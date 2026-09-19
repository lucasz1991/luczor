// Synthetic UI acceptance only; updates never touch a real account or memory store.
import { createApp, h, ref } from 'vue'
import MemoryMetadataEditor from '@/features/memory/MemoryMetadataEditor.vue'
import { memoryExplorerData } from '@/features/memory/explorerData'
import { applyMemoryAnnotation, captureMemoryMetadata, memoryMetadataOf } from '@/services/memory/memoryMetadata'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

document.documentElement.setAttribute('data-theme', 'dark')
let stored = {
  id: 'synthetic-memory',
  content: 'Ich interessiere mich für Laravel. Vor Deployments immer Tests ausführen. Siehe `src/Deployment.php`.',
  source: 'user',
  importance: 0.8,
  tags: ['Laravel', 'Tests'],
  meta: {
    memory_metadata: captureMemoryMetadata({
      content: 'Ich interessiere mich für Laravel. Vor Deployments immer Tests ausführen. Siehe `src/Deployment.php`.',
      source: 'user',
      projectId: 'synthetic-project',
      origin: { messageId: 'synthetic-message', role: 'user', conversationId: 'synthetic-chat' },
      now: 1790000000000,
    }),
  },
}
let revision = 1
const view = () => ({
  id: stored.id,
  importance: stored.importance,
  tags: stored.tags,
  metadata: memoryMetadataOf(stored),
  metadataRevision: String(revision),
})
const record = ref(view())
const saved = ref(0)
memoryExplorerData.updateMetadata = async (id, patch, expectedRevision) => {
  if (id !== stored.id || expectedRevision !== String(revision)) throw new Error('stale_memory')
  const change = applyMemoryAnnotation(stored, patch, { origin: 'user' })
  stored = { ...stored, ...change } as typeof stored
  revision++
  return stored as never
}
createApp({
  setup() {
    return () =>
      h(
        'main',
        { style: 'max-width:420px;margin:32px auto;padding:24px;color:#e8e8ee;background:#191a20;border-radius:12px' },
        [
          h('h1', { style: 'font-size:20px' }, 'Erinnerung einordnen'),
          h('p', { style: 'font-size:12px' }, 'Synthetische Prüfung · keine echten Erinnerungen'),
          h(MemoryMetadataEditor, {
            record: record.value,
            onSaved: () => {
              saved.value++
              record.value = view()
            },
          }),
          h('p', { role: 'status' }, `Gespeicherte Korrekturen: ${saved.value}`),
          h(
            'button',
            {
              class: 'ai-button',
              onClick: () => {
                revision++
                record.value = view()
              },
            },
            'Parallele Änderung simulieren'
          ),
        ]
      )
  },
}).mount('#app')
