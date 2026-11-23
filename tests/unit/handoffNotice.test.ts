import { createSSRApp, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import HandoffNotice from '@/components/ai/HandoffNotice.vue'
import type { MessageHandoff } from '@/state/types'

const handoff = (extra: Partial<MessageHandoff> = {}): MessageHandoff => ({
  from: 'claude',
  reason: 'refusal',
  category: 'SECRET_POLICY_CATEGORY',
  at: 1,
  state: 'offered',
  ...extra,
})
const render = (props: {
  handoff: MessageHandoff
  localAvailable?: boolean
  busy?: boolean
  canSwitchMode?: boolean
}) => renderToString(createSSRApp({ render: () => h(HandoffNotice, { localAvailable: true, ...props }) }))
const button = (html: string, label: string) =>
  // `label` is a literal from the tests below, never external input.
  // eslint-disable-next-line security/detect-non-literal-regexp
  new RegExp(`<button[^>]*>\\s*${label}\\s*</button>`).exec(html)?.[0] ?? null

describe('hand-over notice', () => {
  it('reports an automatic take-over without any action and never shows the policy category', async () => {
    const html = await render({ handoff: handoff({ state: 'taken' }) })
    expect(html).toContain('role="status"')
    expect(html).toMatch(/<b[^>]*>Claude hat diese Anfrage nicht bearbeitet\.<\/b>/)
    expect(html).toContain(
      'Der lokale Spezial-Agent hat den Auftrag übernommen; diese Runde wird nicht an Claude gesendet.'
    )
    expect(html).not.toContain('<button')
    expect(html).not.toContain('SECRET_POLICY_CATEGORY')
  })

  it('words a manual local answer differently', async () => {
    const html = await render({ handoff: handoff({ state: 'taken', reason: 'manual' }) })
    expect(html).toMatch(/<b[^>]*>Lokal neu beantwortet\.<\/b>/)
    expect(html).toContain('auf Wunsch vom lokalen Spezial-Agenten bearbeitet')
    expect(html).not.toContain('Richtlinienhinweis')
    expect(html).not.toContain('<button')
  })

  it('offers the local take-over and the decline action', async () => {
    const html = await render({ handoff: handoff() })
    expect(html).toContain('Soll der lokale Spezial-Agent den Auftrag auf diesem Gerät übernehmen?')
    expect(button(html, 'Lokal bearbeiten')).not.toContain('disabled')
    expect(button(html, 'Nicht bearbeiten')).not.toContain('disabled')
    expect(html).not.toContain('umstellen')
    expect(html).not.toContain('Kein lokales Modell bereit.')
    expect(html).not.toContain('SECRET_POLICY_CATEGORY')
  })

  it('offers switching the chat mode only when asked to', async () => {
    const html = await render({ handoff: handoff(), canSwitchMode: true })
    expect(button(html, 'Chat auf „Claude \\+ lokal“ umstellen')).not.toBeNull()
  })

  it('blocks the local take-over and explains why when no local model is ready', async () => {
    const html = await render({ handoff: handoff(), localAvailable: false, canSwitchMode: true })
    expect(button(html, 'Lokal bearbeiten')).toContain('disabled')
    expect(button(html, 'Nicht bearbeiten')).not.toContain('disabled')
    expect(html).toContain('Kein lokales Modell bereit.')
  })

  it('disables every action while busy', async () => {
    const html = await render({ handoff: handoff(), busy: true, canSwitchMode: true })
    expect(html.match(/<button/g)).toHaveLength(3)
    expect(html.match(/<button[^>]* disabled/g)).toHaveLength(3)
  })

  it('states a declined turn without actions', async () => {
    const html = await render({ handoff: handoff({ state: 'declined' }) })
    expect(html).toMatch(/<b[^>]*>Claude hat diese Anfrage nicht bearbeitet\.<\/b>/)
    expect(html).toContain('Die Anfrage wurde nicht bearbeitet.')
    expect(html).not.toContain('<button')
  })

  it('declares its three decisions', () => {
    const emits = (HandoffNotice as Component & { emits?: string[] | Record<string, unknown> }).emits
    expect(Array.isArray(emits) ? emits : Object.keys(emits ?? {})).toEqual(['accept', 'decline', 'switch-mode'])
  })
})
