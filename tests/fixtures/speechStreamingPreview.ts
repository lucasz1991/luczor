// Synthetic public text + locally generated WAV. No real key or server request is used.
import { createApp, h, ref, watch } from 'vue'
import { mockIPC } from '@tauri-apps/api/mocks'
import StreamingText from '@/components/ai/StreamingText.vue'
import SelectionActions from '@/components/ai/SelectionActions.vue'
import { createCommentarySpeechQueue } from '@/services/voice/commentarySpeech'
import { createProgressiveCommentary } from '@/services/voice/progressiveCommentary'
import { readAlongState } from '@/services/voice/readAlong'
import { streamSpeak, stopSpeak } from '@/services/voice/speak'
import { serverSpeechText } from '@/services/voice/messageSpeech'
import type { Message } from '@/state/types'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

const sample = `## Flüssig vorlesen

Luczor liest **zusammenhängende Absätze** vor. Der Text bleibt normal formatiert, während die Antwort weiter eintrifft. 25 % & 10 € werden als Wörter gesprochen.

Die Liste bleibt sichtbar:

- **Vorbereitung:** Zwei fertige Absätze geben den Start frei.
- **Wiedergabe:** Der nächste Abschnitt wird im Hintergrund vorbereitet.
- **Text:** Neue Absätze erscheinen sofort im Chat.

| Eigenschaft | Ergebnis |
| --- | --- |
| Temperatur | 20 °C |
| Fortschritt | 50 % |

Ein [lesbarer Link](https://example.com) bleibt anklickbar. Auch die ursprünglichen Hervorhebungen und Abstände bleiben erhalten.

\`\`\`ts
const price = 25
console.log(price)
\`\`\`

Dieser letzte Absatz trifft erst später ein. Das Vorlesen soll schon vorher laufen und die fertige Antwort anschließend nicht von vorne wiederholen.`

const message = ref<Pick<Message, 'content' | 'meta'>>({
  content: '',
  meta: { isLoading: true, dataHandling: 'ephemeral', serverSpeechAllowed: false },
})
const metrics = ref({
  requests: [] as { text: string; at: number; whileStreaming: boolean }[],
  firstPlayback: null as number | null,
  streamDone: null as number | null,
  beforeEnd: false,
  error: '',
  selected: '',
  highlightedWord: '',
})
let startedAt = performance.now()
let timer: ReturnType<typeof setInterval> | undefined
const elapsed = () => Math.round(performance.now() - startedAt)

mockIPC((command, args) => {
  if (command === 'device_key_get') return 'synthetic-fixture-key'
  if (command === 'plugin:store|load') return 1
  if (command === 'plugin:store|get') {
    const values = new Map([
      ['luczor_api_base_url', location.origin],
      ['luczor_client_id', 'fixture'],
    ])
    const key = (args as { key: string }).key
    return [values.get(key), values.has(key)]
  }
  throw new Error('Unexpected fixture IPC')
})

function wav(): Blob {
  const rate = 8000
  const length = rate * 8
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const label = (offset: number, text: string) =>
    [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  label(0, 'RIFF')
  view.setUint32(4, buffer.byteLength - 8, true)
  label(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  label(36, 'data')
  view.setUint32(40, length * 2, true)
  // Quiet test tone exercises real Audio clocks without pretending to be speech.
  for (let index = 0; index < length; index++)
    view.setInt16(44 + index * 2, Math.sin((index * Math.PI * 440) / rate) * 90, true)
  return new Blob([buffer], { type: 'audio/wav' })
}

window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url !== `${location.origin}/api/v1/voice/tts`) throw new Error('Unexpected fixture request blocked')
  const payload = JSON.parse(String(init?.body)) as { text: string }
  metrics.value.requests.push({ text: payload.text, at: elapsed(), whileStreaming: !!message.value.meta.isLoading })
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      init?.signal?.removeEventListener('abort', abort)
      resolve()
    }
    const delay = setTimeout(done, 250)
    const abort = () => {
      clearTimeout(delay)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    init?.signal?.addEventListener('abort', abort, { once: true })
  })
  return new Response(wav(), { headers: { 'Content-Type': 'audio/wav' } })
}

