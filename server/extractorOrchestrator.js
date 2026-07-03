import { MeterPoller } from './meterPoller.js'
import { PMEScraper } from './scraper.js'

const DEFAULT_POLL_MS = 2000
const DEFAULT_RECOVERY_THRESHOLD = 2
const DEFAULT_HOLD_TTL_MIN = 3       // carry-forward del último valor bueno del medidor (D-116)
const FRESHNESS_MS = 30_000  // un dato es "fresco" si tiene <30s
const HEARTBEAT_MS = 60_000

export class ExtractorOrchestrator {
  #units
  #onData
  #pollMs
  #recoveryThreshold
  #holdTtlMs
  #meterPoller
  #pmeScraper       // null cuando pmeEnabled=false (D-120)
  #pmeEnabled
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
    // Fallback PME (D-120). Default true = retrocompat con los llamadores/tests que no
    // pasan el flag; el default APAGADO vive en config (PME_ENABLED), no acá.
    pmeEnabled = true,
    onData,
    pollMs = DEFAULT_POLL_MS,
    timeoutMs,
    opPath,
    // fallbackThreshold: obsoleto desde D-116 (decisión ahora time-based). Si una
    // llamada aún lo pasa, se ignora sin romper (destructuring descarta extras).
    recoveryThreshold = DEFAULT_RECOVERY_THRESHOLD,
    holdTtlMin = DEFAULT_HOLD_TTL_MIN,
    holdTtlMs,  // tests: gana sobre holdTtlMin si se pasa (precisión con fake timers)
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
    if (pmeEnabled && !pme) {
      throw new TypeError('ExtractorOrchestrator: pme config required')
    }

    this.#pmeEnabled = pmeEnabled
    this.#units = units
    this.#onData = onData
    this.#pollMs = pollMs
    this.#recoveryThreshold = recoveryThreshold
    this.#holdTtlMs = (holdTtlMs != null && Number.isFinite(holdTtlMs))
      ? holdTtlMs
      : holdTtlMin * 60_000

    this.#meterCache = new Map()
    this.#pmeCache = new Map()
    this.#unitState = new Map()

    for (const u of units) {
      this.#unitState.set(u.id, {
        source: null,
        since: null,
        consecMeterErrors: 0,
        consecMeterOk: 0,
        justSwitched: false,
        // Carry-forward con TTL (D-116). lastGoodMeter es un store SEPARADO de
        // #meterCache porque #onMeterData sobrescribe el cache con value:null cuando
        // el medidor falla; acá retenemos el último valor bueno post-inversión.
        lastGoodMeter: null,  // { value, at }
        holding: false,
        heldTicks: 0,
        lastHoldAt: null,
        meterDownSince: null,
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

    // Con el fallback apagado no se instancia PMEScraper (cero Playwright/Chromium) ni
    // se llama unitsForPME() (las units pueden traer pme: null).
    this.#pmeScraper = pmeEnabled
      ? new pmeScraperCtor({
          pme,
          units: unitsForPME(units),
          onData: (payload) => this.#onPmeData(payload),
        })
      : null
  }

  async start() {
    if (this.#running) return
    this.#running = true
    log('info',
      `ExtractorOrchestrator starting — holdTtlMin=${this.#holdTtlMs / 60_000} ` +
      `recoveryThreshold=${this.#recoveryThreshold} pollMs=${this.#pollMs} ` +
      `pmeEnabled=${this.#pmeEnabled}`,
    )

    // Kick off ambos sub-extractores fire-and-forget. PMEScraper.start() tiene
    // un `while (running)` que nunca resuelve mientras el scraper está vivo
    // (es su ciclo de observación). Si lo awaitáramos aquí, los setIntervals
    // de #tick/#heartbeat nunca se programarían y onData jamás se llamaría.
    // MeterPoller.start() sí resuelve, pero lo tratamos igual por simetría.
    Promise.resolve(this.#meterPoller.start()).catch((e) =>
      log('error', `meterPoller.start failed: ${e?.message ?? e}`),
    )
    if (this.#pmeScraper) {
      Promise.resolve(this.#pmeScraper.start()).catch((e) =>
        log('error', `pmeScraper.start failed: ${e?.message ?? e}`),
      )
    }

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
      ...(this.#pmeScraper ? [Promise.resolve(this.#pmeScraper.stop())] : []),
    ])
  }

  getTickSnapshot(unitId) {
    const state = this.#unitState.get(unitId)
    const meter = this.#meterCache.get(unitId)
    const pme = this.#pmeCache.get(unitId)
    const now = Date.now()
    let meterPreInversion = null
    try {
      meterPreInversion = this.#meterPoller.getPreInversionValue?.(unitId) ?? null
    } catch { /* ignore */ }
    return {
      meterRaw: meter?.value ?? null,
      meterAgeMs: meter ? now - meter.updatedAt : null,
      meterPreInversion,
      pmeRaw: pme?.value ?? null,
      pmeAgeMs: pme ? now - pme.updatedAt : null,
      source: state?.source ?? null,
      sourceSince: state?.since ?? null,
      justSwitched: !!state?.justSwitched,
      consecMeterErrors: state?.consecMeterErrors ?? 0,
      consecMeterOk: state?.consecMeterOk ?? 0,
      holding: !!state?.holding,
      heldTicks: state?.heldTicks ?? 0,
      lastGoodMeterValue: state?.lastGoodMeter?.value ?? null,
      lastGoodMeterAgeMs: state?.lastGoodMeter ? now - state.lastGoodMeter.at : null,
    }
  }

