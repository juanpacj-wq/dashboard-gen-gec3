// Estadística pura (sin I/O) para la comparación 1-a-1 medidor primario vs medidor de
// reserva por Modbus. Vive aparte de analyze-reserva.js para poder testearla: el veredicto
// "la reserva es intercambiable" sale de acá, así que conviene que sea verificable.
//
// Convención de la diferencia en TODO el módulo:  diff = prim.kw − res.kw
//   diff > 0  → la primaria lee más alto que la reserva.
// Se conserva el SIGNO (no solo el valor absoluto) porque un sesgo sistemático y una
// dispersión aleatoria significan cosas distintas: el primero es calibración, el segundo ruido.

// ─── Helpers numéricos ────────────────────────────────────────────────────────

export function pct(part, total) {
  return total === 0 ? 0 : (part / total) * 100
}

export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length))
  return sortedAsc[idx]
}

export function mean(xs) {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length
}

// Desviación estándar muestral (n−1). Con menos de 2 puntos no está definida.
export function stdev(xs) {
  if (xs.length < 2) return null
  const m = mean(xs)
  const ss = xs.reduce((a, x) => a + (x - m) ** 2, 0)
  return Math.sqrt(ss / (xs.length - 1))
}

// ─── Regresión lineal res = slope·prim + intercept ────────────────────────────
// Es el corazón del "1 a 1". Separa dos fallas que un Δ promedio confunde:
//   slope ≠ 1      → error de ESCALA (relación de TC/TP distinta): el Δ crece con la carga.
//   intercept ≠ 0  → OFFSET constante: el Δ es el mismo a plena carga y en vacío.
// r2 dice cuánto de la variación de la reserva explica la primaria; si es bajo, los dos
// medidores no están midiendo lo mismo por más que el promedio coincida.
export function linearFit(xs, ys) {
  const n = Math.min(xs.length, ys.length)
  if (n < 2) return { slope: null, intercept: null, r2: null, n }

  const mx = mean(xs.slice(0, n))
  const my = mean(ys.slice(0, n))
  let sxx = 0, sxy = 0, syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  // Varianza cero en x: la unidad no se movió en toda la ventana. No se puede estimar
  // pendiente (cualquier recta vertical pasa por los puntos); se reporta explícitamente.
  if (sxx === 0) return { slope: null, intercept: null, r2: null, n, degenerate: 'x-constante' }

  const slope = sxy / sxx
  const intercept = my - slope * mx
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy)

  // Error estándar de la pendiente. Sin esto la regresión miente por omisión: si la unidad
  // se movió poco durante la ventana, sxx es chico y la pendiente sale con una incertidumbre
  // enorme — pero el número impreso se lee igual de contundente. Con seSlope se puede decir
  // "0.871 ± 0.09" y concluir que la ventana no alcanza para juzgar la escala, en vez de
  // reprobar un medidor sano.
  const sse = Math.max(0, syy - slope * sxy)
  const seSlope = n > 2 ? Math.sqrt((sse / (n - 2)) / sxx) : null
  return { slope, intercept, r2, n, seSlope }
}

// ─── Régimen: estable vs rampa ────────────────────────────────────────────────
// Los dos medidores no se leen en el MISMO instante (hay unos ms de skew). Mientras la
// potencia es plana eso da igual; durante una rampa, el skew se traduce en una diferencia
// aparente que NO es del medidor:  errorKw ≈ |dP/dt| · skew.
// Por eso el acuerdo se reporta también restringido a ticks estables, que es donde el Δ
// mide de verdad al medidor.
//
// points: [{ tsMs, kw, skewMs }] ordenados por tiempo. Devuelve un arreglo paralelo con
// { dPdt, isRamp, skewErrKw } — dPdt en kW/s.
export function classifyRamp(points, kwPerSecThreshold) {
  const n = points.length
  const out = points.map(() => ({ dPdt: 0, isRamp: false, skewErrKw: 0 }))
  if (n < 2) return out

  // Derivada por diferencias hacia atrás; el primer punto toma la del segundo.
  const back = new Array(n).fill(0)
  for (let i = 1; i < n; i++) {
    const dt = (points[i].tsMs - points[i - 1].tsMs) / 1000
    back[i] = dt > 0 ? (points[i].kw - points[i - 1].kw) / dt : 0
  }
  back[0] = back[1]

  for (let i = 0; i < n; i++) {
    // Se toma el máximo entre la pendiente que entra y la que sale, para que el tick donde
    // arranca la rampa quede marcado y no se cuele como "estable".
    const fwd = i + 1 < n ? back[i + 1] : back[i]
    const dPdt = Math.abs(back[i]) >= Math.abs(fwd) ? back[i] : fwd
    const skewSec = Math.abs(points[i].skewMs ?? 0) / 1000
    out[i] = {
      dPdt,
      isRamp: Math.abs(dPdt) > kwPerSecThreshold,
      skewErrKw: Math.abs(dPdt) * skewSec,
    }
  }
  return out
}

