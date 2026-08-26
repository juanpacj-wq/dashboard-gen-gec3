import { describe, it, expect } from 'vitest'
import {
  linearFit, classifyRamp, trapezoidIntegral, summarizePair, energyDelta,
  stdev, percentile, EpisodeTracker,
} from '../scripts/lib/reservaStats.js'

// Genera N registros kind:'power' de un par, a `stepMs` de separación.
// primFn(i) → kW de la primaria; resFn(i, prim) → kW de la reserva.
function powerRecs(n, primFn, resFn, { stepMs = 2000, t0 = Date.parse('2026-07-21T10:00:00.000Z'), skewMs = 5 } = {}) {
  const out = []
  for (let i = 0; i < n; i++) {
    const prim = primFn(i)
    const res = resFn(i, prim)
    out.push({
      kind: 'power', ts: new Date(t0 + i * stepMs).toISOString(), pair: 'GEC3_1', unit: 'GEC3',
      prim: { ok: true, kw: prim, latencyMs: 20, err: null },
      res: { ok: true, kw: res, latencyMs: 15, err: null },
      bothOk: true, diffKw: prim - res, skewMs,
    })
  }
  return out
}

describe('linearFit', () => {
  it('recupera pendiente 1 e intercepto 0 con dos series idénticas', () => {
    const xs = [-100, -200, -300, -400]
    const fit = linearFit(xs, [...xs])
    expect(fit.slope).toBeCloseTo(1, 10)
    expect(fit.intercept).toBeCloseTo(0, 8)
    expect(fit.r2).toBeCloseTo(1, 10)
  })

  it('detecta un error de ESCALA en la pendiente, sin ensuciar el intercepto', () => {
    const xs = [-100, -200, -300, -400]
    const fit = linearFit(xs, xs.map((x) => x * 1.002))
    expect(fit.slope).toBeCloseTo(1.002, 9)
    expect(fit.intercept).toBeCloseTo(0, 6)
  })

  it('detecta un OFFSET constante en el intercepto, sin ensuciar la pendiente', () => {
    const xs = [-100, -200, -300, -400]
    const fit = linearFit(xs, xs.map((x) => x + 25))
    expect(fit.slope).toBeCloseTo(1, 9)
    expect(fit.intercept).toBeCloseTo(25, 6)
  })

  it('marca como degenerado el caso de potencia constante (no se puede estimar pendiente)', () => {
    const fit = linearFit([-50, -50, -50], [-50, -50, -50])
    expect(fit.slope).toBeNull()
    expect(fit.degenerate).toBe('x-constante')
  })

  it('devuelve nulls con menos de 2 puntos', () => {
    expect(linearFit([1], [1]).slope).toBeNull()
  })

  it('la incertidumbre de la pendiente crece cuando x casi no varía', () => {
    // Mismo ruido en y, pero en un caso la potencia recorre 40.000 kW y en el otro solo 40.
    // La pendiente del segundo caso no es confiable, y seSlope lo delata.
    const ruido = [3, -4, 2, -1, 5, -3, 1, -2, 4, -5]
    const anchos = ruido.map((_, i) => -100_000 - i * 4000)
    const angostos = ruido.map((_, i) => -100_000 - i * 4)
    const fitAncho = linearFit(anchos, anchos.map((x, i) => x + ruido[i]))
    const fitAngosto = linearFit(angostos, angostos.map((x, i) => x + ruido[i]))
    expect(fitAncho.seSlope).toBeLessThan(0.001)
    expect(fitAngosto.seSlope).toBeGreaterThan(0.1)
    // El ancho resuelve la escala; el angosto ni siquiera puede afirmar que la pendiente es 1.
    expect(Math.abs(fitAncho.slope - 1)).toBeLessThan(0.005)
    expect(2 * fitAngosto.seSlope).toBeGreaterThan(0.005)
  })
})

