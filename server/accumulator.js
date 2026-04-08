import { savePeriod, saveAccumState, loadAccumState } from './db.js'

// Colombia is UTC-5 (no daylight saving)
function colombiaTime(date = new Date()) {
  const utc = date.getTime() + date.getTimezoneOffset() * 60_000
  const col = new Date(utc - 5 * 3_600_000)
  return {
    hour: col.getHours(),       // 0-23
    minute: col.getMinutes(),   // 0-59
    period: col.getHours() + 1, // 1-24 (period 1 = hour 0-1)
    dateStr: col.toISOString().slice(0, 10),
  }
}

export class EnergyAccumulator {
  #state = {}       // { unitId: { mwh, lastMW, lastTime, hour, date } }
  #completed = {}   // { unitId: { [hour]: mwhValue } }  — keyed by hour (0-23)
  #minuteBuckets = {} // { unitId: { hour, buckets: [{ sum, count } × 60] } }
  #saveInterval = null
  #onPeriodComplete = null

  constructor({ onPeriodComplete } = {}) {
    this.#onPeriodComplete = onPeriodComplete ?? null
  }

  async init() {
    const rows = await loadAccumState()
    const { hour: currentHour, dateStr: todayStr } = colombiaTime()

    for (const row of rows) {
      const rowDate = new Date(row.fecha).toISOString().slice(0, 10)
      if (rowDate === todayStr && row.hora === currentHour) {
        this.#state[row.unit_id] = {
          mwh: row.energia_mwh,
          lastMW: row.last_mw,
          lastTime: new Date(row.last_time),
          hour: row.hora,
          date: rowDate,
        }
      }
    }
    console.log('[Accumulator] Estado restaurado:', Object.keys(this.#state).length, 'unidades')

    // Persist state to DB every 30 seconds
    this.#saveInterval = setInterval(() => this.#persistState(), 30_000)
  }

  /** Called on every scraper update */
  update(units) {
    const now = new Date()
    const { hour: currentHour, minute: currentMinute, dateStr: todayStr } = colombiaTime(now)

    for (const unit of units) {
      const mw = unit.valueMW ?? 0

      // --- Energy accumulation (trapezoidal) ---
      const prev = this.#state[unit.id]

      if (prev && (prev.hour !== currentHour || prev.date !== todayStr)) {
        // Hour changed → save completed period
        this.#completePeriod(unit.id, prev.date, prev.hour, prev.mwh)
        this.#state[unit.id] = { mwh: 0, lastMW: mw, lastTime: now, hour: currentHour, date: todayStr }
      } else if (!prev) {
        this.#state[unit.id] = { mwh: 0, lastMW: mw, lastTime: now, hour: currentHour, date: todayStr }
      } else {
        const dtHours = (now - prev.lastTime) / 3_600_000
        const areaMWh = ((prev.lastMW + mw) / 2) * dtHours
        prev.mwh += areaMWh
        prev.lastMW = mw
        prev.lastTime = now
      }

      // --- Per-minute average buckets ---
      let mb = this.#minuteBuckets[unit.id]
      if (!mb || mb.hour !== currentHour) {
        mb = { hour: currentHour, buckets: Array.from({ length: 60 }, () => ({ sum: 0, count: 0 })) }
        this.#minuteBuckets[unit.id] = mb
      }
      mb.buckets[currentMinute].sum += mw
      mb.buckets[currentMinute].count += 1
    }
  }

  /** Get state to broadcast to clients */
  getState() {
    const accumulated = {}
    for (const [id, s] of Object.entries(this.#state)) {
      accumulated[id] = Math.round(s.mwh * 10) / 10
    }

    const minuteAvgs = {}
    for (const [id, mb] of Object.entries(this.#minuteBuckets)) {
      minuteAvgs[id] = mb.buckets.map(b => b.count > 0 ? Math.round((b.sum / b.count) * 10) / 10 : null)
    }

    return { accumulated, completedPeriods: this.#completed, minuteAvgs }
  }

  // hour is 0-23, stored in DB as 0-23 (maps to period hour+1 on the client)
  async #completePeriod(unitId, date, hour, mwh) {
    if (!this.#completed[unitId]) this.#completed[unitId] = {}
    this.#completed[unitId][hour] = Math.round(mwh * 10) / 10

    try {
      await savePeriod(unitId, date, hour, mwh)
      console.log(`[Accumulator] Periodo guardado: ${unitId} hora=${hour} periodo=${hour + 1} energia=${mwh.toFixed(3)} MWh`)
    } catch (err) {
      console.error(`[Accumulator] Error guardando periodo:`, err.message)
    }

    if (this.#onPeriodComplete) {
      try {
        await this.#onPeriodComplete(unitId, date, hour, mwh)
      } catch (err) {
        console.error(`[Accumulator] Error en onPeriodComplete:`, err.message)
      }
    }
  }

  async #persistState() {
    for (const [unitId, s] of Object.entries(this.#state)) {
      try {
        await saveAccumState(unitId, s.date, s.hour, s.mwh, s.lastMW, s.lastTime)
      } catch (err) {
        console.error(`[Accumulator] Error persistiendo estado:`, err.message)
      }
    }
  }

  async stop() {
    clearInterval(this.#saveInterval)
    await this.#persistState()
  }
}
