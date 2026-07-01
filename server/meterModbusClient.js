import ModbusRTU from 'modbus-serial'
import { MeterError, MeterTimeoutError, MeterFormatError } from './meterClient.js'

// Cliente Modbus TCP para medidores ION8650 (Function 03 — Read Holding Registers).
// Firma pública IDÉNTICA a ION8650Client (meterClient.js): fetchKwTotal()/close()/host.
// Así es un drop-in detrás del clientFactory de MeterPoller — el poller hace /1000 a MW
// e invierte el signo de Gecelca sin saber el protocolo. Ver SIGN_CONVENTION.md.

const DEFAULT_PORT = 502
const DEFAULT_UNIT_ID = 1
const DEFAULT_REGISTER = 40204      // kW tot scaled (INT32, escala /1000) — match probable del HTML
const DEFAULT_WORD_ORDER = 'high'   // 'high' = high-order register first (doc Schneider) | 'low'
const DEFAULT_DECODE = 'int32'      // 'int32' (signed) | 'float32'
const DEFAULT_SCALE = 1000          // /10 para 40033, /1000 para 40204, 1 para float32
const DEFAULT_TIMEOUT_MS = 4000
const MODBUS_BASE = 40001           // registro doc 4xxxx → offset 0-based = reg - 40001

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_ABORTED', 'ABORT_ERR'])
const NET_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ENOTFOUND', 'EHOSTDOWN',
])

// Excepción de protocolo Modbus (frame 0x83 + código). NO es transitorio: 0x02 (Illegal
// Data Address) suele significar Modbus Map Access bloqueado por Advanced Security en el
// medidor — el operador debe verlo, análogo semántico a MeterAuthError del lado HTTP.
export class MeterModbusException extends MeterError {
  constructor(message, { host, exceptionCode, cause } = {}) {
    super(message, { host, cause })
    this.name = 'MeterModbusException'
    this.exceptionCode = exceptionCode
  }
}

export class ION8650ModbusClient {
  #host
  #port
  #unitId
  #offset
  #register
  #wordOrder
  #decode
  #scale
  #timeoutMs
  #client
  #connected = false
  #connecting = null
  #queue = Promise.resolve()

  // Acepta e ignora user/password/opPath/agent para que el clientFactory del poller pueda
  // pasarle el mismo objeto de opciones que al cliente HTTP sin romper.
  constructor({
    host,
    port = DEFAULT_PORT,
    unitId = DEFAULT_UNIT_ID,
    register = DEFAULT_REGISTER,
    wordOrder = DEFAULT_WORD_ORDER,
    decode = DEFAULT_DECODE,
    scale = DEFAULT_SCALE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    modbusFactory,
  } = {}) {
    if (!host) throw new TypeError('ION8650ModbusClient: host required')
    if (!Number.isInteger(register) || register < MODBUS_BASE) {
      throw new TypeError(`ION8650ModbusClient: register inválido '${register}' (esperado 4xxxx)`)
    }
    if (wordOrder !== 'high' && wordOrder !== 'low') {
      throw new TypeError(`ION8650ModbusClient: wordOrder inválido '${wordOrder}' (high|low)`)
    }
    if (decode !== 'int32' && decode !== 'float32') {
      throw new TypeError(`ION8650ModbusClient: decode inválido '${decode}' (int32|float32)`)
    }

    this.#host = stripScheme(host)
    this.#port = port
    this.#unitId = unitId
    this.#register = register
    this.#offset = register - MODBUS_BASE
    this.#wordOrder = wordOrder
    this.#decode = decode
    this.#scale = scale
    this.#timeoutMs = timeoutMs
    this.#client = (modbusFactory ?? (() => new ModbusRTU()))()
  }

