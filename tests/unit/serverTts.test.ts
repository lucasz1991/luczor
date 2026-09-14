import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_TTS_AUDIO_BYTES, MAX_TTS_TEXT_CHARS, serverTts, TTS_TIMEOUT_MS } from '@/services/voice/serverTts'
import { encodeWavPCM16 } from '@/services/voice/wav'

const config = Object.freeze({
  baseUrl: 'https://luczor.example.test/client',
  deviceKey: 'secret-key',
  clientId: 'one',
})
const wav = () => encodeWavPCM16([new Float32Array([0, 0.1, -0.1])], 16_000)
const response = () => new Response(new Blob([new Uint8Array(wav())]), { headers: { 'Content-Type': 'audio/wav' } })

describe('shared server TTS transport', () => {
  it('passes the explicitly selected voice and rejects malformed IDs without a request', async () => {
    const fetchMock = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    await serverTts('Hallo Benni.', config, { voiceId: 'benni', speed: 1 })
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ text: 'Hallo Benni.', language: 'de', speed: 1, voice_id: 'benni' }),
      })
    )
    await expect(serverTts('Hallo.', config, { voiceId: '../private' })).rejects.toThrow('Stimmen-ID')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('posts German speech to the captured Luczor identity and returns binary WAV', async () => {
    const fetchMock = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    const audio = await serverTts(' Hallo Welt! ', config, { speed: 1.25 })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://luczor.example.test/client/api/v1/voice/tts',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-key',
          Accept: 'audio/wav',
          'Content-Type': 'application/json',
          'X-Luczor-Correlation-Id': expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
        body: JSON.stringify({ text: 'Hallo Welt!', language: 'de', speed: 1.25 }),
      })
    )
    expect(audio.type).toBe('audio/wav')
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(wav())
  })

  it.each(['', 'a'.repeat(MAX_TTS_TEXT_CHARS + 1)])('rejects invalid text before network access', async text => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(serverTts(text, config)).rejects.toThrow('4000')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([Number.NaN, 0.4, 2.1])('rejects invalid speed %s', async speed => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(serverTts('Hallo', config, { speed })).rejects.toThrow('Sprechgeschwindigkeit')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts the exact text boundary', async () => {
    const fetchMock = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    await expect(serverTts('a'.repeat(MAX_TTS_TEXT_CHARS), config)).resolves.toBeInstanceOf(Blob)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    'http://luczor.example.test',
    'https://key:secret@luczor.example.test',
    'https://luczor.example.test?token=secret',
    'https://luczor.example.test#secret',
    'file:///private',
    'invalid',
  ])('rejects unsafe API URL %s without network access', async baseUrl => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(serverTts('Hallo', { ...config, baseUrl })).rejects.toThrow('Server-URL')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows explicitly configured HTTP loopback only in development', async () => {
    const fetchMock = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DEV', true)
    await expect(serverTts('Hallo', { ...config, baseUrl: 'http://127.0.0.1:8100' })).resolves.toBeInstanceOf(Blob)
    vi.stubEnv('DEV', false)
    await expect(serverTts('Hallo', { ...config, baseUrl: 'http://127.0.0.1:8100' })).rejects.toThrow('HTTPS')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('fails without a device key and without trying a local fallback', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(serverTts('Hallo', { ...config, deviceKey: '' })).rejects.toThrow('Device-Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects redirects even if a fetch implementation ignores redirect:error', async () => {
    const redirected = response()
    Object.defineProperty(redirected, 'redirected', { value: true })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => redirected)
    )
    await expect(serverTts('Hallo', config)).rejects.toThrow('Redirects')
  })

  it.each([401, 403, 404, 422, 429, 502, 503])('returns a secret-safe error for HTTP %s', async status => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('PRIVATE TEXT secret-key', { status }))
    )
    const error = await serverTts('Hallo', config).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ status, name: 'LuczorApiError' })
    expect(String(error)).not.toMatch(/PRIVATE TEXT|secret-key/)
  })

  it('does not propagate transport errors containing credentials or spoken text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret-key PRIVATE TEXT')))
    await expect(serverTts('Hallo', config)).rejects.toThrow('Keine Verbindung zum Sprachdienst')
  })

  it.each([429, 503])(
    'retries HTTP %s once after the advertised delay without changing account, voice or text',
    async status => {
      vi.useFakeTimers()
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('busy', { status, headers: { 'Retry-After': '2' } }))
        .mockImplementation(async () => response())
      vi.stubGlobal('fetch', fetchMock)
      const result = serverTts('Hallo.', config, { voiceId: 'benni' })
      await vi.advanceTimersByTimeAsync(1999)
      expect(fetchMock).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      await expect(result).resolves.toBeInstanceOf(Blob)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('stops after one failed TTS retry and never repeats a request indefinitely', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503, headers: { 'Retry-After': '1' } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = serverTts('Hallo.', config).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(result).resolves.toMatchObject({ status: 503 })
    await vi.advanceTimersByTimeAsync(300000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([null, '3600', 'invalid'])('does not retry without a short valid Retry-After (%s)', async retryAfter => {
    const fetchMock = vi.fn(
      async () =>
        new Response('not configured', {
          status: 503,
          headers: retryAfter ? { 'Retry-After': retryAfter } : {},
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(serverTts('Hallo.', config)).rejects.toMatchObject({ status: 503 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('cancels a pending speech retry when the answer is discarded or the user stops playback', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503, headers: { 'Retry-After': '2' } }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const result = serverTts('Hallo.', config, { signal: controller.signal }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await expect(result).resolves.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(300000)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    new Response('<html>secret</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('not audio', { headers: { 'Content-Type': 'audio/wav' } }),
    new Response('', { headers: { 'Content-Type': 'audio/wav' } }),
  ])('rejects non-WAV and empty response bodies', async invalid => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => invalid)
    )
    await expect(serverTts('Hallo', config)).rejects.toThrow(/Audiodatei|WAV/)
  })

  it('cancels an oversized declared body before reading it', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(MAX_TTS_AUDIO_BYTES + 1) },
          })
      )
    )
    await expect(serverTts('Hallo', config)).rejects.toThrow('Größenlimit')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels a chunked body when actual bytes exceed the limit', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_TTS_AUDIO_BYTES))
        controller.enqueue(new Uint8Array(1))
      },
      cancel,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'audio/wav' } }))
    )
    await expect(serverTts('Hallo', config)).rejects.toThrow('Größenlimit')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does no network work for an already aborted caller', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('secret-key'))
    await expect(serverTts('Hallo', config, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('settles caller abort even when fetch ignores AbortSignal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    )
    const controller = new AbortController()
    const outcome = serverTts('Hallo', config, { signal: controller.signal }).catch((error: unknown) => error)
    controller.abort()
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' })
  })

  it('keeps the deadline active after headers and cancels a stalled body', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'audio/wav' } }))
    )
    const outcome = serverTts('Hallo', config).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(TTS_TIMEOUT_MS)
    await expect(outcome).resolves.toMatchObject({
      name: 'LuczorApiError',
      message: expect.stringContaining('lange gedauert'),
    })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels a stalled body immediately when the caller stops', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'audio/wav' } }))
    )
    const controller = new AbortController()
    const outcome = serverTts('Hallo', config, { signal: controller.signal }).catch((error: unknown) => error)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
