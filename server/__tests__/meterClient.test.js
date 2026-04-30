import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { MockAgent } from 'undici'
import {
  ION8650Client,
  parseKwTotal,
  MeterAuthError,
  MeterHttpError,
  MeterFormatError,
} from '../meterClient.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_HTML = readFileSync(
  resolve(__dirname, '../__fixtures__/ion8650_op.html'),
  'utf8',
)

describe('parseKwTotal', () => {
  it('extracts 5240.04 from the real ION8650 fixture', () => {
    expect(parseKwTotal(FIXTURE_HTML)).toBe(5240.04)
  })

  it('throws MeterFormatError when "kW total" label is missing', () => {
    const html =
      '<html><body><table><tr><td class="l">Vln avg</td><td class="v">100 V</td></tr></table></body></html>'
    expect(() => parseKwTotal(html)).toThrow(MeterFormatError)
  })

  it('throws MeterFormatError when value has wrong unit', () => {
    const html =
      '<html><body><table><tr><td class="l">kW total</td><td class="v">5240.04 MW</td></tr></table></body></html>'
    expect(() => parseKwTotal(html)).toThrow(MeterFormatError)
  })

  it('throws MeterFormatError when value cell is non-numeric', () => {
    const html =
      '<html><body><table><tr><td class="l">kW total</td><td class="v">--- kW</td></tr></table></body></html>'
    expect(() => parseKwTotal(html)).toThrow(MeterFormatError)
  })

  it('accepts zero kW (unit not despachada)', () => {
    const html =
      '<html><body><table><tr><td class="l">kW total</td><td class="v">0.00 kW</td></tr></table></body></html>'
    expect(parseKwTotal(html)).toBe(0)
  })

  it('accepts negative values', () => {
    const html =
      '<html><body><table><tr><td class="l">kW total</td><td class="v">-5.5 kW</td></tr></table></body></html>'
    expect(parseKwTotal(html)).toBe(-5.5)
  })

  it('takes the first matching td.l when duplicated', () => {
    const html =
      '<html><body><table>' +
      '<tr><td class="l">kW total</td><td class="v">100.00 kW</td></tr>' +
      '<tr><td class="l">kW total</td><td class="v">200.00 kW</td></tr>' +
      '</table></body></html>'
    expect(parseKwTotal(html)).toBe(100)
  })
})

describe('ION8650Client constructor', () => {
  it('throws TypeError when host is missing', () => {
    expect(() => new ION8650Client({ user: 'u', password: 'p' })).toThrow(TypeError)
  })
  it('throws TypeError when user is missing', () => {
    expect(() => new ION8650Client({ host: 'h', password: 'p' })).toThrow(TypeError)
  })
  it('throws TypeError when password is undefined but accepts empty string', () => {
    expect(() => new ION8650Client({ host: 'h', user: 'u' })).toThrow(TypeError)
    expect(() => new ION8650Client({ host: 'h', user: 'u', password: '' })).not.toThrow()
  })
})

describe('ION8650Client.fetchKwTotal (mocked HTTP)', () => {
  let mockAgent
  let client

  beforeEach(() => {
    mockAgent = new MockAgent()
    mockAgent.disableNetConnect()
  })

  afterEach(async () => {
    if (client) await client.close()
    await mockAgent.close()
  })

  it('returns { kw, fetchedAt, latencyMs } and sends Basic Auth header on 200', async () => {
    let receivedAuth = null
    mockAgent
      .get('http://192.168.200.2')
      .intercept({ path: '/Operation.html', method: 'GET' })
      .reply((opts) => {
        receivedAuth = opts.headers?.authorization ?? opts.headers?.Authorization
        return {
          statusCode: 200,
          data: FIXTURE_HTML,
          responseOptions: { headers: { 'content-type': 'text/html' } },
        }
      })

    client = new ION8650Client({
      host: '192.168.200.2',
      user: 'user1',
      password: '4816',
      agent: mockAgent,
    })
    const result = await client.fetchKwTotal()

    expect(result.kw).toBe(5240.04)
    expect(typeof result.fetchedAt).toBe('string')
    expect(typeof result.latencyMs).toBe('number')
    expect(receivedAuth).toBe(
      'Basic ' + Buffer.from('user1:4816').toString('base64'),
    )
  })

  it('throws MeterAuthError on 401', async () => {
    mockAgent
      .get('http://10.0.0.1')
      .intercept({ path: '/Operation.html' })
      .reply(401, 'unauthorized')

    client = new ION8650Client({
      host: '10.0.0.1',
      user: 'u',
      password: 'bad',
      agent: mockAgent,
    })
    await expect(client.fetchKwTotal()).rejects.toThrow(MeterAuthError)
  })

  it('throws MeterHttpError on 500', async () => {
    mockAgent
      .get('http://10.0.0.1')
      .intercept({ path: '/Operation.html' })
      .reply(500, 'oops')

    client = new ION8650Client({
      host: '10.0.0.1',
      user: 'u',
      password: 'p',
      agent: mockAgent,
    })
    await expect(client.fetchKwTotal()).rejects.toThrow(MeterHttpError)
  })

  it('throws MeterFormatError when 200 but HTML is missing kW total', async () => {
    mockAgent
      .get('http://10.0.0.1')
      .intercept({ path: '/Operation.html' })
      .reply(200, '<html><body>nothing here</body></html>')

    client = new ION8650Client({
      host: '10.0.0.1',
      user: 'u',
      password: 'p',
      agent: mockAgent,
    })
    await expect(client.fetchKwTotal()).rejects.toThrow(MeterFormatError)
  })

  it('respects custom opPath', async () => {
    mockAgent
      .get('http://10.0.0.1')
      .intercept({ path: '/Custom/Page.html' })
      .reply(200, FIXTURE_HTML)

    client = new ION8650Client({
      host: '10.0.0.1',
      user: 'u',
      password: 'p',
      opPath: '/Custom/Page.html',
      agent: mockAgent,
    })
    const result = await client.fetchKwTotal()
    expect(result.kw).toBe(5240.04)
  })

  it('accepts host with explicit http:// scheme', async () => {
    mockAgent
      .get('http://10.0.0.1')
      .intercept({ path: '/Operation.html' })
      .reply(200, FIXTURE_HTML)

    client = new ION8650Client({
      host: 'http://10.0.0.1/',
      user: 'u',
      password: 'p',
      agent: mockAgent,
    })
    const result = await client.fetchKwTotal()
    expect(result.kw).toBe(5240.04)
  })
})
