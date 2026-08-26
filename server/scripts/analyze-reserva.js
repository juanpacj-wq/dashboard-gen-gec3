#!/usr/bin/env node
// Analiza los JSONL de shadow-reserva-watch.js y responde: ¿el medidor de RESERVA lee lo
// mismo que el PRIMARIO? Por par informa disponibilidad, sesgo, dispersión, escala
// (regresión), signo, energía acumulada y latencia; y a nivel de GEC3 verifica el pareo y
// compara la suma de las dos unidades, que es el valor que realmente consume el dashboard.
//
// Uso:  npm run shadow:reserva:analyze          (lee server/traces/reserva/*.jsonl)
//       node scripts/analyze-reserva.js <dir-o-archivo>
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizePair, energyDelta, trapezoidIntegral } from './lib/reservaStats.js'

const DEFAULT_DIR = fileURLToPath(new URL('../traces/reserva', import.meta.url))
const args = process.argv.slice(2)
// --json emite el mismo análisis como JSON en vez del reporte de texto, para que otras
// herramientas (ej. el exportador a Excel) publiquen EXACTAMENTE los números del reporte
// en vez de recalcularlos por su cuenta y arriesgarse a divergir.
const JSON_MODE = args.includes('--json')
const TARGET = args.find((a) => !a.startsWith('--')) || DEFAULT_DIR

function out(...a) { if (!JSON_MODE) console.log(...a) }

// ─── Criterios de éxito ───────────────────────────────────────────────────────
// Las tolerancias de acuerdo son RELATIVAS a la potencia media absoluta de la ventana, no
// absolutas en kW: a 224 MW un umbral fijo en kW sería trivial de pasar, y con la unidad
// en reserva (~0.7 MW) el error relativo punto a punto se dispara sin que el medidor tenga
// nada malo. Un único umbral relativo al promedio evita los dos sesgos.
const C = {
  resNullRateMax: 0.1,     // %
  nullRateDeltaMax: 0.1,   // pp peor que la primaria
  biasPctMax: 0.25,        // % de la potencia media absoluta
  p95PctMax: 0.5,          // % de la potencia media absoluta, en ticks estables
  slopeMin: 0.995,
  slopeMax: 1.005,
  interceptPctMax: 0.25,   // % de la potencia media absoluta
  energyRelPctMax: 0.5,    // %
}
// R² se imprime como contexto pero NO decide: R² = 1 − SSE/SST, y SST depende de cuánto se
// movió LA PLANTA, no de la calidad del medidor. Dos medidores idénticos sobre una planta
// perfectamente constante darían R² ≈ 0. Además es redundante con C3, que ya mide la
// dispersión normalizada contra la potencia. Lo que sí aporta la regresión es separar un
// error de ESCALA (pendiente) de un OFFSET constante (intercepto) — eso es C4.
const TIMEOUT_MS = parseInt(process.env.METER_TIMEOUT_MS, 10) || 6000
// Umbral solo para ETIQUETAR la ventana como movida o plana (informativo). Los ticks que se
// descartan son los contaminados por el desfase de muestreo, no los que tienen rampa.
const RAMP_KW_PER_S = parseFloat(process.env.RESERVA_RAMP_KW_PER_S || '10')
// Con pocos ticks limpios la regresión y el p95 no son representativos; se informan pero
// no deciden el veredicto.
const MIN_CLEAN_TICKS = 30
// Los dos contadores de energía no se actualizan en el mismo instante, así que un desfase de
// latcheo acotado en kWh pesa muchísimo en una ventana corta y casi nada en una larga. Por
// debajo de esta duración, C6 no discrimina y se informa como sin señal.
const MIN_ENERGY_WINDOW_H = parseFloat(process.env.RESERVA_MIN_ENERGY_WINDOW_H || '0.5')

function listFiles(target) {
  const st = statSync(target)
  if (st.isFile()) return [target]
  return readdirSync(target)
    .filter((f) => f.startsWith('reserva-') && f.endsWith('.jsonl'))
    .map((f) => join(target, f))
}

