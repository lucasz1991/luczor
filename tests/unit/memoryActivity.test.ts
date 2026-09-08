import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const files = new Map<string, Map<string, unknown>>()
  return {
    files,
    loadStore: vi.fn(async (filename: string) => {
      let values = files.get(filename)
      if (!values) {
        values = new Map<string, unknown>()
        files.set(filename, values)
      }
      return {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: unknown) => values.set(key, value),
        delete: async (key: string) => values.delete(key),
        save: async () => undefined,
      }
    }),
    account: vi.fn(async () => null),
  }
})

vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: harness.loadStore } }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'memory_key_get_or_create') return '11'.repeat(32)
    throw new Error(`Unexpected command: ${command}`)
  }),
}))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: harness.account }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.files.clear()
  harness.files.set('luczor.settings.json', new Map([['memory_use_server', false]]))
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network request')
    })
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('memory activity counters', () => {
  it('starts with real zero counts and provides immutable detached snapshots', async () => {
    const { snapshotMemoryActivity, trackMemoryActivity } = await import('@/services/memory/activity')
    const initial = snapshotMemoryActivity()
    expect(initial).toEqual({
      reads: 0,
      writes: 0,
      activeReads: 0,
      activeWrites: 0,
      failedReads: 0,
      failedWrites: 0,
      measuredSince: expect.any(Number),
    })
    expect(Object.isFrozen(initial)).toBe(true)
    await trackMemoryActivity('read', () => ['private result'])
    expect(initial.reads).toBe(0)
    expect(snapshotMemoryActivity().reads).toBe(1)
    expect(snapshotMemoryActivity().measuredSince).toBe(initial.measuredSince)
  })

  it('tracks overlapping reads and writes until each operation settles', async () => {
    const { snapshotMemoryActivity, trackMemoryActivity } = await import('@/services/memory/activity')
    const first = deferred<string>()
    const second = deferred<string>()
    const write = deferred<void>()
    const operations = [
      trackMemoryActivity('read', () => first.promise),
      trackMemoryActivity('read', () => second.promise),
      trackMemoryActivity('write', () => write.promise),
    ]
    expect(snapshotMemoryActivity()).toMatchObject({ reads: 0, writes: 0, activeReads: 2, activeWrites: 1 })
    first.resolve('first')
    expect(await operations[0]).toBe('first')
    expect(snapshotMemoryActivity()).toMatchObject({ reads: 1, writes: 0, activeReads: 1, activeWrites: 1 })
    write.resolve()
    await operations[2]
    second.resolve('second')
    await operations[1]
    expect(snapshotMemoryActivity()).toMatchObject({ reads: 2, writes: 1, activeReads: 0, activeWrites: 0 })
  })

  it('retains the original rejection and counts synchronous and asynchronous failures once', async () => {
    const { snapshotMemoryActivity, trackMemoryActivity } = await import('@/services/memory/activity')
    const privateError = new Error('PRIVATE_ERROR_WITH_KEY')
    await expect(
      trackMemoryActivity('read', () => {
        throw privateError
      })
    ).rejects.toBe(privateError)
    const pending = deferred<void>()
    const write = trackMemoryActivity('write', () => pending.promise)
    pending.reject(privateError)
    await expect(write).rejects.toBe(privateError)
    expect(snapshotMemoryActivity()).toMatchObject({
      reads: 0,
      writes: 0,
      failedReads: 1,
      failedWrites: 1,
      activeReads: 0,
      activeWrites: 0,
    })
    expect(JSON.stringify(snapshotMemoryActivity())).not.toContain('PRIVATE_ERROR_WITH_KEY')
  })

  it('counts repeated partial-failure signals once while preserving the fallback result', async () => {
    const { snapshotMemoryActivity, trackMemoryActivity } = await import('@/services/memory/activity')
    const fallback = [{ content: 'PRIVATE_LOCAL_MEMORY', id: 'private-id' }]
    expect(
      await trackMemoryActivity('read', markFailed => {
        markFailed()
        markFailed()
        return fallback
      })
    ).toBe(fallback)
    expect(snapshotMemoryActivity()).toMatchObject({ reads: 0, failedReads: 1, activeReads: 0 })
    expect(JSON.stringify(snapshotMemoryActivity())).not.toMatch(/PRIVATE_LOCAL_MEMORY|private-id/)
  })
})

