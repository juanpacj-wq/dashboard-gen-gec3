import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MeterPoller } from '../meterPoller.js'
import { MeterAuthError, MeterTimeoutError } from '../meterClient.js'

function makeFakeClient() {
  const client = {
    fetchKwTotal: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }
  return client
}

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

describe('MeterPoller — constructor validation', () => {
  it('throws when units is empty', () => {
    expect(() => new MeterPoller({ units: [], onData: () => {} })).toThrow(TypeError)
  })
  it('throws when onData is not a function', () => {
    expect(() => new MeterPoller({ units: buildUnits(), onData: null })).toThrow(TypeError)
  })
  it('throws when a unit has multiple meters but combine is not "sum"', () => {
    const bad = [{
      id: 'X', label: 'X', maxMW: 10, combine: 'single',
      meters: [{ host: 'a', user: 'u', password: 'p' }, { host: 'b', user: 'u', password: 'p' }],
    }]
    expect(() => new MeterPoller({ units: bad, onData: () => {} })).toThrow(/combine/)
  })
})

describe('MeterPoller — happy path', () => {
  let onData, units, clients, factory, poller

  beforeEach(() => {
    vi.useFakeTimers()
    onData = vi.fn()
    units = buildUnits()
    clients = new Map()
    factory = ({ host }) => {
      const c = makeFakeClient()
      clients.set(host, c)
      return c
    }
  })

  afterEach(async () => {
    if (poller) await poller.stop()
    vi.useRealTimers()
  })

  it('emits a payload with the contract shape on the first tick', async () => {
    clients = new Map()
    factory = ({ host }) => {
      const c = makeFakeClient()
      const map = { '10.0.0.10': 140320, '10.0.0.11': 128500, '10.0.0.12': 80100, '10.0.0.13': 84000, '10.0.0.14': 265000 }
      c.fetchKwTotal.mockResolvedValue({ kw: map[host], fetchedAt: new Date().toISOString(), latencyMs: 50 })
      clients.set(host, c)
      return c
    }
    poller = new MeterPoller({ units, onData, pollMs: 1000, clientFactory: factory })
    await poller.start()
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    expect(onData).toHaveBeenCalled()
    const payload = onData.mock.calls[0][0]
    expect(payload.type).toBe('update')
    expect(typeof payload.timestamp).toBe('string')
    expect(payload.units).toHaveLength(4)
    for (const u of payload.units) {
      expect(u).toHaveProperty('id')
      expect(u).toHaveProperty('label')
      expect(u).toHaveProperty('valueMW')
      expect(u).toHaveProperty('maxMW')
    }
  })

  it('TGJ output positivo · GEC suma e invierte signo (frontera input)', async () => {
    factory = ({ host }) => {
      const c = makeFakeClient()
      const map = { '10.0.0.10': 140320, '10.0.0.11': 128500, '10.0.0.12': 80100, '10.0.0.13': 84000, '10.0.0.14': 265000 }
      c.fetchKwTotal.mockResolvedValue({ kw: map[host], fetchedAt: new Date().toISOString(), latencyMs: 50 })
      return c
    }
    poller = new MeterPoller({ units, onData, pollMs: 1000, clientFactory: factory })
    await poller.start()
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    const payload = onData.mock.calls.at(-1)[0]
    const tgj1 = payload.units.find((u) => u.id === 'TGJ1')
    const gec3 = payload.units.find((u) => u.id === 'GEC3')
    const gec32 = payload.units.find((u) => u.id === 'GEC32')
    // Guajiras: frontera 'output' → valor del medidor pasa tal cual.
    expect(tgj1.valueMW).toBeCloseTo(140.32, 2)
    // Gecelca: frontera 'input' → suma e invierte. (80.1 + 84.0) → −164.1
    expect(gec3.valueMW).toBeCloseTo(-164.1, 2)
    // GEC32: frontera 'input' → 265.0 invertido → −265.0
    expect(gec32.valueMW).toBeCloseTo(-265.0, 2)
  })
})

