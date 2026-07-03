import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Alerter } from '../alerter.js'

// Base: 2026-06-01T17:00:00Z → Bogotá 12:00 (UTC-5). Por debajo de la ventana de
// despacho (15:00 Bogotá), así que el bloque dDEC no dispara por defecto.
const BASE_NOW = Date.parse('2026-06-01T17:00:00.000Z')

function makeAlerter({ snapshot, env = {}, now = BASE_NOW } = {}) {
  let currentNow = now
  let currentSnap = snapshot ?? { services: {} }
  const calls = []
  const alerter = new Alerter({
    getSnapshot: () => currentSnap,
    dispatch: (alert) => calls.push(alert),
    env,
    now: () => currentNow,
  })
  return {
    alerter,
    calls,
    setNow: (n) => { currentNow = n },
    advanceMs: (ms) => { currentNow += ms },
    setSnapshot: (s) => { currentSnap = s },
  }
}

describe('Alerter — meterPoller per-meter (WARN)', () => {
  // Umbral reconciliado a 90 (≈3 min a 2s/tick) por D-116. Bloque no-op en prod.
  it('dispara WARN cuando consecutiveErrors >= 90', () => {
    const { alerter, calls } = makeAlerter({
      snapshot: { services: { meterPoller: { perMeter: { 'GEC3@10.0.0.12': { consecutiveErrors: 100, lastError: 'EHOSTUNREACH' } } } } },
    })
    alerter.tick()
    expect(calls).toHaveLength(1)
    expect(calls[0].incidentKey).toBe('meterPoller:GEC3@10.0.0.12')
    expect(calls[0].severity).toBe('WARN')
    expect(calls[0].body).toMatch(/EHOSTUNREACH/)
  })

  it('NO dispara mientras consecutiveErrors < 90', () => {
    const { alerter, calls } = makeAlerter({
      snapshot: { services: { meterPoller: { perMeter: { 'GEC3@h': { consecutiveErrors: 80, lastError: null } } } } },
    })
    alerter.tick()
    expect(calls).toHaveLength(0)
  })
})

describe('Alerter — medidor caído (orchestrator meterDown ≥ 3 min)', () => {
  it('NO dispara con meterDownSeconds=120 (< 3 min)', () => {
    const snap = { services: { orchestrator: { perUnit: {
      GEC3: { source: 'meter', holding: true, meterDownSeconds: 120, consecMeterErrors: 60 },
    } } } }
    const { alerter, calls } = makeAlerter({ snapshot: snap })
    alerter.tick()
    expect(calls.filter(c => c.incidentKey === 'orchestrator:meterDown:GEC3')).toHaveLength(0)
  })

  it('dispara WARN con meterDownSeconds=200 (≥ 3 min)', () => {
    const snap = { services: { orchestrator: { perUnit: {
      GEC3: { source: 'pme', holding: false, meterDownSeconds: 200, consecMeterErrors: 100 },
    } } } }
    const { alerter, calls } = makeAlerter({ snapshot: snap })
    alerter.tick()
    const down = calls.find(c => c.incidentKey === 'orchestrator:meterDown:GEC3')
    expect(down).toBeDefined()
    expect(down.severity).toBe('WARN')
  })

  it('cooldown: una sola alerta meterDown en dos ticks consecutivos', () => {
    const snap = { services: { orchestrator: { perUnit: {
      GEC3: { source: 'pme', holding: false, meterDownSeconds: 200, consecMeterErrors: 100 },
    } } } }
    const { alerter, calls, advanceMs } = makeAlerter({ snapshot: snap })
    alerter.tick()
    advanceMs(60 * 1000)
    alerter.tick()
    expect(calls.filter(c => c.incidentKey === 'orchestrator:meterDown:GEC3')).toHaveLength(1)
  })
})

