import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import MiniChatContextPicker from '@/components/mini/MiniChatContextPicker.vue'
import { emptyMiniSnapshot } from '@/services/miniChat/types'

describe('mini chat context presentation', () => {
  it('identifies the temporary runtime instead of displaying the main chat title', async () => {
    const snapshot = {
      ...emptyMiniSnapshot(),
      conversations: [{ id: 'chat-a', title: 'Main conversation', busy: false }],
      conversationId: 'chat-a',
    }
    const html = await renderToString(createSSRApp({ render: () => h(MiniChatContextPicker, { snapshot }) }))
    expect(html).toContain('Temporärer Chat')
    expect(html).not.toContain('Main conversation')
  })

  it('displays the selected shared conversation with escaped user content', async () => {
    const snapshot = {
      ...emptyMiniSnapshot(),
      view: 'chat' as const,
      conversations: [{ id: 'chat-a', title: '<script>chat</script>', busy: false }],
      conversationId: 'chat-a',
    }
    const html = await renderToString(createSSRApp({ render: () => h(MiniChatContextPicker, { snapshot }) }))
    expect(html).toContain('&lt;script&gt;chat&lt;/script&gt;')
    expect(html).not.toContain('<script>chat</script>')
    expect(html).not.toContain('Temporärer Chat')
  })
})
