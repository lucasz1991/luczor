// Isolated, synthetic microphone and store. Never records a real device or sends a chat.
import { createApp, h, ref } from 'vue'
import { mockIPC } from '@tauri-apps/api/mocks'
import PromptBar from '@/components/ai/PromptBar.vue'
import MiniChatSurface from '@/components/mini/MiniChatSurface.vue'
import { emptyMiniSnapshot } from '@/services/miniChat/types'
import '@/styles/mini-chat.css'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

const stores = new Map<number, Map<string, unknown>>([
  [1, new Map()],
  [2, new Map()],
])
const source = ref('wake')
const notice = ref('Isolierte Prüfansicht · synthetisches Mikrofon · keine Nachricht wird versendet')
mockIPC((command, args) => {
  if (command === 'plugin:store|load') return args?.path === 'luczor.audio-triggers.json' ? 2 : 1
  const values = stores.get(Number(args?.rid)) ?? stores.get(1)!
  if (command === 'plugin:store|get') return [values.get(String(args?.key)), values.has(String(args?.key))]
  if (command === 'plugin:store|set') {
    values.set(String(args?.key), args?.value)
    return
  }
  if (command === 'plugin:store|save' || command === 'voice_input_claim' || command === 'plugin:event|unlisten') return
  if (command === 'plugin:event|listen') return 1
  throw new Error(`Unexpected fixture command: ${command}`)
})
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
  value: async () => {
    const context = new AudioContext()
    const response = await fetch(`/tests/fixtures/audio-triggers/${source.value}.wav`)
    const buffer = await context.decodeAudioData(await response.arrayBuffer())
    const player = context.createBufferSource()
    player.buffer = buffer
    const output = context.createMediaStreamDestination()
    player.connect(output)
    player.start(context.currentTime + 0.25)
    const track = output.stream.getAudioTracks()[0]!
    const stop = track.stop.bind(track)
    track.stop = () => {
      stop()
      void context.close().catch(() => undefined)
    }
    return output.stream
  },
})
createApp({
  setup() {
    const input = ref('')
    if (new URLSearchParams(location.search).has('mini')) {
      const snapshot = { ...emptyMiniSnapshot(), sessionId: 'synthetic-mini-session' }
      return () => h(MiniChatSurface, { snapshot, onAction: () => undefined })
    }
    return () =>
      h(
        'main',
        {
          class: 'ai-workspace',
          style:
            'max-width:800px;min-height:100vh;margin:auto;padding:28px 18px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;gap:20px',
        },
        [
          h('header', [
            h('h1', 'Spracheingabe'),
            h('p', notice.value),
            h('label', [
              'Testquelle ',
              h(
                'select',
                {
                  value: source.value,
                  onChange: (event: Event) => {
                    source.value = (event.target as HTMLSelectElement).value
                  },
                },
                ['wake', 'wake-probe', 'close', 'negative'].map(value => h('option', { value }, value))
              ),
            ]),
          ]),
          h(PromptBar, {
            modelValue: input.value,
            'onUpdate:modelValue': (value: string) => {
              input.value = value
            },
            contextLabel: 'Luczor',
            onVoiceStart: () => {
              notice.value = 'Einstellungen gespeichert · Start angefordert (Prüfansicht ohne Chat)'
            },
          }),
        ]
      )
  },
}).mount('#app')
