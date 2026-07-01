#!/usr/bin/env node
// Watcher en SOMBRA — corre fuera de producción (no toca BD, orchestrator ni server.js).
// Cada METER_POLL_MS lee cada medidor por HTTP y por Modbus EN PARALELO y registra ambos
// resultados a JSONL para comparar tasa de null, acuerdo de valores y latencias.
// Auto-stop a las 3h. Analizar con: npm run shadow:analyze
//
// Uso:  npm run shadow:modbus
// Requiere en ../.env: IP_*/PSW_*/USER_MEDIDORES + METER_MODBUS_* (del match de probe:modbus).
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ION8650Client } from '../meterClient.js'
import { ION8650ModbusClient } from '../meterModbusClient.js'

// Auto-salta la validación fail-fast de config.js (solo precisa vars de medidores),
// portable en Windows. Import dinámico para que el flag aplique antes de evaluar config.
process.env.CONFIG_SKIP_VALIDATION = process.env.CONFIG_SKIP_VALIDATION || '1'
const { UNITS, METER_DEFAULTS } = await import('../config.js')

const POLL_MS = parseInt(process.env.METER_POLL_MS, 10) || 2000
const TIMEOUT_MS = parseInt(process.env.METER_TIMEOUT_MS, 10) || 4000
const DURATION_MS = parseFloat(process.env.SHADOW_DURATION_MIN || '180') * 60_000 // 180 min = 3h
const BASE_DIR = join(fileURLToPath(new URL('../traces/shadow', import.meta.url)))

const MB = {
  port: parseInt(process.env.METER_MODBUS_PORT, 10) || 502,
  unitId: parseInt(process.env.METER_MODBUS_UNIT_ID, 10) || 1,
  register: parseInt(process.env.METER_MODBUS_REGISTER, 10) || 40204,
  wordOrder: process.env.METER_MODBUS_WORD_ORDER || 'high',
  decode: process.env.METER_MODBUS_DECODE || 'int32',
  scale: parseInt(process.env.METER_MODBUS_SCALE, 10) || 1000,
}

// Override opcional de unitId por medidor: MB_UNIT_<IPKEY> (ej MB_UNIT_IP_GEC3_1).
function unitIdFor(meter) {
  const k = meter._ipKey ? `MB_UNIT_${meter._ipKey}` : null
  const v = k ? parseInt(process.env[k], 10) : NaN
  return Number.isInteger(v) ? v : MB.unitId
}

function buildPairs() {
  const pairs = []
  for (const unit of UNITS) {
    for (let i = 0; i < unit.meters.length; i++) {
      const meter = unit.meters[i]
      pairs.push({
        unit: unit.id,
        idx: i,
        host: meter.host,
        http: new ION8650Client({
          host: meter.host, user: meter.user, password: meter.password,
          opPath: METER_DEFAULTS.opPath, timeoutMs: TIMEOUT_MS,
        }),
        modbus: new ION8650ModbusClient({
          host: meter.host, port: MB.port, unitId: unitIdFor(meter),
          register: MB.register, wordOrder: MB.wordOrder, decode: MB.decode,
          scale: MB.scale, timeoutMs: TIMEOUT_MS,
        }),
      })
    }
  }
  return pairs
}

// ─── Writer JSONL por host/hora ────────────────────────────────────────────────
const streams = new Map()
let dirReady = false
function streamFor(host, tsIso) {
  if (!dirReady) { mkdirSync(BASE_DIR, { recursive: true }) ; dirReady = true }
  const dateStr = tsIso.slice(0, 10)
  const hourStr = tsIso.slice(11, 13)
  const key = `${host}::${dateStr}::${hourStr}`
  let entry = streams.get(key)
  if (entry) return entry
  for (const [oldKey, old] of streams) {
    if (oldKey.startsWith(`${host}::`)) { old.end() ; streams.delete(oldKey) }
  }
  const filepath = join(BASE_DIR, `shadow-${host}-${dateStr}-${hourStr}.jsonl`)
  const stream = createWriteStream(filepath, { flags: 'a' })
  stream.on('error', (err) => console.warn(`[shadow] stream error (${host}): ${err?.message}`))
  streams.set(key, stream)
  console.log(`[shadow] abriendo ${filepath}`)
  return stream
}

