import type { ThinkingTier } from '@/services/inference/thinking'
import type { AgentEffort, AgentEffortSelection, AgentRole } from './types'

export type AgentModelCapability = Readonly<{
  model: string
  supportedEfforts: readonly AgentEffort[]
  defaultEffort?: AgentEffort
}>
export type AgentCapabilityCatalog = Readonly<{
  revision: string
  source?: 'codex-cache' | 'sdk-documentation' | 'runtime'
  validForSeconds?: number
  models: readonly AgentModelCapability[]
}>
const TIERS: readonly ThinkingTier[] = ['fast', 'balanced', 'thorough', 'max', 'ultra']
const EFFORTS: readonly AgentEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export function validateAgentExecutionOptions(input: {
  thinkingTier?: ThinkingTier
  effort?: AgentEffort
  maxTurns?: number
  maxBudgetUsd?: number
}) {
  if (input.thinkingTier !== undefined && !TIERS.includes(input.thinkingTier)) throw new Error('Ungültige Denkstufe.')
  if (input.effort !== undefined && !EFFORTS.includes(input.effort)) throw new Error('Ungültiger Modellaufwand.')
  if (
    input.maxTurns !== undefined &&
    (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 200)
  )
    throw new Error('Agentenrunden müssen zwischen 1 und 200 liegen.')
  if (
    input.maxBudgetUsd !== undefined &&
    (!Number.isFinite(input.maxBudgetUsd) || input.maxBudgetUsd <= 0 || input.maxBudgetUsd > 100)
  )
    throw new Error('Ungültiges Agentenkostenlimit.')
}

/** Role escalation is deterministic; a caller's explicit effort always takes precedence. */
export function selectAgentEffort(input: {
  adapter: 'codex' | 'claude'
  tier?: ThinkingTier
  role?: AgentRole
  model?: string
  override?: AgentEffort
  catalog: AgentCapabilityCatalog
}): AgentEffortSelection {
  const tier = input.tier ?? 'balanced'
  validateAgentExecutionOptions({ thinkingTier: tier, effort: input.override })
  const capability = input.catalog.models.find(item => item.model === input.model)
  if (!capability || !capability.supportedEfforts.length) {
    if (input.override) throw new Error('Die gewählte Aufwandstufe ist für dieses Modell nicht bestätigt.')
    return Object.freeze({
      tier,
      model: input.model,
      status: 'unknown',
      reason: input.model ? 'model_capabilities_unknown' : 'default_model_unresolved',
      capabilityRevision: input.catalog.revision,
      capabilitySource: input.catalog.source,
    })
  }
  if (input.override && !capability.supportedEfforts.includes(input.override))
    throw new Error('Das gewählte Modell unterstützt diese Aufwandstufe nicht.')
  let index = TIERS.indexOf(tier)
  const escalated = !input.override && (input.role === 'planner' || input.role === 'reviewer') && index < 2
  if (escalated) index = 2
  const desired: AgentEffort =
    input.override ??
    (input.adapter === 'claude'
      ? (['low', 'medium', 'high', 'xhigh', 'max'] as const).at(index)!
      : (['low', 'medium', 'high', 'max', 'ultra'] as const).at(index)!)
  const supported = EFFORTS.filter(
    value => capability.supportedEfforts.includes(value) && EFFORTS.indexOf(value) <= EFFORTS.indexOf(desired)
  )
  const requestedEffort = input.override ?? supported.at(-1) ?? capability.defaultEffort
  if (!requestedEffort || !capability.supportedEfforts.includes(requestedEffort))
    return Object.freeze({
      tier,
      model: input.model,
      status: 'unknown',
      reason: 'supported_effort_unresolved',
      capabilityRevision: input.catalog.revision,
      capabilitySource: input.catalog.source,
    })
  return Object.freeze({
    tier,
    model: capability.model,
    requestedEffort,
    status: 'requested',
    capabilityRevision: input.catalog.revision,
    capabilitySource: input.catalog.source,
    reason: input.override
      ? 'node_override'
      : escalated
        ? 'role_requires_deeper_review'
        : requestedEffort !== desired
          ? 'model_effort_ceiling'
          : 'prompt_tier',
  })
}
