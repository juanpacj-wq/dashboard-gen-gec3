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
  saveProyeccionHistorico,
  saveProyeccionPeriodo,
  getTodayProyeccionPeriodos,
  getLastHistoricoPerPeriodToday,
  savePeriod,
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

/**
 * Return a Date whose UTC representation equals the Colombia wall clock.
 * Used when persisting DATETIME2 columns so that SSMS/queries show local time
 * regardless of whether the host runs in UTC or Colombia TZ.
 */
function colombiaWallClockDate(date = new Date()) {
  return new Date(date.getTime() - 5 * 3_600_000)
}

// ── Services ──────────────────────────────────────────────────────────────────
const emailDispatchGEC = new EmailDispatchService({
  mailbox: process.env.GRAPH_MAILBOX,
  unitsMap: { 'GECELCA 32': 'GEC32', 'GECELCA 3': 'GEC3' },
  xmCodeMap: { GEC3: ['GEC3'], GEC32: ['GE32'] },
  unitIds: ['GEC3', 'GEC32'],
})
const emailDispatchTGJ = new EmailDispatchService({
  mailbox: process.env.GRAPH_MAILBOXTEG,
  unitsMap: { 'GUAJIRA 2': 'TGJ2', 'GUAJIRA 1': 'TGJ1' },
  xmCodeMap: { TGJ1: ['TGJ1'], TGJ2: ['TGJ2'] },
  unitIds: ['TGJ1', 'TGJ2'],
})

function getMergedDespachoFinal() {
  return { ...emailDispatchGEC.getState(), ...emailDispatchTGJ.getState() }
}
const redespScraper = new RedespachoscraperService()
const despScraper = new DespachoscraperService()

// Accumulator with closing-period callback that persists deviation history
const accumulator = new EnergyAccumulator({
  onPeriodComplete: async (unitId, date, hour, mwh, closingProjection) => {
    const periodo = hour + 1
    const redespacho = redespScraper.getState()?.[unitId]?.[hour] ?? null
    const dfEntry = getMergedDespachoFinal()?.[unitId]?.[periodo]
    const despFinalEmail = dfEntry?.valor_mw ?? null
    const result = computeClosed({ generacionMwh: mwh, despFinalEmail, redespachoMw: redespacho })
    try {
      await saveDesviacionPeriodo(unitId, date, periodo, result)
      console.log(`[Server] Desviación periodo guardada: ${unitId} p=${periodo} dev=${result.desviacionPct?.toFixed(2)}% src=${result.despFinalSource}`)
    } catch (err) {
      console.error('[Server] Error guardando desviación periodo:', err.message)
    }

    // Persist closing projection snapshot for the period
    // closingProjection was computed synchronously in accumulator.update()
    // BEFORE the broadcast overwrites lastProjection with the new period's data.
    try {
      const proyCierre = closingProjection ?? mwh
      const desv = redespacho != null && redespacho > 0
        ? ((Math.max(0, proyCierre) - redespacho) / redespacho) * 100
        : result.desviacionPct
      await saveProyeccionPeriodo(unitId, date, periodo, {
        proyeccionCierreMwh: proyCierre,
        generacionRealMwh: mwh,
        redespachoMw: redespacho,
        desviacionPct: desv,
      })
      // Feed in-memory map so the next broadcast pushes this to all clients
      ;(closingProjections[unitId] ||= {})[periodo] = {
        proyeccion_cierre_mwh: proyCierre,
        generacion_real_mwh: mwh,
        redespacho_mw: redespacho,
        desviacion_pct: desv,
      }
      console.log(`[Server] Proyección cierre guardada: ${unitId} p=${periodo} proy=${proyCierre.toFixed(2)} real=${mwh.toFixed(2)}`)
    } catch (err) {
      console.error('[Server] Error guardando proyección cierre:', err.message)
    }
  },
})

// Latest live projection snapshot per unit (for throttled persistence)
let lastProjection = {}

// In-memory buffer of live projection samples per unit, flushed every 3 min
// as an aggregated row into dashboard.proyeccion_historico for audit trail.
const proyBuffer = {}
let proyWindowStart = new Date()

// In-memory map of closing projection per unit/period so the broadcast
// payload can push this history to the frontend live without a refetch.
// Shape: { [unitId]: { [periodo]: { proyeccion_cierre_mwh, generacion_real_mwh, redespacho_mw, desviacion_pct } } }
const closingProjections = {}

