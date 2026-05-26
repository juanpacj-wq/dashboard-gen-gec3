import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export class DeviationTracer {
  #enabled
  #unitIds
  #baseDir
  #streams = new Map()
  #ready = false

  constructor({ enabled, baseDir } = {}) {
    const raw = (enabled ?? '').trim()
    this.#enabled = raw.length > 0
    this.#unitIds = this.#enabled
      ? new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
      : new Set()
    this.#baseDir = baseDir
  }

  get enabled() {
    return this.#enabled
  }

  tracksUnit(unitId) {
    return this.#enabled && this.#unitIds.has(unitId)
  }

  logTick(record) {
    if (!this.#enabled) return
    const unitId = record?.unit
    if (!unitId || !this.#unitIds.has(unitId)) return

    try {
      const stream = this.#getStream(unitId, record.ts, record.hour)
      stream.write(JSON.stringify(record) + '\n')
    } catch (err) {
      console.warn(`[deviationTracer] write failed (${unitId}): ${err?.message ?? err}`)
    }
  }

  async close() {
    if (!this.#enabled) return
    const closes = []
    for (const entry of this.#streams.values()) {
      closes.push(new Promise((resolve) => entry.stream.end(resolve)))
    }
    this.#streams.clear()
    await Promise.all(closes)
  }

  #getStream(unitId, ts, hour) {
    if (!this.#ready) {
      mkdirSync(this.#baseDir, { recursive: true })
      this.#ready = true
    }

    const dateStr = ts.slice(0, 10)
    const hourStr = String(hour).padStart(2, '0')
    const key = `${unitId}::${dateStr}::${hourStr}`
    let entry = this.#streams.get(key)
    if (entry) return entry.stream

    for (const [oldKey, oldEntry] of this.#streams) {
      if (oldKey.startsWith(`${unitId}::`)) {
        oldEntry.stream.end()
        this.#streams.delete(oldKey)
      }
    }

    const filename = `trace-${unitId}-${dateStr}-${hourStr}.jsonl`
    const filepath = join(this.#baseDir, filename)
    const stream = createWriteStream(filepath, { flags: 'a' })
    stream.on('error', (err) => {
      console.warn(`[deviationTracer] stream error (${unitId}): ${err?.message ?? err}`)
    })
    entry = { stream, filepath }
    this.#streams.set(key, entry)
    console.log(`[deviationTracer] opened ${filepath}`)
    return stream
  }
}
