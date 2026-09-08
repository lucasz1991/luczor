import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  const store = {
    get: vi.fn(async (key: string) => values.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value))
    }),
    save: vi.fn(async () => undefined),
  }
  return {
    values,
    store,
    createProject: vi.fn(),
    getConfigSnapshot: vi.fn(),
    unbindProjectWorkspace: vi.fn(),
    state: { projects: [] as Array<{ id: string }> },
  }
})

vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: vi.fn(async () => harness.store) } }))
vi.mock('@/services/api/luczorApi', () => ({
  LuczorApi: {
    createProject: harness.createProject,
    getConfigSnapshot: harness.getConfigSnapshot,
  },
}))
vi.mock('@/state/store', () => ({ state: harness.state }))
vi.mock('@/services/projectWorkspace', () => ({ unbindProjectWorkspace: harness.unbindProjectWorkspace }))

import {
  commitProjectSync,
  enqueueProjectSync,
  flushProjectSyncQueue,
  pendingProjectSyncCount,
  resetProjectSyncQueueRuntimeForTests,
} from '@/services/api/projectSyncQueue'
import type { LuczorApiConfigSnapshot } from '@/services/api/luczorApi'

const config = Object.freeze({
  baseUrl: 'https://luczor.test',
  deviceKey: 'device-a',
  clientId: 'client-a',
}) satisfies LuczorApiConfigSnapshot

