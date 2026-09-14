import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAXIMUM_RESOURCE_PERCENTAGES,
  percentageResourceConfig,
  resourceSystemCheck,
} from '@/services/inference/resourceSystemCheck'
import type { HardwareSnapshot } from '@/services/inference/capacity'
import {
  DEFAULT_LOCAL_RESOURCE_CONFIG,
  LocalResourceController,
  type LocalResourceConfigState,
  type LocalResourceConfig,
} from '@/services/inference/resources'

describe('hardware-derived percentage budgets', () => {
  const gib = 1024 ** 3
  const hardware: HardwareSnapshot = {
    schemaVersion: 1,
    snapshotId: 'hardware-test',
    capturedAtMs: 10,
    platform: 'windows',
    arch: 'x86_64',
    cpu: { logicalCores: 24, availableLogicalCores: 16, loadPercent: null, features: [] },
    memory: { totalBytes: 32 * gib, availableBytes: 20 * gib },
    storage: [],
    accelerators: [
      { id: 'gpu-large', name: 'Large', backend: 'cuda', totalBytes: 24 * gib, availableBytes: 23 * gib },
      { id: 'gpu-small', name: 'Small', backend: 'cuda', totalBytes: 8 * gib, availableBytes: 7 * gib },
      {
        id: 'gpu-shared',
        name: 'Shared',
        backend: 'unknown',
        totalBytes: 128 * 1024 ** 2,
        availableBytes: null,
        sharedSystemLimitBytes: 16 * gib,
      },
    ],
  }
  it('uses available process cores, whole threads and independent dedicated GPU budgets', () => {
    const config = percentageResourceConfig(hardware, DEFAULT_LOCAL_RESOURCE_CONFIG, {
      responseCpu: 50,
      contextCpu: 75,
      ram: 50,
      gpu: 50,
    })
    const check = resourceSystemCheck(hardware, config)
    expect(check.maximumThreads).toBe(14)
    expect(config.threads).toBe(7)
    expect(config.threadsBatch).toBe(10)
    expect(config.ramReserveBytes! + check.ramBudget).toBe(hardware.memory.availableBytes)
    expect(check.gpus.map(gpu => gpu.budget)).toEqual([11 * gib, 3 * gib, null])
    expect(config.vramReserveBytes).toBeNull()
  })
  it('recomputes smaller budgets for changed hardware and never permits zero threads', () => {
    const config = percentageResourceConfig(hardware, DEFAULT_LOCAL_RESOURCE_CONFIG, {
      responseCpu: 1,
      contextCpu: 1,
      ram: 1,
      gpu: 1,
    })
    const smaller = {
      ...hardware,
      cpu: { ...hardware.cpu, availableLogicalCores: 2 },
      memory: { ...hardware.memory, availableBytes: 6 * gib },
    }
    const changed = percentageResourceConfig(smaller, config, config.percentageLimits!)
    expect(changed.threads).toBe(1)
    expect(changed.threadsBatch).toBe(1)
    expect(resourceSystemCheck(smaller, changed).ramBudget).toBeLessThan(
      resourceSystemCheck(hardware, config).ramBudget
    )
  })
  it('disables CPU and GPU throttling independently while retaining the saved percentages', () => {
    const limits = { responseCpu: 25, contextCpu: 50, ram: 75, gpu: 25, cpuEnabled: true, gpuEnabled: false }
    const cpuOnly = percentageResourceConfig(hardware, DEFAULT_LOCAL_RESOURCE_CONFIG, limits)
    expect(cpuOnly.threads).toBe(3)
    expect(cpuOnly.threadsBatch).toBe(7)
    expect(resourceSystemCheck(hardware, cpuOnly).gpus[0]!.budget).toBe(22 * gib)
    const gpuOnly = percentageResourceConfig(hardware, cpuOnly, { ...limits, cpuEnabled: false, gpuEnabled: true })
    expect(gpuOnly.threads).toBe(14)
    expect(gpuOnly.threadsBatch).toBe(14)
    expect(gpuOnly.ramReserveBytes).toBe(cpuOnly.ramReserveBytes)
    expect(resourceSystemCheck(hardware, gpuOnly).gpus[0]!.budget).toBe(5.5 * gib)
    expect(gpuOnly.percentageLimits).toMatchObject({ responseCpu: 25, gpu: 25 })
    expect(percentageResourceConfig(hardware, gpuOnly, limits)).toEqual(cpuOnly)
  })
  it.each([0, 101, 1.5, NaN, Infinity])('rejects an invalid percentage %s instead of applying it', value => {
    expect(() =>
      percentageResourceConfig(hardware, DEFAULT_LOCAL_RESOURCE_CONFIG, { ...MAXIMUM_RESOURCE_PERCENTAGES, ram: value })
    ).toThrow('resource_percentage_invalid')
  })
  it('toggles RAM alone, preserves the saved percentage and keeps the system reserve', () => {
    const limits = { responseCpu: 25, contextCpu: 50, ram: 40, gpu: 50, cpuEnabled: true, gpuEnabled: false }
    const limited = percentageResourceConfig(hardware, DEFAULT_LOCAL_RESOURCE_CONFIG, limits)
    const full = percentageResourceConfig(hardware, limited, { ...limits, ramEnabled: false })
    const check = resourceSystemCheck(hardware, full)
    expect(check.ramBudget).toBe(check.maximumRam)
    expect(full.ramReserveBytes).toBe(check.ramReserve)
    expect(full.threads).toBe(limited.threads)
    expect(full.threadsBatch).toBe(limited.threadsBatch)
    expect(check.gpus).toEqual(resourceSystemCheck(hardware, limited).gpus)
    expect(full.percentageLimits).toEqual({ ...limits, ramEnabled: false })
    const restored = percentageResourceConfig(hardware, full, { ...limits, ramEnabled: true })
    expect(restored.ramReserveBytes).toBe(limited.ramReserveBytes)
    expect(resourceSystemCheck(hardware, restored).ramBudget).toBe(resourceSystemCheck(hardware, limited).ramBudget)
    const lowMemory = { ...hardware, memory: { ...hardware.memory, availableBytes: gib } }
    expect(resourceSystemCheck(lowMemory, full).ramBudget).toBe(0)
  })
  it('rejects malformed RAM throttle flags', () => {
    expect(() =>
      percentageResourceConfig(hardware, DEFAULT_LOCAL_RESOURCE_CONFIG, {
        ...MAXIMUM_RESOURCE_PERCENTAGES,
        ramEnabled: 'false' as unknown as boolean,
      })
    ).toThrow('resource_percentage_invalid')
  })
  it('fails closed on incomplete CPU/RAM readings and never credits shared memory as VRAM', () => {
    expect(() =>
      resourceSystemCheck(
        { ...hardware, cpu: { ...hardware.cpu, availableLogicalCores: 0 } },
        DEFAULT_LOCAL_RESOURCE_CONFIG
      )
    ).toThrow()
    expect(() =>
      resourceSystemCheck(
        { ...hardware, memory: { ...hardware.memory, availableBytes: NaN } },
        DEFAULT_LOCAL_RESOURCE_CONFIG
      )
    ).toThrow()
    const check = resourceSystemCheck(hardware, { ...DEFAULT_LOCAL_RESOURCE_CONFIG, gpuDeviceIds: ['gpu-shared'] })
    expect(check.gpus).toEqual([{ id: 'gpu-shared', name: 'Shared', maximum: null, budget: null }])
  })
})

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
  it('refuses cleanup during a whole job and never stops or queues it', async () => {
    const { controller, deps } = setup()
    const work = await controller.acquire()
    const cleanup = vi.fn(async () => {})
    await expect(controller.inspectIdle(cleanup)).rejects.toThrow('resource_system_check_busy')
    expect(cleanup).not.toHaveBeenCalled()
    expect(deps.end).not.toHaveBeenCalled()
    expect(controller.isModelSwitchPending()).toBe(false)
    await work.release()
  })

  it('blocks new foreground and background admission until idle cleanup and measurement finish', async () => {
    vi.useFakeTimers()
    const { controller, deps } = setup()
    let finish!: () => void
    const checking = controller.inspectIdle(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    expect(controller.isModelSwitchPending()).toBe(true)
    await expect(controller.inspectIdle(async () => {})).rejects.toThrow('resource_system_check_busy')
    await expect(controller.runPreemptibleBackground(async () => {}, new AbortController().signal)).rejects.toThrow(
      'resource_background_unavailable'
    )
    const next = controller.acquire()
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.begin).not.toHaveBeenCalled()
    finish()
    await checking
    await vi.advanceTimersByTimeAsync(150)
    const work = await next
    expect(deps.begin).toHaveBeenCalledOnce()
    await work.release()
    await expect(
      controller.inspectIdle(async () => {
        throw new Error('sample failed')
      })
    ).rejects.toThrow('sample failed')
    expect(controller.isModelSwitchPending()).toBe(false)
  })
  it('fails a queued switch visibly after exhausted cleanup and reconciles on explicit retry', async () => {
    vi.useFakeTimers()
    const { controller, deps, nativeLeases } = setup()
    const parent = await controller.acquire()
    const replace = vi.fn(async () => {})
    const switching = controller.switchModel(replace)
    const outcome = switching.then(
      () => null,
      error => error
    )
    deps.end.mockRejectedValue(new Error('temporary native end failure'))
    const closing = parent.release()
    await vi.advanceTimersByTimeAsync(8000)
    await closing
    expect(await outcome).toEqual(new Error('resource_work_cleanup_failed'))
    expect(replace).not.toHaveBeenCalled()
    expect(controller.isModelSwitchPending()).toBe(false)
    expect(nativeLeases.size).toBe(1)
    deps.end.mockImplementation(async id => {
      nativeLeases.delete(id)
    })
    const retry = controller.switchModel(replace)
    await vi.advanceTimersByTimeAsync(1200)
    await retry
    expect(replace).toHaveBeenCalledOnce()
    expect(nativeLeases.size).toBe(0)
  })

  it('runs a queued model change after an aborted operation has actually drained', async () => {
    const { controller, deps } = setup()
    const abort = new AbortController()
    let finish!: () => void
    const drained = new Promise<void>(resolve => {
      finish = resolve
    })
    const job = controller.run(async () => {
      await drained
      abort.signal.throwIfAborted()
    }, abort.signal)
    const outcome = job.then(
      () => null,
      error => error
    )
    await vi.waitFor(() => expect(deps.begin).toHaveBeenCalledOnce())
    const replace = vi.fn(async () => {})
    const switching = controller.switchModel(replace)
    abort.abort(new Error('stopped'))
    expect(replace).not.toHaveBeenCalled()
    finish()
    expect(await outcome).toEqual(new Error('stopped'))
    await switching
    expect(deps.end).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledOnce()
  })

  it('drains whole logical jobs for a model change while new chats wait and children finish', async () => {
    const { controller, deps } = setup()
    const parent = await controller.acquire()
    const replace = vi.fn(async () => {})
    const change = controller.switchModel(replace)
    expect(controller.isModelSwitchPending()).toBe(true)
    const newJob = controller.acquire()
    const child = await controller.acquire(undefined, parent.work)
    expect(replace).not.toHaveBeenCalled()
    expect(deps.begin).toHaveBeenCalledOnce()
    await parent.release()
    expect(replace).not.toHaveBeenCalled()
    await child.release()
    await change
    const resumed = await newJob
    expect(replace).toHaveBeenCalledOnce()
    expect(deps.begin).toHaveBeenCalledTimes(2)
    await resumed.release()
    expect(controller.isModelSwitchPending()).toBe(false)
  })

  it('honors a chat stop while waiting for a switch and drops idle maintenance', async () => {
    const { controller, deps } = setup()
    let finish!: () => void
    const change = controller.switchModel(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    const signal = new AbortController()
    const waiting = controller.acquire(signal.signal)
    signal.abort(new Error('user stopped waiting chat'))
    await expect(waiting).rejects.toThrow('user stopped waiting chat')
    await expect(controller.runPreemptibleBackground(async () => {}, new AbortController().signal)).rejects.toThrow(
      'resource_background_unavailable'
    )
    expect(deps.begin).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    finish()
    await change
  })

  it('drops maintenance when a resource switch appears between registration and native begin without applying or retrying it', async () => {
    const { controller, deps } = setup()
    const operation = vi.fn(async () => {})
    const waiting = controller.runPreemptibleBackground(operation, new AbortController().signal)
    deps.begin.mockRejectedValueOnce(new Error('resource_config_pending'))
    await expect(waiting).rejects.toThrow('resource_background_unavailable')
    expect(operation).not.toHaveBeenCalled()
    expect(deps.begin).toHaveBeenCalledOnce()
    expect(deps.apply).not.toHaveBeenCalled()
    expect(controller.hasWork()).toBe(false)
    const foreground = await controller.acquire()
    await foreground.release()
  })

  it('preempts resident maintenance and drains it before user admission without replacing the idle hook', async () => {
    const { controller, deps, nativeLeases } = setup()
    const admission = vi.fn(async () => ({ release: vi.fn() }))
    controller.setForegroundAdmission(admission)
    let started!: () => void
    const startedPromise = new Promise<void>(resolve => {
      started = resolve
    })
    let drain!: () => void
    const drainPromise = new Promise<void>(resolve => {
      drain = resolve
    })
    let backgroundSignal!: AbortSignal
    const background = controller.runPreemptibleBackground(async (_work, signal) => {
      backgroundSignal = signal
      started()
      await drainPromise
      signal.throwIfAborted()
    }, new AbortController().signal)
    const rejected = background.catch((error: unknown) => error)
    await startedPromise
    const foreground = controller.acquire()
    expect(backgroundSignal.aborted).toBe(true)
    await Promise.resolve()
    expect(admission).not.toHaveBeenCalled()
    expect(deps.begin).toHaveBeenCalledTimes(1)
    expect(nativeLeases.size).toBe(1)
    drain()
    expect(String(await rejected)).toContain('resource_background_preempted')
    const lease = await foreground
    expect(admission).toHaveBeenCalledOnce()
    expect(deps.end).toHaveBeenCalledOnce()
    expect(nativeLeases.size).toBe(1)
    expect(deps.end.mock.invocationCallOrder[0]).toBeLessThan(deps.begin.mock.invocationCallOrder[1]!)
    await lease.release()
    expect(controller.hasWork()).toBe(false)
  })

  it('refuses maintenance while foreground admission or an entire multi-round job is active', async () => {
    const { controller } = setup()
    let admit!: () => void
    controller.setForegroundAdmission(
      () =>
        new Promise(resolve => {
          admit = () => resolve({ release() {} })
        })
    )
    const pending = controller.acquire()
    const operation = vi.fn(async () => {})
    await expect(controller.runPreemptibleBackground(operation, new AbortController().signal)).rejects.toThrow(
      'background_unavailable'
    )
    admit()
    const outer = await pending
    const child = await controller.acquire(undefined, outer.work)
    await outer.release()
    await expect(controller.runPreemptibleBackground(operation, new AbortController().signal)).rejects.toThrow(
      'background_unavailable'
    )
    expect(operation).not.toHaveBeenCalled()
    await child.release()
    await controller.runPreemptibleBackground(operation, new AbortController().signal)
    expect(operation).toHaveBeenCalledOnce()
  })

  it('retains a single maintenance owner and releases it after parent cancellation or failure', async () => {
    const { controller, nativeLeases } = setup()
    const aborted = new AbortController()
    aborted.abort(new Error('parent cancelled'))
    const unused = vi.fn(async () => {})
    await expect(controller.runPreemptibleBackground(unused, aborted.signal)).rejects.toThrow('parent cancelled')
    expect(unused).not.toHaveBeenCalled()
    let finish!: () => void
    const background = controller.runPreemptibleBackground(async () => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
      throw new Error('bounded proposal failed')
    }, new AbortController().signal)
    const failed = background.catch((error: unknown) => error)
    await vi.waitFor(() => expect(nativeLeases.size).toBe(1))
    await expect(controller.runPreemptibleBackground(unused, new AbortController().signal)).rejects.toThrow(
      'background_unavailable'
    )
    finish()
    expect(String(await failed)).toContain('bounded proposal failed')
    expect(controller.hasWork()).toBe(false)
    const foreground = await controller.acquire()
    await foreground.release()
    expect(nativeLeases.size).toBe(0)
  })

  it('waits for idle work to drain before native user admission and pauses through nested rounds', async () => {
    const { controller, deps } = setup()
    let drain = () => {}
    const releaseForeground = vi.fn()
    const admission = vi.fn(
      () =>
        new Promise<{ release(): void }>(resolve => {
          drain = () => resolve({ release: releaseForeground })
        })
    )
    controller.setForegroundAdmission(admission)
    const waiting = controller.acquire()
    await Promise.resolve()
    expect(deps.begin).not.toHaveBeenCalled()
    drain()
    const outer = await waiting
    const inner = await controller.acquire(undefined, outer.work)
    await outer.release()
    expect(releaseForeground).not.toHaveBeenCalled()
    expect(admission).toHaveBeenCalledOnce()
    await inner.release()
    expect(releaseForeground).toHaveBeenCalledOnce()
    expect(controller.hasWork()).toBe(false)
  })

  it('idle leases bypass foreground admission while acquisition failures release their foreground pause', async () => {
    const { controller, deps } = setup()
    const release = vi.fn()
    const admission = vi.fn(async () => ({ release }))
    controller.setForegroundAdmission(admission)
    await controller.runBackground(async () => {
      expect(controller.hasWork()).toBe(true)
    }, new AbortController().signal)
    expect(admission).not.toHaveBeenCalled()
    deps.begin.mockRejectedValueOnce(new Error('native unavailable'))
    await expect(controller.acquire()).rejects.toThrow('native unavailable')
    expect(release).toHaveBeenCalledOnce()
    expect(controller.hasWork()).toBe(false)
  })
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
