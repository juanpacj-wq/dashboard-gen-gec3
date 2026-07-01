#!/usr/bin/env node
// Analiza los JSONL del shadow watcher y produce, por medidor: tasa de null HTTP vs Modbus
// (con breakdown de errores), acuerdo de valores cuando ambos OK, latencias p50/p95/p99,
// consistencia de signo, y el veredicto contra los criterios de éxito del plan.
//
// Uso:  npm run shadow:analyze            (lee server/traces/shadow/*.jsonl)
//       node scripts/analyze-shadow.js <dir-o-archivo>
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DIR = fileURLToPath(new URL('../traces/shadow', import.meta.url))
const TARGET = process.argv[2] || DEFAULT_DIR

// Tolerancias de los criterios de éxito (ver plan)
const VAL_REL_PCT = 0.5
const VAL_ABS_KW = 0.05
const MB_NULL_RATE_MAX = 0.1   // %
const VAL_AGREE_MIN = 99.5     // %

function listFiles(target) {
  const st = statSync(target)
  if (st.isFile()) return [target]
  return readdirSync(target)
    .filter((f) => f.startsWith('shadow-') && f.endsWith('.jsonl'))
    .map((f) => join(target, f))
}

function loadRecords(files) {
  const recs = []
  let parseErrors = 0
  for (const f of files) {
    const raw = readFileSync(f, 'utf8')
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { recs.push(JSON.parse(t)) } catch { parseErrors++ }
    }
  }
  return { recs, parseErrors }
}

function errName(s) {
  if (!s) return 'unknown'
  return String(s).split(':')[0].trim()
}

function pct(part, total) {
  return total === 0 ? 0 : (part / total) * 100
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length))
  return sortedAsc[idx]
}

