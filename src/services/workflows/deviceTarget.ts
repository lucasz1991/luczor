import type { WorkflowDefinition, WorkflowDeviceTarget, WorkflowTask } from './types'

/** Mirrors the server contract; ownership and current capabilities remain server-validated. */
export function validateWorkflowDeviceTarget(value: unknown, catalog?: readonly WorkflowTask[]): WorkflowDeviceTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Bitte ein gültiges Geräteziel wählen.')
  const kind = Reflect.get(value, 'kind') as unknown
  const allowed =
    kind === 'specific'
      ? ['kind', 'device_id']
      : kind === 'capability'
        ? ['kind', 'task_type', 'task_version']
        : ['kind']
  if (
    typeof kind !== 'string' ||
    !['current', 'coordinator', 'specific', 'capability'].includes(kind) ||
    Object.keys(value).some(key => !allowed.includes(key))
  )
    throw new Error('Die Felder des Geräteziels passen nicht zur Auswahl.')
  if (kind === 'specific') {
    const id: unknown = Reflect.get(value, 'device_id')
    if (typeof id !== 'string' || !id.trim() || new TextEncoder().encode(id).length > 120)
      throw new Error('Bitte eine Geräte-ID mit höchstens 120 Bytes eintragen.')
    return { kind, device_id: id }
  }
  if (kind === 'capability') {
    const taskType: unknown = Reflect.get(value, 'task_type')
    const version: unknown = Reflect.get(value, 'task_version')
    if (version !== undefined && version !== 1)
      throw new Error('Für Gerätefähigkeiten ist derzeit nur Version 1 freigegeben.')
    if (
      taskType !== undefined &&
      (typeof taskType !== 'string' ||
        !taskType.trim() ||
        (catalog && !catalog.some(task => task.key === taskType && task.runner === 'client')))
    )
      throw new Error('Bitte eine verfügbare Gerätefähigkeit wählen.')
    return {
      kind,
      ...(taskType === undefined ? {} : { task_type: taskType as string }),
      ...(version === undefined ? {} : { task_version: 1 }),
    }
  }
  return { kind: kind as 'current' | 'coordinator' }
}

export function validateWorkflowDeviceTargets(
  definition: WorkflowDefinition,
  catalog?: readonly WorkflowTask[],
  depth = 0
): void {
  if (depth > 8 || !definition || !Array.isArray(definition.steps))
    throw new Error('Die Workflow-Struktur ist ungültig.')
  for (const step of definition.steps) {
    if (step.device_target !== undefined) {
      if (catalog && !catalog.some(task => task.key === step.type && task.runner === 'client'))
        throw new Error(`Schritt „${step.key}“: Nur Geräteaufgaben können ein Geräteziel erhalten.`)
      try {
        validateWorkflowDeviceTarget(step.device_target, catalog)
      } catch (error) {
        throw new Error(`Schritt „${step.key}“: ${error instanceof Error ? error.message : 'Geräteziel prüfen.'}`)
      }
    }
    if (['control.foreach', 'control.until'].includes(step.type) && step.payload.body)
      validateWorkflowDeviceTargets(step.payload.body as WorkflowDefinition, catalog, depth + 1)
    if (step.type === 'control.parallel' && Array.isArray(step.payload.branches))
      for (const branch of step.payload.branches)
        validateWorkflowDeviceTargets(branch as WorkflowDefinition, catalog, depth + 1)
  }
}
