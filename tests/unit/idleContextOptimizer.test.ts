import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IdleContextOptimizer,
  type IdleContextOptimizerDependencies,
  type IdleOptimizationJob,
} from '@/services/agents/idleContextOptimizer'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const job: IdleOptimizationJob = {
  key: 'project-context',
  fingerprint: 'source-version-1',
  boundary: 'account-catalog-1',
  principalId: 'user:1',
  scope: 'project',
  projectId: 'project:1',
  prompt: 'Create suggestions using only these bounded project facts.',
}

function setup(overrides: Partial<IdleContextOptimizerDependencies> = {}) {
  const inspect = vi.fn(async () => ({ available: true, boundary: job.boundary }))
  const nextJob = vi.fn(async () => ({ ...job }))
  const runLocal = vi.fn(async () => 'A private, unconfirmed optimization candidate.')
  const commitCandidate = vi.fn(async () => undefined)
  const deps = { inspect, nextJob, runLocal, commitCandidate, ...overrides }
  const optimizer = new IdleContextOptimizer(deps, {
    idleDelayMs: 100,
    intervalMs: 200,
    timeoutMs: 1_000,
    monitorMs: 50,
    errorBackoffMs: 2_000,
  })
  return { optimizer, inspect, nextJob, runLocal, commitCandidate }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})
afterEach(() => vi.useRealTimers())

