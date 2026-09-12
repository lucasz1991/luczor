import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import ChatTurnTimeline from '@/components/ai/ChatTurnTimeline.vue'
import ChatWorkingIndicator from '@/components/ai/ChatWorkingIndicator.vue'

describe('chat turn timeline', () => {
  it('keeps public activities, commentary, and tools in their recorded order', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(ChatTurnTimeline, {
            activity: {
              startedAt: 100,
              status: 'done',
              steps: [
                {
                  id: 'context',
                  label: 'Kontext vorbereiten',
                  status: 'done',
                  createdAt: 100,
                },
                {
                  id: 'worker-round-1-thinking',
                  label: 'Antwort vorbereiten',
                  status: 'done',
                  createdAt: 400,
                  agentRole: 'worker',
                },
              ],
            },
            commentary: [
              {
                id: 'round-1',
                round: 1,
                content: 'Kommentar nach Kontext',
                createdAt: 200,
                serverSpeechAllowed: true,
              },
            ],
            tools: [{ id: 'tool-1', label: 'Tool danach', status: 'done', createdAt: 300 }],
          }),
      })
    )

    expect(html.indexOf('Kontext vorbereiten')).toBeLessThan(html.indexOf('Kommentar nach Kontext'))
    expect(html.indexOf('Kommentar nach Kontext')).toBeLessThan(html.indexOf('Tool danach'))
    expect(html.indexOf('Tool danach')).toBeLessThan(html.indexOf('Antwort vorbereiten'))
    expect(html).toContain('Bearbeitung')
  })

  it('shows an explicit bottom working indicator while a turn is active', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () => h(ChatWorkingIndicator, { label: 'Werkzeuge ausführen' }),
      })
    )
    expect(html).toContain('role="status"')
    expect(html).toContain('Werkzeuge ausführen')
  })
})
