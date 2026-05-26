#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const VALLEY_ABSOLUTE_THRESHOLD = -2
const VALLEY_RELATIVE_DROP = 1
const VALLEY_NEIGHBOR_RANGE = 2
const NEIGHBOR_QUIET_BAND = 1
const OUTLIER_TICK_THRESHOLD = -5

function fmt(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '?'
  return Number(n).toFixed(digits)
}

function fmtTime(iso) {
  if (!iso) return '????:??:??'
  const d = new Date(iso)
  return d.toISOString().slice(11, 19)
}

function loadTrace(path) {
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  const records = []
  let parseErrors = 0
  for (const line of lines) {
    try {
      records.push(JSON.parse(line))
    } catch {
      parseErrors++
    }
  }
  if (parseErrors > 0) console.warn(`[analyze] ${parseErrors} líneas no parseables (descartadas)`)
  return records
}

function summarize(records) {
  const ts = records.map((r) => new Date(r.ts).getTime())
  const minTs = Math.min(...ts)
  const maxTs = Math.max(...ts)
  const sources = { meter: 0, pme: 0, null: 0, other: 0 }
  const flagCounts = { negativeMw: 0, nullCoercedToZero: 0, sourceSwitched: 0, outlierDeviation: 0, periodBoundary: 0 }
  const transitions = []
  let prevSource = null

  for (const r of records) {
    const s = r.source
    if (s === 'meter') sources.meter++
    else if (s === 'pme') sources.pme++
    else if (s === null) sources.null++
    else sources.other++
    for (const k of Object.keys(flagCounts)) {
      if (r.flags?.[k]) flagCounts[k]++
    }
    if (r.sourceChanged) {
      transitions.push({ ts: r.ts, from: prevSource, to: s })
    }
    prevSource = s
  }

  return { minTs, maxTs, count: records.length, sources, flagCounts, transitions }
}

function groupByMinute(records) {
  const byMin = new Map()
  for (const r of records) {
    const min = r.minute
    if (!byMin.has(min)) byMin.set(min, [])
    byMin.get(min).push(r)
  }
  return byMin
}

function avgDeviationPerMinute(byMin) {
  const out = new Map()
  for (const [min, ticks] of byMin) {
    const vals = ticks.map((t) => t.projection?.deviationPct).filter((v) => v != null && Number.isFinite(v))
    if (vals.length === 0) {
      out.set(min, null)
      continue
    }
    const sum = vals.reduce((a, b) => a + b, 0)
    out.set(min, sum / vals.length)
  }
  return out
}

function detectValleys(avgByMin) {
  const minutes = [...avgByMin.keys()].sort((a, b) => a - b)
  const valleys = []
  for (const m of minutes) {
    const v = avgByMin.get(m)
    if (v == null) continue

    const neighbors = []
    const neighborVals = []
    for (let d = -VALLEY_NEIGHBOR_RANGE; d <= VALLEY_NEIGHBOR_RANGE; d++) {
      if (d === 0) continue
      const nv = avgByMin.get(m + d)
      neighbors.push({ min: m + d, val: nv })
      if (nv != null) neighborVals.push(nv)
    }
    if (neighborVals.length === 0) continue

    const neighborAvg = neighborVals.reduce((a, b) => a + b, 0) / neighborVals.length
    const neighborsQuiet = neighborVals.every((nv) => Math.abs(nv) <= NEIGHBOR_QUIET_BAND)

    const isAbsoluteValley = v < VALLEY_ABSOLUTE_THRESHOLD
    const isRelativeValley = neighborsQuiet && (v - neighborAvg) < -VALLEY_RELATIVE_DROP

    if (!isAbsoluteValley && !isRelativeValley) continue
    valleys.push({ minute: m, avg: v, neighbors, neighborAvg, kind: isAbsoluteValley ? 'absolute' : 'relative' })
  }
  return valleys
}