describe('classifyRamp', () => {
  const pts = (kws, { stepMs = 2000, skewMs = 0 } = {}) =>
    kws.map((kw, i) => ({ tsMs: 1_000_000 + i * stepMs, kw, skewMs }))

  it('no marca rampa en una serie plana con ruido', () => {
    const flags = classifyRamp(pts([-100, -100.5, -99.8, -100.2, -100]), 10)
    expect(flags.every((f) => !f.isRamp)).toBe(true)
  })

  it('marca rampa cuando dP/dt supera el umbral', () => {
    // 40 kW cada 2 s = 20 kW/s > 10 kW/s
    const flags = classifyRamp(pts([-100, -140, -180, -220]), 10)
    expect(flags.every((f) => f.isRamp)).toBe(true)
    expect(Math.abs(flags[1].dPdt)).toBeCloseTo(20, 6)
  })

  it('marca también el tick donde ARRANCA la rampa (mira la pendiente que sale)', () => {
    // plano, plano, y a partir de ahí sube fuerte: el índice 1 ya debe quedar marcado.
    const flags = classifyRamp(pts([-100, -100, -140, -180]), 10)
    expect(flags[1].isRamp).toBe(true)
  })

  it('estima el error en kW que el skew de muestreo mete durante la rampa', () => {
    // 20 kW/s con 250 ms de skew → ~5 kW de diferencia aparente, no del medidor.
    const flags = classifyRamp(pts([-100, -140, -180], { skewMs: 250 }), 10)
    expect(flags[1].skewErrKw).toBeCloseTo(5, 6)
  })

  it('no revienta con series de 0 o 1 punto', () => {
    expect(classifyRamp([], 10)).toEqual([])
    expect(classifyRamp(pts([-100]), 10)).toHaveLength(1)
  })
})

describe('trapezoidIntegral', () => {
  it('integra una potencia constante a energía = P·t', () => {
    // 100 kW durante 1 h (2 puntos separados 1 h) = 100 kWh
    const kwh = trapezoidIntegral([{ tsMs: 0, kw: 100 }, { tsMs: 3_600_000, kw: 100 }])
    expect(kwh).toBeCloseTo(100, 9)
  })

  it('promedia en una rampa lineal', () => {
    // de 0 a 200 kW en 1 h → 100 kWh
    const kwh = trapezoidIntegral([{ tsMs: 0, kw: 0 }, { tsMs: 3_600_000, kw: 200 }])
    expect(kwh).toBeCloseTo(100, 9)
  })

  it('conserva el signo (Gecelca lee negativo en frontera de entrada)', () => {
    expect(trapezoidIntegral([{ tsMs: 0, kw: -100 }, { tsMs: 3_600_000, kw: -100 }])).toBeCloseTo(-100, 9)
  })

  it('devuelve 0 con menos de 2 puntos', () => {
    expect(trapezoidIntegral([{ tsMs: 0, kw: 50 }])).toBe(0)
  })
})

