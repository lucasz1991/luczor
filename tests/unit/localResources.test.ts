import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LOCAL_RESOURCE_CONFIG,
  LocalResourceController,
  type LocalResourceConfigState,
  type LocalResourceConfig,
} from '@/services/inference/resources'

function setup() {
  let state: LocalResourceConfigState = {
    requested: { ...DEFAULT_LOCAL_RESOURCE_CONFIG },
    applied: { ...DEFAULT_LOCAL_RESOURCE_CONFIG },
    revision: 0,
    appliedRevision: 0,
    pending: false,
    reasonCode: null,
  }
  const nativeLeases = new Set<string>()
  const deps = {
    enabled: () => true,
    get: vi.fn(async () => structuredClone(state)),
    set: vi.fn(async (config: LocalResourceConfig, expectedRevision: number) => {
      if (expectedRevision !== state.revision) throw new Error('resource_config_revision_conflict')
      state = { ...state, requested: config, revision: state.revision + 1, pending: true }
      return structuredClone(state)
    }),
    apply: vi.fn(async () => {
      if (nativeLeases.size) throw new Error('resource_config_busy')
      state = { ...state, applied: state.requested, appliedRevision: state.revision, pending: false }
      return structuredClone(state)
    }),
    begin: vi.fn(async (leaseId: string) => {
      if (state.pending) throw new Error('resource_mode_switch_pending')
      nativeLeases.add(leaseId)
      return { leaseId, resourceRevision: state.appliedRevision }
    }),
    end: vi.fn(async (leaseId: string) => {
      nativeLeases.delete(leaseId)
    }),
    applied: vi.fn(),
  }
  return { controller: new LocalResourceController(deps), deps, nativeLeases }
}

afterEach(() => vi.useRealTimers())

