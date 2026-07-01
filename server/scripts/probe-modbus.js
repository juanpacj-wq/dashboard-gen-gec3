#!/usr/bin/env node
// Probe de descubrimiento Modbus — para cada medidor ION8650:
//   1. ¿Alcanzable en :502? (net.connect; distingue ECONNREFUSED de ETIMEDOUT)
//   2. ¿Modbus habilitado? prueba unitIds {1,100,255,0} con FC03
//   3. Matriz registro×wordOrder×decode comparada contra una lectura HTTP SIMULTÁNEA
//      del mismo medidor → descubre el combo (reg,unitId,word,decode,scale) que iguala
//      el valor actual (en kW), sin asumir nada.
//
// Uso:  npm run probe:modbus      (= CONFIG_SKIP_VALIDATION=1 node --env-file=../.env scripts/probe-modbus.js)
import net from 'node:net'
import ModbusRTU from 'modbus-serial'
import { ION8650Client } from '../meterClient.js'
import { decodeRegisters } from '../meterModbusClient.js'

// Diagnóstico: solo necesita las vars de medidores, no las del PME. Auto-salta la
// validación fail-fast de config.js de forma portable (sin env var inline, que rompe
// en Windows). Import dinámico para que el flag aplique antes de evaluar config.js.
process.env.CONFIG_SKIP_VALIDATION = process.env.CONFIG_SKIP_VALIDATION || '1'
const { UNITS, METER_DEFAULTS } = await import('../config.js')

const PORT = parseInt(process.env.METER_MODBUS_PORT, 10) || 502
const OP_TIMEOUT_MS = parseInt(process.env.PROBE_MODBUS_TIMEOUT_MS, 10) || 2500
const UNIT_IDS = (process.env.PROBE_MODBUS_UNIT_IDS || '1,100,255,0')
  .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n))

// Candidatos del mapa ION8650 (kW tot scaled). Offset 0-based = reg - 40001.
const REGISTERS = [
  { reg: 40033, off: 32, scale: 10 },
  { reg: 40204, off: 203, scale: 1000 },
]
const WORD_ORDERS = ['high', 'low']
const DECODES = ['int32', 'float32']
const MATCH_REL_PCT = 2.0    // discovery: tolerancia generosa; el shadow afina luego
const MATCH_ABS_KW = 0.1

function flattenMeters() {
  const out = []
  for (const unit of UNITS) {
    for (let i = 0; i < unit.meters.length; i++) {
      out.push({ unitId: unit.id, idx: i, host: unit.meters[i].host, meter: unit.meters[i] })
    }
  }
  return out
}

function checkPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (reachable, info) => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* ignore */ }
      resolve({ reachable, info })
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true, 'open'))
    sock.once('timeout', () => finish(false, 'ETIMEDOUT (firewall/red)'))
    sock.once('error', (err) => finish(false, `${err.code || err.message} (puerto cerrado/Modbus off)`))
    sock.connect(port, host)
  })
}

async function httpRead(meter) {
  const client = new ION8650Client({
    host: meter.host, user: meter.user, password: meter.password,
    opPath: METER_DEFAULTS.opPath, timeoutMs: OP_TIMEOUT_MS,
  })
  try {
    const { kw } = await client.fetchKwTotal()
    return { ok: true, kw }
  } catch (err) {
    return { ok: false, error: `${err?.name}: ${err?.message}` }
  } finally {
    await client.close().catch(() => {})
  }
}

