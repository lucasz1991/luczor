// Isolated UI/real audio QA. Only fixture credentials and synthetic sentences.
import { createApp, h, ref } from 'vue'
import { mockIPC } from '@tauri-apps/api/mocks'
import VoiceSettingsSection from '@/components/settings/VoiceSettingsSection.vue'
import ReadAloudText from '@/components/ai/ReadAloudText.vue'
import { readAlongState } from '@/services/voice/readAlong'
import { streamSpeak } from '@/services/voice/speak'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'
import '@/components/settings/settings.css'

const voiceId = ref('')
const requests = ref<string[]>([])
const nativeFetch = window.fetch.bind(window)
let catalogAvailable = true
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
  if (url === `${location.origin}/api/v1/voice/voices`)
    return new Response(
      JSON.stringify({
        voices: catalogAvailable
          ? [
              { id: 'piper', name: 'Piper Standard', provider: 'piper', language: 'de' },
              { id: 'benni', name: 'Benni', provider: 'pocket', language: 'de' },
              { id: 'juergen', name: 'Jürgen', provider: 'pocket', language: 'de' },
              { id: 'alba', name: 'Alba', provider: 'pocket', language: 'de' },
              { id: 'javert', name: 'Javert', provider: 'pocket', language: 'de' },
            ]
          : [],
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  if (url === `${location.origin}/api/v1/voice/tts`) {
    const payload = JSON.parse(String(init?.body)) as { text: string; voice_id?: string; speed: number }
    if (payload.text !== 'Projektzustand ist geladen.' || (payload.voice_id && payload.voice_id !== 'benni'))
      throw new Error('Only synthetic Benni/Piper samples are available.')
    requests.value.push(`Stimme: ${payload.voice_id || 'piper'} · Servertempo: ${payload.speed}`)
    return nativeFetch(`/.lmzdev/artifacts/temp/read-aloud/${payload.voice_id === 'benni' ? 'benni' : 'comment'}.wav`, {
      signal: init?.signal,
    })
  }
  throw new Error('Unexpected network request blocked')
}
createApp({
  render: () =>
    h('main', { class: 'ai-workspace', style: 'max-width:780px;margin:auto;padding:20px;min-height:100vh' }, [
      h('h1', 'V2-Stimmenauswahl · Prüfansicht'),
      h('p', 'Isolierter Katalog; Benni- und Piper-Hörprobe mit echtem WAV aus dem Sprachserver-Smoke.'),
      h(VoiceSettingsSection, {
        deviceKey: 'synthetic-fixture-key',
        voiceMode: 'push_to_talk',
        wakeWord: 'luczor',
        endPhrase: 'luczor stopp',
        continuousSilenceMs: 5000,
        autoSubmit: false,
        sttLanguage: 'de',
        voiceId: voiceId.value,
        'onUpdate:voiceId': (id: string) => {
          voiceId.value = id
        },
        testSpeech: (_text: string, signal?: AbortSignal, id?: string) =>
          streamSpeak('Projektzustand ist geladen.', { signal, voiceId: id, rate: 1.25 }),
      }),
      readAlongState.value ? h(ReadAloudText, { playback: readAlongState.value }) : null,
      h('output', { 'data-testid': 'selected-voice' }, `Auswahl: ${voiceId.value || 'piper'}`),
      h('pre', { 'data-testid': 'voice-requests', style: 'white-space:pre-wrap' }, requests.value.join('\n')),
      h(
        'button',
        {
          class: 'ai-button',
          onClick: () => {
            catalogAvailable = false
          },
        },
        'Leeren Katalog beim nächsten Aktualisieren liefern'
      ),
    ]),
}).mount('#app')
