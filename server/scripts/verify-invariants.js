#!/usr/bin/env node
// Verifica la invariante de dominio D-125 en las 6 tablas del esquema `dashboard`:
// la generación nunca es negativa (MW y MWh >= 0) y la desviación nunca baja de -100%.
//
// Es el gate pre/post backfill y sirve para auditar cualquier instancia nueva. Sale con
// código != 0 si encuentra al menos una violación, así que se puede encadenar en scripts.
//
// Uso:  node --env-file=../.env         scripts/verify-invariants.js    (PortalG3)
//       node --env-file=../.env.guajira scripts/verify-invariants.js    (portalteg)
import { getDB } from '../db.js'
import { MIN_GENERATION_MWH, MIN_DEVIATION_PCT } from '../../shared/domain/generation.js'

// Cada entrada declara la tabla, la columna de periodo que usa (varía: generacion_* guarda
// `hora` 0-23 y las proyeccion_* guardan `periodo` 1-24) y las columnas sujetas a piso.
const CHECKS = [
  { tabla: 'generacion_periodos',  periodCol: 'hora',    floors: { energia_mwh: MIN_GENERATION_MWH } },
  { tabla: 'generacion_acumulado', periodCol: 'hora',    floors: { energia_mwh: MIN_GENERATION_MWH } },
  {
    tabla: 'desviacion_periodos', periodCol: 'periodo',
    floors: { generacion_mwh: MIN_GENERATION_MWH, desviacion_pct: MIN_DEVIATION_PCT },
  },
  {
    tabla: 'proyeccion_periodos', periodCol: 'periodo',
    floors: {
      proyeccion_cierre_mwh: MIN_GENERATION_MWH,
      generacion_real_mwh: MIN_GENERATION_MWH,
      desviacion_pct: MIN_DEVIATION_PCT,
    },
  },
  {
    tabla: 'proyeccion_actual', periodCol: 'periodo',
    floors: {
      acumulado_mwh: MIN_GENERATION_MWH,
      proyeccion_mwh: MIN_GENERATION_MWH,
      current_mw: MIN_GENERATION_MWH,
      desviacion_pct: MIN_DEVIATION_PCT,
    },
  },
  {
    tabla: 'proyeccion_historico', periodCol: 'periodo',
    floors: {
      acumulado_mwh: MIN_GENERATION_MWH,
      proyeccion_mwh: MIN_GENERATION_MWH,
      current_mw: MIN_GENERATION_MWH,
      desviacion_pct: MIN_DEVIATION_PCT,
    },
  },
]

const fmt = (v, d = 4) => (v == null ? '—' : Number(v).toFixed(d))
const fecha = (v) => (v == null ? '—' : new Date(v).toISOString().slice(0, 10))

// Filas DISTINTAS con al menos una columna en violación. No es lo mismo que la suma por
// columna: una fila de proyeccion_historico puede violar acumulado_mwh, proyeccion_mwh y
// current_mw a la vez y contaría tres veces. Se reportan las dos cifras.
async function countRows(db, tabla, floors) {
  const cond = Object.entries(floors).map(([c, f]) => `${c} < ${f}`).join(' OR ')
  const { recordset: [r] } = await db.request().query(`
    SELECT COUNT(*) AS filas FROM dashboard.${tabla} WHERE ${cond}
  `)
  return r?.filas ?? 0
}

async function scanColumn(db, tabla, columna, floor) {
  const { recordset } = await db.request().query(`
    SELECT unit_id,
           COUNT(*)        AS celdas,
           MIN(fecha)      AS desde,
           MAX(fecha)      AS hasta,
           MIN(${columna}) AS peor
    FROM dashboard.${tabla}
    WHERE ${columna} < ${floor}
    GROUP BY unit_id
    ORDER BY unit_id
  `)
  return recordset
}

async function main() {
  const db = await getDB()
  const dbName = process.env.DB_NAME ?? '(sin DB_NAME)'
  const host = process.env.DB_HOST ?? '(sin DB_HOST)'

  console.log(`\n=== Verificación de invariantes D-125 ===`)
  console.log(`BD: ${dbName} @ ${host}`)
  console.log(`Pisos: generación >= ${MIN_GENERATION_MWH} · desviación >= ${MIN_DEVIATION_PCT}\n`)

  let totalCeldas = 0
  let totalFilas = 0
  for (const { tabla, periodCol, floors } of CHECKS) {
    const hallazgos = []
    for (const [columna, floor] of Object.entries(floors)) {
      const rows = await scanColumn(db, tabla, columna, floor)
      for (const r of rows) hallazgos.push({ columna, ...r })
    }

    if (hallazgos.length === 0) {
      console.log(`✔ ${tabla.padEnd(22)} sin violaciones`)
      continue
    }

    const celdasTabla = hallazgos.reduce((s, h) => s + h.celdas, 0)
    const filasTabla = await countRows(db, tabla, floors)
    totalCeldas += celdasTabla
    totalFilas += filasTabla
    console.log(`✖ ${tabla.padEnd(22)} ${filasTabla} fila(s) / ${celdasTabla} celda(s)  [periodo en columna \`${periodCol}\`]`)
    for (const h of hallazgos) {
      console.log(
        `    ${h.columna.padEnd(22)} ${String(h.celdas).padStart(6)} celdas` +
        `  ${h.unit_id.padEnd(6)} ${fecha(h.desde)} → ${fecha(h.hasta)}  peor=${fmt(h.peor)}`,
      )
    }
  }

  const total = totalCeldas
  console.log(`\nTotal: ${totalFilas} fila(s) en violación · ${totalCeldas} celda(s) a corregir`)
  if (total > 0) {
    console.log('Siguiente paso: node --env-file=<env> scripts/backfill-d125.js (dry-run) y luego --apply.')
  }
  await db.close()
  process.exit(total > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('[verify-invariants] error:', err?.message ?? err)
  process.exit(2)
})