function loadRecords(files) {
  const recs = []
  let parseErrors = 0
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { recs.push(JSON.parse(t)) } catch { parseErrors++ }
    }
  }
  return { recs, parseErrors }
}

// ─── Evaluación de criterios ──────────────────────────────────────────────────
// ok: true | false | null (no aplica / sin señal suficiente). Los N/A no reprueban, pero
// se marcan para que nadie lea un "PASS" como si estuviera respaldado por datos.
function evaluate(s, e, agree) {
  const c = {}

  c.c1 = {
    label: `nulls reserva ≤ ${C.resNullRateMax}%`,
    ok: s.resNullRate <= C.resNullRateMax && s.resNullRate <= s.primNullRate + C.nullRateDeltaMax,
    detail: `${s.resNullRate.toFixed(3)}% (primaria ${s.primNullRate.toFixed(3)}%)`,
  }

  c.c2 = agree.n === 0
    ? { label: 'sesgo', ok: null, detail: 'sin ticks con ambos medidores OK' }
    : {
      label: `sesgo ≤ ${C.biasPctMax}%`,
      ok: Math.abs(agree.biasPct) <= C.biasPctMax,
      detail: `${fmt(agree.bias)} kW = ${fmt(agree.biasPct)}%`,
    }

  c.c3 = s.clean.n < MIN_CLEAN_TICKS
    ? { label: `p95 ≤ ${C.p95PctMax}%`, ok: null, detail: `solo ${s.clean.n} ticks limpios (<${MIN_CLEAN_TICKS})` }
    : {
      label: `p95 ≤ ${C.p95PctMax}%`,
      ok: s.clean.absP95Pct <= C.p95PctMax,
      detail: `${fmt(s.clean.absP95)} kW = ${fmt(s.clean.absP95Pct)}%`,
    }

  // La mitad del ancho de la banda aceptable: si la incertidumbre de la pendiente es de ese
  // orden, la ventana no distingue una escala buena de una mala y el criterio no aplica.
  const slopeHalfWidth = (C.slopeMax - C.slopeMin) / 2
  if (s.fit.degenerate) {
    c.c4 = { label: 'escala', ok: null, detail: `potencia constante en la ventana (${s.fit.degenerate}): la pendiente no es estimable` }
  } else if (s.fit.slope == null || s.fit.n < MIN_CLEAN_TICKS) {
    c.c4 = { label: 'escala', ok: null, detail: `solo ${s.fit.n} ticks limpios (<${MIN_CLEAN_TICKS})` }
  } else if (s.fit.seSlope != null && 2 * s.fit.seSlope > slopeHalfWidth) {
    // Caso real y traicionero: con la unidad casi plana, la regresión escupe pendientes muy
    // lejos de 1 y R² bajo aunque el acuerdo punto a punto sea excelente. No es el medidor:
    // es que sin recorrido en potencia no hay palanca para estimar una escala.
    c.c4 = {
      label: 'escala',
      ok: null,
      detail: `a=${s.fit.slope.toFixed(6)} ± ${(2 * s.fit.seSlope).toFixed(4)} (R²=${s.fit.r2.toFixed(4)}): la unidad varió muy poco en la ventana, la pendiente no se puede resolver a ±${slopeHalfWidth.toFixed(4)}`,
    }
  } else {
    const interceptTolKw = (C.interceptPctMax / 100) * (s.meanAbsPower ?? 0)
    const interceptPct = s.meanAbsPower ? (s.fit.intercept / s.meanAbsPower) * 100 : null
    c.c4 = {
      label: `escala a∈[${C.slopeMin},${C.slopeMax}] y offset ≤${C.interceptPctMax}%`,
      ok: s.fit.slope >= C.slopeMin && s.fit.slope <= C.slopeMax && Math.abs(s.fit.intercept) <= interceptTolKw,
      detail: `a=${s.fit.slope.toFixed(6)} ± ${s.fit.seSlope != null ? (2 * s.fit.seSlope).toFixed(5) : '—'}  b=${fmt(s.fit.intercept)} kW (${fmt(interceptPct)}%)  [R²=${s.fit.r2.toFixed(4)}, informativo]`,
    }
  }

  c.c5 = { label: 'signo', ok: s.signMismatch === 0, detail: `${s.signMismatch} mismatches` }

  const energyWindowH = Math.min(e?.prim?.spanH ?? 0, e?.res?.spanH ?? 0)
  if (!e || e.relDiffPct == null) {
    c.c6 = { label: 'energía de la ventana', ok: null, detail: 'sin muestras suficientes del contador' }
  } else if (energyWindowH < MIN_ENERGY_WINDOW_H) {
    c.c6 = {
      label: 'energía de la ventana',
      ok: null,
      detail: `ventana de ${fmt(energyWindowH, 2)} h < ${MIN_ENERGY_WINDOW_H} h: el desfase de latcheo domina (Δprim=${e.prim.delta} Δres=${e.res.delta} → ${e.relDiffPct.toFixed(3)}%)`,
    }
  } else {
    c.c6 = {
      label: `energía de la ventana ≤ ${C.energyRelPctMax}%`,
      ok: e.relDiffPct <= C.energyRelPctMax,
      detail: `Δprim=${e.prim.delta} Δres=${e.res.delta} en ${fmt(energyWindowH, 2)} h → ${e.relDiffPct.toFixed(3)}%`,
    }
  }

  c.c7 = s.resLat.p99 == null
    ? { label: 'latencia p99', ok: null, detail: 'sin lecturas buenas de la reserva' }
    : { label: `latencia p99 < ${TIMEOUT_MS}ms`, ok: s.resLat.p99 < TIMEOUT_MS, detail: `${s.resLat.p99} ms` }

  const list = Object.values(c)
  const failed = list.filter((x) => x.ok === false)
  const na = list.filter((x) => x.ok === null)

  // Veredicto. "Usable con corrección" = el medidor está sano y sigue fielmente a la
  // primaria (R² altísimo), pero con un factor de escala o un offset conocidos y estables:
  // no es intercambiable tal cual, pero sí corregible.
  let verdict
  if (failed.length === 0) {
    verdict = na.length === 0 ? 'INTERCAMBIABLE' : 'INTERCAMBIABLE (con criterios sin señal)'
  } else {
    const soloEscalaOSesgo = failed.every((x) => x === c.c2 || x === c.c4 || x === c.c6)
    // "Sigue bien" = la dispersión punto a punto está dentro de tolerancia (C3). Si el
    // medidor acompaña de cerca y solo está corrido en escala u offset, eso se calibra.
    const sigueBien = c.c3.ok === true
    verdict = soloEscalaOSesgo && sigueBien && c.c1.ok && c.c5.ok
      ? 'USABLE CON CORRECCIÓN CONOCIDA'
      : 'NO INTERCAMBIABLE'
  }
  return { c, verdict, failed: failed.length, na: na.length }
}

