// Explicit synthetic UI fixture; no model, account, native command or external API is used.
import { createApp, h, ref } from 'vue'
import StreamingText from '@/components/ai/StreamingText.vue'
import TokenCounter from '@/components/ai/TokenCounter.vue'
import ThinkingState from '@/components/ai/ThinkingState.vue'
import ToolChips from '@/components/ai/ToolChips.vue'
import AssistantProfileStatus from '@/components/AssistantProfileStatus.vue'
import type { TokenUsage } from '@/services/tokenUsage'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

const text = ref('')
const running = ref(false)
const usage = ref<TokenUsage>()
const finalText =
  'Der lokale Grundentwurf ist vorbereitet.\n\nDu kannst Persönlichkeit und Skills in der Admin-App bearbeiten. Während einer Antwort erscheinen neue Zeichen sofort; der Tokenzähler aktualisiert sich mit jedem empfangenen Abschnitt.\n\nDiese Vorschau zeigt ausschließlich synthetische Beispieldaten.'
let timer: ReturnType<typeof setInterval> | undefined
function start() {
  clearInterval(timer)
  text.value = ''
  running.value = true
  timer = setInterval(() => {
    text.value = finalText.slice(0, text.value.length + 2)
    const outputTokens = Math.ceil(text.value.length / 4)
    usage.value = {
      inputTokens: 1200,
      outputTokens,
      totalTokens: 1200 + outputTokens,
      source: 'estimated',
      rounds: 1,
      contextTokens: 8192,
    }
    if (text.value === finalText) {
      clearInterval(timer)
      running.value = false
    }
  }, 60)
}
createApp({
  render: () =>
    h('main', { style: 'max-width:1000px;margin:auto;padding:28px;color:var(--ai-text);font-family:Segoe UI' }, [
      h('h1', { style: 'font-size:24px' }, 'Luczor · lokale Streamingprüfung'),
      h(
        'p',
        { style: 'margin:12px 0 24px' },
        'Synthetische Beispieldaten. Kein echtes Modell und keine Serveranfrage.'
      ),
      h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:28px' }, [
        h('section', [
          h('button', { class: 'ai-button', onClick: start, disabled: running.value }, 'Streaming testen'),
          h(
            ThinkingState,
            {
              active: running.value,
              expanded: true,
              label: running.value ? 'Antwort empfangen' : 'Arbeitsschritte',
              steps: [{ id: 'files', label: 'Projektdateien geprüft', status: 'done' }],
            },
            {
              default: () =>
                h(ToolChips, {
                  tools: [
                    {
                      id: 'tool',
                      label: 'Dateiprüfung',
                      status: 'done',
                      detail: 'Zwischenergebnis\n3 Beispieldateien gefunden.',
                    },
                  ],
                }),
            }
          ),
          h(StreamingText, { content: text.value, streaming: running.value, animate: false, speechDisabled: true }),
          h(TokenCounter, { usage: usage.value, active: running.value }),
          h(
            'output',
            { style: 'display:block;margin-top:20px;font-size:11px', 'data-testid': 'stream-state' },
            `${text.value.length} Zeichen · ${running.value ? 'läuft' : 'beendet'}`
          ),
        ]),
        h(AssistantProfileStatus, { active: false }),
      ]),
    ]),
}).mount('#app')
