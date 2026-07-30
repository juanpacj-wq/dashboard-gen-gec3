// Pure functions for projection / deviation math.
// Reusable from accumulator.js (period close) and server.js (live broadcast).

import { clampGenerationMw, clampGenerationMwh, clampDeviationPct } from '../shared/domain/generation.js'

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
 * D-125 (invariante): acumulado y currentMw entran con piso 0, así que `projection` nunca
 * es negativa y `deviation` nunca baja de -100%. Antes solo se clampaba currentMw: con el
 * acumulado negativo de una unidad en reserva, la desviación viva caía a lo largo de la
 * hora y el chart CEP dibujaba una sierra descendente.
 *
 * @param {Object} args
 * @param {number} args.acumuladoMwh - MWh accumulated so far in the current period (piso 0)
 * @param {number} args.currentMw    - latest instantaneous MW reading (piso 0)
 * @param {number|null} args.redespachoMw - redespacho for the current period (MW ≈ MWh per hour)
 * @param {Date} [args.now]
 * @returns {{ fraction: number, projection: number, deviation: number|null }} projection ≥ 0, deviation ≥ -100
 */
export function computeLive({ acumuladoMwh, currentMw, redespachoMw, now = new Date() }) {
  // El `?? 0` es local a este contexto y NO es la coerción que D-125 prohíbe en el camino
  // del dato canónico: acá "sin lectura" significa "seguí proyectando con lo acumulado",
  // que es exactamente lo que el código ya hacía con `Number.isFinite(...) ? ... : 0`.
  const acum = clampGenerationMwh(acumuladoMwh) ?? 0
  const mw = clampGenerationMw(currentMw) ?? 0
  const seconds = colombiaSecondsInHour(now)
  const fraction = seconds / 3600
  const remaining = Math.max(0, 1 - fraction)   // fracción de tiempo, no generación: sin helper
  const projection = acum + mw * remaining

  let deviation = null
  if (redespachoMw != null && redespachoMw > 0) {
    deviation = clampDeviationPct(((projection - redespachoMw) / redespachoMw) * 100)
  }
  return { fraction, projection, deviation }
}

/**
 * Closed-period deviation. Denominator preference: despacho_final row > redespacho fallback.
 *
 * D-124: la fuente registrada es la REAL de la fila de despacho_final ('email' | 'xm_fallback'),
 * no un literal fijo — desviacion_periodos.desp_final_source es dato de auditoría y antes
 * etiquetaba 'email' incluso cuando el valor venía del fallback de la API XM. Paridad con
 * recoverSkippedPeriods (server.js), que ya atribuía dfEntry.source.
 *
 * D-125 (invariante): era la única fórmula de desviación del repo sin piso en el numerador.
 * Con GEC32 en reserva (-14.79 MWh de auxiliares) contra un despacho final de 35 MW daba
 * -142.27%, mientras proyeccion_periodos -escrita en el mismo callback- ya decía -100.
 * Ahora la generación entra con piso 0 y SALE clampada: el valor devuelto es el que se
 * persiste en desviacion_periodos.generacion_mwh (FLOAT NOT NULL, con CHECK >= 0 desde E6).
 *
 * @param {Object} args
 * @param {number} args.generacionMwh
 * @param {number|null} args.despFinalMw     - MW de la fila de despacho_final (denominador preferido)
 * @param {string|null} args.despFinalSource - fuente real de esa fila ('email' | 'xm_fallback')
 * @param {number|null} args.redespachoMw    - denominador de fallback (rDEC)
 * @returns {{ generacionMwh: number, despFinalMw: number|null, despFinalSource: string|null, desviacionPct: number|null }} generacionMwh ≥ 0, desviacionPct ≥ -100 o null
 */
export function computeClosed({ generacionMwh, despFinalMw, despFinalSource, redespachoMw }) {
  const generacion = clampGenerationMwh(generacionMwh) ?? 0
  let denominator = null
  let source = null
  if (despFinalMw != null && despFinalMw > 0) {
    denominator = despFinalMw
    source = despFinalSource ?? null
  } else if (redespachoMw != null && redespachoMw > 0) {
    denominator = redespachoMw
    source = 'redespacho'
  }

  const desviacionPct = denominator != null
    ? clampDeviationPct(((generacion - denominator) / denominator) * 100)
    : null

  return {
    generacionMwh: generacion,
    despFinalMw: denominator,
    despFinalSource: source,
    desviacionPct,
  }
}
