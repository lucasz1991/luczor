import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

const fixture = vi.hoisted(() => ({
  mounts: [] as Array<() => void>,
  cleanups: [] as Array<() => void>,
  invalidations: new Set<() => void>(),
  start: vi.fn(),
  stop: vi.fn(),
  controls: { mode: 'assist', killSwitch: false },
}))

vi.mock('vue', async importOriginal => ({
  ...(await importOriginal<typeof import('vue')>()),
  onMounted: (callback: () => void) => fixture.mounts.push(callback),
  onBeforeUnmount: (callback: () => void) => fixture.cleanups.push(callback),
}))
vi.mock('@/services/executionGate', () => ({
  executionGate: { snapshot: () => fixture.controls },
  onExecutionInvalidated: (callback: () => void) => {
    fixture.invalidations.add(callback)
    return () => fixture.invalidations.delete(callback)
  },
}))
vi.mock('@/services/workflows/watcher', () => ({
  startWorkflowWatchers: fixture.start,
  stopWorkflowWatchers: fixture.stop,
}))
vi.mock('@/services/workflows/presentation', async () => {
  const { shallowRef } = await import('vue')
  return { workflowChanged: shallowRef({ projectId: '', workflowId: 0, sequence: 0 }) }
})

import { effectScope } from 'vue'
import { useWorkflowWatchers } from '@/composables/useWorkflowWatchers'
import { workflowChanged } from '@/services/workflows/presentation'

let unmount: (() => void) | undefined
let binding: ReturnType<typeof useWorkflowWatchers>
function setup() {
  const scope = effectScope()
  binding = scope.run(useWorkflowWatchers)!
  let disposed = false
  unmount = () => {
    if (disposed) return
    disposed = true
    fixture.cleanups.forEach(cleanup => cleanup())
    scope.stop()
  }
  fixture.mounts.forEach(mount => mount())
  return unmount
}

beforeEach(() => {
  vi.resetAllMocks()
  fixture.mounts.length = 0
  fixture.cleanups.length = 0
  fixture.invalidations.clear()
  fixture.controls = { mode: 'assist', killSwitch: false }
  fixture.start.mockResolvedValue(vi.fn())
  vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }))
})
afterEach(async () => {
  unmount?.()
  await flushPromises()
  vi.unstubAllGlobals()
})

describe('workflow watcher application lifecycle', () => {
  it('releases a stuck setup after native stop and does not restart while the execution gate remains stopped', async () => {
    let finish!: (stop: () => void) => void
    fixture.start.mockReturnValueOnce(
      new Promise<() => void>(resolve => {
        finish = resolve
      })
    )
    setup()
    await flushPromises()
    expect(fixture.start).toHaveBeenCalledOnce()
    fixture.controls.killSwitch = true
    fixture.invalidations.forEach(invalidate => invalidate())
    binding.recoverAfterStop()
    await flushPromises()
    expect(fixture.start).toHaveBeenCalledOnce()
    fixture.controls.killSwitch = false
    fixture.invalidations.forEach(invalidate => invalidate())
    await flushPromises()
    expect(fixture.start).toHaveBeenCalledTimes(2)
    const staleStop = vi.fn()
    finish(staleStop)
    await flushPromises()
    expect(staleStop).toHaveBeenCalledOnce()
    expect(fixture.start).toHaveBeenCalledTimes(2)
  })
  it('holds watchers stopped throughout identity changes, including a failed save', async () => {
    setup()
    await flushPromises()
    expect(fixture.start).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('luczor:api-identity-changing'))
    expect(fixture.stop).toHaveBeenCalledTimes(2)
    fixture.invalidations.forEach(invalidate => invalidate())
    workflowChanged.value = { projectId: 'project-new', workflowId: 4, sequence: 1 }
    window.dispatchEvent(new Event('luczor:workflow-automation-changed'))
    await flushPromises()
    expect(fixture.start).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('luczor:api-identity-changed'))
    await flushPromises()
    expect(fixture.start).toHaveBeenCalledTimes(2)
  })

  it('finishes stale asynchronous setup before starting the replacement session', async () => {
    let resolve!: (stop: () => void) => void
    const pending = new Promise<() => void>(complete => {
      resolve = complete
    })
    const staleStop = vi.fn()
    fixture.start.mockReturnValueOnce(pending)
    setup()
    await flushPromises()
    window.dispatchEvent(new Event('luczor:api-identity-changing'))
    window.dispatchEvent(new Event('luczor:api-identity-changed'))
    await flushPromises()
    expect(fixture.start).toHaveBeenCalledTimes(1)
    resolve(staleStop)
    await flushPromises()
    expect(staleStop).toHaveBeenCalledOnce()
    expect(fixture.start).toHaveBeenCalledTimes(2)
    expect(staleStop.mock.invocationCallOrder[0]).toBeLessThan(fixture.start.mock.invocationCallOrder[1]!)
  })

  it('stops on observe or Not-Aus and restarts only when execution controls permit it', async () => {
    setup()
    await flushPromises()
    fixture.controls.mode = 'observe'
    fixture.invalidations.forEach(invalidate => invalidate())
    await flushPromises()
    expect(fixture.start).toHaveBeenCalledTimes(1)
    fixture.controls = { mode: 'assist', killSwitch: true }
    fixture.invalidations.forEach(invalidate => invalidate())
    await flushPromises()
    expect(fixture.start).toHaveBeenCalledTimes(1)
    fixture.controls.killSwitch = false
    fixture.invalidations.forEach(invalidate => invalidate())
    await flushPromises()
    expect(fixture.start).toHaveBeenCalledTimes(2)
  })

  it('cleans up pending setup and subscriptions when the app unmounts', async () => {
    let resolve!: (stop: () => void) => void
    fixture.start.mockReturnValueOnce(
      new Promise<() => void>(complete => {
        resolve = complete
      })
    )
    const cleanup = setup()
    await flushPromises()
    cleanup()
    const pendingStop = vi.fn()
    resolve(pendingStop)
    await flushPromises()
    expect(pendingStop).toHaveBeenCalledOnce()
    expect(fixture.invalidations.size).toBe(0)
    window.dispatchEvent(new Event('luczor:api-identity-changed'))
    workflowChanged.value = { projectId: 'project-after-unmount', workflowId: 7, sequence: 2 }
    await flushPromises()
    expect(fixture.start).toHaveBeenCalledTimes(1)
  })

  it('does not initialize native watchers in a browser-only preview', async () => {
    vi.stubGlobal('window', new EventTarget())
    setup()
    await flushPromises()
    expect(fixture.start).not.toHaveBeenCalled()
  })
})
