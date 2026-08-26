#!/usr/bin/env node
// Comparación 1-a-1 medidor PRIMARIO vs medidor de RESERVA, ambos por Modbus TCP.
// Corre FUERA de producción: no toca BD, ni orchestrator, ni server.js. Mismo patrón que
// shadow-modbus-watch.js (D-118), pero comparando dos medidores físicos distintos en vez
// de dos protocolos sobre el mismo medidor.
//
// Cada METER_POLL_MS lee los dos medidores del par EN PARALELO (registro 40204, kW tot) y
// escribe ambos resultados a JSONL. En paralelo, cada RESERVA_ENERGY_POLL_MS lee el
// contador de energía acumulada (registro 40230) de los dos lados: comparar cuánto AVANZÓ
// cada contador en la ventana es la prueba más fuerte, porque no depende del instante de
// muestreo. Auto-stop a la hora.
//
// Uso:  npm run shadow:reserva            (1 h; RESERVA_DURATION_MIN=2 para un humo corto)
//       npm run shadow:reserva:analyze    (reporte + veredicto)
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ION8650ModbusClient } from '../meterModbusClient.js'

// Solo se necesitan las vars de medidores, no las del PME. Import dinámico para que el
// flag aplique antes de evaluar config.js (portable en Windows, sin env var inline).
process.env.CONFIG_SKIP_VALIDATION = process.env.CONFIG_SKIP_VALIDATION || '1'
const { METER_DEFAULTS } = await import('../config.js')

const POLL_MS = parseInt(process.env.METER_POLL_MS, 10) || 2000
const TIMEOUT_MS = parseInt(process.env.METER_TIMEOUT_MS, 10) || 4000
const DURATION_MS = parseFloat(process.env.RESERVA_DURATION_MIN || '60') * 60_000
const ENERGY_POLL_MS = parseInt(process.env.RESERVA_ENERGY_POLL_MS, 10) || 60_000
// El contador de energía es lento: leerlo cada 2 s no aporta nada y gasta ancho de banda
// del medidor. 0 lo desactiva y el análisis cae solo sobre la potencia instantánea.
// 40232, NO 40230. 40230 es kWh DELIVERED y en Gecelca no se mueve: la frontera es de entrada,
// así que con la planta generando lo que avanza es 40232 (kWh RECEIVED). Verificado contra la
// integral de la potencia en los 6 medidores. Ver docs/analisis/comparacion-registros-energia.md para el
// mapa completo de los dos bancos de energía y por qué 40091..40105 no se leen como INT32.
const ENERGY_REGISTER = parseInt(process.env.METER_MODBUS_ENERGY_REGISTER, 10) || 40232
const BASE_DIR = fileURLToPath(new URL('../traces/reserva', import.meta.url))

const MB = METER_DEFAULTS.modbus

// Pares primario ↔ reserva, declarados por nombre de env var. La IP de reserva DEBE usar
// el sufijo _RESERVA: si reusa el nombre de la primaria, `node --env-file` se queda con la
// última definición y producción pasaría a leer la reserva sin avisar.
const PAIR_DEFS = [
  { id: 'GEC32',  unit: 'GEC32', primEnv: 'IP_GEC32',   resEnv: 'IP_GEC32_RESERVA'  },
  { id: 'GEC3_1', unit: 'GEC3',  primEnv: 'IP_GEC3_1',  resEnv: 'IP_GEC3_1_RESERVA' },
  { id: 'GEC3_2', unit: 'GEC3',  primEnv: 'IP_GEC3_2',  resEnv: 'IP_GEC3_2_RESERVA' },
]

function powerClient(host) {
  return new ION8650ModbusClient({
    host, port: MB.port, unitId: MB.unitId, register: MB.register,
    wordOrder: MB.wordOrder, decode: MB.decode, scale: MB.scale, timeoutMs: TIMEOUT_MS,
  })
}

// Mismo cliente, otro registro y sin escala: lo que devuelve en `.kw` es el conteo crudo
// del acumulador. El script lo renombra a `raw` al escribir para que el JSONL no mienta.
function energyClient(host) {
  return new ION8650ModbusClient({
    host, port: MB.port, unitId: MB.unitId, register: ENERGY_REGISTER,
    wordOrder: MB.wordOrder, decode: MB.decode, scale: 1, timeoutMs: TIMEOUT_MS,
  })
}

