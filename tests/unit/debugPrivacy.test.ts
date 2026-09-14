import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const createStore = () => {
    const values = new Map<string, unknown>()
    return {
      values,
      instance: {
        get: vi.fn(async (key: string) => values.get(key)),
        set: vi.fn(async (key: string, value: unknown) => {
          values.set(key, value)
        }),
        clear: vi.fn(async () => {
          values.clear()
        }),
        save: vi.fn(async () => undefined),
      },
    }
  }

  const settings = createStore()
  const debug = createStore()
  return {
    settings,
    debug,
    load: vi.fn(async (filename: string) => (filename === 'luczor.debug.json' ? debug.instance : settings.instance)),
    state: {
      projects: [{ id: 'project-secret-id', name: 'Kundenprojekt Müller' }],
      messages: [
        {
          id: 'message-secret-id',
          projectId: 'project-secret-id',
          role: 'user',
          content: 'Vertraulicher Chat für anna@example.org mit token=secret-token',
          visibility: 'visible',
        },
        {
          id: 'tool-secret-id',
          projectId: 'project-secret-id',
          role: 'tool',
          content: 'C:\\Users\\Anna\\private.txt',
          visibility: 'hidden',
        },
      ],
    },
    getApiConfig: vi.fn(),
    pollDebugRequest: vi.fn(),
    completeDebugRequest: vi.fn(),
    voiceRuntimeStatus: vi.fn(),
  }
})

vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: harness.load } }))
vi.mock('@/state/store', () => ({ state: harness.state }))
vi.mock('@/services/api/luczorApi', () => ({
  getApiConfig: harness.getApiConfig,
  LuczorApi: {
    pollDebugRequest: harness.pollDebugRequest,
    completeDebugRequest: harness.completeDebugRequest,
  },
}))
vi.mock('@/services/voice/localVoice', () => ({
  voiceRuntimeStatus: harness.voiceRuntimeStatus,
}))

