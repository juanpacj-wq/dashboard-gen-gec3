import { MeterPoller } from './meterPoller.js'
import { clampGenerationMw } from '../shared/domain/generation.js'

const DEFAULT_POLL_MS = 2000
const DEFAULT_HOLD_TTL_MIN = 3       // carry-forward del último valor bueno del medidor (D-116)
const FRESHNESS_MS = 30_000  // un dato es "fresco" si tiene <30s
const HEARTBEAT_MS = 60_000

/**
 * Fuente ÚNICA de potencia: los medidores ION8650 por Modbus TCP (D-126).
 *
 * El fallback PME se retiró: raspaba el mismo dato de los mismos 5 medidores vía el
 * servidor PME, así que compartía el punto único de falla con el primario (si el medidor
 * o su red caen, caen los dos) y aportaba solo superficie de error propia.
 *
 * Lo que este orquestador SÍ sigue haciendo, y por eso no desapareció con el fallback:
 *   - carry-forward del último valor bueno con TTL ante nulls transitorios (D-116),
 *   - clamp de la invariante de dominio "la generación nunca es negativa" (D-125),
 *   - merge por unidad + freshness + observabilidad (source/holding/heartbeat).
 */
export class ExtractorOrchestrator {
  #units
  #onData
  #pollMs
  #holdTtlMs
  #meterPoller
  #meterCache       // Map<unitId, { value, updatedAt }>
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
    onData,
    pollMs = DEFAULT_POLL_MS,
    timeoutMs,
    opPath,
    // fallbackThreshold / recoveryThreshold / pme / pmeEnabled: obsoletos desde D-126
    // (ya no hay segunda fuente que arbitrar). Si un llamador viejo aún los pasa, el
    // destructuring los descarta sin romper.
    holdTtlMin = DEFAULT_HOLD_TTL_MIN,
    holdTtlMs,  // tests: gana sobre holdTtlMin si se pasa (precisión con fake timers)
    clientFactory,
    // Inyectable para tests:
    meterPollerCtor = MeterPoller,
  } = {}) {
    if (!Array.isArray(units) || units.length === 0) {
      throw new TypeError('ExtractorOrchestrator: units required')
    }
    if (typeof onData !== 'function') {
      throw new TypeError('ExtractorOrchestrator: onData must be a function')
    }

    this.#units = units
    this.#onData = onData
    this.#pollMs = pollMs
    this.#holdTtlMs = (holdTtlMs != null && Number.isFinite(holdTtlMs))
      ? holdTtlMs
      : holdTtlMin * 60_000

    this.#meterCache = new Map()
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
  }

  async start() {
    if (this.#running) return
    this.#running = true
    log('info',
      `ExtractorOrchestrator starting — holdTtlMin=${this.#holdTtlMs / 60_000} ` +
      `pollMs=${this.#pollMs} source=meter-only (D-126)`,
    )

    // Kick off fire-and-forget: MeterPoller.start() resuelve, pero no lo awaitamos
    // para que los setIntervals de #tick/#heartbeat se programen sin depender de él.
    Promise.resolve(this.#meterPoller.start()).catch((e) =>
      log('error', `meterPoller.start failed: ${e?.message ?? e}`),
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

    await Promise.allSettled([Promise.resolve(this.#meterPoller.stop())])
  }

  getTickSnapshot(unitId) {
    const state = this.#unitState.get(unitId)
    const meter = this.#meterCache.get(unitId)
    const now = Date.now()
    let meterPreInversion = null
    try {
      meterPreInversion = this.#meterPoller.getPreInversionValue?.(unitId) ?? null
    } catch { /* ignore */ }
    return {
      meterRaw: meter?.value ?? null,
      meterAgeMs: meter ? now - meter.updatedAt : null,
      meterPreInversion,
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

    const now = Date.now()
    const perUnit = {}
    for (const [unitId, state] of this.#unitState) {
      perUnit[unitId] = {
        source: state.source,
        since: state.since ? new Date(state.since).toISOString() : null,
        consecMeterErrors: state.consecMeterErrors,
        consecMeterOk: state.consecMeterOk,
        meterValue: this.#meterCache.get(unitId)?.value ?? null,
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
      meter,
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

  #tick() {
    const now = Date.now()
    const mergedUnits = []

    for (const unit of this.#units) {
      const state = this.#unitState.get(unit.id)
      state.justSwitched = false

      const meter = this.#meterCache.get(unit.id)
      const meterValid = isValid(meter, now)

      if (meterValid) {
        state.consecMeterOk++
        state.consecMeterErrors = 0
        // lastGoodMeter solo se sella con lecturas válidas (post-inversión).
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
        if (prevSource !== 'meter') { state.source = 'meter'; state.since = now; state.justSwitched = true }
        else state.source = 'meter'
        state.holding = false
      } else if (state.lastGoodMeter && !ttlExpired) {
        // HOLD — se retiene el último valor bueno mientras el TTL no expire
        state.source = 'meter'
        state.holding = true
      } else {
        // TTL expirado (o sin lastGoodMeter en arranque): nadie sirve. Se conserva el
        // source previo por histéresis y el valor sale null — "sin lectura" nunca se
        // convierte en "generando 0 MW" (D-105/D-116).
        state.holding = false
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
        const reason = meterValid ? 'meter recovered' : 'TTL→null'
        log('info', `[${unit.id}] HOLD end — ${state.heldTicks} ticks reason=${reason}`)
        state.heldTicks = 0
      }

      // ── Cálculo de valueMW ─────────────────────────────────────────────────
      const valueMwRaw = meterValid
        ? meter.value
        : (state.holding ? state.lastGoodMeter.value : null)

      // Invariante de dominio (D-125): la generación nunca es negativa. Este es el único
      // punto donde nace el valueMW canónico — fusiona lectura viva y carry-forward —, así
      // que un solo clamp acá cubre ambas procedencias y todo lo que va aguas abajo
      // (accumulator, proyección, broadcast, BD). clampGenerationMw propaga null a
      // propósito: "sin lectura" nunca se convierte en "generando 0 MW" (D-105/D-116).
      // valueMwRaw viaja en el payload para que el clamp sea observable y no silencioso.
      const valueMW = clampGenerationMw(valueMwRaw)

      mergedUnits.push({ id: unit.id, label: unit.label, valueMW, valueMwRaw, maxMW: unit.maxMW, source: state.source, holding: state.holding })

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
    const counts = { meter: 0, none: 0 }
    for (const s of this.#unitState.values()) counts[s.source ?? 'none']++
    log('info',
      `heartbeat updates=${this.#updateCount} stale=${this.#isStale()} ` +
      `sources={meter:${counts.meter}, none:${counts.none}}`,
    )
  }

  #isStale() {
    if (this.#lastDataAt === null) return this.#updateCount > 5
    return Date.now() - this.#lastDataAt >= 60_000
  }
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
