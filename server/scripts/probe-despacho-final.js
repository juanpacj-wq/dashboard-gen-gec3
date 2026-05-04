#!/usr/bin/env node
// Probe standalone — dump dashboard.despacho_final rows for today (Bogotá) y
// agrupa conteo por unidad+source. Útil para diagnosticar divergencias entre
// lo que muestra el dashboard y lo que realmente está persistido en DB.
//
// Uso (desde server/):
//   node --env-file=../.env scripts/probe-despacho-final.js
//   node --env-file=../.env scripts/probe-despacho-final.js 2026-05-04
import sql from 'mssql'

const cfg = {
  server: process.env.DB_HOST.split('\\')[0],
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    instanceName: process.env.DB_HOST.includes('\\') ? process.env.DB_HOST.split('\\')[1] : undefined,
    trustServerCertificate: true,
    encrypt: false,
  },
}

const pool = await sql.connect(cfg)

const today = process.argv[2] || new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10)
console.log('--- despacho_final rows for', today, '---')
const r1 = await pool.request()
  .input('fecha', sql.Date, today)
  .query(`SELECT * FROM dashboard.despacho_final
          WHERE fecha = @fecha AND unit_id IN ('TGJ1','TGJ2','GEC3','GEC32')
          ORDER BY unit_id, periodo`)
for (const row of r1.recordset) {
  const cols = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))
  console.log(JSON.stringify(cols))
}

console.log('--- count by unit ---')
const r2 = await pool.request()
  .input('fecha', sql.Date, today)
  .query(`SELECT unit_id, source, COUNT(*) as cnt FROM dashboard.despacho_final
          WHERE fecha = @fecha GROUP BY unit_id, source ORDER BY unit_id, source`)
for (const row of r2.recordset) console.log(`${row.unit_id} ${row.source} = ${row.cnt}`)

console.log('--- columns of dashboard.despacho_final ---')
const r3 = await pool.request().query(`SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dashboard' AND TABLE_NAME='despacho_final'`)
for (const row of r3.recordset) console.log(`  ${row.COLUMN_NAME}: ${row.DATA_TYPE}`)

await pool.close()