function buildPairs() {
  const pairs = []
  for (const def of PAIR_DEFS) {
    const primHost = process.env[def.primEnv]
    const resHost = process.env[def.resEnv]
    if (!primHost || !resHost) {
      console.warn(`[reserva] salto el par ${def.id}: falta ${!primHost ? def.primEnv : def.resEnv} en .env`)
      continue
    }
    if (primHost === resHost) {
      console.warn(`[reserva] salto el par ${def.id}: ${def.primEnv} y ${def.resEnv} apuntan a la MISMA IP (${primHost})`)
      continue
    }
    pairs.push({
      ...def, primHost, resHost,
      primPower: powerClient(primHost), resPower: powerClient(resHost),
      primEnergy: ENERGY_POLL_MS > 0 ? energyClient(primHost) : null,
      resEnergy: ENERGY_POLL_MS > 0 ? energyClient(resHost) : null,
    })
  }
  return pairs
}

// ─── Writer JSONL por par/hora ────────────────────────────────────────────────
const streams = new Map()
let dirReady = false
function streamFor(pairId, tsIso) {
  if (!dirReady) { mkdirSync(BASE_DIR, { recursive: true }); dirReady = true }
  const dateStr = tsIso.slice(0, 10)
  const hourStr = tsIso.slice(11, 13)
  const key = `${pairId}::${dateStr}::${hourStr}`
  const entry = streams.get(key)
  if (entry) return entry
  // Cierra el archivo de la hora anterior de ESTE par antes de abrir el nuevo.
  for (const [oldKey, old] of streams) {
    if (oldKey.startsWith(`${pairId}::`)) { old.end(); streams.delete(oldKey) }
  }
  const filepath = join(BASE_DIR, `reserva-${pairId}-${dateStr}-${hourStr}.jsonl`)
  const stream = createWriteStream(filepath, { flags: 'a' })
  stream.on('error', (err) => console.warn(`[reserva] stream error (${pairId}): ${err?.message}`))
  streams.set(key, stream)
  console.log(`[reserva] abriendo ${filepath}`)
  return stream
}

function settle(r, valueKey) {
  if (r.status === 'fulfilled') {
    return { ok: true, [valueKey]: r.value.kw, latencyMs: r.value.latencyMs, fetchedAt: r.value.fetchedAt, err: null }
  }
  const e = r.reason
  return { ok: false, [valueKey]: null, latencyMs: null, fetchedAt: null, err: `${e?.name || 'Error'}: ${e?.message || e}` }
}

function errType(s) { return s ? String(s).split(':')[0].trim() : 'unknown' }

const counters = {
  ticks: 0, energyTicks: 0,
  byPair: new Map(),   // pairId → { primNull, resNull, sumAbs, maxAbs, n }
}
function statsFor(id) {
  if (!counters.byPair.has(id)) counters.byPair.set(id, { primNull: 0, resNull: 0, sumAbs: 0, maxAbs: 0, n: 0 })
  return counters.byPair.get(id)
}

async function tickPower(pairs) {
  const tsIso = new Date().toISOString()
  await Promise.all(pairs.map(async (p) => {
    const [a, b] = await Promise.allSettled([p.primPower.fetchKwTotal(), p.resPower.fetchKwTotal()])
    const prim = settle(a, 'kw')
    const res = settle(b, 'kw')
    const st = statsFor(p.id)
    if (!prim.ok) st.primNull++
    if (!res.ok) st.resNull++
    if (!prim.ok || !res.ok) {
      console.warn(`[reserva][NULL] ${tsIso} ${p.id} ` +
        `PRIM(${p.primHost})=${prim.ok ? 'OK' : errType(prim.err)} RES(${p.resHost})=${res.ok ? 'OK' : errType(res.err)}`)
    }

    const bothOk = prim.ok && res.ok
    // Δ CON SIGNO (prim − res): un sesgo sistemático y ruido simétrico se ven distinto.
    const diffKw = bothOk ? prim.kw - res.kw : null
    const relDiffPct = bothOk && prim.kw !== 0 ? (Math.abs(diffKw) / Math.abs(prim.kw)) * 100 : (bothOk ? 0 : null)
    // Desfase real entre las dos lecturas del par: durante una rampa, este skew produce
    // una diferencia aparente que no es del medidor. El analizador lo descuenta.
    const skewMs = bothOk && prim.fetchedAt && res.fetchedAt
      ? Math.abs(Date.parse(prim.fetchedAt) - Date.parse(res.fetchedAt))
      : null

    if (bothOk) {
      st.n++
      const abs = Math.abs(diffKw)
      st.sumAbs += abs
      if (abs > st.maxAbs) st.maxAbs = abs
    }

    const record = {
      kind: 'power', ts: tsIso, pair: p.id, unit: p.unit,
      primHost: p.primHost, resHost: p.resHost,
      prim, res, bothOk, diffKw, relDiffPct, skewMs,
    }
    streamFor(p.id, tsIso).write(JSON.stringify(record) + '\n')
  }))
  counters.ticks++
}

