/**
 * Servicio de redespacho diario XM
 * Descarga rDECMMDD.txt del portal XM, lo parsea y expone los 24 valores horarios por unidad.
 * Persiste en dashboard.redespacho_programado con auditoría de cambios en redespacho_historico.
 * También expone datos nacionales (todas las plantas) para el ticker.
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { saveRedespachoProgBulk, loadRedespachoProg } from './db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
    return { Items: buildEmptyItems(), rawContent: null }
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

  return { Items: items, rawContent: content }
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

// ── Mapeo nacional: nombre planta → código XM ──────────────────────────────

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
    console.log(`[RedespScraper] Mapa de plantas cargado: ${Object.keys(map).length} entradas`)
    return map
  } catch (e) {
    console.warn('[RedespScraper] No se pudo cargar mapa de plantas:', e.message)
    return {}
  }
}

const NATIONAL_PLANT_MAP = loadPlantNameMap()

function parseAllPlants(content) {
  const plants = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const parsed = parseLine(line)
    if (!parsed) continue
    const normalizedName = parsed.plantName.toUpperCase().replace(/\s+/g, '')
    if (normalizedName === 'TOTAL') continue
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

const REFRESH_MS = 5 * 60 * 1000 // 5 minutos

export class RedespachoscraperService {
  #cache = null
  #nationalCache = null
  #interval = null
  #dbAvailable = false

  async init(dbAvailable = false) {
    this.#dbAvailable = dbAvailable
    // Intentar cargar desde DB primero (recuperación post-reinicio)
    if (this.#dbAvailable) {
      const todayStr = getColombiaDate().toISOString().slice(0, 10)
      try {
        const cached = await loadRedespachoProg(todayStr)
        if (cached) {
          this.#cache = cached
          console.log(`[RedespScraper] Datos de ${todayStr} cargados desde DB`)
        }
      } catch (e) {
        console.warn('[RedespScraper] Error leyendo DB:', e.message)
      }
    }
    await this.#refresh()
  }

  start() {
    this.#interval = setInterval(() => {
      this.#refresh().catch(e => console.error('[RedespScraper] Error en ciclo:', e.message))
    }, REFRESH_MS)
    console.log(`[RedespScraper] Servicio iniciado — intervalo ${REFRESH_MS / 1000}s`)
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
    const raw = await scrapeRedespacho()
    this.#cache = parseItems(raw.Items)

    // Parsear todas las plantas para el ticker nacional
    if (raw.rawContent) {
      this.#nationalCache = parseAllPlants(raw.rawContent)
      console.log(`[RedespScraper] Datos cargados: ${Object.keys(this.#cache).join(', ')} | ${this.#nationalCache.length} plantas nacionales`)
    } else {
      console.log(`[RedespScraper] Datos cargados: ${Object.keys(this.#cache).join(', ')} | sin datos nacionales`)
    }

    // Persistir en DB (detecta cambios y audita automáticamente)
    if (this.#dbAvailable) {
      const todayStr = getColombiaDate().toISOString().slice(0, 10)
      try {
        await saveRedespachoProgBulk(todayStr, this.#cache)
      } catch (e) {
        console.error('[RedespScraper] Error guardando en DB:', e.message)
      }
    }
  }
}