function settle(r) {
  if (r.status === 'fulfilled') return { ok: true, kw: r.value.kw, latencyMs: r.value.latencyMs, err: null }
  const e = r.reason
  return { ok: false, kw: null, latencyMs: null, err: `${e?.name || 'Error'}: ${e?.message || e}` }
}

function errType(s) { return s ? String(s).split(':')[0].trim() : 'unknown' }

const counters = { ticks: 0, httpNull: 0, mbNull: 0 }

async function tick(pairs) {
  const tsIso = new Date().toISOString()
  await Promise.all(pairs.map(async (p) => {
    const [h, m] = await Promise.allSettled([p.http.fetchKwTotal(), p.modbus.fetchKwTotal()])
    const http = settle(h)
    const modbus = settle(m)
    if (!http.ok) counters.httpNull++
    if (!modbus.ok) counters.mbNull++
    // Log en vivo del "cuándo": una línea por tick con al menos un null.
    if (!http.ok || !modbus.ok) {
      console.warn(`[shadow][NULL] ${tsIso} ${p.unit}@${p.host} ` +
        `HTTP=${http.ok ? 'OK' : errType(http.err)} MODBUS=${modbus.ok ? 'OK' : errType(modbus.err)}`)
    }
    const bothOk = http.ok && modbus.ok
    const absDiff = bothOk ? Math.abs(http.kw - modbus.kw) : null
    const relDiffPct = bothOk && http.kw !== 0 ? (absDiff / Math.abs(http.kw)) * 100 : (bothOk ? 0 : null)
    const record = { ts: tsIso, unit: p.unit, host: p.host, http, modbus, bothOk, absDiff, relDiffPct }
    streamFor(p.host, tsIso).write(JSON.stringify(record) + '\n')
  }))
  counters.ticks++
}

async function main() {
  const pairs = buildPairs()
  console.log(`[shadow] iniciando — ${pairs.length} medidores, poll=${POLL_MS}ms, duración=${Math.round(DURATION_MS / 60000)}min`)
  console.log(`[shadow] Modbus: port=${MB.port} reg=${MB.register} word=${MB.wordOrder} dec=${MB.decode} /${MB.scale} unitId(base)=${MB.unitId}`)
  console.log(`[shadow] salida JSONL → ${BASE_DIR}\n`)

  let ticking = false
  const pollTimer = setInterval(() => {
    if (ticking) { console.warn('[shadow] tick previo aún corriendo, salto') ; return }
    ticking = true
    tick(pairs).catch((e) => console.error(`[shadow] tick error: ${e?.message}`)).finally(() => { ticking = false })
  }, POLL_MS)

  const hb = setInterval(() => {
    const pct = counters.ticks * pairs.length
    console.log(`[shadow] [${new Date().toISOString()}] ticks=${counters.ticks} lecturas=${pct} httpNull=${counters.httpNull} mbNull=${counters.mbNull}`)
  }, 60_000)

  let stopped = false
  const teardown = async (reason) => {
    if (stopped) return
    stopped = true
    console.log(`\n[shadow] deteniendo (${reason}) — ticks=${counters.ticks} httpNull=${counters.httpNull} mbNull=${counters.mbNull}`)
    clearInterval(pollTimer) ; clearInterval(hb)
    await Promise.allSettled(pairs.flatMap((p) => [p.http.close(), p.modbus.close()]))
    await Promise.all([...streams.values()].map((s) => new Promise((res) => s.end(res))))
    console.log('[shadow] listo. Analizar con: npm run shadow:analyze')
    process.exit(0)
  }

  const autoStop = setTimeout(() => teardown('auto-stop 3h'), DURATION_MS)
  autoStop.unref?.()
  process.on('SIGINT', () => teardown('SIGINT'))
  process.on('SIGTERM', () => teardown('SIGTERM'))
}

main().catch((err) => {
  console.error('[shadow] falló inesperadamente:', err)
  process.exit(2)
})
