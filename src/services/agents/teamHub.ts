import { shallowRef } from 'vue'
import { onExecutionInvalidated } from '@/services/executionGate'
import { agentHub, prepareAgentJob, validateAgentScope } from './hub'
import { executePreparedAgentJob } from './managedJob'
import { AgentTeamOrchestrator, type AgentTeamDefinition, type AgentTeamRun, type AgentTeamRunInput } from './teams'

export const agentTeamsRevision = shallowRef(0)
const principals = new Set<string>()

export const agentTeams = new AgentTeamOrchestrator({
  maxConcurrent: 2,
  validateScope: validateAgentScope,
  async executor(request) {
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
})

export function prepareAgentTeam(definition: AgentTeamDefinition, input: AgentTeamRunInput): AgentTeamRun {
  const run = agentTeams.prepare(definition, input)
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
