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
  // `tier` is always a member of the closed THINKING_TIERS union validated by isThinkingTier at every boundary.
  // eslint-disable-next-line security/detect-object-injection
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
const PROGRESS_NUMBER_FIELDS = [
  'softTargetTokens',
  'thinkingLimitTokens',
  'requestedThinkingLimitTokens',
  'outputLimitTokens',
  'responseReserveTokens',
  'elapsedMs',
  'sequence',
] as const
const PROGRESS_BOOLEAN_FIELDS = ['warning', 'canExtend', 'canAnswer', 'answerRequested'] as const
/** `key` is always drawn from the closed, hardcoded field lists above — never an arbitrary property name. */
function readProgressField(
  record: Record<string, unknown>,
  key: (typeof PROGRESS_NUMBER_FIELDS)[number] | (typeof PROGRESS_BOOLEAN_FIELDS)[number]
): unknown {
  // eslint-disable-next-line security/detect-object-injection
  return record[key]
}
/** Explicit projection: never relay unknown native fields into UI snapshots or logs. */
export function readThinkingProgress(value: unknown): ThinkingBudgetProgress | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (
    typeof raw.requestId !== 'string' ||
    !raw.requestId ||
    raw.requestId.length > 160 ||
    !isThinkingTier(raw.tier) ||
    !['preparing', 'thinking', 'answering', 'unknown'].includes(String(raw.phase))
  )
    return null
  if (
    PROGRESS_NUMBER_FIELDS.some(
      key => !Number.isSafeInteger(readProgressField(raw, key)) || (readProgressField(raw, key) as number) < 0
    )
  )
    return null
  if (raw.generatedTokens !== null && (!Number.isSafeInteger(raw.generatedTokens) || (raw.generatedTokens as number) < 0))
    return null
  if (PROGRESS_BOOLEAN_FIELDS.some(key => typeof readProgressField(raw, key) !== 'boolean')) return null
  return {
    requestId: raw.requestId,
    tier: raw.tier,
    phase: raw.phase as ThinkingBudgetProgress['phase'],
    generatedTokens: raw.generatedTokens as number | null,
    ...(Object.fromEntries(PROGRESS_NUMBER_FIELDS.map(key => [key, readProgressField(raw, key)])) as Pick<
      ThinkingBudgetProgress,
      (typeof PROGRESS_NUMBER_FIELDS)[number]
    >),
    ...(Object.fromEntries(PROGRESS_BOOLEAN_FIELDS.map(key => [key, readProgressField(raw, key)])) as Pick<
      ThinkingBudgetProgress,
      (typeof PROGRESS_BOOLEAN_FIELDS)[number]
    >),
    ...(['applied', 'stale', 'unavailable', 'not_thinking'].includes(String(raw.controlOutcome))
      ? { controlOutcome: raw.controlOutcome as ThinkingBudgetProgress['controlOutcome'] }
      : {}),
  }
}
