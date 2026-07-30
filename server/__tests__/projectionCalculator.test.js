import { describe, it, expect } from 'vitest'
import { computeClosed, computeLive } from '../projectionCalculator.js'

// D-124: desviacion_periodos.desp_final_source es dato de auditoría — computeClosed debe
// registrar la fuente REAL de la fila de despacho_final ('email' | 'xm_fallback'), no un
// literal fijo. Denominador: despacho_final > redespacho (rDEC); 0 no es denominador válido.
describe('computeClosed — atribución de fuente y denominadores (D-124)', () => {
  it('fila email → source="email", desviación contra su valor', () => {
    const r = computeClosed({ generacionMwh: 95, despFinalMw: 100, despFinalSource: 'email', redespachoMw: 90 })
    expect(r.despFinalSource).toBe('email')
    expect(r.despFinalMw).toBe(100)
    expect(r.desviacionPct).toBeCloseTo(-5, 9)
  })

  it('fila xm_fallback → source="xm_fallback" (antes del fix se etiquetaba "email")', () => {
    const r = computeClosed({ generacionMwh: 95, despFinalMw: 100, despFinalSource: 'xm_fallback', redespachoMw: 90 })
    expect(r.despFinalSource).toBe('xm_fallback')
    expect(r.despFinalMw).toBe(100)
    expect(r.desviacionPct).toBeCloseTo(-5, 9)
  })

  it('sin fila de despacho_final → fallback a redespacho (rDEC)', () => {
    const r = computeClosed({ generacionMwh: 95, despFinalMw: null, despFinalSource: null, redespachoMw: 90 })
    expect(r.despFinalSource).toBe('redespacho')
    expect(r.despFinalMw).toBe(90)
    expect(r.desviacionPct).toBeCloseTo(((95 - 90) / 90) * 100, 9)
  })

  it('despFinalMw=0 no es denominador válido → cae a redespacho', () => {
    const r = computeClosed({ generacionMwh: 95, despFinalMw: 0, despFinalSource: 'email', redespachoMw: 90 })
    expect(r.despFinalSource).toBe('redespacho')
    expect(r.despFinalMw).toBe(90)
  })

  it('sin ningún denominador → todo null (sin desviación fabricada)', () => {
    const r = computeClosed({ generacionMwh: 95, despFinalMw: null, despFinalSource: null, redespachoMw: 0 })
    expect(r.despFinalSource).toBeNull()
    expect(r.despFinalMw).toBeNull()
    expect(r.desviacionPct).toBeNull()
    expect(r.generacionMwh).toBe(95)
  })

  it('fila sin source conocida → no fabrica "email": source=null con denominador válido', () => {
    const r = computeClosed({ generacionMwh: 95, despFinalMw: 100, despFinalSource: null, redespachoMw: 90 })
    expect(r.despFinalSource).toBeNull()
    expect(r.despFinalMw).toBe(100)
  })
})

// D-125: la generación nunca es negativa y la desviación nunca baja de -100%. computeClosed
// era la única fórmula de desviación del repo sin piso en el numerador; computeLive clampaba
// currentMw pero no el acumulado.
describe('computeClosed / computeLive — invariante de generación (D-125)', () => {
  // GEC32 2026-07-30 p8 — antes de D-125 esta fila daba -142.27% en desviacion_periodos
  // mientras proyeccion_periodos, escrita en el mismo callback, ya decía -100.
  it('el caso testigo (GEC32 p8): -14.79 MWh contra 35 MW ⇒ -100 y generación 0', () => {
    const r = computeClosed({
      generacionMwh: -14.792992021642776,
      despFinalMw: 35,
      despFinalSource: 'email',
      redespachoMw: 35,
    })
    expect(r.desviacionPct).toBe(-100)
    expect(r.generacionMwh).toBe(0)
    expect(r.despFinalSource).toBe('email')
  })

  it('los otros dos periodos del testigo (p9 y p10) también quedan en -100', () => {
    const p9 = computeClosed({ generacionMwh: -14.355453516392801, despFinalMw: 70, despFinalSource: 'email', redespachoMw: 70 })
    const p10 = computeClosed({ generacionMwh: -14.623243155310275, despFinalMw: 90, despFinalSource: 'email', redespachoMw: 90 })
    expect(p9.desviacionPct).toBe(-100)
    expect(p10.desviacionPct).toBe(-100)
    expect(p9.generacionMwh).toBe(0)
    expect(p10.generacionMwh).toBe(0)
  })

  // La sierra del chart CEP: dentro del periodo 8 la desviación viva caía de -100.2% a
  // -139.7% porque el acumulado negativo entraba crudo a la proyección.
  it('computeLive con acumulado y lectura negativos ⇒ proyección 0 y desviación -100', () => {
    const r = computeLive({
      acumuladoMwh: -13.88,
      currentMw: -14.39,
      redespachoMw: 35,
      now: new Date('2026-07-30T13:30:00Z'),   // 08:30 Bogotá, mitad del periodo 9
    })
    expect(r.projection).toBe(0)
    expect(r.deviation).toBe(-100)
  })

  it('generación real: el clamp no toca el cálculo normal', () => {
    const cerrado = computeClosed({ generacionMwh: 95, despFinalMw: 100, despFinalSource: 'email', redespachoMw: 90 })
    expect(cerrado.desviacionPct).toBeCloseTo(-5, 9)
    expect(cerrado.generacionMwh).toBe(95)

    const vivo = computeLive({
      acumuladoMwh: 20,
      currentMw: 60,
      redespachoMw: 50,
      now: new Date('2026-07-30T13:30:00Z'),   // 08:30 Bogotá ⇒ queda media hora
    })
    expect(vivo.projection).toBeCloseTo(50, 6)
    expect(vivo.deviation).toBeCloseTo(0, 6)
  })

  // Periodos 1-7 del testigo: despacho_final = 0 y sin redespacho. Sin denominador válido
  // no se fabrica desviación — null, no -100.
  it('sin denominador válido ⇒ desviacionPct null, no -100', () => {
    const sinDenom = computeClosed({ generacionMwh: -14.79, despFinalMw: 0, despFinalSource: 'email', redespachoMw: 0 })
    expect(sinDenom.desviacionPct).toBeNull()
    expect(sinDenom.generacionMwh).toBe(0)

    const vivoSinRedesp = computeLive({ acumuladoMwh: -13.88, currentMw: -14.39, redespachoMw: null })
    expect(vivoSinRedesp.deviation).toBeNull()
    expect(vivoSinRedesp.projection).toBe(0)
  })

  it('null en la lectura instantánea no rompe la proyección: sigue con el acumulado', () => {
    const r = computeLive({
      acumuladoMwh: 30,
      currentMw: null,
      redespachoMw: 60,
      now: new Date('2026-07-30T13:30:00Z'),
    })
    expect(r.projection).toBe(30)
    expect(r.deviation).toBeCloseTo(-50, 9)
  })
})
