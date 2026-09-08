import { shallowRef } from 'vue'
import type { PendingToolCall } from '@/state/types'

export const workflowChanged = shallowRef<{ projectId: string; workflowId: number; runId?: string; sequence: number }>({
  projectId: '',
  workflowId: 0,
  sequence: 0,
})
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

export type WorkflowChatReference = {
  id: number
  name: string
  version?: number
  runId?: string
  status?: string
  summary?: string
}
/** Only trusted executed tool results create actionable chat cards. Model text cannot forge them. */
export function workflowReferences(calls: readonly PendingToolCall[]): WorkflowChatReference[] {
  const references = new Map<number, WorkflowChatReference>()
  for (const call of calls) {
    if (
      typeof call.name !== 'string' ||
      !call.name.startsWith('workflow_') ||
      call.status !== 'executed' ||
      !call.result?.ok
    )
      continue
    const output = call.result.output
    if (!output || typeof output !== 'object') continue
    const value: unknown = Reflect.get(output, 'workflow_ref')
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const id: unknown = Reflect.get(value, 'id')
    const name: unknown = Reflect.get(value, 'name')
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || typeof name !== 'string') continue
    const version: unknown = Reflect.get(value, 'version')
    const runId: unknown = Reflect.get(value, 'runId')
    const status: unknown = Reflect.get(value, 'status')
    const summary: unknown = Reflect.get(value, 'summary')
    references.set(id, {
      id,
      name: name.slice(0, 160),
      version: typeof version === 'number' && Number.isSafeInteger(version) && version > 0 ? version : undefined,
      runId: typeof runId === 'string' ? runId.slice(0, 64) : undefined,
      status: typeof status === 'string' ? status.slice(0, 64) : undefined,
      summary: typeof summary === 'string' ? summary.slice(0, 1000) : undefined,
    })
  }
  return [...references.values()].slice(-8)
}
