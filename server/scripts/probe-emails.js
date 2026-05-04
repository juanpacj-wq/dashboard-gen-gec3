#!/usr/bin/env node
// Probe standalone — consulta Graph API directamente con varios filtros para
// determinar si emails de un periodo específico realmente no existen, o si
// están siendo descartados por el filtro que usa el server.
//
// Uso (desde server/):
//   node --env-file=../.env scripts/probe-emails.js              # hoy Bogotá
//   node --env-file=../.env scripts/probe-emails.js 04/05/2026   # fecha específica DD/MM/YYYY
//
// Imprime, en orden:
//   1) Resultado del filtro EXACTO que usa server.js (production behavior).
//   2) Mismo filtro de subject sin restricción de fecha (revela si la fecha está cortando).
//   3) Búsqueda específica de "Periodo 2" y "Periodo 3" del día en cuestión.
//   4) TODOS los correos recibidos en el rango UTC del día (caza variantes con subject distinto).
//   5) Resumen: qué periodos sí existen y cuáles faltan para esa fecha.

const TENANT = process.env.GRAPH_TENANT_ID
const CLIENT = process.env.GRAPH_CLIENT_ID
const SECRET = process.env.GRAPH_CLIENT_SECRET
const MAILBOX = process.env.GRAPH_MAILBOX
const MAILBOXTEG = process.env.GRAPH_MAILBOXTEG

if (!TENANT || !CLIENT || !SECRET || !MAILBOX) {
  console.error('Missing GRAPH_* env vars (TENANT/CLIENT/SECRET/MAILBOX)')
  process.exit(1)
}

