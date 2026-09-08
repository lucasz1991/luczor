import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNetworkActivity, networkScope, snapshotNetworkActivity } from '@/services/networkActivity'
import { apiTransportFetch } from '@/services/api/transportTarget'
import { DEFAULT_API_BASE_URL, DEV_API_PREFIX } from '@/services/api/endpoint'

const encode = (text: string) => new TextEncoder().encode(text)
const target = 'https://public.example.test/private-path?secret=value'

afterEach(() => vi.unstubAllGlobals())

describe('network target classification', () => {
  it.each([
    'http://localhost:8080',
    'http://LOCALHOST.',
    'https://tauri.localhost',
    'http://workstation.local',
    'http://127.1',
    'http://10.255.0.1',
    'http://172.16.0.1',
    'http://172.31.255.254',
    'http://192.168.1.1',
    'http://169.254.2.3',
    'http://[::1]',
    'http://[fc00::1]',
    'http://[fdff:abcd::1]',
    'http://[fe80::1]',
    'http://[febf::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:192.168.1.10]',
    'http://[::ffff:ac10:1]',
    'http://[0:0:0:0:0:ffff:0a00:0001]',
  ])('recognizes local/private target %s', input => {
    expect(networkScope(input)).toBe('local')
  })

  it.each([
    'https://public.example.test',
    'https://localhost.public.example.test',
    'http://172.15.255.255',
    'http://172.32.0.1',
    'http://192.169.0.1',
    'http://8.8.8.8',
    'http://[2001:4860:4860::8888]',
    'http://[fec0::1]',
    'http://[::ffff:8.8.8.8]',
  ])('recognizes external target %s', input => {
    expect(networkScope(input)).toBe('external')
  })

  it.each(['http://intranet', '/relative/api', 'not a url', 'file:///private', 'data:text/plain,hello'])(
    'does not infer a route for %s',
    input => expect(networkScope(input)).toBe('unknown')
  )

  it('accepts URL and Request inputs without inspecting their payloads', () => {
    expect(networkScope(new URL('http://[::ffff:a00:1]'))).toBe('local')
    expect(networkScope(new Request(target, { method: 'POST', body: 'private contents' }))).toBe('external')
  })
})

