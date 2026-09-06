// Local, explicitly synthetic browser fixture. Not an application entry point.
import { createApp, h } from 'vue'
import MiniChatSurface from '@/components/mini/MiniChatSurface.vue'
import { createMiniChatController } from '@/services/miniChat/controller'
import type { MiniAction } from '@/services/miniChat/types'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const controller = createMiniChatController({
  context: () => ({ project: { id: 'fixture', name: 'Lokale Beispieldaten' }, mode: 'act', mainBusy: false }),
  setMode: () => {},
  preamble: () => 'Synthetische UI-Prüfung',
  run: async options => {
    options.onProgress?.({ phase: 'thinking', round: 1 })
    await pause(900)
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    options.onProgress?.({ phase: 'receiving', round: 1, characters: 420 })
    options.toolSession!.queue({
      id: 'fixture-call',
      name: 'Beispielentscheidung',
      args: { aktion: 'Nur diese Vorschau bestätigen; kein Tool wird ausgeführt.' },
      category: 'app',
      requiresApproval: true,
      status: 'proposed',
    })
    const approved = await options.toolSession!.approve('fixture-call')
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    options.toolSession!.update('fixture-call', approved ? 'executing' : 'rejected')
    await pause(1100)
    options.toolSession!.update('fixture-call', approved ? 'executed' : 'rejected')
    const finalText = JSON.stringify({
      summary: approved
        ? 'Die Vorschau ist bestätigt. Der echte Mini-Chat verwendet dieselben Freigaberegeln wie das Hauptfenster.'
        : 'Abgelehnt. Die Beispielaktion wurde nicht ausgeführt.',
      question: 'Was möchtest du als Nächstes ansehen?',
      bullets: ['Noch eine Vorschau', 'Eine kurze Antwort'],
    })
    options.onToken?.(finalText)
    return { finalText }
  },
})
const action = (value: MiniAction) => {
  if (value.type === 'kill_switch') controller.state.hud.killSwitch = value.enabled
  else void controller.dispatch(value)
}
createApp({
  render: () =>
    h('main', { style: 'min-height:100vh;background:#0c111b;padding:48px;color:#d4deec;font-family:Segoe UI' }, [
      h('h1', { style: 'font-size:26px' }, 'Luczor Mini · Browserprüfung'),
      h('p', 'Explizite Beispieldaten. Kein Modell, Mikrofon oder echtes Tool wird aufgerufen.'),
      h('p', 'Chat öffnen, Nachricht senden und Vorschauentscheidung bestätigen oder ablehnen.'),
      h(MiniChatSurface, { snapshot: controller.state, onAction: action }),
    ]),
}).mount('#app')
