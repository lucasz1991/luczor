import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IdleOptimizationContext } from '@/services/agents/idleOptimization'
import type { IdleContextOptimizerSnapshot } from '@/services/agents/idleContextOptimizer'

const fixture = vi.hoisted(() => ({
  mounts: [] as Array<() => void | Promise<void>>,
  cleanups: [] as Array<() => void>,
  invalidations: new Set<() => void>(),
  storeChanges: new Map<string, (key?: string) => void>(),
  deferredSubscriptions: new Map<string, Promise<() => void>>(),
  unlistenMemory: vi.fn(),
  unlistenSettings: vi.fn(),
  releaseAdmission: vi.fn(),
  releaseStatus: vi.fn(),
  releaseInvalidation: vi.fn(),
  releaseManualRequest: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  interrupt: vi.fn(),
  acquireForeground: vi.fn(),
  loadSetting: vi.fn(),
  setAdmission: vi.fn(),
  context: undefined as IdleOptimizationContext | undefined,
  statusListener: undefined as ((state: IdleContextOptimizerSnapshot) => void) | undefined,
  phase: 'running' as IdleContextOptimizerSnapshot['phase'],
}))

vi.mock('vue', async importOriginal => ({
  ...(await importOriginal<typeof import('vue')>()),
  onMounted: (callback: () => void | Promise<void>) => fixture.mounts.push(callback),
  onBeforeUnmount: (callback: () => void) => fixture.cleanups.push(callback),
}))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async (file: string) => ({
      onChange: async (callback: (key?: string) => void) => {
        fixture.storeChanges.set(file, callback)
        return (
          fixture.deferredSubscriptions.get(file) ??
          (file === 'luczor.memory.json' ? fixture.unlistenMemory : fixture.unlistenSettings)
        )
      },
    }),
  },
}))
vi.mock('@/services/agents/idleOptimization', async () => {
  const { shallowRef } = await import('vue')
  return {
    IDLE_OPTIMIZATION_KEY: 'local_idle_context_optimization',
    idleOptimizationEnabled: shallowRef(false),
    idleOptimizationStatus: shallowRef<IdleContextOptimizerSnapshot | null>(null),
    loadIdleOptimizationSetting: fixture.loadSetting,
    registerIdleOptimizationRequest: vi.fn(() => fixture.releaseManualRequest),
    createIdleOptimization: (context: IdleOptimizationContext) => {
      fixture.context = context
      return {
        start: fixture.start,
        stop: fixture.stop,
        interrupt: fixture.interrupt,
        acquireForeground: fixture.acquireForeground,
        snapshot: () => ({ phase: fixture.phase }),
        subscribe: (listener: (state: IdleContextOptimizerSnapshot) => void) => {
          fixture.statusListener = listener
          return fixture.releaseStatus
        },
      }
    },
  }
})
vi.mock('@/services/executionGate', () => ({
  onExecutionInvalidated: (listener: () => void) => {
    fixture.invalidations.add(listener)
    return () => {
      fixture.invalidations.delete(listener)
      fixture.releaseInvalidation()
    }
  },
}))
vi.mock('@/services/inference/resources', () => ({
  localResources: { setForegroundAdmission: fixture.setAdmission },
}))

import { effectScope, nextTick, reactive } from 'vue'
import type { Project } from '@/state/types'
import { useIdleOptimization } from '@/composables/useIdleOptimization'
import { idleOptimizationEnabled, idleOptimizationStatus } from '@/services/agents/idleOptimization'

function deferred<T>() {
  let resolve!: (result: T) => void
  const promise = new Promise<T>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}

let unmount: (() => void) | undefined

function setup() {
  const sources = reactive({ busy: false, draft: '', project: { id: 'project-1' } as Project })
  const scope = effectScope()
  scope.run(() =>
    useIdleOptimization({
      project: () => sources.project,
      busy: () => sources.busy,
      draft: () => sources.draft,
    })
  )
  let disposed = false
  unmount = () => {
    if (disposed) return
    disposed = true
    fixture.cleanups.forEach(cleanup => cleanup())
    scope.stop()
  }
  return { sources, mount: () => fixture.mounts[0]!(), unmount }
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.mounts.length = 0
  fixture.cleanups.length = 0
  fixture.invalidations.clear()
  fixture.storeChanges.clear()
  fixture.deferredSubscriptions.clear()
  fixture.context = undefined
  fixture.statusListener = undefined
  fixture.phase = 'running'
  fixture.stop.mockResolvedValue(undefined)
  fixture.loadSetting.mockImplementation(async () => {
    idleOptimizationEnabled.value = true
  })
  fixture.setAdmission.mockReturnValue(fixture.releaseAdmission)
  fixture.acquireForeground.mockResolvedValue({ release: vi.fn() })
  idleOptimizationEnabled.value = false
  idleOptimizationStatus.value = null
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', new EventTarget())
})
afterEach(async () => {
  unmount?.()
  await nextTick()
  vi.unstubAllGlobals()
})

