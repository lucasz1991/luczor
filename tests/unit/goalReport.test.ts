import { describe, expect, it, vi } from 'vitest'
import { createGoalReportTool, type GoalReport } from '@/services/agents/goalReport'

describe('root goal reports', () => {
  it('records bounded work candidates without approving a goal or returning private details', async () => {
    const report = vi.fn()
    const tool = createGoalReportTool({ phase: 'work', report })
    expect(tool).toMatchObject({
      mutating: false,
      requiresApproval: false,
      dataHandling: 'ephemeral',
      effects: ['read'],
    })
    const result = await tool.execute(
      { status: 'candidate', summary: '  Änderungen bereit  ', evidence: '  Private Prüfdaten  ' },
      { projectId: 'project-1' }
    )
    expect(report).toHaveBeenCalledExactlyOnceWith({
      status: 'candidate',
      summary: 'Änderungen bereit',
      evidence: 'Private Prüfdaten',
    })
    expect(result).toEqual({ ok: true, reportRecorded: true, status: 'candidate' })
  })

  it.each(['continue', 'candidate', 'blocked'] as const)('accepts the work status %s', async status => {
    const report = vi.fn()
    await createGoalReportTool({ phase: 'work', report }).execute(
      { status, summary: 'Belegter Stand' },
      { projectId: 'project-1' }
    )
    expect(report).toHaveBeenCalledWith({ status, summary: 'Belegter Stand' })
  })

  it('does not permit the worker to confirm completion', async () => {
    const report = vi.fn()
    await expect(
      createGoalReportTool({ phase: 'work', report }).execute(
        { status: 'completed', summary: 'Fertig', evidence: 'Tests grün' },
        { projectId: 'project-1' }
      )
    ).rejects.toThrow()
    expect(report).not.toHaveBeenCalled()
  })

  it.each([undefined, '', ' \n '])('requires nonempty evidence for a completed review (%s)', async evidence => {
    const report = vi.fn()
    await expect(
      createGoalReportTool({ phase: 'review', report }).execute(
        { status: 'completed', summary: 'Geprüft', ...(evidence !== undefined ? { evidence } : {}) },
        { projectId: 'project-1' }
      )
    ).rejects.toThrow('Nachweis')
    expect(report).not.toHaveBeenCalled()
  })

  it('records the independent review as a report only', async () => {
    const report = vi.fn<(value: GoalReport) => void>()
    await createGoalReportTool({ phase: 'review', report }).execute(
      { status: 'completed', summary: 'Abnahmekriterien geprüft', evidence: 'Testausgabe: 8/8; Revision abc123.' },
      { projectId: 'project-1' }
    )
    expect(report).toHaveBeenCalledWith({
      status: 'completed',
      summary: 'Abnahmekriterien geprüft',
      evidence: 'Testausgabe: 8/8; Revision abc123.',
    })
  })

  it.each([
    { status: 'unknown', summary: 'Stand' },
    { status: 'continue', summary: '   ' },
    { status: 'continue', summary: 'x'.repeat(1201) },
    { status: 'continue', summary: 'Stand', evidence: 'x'.repeat(4001) },
    { status: 'continue', summary: 'Stand', projectId: 'another-project' },
  ])('rejects invalid or excessive report data', async args => {
    const report = vi.fn()
    await expect(
      createGoalReportTool({ phase: 'work', report }).execute(args, { projectId: 'project-1' })
    ).rejects.toThrow()
    expect(report).not.toHaveBeenCalled()
  })

  it('never reports after cancellation', async () => {
    const report = vi.fn()
    const controller = new AbortController()
    controller.abort()
    await expect(
      createGoalReportTool({ phase: 'work', report }).execute(
        { status: 'candidate', summary: 'Bereit' },
        { projectId: 'project-1', signal: controller.signal }
      )
    ).rejects.toThrow()
    expect(report).not.toHaveBeenCalled()
  })
})
