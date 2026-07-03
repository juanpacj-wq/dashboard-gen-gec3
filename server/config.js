// ─── Conexión PME (mantener para fallback) ────────────────────────────────────
const DEFAULT_DIAGRAM_URL =
  'https://gpme.gecelca.com.co/ion/default.aspx' +
  '?dgm=x-pml%3a%2fdiagrams%2fud%2fbalance.dgm' +
  '&node=' +
  '&logServerName=QUERYSERVER.BQ-ENERGIA-07' +
  '&logServerHandle=327952'

export const PME = {
  loginUrl:   process.env.PME_LOGIN_URL   || 'https://gpme.gecelca.com.co/web',
  diagramUrl: process.env.PME_DIAGRAM_URL || DEFAULT_DIAGRAM_URL,
  user:       process.env.PME_USER        || 'supervisor',
  password:   process.env.PME_PASSWORD    || '',
}

// Fallback PME deshabilitado por default (D-120): con el flag apagado no se instancia el
// PMEScraper (cero Playwright/Chromium) y la extracción queda solo con los medidores.
// Reactivar = PME_ENABLED=1 explícito (+ PME_PASSWORD) y reiniciar.
export const PME_ENABLED = process.env.PME_ENABLED === '1'

// ─── Defaults del extractor de medidores ─────────────────────────────────────
export const METER_DEFAULTS = {
  opPath:     process.env.METER_OP_PATH                  || '/Operation.html',
  pollMs:     parseInt(process.env.METER_POLL_MS, 10)    || 2000,
  timeoutMs:  parseInt(process.env.METER_TIMEOUT_MS, 10) || 4000,
  // Carry-forward del último valor bueno del medidor ante nulls transitorios (D-116).
  holdTtlMin: parseFloat(process.env.METER_HOLD_TTL_MIN) || 3,
  // Protocolo de la fuente primaria (D-118; default modbus desde D-120). 'modbus' = leer
  // Modbus TCP FC03 (validado en sombra: 0% null vs HTTP, ~50× más rápido); 'http' = raspar
  // /Operation.html (legacy, queda como rollback instantáneo: METER_PROTOCOL=http +
  // reiniciar). El cliente se selecciona en server.js vía createMeterClientFactory().
  protocol:   process.env.METER_PROTOCOL || 'modbus',
  // Defaults = combo validado en el shadow (registro 40204 INT32 high /1000, unitId 1).
  modbus: {
    port:      parseInt(process.env.METER_MODBUS_PORT, 10)     || 502,
    unitId:    parseInt(process.env.METER_MODBUS_UNIT_ID, 10)  || 1,
    register:  parseInt(process.env.METER_MODBUS_REGISTER, 10) || 40204,
    wordOrder: process.env.METER_MODBUS_WORD_ORDER || 'high',
    decode:    process.env.METER_MODBUS_DECODE || 'int32',
    scale:     parseInt(process.env.METER_MODBUS_SCALE, 10) || 1000,
  },
}

// ─── Unidades de generación ──────────────────────────────────────────────────
// Modelo unificado:
//   meters[]        → para meterPoller (fuente primaria)
//   combine         → 'single' | 'sum' (GEC3 suma 2 medidores)
//   frontierType    → 'output' (Guajira) | 'input' (Gecelca, signo invertido)
//   pme.referencia  → para PMEScraper legacy (fallback). Etiqueta del DOM.
//   pme.occurrence  → índice base 0 de la N-ésima aparición de la etiqueta.
//
// Variables de entorno por medidor:
//   USER_MEDIDORES → usuario único compartido
//   IP_<ID>[_<N>] / PSW_<ID>[_<N>] → host y password
export const UNITS = [
  unit({
    id: 'TGJ1', label: 'GUAJIRA 1', maxMW: 145,
    frontierType: 'output',
    meterEnv: [{ ip: 'IP_TGJ1', psw: 'PSW_TGJ1' }],
    pme: { referencia: 'kW tot', occurrence: 0 },
  }),
  unit({
    id: 'TGJ2', label: 'GUAJIRA 2', maxMW: 130,
    frontierType: 'output',
    meterEnv: [{ ip: 'IP_TGJ2', psw: 'PSW_TGJ2' }],
    pme: { referencia: 'kW tot', occurrence: 1 },
  }),
  unit({
    id: 'GEC3', label: 'GECELCA 3', maxMW: 164,
    frontierType: 'input',
    meterEnv: [
      { ip: 'IP_GEC3_1', psw: 'PSW_GEC3_1' },
      { ip: 'IP_GEC3_2', psw: 'PSW_GEC3_2' },
    ],
    pme: { referencia: 'KWTOT_G3', occurrence: 0 },
  }),
  unit({
    id: 'GEC32', label: 'GECELCA 32', maxMW: 270,
    frontierType: 'input',
    meterEnv: [{ ip: 'IP_GEC32', psw: 'PSW_GEC32' }],
    pme: { referencia: 'KWTOT_G32', occurrence: 0 },
  }),
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unit({ id, label, maxMW, meterEnv, frontierType = 'output', pme }) {
  if (frontierType !== 'output' && frontierType !== 'input') {
    throw new Error(`config: unit ${id} frontierType inválido '${frontierType}'`)
  }
  // pme solo es obligatorio con el fallback habilitado (D-120); las 4 unidades lo
  // conservan hardcodeado como vía de rollback.
  if (PME_ENABLED && (!pme || !pme.referencia)) {
    throw new Error(`config: unit ${id} requiere pme: { referencia, occurrence } con PME_ENABLED=1`)
  }
  const meters = meterEnv.map(({ ip, psw }) => meterFromEnv({ ipKey: ip, pswKey: psw, unitId: id }))
  return {
    id,
    label,
    maxMW,
    frontierType,
    combine: meters.length > 1 ? 'sum' : 'single',
    meters,
    pme: pme ? { referencia: pme.referencia, occurrence: pme.occurrence ?? 0 } : null,
  }
}

function meterFromEnv({ ipKey, pswKey, unitId }) {
  return {
    host:     process.env[ipKey],
    user:     process.env.USER_MEDIDORES ?? process.env.METER_BASIC_USER,
    password: process.env[pswKey] ?? process.env.METER_BASIC_PASS ?? '',
    _ipKey:   ipKey,
    _pswKey:  pswKey,
    _unitId:  unitId,
  }
}

// ─── Validación al cargar el módulo (fail-fast en arranque) ──────────────────
// Se permite saltarla con CONFIG_SKIP_VALIDATION=1 para herramientas que
// importen la lista (ej. tests, scripts ad-hoc).
if (process.env.CONFIG_SKIP_VALIDATION !== '1') {
  const missing = []
  // Validación de medidores (fuente primaria)
  for (const u of UNITS) {
    for (const m of u.meters) {
      if (!m.host) missing.push(`${m._ipKey}  (unit=${u.id})`)
      if (!m.user) missing.push(`USER_MEDIDORES  (compartido)`)
      if (!m.password) missing.push(`${m._pswKey}  (unit=${u.id})`)
    }
  }
  // Validación del PME (fallback) — solo obligatorio con el fallback habilitado (D-120)
  if (PME_ENABLED && !PME.password) missing.push('PME_PASSWORD  (fallback PME, requerido con PME_ENABLED=1)')

  if (missing.length > 0) {
    const unique = [...new Set(missing)]
    const msg =
      'Faltan variables de entorno (extracción de potencia):\n  - ' +
      unique.join('\n  - ') +
      '\n\nDefinirlas en dashboard-gen-gec3/.env. Para saltar la validación: CONFIG_SKIP_VALIDATION=1'
    throw new Error(msg)
  }
}
