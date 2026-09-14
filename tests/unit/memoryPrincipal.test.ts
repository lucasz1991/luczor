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
    // Every service instance owns a debounced background sync. Keep those
    // timers scoped to their test so a previous instance cannot consume the
    // next test's transport mock while the full suite is running under load.
    vi.useFakeTimers()
    vi.resetModules()
    vi.clearAllMocks()
    harness.files.clear()
    harness.currentSnapshot = accountSnapshot(1, 'key-a')
    harness.getVerifiedAccountSnapshot.mockImplementation(async () => harness.currentSnapshot)
    harness.fetch.mockResolvedValue(jsonResponse({ decision: 'accepted', persisted: true, id: 'server-memory-1' }))
    vi.stubGlobal('fetch', harness.fetch)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('schedules maintenance using only the bound scope and rejects cancelled or foreign-account work', async () => {
    await setServerEnabled(true)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const controller = new AbortController()
    const options = { expectedPrincipalId: harness.currentSnapshot.principalId, signal: controller.signal }
    harness.fetch.mockResolvedValue(jsonResponse({ ok: true, scheduled: true }))
    expect(await memory.scheduleImprovement('user', options)).toBe('scheduled')
    expect(JSON.parse(harness.fetch.mock.calls[0]![1].body)).toEqual({ scope: 'user' })
    harness.fetch.mockClear()
    await expect(memory.scheduleImprovement('user', { ...options, expectedPrincipalId: 'foreign' })).rejects.toThrow(
      'account changed'
    )
    controller.abort()
    await expect(memory.scheduleImprovement('user', options)).rejects.toMatchObject({ name: 'AbortError' })
    expect(harness.fetch).not.toHaveBeenCalled()
  })

  it('persists explicit named priorities and debounces identical confirmed observations into one server write', async () => {
    await setServerEnabled(true)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const input = {
      content: 'Antworten immer auf Deutsch.',
      scope: 'user' as const,
      priority: 'high' as const,
      writeIntent: 'confirmed' as const,
    }
    const first = await memory.remember(input)
    const duplicate = await memory.remember(input)
    expect(duplicate.id).toBe(first.id)
    expect(harness.fetch).not.toHaveBeenCalled()
    await memory.flushPendingSync()
    expect(harness.fetch).toHaveBeenCalledOnce()
    const sent = JSON.parse(String(harness.fetch.mock.calls[0]?.[1]?.body))
    expect(sent).toMatchObject({ priority: 'high', importance: 0.8, write_id: first.id })
    await memory.remember(input)
    await memory.flushPendingSync()
    expect(harness.fetch).toHaveBeenCalledOnce()
    const changed = await memory.remember({ ...input, priority: 'critical' })
    expect(changed.id).not.toBe(first.id)
    await memory.flushPendingSync()
    expect(harness.fetch).toHaveBeenCalledTimes(2)
  })

  it('ranks equally relevant local evidence by priority inside the selected account and project', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    await memory.remember({
      content: 'Navigation Hintergrund.',
      projectId: 'p1',
      priority: 'background',
      writeIntent: 'explicit',
    })
    const important = await memory.remember({
      content: 'Navigation wichtig.',
      projectId: 'p1',
      priority: 'critical',
      writeIntent: 'explicit',
    })
    await memory.remember({
      content: 'Navigation anderes Projekt.',
      projectId: 'p2',
      priority: 'critical',
      writeIntent: 'explicit',
    })
    const hits = await memory.recallLocal({ query: 'Navigation', projectId: 'p1' })
    expect(hits).toHaveLength(2)
    expect(hits[0]?.id).toBe(important.id)
    const report = await memory.analyze('project', { projectId: 'p1' })
    expect(report.local).toMatchObject({ analyzed: 2, priorities: { background: 1, critical: 1 }, changed_records: 0 })
    harness.currentSnapshot = accountSnapshot(2, 'key-b')
    expect((await memory.analyze('project', { projectId: 'p1' })).local.analyzed).toBe(0)
    expect(await memory.recallLocal({ query: 'Navigation', projectId: 'p1' })).toEqual([])
  })

  it('keeps a cloud project memory namespace stable across device-local project ids', async () => {
    await setServerEnabled(false)
    const { state } = await import('@/state/store')
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const template = { ...state.projects[0]! }
    state.projects.push({
      ...template,
      id: 'imported-cloud-project',
      cloud: {
        principalId: harness.currentSnapshot.principalId,
        projectId: 8,
        externalId: 'shared-project',
        revision: 1,
        fingerprint: 'a'.repeat(64),
        syncedAt: 1,
      },
    })
    const memory = new LuczorMemoryService()
    const saved = await memory.remember({
      content: 'Navigation ist links angeordnet.',
      projectId: 'imported-cloud-project',
      writeIntent: 'explicit',
    })
    expect(saved.projectId).toBe('shared-project')
    expect(
      (await memory.recallLocal({ query: 'Navigation', projectId: 'imported-cloud-project' })).map(item => item.id)
    ).toContain(saved.id)
    expect(
      (await memory.recallLocal({ query: 'Navigation', projectId: 'shared-project' })).map(item => item.id)
    ).toContain(saved.id)
    harness.currentSnapshot = accountSnapshot(2, 'key-b')
    await expect(memory.recallLocal({ query: '', projectId: 'imported-cloud-project' })).rejects.toThrow(
      'anderen Benutzer'
    )
  })

  it('captures bounded intermediate candidates early, throttles bursts and rejects account switches', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const checkpoint = {
      content: 'Die öffentliche Planung wurde in drei übersichtliche Schritte eingeteilt.',
      scope: 'project' as const,
      projectId: 'p1',
      sessionId: 'turn-one',
      expectedPrincipalId: harness.currentSnapshot.principalId,
    }
    const first = await memory.captureCheckpoint(checkpoint)
    expect(first).toMatchObject({ status: 'candidate', visibility: 'private', writeIntent: 'automatic' })
    expect(await memory.captureCheckpoint({ ...checkpoint, content: checkpoint.content + ' Weiter.' })).toBeNull()
    expect(
      await memory.captureCheckpoint({ ...checkpoint, content: checkpoint.content + ' Fertig.', final: true })
    ).not.toBeNull()
    expect(await memory.listCandidates('p1')).toHaveLength(2)
    await memory.flushPendingSync()
    expect(harness.fetch).not.toHaveBeenCalled()
    harness.currentSnapshot = accountSnapshot(2, 'key-b')
    await expect(memory.captureCheckpoint(checkpoint)).rejects.toThrow('account changed')
    expect(await memory.listCandidates('p1')).toEqual([])
  })

  it('keeps scoped local analysis when an older backend has no analysis endpoint', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    await memory.remember({ content: 'Eine bestätigte lokale Entscheidung.', projectId: 'p1', writeIntent: 'explicit' })
    await setServerEnabled(true)
    harness.fetch.mockResolvedValue(jsonResponse({ message: 'Not Found' }, 404))
    await expect(memory.analyze('project', { projectId: 'p1' })).resolves.toMatchObject({
      local: { analyzed: 1 },
      server: null,
      serverUnavailable: true,
    })
    harness.fetch.mockImplementationOnce(async () => {
      harness.currentSnapshot = accountSnapshot(2, 'key-b')
      return jsonResponse({}, 404)
    })
    await expect(memory.analyze('project', { projectId: 'p1' })).rejects.toThrow('account changed during analysis')
  })

  it('retrieves private active memories locally without remote queries or ordinary provider recall', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    await memory.remember({
      content: 'Der bevorzugte Projekttest heißt Alpha.',
      scope: 'private',
      projectId: 'p1',
      writeIntent: 'explicit',
      importance: 1,
      visibility: 'private',
    })
    const result = await memory.recallLocal({ scope: 'private', projectId: 'p1', query: 'Alpha', limit: 5 })
    expect(result).toHaveLength(1)
    expect(result[0]?.content).toContain('Alpha')
    await expect(memory.recall({ scope: 'private', projectId: 'p1', query: 'Alpha' })).resolves.toEqual([])
    harness.currentSnapshot = accountSnapshot(2, 'key-b')
    await expect(memory.recallLocal({ scope: 'private', projectId: 'p1', query: 'Alpha' })).resolves.toEqual([])
    expect(harness.fetch).not.toHaveBeenCalled()
  })

  it('rejects a reviewed write when the principal changes while its operation snapshot is resolving', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const reviewedPrincipal = harness.currentSnapshot.principalId
    harness.getVerifiedAccountSnapshot.mockImplementationOnce(async () => {
      await Promise.resolve()
      harness.currentSnapshot = accountSnapshot(2, 'key-c')
      return harness.currentSnapshot
    })

    await expect(
      memory.remember({
        content: 'Reviewed import remains in the selected account.',
        scope: 'project',
        projectId: 'project-1',
        expectedPrincipalId: reviewedPrincipal,
        writeIntent: 'confirmed',
        visibility: 'syncable',
      })
    ).rejects.toThrow('selected memory account changed')

    expect(harness.fetch).not.toHaveBeenCalled()
    await expect(memory.recall({ query: 'Reviewed import', projectId: 'project-1' })).resolves.toEqual([])
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

  it('uses the bounded redirect-safe path with the new verified key for a pre-rotation outbox', async () => {
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
    expect(rememberCall?.[1]?.redirect).toBe('error')
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

  it('returns relevant local evidence without unrelated high-importance or substring matches', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    for (const content of ['Die Kalenderfarben sind blau.', 'Klappbare Navigation verwenden.']) {
      await memory.remember({ content, projectId: 'project-1', writeIntent: 'explicit', importance: 1 })
    }
    await expect(memory.recall({ projectId: 'project-1', query: 'Bitte App Speicher optimieren' })).resolves.toEqual([])
    await expect(memory.recall({ projectId: 'project-1', query: '' })).resolves.toHaveLength(2)
  })

  it('finds tagged memories and technical feature names while preserving project isolation', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const tagged = await memory.remember({
      content: 'Jeden Entwurf kurz gemeinsam prüfen.',
      projectId: 'project-1',
      writeIntent: 'explicit',
      tags: ['Freigaben'],
    })
    const feature = await memory.remember({
      content: 'Die Quellen bei jeder Antwort anzeigen.',
      projectId: 'project-1',
      writeIntent: 'explicit',
      featureKey: 'memoryRecall.sources',
    })
    await memory.remember({
      content: 'Memory recall eines anderen Projekts',
      projectId: 'project-2',
      writeIntent: 'explicit',
      importance: 1,
    })
    await expect(memory.recall({ projectId: 'project-1', query: 'Freigabe' })).resolves.toEqual([
      expect.objectContaining({ id: tagged.id }),
    ])
    await expect(memory.recall({ projectId: 'project-1', query: 'memory_recall' })).resolves.toEqual([
      expect.objectContaining({ id: feature.id }),
    ])
  })

  it('applies local privacy eligibility before the result budget', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    for (let index = 0; index < 3; index++) {
      await memory.remember({
        content: `Navigation intern ${index}`,
        projectId: 'project-1',
        writeIntent: 'explicit',
        source: 'repository_graph',
        importance: 1,
        confidence: 1,
      })
    }
    const safe = await memory.remember({
      content: 'Navigation links anzeigen.',
      projectId: 'project-1',
      writeIntent: 'explicit',
      importance: 0.1,
      confidence: 0.1,
    })
    await expect(memory.recall({ projectId: 'project-1', query: 'Navigation', limit: 1 })).resolves.toEqual([
      expect.objectContaining({ id: safe.id }),
    ])
  })

  it('deduplicates identical local and SQL content even when their hash formats differ', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    await memory.remember({ content: 'Antworten kurz halten.', projectId: 'project-1', writeIntent: 'explicit' })
    await memory.flushPendingSync()
    await setServerEnabled(true)
    harness.fetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'remote-short-answer',
            content: 'Antworten  kurz halten.',
            content_hash: 'server-sha256',
            source: 'sql',
          },
        ],
      })
    )
    await expect(memory.recall({ projectId: 'project-1', query: 'Antworten' })).resolves.toHaveLength(1)
  })

  it('keeps semantic SQL-revalidated hits without returning unrelated SQL fallback rows', async () => {
    await setServerEnabled(true)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    harness.fetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: 'semantic', content: 'Antworten kurz halten.', source: 'cognee_revalidated', retrieval_score: 0.8 },
          { id: 'unrelated', content: 'Kalenderfarben sind blau.', source: 'sql', importance: 1, confidence: 1 },
        ],
      })
    )
    await expect(memory.recall({ projectId: 'project-1', query: 'Knapp formulieren' })).resolves.toEqual([
      expect.objectContaining({ id: 'semantic' }),
    ])
  })

  it.each([20, 11, 19.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'sends an integer limit within the canonical recall API contract for %s',
    async limit => {
      await setServerEnabled(true)
      const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
      const memory = new LuczorMemoryService()
      harness.fetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'valid', content: 'Navigation links' }] }))
      await expect(memory.recall({ projectId: 'project-1', query: 'Navigation', limit })).resolves.toHaveLength(1)
      const request = JSON.parse(String(harness.fetch.mock.calls[0]?.[1]?.body))
      expect(Number.isInteger(request.limit)).toBe(true)
      expect(request.limit).toBeGreaterThanOrEqual(1)
      expect(request.limit).toBeLessThanOrEqual(20)
    }
  )

  it('rejects malformed, private, expired, future, foreign and unconfirmed remote rows independently', async () => {
    await setServerEnabled(true)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const base = { content: 'Navigation links', source: 'sql' }
    harness.fetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          null,
          'malformed',
          { id: 'invalid-content', content: { nested: 'Navigation' } },
          { ...base, id: 'candidate', status: 'candidate' },
          { ...base, id: 'private', visibility: 'private' },
          { ...base, id: 'session', retention: 'session' },
          { ...base, id: 'expired', expires_at: '2000-01-01T00:00:00Z' },
          { ...base, id: 'future', valid_from: '2100-01-01T00:00:00Z' },
          { ...base, id: 'foreign-scope', scope: 'user' },
          { ...base, id: 'foreign-project', project_id: 'project-2' },
          { ...base, id: 'foreign-agent', agent_id: 'agent-2' },
          { ...base, id: 'foreign-session', session_id: 'session-2' },
          { ...base, id: 'repository', source_type: 'repository_graph' },
          { ...base, id: 'valid', tags: ['Bedienung'] },
        ],
      })
    )
    await expect(memory.recall({ projectId: 'project-1', query: 'Navigation' })).resolves.toEqual([
      expect.objectContaining({ id: 'valid', tags: ['Bedienung'] }),
    ])
  })

  it('suppresses a forgotten remote memory while its offline erasure is pending', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    await memory.forget('project', 'forgotten-remote', { projectId: 'project-1' })
    await memory.flushPendingSync()
    await setServerEnabled(true)
    harness.fetch.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'forgotten-remote', content: 'Navigation links' }] })
    )
    await expect(memory.recall({ projectId: 'project-1', query: 'Navigation' })).resolves.toEqual([])
    await expect(memory.pendingSyncCount()).resolves.toBe(1)
  })

  it('keeps a pending confirmed local replacement ahead of a stale remote feature version', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const replacement = await memory.remember({
      content: 'Navigation rechts anzeigen.',
      projectId: 'project-1',
      featureKey: 'navigation.side',
      writeIntent: 'explicit',
    })
    await memory.flushPendingSync()
    await setServerEnabled(true)
    harness.fetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'old-feature',
            content: 'Navigation links anzeigen.',
            feature_key: 'navigation.side',
            importance: 1,
            confidence: 1,
          },
        ],
      })
    )
    await expect(memory.recall({ projectId: 'project-1', query: 'Navigation' })).resolves.toEqual([
      expect.objectContaining({ id: replacement.id, content: 'Navigation rechts anzeigen.' }),
    ])
  })

  it('drops local and remote snapshots erased while recall was in flight, even after server acknowledgement', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const record = await memory.remember({
      content: 'Navigation links anzeigen.',
      projectId: 'project-1',
      writeIntent: 'explicit',
    })
    await memory.flushPendingSync()
    await setServerEnabled(true)
    let releaseRecall!: (response: Response) => void
    let recallStarted!: () => void
    const started = new Promise<void>(resolve => {
      recallStarted = resolve
    })
    harness.fetch.mockImplementation(async (url: unknown) => {
      if (String(url).endsWith('/memory/recall')) {
        recallStarted()
        return new Promise<Response>(resolve => {
          releaseRecall = resolve
        })
      }
      return jsonResponse({ forgotten: true, already_absent: false })
    })
    const recalling = memory.recall({ projectId: 'project-1', query: 'Navigation' })
    await started
    await memory.forget('project', record.id, { projectId: 'project-1' })
    await memory.flushPendingSync()
    await expect(memory.pendingSyncCount()).resolves.toBe(0)
    releaseRecall(jsonResponse({ data: [{ id: record.id, content: record.content }] }))
    await expect(recalling).resolves.toEqual([])
  })

  it('discards recall results if the active account changes during the remote request', async () => {
    await setServerEnabled(true)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    harness.fetch.mockImplementationOnce(async () => {
      harness.currentSnapshot = accountSnapshot(2, 'key-account-b')
      return jsonResponse({ data: [{ id: 'account-a-memory', content: 'Navigation links' }] })
    })
    await expect(memory.recall({ projectId: 'project-1', query: 'Navigation' })).resolves.toEqual([])
  })

  it('returns the latest local evidence when its metadata changes during remote recall', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    const original = await memory.remember({
      content: 'Navigation links anzeigen.',
      projectId: 'project-1',
      writeIntent: 'explicit',
      tags: ['Entwurf'],
    })
    await memory.flushPendingSync()
    await setServerEnabled(true)
    harness.fetch.mockImplementationOnce(async () => {
      await setServerEnabled(false)
      await memory.remember({
        content: original.content,
        projectId: 'project-1',
        writeIntent: 'explicit',
        tags: ['Geprüft'],
      })
      return jsonResponse({ data: [] })
    })
    await expect(memory.recall({ projectId: 'project-1', query: 'Navigation' })).resolves.toEqual([
      // Metadata edits create a new immutable write instead of changing a
      // payload already associated with the original server write ID.
      expect.objectContaining({ id: expect.not.stringMatching(original.id), tags: ['Geprüft'] }),
    ])
  })

  it('does not let a remote copy override an explicit local-only content policy', async () => {
    await setServerEnabled(false)
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const memory = new LuczorMemoryService()
    await memory.remember({
      content: 'Navigation intern aufbauen.',
      projectId: 'project-1',
      writeIntent: 'explicit',
      visibility: 'private',
    })
    await memory.flushPendingSync()
    await setServerEnabled(true)
    harness.fetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'remote-copy',
            content: 'Navigation intern aufbauen.',
            source: 'sql',
          },
        ],
      })
    )
    await expect(memory.recall({ projectId: 'project-1', query: 'Navigation' })).resolves.toEqual([])
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
