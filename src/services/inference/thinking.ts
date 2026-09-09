/** Public budget metadata only. Private reasoning never crosses this contract. */
export const THINKING_TIERS = ['fast', 'balanced', 'thorough', 'max', 'ultra'] as const
export type ThinkingTier = (typeof THINKING_TIERS)[number]
export type ThinkingConfig = Readonly<{
  initialTokens?: number
  maxThinkingTokens?: number
  responseReserveTokens?: number
}>
export const MAX_GENERATION_TOKENS = 131_072
export const THINKING_DEFAULTS = Object.freeze({
  fast: Object.freeze({ label: 'Schnell', initialTokens: 512, maxThinkingTokens: 4_096, responseReserveTokens: 4_096 }),
  balanced: Object.freeze({
    label: 'Ausgewogen',
    initialTokens: 1_024,
    maxThinkingTokens: 8_192,
    responseReserveTokens: 4_096,
  }),
  thorough: Object.freeze({
    label: 'Gründlich',
    initialTokens: 2_048,
    maxThinkingTokens: 16_384,
    responseReserveTokens: 8_192,
  }),
  max: Object.freeze({
    label: 'Maximal',
    initialTokens: 4_096,
    maxThinkingTokens: 32_768,
    responseReserveTokens: 8_192,
  }),
  ultra: Object.freeze({
    label: 'Ultra',
    initialTokens: 8_192,
    maxThinkingTokens: 65_536,
    responseReserveTokens: 16_384,
  }),
})
export function isThinkingTier(value: unknown): value is ThinkingTier {
  return typeof value === 'string' && THINKING_TIERS.some(tier => tier === value)
}
export function resolveThinkingConfig(tier: ThinkingTier = 'balanced', overrides?: ThinkingConfig) {
  const defaults = THINKING_DEFAULTS[tier]
  const config = {
    initialTokens: overrides?.initialTokens ?? defaults.initialTokens,
    maxThinkingTokens: overrides?.maxThinkingTokens ?? defaults.maxThinkingTokens,
    responseReserveTokens: overrides?.responseReserveTokens ?? defaults.responseReserveTokens,
  }
  for (const value of Object.values(config)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GENERATION_TOKENS)
      throw new Error('Denkbudget: Bitte ganze Tokenwerte zwischen 1 und 131.072 eingeben.')
  }
  if (
    config.maxThinkingTokens > 65_536 ||
    config.responseReserveTokens < 256 ||
    config.initialTokens > config.maxThinkingTokens ||
    config.maxThinkingTokens + config.responseReserveTokens > MAX_GENERATION_TOKENS
  )
    throw new Error(
      'Das Anfangsziel darf die Denkgrenze nicht überschreiten. Mindestens 256 Antworttokens und höchstens 131.072 Gesamttokens sind zulässig.'
    )
  return Object.freeze(config)
}
export type ThinkingControlAction = 'more' | 'answer'
export type ThinkingBudgetProgress = {
  requestId: string
  tier: ThinkingTier
  phase: 'preparing' | 'thinking' | 'answering' | 'unknown'
  generatedTokens: number | null
  softTargetTokens: number
  thinkingLimitTokens: number
  requestedThinkingLimitTokens: number
  outputLimitTokens: number
  responseReserveTokens: number
  warning: boolean
  canExtend: boolean
  canAnswer: boolean
  answerRequested: boolean
  elapsedMs: number
  sequence: number
  controlOutcome?: 'applied' | 'stale' | 'unavailable' | 'not_thinking'
}
/** Explicit projection: never relay unknown native fields into UI snapshots or logs. */
export function readThinkingProgress(value: unknown): ThinkingBudgetProgress | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (
    typeof v.requestId !== 'string' ||
    !v.requestId ||
    v.requestId.length > 160 ||
    !isThinkingTier(v.tier) ||
    !['preparing', 'thinking', 'answering', 'unknown'].includes(String(v.phase))
  )
    return null
  const numbers = [
    'softTargetTokens',
    'thinkingLimitTokens',
    'requestedThinkingLimitTokens',
    'outputLimitTokens',
    'responseReserveTokens',
    'elapsedMs',
    'sequence',
  ] as const
  if (numbers.some(key => !Number.isSafeInteger(v[key]) || (v[key] as number) < 0)) return null
  if (v.generatedTokens !== null && (!Number.isSafeInteger(v.generatedTokens) || (v.generatedTokens as number) < 0))
    return null
  const booleans = ['warning', 'canExtend', 'canAnswer', 'answerRequested'] as const
  if (booleans.some(key => typeof v[key] !== 'boolean')) return null
  return {
    requestId: v.requestId,
    tier: v.tier,
    phase: v.phase as ThinkingBudgetProgress['phase'],
    generatedTokens: v.generatedTokens as number | null,
    ...(Object.fromEntries(numbers.map(key => [key, v[key]])) as Pick<
      ThinkingBudgetProgress,
      (typeof numbers)[number]
    >),
    ...(Object.fromEntries(booleans.map(key => [key, v[key]])) as Pick<
      ThinkingBudgetProgress,
      (typeof booleans)[number]
    >),
    ...(['applied', 'stale', 'unavailable', 'not_thinking'].includes(String(v.controlOutcome))
      ? { controlOutcome: v.controlOutcome as ThinkingBudgetProgress['controlOutcome'] }
      : {}),
  }
}
