/**
 * Servicio de despacho diario XM
 * Descarga dDECMMDD_TIES.txt del portal XM, lo parsea y expone los 24 valores horarios por unidad.
 * Persiste en dashboard.despacho_programado (una sola escritura por día).
 */

import { saveDespachoProgBulk, loadDespachoProg } from './db.js'

const API_BASE = 'https://api-portalxm.xm.com.co/administracion-archivos/ficheros/mostrar-url'
const BLOB_CONTAINER = 'storageportalxm'

const PLANT_CODE_MAP = {
  'GECELCA 3':  'GEC3',
  'GECELCA 32': 'GE32',
  'GUAJIRA 1':  'TGJ1',
  'GUAJIRA 2':  'TGJ2',
}

// Codigo XM → unitId interno del dashboard
const CODE_TO_UNIT = { GEC3: 'GEC3', GE32: 'GEC32', TGJ1: 'TGJ1', TGJ2: 'TGJ2' }
const HOUR_KEYS = Array.from({ length: 24 }, (_, i) => `Hour${String(i + 1).padStart(2, '0')}`)

// ── Helpers ─────────────────────────────────────────────────────────────────

function getColombiaDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }))
}

function buildFilePathForDate(date) {
  const yyyy = date.getFullYear()
  const mm   = String(date.getMonth() + 1).padStart(2, '0')
  const dd   = String(date.getDate()).padStart(2, '0')
  return `Energia y Mercado/DESPACHO/TIES/Despachos/${yyyy}-${mm}/dDEC${mm}${dd}_TIES.txt`
}

function buildFilePath() {
  return buildFilePathForDate(getColombiaDate())
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

function getTomorrowColombiaDate() {
  const now = getColombiaDate()
  now.setDate(now.getDate() + 1)
  return now
}

// Returns { found: boolean, Items: [...] }
async function scrapeDespacho() {
  const ruta = buildFilePath()
  console.log(`[DespScraper] Consultando: ${ruta}`)

  let content
  try {
    content = await downloadFile(ruta)
  } catch (err) {
    console.warn(`[DespScraper] Archivo no disponible (${err.message}), asignando 0 a todas las horas.`)
    return { found: false, Items: buildEmptyItems() }
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

  return { found: items.length > 0, Items: items }
}

async function scrapeTomorrow() {
  const tomorrow = getTomorrowColombiaDate()
  const ruta = buildFilePathForDate(tomorrow)
  console.log(`[DespScraper] Consultando mañana: ${ruta}`)

  let content
  try {
    content = await downloadFile(ruta)
  } catch (err) {
    console.log(`[DespScraper] Archivo de mañana no disponible aún (${err.message})`)
    return { found: false, Items: buildEmptyItems() }
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

  return { found: items.length > 0, Items: items }
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

const RETRY_MS = 5 * 60 * 1000 // 5 minutos entre reintentos

export class DespachoscraperService {
  #cache = null
  #interval = null
  #found = false
  #dateLoaded = null // fecha (YYYY-MM-DD) del archivo cargado
  #dbAvailable = false
  #cacheTomorrow = null
  #foundTomorrow = false
  #dateTomorrow = null

  async init(dbAvailable = false) {
    this.#dbAvailable = dbAvailable
    // Siempre hacer scrape en init — la DB se usa como fallback dentro de #refresh
    await this.#refresh()
  }

  start() {
    this.#interval = setInterval(() => {
      this.#refresh().catch(e => console.error('[DespScraper] Error en ciclo:', e.message))
    }, RETRY_MS)
    console.log(`[DespScraper] Servicio iniciado — reintento cada ${RETRY_MS / 1000}s hasta encontrar archivo`)
  }

  stop() {
    if (this.#interval) clearInterval(this.#interval)
    this.#interval = null
  }

  getState() {
    return this.#cache
  }

  getStateTomorrow() {
    return this.#foundTomorrow ? this.#cacheTomorrow : null
  }

  async #refresh() {
    const now = getColombiaDate()
    const todayStr = now.toISOString().slice(0, 10)

    // ── Archivo de hoy ──
    if (!(this.#found && this.#dateLoaded === todayStr)) {
      // Nuevo día → resetear
      if (this.#dateLoaded !== todayStr) {
        this.#found = false
        this.#dateLoaded = todayStr
        console.log(`[DespScraper] Nuevo día ${todayStr} — buscando archivo de despacho`)
      }

      // 1. Intentar scraper (fuente primaria — siempre tiene las 4 unidades)
      const raw = await scrapeDespacho()

      if (raw.found) {
        this.#cache = parseItems(raw.Items)
        this.#found = true
        console.log(`[DespScraper] Archivo encontrado y cargado para ${todayStr}`)
        if (this.#dbAvailable) {
          try {
            await saveDespachoProgBulk(todayStr, this.#cache)
            console.log(`[DespScraper] Datos persistidos en DB para ${todayStr}`)
          } catch (e) {
            console.error('[DespScraper] Error guardando en DB:', e.message)
          }
        }
      } else {
        // 2. Scraper no encontró archivo → intentar DB como fallback
        if (this.#dbAvailable && !this.#cache) {
          try {
            const cached = await loadDespachoProg(todayStr)
            if (cached) {
              this.#cache = cached
              console.log(`[DespScraper] Datos de ${todayStr} cargados desde DB (fallback)`)
            }
          } catch { /* ignore */ }
        }

        // 3. Ni scraper ni DB → usar zeros de parseItems
        if (!this.#cache) {
          this.#cache = parseItems(raw.Items)
        }
        console.log(`[DespScraper] Archivo no disponible aún para ${todayStr}, reintentando en ${RETRY_MS / 1000}s...`)
      }
    }

    // ── Siempre intentar archivo de mañana ──
    await this.#refreshTomorrow()
  }

  async #refreshTomorrow() {
    const tomorrow = getTomorrowColombiaDate()
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}`

    // Nuevo día de "mañana" → resetear
    if (this.#dateTomorrow !== tomorrowStr) {
      this.#foundTomorrow = false
      this.#dateTomorrow = tomorrowStr
      this.#cacheTomorrow = null
    }

    if (this.#foundTomorrow) return

    const raw = await scrapeTomorrow()
    if (raw.found) {
      this.#cacheTomorrow = parseItems(raw.Items)
      this.#foundTomorrow = true
      console.log(`[DespScraper] Archivo de mañana encontrado para ${tomorrowStr}`)
    }
  }
}
