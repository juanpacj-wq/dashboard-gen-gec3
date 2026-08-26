import { describe, it, expect } from 'vitest'
import {
  decodeInt32, decodeMod10k, decodeReg, palabrasDe,
  BANCO_A, BANCO_B, PARES, IDENTIDADES, MOD10K_MAX,
} from '../scripts/lib/regDecode.js'

describe('decodeInt32', () => {
  it('combina en base 65536', () => {
    // Lectura real de GEC32 primaria, registro 40230 (kWh del).
    expect(decodeInt32(114, 5036).value).toBe(7_476_140)
  })

  it('entrega negativos nativos (complemento a dos)', () => {
    expect(decodeInt32(0xffff, 0xffff).value).toBe(-1)
  })
})

describe('decodeMod10k', () => {
  it('combina en base 10000, NO en base 65536', () => {
    // Mismo instante y mismo medidor que el test de arriba, registro 40091 (kWh del).
    // El banco B lo publica como [747, 6140] y debe dar el MISMO número que el banco A.
    expect(decodeMod10k(747, 6140).value).toBe(7_476_140)
    // Leerlo como INT32 daría 48.961.532: plausible, y equivocado.
    expect(decodeInt32(747, 6140).value).toBe(48_961_532)
  })

  it('reproduce las 4 magnitudes que los dos bancos comparten (lectura real de GEC32)', () => {
    const casos = [
      ['kWh del',   [114, 5036],  [747, 6140],  7_476_140],
      ['kWh rec',   [74, 7470],   [485, 7134],  4_857_134],
      ['kVARh del', [42, 23582],  [277, 6094],  2_776_094],
      ['kVARh rec', [99, 11699],  [649, 9763],  6_499_763],
    ]
    for (const [, a, b, esperado] of casos) {
      expect(decodeInt32(...a).value).toBe(esperado)
      expect(decodeMod10k(...b).value).toBe(esperado)
    }
  })

  it('admite w0 por encima de 9999 (el tope real es 0x7FFF, no 9999)', () => {
    // GEC3_1 registro 40099 kVARh del: [16636, 8832]. Coincide con el banco A (40234).
    expect(decodeMod10k(16636, 8832).value).toBe(166_368_832)
    expect(decodeInt32(2538, 38464).value).toBe(166_368_832)
    expect(MOD10K_MAX).toBe(327_679_999)
  })

  it('detecta la saturación positiva (centinela 0x7FFF/0)', () => {
    // GEC3_1 registro 40093: el acumulador real (460.042.848 según el banco A) ya no cabe.
    const d = decodeMod10k(32767, 0)
    expect(d.saturated).toBe(true)
    // El valor que devuelve NO es una medida: es el tope del formato.
    expect(d.value).toBe(327_670_000)
  })

  it('detecta la saturación negativa (centinela 0x8001/0)', () => {
    const d = decodeMod10k(32769, 0)
    expect(d.saturated).toBe(true)
    expect(d.value).toBeLessThan(0)
  })

  it('marca como malformada una palabra baja con más de 4 dígitos decimales', () => {
    // GEC32 registro 40097 devuelve [64798, 64542]: w1=64542 no es Mod10K válido.
    expect(decodeMod10k(64798, 64542).malformed).toBe(true)
    // Una lectura sana no se marca.
    expect(decodeMod10k(747, 6140).malformed).toBe(false)
  })

  it('aplica el signo desde el bit 15 de la palabra alta', () => {
    expect(decodeMod10k(0x8000 | 261, 9006).value).toBe(-2_619_006)
    expect(decodeMod10k(261, 9006).value).toBe(2_619_006)
  })

  it('el cero se decodifica como cero y no como saturado', () => {
    expect(decodeMod10k(0, 0)).toMatchObject({ value: 0, saturated: false, malformed: false })
  })
})

describe('decodeReg', () => {
  it('despacha por formato', () => {
    expect(decodeReg('m10k', 747, 6140).value).toBe(7_476_140)
    expect(decodeReg('int32', 114, 5036).value).toBe(7_476_140)
  })
})

describe('catálogo', () => {
  it('los offsets son el registro documentado menos 40001', () => {
    for (const r of [...BANCO_A, ...BANCO_B]) {
      expect(r.off).toBe(r.reg - 40001)
    }
  })

  it('cada par apunta a un registro que existe en su banco y a la misma magnitud', () => {
    for (const p of PARES) {
      const a = BANCO_A.find((r) => r.reg === p.a)
      const b = BANCO_B.find((r) => r.reg === p.b)
      expect(a, `banco A sin ${p.a}`).toBeTruthy()
      expect(b, `banco B sin ${p.b}`).toBeTruthy()
      expect(a.magnitud).toBe(p.magnitud)
      expect(b.magnitud).toBe(p.magnitud)
    }
  })

  it('las identidades solo referencian registros del banco B', () => {
    const regsB = new Set(BANCO_B.map((r) => r.reg))
    for (const id of IDENTIDADES) {
      expect(regsB.has(id.resultado)).toBe(true)
      for (const [reg] of id.terminos) expect(regsB.has(reg)).toBe(true)
    }
  })
})

describe('palabrasDe', () => {
  const bloques = [
    { off: 90, len: 16, data: Array.from({ length: 16 }, (_, i) => 100 + i) },
    { off: 229, len: 10, data: Array.from({ length: 10 }, (_, i) => 200 + i) },
  ]

  it('extrae el par de palabras del bloque que lo contiene', () => {
    expect(palabrasDe(bloques, 90)).toEqual([100, 101])
    expect(palabrasDe(bloques, 104)).toEqual([114, 115])
    expect(palabrasDe(bloques, 229)).toEqual([200, 201])
  })

  it('devuelve null si el par no cabe entero en ningún bloque', () => {
    expect(palabrasDe(bloques, 105)).toBeNull()   // 105 está, pero 106 no
    expect(palabrasDe(bloques, 500)).toBeNull()
  })
})
