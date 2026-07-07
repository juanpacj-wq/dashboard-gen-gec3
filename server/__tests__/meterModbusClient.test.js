import { describe, it, expect } from 'vitest'
import {
  ION8650ModbusClient,
  MeterModbusException,
  decodeRegisters,
  orderBuffer,
} from '../meterModbusClient.js'
import { MeterError, MeterTimeoutError, MeterFormatError } from '../meterClient.js'

// ─── Fake de modbus-serial inyectable (análogo al clientFactory de meterPoller.test) ──
function makeFakeModbus(behavior = {}) {
  const calls = { setID: [], setTimeout: [], readHoldingRegisters: [], connectTCP: [], close: 0 }
  const fake = {
    isOpen: false,
    calls,
    setID(id) { calls.setID.push(id) },
    setTimeout(ms) { calls.setTimeout.push(ms) },
    connectTCP(host, opts) {
      calls.connectTCP.push({ host, opts })
      if (behavior.connectError) return Promise.reject(behavior.connectError)
      fake.isOpen = true
      return Promise.resolve()
    },
    readHoldingRegisters(addr, len) {
      calls.readHoldingRegisters.push({ addr, len })
      if (behavior.readError) return Promise.reject(behavior.readError)
      return Promise.resolve(behavior.readResult)
    },
    close(cb) { calls.close++; fake.isOpen = false; if (cb) cb() },
  }
  return fake
}

function int32Buf(value) {
  const b = Buffer.alloc(4)
  b.writeInt32BE(value, 0)
  return b
}

function clientWith(fake, opts = {}) {
  return new ION8650ModbusClient({
    host: '192.168.200.5',
    unitId: 1,
    register: 40204,
    wordOrder: 'high',
    decode: 'int32',
    scale: 1000,
    timeoutMs: 1000,
    modbusFactory: () => fake,
    ...opts,
  })
}

// ─── Decode helpers (pura, sin red) ───────────────────────────────────────────
describe('decodeRegisters / orderBuffer', () => {
  it('decodes INT32 high-word-first (5240040 → /1000 = 5240.04)', () => {
    const buf = int32Buf(5240040)
    expect(decodeRegisters(buf, 'high', 'int32')).toBe(5240040)
  })

  it('low word order swaps the two 16-bit words', () => {
    const hi = int32Buf(5240040)            // [b0,b1,b2,b3] high-first
    const swapped = Buffer.from([hi[2], hi[3], hi[0], hi[1]]) // device envió low-first
    expect(decodeRegisters(swapped, 'low', 'int32')).toBe(5240040)
    // y high sobre el swapped daría OTRA cosa (prueba de que el orden importa)
    expect(decodeRegisters(swapped, 'high', 'int32')).not.toBe(5240040)
  })

  it('decodes negative INT32 natively (Gecelca pre-inversión)', () => {
    expect(decodeRegisters(int32Buf(-5500), 'high', 'int32')).toBe(-5500)
  })

  it('orderBuffer high is identity, low swaps words', () => {
    const b = Buffer.from([1, 2, 3, 4])
    expect([...orderBuffer(b, 'high')]).toEqual([1, 2, 3, 4])
    expect([...orderBuffer(b, 'low')]).toEqual([3, 4, 1, 2])
  })
})