function activeFlags(r) {
  const f = r.flags ?? {}
  return Object.keys(f).filter((k) => f[k])
}

function printSummary(file, records, summary) {
  const durStr = `${new Date(summary.minTs).toISOString().slice(11, 19)} → ${new Date(summary.maxTs).toISOString().slice(11, 19)}`
  const total = summary.count
  const pct = (n) => `${((n / total) * 100).toFixed(1)}%`
  console.log(`\nTRACE: ${basename(file)}`)
  console.log(`Duración: ${durStr} | ${total} ticks | source: meter=${pct(summary.sources.meter)} pme=${pct(summary.sources.pme)} null=${pct(summary.sources.null)}`)
  if (summary.transitions.length > 0) {
    const parts = summary.transitions.map((t) => `${fmtTime(t.ts)} ${t.from ?? 'null'}→${t.to ?? 'null'}`)
    console.log(`Transiciones: ${summary.transitions.length} (${parts.join(', ')})`)
  } else {
    console.log(`Transiciones: 0`)
  }
  const flagParts = Object.entries(summary.flagCounts).map(([k, v]) => `${k}=${v}`).join(' ')
  console.log(`Flags totales: ${flagParts}`)
}

function printValleys(valleys, byMin) {
  console.log(`\n== VALLES DETECTADOS ==`)
  if (valleys.length === 0) {
    console.log(`(ninguno absoluto <${VALLEY_ABSOLUTE_THRESHOLD}% ni relativo con caída >${VALLEY_RELATIVE_DROP}% bajo vecinos quietos ±${NEIGHBOR_QUIET_BAND}%)`)
    return
  }
  for (const v of valleys) {
    const ticks = byMin.get(v.minute) ?? []
    const flagsAny = ticks.some((t) => activeFlags(t).length > 0)
    const mark = flagsAny ? '!' : ' '
    const neighborStr = v.neighbors.map((n) => `${n.min}:${n.val == null ? '?' : fmt(n.val)}`).join(', ')
    console.log(`[min ${String(v.minute).padStart(2, '0')}] avg=${fmt(v.avg)}% (${v.kind}, vecinos avg=${fmt(v.neighborAvg)}) ticks=${ticks.length} (${neighborStr}) ${mark}`)
  }
}

function printDrillDowns(valleys, byMin) {
  for (const v of valleys) {
    const ticks = byMin.get(v.minute) ?? []
    console.log(`\n== DRILL [min ${String(v.minute).padStart(2, '0')}] (${ticks.length} ticks) ==`)
    for (const t of ticks) {
      const ts = fmtTime(t.ts)
      const src = (t.source ?? 'null').padEnd(5)
      const cm = fmt(t.currentMw, 2).padStart(8)
      const ms = fmt(t.meter?.valueMW_signed, 2).padStart(8)
      const pm = fmt(t.pme?.valueMW_raw, 2).padStart(8)
      const dev = fmt(t.projection?.deviationPct, 2).padStart(8)
      const flags = activeFlags(t)
      const isOutlier = t.projection?.deviationPct != null && t.projection.deviationPct < OUTLIER_TICK_THRESHOLD
      const marker = isOutlier ? ' <<' : ''
      const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : ''
      console.log(`${ts}  src=${src}  cm=${cm}  meter=${ms}  pme=${pm}  dev=${dev}%${flagStr}${marker}`)
    }
  }
}

function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('Uso: node analyze.js <archivo.jsonl>')
    process.exit(1)
  }
  const records = loadTrace(file)
  if (records.length === 0) {
    console.error('Archivo vacío o sin líneas válidas.')
    process.exit(2)
  }
  const summary = summarize(records)
  const byMin = groupByMinute(records)
  const avgByMin = avgDeviationPerMinute(byMin)
  const valleys = detectValleys(avgByMin)

  printSummary(file, records, summary)
  printValleys(valleys, byMin)
  printDrillDowns(valleys, byMin)
  console.log()
}

main()
