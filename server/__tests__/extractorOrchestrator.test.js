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

function buildOrchestrator({ onData = vi.fn(), fallbackThreshold = 3, recoveryThreshold = 2 } = {}) {
  const meter = makeFakeSubExtractor()
  const pme = makeFakeSubExtractor()
  const orch = new ExtractorOrchestrator({
    units: buildUnits(),
    pme: PME_CONFIG,
    onData,
    pollMs: POLL_MS,
    fallbackThreshold,
    recoveryThreshold,
    meterPollerCtor: meter.ctor,
    pmeScraperCtor: pme.ctor,
  })
  return { orch, meter, pme, onData }
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

describe('ExtractorOrchestrator — histeresis primario → fallback', () => {
  let orch, meter, pme, onData
  beforeEach(() => {
    vi.useFakeTimers()
    ;({ orch, meter, pme, onData } = buildOrchestrator({ fallbackThreshold: 3 }))
  })
  afterEach(async () => { await orch.stop(); vi.useRealTimers() })

  async function emitMeterAll(value) {
    meter.emit(buildUnits().map((u) => ({ id: u.id, label: u.label, valueMW: value, maxMW: u.maxMW })))
  }
  async function emitPmeAll(value) {
    pme.emit(buildUnits().map((u) => ({ id: u.id, label: u.label, valueMW: value, maxMW: u.maxMW })))
  }

  it('después de 1 error meter mantiene source=meter (no switchea aún)', async () => {
    await orch.start()
    await emitMeterAll(50); await emitPmeAll(60); await tick()
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('meter')

    // Tick con meter null
    await emitMeterAll(null); await tick()
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('meter')
    expect(orch.getStatus().perUnit.TGJ1.consecMeterErrors).toBe(1)
  })

  it('después de 3 errores consecutivos switchea a pme', async () => {
    await orch.start()
    await emitMeterAll(50); await emitPmeAll(60); await tick()

    await emitMeterAll(null); await tick()  // error 1
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('meter')
    await emitMeterAll(null); await tick()  // error 2
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('meter')
    await emitMeterAll(null); await tick()  // error 3 — switch
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('pme')
  })

  it('durante la ventana de transición (errores 1-2) el output es null para esa unidad', async () => {
    await orch.start()
    await emitMeterAll(50); await emitPmeAll(60); await tick()

    await emitMeterAll(null); await tick()  // error 1
    let last = onData.mock.calls.at(-1)[0]
    expect(last.units.find((u) => u.id === 'TGJ1').valueMW).toBeNull()

    await emitMeterAll(null); await tick()  // error 2
    last = onData.mock.calls.at(-1)[0]
    expect(last.units.find((u) => u.id === 'TGJ1').valueMW).toBeNull()

    await emitMeterAll(null); await tick()  // error 3 — switch, value desde pme
    last = onData.mock.calls.at(-1)[0]
    expect(last.units.find((u) => u.id === 'TGJ1').valueMW).toBe(60)
  })

  it('si pme tampoco tiene valor, switch no ocurre y output sigue null', async () => {
    await orch.start()
    await emitMeterAll(50); await tick()  // pme no ha emitido nunca

    await emitMeterAll(null); await tick()
    await emitMeterAll(null); await tick()
    await emitMeterAll(null); await tick()  // 3 errores pero pme no tiene cache válido

    expect(orch.getStatus().perUnit.TGJ1.source).toBe('meter')  // no pudo switchear
    const last = onData.mock.calls.at(-1)[0]
    expect(last.units.find((u) => u.id === 'TGJ1').valueMW).toBeNull()
  })
})

describe('ExtractorOrchestrator — histeresis fallback → primario (recovery)', () => {
  let orch, meter, pme, onData
  beforeEach(() => {
    vi.useFakeTimers()
    ;({ orch, meter, pme, onData } = buildOrchestrator({ fallbackThreshold: 3, recoveryThreshold: 2 }))
  })
  afterEach(async () => { await orch.stop(); vi.useRealTimers() })

  async function emitMeterAll(value) {
    meter.emit(buildUnits().map((u) => ({ id: u.id, label: u.label, valueMW: value, maxMW: u.maxMW })))
  }
  async function emitPmeAll(value) {
    pme.emit(buildUnits().map((u) => ({ id: u.id, label: u.label, valueMW: value, maxMW: u.maxMW })))
  }

  it('en pme con 1 OK del meter NO recupera todavía', async () => {
    await orch.start()
    // forzar fallback
    await emitMeterAll(50); await emitPmeAll(60); await tick()
    await emitMeterAll(null); await tick()
    await emitMeterAll(null); await tick()
    await emitMeterAll(null); await tick()
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('pme')

    // 1 OK
    await emitMeterAll(50); await tick()
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('pme')
  })

  it('en pme con 2 OK consecutivos del meter recupera', async () => {
    await orch.start()
    await emitMeterAll(50); await emitPmeAll(60); await tick()
    await emitMeterAll(null); await tick()
    await emitMeterAll(null); await tick()
    await emitMeterAll(null); await tick()
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('pme')

    await emitMeterAll(50); await tick()  // OK 1
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('pme')
    await emitMeterAll(51); await tick()  // OK 2 — recovery
    expect(orch.getStatus().perUnit.TGJ1.source).toBe('meter')

    const last = onData.mock.calls.at(-1)[0]
    expect(last.units.find((u) => u.id === 'TGJ1').valueMW).toBe(51)
  })
})

describe('ExtractorOrchestrator — independencia entre unidades', () => {
  it('TGJ1 puede estar en pme mientras TGJ2/GEC3/GEC32 siguen en meter', async () => {
    vi.useFakeTimers()
    const { orch, meter, pme, onData } = buildOrchestrator({ fallbackThreshold: 3 })
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

      // Solo TGJ1 falla, las otras siguen sirviendo
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
