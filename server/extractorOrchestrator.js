import { MeterPoller } from './meterPoller.js'
import { PMEScraper } from './scraper.js'

const DEFAULT_POLL_MS = 2000
const DEFAULT_FALLBACK_THRESHOLD = 3
const DEFAULT_RECOVERY_THRESHOLD = 2
const FRESHNESS_MS = 30_000  // un dato es "fresco" si tiene <30s
const HEARTBEAT_MS = 60_000

export class ExtractorOrchestrator {
  #units
  #onData
  #pollMs
  #fallbackThreshold
  #recoveryThreshold
  #meterPoller
  #pmeScraper
  #meterCache       // Map<unitId, { value, updatedAt }>
  #pmeCache         // Map<unitId, { value, updatedAt }>
  #unitState        // Map<unitId, { source, since, consecMeterErrors, consecMeterOk }>
  #running = false
  #pollTimer = null
  #heartbeatTimer = null
  #updateCount = 0
  #errorCount = 0
  #lastDataAt = null
  #lastValueChangeAt = null
  #prevValuesByUnit = new Map()

  constructor({
    units,
    pme,
    onData,
    pollMs = DEFAULT_POLL_MS,
    timeoutMs,
    opPath,
    fallbackThreshold = DEFAULT_FALLBACK_THRESHOLD,
    recoveryThreshold = DEFAULT_RECOVERY_THRESHOLD,
    clientFactory,
    // Inyectables para tests:
    meterPollerCtor = MeterPoller,
    pmeScraperCtor = PMEScraper,
  } = {}) {
    if (!Array.isArray(units) || units.length === 0) {
      throw new TypeError('ExtractorOrchestrator: units required')
    }
    if (typeof onData !== 'function') {
      throw new TypeError('ExtractorOrchestrator: onData must be a function')
    }
    if (!pme) {
      throw new TypeError('ExtractorOrchestrator: pme config required')
    }

    this.#units = units
    this.#onData = onData
    this.#pollMs = pollMs
    this.#fallbackThreshold = fallbackThreshold
    this.#recoveryThreshold = recoveryThreshold

    this.#meterCache = new Map()
    this.#pmeCache = new Map()
    this.#unitState = new Map()

    for (const u of units) {
      this.#unitState.set(u.id, {
        source: null,
        since: null,
        consecMeterErrors: 0,
        consecMeterOk: 0,
      })
    }

    this.#meterPoller = new meterPollerCtor({
      units,
      onData: (payload) => this.#onMeterData(payload),
      pollMs,
      timeoutMs,
      opPath,
      clientFactory,
    })

    this.#pmeScraper = new pmeScraperCtor({
      pme,
      units: unitsForPME(units),
      onData: (payload) => this.#onPmeData(payload),
    })
  }

  async start() {
    if (this.#running) return
    this.#running = true
    log('info',
      `ExtractorOrchestrator starting — fallbackThreshold=${this.#fallbackThreshold} ` +
      `recoveryThreshold=${this.#recoveryThreshold} pollMs=${this.#pollMs}`,
    )

    // Kick off ambos sub-extractores fire-and-forget. PMEScraper.start() tiene
    // un `while (running)` que nunca resuelve mientras el scraper está vivo
    // (es su ciclo de observación). Si lo awaitáramos aquí, los setIntervals
    // de #tick/#heartbeat nunca se programarían y onData jamás se llamaría.
    // MeterPoller.start() sí resuelve, pero lo tratamos igual por simetría.
    Promise.resolve(this.#meterPoller.start()).catch((e) =>
      log('error', `meterPoller.start failed: ${e?.message ?? e}`),
    )
    Promise.resolve(this.#pmeScraper.start()).catch((e) =>
      log('error', `pmeScraper.start failed: ${e?.message ?? e}`),
    )

    this.#pollTimer = setInterval(() => {
      try { this.#tick() } catch (e) { log('error', `merge tick failed: ${e?.message ?? e}`) }
    }, this.#pollMs)

    this.#heartbeatTimer = setInterval(() => this.#heartbeat(), HEARTBEAT_MS)

    setTimeout(() => { try { this.#tick() } catch { /* ignore */ } }, 100)
  }

  async stop() {
    if (!this.#running) return
    this.#running = false
    if (this.#pollTimer) { clearInterval(this.#pollTimer); this.#pollTimer = null }
    if (this.#heartbeatTimer) { clearInterval(this.#heartbeatTimer); this.#heartbeatTimer = null }

    await Promise.allSettled([
      Promise.resolve(this.#meterPoller.stop()),
      Promise.resolve(this.#pmeScraper.stop()),
    ])
  }

  getStatus() {
    const meter = safeGetStatus(this.#meterPoller)
    const pme = safeGetStatus(this.#pmeScraper)

    const perUnit = {}
    for (const [unitId, state] of this.#unitState) {
      perUnit[unitId] = {
        source: state.source,
        since: state.since ? new Date(state.since).toISOString() : null,
        consecMeterErrors: state.consecMeterErrors,
        consecMeterOk: state.consecMeterOk,
        meterValue: this.#meterCache.get(unitId)?.value ?? null,
        pmeValue:   this.#pmeCache.get(unitId)?.value   ?? null,
      }
    }

    const now = Date.now()
    return {
      running: this.#running,
      warming: this.#updateCount === 0,
      lastDataAt: this.#lastDataAt ? new Date(this.#lastDataAt).toISOString() : null,
      secondsSinceUpdate: this.#lastDataAt ? Math.floor((now - this.#lastDataAt) / 1000) : null,
      lastValueChangeAt: this.#lastValueChangeAt ? new Date(this.#lastValueChangeAt).toISOString() : null,
      secondsSinceValueChange: this.#lastValueChangeAt ? Math.floor((now - this.#lastValueChangeAt) / 1000) : null,
      updateCount: this.#updateCount,
      errorCount: this.#errorCount,
      stale: this.#isStale(),
      valueStale: false,
      meter,
      pme,
      perUnit,
    }
  }

  // ─── Internals ───────────────────────────────────────────────────

  #onMeterData(payload) {
    if (!payload?.units) return
    const now = Date.now()
    for (const u of payload.units) {
      this.#meterCache.set(u.id, { value: u.valueMW, updatedAt: now })
    }
  }

  #onPmeData(payload) {
    if (!payload?.units) return
    const now = Date.now()
    for (const u of payload.units) {
      this.#pmeCache.set(u.id, { value: u.valueMW, updatedAt: now })
    }
  }

  #tick() {
    const now = Date.now()
    const mergedUnits = []

    for (const unit of this.#units) {
      const state = this.#unitState.get(unit.id)
      const meter = this.#meterCache.get(unit.id)
      const pme = this.#pmeCache.get(unit.id)

      const meterValid = isValid(meter, now)
      const pmeValid = isValid(pme, now)

      if (meterValid) {
        state.consecMeterOk++
        state.consecMeterErrors = 0
      } else {
        state.consecMeterErrors++
        state.consecMeterOk = 0
      }

      const prev = state.source
      if (prev === null) {
        if (meterValid) { state.source = 'meter'; state.since = now }
        else if (pmeValid) {
          state.source = 'pme'; state.since = now
          log('warn', `[${unit.id}] init in fallback (meter invalid at startup)`)
        }
      } else if (prev === 'meter') {
        if (!meterValid && state.consecMeterErrors >= this.#fallbackThreshold && pmeValid) {
          state.source = 'pme'; state.since = now
          log('warn', `[${unit.id}] switched: meter → pme (${state.consecMeterErrors} consec errors)`)
        }
      } else if (prev === 'pme') {
        if (meterValid && state.consecMeterOk >= this.#recoveryThreshold) {
          state.source = 'meter'; state.since = now
          log('info', `[${unit.id}] switched: pme → meter (${state.consecMeterOk} consec OK)`)
        }
      }

      let valueMW
      if (state.source === 'meter') valueMW = meterValid ? meter.value : null
      else if (state.source === 'pme') valueMW = pmeValid ? pme.value : null
      else valueMW = null

      mergedUnits.push({ id: unit.id, label: unit.label, valueMW, maxMW: unit.maxMW, source: state.source })

      if (valueMW !== null) {
        const prevVal = this.#prevValuesByUnit.get(unit.id)
        if (prevVal === undefined || prevVal !== valueMW) {
          this.#lastValueChangeAt = now
          this.#prevValuesByUnit.set(unit.id, valueMW)
        }
      }
    }

    if (mergedUnits.some((u) => u.valueMW !== null)) {
      this.#lastDataAt = now
    }

    this.#updateCount++

    const payload = {
      type: 'update',
      units: mergedUnits,
      timestamp: new Date(now).toISOString(),
    }

    try {
      this.#onData(payload)
    } catch (err) {
      log('error', `onData callback threw: ${err?.message ?? err}`)
      this.#errorCount++
    }
  }

  #heartbeat() {
    const counts = { meter: 0, pme: 0, none: 0 }
    for (const s of this.#unitState.values()) counts[s.source ?? 'none']++
    log('info',
      `heartbeat updates=${this.#updateCount} stale=${this.#isStale()} ` +
      `sources={meter:${counts.meter}, pme:${counts.pme}, none:${counts.none}}`,
    )
  }

  #isStale() {
    if (this.#lastDataAt === null) return this.#updateCount > 5
    return Date.now() - this.#lastDataAt >= 60_000
  }
}

// Adapter: traduce el modelo unificado al shape que PMEScraper consume
// (sin tocar PMEScraper). Líneas 401-406 de scraper.js solo leen
// {id, label, referencia, occurrence, maxMW}.
export function unitsForPME(units) {
  return units.map((u) => ({
    id: u.id,
    label: u.label,
    maxMW: u.maxMW,
    referencia: u.pme.referencia,
    occurrence: u.pme.occurrence ?? 0,
  }))
}

function isValid(entry, now) {
  if (!entry) return false
  if ((now - entry.updatedAt) >= FRESHNESS_MS) return false
  if (entry.value === null || entry.value === undefined) return false
  if (!Number.isFinite(entry.value)) return false
  return true
}

function safeGetStatus(sub) {
  try { return sub.getStatus() } catch { return null }
}

function log(level, msg) {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(`[orchestrator] [${new Date().toISOString()}] ${msg}`)
}
