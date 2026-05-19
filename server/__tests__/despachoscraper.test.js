import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../db.js', () => ({
  saveDespachoProgBulk: vi.fn().mockResolvedValue(undefined),
  loadDespachoProg: vi.fn().mockResolvedValue(null),
}))

const { DespachoscraperService } = await import('../despachoscraper.js')

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