// ─── Impresión de un bloque de par ────────────────────────────────────────────
function printPair(title, s, e, extra = {}) {
  // El acuerdo se mide sobre los ticks limpios cuando hay suficientes: en los contaminados,
  // los milisegundos de desfase entre las dos lecturas explican por sí solos parte del Δ.
  const agree = s.clean.n >= MIN_CLEAN_TICKS ? s.clean : s.all
  const agreeSrc = s.clean.n >= MIN_CLEAN_TICKS ? 'limpios' : 'todos'
  const ev = evaluate(s, e, agree)

  out(`━━ ${title}  (${s.total} ticks) → ${ev.verdict}`)
  if (extra.hosts) out(`   medidores: primaria ${extra.hosts.prim}  vs  reserva ${extra.hosts.res}`)

  out(`   régimen: |P| media=${fmt(s.meanAbsPower)} kW, ${s.rampTicks}/${s.bothOk} ticks con la unidad moviéndose (>${RAMP_KW_PER_S} kW/s)`)
  out(`   ticks usables: ${s.clean.n} limpios / ${s.skewed.n} descartados por desfase (>${fmt(s.skewLimitKw)} kW imputables al skew)`)
  out(`   disponibilidad: primaria ${s.primNull} nulls (${s.primNullRate.toFixed(3)}%)  reserva ${s.resNull} nulls (${s.resNullRate.toFixed(3)}%)`)
  if (Object.keys(s.primErrs).length) out(`     errs primaria: ${fmtErrs(s.primErrs)}`)
  if (Object.keys(s.resErrs).length) out(`     errs reserva:  ${fmtErrs(s.resErrs)}`)
  out(`   co-ocurrencia: ambosOK=${s.co.bothOk}  solo-primaria-null=${s.co.primOnlyNull}  solo-reserva-null=${s.co.resOnlyNull}  ambos-null=${s.co.bothNull}`)
  if (s.primEpisodes.length || s.resEpisodes.length) {
    out(`   episodios null: primaria ${s.primEpisodes.length}${fmtEpisodes(s.primEpisodes)}`)
    out(`                   reserva  ${s.resEpisodes.length}${fmtEpisodes(s.resEpisodes)}`)
  }

  out(`   acuerdo (Δ = primaria − reserva, ticks ${agreeSrc}, n=${agree.n}):`)
  out(`     sesgo=${fmt(agree.bias)} kW (${fmt(agree.biasPct)}%)  σ=${fmt(agree.sigma)} kW`)
  out(`     |Δ| p50=${fmt(agree.absP50)}  p95=${fmt(agree.absP95)} (${fmt(agree.absP95Pct)}%)  max=${fmt(agree.absMax)} (${fmt(agree.absMaxPct)}%) kW`)
  if (s.skewed.n > 0) {
    out(`     [descartados, n=${s.skewed.n}] sesgo=${fmt(s.skewed.bias)} kW  |Δ| p95=${fmt(s.skewed.absP95)} kW`)
  }
  out(`   escala: ${s.fit.degenerate
    ? `no estimable (${s.fit.degenerate})`
    : `reserva = ${fmtFit(s.fit.slope, 6)}${s.fit.seSlope != null ? ` ±${(2 * s.fit.seSlope).toFixed(5)}` : ''}·primaria + ${fmt(s.fit.intercept)} kW   R²=${fmtFit(s.fit.r2, 6)}  (n=${s.fit.n})`}`)
  out(`   signo: ${s.signMismatch} mismatches (tolerancia ${fmt(s.absTolKw)} kW)`)
  out(`   desfase entre lecturas del par: p50=${s.skew.p50}ms p95=${s.skew.p95}ms max=${s.skew.max}ms → error máx. imputable al skew ${fmt(s.maxSkewErrKw)} kW`)

  if (e) {
    out(`   energía (registro acumulado):`)
    out(`     primaria ${e.prim.first} → ${e.prim.last}  Δ=${e.prim.delta ?? '—'}  (${e.prim.samples} muestras, ${fmt(e.prim.spanH)} h)`)
    out(`     reserva  ${e.res.first} → ${e.res.last}  Δ=${e.res.delta ?? '—'}  (${e.res.samples} muestras, ${fmt(e.res.spanH)} h)`)
    if (e.relDiffPct != null) out(`     ratio res/prim=${fmt(e.ratio, 6)}  diferencia=${e.relDiffPct.toFixed(3)}%`)
    if (e.prim.delta != null && e.prim.delta < 0) out(`     ⚠ Δ negativo en la primaria: el contador se reinició o dio la vuelta`)
    if (e.res.delta != null && e.res.delta < 0) out(`     ⚠ Δ negativo en la reserva: el contador se reinició o dio la vuelta`)
    // Contraste contra la integral de la potencia: valida en qué unidades cuenta el registro.
    if (extra.integralKwh != null && e.prim.delta) {
      out(`     integral de kW de la primaria = ${fmt(extra.integralKwh)} kWh → el contador avanza ${fmt(e.prim.delta / extra.integralKwh, 4)}× eso`)
      out(`       (≈1 ⇒ el registro cuenta kWh; ≈1000 ⇒ Wh; otro valor ⇒ escala propia por confirmar)`)
    }
  }

  // El bloque de unidad se arma sumando ticks ya validados, así que no arrastra latencias.
  if (s.primLat.p50 != null || s.resLat.p50 != null) {
    out(`   latencia primaria p50/p95/p99 = ${lat(s.primLat)} ms`)
    out(`   latencia reserva  p50/p95/p99 = ${lat(s.resLat)} ms`)
  }
  out('   criterios:')
  for (const [k, v] of Object.entries(ev.c)) {
    out(`     ${mark(v.ok)} ${k.toUpperCase()} ${v.label.padEnd(34)} ${v.detail}`)
  }
  out('')
  return ev
}

