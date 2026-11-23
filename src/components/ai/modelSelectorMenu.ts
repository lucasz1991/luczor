import { claudeEffortForTier, supportedThinkingTier, type ClaudeModelOption } from '@/services/inference/claudeMain'
import { THINKING_DEFAULTS, THINKING_TIERS, type ThinkingTier } from '@/services/inference/thinking'

/** Pure menu model of ModelSelector.vue: labels, option order and keyboard movement, testable without a DOM. */
export type ModelSelectorProvider = 'claude' | 'local' | 'external'

export type ModelSelectorEntry = Readonly<{
  /** Stable key, also the suffix of the option's DOM id. */
  key: string
  kind: 'model' | 'tier'
  value: string
  label: string
  detail: string
  selected: boolean
  disabled: boolean
}>

export type ModelSelectorState = Readonly<{
  thinkingTier: ThinkingTier
  claudeMode: boolean
  models: readonly ClaudeModelOption[]
  model?: string
  info?: string
  provider?: ModelSelectorProvider
  specialist?: boolean
}>

export type ModelSelectorMove = 'next' | 'previous' | 'first' | 'last'

const format = (value: number) => value.toLocaleString('de-DE')

/** Initial goal / thinking ceiling / response reserve — the same string ThinkingSelector shows. */
export function thinkingBudgetLabel(tier: ThinkingTier): string {
  // `tier` is a member of the closed THINKING_TIERS union.
  // eslint-disable-next-line security/detect-object-injection
  const defaults = THINKING_DEFAULTS[tier]
  return `${format(defaults.initialTokens)} / ${format(defaults.maxThinkingTokens)} / ${format(defaults.responseReserveTokens)}`
}

export function thinkingTierLabel(tier: ThinkingTier): string {
  // eslint-disable-next-line security/detect-object-injection
  return THINKING_DEFAULTS[tier].label
}

/** The chosen Claude model; an unknown id falls back to the first offered one instead of an empty control. */
export function selectedClaudeModel(state: ModelSelectorState): ClaudeModelOption | null {
  if (!state.claudeMode) return null
  return state.models.find(model => model.id === state.model) ?? state.models[0] ?? null
}

export function modelSelectorProvider(state: ModelSelectorState): ModelSelectorProvider {
  if (state.claudeMode) return 'claude'
  return state.provider === 'external' ? 'external' : state.provider === 'claude' ? 'claude' : 'local'
}

/** Tier the next turn really uses: a Claude model lowers an unsupported choice to the nearest supported one. */
export function effectiveThinkingTier(state: ModelSelectorState): ThinkingTier {
  const model = selectedClaudeModel(state)
  return model ? supportedThinkingTier(model, state.thinkingTier) : state.thinkingTier
}

export function modelSelectorLabel(state: ModelSelectorState): string {
  const model = selectedClaudeModel(state)
  const base = state.claudeMode
    ? (model?.label ?? 'Claude')
    : state.info?.trim() || (modelSelectorProvider(state) === 'external' ? 'Extern · Serverauswahl' : 'Lokales Modell')
  return state.specialist ? `${base} · Spezial-Agent` : base
}

export function modelSelectorHint(state: ModelSelectorState): string {
  if (state.claudeMode) return ''
  const provider = modelSelectorProvider(state)
  if (provider === 'local') return 'Lokales Modell in den Einstellungen ändern'
  return provider === 'external' ? 'Der Server wählt das Modell' : ''
}

export function modelSelectorTitle(state: ModelSelectorState, nextPrompt = false): string {
  return `Modell und Denktiefe: ${modelSelectorLabel(state)}, ${thinkingTierLabel(effectiveThinkingTier(state))}${
    nextPrompt ? ' · gilt für den nächsten Auftrag' : ''
  }`
}

/** Selectable rows in visual order: Claude models (Claude mode only), then the five tiers. */
export function modelSelectorEntries(state: ModelSelectorState): ModelSelectorEntry[] {
  const model = selectedClaudeModel(state)
  const tier = effectiveThinkingTier(state)
  const models: ModelSelectorEntry[] = state.claudeMode
    ? state.models.map((option, index) => ({
        key: `model-${index}`,
        kind: 'model' as const,
        value: option.id,
        label: option.label,
        detail: option.description,
        selected: option.id === model?.id,
        disabled: false,
      }))
    : []
  const tiers: ModelSelectorEntry[] = THINKING_TIERS.map(option => ({
    key: `tier-${option}`,
    kind: 'tier' as const,
    value: option,
    label: thinkingTierLabel(option),
    detail: state.claudeMode ? `effort ${claudeEffortForTier(option)}` : thinkingBudgetLabel(option),
    selected: option === tier,
    disabled: !!model && !model.efforts.includes(option),
  }))
  return [...models, ...tiers]
}

/** Where focus lands when the menu opens: the active tier, else the first usable row. */
export function initialEntryKey(entries: readonly ModelSelectorEntry[]): string | null {
  const usable = entries.filter(entry => !entry.disabled)
  return (usable.find(entry => entry.kind === 'tier' && entry.selected) ?? usable[0])?.key ?? null
}

/** Roving movement over enabled rows; arrows wrap around like the shared dropdown. */
export function moveEntryKey(
  entries: readonly ModelSelectorEntry[],
  current: string | null,
  move: ModelSelectorMove
): string | null {
  const usable = entries.filter(entry => !entry.disabled)
  if (!usable.length) return null
  if (move === 'first') return usable[0]?.key ?? null
  if (move === 'last') return usable.at(-1)?.key ?? null
  const index = usable.findIndex(entry => entry.key === current)
  if (index < 0) return (move === 'next' ? usable[0] : usable.at(-1))?.key ?? null
  const delta = move === 'next' ? 1 : -1
  return usable.at((index + delta + usable.length) % usable.length)?.key ?? null
}

/** Maps a key press inside the open menu to a movement; anything else is left to the browser. */
export function menuKeyMove(key: string): ModelSelectorMove | null {
  switch (key) {
    case 'ArrowDown':
      return 'next'
    case 'ArrowUp':
      return 'previous'
    case 'Home':
      return 'first'
    case 'End':
      return 'last'
    default:
      return null
  }
}
