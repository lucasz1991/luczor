import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import { unresolvedCheckpointCalls } from '@/services/agents/continuationHistory'

const PROBES = new Set(['research_search', 'research_read', 'research_download', 'research_read_document'])
const HOST_READS = new Set([
  'research_read_evidence',
  'research_submit_plan',
  'research_submit_claims',
  'research_submit_review',
  'research_request_clarification',
])
/** These host adapters verify their input snapshots/bytes and write only inside the native research grant. */
export const isResearchProbe = (name: string): boolean => PROBES.has(name)

export function researchProbeMutationKey(key: string): boolean {
  try {
    const parsed: unknown = JSON.parse(key)
    return (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      isResearchProbe(parsed[0]) &&
      !!parsed[1] &&
      typeof parsed[1] === 'object' &&
      !Array.isArray(parsed[1])
    )
  } catch {
    return false
  }
}

/** Unknown general browser inputs/terminal effects are never treated as repeatable research reads. */
export function researchOnlyUncertainty(checkpoint?: AgentCheckpoint): boolean {
  if (!checkpoint || checkpoint.pendingTaskCreateVerifications?.some(item => item.state !== 'verified_present'))
    return false
  const uncertain = checkpoint.uncertainMutations ?? []
  const unresolved = unresolvedCheckpointCalls(checkpoint.messages)
  return (
    uncertain.length + unresolved.length > 0 &&
    uncertain.every(researchProbeMutationKey) &&
    unresolved.every(call => isResearchProbe(call.function.name) || HOST_READS.has(call.function.name))
  )
}
