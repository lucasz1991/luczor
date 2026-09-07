// Local, explicitly synthetic browser fixture. Not an application entry point.
import { createApp, h, reactive } from 'vue'
import MiniChatSurface from '@/components/mini/MiniChatSurface.vue'
import { createMiniChatController } from '@/services/miniChat/controller'
import type { MiniAction, MiniMessage } from '@/services/miniChat/types'
import { createMiniChatBridge, type MiniChatBinding } from '@/services/miniChat/bridge'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const projects = [
  { id: 'fixture', name: 'Website · Beispieldaten', messageCount: 1, updatedAt: Date.now() },
  { id: 'fixture-code', name: 'Desktop-App · Beispieldaten', messageCount: 1, updatedAt: Date.now() },
]
const history = new Map<string, MiniMessage[]>(
  projects.map(project => [
    project.id,
    reactive([
      {
        id: `${project.id}-hello`,
        role: 'assistant' as const,
        content: `Dies ist der gemeinsame Projektchat für ${project.name}. Nachrichten aus dem Mini erscheinen auch hier.`,
        choices: [],
        createdAt: Date.now(),
        status: 'done' as const,
      },
    ]),
  ])
)
const chat = reactive<MiniChatBinding>({
  key: 'fixture',
  project: projects[0]!,
  messages: history.get('fixture')!,
  tools: [],
  busy: false,
})
let chatAbort: AbortController | undefined
const controller = createMiniChatController({
  followProject: true,
  context: () => ({ project: chat.project, mode: 'act', mainBusy: chat.busy }),
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
const bridge = createMiniChatBridge(controller, {
  projects: () => projects,
  chat: () => chat,
  selectProject(id) {
    chat.project = projects.find(project => project.id === id)!
    chat.key = id
    chat.messages = history.get(id)!
  },
  async sendChat(text, projectId) {
    if (projectId !== chat.project?.id || chat.busy) return
    chatAbort = new AbortController()
    const signal = chatAbort.signal
    chat.busy = true
    chat.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      choices: [],
      createdAt: Date.now(),
      status: 'done',
    })
    const answer = reactive<MiniMessage>({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      choices: [],
      createdAt: Date.now(),
      status: 'running',
    })
    chat.messages.push(answer)
    try {
      for (const part of [
        'Die Nachricht ist ',
        'im gemeinsamen Projektchat angekommen. ',
        'Großes Fenster und Mini zeigen denselben Verlauf.',
      ]) {
        await pause(400)
        if (signal.aborted) {
          answer.status = 'canceled'
          answer.content ||= 'Abgebrochen.'
          return
        }
        answer.content += part
      }
      answer.status = 'done'
    } finally {
      chat.busy = false
    }
  },
  stopChat() {
    chatAbort?.abort()
  },
  openPanel(panel) {
    controller.state.notice = `Prüfvorschau: ${panel} würde im Hauptfenster geöffnet.`
  },
})
const action = (value: MiniAction) => {
  if (value.type === 'kill_switch') controller.state.hud.killSwitch = value.enabled
  else void bridge.dispatch(value)
}
createApp({
  render: () =>
    h(
      'main',
      {
        class: 'ai-workspace',
        style:
          'min-height:100vh;display:block;background:var(--ai-page);padding:48px;color:var(--ai-ink);font-family:var(--ai-font)',
      },
      [
        h('h1', { style: 'font-size:26px' }, 'Luczor Mini · Browserprüfung'),
        h('p', 'Explizite Beispieldaten. Kein Modell, Mikrofon oder echtes Tool wird aufgerufen.'),
        h('p', 'Projektchat und Workspace wechseln; Nachricht im gemeinsamen Verlauf prüfen.'),
        h('section', { style: 'max-width:560px;margin-top:64px' }, [
          h('h2', { style: 'font-size:20px;margin-bottom:24px' }, `Großer Projektchat · ${chat.project?.name}`),
          ...chat.messages.map(message =>
            h('article', { style: 'padding:16px 0;border-bottom:1px solid var(--ai-line)' }, [
              h('small', message.role === 'user' ? 'Du' : 'Luczor'),
              h('p', message.content),
            ])
          ),
        ]),
        h(MiniChatSurface, { snapshot: bridge.snapshot.value, onAction: action }),
      ]
    ),
}).mount('#app')
