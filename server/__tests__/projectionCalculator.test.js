import { describe, it, expect } from 'vitest'
import { computeClosed } from '../projectionCalculator.js'

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
