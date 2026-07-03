import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ExtractorOrchestrator, unitsForPME } from '../extractorOrchestrator.js'

const POLL_MS = 1000

function buildUnits() {
  return [
    {
      id: 'TGJ1', label: 'GUAJIRA 1', maxMW: 145, combine: 'single', frontierType: 'output',
      meters: [{ host: '10.0.0.10', user: 'u', password: 'p' }],
      pme: { referencia: 'kW tot', occurrence: 0 },
    },
    {
      id: 'TGJ2', label: 'GUAJIRA 2', maxMW: 130, combine: 'single', frontierType: 'output',
      meters: [{ host: '10.0.0.11', user: 'u', password: 'p' }],
      pme: { referencia: 'kW tot', occurrence: 1 },
    },
    {
      id: 'GEC3', label: 'GECELCA 3', maxMW: 164, combine: 'sum', frontierType: 'input',
      meters: [
        { host: '10.0.0.12', user: 'u', password: 'p' },
        { host: '10.0.0.13', user: 'u', password: 'p' },
      ],
      pme: { referencia: 'KWTOT_G3', occurrence: 0 },
    },
    {
      id: 'GEC32', label: 'GECELCA 32', maxMW: 270, combine: 'single', frontierType: 'input',
      meters: [{ host: '10.0.0.14', user: 'u', password: 'p' }],
      pme: { referencia: 'KWTOT_G32', occurrence: 0 },
    },
  ]
}

const PME_CONFIG = { loginUrl: 'x', diagramUrl: 'x', user: 'x', password: 'x' }

// Fake MeterPoller / PMEScraper que el test controla manualmente.
function makeFakeSubExtractor() {
  let storedOnData = null
  const ctor = vi.fn(({ onData }) => {
    storedOnData = onData
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(() => ({ running: true, stale: false })),
    }
  })
  return {
    ctor,
    emit: (units) => storedOnData?.({ type: 'update', units, timestamp: new Date().toISOString() }),
  }
}

function buildOrchestrator({ onData = vi.fn(), fallbackThreshold = 3, recoveryThreshold = 2, holdTtlMs } = {}) {
  const meter = makeFakeSubExtractor()
  const pme = makeFakeSubExtractor()
  const orch = new ExtractorOrchestrator({
    units: buildUnits(),
    pme: PME_CONFIG,
    onData,
    pollMs: POLL_MS,
    fallbackThreshold,
    recoveryThreshold,
    holdTtlMs,  // undefined → default 3 min; tests de switch pasan un TTL corto
    meterPollerCtor: meter.ctor,
    pmeScraperCtor: pme.ctor,
  })
  return { orch, meter, pme, onData }
}

// Emite el mismo valor para las 4 unidades en el sub-extractor dado.
function emitAll(sub, value) {
  sub.emit(buildUnits().map((u) => ({ id: u.id, label: u.label, valueMW: value, maxMW: u.maxMW })))
}

async function flushPromises() {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
}