describe('durable project-create synchronization queue', () => {
  beforeEach(() => {
    resetProjectSyncQueueRuntimeForTests()
    harness.values.clear()
    vi.clearAllMocks()
    harness.getConfigSnapshot.mockResolvedValue(config)
    harness.createProject.mockResolvedValue({ data: {} })
    harness.unbindProjectWorkspace.mockResolvedValue(undefined)
    harness.state.projects = [{ id: 'project-a' }, { id: 'project-b' }]
  })

  it('retains a failed idempotent POST and removes it after a later retry', async () => {
    const staged = await enqueueProjectSync('project-a', 'Projekt A', config)
    await commitProjectSync(staged, () => undefined)
    harness.createProject.mockRejectedValueOnce(new Error('offline'))

    await expect(flushProjectSyncQueue({ config })).resolves.toEqual({ attempted: 1, synced: 0, pending: 1 })
    await expect(pendingProjectSyncCount(config)).resolves.toBe(1)

    await expect(flushProjectSyncQueue({ config, force: true })).resolves.toEqual({
      attempted: 1,
      synced: 1,
      pending: 0,
    })
    expect(harness.createProject).toHaveBeenNthCalledWith(1, 'project-a', 'Projekt A', undefined, config)
    expect(harness.createProject).toHaveBeenNthCalledWith(2, 'project-a', 'Projekt A', undefined, config)
    await expect(pendingProjectSyncCount(config)).resolves.toBe(0)
  })

  it('keeps an aborted POST queued for the exact API identity', async () => {
    const abort = new AbortController()
    const staged = await enqueueProjectSync('project-a', 'Projekt A', config)
    await commitProjectSync(staged, () => undefined)
    harness.createProject.mockImplementationOnce(async () => {
      abort.abort()
      throw new DOMException('Aborted', 'AbortError')
    })

    await expect(flushProjectSyncQueue({ config, signal: abort.signal })).resolves.toEqual({
      attempted: 1,
      synced: 0,
      pending: 1,
    })
    await expect(pendingProjectSyncCount(config)).resolves.toBe(1)
  })

  it('isolates retries by API credential and preserves the original queue', async () => {
    const other = Object.freeze({ ...config, deviceKey: 'device-b' })
    const staged = await enqueueProjectSync('project-a', 'Projekt A', config)
    await commitProjectSync(staged, () => undefined)

    await expect(flushProjectSyncQueue({ config: other, force: true })).resolves.toEqual({
      attempted: 0,
      synced: 0,
      pending: 0,
    })
    expect(harness.createProject).not.toHaveBeenCalled()
    await expect(pendingProjectSyncCount(config)).resolves.toBe(1)
  })

  it('drains a bounded batch in stable FIFO order', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(2)
    const stagedB = await enqueueProjectSync('project-b', 'Projekt B', config)
    await commitProjectSync(stagedB, () => undefined)
    now.mockReturnValueOnce(1)
    const stagedA = await enqueueProjectSync('project-a', 'Projekt A', config)
    await commitProjectSync(stagedA, () => undefined)
    now.mockRestore()

    await expect(flushProjectSyncQueue({ config, force: true, maxEntries: 1 })).resolves.toEqual({
      attempted: 1,
      synced: 1,
      pending: 1,
    })
    expect(harness.createProject).toHaveBeenCalledWith('project-a', 'Projekt A', undefined, config)
  })

  it('fails closed when the persisted queue is malformed', async () => {
    harness.values.set('queue_v1', { version: 1, entries: [{ externalId: 'project-a' }] })

    await expect(pendingProjectSyncCount(config)).rejects.toThrow('ungültigen Eintrag')
    expect(harness.createProject).not.toHaveBeenCalled()
  })

  it('removes the exact staged entry when the final local execution assertion is revoked', async () => {
    const staged = await enqueueProjectSync('project-a', 'Projekt A', config)

    await expect(
      commitProjectSync(staged, () => {
        throw new Error('execution revoked')
      })
    ).rejects.toThrow('execution revoked')

    await expect(pendingProjectSyncCount(config)).resolves.toBe(0)
    await expect(flushProjectSyncQueue({ config, force: true })).resolves.toEqual({
      attempted: 0,
      synced: 0,
      pending: 0,
    })
    expect(harness.createProject).not.toHaveBeenCalled()
  })

  it('keeps a parallel flush behind the durable local commit', async () => {
    const staged = await enqueueProjectSync('project-a', 'Projekt A', config)
    let releaseLocal!: () => void
    let localCommitted = false
    const committing = commitProjectSync(
      staged,
      () =>
        new Promise<void>(resolve => {
          releaseLocal = () => {
            localCommitted = true
            resolve()
          }
        })
    )
    await vi.waitFor(() => expect(releaseLocal).toBeTypeOf('function'))
    const flushing = flushProjectSyncQueue({ config, force: true })

    await Promise.resolve()
    expect(localCommitted).toBe(false)
    expect(harness.createProject).not.toHaveBeenCalled()
    releaseLocal()

    await committing
    await expect(flushing).resolves.toEqual({ attempted: 1, synced: 1, pending: 0 })
    expect(localCommitted).toBe(true)
    expect(harness.createProject).toHaveBeenCalledOnce()
  })

  it('never flushes a ready crash remnant without its committed local project', async () => {
    const staged = await enqueueProjectSync('project-a', 'Projekt A', config, {
      workspacePrincipalId: 'account:v2:principal-a',
    })
    await commitProjectSync(staged, () => undefined)
    harness.state.projects = []

    await expect(flushProjectSyncQueue({ config, force: true })).resolves.toEqual({
      attempted: 0,
      synced: 0,
      pending: 0,
    })
    await expect(pendingProjectSyncCount(config)).resolves.toBe(0)
    expect(harness.createProject).not.toHaveBeenCalled()
    expect(harness.unbindProjectWorkspace).toHaveBeenCalledWith('project-a', 'account:v2:principal-a')
  })

  it('prunes a staged crash remnant once no live operation owns it', async () => {
    await enqueueProjectSync('project-a', 'Projekt A', config)
    resetProjectSyncQueueRuntimeForTests()
    harness.state.projects = []

    await expect(pendingProjectSyncCount(config)).resolves.toBe(0)
    const document = harness.values.get('queue_v1') as { entries: unknown[] }
    expect(document.entries).toEqual([])
  })

  it('recovers an orphaned native workspace before deleting its crash marker', async () => {
    await enqueueProjectSync('project-a', 'Projekt A', config, {
      workspacePrincipalId: 'account:v2:principal-a',
    })
    resetProjectSyncQueueRuntimeForTests()
    harness.state.projects = []

    await expect(pendingProjectSyncCount(config)).resolves.toBe(0)
    expect(harness.unbindProjectWorkspace).toHaveBeenCalledWith('project-a', 'account:v2:principal-a')
    const document = harness.values.get('queue_v1') as { entries: unknown[] }
    expect(document.entries).toEqual([])
  })

  it('retains the workspace recovery marker when native unbind is temporarily unavailable', async () => {
    await enqueueProjectSync('project-a', 'Projekt A', config, {
      workspacePrincipalId: 'account:v2:principal-a',
    })
    resetProjectSyncQueueRuntimeForTests()
    harness.state.projects = []
    harness.unbindProjectWorkspace.mockRejectedValueOnce(new Error('database busy'))

    await expect(pendingProjectSyncCount(config)).resolves.toBe(0)
    const document = harness.values.get('queue_v1') as { entries: unknown[] }
    expect(document.entries).toHaveLength(1)
  })

  it('does not prune a staged entry that still has a live commit owner', async () => {
    const staged = await enqueueProjectSync('project-a', 'Projekt A', config)

    await expect(pendingProjectSyncCount(config)).resolves.toBe(0)
    await expect(commitProjectSync(staged, () => undefined)).resolves.toBeUndefined()
    await expect(pendingProjectSyncCount(config)).resolves.toBe(1)
  })

  it('promotes a staged crash marker when the local project was already durably restored', async () => {
    await enqueueProjectSync('project-a', 'Projekt A', config, {
      workspacePrincipalId: 'account:v2:principal-a',
    })
    resetProjectSyncQueueRuntimeForTests()

    await expect(pendingProjectSyncCount(config)).resolves.toBe(1)
    expect(harness.unbindProjectWorkspace).not.toHaveBeenCalled()
    await expect(flushProjectSyncQueue({ config, force: true })).resolves.toEqual({
      attempted: 1,
      synced: 1,
      pending: 0,
    })
  })

  it('rejects an incomplete API identity before writing a misleading queue entry', async () => {
    await expect(enqueueProjectSync('project-a', 'Projekt A', { ...config, deviceKey: '' })).rejects.toThrow(
      'vollständig konfiguriert'
    )
    expect(harness.store.set).not.toHaveBeenCalled()
    expect(harness.createProject).not.toHaveBeenCalled()
  })
})
