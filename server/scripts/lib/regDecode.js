// Decodificadores de los dos formatos con que el ION8650 publica los mismos acumuladores de
// energía, y el catálogo de qué registro lleva qué magnitud.
//
// El medidor expone las MISMAS magnitudes en dos bancos con codificación distinta:
//
//   Banco A — 40230..40238, formato "kWh/kVArh", INT32 binario clásico (base 65536).
//   Banco B — 40091..40105, formato "Energy/THD", INT32-M10K (base 10000).
//
// Mod10K NO es un INT32: cada registro de 16 bits lleva un grupo de 4 dígitos DECIMALES, así
// que el valor es w0·10000 + w1, no w0·65536 + w1. Leer un registro Mod10K como INT32 da un
// número plausible pero equivocado, y —peor— a veces acierta: mientras w0 no cambie, el
// INCREMENTO de las dos lecturas coincide, y solo se rompe cuando w1 da la vuelta.

export const MOD10K_MAX = 0x7fff * 10000 + 9999   // 327.679.999

// ─── Decodificadores ──────────────────────────────────────────────────────────

export function decodeInt32(w0, w1) {
  return { value: ((w0 << 16) | w1) | 0, saturated: false, malformed: false }
}

// Mod10K de 2 registros. El bit 15 de w0 es el signo; el resto de w0 son los dígitos altos.
// Saturación: el medidor publica 0x7FFF/0 (o 0x8001/0 en negativo) cuando el acumulador ya no
// cabe en el formato. Es un valor CENTINELA, no una medida: hay que detectarlo, porque si se
// toma por bueno el contador parece congelado y su Δ da cero para siempre.
export function decodeMod10k(w0, w1) {
  const negativo = (w0 & 0x8000) !== 0
  const altos = w0 & 0x7fff
  const saturated = (altos === 0x7fff && w1 === 0) || (negativo && altos === 1 && w1 === 0)
  // w1 solo puede llevar 4 dígitos decimales: por encima de 9999 la palabra no es Mod10K
  // válido (registro mal mapeado, o el medidor publicando otra cosa en esa dirección).
  const malformed = w1 > 9999
  const magnitud = altos * 10000 + w1
  return { value: negativo ? -magnitud : magnitud, saturated, malformed }
}

export function decodeReg(formato, w0, w1) {
  return formato === 'm10k' ? decodeMod10k(w0, w1) : decodeInt32(w0, w1)
}

// ─── Catálogo de registros ────────────────────────────────────────────────────
// `off` = offset 0-based del protocolo = registro documentado − 40001.

export const BANCO_A = [
  { reg: 40230, off: 229, magnitud: 'kWh del',       formato: 'int32', banco: 'A' },
  { reg: 40232, off: 231, magnitud: 'kWh rec',       formato: 'int32', banco: 'A' },
  { reg: 40234, off: 233, magnitud: 'kVARh del',     formato: 'int32', banco: 'A' },
  { reg: 40236, off: 235, magnitud: 'kVARh rec',     formato: 'int32', banco: 'A' },
  { reg: 40238, off: 237, magnitud: 'kVAh del+rec',  formato: 'int32', banco: 'A' },
]

export const BANCO_B = [
  { reg: 40091, off: 90,  magnitud: 'kWh del',       formato: 'm10k', banco: 'B' },
  { reg: 40093, off: 92,  magnitud: 'kWh rec',       formato: 'm10k', banco: 'B' },
  { reg: 40095, off: 94,  magnitud: 'kWh del+rec',   formato: 'm10k', banco: 'B' },
  { reg: 40097, off: 96,  magnitud: 'kWh del-rec',   formato: 'm10k', banco: 'B' },
  { reg: 40099, off: 98,  magnitud: 'kVARh del',     formato: 'm10k', banco: 'B' },
  { reg: 40101, off: 100, magnitud: 'kVARh rec',     formato: 'm10k', banco: 'B' },
  { reg: 40103, off: 102, magnitud: 'kVARh del+rec', formato: 'm10k', banco: 'B' },
  { reg: 40105, off: 104, magnitud: 'kVARh del-rec', formato: 'm10k', banco: 'B' },
]

export const REGISTROS = [...BANCO_A, ...BANCO_B]

// Magnitudes que existen en los DOS bancos: son las que se pueden poner lado a lado.
// Las demás (kVAh del+rec solo en A; del+rec y del-rec de kWh/kVARh solo en B) se informan
// aparte, porque no tienen contraparte contra la cual compararse.
export const PARES = [
  { magnitud: 'kWh del',   a: 40230, b: 40091 },
  { magnitud: 'kWh rec',   a: 40232, b: 40093 },
  { magnitud: 'kVARh del', a: 40234, b: 40099 },
  { magnitud: 'kVARh rec', a: 40236, b: 40101 },
]

// Identidades internas del banco B: si el decodificador es correcto, se cumplen exactamente.
// Es la mejor verificación disponible, porque no depende de ninguna referencia externa.
export const IDENTIDADES = [
  { nombre: 'kWh del+rec = del + rec',   resultado: 40095, terminos: [[40091, 1], [40093, 1]] },
  { nombre: 'kWh del−rec = del − rec',   resultado: 40097, terminos: [[40091, 1], [40093, -1]] },
  { nombre: 'kVARh del+rec = del + rec', resultado: 40103, terminos: [[40099, 1], [40101, 1]] },
  { nombre: 'kVARh del−rec = del − rec', resultado: 40105, terminos: [[40099, 1], [40101, -1]] },
]

// Bloques contiguos a leer por tick. Un solo FC03 por bloque en vez de uno por registro:
// 3 lecturas por medidor por tick en lugar de 14.
export const BLOQUES = [
  { off: 90,  len: 16 },   // banco B completo (40091..40106)
  { off: 229, len: 10 },   // banco A completo (40230..40239)
  { off: 203, len: 2 },    // 40204 kW tot — referencia independiente para integrar
]

export function palabrasDe(bloques, off) {
  for (const b of bloques) {
    if (off >= b.off && off + 1 < b.off + b.len) {
      const i = off - b.off
      return [b.data[i], b.data[i + 1]]
    }
  }
  return null
}