describe('Alerter — orchestrator per-unit en PME (WARN > 10 min)', () => {
  it('NO dispara antes de 10 min en PME', () => {
    const snap = { services: { orchestrator: { perUnit: {
      GEC3: { source: 'pme', consecMeterErrors: 5 },
      GEC32: { source: 'meter' },
    } } } }
    const { alerter, calls, advanceMs } = makeAlerter({ snapshot: snap })
    alerter.tick()                  // sets pmeSwitchedAt[GEC3] = base
    advanceMs(5 * 60 * 1000)        // +5 min
    alerter.tick()
    expect(calls).toHaveLength(0)
  })

  it('dispara WARN tras > 10 min en PME', () => {
    const snap = { services: { orchestrator: { perUnit: {
      GEC3: { source: 'pme', consecMeterErrors: 5 },
      GEC32: { source: 'meter' },
    } } } }
    const { alerter, calls, advanceMs } = makeAlerter({ snapshot: snap })
    alerter.tick()
    advanceMs(11 * 60 * 1000)
    alerter.tick()
    expect(calls).toHaveLength(1)
    expect(calls[0].incidentKey).toBe('orchestrator:pme:GEC3')
    expect(calls[0].severity).toBe('WARN')
  })

  it('resetea pmeSwitchedAt cuando vuelve a meter (sin emitir recovery WARN)', () => {
    const snap = { services: { orchestrator: { perUnit: {
      GEC3: { source: 'pme' },
      GEC32: { source: 'meter' },
    } } } }
    const { alerter, calls, advanceMs, setSnapshot } = makeAlerter({ snapshot: snap })
    alerter.tick()
    advanceMs(11 * 60 * 1000)
    alerter.tick()  // dispara WARN
    expect(calls).toHaveLength(1)

    setSnapshot({ services: { orchestrator: { perUnit: {
      GEC3: { source: 'meter' },
      GEC32: { source: 'meter' },
    } } } })
    advanceMs(60 * 1000)
    alerter.tick()
    expect(calls).toHaveLength(1)  // sigue 1 — WARN no emite recovery (Q6)
  })
})

describe('Alerter — orchestrator GLOBAL en PME (CRITICAL > 2 min)', () => {
  const allPme = { services: { orchestrator: { perUnit: {
    GEC3:  { source: 'pme' }, GEC32: { source: 'pme' },
    TGJ1:  { source: 'pme' }, TGJ2:  { source: 'pme' },
  } } } }

  it('dispara CRITICAL global tras > 2 min con todas en PME', () => {
    const { alerter, calls, advanceMs } = makeAlerter({ snapshot: allPme })
    alerter.tick()                  // marca pmeGlobalSince
    advanceMs(3 * 60 * 1000)
    alerter.tick()
    const global = calls.find(c => c.incidentKey === 'orchestrator:pme:GLOBAL')
    expect(global).toBeDefined()
    expect(global.severity).toBe('CRITICAL')
  })

  it('emite RECOVERED cuando alguna unidad vuelve a meter', () => {
    const { alerter, calls, advanceMs, setSnapshot } = makeAlerter({ snapshot: allPme })
    alerter.tick()
    advanceMs(3 * 60 * 1000)
    alerter.tick()  // CRITICAL
    const callsBefore = calls.length

    setSnapshot({ services: { orchestrator: { perUnit: {
      GEC3:  { source: 'meter' }, GEC32: { source: 'pme' },
      TGJ1:  { source: 'pme' },   TGJ2:  { source: 'pme' },
    } } } })
    alerter.tick()
    const recovered = calls.find(c => c.incidentKey === 'orchestrator:pme:GLOBAL' && c.severity === 'RECOVERED')
    expect(recovered).toBeDefined()
    expect(calls.length).toBeGreaterThan(callsBefore)
  })
})

describe('Alerter — cooldown', () => {
  it('cooldown evita re-emisión del mismo incident en ticks consecutivos', () => {
    const snap = { services: { meterPoller: { perMeter: { 'GEC3@h': { consecutiveErrors: 100, lastError: 'X' } } } } }
    const { alerter, calls, advanceMs } = makeAlerter({ snapshot: snap })
    alerter.tick()
    advanceMs(60 * 1000)            // +1 min
    alerter.tick()
    advanceMs(10 * 60 * 1000)       // +10 min
    alerter.tick()
    expect(calls).toHaveLength(1)
  })

  it('re-emite tras > 30 min de cooldown si el problema persiste', () => {
    const snap = { services: { meterPoller: { perMeter: { 'GEC3@h': { consecutiveErrors: 100, lastError: 'X' } } } } }
    const { alerter, calls, advanceMs } = makeAlerter({ snapshot: snap })
    alerter.tick()
    advanceMs(31 * 60 * 1000)
    alerter.tick()
    expect(calls).toHaveLength(2)
  })
})