describe('idle local context optimization', () => {
  it('fences a detached idle owner and its foreground counters after native-confirmed global stop', async () => {
    const late = deferred<string>()
    const { optimizer, commitCandidate } = setup({ runLocal: () => late.promise })
    optimizer.start()
    await vi.advanceTimersByTimeAsync(100)
    const oldForeground = optimizer.acquireForeground().catch(error => error)
    void optimizer.stop()
    optimizer.recoverAfterStop()
    expect(await oldForeground).toMatchObject({ name: 'AbortError' })
    expect(optimizer.snapshot()).toMatchObject({ enabled: false, phase: 'stopped', foregroundJobs: 0, manual: false })
    const fresh = await optimizer.acquireForeground()
    expect(optimizer.snapshot().foregroundJobs).toBe(1)
    late.resolve('Must not commit after native stop')
    await vi.advanceTimersByTimeAsync(500)
    expect(commitCandidate).not.toHaveBeenCalled()
    expect(optimizer.snapshot().foregroundJobs).toBe(1)
    fresh.release()
    expect(optimizer.snapshot().foregroundJobs).toBe(0)
    expect(optimizer.snapshot().nextCheckAt).toBeNull()
  })
  it('waits for idle grace, writes one candidate, and does not repeat unchanged source context', async () => {
    const { optimizer, runLocal, commitCandidate } = setup()
    optimizer.start()
    optimizer.start()
    await vi.advanceTimersByTimeAsync(99)
    expect(runLocal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(runLocal).toHaveBeenCalledTimes(1)
    expect(commitCandidate).toHaveBeenCalledWith(job, expect.any(String), expect.any(AbortSignal))
    expect(optimizer.snapshot()).toMatchObject({ completed: 1, reason: 'candidate_ready' })
    await vi.advanceTimersByTimeAsync(600)
    expect(runLocal).toHaveBeenCalledTimes(1)
    expect(optimizer.snapshot().reason).toBe('unchanged_context')
    await optimizer.stop()
  })

  it('runs a new revision of the same source and separates accounts', async () => {
    let next = { ...job }
    const { optimizer, runLocal } = setup({ nextJob: async () => next })
    optimizer.start()
    await vi.advanceTimersByTimeAsync(100)
    next = { ...job, fingerprint: 'source-version-2' }
    await vi.advanceTimersByTimeAsync(200)
    next = { ...job, principalId: 'user:2' }
    await vi.advanceTimersByTimeAsync(200)
    expect(runLocal).toHaveBeenCalledTimes(3)
    await optimizer.stop()
  })

  it('aborts background on a user job and waits for actual native drain before admission', async () => {
    const nativeDrain = deferred<string>()
    let backgroundSignal: AbortSignal | undefined
    const { optimizer, commitCandidate } = setup({
      runLocal: async (_job, signal) => {
        backgroundSignal = signal
        return nativeDrain.promise
      },
    })
    optimizer.start()
    await vi.advanceTimersByTimeAsync(100)
    let admitted = false
    const foreground = optimizer.acquireForeground().then(lease => {
      admitted = true
      return lease
    })
    expect(backgroundSignal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(admitted).toBe(false)
    expect(optimizer.snapshot()).toMatchObject({ phase: 'yielding', foregroundJobs: 1 })
    nativeDrain.resolve('Late content must never become memory.')
    const lease = await foreground
    expect(admitted).toBe(true)
    expect(commitCandidate).not.toHaveBeenCalled()
    lease.release()
    lease.release()
    expect(optimizer.snapshot().foregroundJobs).toBe(0)
    await optimizer.stop()
  })

  it('keeps all foreground workflows protected across tool gaps and concurrent completion', async () => {
    const { optimizer, runLocal } = setup()
    optimizer.start()
    const first = await optimizer.acquireForeground()
    const second = await optimizer.acquireForeground()
    await vi.advanceTimersByTimeAsync(2_000)
    first.release()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(runLocal).not.toHaveBeenCalled()
    second.release()
    await vi.advanceTimersByTimeAsync(99)
    expect(runLocal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(runLocal).toHaveBeenCalledTimes(1)
    await optimizer.stop()
  })

  it('cancels a waiting user without dropping ownership of an undrained background stream', async () => {
    const nativeDrain = deferred<string>()
    const { optimizer, commitCandidate } = setup({ runLocal: () => nativeDrain.promise })
    optimizer.start()
    await vi.advanceTimersByTimeAsync(100)
    const cancellation = new AbortController()
    const admission = optimizer.acquireForeground(cancellation.signal)
    cancellation.abort()
    await expect(admission).rejects.toMatchObject({ name: 'AbortError' })
    expect(optimizer.snapshot().foregroundJobs).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(optimizer.snapshot().nextCheckAt).toBeNull()
    nativeDrain.resolve('Late answer')
    await vi.advanceTimersByTimeAsync(1)
    expect(commitCandidate).not.toHaveBeenCalled()
    await optimizer.stop()
  })

  it('does not start local inference when foreground work arrives during context reads', async () => {
    const contextRead = deferred<IdleOptimizationJob | null>()
    const { optimizer, runLocal } = setup({ nextJob: () => contextRead.promise })
    optimizer.start()
    await vi.advanceTimersByTimeAsync(100)
    const foreground = optimizer.acquireForeground()
    contextRead.resolve(job)
    const lease = await foreground
    expect(runLocal).not.toHaveBeenCalled()
    lease.release()
    await optimizer.stop()
  })

  it('pauses under memory pressure without starting or loading a model', async () => {
    const { optimizer, nextJob, runLocal } = setup({
      inspect: async () => ({ available: false, boundary: job.boundary, reason: 'memory_pressure' }),
    })
    optimizer.start()
    await vi.advanceTimersByTimeAsync(500)
    expect(nextJob).not.toHaveBeenCalled()
    expect(runLocal).not.toHaveBeenCalled()
    expect(optimizer.snapshot()).toMatchObject({ phase: 'paused', reason: 'memory_pressure' })
    await optimizer.stop()
  })

  it('monitors memory pressure during inference and rejects its late result', async () => {
    let available = true
    let signal: AbortSignal | undefined
    const nativeDrain = deferred<string>()
    const { optimizer, commitCandidate } = setup({
      inspect: async () => ({ available, boundary: job.boundary, reason: 'memory_pressure' }),
      runLocal: async (_job, requestSignal) => {
        signal = requestSignal
        return nativeDrain.promise
      },
    })
    optimizer.start()
    await vi.advanceTimersByTimeAsync(100)
    available = false
    await vi.advanceTimersByTimeAsync(50)
    expect(signal?.aborted).toBe(true)
    expect(optimizer.snapshot().reason).toBe('memory_pressure')
    nativeDrain.resolve('Stale answer')
    await optimizer.stop()
    expect(commitCandidate).not.toHaveBeenCalled()
  })

  it('discards results after account, catalog or resource-boundary changes', async () => {
    let boundary = job.boundary
    const nativeDrain = deferred<string>()
    const { optimizer, commitCandidate } = setup({
      inspect: async () => ({ available: true, boundary }),
      runLocal: () => nativeDrain.promise,
    })
    optimizer.start()
    await vi.advanceTimersByTimeAsync(100)
    boundary = 'different-account-catalog-resources'
    nativeDrain.resolve('Must not cross account boundary.')
    await vi.advanceTimersByTimeAsync(0)
    expect(commitCandidate).not.toHaveBeenCalled()
    expect(optimizer.snapshot().reason).toBe('boundary_changed')
    await optimizer.stop()
  })

  it('rejects context whose boundary changed before model admission', async () => {
    let calls = 0
    const { optimizer, runLocal } = setup({
      inspect: async () => ({ available: true, boundary: ++calls < 2 ? job.boundary : 'new-boundary' }),
    })
    optimizer.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(runLocal).not.toHaveBeenCalled()
    expect(optimizer.snapshot().reason).toBe('boundary_changed')
    await optimizer.stop()
  })

  it('limits generation time and does not retry while cancellation is still draining', async () => {
    const nativeDrain = deferred<string>()
    let signal: AbortSignal | undefined
    const runLocal = vi.fn(async (_job: IdleOptimizationJob, requestSignal: AbortSignal) => {
      signal = requestSignal
      return nativeDrain.promise
    })
    const { optimizer, commitCandidate } = setup({ runLocal })
    optimizer.start()
    await vi.advanceTimersByTimeAsync(1_100)
    expect(signal?.aborted).toBe(true)
    expect(optimizer.snapshot().reason).toBe('timeout')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(runLocal).toHaveBeenCalledTimes(1)
    nativeDrain.resolve('After deadline')
    await vi.advanceTimersByTimeAsync(0)
    expect(commitCandidate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(runLocal).toHaveBeenCalledTimes(1)
    await optimizer.stop()
  })

  it('does not persist empty or oversized results and backs off without exposing raw errors', async () => {
    for (const output of ['', 'x'.repeat(8_001)]) {
      const { optimizer, runLocal, commitCandidate } = setup()
      runLocal.mockResolvedValue(output)
      optimizer.start()
      await vi.advanceTimersByTimeAsync(100)
      expect(commitCandidate).not.toHaveBeenCalled()
      expect(optimizer.snapshot().reason).toBe('failed')
      await vi.advanceTimersByTimeAsync(1_999)
      expect(runLocal).toHaveBeenCalledTimes(1)
      await optimizer.stop()
    }
  })

  it('resets idle grace on typing and supports disable/re-enable without duplicate loops', async () => {
    const { optimizer, runLocal } = setup()
    optimizer.start()
    await vi.advanceTimersByTimeAsync(90)
    optimizer.interrupt('typing')
    await vi.advanceTimersByTimeAsync(90)
    expect(runLocal).not.toHaveBeenCalled()
    await optimizer.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(runLocal).not.toHaveBeenCalled()
    optimizer.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(runLocal).toHaveBeenCalledTimes(1)
    await optimizer.stop()
  })

  it('allows one manual request without bypassing foreground ownership', async () => {
    const pending = deferred<string>()
    const runLocal = vi.fn(() => pending.promise)
    const { optimizer } = setup({ runLocal })
    optimizer.start()
    expect(optimizer.requestNow()).toBe(true)
    expect(optimizer.snapshot().nextCheckAt).toBe(Date.now() + 1)
    await vi.advanceTimersByTimeAsync(2)
    expect(runLocal).toHaveBeenCalledTimes(1)
    expect(optimizer.requestNow()).toBe(false)
    pending.resolve('A bounded local proposal.')
    await vi.advanceTimersByTimeAsync(0)
    await optimizer.stop()
  })

  it('keeps a manual request alive across interrupts and marks the pass as manual', async () => {
    const { optimizer, inspect, runLocal, commitCandidate } = setup()
    optimizer.start()
    expect(optimizer.manualBlocker()).toBeNull()
    expect(optimizer.requestNow()).toBe(true)
    // A settings echo or focus change right after the click must not push the pass back to the idle grace.
    optimizer.interrupt('activity')
    expect(optimizer.snapshot()).toMatchObject({ manual: true, phase: 'paused' })
    expect(optimizer.snapshot().nextCheckAt).toBe(Date.now() + 1)
    await vi.advanceTimersByTimeAsync(2)
    expect(inspect).toHaveBeenCalledWith(expect.any(AbortSignal), false, true)
    expect(runLocal).toHaveBeenCalledWith(expect.objectContaining({ manual: true }), expect.any(AbortSignal))
    expect(commitCandidate).toHaveBeenCalledTimes(1)
    expect(optimizer.snapshot()).toMatchObject({ manual: false, reason: 'candidate_ready' })
    // Scheduled passes are not manual.
    await vi.advanceTimersByTimeAsync(300)
    expect(inspect).toHaveBeenLastCalledWith(expect.any(AbortSignal), false, false)
    await optimizer.stop()
    expect(optimizer.manualBlocker()).toBe('disabled')
  })

  it('ignores faulty UI subscribers and returns immutable snapshots', async () => {
    const { optimizer, runLocal } = setup()
    const unsubscribe = optimizer.subscribe(() => {
      throw new Error('Untrusted view failure')
    })
    const detached = optimizer.snapshot() as { foregroundJobs: number }
    detached.foregroundJobs = 99
    optimizer.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(runLocal).toHaveBeenCalledTimes(1)
    expect(optimizer.snapshot().foregroundJobs).toBe(0)
    unsubscribe()
    await optimizer.stop()
  })

  it('rejects oversized and unbound context before touching the local model', async () => {
    for (const invalid of [
      { ...job, prompt: 'x'.repeat(24_001) },
      { ...job, projectId: undefined },
      { ...job, boundary: 'stale-account' },
      { ...job, principalId: '' },
    ]) {
      const { optimizer, runLocal, commitCandidate } = setup({ nextJob: async () => invalid })
      optimizer.start()
      await vi.advanceTimersByTimeAsync(100)
      expect(runLocal).not.toHaveBeenCalled()
      expect(commitCandidate).not.toHaveBeenCalled()
      expect(optimizer.snapshot().reason).toBe('invalid_context')
      await optimizer.stop()
    }
  })

  it('keeps a restarted scheduler behind a previous undrained stop', async () => {
    const drain = deferred<string>()
    const runLocal = vi.fn(() => drain.promise)
    const { optimizer } = setup({ runLocal })
    optimizer.start()
    await vi.advanceTimersByTimeAsync(100)
    const stopping = optimizer.stop()
    optimizer.start()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(runLocal).toHaveBeenCalledTimes(1)
    drain.resolve('Discarded cancelled candidate')
    await stopping
    expect(optimizer.snapshot().enabled).toBe(true)
    await vi.advanceTimersByTimeAsync(199)
    expect(runLocal).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runLocal).toHaveBeenCalledTimes(2)
    await optimizer.stop()
  })

  it('never includes underlying errors or local context in public scheduler diagnostics', async () => {
    const { optimizer } = setup({
      runLocal: async () => {
        throw new Error('Endpoint, credentials and private prompt from an opaque transport error')
      },
    })
    optimizer.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(optimizer.snapshot().reason).toBe('failed')
    expect(JSON.stringify(optimizer.snapshot())).not.toMatch(/Endpoint|credentials|prompt|project:1/)
    await optimizer.stop()
  })
})