// Conecta una vez y prueba unitIds + lee los registros candidatos. Devuelve, por unitId
// que respondió, los buffers de cada registro (o el error/exception por registro).
async function modbusProbe(host) {
  const client = new ModbusRTU()
  try {
    await client.connectTCP(host, { port: PORT })
  } catch (err) {
    return { connected: false, error: `${err.code || err.name}: ${err.message}` }
  }
  client.setTimeout(OP_TIMEOUT_MS)

  let chosen = null
  const perUnitEvidence = []
  for (const uid of UNIT_IDS) {
    try {
      client.setID(uid)
      const res = await client.readHoldingRegisters(REGISTERS[0].off, 2) // 40033 como sonda
      chosen = { uid, firstBuffer: res?.buffer }
      break
    } catch (err) {
      perUnitEvidence.push(`uid=${uid} → ${err.modbusCode != null ? `exception 0x${err.modbusCode.toString(16).padStart(2, '0')}` : (err.name || err.code || 'err')}: ${err.message}`)
    }
  }

  if (!chosen) {
    try { await closeClient(client) } catch { /* ignore */ }
    return { connected: true, modbusOk: false, evidence: perUnitEvidence }
  }

  // Lee cada registro candidato con el uid elegido
  const reads = {}
  for (const r of REGISTERS) {
    try {
      const res = await client.readHoldingRegisters(r.off, 2)
      reads[r.reg] = { ok: true, buffer: res?.buffer }
    } catch (err) {
      reads[r.reg] = { ok: false, error: err.modbusCode != null ? `exception 0x${err.modbusCode.toString(16).padStart(2, '0')}` : (err.message || String(err)) }
    }
  }
  await closeClient(client).catch(() => {})
  return { connected: true, modbusOk: true, uid: chosen.uid, reads }
}

function closeClient(client) {
  return new Promise((resolve) => {
    try { client.close(() => resolve()) } catch { resolve() }
  })
}

// Dado los buffers leídos y el kW HTTP de referencia, encuentra los combos que matchean.
function findMatches(reads, httpKw) {
  const combos = []
  for (const r of REGISTERS) {
    const entry = reads[r.reg]
    if (!entry?.ok || !Buffer.isBuffer(entry.buffer) || entry.buffer.length < 4) continue
    for (const word of WORD_ORDERS) {
      for (const decode of DECODES) {
        let raw
        try { raw = decodeRegisters(entry.buffer, word, decode) } catch { continue }
        const scale = decode === 'float32' ? 1 : r.scale
        const kw = raw / scale
        if (!Number.isFinite(kw)) continue
        const absDiff = httpKw == null ? null : Math.abs(kw - httpKw)
        const relPct = (httpKw == null || httpKw === 0)
          ? (absDiff != null && absDiff <= MATCH_ABS_KW ? 0 : null)
          : (absDiff / Math.abs(httpKw)) * 100
        const match = httpKw != null &&
          (absDiff <= MATCH_ABS_KW || (relPct != null && relPct <= MATCH_REL_PCT))
        combos.push({ reg: r.reg, word, decode, scale, kw, absDiff, relPct, match })
      }
    }
  }
  combos.sort((a, b) => (a.absDiff ?? Infinity) - (b.absDiff ?? Infinity))
  return combos
}

