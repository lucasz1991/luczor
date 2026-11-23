import { shallowRef } from 'vue'
import { isThinkingTier, THINKING_TIERS, type ThinkingTier } from './thinking'

/** One Claude model the server offers in the composer. The server owns label, order and visibility. */
export type ClaudeModelOption = Readonly<{
  id: string
  label: string
  description: string
  /** Thinking tiers this model accepts; an unsupported choice falls to the next lower one. */
  efforts: readonly ThinkingTier[]
}>

export type ClaudeKeySource = 'user' | 'organization'

/** Server policy from `bootstrap.routing.main_model`. Absent on older servers: Claude modes stay locked. */
export type ClaudeMainPolicy = Readonly<{
  allowed: boolean
  keySources: readonly ClaudeKeySource[]
  defaultModel: string | null
  models: readonly ClaudeModelOption[]
}>

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const NO_CLAUDE_POLICY: ClaudeMainPolicy = Object.freeze({
  allowed: false,
  keySources: Object.freeze([]),
  defaultModel: null,
  models: Object.freeze([]),
})

const MODEL_ID = /^[a-zA-Z0-9._-]{1,160}$/
const MAX_MODELS = 24

const EFFORT_BY_TIER: Readonly<Record<ThinkingTier, ClaudeEffort>> = Object.freeze({
  fast: 'low',
  balanced: 'medium',
  thorough: 'high',
  max: 'xhigh',
  ultra: 'max',
})

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

/** Fail-closed parse of the untrusted bootstrap block; malformed entries are dropped, never guessed. */
export function parseClaudeMainPolicy(value: unknown): ClaudeMainPolicy {
  if (!value || typeof value !== 'object') return NO_CLAUDE_POLICY
  const raw = value as Record<string, unknown>
  const models: ClaudeModelOption[] = []
  for (const entry of Array.isArray(raw.models) ? raw.models.slice(0, MAX_MODELS) : []) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const id = text(item.id, 160)
    if (!MODEL_ID.test(id) || models.some(model => model.id === id)) continue
    const efforts = (Array.isArray(item.efforts) ? item.efforts : []).filter(isThinkingTier)
    models.push(
      Object.freeze({
        id,
        label: text(item.label, 80) || id,
        description: text(item.description, 160),
        efforts: Object.freeze(
          efforts.length ? THINKING_TIERS.filter(tier => efforts.includes(tier)) : [...THINKING_TIERS]
        ),
      })
    )
  }
  const keySources = (Array.isArray(raw.key_sources) ? raw.key_sources : []).filter(
    (source): source is ClaudeKeySource => source === 'user' || source === 'organization'
  )
  const requestedDefault = text(raw.default_model, 160)
  return Object.freeze({
    allowed: raw.claude_modes_allowed === true && models.length > 0,
    keySources: Object.freeze([...new Set(keySources)]),
    defaultModel: models.some(model => model.id === requestedDefault) ? requestedDefault : (models[0]?.id ?? null),
    models: Object.freeze(models),
  })
}

export const claudeMainPolicy = shallowRef<ClaudeMainPolicy>(NO_CLAUDE_POLICY)

/** Called with every verified bootstrap; a missing block locks the Claude modes again. */
export function applyClaudeMainPolicy(bootstrap: { routing?: unknown } | null | undefined): void {
  const routing = bootstrap?.routing
  claudeMainPolicy.value = parseClaudeMainPolicy(
    routing && typeof routing === 'object' ? (routing as Record<string, unknown>).main_model : undefined
  )
}

/** Chat choice, then the last composer choice, then the server default. Unknown ids never reach the proxy. */
export function resolveClaudeModel(
  chatModel: string | undefined,
  lastModel: string | null | undefined,
  policy: ClaudeMainPolicy = claudeMainPolicy.value
): ClaudeModelOption | null {
  const byId = (id: string | null | undefined) => (id ? policy.models.find(model => model.id === id) : undefined)
  return byId(chatModel) ?? byId(lastModel) ?? byId(policy.defaultModel) ?? policy.models[0] ?? null
}

/** The chosen tier, lowered to the nearest one the model supports. */
export function supportedThinkingTier(model: Pick<ClaudeModelOption, 'efforts'>, tier: ThinkingTier): ThinkingTier {
  if (model.efforts.includes(tier)) return tier
  const index = THINKING_TIERS.indexOf(tier)
  for (let lower = index - 1; lower >= 0; lower--) {
    const candidate = THINKING_TIERS.at(lower)
    if (candidate && model.efforts.includes(candidate)) return candidate
  }
  return model.efforts[0] ?? 'balanced'
}

export function claudeEffortForTier(tier: ThinkingTier): ClaudeEffort {
  // `tier` is a member of the closed THINKING_TIERS union.
  // eslint-disable-next-line security/detect-object-injection
  return EFFORT_BY_TIER[tier]
}
