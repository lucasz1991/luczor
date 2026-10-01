import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginDreamRun,
  commitDreamDecisions,
  dreamEffects,
  dreamTrace,
  endDreamRun,
  recordDreamDecision,
  recordDreamFailure,
  recordDreamOffload,
  recordDreamScan,
  recordDreamSkip,
  recordDreamStep,
  resetDreamTraceForTests,
} from '@/services/memory/dreamTrace'

describe('dream trace', () => {
  beforeEach(() => resetDreamTraceForTests())
  afterEach(() => vi.restoreAllMocks())

  it('records skips only when the reason changes', () => {
    recordDreamSkip('foreground')
    const first = dreamTrace.value.lastSkip
    recordDreamSkip('foreground')
    expect(dreamTrace.value.lastSkip).toBe(first)
    recordDreamSkip('cpu_pressure')
    expect(dreamTrace.value.lastSkip?.reason).toBe('cpu_pressure')
  })

  it('folds the last scan into a new run and maps decisions to graph node effects', () => {
    recordDreamScan({ work: 4, queued: 2, blocked: 1, waitingForGate: 0 })
    beginDreamRun({
      jobKey: 'memory:p1:a',
      task: 'memory',
      scope: 'project',
      projectId: 'p1',
      sources: [
        { kind: 'memory', id: 'm1', label: 'x'.repeat(200) },
        { kind: 'file', id: 'f1', label: 'src/app.ts' },
      ],
    })
    const run = dreamTrace.value.current!
    expect(run.steps.map(step => step.stage)).toEqual(['scanning', 'selecting'])
    expect(run.decisions[0]!.targets[0]!.label).toHaveLength(72)
    recordDreamStep('generating', 'Entwurf erzeugen')
    recordDreamDecision('remove', [{ kind: 'memory', id: 'm1' }], 'ersetzt')
    recordDreamDecision('conflict', [{ kind: 'memory', id: 'm2' }])
    const live = dreamEffects(dreamTrace.value)
    expect(live.active).toBe(true)
    expect([...live.reading]).toEqual(['memory:m1', 'file:f1'])
    expect(live.removing.size).toBe(0)
    expect(live.conflicts.size).toBe(0)
    commitDreamDecisions()
    endDreamRun('success')
    expect(dreamTrace.value.current).toBeNull()
    expect(dreamTrace.value.history[0]?.outcome).toBe('success')
    expect(dreamTrace.value.history[0]?.steps.at(-1)?.stage).toBe('done')
    const settled = dreamEffects(dreamTrace.value)
    expect(settled.active).toBe(false)
    expect(settled.reading.size).toBe(0)
    expect(settled.removing.has('memory:m1')).toBe(true)
  })

  it.each(['failed', 'interrupted'] as const)('never animates uncommitted effects after %s', outcome => {
    beginDreamRun({ jobKey: 'a', task: 'memory', scope: 'user', sources: [] })
    recordDreamDecision('remove', [{ kind: 'memory', id: 'm1' }])
    recordDreamDecision('conflict', [{ kind: 'memory', id: 'm2' }])
    endDreamRun(outcome, 'verification_rejected')
    const effects = dreamEffects(dreamTrace.value)
    expect(effects.removing.size).toBe(0)
    expect(effects.conflicts.size).toBe(0)
    expect(effects.touched.size).toBe(0)
    expect(effects.run?.decisions.every(decision => decision.effectState === 'proposed')).toBe(true)
  })

  it('only promotes explicitly committed decisions and records safe failure metadata', () => {
    beginDreamRun({ jobKey: 'a', task: 'memory', scope: 'user', sources: [] })
    recordDreamDecision('remove', [{ kind: 'memory', id: 'm1' }])
    commitDreamDecisions()
    commitDreamDecisions()
    recordDreamFailure({ phase: 'commit', category: 'runtime', code: 'journal_failed', attempt: 1 })
    endDreamRun('failed', 'journal_failed')
    expect(dreamEffects(dreamTrace.value).removing.has('memory:m1')).toBe(true)
    expect(dreamTrace.value.history[0]?.failureDetail).toEqual({
      phase: 'commit',
      category: 'runtime',
      code: 'journal_failed',
      attempt: 1,
    })
    expect(dreamTrace.value.history[0]?.decisions).toHaveLength(1)
    expect(dreamTrace.value.history[0]?.committedAt).toBeDefined()
    expect(dreamTrace.value.history[0]?.steps.at(-1)?.title).toBe('Nach Speichern unterbrochen')
  })

  it('marks an abandoned run as interrupted when the next one starts', () => {
    beginDreamRun({ jobKey: 'a', task: 'context', scope: 'user', sources: [] })
    beginDreamRun({ jobKey: 'b', task: 'context', scope: 'user', sources: [] })
    expect(dreamTrace.value.history[0]?.jobKey).toBe('a')
    expect(dreamTrace.value.history[0]?.outcome).toBe('interrupted')
    expect(dreamTrace.value.current?.jobKey).toBe('b')
  })

  it('does not apply a previous run commit or error to a newly started run', () => {
    beginDreamRun({ jobKey: 'old', task: 'memory', scope: 'user', sources: [] })
    const oldId = dreamTrace.value.current!.id
    beginDreamRun({ jobKey: 'new', task: 'memory', scope: 'user', sources: [] })
    recordDreamDecision('remove', [{ kind: 'memory', id: 'new-memory' }])
    commitDreamDecisions(oldId)
    recordDreamFailure({ phase: 'commit', category: 'runtime', code: 'journal_failed' }, oldId)
    expect(dreamTrace.value.current?.failureDetail).toBeUndefined()
    expect(dreamTrace.value.current?.decisions[0]?.effectState).toBe('proposed')
    expect(dreamEffects(dreamTrace.value).removing.size).toBe(0)
  })

  it.each(['success', 'failed', 'interrupted'] as const)(
    'stops low-RAM activity after %s and retains the free-capacity observation as history',
    outcome => {
      recordDreamOffload({ active: true, freeRamMiB: 2898, swapFreeMiB: 33947 })
      beginDreamRun({ jobKey: 'a', task: 'context', scope: 'user', sources: [] })
      const step = dreamTrace.value.current?.steps[0]
      expect(step?.title).toBe('RAM-schonender Modus')
      expect(step?.detail).toContain('Systemweit frei')
      expect(step?.detail).toContain('Keine Verbrauchsmessung')
      expect(step?.detail).not.toContain('langsamer')
      endDreamRun(outcome)
      expect(dreamTrace.value.offload?.active).toBe(false)
      expect(dreamTrace.value.history[0]?.steps[0]).toEqual(step)
    }
  )

  it('clears a declined admission even for a repeated skip without discarding the observation', () => {
    recordDreamSkip('cpu_pressure')
    const originalSkip = dreamTrace.value.lastSkip
    recordDreamOffload({ active: true, freeRamMiB: 2898, swapFreeMiB: 33947 })
    recordDreamSkip('cpu_pressure')
    expect(dreamTrace.value.offload).toMatchObject({ active: false, freeRamMiB: 2898, swapFreeMiB: 33947 })
    expect(dreamTrace.value.lastSkip).toBe(originalSkip)
  })

  it('does not attach old low-RAM eligibility to a later run', () => {
    recordDreamOffload({ active: true, freeRamMiB: 2898, swapFreeMiB: 33947 })
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121_000)
    beginDreamRun({ jobKey: 'a', task: 'context', scope: 'user', sources: [] })
    expect(dreamTrace.value.current?.steps.map(step => step.stage)).toEqual(['selecting'])
  })
})
