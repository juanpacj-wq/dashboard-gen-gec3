#!/usr/bin/env node
// Captura los DOS bancos de registros de energía del ION8650 durante 1 h, para decidir cuál
// de los IDs duplicados sirve.
//
// El medidor publica las mismas magnitudes dos veces:
//   Banco A — 40230..40238, INT32 clásico.
//   Banco B — 40091..40105, INT32-M10K (base 10000, no 65536).
// Este script lee los dos bancos EN EL MISMO TICK sobre el mismo medidor, guarda las palabras
// de 16 bits CRUDAS además de los valores decodificados —así el análisis puede probar otra
// decodificación después sin volver a medir— y lee además 40204 (kW tot) para tener una
// referencia independiente: integrando la potencia se sabe cuánta energía hubo de verdad.
//
// Corre fuera de producción: no toca BD, ni orchestrator, ni server.js.
//
// Uso:  npm run shadow:registros            (1 h; REGISTROS_DURATION_MIN=2 para un humo corto)
//       npm run shadow:registros:analyze
import ModbusRTU from 'modbus-serial'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BLOQUES, REGISTROS, decodeReg, palabrasDe } from './lib/regDecode.js'

process.env.CONFIG_SKIP_VALIDATION = process.env.CONFIG_SKIP_VALIDATION || '1'
const { METER_DEFAULTS } = await import('../config.js')

const MB = METER_DEFAULTS.modbus
const TIMEOUT_MS = parseInt(process.env.METER_TIMEOUT_MS, 10) || 6000
const DURATION_MS = parseFloat(process.env.REGISTROS_DURATION_MIN || '60') * 60_000
// 5 s: los acumuladores no necesitan más, y la integral de kW con este paso es de sobra
// precisa frente a totales de cientos de MWh.
const POLL_MS = parseInt(process.env.REGISTROS_POLL_MS, 10) || 5000
const BASE_DIR = fileURLToPath(new URL('../traces/registros', import.meta.url))

// Los 6 medidores: 3 primarios y sus 3 de reserva. La saturación del banco B depende del
// valor absoluto del acumulador de CADA medidor, así que hay que mirarlos todos.
const MEDIDORES = [
  { id: 'GEC32-prim',  env: 'IP_GEC32' },
  { id: 'GEC32-res',   env: 'IP_GEC32_RESERVA' },
  { id: 'GEC3_1-prim', env: 'IP_GEC3_1' },
  { id: 'GEC3_1-res',  env: 'IP_GEC3_1_RESERVA' },
  { id: 'GEC3_2-prim', env: 'IP_GEC3_2' },
  { id: 'GEC3_2-res',  env: 'IP_GEC3_2_RESERVA' },
]

function construir() {
  const out = []
  for (const m of MEDIDORES) {
    const host = process.env[m.env]
    if (!host) { console.warn(`[registros] salto ${m.id}: falta ${m.env} en .env`); continue }
    out.push({ ...m, host, client: new ModbusRTU(), conectado: false })
  }
  return out
}

async function conectar(m) {
  if (m.conectado && m.client.isOpen) return
  // Instancia fresca en cada reconexión: modbus-serial puede quedar en un estado del que no
  // se recupera reconectando sobre el mismo objeto (mismo motivo que D-123).
  m.client = new ModbusRTU()
  await m.client.connectTCP(m.host, { port: MB.port })
  m.client.setID(MB.unitId)
  m.client.setTimeout(TIMEOUT_MS)
  m.conectado = true
}

// Los dos bancos NO se pueden leer en la misma trama: son dos FC03 separados con unos ms
// entre medio, y el contador sigue subiendo. Eso solo produce diferencias A−B minúsculas,
// pero con un orden fijo esas diferencias tendrían siempre el mismo signo y se podrían
// confundir con un sesgo real entre registros. Por eso el orden se ALTERNA por tick: si la
// diferencia cambia de signo con el orden, queda probado que es desfase de lectura y no
// discrepancia. Además se guarda el instante de cada bloque para poder cuantificarlo.
async function leer(m, tick) {
  await conectar(m)
  const energia = tick % 2 === 0 ? [BLOQUES[0], BLOQUES[1]] : [BLOQUES[1], BLOQUES[0]]
  const orden = [...energia, BLOQUES[2]]
  const t0 = Date.now()
  const bloques = []
  for (const b of orden) {
    const antes = Date.now()
    const res = await m.client.readHoldingRegisters(b.off, b.len)
    bloques.push({ off: b.off, len: b.len, data: res.data, tMs: (antes + Date.now()) / 2 - t0 })
  }
  return { bloques, ordenLectura: orden.slice(0, 2).map((b) => (b.off === 90 ? 'B' : 'A')).join('→') }
}

