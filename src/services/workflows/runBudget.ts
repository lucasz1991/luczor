import type { WorkflowRun } from './types'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
export type WorkflowBudgetRow = {
  key: string
  label: string
  used: number
  limit: number
  percent: number
  unit: string
}

/** Root counters are authoritative; absent child/root metrics never become zero usage. */
export function readWorkflowRunBudget(run: WorkflowRun | null, knownRuns: readonly WorkflowRun[]) {
  const rows: WorkflowBudgetRow[] = []
  const rootId = run ? count(Reflect.get(run, 'root_workflow_run_id')) : null
  const inherited = rootId !== null && rootId > 0 && rootId !== run?.id
  const embedded = record(run && Reflect.get(run, 'root_budget'))
  const source =
    embedded && embedded.id === (inherited ? rootId : run?.id)
      ? embedded
      : inherited
        ? knownRuns.find(item => item.id === rootId)
        : run
  const policy = record(source && Reflect.get(source, 'budgets'))
  const state = record(source && Reflect.get(source, 'budget_state'))
  if (policy && state) {
    const executions = count(state.executions)
    const executionLimit = count(policy.max_executions)
    if (executions !== null && executionLimit !== null && executionLimit > 0)
      rows.push({
        key: 'executions',
        label: 'Ausgeführte Schritte',
        used: executions,
        limit: executionLimit,
        percent: Math.min(100, (executions / executionLimit) * 100),
        unit: '',
      })
    const milliseconds = count(state.active_ms)
    const secondsLimit = count(policy.active_seconds)
    if (milliseconds !== null && secondsLimit !== null && secondsLimit > 0)
      rows.push({
        key: 'active',
        label: 'Aktive Laufzeit',
        used: milliseconds / 60000,
        limit: secondsLimit / 60,
        percent: Math.min(100, (milliseconds / (secondsLimit * 1000)) * 100),
        unit: 'Min.',
      })
  }
  return {
    inherited,
    rootId,
    rootUnavailable: inherited && !source,
    rows,
    nearLimit: rows.some(row => row.percent >= 80),
    accountedAt: typeof state?.last_accounted_at === 'string' ? state.last_accounted_at : null,
    stopReason: typeof state?.stop_reason === 'string' ? state.stop_reason : null,
    rootStatus: typeof source?.status === 'string' ? source.status : null,
    boundaryStop: (() => {
      const boundary = record(state?.boundary_stop)
      return boundary?.status === 'pending' || boundary?.status === 'completed' ? boundary.status : null
    })(),
  }
}
