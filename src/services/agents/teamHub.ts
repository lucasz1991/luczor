import { shallowRef } from 'vue'
import { localResources, type LocalResourceWork } from '@/services/inference/resources'
import { onExecutionInvalidated } from '@/services/executionGate'
import { agentHub, prepareAgentJob, validateAgentScope } from './hub'
import { executePreparedAgentJob } from './managedJob'
import { AgentTeamOrchestrator, type AgentTeamDefinition, type AgentTeamRun, type AgentTeamRunInput } from './teams'
import type { AgentTeamExecutor } from './teams'

export const agentTeamsRevision = shallowRef(0)
const principals = new Set<string>()
const chatExecutors = new Map<string, AgentTeamExecutor>()
const resourceParents = new Map<string, LocalResourceWork>()

export const agentTeams = new AgentTeamOrchestrator({
  maxConcurrent: 2,
  async acquireResources(runId, signal) {
    const lease = await localResources.acquireGroup(`team:${runId}`, signal, resourceParents.get(runId))
    return lease.release
  },
  validateScope: validateAgentScope,
  async executor(request) {
    if (request.adapterId === 'chat' || request.adapterId === 'external_chat') {
      const execute = chatExecutors.get(request.runId)
      if (!execute) throw new Error('Die Chatsitzung des Agententeams ist nicht mehr verfügbar.')
      return execute(request)
    }
    const job = await prepareAgentJob({
      projectId: request.project.projectId,
      adapterId: request.adapterId,
      prompt: request.prompt,
      promptAssembly: request.promptAssembly,
      role: request.role,
      permission: request.permission,
      model: request.model,
      includeMemory: request.includeMemory,
      resume: request.resume,
      teamRunId: request.runId,
      teamNodeId: request.nodeId,
      expectedProject: request.project,
    })
    try {
      request.onPreparedPrompt(agentHub.getPrompt(job.id).length)
    } catch (error) {
      agentHub.cancel(job.id)
      throw error
    }
    return executePreparedAgentJob(job.id, request.signal, {
      onPhase: request.onPhase,
      onOutput: request.onOutput,
    })
  },
})

agentTeams.subscribe(() => {
  agentTeamsRevision.value++
  for (const runId of resourceParents.keys()) {
    const run = agentTeams.getRun(runId)
    if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) resourceParents.delete(runId)
  }
  for (const runId of chatExecutors.keys()) {
    const run = agentTeams.getRun(runId)
    if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) chatExecutors.delete(runId)
  }
})

/** Only the trusted chat controller supplies this ephemeral executor, never model tools. */
export function prepareChatAgentTeam(
  definition: AgentTeamDefinition,
  input: AgentTeamRunInput,
  executor: AgentTeamExecutor
): AgentTeamRun {
  if (definition.nodes.some(node => !['chat', 'external_chat'].includes(node.adapterId)))
    throw new Error('Ungültiges Chat-Agententeam.')
  const run = prepareAgentTeam(definition, input)
  chatExecutors.set(run.id, executor)
  return run
}

export function prepareAgentTeam(definition: AgentTeamDefinition, input: AgentTeamRunInput): AgentTeamRun {
  const run = agentTeams.prepare(definition, input)
  if (input.resourceWork) resourceParents.set(run.id, input.resourceWork)
  principals.add(run.project.principalId)
  return run
}

function cancelLiveTeams(): void {
  for (const principal of principals) {
    for (const run of agentTeams.listRuns(principal)) {
      if (!['completed', 'failed', 'cancelled'].includes(run.status)) agentTeams.cancelRun(run.id)
    }
  }
}

onExecutionInvalidated(cancelLiveTeams)

if (typeof window !== 'undefined') {
  window.addEventListener('luczor:api-identity-changing', () => {
    for (const principal of principals) agentTeams.clearPrincipal(principal)
    principals.clear()
  })
}
