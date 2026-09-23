import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: vi.fn() }))
vi.mock('@/services/executionGate', () => ({ executionGate: { capture: vi.fn() } }))
vi.mock('@/state/store', () => ({ state: { projects: [] } }))
vi.mock('@/services/memory/luczorMemory', () => ({ luczorMemory: {}, memoryUseServer: vi.fn() }))
vi.mock('@/services/memory/memoryServerCapabilities', () => ({
  getMemoryServerCapabilities: vi.fn(),
  memoryServerRequest: vi.fn(),
}))
import { createMemorySyncCoordinator } from '@/services/memory/memorySyncCoordinator'
import {
  emptyMemorySyncState,
  type MemoryChangePage,
  type MemorySyncIdentity,
  type MemorySyncState,
} from '@/services/memory/memorySyncState'

const snapshot = {
  principalId: 'principal',
  serverInstance: 'https://luczor.test',
  serverOrigin: 'https://luczor.test',
  accountId: 1,
  config: { baseUrl: 'https://luczor.test', deviceKey: 'fake', clientId: 'client' },
}
const page = (cursor: string, hasMore = false): MemoryChangePage => ({
  version: 1,
  cursor,
  has_more: hasMore,
  reset: false,
  changes: [],
})
function fixture() {
  let persisted: MemorySyncState | undefined
  const deps = {
    enabled: vi.fn(async () => true),
    account: vi.fn(async () => snapshot),
    projects: vi.fn(() => [] as string[]),
    pending: vi.fn(async () => 2),
    flush: vi.fn(async (_options?: { force?: boolean }) => 0),
    capabilities: vi.fn(async () => ({
      memory_change_feed: 1,
      memory_change_scopes: ['user', 'project'],
      memory_deletion_receipts: 1,
    })),
    request: vi.fn(async () => page('c1')),
    read: vi.fn(async (identity: MemorySyncIdentity) => persisted ?? emptyMemorySyncState(identity)),
    apply: vi.fn(async (input: MemorySyncIdentity & { page: MemoryChangePage; expectedCursor: string | null }) => {
      persisted = { ...emptyMemorySyncState(input), cursor: input.page.cursor }
    }),
    update: vi.fn(async () => {}),
  }
  // The production generic request returns validated wire DTOs; fixture schedules those DTOs below.
  const coordinator = createMemorySyncCoordinator({ ...deps, request: deps.request as never })
  return { deps, coordinator, cursor: () => persisted?.cursor }
}

describe('canonical memory synchronization', () => {
  beforeEach(() => vi.clearAllMocks())
  it('does not access the account or server while server memory is disabled', async () => {
    const { coordinator, deps } = fixture()
    deps.enabled.mockResolvedValue(false)
    await coordinator.synchronize({ force: true })
    expect(deps.account).not.toHaveBeenCalled()
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('forces the real memory outbox and commits each next page against the durable previous cursor', async () => {
    const { coordinator, deps, cursor } = fixture()
    deps.request.mockResolvedValueOnce(page('c1', true)).mockResolvedValueOnce(page('c2'))
    const result = await coordinator.synchronize({ force: true })
    expect(deps.flush).toHaveBeenCalledWith({ force: true })
    expect(deps.apply.mock.calls.map(call => call[0].expectedCursor)).toEqual([null, 'c1'])
    expect(cursor()).toBe('c2')
    expect(result.pages).toBe(2)
  })
  it('does not commit a page received after an account switch', async () => {
    const { coordinator, deps, cursor } = fixture()
    deps.request.mockImplementationOnce(async () => {
      deps.account.mockResolvedValue({ ...snapshot, principalId: 'another-account' })
      return page('foreign')
    })
    await expect(coordinator.synchronize()).rejects.toThrow('identity_changed')
    expect(deps.apply).not.toHaveBeenCalled()
    expect(cursor()).toBeUndefined()
  })
  it('retains the cursor after a failed local transaction and re-requests it on explicit retry', async () => {
    const { coordinator, deps, cursor } = fixture()
    deps.apply.mockRejectedValueOnce(new Error('disk_failure'))
    expect((await coordinator.synchronize()).errors).toEqual(['disk_failure'])
    expect(cursor()).toBeUndefined()
    await coordinator.synchronize({ force: true })
    expect(deps.apply.mock.calls[1]![0].expectedCursor).toBeNull()
    expect(cursor()).toBe('c1')
  })
  it('leaves older servers compatible without querying a nonexistent feed', async () => {
    const { coordinator, deps } = fixture()
    deps.capabilities.mockResolvedValue({
      memory_change_feed: 0,
      memory_change_scopes: [],
      memory_deletion_receipts: 0,
    })
    expect((await coordinator.synchronize()).supported).toBe(false)
    expect(deps.flush).toHaveBeenCalledOnce()
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('rejects a repeating has-more cursor instead of looping', async () => {
    const { coordinator, deps } = fixture()
    deps.request.mockResolvedValue(page('c1', true))
    const result = await coordinator.synchronize({ force: true })
    expect(result.errors).toEqual(['invalid_memory_change_page'])
    expect(deps.request).toHaveBeenCalledTimes(2)
  })
  it('bounds background pages and resumes at the committed cursor', async () => {
    const { coordinator, deps } = fixture()
    deps.request
      .mockResolvedValueOnce(page('c1', true))
      .mockResolvedValueOnce(page('c2', true))
      .mockResolvedValueOnce(page('c3'))
    expect((await coordinator.synchronize()).hasMore).toBe(true)
    await coordinator.synchronize()
    expect(deps.apply.mock.calls[2]![0].expectedCursor).toBe('c2')
  })
  it('accepts a first-page baseline reset, but never a reset of an existing cursor', async () => {
    const { coordinator, deps } = fixture()
    deps.request.mockResolvedValue({ ...page('initial'), reset: true })
    expect((await coordinator.synchronize()).errors).toEqual([])
    expect((await coordinator.synchronize({ force: true })).errors).toEqual(['invalid_memory_change_page'])
    expect(deps.apply).toHaveBeenCalledOnce()
  })
})