// ─── Integral trapezoidal de kW → kWh ─────────────────────────────────────────
// Sirve para contrastar el Δ del contador de energía (registro 40230, unidades y escala
// no documentadas) contra la energía que implica la propia serie de potencia. Si el
// cociente da ~1, el contador está en kWh; si da 1000, en Wh; etc.
// points: [{ tsMs, kw }] ordenados por tiempo.
export function trapezoidIntegral(points) {
  if (points.length < 2) return 0
  let kwh = 0
  for (let i = 1; i < points.length; i++) {
    const dtH = (points[i].tsMs - points[i - 1].tsMs) / 3_600_000
    if (dtH <= 0) continue
    kwh += ((points[i].kw + points[i - 1].kw) / 2) * dtH
  }
  return kwh
}

// ─── Episodios de nulls consecutivos ──────────────────────────────────────────
// Mismo criterio que analyze-shadow.js (D-118): 60 nulls sueltos repartidos en la hora y
// 60 nulls seguidos tienen la misma tasa pero significan cosas muy distintas.
export class EpisodeTracker {
  #open = null
  episodes = []

  add(ts, isNull, errType) {
    if (isNull) {
      if (this.#open) {
        this.#open.ticks++
        this.#open.endTs = ts
        if (errType) this.#open.errs.add(errType)
      } else {
        this.#open = { startTs: ts, endTs: ts, ticks: 1, errs: new Set(errType ? [errType] : []) }
      }
    } else if (this.#open) {
      this.episodes.push(this.#seal(this.#open))
      this.#open = null
    }
  }

  finish() {
    if (this.#open) { this.episodes.push(this.#seal(this.#open)); this.#open = null }
    return this.episodes
  }

  #seal(e) {
    const durSec = (Date.parse(e.endTs) - Date.parse(e.startTs)) / 1000
    return { startTs: e.startTs, endTs: e.endTs, ticks: e.ticks, durSec, errType: [...e.errs].join('|') || 'unknown' }
  }
}

export function errName(s) {
  return s ? String(s).split(':')[0].trim() : 'unknown'
}

// ─── Resumen de un par (primario, reserva) ────────────────────────────────────
// recs: registros kind:'power' de UN par, en cualquier orden (se ordenan acá).
// opts.rampKwPerSec  umbral para ETIQUETAR un tick como "en rampa" (kW/s). Es informativo:
//                    dice si la unidad se movió en la ventana, que es lo que le da rango a
//                    la regresión. NO decide qué ticks se usan.
// opts.relTolPct     tolerancia relativa (% de la potencia media absoluta de la ventana).
//                    Se usa para el mismatch de signo y como referencia del filtro de skew.
// opts.skewErrFrac   fracción de la tolerancia por encima de la cual el desfase de muestreo
//                    explica por sí solo el Δ del tick, y por lo tanto el tick no sirve para
//                    medir al medidor. Ese es el criterio que separa `clean` de `skewed`.
export function summarizePair(recs, { rampKwPerSec = 10, relTolPct = 0.5, skewErrFrac = 0.1 } = {}) {
  const sorted = [...recs].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  const total = sorted.length

  let primNull = 0, resNull = 0
  const primErrs = {}, resErrs = {}
  const primLat = [], resLat = []
  const co = { bothOk: 0, primOnlyNull: 0, resOnlyNull: 0, bothNull: 0 }
  const primEp = new EpisodeTracker(), resEp = new EpisodeTracker()
  const paired = []   // ticks con ambos OK, ya emparejados

  for (const r of sorted) {
    const pOk = !!r.prim?.ok, rOk = !!r.res?.ok
    const pErr = errName(r.prim?.err), rErr = errName(r.res?.err)

    if (pOk) { if (Number.isFinite(r.prim.latencyMs)) primLat.push(r.prim.latencyMs) }
    else { primNull++; primErrs[pErr] = (primErrs[pErr] || 0) + 1 }
    if (rOk) { if (Number.isFinite(r.res.latencyMs)) resLat.push(r.res.latencyMs) }
    else { resNull++; resErrs[rErr] = (resErrs[rErr] || 0) + 1 }

    if (pOk && rOk) co.bothOk++
    else if (!pOk && rOk) co.primOnlyNull++
    else if (pOk && !rOk) co.resOnlyNull++
    else co.bothNull++

    primEp.add(r.ts, !pOk, pOk ? null : pErr)
    resEp.add(r.ts, !rOk, rOk ? null : rErr)

    if (pOk && rOk) {
      paired.push({
        ts: r.ts,
        tsMs: Date.parse(r.ts),
        prim: r.prim.kw,
        res: r.res.kw,
        diff: r.prim.kw - r.res.kw,
        skewMs: r.skewMs ?? 0,
      })
    }
  }
  primEp.finish(); resEp.finish()
  primLat.sort((a, b) => a - b); resLat.sort((a, b) => a - b)

  const base = {
    total, primNull, resNull, primErrs, resErrs,
    primNullRate: pct(primNull, total), resNullRate: pct(resNull, total),
    co,
    primEpisodes: primEp.episodes, resEpisodes: resEp.episodes,
    primLat: latencyStats(primLat), resLat: latencyStats(resLat),
    bothOk: paired.length,
    paired,
  }

  if (paired.length === 0) {
    return { ...base, meanAbsPower: null, all: emptyAgreement(), clean: emptyAgreement(),
      skewed: emptyAgreement(), fit: { slope: null, intercept: null, r2: null, n: 0 },
      signMismatch: 0, skew: { p50: null, p95: null, max: null }, rampTicks: 0, maxSkewErrKw: 0 }
  }

  // Escala de referencia de la ventana: potencia media ABSOLUTA de la primaria.
  // Todas las tolerancias son relativas a esto y no a un umbral fijo en kW: a 224 MW un
  // umbral fijo sería trivial de pasar, y con la unidad en reserva (~0.7 MW) el error
  // relativo punto a punto se dispara sin que el medidor tenga nada malo.
  const meanAbsPower = mean(paired.map((p) => Math.abs(p.prim)))
  const absTolKw = (relTolPct / 100) * meanAbsPower

  const flags = classifyRamp(
    paired.map((p) => ({ tsMs: p.tsMs, kw: p.prim, skewMs: p.skewMs })),
    rampKwPerSec,
  )
  // Un tick se descarta SOLO si el desfase de muestreo alcanza para explicar por sí solo una
  // parte apreciable de la tolerancia. Descartar por "hay rampa" a secas sería un error: en
  // una planta de 224 MW la potencia fluctúa decenas de kW entre muestras de 2 s, así que casi
  // todos los ticks quedarían fuera — y encima la rampa es justo lo que le da rango a la
  // regresión. Lo que contamina no es moverse, es moverse rápido MIENTRAS hay desfase.
  const skewLimitKw = skewErrFrac * absTolKw
  const cleanPts = paired.filter((_, i) => flags[i].skewErrKw <= skewLimitKw)
  const skewedPts = paired.filter((_, i) => flags[i].skewErrKw > skewLimitKw)

  let signMismatch = 0
  for (const p of paired) {
    if (Math.sign(p.prim) !== Math.sign(p.res) && Math.abs(p.diff) > absTolKw) signMismatch++
  }

  const skews = paired.map((p) => Math.abs(p.skewMs)).sort((a, b) => a - b)

  return {
    ...base,
    meanAbsPower,
    absTolKw,
    all: agreement(paired, meanAbsPower),
    clean: agreement(cleanPts, meanAbsPower),
    skewed: agreement(skewedPts, meanAbsPower),
    // El ajuste va sobre los ticks limpios: en los contaminados el error del skew está
    // correlacionado con dP/dt y sesgaría la pendiente.
    fit: linearFit(cleanPts.map((p) => p.prim), cleanPts.map((p) => p.res)),
    signMismatch,
    skewLimitKw,
    // Cuántos ticks tuvieron a la unidad moviéndose. Informativo: si son ~0, la ventana fue
    // plana y la pendiente de la regresión no tiene rango del cual salir.
    rampTicks: flags.filter((f) => f.isRamp).length,
    maxSkewErrKw: Math.max(0, ...flags.map((f) => f.skewErrKw)),
    skew: { p50: percentile(skews, 50), p95: percentile(skews, 95), max: skews[skews.length - 1] ?? null },
  }
}

function agreement(points, meanAbsPower) {
  if (points.length === 0) return emptyAgreement()
  const diffs = points.map((p) => p.diff)
  const abs = diffs.map(Math.abs).sort((a, b) => a - b)
  const bias = mean(diffs)
  const p95 = percentile(abs, 95)
  const max = abs[abs.length - 1]
  const rel = (v) => (meanAbsPower ? (Math.abs(v) / meanAbsPower) * 100 : null)
  return {
    n: points.length,
    // biasPct conserva el signo: importa si la reserva lee sistemáticamente por encima o
    // por debajo, no solo cuánto. Los percentiles sí van en valor absoluto.
    bias, biasPct: meanAbsPower ? (bias / meanAbsPower) * 100 : null,
    sigma: stdev(diffs),
    absP50: percentile(abs, 50),
    absP95: p95, absP95Pct: rel(p95),
    absMax: max, absMaxPct: rel(max),
  }
}

function emptyAgreement() {
  return { n: 0, bias: null, biasPct: null, sigma: null, absP50: null, absP95: null,
    absP95Pct: null, absMax: null, absMaxPct: null }
}

function latencyStats(sortedAsc) {
  return {
    p50: percentile(sortedAsc, 50),
    p95: percentile(sortedAsc, 95),
    p99: percentile(sortedAsc, 99),
  }
}

// ─── Energía: Δ del contador en la ventana ────────────────────────────────────
// Los contadores absolutos de primaria y reserva NO son comparables (cada medidor arrancó
// en un momento distinto: se observó 68.713.872 vs 2.439.616 en el mismo par). Lo único
// comparable es cuánto AVANZÓ cada uno durante la ventana.
// recs: registros kind:'energy' de un par.
export function energyDelta(recs) {
  const sorted = [...recs].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  const side = (key) => {
    const ok = sorted.filter((r) => r[key]?.ok && Number.isFinite(r[key].raw))
    if (ok.length < 2) return { samples: ok.length, delta: null, first: null, last: null, spanH: null }
    const first = ok[0], last = ok[ok.length - 1]
    const spanH = (Date.parse(last.ts) - Date.parse(first.ts)) / 3_600_000
    return {
      samples: ok.length,
      first: first[key].raw,
      last: last[key].raw,
      delta: last[key].raw - first[key].raw,
      spanH,
      firstTs: first.ts,
      lastTs: last.ts,
    }
  }
  const prim = side('prim')
  const res = side('res')
  const ratio = prim.delta && res.delta != null && prim.delta !== 0 ? res.delta / prim.delta : null
  const relDiffPct = prim.delta && prim.delta !== 0
    ? (Math.abs((res.delta ?? 0) - prim.delta) / Math.abs(prim.delta)) * 100
    : null
  return { prim, res, ratio, relDiffPct }
}
