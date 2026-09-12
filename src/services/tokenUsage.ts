import type { InferenceRequest, InferenceResult, InferenceTokenUsage } from './inference/types'
import { readLocalFailureDiagnostic } from './inference/localFailure'

/** Per user turn, including every model/tool round. Live estimates are explicit. */
export type TokenUsage = InferenceTokenUsage & {
  source: 'reported' | 'estimated' | 'mixed'
  rounds: number
  contextTokens?: number
}

export function readReportedTokenUsage(value: unknown): InferenceTokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const inputTokens = record.prompt_tokens ?? record.inputTokens
  const outputTokens = record.completion_tokens ?? record.outputTokens
  if (
    typeof inputTokens !== 'number' ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== 'number' ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    !Number.isSafeInteger(inputTokens + outputTokens)
  )
    return undefined
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

const estimate = (text: string) => Math.ceil(text.length / 4)

/** Replace each round's provisional counts, never add repeated cumulative deltas. */
export function createTokenUsageCounter() {
  const rounds = new Map<number, TokenUsage>()
  const estimatedInputs = new Map<number, number>()
  const measuredInputs = new Map<number, number>()
  const measuredContexts = new Map<number, number>()
  const count = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  function update(
    round: number,
    request: Pick<InferenceRequest, 'messages' | 'tools'>,
    content: string,
    result?: Pick<InferenceResult, 'usage' | 'contextUsage' | 'rawToolCalls'>
  ): TokenUsage {
    const reported = readReportedTokenUsage(result?.usage)
    if (count(result?.contextUsage?.inputTokens)) measuredInputs.set(round, result.contextUsage.inputTokens)
    if (count(result?.contextUsage?.contextTokens)) measuredContexts.set(round, result.contextUsage.contextTokens)
    const measuredInput = measuredInputs.get(round)
    // The prompt is fixed during a model round. Avoid serializing a long chat
    // again for every output character/token.
    if (!estimatedInputs.has(round)) estimatedInputs.set(round, estimate(JSON.stringify(request)))
    const inputTokens = reported?.inputTokens ?? measuredInput ?? estimatedInputs.get(round)!
    const outputTokens =
      reported?.outputTokens ??
      estimate(content + (result?.rawToolCalls?.length ? JSON.stringify(result.rawToolCalls) : ''))
    rounds.set(round, {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      source: reported ? 'reported' : measuredInput === undefined ? 'estimated' : 'mixed',
      rounds: 1,
      contextTokens: measuredContexts.get(round),
    })
    return snapshot()
  }
  /** A failed native request may still have counted its actual prompt. Its outputTokens field is only a limit. */
  function recordLocalFailure(round: number, diagnostic: unknown): TokenUsage {
    const failure = readLocalFailureDiagnostic(diagnostic)
    const previous = rounds.get(round)
    if (!failure || !previous || previous.source === 'reported') return snapshot()
    if (failure.inputTokens !== undefined && Number.isSafeInteger(failure.inputTokens + previous.outputTokens))
      measuredInputs.set(round, failure.inputTokens)
    if (failure.contextTokens !== undefined) measuredContexts.set(round, failure.contextTokens)
    const measuredInput = measuredInputs.get(round)
    const inputTokens = measuredInput ?? previous.inputTokens
    rounds.set(round, {
      ...previous,
      inputTokens,
      totalTokens: inputTokens + previous.outputTokens,
      source: measuredInput === undefined ? previous.source : 'mixed',
      contextTokens: measuredContexts.get(round) ?? previous.contextTokens,
    })
    return snapshot()
  }
  function snapshot(): TokenUsage {
    const values = [...rounds.values()]
    const inputTokens = values.reduce((sum, item) => sum + item.inputTokens, 0)
    const outputTokens = values.reduce((sum, item) => sum + item.outputTokens, 0)
    const sources = new Set(values.map(item => item.source))
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      rounds: values.length,
      source: sources.size === 1 ? values[0]!.source : values.length ? 'mixed' : 'estimated',
      contextTokens: values.at(-1)?.contextTokens,
    }
  }
  return { update, recordLocalFailure, snapshot }
}
