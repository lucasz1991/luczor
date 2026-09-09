import { invoke } from '@tauri-apps/api/core'
import { requestWithConfig, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import type { WorkflowArtifactScope } from './browser'
import { isTerminalWorkflow } from './types'

type Resource = { scope: WorkflowArtifactScope; config: LuczorApiConfigSnapshot }
const resources = new Map<string, Resource>()
const key = (scope: WorkflowArtifactScope) => `${scope.principalId}:${scope.projectId}:${scope.runId}`
const sameAccount = (a: LuczorApiConfigSnapshot, b: LuczorApiConfigSnapshot) =>
  a.baseUrl === b.baseUrl && a.clientId === b.clientId && a.deviceKey === b.deviceKey

/** Retain browser state between steps, release it only after the complete run or its owner ends. */
export function retainWorkflowResources(scope: WorkflowArtifactScope, config: LuczorApiConfigSnapshot) {
  resources.set(key(scope), { scope: Object.freeze({ ...scope }), config: Object.freeze({ ...config }) })
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
