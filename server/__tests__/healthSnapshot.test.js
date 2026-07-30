import { describe, it, expect } from 'vitest'
import { buildHealthSnapshot } from '../healthSnapshot.js'

const fakeStatus = (overrides = {}) => ({
  lastSuccessAt: '2026-06-01T12:00:00.000Z',
  secondsSinceSuccess: 30,
  lastErrorAt: null,
  lastError: null,
  consecutiveErrors: 0,
  ...overrides,
})

describe('buildHealthSnapshot', () => {
  it('returns snapshot con todos los servicios + summary.clientsConnected', () => {
    const deps = {
      scraper:           { getStatus: () => fakeStatus() },
      orchestrator:      { getStatus: () => ({ perUnit: { GEC3: { source: 'meter' } }, ...fakeStatus() }) },
      accumulator:       { getStatus: () => fakeStatus({ lastUnitWithValue: 'GEC3' }) },
      emailDispatchGEC:  { getStatus: () => fakeStatus() },
      emailDispatchTGJ:  { getStatus: () => fakeStatus() },
      despachoScraper:   { getStatus: () => fakeStatus({ foundForToday: true }) },
      redespachoScraper: { getStatus: () => fakeStatus({ lastChangesCount: 5 }) },
      clientsCount: 3,
      now: Date.parse('2026-06-01T12:00:30.000Z'),
    }
    const snap = buildHealthSnapshot(deps)
    expect(snap.evaluatedAt).toBe('2026-06-01T12:00:30.000Z')
    expect(snap.services.meterPoller.consecutiveErrors).toBe(0)
    expect(snap.services.orchestrator.perUnit.GEC3.source).toBe('meter')
    expect(snap.services.accumulator.lastUnitWithValue).toBe('GEC3')
    expect(snap.services.despachoScraper.foundForToday).toBe(true)
    expect(snap.services.redespachoScraper.lastChangesCount).toBe(5)
    expect(snap.summary.clientsConnected).toBe(3)
  })

  it('tolera servicios pasados como null (no instanciados) — slot queda null', () => {
    const deps = {
      scraper:           { getStatus: () => fakeStatus() },
      orchestrator:      null,
      accumulator:       { getStatus: () => fakeStatus() },
      emailDispatchGEC:  { getStatus: () => fakeStatus() },
      emailDispatchTGJ:  { getStatus: () => fakeStatus() },
      despachoScraper:   { getStatus: () => fakeStatus() },
      redespachoScraper: { getStatus: () => fakeStatus() },
    }
    const snap = buildHealthSnapshot(deps)
    expect(snap.services.orchestrator).toBeNull()
    expect(snap.services.meterPoller.consecutiveErrors).toBe(0)
  })

  it('tolera servicio cuyo getStatus tira excepción — slot queda null sin propagar', () => {
    const deps = {
      scraper:           { getStatus: () => { throw new Error('boom') } },
      orchestrator:      { getStatus: () => fakeStatus() },
      accumulator:       { getStatus: () => fakeStatus() },
      emailDispatchGEC:  { getStatus: () => fakeStatus() },
      emailDispatchTGJ:  { getStatus: () => fakeStatus() },
      despachoScraper:   { getStatus: () => fakeStatus() },
      redespachoScraper: { getStatus: () => fakeStatus() },
    }
    const snap = buildHealthSnapshot(deps)
    expect(snap.services.meterPoller).toBeNull()
    expect(snap.services.orchestrator.consecutiveErrors).toBe(0)
  })

  it('tolera objeto sin getStatus (no es función) — slot queda null', () => {
    const deps = {
      scraper:           { notAStatus: 1 },
      orchestrator:      { getStatus: () => fakeStatus() },
      accumulator:       { getStatus: () => fakeStatus() },
      emailDispatchGEC:  { getStatus: () => fakeStatus() },
      emailDispatchTGJ:  { getStatus: () => fakeStatus() },
      despachoScraper:   { getStatus: () => fakeStatus() },
      redespachoScraper: { getStatus: () => fakeStatus() },
    }
    expect(buildHealthSnapshot(deps).services.meterPoller).toBeNull()
  })

  it('clientsConnected = null cuando no se inyecta clientsCount', () => {
    const snap = buildHealthSnapshot({
      scraper: null, orchestrator: null, accumulator: null,
      emailDispatchGEC: null, emailDispatchTGJ: null,
      despachoScraper: null, redespachoScraper: null,
    })
    expect(snap.summary.clientsConnected).toBeNull()
    expect(snap.evaluatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

// D-125: una CHECK de invariante que no se aplicó no puede ser una falla silenciosa — el
// sistema parecería blindado sin estarlo. /health/detailed la tiene que mostrar.
describe('buildHealthSnapshot — invariantes de generación (D-125)', () => {
  const OK = { total: 10, constraintsAplicadas: 10, constraintsFaltantes: [], ok: true, evaluado: true }

  it('expone el estado de las constraints cuando se inyecta como getter', () => {
    const snap = buildHealthSnapshot({ invariantConstraints: () => OK })
    expect(snap.invariantes.ok).toBe(true)
    expect(snap.invariantes.constraintsAplicadas).toBe(10)
    expect(snap.invariantes.constraintsFaltantes).toEqual([])
  })

  it('acepta el estado como objeto plano, no solo como función', () => {
    expect(buildHealthSnapshot({ invariantConstraints: OK }).invariantes.ok).toBe(true)
  })

  it('constraints faltantes quedan VISIBLES con ok=false y sus nombres', () => {
    const snap = buildHealthSnapshot({
      invariantConstraints: {
        total: 10,
        constraintsAplicadas: 8,
        constraintsFaltantes: ['CK_proy_hist_no_negativa', 'CK_proy_hist_piso'],
        ok: false,
        evaluado: true,
      },
    })
    expect(snap.invariantes.ok).toBe(false)
    expect(snap.invariantes.constraintsAplicadas).toBe(8)
    expect(snap.invariantes.constraintsFaltantes).toContain('CK_proy_hist_no_negativa')
  })

  it('sin inyección → null (no finge que está blindado)', () => {
    expect(buildHealthSnapshot({ scraper: null }).invariantes).toBeNull()
  })

  it('si el getter tira, el snapshot no se cae: invariantes queda null', () => {
    const snap = buildHealthSnapshot({
      invariantConstraints: () => { throw new Error('pool caído') },
      clientsCount: 2,
    })
    expect(snap.invariantes).toBeNull()
    expect(snap.summary.clientsConnected).toBe(2)
  })
})
