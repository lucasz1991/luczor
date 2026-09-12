// Isolated UI/real audio QA. Native IPC and network are limited to synthetic fixture values.
import { createApp, h, ref } from 'vue'
import { mockIPC } from '@tauri-apps/api/mocks'
import PromptBar from '@/components/ai/PromptBar.vue'
import ReadAloudText from '@/components/ai/ReadAloudText.vue'
import SelectionActions from '@/components/ai/SelectionActions.vue'
import { readAlongState } from '@/services/voice/readAlong'
import { streamSpeak } from '@/services/voice/speak'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

const fullText =
  'Luczor bereitet jetzt den vollständigen Text als eine zusammenhängende Sprachausgabe vor. Dadurch läuft die Wiedergabe flüssig über mehrere Sätze, während das aktuelle Wort weiter sichtbar markiert wird.'
const fallback = ref(false)
const spoken = ref('Noch keine Ausgabe')
const nativeFetch = window.fetch.bind(window)

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

window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url !== `${location.origin}/api/v1/voice/tts`) throw new Error('Unexpected network request blocked')
  const payload = JSON.parse(String(init?.body)) as { text: string; voice_id?: string; speed: number }
  if (payload.voice_id !== 'benni' || payload.speed !== 1) throw new Error('Unexpected voice fixture request')
  const selection = payload.text.trim()
  const file =
    payload.text === fullText ? 'fluid.wav' : selection && fullText.includes(selection) ? 'selection.wav' : ''
  if (!file) throw new Error('Only the synthetic full text and exact selected sample may be spoken')
  spoken.value = file === 'fluid.wav' ? 'Gesamter Text · eine Serveranfrage' : 'Nur Auswahl · eine Serveranfrage'
  return nativeFetch(`/.lmzdev/artifacts/temp/read-aloud/${file}`, { signal: init?.signal })
}

async function speak(text: string) {
  await streamSpeak(text, { key: 'context', voiceId: 'benni' })
}

createApp({
  render: () =>
    h('main', { class: 'ai-workspace speech-selection-fixture' }, [
      h('header', { class: 'fixture-head' }, [
        h('span', { class: 'ai-eyebrow' }, 'VORLESEN · PRÜFANSICHT'),
        h('h1', 'Flüssige Ausgabe mit Wortmarkierung'),
        h('p', 'Markiere einen Teil des Textes. Danach erscheint direkt die Option „Auswahl vorlesen“.'),
      ]),
      h(
        SelectionActions,
        {
          onSpeak: (text: string) => void speak(text),
          onAction: () => undefined,
        },
        {
          default: () =>
            h('article', { class: 'fixture-answer' }, [
              readAlongState.value
                ? h(ReadAloudText, { playback: readAlongState.value })
                : h('p', { 'data-testid': 'selectable-output' }, fullText),
            ]),
        }
      ),
      h(
        'button',
        { class: 'ai-button fixture-speak-all', onClick: () => void speak(fullText) },
        'Gesamten Text vorlesen'
      ),
      h('output', { 'data-testid': 'spoken-request', class: 'fixture-output' }, spoken.value),
      h(PromptBar, {
        modelValue: '',
        modelLabel: fallback.value ? 'Lokal · Fallback nach Freigabe' : 'Lokales Modell',
        contextLabel: 'Luczor',
        externalAllowed: true,
        routeMode: fallback.value ? 'auto' : 'local',
        'onUpdate:routeMode': (value: 'local' | 'auto' | 'external') => {
          fallback.value = value !== 'local'
        },
      }),
    ]),
}).mount('#app')
