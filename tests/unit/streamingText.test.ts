import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import StreamingText from '@/components/ai/StreamingText.vue'

describe('live answer block rendering', () => {
  it('shows a partial question and incomplete bullet while answer actions stay unavailable', async () => {
    const html = await renderToString(
      createSSRApp(StreamingText, {
        content: '',
        streaming: true,
        question: 'Welche Datei',
        followUps: ['Backend prüfen', 'Frontend te'],
      })
    )
    expect(html).toContain('Welche Datei')
    expect(html).toContain('Backend prüfen')
    expect(html).toContain('Frontend te')
    expect(html).toContain('ai-answer__streamed-bullets')
    expect(html).not.toContain('Antwort kopieren')
    expect(html).not.toContain('ai-follow-ups')
  })

  it('renders an open code block immediately before a closing fence arrives', async () => {
    const html = await renderToString(
      createSSRApp(StreamingText, {
        content: 'Hier der Code:\n```ts\nconst ready = true\nconsole.log(ready)',
        streaming: true,
      })
    )
    expect(html).toContain('Hier der Code:')
    expect(html).toContain('const ready = true')
    expect(html).toContain('console.log(ready)')
    expect(html).toContain('ai-code__line')
  })
})
