import { state } from '@/state/store'
import { agentProjectSnapshot, prepareAgentJob } from './hub'
import { executePreparedAgentJob } from './managedJob'
import type { AgentExecutionOptions, AgentPermission, AgentRole, AgentRunResult } from './types'
import type { WorkflowArtifactScope } from '@/services/workflows/browser'
import { freezeAgentWorkflowScope } from './workflowScope'

export type WorkflowAgentResult = Readonly<{
  ok: boolean
  code: number
  stdout: string
  stderr: string
  effortSelection?: AgentRunResult['effortSelection']
  runtimeEvidence?: AgentRunResult['runtimeEvidence']
  externalThreadId?: string
  requestedModel?: string
  defaultModelRevision?: string
  defaultModelSource?: string
}>

function canonicalPath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '')
  return /^[a-z]:\//iu.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
}

/** Maps a signed workflow dispatch onto the same approved, scoped Codex job lifecycle as Agent Hub. */
export async function runWorkflowAgent(
  agent: string,
  prompt: string,
  projectDir?: string,
  signal?: AbortSignal,
  explicitProjectId?: string,
  options: AgentExecutionOptions & {
    model?: string
    role?: AgentRole
    permission?: AgentPermission
    workflowScope?: WorkflowArtifactScope
  } = {}
): Promise<WorkflowAgentResult> {
  const adapterId = agent.trim().toLowerCase()
  if (adapterId !== 'codex' && adapterId !== 'claude') {
    throw new Error('Dieser Workflow-Agent ist nicht als verwalteter Luczor-Agent verfügbar.')
  }
  if (!prompt.trim() || prompt.length > 24_000) throw new Error('Der Workflow-Agentenauftrag ist ungültig.')
  const projectId =
    explicitProjectId ?? state.global.ui?.lastProjectId ?? state.projects.find(project => !project.archivedAt)?.id
  const project = state.projects.find(item => item.id === projectId && !item.archivedAt)
  if (!project) throw new Error('Für den Workflow ist kein aktives Projekt verfügbar.')
  const snapshot = await agentProjectSnapshot(project.id)
  if (!snapshot.rootPath) throw new Error('Dem aktiven Projekt ist kein verfügbarer Projektordner zugeordnet.')
  const workflowScope = freezeAgentWorkflowScope(options.workflowScope, snapshot)
  if (projectDir && canonicalPath(projectDir) !== canonicalPath(workflowScope?.expectedRootPath ?? snapshot.rootPath)) {
    throw new Error('Der Workflow-Projektordner entspricht nicht dem aktiven Luczor-Projekt.')
  }
  const job = await prepareAgentJob({
    projectId: project.id,
    adapterId,
    prompt,
    ...options,
    workflowScope,
    role: options.role ?? 'implementer',
    permission: options.permission ?? 'workspace-write',
    includeMemory: false,
    memoryOrigin: 'workflow',
    expectedProject: snapshot,
    promptAssembly: 'exact-reviewed',
    assertExecution: () => signal?.throwIfAborted(),
  })
  try {
    const result = await executePreparedAgentJob(job.id, signal)
    return {
      ok: true,
      code: 0,
      stdout: result.output,
      stderr: '',
      ...(job.model ? { requestedModel: job.model } : {}),
      ...(job.defaultModelRevision
        ? { defaultModelRevision: job.defaultModelRevision, defaultModelSource: job.defaultModelSource }
        : {}),
      ...(result.effortSelection ? { effortSelection: result.effortSelection } : {}),
      ...(result.runtimeEvidence ? { runtimeEvidence: result.runtimeEvidence } : {}),
      ...(result.externalThreadId ? { externalThreadId: result.externalThreadId } : {}),
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
    return {
      ok: false,
      code: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'Agentenauftrag fehlgeschlagen.',
    }
  }
}
