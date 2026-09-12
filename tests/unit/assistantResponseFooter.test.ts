import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import AssistantResponseFooter from '@/components/ai/AssistantResponseFooter.vue'
import type { ThinkingBudgetProgress } from '@/services/inference/thinking'

const budget: ThinkingBudgetProgress = {
  requestId: 'generation-2',
  tier: 'fast',
  phase: 'thinking',
  generatedTokens: 400,
  softTargetTokens: 512,
  thinkingLimitTokens: 4096,
  requestedThinkingLimitTokens: 4096,
  outputLimitTokens: 8192,
  responseReserveTokens: 4096,
  warning: true,
  canExtend: true,
  canAnswer: true,
  answerRequested: false,
  elapsedMs: 8000,
  sequence: 3,
}
const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, source: 'reported' as const, rounds: 1 }

describe('assistant response footer ownership', () => {
  it('shows live budget actions only underneath the owning active response', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(
            'main',
            ['old-answer', 'answer-2'].map(messageId =>
              h('article', { 'data-message': messageId }, [
                h('p', 'Öffentliche Antwort'),
                h(AssistantResponseFooter, {
                  messageId,
                  activeMessageId: 'answer-2',
                  active: true,
                  budget,
                  usage,
                  control: async () => undefined,
                }),
              ])
            )
          ),
      })
    )
    const [older, active] = html.split('<article data-message="answer-2">')
    expect(older).not.toContain('Laufendes Denkbudget')
    expect(active).toContain('Laufendes Denkbudget')
    expect(active!.indexOf('Öffentliche Antwort')).toBeLessThan(active!.indexOf('Laufendes Denkbudget'))
    expect(html.match(/Laufendes Denkbudget/g)).toHaveLength(1)
    expect(active).toContain('Mehr denken')
    expect(active).toContain('Jetzt antworten')
    expect(active).toContain('Stoppen')
    expect(active).toContain('400 Tokens generiert')
    expect(active).toContain('120 Tokens')
  })

  it('keeps usage after completion without stale generation controls', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(AssistantResponseFooter, {
            messageId: 'answer-2',
            activeMessageId: 'answer-2',
            active: false,
            budget,
            usage,
          }),
      })
    )
    expect(html).toContain('120 Tokens')
    expect(html).not.toContain('Laufendes Denkbudget')
    expect(html).not.toContain('Jetzt antworten')
  })

  it('does not attach a budget when no response owner is known', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () => h(AssistantResponseFooter, { messageId: 'answer-2', active: true, budget }),
      })
    )
    expect(html).not.toContain('Laufendes Denkbudget')
  })
})
