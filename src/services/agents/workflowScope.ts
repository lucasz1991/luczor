import type { WorkflowArtifactScope } from '@/services/workflows/browser'
import type { AgentProjectSnapshot } from './types'

/** These tools explicitly resolve native registered workcopies; other tools do not. */
export const WORKFLOW_WORKCOPY_TOOLS = new Set([
  'workspace_get',
  'fs_list',
  'fs_stat',
  'fs_read',
  'fs_search',
  'fs_write',
  'fs_create_dir',
  'fs_move',
  'fs_delete',
  'project_terminal_run',
])

/** This is a binding check; native code remains the workcopy registration authority. */
export function freezeAgentWorkflowScope(
  scope: WorkflowArtifactScope | undefined,
  project: AgentProjectSnapshot
): WorkflowArtifactScope | undefined {
  if (!scope) return undefined
  if (
    scope.principalId !== project.principalId ||
    scope.projectId !== project.projectId ||
    scope.expectedWorkspaceUpdatedAt !== project.workspaceUpdatedAt ||
    !Number.isSafeInteger(scope.expectedWorkspaceUpdatedAt) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(scope.runId) ||
    typeof scope.expectedRootPath !== 'string' ||
    !scope.expectedRootPath.trim() ||
    /[\u0000-\u001f]/u.test(scope.expectedRootPath)
  )
    throw new Error('Der eingefrorene Workflow-Arbeitsordner gehört nicht zu dieser Projektfreigabe.')
  return Object.freeze({
    principalId: scope.principalId,
    projectId: scope.projectId,
    runId: scope.runId,
    expectedRootPath: scope.expectedRootPath,
    expectedWorkspaceUpdatedAt: scope.expectedWorkspaceUpdatedAt,
  })
}
