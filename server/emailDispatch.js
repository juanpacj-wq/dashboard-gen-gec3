import { saveDespachoFinal, getDespachoFinalByDate, existsDespachoFinal } from './db.js'

// ── Config ──────────────────────────────────────────────────────────────────
const TENANT   = process.env.GRAPH_TENANT_ID
const CLIENT   = process.env.GRAPH_CLIENT_ID
const SECRET   = process.env.GRAPH_CLIENT_SECRET
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`

const INTERVAL_MS = 5 * 60 * 1000  // 5 minutes
const SUBJECT_RE = /periodo\s+(\d+)\s+del\s+d[i\u00ed]a\s+(\d{2}\/\d{2}\/\d{4})/i

// ── Helpers ─────────────────────────────────────────────────────────────────
function colombiaTime() {
  const now = new Date()
  const col = new Date(now.getTime() - 5 * 3600000)
  const hour = col.getUTCHours()
  const minute = col.getUTCMinutes()
  const dateStr = col.toISOString().slice(0, 10)
  // Tomorrow date for period-24 edge case
  const tomorrow = new Date(col)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  const tomorrowStr = tomorrow.toISOString().slice(0, 10)
  return { hour, minute, dateStr, tomorrowStr }
}

/** Convert DD/MM/YYYY to YYYY-MM-DD */
function toISO(ddmmyyyy) {
  const [d, m, y] = ddmmyyyy.split('/')
  return `${y}-${m}-${d}`
}

// ── OAuth2 Token ────────────────────────────────────────────────────────────
let cachedToken = null
let tokenExpiresAt = 0

async function getGraphToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT,
    client_secret: SECRET,
    scope: 'https://graph.microsoft.com/.default',
  })

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`Token error: ${res.status} ${await res.text()}`)
  const json = await res.json()
  cachedToken = json.access_token
  tokenExpiresAt = Date.now() + (json.expires_in - 100) * 1000
  return cachedToken
}

// ── XM Fallback ─────────────────────────────────────────────────────────────
const XM_URL = 'https://servapibi.xm.com.co/hourly'
let xmCache = { date: null, byCode: null }

async function fetchXmRedespacho(dateStr, codeMap) {
  // Fetch raw data (cached per date, shared across instances)
  if (xmCache.date !== dateStr || !xmCache.byCode) {
    const res = await fetch(XM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        MetricId: 'GeneProgRedesp',
        StartDate: dateStr,
        EndDate: dateStr,
        Entity: 'Recurso',
        Filter: [],
      }),
    })
    if (!res.ok) throw new Error(`XM API error: ${res.status}`)
    const json = await res.json()
    const records = json?.Items || []

    const byCode = {}
    for (const item of records) {
      const vals = item.HourlyEntities?.[0]?.Values
      if (!vals) continue
      const code = (vals.code || '').trim()
      byCode[code] = Array.from({ length: 24 }, (_, i) => {
        const raw = vals[`Hour${String(i + 1).padStart(2, '0')}`]
        return raw != null && raw !== '' ? parseFloat(raw) / 1000 : 0
      })
    }
    xmCache = { date: dateStr, byCode }
  }

  // Apply codeMap transformation per caller
  const result = {}
  for (const [unitId, codes] of Object.entries(codeMap)) {
    const arrays = codes.map(c => xmCache.byCode[c]).filter(Boolean)
    if (arrays.length === 0) { result[unitId] = Array(24).fill(0); continue }
    result[unitId] = Array.from({ length: 24 }, (_, i) =>
      Math.round(arrays.reduce((s, a) => s + (a[i] || 0), 0) * 10) / 10
    )
  }
  return result
}

// ── Main Service ────────────────────────────────────────────────────────────
export class EmailDispatchService {
  #interval = null
  #state = {}
  #mailbox
  #unitsMap
  #xmCodeMap
  #unitIds
  // Sorted keys (longest first) for safe regex matching
  #unitKeys

  constructor({ mailbox, unitsMap, xmCodeMap, unitIds }) {
    this.#mailbox = mailbox
    this.#unitsMap = unitsMap
    this.#xmCodeMap = xmCodeMap
    this.#unitIds = unitIds
    // Sort keys by length descending to avoid partial matches (e.g. "GECELCA 3" matching before "GECELCA 32")
    this.#unitKeys = Object.keys(unitsMap).sort((a, b) => b.length - a.length)
  }

  async init() {
    await this.#loadState()
    console.log(`[EmailDispatch:${this.#unitIds}] Estado cargado desde DB`)
  }

  start() {
    this.fetchAndProcess().catch(e => console.error(`[EmailDispatch:${this.#unitIds}] Error inicial:`, e.message))
    this.#interval = setInterval(() => {
      this.fetchAndProcess().catch(e => console.error(`[EmailDispatch:${this.#unitIds}] Error en ciclo:`, e.message))
    }, INTERVAL_MS)
    console.log(`[EmailDispatch:${this.#unitIds}] Servicio iniciado — intervalo 5min`)
  }

  async stop() {
    if (this.#interval) clearInterval(this.#interval)
    this.#interval = null
  }

  getState() {
    return this.#state
  }

  // ── Private: fetch emails from configured mailbox ─────────────────────────
  async #fetchEmails(dateStr) {
    const token = await getGraphToken()
    const startOfDayUTC = `${dateStr}T01:00:00Z`
    const filter = `contains(subject,'Redespacho Periodo') and receivedDateTime ge ${startOfDayUTC}`
    const select = 'id,subject,body,receivedDateTime'
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.#mailbox)}/messages?$filter=${encodeURIComponent(filter)}&$select=${select}&$top=50`

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Graph API error: ${res.status} ${await res.text()}`)
    const json = await res.json()
    return json.value || []
  }

  // ── Private: parse a single email using configured unitsMap ────────────────
  #parseEmail(email) {
    const subject = email.subject || ''
    const match = subject.match(SUBJECT_RE)
    console.log('[Parse] Subject:', subject, '| Match:', match?.[0])
    if (!match) return null

    const periodo = parseInt(match[1], 10)
    const fechaISO = toISO(match[2])

    const htmlBody = email.body?.content || ''

    // Take content before CONF.ORIG
    const beforeConf = htmlBody.split(/CONF\.ORIG/i)[0]

    // Strip HTML to get table-like text, preserving row boundaries
    const rows = beforeConf
      .split(/<\/tr>/gi)
      .map(row => row
        .replace(/<\/td>/gi, '\t')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .trim()
      )
      .filter(Boolean)

    const results = []

    for (const row of rows) {
      // Check each unit key (sorted longest first to avoid partial matches)
      let plantName = null
      for (const key of this.#unitKeys) {
        const escaped = key.replace(/\s+/g, '\\s+')
        if (new RegExp(escaped + '(?!\\d)', 'i').test(row)) {
          plantName = key
          break
        }
      }
      if (!plantName) continue

      const unitId = this.#unitsMap[plantName]
      if (!unitId) continue

      // Skip greeting/intro rows (contain long text, not tabular data)
      // Real data rows are tab-separated with few fields; greeting rows have 5+ numbers (dates, etc.)
      const numbers = row.match(/(\d+\.?\d*)/g)
      console.log('[Row]', row.slice(0, 80), '→ numbers:', numbers)
      if (!numbers || numbers.length < 3 || numbers.length > 4) continue

      // numbers[0]=unit code, numbers[1]=despacho original, numbers[2]=redespacho (modified)
      const valorMw = parseFloat(numbers[2])
      if (isNaN(valorMw)) continue

      results.push({ unitId, periodo, fechaISO, valorMw })
    }
    console.log('[Parse] Resultado:', results)
    return results.length > 0
      ? { periodo, fechaISO, units: results, subject, emailId: email.id, emailDate: email.receivedDateTime }
      : null
  }

  // ── Private: load state from DB filtered by unitIds ───────────────────────
  async #loadState() {
    const { dateStr, tomorrowStr, hour } = colombiaTime()
    const datesToLoad = [dateStr]
    if (hour === 23) datesToLoad.push(tomorrowStr)

    this.#state = {}
    for (const fecha of datesToLoad) {
      const rows = await getDespachoFinalByDate(fecha)
      for (const row of rows) {
        if (!this.#unitIds.includes(row.unit_id)) continue
        if (!this.#state[row.unit_id]) this.#state[row.unit_id] = {}
        this.#state[row.unit_id][row.periodo] = {
          valor_mw: row.valor_mw,
          source: row.source,
        }
      }
    }
  }

  async fetchAndProcess() {
    if (!TENANT || !CLIENT || !SECRET || !this.#mailbox) {
      console.warn(`[EmailDispatch:${this.#unitIds}] Variables GRAPH_* no configuradas, omitiendo`)
      return
    }

    const { hour, minute, dateStr, tomorrowStr } = colombiaTime()
    const validDates = [dateStr]
    if (hour === 23) validDates.push(tomorrowStr)

    // 1. Fetch and parse emails
    let emails
    try {
      emails = await this.#fetchEmails(dateStr)
      console.log(`[EmailDispatch:${this.#unitIds}] ${emails.length} correos encontrados`)
      emails.forEach(e => console.log(' -', e.subject, '|', e.receivedDateTime))
    } catch (e) {
      console.error(`[EmailDispatch:${this.#unitIds}] Error leyendo correos:`, e.message)
      return
    }

    let saved = 0
    for (const email of emails) {
      const parsed = this.#parseEmail(email)
      if (!parsed) continue
      console.log(`[DEBUG] Parseado OK: P${parsed.periodo} fecha=${parsed.fechaISO} | validDates=${validDates}`)
      if (!validDates.includes(parsed.fechaISO)) {
        console.log(`[DEBUG] Descartado por fecha: ${parsed.fechaISO} no está en ${validDates}`)
        continue
      }

      for (const unit of parsed.units) {
        try {
          await saveDespachoFinal(
            unit.unitId, unit.fechaISO, unit.periodo, unit.valorMw,
            'email', parsed.subject, parsed.emailId, parsed.emailDate
          )
          saved++
        } catch (e) {
          console.error(`[EmailDispatch] Error guardando ${unit.unitId} P${unit.periodo}:`, e.message)
        }
      }
    }

    if (saved > 0) console.log(`[EmailDispatch:${this.#unitIds}] ${saved} registros guardados desde correos`)

    // 2. Fallback: at minute >= 55, fill missing next-period with XM redespacho
    if (minute >= 55) {
      await this.#applyFallbacks(hour, dateStr, tomorrowStr)
    }

    // 3. Reload state from DB
    await this.#loadState()
  }

  async #applyFallbacks(hour, dateStr, tomorrowStr) {
    // Current period = hour + 1, next period = hour + 2
    const nextPeriodo = hour + 2
    const targetDate = nextPeriodo <= 24 ? dateStr : tomorrowStr
    const targetPeriodo = nextPeriodo <= 24 ? nextPeriodo : 1

    let xmData
    try {
      xmData = await fetchXmRedespacho(targetDate, this.#xmCodeMap)
    } catch (e) {
      console.error(`[EmailDispatch:${this.#unitIds}] Error fetch XM fallback:`, e.message)
      return
    }

    for (const unitId of this.#unitIds) {
      try {
        const exists = await existsDespachoFinal(unitId, targetDate, targetPeriodo)
        if (exists) continue

        const xmValue = xmData[unitId]?.[targetPeriodo - 1] ?? 0
        if (xmValue === 0) continue

        await saveDespachoFinal(unitId, targetDate, targetPeriodo, xmValue, 'xm_fallback', null, null, null)
        console.log(`[EmailDispatch] Fallback XM: ${unitId} P${targetPeriodo} = ${xmValue} MW`)
      } catch (e) {
        console.error(`[EmailDispatch] Error fallback ${unitId} P${targetPeriodo}:`, e.message)
      }
    }
  }
}
