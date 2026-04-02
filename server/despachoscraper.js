/**
 * Servicio de despacho diario XM
 * Descarga dDECMMDD_TIES.txt del portal XM, lo parsea y expone los 24 valores horarios por unidad.
 * Persiste en dashboard.despacho_programado (una sola escritura por día).
 * También expone datos nacionales (todas las plantas) para el ticker.
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { saveDespachoProgBulk, loadDespachoProg } from './db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const API_BASE = 'https://api-portalxm.xm.com.co/administracion-archivos/ficheros/mostrar-url'
const BLOB_CONTAINER = 'storageportalxm'

// Gecelca units filter
const PLANT_CODE_MAP = {
  'GECELCA 3':  'GEC3',
  'GECELCA 32': 'GE32',
  'GUAJIRA 1':  'TGJ1',
  'GUAJIRA 2':  'TGJ2',
}

// Codigo XM → unitId interno del dashboard
const CODE_TO_UNIT = { GEC3: 'GEC3', GE32: 'GEC32', TGJ1: 'TGJ1', TGJ2: 'TGJ2' }
const HOUR_KEYS = Array.from({ length: 24 }, (_, i) => `Hour${String(i + 1).padStart(2, '0')}`)

// ── Mapeo nacional: nombre planta → código XM ──────────────────────────────
// Carga "Nombre unidades y su código.json" y construye un mapa normalizado
function loadPlantNameMap() {
  try {
    const raw = JSON.parse(readFileSync(join(__dirname, '..', 'Nombre_unidades_y_su_código.json'), 'utf-8'))
    const arr = raw[Object.keys(raw)[0]] || []
    const map = {}
    for (const e of arr) {
      if (!e.recurso_ofei || !e.codsic_planta) continue
      const key = e.recurso_ofei.trim().toUpperCase().replace(/\s+/g, '')
      map[key] = { code: e.codsic_planta.trim(), name: e.recurso_ofei.trim() }
    }
    console.log(`[DespScraper] Mapa de plantas cargado: ${Object.keys(map).length} entradas`)
    return map
  } catch (e) {
    console.warn('[DespScraper] No se pudo cargar mapa de plantas:', e.message)
    return {}
  }
}

const NATIONAL_PLANT_MAP = loadPlantNameMap()

// ── Helpers ─────────────────────────────────────────────────────────────────

function getColombiaDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }))
}

function buildFilePath() {
  const now = getColombiaDate()
  const yyyy = now.getFullYear()
  const mm   = String(now.getMonth() + 1).padStart(2, '0')
  const dd   = String(now.getDate()).padStart(2, '0')
  return `Energia y Mercado/DESPACHO/TIES/Despachos/${yyyy}-${mm}/dDEC${mm}${dd}_TIES.txt`
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

// Returns { found: boolean, Items: [...], rawContent: string|null }
async function scrapeDespacho() {
  const ruta = buildFilePath()
  console.log(`[DespScraper] Consultando: ${ruta}`)

  let content
  try {
    content = await downloadFile(ruta)
  } catch (err) {
    console.warn(`[DespScraper] Archivo no disponible (${err.message}), asignando 0 a todas las horas.`)
    return { found: false, Items: buildEmptyItems(), rawContent: null }
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

  return { found: items.length > 0, Items: items, rawContent: content }
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

// ── Parsea TODAS las plantas del archivo para el ticker nacional ────────────

function parseAllPlants(content) {
  const plants = [] // [{ code, name, values: [24 MW] }]
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const parsed = parseLine(line)
    if (!parsed) continue

    // Normalizar nombre para buscar en el mapa
    const normalizedName = parsed.plantName.toUpperCase().replace(/\s+/g, '')
    const mapping = NATIONAL_PLANT_MAP[normalizedName]
    const code = mapping?.code || normalizedName
    const name = parsed.plantName

    const values = Array.from({ length: 24 }, (_, i) =>
      i < parsed.values.length ? Math.round(parsed.values[i] * 10) / 10 : 0
    )

    plants.push({ code, name, values })
  }
  return plants
}

// ── Servicio ────────────────────────────────────────────────────────────────

const RETRY_MS = 5 * 60 * 1000 // 5 minutos entre reintentos

export class DespachoscraperService {
  #cache = null
  #nationalCache = null // [{ code, name, values: [24 MW] }] — todas las plantas
  #interval = null
  #found = false
  #dateLoaded = null // fecha (YYYY-MM-DD) del archivo cargado
  #dbAvailable = false

  async init(dbAvailable = false) {
    this.#dbAvailable = dbAvailable
    // Intentar cargar desde DB primero (recuperación post-reinicio)
    if (this.#dbAvailable) {
      const todayStr = getColombiaDate().toISOString().slice(0, 10)
      try {
        const cached = await loadDespachoProg(todayStr)
        if (cached) {
          this.#cache = cached
          this.#found = true
          this.#dateLoaded = todayStr
          console.log(`[DespScraper] Datos de ${todayStr} cargados desde DB`)
          return
        }
      } catch (e) {
        console.warn('[DespScraper] Error leyendo DB, continuando con scraper:', e.message)
      }
    }
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

  /** Returns all plants for the national ticker: [{ code, name, values: [24 MW] }] */
  getNational() {
    return this.#nationalCache
  }

  async #refresh() {
    const now = getColombiaDate()
    const todayStr = now.toISOString().slice(0, 10)

    // Si ya se encontró el archivo de hoy, no volver a consultar
    if (this.#found && this.#dateLoaded === todayStr) return

    // Nuevo día → resetear estado, intentar cargar desde DB
    if (this.#dateLoaded !== todayStr) {
      this.#found = false
      this.#dateLoaded = todayStr
      this.#nationalCache = null
      console.log(`[DespScraper] Nuevo día ${todayStr} — buscando archivo de despacho`)

      if (this.#dbAvailable) {
        try {
          const cached = await loadDespachoProg(todayStr)
          if (cached) {
            this.#cache = cached
            this.#found = true
            console.log(`[DespScraper] Datos de ${todayStr} cargados desde DB (sin datos nacionales hasta próximo fetch)`)
            // No retornar — continuar al scraper para obtener datos nacionales
          }
        } catch { /* fall through to scraper */ }
      }
    }

    const raw = await scrapeDespacho()
    this.#cache = parseItems(raw.Items)

    if (raw.found) {
      this.#found = true
      // Parsear todas las plantas para el ticker
      if (raw.rawContent) {
        this.#nationalCache = parseAllPlants(raw.rawContent)
        console.log(`[DespScraper] Archivo cargado para ${todayStr}: ${this.#nationalCache.length} plantas nacionales`)
      }
      // Persistir en DB
      if (this.#dbAvailable) {
        try {
          await saveDespachoProgBulk(todayStr, this.#cache)
          console.log(`[DespScraper] Datos persistidos en DB para ${todayStr}`)
        } catch (e) {
          console.error('[DespScraper] Error guardando en DB:', e.message)
        }
      }
    } else {
      console.log(`[DespScraper] Archivo no disponible aún para ${todayStr}, reintentando en ${RETRY_MS / 1000}s...`)
    }
  }
}
