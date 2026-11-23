import { runAgent, type RunAgentOptions, type RunAgentResult } from '@/services/agent'
import { createClaudeMainGateway, ProviderRefusalError } from '@/services/inference/claudeGateway'
import type { ClaudeEffort } from '@/services/inference/claudeMain'
import { claudeDisabledToolNames } from '@/services/inference/claudeToolPolicy'
import type { ClaudeRouteMode } from '@/services/inference/modelUsageSettings'
import type { ApprovedProxyConfig, InferenceGateway, WireMessage } from '@/services/inference/types'
import { listTools } from '@/services/tools/registry'
import { createTokenUsageCounter } from '@/services/tokenUsage'

/** A Claude-led turn may run this long across all of its model/tool rounds. */
export const CLAUDE_TURN_TTL_MS = 30 * 60_000

export type ClaudeTurnPlan = Readonly<{
  mode: ClaudeRouteMode
  modelProfile: string
  effort: ClaudeEffort
}>

/** What happened to a turn the provider declined. `undefined` means Claude answered normally. */
export type ClaudeTurnHandoff = Readonly<{
  /** `taken`: the local model answered. `offered`: nothing was answered, the user decides. */
  state: 'taken' | 'offered'
  category?: string
  /** A local hand-over was attempted and failed; shown with the offer. */
  localFailure?: string
}>

export type ClaudeTurnInput = {
  /** Complete options of the equivalent local-only turn; reused unchanged for a hand-over. */
  local: RunAgentOptions
  /** Provider-safe transcript assembled independently from local-only context. */
  externalBaseMessages: WireMessage[]
  plan: ClaudeTurnPlan
  apiConfig: ApprovedProxyConfig
  /** A signed local model is admissible for a chat turn right now. */
  localAvailable: () => boolean
  /** Runs once before a local hand-over: discard Claude's partial output, mark the turn local. */
  onLocalTakeover?: (category: string | undefined) => void | Promise<void>
  now?: () => number
  /** Test seams. */
  run?: (options: RunAgentOptions) => Promise<RunAgentResult>
  transport?: Pick<InferenceGateway, 'streamChatWithTools'>
}

function unansweredResult(): RunAgentResult {
  return {
    finalText: '',
    toolFailures: 0,
    toolSuccesses: 0,
    ephemeralDataUsed: false,
    inferenceTarget: 'laravel_proxy',
    useCase: 'main-claude',
    tokenUsage: createTokenUsageCounter().snapshot(),
  }
}

/** Options of the Claude-led run: provider-safe transcript, shareable tools only, no local evidence. */
export function claudeRunOptions(input: ClaudeTurnInput, gateway: InferenceGateway): RunAgentOptions {
  const { local } = input
  return {
    ...local,
    inferenceGateway: gateway,
    baseMessages: input.externalBaseMessages,
    // The delegation tools start local children on the active gateway; a Claude-led turn has none.
    agentMode: false,
    disabledTools: [...new Set([...(local.disabledTools ?? []), ...claudeDisabledToolNames(listTools())])],
    // Archived runs, device-local history and private context never join a provider packet.
    archivedHistory: undefined,
    ephemeralContextUsed: false,
    localOnlyContextUsed: false,
    contextDataPolicy: 'syncable',
    contextEgress: 'external_allowed',
    continuation: undefined,
    continuationContext: undefined,
    goalTracking: undefined,
    externalPackage: undefined,
    externalBaseMessages: undefined,
    requestExternalApproval: undefined,
    // The provider rejects a forced tool choice.
    toolChoice: local.toolChoice === 'none' ? 'none' : 'auto',
  }
}

/**
 * Run one user turn with Claude as the main model.
 *
 * The provider signals a declined round explicitly. Only that signal — never the wording of an
 * answer — moves a turn to the local model, and only in the `claude_local` mode. Once Claude has
 * already executed tools the turn is not restarted: the agent loop returns its saved checkpoint
 * and the user continues it deliberately, which runs locally and repeats no completed change.
 */
export async function runClaudeLedTurn(
  input: ClaudeTurnInput
): Promise<{ result: RunAgentResult; handoff?: ClaudeTurnHandoff }> {
  const run = input.run ?? runAgent
  const now = input.now ?? Date.now
  const maxRounds = input.local.maxRounds ?? 12
  const gateway = createClaudeMainGateway({
    apiConfig: input.apiConfig,
    modelProfile: input.plan.modelProfile,
    effort: input.plan.effort,
    maxRequests: maxRounds * 2 + 8,
    expiresAt: now() + CLAUDE_TURN_TTL_MS,
    now,
    transport: input.transport,
  })

  let category: string | undefined
  try {
    const result = await run(claudeRunOptions(input, gateway))
    if (result.interrupted?.code !== 'provider_refusal') return { result }
    // Tools already ran. Keep the checkpoint; "Weiterarbeiten" resumes on the local model.
    return {
      result: {
        ...result,
        finalText:
          'Claude hat diesen Auftrag nach bereits ausgeführten Arbeitsschritten nicht weiter bearbeitet. ' +
          'Der Arbeitsstand ist gesichert. „Weiterarbeiten“ setzt den Auftrag mit dem lokalen Modell fort; ' +
          'bereits erfolgreiche Änderungen werden dabei nicht wiederholt.',
      },
    }
  } catch (error) {
    if (!(error instanceof ProviderRefusalError)) throw error
    category = error.category
  }

  if (input.plan.mode !== 'claude_local' || !input.localAvailable()) {
    return { result: unansweredResult(), handoff: { state: 'offered', ...(category ? { category } : {}) } }
  }
  await input.onLocalTakeover?.(category)
  try {
    const result = await run({
      ...input.local,
      contextEgress: 'local_only',
      routingSettings: { ...input.local.routingSettings, preference: 'local_only' },
      externalPackage: undefined,
    })
    return { result, handoff: { state: 'taken', ...(category ? { category } : {}) } }
  } catch (error) {
    if (input.local.signal?.aborted) throw error
    return {
      result: unansweredResult(),
      handoff: {
        state: 'offered',
        ...(category ? { category } : {}),
        localFailure: error instanceof Error ? error.message.slice(0, 400) : 'Das lokale Modell ist nicht bereit.',
      },
    }
  }
}