describe('session network payload accounting', () => {
  it('counts encoded request and consumed response bytes without retaining content or metadata', async () => {
    const activity = createNetworkActivity()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Grüße 🌍'))
    )
    const response = await activity.fetch(target, {
      method: 'POST',
      body: 'ä🔒',
      headers: { Authorization: 'Bearer private-device-key' },
    })
    expect(activity.snapshot().external).toMatchObject({
      sentBytes: 6,
      receivedBytes: 0,
      requests: 1,
      activeRequests: 1,
    })
    expect(await response.text()).toBe('Grüße 🌍')
    const snapshot = activity.snapshot()
    expect(snapshot.external).toEqual({
      sentBytes: 6,
      receivedBytes: encode('Grüße 🌍').byteLength,
      requests: 1,
      activeRequests: 0,
      failedRequests: 0,
      unmeasuredBodies: 0,
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private|Bearer|Grüße|public|Authorization/)
    snapshot.external.sentBytes = 999
    expect(activity.snapshot().external.sentBytes).toBe(6)
  })

  it.each([
    ['search parameters', new URLSearchParams({ value: 'ä' }), 12],
    ['blob', new Blob(['ä']), 2],
    ['array buffer', new Uint8Array([1, 2, 3]).buffer, 3],
    ['offset view', new Uint8Array(new ArrayBuffer(10), 3, 4), 4],
  ])('measures known %s payload size', async (_label, body, expected) => {
    const activity = createNetworkActivity()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    )
    await activity.fetch('http://localhost', { method: 'POST', body })
    expect(activity.snapshot().local).toMatchObject({ sentBytes: expected, activeRequests: 0, unmeasuredBodies: 0 })
  })

  it('leaves FormData, streaming uploads and inherited Request bodies unmeasured and untouched', async () => {
    const activity = createNetworkActivity()
    const pull = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 })
    const request = new Request(target, { method: 'POST', body: 'private request' })
    const form = new FormData()
    form.append('private-name', 'private-value')
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    await activity.fetch(target, { method: 'POST', body: form })
    await activity.fetch(target, { method: 'POST', body })
    await activity.fetch(request)
    await activity.fetch(request, { body: null })
    expect(activity.snapshot().external).toMatchObject({ requests: 4, sentBytes: 0, unmeasuredBodies: 4 })
    expect(pull).not.toHaveBeenCalled()
    expect(body.locked).toBe(false)
    expect(request.bodyUsed).toBe(false)
  })

  it('does not pull or lock on headers and respects downstream backpressure', async () => {
    const activity = createNetworkActivity()
    let sequence = 0
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (sequence < 2) controller.enqueue(encode(String(++sequence)))
      else controller.close()
    })
    const source = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(source))
    )
    const response = await activity.fetch(target)
    expect(source.locked).toBe(false)
    expect(pull).not.toHaveBeenCalled()
    const reader = response.body!.getReader()
    expect(pull).not.toHaveBeenCalled()
    expect((await reader.read()).value).toEqual(encode('1'))
    expect(pull).toHaveBeenCalledTimes(1)
    expect(activity.snapshot().external.receivedBytes).toBe(1)
    expect((await reader.read()).value).toEqual(encode('2'))
    expect(pull).toHaveBeenCalledTimes(2)
    expect((await reader.read()).done).toBe(true)
    expect(source.locked).toBe(false)
    expect(activity.snapshot().external.activeRequests).toBe(0)
    reader.releaseLock()
  })

  it('counts a cloned response stream only once while preserving identity on every clone', async () => {
    const activity = createNetworkActivity()
    const original = new Response('shared bytes', {
      status: 201,
      statusText: 'Created',
      headers: { 'X-Value': 'keep' },
    })
    Object.defineProperties(original, {
      url: { value: target },
      redirected: { value: true },
      type: { value: 'cors' },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => original)
    )
    const response = await activity.fetch(target)
    const clone = response.clone()
    const secondClone = clone.clone()
    for (const item of [response, clone, secondClone]) {
      expect(item.url).toBe(target)
      expect(item.redirected).toBe(true)
      expect(item.type).toBe('cors')
      expect(item.status).toBe(201)
      expect(item.statusText).toBe('Created')
      expect(item.headers.get('X-Value')).toBe('keep')
    }
    expect(await Promise.all([response.text(), clone.text(), secondClone.text()])).toEqual(
      Array(3).fill('shared bytes')
    )
    expect(activity.snapshot().external.receivedBytes).toBe(12)
    expect(original.body?.locked).toBe(false)
    expect(() => response.clone()).toThrow()
  })

  it.each([false, true])(
    'forwards cancellation before/after a first read (read=%s) and releases the source lock',
    async read => {
      const activity = createNetworkActivity()
      const cancel = vi.fn()
      const source = new ReadableStream<Uint8Array>(
        { pull: controller => controller.enqueue(encode('one')), cancel },
        { highWaterMark: 0 }
      )
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(source))
      )
      const response = await activity.fetch(target)
      const reader = response.body!.getReader()
      if (read) await reader.read()
      const reason = { cancelled: 'caller decision' }
      await reader.cancel(reason)
      expect(cancel).toHaveBeenCalledExactlyOnceWith(reason)
      expect(source.locked).toBe(false)
      expect(activity.snapshot().external).toMatchObject({ activeRequests: 0, receivedBytes: read ? 3 : 0 })
      reader.releaseLock()
    }
  )

  it('preserves a source cancellation rejection and releases its reader', async () => {
    const activity = createNetworkActivity()
    const failure = new Error('cancel failed')
    const source = new ReadableStream<Uint8Array>(
      {
        pull: controller => controller.enqueue(encode('one')),
        cancel: () => Promise.reject(failure),
      },
      { highWaterMark: 0 }
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(source))
    )
    const response = await activity.fetch(target)
    const reader = response.body!.getReader()
    await reader.read()
    await expect(reader.cancel()).rejects.toBe(failure)
    expect(source.locked).toBe(false)
    expect(activity.snapshot().external).toMatchObject({ activeRequests: 0, failedRequests: 1 })
  })

  it('preserves fetch exceptions and does not decrement an already aborted request twice', async () => {
    const activity = createNetworkActivity()
    const controller = new AbortController()
    const failure = new TypeError('network failed')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        controller.abort()
        throw failure
      })
    )
    await expect(activity.fetch(target, { signal: controller.signal })).rejects.toBe(failure)
    expect(activity.snapshot().external).toMatchObject({ requests: 1, activeRequests: 0, failedRequests: 1 })
  })

  it('preserves stream errors and releases the original body lock', async () => {
    const activity = createNetworkActivity()
    const failure = new Error('stream failed')
    const source = new ReadableStream<Uint8Array>(
      { pull: controller => controller.error(failure) },
      { highWaterMark: 0 }
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(source))
    )
    const response = await activity.fetch(target)
    await expect(response.text()).rejects.toBe(failure)
    expect(source.locked).toBe(false)
    expect(activity.snapshot().external).toMatchObject({ receivedBytes: 0, failedRequests: 1, activeRequests: 0 })
  })

  it('finishes HTTP errors at headers without locking a reusable unconsumed response', async () => {
    const activity = createNetworkActivity()
    const source = new Response('failure body', { status: 503 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(source))
    await activity.fetch(target)
    const second = await activity.fetch(target)
    expect(source.body?.locked).toBe(false)
    expect(activity.snapshot().external).toMatchObject({
      requests: 2,
      failedRequests: 2,
      activeRequests: 0,
      receivedBytes: 0,
    })
    expect(await second.text()).toBe('failure body')
    expect(activity.snapshot().external).toMatchObject({ failedRequests: 2, receivedBytes: 12 })
  })

  it('returns response-like custom transports unchanged with explicitly unmeasured bodies', async () => {
    const activity = createNetworkActivity()
    const double = {
      ok: true,
      status: 200,
      body: { getReader: vi.fn() },
      text: vi.fn(async () => 'same custom result'),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(double))
    const result = await activity.fetch(target)
    expect(result).toBe(double)
    expect(await result.text()).toBe('same custom result')
    expect(double.body.getReader).not.toHaveBeenCalled()
    expect(activity.snapshot().external).toMatchObject({ unmeasuredBodies: 1, receivedBytes: 0, activeRequests: 0 })
  })

  it('preserves already locked native responses instead of throwing from instrumentation', async () => {
    const activity = createNetworkActivity()
    const original = new Response('body')
    const reader = original.body!.getReader()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => original)
    )
    expect(await activity.fetch(target)).toBe(original)
    expect(activity.snapshot().external).toMatchObject({ unmeasuredBodies: 1, receivedBytes: 0, activeRequests: 0 })
    await reader.cancel()
    reader.releaseLock()
  })

  it('uses Request.signal and preserves a pre-aborted request rejection without counting an attempted request', async () => {
    const activity = createNetworkActivity()
    const controller = new AbortController()
    const request = new Request(target, { signal: controller.signal })
    controller.abort()
    const failure = new DOMException('aborted', 'AbortError')
    const fetch = vi.fn(async () => {
      throw failure
    })
    vi.stubGlobal('fetch', fetch)
    await expect(activity.fetch(request)).rejects.toBe(failure)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(request, {})
    expect(activity.snapshot().external.requests).toBe(0)
  })

  it('honors an inherited signal after headers and removes the listener after completion', async () => {
    const activity = createNetworkActivity()
    const controller = new AbortController()
    const request = new Request(target, { signal: controller.signal })
    const remove = vi.spyOn(request.signal, 'removeEventListener')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('done'))
    )
    const response = await activity.fetch(request)
    controller.abort()
    expect(activity.snapshot().external).toMatchObject({ activeRequests: 0, failedRequests: 1 })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    await response.text()
    expect(activity.snapshot().external).toMatchObject({ activeRequests: 0, failedRequests: 1 })
  })

  it('respects explicit init signal overrides including null', async () => {
    const activity = createNetworkActivity()
    const inherited = new AbortController()
    inherited.abort()
    const request = new Request(target, { signal: inherited.signal })
    const explicit = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    )
    await activity.fetch(request, { signal: null })
    await activity.fetch(request, { signal: explicit.signal })
    explicit.abort()
    expect(activity.snapshot().external).toMatchObject({ requests: 2, activeRequests: 0, failedRequests: 0 })
  })

  it('classifies the original external API destination before the development proxy rewrite', async () => {
    vi.stubGlobal('location', { origin: 'http://localhost:1430' })
    const fetch = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    const before = snapshotNetworkActivity()
    const response = await apiTransportFetch(`${DEFAULT_API_BASE_URL}/api/v1/health`)
    await response.text()
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`http://localhost:1430${DEV_API_PREFIX}/api/v1/health`, {})
    const after = snapshotNetworkActivity()
    expect(after.local).toEqual(before.local)
    expect(after.external.requests - before.external.requests).toBe(1)
    expect(after.external.receivedBytes - before.external.receivedBytes).toBe(2)
  })
})
