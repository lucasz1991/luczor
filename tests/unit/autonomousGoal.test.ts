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

  it('keeps the captured goal section alive during navigation before scheduling the next project', async () => {
    const context = fixture()
    context.states.set('p2', createGoalRunState('Second project goal', true))
    let finish!: (result: GoalStepResult) => void
    context.run
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      )
      .mockResolvedValueOnce({ status: 'blocked', summary: 'Second project needs input' })
    context.controller.kick('p1')
    await vi.advanceTimersByTimeAsync(0)
    context.controller.kick('p2')
    await vi.advanceTimersByTimeAsync(5000)
    expect(context.run).toHaveBeenCalledTimes(1)
    expect(context.run.mock.calls[0]?.[2].aborted).toBe(false)
    finish({ status: 'candidate', summary: 'First project result retained', evidence: 'Evidence to review' })
    await vi.advanceTimersByTimeAsync(250)
    expect(context.run.mock.calls.map(call => call[0])).toEqual(['p1', 'p2'])
    expect(context.states.get('p1')).toMatchObject({
      active: true,
      status: 'waiting',
      phase: 'review',
      progress: 'First project result retained',
    })
    expect(context.states.get('p2')).toMatchObject({ active: false, status: 'blocked' })
  })
})