describe('debug privacy boundary', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    harness.settings.values.clear()
    harness.debug.values.clear()
    harness.getApiConfig.mockResolvedValue({
      baseUrl: 'https://internal-customer.example.org',
      clientId: 'private-client-id',
      deviceKey: 'private-device-token',
    })
    harness.pollDebugRequest.mockResolvedValue({ data: null })
    harness.completeDebugRequest.mockResolvedValue({ ok: true })
    harness.voiceRuntimeStatus.mockResolvedValue({
      state: 'error',
      version: '1.2.3',
      stt_ready: false,
      tts_ready: true,
      error: 'C:\\Users\\Anna\\voice.exe failed with token=voice-secret',
    })
  })

  it('is fail-closed by default and neither stores nor polls', async () => {
    const debug = await import('@/services/debug')

    await expect(debug.getDebugCollectionEnabled()).resolves.toBe(false)
    await debug.recordDebugEvent('error', 'window.error', { message: 'private content' })
    await expect(debug.collectRequestedDebugReport()).resolves.toBe('disabled')
    await expect(debug.buildDebugReport()).rejects.toThrow('disabled')

    expect(harness.debug.values.size).toBe(0)
    expect(harness.getApiConfig).not.toHaveBeenCalled()
    expect(harness.pollDebugRequest).not.toHaveBeenCalled()
    expect(harness.completeDebugRequest).not.toHaveBeenCalled()
  })

  it('persists explicit consent and stops immediately after revocation', async () => {
    const debug = await import('@/services/debug')

    await debug.setDebugCollectionEnabled(true)
    await expect(debug.getDebugCollectionEnabled()).resolves.toBe(true)
    expect(harness.settings.values.get(debug.DEBUG_COLLECTION_ENABLED_KEY)).toBe(true)

    harness.pollDebugRequest.mockImplementationOnce(async () => {
      harness.settings.values.set(debug.DEBUG_COLLECTION_ENABLED_KEY, false)
      return { data: { id: 'debug-request-1' } }
    })
    await expect(debug.collectRequestedDebugReport()).resolves.toBe('disabled')

    expect(harness.completeDebugRequest).not.toHaveBeenCalled()
    await debug.recordDebugEvent('warn', 'after.optout', { status: 500 })
    expect(harness.debug.values.size).toBe(0)
  })

  it('builds and uploads only a minimal report without content, identifiers or secrets', async () => {
    const debug = await import('@/services/debug')
    await debug.setDebugCollectionEnabled(true)
    harness.debug.values.set('events', [
      {
        at: '2026-08-23T10:00:00.000Z',
        level: 'error',
        event: 'assistant_request_failed',
        detail: {
          content: 'Vertraulicher Chat',
          token: 'debug-secret-token',
          source: 'C:\\Users\\Anna\\app.ts',
        },
      },
      {
        at: '2026-08-23T10:05:00.000Z',
        level: 'warn',
        event: 'anna.schmidt',
        detail: { status: 400 },
      },
    ])
    harness.pollDebugRequest.mockResolvedValue({ data: { id: 'debug-request-2' } })

    await expect(debug.collectRequestedDebugReport()).resolves.toBe('uploaded')
    expect(harness.completeDebugRequest).toHaveBeenCalledOnce()
    const report = harness.completeDebugRequest.mock.calls[0]?.[1]
    expect(report).toMatchObject({
      version: 'luczor-debug-v2',
      consent: { diagnostics_enabled: true },
      app_state: {
        project_count: 1,
        message_count: 2,
        visible_message_count: 1,
        hidden_message_count: 1,
        messages_by_role: { user: 1, assistant: 0, tool: 1 },
      },
      voice_runtime: {
        state: 'error',
        version: '1.2.3',
        stt_ready: false,
        tts_ready: true,
        error_present: true,
      },
      debug_events: [
        {
          level: 'error',
          event: 'assistant_request_failed',
          count: 1,
        },
        {
          level: 'warn',
          event: 'client_event',
          count: 1,
        },
      ],
    })
    expect(report).not.toHaveProperty('server')
    expect(report).not.toHaveProperty('settings')

    const serialized = JSON.stringify(report)
    for (const forbidden of [
      'Vertraulicher',
      'Kundenprojekt',
      'Müller',
      'anna@example.org',
      'anna.schmidt',
      'secret-token',
      'debug-secret-token',
      'voice-secret',
      'project-secret-id',
      'message-secret-id',
      'private-client-id',
      'internal-customer.example.org',
      'Users\\\\Anna',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('clears only the local diagnostics store', async () => {
    harness.debug.values.set('events', [{ event: 'old.event' }])
    harness.settings.values.set('assistant_name', 'Luczor')
    const debug = await import('@/services/debug')

    await debug.clearDebugData()

    expect(harness.debug.values.size).toBe(0)
    expect(harness.debug.instance.clear).toHaveBeenCalledOnce()
    expect(harness.debug.instance.save).toHaveBeenCalledOnce()
    expect(harness.settings.values.get('assistant_name')).toBe('Luczor')
  })

  it('records public model exchanges and tool content only with separate detailed consent', async () => {
    const debug = await import('@/services/debug')
    const trace = await import('@/services/debugTrace')
    await debug.setDebugCollectionEnabled(true)
    await trace.recordTrace('tool.request', { arguments: { path: 'src/main.ts' } })
    expect(harness.debug.values.size).toBe(0)
    await trace.setTraceEnabled(true)
    const result = { content: 'Erledigt', toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
    await expect(
      trace.traceInference(
        'test-model',
        {
          messages: [{ role: 'user', content: 'Datei prüfen' }],
          debugScope: { runId: 'run-a', conversationId: 'chat-a' },
          expectedProxyConfig: { baseUrl: 'https://example.com', clientId: 'private-client', deviceKey: 'private-key' },
        },
        async request => {
          request.onToken?.('Zwischenstand')
          return result
        }
      )
    ).resolves.toBe(result)
    await trace.recordTrace('tool.response', {
      callId: 'tool-1',
      output: { content: 'Datei gelesen', password: 'not-exported' },
    })
    const report = await debug.buildDebugReport()
    expect(report.version).toBe('luczor-debug-v3')
    expect(report.chat_trace?.events.map(event => event.kind)).toEqual(
      expect.arrayContaining(['model.request', 'model.response', 'tool.response'])
    )
    const serialized = JSON.stringify(report)
    expect(serialized).toContain('Datei prüfen')
    expect(serialized).toContain('Datei gelesen')
    expect(serialized).toContain('run-a')
    for (const secret of ['not-exported', 'private-key', 'expectedProxyConfig'])
      expect(serialized).not.toContain(secret)
  })

  it('keeps partial public output on error and never carries logs into another account', async () => {
    const debug = await import('@/services/debug')
    const trace = await import('@/services/debugTrace')
    await debug.setDebugCollectionEnabled(true)
    await trace.setTraceEnabled(true)
    const failure = new Error('HTTP 400 grammar')
    await expect(
      trace.traceInference('test', { messages: [] }, async request => {
        request.onToken?.('Bereits gelesen')
        throw failure
      })
    ).rejects.toBe(failure)
    expect(JSON.stringify(await trace.readTrace())).toContain('Bereits gelesen')
    expect(JSON.stringify(await trace.readTrace())).toContain('HTTP 400 grammar')
    const owner = await trace.debugScope()
    harness.getApiConfig.mockResolvedValue({ baseUrl: 'https://other.example', clientId: 'other', deviceKey: 'other' })
    await trace.recordTrace('tool.response', { content: 'stale data' }, owner)
    expect((await trace.readTrace())?.events).toEqual([])
  })

  it('redacts nested JSON credentials, binary data and private reasoning while retaining public text', async () => {
    const { redactTrace } = await import('@/services/debugTrace')
    const output = JSON.stringify(
      redactTrace({
        args: JSON.stringify({
          nested: { DB_PASSWORD: 'db-secret-value', token: 'token-secret-value' },
          public: 'works',
        }),
        content: 'Public <think>private-thought</think> Bearer abcsecret data:image/png;base64,YWJjZA==',
        reasoning_content: 'private-channel',
      })
    )
    expect(output).toContain('works')
    expect(output).toContain('Public')
    for (const secret of [
      'db-secret-value',
      'token-secret-value',
      'private-thought',
      'abcsecret',
      'YWJjZA==',
      'private-channel',
    ])
      expect(output).not.toContain(secret)
  })

  it('serializes concurrent writes and explicitly reports oversized payload truncation', async () => {
    const debug = await import('@/services/debug')
    const trace = await import('@/services/debugTrace')
    await debug.setDebugCollectionEnabled(true)
    await trace.setTraceEnabled(true)
    await Promise.all(Array.from({ length: 12 }, (_, index) => trace.recordTrace('tool.response', { index })))
    expect((await trace.readTrace())?.events).toHaveLength(12)
    await trace.recordTrace('tool.response', { content: 'x'.repeat(600_000) })
    expect((await trace.readTrace())?.events.at(-1)?.data).toMatchObject({ truncated: true })
    await trace.setTraceEnabled(false)
    expect(await trace.readTrace()).toBeUndefined()
  })
})
