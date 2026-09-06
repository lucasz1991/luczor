import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import TokenCounter from '@/components/ai/TokenCounter.vue'
describe('token counter', () => {
  it('labels live estimates and separates input and output from context capacity', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(TokenCounter, {
            active: true,
            usage: {
              inputTokens: 1200,
              outputTokens: 300,
              totalTokens: 1500,
              source: 'estimated',
              rounds: 2,
              contextTokens: 8192,
            },
          }),
      })
    )
    expect(html).toContain('1.500 Tokens')
    expect(html).toContain('1.200 Eingabe')
    expect(html).toContain('300 Ausgabe')
    expect(html).toContain('geschätzt · live')
    expect(html).toContain('Kontextfenster: 8.192')
  })
  it('does not invent usage for older messages', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(TokenCounter) }))
    expect(html).not.toContain('0 Tokens')
    expect(html).not.toContain('Tokenverbrauch')
  })
})
