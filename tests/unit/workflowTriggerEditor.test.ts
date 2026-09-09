import { describe, expect, it } from 'vitest'
import { preserveWorkflowTriggerScope } from '@/services/workflows/triggerEditing'
import type { WorkflowTrigger } from '@/services/workflows/types'

const trigger = (kind: WorkflowTrigger['kind'], config: Record<string, unknown>): WorkflowTrigger => ({
  id: 7,
  public_id: 'trigger',
  name: 'Existing',
  enabled: true,
  kind,
  config,
})
describe('editing trigger metadata preserves its execution scope', () => {
  it('keeps the exact completion filter when only renaming', () => {
    expect(
      preserveWorkflowTriggerScope(trigger('workflow.completed', { statuses: ['failed'] }), 'workflow.completed', {
        workflow_definition_id: 4,
        statuses: ['completed', 'failed'],
      })
    ).toEqual({ workflow_definition_id: 4, statuses: ['failed'] })
  })
  it('keeps device, root and debounce independent from the currently open project but accepts explicitly edited patterns', () => {
    const old = { device_id: 'original-device', root_path: 'E:/original', debounce_seconds: 12, paths: ['src/**'] }
    const edited = { device_id: 'other', root_path: 'E:/other', debounce_seconds: 2, paths: ['docs/**'] }
    expect(
      preserveWorkflowTriggerScope(trigger('workspace.file_changed', old), 'workspace.file_changed', edited)
    ).toEqual({ ...old, paths: ['docs/**'] })
    expect(edited.device_id).toBe('other')
  })
  it('does not turn an absent filter into an explicit different one or leak old configuration across trigger types', () => {
    expect(
      preserveWorkflowTriggerScope(trigger('workflow.completed', {}), 'workflow.completed', {
        statuses: ['completed', 'failed'],
      })
    ).toEqual({})
    expect(
      preserveWorkflowTriggerScope(trigger('workflow.completed', { statuses: ['failed'] }), 'webhook', {})
    ).toEqual({})
    expect(preserveWorkflowTriggerScope(undefined, 'workflow.completed', { statuses: ['completed'] })).toEqual({
      statuses: ['completed'],
    })
  })
})