describe('summarizePair — acuerdo', () => {
  it('dos medidores idénticos: sesgo 0, pendiente 1, sin mismatch de signo', () => {
    const recs = powerRecs(60, (i) => -100 - i, (_, p) => p)
    const s = summarizePair(recs)
    expect(s.total).toBe(60)
    expect(s.bothOk).toBe(60)
    expect(s.all.bias).toBeCloseTo(0, 9)
    expect(s.all.absMax).toBeCloseTo(0, 9)
    expect(s.fit.slope).toBeCloseTo(1, 8)
    expect(s.signMismatch).toBe(0)
  })

  it('mide el SESGO con signo: primaria más alta que la reserva da bias positivo', () => {
    // diff = prim − res = −100 − (−90) = −10  → la primaria lee 10 kW MÁS negativo
    const recs = powerRecs(30, () => -100, () => -90)
    const s = summarizePair(recs)
    expect(s.all.bias).toBeCloseTo(-10, 9)
    // biasPct conserva el signo: dice hacia qué lado, no solo cuánto.
    expect(s.all.biasPct).toBeCloseTo(-10, 6)  // −10 kW sobre |−100| kW de media
    expect(s.all.sigma).toBeCloseTo(0, 9)
  })

  it('el porcentaje de sesgo cambia de signo cuando se invierte quién lee más alto', () => {
    const arriba = summarizePair(powerRecs(30, () => -100, () => -110))
    expect(arriba.all.biasPct).toBeCloseTo(10, 6)
    const abajo = summarizePair(powerRecs(30, () => -100, () => -90))
    expect(abajo.all.biasPct).toBeCloseTo(-10, 6)
  })

  it('distingue sesgo (media) de dispersión (sigma): ruido simétrico no genera sesgo', () => {
    const recs = powerRecs(40, () => -1000, (i) => -1000 + (i % 2 === 0 ? 5 : -5))
    const s = summarizePair(recs)
    expect(s.all.bias).toBeCloseTo(0, 6)
    expect(s.all.sigma).toBeGreaterThan(4)
    expect(s.all.absP50).toBeCloseTo(5, 6)
  })

  it('normaliza las tolerancias contra la potencia media absoluta de la ventana', () => {
    const recs = powerRecs(20, () => -200_000, () => -200_500)
    const s = summarizePair(recs)
    expect(s.meanAbsPower).toBeCloseTo(200_000, 6)
    // 500 kW sobre 200 MW = 0.25 %
    expect(s.all.absP95Pct).toBeCloseTo(0.25, 6)
  })

  it('NO descarta un tick solo por haber rampa: con skew despreciable sigue siendo usable', () => {
    // Rampa fuerte (25 kW/s) pero 5 ms de desfase → 0.125 kW de error, contra una tolerancia
    // de 0.5 % de 1000 kW = 5 kW. Descartar acá tiraría la ventana entera a la basura, y
    // encima es la rampa la que le da rango a la regresión.
    const recs = powerRecs(60, (i) => -1000 - i * 50, (_, p) => p, { skewMs: 5 })
    const s = summarizePair(recs, { rampKwPerSec: 10 })
    expect(s.rampTicks).toBe(60)      // la unidad sí se estaba moviendo
    expect(s.clean.n).toBe(60)        // pero ningún tick está contaminado
    expect(s.skewed.n).toBe(0)
    expect(s.fit.n).toBe(60)
  })

  it('descarta los ticks donde el desfase explica por sí solo parte de la tolerancia', () => {
    // Misma rampa de 25 kW/s pero con 1 s de desfase → 25 kW de error aparente, muy por
    // encima del 10 % de la tolerancia (0.5 kW).
    const recs = powerRecs(60, (i) => -1000 - i * 50, (_, p) => p, { skewMs: 1000 })
    const s = summarizePair(recs, { rampKwPerSec: 10 })
    expect(s.clean.n).toBe(0)
    expect(s.skewed.n).toBe(60)
    expect(s.fit.n).toBe(0)
  })

  it('clean + skewed cubren todos los ticks con ambos medidores OK', () => {
    const recs = powerRecs(40, (i) => -1000 - i * 10, (_, p) => p)
    const s = summarizePair(recs)
    expect(s.clean.n + s.skewed.n).toBe(s.bothOk)
  })
})

describe('summarizePair — disponibilidad', () => {
  it('cuenta nulls por lado y su co-ocurrencia', () => {
    const recs = powerRecs(10, () => -100, (_, p) => p)
    recs[2].prim = { ok: false, kw: null, latencyMs: null, err: 'MeterTimeoutError: timeout' }
    recs[2].bothOk = false
    recs[5].res = { ok: false, kw: null, latencyMs: null, err: 'MeterError: ECONNRESET' }
    recs[5].bothOk = false
    recs[7].prim = { ok: false, kw: null, latencyMs: null, err: 'MeterTimeoutError: timeout' }
    recs[7].res = { ok: false, kw: null, latencyMs: null, err: 'MeterTimeoutError: timeout' }
    recs[7].bothOk = false

    const s = summarizePair(recs)
    expect(s.primNull).toBe(2)
    expect(s.resNull).toBe(2)
    expect(s.co).toEqual({ bothOk: 7, primOnlyNull: 1, resOnlyNull: 1, bothNull: 1 })
    expect(s.primErrs).toEqual({ MeterTimeoutError: 2 })
    expect(s.bothOk).toBe(7)
  })

  it('sobrevive a una ventana sin un solo tick bueno', () => {
    const recs = powerRecs(5, () => -100, (_, p) => p)
    for (const r of recs) {
      r.prim = { ok: false, kw: null, latencyMs: null, err: 'MeterError: EHOSTUNREACH' }
      r.bothOk = false
    }
    const s = summarizePair(recs)
    expect(s.bothOk).toBe(0)
    expect(s.meanAbsPower).toBeNull()
    expect(s.fit.slope).toBeNull()
    expect(s.all.n).toBe(0)
  })

  it('detecta mismatch de signo solo cuando supera la tolerancia relativa', () => {
    // Media |P| = 1000 kW, tolerancia 0.5 % = 5 kW. Un cruce de signo de ±1 kW es ruido
    // alrededor de cero y NO debe contar; uno de ±50 kW sí.
    const ruido = powerRecs(2, () => 1, () => -1)
    expect(summarizePair([...powerRecs(20, () => -1000, (_, p) => p), ...ruido]).signMismatch).toBe(0)
    const real = powerRecs(2, () => 50, () => -50)
    expect(summarizePair([...powerRecs(20, () => -1000, (_, p) => p), ...real]).signMismatch).toBe(2)
  })
})

