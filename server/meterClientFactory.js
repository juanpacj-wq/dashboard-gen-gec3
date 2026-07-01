import { ION8650ModbusClient } from './meterModbusClient.js'

// Selecciona el cliente de extracción primaria según METER_PROTOCOL (D-118).
// Devuelve un clientFactory para MeterPoller, o `undefined` cuando el protocolo es 'http'
// (así el poller usa su defaultClientFactory = ION8650Client HTTP, sin cambios).
//
// El factory que invoca el poller recibe solo { host, user, password, opPath, timeoutMs,
// agent } (meterPoller.js:73) — NO el unitId del medidor. Por eso precomputamos un mapa
// host → config Modbus desde UNITS, resolviendo override per-medidor MB_UNIT_<ipKey>.
export function createMeterClientFactory({ protocol, modbus, units, clientCtor = ION8650ModbusClient } = {}) {
  if (protocol !== 'modbus') return undefined

  const byHost = new Map()
  for (const unit of units) {
    for (const meter of unit.meters) {
      byHost.set(meter.host, { ...modbus, unitId: resolveUnitId(meter, modbus.unitId) })
    }
  }

  return (opts) => {
    const cfg = byHost.get(opts.host) ?? modbus
    return new clientCtor({ ...opts, ...cfg })
  }
}

// Override opcional de unitId por medidor vía env MB_UNIT_<ipKey> (ej. MB_UNIT_IP_GEC3_1).
// Útil si algún medidor quedara con un slave id distinto; default = unitId global.
function resolveUnitId(meter, fallback) {
  const key = meter?._ipKey ? `MB_UNIT_${meter._ipKey}` : null
  const raw = key ? parseInt(process.env[key], 10) : NaN
  return Number.isInteger(raw) ? raw : fallback
}