const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`

async function getToken() {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT,
      client_secret: SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }),
  })
  if (!res.ok) throw new Error(`Token error: ${res.status} ${await res.text()}`)
  const json = await res.json()
  return json.access_token
}

async function listEmails(token, mailbox, filter, top = 200) {
  // OJO: $orderby=receivedDateTime combinado con contains() dispara
  // InefficientFilter en Graph. server.js no lo usa, así que lo evitamos
  // acá para igualar el comportamiento de producción.
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages?$filter=${encodeURIComponent(filter)}&$select=id,subject,receivedDateTime,bodyPreview&$top=${top}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    console.error(`  ! filter failed (${res.status}):`, (await res.text()).slice(0, 200))
    return []
  }
  const json = await res.json()
  const list = json.value || []
  // Sort client-side por fecha desc para output consistente
  list.sort((a, b) => (b.receivedDateTime || '').localeCompare(a.receivedDateTime || ''))
  return list
}

const arg = process.argv[2]
let targetDate
if (arg) {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(arg)) {
    console.error(`Bad date format: "${arg}". Expected DD/MM/YYYY.`)
    process.exit(1)
  }
  targetDate = arg
} else {
  const col = new Date(Date.now() - 5 * 3600000)
  const d = String(col.getUTCDate()).padStart(2, '0')
  const m = String(col.getUTCMonth() + 1).padStart(2, '0')
  const y = col.getUTCFullYear()
  targetDate = `${d}/${m}/${y}`
}

const [dd, mm, yyyy] = targetDate.split('/')
const isoDate = `${yyyy}-${mm}-${dd}`
const startOfDayUTC = `${isoDate}T01:00:00Z`  // 8pm Bogotá día anterior — replica server.js
const utcMidnightStart = `${isoDate}T00:00:00Z`
const nextDay = new Date(Date.UTC(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd) + 1))
const utcMidnightEnd = nextDay.toISOString().slice(0, 11) + '00:00:00Z'

console.log(`\n=== Probe emails para fecha ${targetDate} (ISO ${isoDate}) ===`)
console.log(`Mailbox GRAPH_MAILBOX:    ${MAILBOX}`)
console.log(`Mailbox GRAPH_MAILBOXTEG: ${MAILBOXTEG ?? '(no configurado)'}\n`)

const token = await getToken()
const mailbox = MAILBOX  // ambos apuntan al mismo si MAILBOXTEG === MAILBOX, da igual cuál

// ── 1) Filtro EXACTO del server ─────────────────────────────────────────────
const f1 = `contains(subject,'Redespacho Periodo') and receivedDateTime ge ${startOfDayUTC}`
console.log(`[1] Filtro exacto del server`)
console.log(`    "${f1}"`)
const r1 = await listEmails(token, mailbox, f1)
console.log(`    → ${r1.length} emails:`)
for (const e of r1) console.log(`       - ${e.subject} | ${e.receivedDateTime}`)

// ── 2) Mismo subject filter, SIN restricción de fecha ───────────────────────
const f2 = `contains(subject,'Redespacho Periodo')`
console.log(`\n[2] Subject "Redespacho Periodo" sin restricción de fecha (top 200)`)
const r2 = await listEmails(token, mailbox, f2, 200)
const r2Today = r2.filter(e => (e.subject || '').includes(targetDate))
console.log(`    → ${r2.length} totales / ${r2Today.length} con "${targetDate}" en el subject:`)
for (const e of r2Today) console.log(`       - ${e.subject} | ${e.receivedDateTime}`)

// ── 3) Búsqueda específica de Periodo 2 y Periodo 3 ─────────────────────────
console.log(`\n[3a] Subject "Periodo 2 del" + "${targetDate}"`)
const f3a = `contains(subject,'Periodo 2 del') and contains(subject,'${targetDate}')`
const r3a = await listEmails(token, mailbox, f3a)
console.log(`    → ${r3a.length} emails:`)
for (const e of r3a) console.log(`       - ${e.subject} | ${e.receivedDateTime}`)

console.log(`\n[3b] Subject "Periodo 3 del" + "${targetDate}"`)
const f3b = `contains(subject,'Periodo 3 del') and contains(subject,'${targetDate}')`
const r3b = await listEmails(token, mailbox, f3b)
console.log(`    → ${r3b.length} emails:`)
for (const e of r3b) console.log(`       - ${e.subject} | ${e.receivedDateTime}`)

// ── 4) TODOS los emails en el rango UTC del día (caza variantes de subject) ─
console.log(`\n[4] TODOS los emails recibidos entre ${utcMidnightStart} y ${utcMidnightEnd} (top 500)`)
const f4 = `receivedDateTime ge ${utcMidnightStart} and receivedDateTime lt ${utcMidnightEnd}`
const r4 = await listEmails(token, mailbox, f4, 500)
const periodLike = r4.filter(e => /periodo\s*\d+/i.test(e.subject || ''))
const otherSuspicious = r4.filter(e => /redespacho|despacho|guajira|gecelca|tgj|gec/i.test(e.subject || '') && !periodLike.includes(e))
console.log(`    → ${r4.length} totales`)
console.log(`    → ${periodLike.length} mencionan "Periodo N" en subject:`)
for (const e of periodLike) console.log(`       - ${e.subject} | ${e.receivedDateTime}`)
if (otherSuspicious.length > 0) {
  console.log(`    → ${otherSuspicious.length} OTROS con palabras clave (revisar manualmente):`)
  for (const e of otherSuspicious.slice(0, 20)) console.log(`       - ${e.subject} | ${e.receivedDateTime}`)
}

// ── 5) Resumen ──────────────────────────────────────────────────────────────
// Construímos desde la unión de r1+r2+r4 para no perder nada por filtros que
// retornen distinto. Deduplicamos por id.
console.log(`\n=== Resumen para ${targetDate} ===`)
const SUBJECT_RE = /Periodo\s+(\d+)\s+del\s+d[ií]a\s+(\d{2}\/\d{2}\/\d{4})/i
const byPeriod = new Map()
const seen = new Set()
const allEmails = [...r1, ...r2, ...r4]
for (const e of allEmails) {
  if (seen.has(e.id)) continue
  seen.add(e.id)
  const subj = e.subject || ''
  const m = subj.match(SUBJECT_RE)
  if (m && m[2] === targetDate) {
    const p = parseInt(m[1], 10)
    if (!byPeriod.has(p)) byPeriod.set(p, [])
    byPeriod.get(p).push({ subject: subj, time: e.receivedDateTime })
  }
}
const found = [...byPeriod.keys()].sort((a, b) => a - b)
const missing = Array.from({ length: 24 }, (_, i) => i + 1).filter(p => !byPeriod.has(p))
console.log(`Periodos CON correo (subject "Periodo N del día ${targetDate}"): [${found.join(', ')}]`)
console.log(`Periodos SIN correo:                                              [${missing.join(', ')}]`)
console.log(`(${byPeriod.size}/24 periodos cubiertos)`)
console.log(`\nDetalle por periodo:`)
for (const p of found) {
  const list = byPeriod.get(p)
  console.log(`  P${String(p).padStart(2)}: ${list.length} email(s)`)
  for (const item of list) console.log(`        ${item.time}  ${item.subject}`)
}