describe('idle optimizer lifecycle and invalidation', () => {
  it('invalidates memory during generation and preserves its own candidate commit', async () => {
    const harness = setup()
    await harness.mount()
    const memoryChanged = fixture.storeChanges.get('luczor.memory.json')!
    memoryChanged()
    expect(fixture.interrupt).toHaveBeenLastCalledWith('memory_changed')
    fixture.interrupt.mockClear()
    fixture.phase = 'committing'
    memoryChanged()
    expect(fixture.interrupt).not.toHaveBeenCalled()
    fixture.phase = 'cooldown'
    memoryChanged()
    expect(fixture.interrupt).toHaveBeenCalledWith('memory_changed')
  })

  it('resets user idle grace synchronously for typing, busy state and selected project', async () => {
    const harness = setup()
    await harness.mount()
    harness.sources.draft = 'New prompt'
    expect(fixture.interrupt).toHaveBeenCalledTimes(1)
    harness.sources.busy = true
    expect(fixture.interrupt).toHaveBeenCalledTimes(2)
    harness.sources.project.id = 'project-2'
    expect(fixture.interrupt).toHaveBeenCalledTimes(3)
    expect(fixture.interrupt).toHaveBeenLastCalledWith('activity')
  })

  it('treats actual keyboard and pointer input as activity without reacting to pointer movement', async () => {
    const harness = setup()
    await harness.mount()
    fixture.phase = 'waiting'
    fixture.interrupt.mockClear()
    document.dispatchEvent(new Event('pointermove'))
    expect(fixture.interrupt).not.toHaveBeenCalled()
    document.dispatchEvent(new Event('pointerdown'))
    document.dispatchEvent(new Event('keydown'))
    expect(fixture.interrupt).toHaveBeenCalledTimes(2)
    expect(fixture.interrupt).toHaveBeenLastCalledWith('activity')
    fixture.phase = 'running'
    fixture.interrupt.mockClear()
    document.dispatchEvent(new Event('pointerdown'))
    expect(fixture.interrupt).not.toHaveBeenCalled()
    harness.sources.draft = 'A new chat request'
    expect(fixture.interrupt).toHaveBeenCalledWith('activity')
  })

  it('pauses throughout the actual API identity-changing interval and retains ordinary busy state afterwards', async () => {
    const harness = setup()
    await harness.mount()
    expect(fixture.context?.busy()).toBe(false)
    window.dispatchEvent(new Event('luczor:api-identity-changing'))
    expect(fixture.context?.busy()).toBe(true)
    expect(fixture.interrupt).toHaveBeenLastCalledWith('boundary_changed')
    await nextTick()
    expect(fixture.context?.busy()).toBe(true)
    harness.sources.busy = true
    window.dispatchEvent(new Event('luczor:api-identity-changed'))
    expect(fixture.context?.busy()).toBe(true)
    harness.sources.busy = false
    expect(fixture.context?.busy()).toBe(false)
    window.dispatchEvent(new Event('beforeunload'))
    expect(fixture.context?.busy()).toBe(true)
  })

  it('wires execution invalidation and whole-workflow admission without replacing abort signals', async () => {
    const harness = setup()
    await harness.mount()
    fixture.invalidations.forEach(invalidate => invalidate())
    expect(fixture.interrupt).toHaveBeenLastCalledWith('boundary_changed')
    const signal = new AbortController().signal
    const admission = fixture.setAdmission.mock.calls[0]![0] as (signal: AbortSignal) => Promise<unknown>
    await admission(signal)
    expect(fixture.acquireForeground).toHaveBeenCalledWith(signal)
  })

  it('reloads device settings on Store change, stops when disabled and restarts when enabled', async () => {
    const harness = setup()
    await harness.mount()
    await nextTick()
    fixture.start.mockClear()
    fixture.loadSetting.mockImplementation(async () => {
      idleOptimizationEnabled.value = false
    })
    // Other keys interrupt; the enable toggle itself must not cancel a pass it just requested.
    fixture.storeChanges.get('luczor.settings.json')!('local_idle_context_optimization')
    await nextTick()
    expect(fixture.interrupt).not.toHaveBeenCalledWith('settings_changed')
    fixture.storeChanges.get('luczor.settings.json')!('repository_external_policy')
    await nextTick()
    expect(fixture.interrupt).toHaveBeenLastCalledWith('settings_changed')
    expect(fixture.stop).toHaveBeenCalled()
    fixture.loadSetting.mockImplementation(async () => {
      idleOptimizationEnabled.value = true
    })
    fixture.storeChanges.get('luczor.settings.json')!('local_idle_context_optimization')
    await nextTick()
    expect(fixture.start).toHaveBeenCalledTimes(1)
  })

  it('fails closed when a changed setting cannot be read', async () => {
    const harness = setup()
    await harness.mount()
    await nextTick()
    fixture.loadSetting.mockRejectedValueOnce(new Error('Store temporarily unavailable'))
    fixture.storeChanges.get('luczor.settings.json')!()
    await nextTick()
    await nextTick()
    expect(idleOptimizationEnabled.value).toBe(false)
    expect(fixture.stop).toHaveBeenCalled()
  })

  it('cleans listeners immediately but retains foreground admission until model cancellation drains', async () => {
    const harness = setup()
    await harness.mount()
    const drain = deferred<void>()
    fixture.stop.mockReturnValue(drain.promise)
    harness.unmount()
    expect(fixture.unlistenMemory).toHaveBeenCalledTimes(1)
    expect(fixture.unlistenSettings).toHaveBeenCalledTimes(1)
    expect(fixture.releaseStatus).toHaveBeenCalledTimes(1)
    expect(fixture.releaseInvalidation).toHaveBeenCalledTimes(1)
    expect(fixture.releaseManualRequest).toHaveBeenCalledTimes(1)
    expect(fixture.releaseAdmission).not.toHaveBeenCalled()
    fixture.interrupt.mockClear()
    window.dispatchEvent(new Event('luczor:api-identity-changing'))
    window.dispatchEvent(new Event('luczor:api-identity-changed'))
    window.dispatchEvent(new Event('beforeunload'))
    fixture.invalidations.forEach(invalidate => invalidate())
    harness.sources.draft = 'Typing after teardown'
    idleOptimizationEnabled.value = !idleOptimizationEnabled.value
    await nextTick()
    expect(fixture.interrupt).not.toHaveBeenCalled()
    drain.resolve()
    await nextTick()
    expect(fixture.releaseAdmission).toHaveBeenCalledTimes(1)
  })

  it.each(['luczor.memory.json', 'luczor.settings.json'])(
    'disposes a late %s subscription after unmount without starting',
    async filename => {
      const registration = deferred<() => void>()
      fixture.deferredSubscriptions.set(filename, registration.promise)
      const harness = setup()
      const mounted = harness.mount()
      // Let the async store loads reach the listener handshake.
      for (let tick = 0; tick < 5; tick++) await nextTick()
      expect(fixture.storeChanges.has(filename)).toBe(true)
      harness.unmount()
      const lateUnlisten = vi.fn()
      registration.resolve(lateUnlisten)
      await mounted
      await nextTick()
      expect(lateUnlisten).toHaveBeenCalledTimes(1)
      expect(fixture.start).not.toHaveBeenCalled()
      expect(fixture.loadSetting).not.toHaveBeenCalled()
      expect(fixture.unlistenMemory).toHaveBeenCalledTimes(filename === 'luczor.settings.json' ? 1 : 0)
    }
  )

  it('does not start from a setting load completed after unmount', async () => {
    const setting = deferred<void>()
    fixture.loadSetting.mockImplementation(async () => {
      await setting.promise
      idleOptimizationEnabled.value = true
    })
    const harness = setup()
    const mounted = harness.mount()
    for (let tick = 0; tick < 7; tick++) await nextTick()
    expect(fixture.loadSetting).toHaveBeenCalledTimes(1)
    harness.unmount()
    setting.resolve()
    await mounted
    await nextTick()
    expect(fixture.start).not.toHaveBeenCalled()
  })
})