// ─── Sintetiza registros de potencia para reusar summarizePair ────────────────
// Sirve para dos cosas: comparar el pareo alterno de GEC3 y comparar la SUMA de las dos
// unidades. En ambos casos el análisis es idéntico, solo cambia de dónde salen los kW.
function syntheticRecs(byTs, pick) {
  const out = []
  for (const [ts, tick] of byTs) {
    const v = pick(tick)
    if (!v) continue
    out.push({
      kind: 'power', ts,
      prim: { ok: true, kw: v.prim, latencyMs: v.primLat ?? null, err: null },
      res: { ok: true, kw: v.res, latencyMs: v.resLat ?? null, err: null },
      bothOk: true, skewMs: v.skewMs ?? 0,
    })
  }
  return out
}

function main() {
  let files
  try { files = listFiles(TARGET) } catch { console.log(`No existe ${TARGET}. Corre primero: npm run shadow:reserva`); process.exit(1) }
  if (files.length === 0) { console.log(`No hay archivos reserva-*.jsonl en ${TARGET}`); process.exit(1) }

  const { recs, parseErrors } = loadRecords(files)
  out(`Analizando ${files.length} archivo(s), ${recs.length} registros (${parseErrors} líneas no parseables)`)
  out(`Criterios: sesgo ≤${C.biasPctMax}% · p95 ≤${C.p95PctMax}% · pendiente ${C.slopeMin}–${C.slopeMax} · offset ≤${C.interceptPctMax}% · energía ≤${C.energyRelPctMax}% · nulls ≤${C.resNullRateMax}% · p99 <${TIMEOUT_MS}ms`)
  const ventana = ventanaDe(recs)
  if (ventana) out(`Ventana: ${ventana.desde} → ${ventana.hasta}  (${ventana.horas.toFixed(2)} h)\n`)
  else out('')

  const byPair = new Map()
  for (const r of recs) {
    if (!r.pair) continue
    if (!byPair.has(r.pair)) byPair.set(r.pair, { power: [], energy: [] })
    const b = byPair.get(r.pair)
    if (r.kind === 'energy') b.energy.push(r)
    else b.power.push(r)
  }

  const results = []
  for (const [pair, { power, energy }] of [...byPair.entries()].sort()) {
    if (power.length === 0) continue
    const s = summarizePair(power, { rampKwPerSec: RAMP_KW_PER_S })
    const e = energy.length ? energyDelta(energy) : null
    const integralKwh = s.paired.length >= 2
      ? Math.abs(trapezoidIntegral(s.paired.map((p) => ({ tsMs: p.tsMs, kw: p.prim }))))
      : null
    const hosts = { prim: power[0].primHost, res: power[0].resHost }
    const ev = printPair(`PAR ${pair}`, s, e, { hosts, integralKwh })
    results.push({ pair, unit: power[0].unit, s, e, ev })
  }

  const pareo = verificarPareoGEC3(byPair)
  const unidad = compararUnidadGEC3(byPair)

  // ─── Veredicto agregado ─────────────────────────────────────────────────────
  out('══════ VEREDICTO ══════')
  for (const r of results) {
    out(`  ${r.pair.padEnd(8)} ${r.ev.verdict}${r.ev.na ? `  (${r.ev.na} criterio(s) sin señal)` : ''}`)
  }
  const todos = results.every((r) => r.ev.verdict.startsWith('INTERCAMBIABLE'))
  const alguno = results.some((r) => r.ev.verdict === 'NO INTERCAMBIABLE')
  const sinSenal = results.reduce((a, r) => a + r.ev.na, 0)
  out('')
  if (todos) {
    out('✓ Los medidores de reserva leen lo mismo que los primarios dentro de tolerancia.')
    out('  Sirven como fuente alterna real (juego de medidores físicamente distinto), a')
    out('  diferencia del PME, que lee los MISMOS ION8650 y por eso no es fallback independiente.')
  } else if (alguno) {
    out('✗ Al menos un par NO es intercambiable. Revisa arriba qué criterio falló:')
    out('  pendiente ≠ 1 ⇒ relación de TC/TP distinta · intercepto ≠ 0 ⇒ offset ·')
    out('  R² bajo ⇒ no están midiendo lo mismo · nulls ⇒ problema de red o del medidor.')
  } else {
    out('⚠ Los pares son usables con una corrección conocida y estable, pero no tal cual.')
    out('  La pendiente y/o el offset de la regresión son el factor de calibración a aplicar.')
  }
  if (sinSenal > 0) {
    out(`\n⚠ ${sinSenal} criterio(s) quedaron sin señal suficiente. Si fue por potencia constante o`)
    out('  por pocos ticks estables, repite la ventana con la unidad moviéndose en carga.')
  }

  if (JSON_MODE) {
    const bloques = [...results, ...(unidad ? [unidad] : [])]
    console.log(JSON.stringify({
      ventana,
      umbrales: { ...C, timeoutMs: TIMEOUT_MS, rampKwPerS: RAMP_KW_PER_S, minCleanTicks: MIN_CLEAN_TICKS, minEnergyWindowH: MIN_ENERGY_WINDOW_H },
      archivos: files.length,
      registros: recs.length,
      bloques: bloques.map((r) => ({
        pair: r.pair,
        unit: r.unit,
        hosts: r.pair === 'UNIDAD_GEC3' ? null : hostsDe(byPair, r.pair),
        // `paired` son los 1792 ticks: no van al JSON (las hojas de detalle del Excel se
        // arman leyendo los JSONL directo). Acá va solo el resumen.
        s: { ...r.s, paired: undefined },
        e: r.e,
        ev: r.ev,
      })),
      pareo,
      veredicto: { todos, alguno, sinSenal },
    }, null, 2))
  }
  process.exit(0)
}

