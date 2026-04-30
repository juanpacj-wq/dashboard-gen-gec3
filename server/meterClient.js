import * as cheerio from 'cheerio'
import { Agent, request } from 'undici'

export class MeterError extends Error {
  constructor(message, { host, cause } = {}) {
    super(message)
    this.name = 'MeterError'
    this.host = host
    if (cause) this.cause = cause
  }
}
export class MeterAuthError extends MeterError { constructor(...a) { super(...a); this.name = 'MeterAuthError' } }
export class MeterHttpError extends MeterError { constructor(...a) { super(...a); this.name = 'MeterHttpError' } }
export class MeterTimeoutError extends MeterError { constructor(...a) { super(...a); this.name = 'MeterTimeoutError' } }
export class MeterFormatError extends MeterError { constructor(...a) { super(...a); this.name = 'MeterFormatError' } }

const DEFAULT_OP_PATH = '/Operation.html'
const DEFAULT_TIMEOUT_MS = 4000
const KW_LABEL = 'kW total'

const TIMEOUT_CODES = new Set([
  'UND_ERR_ABORTED',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ABORT_ERR',
])

export class ION8650Client {
  #host
  #authHeader
  #opPath
  #timeoutMs
  #agent
  #ownsAgent

  constructor({ host, user, password, opPath = DEFAULT_OP_PATH, timeoutMs = DEFAULT_TIMEOUT_MS, agent } = {}) {
    if (!host) throw new TypeError('ION8650Client: host required')
    if (!user) throw new TypeError('ION8650Client: user required')
    if (password == null) throw new TypeError('ION8650Client: password required')

    this.#host = host
    this.#authHeader = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
    this.#opPath = opPath
    this.#timeoutMs = timeoutMs

    if (agent) {
      this.#agent = agent
      this.#ownsAgent = false
    } else {
      this.#agent = new Agent({
        keepAliveTimeout: 10_000,
        keepAliveMaxTimeout: 30_000,
        connections: 2,
        pipelining: 0,
      })
      this.#ownsAgent = true
    }
  }

  get host() { return this.#host }

  async fetchKwTotal() {
    const url = this.#buildUrl()
    const startedAt = Date.now()
    let res
    try {
      res = await request(url, {
        method: 'GET',
        headers: {
          authorization: this.#authHeader,
          accept: 'text/html,application/xhtml+xml',
        },
        dispatcher: this.#agent,
        signal: AbortSignal.timeout(this.#timeoutMs),
        bodyTimeout: this.#timeoutMs,
        headersTimeout: this.#timeoutMs,
      })
    } catch (err) {
      if (TIMEOUT_CODES.has(err?.code) || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new MeterTimeoutError(`Timeout (${this.#timeoutMs}ms) fetching ${url}`, { host: this.#host, cause: err })
      }
      throw new MeterError(`Network error fetching ${url}: ${err?.message ?? err}`, { host: this.#host, cause: err })
    }

    if (res.statusCode === 401) {
      await drain(res)
      throw new MeterAuthError(`401 Unauthorized at ${url}`, { host: this.#host })
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      await drain(res)
      throw new MeterHttpError(`HTTP ${res.statusCode} at ${url}`, { host: this.#host })
    }

    let html
    try {
      html = await res.body.text()
    } catch (err) {
      if (TIMEOUT_CODES.has(err?.code) || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new MeterTimeoutError(`Body read timeout at ${url}`, { host: this.#host, cause: err })
      }
      throw new MeterError(`Body read error at ${url}: ${err?.message ?? err}`, { host: this.#host, cause: err })
    }

    const kw = parseKwTotal(html, this.#host)
    return { kw, fetchedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt }
  }

  #buildUrl() {
    const hasScheme = /^https?:\/\//i.test(this.#host)
    const base = (hasScheme ? this.#host : `http://${this.#host}`).replace(/\/+$/, '')
    const path = this.#opPath.startsWith('/') ? this.#opPath : `/${this.#opPath}`
    return base + path
  }

  async close() {
    if (this.#ownsAgent) {
      await this.#agent.close().catch(() => {})
    }
  }
}

export function parseKwTotal(html, host = '<unknown>') {
  const $ = cheerio.load(html, { xmlMode: false })
  const labelCell = $('td.l')
    .filter((_, el) => $(el).text().trim() === KW_LABEL)
    .first()
  if (labelCell.length === 0) {
    throw new MeterFormatError(`Could not find label cell '${KW_LABEL}' in HTML (host=${host})`, { host })
  }
  const valueCell = labelCell.next('td.v')
  if (valueCell.length === 0) {
    throw new MeterFormatError(`Label '${KW_LABEL}' present but adjacent td.v missing (host=${host})`, { host })
  }
  const valueText = valueCell.text().trim()
  const match = /^(-?\d+(?:\.\d+)?)\s*kW$/.exec(valueText)
  if (!match) {
    throw new MeterFormatError(`Value '${valueText}' does not match '<number> kW' pattern (host=${host})`, { host })
  }
  const kw = parseFloat(match[1])
  if (!Number.isFinite(kw)) {
    throw new MeterFormatError(`Parsed kW is not finite: '${match[1]}' (host=${host})`, { host })
  }
  return kw
}

async function drain(res) {
  try { await res.body.dump() } catch { /* ignore */ }
}