// ── HTTP + WebSocket server ──────────────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  // Health check
  if (req.url === '/health') {
    const pme = scraper.getStatus()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: pme.stale ? 'degraded' : 'ok',
      clients: clients.size,
      uptime: process.uptime(),
      pme,
    }))
    return
  }

  // REST endpoint: completed periods for today
  if (req.url === '/api/periods/today' && req.method === 'GET') {
    try {
      const periods = await getTodayPeriods()
      // Fallback: rellenar periodos pasados ausentes desde proyeccion_historico
      // (caso típico: scraper colgado entre límites de hora; ver fallback-historico-recovery.md)
      const { hour: currentHour } = colombiaNow()
      const historico = await getLastHistoricoPerPeriodToday()
      const present = new Set(periods.map(r => `${r.unit_id}_${r.hora}`))
      for (const [unitId, byPeriod] of Object.entries(historico)) {
        for (const [periodoStr, hist] of Object.entries(byPeriod)) {
          const periodo = parseInt(periodoStr, 10)
          const hora = periodo - 1
          if (hora >= currentHour) continue
          if (present.has(`${unitId}_${hora}`)) continue
          periods.push({
            unit_id: unitId,
            hora,
            energia_mwh: hist.acumulado_mwh ?? 0,
            source: 'historico_fallback',
          })
        }
      }
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
      const data = getMergedDespachoFinal()
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

  // REST endpoint: despacho de mañana from dDEC file (next day)
  if (req.url === '/api/despacho/tomorrow' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(despScraper.getStateTomorrow()))
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

  // REST endpoint: closing projection per period (audit) for today
  if (req.url === '/api/proyeccion-periodos/today' && req.method === 'GET') {
    try {
      const rows = await getTodayProyeccionPeriodos()
      const data = {}
      for (const row of rows) {
        if (!data[row.unit_id]) data[row.unit_id] = {}
        data[row.unit_id][row.periodo] = {
          proyeccion_cierre_mwh: row.proyeccion_cierre_mwh,
          generacion_real_mwh: row.generacion_real_mwh,
          redespacho_mw: row.redespacho_mw,
          desviacion_pct: row.desviacion_pct,
        }
      }
      // Fallback: completar periodos pasados ausentes desde proyeccion_historico
      const { hour: currentHour } = colombiaNow()
      const historico = await getLastHistoricoPerPeriodToday()
      for (const [unitId, byPeriod] of Object.entries(historico)) {
        for (const [periodoStr, hist] of Object.entries(byPeriod)) {
          const periodo = parseInt(periodoStr, 10)
          const hora = periodo - 1
          if (hora >= currentHour) continue
          if (data[unitId]?.[periodo]) continue
          if (!data[unitId]) data[unitId] = {}
          data[unitId][periodo] = {
            proyeccion_cierre_mwh: hist.proyeccion_mwh,
            generacion_real_mwh:   hist.acumulado_mwh,
            redespacho_mw:         hist.redespacho_mw,
            desviacion_pct:        hist.desviacion_pct,
            source: 'historico_fallback',
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    } catch (err) {
      console.error('[API] Error fetching proyeccion periodos:', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // REST endpoint: closed-period deviation history for today
  if (req.url === '/api/desviacion-periodos/today' && req.method === 'GET') {
    try {
      const rows = await getTodayDesviacionPeriodos()
      // Fallback: completar periodos pasados ausentes desde proyeccion_historico
      const { hour: currentHour } = colombiaNow()
      const historico = await getLastHistoricoPerPeriodToday()
      const present = new Set(rows.map(r => `${r.unit_id}_${r.periodo}`))
      for (const [unitId, byPeriod] of Object.entries(historico)) {
        for (const [periodoStr, hist] of Object.entries(byPeriod)) {
          const periodo = parseInt(periodoStr, 10)
          const hora = periodo - 1
          if (hora >= currentHour) continue
          if (present.has(`${unitId}_${periodo}`)) continue
          rows.push({
            unit_id: unitId,
            periodo,
            generacion_mwh:    hist.acumulado_mwh ?? 0,
            desp_final_mw:     hist.redespacho_mw ?? null,
            desp_final_source: 'historico_fallback',
            desviacion_pct:    hist.desviacion_pct,
          })
        }
      }
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

  // Send last known data immediately. Si el scraper está rancio, marcamos el
  // payload como tal para que el frontend pueda mostrar un indicador en lugar
  // de presentar valores estáticos como si fueran en vivo.
  if (lastPayload) {
    const pmeStatus = scraper.getStatus()
    const snapshot = pmeStatus.stale
      ? { ...lastPayload, stale: true, staleSeconds: pmeStatus.secondsSinceUpdate }
      : lastPayload
    ws.send(JSON.stringify(snapshot))
  }

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

  // ── Compute live projection / deviation per unit (VB6 logic) ──
  // Must run BEFORE getState() so feedDeviation populates the minute buckets
  const now = new Date()
  const { hour: currentHour, period: currentPeriod, dateStr: todayStr } = colombiaNow(now)
  const colMinute = new Date(now.getTime() + now.getTimezoneOffset() * 60_000 - 5 * 3_600_000).getMinutes()
  const redespState = redespScraper.getState() ?? {}
  const { accumulated: accSnap } = accumulator.getState()
  const projection = {}
  for (const unit of payload.units) {
    const acumulado = accSnap[unit.id] ?? 0
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

    // Feed deviation minute bucket (same deviation formula as Table.jsx current period)
    accumulator.feedDeviation(unit.id, currentHour, colMinute, live.deviation)

    // Feed the 3-min aggregation buffer for audit history
    ;(proyBuffer[unit.id] ||= []).push({
      fecha: todayStr,
      periodo: currentPeriod,
      acumuladoMwh: acumulado,
      currentMw,
      redespachoMw: redespacho,
      projection: live.projection,
      deviation: live.deviation,
      fraction: live.fraction,
    })
  }
  payload.projection = projection
  lastProjection = projection

  // Enrich payload with accumulation data (after feedDeviation so minuteDeviations is populated)
  const { accumulated, completedPeriods, minuteAvgs, minuteDeviations } = accumulator.getState()
  payload.accumulated = accumulated
  payload.completedPeriods = completedPeriods
  payload.minuteAvgs = minuteAvgs
  payload.minuteDeviations = minuteDeviations
  payload.despachoFinal = getMergedDespachoFinal()
  payload.proyeccionPeriodos = closingProjections

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

// Flush the projection buffer every 3 min — one aggregated row per unit
const PROY_FLUSH_MS = 3 * 60 * 1000
const proyHistFlushInterval = setInterval(async () => {
  const windowEnd = new Date()
  const windowStart = proyWindowStart
  proyWindowStart = windowEnd

  for (const unitId of Object.keys(proyBuffer)) {
    const samples = proyBuffer[unitId]
    if (!samples || samples.length === 0) continue
    proyBuffer[unitId] = []

    const n = samples.length
    const sum = (fn) => samples.reduce((s, x) => s + (Number.isFinite(fn(x)) ? fn(x) : 0), 0)
    const avg = (fn) => sum(fn) / n
    // Average deviation ignoring nulls
    const devSamples = samples.filter(x => x.deviation != null)
    const avgDev = devSamples.length > 0
      ? devSamples.reduce((s, x) => s + x.deviation, 0) / devSamples.length
      : null
    const last = samples[n - 1]

    try {
      await saveProyeccionHistorico(unitId, {
        fecha: last.fecha,
        periodo: last.periodo,
        acumuladoMwh: avg(x => x.acumuladoMwh),
        currentMw: avg(x => x.currentMw),
        redespachoMw: last.redespachoMw,
        proyeccionMwh: avg(x => x.projection),
        desviacionPct: avgDev,
        fraction: last.fraction,
        samples: n,
        windowStart: colombiaWallClockDate(windowStart),
        windowEnd: colombiaWallClockDate(windowEnd),
      })
    } catch (err) {
      console.error(`[Server] Error guardando proyección histórico ${unitId}:`, err.message)
    }
  }
}, PROY_FLUSH_MS)

// ── Scraper ──────────────────────────────────────────────────────────────────
const scraper = new PMEScraper({ pme: PME, units: UNITS, onData: broadcast })

/**
 * Rellena en `generacion_periodos`/`proyeccion_periodos`/`desviacion_periodos`
 * los periodos pasados que faltan, usando la última fila por (unit, periodo)
 * de `proyeccion_historico`. Idempotente: corre una vez por arranque y los
 * MERGE evitan pisar datos canónicos auténticos.
 *
 * Necesario porque cuando el scraper se cuelga atravesando uno o más límites
 * de hora, accumulator.update() no detecta el cambio y #completePeriod nunca
 * se ejecuta para esos periodos. El watchdog del scraper previene huecos
 * largos a futuro, pero esta recovery cierra los gaps históricos.
 */
async function recoverSkippedPeriods() {
  try {
    const { hour: currentHour, dateStr: today } = colombiaNow()
    const [periods, proyPeriodos, desvPeriodos, historico] = await Promise.all([
      getTodayPeriods(),
      getTodayProyeccionPeriodos(),
      getTodayDesviacionPeriodos(),
      getLastHistoricoPerPeriodToday(),
    ])
    const presentGen  = new Set(periods.map(r => `${r.unit_id}_${r.hora}`))
    const presentProy = new Set(proyPeriodos.map(r => `${r.unit_id}_${r.periodo}`))
    const presentDesv = new Set(desvPeriodos.map(r => `${r.unit_id}_${r.periodo}`))
    const redespState = redespScraper.getState() ?? {}
    const dfState = getMergedDespachoFinal()

    let recovered = 0
    for (const [unitId, byPeriod] of Object.entries(historico)) {
      for (const [periodoStr, hist] of Object.entries(byPeriod)) {
        const periodo = parseInt(periodoStr, 10)
        const hora = periodo - 1
        if (hora >= currentHour) continue

        const missingGen  = !presentGen.has(`${unitId}_${hora}`)
        const missingProy = !presentProy.has(`${unitId}_${periodo}`)
        const missingDesv = !presentDesv.has(`${unitId}_${periodo}`)
        if (!missingGen && !missingProy && !missingDesv) continue

        const proyCierre = hist.proyeccion_mwh ?? 0
        const generacion = hist.acumulado_mwh ?? 0
        const redespacho = redespState?.[unitId]?.[hora] ?? hist.redespacho_mw ?? null
        const dfEntry = dfState?.[unitId]?.[periodo]
        const despFinal = dfEntry?.valor_mw ?? null
        const denom = despFinal != null ? despFinal : redespacho
        const desv = (denom != null && denom > 0)
          ? ((Math.max(0, proyCierre) - denom) / denom) * 100
          : (hist.desviacion_pct ?? null)

        try {
          if (missingGen)  await savePeriod(unitId, today, hora, generacion)
          if (missingProy) {
            await saveProyeccionPeriodo(unitId, today, periodo, {
              proyeccionCierreMwh: proyCierre,
              generacionRealMwh: generacion,
              redespachoMw: redespacho,
              desviacionPct: desv,
            })
            ;(closingProjections[unitId] ||= {})[periodo] = {
              proyeccion_cierre_mwh: proyCierre,
              generacion_real_mwh: generacion,
              redespacho_mw: redespacho,
              desviacion_pct: desv,
            }
          }
          if (missingDesv) {
            await saveDesviacionPeriodo(unitId, today, periodo, {
              generacionMwh: generacion,
              despFinalMw: despFinal,
              despFinalSource: dfEntry?.source ?? (redespacho != null ? 'redespacho' : null),
              desviacionPct: desv,
            })
          }
          recovered++
          console.log(`[Recovery] ${unitId} periodo=${periodo} proy=${proyCierre.toFixed(2)} gen=${generacion.toFixed(2)} desv=${desv?.toFixed(2)}%`)
        } catch (err) {
          console.error(`[Recovery] Error ${unitId} periodo=${periodo}:`, err.message)
        }
      }
    }
    console.log(`[Server] Recovery: ${recovered} periodo(s) recuperados desde proyeccion_historico`)
  } catch (err) {
    console.error('[Server] Recovery falló:', err.message)
  }
}

// ── Arranque ─────────────────────────────────────────────────────────────────
async function start() {
  let dbOk = false
  try {
    await initDB()
    await accumulator.init()
    console.log('[DB] Conexión OK')
    await emailDispatchGEC.init()
    await emailDispatchTGJ.init()
    // Preload closing projections from DB so broadcasts include today's history after restart
    try {
      const rows = await getTodayProyeccionPeriodos()
      for (const row of rows) {
        ;(closingProjections[row.unit_id] ||= {})[row.periodo] = {
          proyeccion_cierre_mwh: row.proyeccion_cierre_mwh,
          generacion_real_mwh: row.generacion_real_mwh,
          redespacho_mw: row.redespacho_mw,
          desviacion_pct: row.desviacion_pct,
        }
      }
      console.log(`[Server] Proyección cierre precargada: ${rows.length} filas`)
    } catch (err) {
      console.warn('[Server] No se pudo precargar proyección cierre:', err.message)
    }
    dbOk = true
  } catch (err) {
    console.error('[DB] Error de conexión:', err.message)
    console.log('[DB] Continuando sin persistencia — datos solo en memoria')
  }

  emailDispatchGEC.start()
  emailDispatchTGJ.start()

  await redespScraper.init(dbOk)
  redespScraper.start()

  await despScraper.init(dbOk)
  despScraper.start()

  // Reconstruir periodos pasados que no quedaron en las tablas canónicas (típico
  // tras un cuelgue del scraper que cruzó límites de hora). Se hace antes de
  // levantar el scraper PME para evitar carrera con accumulator.update().
  if (dbOk) await recoverSkippedPeriods()

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
  clearInterval(proyHistFlushInterval)
  await emailDispatchGEC.stop()
  await emailDispatchTGJ.stop()
  redespScraper.stop()
  despScraper.stop()
  await accumulator.stop()
  await scraper.stop()
  httpServer.close()
  process.exit(0)
})