function hostsDe(byPair, pair) {
  const p = byPair.get(pair)?.power?.[0]
  return p ? { prim: p.primHost, res: p.resHost } : null
}

// ─── Verificación empírica del pareo de GEC3 ──────────────────────────────────
// Que .5↔.7 y .6↔.8 es una suposición basada en el orden de las IPs. Se comprueba con
// datos: se recalcula el acuerdo con el mapeo cruzado y gana el que dé un Δ menor a lo
// largo de toda la ventana.
function verificarPareoGEC3(byPair) {
  const a = byPair.get('GEC3_1')?.power
  const b = byPair.get('GEC3_2')?.power
  if (!a?.length || !b?.length) return

  const byTs = joinTicks(a, b)
  if (byTs.size === 0) {
    out('── Pareo GEC3: sin ticks con los 4 medidores OK al mismo tiempo, no se puede verificar.\n')
    return
  }

  const asumido = summarizePair(syntheticRecs(byTs, (t) => ({ prim: t.a.prim, res: t.a.res, skewMs: t.a.skewMs })), { rampKwPerSec: RAMP_KW_PER_S })
  const asumido2 = summarizePair(syntheticRecs(byTs, (t) => ({ prim: t.b.prim, res: t.b.res, skewMs: t.b.skewMs })), { rampKwPerSec: RAMP_KW_PER_S })
  const cruzado = summarizePair(syntheticRecs(byTs, (t) => ({ prim: t.a.prim, res: t.b.res, skewMs: t.a.skewMs })), { rampKwPerSec: RAMP_KW_PER_S })
  const cruzado2 = summarizePair(syntheticRecs(byTs, (t) => ({ prim: t.b.prim, res: t.a.res, skewMs: t.b.skewMs })), { rampKwPerSec: RAMP_KW_PER_S })

  const errAsumido = (asumido.all.absP50 ?? 0) + (asumido2.all.absP50 ?? 0)
  const errCruzado = (cruzado.all.absP50 ?? 0) + (cruzado2.all.absP50 ?? 0)
  const hosts = { p1: a[0].primHost, r1: a[0].resHost, p2: b[0].primHost, r2: b[0].resHost }

  out('── Verificación del pareo de GEC3 ──')
  out(`   asumido  (${hosts.p1}↔${hosts.r1}, ${hosts.p2}↔${hosts.r2}):  |Δ| p50 sumado = ${fmt(errAsumido)} kW`)
  out(`   cruzado  (${hosts.p1}↔${hosts.r2}, ${hosts.p2}↔${hosts.r1}):  |Δ| p50 sumado = ${fmt(errCruzado)} kW`)
  const margen = Math.abs(errAsumido - errCruzado)
  const relMargen = errAsumido > 0 ? (margen / errAsumido) * 100 : null
  const veredictoPareo = errCruzado < errAsumido && relMargen != null && relMargen > 20
    ? 'CRUZADO'
    : (errAsumido < errCruzado && relMargen != null && relMargen > 20 ? 'ASUMIDO' : 'INDISTINGUIBLE')
  if (errCruzado < errAsumido && relMargen != null && relMargen > 20) {
    out(`   ⚠ El mapeo CRUZADO ajusta claramente mejor (${fmt(margen)} kW): las IPs de reserva`)
    out(`     están al revés respecto a lo asumido. Corrige el pareo antes de leer el resto.`)
  } else if (errAsumido < errCruzado && relMargen != null && relMargen > 20) {
    out(`   ✓ El mapeo asumido ajusta mejor por ${fmt(margen)} kW. Pareo confirmado.`)
  } else {
    out(`   ~ Los dos mapeos ajustan casi igual (diferencia ${fmt(margen)} kW): las dos unidades de`)
    out(`     GEC3 llevan carga muy parecida, así que el pareo no se puede resolver por valor.`)
    out(`     No afecta el total de la unidad (ver suma abajo), pero confirma el pareo en campo`)
    out(`     si se va a usar un medidor de reserva individualmente.`)
  }
  out('')
  return { hosts, errAsumido, errCruzado, margen, relMargen, veredicto: veredictoPareo }
}

