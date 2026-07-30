/**
 * Invariantes de dominio de la generación (D-125).
 *
 * Dos reglas físicas del negocio, definidas acá una sola vez y compartidas por el backend
 * (`server/`, ESM por ruta relativa) y el frontend (`src/`, lo bundlea Vite):
 *   1. La generación nunca es negativa: el mínimo real de una unidad es 0 MW / 0 MWh.
 *   2. La desviación nunca baja de -100%: no se puede dejar de generar más que todo.
 *
 * Por qué existe: los medidores ION8650 de Gecelca están en frontera de entrada, así que
 * con la unidad parada consumiendo auxiliares el valor canónico queda negativo (≈ -14.7 MW).
 * Esa inversión de signo es correcta y vive en `meterPoller.js`; lo que no es correcto es
 * dejar que ese negativo se propague como "generación". Detalle físico en
 * `server/SIGN_CONVENTION.md`.
 *
 * ⚠️ Null-safety (restricción dura): `null` significa "sin lectura", NO "cero". Un
 * `Math.max(0, null)` devuelve 0 y convertiría un medidor muerto en "generando 0 MW": el
 * accumulator volvería a integrarlo (D-105/D-116 hacen `continue` con null) y la alerta de
 * medidor caído se apagaría. Por eso todo lo que no sea un número finito sale como `null`.
 * Nunca uses `Math.max` pelado en un call-site de esta invariante.
 */

export const MIN_GENERATION_MW = 0
export const MIN_GENERATION_MWH = 0
export const MIN_DEVIATION_PCT = -100

/**
 * Aplica un piso preservando la semántica de "sin lectura".
 * Solo acepta números finitos: strings numéricos, booleanos y objetos salen como `null`
 * a propósito, para que un valor mal tipado no se convierta en silencio en el piso.
 */
function clampAtFloor(value, floor) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < floor) return floor
  return value === 0 ? 0 : value // normaliza -0 a 0: Object.is(-0, 0) es false y confunde aguas abajo
}

/** Potencia instantánea en MW, con piso 0. `null` si no hay lectura válida. */
export function clampGenerationMw(value) {
  return clampAtFloor(value, MIN_GENERATION_MW)
}

/** Energía en MWh, con piso 0. `null` si no hay lectura válida. */
export function clampGenerationMwh(value) {
  return clampAtFloor(value, MIN_GENERATION_MWH)
}

/** Desviación porcentual, con piso -100. `null` si no hay valor válido. */
export function clampDeviationPct(value) {
  return clampAtFloor(value, MIN_DEVIATION_PCT)
}
