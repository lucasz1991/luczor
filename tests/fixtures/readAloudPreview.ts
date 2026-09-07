// Explicit synthetic QA surface. Native IPC and server requests are replaced;
// production queue, playback owner, actual HTMLAudioElement and UI remain real.
import { createApp, h, nextTick, ref, watch } from 'vue'
import { mockIPC } from '@tauri-apps/api/mocks'
import ChatCommentary from '@/components/ai/ChatCommentary.vue'
import StreamingText from '@/components/ai/StreamingText.vue'
import ChatSettingsSection from '@/components/settings/ChatSettingsSection.vue'
import { commentaryForSpeech } from '@/services/chatCommentary'
import { createCommentarySpeechQueue } from '@/services/voice/commentarySpeech'
import { streamSpeak, stopSpeak } from '@/services/voice/speak'
import { beginReadAlong, endReadAlong, readAlongState, updateReadAlong } from '@/services/voice/readAlong'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

const allowed = ref(true)
const enabled = ref(true)
const events = ref<string[]>([])
const error = ref('')
const busy = ref(false)
const longComment = 'Projektzustand ist geladen. Jetzt lese ich die Codex-Daten und prüfe die Projektstruktur.'
const comment = {
  id: 'round-2',
  round: 2,
  content: 'Projektzustand ist geladen.',
  createdAt: 1,
  serverSpeechAllowed: false,
}
const comments = ref([comment])
const answer = 'Die Prüfung ist abgeschlossen.'
const files = new Map([
  [comment.content, 'comment.wav'],
  [answer, 'answer.wav'],
])
const nativeFetch = window.fetch.bind(window)
mockIPC((command, args) => {
  if (command === 'device_key_get') return 'synthetic-fixture-key'
  if (command === 'plugin:store|load') return 1
  if (command === 'plugin:store|get') {
    const key = (args as { key: string }).key
    const values: Record<string, string> = { luczor_api_base_url: location.origin, luczor_client_id: 'fixture' }
    return [Object.getOwnPropertyDescriptor(values, key)?.value, Object.hasOwn(values, key)]
  }
  throw new Error(`Unexpected fixture IPC: ${command}`)
})
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url === `${location.origin}/api/v1/voice/tts`) {
    const payload = JSON.parse(String(init?.body)) as { text: string }
    const filename = files.get(payload.text)
    if (!filename) throw new Error('Only the two synthetic fixture sentences may be spoken.')
    events.value.push(`tts:${payload.text}`)
    return nativeFetch(`/.lmzdev/artifacts/temp/read-aloud/${filename}`, { signal: init?.signal })
  }
  throw new Error('Unexpected network request blocked by read-aloud fixture.')
}
const queue = createCommentarySpeechQueue({
  canSpeak: () => enabled.value,
  allowLocalContent: () => allowed.value,
  isCurrent: () => true,
  onBlocked: () => {
    error.value = 'Lokale Inhalte sind nicht zum Vorlesen freigegeben.'
  },
  speak: (text, { signal, key }) => streamSpeak(text, { signal, key }),
  onError: () => {
    error.value = 'Audio konnte nicht abgespielt werden.'
  },
})
watch(
  () => [readAlongState.value?.key, readAlongState.value?.phase],
  async () => {
    await nextTick()
    if (readAlongState.value)
      events.value.push(
        `${readAlongState.value.key}:${readAlongState.value.phase}:mark=${document.querySelector('mark')?.textContent ?? '-'}`
      )
  }
)
function stop() {
  queue.cancel()
  stopSpeak()
  if (readAlongState.value) endReadAlong(readAlongState.value.owner)
  busy.value = false
}
async function play() {
  stop()
  comments.value = [comment]
  error.value = ''
  events.value = []
  busy.value = true
  const first = queue.enqueueMessage({
    scope: 'fixture',
    key: 'message:round-2',
    readMessage: () => commentaryForSpeech(comment),
  })
  const final = queue.enqueueMessage({
    scope: 'fixture',
    key: 'message:answer',
    readMessage: () => ({ content: answer, meta: { dataHandling: 'ephemeral', serverSpeechAllowed: false } }),
  })
  await Promise.all([first, final])
  busy.value = false
}
function position() {
  stop()
  comments.value = [{ ...comment, content: longComment }]
  const owner = beginReadAlong('message:round-2', longComment)
  updateReadAlong(owner, 'playing', longComment.indexOf('Codex'))
}
createApp({
  render: () =>
    h('main', { class: 'ai-workspace', style: 'max-width:780px;margin:auto;padding:20px;min-height:100vh' }, [
      h('h1', 'Luczor · Vorlesen'),
      h(
        'p',
        'Prüfansicht mit synthetischen Beispielsätzen. „Abspielen“ nutzt echte WAV-Wiedergabe; „Prüfposition“ setzt eine feste Anzeige.'
      ),
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin:16px 0' }, [
        h('button', { class: 'ai-button', onClick: play, disabled: busy.value }, 'Kommentare und Antwort abspielen'),
        h('button', { class: 'ai-button', onClick: position }, 'Prüfposition anzeigen'),
        h(
          'button',
          {
            class: 'ai-button',
            onClick: () => {
              if (readAlongState.value) updateReadAlong(readAlongState.value.owner, 'waiting')
            },
          },
          'Audiopause anzeigen'
        ),
        h('button', { class: 'ai-button', onClick: stop }, 'Vorlesen stoppen'),
      ]),
      h('label', [
        h('input', {
          type: 'checkbox',
          checked: allowed.value,
          onChange: (event: Event) => {
            allowed.value = (event.target as HTMLInputElement).checked
            stop()
          },
        }),
        ' Lokale Inhalte freigeben',
      ]),
      h('p', { role: 'status' }, error.value),
      h(ChatCommentary, { entries: comments.value, messageId: 'message' }),
      h(StreamingText, { content: answer, speechKey: 'message:answer', actions: false }),
      h('details', [
        h('summary', 'Chat-Einstellungen prüfen'),
        h(ChatSettingsSection, {
          autoSpeech: enabled.value,
          autoSpeechMode: 'assistant_only',
          allowLocalSpeech: allowed.value,
          historyTokenBudget: 2400,
          'onUpdate:autoSpeech': (value: boolean) => {
            enabled.value = value
            stop()
          },
          'onUpdate:allowLocalSpeech': (value: boolean) => {
            allowed.value = value
            stop()
          },
        }),
      ]),
      h(
        'pre',
        { style: 'white-space:pre-wrap;overflow-wrap:anywhere', 'data-testid': 'speech-events' },
        events.value.join('\n')
      ),
    ]),
}).mount('#app')
