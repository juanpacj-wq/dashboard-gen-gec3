// server/alerter.js
// Alerter in-process: polea snapshot, evalúa umbrales, dispara alerts vía dispatch().
// Estado solo en memoria (Q5 cerrada en preguntas-01-obs-alerting.md).

const DEFAULTS = {
  ALERT_POLL_INTERVAL_SEC: 30,
  ALERT_COOLDOWN_MIN: 30,
  // ≈3 min a 2s/tick. Reconciliado con el TTL de carry-forward (D-116): la alerta
  // canónica de medidor caído es la per-unit time-based (meterDown ≥ 3min); este
  // umbral opera sobre meterPoller.perMeter (no-op en prod) y es defensivo.
  ALERT_THRESH_METER_CONSEC_ERRORS: 90,
  ALERT_THRESH_METER_DOWN_MIN: 3,
  // Global "todas sin medidor" (D-126): es EL CRITICAL de falla total de extracción.
  // Ya no está condicionado a que el fallback PME esté apagado — no hay fallback.
  ALERT_THRESH_METER_DOWN_GLOBAL_MIN: 2,
  ALERT_THRESH_EMAIL_STALE_MIN: 20,
  ALERT_THRESH_REDESP_STALE_MIN: 30,
  ALERT_THRESH_DESPACHO_STALE_MIN: 60,
  ALERT_DESPACHO_AFTER_HOUR_BOG: 15,
  ALERT_THRESH_ACCUMULATOR_STALE_MIN: 5,
}

function readEnv(env = process.env) {
  const out = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    const v = env[k]
    if (v != null && v !== '') {
      const n = Number(v)
      if (!Number.isFinite(n)) {
        throw new Error(`[alerter] env ${k}='${v}' no es numérico`)
      }
      out[k] = n
    }
  }
  return out
}

// Colombia es UTC-5 sin DST (CLAUDE.md umbrella §TZ). Intl con timeZone explícito;
// NO usar getHours() del host porque rompe si el server corre en otra TZ.
function bogotaHour(now = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota', hour: 'numeric', hour12: false,
  })
  return Number(fmt.format(new Date(now)))
}

/**
 * Alerter: polea getSnapshot() y emite alerts vía dispatch().
 * Estado en memoria. No persiste.
 */
export class Alerter {
  #cfg
  #getSnapshot
  #dispatch
  #now
  #interval = null
  // Map<incident_key, { severity, firstSeenAt, lastAlertedAt, active }>
  #incidents = new Map()

  constructor({ getSnapshot, dispatch, env = process.env, now = () => Date.now() }) {
    this.#cfg = readEnv(env)
    this.#getSnapshot = getSnapshot
    this.#dispatch = dispatch
    this.#now = now
  }

  start() {
    if (this.#interval) return
    const ms = this.#cfg.ALERT_POLL_INTERVAL_SEC * 1000
    this.#interval = setInterval(() => this.tick(), ms)
    // Primera evaluación inmediata para no esperar 30s al arrancar:
    this.tick()
  }

  stop() {
    if (this.#interval) clearInterval(this.#interval)
    this.#interval = null
  }

  tick() {
    let snap
    try {
      snap = this.#getSnapshot()
    } catch (err) {
      console.error('[alerter] snapshot failed:', err.message)
      return
    }
    this.#evaluate(snap)
  }

  #evaluate(snap) {
    const now = this.#now()
    const s = snap?.services ?? {}
    const c = this.#cfg

    // 1) MeterPoller per-meter: consecutiveErrors >= N
    const mp = s.meterPoller
    if (mp?.perMeter) {
      for (const [key, m] of Object.entries(mp.perMeter)) {
        const k = `meterPoller:${key}`
        if (m.consecutiveErrors >= c.ALERT_THRESH_METER_CONSEC_ERRORS) {
          this.#open(k, 'WARN', {
            title: `MeterPoller errores consecutivos: ${key}`,
            body: `consecutiveErrors=${m.consecutiveErrors}, lastError=${m.lastError ?? '?'}`,
          }, now)
        } else {
          this.#close(k, now, /*emitRecovery*/ false)
        }
      }
    }

    // 2) Orchestrator per-unit: medidor caído (fuente única desde D-126)
    const orch = s.orchestrator
    const perUnit = orch?.perUnit ?? {}
    const unitIds = Object.keys(perUnit)

