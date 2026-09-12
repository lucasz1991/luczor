import { requestWithConfig, type LuczorApiConfigSnapshot, type RequestOptions } from '@/services/api/luczorApi'
import { projectExternalIdForServer } from '@/services/cloudProjectAccess'
import type {
  Workflow,
  WorkflowDefinition,
  WorkflowRevision,
  WorkflowRun,
  WorkflowTask,
  WorkflowTrigger,
  WorkflowWrite,
} from './types'

export type WorkflowEnvelope<T> = { data: T; meta?: Record<string, unknown> }
/** Every request retains the account/server snapshot captured by its owning action. */
export function createWorkflowApi(config: LuczorApiConfigSnapshot, signal?: AbortSignal) {
  const request = <T>(path: string, options: RequestOptions = {}) =>
    requestWithConfig<T>(path, { ...options, signal }, config)
  return {
    catalog: () => request<WorkflowEnvelope<WorkflowTask[]>>('/workflows/task-catalog'),
    list: (projectId: string) =>
      request<WorkflowEnvelope<Workflow[]>>('/workflows', { query: { project_id: projectExternalIdForServer(projectId)! } }),
    get: (id: number) => request<WorkflowEnvelope<Workflow>>(`/workflows/${id}`),
    revision: (id: number, version: number) =>
      request<WorkflowEnvelope<WorkflowRevision>>(`/workflows/${id}/revisions/${version}`),
    validate: (definition: WorkflowDefinition, projectId: string, workflowId?: number) =>
      request<WorkflowEnvelope<{ valid: boolean; definition: WorkflowDefinition }>>('/workflows/validate', {
        method: 'POST',
        body: { definition, project_id: projectExternalIdForServer(projectId), workflow_definition_id: workflowId },
      }),
    create: (body: WorkflowWrite) => request<WorkflowEnvelope<Workflow>>('/workflows', { method: 'POST', body: { ...body, project_id: projectExternalIdForServer(body.project_id) } }),
    update: (id: number, body: WorkflowWrite) =>
      request<WorkflowEnvelope<Workflow>>(`/workflows/${id}`, { method: 'PATCH', body: { ...body, project_id: projectExternalIdForServer(body.project_id) } }),
    operation: (id: string) =>
      request<WorkflowEnvelope<{ operation_id: string; status: string; response?: unknown }>>(
        `/workflow-operations/${encodeURIComponent(id)}`
      ),
    runs: (id: number) => request<WorkflowEnvelope<WorkflowRun[]>>(`/workflows/${id}/runs`),
    run: (id: string) => request<WorkflowEnvelope<WorkflowRun>>(`/workflow-runs/${encodeURIComponent(id)}`),
    start: (id: number, body: Record<string, unknown>) =>
      request<WorkflowEnvelope<WorkflowRun>>(`/workflows/${id}/runs`, { method: 'POST', body }),
    cancel: (id: string) =>
      request<WorkflowEnvelope<WorkflowRun>>(`/workflow-runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    stopAfterStep: (id: string, operationId: string) =>
      request<WorkflowEnvelope<WorkflowRun>>(`/workflow-runs/${encodeURIComponent(id)}/stop-after-step`, {
        method: 'POST',
        body: { operation_id: operationId },
      }),
    approve: (id: number) =>
      request<WorkflowEnvelope<WorkflowRun>>(`/workflow-steps/${id}/approve`, { method: 'POST' }),
    complete: (id: number, output: Record<string, unknown>) =>
      request<WorkflowEnvelope<WorkflowRun>>(`/workflow-steps/${id}/complete`, { method: 'POST', body: { output } }),
    triggers: (id: number) => request<WorkflowEnvelope<WorkflowTrigger[]>>(`/workflows/${id}/triggers`),
    saveTrigger: (id: number, body: Record<string, unknown>, triggerId?: number) =>
      request<WorkflowEnvelope<WorkflowTrigger>>(
        triggerId ? `/workflow-triggers/${triggerId}` : `/workflows/${id}/triggers`,
        { method: triggerId ? 'PATCH' : 'POST', body }
      ),
    deleteTrigger: (id: number) => request<WorkflowEnvelope<unknown>>(`/workflow-triggers/${id}`, { method: 'DELETE' }),
    automation: (id: number) =>
      request<WorkflowEnvelope<{ grant: Record<string, unknown> | null }>>(`/workflows/${id}/automation`),
    sources: (projectId: string) =>
      request<
        WorkflowEnvelope<{
          repositories: Array<{ id: number; full_name: string }>
          tasks: Array<{ id: number; title: string }>
          workflows: Array<{ id: number; name: string }>
        }>
      >('/workflow-trigger-sources', { query: { project_id: projectExternalIdForServer(projectId)! } }),
    deliveries: (id: number) =>
      request<
        WorkflowEnvelope<
          Array<{ id: number; status: string; last_error?: string | null; error?: string | null; created_at?: string }>
        >
      >(`/workflow-triggers/${id}/deliveries`),
    retryDelivery: (id: number) =>
      request<WorkflowEnvelope<unknown>>(`/workflow-trigger-deliveries/${id}/retry`, { method: 'POST' }),
  }
}
export type WorkflowApi = ReturnType<typeof createWorkflowApi>

/** Explicit UI stop, bound to an owned run and recovered before repeating an uncertain POST. */
export async function stopWorkflowAfterStep(
  projectId: string,
  workflowId: number,
  runId: string,
  signal?: AbortSignal
) {
  const { captureWorkflowAccess } = await import('./access')
  const { workflowOperations, WorkflowOperationUncertain } = await import('./operations')
  const access = await captureWorkflowAccess({ projectId, signal }, undefined, true)
  await access.workflow(workflowId)
  const requested = (await access.api.run(runId)).data
  await access.check()
  if (requested.workflow_definition_id !== workflowId)
    throw new Error('Der angeforderte Lauf gehört zu einem anderen Workflow.')
  const rootId: unknown = Reflect.get(requested, 'root_workflow_run_id')
  const validate = (result: WorkflowRun) => {
    if (!Number.isSafeInteger(result?.id) || result.id < 1 || (result.id !== requested.id && result.id !== rootId))
      throw new Error('Die Stoppantwort gehört zu einem anderen Auftrag.')
    return result
  }
  return workflowOperations.run<WorkflowRun>({
    scope: {
      principal: access.principalId,
      config: access.config,
      workflowId,
      runId: requested.public_id,
      action: 'stop_after_step',
    },
    args: { workflowId, runId: requested.public_id },
    assertCurrent: access.check,
    async verify(operationId) {
      const response = await access.api.operation(operationId)
      if (response.data.status === 'not_found') return null
      if (response.data.status !== 'completed' || !response.data.response)
        throw new WorkflowOperationUncertain(operationId)
      return validate(response.data.response as WorkflowRun)
    },
    async execute(operationId) {
      await access.check()
      const response = await access.api.stopAfterStep(requested.public_id, operationId)
      await access.check()
      return validate(response.data)
    },
  })
}
