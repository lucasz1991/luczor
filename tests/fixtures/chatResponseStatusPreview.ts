// Explicit synthetic UI fixture. No model, account, external request or native tool is called.
import { createApp, h, computed, ref } from 'vue'
import AssistantResponseFooter from '@/components/ai/AssistantResponseFooter.vue'
import MiniChatSurface from '@/components/mini/MiniChatSurface.vue'
import ThinkingState from '@/components/ai/ThinkingState.vue'
import StreamingText from '@/components/ai/StreamingText.vue'
import PromptBar from '@/components/ai/PromptBar.vue'
import { emptyMiniSnapshot, type MiniAction } from '@/services/miniChat/types'
import { createChatActivity, updateChatActivity, finishChatActivity } from '@/services/chatActivity'
import type { ThinkingBudgetProgress, ThinkingControlAction } from '@/services/inference/thinking'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

const active = ref(true)
const progress = ref<ThinkingBudgetProgress>({
  requestId: 'synthetic-generation',
  tier: 'fast',
  phase: 'thinking',
  generatedTokens: 430,
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
  sequence: 1,
})
const activity = ref(createChatActivity(Date.now()))
updateChatActivity(activity.value, { phase: 'thinking', agentRole: 'planner', round: 1 })
const usage = { inputTokens: 720, outputTokens: 430, totalTokens: 1150, source: 'reported' as const, rounds: 1 }
const text =
  'Ich habe den Projektstand gelesen. Als Nächstes prüfe ich die betroffenen Dateien und fasse die Änderungen zusammen.'
const ack = ref<ReturnType<typeof emptyMiniSnapshot>['thinkingControlAck']>(null)
async function control(requestId: string, action: ThinkingControlAction, sequence: number) {
  if (requestId !== progress.value.requestId || sequence !== progress.value.sequence)
    throw new Error('Stand gewechselt')
  progress.value = {
    ...progress.value,
    sequence: sequence + 1,
    controlOutcome: 'applied',
    answerRequested: action === 'answer',
    warning: false,
    softTargetTokens: action === 'more' ? 1024 : progress.value.softTargetTokens,
  }
  return progress.value
}
function stop() {
  active.value = false
  finishChatActivity(activity.value, 'canceled')
}
const snapshot = computed(() => ({
  ...emptyMiniSnapshot(),
  sessionId: 'synthetic-session',
  view: 'chat' as const,
  project: { id: 'synthetic-project', name: 'Beispielprojekt' },
  busy: active.value,
  thinkingBudget: progress.value,
  thinkingControlAck: ack.value,
  messages: [
    {
      id: 'synthetic-answer',
      role: 'assistant' as const,
      content: text,
      createdAt: Date.now(),
      choices: [],
      status: active.value ? ('running' as const) : ('canceled' as const),
      activity: activity.value,
      tokenUsage: usage,
    },
  ],
}))
async function onAction(action: MiniAction) {
  if (action.type === 'stop') stop()
  if (action.type === 'thinking_control') {
    const next = await control(action.requestId, action.action, action.sequence)
    ack.value = { requestId: action.requestId, controlId: action.controlId, progress: next }
  }
}
createApp({
  render: () =>
    h(
      'main',
      { class: 'ai-workspace', style: 'min-height:100vh;padding:32px;color:var(--ai-ink);font-family:var(--ai-font)' },
      [
        h('h1', { style: 'font-size:22px' }, 'Antwortstatus · Browserprüfung'),
        h('p', { style: 'margin:12px 0 32px' }, 'Synthetische Beispieldaten. Keine Modell- oder Serveranfrage.'),
        h('section', { style: 'max-width:680px;margin-right:460px' }, [
          h('h2', { style: 'font-size:16px;margin-bottom:16px' }, 'Hauptchat · gemeinsame Antwortkomponenten'),
          h('article', [
            h(ThinkingState, {
              label: active.value ? 'Vorgehen wird ausgearbeitet' : 'Abgebrochen',
              steps: activity.value.steps,
            }),
            h(StreamingText, { content: text, streaming: active.value, actions: false }),
            h(AssistantResponseFooter, {
              messageId: 'synthetic-answer',
              activeMessageId: 'synthetic-answer',
              active: active.value,
              budget: progress.value,
              usage,
              control,
              onStop: stop,
            }),
          ]),
          h('div', { style: 'margin-top:40px' }, [
            h(PromptBar, {
              modelValue: '',
              busy: active.value,
              routeMode: 'auto',
              externalAllowed: true,
              modelLabel: 'Lokal + extern',
              onStop: stop,
            }),
          ]),
        ]),
        h(MiniChatSurface, { snapshot: snapshot.value, onAction }),
      ]
    ),
}).mount('#app')
