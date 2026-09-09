import type { WorkflowTrigger, WorkflowTriggerKind } from './types'

/** Fields this editor does not expose must survive an unrelated rename or input edit. */
export function preserveWorkflowTriggerScope(
  trigger: WorkflowTrigger | undefined,
  kind: WorkflowTriggerKind,
  edited: Record<string, unknown>
): Record<string, unknown> {
  const config = { ...edited }
  if (trigger?.kind !== kind) return config
  const preserved =
    kind === 'workspace.file_changed'
      ? ['device_id', 'root_path', 'debounce_seconds']
      : kind === 'workflow.completed'
        ? ['statuses']
        : []
  for (const field of preserved) {
    if (Object.hasOwn(trigger.config, field)) Reflect.set(config, field, Reflect.get(trigger.config, field))
    else Reflect.deleteProperty(config, field)
  }
  return config
}