const queue = createCommentarySpeechQueue({
  speak: (text, options) => streamSpeak(text, { ...options, voiceId: 'benni' }),
  canSpeak: () => true,
  allowLocalContent: () => true,
  isCurrent: () => true,
  onError: error => {
    metrics.value.error = String(error)
  },
})
let progressive = createProgressiveCommentary({
  scope: 'fixture',
  answerKey: 'fixture:answer',
  queue,
  readMessage: () => message.value,
})
watch(readAlongState, value => {
  if (value?.phase === 'playing' && metrics.value.firstPlayback === null) {
    metrics.value.firstPlayback = elapsed()
    metrics.value.beforeEnd = !!message.value.meta.isLoading
  }
  requestAnimationFrame(() => {
    metrics.value.highlightedWord = Array.from(CSS.highlights?.get('luczor-read-aloud') ?? [], range =>
      range.toString()
    ).join(' ')
  })
})

function reset() {
  clearInterval(timer)
  progressive.cancel()
  queue.cancel()
  stopSpeak()
  metrics.value = {
    requests: [],
    firstPlayback: null,
    streamDone: null,
    beforeEnd: false,
    error: '',
    selected: '',
    highlightedWord: '',
  }
  startedAt = performance.now()
  progressive = createProgressiveCommentary({
    scope: 'fixture',
    answerKey: 'fixture:answer',
    queue,
    readMessage: () => message.value,
  })
}
function start() {
  reset()
  message.value = { content: '', meta: { isLoading: true, dataHandling: 'ephemeral', serverSpeechAllowed: false } }
  let offset = 0
  timer = setInterval(() => {
    offset += 30
    message.value.content = sample.slice(0, offset)
    progressive.update()
    if (offset >= sample.length) {
      clearInterval(timer)
      message.value.meta.isLoading = false
      metrics.value.streamDone = elapsed()
      progressive.completeAnswer()
    }
  }, 350)
}
function showAll() {
  reset()
  message.value = { content: sample, meta: { isLoading: false } }
}
const button = (text: string, action: () => void) =>
  h('button', { type: 'button', class: 'ai-button', onClick: action }, text)

createApp({
  render: () =>
    h('main', { class: 'ai-workspace' }, [
      h('h1', 'Stream und Vorlesen'),
      h('p', 'Prüfansicht mit synthetischem Text und leisem Testton. Keine Verbindung zum Sprachserver.'),
      h('div', { class: 'fixture-controls' }, [
        button('Textstream starten', start),
        button('Text vollständig anzeigen', showAll),
        button('Code und Rückfrage anzeigen', () => {
          reset()
          message.value = {
            content: '```ts\nconst ready = true\n```',
            meta: { isLoading: false, question: 'Welche Datei soll ich jetzt prüfen?' },
          }
        }),
        button('Vorlesen', () => {
          void streamSpeak(serverSpeechText(message.value, { allowLocalContent: true }), {
            key: 'fixture:answer',
            voiceId: 'benni',
          })
        }),
        button('Vorlesen stoppen', () => {
          progressive.cancel()
          queue.cancel()
          stopSpeak()
        }),
      ]),
      h(
        SelectionActions,
        {
          onSpeak: (text: string) => {
            metrics.value.selected = text
            void streamSpeak(text, { key: 'selection', voiceId: 'benni' })
          },
          onAction: () => undefined,
        },
        {
          default: () =>
            h('article', { class: 'fixture-answer' }, [
              h(StreamingText, {
                content: message.value.content,
                question: message.value.meta.question,
                streaming: !!message.value.meta.isLoading,
                speechKey: 'fixture:answer',
                actions: false,
              }),
            ]),
        }
      ),
      h(
        'p',
        { 'data-testid': 'stream-state' },
        message.value.meta.isLoading ? 'Textstream läuft' : 'Textstream vollständig'
      ),
      h('p', { 'data-testid': 'highlighted-word' }, metrics.value.highlightedWord),
      h('pre', { class: 'fixture-metrics', 'data-testid': 'metrics' }, JSON.stringify(metrics.value, null, 2)),
    ]),
}).mount('#app')
