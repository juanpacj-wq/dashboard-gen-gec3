/**
 * Servicio de redespacho diario XM
 * Descarga rDECMMDD.txt del portal XM, lo parsea y expone los 24 valores horarios por unidad.
 */

const API_BASE = 'https://api-portalxm.xm.com.co/administracion-archivos/ficheros/mostrar-url'
const BLOB_CONTAINER = 'storageportalxm'

const PLANT_CODE_MAP = {
  'GECELCA 3':  'GEC3',
  'GECELCA 32': 'GE32',
  'GUAJIRA 1':  'TGJ1',
  'GUAJIRA 2':  'TGJ2',
}

// Código XM → unitId interno del dashboard
const CODE_TO_UNIT = { GEC3: 'GEC3', GE32: 'GEC32', TGJ1: 'TGJ1', TGJ2: 'TGJ2' }
const HOUR_KEYS = Array.from({ length: 24 }, (_, i) => `Hour${String(i + 1).padStart(2, '0')}`)

// ── Helpers del scraper ──────────────────────────────────────────────────────

function getColombiaDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }))
}

function buildFilePath() {
  const now = getColombiaDate()
  const yyyy = now.getFullYear()
  const mm   = String(now.getMonth() + 1).padStart(2, '0')
  const dd   = String(now.getDate()).padStart(2, '0')
  return `M:/InformacionAgentes/Usuarios/Publico/Redespacho/${yyyy}-${mm}/rDEC${mm}${dd}.txt`
}

function formatValue(num) {
  return num.toFixed(3).replace('.', ',')
}

function parseLine(line) {
  const match = line.match(/^"([^"]+)",\s*(.+)$/)
  if (!match) return null
  const plantName = match[1].trim()
  const values = match[2].split(',').map(v => parseFloat(v.trim()))
  return { plantName, values }
}

function buildEmptyItems() {
  return Object.values(PLANT_CODE_MAP).map(code => {
    const hourValues = { code }
    for (let i = 0; i < 24; i++) {
      hourValues[`Hour${String(i + 1).padStart(2, '0')}`] = '0,000'
    }
    return { HourlyEntities: [{ Values: hourValues }] }
  })
}

async function downloadFile(ruta) {
  const url = `${API_BASE}?ruta=${encodeURIComponent(ruta)}&nombreBlobContainer=${BLOB_CONTAINER}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} al consultar la API`)

  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const json = await response.json()
    const fileUrl = typeof json === 'string' ? json : (json.url || json.sasUrl || json)
    const fileResponse = await fetch(fileUrl)
    if (!fileResponse.ok) throw new Error(`HTTP ${fileResponse.status} al descargar el archivo`)
    return fileResponse.text()
  }
  return response.text()
}

async function scrapeRedespacho() {
  const ruta = buildFilePath()
  console.log(`[RedespScraper] Consultando: ${ruta}`)

  let content
  try {
    content = await downloadFile(ruta)
  } catch (err) {
    console.warn(`[RedespScraper] Archivo no disponible (${err.message}), asignando 0 a todas las horas.`)
    return { Items: buildEmptyItems() }
  }

  const items = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const parsed = parseLine(line)
    if (!parsed) continue
    const code = PLANT_CODE_MAP[parsed.plantName]
    if (!code) continue
    const hourValues = { code }
    for (let i = 0; i < 24; i++) {
      const key = `Hour${String(i + 1).padStart(2, '0')}`
      hourValues[key] = i < parsed.values.length ? formatValue(parsed.values[i]) : ''
    }
    items.push({ HourlyEntities: [{ Values: hourValues }] })
  }

  return { Items: items }
}

// ── Convierte Items[] → { GEC3: [24 MW], GEC32: [24 MW], TGJ1: [24 MW], TGJ2: [24 MW] } ──

function parseItems(items) {
  const result = {
    GEC3:  Array(24).fill(0),
    GEC32: Array(24).fill(0),
    TGJ1:  Array(24).fill(0),
    TGJ2:  Array(24).fill(0),
  }
  for (const item of items) {
    const vals = item.HourlyEntities?.[0]?.Values
    if (!vals) continue
    const code = (vals.code || '').trim()
    const unitId = CODE_TO_UNIT[code]
    if (!unitId) continue
    result[unitId] = HOUR_KEYS.map(k => {
      const raw = vals[k]
      if (!raw || raw === '') return 0
      return Math.round(parseFloat(raw.replace(',', '.')) * 10) / 10
    })
  }
  return result
}

// ── Servicio ────────────────────────────────────────────────────────────────

export class RedespachoscraperService {
  #cache = null
  #interval = null

  async init() {
    await this.#refresh()
  }

  start() {
    this.#interval = setInterval(() => {
      this.#refresh().catch(e => console.error('[RedespScraper] Error en ciclo:', e.message))
    }, 60 * 60 * 1000) // refresca cada hora
    console.log('[RedespScraper] Servicio iniciado — intervalo 1h')
  }

  stop() {
    if (this.#interval) clearInterval(this.#interval)
    this.#interval = null
  }

  getState() {
    return this.#cache
  }

  async #refresh() {
    const raw = await scrapeRedespacho()
    this.#cache = parseItems(raw.Items)
    console.log(`[RedespScraper] Datos cargados: ${Object.keys(this.#cache).join(', ')}`)
  }
}
