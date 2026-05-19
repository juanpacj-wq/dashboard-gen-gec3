import { describe, it, expect, vi } from 'vitest'
import { createAlertDispatcher } from '../alertDispatcher.js'

function mkAlert(overrides = {}) {
  return {
    incidentKey: 'meterPoller:GEC3@host',
    severity: 'WARN',
    title: 'Test alert',
    body: 'lorem ipsum',
    firstSeenAt: '2026-06-01T12:00:00.000Z',
    emittedAt: '2026-06-01T12:00:30.000Z',
    ...overrides,
  }
}

function mkFetchOk() {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }))
}

function mkLogger() {
  return { warn: vi.fn(), error: vi.fn() }
}

describe('alertDispatcher — webhookUrl ausente', () => {
  it('webhookUrl=null → no llama fetch, loguea warn', async () => {
    const fetch = mkFetchOk()
    const logger = mkLogger()
    const dispatch = createAlertDispatcher({ webhookUrl: null, fetch, logger })
    await dispatch(mkAlert())
    expect(fetch).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.warn.mock.calls[0][0]).toMatch(/no configurado/)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('webhookUrl="" → no llama fetch', async () => {
    const fetch = mkFetchOk()
    const dispatch = createAlertDispatcher({ webhookUrl: '', fetch, logger: mkLogger() })
    await dispatch(mkAlert())
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('alertDispatcher — serialización por target', () => {
  it('target="generic" → JSON crudo con campos canónicos', async () => {
    const fetch = mkFetchOk()
    const dispatch = createAlertDispatcher({ webhookUrl: 'https://hook.example/x', target: 'generic', fetch })
    await dispatch(mkAlert({ severity: 'CRITICAL' }))
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://hook.example/x')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body)
    expect(body).toEqual({
      severity: 'CRITICAL',
      incident_key: 'meterPoller:GEC3@host',
      title: 'Test alert',
      body: 'lorem ipsum',
      first_seen_at: '2026-06-01T12:00:00.000Z',
      emitted_at: '2026-06-01T12:00:30.000Z',
      source: 'dashboard-gen-gec3',
    })
  })

  it('target="teams" → MessageCard con themeColor=rojo para CRITICAL', async () => {
    const fetch = mkFetchOk()
    const dispatch = createAlertDispatcher({ webhookUrl: 'https://teams.example/x', target: 'teams', fetch })
    await dispatch(mkAlert({ severity: 'CRITICAL' }))
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body['@type']).toBe('MessageCard')
    expect(body['@context']).toBe('https://schema.org/extensions')
    expect(body.themeColor).toBe('D32F2F')
    expect(body.title).toBe('[CRITICAL] Test alert')
    expect(body.sections[0].facts).toEqual([
      { name: 'incident_key', value: 'meterPoller:GEC3@host' },
      { name: 'first_seen_at', value: '2026-06-01T12:00:00.000Z' },
      { name: 'emitted_at', value: '2026-06-01T12:00:30.000Z' },
    ])
  })

  it('target="teams" → themeColor según severidad WARN/RECOVERED', async () => {
    const fetch = mkFetchOk()
    const dispatch = createAlertDispatcher({ webhookUrl: 'https://t.x', target: 'teams', fetch })
    await dispatch(mkAlert({ severity: 'WARN' }))
    await dispatch(mkAlert({ severity: 'RECOVERED' }))
    const warnBody = JSON.parse(fetch.mock.calls[0][1].body)
    const recBody = JSON.parse(fetch.mock.calls[1][1].body)
    expect(warnBody.themeColor).toBe('F9A825')
    expect(recBody.themeColor).toBe('2E7D32')
  })

  it('target="slack" → blocks + emoji según severidad', async () => {
    const fetch = mkFetchOk()
    const dispatch = createAlertDispatcher({ webhookUrl: 'https://slack.example/x', target: 'slack', fetch })
    await dispatch(mkAlert({ severity: 'CRITICAL' }))
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.text).toMatch(/:rotating_light:/)
    expect(body.text).toMatch(/\*\[CRITICAL\]\*/)
    expect(Array.isArray(body.blocks)).toBe(true)
    expect(body.blocks[0]).toMatchObject({ type: 'header' })
    expect(body.blocks[1]).toMatchObject({ type: 'section' })
    expect(body.blocks[2]).toMatchObject({ type: 'context' })
    expect(body.blocks[2].elements[0].text).toMatch(/incident:.*meterPoller:GEC3@host/)
  })

  it('target inválido → cae a "generic" y loguea warn', async () => {
    const fetch = mkFetchOk()
    const logger = mkLogger()
    const dispatch = createAlertDispatcher({ webhookUrl: 'https://x.y/z', target: 'pagerduty', fetch, logger })
    await dispatch(mkAlert())
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.warn.mock.calls[0][0]).toMatch(/no soportado/)
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.source).toBe('dashboard-gen-gec3')   // formato generic
    expect(body['@type']).toBeUndefined()
  })

  it('Content-Type es siempre application/json', async () => {
    const fetch = mkFetchOk()
    const targets = ['generic', 'teams', 'slack']
    for (const t of targets) {
      const dispatch = createAlertDispatcher({ webhookUrl: 'https://x.y/z', target: t, fetch })
      await dispatch(mkAlert())
    }
    for (const call of fetch.mock.calls) {
      expect(call[1].headers['Content-Type']).toBe('application/json')
    }
  })
})

describe('alertDispatcher — tolerancia a fallos HTTP/network', () => {
  it('HTTP 500 → loguea error pero no tira', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'server boom' }))
    const logger = mkLogger()
    const dispatch = createAlertDispatcher({ webhookUrl: 'https://x.y/z', fetch, logger })
    await expect(dispatch(mkAlert())).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error.mock.calls[0][0]).toMatch(/HTTP 500/)
    expect(logger.error.mock.calls[0][0]).toMatch(/server boom/)
  })

  it('fetch rejected → loguea error pero no tira', async () => {
    const fetch = vi.fn(async () => { throw new Error('ECONNRESET') })
    const logger = mkLogger()
    const dispatch = createAlertDispatcher({ webhookUrl: 'https://x.y/z', fetch, logger })
    await expect(dispatch(mkAlert())).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error.mock.calls[0][0]).toMatch(/ECONNRESET/)
  })

  it('HTTP no-OK con body unreadable → loguea sin crashear', async () => {
    const fetch = vi.fn(async () => ({
      ok: false, status: 502,
      text: async () => { throw new Error('chunked decode failed') },
    }))
    const logger = mkLogger()
    const dispatch = createAlertDispatcher({ webhookUrl: 'https://x.y/z', fetch, logger })
    await dispatch(mkAlert())
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error.mock.calls[0][0]).toMatch(/HTTP 502.*<unreadable>/)
  })
})