  get host() { return this.#host }

  async fetchKwTotal() {
    // Serializa las llamadas: modbus-serial no soporta requests concurrentes sobre un
    // mismo socket. El poller ya hace 1 fetch/medidor por tick, así que la cola casi
    // nunca encola; es defensa en profundidad.
    const run = this.#queue.then(() => this.#doFetch())
    this.#queue = run.catch(() => {})
    return run
  }

  async #doFetch() {
    const startedAt = Date.now()
    await this.#ensureConnected()

    let res
    try {
      this.#client.setID(this.#unitId)
      this.#client.setTimeout(this.#timeoutMs)
      res = await this.#client.readHoldingRegisters(this.#offset, 2)
    } catch (err) {
      this.#markDisconnected()
      throw this.#mapError(err)
    }

    const buf = res?.buffer
    if (!Buffer.isBuffer(buf) || buf.length < 4) {
      throw new MeterFormatError(
        `Respuesta Modbus sin 4 bytes (host=${this.#host} reg=${this.#register} len=${buf?.length})`,
        { host: this.#host },
      )
    }

    const raw = decodeRegisters(buf, this.#wordOrder, this.#decode)
    const kw = raw / this.#scale
    if (!Number.isFinite(kw)) {
      throw new MeterFormatError(
        `Valor Modbus no finito (host=${this.#host} reg=${this.#register} raw=${raw})`,
        { host: this.#host },
      )
    }
    return { kw, fetchedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt }
  }

  async #ensureConnected() {
    if (this.#connected && this.#client.isOpen) return
    if (this.#connecting) return this.#connecting

    this.#connecting = (async () => {
      try {
        if (this.#client.isOpen) { this.#connected = true; return }
        await withTimeout(
          this.#client.connectTCP(this.#host, { port: this.#port }),
          this.#timeoutMs,
          () => this.#abortConnect(),
        )
        this.#connected = true
      } catch (err) {
        this.#markDisconnected()
        throw this.#mapError(err)
      } finally {
        this.#connecting = null
      }
    })()
    return this.#connecting
  }

  #abortConnect() {
    try { this.#client.close(() => {}) } catch { /* ignore */ }
  }

  #markDisconnected() {
    this.#connected = false
    try { this.#client.close(() => {}) } catch { /* ignore */ }
  }

  #mapError(err) {
    if (err instanceof MeterError) return err
    // Excepción de protocolo Modbus: modbus-serial expone err.modbusCode.
    const code = err?.modbusCode
    if (code != null) {
      return new MeterModbusException(
        `Modbus exception ${code} at ${this.#host}:${this.#port} (unit=${this.#unitId} reg=${this.#register})`,
        { host: this.#host, exceptionCode: code, cause: err },
      )
    }
    if (TIMEOUT_CODES.has(err?.code) || /timed?\s?out/i.test(err?.message ?? '') ||
        err?.name === 'TransactionTimedOutError' || err?.name === 'TimeoutError') {
      return new MeterTimeoutError(
        `Timeout (${this.#timeoutMs}ms) Modbus ${this.#host}:${this.#port}`,
        { host: this.#host, cause: err },
      )
    }
    if (NET_ERROR_CODES.has(err?.code)) {
      return new MeterError(
        `Error de red Modbus ${this.#host}:${this.#port}: ${err.code}`,
        { host: this.#host, cause: err },
      )
    }
    return new MeterError(
      `Error Modbus ${this.#host}:${this.#port}: ${err?.message ?? err}`,
      { host: this.#host, cause: err },
    )
  }

  async close() {
    this.#connected = false
    await new Promise((resolve) => {
      try { this.#client.close(() => resolve()) } catch { resolve() }
    })
  }
}

// ─── Helpers de decode (exportados para reuso en probe-modbus.js) ─────────────

// El buffer de readHoldingRegisters viene como [r0_hi, r0_lo, r1_hi, r1_lo]
// (big-endian intra-registro). wordOrder solo intercambia las dos palabras de 16 bits:
//   'high' (ABCD): r0 es la palabra alta → buffer tal cual.
//   'low'  (CDAB): r0 es la palabra baja → swap [r1, r0].
export function orderBuffer(buf4, wordOrder) {
  if (wordOrder === 'low') {
    return Buffer.from([buf4[2], buf4[3], buf4[0], buf4[1]])
  }
  return Buffer.from([buf4[0], buf4[1], buf4[2], buf4[3]])
}

export function decodeRegisters(buf4, wordOrder, decode) {
  const b = orderBuffer(buf4, wordOrder)
  return decode === 'float32' ? b.readFloatBE(0) : b.readInt32BE(0)
}

function stripScheme(host) {
  // Los hosts en config.js son IPs desnudas, pero por robustez quitamos un scheme
  // http(s):// accidental y cualquier path. El puerto va aparte (param `port`).
  return String(host).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
}

function withTimeout(promise, ms, onTimeout) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) onTimeout()
      const e = new Error(`connect timed out (${ms}ms)`)
      e.code = 'ETIMEDOUT'
      reject(e)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
