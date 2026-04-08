import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { PMEScraper } from './scraper.js'
import { UNITS, PME } from './config.js'
import {
  initDB,
  getTodayPeriods,
  saveProyeccionActual,
  loadProyeccionActual,
  saveDesviacionPeriodo,
  getTodayDesviacionPeriodos,
} from './db.js'
import { EnergyAccumulator } from './accumulator.js'
import { EmailDispatchService } from './emailDispatch.js'
import { RedespachoscraperService } from './redespachoscraper.js'
import { DespachoscraperService } from './despachoscraper.js'
import { computeLive, computeClosed } from './projectionCalculator.js'

const PORT = parseInt(process.env.WS_PORT, 10) || 3001

// Colombia (UTC-5) date/hour helpers
function colombiaNow(date = new Date()) {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60_000
  const col = new Date(utcMs - 5 * 3_600_000)
  return {
    hour: col.getHours(),
    period: col.getHours() + 1,
    dateStr: col.toISOString().slice(0, 10),
  }
}

// ── Services ──────────────────────────────────────────────────────────────────
const emailDispatch = new EmailDispatchService()
const redespScraper = new RedespachoscraperService()
const despScraper = new DespachoscraperService()

// Accumulator with closing-period callback that persists deviation history
const accumulator = new EnergyAccumulator({
  onPeriodComplete: async (unitId, date, hour, mwh) => {
    const periodo = hour + 1
    const redespacho = redespScraper.getState()?.[unitId]?.[hour] ?? null
    const dfEntry = emailDispatch.getState()?.[unitId]?.[periodo]
    const despFinalEmail = dfEntry?.valor_mw ?? null
    const result = computeClosed({ generacionMwh: mwh, despFinalEmail, redespachoMw: redespacho })
    try {
      await saveDesviacionPeriodo(unitId, date, periodo, result)
      console.log(`[Server] Desviación periodo guardada: ${unitId} p=${periodo} dev=${result.desviacionPct?.toFixed(2)}% src=${result.despFinalSource}`)
    } catch (err) {
      console.error('[Server] Error guardando desviación periodo:', err.message)
    }
  },
})

// Latest live projection snapshot per unit (for throttled persistence)
let lastProjection = {}

