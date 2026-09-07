// Synthetic transport fixture, using actual transcript presentation and speech queue.
// No network, model, credentials, native calls or actual audio.
import { createApp, h, ref } from 'vue'
import ChatCommentary from '@/components/ai/ChatCommentary.vue'
import StreamingText from '@/components/ai/StreamingText.vue'
import ThinkingState from '@/components/ai/ThinkingState.vue'
import { presentEnvelopeStream } from '@/services/envelope'
import { completedCommentary, commentaryForSpeech } from '@/services/chatCommentary'
import { createCommentarySpeechQueue } from '@/services/voice/commentarySpeech'
import { createChatActivity, finishChatActivity, updateChatActivity } from '@/services/chatActivity'
import type { ChatCommentary as Entry } from '@/state/types'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

const final = JSON.stringify({
  answer: 'Die ersten Zeichen sind bereits sichtbar.\n\n```ts\nconst text = "Hallo";\n```',
  question: 'Soll ich weitermachen?',
  bullets: ['Weiter', 'Details'],
})
const chunks = [
  '{"summary":"Ich prü',
  '{"summary":"Ich prüfe die Beispieldaten und zeige den Zwischenstand."}',
  final.slice(0, final.indexOf('Zeichen') + 3),
  final.slice(0, final.indexOf('Hallo') + 3),
  final.slice(0, final.indexOf('weitermachen') + 6),
  final.slice(0, final.indexOf('Weiter') + 3),
]
const index = ref(0)
const live = ref('')
const running = ref(true)
const comments = ref<Entry[]>([])
const activity = ref(createChatActivity())
const enabled = ref(true)
const spoken = ref<string[]>([])
const queue = createCommentarySpeechQueue({
  isCurrent: () => true,
  canSpeak: () => enabled.value,
  speak: async text => {
    spoken.value.push(text)
    return 'completed'
  },
})
function step() {
  if (index.value === 2) {
    const entry = completedCommentary({ round: 1, content: chunks[1]!, serverSpeechAllowed: true })!
    comments.value.push(entry)
    void queue.enqueueMessage({
      scope: 'fixture',
      key: entry.id,
      readMessage: () => commentaryForSpeech(comments.value[0]),
    })
    updateChatActivity(activity.value, { phase: 'tools', round: 1 })
  }
  if (index.value >= chunks.length) {
    live.value = final
    running.value = false
    finishChatActivity(activity.value, 'done')
    void queue.enqueueMessage({
      scope: 'fixture',
      key: 'answer',
      readMessage: () => ({ content: presentEnvelopeStream(final, true).content, meta: { serverSpeechAllowed: true } }),
    })
    return
  }
  live.value = chunks[index.value++]!
  updateChatActivity(activity.value, {
    phase: 'receiving',
    round: index.value <= 2 ? 1 : 2,
    characters: live.value.length,
  })
}
createApp({
  render() {
    const shown = presentEnvelopeStream(live.value, !running.value)
    return h('main', { style: 'max-width:780px;margin:auto;padding:24px;color:var(--ai-ink)' }, [
      h('h1', 'Zwischenkommentare und Live-Stream'),
      h('p', 'Synthetische Teilstücke. Die Vorleseliste prüft die Warteschlange ohne Audio oder Server.'),
      h('label', [
        h('input', {
          type: 'checkbox',
          checked: enabled.value,
          onChange: (event: Event) => {
            enabled.value = (event.target as HTMLInputElement).checked
          },
        }),
        ' Automatisch vorlesen (Simulation)',
      ]),
      h('button', { class: 'ai-button', onClick: step, disabled: !running.value }, 'Nächste Streamzeichen'),
      h('output', { 'data-testid': 'phase' }, `Teil ${index.value} · ${running.value ? 'läuft' : 'fertig'}`),
      h(ThinkingState, {
        active: running.value,
        label: running.value ? 'Text wird empfangen' : 'Abgeschlossen',
        steps: activity.value.steps,
      }),
      h(ChatCommentary, { entries: comments.value }),
      h(StreamingText, {
        content: shown.content,
        question: shown.question,
        followUps: shown.bullets,
        streaming: running.value,
        actions: false,
      }),
      h('section', { 'aria-label': 'Vorlesereihenfolge' }, [
        h('h2', 'Vorlesereihenfolge'),
        h(
          'ol',
          spoken.value.map((text, number) => h('li', { key: number }, text))
        ),
      ]),
    ])
  },
}).mount('#app')
