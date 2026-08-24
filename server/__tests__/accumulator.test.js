import { describe, it, expect, vi } from 'vitest'

vi.mock('../db.js', () => ({
  savePeriod: vi.fn().mockResolvedValue(undefined),
  saveAccumState: vi.fn().mockResolvedValue(undefined),
  loadAccumState: vi.fn().mockResolvedValue([]),
  getTodayPeriods: vi.fn().mockResolvedValue([]),
}))

const { EnergyAccumulator } = await import('../accumulator.js')
const db = await import('../db.js')

// Hora Bogotá actual (0-23), igual que colombiaTime() del módulo
const bogotaHour = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' })).getHours()

describe('EnergyAccumulator.init() — rehidratación de periodos cerrados (restart)', () => {
  it('carga en completedPeriods las horas < actual que hay en generacion_periodos', async () => {
    const h = bogotaHour()
    db.getTodayPeriods.mockResolvedValueOnce([
      { unit_id: 'GEC3', hora: Math.max(0, h - 2), energia_mwh: 158.567 },
      { unit_id: 'GEC3', hora: Math.max(0, h - 1), energia_mwh: 158.8 },
      { unit_id: 'GEC3', hora: h, energia_mwh: 50 },          // hora en curso: NO es periodo cerrado
      { unit_id: 'TGJ1', hora: Math.max(0, h - 1), energia_mwh: -3 }, // legacy negativo → piso 0 (D-125)
    ])
    const acc = new EnergyAccumulator()
    await acc.init()
    const { completedPeriods } = acc.getState()
    if (h >= 2) {
      expect(completedPeriods.GEC3[h - 2]).toBe(158.57)
      expect(completedPeriods.GEC3[h - 1]).toBe(158.8)
      expect(completedPeriods.TGJ1[h - 1]).toBe(0)
    }
    expect(completedPeriods.GEC3?.[h]).toBeUndefined()
    await acc.stop()
  })

  it('si la consulta falla, arranca sin periodos pero no revienta', async () => {
    db.getTodayPeriods.mockRejectedValueOnce(new Error('db down'))
    const acc = new EnergyAccumulator()
    await expect(acc.init()).resolves.toBeUndefined()
    expect(acc.getState().completedPeriods).toEqual({})
    await acc.stop()
  })
})

describe('EnergyAccumulator.setCompleted()', () => {
  it('registra con 2 decimales y no pisa un valor existente', () => {
    const acc = new EnergyAccumulator()
    acc.setCompleted('GEC3', 3, 158.567)
    acc.setCompleted('GEC3', 3, 1)
    expect(acc.getState().completedPeriods).toEqual({ GEC3: { 3: 158.57 } })
  })
})

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
