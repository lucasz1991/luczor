import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: { get: vi.fn(), set: vi.fn(), save: vi.fn() },
  setSyncStatus: vi.fn(),
  pendingSyncCount: vi.fn(),
  memoryHealth: vi.fn(),
  getConfig: vi.fn(),
  health: vi.fn(),
  pushAllToServer: vi.fn(),
  pendingProjectSyncCount: vi.fn(),
  flushProjectSyncQueue: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: vi.fn(async () => mocks.settings) } }))
vi.mock('@/state/hud', () => ({ setSyncStatus: mocks.setSyncStatus }))
vi.mock('@/services/memory/luczorMemory', () => ({
  luczorMemory: { pendingSyncCount: mocks.pendingSyncCount, memoryHealth: mocks.memoryHealth },
}))
vi.mock('@/services/api/luczorApi', () => ({
  LuczorApi: { getConfig: mocks.getConfig, health: mocks.health },
}))
vi.mock('@/services/api/sync', () => ({ pushAllToServer: mocks.pushAllToServer }))
vi.mock('@/services/api/projectSyncQueue', () => ({
  pendingProjectSyncCount: mocks.pendingProjectSyncCount,
  flushProjectSyncQueue: mocks.flushProjectSyncQueue,
}))

import { refreshStatus, syncNow } from '@/services/status'

describe('project-create queue status integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pendingSyncCount.mockResolvedValue(0)
    mocks.memoryHealth.mockResolvedValue(null)
    mocks.getConfig.mockResolvedValue({ baseUrl: 'https://luczor.test', deviceKey: 'key', clientId: 'client' })
    mocks.health.mockResolvedValue({ status: 'ok' })
    mocks.pendingProjectSyncCount.mockResolvedValue(0)
    mocks.flushProjectSyncQueue.mockResolvedValue({ attempted: 0, synced: 0, pending: 0 })
    mocks.pushAllToServer.mockResolvedValue({ ok: true, counts: {}, cursor: 'cursor' })
  })

  it('retries queued project creates whenever the heartbeat sees the server online', async () => {
    mocks.pendingProjectSyncCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    mocks.flushProjectSyncQueue.mockResolvedValueOnce({ attempted: 1, synced: 1, pending: 0 })

    await refreshStatus()

    expect(mocks.flushProjectSyncQueue).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) })
    expect(mocks.setSyncStatus).toHaveBeenCalledWith({ pending: 0, server: 'online', cognee: 'disabled' })
  })

  it('keeps the queue untouched while the configured server is offline', async () => {
    mocks.pendingProjectSyncCount.mockResolvedValue(1)
    mocks.health.mockRejectedValueOnce(new Error('offline'))

    await refreshStatus()

    expect(mocks.flushProjectSyncQueue).not.toHaveBeenCalled()
    expect(mocks.setSyncStatus).toHaveBeenCalledWith({ pending: 1, server: 'offline', cognee: 'disabled' })
  })

  it('forces a bounded project-create retry batch during a manual sync', async () => {
    mocks.flushProjectSyncQueue.mockResolvedValueOnce({ attempted: 2, synced: 2, pending: 0 })
    mocks.pushAllToServer.mockResolvedValueOnce({ ok: true, counts: { projects: 3 }, cursor: 'cursor' })

    await expect(syncNow()).resolves.toBe(3)

    expect(mocks.flushProjectSyncQueue).toHaveBeenNthCalledWith(1, {
      force: true,
      signal: expect.any(AbortSignal),
    })
    expect(mocks.pushAllToServer).toHaveBeenCalledOnce()
  })
})
