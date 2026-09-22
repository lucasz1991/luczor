import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

vi.mock('@/services/assistantProfile', () => ({
  assistantProfileState: { source: 'none', profile: { revision: '0', skills: [], persona: null } },
}))
vi.mock('@/services/memory/luczorMemory', () => ({
  luczorMemory: { inspectLocal: vi.fn(), recall: vi.fn(), maintenanceSnapshot: vi.fn() },
  getMemoryPrefs: vi.fn(),
}))
vi.mock('@/services/repositoryGraph', () => ({ inspectRepositoryGraph: vi.fn() }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: vi.fn() }))

import { memoryExplorerData } from '@/features/memory/explorerData'
import { resetMemoryGraphDataForTests, useMemoryGraphData } from '@/features/memory/useMemoryGraphData'

const record = (id: string, content: string) => ({
  id,
  content,
  type: 'fact',
  scope: 'project',
  status: 'active',
  source: 'user',
  visibility: 'private',
  retention: 'durable',
  confidence: 1,
  updatedAt: 1,
  synced: false,
  tags: [],
})

describe('shared knowledge-space data', () => {
  let records: ReturnType<typeof record>[]
  beforeEach(() => {
    vi.useFakeTimers()
    // Node has no window; the store only needs an event target for the app's memory events.
    vi.stubGlobal('window', new EventTarget())
    resetMemoryGraphDataForTests()
    records = [record('a', 'Alpha'), record('b', 'Beta')]
    memoryExplorerData.account = async () => ({ principalId: 'demo' })
    memoryExplorerData.inventory = (async () => ({
      records,
      total: records.length,
      filtered: records.length,
      active: records.length,
      candidates: 0,
      pending: 0,
      synced: 0,
    })) as never
    memoryExplorerData.graph = (async () => {
      throw new Error('no repository')
    }) as never
    memoryExplorerData.artifacts = async () => []
  })
  afterEach(() => {
    resetMemoryGraphDataForTests()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('loads once per project and shares the graph between backdrop and page', async () => {
    const data = useMemoryGraphData()
    data.ensureLoaded('p1')
    await vi.advanceTimersByTimeAsync(50)
    expect(data.project.value).toBe('p1')
    expect(data.graph.value.nodes.map(node => node.id)).toContain('memory:a')
    const inventorySpy = vi.spyOn(memoryExplorerData, 'inventory')
    data.ensureLoaded('p1')
    await vi.advanceTimersByTimeAsync(50)
    expect(inventorySpy).not.toHaveBeenCalled()
    expect(useMemoryGraphData().graph.value).toBe(data.graph.value)
  })

  it('marks new and replaced memories after an idle commit and lets them fade', async () => {
    const data = useMemoryGraphData()
    data.ensureLoaded('p1')
    await vi.advanceTimersByTimeAsync(50)
    records = [record('a', 'Alpha'), record('c', 'Gamma (aus Beta)')]
    window.dispatchEvent(new CustomEvent('luczor:memory-changed', { detail: { origin: 'idle' } }))
    // Soft reloads are debounced so a burst of writes refreshes once.
    await vi.advanceTimersByTimeAsync(1_000)
    await nextTick()
    const states = new Map(data.graph.value.nodes.map(node => [node.id, node.state]))
    expect(states.get('memory:c')).toBe('born')
    expect(states.get('memory:b')).toBe('removed')
    await vi.advanceTimersByTimeAsync(8_100)
    expect(data.graph.value.nodes.some(node => node.id === 'memory:b')).toBe(false)
    expect(data.graph.value.nodes.find(node => node.id === 'memory:c')?.state).toBeUndefined()
  })

  it('filters by system and keeps the selection valid', async () => {
    const data = useMemoryGraphData()
    data.ensureLoaded('p1')
    await vi.advanceTimersByTimeAsync(50)
    data.setSystem('Persönlichkeit')
    // The model core is the reference point and stays visible under every filter.
    expect(data.graph.value.nodes.every(node => node.system === 'Persönlichkeit' || node.id === 'model:local')).toBe(
      true
    )
    expect(data.graph.value.nodes[0]?.id).toBe('model:local')
    expect(data.selected.value).toBe('model:local')
    data.focusDreamTarget({ kind: 'memory', id: 'a' })
    expect(data.selected.value).toBe('model:local')
    data.setSystem('')
    data.focusDreamTarget({ kind: 'memory', id: 'a' })
    expect(data.selected.value).toBe('memory:a')
  })

  it('releases visual timers, caches and subscriptions on close and reloads on reopen', async () => {
    const data = useMemoryGraphData()
    const inventorySpy = vi.spyOn(memoryExplorerData, 'inventory')
    data.ensureLoaded('p1')
    await vi.advanceTimersByTimeAsync(50)
    window.dispatchEvent(new Event('luczor:memory-changed'))
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    data.stopListening()
    expect(vi.getTimerCount()).toBe(0)
    expect(data.inventory.value).toBeNull()
    inventorySpy.mockClear()
    window.dispatchEvent(new Event('luczor:memory-changed'))
    window.dispatchEvent(new Event('luczor:api-identity-changed'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(inventorySpy).not.toHaveBeenCalled()
    records = [record('fresh', 'New account data')]
    data.ensureLoaded('p1')
    await vi.advanceTimersByTimeAsync(50)
    expect(inventorySpy).toHaveBeenCalledOnce()
    expect(data.graph.value.nodes.map(node => node.id)).toContain('memory:fresh')
    data.stopListening()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores an outstanding load after the page closes', async () => {
    const data = useMemoryGraphData()
    let finish!: (value: Awaited<ReturnType<typeof memoryExplorerData.inventory>>) => void
    memoryExplorerData.inventory = vi.fn<typeof memoryExplorerData.inventory>(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    data.ensureLoaded('p1')
    await vi.advanceTimersByTimeAsync(1)
    data.stopListening()
    finish({ records: [], total: 0, filtered: 0, offset: 0, active: 0, candidates: 0, pending: 0, synced: 0 })
    await vi.advanceTimersByTimeAsync(1)
    expect(data.inventory.value).toBeNull()
    expect(data.loading.value).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
