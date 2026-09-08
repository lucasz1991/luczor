import { shallowRef } from 'vue'
import type { PendingToolCall } from '@/state/types'

export const workflowChanged = shallowRef<{ projectId: string; workflowId: number; runId?: string; sequence: number }>({ projectId: '', workflowId: 0, sequence: 0 })
export const workflowWebhookSecrets = shallowRef<Record<number, string>>({})
export function publishWorkflowChange(projectId: string, workflowId: number, runId?: string) {
  workflowChanged.value = { projectId, workflowId, runId, sequence: workflowChanged.value.sequence + 1 }
}
export function retainWorkflowSecret(id: number, secret: string) {
  workflowWebhookSecrets.value = { ...workflowWebhookSecrets.value, [id]: secret }
}
export function clearWorkflowPresentation() {
  workflowWebhookSecrets.value = {}
  workflowChanged.value = { projectId: '', workflowId: 0, sequence: workflowChanged.value.sequence + 1 }
}
if (typeof window !== 'undefined') window.addEventListener('luczor:api-identity-changing', clearWorkflowPresentation)

export type WorkflowChatReference = { id: number; name: string; version?: number; runId?: string; status?: string; summary?: string }
/** Only trusted executed tool results create actionable chat cards. Model text cannot forge them. */
export function workflowReferences(calls: readonly PendingToolCall[]): WorkflowChatReference[] {
  const references = new Map<number, WorkflowChatReference>()
  for (const call of calls) {
    if (!call.name.startsWith('workflow_') || call.status !== 'executed' || !call.result?.ok) continue
    const output = call.result.output
    if (!output || typeof output !== 'object') continue
    const value = Reflect.get(output, 'workflow_ref') as WorkflowChatReference | undefined
    if (!value || !Number.isSafeInteger(value.id) || value.id < 1 || typeof value.name !== 'string') continue
    references.set(value.id, { ...value, name: value.name.slice(0, 160), summary: value.summary?.slice(0, 1000) })
  }
  return [...references.values()].slice(-8)
}