describe('MeterPoller — failure semantics', () => {
  let onData, units, poller

  beforeEach(() => {
    vi.useFakeTimers()
    onData = vi.fn()
    units = buildUnits()
  })

  afterEach(async () => {
    if (poller) await poller.stop()
    vi.useRealTimers()
  })

  it('GEC3 valueMW=null when one of its 2 meters fails (no partial)', async () => {
    const factory = ({ host }) => {
      const c = makeFakeClient()
      if (host === '10.0.0.13') {
        c.fetchKwTotal.mockRejectedValue(new MeterTimeoutError('boom', { host }))
      } else {
        c.fetchKwTotal.mockResolvedValue({ kw: 80000, fetchedAt: '', latencyMs: 0 })
      }
      return c
    }
    poller = new MeterPoller({ units, onData, pollMs: 1000, clientFactory: factory })
    await poller.start()
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    const payload = onData.mock.calls.at(-1)[0]
    const gec3 = payload.units.find((u) => u.id === 'GEC3')
    const tgj1 = payload.units.find((u) => u.id === 'TGJ1')
    expect(gec3.valueMW).toBeNull()
    expect(tgj1.valueMW).not.toBeNull()
  })

  it('one unit failing does NOT affect other units', async () => {
    const factory = ({ host }) => {
      const c = makeFakeClient()
      if (host === '10.0.0.10') {
        c.fetchKwTotal.mockRejectedValue(new MeterAuthError('401', { host }))
      } else {
        c.fetchKwTotal.mockResolvedValue({ kw: 50000, fetchedAt: '', latencyMs: 0 })
      }
      return c
    }
    poller = new MeterPoller({ units, onData, pollMs: 1000, clientFactory: factory })
    await poller.start()
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    const payload = onData.mock.calls.at(-1)[0]
    const tgj1 = payload.units.find((u) => u.id === 'TGJ1')
    const tgj2 = payload.units.find((u) => u.id === 'TGJ2')
    const gec32 = payload.units.find((u) => u.id === 'GEC32')
    expect(tgj1.valueMW).toBeNull()
    expect(tgj2.valueMW).toBeCloseTo(50, 2)        // frontera output
    expect(gec32.valueMW).toBeCloseTo(-50, 2)      // frontera input → invertido
  })

  it('zero kW is preserved (unit not despachada, NOT treated as null) y −0 se normaliza a 0', async () => {
    const factory = ({ host }) => {
      const c = makeFakeClient()
      c.fetchKwTotal.mockResolvedValue({ kw: 0, fetchedAt: '', latencyMs: 0 })
      return c
    }
    poller = new MeterPoller({ units, onData, pollMs: 1000, clientFactory: factory })
    await poller.start()
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    const payload = onData.mock.calls.at(-1)[0]
    for (const u of payload.units) {
      expect(u.valueMW).toBe(0)
      expect(Object.is(u.valueMW, -0)).toBe(false) // garantía explícita
    }
  })
})

describe('MeterPoller.getStatus', () => {
  it('returns shape compatible with PMEScraper.getStatus()', async () => {
    vi.useFakeTimers()
    const onData = vi.fn()
    const factory = ({ host }) => {
      const c = makeFakeClient()
      c.fetchKwTotal.mockResolvedValue({ kw: 100, fetchedAt: '', latencyMs: 0 })
      return c
    }
    const poller = new MeterPoller({ units: buildUnits(), onData, pollMs: 1000, clientFactory: factory })

    const before = poller.getStatus()
    expect(before).toMatchObject({
      running: false,
      warming: false,
      lastDataAt: null,
      secondsSinceUpdate: null,
      updateCount: 0,
      errorCount: 0,
      stale: expect.any(Boolean),
    })
    expect(before.perMeter).toBeTypeOf('object')

    await poller.start()
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    const after = poller.getStatus()
    expect(after.running).toBe(true)
    expect(after.warming).toBe(false)
    expect(after.updateCount).toBeGreaterThanOrEqual(1)
    expect(after.lastDataAt).toBeTypeOf('string')
    expect(Object.keys(after.perMeter)).toHaveLength(5)

    await poller.stop()
    vi.useRealTimers()
  })
})