// ─── GEC3 a nivel de unidad ───────────────────────────────────────────────────
// config.js declara GEC3 con combine:'sum': el dashboard consume prim1+prim2. Comparar las
// sumas es lo que de verdad importa, y además es inmune a que el pareo esté cruzado.
function compararUnidadGEC3(byPair) {
  const a = byPair.get('GEC3_1')?.power
  const b = byPair.get('GEC3_2')?.power
  if (!a?.length || !b?.length) return
  const byTs = joinTicks(a, b)
  if (byTs.size === 0) return

  const sumRecs = syntheticRecs(byTs, (t) => ({
    prim: t.a.prim + t.b.prim,
    res: t.a.res + t.b.res,
    skewMs: Math.max(t.a.skewMs ?? 0, t.b.skewMs ?? 0),
  }))
  const s = summarizePair(sumRecs, { rampKwPerSec: RAMP_KW_PER_S })
  const e = sumEnergia(byPair, ['GEC3_1', 'GEC3_2'])
  out('── GEC3 a nivel de UNIDAD (suma de los 2 medidores — el valor que consume el dashboard) ──')
  const ev = printPair('UNIDAD GEC3 (suma)', s, e)
  return { pair: 'UNIDAD_GEC3', unit: 'GEC3', s, e, ev, ticks: sumRecs }
}

