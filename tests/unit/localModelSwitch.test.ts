import { describe, expect, it, vi } from 'vitest'
import { LocalModelSwitch } from '@/services/inference/modelSwitch'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('resident model selection switch', () => {
  it('starts a selection that arrives after draining but before the exclusive barrier settles', async () => {
    const drained = deferred()
    const releaseBarrier = deferred()
    const prepare = vi.fn(async (id: string | null) => id!)
    let passes = 0
    const controller = new LocalModelSwitch({
      exclusive: async operation => {
        await operation()
        if (++passes === 1) {
          drained.resolve()
          await releaseBarrier.promise
        }
      },
      unload: async () => {},
      prepare,
    })
    const first = controller.request('first', () => {})
    await drained.promise
    controller.request('last', () => {})
    expect(controller.snapshot().phase).toBe('waiting')
    releaseBarrier.resolve()
    await first
    await vi.waitFor(() => expect(controller.snapshot()).toMatchObject({ phase: 'ready', activeModelId: 'last' }))
    expect(prepare.mock.calls.map(call => call[0])).toEqual(['first', 'last'])
  })

  it('waits for jobs and confirms termination before preparing and publishing readiness', async () => {
    const jobs = deferred()
    const stopped = deferred()
    const ready = deferred<string>()
    const prepare = vi.fn(() => ready.promise)
    const unload = vi.fn(async (_id, notify) => {
      notify('old')
      await stopped.promise
    })
    const controller = new LocalModelSwitch({
      exclusive: async operation => {
        await jobs.promise
        await operation()
      },
      unload,
      prepare,
    })
    const work = controller.request('new', () => {})
    expect(controller.snapshot().phase).toBe('waiting')
    expect(unload).not.toHaveBeenCalled()
    jobs.resolve()
    await vi.waitFor(() => expect(controller.snapshot()).toMatchObject({ phase: 'unloading', previousModelId: 'old' }))
    expect(prepare).not.toHaveBeenCalled()
    stopped.resolve()
    await vi.waitFor(() => expect(controller.snapshot().phase).toBe('loading'))
    ready.resolve('new')
    await work
    expect(controller.snapshot()).toMatchObject({ phase: 'ready', activeModelId: 'new' })
  })

  it('coalesces rapid selections during unloading without loading intermediate models', async () => {
    const stopped = deferred()
    const prepare = vi.fn(async (id: string | null) => id ?? 'automatic')
    const unload = vi.fn(async () => {
      await stopped.promise
    })
    const exclusive = vi.fn(async (operation: () => Promise<void>) => {
      await Promise.resolve()
      await operation()
    })
    const controller = new LocalModelSwitch({ exclusive, unload, prepare })
    const work = controller.request('intermediate', () => {})
    await vi.waitFor(() => expect(unload).toHaveBeenCalledOnce())
    controller.request('final', () => {})
    stopped.resolve()
    await work
    expect(exclusive).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledExactlyOnceWith('final')
    expect(controller.snapshot()).toMatchObject({ phase: 'ready', activeModelId: 'final', revision: 2 })
  })

  it('discards a late readiness result and unloads it before loading the latest selection', async () => {
    const ready = deferred<string>()
    const phases: string[] = []
    const prepare = vi.fn(async (id: string | null) => (id === 'first' ? ready.promise : 'second'))
    const unload = vi.fn(async () => {})
    const controller = new LocalModelSwitch({
      exclusive: async operation => {
        await Promise.resolve()
        await operation()
      },
      unload,
      prepare,
    })
    controller.subscribe(state => {
      if (state.phase === 'ready') phases.push(state.activeModelId!)
    })
    const work = controller.request('first', () => {})
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledWith('first'))
    controller.request('second', () => {})
    ready.resolve('first')
    await work
    expect(phases).toEqual(['second'])
    expect(unload).toHaveBeenCalledTimes(2)
  })

  it('does not load after stop failure and never projects raw native error details', async () => {
    const prepare = vi.fn(async () => 'new')
    const controller = new LocalModelSwitch({
      exclusive: async operation => {
        await Promise.resolve()
        await operation()
      },
      unload: async () => {
        throw new Error('private native path or credential')
      },
      prepare,
    })
    await controller.request('new', () => {})
    expect(prepare).not.toHaveBeenCalled()
    expect(controller.snapshot().phase).toBe('failed')
    expect(JSON.stringify(controller.snapshot())).not.toContain('private')
  })

  it('refuses to start after account/session revocation and permits explicit retry', async () => {
    const unload = vi.fn(async () => {})
    const controller = new LocalModelSwitch({
      exclusive: async operation => {
        await Promise.resolve()
        await operation()
      },
      unload,
      prepare: async () => 'automatic',
    })
    await controller.request(null, () => {
      throw new Error('session revoked')
    })
    expect(unload).not.toHaveBeenCalled()
    expect(controller.snapshot().phase).toBe('failed')
    await controller.request(null, () => {})
    expect(controller.snapshot()).toMatchObject({ phase: 'ready', activeModelId: 'automatic' })
  })
})
