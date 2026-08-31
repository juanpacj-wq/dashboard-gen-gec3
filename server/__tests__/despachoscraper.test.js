import { readFileSync } from 'node:fs'

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

vi.mock('../db.js', () => ({
  saveDespachoProgBulk: vi.fn().mockResolvedValue(undefined),
  loadDespachoProg: vi.fn().mockResolvedValue(null),
  saveDespachoRecibido: vi.fn().mockResolvedValue(true),
}))

const { DespachoscraperService } = await import('../despachoscraper.js')
const { saveDespachoRecibido } = await import('../db.js')

const VALID_ROW = '"GECELCA 3", ' + Array(24).fill('100.0').join(', ') + '\n'

function mockFetchSuccess(content) {
  return vi.fn().mockImplementation((url) => {
    const u = String(url)
    if (u.includes('api-portalxm.xm.com.co')) {
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve('https://blob.fake/file.txt'),
        text: () => Promise.resolve(''),
      })
    }
    return Promise.resolve({
      ok: true,
      headers: { get: () => 'text/plain' },
      text: () => Promise.resolve(content),
    })
  })
}

function mockFetchNotFound() {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 404,
    headers: { get: () => 'text/plain' },
    text: () => Promise.resolve(''),
    json: () => Promise.resolve({}),
  })
}

describe('DespachoscraperService.getStatus()', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shape inicial', () => {
    const svc = new DespachoscraperService()
    expect(svc.getStatus()).toEqual({
      lastSuccessAt: null,
      secondsSinceSuccess: null,
      lastErrorAt: null,
      lastError: null,
      consecutiveErrors: 0,
      foundForToday: false,
      lastFileForDate: null,
    })
  })

  it('downloader success → lastSuccessAt set, foundForToday=true, consecutiveErrors=0', async () => {
    vi.stubGlobal('fetch', mockFetchSuccess(VALID_ROW))
    const svc = new DespachoscraperService()
    await svc.init(false)
    const s = svc.getStatus()
    expect(s.lastSuccessAt).not.toBeNull()
    expect(typeof s.secondsSinceSuccess).toBe('number')
    expect(s.consecutiveErrors).toBe(0)
    expect(s.foundForToday).toBe(true)
    expect(s.lastFileForDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(s.lastError).toBeNull()
  })

  it('downloader failure (HTTP 404) → lastError="file-not-yet-published", consecutiveErrors++', async () => {
    vi.stubGlobal('fetch', mockFetchNotFound())
    const svc = new DespachoscraperService()
    await svc.init(false)
    const s = svc.getStatus()
    expect(s.lastError).toBe('file-not-yet-published')
    expect(s.consecutiveErrors).toBeGreaterThanOrEqual(1)
    expect(s.lastErrorAt).not.toBeNull()
    expect(s.foundForToday).toBe(false)
    expect(s.lastSuccessAt).toBeNull()
  })
})

// ── Llegada del despacho de mañana (D-064) ──────────────────────────────────
//
// El hecho tiene que quedar ESCRITO: es de donde Bitácora arma el renglón del GENE-F03.
// Antes solo prendía un flag en memoria y un reinicio lo perdía.

/** La fecha de mañana en Bogotá, derivada aparte de como la calcula el scraper. */
function fechaMananaBogota() {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date())
  const d = new Date(`${hoy}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** Las líneas de `saveDespachoRecibido`, tal como están escritas hoy en `db.js`. */
function fuenteDeSaveDespachoRecibido() {
  const src = readFileSync(new URL('../db.js', import.meta.url), 'utf8')
  const lineas = src.split(/\r?\n/)
  const desde = lineas.findIndex((l) => l.startsWith('export async function saveDespachoRecibido'))
  if (desde === -1) throw new Error('saveDespachoRecibido no existe en db.js')
  const largo = lineas.slice(desde).findIndex((l, i) => i > 0 && l.trimEnd() === '}')
  if (largo === -1) throw new Error('no encontré el cierre de saveDespachoRecibido')
  return lineas.slice(desde, desde + largo + 1).join(' ')
}

describe('DespachoscraperService — llegada del despacho (D-064)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    saveDespachoRecibido.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persiste la llegada del despacho de mañana', async () => {
    vi.stubGlobal('fetch', mockFetchSuccess(VALID_ROW))
    const svc = new DespachoscraperService()
    await svc.init(true)

    expect(saveDespachoRecibido).toHaveBeenCalledTimes(1)
    expect(saveDespachoRecibido).toHaveBeenCalledWith(fechaMananaBogota())
    expect(svc.getStateTomorrow()).not.toBeNull()
  })

  it('sin archivo no escribe nada', async () => {
    vi.stubGlobal('fetch', mockFetchNotFound())
    const svc = new DespachoscraperService()
    await svc.init(true)

    expect(saveDespachoRecibido).not.toHaveBeenCalled()
    expect(svc.getStateTomorrow()).toBeNull()
  })

  it('no escribe si el servicio arrancó sin BD', async () => {
    vi.stubGlobal('fetch', mockFetchSuccess(VALID_ROW))
    const svc = new DespachoscraperService()
    await svc.init(false)

    expect(saveDespachoRecibido).not.toHaveBeenCalled()
  })

  it('no pisa la primera detección', async () => {
    vi.stubGlobal('fetch', mockFetchSuccess(VALID_ROW))

    const svc = new DespachoscraperService()
    await svc.init(true)
    await svc.init(true) // segundo tick del mismo proceso: el guard en memoria ya la vio
    expect(saveDespachoRecibido).toHaveBeenCalledTimes(1)

    // Un reinicio sí vuelve a intentarlo, porque el guard en memoria se perdió. Por eso la
    // defensa real es el SQL: inserta solo si no existe y nunca toca `detectado_en`.
    const trasReinicio = new DespachoscraperService()
    await trasReinicio.init(true)
    expect(saveDespachoRecibido).toHaveBeenCalledTimes(2)
    expect(saveDespachoRecibido).toHaveBeenLastCalledWith(fechaMananaBogota())

    const fuente = fuenteDeSaveDespachoRecibido()
    expect(fuente).toMatch(/NOT EXISTS/)
    expect(fuente).not.toMatch(/UPDATE|MERGE|DELETE/i)
  })

  it('degrada si la BD falla', async () => {
    vi.stubGlobal('fetch', mockFetchSuccess(VALID_ROW))
    saveDespachoRecibido.mockRejectedValueOnce(
      new Error("Invalid object name 'dashboard.despacho_recibido'."),
    )

    const svc = new DespachoscraperService()
    await expect(svc.init(true)).resolves.toBeUndefined()

    expect(saveDespachoRecibido).toHaveBeenCalledTimes(1)
    expect(svc.getStateTomorrow()).not.toBeNull() // el scraper sigue sirviendo el dato
  })
})
