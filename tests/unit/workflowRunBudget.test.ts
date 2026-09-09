import { describe, expect, it } from 'vitest'
import { readWorkflowRunBudget } from '@/services/workflows/runBudget'
import type { WorkflowRun } from '@/services/workflows/types'

function run(extra: Record<string, unknown> = {}): WorkflowRun {
  return { id: 1, public_id: 'run', workflow_definition_id: 3, status: 'running', sandbox: false, ...extra }
}
describe('authoritative workflow run budget display', () => {
  it('does not turn absent or invalid measurements into zero consumption', () => {
    expect(readWorkflowRunBudget(run(), []).rows).toEqual([])
    const invalid = run({
      budgets: { max_executions: 0, active_seconds: 10 },
      budget_state: { executions: 0, active_ms: -1 },
    })
    expect(readWorkflowRunBudget(invalid, []).rows).toEqual([])
  })
  it('uses actual server measurements for the 80 percent threshold without wall-clock extrapolation', () => {
    const current = run({
      budgets: { max_executions: 100, active_seconds: 60 },
      budget_state: { executions: 79, active_ms: 48000, last_accounted_at: '2026-09-09T00:00:00Z' },
    })
    const budget = readWorkflowRunBudget(current, [])
    expect(budget.rows.map(row => row.percent)).toEqual([79, 80])
    expect(budget.nearLimit).toBe(true)
    expect(budget.accountedAt).toBe('2026-09-09T00:00:00Z')
  })
  it('never treats a child counter as the total while the root is absent', () => {
    const child = run({ root_workflow_run_id: 5, budgets: { max_executions: 200 }, budget_state: { executions: 0 } })
    expect(readWorkflowRunBudget(child, [child])).toMatchObject({ rootUnavailable: true, rows: [] })
    const root = run({ id: 5, budgets: { max_executions: 200 }, budget_state: { executions: 170 } })
    expect(readWorkflowRunBudget(child, [child, root])).toMatchObject({
      inherited: true,
      rootUnavailable: false,
      nearLimit: true,
      rows: [{ used: 170, limit: 200, percent: 85 }],
    })
  })
  it('clamps a progress bar but preserves measured overrun and the actual stop reason', () => {
    const current = run({
      budgets: { max_executions: 2 },
      budget_state: { executions: 3, stop_reason: 'workflow_budget_exhausted' },
    })
    expect(readWorkflowRunBudget(current, [])).toMatchObject({
      rows: [{ used: 3, limit: 2, percent: 100 }],
      stopReason: 'workflow_budget_exhausted',
    })
  })
  it('keeps a requested boundary stop pending until the server reports actual completion', () => {
    const current = run({ budget_state: { boundary_stop: { status: 'pending', requested_at: '2026-09-09' } } })
    expect(readWorkflowRunBudget(current, []).boundaryStop).toBe('pending')
    expect(current.status).toBe('running')
    const completed = run({
      status: 'cancelled',
      budget_state: { boundary_stop: { status: 'completed' }, stop_reason: 'workflow_boundary_stop' },
    })
    expect(readWorkflowRunBudget(completed, [])).toMatchObject({
      boundaryStop: 'completed',
      stopReason: 'workflow_boundary_stop',
    })
    expect(
      readWorkflowRunBudget(run({ budget_state: { boundary_stop: { status: 'paused' } } }), []).boundaryStop
    ).toBeNull()
  })
  it('uses the owned root projection and rejects a projection for a different root', () => {
    const child = run({
      root_workflow_run_id: 5,
      root_budget: {
        id: 5,
        status: 'running',
        budgets: { max_executions: 200 },
        budget_state: { executions: 180, boundary_stop: { status: 'pending' } },
      },
    })
    expect(readWorkflowRunBudget(child, [])).toMatchObject({
      inherited: true,
      rootUnavailable: false,
      boundaryStop: 'pending',
      rootStatus: 'running',
      rows: [{ used: 180, limit: 200, percent: 90 }],
    })
    const mismatched = {
      ...child,
      root_budget: { id: 99, status: 'running', budget_state: { boundary_stop: { status: 'pending' } } },
    }
    expect(readWorkflowRunBudget(mismatched, [])).toMatchObject({ rootUnavailable: true, boundaryStop: null, rows: [] })
  })
})