async function tickEnergy(pairs) {
  const tsIso = new Date().toISOString()
  await Promise.all(pairs.map(async (p) => {
    if (!p.primEnergy || !p.resEnergy) return
    const [a, b] = await Promise.allSettled([p.primEnergy.fetchKwTotal(), p.resEnergy.fetchKwTotal()])
    const prim = settle(a, 'raw')
    const res = settle(b, 'raw')
    if (!prim.ok || !res.ok) {
      console.warn(`[reserva][NULL-E] ${tsIso} ${p.id} reg=${ENERGY_REGISTER} ` +
        `PRIM=${prim.ok ? 'OK' : errType(prim.err)} RES=${res.ok ? 'OK' : errType(res.err)}`)
    }
    const record = {
      kind: 'energy', ts: tsIso, pair: p.id, unit: p.unit,
      primHost: p.primHost, resHost: p.resHost, register: ENERGY_REGISTER, prim, res,
    }
    streamFor(p.id, tsIso).write(JSON.stringify(record) + '\n')
  }))
  counters.energyTicks++
}

async function main() {
  const pairs = buildPairs()
  if (pairs.length === 0) {
    console.error('[reserva] no hay ningún par válido. Define IP_<ID> e IP_<ID>_RESERVA en .env.')
    process.exit(1)
  }

  console.log(`[reserva] iniciando — ${pairs.length} par(es), poll=${POLL_MS}ms, duración=${Math.round(DURATION_MS / 60000)}min`)
  console.log(`[reserva] Modbus potencia: port=${MB.port} reg=${MB.register} word=${MB.wordOrder} dec=${MB.decode} /${MB.scale} unitId=${MB.unitId}`)
  console.log(`[reserva] Modbus energía:  ${ENERGY_POLL_MS > 0 ? `reg=${ENERGY_REGISTER} cada ${ENERGY_POLL_MS / 1000}s (sin escala)` : 'DESACTIVADA'}`)
  for (const p of pairs) console.log(`[reserva]   ${p.id.padEnd(7)} ${p.unit.padEnd(6)} primaria=${p.primHost}  reserva=${p.resHost}`)
  console.log(`[reserva] salida JSONL → ${BASE_DIR}\n`)

  let ticking = false
  const pollTimer = setInterval(() => {
    if (ticking) { console.warn('[reserva] tick previo aún corriendo, salto'); return }
    ticking = true
    tickPower(pairs).catch((e) => console.error(`[reserva] tick error: ${e?.message}`)).finally(() => { ticking = false })
  }, POLL_MS)

  let energyTimer = null
  if (ENERGY_POLL_MS > 0) {
    // Primera muestra ya: el Δ de la ventana necesita un punto de arranque temprano.
    await tickEnergy(pairs).catch((e) => console.error(`[reserva] tick energía error: ${e?.message}`))
    let eTicking = false
    energyTimer = setInterval(() => {
      if (eTicking) return
      eTicking = true
      tickEnergy(pairs).catch((e) => console.error(`[reserva] tick energía error: ${e?.message}`)).finally(() => { eTicking = false })
    }, ENERGY_POLL_MS)
  }

  const hb = setInterval(() => {
    const resumen = [...counters.byPair.entries()]
      .map(([id, s]) => `${id}: Δmedia=${s.n ? (s.sumAbs / s.n).toFixed(1) : '—'}kW Δmax=${s.maxAbs.toFixed(1)}kW nullP=${s.primNull} nullR=${s.resNull}`)
      .join(' | ')
    console.log(`[reserva] [${new Date().toISOString()}] ticks=${counters.ticks} energía=${counters.energyTicks} — ${resumen}`)
  }, 60_000)

  let stopped = false
  const teardown = async (reason) => {
    if (stopped) return
    stopped = true
    console.log(`\n[reserva] deteniendo (${reason}) — ticks=${counters.ticks}`)
    clearInterval(pollTimer); clearInterval(hb)
    if (energyTimer) clearInterval(energyTimer)
    // Última muestra de energía para cerrar la ventana con el mismo criterio con que abrió.
    if (ENERGY_POLL_MS > 0) await tickEnergy(pairs).catch(() => {})
    await Promise.allSettled(pairs.flatMap((p) => [
      p.primPower.close(), p.resPower.close(),
      p.primEnergy?.close(), p.resEnergy?.close(),
    ].filter(Boolean)))
    await Promise.all([...streams.values()].map((s) => new Promise((res) => s.end(res))))
    console.log('[reserva] listo. Analizar con: npm run shadow:reserva:analyze')
    process.exit(0)
  }

  const autoStop = setTimeout(() => teardown(`auto-stop ${Math.round(DURATION_MS / 60000)}min`), DURATION_MS)
  autoStop.unref?.()
  process.on('SIGINT', () => teardown('SIGINT'))
  process.on('SIGTERM', () => teardown('SIGTERM'))
}

main().catch((err) => {
  console.error('[reserva] falló inesperadamente:', err)
  process.exit(2)
})
