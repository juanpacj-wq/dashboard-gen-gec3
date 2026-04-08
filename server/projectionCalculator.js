// Pure functions for projection / deviation math.
// Reusable from accumulator.js (period close) and server.js (live broadcast).

// Colombia is UTC-5, no DST. Returns seconds within the current hour [0..3599].
function colombiaSecondsInHour(date = new Date()) {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60_000
  const col = new Date(utcMs - 5 * 3_600_000)
  return col.getMinutes() * 60 + col.getSeconds()
}

/**
 * Live deviation for the period in progress (VB6 logic):
 *   fraction   = secondsElapsed / 3600
 *   projection = acumulado + currentMW * (1 - fraction)
 *   deviation  = ((projection - redespacho) / redespacho) * 100   (null if redespacho <= 0)
 *
 * @param {Object} args
 * @param {number} args.acumuladoMwh - MWh accumulated so far in the current period
 * @param {number} args.currentMw    - latest instantaneous MW reading
 * @param {number|null} args.redespachoMw - redespacho for the current period (MW ≈ MWh per hour)
 * @param {Date} [args.now]
 * @returns {{ fraction: number, projection: number, deviation: number|null }}
 */
export function computeLive({ acumuladoMwh, currentMw, redespachoMw, now = new Date() }) {
  const acum = Number.isFinite(acumuladoMwh) ? acumuladoMwh : 0
  const mw = Number.isFinite(currentMw) ? Math.max(0, currentMw) : 0
  const seconds = colombiaSecondsInHour(now)
  const fraction = seconds / 3600
  const remaining = Math.max(0, 1 - fraction)
  const projection = acum + mw * remaining

  let deviation = null
  if (redespachoMw != null && redespachoMw > 0) {
    deviation = ((projection - redespachoMw) / redespachoMw) * 100
  }
  return { fraction, projection, deviation }
}

/**
 * Closed-period deviation. Denominator preference: email despFinal > redespacho fallback.
 *
 * @param {Object} args
 * @param {number} args.generacionMwh
 * @param {number|null} args.despFinalEmail - MW from email dispatch (preferred denominator)
 * @param {number|null} args.redespachoMw   - fallback denominator
 * @returns {{ generacionMwh: number, despFinalMw: number|null, despFinalSource: string|null, desviacionPct: number|null }}
 */
export function computeClosed({ generacionMwh, despFinalEmail, redespachoMw }) {
  let denominator = null
  let source = null
  if (despFinalEmail != null && despFinalEmail > 0) {
    denominator = despFinalEmail
    source = 'email'
  } else if (redespachoMw != null && redespachoMw > 0) {
    denominator = redespachoMw
    source = 'redespacho'
  }

  const desviacionPct = denominator != null
    ? ((generacionMwh - denominator) / denominator) * 100
    : null

  return {
    generacionMwh,
    despFinalMw: denominator,
    despFinalSource: source,
    desviacionPct,
  }
}
