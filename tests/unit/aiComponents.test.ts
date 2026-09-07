import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import StreamingText from '@/components/ai/StreamingText.vue'
import ApprovalCard from '@/components/ai/ApprovalCard.vue'
import ThinkingState from '@/components/ai/ThinkingState.vue'
import RecordsTable from '@/components/ai/RecordsTable.vue'
import AgentScreen from '@/components/ai/AgentScreen.vue'

describe('AI component rendering contracts', () => {
  it('renders structured code without allowing model HTML to execute', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(StreamingText, {
            content: '## Ergebnis\n\n<script>alert(1)</script>\n\n```html\n<img src=x onerror=alert(2)>\n```',
            followUps: ['Nächster Schritt'],
          }),
      })
    )
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
    expect(html).toContain('Code kopieren')
    expect(html).toContain('Nächster Schritt')
  })

  it('streams question and option text while keeping answer and option actions unavailable', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(StreamingText, {
            content: 'Antwort läuft',
            streaming: true,
            question: 'Welche Variante',
            followUps: ['Noch nicht senden'],
          }),
      })
    )
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('Antwort kopieren')
    expect(html).toContain('Welche Variante')
    expect(html).toContain('<li>Noch nicht senden</li>')
    expect(html).not.toContain('<button')
  })

  it('disables speech for private or incomplete replies and explains the reason', async () => {
    const reason = 'Lokale oder unvollständige Inhalte werden nicht an den Sprachserver gesendet.'
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(StreamingText, {
            content: 'Private lokale Antwort',
            speechDisabled: true,
            speechDisabledReason: reason,
          }),
      })
    )
    expect(html).toMatch(/aria-label="Antwort vorlesen"[^>]*disabled/)
    expect(html).toContain(`title="${reason}"`)
    expect(html).toContain('Antwort kopieren')
  })

  it('disables both approval actions while a decision is being processed and escapes arguments', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () => h(ApprovalCard, { title: 'file_write', detail: '<script>payload</script>', busy: true }),
      })
    )
    expect(html.match(/ disabled/g)).toHaveLength(2)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>payload')
  })

  it('keeps finished traces expanded unless explicitly collapsed', async () => {
    const render = (expanded?: boolean) =>
      renderToString(
        createSSRApp({
          render: () =>
            h(ThinkingState, { expanded, steps: [{ id: 'read', label: 'Projekt gelesen', status: 'done' }] }),
        })
      )
    expect(await render()).toContain('aria-expanded="true"')
    expect(await render(true)).toContain('aria-expanded="true"')
    expect(await render(false)).toContain('aria-expanded="false"')
  })

  it('renders empty records and screens without fabricating runtime evidence', async () => {
    const table = await renderToString(
      createSSRApp({ render: () => h(RecordsTable, { columns: [{ key: 'name', label: 'Name' }], rows: [] }) })
    )
    expect(table).toContain('Keine Einträge vorhanden.')
    const screen = await renderToString(createSSRApp({ render: () => h(AgentScreen) }))
    expect(screen).toContain('Keine Bildschirmansicht vorhanden.')
    expect(screen).toContain('disabled')
    expect(screen).not.toContain('<img')
  })
})