// ─── Constructor ───────────────────────────────────────────────────────────────
describe('ION8650ModbusClient constructor', () => {
  it('throws when host missing', () => {
    expect(() => new ION8650ModbusClient({ register: 40204 })).toThrow(TypeError)
  })
  it('throws on invalid register', () => {
    expect(() => new ION8650ModbusClient({ host: 'h', register: 5 })).toThrow(TypeError)
  })
  it('throws on invalid wordOrder', () => {
    expect(() => new ION8650ModbusClient({ host: 'h', wordOrder: 'mid' })).toThrow(TypeError)
  })
  it('throws on invalid decode', () => {
    expect(() => new ION8650ModbusClient({ host: 'h', decode: 'int16' })).toThrow(TypeError)
  })
  it('accepts and ignores HTTP-style extras (user/password/opPath/agent)', () => {
    expect(() => new ION8650ModbusClient({
      host: 'h', user: 'u', password: 'p', opPath: '/x', agent: {},
      modbusFactory: () => makeFakeModbus(),
    })).not.toThrow()
  })
  it('strips an accidental scheme from host', () => {
    const c = new ION8650ModbusClient({ host: 'http://10.0.0.1/', modbusFactory: () => makeFakeModbus() })
    expect(c.host).toBe('10.0.0.1')
  })
})