// ─── Salida JSONL ─────────────────────────────────────────────────────────────
const streams = new Map()
let dirListo = false
function streamPara(id, tsIso) {
  if (!dirListo) { mkdirSync(BASE_DIR, { recursive: true }); dirListo = true }
  const clave = `${id}::${tsIso.slice(0, 13)}`
  if (streams.has(clave)) return streams.get(clave)
  for (const [vieja, s] of streams) {
    if (vieja.startsWith(`${id}::`)) { s.end(); streams.delete(vieja) }
  }
  const ruta = join(BASE_DIR, `registros-${id}-${tsIso.slice(0, 10)}-${tsIso.slice(11, 13)}.jsonl`)
  const s = createWriteStream(ruta, { flags: 'a' })
  s.on('error', (e) => console.warn(`[registros] stream error (${id}): ${e?.message}`))
  streams.set(clave, s)
  console.log(`[registros] abriendo ${ruta}`)
  return s
}

const cont = { ticks: 0, errores: 0, porMedidor: new Map() }

async function tick(medidores) {
  const tsIso = new Date().toISOString()
  await Promise.all(medidores.map(async (m) => {
    let bloques, ordenLectura
    try {
      ({ bloques, ordenLectura } = await leer(m, cont.ticks))
    } catch (err) {
      m.conectado = false
      cont.errores++
      const est = cont.porMedidor.get(m.id) || { nulls: 0 }
      est.nulls++; cont.porMedidor.set(m.id, est)
      streamPara(m.id, tsIso).write(JSON.stringify({
        ts: tsIso, medidor: m.id, host: m.host, ok: false,
        err: `${err?.name || 'Error'}: ${err?.message || err}`,
      }) + '\n')
      return
    }

    const kwWords = palabrasDe(bloques, 203)
    const kwTot = kwWords ? (((kwWords[0] << 16) | kwWords[1]) | 0) / MB.scale : null

    const tMsPorBloque = Object.fromEntries(bloques.map((b) => [b.off, Math.round(b.tMs)]))
    const regs = {}
    for (const r of REGISTROS) {
      const w = palabrasDe(bloques, r.off)
      if (!w) { regs[r.reg] = { w0: null, w1: null, value: null }; continue }
      const d = decodeReg(r.formato, w[0], w[1])
      const bloque = bloques.find((b) => r.off >= b.off && r.off + 1 < b.off + b.len)
      // Se guardan las palabras crudas a propósito: si mañana hay que probar otra
      // decodificación, se hace sobre estos datos sin volver a medir una hora.
      regs[r.reg] = {
        w0: w[0], w1: w[1], value: d.value, sat: d.saturated, mal: d.malformed,
        tMs: bloque ? Math.round(bloque.tMs) : null,
      }
    }

    streamPara(m.id, tsIso).write(JSON.stringify({
      ts: tsIso, medidor: m.id, host: m.host, ok: true, kwTot, ordenLectura, tMsPorBloque, regs,
    }) + '\n')
  }))
  cont.ticks++
}

async function main() {
  const medidores = construir()
  if (medidores.length === 0) { console.error('[registros] no hay medidores configurados'); process.exit(1) }

  console.log(`[registros] iniciando — ${medidores.length} medidores, poll=${POLL_MS}ms, duración=${Math.round(DURATION_MS / 60000)}min`)
  console.log(`[registros] banco A (INT32): 40230,40232,40234,40236,40238`)
  console.log(`[registros] banco B (M10K):  40091,40093,40095,40097,40099,40101,40103,40105`)
  console.log(`[registros] referencia independiente: 40204 kW tot (se integra para saber la energía real)`)
  for (const m of medidores) console.log(`[registros]   ${m.id.padEnd(13)} ${m.host}`)
  console.log(`[registros] salida JSONL → ${BASE_DIR}\n`)

  let corriendo = false
  const timer = setInterval(() => {
    if (corriendo) { console.warn('[registros] tick previo aún corriendo, salto'); return }
    corriendo = true
    tick(medidores).catch((e) => console.error(`[registros] tick error: ${e?.message}`)).finally(() => { corriendo = false })
  }, POLL_MS)

  await tick(medidores).catch(() => {})   // primera muestra ya: abre la ventana del Δ

  const hb = setInterval(() => {
    const fallas = [...cont.porMedidor.entries()].map(([k, v]) => `${k}=${v.nulls}`).join(' ') || 'ninguna'
    console.log(`[registros] [${new Date().toISOString()}] ticks=${cont.ticks} errores=${cont.errores} (${fallas})`)
  }, 60_000)

  let parado = false
  const cerrar = async (motivo) => {
    if (parado) return
    parado = true
    console.log(`\n[registros] deteniendo (${motivo}) — ticks=${cont.ticks} errores=${cont.errores}`)
    clearInterval(timer); clearInterval(hb)
    await tick(medidores).catch(() => {})   // última muestra: cierra la ventana del Δ
    for (const m of medidores) { try { m.client.close(() => {}) } catch { /* ignore */ } }
    await Promise.all([...streams.values()].map((s) => new Promise((r) => s.end(r))))
    console.log('[registros] listo. Analizar con: npm run shadow:registros:analyze')
    process.exit(0)
  }

  const auto = setTimeout(() => cerrar(`auto-stop ${Math.round(DURATION_MS / 60000)}min`), DURATION_MS)
  auto.unref?.()
  process.on('SIGINT', () => cerrar('SIGINT'))
  process.on('SIGTERM', () => cerrar('SIGTERM'))
}

main().catch((err) => { console.error('[registros] falló inesperadamente:', err); process.exit(2) })
