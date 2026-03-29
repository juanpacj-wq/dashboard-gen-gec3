import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { PMEScraper } from './scraper.js'
import { UNITS, PME } from './config.js'

const PORT = parseInt(process.env.WS_PORT, 10) || 3001

// ── HTTP + WebSocket server ──────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  // Health check mínimo
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', clients: clients.size }))
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

  // Enviar el último dato conocido de inmediato (sin esperar el próximo ciclo)
  if (lastPayload) ws.send(JSON.stringify(lastPayload))

  ws.on('close', () => {
    clients.delete(ws)
    console.log(`[WS] Cliente desconectado | Total: ${clients.size}`)
  })

  ws.on('error', (err) => console.warn('[WS] Error de cliente:', err.message))
})

// ── Broadcast a todos los clientes conectados ────────────────────────────────
function broadcast(payload) {
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
scraper.start()

// ── Arranque ─────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n[Server] WebSocket en ws://localhost:${PORT}`)
  console.log(`[Server] Health check en http://localhost:${PORT}/health\n`)
})

// ── Apagado limpio ───────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n[Server] Apagando…')
  await scraper.stop()
  httpServer.close()
  process.exit(0)
})
