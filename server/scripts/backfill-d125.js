#!/usr/bin/env node
// Backfill auditable de la invariante D-125: lleva la generación histórica a piso 0 y la
// desviación a piso -100 en las 6 tablas del esquema `dashboard`, dejando rastro celda por
// celda en `dashboard.correccion_d125`.
//
// DRY-RUN POR DEFECTO: sin `--apply` no escribe absolutamente nada (ni siquiera crea la
// tabla de auditoría).
//
// Uso:  node --env-file=../.env scripts/backfill-d125.js              (dry-run)
//       node --env-file=../.env scripts/backfill-d125.js --apply
//       node --env-file=../.env scripts/backfill-d125.js --apply --verbose
//
// ORDEN EN PRODUCCIÓN: desplegar E1..E4 y reiniciar el servicio ANTES de correr esto. Con el
// código viejo vivo, las tablas de estado (generacion_acumulado, proyeccion_actual) se
// vuelven a ensuciar en el siguiente tick. Y el backfill va ANTES de las CHECK de E6: una
// constraint sobre datos sucios falla.
import sql from 'mssql'
import { getDB } from '../db.js'
import { MIN_GENERATION_MWH, MIN_DEVIATION_PCT } from '../../shared/domain/generation.js'

const APPLY = process.argv.includes('--apply')
const VERBOSE = process.argv.includes('--verbose')
const SAMPLE = VERBOSE ? 20 : 5
const BATCH = 5000   // filas por sentencia en --apply

const MOTIVO_GEN = 'D-125: piso 0 — lo que el medidor lee por debajo son auxiliares en frontera de entrada'
const MOTIVO_DEV = 'D-125: piso -100% — no se puede dejar de generar mas que todo lo despachado'
const MOTIVO_RECALC = 'D-125: recalculo desde desp_final_mw tras llevar generacion_mwh a 0 (coherencia de la fila)'
const NOTA_HORA = ' | periodo = hora + 1'

// `periodOut` es la expresión que se guarda como `periodo` en la auditoría: las tablas
// generacion_* guardan `hora` (0-23) y las proyeccion_*/desviacion_* guardan `periodo` (1-24).
// Se normaliza todo a 1-24 para que la auditoría sea comparable entre tablas.
const TABLES = [
  {
    tabla: 'generacion_periodos', pk: 'id', periodOut: 'deleted.hora + 1', periodSel: 'hora + 1',
    cols: [{ columna: 'energia_mwh', floor: MIN_GENERATION_MWH, motivo: MOTIVO_GEN + NOTA_HORA }],
  },
  {
    tabla: 'generacion_acumulado', pk: null, periodOut: 'deleted.hora + 1', periodSel: 'hora + 1',
    cols: [{ columna: 'energia_mwh', floor: MIN_GENERATION_MWH, motivo: MOTIVO_GEN + NOTA_HORA }],
  },
  {
    tabla: 'desviacion_periodos', pk: 'id', periodOut: 'deleted.periodo', periodSel: 'periodo',
    cols: [
      { columna: 'generacion_mwh', floor: MIN_GENERATION_MWH, motivo: MOTIVO_GEN },
      { columna: 'desviacion_pct', floor: MIN_DEVIATION_PCT, motivo: MOTIVO_DEV },
    ],
    recalcDesviacion: true,
  },
  {
    tabla: 'proyeccion_periodos', pk: 'id', periodOut: 'deleted.periodo', periodSel: 'periodo',
    cols: [
      { columna: 'proyeccion_cierre_mwh', floor: MIN_GENERATION_MWH, motivo: MOTIVO_GEN },
      { columna: 'generacion_real_mwh', floor: MIN_GENERATION_MWH, motivo: MOTIVO_GEN },
      { columna: 'desviacion_pct', floor: MIN_DEVIATION_PCT, motivo: MOTIVO_DEV },
    ],
  },
  {
    tabla: 'proyeccion_actual', pk: null, periodOut: 'deleted.periodo', periodSel: 'periodo',
    cols: [
      { columna: 'acumulado_mwh', floor: MIN_GENERATION_MWH, motivo: MOTIVO_GEN },
      { columna: 'proyeccion_mwh', floor: MIN_GENERATION_MWH, motivo: MOTIVO_GEN },
      { columna: 'current_mw', floor: MIN_GENERATION_MWH, motivo: MOTIVO_GEN },
      { columna: 'desviacion_pct', floor: MIN_DEVIATION_PCT, motivo: MOTIVO_DEV },
    ],
  },
  {
    tabla: 'proyeccion_historico', pk: 'id', periodOut: 'deleted.periodo', periodSel: 'periodo',
    cols: [
      { columna: 'acumulado_mwh', floor: MIN_GENERATION_MWH, motivo: MOTIVO_GEN },
      { columna: 'proyeccion_mwh', floor: MIN_GENERATION_MWH, motivo: MOTIVO_GEN },
      { columna: 'current_mw', floor: MIN_GENERATION_MWH, motivo: MOTIVO_GEN },
      { columna: 'desviacion_pct', floor: MIN_DEVIATION_PCT, motivo: MOTIVO_DEV },
    ],
  },
]