// Detector de episodios de null consecutivos para un protocolo. Recorre los registros
// ya ordenados por ts; agrupa corridas de ticks null en episodios con ts y duración.
class EpisodeTracker {
  #open = null
  episodes = []
  add(ts, isNull, errType) {
    if (isNull) {
      if (this.#open) { this.#open.ticks++; this.#open.endTs = ts; if (errType) this.#open.errs.add(errType) }
      else this.#open = { startTs: ts, endTs: ts, ticks: 1, errs: new Set(errType ? [errType] : []) }
    } else if (this.#open) { this.episodes.push(this.#seal(this.#open)); this.#open = null }
  }
  finish() { if (this.#open) { this.episodes.push(this.#seal(this.#open)); this.#open = null } }
  #seal(e) {
    const durSec = (Date.parse(e.endTs) - Date.parse(e.startTs)) / 1000
    return { startTs: e.startTs, endTs: e.endTs, ticks: e.ticks, durSec, errType: [...e.errs].join('|') || 'unknown' }
  }
}

function analyzeMeter(recs) {
  recs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  const total = recs.length
  let httpNull = 0, mbNull = 0
  const httpErrs = {}, mbErrs = {}
  const httpLat = [], mbLat = []
  let bothOk = 0, agree = 0, signMismatch = 0
  let maxAbs = 0, sumAbs = 0, maxRel = 0, sumRel = 0
  // Co-ocurrencia por tick + cobertura + histograma por hora.
  const co = { bothOk: 0, httpOnlyNull: 0, mbOnlyNull: 0, bothNull: 0 }
  let httpNullCoveredByMb = 0
  const histo = new Map()          // hourBucket → { http, mb }
  const httpEp = new EpisodeTracker(), mbEp = new EpisodeTracker()

  for (const r of recs) {
    const httpOk = !!r.http?.ok, mbOk = !!r.modbus?.ok
    const hErr = errName(r.http?.err), mErr = errName(r.modbus?.err)

    if (httpOk) { if (Number.isFinite(r.http.latencyMs)) httpLat.push(r.http.latencyMs) }
    else { httpNull++; httpErrs[hErr] = (httpErrs[hErr] || 0) + 1 }
    if (mbOk) { if (Number.isFinite(r.modbus.latencyMs)) mbLat.push(r.modbus.latencyMs) }
    else { mbNull++; mbErrs[mErr] = (mbErrs[mErr] || 0) + 1 }

    // Co-ocurrencia
    if (httpOk && mbOk) co.bothOk++
    else if (!httpOk && mbOk) { co.httpOnlyNull++; httpNullCoveredByMb++ }
    else if (httpOk && !mbOk) co.mbOnlyNull++
    else co.bothNull++

    // Histograma por hora (YYYY-MM-DDTHH)
    const hour = (r.ts || '').slice(0, 13)
    if (!histo.has(hour)) histo.set(hour, { http: 0, mb: 0 })
    if (!httpOk) histo.get(hour).http++
    if (!mbOk) histo.get(hour).mb++

    // Episodios
    httpEp.add(r.ts, !httpOk, httpOk ? null : hErr)
    mbEp.add(r.ts, !mbOk, mbOk ? null : mErr)

    if (r.bothOk) {
      bothOk++
      const abs = r.absDiff ?? Math.abs(r.http.kw - r.modbus.kw)
      const rel = r.relDiffPct ?? (r.http.kw !== 0 ? (abs / Math.abs(r.http.kw)) * 100 : 0)
      sumAbs += abs; sumRel += rel
      if (abs > maxAbs) maxAbs = abs
      if (rel > maxRel) maxRel = rel
      if (abs <= VAL_ABS_KW || rel <= VAL_REL_PCT) agree++
      if (Math.sign(r.http.kw) !== Math.sign(r.modbus.kw) && abs > VAL_ABS_KW) signMismatch++
    }
  }
  httpEp.finish(); mbEp.finish()
  httpLat.sort((a, b) => a - b); mbLat.sort((a, b) => a - b)

  return {
    total, httpNull, mbNull, httpErrs, mbErrs,
    httpNullRate: pct(httpNull, total), mbNullRate: pct(mbNull, total),
    bothOk, agree, agreeRate: pct(agree, bothOk), signMismatch,
    meanAbs: bothOk ? sumAbs / bothOk : null, maxAbs,
    meanRel: bothOk ? sumRel / bothOk : null, maxRel,
    httpLat: { p50: percentile(httpLat, 50), p95: percentile(httpLat, 95), p99: percentile(httpLat, 99) },
    mbLat: { p50: percentile(mbLat, 50), p95: percentile(mbLat, 95), p99: percentile(mbLat, 99) },
    co, httpNullCoveredByMb, coverageRate: pct(httpNullCoveredByMb, httpNull),
    httpEpisodes: httpEp.episodes, mbEpisodes: mbEp.episodes, histo,
  }
}

function main() {
  const files = listFiles(TARGET)
  if (files.length === 0) { console.log(`No hay archivos shadow-*.jsonl en ${TARGET}`); process.exit(1) }
  const { recs, parseErrors } = loadRecords(files)
  console.log(`Analizando ${files.length} archivo(s), ${recs.length} registros (${parseErrors} líneas no parseables)\n`)

  // Agrupar por medidor (unit+host)
  const byMeter = new Map()
  for (const r of recs) {
    const key = `${r.unit}@${r.host}`
    if (!byMeter.has(key)) byMeter.set(key, [])
    byMeter.get(key).push(r)
  }

  let allPass = true
  const agg = { total: 0, httpNull: 0, mbNull: 0, httpOnlyNull: 0, mbOnlyNull: 0, bothNull: 0, coveredByMb: 0, mbErrs: {} }
  for (const [key, mrecs] of [...byMeter.entries()].sort()) {
    const a = analyzeMeter(mrecs)
    const timeoutMs = parseInt(process.env.METER_TIMEOUT_MS, 10) || 4000
    const c1 = a.mbNullRate <= MB_NULL_RATE_MAX
    const c2 = a.mbNullRate < a.httpNullRate || (a.httpNullRate === 0 && a.mbNullRate === 0)
    const c3 = a.bothOk === 0 ? false : a.agreeRate >= VAL_AGREE_MIN
    const c4 = a.signMismatch === 0
    const c5 = a.mbLat.p99 == null ? false : (a.mbLat.p99 < timeoutMs && a.mbLat.p99 < 2000)
    const pass = c1 && c2 && c3 && c4 && c5
    allPass = allPass && pass

    agg.total += a.total; agg.httpNull += a.httpNull; agg.mbNull += a.mbNull
    agg.httpOnlyNull += a.co.httpOnlyNull; agg.mbOnlyNull += a.co.mbOnlyNull; agg.bothNull += a.co.bothNull
    agg.coveredByMb += a.httpNullCoveredByMb
    for (const [k, v] of Object.entries(a.mbErrs)) agg.mbErrs[k] = (agg.mbErrs[k] || 0) + v

    console.log(`━━ ${key}  (${a.total} ticks) ${pass ? '✓ PASS' : '✗ revisar'}`)
    console.log(`   null:    HTTP ${a.httpNull} (${a.httpNullRate.toFixed(2)}%)  vs  Modbus ${a.mbNull} (${a.mbNullRate.toFixed(2)}%)`)
    if (Object.keys(a.httpErrs).length) console.log(`     HTTP errs:   ${fmtErrs(a.httpErrs)}`)
    if (Object.keys(a.mbErrs).length) console.log(`     Modbus errs: ${fmtErrs(a.mbErrs)}`)
    console.log(`   co-ocurrencia: ambosOK=${a.co.bothOk}  HTTP-null&Modbus-OK=${a.co.httpOnlyNull}  Modbus-null&HTTP-OK=${a.co.mbOnlyNull}  ambos-null=${a.co.bothNull}`)
    console.log(`   cobertura: Modbus OK en ${a.httpNullCoveredByMb}/${a.httpNull} ticks HTTP-null (${a.httpNull ? a.coverageRate.toFixed(1) : '—'}%)`)
    console.log(`   episodios null HTTP:   ${a.httpEpisodes.length}${fmtEpisodes(a.httpEpisodes)}`)
    console.log(`   episodios null Modbus: ${a.mbEpisodes.length}${fmtEpisodes(a.mbEpisodes)}`)
    const hh = fmtHisto(a.histo)
    if (hh) console.log(`   nulls por hora: ${hh}`)
    console.log(`   valores: ambosOK=${a.bothOk}  acuerdo(±${VAL_REL_PCT}%/${VAL_ABS_KW}kW)=${a.agreeRate.toFixed(2)}%  meanΔ=${fmt(a.meanAbs)}kW maxΔ=${fmt(a.maxAbs)}kW (rel max ${fmt(a.maxRel)}%)`)
    console.log(`   signo:   mismatches=${a.signMismatch}`)
    console.log(`   latencia HTTP   p50/p95/p99 = ${a.httpLat.p50}/${a.httpLat.p95}/${a.httpLat.p99} ms`)
    console.log(`   latencia Modbus p50/p95/p99 = ${a.mbLat.p50}/${a.mbLat.p95}/${a.mbLat.p99} ms`)
    console.log(`   criterios: [1 mb_null≤${MB_NULL_RATE_MAX}%]${mark(c1)} [2 mb<http]${mark(c2)} [3 acuerdo≥${VAL_AGREE_MIN}%]${mark(c3)} [4 signo]${mark(c4)} [5 lat p99]${mark(c5)}\n`)
  }

  // ── Veredicto agregado: ¿Modbus abarca el problema del null? ──
  const coveragePct = agg.httpNull ? pct(agg.coveredByMb, agg.httpNull) : null
  console.log('══════ RESUMEN AGREGADO (5 medidores) ══════')
  console.log(`  Ticks totales: ${agg.total}`)
  console.log(`  Nulls HTTP:   ${agg.httpNull} (${pct(agg.httpNull, agg.total).toFixed(3)}%)`)
  console.log(`  Nulls Modbus: ${agg.mbNull} (${pct(agg.mbNull, agg.total).toFixed(3)}%)${Object.keys(agg.mbErrs).length ? ' — ' + fmtErrs(agg.mbErrs) : ''}`)
  console.log(`  Co-ocurrencia: HTTP-null&Modbus-OK=${agg.httpOnlyNull}  Modbus-null&HTTP-OK=${agg.mbOnlyNull}  ambos-null=${agg.bothNull}`)
  console.log(`  ¿Modbus cubre los nulls de HTTP? ${coveragePct == null ? 'N/A (HTTP no tuvo nulls)' : coveragePct.toFixed(1) + '% de los ticks HTTP-null tuvieron Modbus OK'}`)
  console.log(`  ¿Modbus tiene nulls propios? ${agg.mbNull === 0 ? 'NO (0)' : `SÍ: ${agg.mbNull} (${agg.bothNull} compartidos con HTTP = red/medidor, ${agg.mbOnlyNull} solo-Modbus)`}`)
  const modbusCovers = agg.httpNull > 0 && agg.mbNull === 0 ||
    (agg.httpNull > 0 && coveragePct >= 99 && agg.mbOnlyNull === 0)
  console.log('\n' + (modbusCovers
    ? '✓ VEREDICTO: Modbus abarca el problema — HTTP presenta nulls y Modbus los cubre en el mismo instante (0 nulls propios de contención).'
    : (agg.httpNull === 0
      ? '⚠ VEREDICTO: HTTP no presentó nulls en esta ventana — repetir en una ventana con más contención para evidenciar el problema.'
      : '⚠ VEREDICTO: revisar — Modbus mostró nulls propios o cobertura <99%; ver co-ocurrencia y errores arriba.')))
  console.log(`\n(Criterios de migración: ${allPass ? 'todos PASS' : 'hay medidores a revisar'})`)
  process.exit(0)
}

function fmtErrs(o) { return Object.entries(o).map(([k, v]) => `${k}=${v}`).join(', ') }
function fmt(n) { return n == null ? '—' : n.toFixed(3) }
function mark(b) { return b ? '✓' : '✗' }

// Top episodios por duración (ticks), con hora de inicio y tipo de error.
function fmtEpisodes(eps, topN = 6) {
  if (!eps.length) return ''
  const top = [...eps].sort((a, b) => b.ticks - a.ticks).slice(0, topN)
  const parts = top.map((e) => `${(e.startTs || '').slice(11, 19)}×${e.ticks}t${e.durSec ? `/${e.durSec}s` : ''}(${e.errType})`)
  return `  [${parts.join(', ')}${eps.length > topN ? ', …' : ''}]`
}

// Histograma compacto: solo horas con al menos un null.
function fmtHisto(histo) {
  const rows = [...histo.entries()]
    .filter(([, v]) => v.http || v.mb)
    .sort()
    .map(([h, v]) => `${h.slice(11, 13)}h:HTTP=${v.http}/MB=${v.mb}`)
  return rows.join('  ')
}

main()
