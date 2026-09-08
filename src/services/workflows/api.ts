import { requestWithConfig, type LuczorApiConfigSnapshot, type RequestOptions } from '@/services/api/luczorApi'
import type { Workflow, WorkflowDefinition, WorkflowRun, WorkflowTask, WorkflowTrigger, WorkflowWrite } from './types'

export type WorkflowEnvelope<T> = { data: T; meta?: Record<string, unknown> }
/** Every request retains the account/server snapshot captured by its owning action. */
export function createWorkflowApi(config: LuczorApiConfigSnapshot, signal?: AbortSignal) {
  const request = <T>(path: string, options: RequestOptions = {}) =>
    requestWithConfig<T>(path, { ...options, signal }, config)
  return {
    catalog: () => request<WorkflowEnvelope<WorkflowTask[]>>('/workflows/task-catalog'),
    list: (projectId: string) => request<WorkflowEnvelope<Workflow[]>>('/workflows', { query: { project_id: projectId } }),
    get: (id: number) => request<WorkflowEnvelope<Workflow>>(`/workflows/${id}`),
    validate: (definition: WorkflowDefinition, projectId: string, workflowId?: number) =>
      request<WorkflowEnvelope<{ valid: boolean; definition: WorkflowDefinition }>>('/workflows/validate', {
        method: 'POST', body: { definition, project_id: projectId, workflow_definition_id: workflowId },
      }),
    create: (body: WorkflowWrite) => request<WorkflowEnvelope<Workflow>>('/workflows', { method: 'POST', body }),
    update: (id: number, body: WorkflowWrite) => request<WorkflowEnvelope<Workflow>>(`/workflows/${id}`, { method: 'PATCH', body }),
    operation: (id: string) => request<WorkflowEnvelope<{ operation_id: string; status: string; response?: unknown }>>(`/workflow-operations/${encodeURIComponent(id)}`),
    runs: (id: number) => request<WorkflowEnvelope<WorkflowRun[]>>(`/workflows/${id}/runs`),
    run: (id: string) => request<WorkflowEnvelope<WorkflowRun>>(`/workflow-runs/${encodeURIComponent(id)}`),
    start: (id: number, body: Record<string, unknown>) => request<WorkflowEnvelope<WorkflowRun>>(`/workflows/${id}/runs`, { method: 'POST', body }),
    cancel: (id: string) => request<WorkflowEnvelope<WorkflowRun>>(`/workflow-runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    approve: (id: number) => request<WorkflowEnvelope<WorkflowRun>>(`/workflow-steps/${id}/approve`, { method: 'POST' }),
    complete: (id: number, output: Record<string, unknown>) => request<WorkflowEnvelope<WorkflowRun>>(`/workflow-steps/${id}/complete`, { method: 'POST', body: { output } }),
    triggers: (id: number) => request<WorkflowEnvelope<WorkflowTrigger[]>>(`/workflows/${id}/triggers`),
    saveTrigger: (id: number, body: Record<string, unknown>, triggerId?: number) =>
      request<WorkflowEnvelope<WorkflowTrigger>>(triggerId ? `/workflow-triggers/${triggerId}` : `/workflows/${id}/triggers`, { method: triggerId ? 'PATCH' : 'POST', body }),
    deleteTrigger: (id: number) => request<WorkflowEnvelope<unknown>>(`/workflow-triggers/${id}`, { method: 'DELETE' }),
    automation: (id: number) => request<WorkflowEnvelope<{ grant: Record<string, unknown> | null }>>(`/workflows/${id}/automation`),
  }
}
export type WorkflowApi = ReturnType<typeof createWorkflowApi>