async function tick({ ms = POLL_MS } = {}) {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

describe('unitsForPME', () => {
  it('produce shape legacy de PMEScraper sin campos nuevos', () => {
    const adapted = unitsForPME(buildUnits())
    expect(adapted).toHaveLength(4)
    for (const u of adapted) {
      expect(Object.keys(u).sort()).toEqual(['id', 'label', 'maxMW', 'occurrence', 'referencia'])
    }
    const gec3 = adapted.find((u) => u.id === 'GEC3')
    expect(gec3.referencia).toBe('KWTOT_G3')
    expect(gec3.occurrence).toBe(0)
  })
})

describe('ExtractorOrchestrator constructor', () => {
  it('lanza si units está vacío', () => {
    expect(() => new ExtractorOrchestrator({ units: [], pme: PME_CONFIG, onData: () => {} }))
      .toThrow(TypeError)
  })
  it('lanza si onData no es función', () => {
    expect(() => new ExtractorOrchestrator({ units: buildUnits(), pme: PME_CONFIG, onData: null }))
      .toThrow(TypeError)
  })
  it('lanza si pme falta', () => {
    expect(() => new ExtractorOrchestrator({ units: buildUnits(), onData: () => {} }))
      .toThrow(TypeError)
  })
})

describe('ExtractorOrchestrator — caso ideal (meter primario sirviendo)', () => {
  let orch, meter, pme, onData
  beforeEach(() => {
    vi.useFakeTimers()
    ;({ orch, meter, pme, onData } = buildOrchestrator())
  })
  afterEach(async () => { await orch.stop(); vi.useRealTimers() })

  it('sirve valor del medidor cuando es válido y la fuente es meter', async () => {
    await orch.start()
    meter.emit([
      { id: 'TGJ1', label: 'GUAJIRA 1', valueMW: 70, maxMW: 145 },
      { id: 'TGJ2', label: 'GUAJIRA 2', valueMW: 60, maxMW: 130 },
      { id: 'GEC3', label: 'GECELCA 3', valueMW: -0.5, maxMW: 164 },
      { id: 'GEC32', label: 'GECELCA 32', valueMW: -3, maxMW: 270 },
    ])
    await tick()
    const last = onData.mock.calls.at(-1)[0]
    expect(last.type).toBe('update')
    expect(last.units.find((u) => u.id === 'TGJ1').valueMW).toBe(70)
    expect(last.units.find((u) => u.id === 'GEC3').valueMW).toBe(-0.5)

    const status = orch.getStatus()
    for (const id of ['TGJ1', 'TGJ2', 'GEC3', 'GEC32']) {
      expect(status.perUnit[id].source).toBe('meter')
    }
  })
})

describe('ExtractorOrchestrator — carry-forward con TTL (D-116)', () => {
  let orch, meter, pme, onData
  afterEach(async () => { await orch.stop(); vi.useRealTimers() })

  const valueOf = (last, id) => last.units.find((u) => u.id === id).valueMW
  const holdingOf = (last, id) => last.units.find((u) => u.id === id).holding

  it('hold corto retiene el último valor bueno (caso 1)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, onData } = buildOrchestrator())  // default TTL 3 min
    await orch.start()
    emitAll(meter, 70); await tick()
    emitAll(meter, null); await tick()

    const st = orch.getStatus().perUnit.TGJ1
    expect(st.source).toBe('meter')
    expect(st.holding).toBe(true)
    expect(st.consecMeterErrors).toBe(1)
    const last = onData.mock.calls.at(-1)[0]
    expect(valueOf(last, 'TGJ1')).toBe(70)   // retenido, NO null ni 0
    expect(holdingOf(last, 'TGJ1')).toBe(true)
  })

  it('hold sostenido a través de N nulls < TTL incrementa heldTicks (caso 2)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter } = buildOrchestrator())
    await orch.start()
    emitAll(meter, 70); await tick()
    emitAll(meter, null); await tick()
    expect(orch.getStatus().perUnit.TGJ1.heldTicks).toBe(1)
    emitAll(meter, null); await tick()
    expect(orch.getStatus().perUnit.TGJ1.heldTicks).toBe(2)
    emitAll(meter, null); await tick()
    expect(orch.getStatus().perUnit.TGJ1.heldTicks).toBe(3)
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('meter')  // sigue en meter
  })

  it('prioridad sobre PME: dentro del TTL emite el retenido, no PME (caso 3)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, pme, onData } = buildOrchestrator())
    await orch.start()
    emitAll(meter, 70); emitAll(pme, 200); await tick()
    emitAll(meter, null); emitAll(pme, 200); await tick()

    const last = onData.mock.calls.at(-1)[0]
    expect(valueOf(last, 'TGJ1')).toBe(70)   // retenido, no 200
    expect(last.units.find((u) => u.id === 'TGJ1').source).toBe('meter')
    expect(holdingOf(last, 'TGJ1')).toBe(true)
  })

  it('lastGoodMeter se sella solo con lecturas válidas: 70, null, 71 (caso 7)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, onData } = buildOrchestrator())
    await orch.start()
    emitAll(meter, 70); await tick()
    expect(orch.getTickSnapshot('TGJ1').lastGoodMeterValue).toBe(70)

    emitAll(meter, null); await tick()  // HOLD — lastGood NO cambia
    expect(orch.getTickSnapshot('TGJ1').lastGoodMeterValue).toBe(70)
    expect(valueOf(onData.mock.calls.at(-1)[0], 'TGJ1')).toBe(70)

    emitAll(meter, 71); await tick()    // nueva lectura válida sella 71
    expect(orch.getTickSnapshot('TGJ1').lastGoodMeterValue).toBe(71)
    expect(valueOf(onData.mock.calls.at(-1)[0], 'TGJ1')).toBe(71)
    expect(orch.getStatus().perUnit.TGJ1.holding).toBe(false)
  })

  it('getStatus expone holding/heldTicks/lastHoldAt/meterDownSeconds (caso 10)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter } = buildOrchestrator())
    await orch.start()
    emitAll(meter, 70); await tick()
    emitAll(meter, null); await tick()

    const st = orch.getStatus().perUnit.TGJ1
    expect(st.holding).toBe(true)
    expect(st.heldTicks).toBeGreaterThanOrEqual(1)
    expect(typeof st.lastHoldAt).toBe('string')        // ISO
    expect(typeof st.meterDownSeconds).toBe('number')
  })

  it('meterDownSeconds corre durante el hold y un OK lo resetea a 0 (caso 11)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter } = buildOrchestrator())
    await orch.start()
    emitAll(meter, 50); await tick()
    expect(orch.getStatus().perUnit.TGJ1.meterDownSeconds).toBe(0)

    emitAll(meter, null); await tick()  // meterDownSince sellado
    emitAll(meter, null); await tick()  // un tick más → cuenta corre
    expect(orch.getStatus().perUnit.TGJ1.meterDownSeconds).toBeGreaterThanOrEqual(1)

    emitAll(meter, 50); await tick()    // lectura válida resetea
    expect(orch.getStatus().perUnit.TGJ1.meterDownSeconds).toBe(0)
  })
})