const AUDIT_COLS = '(tabla, pk_id, unit_id, fecha, periodo, columna, valor_antes, valor_despues, motivo)'
const fmt = (v, d = 6) => (v == null ? 'NULL' : Number(v).toFixed(d))
const fecha = (v) => (v == null ? '—' : new Date(v).toISOString().slice(0, 10))

async function ensureAuditTable(db) {
  await db.request().query(`
    IF OBJECT_ID('dashboard.correccion_d125', 'U') IS NULL
    CREATE TABLE dashboard.correccion_d125 (
      id            INT IDENTITY(1,1) PRIMARY KEY,
      tabla         VARCHAR(50)   NOT NULL,
      pk_id         INT           NULL,
      unit_id       VARCHAR(10)   NULL,
      fecha         DATE          NULL,
      periodo       TINYINT       NULL,
      columna       VARCHAR(50)   NOT NULL,
      valor_antes   FLOAT         NULL,
      valor_despues FLOAT         NULL,
      motivo        VARCHAR(200)  NOT NULL,
      aplicado_en   DATETIME2     NOT NULL DEFAULT GETDATE()
    );
  `)
  await db.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_correccion_d125_tabla' AND object_id = OBJECT_ID('dashboard.correccion_d125'))
      CREATE INDEX IX_correccion_d125_tabla ON dashboard.correccion_d125 (tabla, columna, aplicado_en);
  `)
}

// ── Dry-run: mismas condiciones que los UPDATE, sin escribir ────────────────────

async function previewColumn(db, { tabla, periodSel }, { columna, floor }) {
  const { recordset: [agg] } = await db.request().query(`
    SELECT COUNT(*) AS filas, MIN(${columna}) AS peor
    FROM dashboard.${tabla} WHERE ${columna} < ${floor}
  `)
  if (!agg?.filas) return { filas: 0, peor: null, muestra: [] }
  const { recordset: muestra } = await db.request().query(`
    SELECT TOP ${SAMPLE} unit_id, fecha, ${periodSel} AS periodo, ${columna} AS valor
    FROM dashboard.${tabla} WHERE ${columna} < ${floor} ORDER BY ${columna} ASC
  `)
  return { filas: agg.filas, peor: agg.peor, muestra }
}

// Filas de desviacion_periodos cuya desviación quedaría incoherente tras llevar la
// generación a 0: se recalcula desde desp_final_mw, que es el denominador REAL que usó
// computeClosed (venga de despacho_final o del fallback rDEC).
async function previewRecalc(db) {
  const { recordset: [agg] } = await db.request().query(`
    SELECT COUNT(*) AS filas FROM dashboard.desviacion_periodos d
    WHERE d.generacion_mwh < ${MIN_GENERATION_MWH}
      AND ${distintoDelObjetivo(DEV_POST_CLAMP)}
  `)
  if (!agg?.filas) return { filas: 0, muestra: [] }
  const { recordset: muestra } = await db.request().query(`
    SELECT TOP ${SAMPLE} d.unit_id, d.fecha, d.periodo, d.desp_final_mw,
           ${DEV_POST_CLAMP} AS desviacion_pct, ${OBJETIVO} AS objetivo
    FROM dashboard.desviacion_periodos d
    WHERE d.generacion_mwh < ${MIN_GENERATION_MWH} AND ${distintoDelObjetivo(DEV_POST_CLAMP)}
    ORDER BY d.fecha DESC, d.unit_id, d.periodo
  `)
  return { filas: agg.filas, muestra }
}

const OBJETIVO = `CASE WHEN d.desp_final_mw IS NOT NULL AND d.desp_final_mw > 0 THEN ${MIN_DEVIATION_PCT} ELSE NULL END`
// El recálculo corre DESPUÉS del clamp de desviacion_pct, así que el dry-run tiene que
// comparar contra el valor ya clampado. Si no, predice como "a recalcular" las mismas celdas
// que el clamp ya dejó en -100 y los números del dry-run no cuadran con los del --apply.
const DEV_POST_CLAMP = `CASE WHEN d.desviacion_pct < ${MIN_DEVIATION_PCT} THEN ${MIN_DEVIATION_PCT} ELSE d.desviacion_pct END`
const distintoDelObjetivo = (dev) => `(
     (${dev} IS NULL     AND ${OBJETIVO} IS NOT NULL)
  OR (${dev} IS NOT NULL AND ${OBJETIVO} IS NULL)
  OR (${dev} <> ${OBJETIVO})
)`

// ── Apply ──────────────────────────────────────────────────────────────────────

// Un solo UPDATE ... OUTPUT ... INTO por columna: la fila de auditoría con el valor original
// y la corrección son la MISMA sentencia, así que es imposible sobrescribir sin dejar rastro
// y no hay ventana de carrera con el servidor vivo (que escribe generacion_acumulado y
// proyeccion_actual mientras esto corre).
function clampStatement({ tabla, pk, periodOut }, { columna, floor, motivo }) {
  const pkExpr = pk ? `deleted.${pk}` : 'CAST(NULL AS INT)'
  return `
    UPDATE TOP (${BATCH}) dashboard.${tabla}
    SET ${columna} = ${floor}
    OUTPUT '${tabla}', ${pkExpr}, deleted.unit_id, deleted.fecha, ${periodOut},
           '${columna}', deleted.${columna}, inserted.${columna}, '${motivo.replace(/'/g, "''")}'
    INTO dashboard.correccion_d125 ${AUDIT_COLS}
    WHERE ${columna} < ${floor}
  `
}

function recalcStatement() {
  return `
    WITH afectadas AS (
      SELECT d.id, d.unit_id, d.fecha, d.periodo, d.desviacion_pct,
             ${OBJETIVO} AS objetivo
      FROM dashboard.desviacion_periodos d
      WHERE d.generacion_mwh = ${MIN_GENERATION_MWH}
        AND EXISTS (
          SELECT 1 FROM dashboard.correccion_d125 c
          WHERE c.tabla = 'desviacion_periodos' AND c.columna = 'generacion_mwh'
            AND c.pk_id = d.id AND c.aplicado_en >= @inicio
        )
    )
    UPDATE afectadas
    SET desviacion_pct = objetivo
    OUTPUT 'desviacion_periodos', deleted.id, deleted.unit_id, deleted.fecha, deleted.periodo,
           'desviacion_pct', deleted.desviacion_pct, inserted.desviacion_pct, '${MOTIVO_RECALC.replace(/'/g, "''")}'
    INTO dashboard.correccion_d125 ${AUDIT_COLS}
    WHERE (desviacion_pct IS NULL     AND objetivo IS NOT NULL)
       OR (desviacion_pct IS NOT NULL AND objetivo IS NULL)
       OR (desviacion_pct <> objetivo)
  `
}

async function applyTable(db, spec, inicio) {
  const resultados = []
  try {
    for (const col of spec.cols) {
      // Lotes de BATCH filas en autocommit. Cada UPDATE ... OUTPUT es atómico por sí solo, así
      // que la garantía de auditoría no depende de una transacción explícita; partir en lotes
      // evita una transacción gigante (proyeccion_historico tiene ~160k celdas a corregir)
      // que inflaría el log y bloquearía al servidor vivo, que escribe estas mismas tablas.
      let filas = 0
      for (;;) {
        const r = await db.request().query(clampStatement(spec, col))
        const n = r.rowsAffected[0] ?? 0
        filas += n
        if (n < BATCH) break
      }
      resultados.push({ columna: col.columna, filas })
    }
    if (spec.recalcDesviacion) {
      const req = db.request()
      req.input('inicio', sql.DateTime2, inicio)
      const r = await req.query(recalcStatement())
      resultados.push({ columna: 'desviacion_pct (recálculo)', filas: r.rowsAffected[0] ?? 0 })
    }
  } catch (err) {
    throw new Error(`${spec.tabla}: ${err?.message ?? err}`)
  }
  return resultados
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const db = await getDB()
  const dbName = process.env.DB_NAME ?? '(sin DB_NAME)'
  const host = process.env.DB_HOST ?? '(sin DB_HOST)'

  console.log(`\n=== Backfill D-125 — ${APPLY ? 'APPLY (escribe)' : 'DRY-RUN (no escribe nada)'} ===`)
  console.log(`BD: ${dbName} @ ${host}`)
  console.log(`Pisos: generación >= ${MIN_GENERATION_MWH} · desviación >= ${MIN_DEVIATION_PCT}\n`)

  let total = 0

  if (!APPLY) {
    for (const spec of TABLES) {
      let filasTabla = 0
      const lineas = []
      for (const col of spec.cols) {
        const { filas, peor, muestra } = await previewColumn(db, spec, col)
        if (!filas) continue
        filasTabla += filas
        lineas.push(`    ${col.columna.padEnd(24)} ${String(filas).padStart(6)} celdas  peor=${fmt(peor)} → ${col.floor}`)
        for (const m of muestra) {
          lineas.push(`        ${m.unit_id.padEnd(6)} ${fecha(m.fecha)} p${String(m.periodo).padStart(2)}  ${fmt(m.valor)} → ${col.floor}`)
        }
      }
      if (spec.recalcDesviacion) {
        const { filas, muestra } = await previewRecalc(db)
        if (filas) {
          filasTabla += filas
          lineas.push(`    desviacion_pct (recálculo) ${String(filas).padStart(4)} celdas  desde desp_final_mw`)
          for (const m of muestra) {
            lineas.push(`        ${m.unit_id.padEnd(6)} ${fecha(m.fecha)} p${String(m.periodo).padStart(2)}  ` +
              `${fmt(m.desviacion_pct, 2)} → ${m.objetivo == null ? 'NULL' : fmt(m.objetivo, 2)}  (desp_final=${fmt(m.desp_final_mw, 2)})`)
          }
        }
      }
      total += filasTabla
      if (filasTabla === 0) console.log(`✔ ${spec.tabla.padEnd(22)} nada que corregir`)
      else {
        console.log(`• ${spec.tabla.padEnd(22)} ${filasTabla} celda(s) a corregir`)
        console.log(lineas.join('\n'))
      }
    }
    console.log(`\nTotal de celdas que se corregirían: ${total}`)
    console.log('Nada fue escrito. Volvé a correr con --apply para aplicar.')
    await db.close()
    return
  }

  // --apply
  await ensureAuditTable(db)
  // Marca de inicio tomada del reloj del SERVIDOR SQL, no del cliente: el recálculo de
  // desviacion_periodos filtra la auditoría de esta corrida con `aplicado_en >= @inicio`.
  const { recordset: [{ ahora }] } = await db.request().query('SELECT GETDATE() AS ahora')

  for (const spec of TABLES) {
    const resultados = await applyTable(db, spec, ahora)
    const filasTabla = resultados.reduce((s, r) => s + r.filas, 0)
    total += filasTabla
    if (filasTabla === 0) { console.log(`✔ ${spec.tabla.padEnd(22)} nada que corregir`); continue }
    console.log(`• ${spec.tabla.padEnd(22)} ${filasTabla} celda(s) corregidas`)
    for (const r of resultados) {
      if (r.filas) console.log(`    ${r.columna.padEnd(26)} ${String(r.filas).padStart(6)} celdas`)
    }
  }

  console.log(`\nTotal de celdas corregidas: ${total}`)
  console.log('Rastro completo en dashboard.correccion_d125 (valor_antes / valor_despues por celda).')
  console.log('Siguiente paso: scripts/verify-invariants.js debe salir con 0 violaciones.')
  await db.close()
}

main().catch((err) => {
  console.error('[backfill-d125] error:', err?.message ?? err)
  process.exit(1)
})