describe('memory facade instrumentation', () => {
  it('counts one logical write and one recall despite encryption and local reconciliation reads', async () => {
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const { snapshotMemoryActivity } = await import('@/services/memory/activity')
    const memory = new LuczorMemoryService()
    const record = await memory.remember({
      content: 'Navigation bevorzugt links.',
      scope: 'project',
      projectId: 'p1',
      writeIntent: 'confirmed',
    })
    expect(snapshotMemoryActivity()).toMatchObject({ reads: 0, writes: 1 })
    const hits = await memory.recall({ scope: 'project', projectId: 'p1', query: 'Navigation' })
    expect(hits.map(hit => hit.id)).toContain(record.id)
    expect(snapshotMemoryActivity()).toMatchObject({ reads: 1, writes: 1, failedReads: 0, failedWrites: 0 })
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(snapshotMemoryActivity())).not.toMatch(/Navigation|p1|device-local|content/)
  })

  it('does not count delegated checkpoints and prompt helpers twice or count health and sync status', async () => {
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const { snapshotMemoryActivity } = await import('@/services/memory/activity')
    const memory = new LuczorMemoryService()
    const checkpoint = {
      content: 'Dieser öffentliche Zwischenstand beschreibt den Fortschritt der Navigation ausführlich.',
      scope: 'project' as const,
      projectId: 'p1',
      sessionId: 's1',
      expectedPrincipalId: 'device-local',
    }
    expect(await memory.captureCheckpoint(checkpoint)).not.toBeNull()
    expect(await memory.captureCheckpoint(checkpoint)).toBeNull()
    expect(snapshotMemoryActivity()).toMatchObject({ writes: 1, reads: 0 })
    await memory.getContextForPrompt('p1', 'Navigation')
    expect(snapshotMemoryActivity()).toMatchObject({ writes: 1, reads: 1 })
    const beforeStatus = snapshotMemoryActivity()
    await memory.pendingSyncCount()
    await memory.memoryHealth()
    await memory.flushPendingSync()
    expect(snapshotMemoryActivity()).toEqual(beforeStatus)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('records local recall, analysis, candidates, promotion and erasure as their actual operation kind', async () => {
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const { snapshotMemoryActivity } = await import('@/services/memory/activity')
    const memory = new LuczorMemoryService()
    const candidate = await memory.remember({
      content: 'Navigation bevorzugt links.',
      projectId: 'p1',
      writeIntent: 'automatic',
    })
    const candidates = await memory.listCandidates('p1')
    expect(candidates.map(record => record.id)).toContain(candidate.id)
    await memory.promote(candidate.id)
    expect(await memory.recallLocal({ projectId: 'p1', query: 'Navigation' })).toHaveLength(1)
    await memory.analyze('project', { projectId: 'p1' })
    await memory.forget('project', candidate.id, { projectId: 'p1' })
    expect(snapshotMemoryActivity()).toMatchObject({
      reads: 3,
      writes: 3,
      failedReads: 0,
      failedWrites: 0,
      activeReads: 0,
      activeWrites: 0,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('counts swallowed local-recall failures once and leaves its empty fallback intact', async () => {
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const { snapshotMemoryActivity } = await import('@/services/memory/activity')
    const memory = new LuczorMemoryService()
    harness.files.set('luczor.memory.json', new Map([['state_v3_encrypted', 'invalid envelope']]))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await memory.recall({ projectId: 'p1', query: 'PRIVATE_QUERY' })).toEqual([])
    expect(snapshotMemoryActivity()).toMatchObject({ reads: 0, failedReads: 1, activeReads: 0 })
    expect(JSON.stringify(snapshotMemoryActivity())).not.toContain('PRIVATE_QUERY')
  })

  it('records rejected writes and local reads without retaining their request or failure payloads', async () => {
    const { LuczorMemoryService } = await import('@/services/memory/luczorMemory')
    const { snapshotMemoryActivity } = await import('@/services/memory/activity')
    const memory = new LuczorMemoryService()
    await expect(memory.remember({ content: '  ' })).rejects.toThrow('Memory content must not be empty')
    harness.files.set('luczor.memory.json', new Map([['state_v3_encrypted', 'PRIVATE_INVALID_ENVELOPE']]))
    await expect(memory.recallLocal({ query: 'PRIVATE_QUERY' })).rejects.toThrow('Local memory storage is unavailable')
    expect(snapshotMemoryActivity()).toMatchObject({
      reads: 0,
      writes: 0,
      failedReads: 1,
      failedWrites: 1,
      activeReads: 0,
      activeWrites: 0,
    })
    expect(JSON.stringify(snapshotMemoryActivity())).not.toMatch(/PRIVATE|content|Error/)
  })
})