describe('ExtractorOrchestrator — TTL expira → cede a PME', () => {
  let orch, meter, pme, onData
  afterEach(async () => { await orch.stop(); vi.useRealTimers() })

  const valueOf = (last, id) => last.units.find((u) => u.id === id).valueMW

  it('al expirar el TTL cede a PME si está válido (caso 4)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, pme, onData } = buildOrchestrator({ holdTtlMs: 2 * POLL_MS }))
    await orch.start()
    emitAll(meter, 50); emitAll(pme, 60); await tick()
    emitAll(meter, null); emitAll(pme, 60); await tick()   // 1er null < TTL → HOLD
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('meter')
    expect(orch.getStatus().perUnit.TGJ1.holding).toBe(true)

    emitAll(meter, null); emitAll(pme, 60); await tick()   // TTL expira → pme
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('pme')
    expect(orch.getStatus().perUnit.TGJ1.holding).toBe(false)
    expect(valueOf(onData.mock.calls.at(-1)[0], 'TGJ1')).toBe(60)
  })

  it('TTL expira sin PME válido → valueMW=null, holding=false, source previo (caso 5)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, onData } = buildOrchestrator({ holdTtlMs: 2 * POLL_MS }))
    await orch.start()
    emitAll(meter, 50); await tick()                       // pme nunca emite
    emitAll(meter, null); await tick()                     // HOLD
    emitAll(meter, null); await tick()                     // TTL expira, sin pme

    const st = orch.getStatus().perUnit.TGJ1
    expect(st.holding).toBe(false)
    expect(st.source).toBe('meter')                        // conserva histéresis
    expect(valueOf(onData.mock.calls.at(-1)[0], 'TGJ1')).toBeNull()  // sin spike
  })

  it('arranque sin lastGoodMeter + null + PME válido → pme directo (caso 6a)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, pme, onData } = buildOrchestrator())
    await orch.start()
    emitAll(meter, null); emitAll(pme, 200); await tick()

    expect(orch.getStatus().perUnit.TGJ1.source).toBe('pme')
    expect(orch.getStatus().perUnit.TGJ1.holding).toBe(false)
    expect(valueOf(onData.mock.calls.at(-1)[0], 'TGJ1')).toBe(200)
  })

  it('arranque sin lastGoodMeter + null + sin PME → null sin spike (caso 6b)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, onData } = buildOrchestrator())
    await orch.start()
    emitAll(meter, null); await tick()

    expect(orch.getStatus().perUnit.TGJ1.source).toBeNull()
    expect(valueOf(onData.mock.calls.at(-1)[0], 'TGJ1')).toBeNull()
  })

  it('flapping ok/null/ok/null resetea el TTL → nunca cae a PME (caso 8)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, pme } = buildOrchestrator({ holdTtlMs: 2 * POLL_MS }))
    await orch.start()
    emitAll(meter, 50); emitAll(pme, 99); await tick()
    for (let i = 0; i < 3; i++) {
      emitAll(meter, null); emitAll(pme, 99); await tick()  // 1 null (gap < TTL) → HOLD
      emitAll(meter, 50);   emitAll(pme, 99); await tick()  // OK resetea lastGood.at
      expect(orch.getStatus().perUnit.TGJ1.source).toBe('meter')
    }
  })
})

