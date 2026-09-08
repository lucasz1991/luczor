import { state } from '@/state/store'
import { agentProjectSnapshot, prepareAgentJob } from './hub'
import { executePreparedAgentJob } from './managedJob'

export type WorkflowAgentResult = Readonly<{ ok: boolean; code: number; stdout: string; stderr: string }>

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
  explicitProjectId?: string
): Promise<WorkflowAgentResult> {
  if (agent.trim().toLowerCase() !== 'codex') {
    throw new Error('Dieser Workflow-Agent ist nicht als verwalteter Luczor-Agent verfügbar.')
  }
  if (!prompt.trim() || prompt.length > 24_000) throw new Error('Der Workflow-Agentenauftrag ist ungültig.')
  const projectId = explicitProjectId ?? state.global.ui?.lastProjectId ?? state.projects.find(project => !project.archivedAt)?.id
  const project = state.projects.find(item => item.id === projectId && !item.archivedAt)
  if (!project) throw new Error('Für den Workflow ist kein aktives Projekt verfügbar.')
  const snapshot = await agentProjectSnapshot(project.id)
  if (!snapshot.rootPath) throw new Error('Dem aktiven Projekt ist kein verfügbarer Projektordner zugeordnet.')
  if (projectDir && canonicalPath(projectDir) !== canonicalPath(snapshot.rootPath)) {
    throw new Error('Der Workflow-Projektordner entspricht nicht dem aktiven Luczor-Projekt.')
  }
  const job = await prepareAgentJob({
    projectId: project.id,
    adapterId: 'codex',
    prompt,
    role: 'implementer',
    permission: 'workspace-write',
    includeMemory: false,
    expectedProject: snapshot,
    promptAssembly: 'exact-reviewed',
  })
  try {
    const result = await executePreparedAgentJob(job.id, signal)
    return { ok: true, code: 0, stdout: result.output, stderr: '' }
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