// ─── fetchKwTotal (modbus mockeado) ────────────────────────────────────────────
describe('ION8650ModbusClient.fetchKwTotal', () => {
  it('returns { kw, fetchedAt, latencyMs } decoding INT32 /1000', async () => {
    const fake = makeFakeModbus({ readResult: { buffer: int32Buf(5240040) } })
    const client = clientWith(fake)
    const res = await client.fetchKwTotal()
    expect(res.kw).toBeCloseTo(5240.04, 5)
    expect(typeof res.fetchedAt).toBe('string')
    expect(typeof res.latencyMs).toBe('number')
    await client.close()
  })

  it('reads the correct offset (40204 → 203), qty 2, and sets unitId', async () => {
    const fake = makeFakeModbus({ readResult: { buffer: int32Buf(1000) } })
    const client = clientWith(fake, { unitId: 100 })
    await client.fetchKwTotal()
    expect(fake.calls.readHoldingRegisters[0]).toEqual({ addr: 203, len: 2 })
    expect(fake.calls.setID).toContain(100)
    expect(fake.calls.connectTCP[0].opts).toEqual({ port: 502 })
    await client.close()
  })

  it('uses offset 32 for register 40033', async () => {
    const fake = makeFakeModbus({ readResult: { buffer: int32Buf(1402) } })
    const client = clientWith(fake, { register: 40033, scale: 10 })
    const res = await client.fetchKwTotal()
    expect(fake.calls.readHoldingRegisters[0].addr).toBe(32)
    expect(res.kw).toBeCloseTo(140.2, 5)
    await client.close()
  })

  it('accepts zero kW as valid (no error)', async () => {
    const fake = makeFakeModbus({ readResult: { buffer: int32Buf(0) } })
    const client = clientWith(fake)
    const res = await client.fetchKwTotal()
    expect(res.kw).toBe(0)
    await client.close()
  })

  it('returns negative kW natively', async () => {
    const fake = makeFakeModbus({ readResult: { buffer: int32Buf(-740000) } })
    const client = clientWith(fake)
    const res = await client.fetchKwTotal()
    expect(res.kw).toBeCloseTo(-740, 5)
    await client.close()
  })

  it('maps a Modbus exception (0x02) to MeterModbusException with exceptionCode', async () => {
    const err = new Error('Illegal data address')
    err.modbusCode = 2
    const fake = makeFakeModbus({ readError: err })
    const client = clientWith(fake)
    await expect(client.fetchKwTotal()).rejects.toMatchObject({
      name: 'MeterModbusException',
      exceptionCode: 2,
    })
    await expect(client.fetchKwTotal()).rejects.toBeInstanceOf(MeterModbusException)
    await client.close()
  })

  it('maps a read timeout to MeterTimeoutError', async () => {
    const err = new Error('Timed out')
    err.name = 'TransactionTimedOutError'
    const fake = makeFakeModbus({ readError: err })
    const client = clientWith(fake)
    await expect(client.fetchKwTotal()).rejects.toBeInstanceOf(MeterTimeoutError)
    await client.close()
  })

  it('maps ECONNREFUSED on connect to MeterError (not timeout/exception)', async () => {
    const err = new Error('connect ECONNREFUSED')
    err.code = 'ECONNREFUSED'
    const fake = makeFakeModbus({ connectError: err })
    const client = clientWith(fake)
    const rejection = client.fetchKwTotal()
    await expect(rejection).rejects.toBeInstanceOf(MeterError)
    await expect(rejection).rejects.not.toBeInstanceOf(MeterTimeoutError)
    await client.close()
  })

  it('throws MeterFormatError when the buffer is too short', async () => {
    const fake = makeFakeModbus({ readResult: { buffer: Buffer.from([0x00, 0x01]) } })
    const client = clientWith(fake)
    await expect(client.fetchKwTotal()).rejects.toBeInstanceOf(MeterFormatError)
    await client.close()
  })

  it('reconnects on the next call after a socket error', async () => {
    // Fake que falla la 1ª lectura (ECONNRESET) y acierta la 2ª.
    let reads = 0
    const calls = { connectTCP: 0, close: 0 }
    const fake = {
      isOpen: false,
      setID() {}, setTimeout() {},
      connectTCP() { calls.connectTCP++; fake.isOpen = true; return Promise.resolve() },
      readHoldingRegisters() {
        reads++
        if (reads === 1) {
          const e = new Error('socket hang up'); e.code = 'ECONNRESET'
          return Promise.reject(e)
        }
        return Promise.resolve({ buffer: int32Buf(1000) })
      },
      close(cb) { calls.close++; fake.isOpen = false; if (cb) cb() },
    }
    const client = clientWith(fake, { modbusFactory: () => fake })

    await expect(client.fetchKwTotal()).rejects.toBeInstanceOf(MeterError)
    const res = await client.fetchKwTotal()       // debe reconectar y leer bien
    expect(res.kw).toBeCloseTo(1, 5)
    expect(calls.connectTCP).toBeGreaterThanOrEqual(2) // reconectó tras marcar desconexión
    await client.close()
  })

  it('recreates the modbus instance on disconnect (recovers from a wedged socket)', async () => {
    // Reproduce el incidente de prod: la 1ª instancia conecta, su socket muere en la
    // lectura y luego queda WEDGED — reconectar sobre ella falla para siempre. El fix
    // recrea la instancia vía la factory, así una instancia NUEVA sí conecta y lee.
    const instances = []
    let n = 0
    const factory = () => {
      const idx = n++
      const inst = {
        idx,
        isOpen: false,
        _connectedOnce: false,
        setID() {}, setTimeout() {},
        connectTCP() {
          // La instancia #0, una vez muerta, nunca vuelve a conectar (wedged).
          if (idx === 0 && inst._connectedOnce) {
            const e = new Error('wedged'); e.code = 'ECONNRESET'
            return Promise.reject(e)
          }
          inst._connectedOnce = true; inst.isOpen = true
          return Promise.resolve()
        },
        readHoldingRegisters() {
          if (idx === 0) { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; return Promise.reject(e) }
          return Promise.resolve({ buffer: int32Buf(1000) })
        },
        close(cb) { inst.isOpen = false; if (cb) cb() },
      }
      instances.push(inst)
      return inst
    }
    const client = new ION8650ModbusClient({
      host: '192.168.3.40', register: 40204, wordOrder: 'high', decode: 'int32',
      scale: 1000, timeoutMs: 1000, modbusFactory: factory,
    })

    // 1er fetch: la instancia #0 conecta pero la lectura muere (ECONNRESET).
    await expect(client.fetchKwTotal()).rejects.toBeInstanceOf(MeterError)
    // 2º fetch: SIN el fix reusaría #0 (wedged, connectTCP rechaza) y fallaría; CON el
    // fix usa la instancia #1 fresca y lee bien.
    const res = await client.fetchKwTotal()
    expect(res.kw).toBeCloseTo(1, 5)
    expect(instances.length).toBeGreaterThanOrEqual(2) // se recreó la instancia
    await client.close()
  })
})