describe('ExtractorOrchestrator — recovery pme → meter (preserva D-102)', () => {
  let orch, meter, pme, onData
  afterEach(async () => { await orch.stop(); vi.useRealTimers() })

  it('en pme con 1 OK del meter NO recupera; con 2 OK consecutivos sí (caso 9)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, pme, onData } = buildOrchestrator({ holdTtlMs: 2 * POLL_MS, recoveryThreshold: 2 }))
    await orch.start()
    // forzar fallback a pme (TTL corto)
    emitAll(meter, 50); emitAll(pme, 60); await tick()
    emitAll(meter, null); emitAll(pme, 60); await tick()
    emitAll(meter, null); emitAll(pme, 60); await tick()
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('pme')

    emitAll(meter, 50); emitAll(pme, 60); await tick()  // OK 1 — no recupera aún
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('pme')
    emitAll(meter, 51); emitAll(pme, 60); await tick()  // OK 2 — recovery
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('meter')
    expect(onData.mock.calls.at(-1)[0].units.find((u) => u.id === 'TGJ1').valueMW).toBe(51)
  })
})

describe('ExtractorOrchestrator — independencia entre unidades', () => {
  it('TGJ1 puede estar en pme mientras TGJ2/GEC3/GEC32 siguen en meter', async () => {
    vi.useFakeTimers()
    const { orch, meter, pme, onData } = buildOrchestrator({ holdTtlMs: 2 * POLL_MS })
    try {
      await orch.start()

      // Todas en meter inicialmente
      meter.emit([
        { id: 'TGJ1', label: 'GUAJIRA 1', valueMW: 70, maxMW: 145 },
        { id: 'TGJ2', label: 'GUAJIRA 2', valueMW: 60, maxMW: 130 },
        { id: 'GEC3', label: 'GECELCA 3', valueMW: -0.5, maxMW: 164 },
        { id: 'GEC32', label: 'GECELCA 32', valueMW: -3, maxMW: 270 },
      ])
      pme.emit([
        { id: 'TGJ1', label: 'GUAJIRA 1', valueMW: 71, maxMW: 145 },
        { id: 'TGJ2', label: 'GUAJIRA 2', valueMW: 60, maxMW: 130 },
        { id: 'GEC3', label: 'GECELCA 3', valueMW: -0.5, maxMW: 164 },
        { id: 'GEC32', label: 'GECELCA 32', valueMW: -3, maxMW: 270 },
      ])
      await tick()

      // Solo TGJ1 falla (TTL corto la cede a pme tras el hold); las otras siguen sirviendo
      for (let i = 0; i < 3; i++) {
        meter.emit([
          { id: 'TGJ1', label: 'GUAJIRA 1', valueMW: null, maxMW: 145 },
          { id: 'TGJ2', label: 'GUAJIRA 2', valueMW: 60, maxMW: 130 },
          { id: 'GEC3', label: 'GECELCA 3', valueMW: -0.5, maxMW: 164 },
          { id: 'GEC32', label: 'GECELCA 32', valueMW: -3, maxMW: 270 },
        ])
        await tick()
      }

      const status = orch.getStatus()
      expect(status.perUnit.TGJ1.source).toBe('pme')
      expect(status.perUnit.TGJ2.source).toBe('meter')
      expect(status.perUnit.GEC3.source).toBe('meter')
      expect(status.perUnit.GEC32.source).toBe('meter')

      const last = onData.mock.calls.at(-1)[0]
      expect(last.units.find((u) => u.id === 'TGJ1').valueMW).toBe(71)  // pme
      expect(last.units.find((u) => u.id === 'TGJ2').valueMW).toBe(60)  // meter
      expect(last.units.find((u) => u.id === 'TGJ1').source).toBe('pme')
      expect(last.units.find((u) => u.id === 'TGJ2').source).toBe('meter')
      expect(last.units.find((u) => u.id === 'GEC3').source).toBe('meter')
      expect(last.units.find((u) => u.id === 'GEC32').source).toBe('meter')
    } finally {
      await orch.stop()
      vi.useRealTimers()
    }
  })
})

