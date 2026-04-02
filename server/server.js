import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { PMEScraper } from './scraper.js'
import { UNITS, PME } from './config.js'
import { initDB, getTodayPeriods } from './db.js'
import { EnergyAccumulator } from './accumulator.js'
import { EmailDispatchService } from './emailDispatch.js'
import { RedespachoscraperService } from './redespachoscraper.js'

const PORT = parseInt(process.env.WS_PORT, 10) || 3001

// ── Energy accumulator ────────────────────────────────────────────────────────
const accumulator = new EnergyAccumulator()
const emailDispatch = new EmailDispatchService()
const redespScraper = new RedespachoscraperService()

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

// ── Scraper ──────────────────────────────────────────────────────────────────
const scraper = new PMEScraper({ pme: PME, units: UNITS, onData: broadcast })

// ── Arranque ─────────────────────────────────────────────────────────────────
async function start() {
  try {
    await initDB()
    await accumulator.init()
    console.log('[DB] Conexión OK')
    await emailDispatch.init()
  } catch (err) {
    console.error('[DB] Error de conexión:', err.message)
    console.log('[DB] Continuando sin persistencia — datos solo en memoria')
  }

  emailDispatch.start()

  await redespScraper.init()
  redespScraper.start()

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
  await emailDispatch.stop()
  redespScraper.stop()
  await accumulator.stop()
  await scraper.stop()
  httpServer.close()
  process.exit(0)
})
