import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_API_BASE_URL, DEV_API_PREFIX, resolveApiFetchUrl } from '@/services/api/endpoint'
import { apiTransportInput } from '@/services/api/transportTarget'
import { bootstrapWithApiConfig, fetchWithTimeout } from '@/services/api/luczorApi'

describe('Loopback development API transport', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('relays only the fixed API from loopback development and preserves endpoint/query', () => {
    for (const origin of ['http://localhost:1420', 'http://127.0.0.1:1433', 'https://[::1]:1420']) {
      expect(
        resolveApiFetchUrl(`${DEFAULT_API_BASE_URL}/api/v1/bootstrap?scope=a%2Fb`, { development: true, origin })
      ).toBe(`${origin}${DEV_API_PREFIX}/api/v1/bootstrap?scope=a%2Fb`)
    }
  })

  it('leaves packaged, custom-server, remote-page and non-API requests untouched', () => {
    const url = `${DEFAULT_API_BASE_URL}/api/v1/health`
    for (const environment of [
      { development: false, origin: 'http://localhost:1420' },
      { development: true, origin: 'http://tauri.localhost' },
      { development: true, origin: 'https://unrelated.example' },
      { development: true },
    ])
      expect(resolveApiFetchUrl(url, environment)).toBe(url)
    for (const target of [
      'https://custom.example/api/v1/health',
      `${DEFAULT_API_BASE_URL}/customer/api/v1/health`,
      `${DEFAULT_API_BASE_URL}/api/v11/health`,
      `${DEFAULT_API_BASE_URL}/api/v1/../../dashboard`,
      'https://user:password@luczor.follow-flow.de/api/v1/health',
      'https://luczor.follow-flow.de.attacker.example/api/v1/health',
      '/api/v1/health',
    ])
      expect(resolveApiFetchUrl(target, { development: true, origin: 'http://localhost:1420' })).toBe(target)
  })

  it('preserves a Request body, bearer and abort signal when only its transport URL changes', async () => {
    vi.stubGlobal('location', { origin: 'http://localhost:1420' })
    const controller = new AbortController()
    const input = new Request(`${DEFAULT_API_BASE_URL}/api/v1/context/ask`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-device' },
      body: '{"query":"test"}',
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
    })
    const mapped = apiTransportInput(input) as Request
    expect(mapped.url).toBe(`http://localhost:1420${DEV_API_PREFIX}/api/v1/context/ask`)
    expect(mapped.method).toBe('POST')
    expect(mapped.headers.get('Authorization')).toBe('Bearer test-device')
    expect(mapped.redirect).toBe('error')
    expect(mapped.credentials).toBe('omit')
    expect(await mapped.text()).toBe('{"query":"test"}')
    controller.abort()
    expect(mapped.signal.aborted).toBe(true)
  })

  it('uses the relay for both bounded bootstrap and the ordinary health transport without mutating identity', async () => {
    vi.stubGlobal('location', { origin: 'http://localhost:1420' })
    const fetchMock = vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const config = Object.freeze({ baseUrl: DEFAULT_API_BASE_URL, clientId: 'test-client', deviceKey: 'test-device' })
    await bootstrapWithApiConfig(config)
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:1420${DEV_API_PREFIX}/api/v1/bootstrap`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-device' }),
        redirect: 'error',
        credentials: 'omit',
      })
    )
    await fetchWithTimeout(`${DEFAULT_API_BASE_URL}/api/v1/health`)
    expect(fetchMock).toHaveBeenLastCalledWith(
      `http://localhost:1420${DEV_API_PREFIX}/api/v1/health`,
      expect.any(Object)
    )
    expect(config.baseUrl).toBe(DEFAULT_API_BASE_URL)
  })
})
