import { describe, it, expect, vi } from 'vitest'

vi.mock('../db.js', () => ({
  savePeriod: vi.fn().mockResolvedValue(undefined),
  saveAccumState: vi.fn().mockResolvedValue(undefined),
  loadAccumState: vi.fn().mockResolvedValue([]),
}))

const { EnergyAccumulator } = await import('../accumulator.js')

describe('EnergyAccumulator.getStatus() — shape canónico', () => {
  it('instancia recién creada → todos los campos en null/0', () => {
    const acc = new EnergyAccumulator()
    expect(acc.getStatus()).toEqual({
      lastSuccessAt: null,
      secondsSinceSuccess: null,
      lastErrorAt: null,
      lastError: null,
      consecutiveErrors: 0,
      lastUpdateAt: null,
      lastUnitWithValue: null,
    })
  })

  it('update con valueMW non-null setea lastSuccessAt + lastUnitWithValue', () => {
    const acc = new EnergyAccumulator()
    acc.update([{ id: 'GEC3', valueMW: 100 }])
    const s = acc.getStatus()
    expect(s.lastSuccessAt).not.toBeNull()
    expect(typeof s.secondsSinceSuccess).toBe('number')
    expect(s.lastUnitWithValue).toBe('GEC3')
    expect(s.consecutiveErrors).toBe(0)
    expect(s.lastError).toBeNull()
  })

  it('update con valueMW=0 SÍ actualiza lastSuccessAt (D-109: cero es valid data)', () => {
    const acc = new EnergyAccumulator()
    acc.update([{ id: 'TGJ1', valueMW: 0 }])
    const s = acc.getStatus()
    expect(s.lastSuccessAt).not.toBeNull()
    expect(s.lastUnitWithValue).toBe('TGJ1')
  })

  it('update con valueMW=null NO actualiza lastSuccessAt (D-109: null se ignora)', () => {
    const acc = new EnergyAccumulator()
    acc.update([{ id: 'GEC3', valueMW: null }])
    expect(acc.getStatus().lastSuccessAt).toBeNull()
    expect(acc.getStatus().lastUnitWithValue).toBeNull()
  })

  it('lastUnitWithValue = última unidad con valor non-null en el tick (orden no determinístico)', () => {
    const acc = new EnergyAccumulator()
    acc.update([
      { id: 'GEC3', valueMW: 100 },
      { id: 'GEC32', valueMW: 200 },
      { id: 'TGJ1', valueMW: null },
    ])
    expect(acc.getStatus().lastUnitWithValue).toBe('GEC32')
  })

  it('lastSuccessAt persiste tras update con todos los valores null', () => {
    const acc = new EnergyAccumulator()
    acc.update([{ id: 'GEC3', valueMW: 100 }])
    const t1 = acc.getStatus().lastSuccessAt
    acc.update([{ id: 'GEC3', valueMW: null }])
    expect(acc.getStatus().lastSuccessAt).toBe(t1)
    expect(acc.getStatus().lastUnitWithValue).toBe('GEC3')
  })
})

describe('EnergyAccumulator — null no se integra (D-116)', () => {
  it('valueMW=null no altera accumulated ni minuteAvgs', () => {
    const acc = new EnergyAccumulator()
    acc.update([{ id: 'GEC3', valueMW: null }])
    const { accumulated, minuteAvgs } = acc.getState()
    expect(accumulated).toEqual({})    // no se creó estado de energía
    expect(minuteAvgs).toEqual({})     // ningún bucket de minuto poblado
  })

  it('null tras un valor real no agrega área ni bucket (antes coercía a 0)', () => {
    const acc = new EnergyAccumulator()
    acc.update([{ id: 'GEC3', valueMW: 120 }])
    const after1 = acc.getState()
    const mwh1 = after1.accumulated.GEC3
    const buckets1 = after1.minuteAvgs.GEC3.filter(b => b != null).length

    acc.update([{ id: 'GEC3', valueMW: null }])   // skip: no integra, no bucket
    const after2 = acc.getState()
    expect(after2.accumulated.GEC3).toBe(mwh1)     // sin cambio
    expect(after2.minuteAvgs.GEC3.filter(b => b != null).length).toBe(buckets1)
  })
})
