import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapWithApiConfig,
  createCorrelationId,
  fetchBoundedResponseWithTimeout,
  fetchWithTimeout,
  readBoundedResponseText,
} from '@/services/api/luczorApi'

describe('Luczor API transport boundaries', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('creates a Laravel-compatible UUID correlation id', () => {
    expect(createCorrelationId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('accepts an exact response boundary', async () => {
    const response = new Response('12345', {
      headers: { 'Content-Length': '5' },
    })

    await expect(readBoundedResponseText(response, 5)).resolves.toBe('12345')
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
})
