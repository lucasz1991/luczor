import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TestAccountSnapshot = Readonly<{
  principalId: string
  serverOrigin: string
  accountId: number
  config: Readonly<{ baseUrl: string; deviceKey: string; clientId: string }>
}>

const harness = vi.hoisted(() => {
  const files = new Map<string, Map<string, unknown>>()
  const storeFor = (filename: string) => {
    let values = files.get(filename)
    if (!values) {
      values = new Map<string, unknown>()
      files.set(filename, values)
    }
    return {
      get: vi.fn(async (key: string) => values?.get(key)),
      set: vi.fn(async (key: string, value: unknown) => values?.set(key, value)),
      delete: vi.fn(async (key: string) => values?.delete(key)),
      save: vi.fn(async () => undefined),
    }
  }
  return {
    files,
    loadStore: vi.fn(async (filename: string) => storeFor(filename)),
    invoke: vi.fn(async (command: string) => {
      if (command === 'memory_key_get_or_create') return '11'.repeat(32)
      throw new Error(`Unexpected command: ${command}`)
    }),
    getVerifiedAccountSnapshot: vi.fn(),
    currentSnapshot: {
      principalId: 'account:v2:account-a',
      serverOrigin: 'https://memory.example.test',
      accountId: 1,
      config: Object.freeze({
        baseUrl: 'https://memory.example.test',
        deviceKey: 'key-a',
        clientId: 'desktop-1',
      }),
    } as TestAccountSnapshot,
    fetch: vi.fn(),
  }
})

vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: harness.loadStore } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: harness.invoke }))
vi.mock('@/services/accountPrincipal', () => ({
  getVerifiedAccountSnapshot: harness.getVerifiedAccountSnapshot,
}))

