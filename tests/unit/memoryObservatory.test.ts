import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const harness = vi.hoisted(() => ({
  mounts: [] as Array<() => unknown>,
  disposals: [] as Array<() => void>,
  handlers: new Map<string, (event?: unknown) => unknown>(),
  emit: vi.fn(),
  inspect: vi.fn(),
  graph: vi.fn(),
  account: vi.fn(),
  release: vi.fn(),
}))
vi.mock('vue', async importOriginal => ({
  ...(await importOriginal<typeof import('vue')>()),
  onMounted: (callback: () => unknown) => harness.mounts.push(callback),
  onBeforeUnmount: (callback: () => void) => harness.disposals.push(callback),
}))
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: harness.emit,
  listen: vi.fn(async (name, callback) => {
    harness.handlers.set(name, callback)
    return harness.release
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: harness.account }))
vi.mock('@/services/memory/luczorMemory', () => ({
  luczorMemory: { inspectLocal: harness.inspect, sharedMaintenance: vi.fn(async () => []) },
  getMemoryPrefs: async () => ({ inject: true, injectCount: 5, autoRemember: true }),
}))
vi.mock('@/services/repositoryGraph', () => ({ repositoryGraphStatus: harness.graph }))
vi.mock('@/services/agents/idleOptimization', () => ({
  idleOptimizationStatus: { value: null },
  idleMemoryMaintenance: { value: 'idle' },
}))
vi.mock('@/services/assistantProfile', () => ({
  assistantProfileState: { source: 'admin', profile: { persona: { prompt: 'SECRET_PROMPT' }, skills: [] } },
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.mounts.length = 0
  harness.disposals.length = 0
  harness.handlers.clear()
  vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }))
  harness.account.mockResolvedValue({ principalId: 'account:test' })
  harness.emit.mockResolvedValue(undefined)
  harness.inspect.mockResolvedValue({
    total: 3,
    active: 2,
    candidates: 1,
    pending: 0,
    synced: 0,
    records: [{ content: 'SECRET_MEMORY' }],
  })
  harness.graph.mockResolvedValue({
    status: 'ready',
    files: 3,
    symbols: 6,
    edges: 2,
    skipped: 0,
    error: 'PRIVATE_PATH',
  })
})
afterEach(() => {
  for (const dispose of harness.disposals) dispose()
  vi.unstubAllGlobals()
})
async function mount() {
  for (const callback of harness.mounts) await callback()
}

describe('main-owned memory status transport', () => {
  it('publishes only inventory counters and graph metadata to the status window', async () => {
    const { useMemoryObservatoryHost, memoryStatus } = await import('@/features/memory/observatory')
    useMemoryObservatoryHost(() => ({ id: 'project', name: 'Project' }), vi.fn())
    await mount()
    harness.handlers.get('luczor-memory-status-request')?.()
    await vi.waitFor(() => expect(memoryStatus.value?.inventory?.total).toBe(3))
    expect(harness.emit).toHaveBeenCalledWith(
      'luczor-system-status',
      'luczor-memory-status-snapshot',
      expect.objectContaining({ projectId: 'project' })
    )
    expect(JSON.stringify(harness.emit.mock.calls)).not.toMatch(/SECRET_MEMORY|SECRET_PROMPT|PRIVATE_PATH|account:test/)
  })
  it('shares in-flight inspection and discards data after account invalidation', async () => {
    let finish!: (value: unknown) => void
    harness.inspect.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )
    const { useMemoryObservatoryHost, memoryStatus } = await import('@/features/memory/observatory')
    useMemoryObservatoryHost(() => ({ id: 'project', name: 'Project' }), vi.fn())
    await mount()
    const request = harness.handlers.get('luczor-memory-status-request')!
    request()
    request()
    request()
    await vi.waitFor(() => expect(harness.inspect).toHaveBeenCalledTimes(1))
    window.dispatchEvent(new Event('luczor:api-identity-changing'))
    finish({ total: 999, records: [] })
    await vi.waitFor(() => expect(harness.account).toHaveBeenCalledTimes(2))
    expect(memoryStatus.value).toBeNull()
    expect(harness.emit.mock.calls.some(call => call[2]?.inventory?.total === 999)).toBe(false)
  })
  it('secondary views request host data without opening memory storage', async () => {
    const { useMemoryStatus, memoryStatus } = await import('@/features/memory/observatory')
    useMemoryStatus(() => true, true)
    await mount()
    expect(harness.emit).toHaveBeenCalledWith('main', 'luczor-memory-status-request')
    expect(harness.inspect).not.toHaveBeenCalled()
    harness.handlers.get('luczor-memory-status-snapshot')?.({ payload: null })
    expect(memoryStatus.value).toBeNull()
  })
})