describe('MeterPoller — convención de signos (frontera input/output)', () => {
  let poller
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(async () => { if (poller) await poller.stop(); vi.useRealTimers() })

  async function runOneTick(units, kwByHost) {
    const onData = vi.fn()
    const factory = ({ host }) => {
      const c = makeFakeClient()
      c.fetchKwTotal.mockResolvedValue({ kw: kwByHost[host], fetchedAt: '', latencyMs: 0 })
      return c
    }
    poller = new MeterPoller({ units, onData, pollMs: 1000, clientFactory: factory })
    await poller.start()
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    return onData.mock.calls.at(-1)[0]
  }

  it("frontierType:'output' (Guajira) — pasa el valor del medidor sin tocar", async () => {
    const units = [{
      id: 'TGJ', label: 'TGJ', maxMW: 145, combine: 'single', frontierType: 'output',
      meters: [{ host: 'h1', user: 'u', password: 'p' }],
    }]
    const positive = await runOneTick(units, { h1: 72800 })
    expect(positive.units[0].valueMW).toBeCloseTo(72.8, 2)
    const negative = await runOneTick(units, { h1: -3000 })
    expect(negative.units[0].valueMW).toBeCloseTo(-3.0, 2)
  })

  it("frontierType:'input' (Gecelca) — invierte el signo del medidor", async () => {
    const units = [{
      id: 'GEC', label: 'GEC', maxMW: 164, combine: 'single', frontierType: 'input',
      meters: [{ host: 'h1', user: 'u', password: 'p' }],
    }]
    // Planta en reserva consumiendo aux: medidor reporta +740 W → debe ser −0.74 MW (PME convention).
    const aux = await runOneTick(units, { h1: 740 })
    expect(aux.units[0].valueMW).toBeCloseTo(-0.74, 3)
    // Planta generando: medidor reporta −150000 W → debe ser +150 MW.
    const gen = await runOneTick(units, { h1: -150000 })
    expect(gen.units[0].valueMW).toBeCloseTo(150.0, 2)
  })

  it("frontierType:'input' + combine:'sum' (GEC3 con 2 medidores) — suma luego invierte", async () => {
    const units = [{
      id: 'GEC3', label: 'GEC3', maxMW: 164, combine: 'sum', frontierType: 'input',
      meters: [
        { host: 'a', user: 'u', password: 'p' },
        { host: 'b', user: 'u', password: 'p' },
      ],
    }]
    // Caso real observado: ambos medidores reportan ~398 + ~347 = ~745 kW (planta en reserva).
    // Resultado esperado: −(398.05 + 347.01) / 1000 = −0.745 MW.
    const reserva = await runOneTick(units, { a: 398.05, b: 347.01 })
    expect(reserva.units[0].valueMW).toBeCloseTo(-0.745, 3)
  })

  it('valida que frontierType desconocido es rechazado en config (defensa en profundidad)', () => {
    const bad = [{
      id: 'X', label: 'X', maxMW: 10, combine: 'single', frontierType: 'lateral',
      meters: [{ host: 'h', user: 'u', password: 'p' }],
    }]
    // El poller mismo no rechaza (lo valida config.js). Aquí solo verificamos que no
    // explote: frontierType desconocido = no invertir (comportamiento conservador).
    expect(() => new MeterPoller({ units: bad, onData: () => {} })).not.toThrow()
  })
})

describe('MeterPoller — lifecycle', () => {
  it('stop() prevents further ticks', async () => {
    vi.useFakeTimers()
    const onData = vi.fn()
    const factory = ({ host }) => {
      const c = makeFakeClient()
      c.fetchKwTotal.mockResolvedValue({ kw: 100, fetchedAt: '', latencyMs: 0 })
      return c
    }
    const poller = new MeterPoller({ units: buildUnits(), onData, pollMs: 1000, clientFactory: factory })
    await poller.start()
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    const callsAfterStart = onData.mock.calls.length
    await poller.stop()
    await vi.advanceTimersByTimeAsync(5000)

    expect(onData.mock.calls.length).toBe(callsAfterStart)
    vi.useRealTimers()
  })
})
