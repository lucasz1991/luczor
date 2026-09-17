import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapWithApiConfig,
  createCorrelationId,
  fetchBoundedResponseWithTimeout,
  fetchWithTimeout,
  LuczorApi,
  readBoundedResponseText,
  requestWithConfig,
} from '@/services/api/luczorApi'

describe('Luczor API transport boundaries', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('creates a Laravel-compatible UUID correlation id', () => {
    expect(createCorrelationId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('revokes the currently authenticated desktop key through the fixed account endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response('{"status":"revoked"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      LuczorApi.logoutCurrentDevice({
        baseUrl: 'https://bound.example.test',
        deviceKey: 'synthetic-test-device-key',
        clientId: 'desktop-1',
      })
    ).resolves.toEqual({ status: 'revoked' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://bound.example.test/api/v1/auth/device/logout',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: 'Bearer synthetic-test-device-key' }),
      })
    )
  })

  it('accepts an exact response boundary', async () => {
    const response = new Response('12345', {
      headers: { 'Content-Length': '5' },
    })

    await expect(readBoundedResponseText(response, 5)).resolves.toBe('12345')
  })

  it.each([
    ['local_model_signing_key_missing', 'local_model_signing_key_missing'],
    [undefined, undefined],
    [{ message: 'untrusted' }, undefined],
    ['secret/path.pem', undefined],
    ['a'.repeat(129), undefined],
  ])('preserves only bounded machine-readable API error codes (%j)', async (code, expectedCode) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              message: 'Signed manifest unavailable.',
              code,
            }),
            { status: 503, headers: { 'X-Luczor-Correlation-Id': 'test-correlation' } }
          )
      )
    )

    await expect(
      bootstrapWithApiConfig({
        baseUrl: 'https://bound.example.test',
        deviceKey: 'device-key',
        clientId: 'desktop-1',
      })
    ).rejects.toMatchObject({
      name: 'LuczorApiError',
      status: 503,
      code: expectedCode,
      correlationId: 'test-correlation',
    })
  })

  it('rejects a declared oversized response before reading it', async () => {
    const response = new Response('123456', {
      headers: { 'Content-Length': '6' },
    })

    await expect(readBoundedResponseText(response, 5)).rejects.toMatchObject({
      name: 'LuczorApiError',
      status: 0,
    })
  })

  it('cancels a chunked response as soon as the byte limit is exceeded', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('123'))
        controller.enqueue(new TextEncoder().encode('456'))
      },
      cancel() {
        cancelled = true
      },
    })

    await expect(readBoundedResponseText(new Response(body), 5)).rejects.toThrow(/überschreitet das Limit/)
    expect(cancelled).toBe(true)
  })

  it('fails bootstrap offline after ten seconds even when fetch ignores AbortSignal', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    )

    const request = bootstrapWithApiConfig({
      baseUrl: 'https://blackhole.example.test',
      deviceKey: 'device-key',
      clientId: 'desktop-1',
    })
    const outcome = request.catch(error => error)

    await vi.advanceTimersByTimeAsync(10_000)
    await expect(outcome).resolves.toMatchObject({ name: 'LuczorApiError', status: 0 })
  })

  it('allows a proved operation past ten seconds and enforces its entire response deadline', async () => {
    vi.useFakeTimers()
    const config = { baseUrl: 'https://bound.example.test', deviceKey: 'synthetic-test-key', clientId: 'device' }
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
      },
      cancel() {
        cancelled = true
      },
    })
    const fetch = vi.fn(async () => new Response(body))
    vi.stubGlobal('fetch', fetch)
    let settled = false
    const response = requestWithConfig('/proxy/vision', { method: 'POST', timeoutMs: 75000, body: {} }, config).catch(
      error => {
        settled = true
        return error
      }
    )
    await vi.advanceTimersByTimeAsync(10001)
    expect(settled).toBe(false)
    expect(cancelled).toBe(false)
    await vi.advanceTimersByTimeAsync(64999)
    await expect(response).resolves.toMatchObject({ name: 'LuczorApiError', status: 0 })
    expect(cancelled).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('accepts a long operation response after the ordinary ten-second deadline', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(
      () => new Promise<Response>(resolve => setTimeout(() => resolve(new Response('{"data":{"ok":true}}')), 12000))
    )
    vi.stubGlobal('fetch', fetch)
    const result = requestWithConfig(
      '/proxy/vision',
      { method: 'POST', timeoutMs: 75000, body: {} },
      {
        baseUrl: 'https://bound.example.test',
        deviceKey: 'synthetic-test-key',
        clientId: 'device',
      }
    )
    await vi.advanceTimersByTimeAsync(12000)
    await expect(result).resolves.toEqual({ data: { ok: true } })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([0, -1, 999, 615001, Infinity, NaN, 1000.5])(
    'rejects an invalid operation deadline %s before transport',
    async timeoutMs => {
      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)
      await expect(
        requestWithConfig(
          '/proxy/vision',
          { timeoutMs },
          {
            baseUrl: 'https://bound.example.test',
            deviceKey: 'synthetic-test-key',
            clientId: 'device',
          }
        )
      ).rejects.toThrow('API request timeout')
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it('times out and cancels a response body that stalls after successful headers', async () => {
    vi.useFakeTimers()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
      },
      cancel() {
        cancelled = true
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 }))
    )

    const outcome = bootstrapWithApiConfig({
      baseUrl: 'https://slow-body.example.test',
      deviceKey: 'device-key',
      clientId: 'desktop-1',
    }).catch(error => error)

    await vi.advanceTimersByTimeAsync(10_000)
    await expect(outcome).resolves.toMatchObject({ name: 'LuczorApiError', status: 0 })
    expect(cancelled).toBe(true)
  })

  it('honours caller abort after headers while a bounded response body is pending', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 }))
    )
    const controller = new AbortController()
    const outcome = fetchBoundedResponseWithTimeout(
      'https://slow-body.example.test',
      { signal: controller.signal },
      10_000,
      1024
    ).catch(error => error)

    await Promise.resolve()
    await Promise.resolve()
    controller.abort()

    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
  })

  it('rejects redirects while keeping bootstrap bound to its configured server instance', async () => {
    const redirected = new Response('{}', { status: 200 })
    Object.defineProperty(redirected, 'redirected', { value: true })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      return redirected
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      bootstrapWithApiConfig({
        baseUrl: 'https://bound.example.test/luczor',
        deviceKey: 'device-key',
        clientId: 'desktop-1',
      })
    ).rejects.toThrow('Redirects')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('honours a caller AbortSignal even when fetch ignores it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    )
    const controller = new AbortController()
    const request = fetchWithTimeout('https://blackhole.example.test', { signal: controller.signal })
    const outcome = request.catch(error => error)

    controller.abort()

    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' })
  })

  it('does not invoke either transport with an already aborted signal', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()

    await expect(fetchWithTimeout('https://bound.example.test', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    await expect(
      fetchBoundedResponseWithTimeout('https://bound.example.test', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
