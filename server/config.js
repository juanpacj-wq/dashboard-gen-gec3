// ─── Conexión PME ────────────────────────────────────────────────────────────
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

// ─── Unidades de generación ───────────────────────────────────────────────────
// vllinea : número de fila (base-1) en la tabla HTML del diagrama PME
// referencia: texto de etiqueta que aparece en el diagrama junto al valor
// maxMW: capacidad máxima en MW (el PME reporta en kW → se divide /1000)
// occurrence: índice (base 0) de la Nth aparición del texto `referencia` en el DOM.
// Necesario cuando dos unidades comparten la misma etiqueta (ej. ambas Guajiras = "kW tot").
export const UNITS = [
  {
    id:         'TGJ1',
    label:      'GUAJIRA 1',
    referencia: 'kW tot',
    occurrence: 0,       // primera aparición de "kW tot"
    maxMW:      145,
  },
  {
    id:         'TGJ2',
    label:      'GUAJIRA 2',
    referencia: 'kW tot',
    occurrence: 1,       // segunda aparición de "kW tot"
    maxMW:      130,
  },
  {
    id:         'GEC3',
    label:      'GECELCA 3',
    referencia: 'KWTOT_G3',
    occurrence: 0,
    maxMW:      164,
  },
  {
    id:         'GEC32',
    label:      'GECELCA 32',
    referencia: 'KWTOT_G32',
    occurrence: 0,
    maxMW:      270,
  },
]