  getStatus() {
    const meter = safeGetStatus(this.#meterPoller)
    const pme = this.#pmeScraper ? safeGetStatus(this.#pmeScraper) : null

    const now = Date.now()
    const perUnit = {}
    for (const [unitId, state] of this.#unitState) {
      perUnit[unitId] = {
        source: state.source,
        since: state.since ? new Date(state.since).toISOString() : null,
        consecMeterErrors: state.consecMeterErrors,
        consecMeterOk: state.consecMeterOk,
        meterValue: this.#meterCache.get(unitId)?.value ?? null,
        pmeValue:   this.#pmeCache.get(unitId)?.value   ?? null,
        holding: state.holding,
        heldTicks: state.heldTicks,
        lastHoldAt: state.lastHoldAt ? new Date(state.lastHoldAt).toISOString() : null,
        meterDownSeconds: state.meterDownSince ? Math.floor((now - state.meterDownSince) / 1000) : 0,
      }
    }

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
      pmeEnabled: this.#pmeEnabled,
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
      state.justSwitched = false

      const meter = this.#meterCache.get(unit.id)
      const pme = this.#pmeCache.get(unit.id)

      const meterValid = isValid(meter, now)
      // Con el fallback apagado el dato pme nunca es válido: la rama de conmutación
      // meter→pme queda inalcanzable y tras el hold TTL la unidad emite null (D-120).
      const pmeValid = this.#pmeEnabled ? isValid(pme, now) : false

      if (meterValid) {
        state.consecMeterOk++
        state.consecMeterErrors = 0
        // 1c: lastGoodMeter solo se sella con lecturas válidas (post-inversión).
        state.lastGoodMeter = { value: meter.value, at: now }
      } else {
        state.consecMeterErrors++
        state.consecMeterOk = 0
      }

      // ── Decisión de fuente: carry-forward con TTL (D-116) ──────────────────
      const prevSource = state.source
      const wasHolding = state.holding
      const ttlExpired = state.lastGoodMeter ? (now - state.lastGoodMeter.at) >= this.#holdTtlMs : true

      // Reloj meter-down: corre durante el hold; el hold NO lo resetea
      // (observabilidad veraz). Solo una lectura válida lo limpia.
      if (meterValid) state.meterDownSince = null
      else if (state.meterDownSince === null) state.meterDownSince = now

      if (meterValid) {
        if (prevSource === 'pme') {
          // recovery pme→meter: preserva recoveryThreshold (D-102)
          if (state.consecMeterOk >= this.#recoveryThreshold) {
            state.source = 'meter'; state.since = now; state.justSwitched = true
            log('info', `[${unit.id}] switched: pme → meter (${state.consecMeterOk} consec OK)`)
          }
        } else {
          if (prevSource !== 'meter') { state.source = 'meter'; state.since = now; state.justSwitched = true }
          else state.source = 'meter'
        }
        state.holding = false
      } else if (state.lastGoodMeter && !ttlExpired) {
        // HOLD — prioridad sobre PME mientras el TTL no expire
        state.source = 'meter'
        state.holding = true
      } else {
        // TTL expiró (o sin lastGoodMeter en arranque) → ceder a PME
        state.holding = false
        if (pmeValid && prevSource !== 'pme') {
          state.source = 'pme'; state.since = now; state.justSwitched = true
          if (prevSource === 'meter') {
            log('warn', `[${unit.id}] switched: meter → pme (TTL ${this.#holdTtlMs / 60_000}min agotado)`)
          } else {
            log('warn', `[${unit.id}] init in fallback (meter invalid at startup)`)
          }
        }
        // ambas muertas: mantener source previo (value será null); conserva histéresis
      }

      // ── Episodio de hold (log inicio/fin) ──────────────────────────────────
      if (state.holding) {
        if (!wasHolding) {
          state.heldTicks = 1; state.lastHoldAt = now
          log('warn', `[${unit.id}] HOLD start — retiene ${state.lastGoodMeter.value} MW (lastGood age=${Math.round((now - state.lastGoodMeter.at) / 1000)}s)`)
        } else {
          state.heldTicks++
        }
      } else if (wasHolding) {
        const reason = meterValid ? 'meter recovered' : (pmeValid ? 'TTL→pme' : 'TTL→null')
        log('info', `[${unit.id}] HOLD end — ${state.heldTicks} ticks reason=${reason}`)
        state.heldTicks = 0
      }

      // ── Cálculo de valueMW ─────────────────────────────────────────────────
      let valueMW
      if (state.source === 'meter')    valueMW = meterValid ? meter.value : (state.holding ? state.lastGoodMeter.value : null)
      else if (state.source === 'pme') valueMW = pmeValid ? pme.value : null
      else                             valueMW = null

      mergedUnits.push({ id: unit.id, label: unit.label, valueMW, maxMW: unit.maxMW, source: state.source, holding: state.holding })

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