describe('ExtractorOrchestrator.getStatus shape', () => {
  it('contiene todos los campos compatibles con PMEScraper más extensiones', async () => {
    vi.useFakeTimers()
    const { orch, meter, pme } = buildOrchestrator()
    await orch.start()
    meter.emit(buildUnits().map((u) => ({ id: u.id, label: u.label, valueMW: 50, maxMW: u.maxMW })))
    await tick()

    const s = orch.getStatus()
    // PMEScraper-compat fields:
    expect(s).toHaveProperty('running')
    expect(s).toHaveProperty('warming')
    expect(s).toHaveProperty('lastDataAt')
    expect(s).toHaveProperty('secondsSinceUpdate')
    expect(s).toHaveProperty('lastValueChangeAt')
    expect(s).toHaveProperty('secondsSinceValueChange')
    expect(s).toHaveProperty('updateCount')
    expect(s).toHaveProperty('errorCount')
    expect(s).toHaveProperty('stale')
    expect(s).toHaveProperty('valueStale')
    // Extension fields:
    expect(s).toHaveProperty('meter')
    expect(s).toHaveProperty('pme')
    expect(s).toHaveProperty('perUnit')
    expect(Object.keys(s.perUnit)).toHaveLength(4)
    expect(s.perUnit.TGJ1).toMatchObject({
      source: expect.any(String),
      consecMeterErrors: expect.any(Number),
      consecMeterOk: expect.any(Number),
      holding: false,
      heldTicks: expect.any(Number),
      meterDownSeconds: expect.any(Number),
    })

    await orch.stop()
    vi.useRealTimers()
  })
})

describe('ExtractorOrchestrator — start no bloquea si sub-extractor no resuelve', () => {
  // Regresión: PMEScraper.start() real nunca resuelve (while running infinito).
  // El orquestador NO debe await sus sub-extractores en start, porque si lo hace
  // los setInterval del #tick/#heartbeat nunca se programan y onData nunca corre.
  it('tickea aunque pmeScraper.start() nunca resuelva', async () => {
    vi.useFakeTimers()
    const onData = vi.fn()

    const meter = makeFakeSubExtractor()
    // Fake pmeScraper con start() que solo resuelve al stop() — modela el
    // comportamiento real de PMEScraper (while running infinito).
    let pmeStartResolver
    const pmeCtor = vi.fn(({ onData: cb }) => {
      return {
        start: vi.fn(() => new Promise((resolve) => { pmeStartResolver = resolve })),
        stop: vi.fn(() => { pmeStartResolver?.(); return Promise.resolve() }),
        getStatus: vi.fn(() => ({ running: true })),
      }
    })

    const orch = new ExtractorOrchestrator({
      units: buildUnits(),
      pme: PME_CONFIG,
      onData,
      pollMs: POLL_MS,
      meterPollerCtor: meter.ctor,
      pmeScraperCtor: pmeCtor,
    })
    try {
      await orch.start()  // no debe colgarse esperando pme
      meter.emit(buildUnits().map((u) => ({ id: u.id, label: u.label, valueMW: 50, maxMW: u.maxMW })))
      await tick()
      expect(onData).toHaveBeenCalled()
      const last = onData.mock.calls.at(-1)[0]
      expect(last.units.find((u) => u.id === 'TGJ1').valueMW).toBe(50)
    } finally {
      await orch.stop()
      vi.useRealTimers()
    }
  })
})

describe('ExtractorOrchestrator — lifecycle', () => {
  it('stop() detiene los timers y los sub-extractores', async () => {
    vi.useFakeTimers()
    const { orch, meter, pme, onData } = buildOrchestrator()
    await orch.start()
    meter.emit(buildUnits().map((u) => ({ id: u.id, label: u.label, valueMW: 50, maxMW: u.maxMW })))
    await tick()
    const callsBefore = onData.mock.calls.length

    await orch.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(onData.mock.calls.length).toBe(callsBefore)
    vi.useRealTimers()
  })
})