// Energía de la unidad = suma de los avances de sus medidores. Vale porque Δ(a+b) = Δa + Δb
// y las dos ventanas son la misma. Devuelve null si a algún medidor le falta el contador.
function sumEnergia(byPair, pairIds) {
  const partes = pairIds.map((id) => {
    const recs = byPair.get(id)?.energy
    return recs?.length ? energyDelta(recs) : null
  })
  if (partes.some((p) => !p || p.prim.delta == null || p.res.delta == null)) return null

  const acc = (lado) => ({
    samples: Math.min(...partes.map((p) => p[lado].samples)),
    first: partes.reduce((a, p) => a + p[lado].first, 0),
    last: partes.reduce((a, p) => a + p[lado].last, 0),
    delta: partes.reduce((a, p) => a + p[lado].delta, 0),
    spanH: Math.min(...partes.map((p) => p[lado].spanH)),
  })
  const prim = acc('prim')
  const res = acc('res')
  return {
    prim, res,
    ratio: prim.delta !== 0 ? res.delta / prim.delta : null,
    relDiffPct: prim.delta !== 0 ? (Math.abs(res.delta - prim.delta) / Math.abs(prim.delta)) * 100 : null,
  }
}

// Junta los ticks de dos pares por timestamp exacto. Se puede porque tickPower() calcula
// un único ts por tick y lo escribe igual en todos los pares. Solo entran los ticks en que
// los 4 medidores respondieron.
function joinTicks(aRecs, bRecs) {
  const bByTs = new Map(bRecs.map((r) => [r.ts, r]))
  const out = new Map()
  for (const ra of aRecs) {
    const rb = bByTs.get(ra.ts)
    if (!rb) continue
    if (!ra.prim?.ok || !ra.res?.ok || !rb.prim?.ok || !rb.res?.ok) continue
    out.set(ra.ts, {
      a: { prim: ra.prim.kw, res: ra.res.kw, skewMs: ra.skewMs },
      b: { prim: rb.prim.kw, res: rb.res.kw, skewMs: rb.skewMs },
    })
  }
  return out
}

