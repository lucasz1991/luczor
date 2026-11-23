import { createSSRApp, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import ModelSelector from '@/components/ai/ModelSelector.vue'
import {
  effectiveThinkingTier,
  initialEntryKey,
  menuKeyMove,
  modelSelectorEntries,
  modelSelectorHint,
  modelSelectorLabel,
  modelSelectorTitle,
  moveEntryKey,
  thinkingBudgetLabel,
  type ModelSelectorState,
} from '@/components/ai/modelSelectorMenu'
import type { ClaudeModelOption } from '@/services/inference/claudeMain'
import { THINKING_TIERS } from '@/services/inference/thinking'

const MODELS: readonly ClaudeModelOption[] = [
  { id: 'model-large', label: 'Claude Groß', description: 'Leistungsstark', efforts: [...THINKING_TIERS] },
  { id: 'model-small', label: 'Claude Klein', description: 'Am schnellsten', efforts: ['fast', 'balanced'] },
]
const claude = (extra: Partial<ModelSelectorState> = {}): ModelSelectorState => ({
  thinkingTier: 'balanced',
  claudeMode: true,
  models: MODELS,
  model: 'model-large',
  ...extra,
})
const local = (extra: Partial<ModelSelectorState> = {}): ModelSelectorState => ({
  thinkingTier: 'balanced',
  claudeMode: false,
  models: [],
  info: 'Lokal 27B',
  provider: 'local',
  ...extra,
})
const render = (props: Record<string, unknown>) =>
  renderToString(createSSRApp({ render: () => h(ModelSelector, props) }))

describe('model and thinking selector: labels', () => {
  it('names the chosen Claude model and falls back to the first offered one for an unknown id', () => {
    expect(modelSelectorLabel(claude())).toBe('Claude Groß')
    expect(modelSelectorLabel(claude({ model: 'model-small' }))).toBe('Claude Klein')
    expect(modelSelectorLabel(claude({ model: 'gone' }))).toBe('Claude Groß')
    expect(modelSelectorLabel(claude({ models: [] }))).toBe('Claude')
  })

  it('shows the info text outside Claude mode and marks the local specialist', () => {
    expect(modelSelectorLabel(local())).toBe('Lokal 27B')
    expect(modelSelectorLabel(local({ specialist: true }))).toBe('Lokal 27B · Spezial-Agent')
    expect(modelSelectorLabel(local({ info: '', provider: 'external' }))).toBe('Extern · Serverauswahl')
    expect(modelSelectorHint(local())).toBe('Lokales Modell in den Einstellungen ändern')
    expect(modelSelectorHint(local({ provider: 'external' }))).toBe('Der Server wählt das Modell')
    expect(modelSelectorHint(claude())).toBe('')
  })

  it('builds the accessible title with the tier and the next-prompt note', () => {
    expect(modelSelectorTitle(claude())).toBe('Modell und Denktiefe: Claude Groß, Ausgewogen')
    expect(modelSelectorTitle(local({ thinkingTier: 'ultra' }), true)).toBe(
      'Modell und Denktiefe: Lokal 27B, Ultra · gilt für den nächsten Auftrag'
    )
  })
})

describe('model and thinking selector: tiers', () => {
  it('shows the Claude effort per tier in Claude mode and the token budget otherwise', () => {
    const tiers = (state: ModelSelectorState) =>
      modelSelectorEntries(state)
        .filter(entry => entry.kind === 'tier')
        .map(entry => entry.detail)
    expect(tiers(claude())).toEqual(['effort low', 'effort medium', 'effort high', 'effort xhigh', 'effort max'])
    expect(tiers(local())).toEqual(THINKING_TIERS.map(thinkingBudgetLabel))
    expect(thinkingBudgetLabel('balanced')).toBe('1.024 / 8.192 / 4.096')
  })

  it('disables tiers the chosen model does not accept and lowers the shown tier accordingly', () => {
    const state = claude({ model: 'model-small', thinkingTier: 'max' })
    const tiers = modelSelectorEntries(state).filter(entry => entry.kind === 'tier')
    expect(tiers.map(entry => entry.disabled)).toEqual([false, false, true, true, true])
    expect(effectiveThinkingTier(state)).toBe('balanced')
    expect(tiers.find(entry => entry.selected)?.value).toBe('balanced')
    expect(modelSelectorEntries(local({ thinkingTier: 'max' })).every(entry => !entry.disabled)).toBe(true)
  })

  it('lists selectable models only in Claude mode', () => {
    expect(
      modelSelectorEntries(claude())
        .filter(entry => entry.kind === 'model')
        .map(entry => [entry.value, entry.selected])
    ).toEqual([
      ['model-large', true],
      ['model-small', false],
    ])
    expect(modelSelectorEntries(local()).some(entry => entry.kind === 'model')).toBe(false)
  })
})

describe('model and thinking selector: keyboard', () => {
  it('maps arrow, Home and End keys and ignores everything else', () => {
    expect(['ArrowDown', 'ArrowUp', 'Home', 'End', 'a', 'Enter'].map(menuKeyMove)).toEqual([
      'next',
      'previous',
      'first',
      'last',
      null,
      null,
    ])
  })

  it('starts on the active tier and wraps over models and tiers', () => {
    const entries = modelSelectorEntries(claude())
    expect(initialEntryKey(entries)).toBe('tier-balanced')
    expect(moveEntryKey(entries, 'tier-balanced', 'previous')).toBe('tier-fast')
    expect(moveEntryKey(entries, 'tier-fast', 'previous')).toBe('model-1')
    expect(moveEntryKey(entries, 'tier-ultra', 'next')).toBe('model-0')
    expect(moveEntryKey(entries, 'model-0', 'previous')).toBe('tier-ultra')
    expect(moveEntryKey(entries, 'tier-fast', 'first')).toBe('model-0')
    expect(moveEntryKey(entries, 'tier-fast', 'last')).toBe('tier-ultra')
    expect(moveEntryKey(entries, null, 'next')).toBe('model-0')
  })

  it('skips disabled tiers', () => {
    const entries = modelSelectorEntries(claude({ model: 'model-small' }))
    expect(moveEntryKey(entries, 'tier-balanced', 'next')).toBe('model-0')
    expect(moveEntryKey(entries, 'tier-balanced', 'last')).toBe('tier-balanced')
    expect(moveEntryKey([], null, 'next')).toBeNull()
  })
})

describe('model and thinking selector: rendering', () => {
  it('renders the Claude menu with model options, efforts, disabled tiers and the footer', async () => {
    const html = await render({ claudeMode: true, models: MODELS, model: 'model-small', thinkingTier: 'fast' })
    expect(html).toContain('aria-label="Modell und Denktiefe: Claude Klein, Schnell"')
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('aria-expanded="false"')
    expect(html.match(/role="listbox"/g)).toHaveLength(2)
    expect(html.match(/role="option"/g)).toHaveLength(7)
    expect(html).toContain('Leistungsstark')
    expect(html).toContain('effort xhigh')
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(3)
    expect(html).toContain('Neue Chats starten mit der zuletzt gewählten Kombination.')
    expect(html).toMatch(/class=\"is-claude ai-model-select__provider\"/)
    expect(html).not.toContain('Lokales Modell in den Einstellungen ändern')
  })

  it('renders a read-only model row, token budgets and no footer outside Claude mode', async () => {
    const html = await render({ info: 'Lokal 27B', provider: 'local', nextPrompt: true })
    expect(html).toContain('aria-label="Modell und Denktiefe: Lokal 27B, Ausgewogen · gilt für den nächsten Auftrag"')
    expect(html.match(/role="option"/g)).toHaveLength(5)
    expect(html).toContain('Lokales Modell in den Einstellungen ändern')
    expect(html).toContain('1.024 / 8.192 / 4.096')
    expect(html).toMatch(/class=\"is-local ai-model-select__provider\"/)
    expect(html).not.toContain('effort ')
    expect(html).not.toContain('Gilt für diesen Chat')
    const external = await render({ info: 'Extern · Serverauswahl', provider: 'external' })
    expect(external).toContain('Der Server wählt das Modell')
    expect(external).toMatch(/class=\"is-external ai-model-select__provider\"/)
  })

  it('keeps all five step bars in the trigger and escapes server-provided labels', async () => {
    const html = await render({
      claudeMode: true,
      models: [{ id: 'x', label: '<img src=x>', description: '', efforts: [...THINKING_TIERS] }],
      thinkingTier: 'thorough',
    })
    const trigger = html.slice(0, html.indexOf('ai-model-select__menu'))
    expect(trigger.match(/<i class/g)).toHaveLength(5)
    expect(trigger.match(/is-filled/g)).toHaveLength(3)
    expect(html).not.toContain('<img src=x>')
  })

  it('declares exactly the two update events', () => {
    const emits = (ModelSelector as Component & { emits?: string[] | Record<string, unknown> }).emits
    expect(Array.isArray(emits) ? emits : Object.keys(emits ?? {})).toEqual(['update:thinkingTier', 'update:model'])
  })
})
