import { getApiConfigSnapshot } from '@/services/api/luczorApi'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { executionGate } from '@/services/executionGate'
import { resolveWorkspacePrincipalId } from '@/services/projectWorkspace'
import { state } from '@/state/store'
import type { ToolContext } from '@/services/tools/types'
import { createWorkflowApi } from './api'
import { projectExternalIdForServer } from '@/services/cloudProjectAccess'
import type { Workflow } from './types'

export async function captureWorkflowAccess(ctx: ToolContext, requestedProjectId: unknown, mutating: boolean) {
  const execution = ctx.execution ?? executionGate.capture(ctx.signal)
  const projectId = typeof requestedProjectId === 'string' && requestedProjectId ? requestedProjectId : ctx.projectId
  const scope = ctx.workspaceScope
    ? { principalId: ctx.workspaceScope.principalId, ids: [...ctx.workspaceScope.projectIds] }
    : undefined
  const assert = () => {
    executionGate.assert(execution, mutating)
    ctx.signal?.throwIfAborted()
    if (!projectId || !state.projects.some(project => project.id === projectId && !project.archivedAt))
      throw new Error('Ein verfügbares Zielprojekt ist erforderlich.')
    if (scope) {
      if (!requestedProjectId || ctx.inferenceTarget !== 'local' || !scope.ids.includes(projectId))
        throw new Error('Das Workflow-Zielprojekt muss ausdrücklich zum freigegebenen Arbeitsbereich gehören.')
    } else if (projectId !== ctx.projectId) throw new Error('Workflow-Aufträge sind an das aktuelle Projekt gebunden.')
  }
  assert()
  const identity = await getVerifiedAccountSnapshot()
  assert()
  if (!identity) throw new Error('Für Workflows ist eine verifizierte Serververbindung erforderlich.')
  const config = identity.config
  const check = async () => {
    assert()
    const current = await getApiConfigSnapshot()
    assert()
    if (
      current.baseUrl !== config.baseUrl ||
      current.deviceKey !== config.deviceKey ||
      current.clientId !== config.clientId
    )
      throw new Error('Die Workflow-Kontoverbindung wurde geändert.')
    if (scope && (await resolveWorkspacePrincipalId()) !== scope.principalId)
      throw new Error('Das Workflow-Konto wurde geändert.')
    assert()
  }
  await check()
  const api = createWorkflowApi(config, execution.signal)
  const workflow = async (id: number): Promise<Workflow> => {
    const response = await api.get(id)
    await check()
    if (response.data.project_external_id !== projectExternalIdForServer(projectId, identity.principalId))
      throw new Error('Der Workflow gehört zu einem anderen Projekt.')
    return response.data
  }
  return { projectId, principalId: identity.principalId, config, api, execution, check, workflow }
}
