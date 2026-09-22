// Synthetic view fixture: actual components, no account, native calls or model traffic.
import { createApp, h, ref } from 'vue'
import ContextInspector from '@/components/ContextInspector.vue'
import AutonomousGoalControl from '@/components/projects/AutonomousGoalControl.vue'
import type { ContextSnapshot } from '@/services/contextInspector'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

const scopeKey = {
  principalId: 'fixture',
  serverInstance: 'fixture',
  projectId: 'fixture',
  sessionId: 'fixture-run',
  taskType: 'coding',
}
const fragments: ContextSnapshot['fragments'] = [
  {
    id: 'project-goal',
    source: 'project',
    content: 'Die Dateisuche verbessern und das Ergebnis prüfen.',
    scope: 'project',
    trust: 'user_confirmed',
    egress: 'allowed',
    priority: 90,
  },
  {
    id: 'repository-src-search-ts',
    source: 'repository',
    content: 'src/search.ts · Zeilen 420–424\nexport function findSymbol(name: string) { return index.get(name) }',
    scope: 'project',
    trust: 'untrusted_data',
    egress: 'local_only',
    priority: 80,
  },
  {
    id: 'session-memory-candidate:fixture',
    source: 'history',
    content: 'Unbestätigter Auszug dieses Chats: Die Dateisuche soll auch Symbole am Dateiende finden.',
    scope: 'session',
    trust: 'untrusted_data',
    egress: 'local_only',
    priority: 70,
  },
]
const snapshot: ContextSnapshot = {
  kind: 'run',
  at: Date.now(),
  projectId: 'fixture',
  conversationId: 'fixture-chat',
  taskType: 'coding',
  prompt: 'Bitte weiterarbeiten.',
  fragments,
  local: {
    target: 'local_llama_cpp',
    scopeKey,
    text: fragments.map(item => item.content).join('\n'),
    selected: fragments.map(item => ({ id: item.id, contentHash: 'fixture' })),
    omitted: [],
    charCount: 392,
    budget: { maxChars: 16000, maxFragments: 24, maxFragmentChars: 4000 },
  },
  external: {
    target: 'laravel_proxy',
    scopeKey,
    text: fragments[0]!.content,
    selected: [{ id: 'project-goal', contentHash: 'fixture' }],
    omitted: fragments.slice(1).map(item => ({ id: item.id, reason: 'local_only' })),
    charCount: 58,
    budget: { maxChars: 16000, maxFragments: 24, maxFragmentChars: 4000 },
  },
  retrieval: {
    repositoryDiagnostics: {
      status: 'ready',
      queryCount: 3,
      contextual: true,
      matchedFiles: 5,
      selectedFiles: 2,
      materializedFiles: 2,
      relationCount: 4,
      omittedFiles: 0,
      omissionReasons: [],
    },
    memoryDiagnostics: { enabled: true, active: 2, conversationExcerpts: 1, contextual: true },
  },
}
const goal = ref({
  text: 'Dateisuche verbessern und mit einem langen Beispiel prüfen.',
  active: true,
  status: 'running' as const,
  revision: 1,
  iterations: 4,
  phase: 'work' as const,
  progress: 'Passende Symbole gefunden; Prüfung läuft mit erhaltenem Arbeitskontext.',
  updatedAt: Date.now(),
})
createApp({
  render() {
    return h('main', { style: 'max-width:820px;margin:auto;padding:24px;color:var(--ai-ink)' }, [
      h('h1', 'Arbeitskontext'),
      h('p', 'Synthetische Ansicht zur Prüfung der echten Kontext- und Zielsteuerung.'),
      h(ContextInspector, { snapshot, emptyHint: 'Noch kein Kontext vorhanden.' }),
      h(AutonomousGoalControl, {
        model: goal.value,
        onToggle: (active: boolean) => {
          goal.value.active = active
        },
        onSave: (text: string) => {
          goal.value.text = text
        },
      }),
    ])
  },
}).mount('#app')
