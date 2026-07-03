import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// config.js valida al CARGAR el módulo (fail-fast), así que cada caso resetea el
// registro de módulos, stubea el env y lo importa dinámicamente.

const METER_ENV = {
  USER_MEDIDORES: 'user1',
  IP_TGJ1: '10.0.0.1',  PSW_TGJ1: 'x',
  IP_TGJ2: '10.0.0.2',  PSW_TGJ2: 'x',
  IP_GEC32: '10.0.0.3', PSW_GEC32: 'x',
  IP_GEC3_1: '10.0.0.4', PSW_GEC3_1: 'x',
  IP_GEC3_2: '10.0.0.5', PSW_GEC3_2: 'x',
}

async function loadConfig() {
  vi.resetModules()
  return await import('../config.js')
}

describe('config — flag PME_ENABLED (D-120)', () => {
  beforeEach(() => {
    // Env limpio y completo para los medidores: aísla la validación del caso PME.
    for (const [k, v] of Object.entries(METER_ENV)) vi.stubEnv(k, v)
    vi.stubEnv('CONFIG_SKIP_VALIDATION', '')
    vi.stubEnv('PME_ENABLED', '')
    vi.stubEnv('PME_PASSWORD', '')
    vi.stubEnv('METER_PROTOCOL', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('sin PME_PASSWORD y sin PME_ENABLED el módulo carga (flag default apagado)', async () => {
    const cfg = await loadConfig()
    expect(cfg.PME_ENABLED).toBe(false)
    expect(cfg.UNITS).toHaveLength(4)
  })

  it('con PME_ENABLED=1 sin PME_PASSWORD la validación fail-fast lanza', async () => {
    vi.stubEnv('PME_ENABLED', '1')
    await expect(loadConfig()).rejects.toThrow(/PME_PASSWORD/)
  })

  it('con PME_ENABLED=1 y PME_PASSWORD presente carga y el flag queda encendido', async () => {
    vi.stubEnv('PME_ENABLED', '1')
    vi.stubEnv('PME_PASSWORD', 'secreto')
    const cfg = await loadConfig()
    expect(cfg.PME_ENABLED).toBe(true)
  })

  it('las 4 unidades conservan su config pme hardcodeada (rollback intacto)', async () => {
    const cfg = await loadConfig()
    for (const u of cfg.UNITS) {
      expect(u.pme).toEqual({ referencia: expect.any(String), occurrence: expect.any(Number) })
    }
  })
})

describe('config — METER_PROTOCOL default modbus (D-120)', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(METER_ENV)) vi.stubEnv(k, v)
    vi.stubEnv('CONFIG_SKIP_VALIDATION', '')
    vi.stubEnv('PME_ENABLED', '')
    vi.stubEnv('PME_PASSWORD', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('sin METER_PROTOCOL el default es modbus', async () => {
    vi.stubEnv('METER_PROTOCOL', '')
    const cfg = await loadConfig()
    expect(cfg.METER_DEFAULTS.protocol).toBe('modbus')
  })

  it('METER_PROTOCOL=http explícito se respeta (rollback sin código)', async () => {
    vi.stubEnv('METER_PROTOCOL', 'http')
    const cfg = await loadConfig()
    expect(cfg.METER_DEFAULTS.protocol).toBe('http')
  })
})