describe('device resource workflow barrier', () => {
  it('shares final release confirmation between concurrent callers without duplicate native end', async () => {
    const { controller, deps, nativeLeases } = setup()
    const lease = await controller.acquire()
    let confirmEnd = () => {}
    deps.end.mockImplementationOnce(
      leaseId =>
        new Promise<void>(resolve => {
          confirmEnd = () => {
            nativeLeases.delete(leaseId)
            resolve()
          }
        })
    )
    const first = lease.release()
    const secondDone = vi.fn()
    const second = lease.release().then(secondDone)
    await Promise.resolve()
    expect(secondDone).not.toHaveBeenCalled()
    expect(deps.end).toHaveBeenCalledOnce()
    expect(nativeLeases.size).toBe(1)
    confirmEnd()
    await Promise.all([first, second])
    expect(secondDone).toHaveBeenCalledOnce()
    expect(nativeLeases.size).toBe(0)
  })

  it('does not forget a native lease when native availability changes before release', async () => {
    vi.useFakeTimers()
    const { controller, deps, nativeLeases } = setup()
    const lease = await controller.acquire()
    deps.enabled = () => false
    for (let attempt = 0; attempt < 3; attempt++) {
      deps.end.mockRejectedValueOnce(new Error('native transport unavailable'))
    }
    const release = lease.release()
    await vi.advanceTimersByTimeAsync(350)
    await release
    expect(nativeLeases.size).toBe(1)
    expect(deps.end).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(deps.end).toHaveBeenCalledTimes(4)
    expect(nativeLeases.size).toBe(0)
  })

  it('retains a completed result and the closing lease until deferred native cleanup succeeds', async () => {
    vi.useFakeTimers()
    const { controller, deps, nativeLeases } = setup()
    const operation = vi.fn(async () => {
      await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'gpu' }, 0)
      return 'completed answer'
    })
    for (let attempt = 0; attempt < 3; attempt++) {
      deps.end.mockRejectedValueOnce(new Error('native end unavailable'))
    }
    const result = controller.run(operation)
    await vi.advanceTimersByTimeAsync(350)
    await expect(result).resolves.toBe('completed answer')
    expect(operation).toHaveBeenCalledOnce()
    expect(nativeLeases.size).toBe(1)
    expect(deps.end).toHaveBeenCalledTimes(3)
    expect(deps.apply).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(nativeLeases.size).toBe(0)
    expect(deps.end).toHaveBeenCalledTimes(4)
    expect(deps.apply).toHaveBeenCalledExactlyOnceWith(1)
    expect(deps.applied).toHaveBeenCalledOnce()
    expect((await controller.get()).pending).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deps.end).toHaveBeenCalledTimes(4)
    expect(operation).toHaveBeenCalledOnce()
  })

  it('exhausts one bounded cleanup wave without dropping ownership or retrying on internal polls', async () => {
    vi.useFakeTimers()
    const { controller, deps, nativeLeases } = setup()
    const lease = await controller.acquireGroup('team:cleanup')
    await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'cpu' }, 0)
    deps.end.mockRejectedValue(new Error('native end unavailable'))
    const release = lease.release()
    await vi.advanceTimersByTimeAsync(350)
    await release
    expect(controller.group('team:cleanup')).toBeUndefined()
    await expect(controller.acquire(undefined, lease.work)).rejects.toThrow('parent_expired')
    await vi.advanceTimersByTimeAsync(7_000)
    expect(deps.end).toHaveBeenCalledTimes(6)
    expect(nativeLeases.size).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    for (let poll = 0; poll < 5; poll++) {
      expect((await controller.get()).pending).toBe(true)
      expect((await controller.flush()).pending).toBe(true)
    }
    await lease.release()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(deps.end).toHaveBeenCalledTimes(6)
    expect(deps.apply).not.toHaveBeenCalled()
    expect(nativeLeases.size).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['refresh', 'save'] as const)('allows one new cleanup wave after explicit UI %s', async action => {
    vi.useFakeTimers()
    const { controller, deps, nativeLeases } = setup()
    deps.end.mockRejectedValue(new Error('native end unavailable'))
    const operation = vi.fn(async () => {
      await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'gpu' }, 0)
      return 'tool ran once'
    })
    const result = controller.run(operation)
    await vi.advanceTimersByTimeAsync(8_000)
    await expect(result).resolves.toBe('tool ran once')
    expect(deps.end).toHaveBeenCalledTimes(6)
    deps.end.mockImplementation(async leaseId => {
      nativeLeases.delete(leaseId)
    })

    const state =
      action === 'refresh'
        ? await controller.refresh()
        : await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'cpu' }, 1)
    expect(state.pending).toBe(true)
    await controller.refresh()
    expect(deps.end).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(deps.end).toHaveBeenCalledTimes(7)
    expect(nativeLeases.size).toBe(0)
    expect(deps.apply).toHaveBeenCalledExactlyOnceWith(action === 'refresh' ? 1 : 2)
    expect(deps.applied).toHaveBeenCalledOnce()
    expect(operation).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deps.end).toHaveBeenCalledTimes(7)
  })

  it('does not turn a failed cleanup into a different operation error', async () => {
    vi.useFakeTimers()
    const { controller, deps, nativeLeases } = setup()
    deps.end.mockRejectedValue(new Error('native cleanup failed'))
    const failure = new Error('original tool error')
    const result = controller.run(async () => {
      throw failure
    })
    const rejected = result.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(350)
    expect(await rejected).toBe(failure)
    await vi.advanceTimersByTimeAsync(7_000)
    expect(deps.end).toHaveBeenCalledTimes(6)
    expect(nativeLeases.size).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for idempotent end confirmation when the first native reply is lost', async () => {
    vi.useFakeTimers()
    const { controller, deps, nativeLeases } = setup()
    const lease = await controller.acquire()
    await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'gpu' }, 0)
    deps.end.mockImplementationOnce(async leaseId => {
      nativeLeases.delete(leaseId)
      throw new Error('reply lost after native end')
    })
    const release = lease.release()
    await vi.advanceTimersByTimeAsync(100)
    expect(nativeLeases.size).toBe(0)
    expect((await controller.flush()).pending).toBe(true)
    expect(deps.apply).not.toHaveBeenCalled()
    await expect(controller.acquire(undefined, lease.work)).rejects.toThrow('parent_expired')
    await vi.advanceTimersByTimeAsync(100)
    await release
    expect(deps.end).toHaveBeenNthCalledWith(1, lease.work.leaseId)
    expect(deps.end).toHaveBeenNthCalledWith(2, lease.work.leaseId)
    expect(deps.apply).toHaveBeenCalledOnce()
  })

  it('keeps successful work successful when applying the pending configuration fails', async () => {
    const { controller, deps, nativeLeases } = setup()
    deps.apply.mockRejectedValue(new Error('resource_config_write_failed'))
    const result = await controller.run(async () => {
      await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'gpu' }, 0)
      return 'finished'
    })
    expect(result).toBe('finished')
    expect(nativeLeases.size).toBe(0)
    expect(deps.end).toHaveBeenCalledOnce()
    expect((await controller.get()).pending).toBe(true)
  })

  it('isolates throwing subscribers during initial delivery, updates and cleanup', async () => {
    const { controller, deps } = setup()
    const broken = vi.fn(() => {
      throw new Error('view failed')
    })
    await controller.get()
    const stopBroken = await controller.subscribe(broken)
    const observer = vi.fn()
    const stopObserver = await controller.subscribe(observer)
    await expect(
      controller.run(async () => {
        await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'cpu' }, 0)
        return 'finished'
      })
    ).resolves.toBe('finished')
    expect(broken).toHaveBeenCalled()
    expect(observer).toHaveBeenLastCalledWith(expect.objectContaining({ appliedRevision: 1, pending: false }))
    expect(deps.applied).toHaveBeenCalledOnce()
    stopBroken()
    stopObserver()
  })

  it('does not publish older requested or applied revisions from delayed reads', async () => {
    const { controller, deps } = setup()
    const original = await controller.get()
    const current = await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'cpu' }, 0)
    const observer = vi.fn()
    const stop = await controller.subscribe(observer)
    deps.get.mockResolvedValueOnce(original)
    expect(await controller.get()).toEqual(current)
    deps.get.mockResolvedValueOnce({ ...original, revision: 2, pending: true })
    expect(await controller.get()).toEqual(current)
    expect(observer).toHaveBeenCalledOnce()
    stop()
  })

  it('applies an idle change once and rejects concurrent stale settings', async () => {
    const { controller, deps } = setup()
    const state = await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'cpu' }, 0)
    expect(state).toMatchObject({ appliedRevision: 1, pending: false, applied: { mode: 'cpu' } })
    expect(deps.applied).toHaveBeenCalledOnce()
    await expect(controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG }, 0)).rejects.toThrow('revision_conflict')
  })

  it('lets existing child rounds finish while new top-level work waits for the applied revision', async () => {
    vi.useFakeTimers()
    const { controller, deps, nativeLeases } = setup()
    const parent = await controller.acquire()
    expect((await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'gpu' }, 0)).pending).toBe(true)
    const child = await controller.acquire(undefined, parent.work)
    const incoming = controller.acquire()
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.apply).not.toHaveBeenCalled()
    await parent.release()
    expect(nativeLeases.size).toBe(1)
    await child.release()
    await vi.advanceTimersByTimeAsync(200)
    const next = await incoming
    expect(next.work.resourceRevision).toBe(1)
    expect(deps.apply).toHaveBeenCalledOnce()
    await next.release()
    expect(nativeLeases.size).toBe(0)
  })

  it('keeps one group across dependent agents and releases after failure', async () => {
    const { controller, nativeLeases } = setup()
    const group = await controller.acquireGroup('team:one')
    await expect(
      controller.run(
        async () => {
          throw new Error('tool failure')
        },
        undefined,
        controller.group('team:one')
      )
    ).rejects.toThrow('tool failure')
    expect(nativeLeases.size).toBe(1)
    await group.release()
    expect(nativeLeases.size).toBe(0)
    expect(controller.group('team:one')).toBeUndefined()
    await expect(controller.acquire(undefined, group.work)).rejects.toThrow('parent_expired')
  })

  it('cancels a waiting new request without interrupting the current job', async () => {
    vi.useFakeTimers()
    const { controller, nativeLeases, deps } = setup()
    const active = await controller.acquire()
    await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'cpu' }, 0)
    const abort = new AbortController()
    const next = controller.acquire(abort.signal)
    const rejection = next.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1)
    abort.abort()
    expect(await rejection).toMatchObject({ name: 'AbortError' })
    expect(nativeLeases.size).toBe(1)
    expect(deps.end).not.toHaveBeenCalled()
    await active.release()
    expect(nativeLeases.size).toBe(0)
  })

  it('waits for native preparation instead of force stopping a busy runtime', async () => {
    vi.useFakeTimers()
    const { controller, deps } = setup()
    deps.apply.mockRejectedValueOnce(new Error('resource_config_busy'))
    expect((await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'gpu' }, 0)).pending).toBe(true)
    await vi.advanceTimersByTimeAsync(400)
    expect((await controller.get()).pending).toBe(false)
    expect(deps.applied).toHaveBeenCalledOnce()
  })

  it('does not leak mutable configuration between status subscribers', async () => {
    const { controller } = setup()
    const stop = await controller.subscribe(value => {
      value.applied.mode = 'cpu'
    })
    expect((await controller.get()).applied.mode).toBe('auto')
    stop()
  })
})
