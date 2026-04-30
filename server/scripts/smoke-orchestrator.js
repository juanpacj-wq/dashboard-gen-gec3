#!/usr/bin/env node
import { ExtractorOrchestrator } from '../extractorOrchestrator.js'
import { UNITS, PME, METER_DEFAULTS } from '../config.js'

const orch = new ExtractorOrchestrator({
  units: UNITS,
  pme: PME,
  onData: (p) => {
    const t = p.timestamp.slice(11, 19)
    const cells = p.units
      .map((u) => u.id + '=' + (u.valueMW != null ? u.valueMW.toFixed(2) + 'MW' : '—'))
      .join(' ')
    process.stdout.write('[' + t + '] ' + cells + '\n')
  },
  ...METER_DEFAULTS,
})

await orch.start()

setInterval(() => {
  const s = orch.getStatus()
  const sources = Object.entries(s.perUnit).map(([k, v]) => k + ':' + v.source).join(' ')
  process.stdout.write('[status] ' + sources + '\n')
}, 30000)
