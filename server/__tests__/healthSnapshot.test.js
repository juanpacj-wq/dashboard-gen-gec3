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
