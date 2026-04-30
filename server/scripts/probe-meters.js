#!/usr/bin/env node
// Probe standalone — recorre UNITS y golpea cada medidor con timeout corto,
// imprime tabla con kW y latencia. Pensado para descubrir paths/credenciales
// nuevos antes de tocar el pipeline real.
//
// Uso:
//   npm run probe
//   METER_TGJ1_HOST=... METER_TGJ1_USER=... METER_TGJ1_PASS=... node scripts/probe-meters.js
import { UNITS, METER_DEFAULTS } from '../config.js'
import { ION8650Client } from '../meterClient.js'

const PROBE_TIMEOUT_MS = parseInt(process.env.PROBE_TIMEOUT_MS, 10) || 5000

async function probeMeter(unit, meter, idx) {
  const startedAt = Date.now()
  const client = new ION8650Client({
    host: meter.host,
    user: meter.user,
    password: meter.password,
    opPath: METER_DEFAULTS.opPath,
    timeoutMs: PROBE_TIMEOUT_MS,
  })
  try {
    const { kw, latencyMs } = await client.fetchKwTotal()
    return { unit: unit.id, idx, host: meter.host, ok: true, kw, latencyMs }
  } catch (err) {
    return {
      unit: unit.id,
      idx,
      host: meter.host,
      ok: false,
      error: `${err?.name ?? 'Error'}: ${err?.message ?? err}`,
      latencyMs: Date.now() - startedAt,
    }
  } finally {
    await client.close().catch(() => {})
  }
}

async function main() {
  console.log(`Probing ${UNITS.length} units (opPath=${METER_DEFAULTS.opPath}, timeout=${PROBE_TIMEOUT_MS}ms)\n`)

  const tasks = []
  for (const unit of UNITS) {
    for (let i = 0; i < unit.meters.length; i++) {
      tasks.push(probeMeter(unit, unit.meters[i], i))
    }
  }
  const results = await Promise.all(tasks)

  const header = pad('UNIT', 7) + pad('M', 3) + pad('HOST', 24) + pad('STATUS', 8) + pad('kW', 14) + 'LAT/INFO'
  console.log(header)
  console.log('─'.repeat(header.length + 20))

  for (const r of results) {
    const status = r.ok ? 'OK' : 'FAIL'
    const kwStr = r.ok ? r.kw.toFixed(2) : '—'
    const info = r.ok ? `${r.latencyMs}ms` : r.error
    console.log(
      pad(r.unit, 7) + pad(`m${r.idx}`, 3) + pad(r.host, 24) + pad(status, 8) + pad(kwStr, 14) + info,
    )
  }

  const allOk = results.every((r) => r.ok)
  console.log()
  console.log(allOk ? '✓ Todos los medidores responden.' : '✗ Hay medidores con fallo — revisar credenciales/red/path antes de iniciar el server.')
  process.exit(allOk ? 0 : 1)
}

function pad(s, n) {
  const str = String(s)
  if (str.length >= n) return str + ' '
  return str + ' '.repeat(n - str.length)
}

main().catch((err) => {
  console.error('Probe falló inesperadamente:', err)
  process.exit(2)
})