    for (const u of unitIds) {
      // 2b) Medidor caído ≥ N min (carry-forward agotado, D-116). El reloj
      // meterDownSince del orchestrator corre durante el hold (observabilidad
      // veraz); una sola alerta gracias al cooldown por incident_key.
      const kDown = `orchestrator:meterDown:${u}`
      const downSec = perUnit[u].meterDownSeconds ?? 0
      if (downSec >= c.ALERT_THRESH_METER_DOWN_MIN * 60) {
        this.#open(kDown, 'WARN', {
          title: `Medidor ${u} caído ${Math.round(downSec / 60)} min (carry-forward agotado)`,
          body: `holding=${perUnit[u].holding} source=${perUnit[u].source} consecMeterErrors=${perUnit[u].consecMeterErrors ?? '?'}`,
        }, now)
      } else {
        this.#close(kDown, now, /*emitRecovery*/ false)
      }
    }

    // Global: TODAS las unidades sin medidor. Desde D-126 es EL CRITICAL de falla total
    // de extracción — ya no está condicionado a `pmeEnabled === false` porque no hay
    // segunda fuente, y su gemelo `orchestrator:pme:GLOBAL` desapareció con el fallback.
    // Sin reloj propio: meterDownSeconds del orchestrator ya corre durante el hold (D-116).
    // El !holding evita el falso positivo mientras el carry-forward todavía sirve valores;
    // en la práctica dispara en el primer tick tras agotarse el TTL.
    const kMeterGlobal = 'orchestrator:meterDown:GLOBAL'
    const allMetersDown = unitIds.length > 0 && unitIds.every(u =>
      !perUnit[u].holding &&
      (perUnit[u].meterDownSeconds ?? 0) >= c.ALERT_THRESH_METER_DOWN_GLOBAL_MIN * 60)
    if (allMetersDown) {
      this.#open(kMeterGlobal, 'CRITICAL', {
        title: 'TODAS las unidades sin medidor',
        body: 'Probable falla de LAN de medidores. Fuente única (D-126): valores en null. Revisar conectividad meter hosts.',
      }, now)
    } else {
      this.#close(kMeterGlobal, now, /*emitRecovery*/ true)   // CRITICAL = manda recovery
    }

    // 3) EmailDispatch GEC + TGJ
    for (const [label, svcKey] of [['GEC', 'emailDispatchGEC'], ['TGJ', 'emailDispatchTGJ']]) {
      const e = s[svcKey]
      if (!e) continue
      const ageSec = e.secondsSinceSuccess ?? e.lastLoadAgeSec ?? null
      const k = `emailDispatch:${label}`
      if (ageSec != null && ageSec > c.ALERT_THRESH_EMAIL_STALE_MIN * 60) {
        this.#open(k, 'WARN', {
          title: `EmailDispatch ${label} sin lectura por ${Math.round(ageSec / 60)} min`,
          body: `lastError=${e.lastLoadError ?? e.lastError ?? '?'}`,
        }, now)
      } else {
        this.#close(k, now, false)
      }
    }

    // 4) Redespacho scraper
    const rd = s.redespachoScraper
    if (rd) {
      const ageSec = rd.secondsSinceSuccess
      const k = 'redespachoScraper:stale'
      if (ageSec != null && ageSec > c.ALERT_THRESH_REDESP_STALE_MIN * 60) {
        this.#open(k, 'WARN', {
          title: `Redespacho scraper stale ${Math.round(ageSec / 60)} min`,
          body: `lastError=${rd.lastError ?? '?'}`,
        }, now)
      } else {
        this.#close(k, now, false)
      }
    }

    // 5) Despacho scraper — solo después de ALERT_DESPACHO_AFTER_HOUR_BOG
    const dd = s.despachoScraper
    if (dd) {
      const hour = bogotaHour(now)
      const ageSec = dd.secondsSinceSuccess
      const k = 'despachoScraper:stale'
      if (hour >= c.ALERT_DESPACHO_AFTER_HOUR_BOG &&
          ageSec != null && ageSec > c.ALERT_THRESH_DESPACHO_STALE_MIN * 60 &&
          !dd.foundForToday) {
        this.#open(k, 'WARN', {
          title: `Despacho scraper sin archivo hoy (hora Bogotá ${hour}:00)`,
          body: `lastError=${dd.lastError ?? '?'}, foundForToday=${dd.foundForToday}`,
        }, now)
      } else {
        this.#close(k, now, false)
      }
    }

    // 6) Accumulator (CRITICAL — emite recovery)
    const acc = s.accumulator
    if (acc) {
      const ageSec = acc.secondsSinceSuccess
      const k = 'accumulator:stale'
      if (ageSec != null && ageSec > c.ALERT_THRESH_ACCUMULATOR_STALE_MIN * 60) {
        this.#open(k, 'CRITICAL', {
          title: `Accumulator sin ticks por ${Math.round(ageSec / 60)} min`,
          body: 'Extractor puede estar vivo pero accumulator.update() no entra. Bug probable.',
        }, now)
      } else {
        this.#close(k, now, /*emitRecovery*/ true)
      }
    }
  }

  #open(incidentKey, severity, payload, now) {
    const existing = this.#incidents.get(incidentKey)
    const cooldownMs = this.#cfg.ALERT_COOLDOWN_MIN * 60 * 1000
    if (existing?.active && existing.severity === severity) {
      // mismo incident activo. Solo re-emite si pasó el cooldown.
      if (now - existing.lastAlertedAt < cooldownMs) return
    }
    const record = {
      severity,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastAlertedAt: now,
      active: true,
    }
    this.#incidents.set(incidentKey, record)
    try {
      this.#dispatch({
        incidentKey, severity,
        title: payload.title,
        body: payload.body,
        firstSeenAt: new Date(record.firstSeenAt).toISOString(),
        emittedAt: new Date(now).toISOString(),
      })
    } catch (err) {
      console.error('[alerter] dispatch failed:', err.message)
    }
  }

  #close(incidentKey, now, emitRecovery) {
    const existing = this.#incidents.get(incidentKey)
    if (!existing?.active) return
    existing.active = false
    if (emitRecovery && existing.severity === 'CRITICAL') {
      try {
        this.#dispatch({
          incidentKey, severity: 'RECOVERED',
          title: `Recuperado: ${incidentKey}`,
          body: `Incidente activo desde ${new Date(existing.firstSeenAt).toISOString()}`,
          firstSeenAt: new Date(existing.firstSeenAt).toISOString(),
          emittedAt: new Date(now).toISOString(),
        })
      } catch (err) {
        console.error('[alerter] dispatch recovery failed:', err.message)
      }
    }
  }

  // Test helper:
  _stateForTest() {
    return {
      incidents: Array.from(this.#incidents.entries()),
    }
  }
}
