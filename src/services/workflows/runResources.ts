import { invoke } from '@tauri-apps/api/core'
import { requestWithConfig, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import type { WorkflowArtifactScope } from './browser'
import { isTerminalWorkflow } from './types'
import { WORKFLOW_AUTOMATION_INVALIDATED, workflowAutomationRevision } from './automation'

type Authorization = { accountScope: string; definitionId: number; revision: number }
type Resource = { scope: WorkflowArtifactScope; config: LuczorApiConfigSnapshot; authorization?: Authorization }
const resources = new Map<string, Resource>()
const key = (scope: WorkflowArtifactScope) => `${scope.principalId}:${scope.projectId}:${scope.runId}`
const sameAccount = (left: LuczorApiConfigSnapshot, right: LuczorApiConfigSnapshot) =>
  left.baseUrl === right.baseUrl && left.clientId === right.clientId && left.deviceKey === right.deviceKey
const sameScope = (left: WorkflowArtifactScope, right: WorkflowArtifactScope) =>
  left.principalId === right.principalId &&
  left.projectId === right.projectId &&
  left.runId === right.runId &&
  left.expectedRootPath === right.expectedRootPath &&
  left.expectedWorkspaceUpdatedAt === right.expectedWorkspaceUpdatedAt
let listenerWindow: Window | undefined
function watchRevocation() {
  if (listenerWindow === window) return
  listenerWindow = window
  window.addEventListener(WORKFLOW_AUTOMATION_INVALIDATED, event => {
    const detail = (event as CustomEvent<{ scope?: string; definitionId?: number }>).detail
    for (const item of resources.values())
      if (
        item.authorization &&
        detail?.scope === item.authorization.accountScope &&
        detail.definitionId === item.authorization.definitionId
      )
        void releaseWorkflowResources(item.scope).catch(() => {})
  })
}

/** Retain browser state between steps, release it only after the complete run or its owner ends. */
export function retainWorkflowResources(
  scope: WorkflowArtifactScope,
  config: LuczorApiConfigSnapshot,
  authorization?: Authorization
) {
  const previous = resources.get(key(scope))
  if (
    previous &&
    (!sameScope(previous.scope, scope) ||
      !sameAccount(previous.config, config) ||
      JSON.stringify(previous.authorization) !== JSON.stringify(authorization))
  ) {
    void releaseWorkflowResources(previous.scope).catch(() => {})
    throw new Error('workflow_browser_scope_changed')
  }
  if (
    authorization &&
    workflowAutomationRevision(authorization.accountScope, authorization.definitionId) !== authorization.revision
  )
    throw new Error('workflow_automation_revoked')
  watchRevocation()
  if (!previous)
    resources.set(key(scope), {
      scope: Object.freeze({ ...scope }),
      config: Object.freeze({ ...config }),
      authorization: authorization ? Object.freeze({ ...authorization }) : undefined,
    })
}
export async function releaseWorkflowResources(scope: WorkflowArtifactScope) {
  const owned = resources.get(key(scope))
  if (!owned) return
  await invoke('wf_browser_cleanup', { payload: owned.scope })
  if (resources.get(key(scope)) === owned) resources.delete(key(scope))
}
export async function releaseWorkflowAccountResources(config: LuczorApiConfigSnapshot) {
  await Promise.allSettled(
    [...resources.values()]
      .filter(item => sameAccount(item.config, config))
      .map(item => releaseWorkflowResources(item.scope))
  )
}
/** Release only this renderer's retained local browser resources, not remote workflow state. */
export async function releaseAllWorkflowResources(): Promise<void> {
  const results = await Promise.allSettled([...resources.values()].map(item => releaseWorkflowResources(item.scope)))
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}
/** Native global cleanup already closed these sessions; discard stale renderer ownership. */
export function recoverWorkflowResourcesAfterStop(): void {
  resources.clear()
}
export async function sweepWorkflowResources(config: LuczorApiConfigSnapshot, signal: AbortSignal) {
  for (const item of [...resources.values()]) {
    if (signal.aborted || !sameAccount(item.config, config)) continue
    try {
      const result = await requestWithConfig<{ data: { status: string; public_id: string } }>(
        `/workflow-runs/${encodeURIComponent(item.scope.runId)}`,
        { signal },
        config
      )
      if (result.data.public_id === item.scope.runId && isTerminalWorkflow(result.data.status))
        await releaseWorkflowResources(item.scope)
    } catch {
      // A missing control-plane response is not proof of a terminal run. Account shutdown still releases its UI.
    }
  }
}
