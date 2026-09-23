import { createApp, h, reactive, ref } from 'vue'
import { emptyMiniSnapshot, type MiniAction, type MiniMessage } from '@/services/miniChat/types'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'
import '@/styles/liquid-glass.css'

// Presentation-only test data: no model, microphone or actual tool is started here.
const snapshot = reactive({
  ...emptyMiniSnapshot(),
  view: 'chat' as 'chat' | 'workspace',
  sessionId: 'preview-a',
  conversationId: 'a',
  project: { id: 'preview', name: 'Website' },
  projects: [
    { id: 'preview', name: 'Website', messageCount: 0, updatedAt: 1 },
    { id: 'free', name: 'Chat ohne Projekt', messageCount: 0, updatedAt: 1 },
  ],
  conversations: [
    { id: 'a', title: 'Entwurf besprechen', busy: false },
    { id: 'b', title: 'Sehr langer Chatname für die Planung der nächsten gemeinsamen Schritte', busy: false },
  ],
})
const connectionError = ref('')
const lastAction = ref('Keine Aktion')
const history = new Map<string, MiniMessage[]>()
let stream: ReturnType<typeof setInterval> | undefined
const stop = () => {
  clearInterval(stream)
  snapshot.busy = false
  snapshot.decision = null
  for (const message of snapshot.messages) if (message.status === 'running') message.status = 'canceled'
  snapshot.revision++
}
function action(value: MiniAction) {
  lastAction.value = value.type
  if (value.type === 'view') {
    snapshot.view = value.view
    snapshot.sessionId = crypto.randomUUID()
  } else if (
    value.type === 'select_conversation' ||
    value.type === 'select_project' ||
    value.type === 'new_conversation'
  ) {
    stop()
    history.set(`${snapshot.project.id}:${snapshot.conversationId}`, [...snapshot.messages])
    if (value.type === 'select_project')
      snapshot.project = snapshot.projects.find(project => project.id === value.projectId)!
    snapshot.conversationId =
      value.type === 'select_conversation'
        ? value.conversationId
        : value.type === 'new_conversation'
          ? crypto.randomUUID()
          : 'a'
    if (value.type === 'new_conversation')
      snapshot.conversations.push({ id: snapshot.conversationId, title: 'Neuer Chat', busy: false })
    snapshot.sessionId = crypto.randomUUID()
    snapshot.messages = history.get(`${snapshot.project.id}:${snapshot.conversationId}`) ?? []
  } else if (value.type === 'stop') stop()
  else if (value.type === 'thinking_tier') snapshot.thinkingTier = value.tier
  else if (value.type === 'mode') snapshot.mode = value.mode
  else if (value.type === 'send') {
    stop()
    snapshot.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: value.text,
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
    snapshot.messages.push(answer)
    snapshot.busy = true
    snapshot.revision++
    const parts = [
      'Ich schaue mir deinen Entwurf an. ',
      'Wir können die Navigation vereinfachen ',
      'und die wichtigsten Aktionen direkt erreichbar machen.\n\n',
      'Als Nächstes prüfen wir die Darstellung in einem kleinen Fenster.',
    ]
    stream = setInterval(() => {
      answer.content += parts.shift() ?? ''
      if (!parts.length) {
        clearInterval(stream)
        answer.status = 'done'
        answer.choices = ['Navigation prüfen', 'Darstellung ansehen']
        snapshot.busy = false
      }
      snapshot.revision++
    }, 1100)
  } else if (value.type === 'decide') {
    lastAction.value = value.approved ? 'Freigegeben' : 'Abgelehnt'
    stop()
  }
}
function approval() {
  stop()
  snapshot.busy = true
  snapshot.decision = {
    id: 'preview-approval',
    kind: 'tool',
    title: 'Änderung speichern?',
    description: 'Die Beispieldatei notes.md im Projekt aktualisieren.',
    detail: 'Synthetische Freigabe. Es wird keine Datei geändert.',
  }
}
function longChat() {
  stop()
  snapshot.messages = Array.from({ length: 8 }, (_, index) => ({
    id: `long-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content:
      index % 2
        ? '## Vorschlag\n\nEine kompakte Navigation schafft Platz für die Unterhaltung.\n\n' +
          'Dieser längere Beispielabsatz prüft den unabhängigen Bildlauf und den Zeilenumbruch. '.repeat(6)
        : 'Prüfe bitte die Navigation und das Layout.',
    choices: [],
    createdAt: 1,
    status: 'done',
  }))
}
async function mountPreview() {
  const host = document.getElementById('app')
  if (host) host.textContent = 'Mini-Komponente wird geladen …'
  const { default: MiniChatSurface } = await import('@/components/mini/MiniChatSurface.vue')
  createApp({
    render: () =>
      h(
        'main',
        {
          style: 'padding:18px;min-height:100vh;background:var(--ai-page);color:var(--ai-ink);font:12px var(--ai-font)',
        },
        [
          h('p', 'Synthetische Designprüfung · Keine echten Läufe'),
          h('nav', { style: 'display:flex;gap:10px;flex-wrap:wrap;max-width:450px' }, [
            h('button', { onClick: () => (document.documentElement.dataset.theme = 'light') }, 'Hell'),
            h('button', { onClick: () => (document.documentElement.dataset.theme = 'dark') }, 'Dunkel'),
            h(
              'button',
              {
                onClick: () => {
                  stop()
                  snapshot.messages = []
                },
              },
              'Leerer Chat'
            ),
            h('button', { onClick: approval }, 'Freigabe simulieren'),
            h('button', { onClick: longChat }, 'Langer Verlauf'),
            h(
              'button',
              {
                onClick: () =>
                  (connectionError.value = connectionError.value
                    ? ''
                    : 'Verbindung unterbrochen. Bitte erneut verbinden.'),
              },
              'Verbindung umschalten'
            ),
          ]),
          h('p', { role: 'status' }, `Letzte Aktion: ${lastAction.value}`),
          h(MiniChatSurface, {
            snapshot,
            connectionError: connectionError.value,
            onAction: action,
            onHide: () => (lastAction.value = 'Ausgeblendet'),
            onShowMain: () => (lastAction.value = 'Hauptfenster'),
          }),
        ]
      ),
  }).mount('#app')
}
void mountPreview().catch(error => {
  console.error('Mini preview failed:', error)
  const host = document.getElementById('app')
  if (host) host.textContent = `Prüfvorschau konnte nicht geladen werden: ${String(error)}`
})