async function main() {
  console.log(`Probe Modbus — puerto ${PORT}, timeout ${OP_TIMEOUT_MS}ms, unitIds [${UNIT_IDS.join(',')}]`)
  console.log(`Registros candidatos: ${REGISTERS.map((r) => `${r.reg}(off ${r.off}, /${r.scale})`).join(', ')}\n`)

  const meters = flattenMeters()
  const rows = []
  for (const m of meters) {
    // HTTP y Modbus en paralelo (lectura "simultánea" para comparar el mismo instante)
    const [http, port] = await Promise.all([httpRead(m.meter), checkPort(m.host, PORT, OP_TIMEOUT_MS)])
    let mb = { connected: false }
    if (port.reachable) mb = await modbusProbe(m.host)

    const httpKw = http.ok ? http.kw : null
    let best = null
    let combos = []
    if (mb.modbusOk) {
      combos = findMatches(mb.reads, httpKw)
      best = combos.find((c) => c.match) || combos[0] || null
    }
    rows.push({ m, http, port, mb, best, combos })
  }

  // ── Tabla resumen ──
  const H = pad('UNIT', 7) + pad('M', 3) + pad('HOST', 18) + pad('502?', 6) + pad('MB?', 6) +
    pad('kW(HTTP)', 12) + pad('MATCH(reg,uid,word,dec,scale)', 32) + pad('kW(MB)', 12) + 'Δ'
  console.log(H)
  console.log('─'.repeat(H.length + 10))
  for (const { m, http, port, mb, best } of rows) {
    const p502 = port.reachable ? 'OK' : 'NO'
    const mbOk = !port.reachable ? '—' : (mb.modbusOk ? 'OK' : 'NO')
    const httpKw = http.ok ? http.kw.toFixed(2) : `ERR`
    const matchStr = best && best.match
      ? `${best.reg},${mb.uid},${best.word},${best.decode},/${best.scale}`
      : (mb.modbusOk ? '(sin match)' : '—')
    const mbKw = best ? best.kw.toFixed(2) : '—'
    const delta = best && best.absDiff != null ? best.absDiff.toFixed(3) : '—'
    console.log(
      pad(m.unitId, 7) + pad(`m${m.idx}`, 3) + pad(m.host, 18) + pad(p502, 6) + pad(mbOk, 6) +
      pad(httpKw, 12) + pad(matchStr, 32) + pad(mbKw, 12) + delta,
    )
  }

  // ── Detalle / evidencia ──
  console.log('\n── Detalle ──')
  for (const { m, http, port, mb, best, combos } of rows) {
    console.log(`\n[${m.unitId} m${m.idx}] ${m.host}`)
    console.log(`  HTTP: ${http.ok ? http.kw.toFixed(2) + ' kW' : 'ERROR ' + http.error}`)
    console.log(`  :502 → ${port.reachable ? 'alcanzable' : 'NO (' + port.info + ')'}`)
    if (port.reachable && !mb.connected) console.log(`  Modbus connect: FALLÓ — ${mb.error}`)
    if (mb.connected && !mb.modbusOk) {
      console.log(`  Modbus habilitado: NO. Evidencia por unitId (para ticket proveedor):`)
      for (const e of mb.evidence || []) console.log(`    · ${e}`)
    }
    if (mb.modbusOk) {
      console.log(`  Modbus OK con unitId=${mb.uid}. Combos (orden por Δ):`)
      for (const c of combos.slice(0, 6)) {
        console.log(`    ${c.match ? '✓' : ' '} reg=${c.reg} word=${c.word} dec=${c.decode} /${c.scale} → ${c.kw.toFixed(3)} kW  Δ=${c.absDiff != null ? c.absDiff.toFixed(3) : '—'}${c.relPct != null ? ` (${c.relPct.toFixed(2)}%)` : ''}`)
      }
      if (best && best.match) {
        console.log(`  → MATCH: METER_MODBUS_REGISTER=${best.reg} METER_MODBUS_UNIT_ID=${mb.uid} METER_MODBUS_WORD_ORDER=${best.word} METER_MODBUS_DECODE=${best.decode} METER_MODBUS_SCALE=${best.scale}`)
      } else {
        console.log(`  → SIN MATCH contra el valor HTTP — ampliar búsqueda de registros antes de seguir.`)
      }
    }
  }

  // ── Veredicto ──
  const allMatched = rows.every((r) => r.best && r.best.match)
  const anyModbusOff = rows.some((r) => r.port.reachable && !r.mb.modbusOk)
  const anyUnreachable = rows.some((r) => !r.port.reachable)
  console.log('\n' + (allMatched
    ? '✓ Los 5 medidores responden Modbus y matchean el valor HTTP. Listo para el shadow.'
    : `✗ Pendiente: ${anyUnreachable ? 'puerto 502 inalcanzable en algún medidor (infra). ' : ''}${anyModbusOff ? 'Modbus deshabilitado en algún medidor (proveedor). ' : ''}Revisar detalle arriba.`))
  process.exit(allMatched ? 0 : 1)
}

function pad(s, n) {
  const str = String(s)
  return str.length >= n ? str + ' ' : str + ' '.repeat(n - str.length)
}

main().catch((err) => {
  console.error('Probe Modbus falló inesperadamente:', err)
  process.exit(2)
})
