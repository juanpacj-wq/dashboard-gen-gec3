import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../db.js', () => ({
  saveRedespachoProgBulk: vi.fn().mockResolvedValue(undefined),
  loadRedespachoProg: vi.fn().mockResolvedValue(null),
}))

const { RedespachoscraperService } = await import('../redespachoscraper.js')

const ROW_GEC3 = (val) => '"GECELCA 3", ' + Array(24).fill(val.toFixed(1)).join(', ') + '\n'

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

describe('RedespachoscraperService.getStatus()', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shape inicial', () => {
    const svc = new RedespachoscraperService()
    expect(svc.getStatus()).toEqual({
      lastSuccessAt: null,
      secondsSinceSuccess: null,
      lastErrorAt: null,
      lastError: null,
      consecutiveErrors: 0,
      lastChangesCount: 0,
    })
  })

  it('downloader success → lastSuccessAt set, consecutiveErrors=0, lastError=null', async () => {
    vi.stubGlobal('fetch', mockFetchSuccess(ROW_GEC3(100)))
    const svc = new RedespachoscraperService()
    await svc.init(false)
    const s = svc.getStatus()
    expect(s.lastSuccessAt).not.toBeNull()
    expect(typeof s.secondsSinceSuccess).toBe('number')
    expect(s.consecutiveErrors).toBe(0)
    expect(s.lastError).toBeNull()
  })

  it('downloader failure (HTTP 404) → lastError="file-not-yet-published"', async () => {
    vi.stubGlobal('fetch', mockFetchNotFound())
    const svc = new RedespachoscraperService()
    await svc.init(false)
    const s = svc.getStatus()
    expect(s.lastError).toBe('file-not-yet-published')
    expect(s.consecutiveErrors).toBeGreaterThanOrEqual(1)
    expect(s.lastErrorAt).not.toBeNull()
    expect(s.lastSuccessAt).toBeNull()
  })

  it('lastChangesCount refleja celdas cambiadas vs cache previo (>0.01 MW)', async () => {
    // 1er refresh: prev=null → 0 cambios
    vi.stubGlobal('fetch', mockFetchSuccess(ROW_GEC3(100)))
    const svc = new RedespachoscraperService()
    await svc.init(false)
    expect(svc.getStatus().lastChangesCount).toBe(0)

    // 2do refresh con valores distintos → 24 horas de GEC3 cambiaron
    vi.stubGlobal('fetch', mockFetchSuccess(ROW_GEC3(200)))
    await svc.init(false)
    expect(svc.getStatus().lastChangesCount).toBe(24)
  })

  it('lastChangesCount=0 cuando los valores no cambian entre refreshes', async () => {
    vi.stubGlobal('fetch', mockFetchSuccess(ROW_GEC3(100)))
    const svc = new RedespachoscraperService()
    await svc.init(false)
    await svc.init(false)
    expect(svc.getStatus().lastChangesCount).toBe(0)
  })
})
