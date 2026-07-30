import { describe, it, expect } from 'vitest'
import {
  MIN_GENERATION_MW,
  MIN_GENERATION_MWH,
  MIN_DEVIATION_PCT,
  clampGenerationMw,
  clampGenerationMwh,
  clampDeviationPct,
} from '../../shared/domain/generation.js'

// D-125: la generación nunca es negativa y la desviación nunca baja de -100%. Los helpers
// son null-safe a propósito: null es "sin lectura", no "cero" — un medidor muerto que
// reporte 0 MW reintroduciría la integración de energía que D-105/D-116 eliminaron.
describe('constantes de la invariante (D-125)', () => {
  it('los pisos son los acordados; cambiarlos rompe la suite', () => {
    expect(MIN_GENERATION_MW).toBe(0)
    expect(MIN_GENERATION_MWH).toBe(0)
    expect(MIN_DEVIATION_PCT).toBe(-100)
  })
})

describe('clampGenerationMw', () => {
  it('negativo de auxiliares → 0 (GEC32 parada consumiendo ≈ -14.7 MW)', () => {
    expect(clampGenerationMw(-14.7)).toBe(0)
  })

  it('-0 → 0 normalizado (Object.is(-0, 0) es false y confunde aguas abajo)', () => {
    const r = clampGenerationMw(-0)
    expect(r).toBe(0)
    expect(Object.is(r, 0)).toBe(true)
  })

  it('0 y positivos pasan sin tocar', () => {
    expect(clampGenerationMw(0)).toBe(0)
    expect(clampGenerationMw(72.8)).toBe(72.8)
  })

  it('sin lectura → null, nunca 0', () => {
    expect(clampGenerationMw(null)).toBeNull()
    expect(clampGenerationMw(undefined)).toBeNull()
    expect(clampGenerationMw(NaN)).toBeNull()
    expect(clampGenerationMw(Infinity)).toBeNull()
    expect(clampGenerationMw(-Infinity)).toBeNull()
  })

  it('tipos no numéricos → null (un string numérico no se convierte en silencio)', () => {
    expect(clampGenerationMw('5')).toBeNull()
    expect(clampGenerationMw('-14.7')).toBeNull()
    expect(clampGenerationMw({})).toBeNull()
    expect(clampGenerationMw(true)).toBeNull()
  })
})

describe('clampGenerationMwh', () => {
  it('energía negativa del integrador → MIN_GENERATION_MWH', () => {
    expect(clampGenerationMwh(-14.792992)).toBe(MIN_GENERATION_MWH)
  })

  it('-0 → 0 normalizado', () => {
    const r = clampGenerationMwh(-0)
    expect(r).toBe(0)
    expect(Object.is(r, 0)).toBe(true)
  })

  it('0 y positivos pasan sin tocar', () => {
    expect(clampGenerationMwh(0)).toBe(0)
    expect(clampGenerationMwh(72.8)).toBe(72.8)
  })

  it('sin lectura → null, nunca 0', () => {
    expect(clampGenerationMwh(null)).toBeNull()
    expect(clampGenerationMwh(undefined)).toBeNull()
    expect(clampGenerationMwh(NaN)).toBeNull()
    expect(clampGenerationMwh(Infinity)).toBeNull()
    expect(clampGenerationMwh(-Infinity)).toBeNull()
  })

  it('tipos no numéricos → null', () => {
    expect(clampGenerationMwh('5')).toBeNull()
    expect(clampGenerationMwh({})).toBeNull()
    expect(clampGenerationMwh(true)).toBeNull()
  })
})

describe('clampDeviationPct', () => {
  // Caso testigo real: GEC32, 2026-07-30 periodo 8. gen=-14.792992 MWh contra un despacho
  // final de 35 MW dio -142.27% en desviacion_periodos, mientras la misma fila en
  // proyeccion_periodos ya decía -100. Esa asimetría es el bug que abrió D-125.
  // El literal que quedó anotado en _CONTEXTO-BASE.md (-142.26569149040793) sale del
  // generacion_mwh con toda su precisión FLOAT en BD; con el valor truncado a 6 decimales
  // la aritmética da -142.26569142857142. Se prueban los dos: el clamp no distingue.
  it('el -142.27% de GEC32 (2026-07-30 p8) queda en -100', () => {
    const desviacionCruda = ((-14.792992 - 35) / 35) * 100
    expect(desviacionCruda).toBeCloseTo(-142.2656914, 6)
    expect(clampDeviationPct(desviacionCruda)).toBe(-100)
    expect(clampDeviationPct(-142.26569149040793)).toBe(-100)
  })

  it('-100 exacto se conserva; -99.5 no se toca', () => {
    expect(clampDeviationPct(-100)).toBe(-100)
    expect(clampDeviationPct(-99.5)).toBe(-99.5)
  })

  it('0 y positivos pasan sin tocar', () => {
    expect(clampDeviationPct(0)).toBe(0)
    expect(clampDeviationPct(12.3)).toBe(12.3)
  })

  it('-0 → 0 normalizado', () => {
    const r = clampDeviationPct(-0)
    expect(r).toBe(0)
    expect(Object.is(r, 0)).toBe(true)
  })

  it('sin valor → null (no hay desviación fabricada)', () => {
    expect(clampDeviationPct(null)).toBeNull()
    expect(clampDeviationPct(undefined)).toBeNull()
    expect(clampDeviationPct(NaN)).toBeNull()
    expect(clampDeviationPct(-Infinity)).toBeNull()
  })

  it('tipos no numéricos → null', () => {
    expect(clampDeviationPct('-142.27')).toBeNull()
    expect(clampDeviationPct({})).toBeNull()
  })
})
