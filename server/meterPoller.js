import { Agent } from 'undici'
import { ION8650Client } from './meterClient.js'

const DEFAULT_POLL_MS = 2000
const DEFAULT_TIMEOUT_MS = 4000
const DEFAULT_OP_PATH = '/Operation.html'
const HEARTBEAT_MS = 60_000
const STALE_WARNING_MS = 30_000
const STALE_THRESHOLD_MS = 60_000

export class MeterPoller {
  #units
  #onData
  #pollMs
  #timeoutMs
  #opPath
  #agent
  #clients
  #meterStatus
  #clientFactory
  #running = false
  #warming = false
  #updateCount = 0
  #errorCount = 0
  #pollTimer = null
  #heartbeatTimer = null
  #ticking = false

  constructor({
    units,
    onData,
    pollMs = DEFAULT_POLL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    opPath = DEFAULT_OP_PATH,
    clientFactory,
  } = {}) {
    if (!Array.isArray(units) || units.length === 0) {
      throw new TypeError('MeterPoller: units must be a non-empty array')
    }
    if (typeof onData !== 'function') {
      throw new TypeError('MeterPoller: onData must be a function')
    }
    for (const u of units) {
      if (!u?.id) throw new TypeError('MeterPoller: each unit needs an id')
      if (!Array.isArray(u.meters) || u.meters.length === 0) {
        throw new TypeError(`MeterPoller: unit ${u.id} has no meters`)
      }
      if (u.meters.length > 1 && u.combine !== 'sum') {
        throw new TypeError(`MeterPoller: unit ${u.id} has ${u.meters.length} meters but combine='${u.combine}'. Use 'sum'.`)
      }
    }

    this.#units = units
    this.#onData = onData
    this.#pollMs = pollMs
    this.#timeoutMs = timeoutMs
    this.#opPath = opPath
    this.#agent = new Agent({
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 30_000,
      connections: 4,
      pipelining: 0,
    })
    this.#clients = new Map()
    this.#meterStatus = new Map()
    this.#clientFactory = clientFactory ?? defaultClientFactory

    for (const unit of units) {
      for (const meter of unit.meters) {
        const key = meterKey(unit.id, meter.host)
        if (this.#clients.has(key)) continue
        const client = this.#clientFactory({
          host: meter.host,
          user: meter.user,
          password: meter.password,
          opPath: this.#opPath,
          timeoutMs: this.#timeoutMs,
          agent: this.#agent,
        })
        this.#clients.set(key, client)
        this.#meterStatus.set(key, {
          unitId: unit.id,
          host: meter.host,
          lastOkAt: null,
          lastErrorAt: null,
          consecutiveErrors: 0,
          lastError: null,
        })
      }
    }
  }

  async start() {
    if (this.#running) return
    this.#running = true
    this.#warming = true
    log('info', `MeterPoller starting — ${this.#units.length} units, ${this.#clients.size} meters, poll=${this.#pollMs}ms`)

    this.#tick().catch((e) => log('error', `initial tick failed: ${e?.message ?? e}`))

    this.#pollTimer = setInterval(() => {
      if (this.#ticking) {
        log('warn', 'previous tick still running, skipping interval')
        return
      }
      this.#tick().catch((e) => log('error', `tick failed: ${e?.message ?? e}`))
    }, this.#pollMs)

    this.#heartbeatTimer = setInterval(() => {
      log('info',
        `heartbeat updates=${this.#updateCount} errors=${this.#errorCount} ` +
        `stale=${this.#isGloballyStale()} secondsSinceUpdate=${this.#secondsSinceUpdate()}`,
      )
    }, HEARTBEAT_MS)
  }

  async stop() {
    if (!this.#running) return
    this.#running = false
    if (this.#pollTimer) { clearInterval(this.#pollTimer); this.#pollTimer = null }
    if (this.#heartbeatTimer) { clearInterval(this.#heartbeatTimer); this.#heartbeatTimer = null }
    for (const c of this.#clients.values()) {
      try { await c.close() } catch { /* ignore */ }
    }
    try { await this.#agent.close() } catch { /* ignore */ }
  }

  getStatus() {
    const lastDataAt = this.#lastDataAt()
    const perMeter = {}
    const now = Date.now()
    for (const [key, s] of this.#meterStatus) {
      perMeter[key] = {
        unitId: s.unitId,
        host: s.host,
        lastOkAt: s.lastOkAt ? new Date(s.lastOkAt).toISOString() : null,
        secondsSinceOk: s.lastOkAt ? Math.floor((now - s.lastOkAt) / 1000) : null,
        consecutiveErrors: s.consecutiveErrors,
        lastError: s.lastError,
      }
    }
    return {
      running: this.#running,
      warming: this.#warming,
      lastDataAt: lastDataAt ? new Date(lastDataAt).toISOString() : null,
      secondsSinceUpdate: this.#secondsSinceUpdate(),
      updateCount: this.#updateCount,
      errorCount: this.#errorCount,
      stale: this.#isGloballyStale(),
      perMeter,
    }
  }

  async #tick() {
    if (this.#ticking) return
    this.#ticking = true
    const tickStart = Date.now()
    try {
      const units = await Promise.all(this.#units.map((u) => this.#readUnit(u)))
      const payload = {
        type: 'update',
        units,
        timestamp: new Date(tickStart).toISOString(),
      }
      this.#warming = false
      this.#updateCount++
      try {
        this.#onData(payload)
      } catch (err) {
        log('error', `onData callback threw: ${err?.message ?? err}`)
      }
    } finally {
      this.#ticking = false
    }
  }

  async #readUnit(unit) {
    const now = Date.now()
    const results = await Promise.all(
      unit.meters.map((meter) => {
        const key = meterKey(unit.id, meter.host)
        const client = this.#clients.get(key)
        return client.fetchKwTotal()
          .then((r) => ({ ok: true, key, kw: r.kw }))
          .catch((err) => ({ ok: false, key, error: err }))
      }),
    )

    let valueMW = null
    if (results.every((r) => r.ok)) {
      const kws = results.map((r) => r.kw)
      const total = unit.combine === 'sum' ? sum(kws) : kws[0]
      valueMW = total / 1000
      // Inversión de signo para fronteras de medición de ENTRADA (GEC3, GEC32):
      // el medidor reporta con signo opuesto al de generación neta. Ver
      // SIGN_CONVENTION.md.
      if (unit.frontierType === 'input') valueMW = -valueMW
      // Normaliza -0 → 0 para que aguas abajo no haya sorpresas (Object.is).
      if (Object.is(valueMW, -0)) valueMW = 0
      for (const r of results) this.#markOk(r.key, now)
    } else {
      for (const r of results) {
        if (r.ok) this.#markOk(r.key, now)
        else { this.#markError(r.key, now, r.error, unit.id); this.#errorCount++ }
      }
    }

    return { id: unit.id, label: unit.label, valueMW, maxMW: unit.maxMW }
  }

  #markOk(key, now) {
    const s = this.#meterStatus.get(key)
    if (!s) return
    s.lastOkAt = now
    s.consecutiveErrors = 0
    s.lastError = null
  }

  #markError(key, now, err, unitId) {
    const s = this.#meterStatus.get(key)
    if (!s) return
    s.lastErrorAt = now
    s.consecutiveErrors++
    s.lastError = `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`
    const sinceOk = s.lastOkAt ? now - s.lastOkAt : Infinity
    const level = sinceOk >= STALE_THRESHOLD_MS && s.consecutiveErrors > 1
      ? 'error'
      : sinceOk >= STALE_WARNING_MS
        ? 'warn'
        : 'warn'
    log(level, `meter fetch failed (unit=${unitId} key=${key} consecErrors=${s.consecutiveErrors}): ${s.lastError}`)
  }

  #lastDataAt() {
    let max = null
    for (const s of this.#meterStatus.values()) {
      if (s.lastOkAt && (max === null || s.lastOkAt > max)) max = s.lastOkAt
    }
    return max
  }

  #secondsSinceUpdate() {
    const last = this.#lastDataAt()
    return last ? Math.floor((Date.now() - last) / 1000) : null
  }

  #isGloballyStale() {
    if (this.#warming && this.#lastDataAt() === null) return false
    const last = this.#lastDataAt()
    if (last === null) return true
    return Date.now() - last >= STALE_THRESHOLD_MS
  }
}

function meterKey(unitId, host) {
  return `${unitId}@${host}`
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0)
}

function defaultClientFactory(opts) {
  return new ION8650Client(opts)
}

function log(level, msg) {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(`[meterPoller] [${new Date().toISOString()}] ${msg}`)
}