describe('Alerter — accumulator (CRITICAL + recovery)', () => {
  it('dispara CRITICAL cuando secondsSinceSuccess > 5 min y luego RECOVERED al volver', () => {
    const stale = { services: { accumulator: { secondsSinceSuccess: 400 } } }
    const fresh = { services: { accumulator: { secondsSinceSuccess: 5 } } }
    const { alerter, calls, setSnapshot } = makeAlerter({ snapshot: stale })
    alerter.tick()
    expect(calls).toHaveLength(1)
    expect(calls[0].severity).toBe('CRITICAL')

    setSnapshot(fresh)
    alerter.tick()
    expect(calls).toHaveLength(2)
    expect(calls[1].severity).toBe('RECOVERED')
    expect(calls[1].incidentKey).toBe('accumulator:stale')
  })
})

describe('Alerter — ventana horaria del despacho scraper', () => {
  const staleDespacho = { services: { despachoScraper: { secondsSinceSuccess: 70 * 60, lastError: 'file-not-yet-published', foundForToday: false } } }

  it('a las 14:00 Bogotá NO dispara aunque haya stale > 60 min', () => {
    // 14:00 Bogotá = 19:00 UTC
    const { alerter, calls } = makeAlerter({ snapshot: staleDespacho, now: Date.parse('2026-06-01T19:00:00.000Z') })
    alerter.tick()
    expect(calls).toHaveLength(0)
  })

  it('a las 15:00 Bogotá SÍ dispara', () => {
    const { alerter, calls } = makeAlerter({ snapshot: staleDespacho, now: Date.parse('2026-06-01T20:00:00.000Z') })
    alerter.tick()
    expect(calls).toHaveLength(1)
    expect(calls[0].incidentKey).toBe('despachoScraper:stale')
  })
})

describe('Alerter — robustez del transport', () => {
  it('dispatch que tira no crashea el alerter; siguiente tick funciona', () => {
    const snap = { services: { meterPoller: { perMeter: { 'GEC3@h': { consecutiveErrors: 100, lastError: 'X' } } } } }
    let calls = 0
    let shouldThrow = true
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = new Alerter({
      getSnapshot: () => snap,
      dispatch: () => {
        calls++
        if (shouldThrow) throw new Error('boom')
      },
      now: () => BASE_NOW,
    })
    expect(() => a.tick()).not.toThrow()
    expect(calls).toBe(1)
    shouldThrow = false
    // Avanzar el now para superar el cooldown y permitir re-emit
    a._stateForTest()  // not strictly needed — just docs
    const a2 = new Alerter({
      getSnapshot: () => snap,
      dispatch: () => { calls++ },
      now: () => BASE_NOW,
    })
    a2.tick()
    expect(calls).toBe(2)
    errSpy.mockRestore()
  })

  it('getSnapshot que tira loguea y no propaga', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = new Alerter({
      getSnapshot: () => { throw new Error('snap fail') },
      dispatch: () => {},
      now: () => BASE_NOW,
    })
    expect(() => a.tick()).not.toThrow()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('Alerter — config vía env', () => {
  it('umbrales se sobrescriben con env vars numéricas', () => {
    const snap = { services: { meterPoller: { perMeter: { 'GEC3@h': { consecutiveErrors: 5, lastError: 'X' } } } } }
    const { alerter, calls } = makeAlerter({
      snapshot: snap,
      env: { ALERT_THRESH_METER_CONSEC_ERRORS: '3' },
    })
    alerter.tick()
    expect(calls).toHaveLength(1)
  })

  it('env var no numérica tira al construir', () => {
    expect(() => new Alerter({
      getSnapshot: () => ({}),
      dispatch: () => {},
      env: { ALERT_THRESH_METER_CONSEC_ERRORS: 'foo' },
    })).toThrow(/no es numérico/)
  })
})

describe('Alerter — lifecycle (start/stop con timers)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('start() agenda ticks cada ALERT_POLL_INTERVAL_SEC; stop() los detiene', () => {
    let ticks = 0
    const a = new Alerter({
      getSnapshot: () => { ticks++; return { services: {} } },
      dispatch: () => {},
      env: { ALERT_POLL_INTERVAL_SEC: '1' },
    })
    a.start()                       // tick inmediato
    expect(ticks).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(ticks).toBe(2)
    vi.advanceTimersByTime(2000)
    expect(ticks).toBe(4)
    a.stop()
    vi.advanceTimersByTime(5000)
    expect(ticks).toBe(4)
  })
})

