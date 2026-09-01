import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ExtractorOrchestrator } from '../extractorOrchestrator.js'

const POLL_MS = 1000

function buildUnits() {
  return [
    {
      id: 'TGJ1', label: 'GUAJIRA 1', maxMW: 145, combine: 'single', frontierType: 'output',
      meters: [{ host: '10.0.0.10', user: 'u', password: 'p' }],
    },
    {
      id: 'TGJ2', label: 'GUAJIRA 2', maxMW: 130, combine: 'single', frontierType: 'output',
      meters: [{ host: '10.0.0.11', user: 'u', password: 'p' }],
    },
    {
      id: 'GEC3', label: 'GECELCA 3', maxMW: 164, combine: 'sum', frontierType: 'input',
      meters: [
        { host: '10.0.0.12', user: 'u', password: 'p' },
        { host: '10.0.0.13', user: 'u', password: 'p' },
      ],
    },
    {
      id: 'GEC32', label: 'GECELCA 32', maxMW: 270, combine: 'single', frontierType: 'input',
      meters: [{ host: '10.0.0.14', user: 'u', password: 'p' }],
    },
  ]
}

// Fake MeterPoller que el test controla manualmente.
//
// La implementación del spy es una `function`, NO una flecha: el orquestador lo invoca con
// `new meterPollerCtor({...})` (D-126) y una flecha no tiene [[Construct]] — el doble reventaba
// con "is not a constructor" antes de que el test llegara a su primer assert. Se apoya en la
// semántica de que un constructor que devuelve un objeto devuelve ESE objeto, así que el cuerpo
// sigue siendo el mismo literal de siempre. El sustituto de un `class` tiene que ser
// construible: si mañana `MeterPoller` dejara de serlo, es este doble el que debe cambiar.
function makeFakeSubExtractor() {
  let storedOnData = null
  const ctor = vi.fn(function ({ onData }) {
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

function buildOrchestrator({ onData = vi.fn(), holdTtlMs } = {}) {
  const meter = makeFakeSubExtractor()
  const orch = new ExtractorOrchestrator({
    units: buildUnits(),
    onData,
    pollMs: POLL_MS,
    holdTtlMs,  // undefined → default 3 min; los tests de expiración pasan un TTL corto
    meterPollerCtor: meter.ctor,
  })
  return { orch, meter, onData }
}

// Emite el mismo valor para las 4 unidades.
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

describe('ExtractorOrchestrator constructor', () => {
  it('lanza si units está vacío', () => {
    expect(() => new ExtractorOrchestrator({ units: [], onData: () => {} }))
      .toThrow(TypeError)
  })
  it('lanza si onData no es función', () => {
    expect(() => new ExtractorOrchestrator({ units: buildUnits(), onData: null }))
      .toThrow(TypeError)
  })
  it('NO exige config de una segunda fuente: units + onData bastan (D-126)', () => {
    expect(() => new ExtractorOrchestrator({ units: buildUnits(), onData: () => {} }))
      .not.toThrow()
  })
})

describe('ExtractorOrchestrator — caso ideal (medidor sirviendo)', () => {
  let orch, meter, onData
  beforeEach(() => {
    vi.useFakeTimers()
    ;({ orch, meter, onData } = buildOrchestrator())
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
    // D-125: el -0.5 del medidor (auxiliares en frontera de entrada) ya no se propaga como
    // generación; el canónico es 0 y el crudo queda visible en valueMwRaw.
    expect(last.units.find((u) => u.id === 'GEC3').valueMW).toBe(0)
    expect(last.units.find((u) => u.id === 'GEC3').valueMwRaw).toBe(-0.5)

    const status = orch.getStatus()
    for (const id of ['TGJ1', 'TGJ2', 'GEC3', 'GEC32']) {
      expect(status.perUnit[id].source).toBe('meter')
    }
  })
})

describe('ExtractorOrchestrator — carry-forward con TTL (D-116)', () => {
  let orch, meter, onData
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

describe('ExtractorOrchestrator — TTL expira → null (fuente única, D-126)', () => {
  let orch, meter, onData
  afterEach(async () => { await orch.stop(); vi.useRealTimers() })

  const valueOf = (last, id) => last.units.find((u) => u.id === id).valueMW

  it('TTL expira → valueMW=null, holding=false, source previo (caso 5)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, onData } = buildOrchestrator({ holdTtlMs: 2 * POLL_MS }))
    await orch.start()
    emitAll(meter, 50); await tick()
    emitAll(meter, null); await tick()                     // HOLD
    emitAll(meter, null); await tick()                     // TTL expira

    const st = orch.getStatus().perUnit.TGJ1
    expect(st.holding).toBe(false)
    expect(st.source).toBe('meter')                        // conserva histéresis
    expect(valueOf(onData.mock.calls.at(-1)[0], 'TGJ1')).toBeNull()  // sin spike
  })

  it('arranque sin lastGoodMeter + null → null sin spike (caso 6b)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, onData } = buildOrchestrator())
    await orch.start()
    emitAll(meter, null); await tick()

    expect(orch.getStatus().perUnit.TGJ1.source).toBeNull()
    expect(valueOf(onData.mock.calls.at(-1)[0], 'TGJ1')).toBeNull()
  })

  it('flapping ok/null/ok/null resetea el TTL → nunca deja de servir (caso 8)', async () => {
    vi.useFakeTimers()
    ;({ orch, meter } = buildOrchestrator({ holdTtlMs: 2 * POLL_MS }))
    await orch.start()
    emitAll(meter, 50); await tick()
    for (let i = 0; i < 3; i++) {
      emitAll(meter, null); await tick()  // 1 null (gap < TTL) → HOLD
      emitAll(meter, 50);   await tick()  // OK resetea lastGood.at
      expect(orch.getStatus().perUnit.TGJ1.source).toBe('meter')
    }
  })

  it('el medidor vuelve tras el null: reanuda emisión de valor', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, onData } = buildOrchestrator({ holdTtlMs: 2 * POLL_MS }))
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
})

describe('ExtractorOrchestrator — independencia entre unidades', () => {
  it('TGJ1 puede quedar sin lectura mientras TGJ2/GEC3/GEC32 siguen en meter', async () => {
    vi.useFakeTimers()
    const { orch, meter, onData } = buildOrchestrator({ holdTtlMs: 2 * POLL_MS })
    try {
      await orch.start()

      // Todas en meter inicialmente
      meter.emit([
        { id: 'TGJ1', label: 'GUAJIRA 1', valueMW: 70, maxMW: 145 },
        { id: 'TGJ2', label: 'GUAJIRA 2', valueMW: 60, maxMW: 130 },
        { id: 'GEC3', label: 'GECELCA 3', valueMW: -0.5, maxMW: 164 },
        { id: 'GEC32', label: 'GECELCA 32', valueMW: -3, maxMW: 270 },
      ])
      await tick()

      // Solo TGJ1 falla; las otras siguen sirviendo
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
      expect(status.perUnit.TGJ1.holding).toBe(false)   // TTL agotado
      expect(status.perUnit.TGJ2.source).toBe('meter')
      expect(status.perUnit.GEC3.source).toBe('meter')
      expect(status.perUnit.GEC32.source).toBe('meter')

      const last = onData.mock.calls.at(-1)[0]
      expect(last.units.find((u) => u.id === 'TGJ1').valueMW).toBeNull()
      expect(last.units.find((u) => u.id === 'TGJ2').valueMW).toBe(60)
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
  it('expone los campos de estado del extractor, sin rastro de una 2ª fuente (D-126)', async () => {
    vi.useFakeTimers()
    const { orch, meter } = buildOrchestrator()
    await orch.start()
    meter.emit(buildUnits().map((u) => ({ id: u.id, label: u.label, valueMW: 50, maxMW: u.maxMW })))
    await tick()

    const s = orch.getStatus()
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
    expect(s).toHaveProperty('meter')
    expect(s).toHaveProperty('perUnit')
    // El fallback se retiró: estas llaves no deben volver.
    expect(s).not.toHaveProperty('pme')
    expect(s).not.toHaveProperty('pmeEnabled')
    expect(Object.keys(s.perUnit)).toHaveLength(4)
    expect(s.perUnit.TGJ1).toMatchObject({
      source: expect.any(String),
      consecMeterErrors: expect.any(Number),
      consecMeterOk: expect.any(Number),
      holding: false,
      heldTicks: expect.any(Number),
      meterDownSeconds: expect.any(Number),
    })
    expect(s.perUnit.TGJ1).not.toHaveProperty('pmeValue')

    await orch.stop()
    vi.useRealTimers()
  })

  it('getTickSnapshot no expone campos de una 2ª fuente (D-126)', async () => {
    vi.useFakeTimers()
    const { orch, meter } = buildOrchestrator()
    await orch.start()
    emitAll(meter, 50); await tick()

    const snap = orch.getTickSnapshot('TGJ1')
    expect(snap).toHaveProperty('meterRaw')
    expect(snap).not.toHaveProperty('pmeRaw')
    expect(snap).not.toHaveProperty('pmeAgeMs')

    await orch.stop()
    vi.useRealTimers()
  })
})

describe('ExtractorOrchestrator — el fallback no vuelve por la puerta de atrás (D-126)', () => {
  it('los args legacy pme/pmeEnabled/pmeScraperCtor son inertes: nada se instancia', async () => {
    vi.useFakeTimers()
    const meter = makeFakeSubExtractor()
    const pmeCtorEspia = vi.fn()
    const orch = new ExtractorOrchestrator({
      units: buildUnits(),
      onData: vi.fn(),
      pollMs: POLL_MS,
      // Restos de la configuración vieja: deben ser descartados por el destructuring.
      pme: { loginUrl: 'x', diagramUrl: 'x', user: 'x', password: 'x' },
      pmeEnabled: true,
      pmeScraperCtor: pmeCtorEspia,
      recoveryThreshold: 2,
      fallbackThreshold: 3,
      meterPollerCtor: meter.ctor,
    })
    try {
      await orch.start()
      emitAll(meter, 70); await tick()
      expect(pmeCtorEspia).not.toHaveBeenCalled()
      expect(orch.getStatus().perUnit.TGJ1.source).toBe('meter')
    } finally {
      await orch.stop()
      vi.useRealTimers()
    }
  })
})

describe('ExtractorOrchestrator — start no bloquea si el sub-extractor no resuelve', () => {
  // Regresión heredada del PMEScraper (su start() nunca resolvía). La invariante sigue
  // valiendo para cualquier sub-extractor: el orquestador NO debe await-earlo en start,
  // porque si lo hace los setInterval de #tick/#heartbeat nunca se programan.
  it('tickea aunque meterPoller.start() nunca resuelva', async () => {
    vi.useFakeTimers()
    const onData = vi.fn()

    let storedOnData = null
    let startResolver
    // `function` y no flecha, por la misma razón que el doble de `makeFakeSubExtractor`.
    const meterCtor = vi.fn(function ({ onData: cb }) {
      storedOnData = cb
      return {
        start: vi.fn(() => new Promise((resolve) => { startResolver = resolve })),
        stop: vi.fn(() => { startResolver?.(); return Promise.resolve() }),
        getStatus: vi.fn(() => ({ running: true })),
      }
    })

    const orch = new ExtractorOrchestrator({
      units: buildUnits(),
      onData,
      pollMs: POLL_MS,
      meterPollerCtor: meterCtor,
    })
    try {
      await orch.start()  // no debe colgarse esperando al poller
      storedOnData({
        type: 'update',
        units: buildUnits().map((u) => ({ id: u.id, label: u.label, valueMW: 50, maxMW: u.maxMW })),
        timestamp: new Date().toISOString(),
      })
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
  it('stop() detiene los timers y el sub-extractor', async () => {
    vi.useFakeTimers()
    const { orch, meter, onData } = buildOrchestrator()
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

describe('ExtractorOrchestrator — invariante de generación (D-125)', () => {
  let orch, meter, onData
  afterEach(async () => { await orch?.stop(); vi.useRealTimers() })

  const unitOf = (last, id) => last.units.find((u) => u.id === id)

  // Caso GEC32 del 2026-07-30: la unidad estaba parada consumiendo auxiliares y el medidor,
  // que está en frontera de entrada, entregaba ≈ -14.7 MW. Ese negativo se integraba como
  // energía y terminaba en una desviación de -142.27% en desviacion_periodos.
  it('unidad en reserva: el medidor entrega -14.7 → canónico 0, crudo visible', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, onData } = buildOrchestrator())
    await orch.start()
    emitAll(meter, -14.7); await tick()

    const gec32 = unitOf(onData.mock.calls.at(-1)[0], 'GEC32')
    expect(gec32.valueMW).toBe(0)
    expect(gec32.valueMwRaw).toBe(-14.7)
    expect(gec32.source).toBe('meter')
  })

  // LIVENESS — este test es el que impide que el clamp se coma la alerta de medidor caído.
  // null significa "sin lectura", no "cero": si el canónico fuera 0, el accumulator volvería
  // a integrar (D-105/D-116 hacen continue con null) y el medidor muerto se vería sano.
  it('medidor muerto: null sigue siendo null, nunca 0', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, onData } = buildOrchestrator({ holdTtlMs: 2 * POLL_MS }))
    await orch.start()

    // Arranque en frío sin lastGoodMeter
    emitAll(meter, null); await tick()
    let tgj1 = unitOf(onData.mock.calls.at(-1)[0], 'TGJ1')
    expect(tgj1.valueMW).toBeNull()
    expect(tgj1.valueMwRaw).toBeNull()

    // Y también después de haber tenido lecturas buenas, con el TTL del hold ya expirado
    emitAll(meter, 50); await tick()
    emitAll(meter, null); await tick()   // HOLD
    emitAll(meter, null); await tick()   // TTL expira
    tgj1 = unitOf(onData.mock.calls.at(-1)[0], 'TGJ1')
    expect(tgj1.valueMW).toBeNull()
    expect(tgj1.valueMwRaw).toBeNull()
  })

  it('hold (D-116) con último valor bueno negativo: retiene -14.7 crudo y sirve 0', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, onData } = buildOrchestrator())   // TTL default 3 min: no expira
    await orch.start()
    emitAll(meter, -14.7); await tick()
    emitAll(meter, null); await tick()

    const gec3 = unitOf(onData.mock.calls.at(-1)[0], 'GEC3')
    expect(gec3.valueMW).toBe(0)
    expect(gec3.valueMwRaw).toBe(-14.7)
    expect(gec3.holding).toBe(true)
    expect(gec3.source).toBe('meter')
    // El carry-forward guarda el crudo: el clamp no contamina la evidencia forense.
    expect(orch.getTickSnapshot('GEC3').lastGoodMeterValue).toBe(-14.7)
  })

  it('generación real: el clamp no toca valores válidos', async () => {
    vi.useFakeTimers()
    ;({ orch, meter, onData } = buildOrchestrator())
    await orch.start()
    emitAll(meter, 150); await tick()

    const gec32 = unitOf(onData.mock.calls.at(-1)[0], 'GEC32')
    expect(gec32.valueMW).toBe(150)
    expect(gec32.valueMwRaw).toBe(150)
  })

  it('los caches quedan crudos: getStatus().meterValue y getTickSnapshot() no se clampan', async () => {
    vi.useFakeTimers()
    ;({ orch, meter } = buildOrchestrator())
    await orch.start()
    emitAll(meter, -14.7); await tick()

    // Observabilidad del extractor ≠ dato de negocio: acá se ve lo que el medidor midió.
    expect(orch.getStatus().perUnit.GEC32.meterValue).toBe(-14.7)
    expect(orch.getTickSnapshot('GEC32').meterRaw).toBe(-14.7)
  })
})