describe('energyDelta', () => {
  const eRecs = (primVals, resVals, t0 = Date.parse('2026-07-21T10:00:00.000Z')) =>
    primVals.map((p, i) => ({
      kind: 'energy', ts: new Date(t0 + i * 60_000).toISOString(), pair: 'GEC32',
      prim: { ok: true, raw: p, err: null },
      res: { ok: true, raw: resVals[i], err: null },
    }))

  it('compara el AVANCE del contador, no el absoluto (los totales no son comparables)', () => {
    // Primaria arrancó hace años (68 M) y la reserva es nueva (2 M): igual avanzan lo mismo.
    const recs = eRecs([68_713_872, 68_717_872], [2_439_616, 2_443_616])
    const e = energyDelta(recs)
    expect(e.prim.delta).toBe(4000)
    expect(e.res.delta).toBe(4000)
    expect(e.ratio).toBeCloseTo(1, 9)
    expect(e.relDiffPct).toBeCloseTo(0, 9)
  })

  it('cuantifica una diferencia de avance en %', () => {
    const e = energyDelta(eRecs([1000, 2000], [1000, 1990]))
    expect(e.relDiffPct).toBeCloseTo(1, 6)   // 990 vs 1000 = 1 %
  })

  it('devuelve delta null con menos de 2 muestras buenas de un lado', () => {
    const recs = eRecs([1000, 2000], [1000, 2000])
    recs[1].res = { ok: false, raw: null, err: 'MeterTimeoutError: t' }
    const e = energyDelta(recs)
    expect(e.prim.delta).toBe(1000)
    expect(e.res.delta).toBeNull()
  })
})

describe('helpers', () => {
  it('percentile toma el valor de la posición, con arreglo ordenado', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(xs, 50)).toBe(6)
    expect(percentile(xs, 95)).toBe(10)
    expect(percentile([], 50)).toBeNull()
  })

  it('stdev necesita al menos 2 puntos', () => {
    expect(stdev([5])).toBeNull()
    expect(stdev([1, 1, 1])).toBeCloseTo(0, 9)
    expect(stdev([2, 4])).toBeCloseTo(Math.SQRT2, 9)
  })

  it('EpisodeTracker agrupa nulls consecutivos en un solo episodio', () => {
    const t = new EpisodeTracker()
    t.add('2026-07-21T10:00:00.000Z', false)
    t.add('2026-07-21T10:00:02.000Z', true, 'MeterTimeoutError')
    t.add('2026-07-21T10:00:04.000Z', true, 'MeterTimeoutError')
    t.add('2026-07-21T10:00:06.000Z', false)
    t.add('2026-07-21T10:00:08.000Z', true, 'MeterError')
    const eps = t.finish()
    expect(eps).toHaveLength(2)
    expect(eps[0]).toMatchObject({ ticks: 2, durSec: 2, errType: 'MeterTimeoutError' })
    expect(eps[1].ticks).toBe(1)
  })
})