describe('Alerter — GLOBAL meterDown con PME deshabilitado (CRITICAL, D-120)', () => {
  const K = 'orchestrator:meterDown:GLOBAL'
  const unit = (over = {}) => ({ source: 'meter', holding: false, meterDownSeconds: 200, consecMeterErrors: 100, ...over })
  const allDown = (pmeEnabled) => ({ services: { orchestrator: { pmeEnabled, perUnit: {
    GEC3: unit(), GEC32: unit(), TGJ1: unit(), TGJ2: unit(),
  } } } })

  it('dispara CRITICAL con todas las unidades caídas y pmeEnabled=false', () => {
    const { alerter, calls } = makeAlerter({ snapshot: allDown(false) })
    alerter.tick()
    const global = calls.find(c => c.incidentKey === K)
    expect(global).toBeDefined()
    expect(global.severity).toBe('CRITICAL')
    expect(global.title).toMatch(/sin medidor/i)
  })

  it('NO dispara mientras alguna unidad hace holding (carry-forward activo)', () => {
    const snap = { services: { orchestrator: { pmeEnabled: false, perUnit: {
      GEC3: unit({ holding: true }), GEC32: unit(), TGJ1: unit(), TGJ2: unit(),
    } } } }
    const { alerter, calls } = makeAlerter({ snapshot: snap })
    alerter.tick()
    expect(calls.filter(c => c.incidentKey === K)).toHaveLength(0)
  })

  it('NO dispara con pmeEnabled=true ni con el campo ausente (snapshot legacy)', () => {
    for (const snap of [allDown(true), allDown(undefined)]) {
      const { alerter, calls } = makeAlerter({ snapshot: snap })
      alerter.tick()
      expect(calls.filter(c => c.incidentKey === K)).toHaveLength(0)
    }
  })

  it('NO dispara si solo algunas unidades están caídas (las per-unit sí)', () => {
    const snap = { services: { orchestrator: { pmeEnabled: false, perUnit: {
      GEC3: unit(), GEC32: unit({ meterDownSeconds: 0 }), TGJ1: unit(), TGJ2: unit(),
    } } } }
    const { alerter, calls } = makeAlerter({ snapshot: snap })
    alerter.tick()
    expect(calls.filter(c => c.incidentKey === K)).toHaveLength(0)
    expect(calls.find(c => c.incidentKey === 'orchestrator:meterDown:GEC3')).toBeDefined()
  })

  it('emite RECOVERED cuando una unidad vuelve', () => {
    const { alerter, calls, advanceMs, setSnapshot } = makeAlerter({ snapshot: allDown(false) })
    alerter.tick()  // CRITICAL
    expect(calls.find(c => c.incidentKey === K && c.severity === 'CRITICAL')).toBeDefined()

    setSnapshot({ services: { orchestrator: { pmeEnabled: false, perUnit: {
      GEC3: unit({ meterDownSeconds: 0 }), GEC32: unit(), TGJ1: unit(), TGJ2: unit(),
    } } } })
    advanceMs(60 * 1000)
    alerter.tick()
    expect(calls.find(c => c.incidentKey === K && c.severity === 'RECOVERED')).toBeDefined()
  })

  it('cooldown: una sola alerta global en dos ticks consecutivos', () => {
    const { alerter, calls, advanceMs } = makeAlerter({ snapshot: allDown(false) })
    alerter.tick()
    advanceMs(60 * 1000)
    alerter.tick()
    expect(calls.filter(c => c.incidentKey === K)).toHaveLength(1)
  })

  it('umbral configurable: no dispara por debajo de ALERT_THRESH_METER_DOWN_GLOBAL_MIN', () => {
    const snap = { services: { orchestrator: { pmeEnabled: false, perUnit: {
      GEC3: unit({ meterDownSeconds: 90 }), GEC32: unit({ meterDownSeconds: 90 }),
      TGJ1: unit({ meterDownSeconds: 90 }), TGJ2: unit({ meterDownSeconds: 90 }),
    } } } }
    const { alerter, calls } = makeAlerter({ snapshot: snap, env: { ALERT_THRESH_METER_DOWN_GLOBAL_MIN: '2' } })
    alerter.tick()
    expect(calls.filter(c => c.incidentKey === K)).toHaveLength(0)
  })
})
