/** Shared desktop contracts for the existing Laravel workflow API. */
export type WorkflowRoute = { type: 'step' | 'end' | 'fail'; step_key?: string; max_iterations?: number }
export type WorkflowStepDefinition = {
  key: string
  type: string
  depends_on?: string[]
  payload: Record<string, unknown>
  routes?: Record<string, WorkflowRoute>
  requires_approval?: boolean
  max_attempts?: number
}
export type WorkflowDefinition = {
  steps: WorkflowStepDefinition[]
  lists?: Array<{ key: string; name: string }>
  input_schema?: Record<string, unknown>
  meta?: Record<string, unknown>
}
export type WorkflowRevision = {
  id: number
  version: number
  name?: string
  definition: WorkflowDefinition
  change_summary?: string | null
  created_at: string
}
export type Workflow = {
  id: number
  name: string
  version: number
  current_revision_id?: number | null
  project_id: number | null
  project_external_id: string | null
  status: string
  is_locked: boolean
  is_edit_locked?: boolean
  definition: WorkflowDefinition
  revisions?: WorkflowRevision[]
  updated_at?: string
}
export type WorkflowTask = {
  key: string
  label: string
  kind: string
  runner: string
  mutating: boolean
  requires_approval: boolean
  allowed_in_definition: boolean
  params: Record<
    string,
    { type: string; default?: unknown; min?: number; max?: number; required?: boolean; enum?: string[] }
  >
}
export type WorkflowRunStep = {
  id: number
  step_key: string
  type: string
  status: string
  attempts?: number
  output?: Record<string, unknown> | null
  error?: string | null
  duration_ms?: number | null
  payload?: Record<string, unknown>
}
export type WorkflowRun = {
  id: number
  public_id: string
  workflow_definition_id: number
  workflow_revision_id?: number | null
  definition_version?: number | null
  project_external_id?: string | null
  status: string
  sandbox: boolean
  steps?: WorkflowRunStep[]
  output?: Record<string, unknown> | null
  context?: Record<string, unknown>
  started_at?: string | null
  finished_at?: string | null
  created_at?: string
  duration_ms?: number | null
}
export const WORKFLOW_TRIGGER_KINDS = [
  'schedule',
  'webhook',
  'task.completed',
  'workflow.completed',
  'github.push',
  'github.pull_request',
  'workspace.file_changed',
] as const
export type WorkflowTriggerKind = (typeof WORKFLOW_TRIGGER_KINDS)[number]
export type WorkflowTrigger = {
  id: number
  public_id: string
  workflow_definition_id?: number
  name: string
  kind: WorkflowTriggerKind
  enabled: boolean
  config: Record<string, unknown>
  input?: Record<string, unknown>
  next_due_at?: string | null
  last_error?: string | null
  webhook_secret?: string
  webhook_url?: string
}
export type WorkflowWrite = {
  name: string
  definition: WorkflowDefinition
  project_id: string
  expected_version?: number
  change_summary?: string
  operation_id?: string
}
export const WORKFLOW_STATUS_LABELS: Record<string, string> = {
  active: 'Aktiv',
  draft: 'Entwurf',
  paused: 'Pausiert',
  queued: 'Eingereiht',
  ready: 'Bereit',
  running: 'Läuft',
  completed: 'Abgeschlossen',
  failed: 'Fehlgeschlagen',
  cancelled: 'Abgebrochen',
  cancelling: 'Abbruch läuft',
  cancel_requested: 'Abbruch läuft',
  skipped: 'Übersprungen',
  awaiting_approval: 'Freigabe erforderlich',
  waiting_device: 'Wartet auf Gerät',
  waiting_for_device: 'Wartet auf Gerät',
  awaiting_device: 'Wartet auf Gerät',
  waiting_project: 'Wartet auf Projekt',
  waiting: 'Wartet',
  outcome_unknown: 'Ausgang unklar',
  approval_required: 'Freigabe erforderlich',
}
export function workflowStatusLabel(status: string): string {
  return Object.hasOwn(WORKFLOW_STATUS_LABELS, status)
    ? (Reflect.get(WORKFLOW_STATUS_LABELS, status) as string)
    : status
}
export function isTerminalWorkflow(status: string): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status)
}