describe('ExtractorOrchestrator — pmeEnabled=false (D-120)', () => {
  let orch
  afterEach(async () => { if (orch) await orch.stop(); orch = null; vi.useRealTimers() })

  // Builder propio: sin config pme (con el flag apagado no debe ser obligatoria).
  function buildOff({ onData = vi.fn(), holdTtlMs } = {}) {
    const meter = makeFakeSubExtractor()
    const pme = makeFakeSubExtractor()
    orch = new ExtractorOrchestrator({
      units: buildUnits(),
      pmeEnabled: false,
      onData,
      pollMs: POLL_MS,
      holdTtlMs,
      meterPollerCtor: meter.ctor,
      pmeScraperCtor: pme.ctor,
    })
    return { meter, pme, onData }
  }

  it('constructor sin pme NO lanza con pmeEnabled=false', () => {
    vi.useFakeTimers()
    expect(() => buildOff()).not.toThrow()
  })

  it('jamás instancia el PMEScraper y start/stop no revientan', async () => {
    vi.useFakeTimers()
    const { pme, meter } = buildOff()
    await orch.start()
    emitAll(meter, 70)
    await tick()
    expect(pme.ctor).not.toHaveBeenCalled()
    await orch.stop()
    expect(pme.ctor).not.toHaveBeenCalled()
  })

  it('meter caído: hold dentro del TTL y al expirar null con source sticky (nunca pme)', async () => {
    vi.useFakeTimers()
    const { meter, pme, onData } = buildOff({ holdTtlMs: 2 * POLL_MS })
    await orch.start()
    emitAll(meter, 70); await tick()
    // El fake pme "emite" pero nunca fue instanciado → no tiene efecto alguno.
    emitAll(pme, 55)
    emitAll(meter, null); await tick()
    let st = orch.getStatus().perUnit.TGJ1
    expect(st.source).toBe('meter')
    expect(st.holding).toBe(true)
    expect(onData.mock.calls.at(-1)[0].units.find((u) => u.id === 'TGJ1').valueMW).toBe(70)

    emitAll(meter, null); await tick()
    emitAll(meter, null); await tick()
    st = orch.getStatus().perUnit.TGJ1
    expect(st.source).toBe('meter')      // sticky: jamás conmuta a 'pme'
    expect(st.holding).toBe(false)
    expect(onData.mock.calls.at(-1)[0].units.find((u) => u.id === 'TGJ1').valueMW).toBe(null)
  })

  it('recovery del meter tras el null: vuelve a emitir valor', async () => {
    vi.useFakeTimers()
    const { meter, onData } = buildOff({ holdTtlMs: 2 * POLL_MS })
    await orch.start()
    emitAll(meter, 70); await tick()
    emitAll(meter, null); await tick()
    emitAll(meter, null); await tick()
    emitAll(meter, null); await tick()   // TTL agotado → null
    emitAll(meter, 68); await tick()     // el medidor vuelve
    const st = orch.getStatus().perUnit.TGJ1
    expect(st.source).toBe('meter')
    expect(st.holding).toBe(false)
    expect(onData.mock.calls.at(-1)[0].units.find((u) => u.id === 'TGJ1').valueMW).toBe(68)
  })

  it('arranque en frío sin lectura válida: source null y valueMW null', async () => {
    vi.useFakeTimers()
    const { onData } = buildOff()
    await orch.start()
    await tick()
    const st = orch.getStatus().perUnit.TGJ1
    expect(st.source).toBe(null)
    expect(onData.mock.calls.at(-1)[0].units.find((u) => u.id === 'TGJ1').valueMW).toBe(null)
  })

  it('getStatus expone pmeEnabled=false y pme=null', async () => {
    vi.useFakeTimers()
    buildOff()
    await orch.start()
    const status = orch.getStatus()
    expect(status.pmeEnabled).toBe(false)
    expect(status.pme).toBe(null)
  })

  it('sanity flag-on: pmeEnabled=true explícito conmuta a pme al agotar el TTL (como hoy)', async () => {
    vi.useFakeTimers()
    const meter = makeFakeSubExtractor()
    const pme = makeFakeSubExtractor()
    orch = new ExtractorOrchestrator({
      units: buildUnits(),
      pme: PME_CONFIG,
      pmeEnabled: true,
      onData: vi.fn(),
      pollMs: POLL_MS,
      holdTtlMs: 2 * POLL_MS,
      meterPollerCtor: meter.ctor,
      pmeScraperCtor: pme.ctor,
    })
    await orch.start()
    expect(pme.ctor).toHaveBeenCalledTimes(1)
    emitAll(meter, 70); await tick()
    emitAll(pme, 55)
    emitAll(meter, null); await tick()
    emitAll(meter, null); await tick()
    emitAll(pme, 55)
    emitAll(meter, null); await tick()
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('pme')
    expect(orch.getStatus().pmeEnabled).toBe(true)
  })
})