// ── HTTP + WebSocket server ──────────────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', clients: clients.size }))
    return
  }

  // REST endpoint: completed periods for today
  if (req.url === '/api/periods/today' && req.method === 'GET') {
    try {
      const periods = await getTodayPeriods()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(periods))
    } catch (err) {
      console.error('[API] Error fetching periods:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // REST endpoint: despacho final for today
  if (req.url === '/api/despacho-final/today' && req.method === 'GET') {
    try {
      const data = emailDispatch.getState()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    } catch (err) {
      console.error('[API] Error fetching despacho final:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // REST endpoint: redespacho scraped from rDEC file
  if (req.url === '/api/redespacho/today' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(redespScraper.getState() ?? {}))
    return
  }

  // REST endpoint: redespacho nacional (todas las plantas, para ticker)
  if (req.url === '/api/redespacho/national' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(redespScraper.getNational() ?? []))
    return
  }

  // REST endpoint: despacho scraped from dDEC file (Gecelca units)
  if (req.url === '/api/despacho/today' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(despScraper.getState() ?? {}))
    return
  }

  // REST endpoint: live projection state per unit (for first paint after page reload)
  if (req.url === '/api/proyeccion/today' && req.method === 'GET') {
    try {
      const rows = await loadProyeccionActual()
      const data = {}
      for (const row of rows) {
        data[row.unit_id] = {
          fecha: row.fecha,
          periodo: row.periodo,
          acumulado_mwh: row.acumulado_mwh,
          current_mw: row.current_mw,
          redespacho_mw: row.redespacho_mw,
          proyeccion_mwh: row.proyeccion_mwh,
          desviacion_pct: row.desviacion_pct,
          fraction: row.fraction,
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    } catch (err) {
      console.error('[API] Error fetching proyeccion:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // REST endpoint: closed-period deviation history for today
  if (req.url === '/api/desviacion-periodos/today' && req.method === 'GET') {
    try {
      const rows = await getTodayDesviacionPeriodos()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(rows))
    } catch (err) {
      console.error('[API] Error fetching desviacion periodos:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  res.writeHead(404).end()
})

const wss = new WebSocketServer({ server: httpServer })
const clients = new Set()
let lastPayload = null

wss.on('connection', (ws, req) => {
  clients.add(ws)
  console.log(`[WS] Cliente conectado — IP: ${req.socket.remoteAddress} | Total: ${clients.size}`)

  // Send last known data immediately
  if (lastPayload) ws.send(JSON.stringify(lastPayload))

  ws.on('close', () => {
    clients.delete(ws)
    console.log(`[WS] Cliente desconectado | Total: ${clients.size}`)
  })

  ws.on('error', (err) => console.warn('[WS] Error de cliente:', err.message))
})

// ── Broadcast a todos los clientes conectados ────────────────────────────────
function broadcast(payload) {
  // Feed units to the accumulator
  accumulator.update(payload.units)

  // Enrich payload with accumulation data
  const { accumulated, completedPeriods, minuteAvgs } = accumulator.getState()
  payload.accumulated = accumulated
  payload.completedPeriods = completedPeriods
  payload.minuteAvgs = minuteAvgs
  payload.despachoFinal = emailDispatch.getState()

  // ── Compute live projection / deviation per unit (VB6 logic) ──
  const now = new Date()
  const { hour: currentHour, period: currentPeriod, dateStr: todayStr } = colombiaNow(now)
  const redespState = redespScraper.getState() ?? {}
  const projection = {}
  for (const unit of payload.units) {
    const acumulado = accumulated[unit.id] ?? 0
    const currentMw = unit.valueMW ?? 0
    const redespacho = redespState?.[unit.id]?.[currentHour] ?? null
    const live = computeLive({ acumuladoMwh: acumulado, currentMw, redespachoMw: redespacho, now })
    projection[unit.id] = {
      fecha: todayStr,
      periodo: currentPeriod,
      acumulado_mwh: acumulado,
      current_mw: currentMw,
      redespacho_mw: redespacho,
      proyeccion_mwh: live.projection,
      desviacion_pct: live.deviation,
      fraction: live.fraction,
    }
  }
  payload.projection = projection
  lastProjection = projection

  lastPayload = payload
  const msg = JSON.stringify(payload)
  let sent = 0
  for (const client of clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(msg)
      sent++
    }
  }
  if (sent === 0 && clients.size > 0) {
    console.warn('[WS] Ningún cliente listo para recibir datos.')
  }
}

// Persist live projection snapshot every 30s (mirror of accumulator persist cadence)
const projectionSaveInterval = setInterval(async () => {
  for (const [unitId, snap] of Object.entries(lastProjection)) {
    try {
      await saveProyeccionActual(unitId, {
        fecha: snap.fecha,
        periodo: snap.periodo,
        acumuladoMwh: snap.acumulado_mwh,
        currentMw: snap.current_mw,
        redespachoMw: snap.redespacho_mw,
        proyeccionMwh: snap.proyeccion_mwh,
        desviacionPct: snap.desviacion_pct,
        fraction: snap.fraction,
      })
    } catch (err) {
      console.error(`[Server] Error persistiendo proyección ${unitId}:`, err.message)
    }
  }
}, 30_000)

// ── Scraper ──────────────────────────────────────────────────────────────────
const scraper = new PMEScraper({ pme: PME, units: UNITS, onData: broadcast })

// ── Arranque ─────────────────────────────────────────────────────────────────
async function start() {
  let dbOk = false
  try {
    await initDB()
    await accumulator.init()
    console.log('[DB] Conexión OK')
    await emailDispatch.init()
    dbOk = true
  } catch (err) {
    console.error('[DB] Error de conexión:', err.message)
    console.log('[DB] Continuando sin persistencia — datos solo en memoria')
  }

  emailDispatch.start()

  await redespScraper.init(dbOk)
  redespScraper.start()

  await despScraper.init(dbOk)
  despScraper.start()

  scraper.start()

  httpServer.listen(PORT, () => {
    console.log(`\n[Server] WebSocket en ws://localhost:${PORT}`)
    console.log(`[Server] Health check en http://localhost:${PORT}/health`)
    console.log(`[Server] Periodos API en http://localhost:${PORT}/api/periods/today\n`)
  })
}

start()

// ── Apagado limpio ───────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n[Server] Apagando…')
  clearInterval(projectionSaveInterval)
  await emailDispatch.stop()
  redespScraper.stop()
  despScraper.stop()
  await accumulator.stop()
  await scraper.stop()
  httpServer.close()
  process.exit(0)
})
