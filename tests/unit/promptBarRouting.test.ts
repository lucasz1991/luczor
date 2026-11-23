import { createSSRApp, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import DropdownMenu from '@/components/ai/DropdownMenu.vue'
import PromptBar from '@/components/ai/PromptBar.vue'
import { THINKING_TIERS } from '@/services/inference/thinking'

const MODELS = [
  { id: 'model-large', label: 'Claude Groß', description: 'Leistungsstark', efforts: [...THINKING_TIERS] },
]
const bar = (props: Record<string, unknown>) =>
  renderToString(createSSRApp({ render: () => h(PromptBar, { modelValue: '', ...props }) }))
/** The option button of one route mode, found by its visible label. */
function option(html: string, label: string): string {
  const match = html.match(
    // `label` is a literal from the tests below, never external input.
    // eslint-disable-next-line security/detect-non-literal-regexp
    new RegExp(`<button[^>]*role="option"[^>]*>(?:(?!</button>).)*<span[^>]*>${label}</span>`, 's')
  )
  if (!match) throw new Error(`Option ${label} not rendered`)
  return match[0]
}
const routeLabel = (html: string) => /aria-label="Erlaubte Modelle für diesen Chat: ([^"]+)"/.exec(html)?.[1]

describe('dropdown group headings', () => {
  const menu = (options: unknown[]) =>
    renderToString(
      createSSRApp({ render: () => h(DropdownMenu as Component, { modelValue: 'a', options, label: 'Test' }) })
    )

  it('renders one heading per run of options sharing a group', async () => {
    const html = await menu([
      { value: 'a', label: 'A', group: 'Erste Gruppe' },
      { value: 'b', label: 'B', group: 'Erste Gruppe' },
      { value: 'c', label: 'C', group: 'Zweite Gruppe' },
    ])
    expect(html.match(/ai-dropdown__head/g)).toHaveLength(2)
    expect(html.indexOf('Erste Gruppe')).toBeLessThan(html.indexOf('option-a"'))
    expect(html.indexOf('Zweite Gruppe')).toBeGreaterThan(html.indexOf('option-b"'))
    expect(html.match(/role="option"/g)).toHaveLength(3)
  })

  it('renders no heading when no option has a group', async () => {
    const html = await menu([
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ])
    expect(html).not.toContain('ai-dropdown__head')
  })
})

describe('prompt bar route modes', () => {
  it('groups the five modes and locks Claude and external entries without their access', async () => {
    const html = await bar({ routeMode: 'local', externalAllowed: false })
    for (const heading of ['Lokales Modell führt', 'Claude führt', 'Externe Modelle führen']) {
      expect(html).toContain(heading)
    }
    expect(option(html, 'Lokal')).not.toContain('disabled')
    for (const label of ['Lokal \\+ extern', 'Claude \\+ lokal', 'Nur Claude', 'Nur extern']) {
      expect(option(html, label)).toContain('disabled')
    }
    expect(html).toContain('Claude führt; das lokale Modell übernimmt bei Ablehnung.')
    expect(html).toContain('Claude führt ohne lokales Modell.')
  })

  it('unlocks the Claude entries with a Claude access and the external ones with the external release', async () => {
    const html = await bar({ routeMode: 'local', externalAllowed: true, claudeAvailable: true })
    for (const label of ['Lokal \\+ extern', 'Claude \\+ lokal', 'Nur Claude', 'Nur extern']) {
      expect(option(html, label)).not.toContain('disabled')
    }
  })

  it('shows a Claude mode only while the Claude access is available', async () => {
    const active = await bar({ routeMode: 'claude_local', claudeAvailable: true, claudeModels: MODELS })
    expect(routeLabel(active)).toBe('Claude + lokal')
    expect(active).toMatch(/ai-route-mode is-active/)
    expect(active).toContain('Modell und Denktiefe: Claude Groß, Ausgewogen')
    expect(active).toContain('effort medium')

    const locked = await bar({
      routeMode: 'claude',
      claudeAvailable: false,
      claudeModels: MODELS,
      modelInfo: 'Lokal 27B',
    })
    expect(routeLabel(locked)).toBe('Lokal')
    expect(locked).not.toMatch(/ai-route-mode is-active/)
    expect(locked).toContain('Einstellungen → Claude API')
    expect(locked).toContain('Modell und Denktiefe: Lokal 27B, Ausgewogen')
    expect(locked).not.toContain('effort medium')
  })

  it('shows external modes only while external models are allowed, independent of Claude', async () => {
    const allowed = await bar({ routeMode: 'external', externalAllowed: true })
    expect(routeLabel(allowed)).toBe('Nur extern')
    expect(allowed).toContain('Modell und Denktiefe: Extern · Serverauswahl, Ausgewogen')
    expect(allowed).toContain('Der Server wählt das Modell')

    const locked = await bar({ routeMode: 'auto', externalAllowed: false, claudeAvailable: true })
    expect(routeLabel(locked)).toBe('Lokal')
    expect(locked).toContain('Externe Modelle zuerst unter Einstellungen')

    const claudeOnly = await bar({
      routeMode: 'claude',
      externalAllowed: false,
      claudeAvailable: true,
      claudeModels: MODELS,
    })
    expect(routeLabel(claudeOnly)).toBe('Nur Claude')
  })

  it('declares the new model and resume events', () => {
    const emits = (PromptBar as Component & { emits?: string[] | Record<string, unknown> }).emits
    expect(Array.isArray(emits) ? emits : Object.keys(emits ?? {})).toEqual(
      expect.arrayContaining(['update:routeMode', 'update:thinkingTier', 'update:claudeModel', 'resume-claude'])
    )
  })
})

describe('prompt bar local continuation', () => {
  it('renders no continuation bar by default', async () => {
    const html = await bar({ routeMode: 'claude_local', claudeAvailable: true, claudeModels: MODELS })
    expect(html).not.toContain('ai-prompt__continuation')
    expect(html).not.toContain('Wieder Claude verwenden')
  })

  it('announces the local continuation above the prompt and shows the local specialist as model', async () => {
    const html = await bar({
      routeMode: 'claude_local',
      claudeAvailable: true,
      claudeModels: MODELS,
      modelInfo: 'Lokal 27B',
      localContinuation: true,
    })
    expect(html).toMatch(/class="ai-prompt__continuation"[^>]*role="status"/)
    expect(html).toContain('Dieser Chat wird lokal fortgeführt, damit Folgefragen den vollständigen Verlauf sehen.')
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>\s*Wieder Claude verwenden\s*<\/button>/)
    expect(html.indexOf('ai-prompt__continuation')).toBeLessThan(html.indexOf('class="ai-prompt"'))
    expect(html).toContain('Modell und Denktiefe: Lokal 27B · Spezial-Agent, Ausgewogen')
    expect(html).toMatch(/class=\"is-local ai-model-select__provider\"/)
    expect(html).not.toContain('effort medium')
    // The chat itself stays a Claude chat; only the model control reflects the hand-over.
    expect(routeLabel(html)).toBe('Claude + lokal')
  })
})
