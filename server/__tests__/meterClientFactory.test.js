import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMeterClientFactory } from '../meterClientFactory.js'
import { ION8650ModbusClient } from '../meterModbusClient.js'

const MODBUS = { port: 502, unitId: 1, register: 40204, wordOrder: 'high', decode: 'int32', scale: 1000 }

// UNITS mínimo con el shape real (incluye _ipKey, como lo arma config.js).
const UNITS = [
  { id: 'TGJ1', label: 'GUAJIRA 1', maxMW: 145, meters: [{ host: '10.0.0.40', user: 'u', password: 'p', _ipKey: 'IP_TGJ1' }] },
  { id: 'GEC3', label: 'GECELCA 3', maxMW: 164, meters: [
    { host: '10.0.0.5', user: 'u', password: 'p', _ipKey: 'IP_GEC3_1' },
    { host: '10.0.0.6', user: 'u', password: 'p', _ipKey: 'IP_GEC3_2' },
  ] },
]

function pollerOpts(host) {
  return { host, user: 'u', password: 'p', opPath: '/Operation.html', timeoutMs: 4000, agent: {} }
}

describe('createMeterClientFactory', () => {
  const saved = {}
  beforeEach(() => { for (const k of Object.keys(process.env)) if (k.startsWith('MB_UNIT_')) { saved[k] = process.env[k]; delete process.env[k] } })
  afterEach(() => { for (const [k, v] of Object.entries(saved)) process.env[k] = v })

  it('returns undefined for protocol http (poller usa su default HTTP)', () => {
    expect(createMeterClientFactory({ protocol: 'http', modbus: MODBUS, units: UNITS })).toBeUndefined()
  })

  it('returns undefined for any non-modbus protocol', () => {
    expect(createMeterClientFactory({ protocol: undefined, modbus: MODBUS, units: UNITS })).toBeUndefined()
  })

  it('produces ION8650ModbusClient instances per host', () => {
    const factory = createMeterClientFactory({ protocol: 'modbus', modbus: MODBUS, units: UNITS })
    const c = factory(pollerOpts('10.0.0.40'))
    expect(c).toBeInstanceOf(ION8650ModbusClient)
    expect(c.host).toBe('10.0.0.40')
  })

  it('passes the global modbus config (register/word/scale) and unitId to each client', () => {
    const calls = []
    const spy = class { constructor(opts) { calls.push(opts) } get host() { return this._h } }
    const factory = createMeterClientFactory({ protocol: 'modbus', modbus: MODBUS, units: UNITS, clientCtor: spy })
    factory(pollerOpts('10.0.0.5'))
    expect(calls[0]).toMatchObject({
      host: '10.0.0.5', register: 40204, wordOrder: 'high', decode: 'int32', scale: 1000, unitId: 1,
    })
  })

  it('honors per-meter unitId override MB_UNIT_<ipKey>', () => {
    process.env.MB_UNIT_IP_GEC3_2 = '100'
    const calls = []
    const spy = class { constructor(opts) { calls.push(opts) } }
    const factory = createMeterClientFactory({ protocol: 'modbus', modbus: MODBUS, units: UNITS, clientCtor: spy })
    factory(pollerOpts('10.0.0.5'))   // IP_GEC3_1 → unitId global 1
    factory(pollerOpts('10.0.0.6'))   // IP_GEC3_2 → override 100
    expect(calls.find((c) => c.host === '10.0.0.5').unitId).toBe(1)
    expect(calls.find((c) => c.host === '10.0.0.6').unitId).toBe(100)
  })

  it('falls back to global modbus config for an unknown host', () => {
    const calls = []
    const spy = class { constructor(opts) { calls.push(opts) } }
    const factory = createMeterClientFactory({ protocol: 'modbus', modbus: MODBUS, units: UNITS, clientCtor: spy })
    factory(pollerOpts('10.9.9.9'))
    expect(calls[0]).toMatchObject({ host: '10.9.9.9', unitId: 1, register: 40204 })
  })
})
