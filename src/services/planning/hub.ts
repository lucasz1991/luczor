import { agentHub, agentProjectSnapshot, prepareAgentJob, validateAgentScope } from '@/services/agents/hub'
import { executePreparedAgentJob } from '@/services/agents/managedJob'
import { agentTeams, prepareAgentTeam } from '@/services/agents/teamHub'
import { executionGate, onExecutionInvalidated } from '@/services/executionGate'
import { createPlanningHub } from './controller'

export const planningHub = createPlanningHub({
  projectSnapshot: agentProjectSnapshot,
  validateScope: validateAgentScope,
  prepareAgentJob,
  cancelAgentJob: jobId => agentHub.cancel(jobId),
  executePreparedAgentJob,
  prepareAgentTeam,
  approveAgentTeam: runId => agentTeams.approveRun(runId),
  cancelAgentTeam: runId => agentTeams.cancelRun(runId),
  getAgentTeam: runId => agentTeams.getRun(runId),
  subscribeAgentTeams: listener => agentTeams.subscribe(listener),
  captureExecution: signal => executionGate.capture(signal),
  assertExecution: (ticket, mutating) => executionGate.assert(ticket, mutating),
})

onExecutionInvalidated(() => planningHub.interruptActive())

if (typeof window !== 'undefined') {
  window.addEventListener('luczor:api-identity-changing', () => planningHub.clearAll())
}