function accountSnapshot(accountId: number, deviceKey: string) {
  return Object.freeze({
    principalId: `account:v2:account-${accountId}`,
    serverOrigin: 'https://memory.example.test',
    accountId,
    config: Object.freeze({
      baseUrl: 'https://memory.example.test',
      deviceKey,
      clientId: 'desktop-1',
    }),
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function setServerEnabled(enabled: boolean): Promise<void> {
  let settings = harness.files.get('luczor.settings.json')
  if (!settings) {
    settings = new Map<string, unknown>()
    harness.files.set('luczor.settings.json', settings)
  }
  settings.set('memory_use_server', enabled)
}

describe('desktop memory account isolation', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    vi.clearAllMocks()
    harness.files.clear()
    harness.currentSnapshot = accountSnapshot(1, 'key-a')
    harness.getVerifiedAccountSnapshot.mockImplementation(async () => harness.currentSnapshot)
    harness.fetch.mockResolvedValue(jsonResponse({ decision: 'accepted', persisted: true, id: 'server-memory-1' }))
    vi.stubGlobal('fetch', harness.fetch)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps local memory available after same-account key rotation but isolated from another account', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()

    const candidate = await memory.remember({
      content: 'Ein persönlicher Arbeitsstil',
      scope: 'project',
      projectId: 'project-1',
      source: 'assistant',
      writeIntent: 'automatic',
    })

    harness.currentSnapshot = accountSnapshot(1, 'key-b')
    await expect(memory.listCandidates('project-1')).resolves.toEqual([expect.objectContaining({ id: candidate.id })])

    harness.currentSnapshot = accountSnapshot(2, 'key-c')
    await expect(memory.listCandidates('project-1')).resolves.toEqual([])
  })

  it('flushes a pre-rotation outbox with the new key of the same verified account', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    await memory.remember({
      content: 'Merke dir diese bestätigte Einstellung.',
      scope: 'project',
      projectId: 'project-1',
      source: 'user',
      writeIntent: 'explicit',
    })
    await memory.flushPendingSync()

    harness.currentSnapshot = accountSnapshot(1, 'key-b')
    await setServerEnabled(true)
    await memory.flushPendingSync()

    const rememberCall = harness.fetch.mock.calls.find(([url]) => String(url).endsWith('/api/v1/memory/remember'))
    expect(rememberCall?.[1]?.headers).toMatchObject({ Authorization: 'Bearer key-b' })
    await expect(memory.pendingSyncCount()).resolves.toBe(0)
  })

  it('uses one account and config snapshot for a whole flush even when the active account changes mid-request', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    await memory.remember({
      content: 'Merke dir diese atomare Flush-Prüfung.',
      scope: 'project',
      projectId: 'project-1',
      source: 'user',
      writeIntent: 'explicit',
    })
    await memory.flushPendingSync()

    await setServerEnabled(true)
    harness.getVerifiedAccountSnapshot.mockClear()
    harness.fetch.mockImplementationOnce(async (_url: unknown, options?: RequestInit) => {
      harness.currentSnapshot = accountSnapshot(2, 'key-account-b')
      expect(options?.headers).toMatchObject({ Authorization: 'Bearer key-a' })
      return jsonResponse({ decision: 'accepted', persisted: true, id: 'server-memory-atomic' })
    })

    await memory.flushPendingSync()

    expect(harness.getVerifiedAccountSnapshot).toHaveBeenCalledOnce()
    expect(harness.fetch).toHaveBeenCalledOnce()
  })

  it('never sends a promoted repository candidate even when provenance is nested in metadata', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const candidate = await memory.remember({
      content: 'Lokale Repository-Evidenz für die Architektur',
      scope: 'project',
      projectId: 'project-1',
      source: 'user',
      meta: { nested: { source_type: 'repository_graph' } },
      writeIntent: 'automatic',
    })

    await setServerEnabled(true)
    harness.fetch.mockClear()
    const promoted = await memory.promote(candidate.id)
    await memory.flushPendingSync()

    expect(promoted).toMatchObject({ status: 'active', visibility: 'private' })
    expect(harness.fetch).not.toHaveBeenCalled()
    await expect(memory.pendingSyncCount()).resolves.toBe(0)
  })

  it('never exposes session secrets or local repository memories through ordinary prompt recall', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const secret = 'github_pat_abcdefghijklmnopqrstuvwxyz123456'
    const repositoryFact = 'Die private Klasse liegt in src/Internal/Secret.ts'

    await memory.remember({
      content: secret,
      scope: 'project',
      projectId: 'project-1',
      source: 'user',
      writeIntent: 'explicit',
    })
    await memory.remember({
      content: repositoryFact,
      scope: 'project',
      projectId: 'project-1',
      source: 'repository_graph',
      writeIntent: 'explicit',
    })

    await expect(memory.recall({ projectId: 'project-1', query: 'private secret' })).resolves.toEqual([])
    const prompt = await memory.getContextForPrompt('project-1', 'private secret')
    expect(prompt).not.toContain(secret)
    expect(prompt).not.toContain(repositoryFact)
  })

  it('rejects repository provenance returned by the server before recall fusion', async () => {
    await setServerEnabled(true)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    harness.fetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'server-repository-memory',
            content: 'Interne Repository-Struktur vom Server',
            source: 'user',
            meta: { nested: { originType: 'repository_graph' } },
          },
        ],
      })
    )

    await expect(memory.recall({ projectId: 'project-1', query: 'Repository-Struktur' })).resolves.toEqual([])
  })

  it('normalizes nested origin_type provenance and keeps it local without a request', async () => {
    await setServerEnabled(true)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()

    for (const key of ['origin_type', 'originType', 'origintype']) {
      const record = await memory.remember({
        content: `Lokale Repository-Evidenz mit Herkunftsschlüssel ${key}`,
        scope: 'project',
        projectId: 'project-1',
        source: 'user',
        meta: { nested: { [key]: 'repository' } },
        writeIntent: 'explicit',
      })
      expect(record).toMatchObject({ visibility: 'private', sensitivity: 'normal' })
    }

    expect(harness.fetch).not.toHaveBeenCalled()
    await expect(memory.pendingSyncCount()).resolves.toBe(0)
  })

  it('fails a large multibyte metadata payload closed without contacting the server', async () => {
    await setServerEnabled(true)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()

    const record = await memory.remember({
      content: 'Merke dir diese lokal geprüfte Einstellung.',
      scope: 'project',
      projectId: 'project-1',
      source: 'user',
      meta: { nested: '漢'.repeat(40_000) },
      writeIntent: 'explicit',
    })

    expect(record).toMatchObject({ visibility: 'private', sensitivity: 'secret', retention: 'session' })
    expect(harness.fetch).not.toHaveBeenCalled()
    await expect(memory.pendingSyncCount()).resolves.toBe(0)
  })

  it('returns local prompt memory after ten seconds when the server transport never settles', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const content = 'Merke dir: Antworten für dieses Projekt bleiben knapp.'
    await memory.remember({
      content,
      scope: 'project',
      projectId: 'project-1',
      source: 'user',
      writeIntent: 'explicit',
    })
    await memory.flushPendingSync()

    await setServerEnabled(true)
    harness.fetch.mockClear()
    harness.fetch.mockImplementation(() => new Promise<Response>(() => undefined))
    vi.useFakeTimers()
    const promptRequest = memory.getContextForPrompt('project-1', 'Antworten knapp')
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledOnce(), { timeout: 1_000, interval: 1 })

    await vi.advanceTimersByTimeAsync(10_000)
    await expect(promptRequest).resolves.toContain(content)
  })

  it('retries an unconfirmed forget and acknowledges an idempotent already-absent response', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T10:00:00.000Z'))
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const record = await memory.remember({
      content: 'Merke dir diese löschbare Einstellung.',
      scope: 'project',
      projectId: 'project-1',
      source: 'user',
      writeIntent: 'explicit',
    })
    await memory.flushPendingSync()

    await setServerEnabled(true)
    await memory.flushPendingSync()
    await setServerEnabled(false)
    await memory.forget('project', record.id, { projectId: 'project-1' })
    await memory.flushPendingSync()

    await setServerEnabled(true)
    harness.fetch.mockResolvedValueOnce(jsonResponse({ forgotten: false, already_absent: false }))
    await memory.flushPendingSync()
    await expect(memory.pendingSyncCount()).resolves.toBe(1)

    vi.advanceTimersByTime(10_001)
    harness.fetch.mockResolvedValueOnce(jsonResponse({ forgotten: false, already_absent: true }))
    await memory.flushPendingSync()
    await expect(memory.pendingSyncCount()).resolves.toBe(0)
  })

  it('deduplicates repeated forget operations until the server acknowledges deletion', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const record = await memory.remember({
      content: 'Merke dir diese einmalig zu löschende Einstellung.',
      scope: 'project',
      projectId: 'project-1',
      source: 'user',
      writeIntent: 'explicit',
    })

    await setServerEnabled(true)
    await memory.flushPendingSync()
    await setServerEnabled(false)
    await memory.forget('project', record.id, { projectId: 'project-1' })
    await memory.forget('project', record.id, { projectId: 'project-1' })
    await memory.flushPendingSync()
    await expect(memory.pendingSyncCount()).resolves.toBe(1)

    harness.fetch.mockClear()
    harness.fetch.mockResolvedValue(jsonResponse({ forgotten: true, already_absent: false }))
    await setServerEnabled(true)
    await memory.flushPendingSync()
    await memory.flushPendingSync()

    expect(harness.fetch).toHaveBeenCalledOnce()
    await expect(memory.pendingSyncCount()).resolves.toBe(0)
  })

  it('renews TTL, timestamp and evidence when an expired candidate is observed again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T10:00:00.000Z'))
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const first = await memory.remember({
      content: 'Wiederkehrende, noch unbestätigte Beobachtung',
      scope: 'project',
      projectId: 'project-1',
      source: 'assistant',
      writeIntent: 'automatic',
    })

    vi.advanceTimersByTime(25 * 60 * 60_000)
    const observedAt = Date.now()
    const renewed = await memory.remember({
      content: 'Wiederkehrende, noch unbestätigte Beobachtung',
      scope: 'project',
      projectId: 'project-1',
      source: 'assistant',
      writeIntent: 'automatic',
    })

    expect(renewed.id).toBe(first.id)
    expect(renewed.updatedAt).toBe(observedAt)
    expect(renewed.expiresAt).toBe(observedAt + 24 * 60 * 60_000)
    expect(renewed.provenance).toMatchObject({
      captured_at: new Date(observedAt).toISOString(),
      observation_count: 2,
    })
    await expect(memory.listCandidates('project-1')).resolves.toHaveLength(1)
  })

  it('does not write account data when configured-account verification fails', async () => {
    harness.getVerifiedAccountSnapshot.mockRejectedValueOnce(new Error('verification failed'))
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()

    await expect(
      memory.remember({ content: 'Must not be guessed into a partition', scope: 'project', projectId: 'project-1' })
    ).rejects.toThrow('verification failed')
    expect(harness.files.has('luczor.memory.json')).toBe(false)
  })

  it('uses the acknowledged server version as CAS for the next feature write', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    await memory.remember({
      content: 'Erste geräteübergreifende Regel',
      scope: 'project',
      projectId: 'project-1',
      featureKey: 'answer.shared-rule',
      source: 'user',
      writeIntent: 'explicit',
    })

    await setServerEnabled(true)
    harness.fetch.mockResolvedValueOnce(
      jsonResponse({ decision: 'accepted', persisted: true, id: 'shared-rule', memory_link_id: 41 })
    )
    await memory.flushPendingSync()

    await setServerEnabled(false)
    await memory.remember({
      content: 'Zweite geräteübergreifende Regel',
      scope: 'project',
      projectId: 'project-1',
      featureKey: 'answer.shared-rule',
      source: 'user',
      writeIntent: 'explicit',
    })
    await setServerEnabled(true)
    harness.fetch.mockClear()
    harness.fetch.mockResolvedValueOnce(
      jsonResponse({ decision: 'accepted', persisted: true, id: 'shared-rule', memory_link_id: 42 })
    )
    await memory.flushPendingSync()

    expect(harness.fetch).toHaveBeenCalledOnce()
    const rememberRequest = harness.fetch.mock.calls[0]
    expect(rememberRequest).toBeDefined()
    const [, options] = rememberRequest!
    expect(JSON.parse(String(options?.body))).toMatchObject({
      feature_key: 'answer.shared-rule',
      expected_previous_id: 41,
    })
    expect(String(rememberRequest![0])).toContain('/api/v1/memory/remember')
    await expect(memory.pendingSyncCount()).resolves.toBe(0)
  })

  it('turns a stale first-write CAS conflict into a review candidate instead of overwriting', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const record = await memory.remember({
      content: 'Offline-Regel mit unbekanntem Server-Vorgänger',
      scope: 'project',
      projectId: 'project-1',
      featureKey: 'answer.remote-conflict',
      source: 'user',
      writeIntent: 'explicit',
    })

    await setServerEnabled(true)
    harness.fetch.mockResolvedValueOnce(jsonResponse({ message: 'Version conflict' }, 409))
    await memory.flushPendingSync()

    const rememberCall = harness.fetch.mock.calls.find(([url]) => String(url).endsWith('/api/v1/memory/remember'))
    expect(JSON.parse(String(rememberCall?.[1]?.body))).toMatchObject({
      feature_key: 'answer.remote-conflict',
      expected_previous_id: null,
    })
    await expect(memory.listCandidates('project-1')).resolves.toEqual([
      expect.objectContaining({
        id: record.id,
        status: 'candidate',
        synced: false,
        requiresServerVersionRefresh: true,
      }),
    ])
    await expect(memory.pendingSyncCount()).resolves.toBe(0)
  })

  it('uses the current version from a structured conflict for an explicit reviewed promotion', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const record = await memory.remember({
      content: 'Lokale Änderung auf einem neuen Gerät',
      scope: 'project',
      projectId: 'project-1',
      featureKey: 'answer.structured-conflict',
      source: 'user',
      writeIntent: 'explicit',
    })

    await setServerEnabled(true)
    harness.fetch.mockResolvedValueOnce(jsonResponse({ message: 'Version conflict', current_memory_id: 77 }, 409))
    await memory.flushPendingSync()

    await expect(memory.listCandidates('project-1')).resolves.toEqual([
      expect.objectContaining({
        id: record.id,
        expectedPreviousServerVersionId: 77,
        requiresServerVersionRefresh: false,
      }),
    ])

    await setServerEnabled(false)
    await expect(memory.promote(record.id)).resolves.toMatchObject({ status: 'active' })
    await setServerEnabled(true)
    harness.fetch.mockClear()
    harness.fetch.mockResolvedValueOnce(
      jsonResponse({ decision: 'accepted', persisted: true, id: 'structured-conflict', memory_link_id: 78 })
    )
    await memory.flushPendingSync()

    expect(harness.fetch).toHaveBeenCalledOnce()
    const promotedRequest = harness.fetch.mock.calls[0]
    expect(promotedRequest).toBeDefined()
    expect(JSON.parse(String(promotedRequest![1]?.body))).toMatchObject({
      feature_key: 'answer.structured-conflict',
      expected_previous_id: 77,
    })
    await expect(memory.pendingSyncCount()).resolves.toBe(0)
  })

  it('refreshes an unstructured conflict through recall before the reviewed promotion', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const record = await memory.remember({
      content: 'Neue lokale Fassung einer bestehenden Regel',
      scope: 'project',
      projectId: 'project-1',
      featureKey: 'answer.recalled-conflict',
      source: 'user',
      writeIntent: 'explicit',
    })

    await setServerEnabled(true)
    harness.fetch.mockResolvedValueOnce(jsonResponse({ message: 'Version conflict' }, 409)).mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'recalled-conflict',
            content: 'Aktive Fassung auf dem Server',
            feature_key: 'answer.recalled-conflict',
            source_record_id: '91',
          },
        ],
      })
    )
    await memory.flushPendingSync()

    expect(harness.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/api/v1/memory/remember'),
      expect.stringContaining('/api/v1/memory/recall'),
    ])
    await expect(memory.listCandidates('project-1')).resolves.toEqual([
      expect.objectContaining({
        id: record.id,
        expectedPreviousServerVersionId: 91,
        requiresServerVersionRefresh: false,
      }),
    ])

    await setServerEnabled(false)
    await memory.promote(record.id)
    await setServerEnabled(true)
    harness.fetch.mockClear()
    harness.fetch.mockResolvedValueOnce(
      jsonResponse({ decision: 'accepted', persisted: true, id: 'recalled-conflict', memory_link_id: 92 })
    )
    await memory.flushPendingSync()

    const promotedRequest = harness.fetch.mock.calls[0]
    expect(promotedRequest).toBeDefined()
    expect(JSON.parse(String(promotedRequest![1]?.body))).toMatchObject({
      expected_previous_id: 91,
    })
  })

  it('keeps a conflict candidate unchanged when the active server version cannot be verified', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const record = await memory.remember({
      content: 'Nicht blind zu überschreibende lokale Regel',
      scope: 'project',
      projectId: 'project-1',
      featureKey: 'answer.unresolved-conflict',
      source: 'user',
      writeIntent: 'explicit',
    })

    await setServerEnabled(true)
    harness.fetch
      .mockResolvedValueOnce(jsonResponse({ message: 'Version conflict' }, 409))
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
    await memory.flushPendingSync()

    harness.fetch.mockClear()
    harness.fetch.mockResolvedValue(jsonResponse({ data: [] }))
    await expect(memory.promote(record.id)).rejects.toThrow('could not be verified')

    expect(harness.fetch).toHaveBeenCalledTimes(2)
    expect(harness.fetch.mock.calls.every(([url]) => String(url).endsWith('/api/v1/memory/recall'))).toBe(true)
    await expect(memory.listCandidates('project-1')).resolves.toEqual([
      expect.objectContaining({
        id: record.id,
        status: 'candidate',
        requiresServerVersionRefresh: true,
      }),
    ])
    await expect(memory.pendingSyncCount()).resolves.toBe(0)
  })
})
