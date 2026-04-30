#!/usr/bin/env node
// Smoke test del extractor: prende MeterPoller con la config real y loguea
// cada broadcast en vivo. Útil para validar end-to-end (red + medidores +
// parsing + agregación GEC3 + cadencia) sin depender del server.js completo.
//
// Uso:
//   npm run smoke
//   (Ctrl+C para parar; SIGTERM también lo cierra graceful)
import { UNITS, METER_DEFAULTS } from '../config.js'
import { MeterPoller } from '../meterPoller.js'

console.log(
  `[smoke] Arrancando MeterPoller — ${UNITS.length} unidades, ${UNITS.reduce((n, u) => n + u.meters.length, 0)} medidores, poll=${METER_DEFAULTS.pollMs}ms, timeout=${METER_DEFAULTS.timeoutMs}ms\n`,
)

const poller = new MeterPoller({
  units: UNITS,
  onData: (payload) => {
    const t = payload.timestamp.slice(11, 19)
    const cells = payload.units
      .map((u) => `${u.id}=${u.valueMW != null ? u.valueMW.toFixed(2).padStart(7) + ' MW' : '   —    '}`)
      .join('   ')
    console.log(`[${t}] ${cells}`)
  },
  ...METER_DEFAULTS,
})

await poller.start()

setInterval(() => {
  const s = poller.getStatus()
  const meterErrors = Object.entries(s.perMeter)
    .filter(([, m]) => m.consecutiveErrors > 0)
    .map(([k, m]) => `${k}:${m.consecutiveErrors}`)
    .join(' ')
  console.log(
    `\n[smoke] status: updates=${s.updateCount} errorTicks=${s.errorCount} stale=${s.stale}` +
    (meterErrors ? `  medidoresConError=[${meterErrors}]` : '') +
    `\n`,
  )
}, 30_000)

const shutdown = async (sig) => {
  console.log(`\n[smoke] ${sig} recibido — cerrando...`)
  await poller.stop()
  process.exit(0)
}
process.on('SIGINT',  () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
