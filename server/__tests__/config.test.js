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

describe('config — sin fallback PME (D-126)', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(METER_ENV)) vi.stubEnv(k, v)
    vi.stubEnv('CONFIG_SKIP_VALIDATION', '')
    vi.stubEnv('METER_PROTOCOL', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('el módulo carga solo con las variables de medidores', async () => {
    const cfg = await loadConfig()
    expect(cfg.UNITS).toHaveLength(4)
  })

  it('no exporta PME ni PME_ENABLED', async () => {
    const cfg = await loadConfig()
    expect(cfg.PME).toBeUndefined()
    expect(cfg.PME_ENABLED).toBeUndefined()
  })

  it('PME_ENABLED=1 en el env es inerte: ya no hay flag que encender', async () => {
    vi.stubEnv('PME_ENABLED', '1')
    const cfg = await loadConfig()   // no debe lanzar por PME_PASSWORD ausente
    expect(cfg.UNITS).toHaveLength(4)
    expect(cfg.PME_ENABLED).toBeUndefined()
  })

  it('las unidades ya no llevan config pme', async () => {
    const cfg = await loadConfig()
    for (const u of cfg.UNITS) {
      expect(u).not.toHaveProperty('pme')
    }
  })

  it('faltando una IP de medidor la validación fail-fast sigue lanzando', async () => {
    vi.stubEnv('IP_TGJ1', '')
    await expect(loadConfig()).rejects.toThrow(/IP_TGJ1/)
  })
})

describe('config — METER_PROTOCOL default modbus (D-120)', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(METER_ENV)) vi.stubEnv(k, v)
    vi.stubEnv('CONFIG_SKIP_VALIDATION', '')
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
