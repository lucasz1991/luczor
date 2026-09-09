import { readWorkflowRunBudget } from '@/services/workflows/runBudget'
import type { WorkflowRun } from '@/services/workflows/types'

/** Renderer projection contains only identities, measured counters and public stop state. */
export function miniWorkflowBudgetSnapshot(run: WorkflowRun): WorkflowRun {
  const budget = readWorkflowRunBudget(run, [])
  const policy: Record<string, number> = {}
  const state: Record<string, unknown> = {}
  for (const row of budget.rows) {
    if (row.key === 'executions') { policy.max_executions = row.limit; state.executions = row.used }
    else if (row.key === 'active') { policy.active_seconds = Math.round(row.limit * 60); state.active_ms = Math.round(row.used * 60000) }
  }
  if (budget.accountedAt) state.last_accounted_at = budget.accountedAt.slice(0, 40)
  if (budget.boundaryStop) state.boundary_stop = { status: budget.boundaryStop }
  if (budget.stopReason === 'workflow_boundary_stop') state.stop_reason = budget.stopReason
  const snapshot: WorkflowRun = {
    id: run.id, public_id: run.public_id, workflow_definition_id: run.workflow_definition_id,
    project_external_id: run.project_external_id, status: run.status.slice(0, 64), sandbox: run.sandbox,
  }
  return Object.assign(snapshot, budget.inherited ? {
    root_workflow_run_id: budget.rootId,
    ...(!budget.rootUnavailable ? { root_budget: { id: budget.rootId, status: budget.rootStatus, budgets: policy, budget_state: state } } : {}),
  } : { budgets: policy, budget_state: state })
}