function ventanaDe(recs) {
  const ts = recs.map((r) => r.ts).filter(Boolean).sort()
  if (ts.length < 2) return null
  return {
    desde: ts[0],
    hasta: ts[ts.length - 1],
    horas: (Date.parse(ts[ts.length - 1]) - Date.parse(ts[0])) / 3_600_000,
  }
}

// ─── Formato ──────────────────────────────────────────────────────────────────
function fmt(n, d = 3) { return n == null || Number.isNaN(n) ? '—' : n.toFixed(d) }
function lat(l) { return `${l.p50 ?? '—'}/${l.p95 ?? '—'}/${l.p99 ?? '—'}` }
function fmtFit(n, d) { return n == null ? '—' : n.toFixed(d) }
function mark(ok) { return ok === null ? '·' : (ok ? '✓' : '✗') }
function fmtErrs(o) { return Object.entries(o).map(([k, v]) => `${k}=${v}`).join(', ') }
function fmtEpisodes(eps, topN = 5) {
  if (!eps.length) return ''
  const top = [...eps].sort((x, y) => y.ticks - x.ticks).slice(0, topN)
  const parts = top.map((e) => `${(e.startTs || '').slice(11, 19)}×${e.ticks}t/${e.durSec}s(${e.errType})`)
  return `  [${parts.join(', ')}${eps.length > topN ? ', …' : ''}]`
}

main()
