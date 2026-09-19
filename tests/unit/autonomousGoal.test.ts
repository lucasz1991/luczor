import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAutonomousGoalController,
  createGoalRunState,
  type GoalRunState,
  type GoalStepResult,
} from '@/services/goals/autonomousGoal'

describe('autonomous goal controller', () => {
  const controllers: ReturnType<typeof createAutonomousGoalController>[] = []
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    controllers.forEach(controller => controller.dispose())
    controllers.length = 0
    vi.useRealTimers()
  })

  function fixture() {
    const states = new Map<string, GoalRunState>([['p1', createGoalRunState('Implement and verify a fix', true)]])
    const run = vi.fn<(id: string, state: Readonly<GoalRunState>, signal: AbortSignal) => Promise<GoalStepResult>>()
    const canRun = vi.fn(() => true)
    const persist = vi.fn(async (id: string, next: GoalRunState, expected: number) => {
      if (states.get(id)?.revision !== expected) return false
      states.set(id, next)
      return true
    })
    const onPersistenceError = vi.fn()
    const controller = createAutonomousGoalController({
      read: id => states.get(id),
      persist,
      run,
      canRun,
      onPersistenceError,
    })
    controllers.push(controller)
    return { controller, states, run, persist, canRun, onPersistenceError, current: () => states.get('p1')! }
  }

  it('requires an independent review with evidence before completion', async () => {
    const context = fixture()
    context.run
      .mockResolvedValueOnce({ status: 'completed', summary: 'Implementation ready', evidence: 'Worker claim' })
      .mockResolvedValueOnce({
        status: 'completed',
        summary: 'Tests passed',
        evidence: 'Test report: 12 passing assertions',
      })
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(0)
    expect(context.current()).toMatchObject({
      active: true,
      phase: 'review',
      status: 'waiting',
      iterations: 1,
      evidence: 'Worker claim',
    })
    await vi.advanceTimersByTimeAsync(250)
    expect(context.run.mock.calls.map(call => call[1].phase)).toEqual(['work', 'review'])
    expect(context.current()).toMatchObject({
      active: false,
      status: 'completed',
      iterations: 2,
      evidence: 'Test report: 12 passing assertions',
    })
    await vi.advanceTimersByTimeAsync(10000)
    expect(context.run).toHaveBeenCalledTimes(2)
  })

  it('returns to work if the review reports completion without evidence', async () => {
    const context = fixture()
    context.run
      .mockResolvedValueOnce({ status: 'candidate', summary: 'Candidate' })
      .mockResolvedValueOnce({ status: 'completed', summary: 'Looks good', evidence: '  ' })
      .mockResolvedValueOnce({ status: 'blocked', summary: 'A required test is unavailable' })
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(250)
    expect(context.current()).toMatchObject({ active: true, phase: 'work', status: 'waiting' })
    expect(context.current().reason).toContain('Erfolgsnachweis fehlt')
    await vi.advanceTimersByTimeAsync(250)
    expect(context.current()).toMatchObject({ active: false, status: 'blocked' })
  })

  it('accepts one continuous work run only after its adapter confirms the separate evidence review', async () => {
    const context = fixture()
    context.run.mockResolvedValueOnce({
      status: 'completed',
      summary: 'Verified in the same run',
      evidence: 'Fresh read receipts and passing criteria',
      reviewVerified: true,
    })
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(10000)
    expect(context.run).toHaveBeenCalledOnce()
    expect(context.current()).toMatchObject({ active: false, status: 'completed', iterations: 1 })
  })

  it('keeps the goal open at an inline budget boundary without launching a fresh context', async () => {
    const context = fixture()
    context.run.mockResolvedValueOnce({
      status: 'blocked',
      summary: 'Configured round budget reached; full progress retained',
      messageId: 'same-answer',
    })
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(10000)
    expect(context.run).toHaveBeenCalledOnce()
    expect(context.current()).toMatchObject({ active: false, status: 'blocked', lastMessageId: 'same-answer' })
  })

  it('attaches an admitted user answer and completes without scheduling a synthetic goal turn', async () => {
    const context = fixture()
    context.canRun.mockReturnValue(false)
    context.controller.kick('p1')
    const attached = vi.fn(async () => ({
      status: 'completed' as const,
      summary: 'Same user answer verified',
      evidence: 'Fresh read receipt',
      reviewVerified: true,
      messageId: 'user-answer',
    }))
    await context.controller.runAttached('p1', attached)
    await vi.advanceTimersByTimeAsync(10000)
    expect(attached).toHaveBeenCalledOnce()
    expect(context.run).not.toHaveBeenCalled()
    expect(context.current()).toMatchObject({
      active: false,
      status: 'completed',
      iterations: 1,
      lastMessageId: 'user-answer',
    })
  })

  it('never starts an attached answer for an inactive or stale goal', async () => {
    const context = fixture()
    context.states.set('p1', { ...context.current(), active: false })
    const attached = vi.fn()
    await context.controller.runAttached('p1', attached)
    expect(attached).not.toHaveBeenCalled()
    context.states.set('p1', { ...context.current(), active: true })
    context.persist.mockImplementationOnce(async () => false)
    await context.controller.runAttached('p1', attached)
    expect(attached).not.toHaveBeenCalled()
  })

  it('aborts and drains an attached user answer before another goal run is admitted', async () => {
    const context = fixture()
    const attached = context.controller.runAttached(
      'p1',
      async (_goal, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true })
        })
    )
    await vi.advanceTimersByTimeAsync(0)
    await expect(context.controller.runAttached('p1', vi.fn())).rejects.toThrow('vollständig beendet')
    await context.controller.interrupt('p1')
    await attached
    expect(context.current()).toMatchObject({ active: true, status: 'waiting' })
    const next = vi.fn(async () => ({ status: 'blocked' as const, summary: 'New user direction needed' }))
    await context.controller.runAttached('p1', next)
    await vi.advanceTimersByTimeAsync(10000)
    expect(next).toHaveBeenCalledOnce()
    expect(context.run).not.toHaveBeenCalled()
  })

  it('drains result persistence and rejects late completion after user interruption', async () => {
    const context = fixture()
    let release!: () => void
    const blockedWrite = new Promise<void>(resolve => {
      release = resolve
    })
    context.persist.mockImplementation(async (id, next, expected) => {
      if (next.status === 'completed') await blockedWrite
      if (context.states.get(id)?.revision !== expected) return false
      context.states.set(id, next)
      return true
    })
    const attached = context.controller.runAttached('p1', async () => ({
      status: 'completed',
      summary: 'Old result',
      evidence: 'Old read',
      reviewVerified: true,
    }))
    await vi.advanceTimersByTimeAsync(0)
    let drained = false
    const interrupted = context.controller.interrupt('p1').then(() => {
      drained = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(drained).toBe(false)
    release()
    await Promise.all([attached, interrupted])
    expect(drained).toBe(true)
    expect(context.current()).toMatchObject({ active: true, status: 'waiting' })
    expect(context.current().progress).toBeUndefined()
  })

  it('exposes and drains admission before the goal callback starts', async () => {
    const context = fixture()
    let release!: () => void
    const admissionWrite = new Promise<void>(resolve => {
      release = resolve
    })
    context.persist.mockImplementation(async (id, next, expected) => {
      if (next.status === 'running') await admissionWrite
      if (context.states.get(id)?.revision !== expected) return false
      context.states.set(id, next)
      return true
    })
    const execute = vi.fn()
    const attached = context.controller.runAttached('p1', execute)
    expect(context.controller.isRunning('p1')).toBe(true)
    let drained = false
    const interrupted = context.controller.interrupt('p1').then(() => {
      drained = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(drained).toBe(false)
    release()
    await Promise.all([attached, interrupted])
    expect(drained).toBe(true)
    expect(execute).not.toHaveBeenCalled()
    expect(context.controller.isRunning('p1')).toBe(false)
  })

  it('does not automatically retry an attached answer with a new context after failure', async () => {
    const context = fixture()
    const attached = vi.fn(async () => {
      throw new Error('Model failure')
    })
    await context.controller.runAttached('p1', attached)
    await vi.advanceTimersByTimeAsync(10000)
    expect(context.current()).toMatchObject({ active: false, status: 'blocked' })
    expect(attached).toHaveBeenCalledOnce()
    expect(context.run).not.toHaveBeenCalled()
  })

  it('stops after three sections with the same progress rather than spinning indefinitely', async () => {
    const context = fixture()
    context.run.mockResolvedValue({ status: 'continue', summary: 'Still analyzing', fingerprint: 'unchanged-files' })
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(10000)
    expect(context.run).toHaveBeenCalledTimes(3)
    expect(context.current()).toMatchObject({ active: false, status: 'blocked', stagnantIterations: 3 })
    expect(context.current().reason).toContain('ohne erkennbaren Fortschritt')
  })

  it('bounds transient failures with backoff and never calls them successful', async () => {
    const context = fixture()
    context.run.mockRejectedValue(new Error('Transient transport failure'))
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(0)
    expect(context.run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(context.run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3001)
    expect(context.run).toHaveBeenCalledTimes(3)
    expect(context.current()).toMatchObject({ active: false, status: 'blocked', consecutiveErrors: 3 })
  })

  it('gives a user message priority and discards a late result even if the adapter ignores abort', async () => {
    const context = fixture()
    let finish!: (result: GoalStepResult) => void
    context.run.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(0)
    let released = false
    const interrupted = context.controller.interrupt('p1').then(() => {
      released = true
    })
    expect(context.run.mock.calls[0]?.[2].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(released).toBe(false)
    const revision = context.current().revision
    finish({ status: 'completed', summary: 'Late completion', evidence: 'Late evidence' })
    await interrupted
    expect(released).toBe(true)
    await vi.advanceTimersByTimeAsync(10000)
    expect(context.current()).toMatchObject({ active: true, status: 'waiting', revision })
    expect(context.current().progress).toBeUndefined()
    expect(context.run).toHaveBeenCalledTimes(1)
    context.run.mockResolvedValueOnce({ status: 'blocked', summary: 'Needs input' })
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(0)
    expect(context.run).toHaveBeenCalledTimes(2)
  })

  it('restores an interrupted review as a fresh state-reading work round', async () => {
    const context = fixture()
    context.states.set('p1', { ...context.current(), status: 'checking', phase: 'review', lastMessageId: 'previous' })
    context.run.mockResolvedValueOnce({ status: 'blocked', summary: 'Manual clarification' })
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(0)
    expect(context.run.mock.calls[0]?.[1]).toMatchObject({ phase: 'work', lastMessageId: 'previous' })
    expect(context.persist.mock.calls[0]?.[1].reason).toContain('neu prüfen')
  })

  it('never overlaps cycles and waits while a user workload is active', async () => {
    const context = fixture()
    context.canRun.mockReturnValue(false)
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(5000)
    expect(context.run).not.toHaveBeenCalled()
    context.canRun.mockReturnValue(true)
    let finish!: (result: GoalStepResult) => void
    context.run.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(0)
    context.controller.kick('p1')
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(10000)
    expect(context.run).toHaveBeenCalledTimes(1)
    const stopped = context.controller.stop('p1')
    finish({ status: 'continue', summary: 'Late progress' })
    await stopped
    await vi.advanceTimersByTimeAsync(10000)
    expect(context.current()).toMatchObject({ active: false, status: 'waiting' })
    expect(context.run).toHaveBeenCalledTimes(1)
  })

  it('discards results after an external revision update and cannot write across edits', async () => {
    const context = fixture()
    let finish!: (result: GoalStepResult) => void
    context.run.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(0)
    const revision = context.current().revision + 1
    context.states.set('p1', { ...context.current(), text: 'A new goal', active: false, revision })
    finish({ status: 'completed', summary: 'Obsolete', evidence: 'Obsolete' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(context.current()).toMatchObject({ text: 'A new goal', active: false, revision })
    expect(context.current().progress).toBeUndefined()
  })

  it('does not launch work when the running state cannot be persisted', async () => {
    const context = fixture()
    context.persist.mockRejectedValue(new Error('Disk unavailable'))
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(10000)
    expect(context.run).not.toHaveBeenCalled()
    expect(context.onPersistenceError).toHaveBeenCalledTimes(1)
    expect(context.persist).toHaveBeenCalledTimes(1)
  })

  it('preserves goal text and refuses oversized goals instead of silently shortening them', () => {
    expect(createGoalRunState('  Complete this exact goal.  ', true).text).toBe('Complete this exact goal.')
    expect(createGoalRunState(' ', true).active).toBe(false)
    expect(() => createGoalRunState('x'.repeat(20001), true)).toThrow('nichts gekürzt')
  })

  it('drives goals of several chats side by side without aborting the first one', async () => {
    const context = fixture()
    context.states.set('p2', createGoalRunState('Second chat goal', true))
    let finish!: (result: GoalStepResult) => void
    context.run
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      )
      .mockResolvedValueOnce({ status: 'blocked', summary: 'Second chat needs input' })
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(0)
    context.controller.kick('p2')
    await vi.advanceTimersByTimeAsync(0)
    expect(context.run).toHaveBeenCalledTimes(2)
    expect(context.run.mock.calls.map(call => call[0])).toEqual(['p1', 'p2'])
    expect(context.run.mock.calls[0]?.[2].aborted).toBe(false)
    expect(context.controller.isRunning('p1')).toBe(true)
    expect(context.states.get('p2')).toMatchObject({ active: false, status: 'blocked' })
    finish({ status: 'candidate', summary: 'First chat result retained', evidence: 'Evidence to review' })
    await vi.advanceTimersByTimeAsync(0)
    expect(context.states.get('p1')).toMatchObject({
      active: true,
      status: 'waiting',
      phase: 'review',
      progress: 'First chat result retained',
    })
  })

  it('bounds concurrent goal sections and resumes the waiting goal once a slot frees up', async () => {
    const states = new Map<string, GoalRunState>([
      ['a', createGoalRunState('Goal A', true)],
      ['b', createGoalRunState('Goal B', true)],
    ])
    const finishers = new Map<string, (result: GoalStepResult) => void>()
    const run = vi.fn(
      (id: string) =>
        new Promise<GoalStepResult>(resolve => {
          finishers.set(id, resolve)
        })
    )
    const controller = createAutonomousGoalController({
      read: id => states.get(id),
      persist: async (id, next, expected) => {
        if (states.get(id)?.revision !== expected) return false
        states.set(id, next)
        return true
      },
      run,
      canRun: () => true,
      maxConcurrent: 1,
    })
    controllers.push(controller)
    controller.kick('a')
    await vi.advanceTimersByTimeAsync(0)
    controller.kick('b')
    await vi.advanceTimersByTimeAsync(2000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(states.get('b')).toMatchObject({ active: true, status: 'waiting' })
    finishers.get('a')!({ status: 'blocked', summary: 'A needs input' })
    await vi.advanceTimersByTimeAsync(1500)
    expect(run.mock.calls.map(call => call[0])).toEqual(['a', 'b'])
    expect(controller.isRunning('b')).toBe(true)
  })
})
