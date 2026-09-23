import { createApp, h, ref } from 'vue'
import MemorySyncPanel from '@/features/memory/MemorySyncPanel.vue'
import { memorySyncPanelData as data } from '@/features/memory/memorySyncPanelData'
import { emptyMemorySyncState } from '@/services/memory/memorySyncState'
import type { MemoryRecord } from '@/services/memory/luczorMemory'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

document.documentElement.setAttribute('data-theme', 'dark')
const resolutions = ref(0)
const base = {
  expectedPrincipalId: 'synthetic',
  serverInstance: 'fixture',
  scope: 'project' as const,
  projectId: 'fixture',
}
const local: MemoryRecord = {
  id: 'fixture-memory',
  principalId: 'synthetic',
  scope: 'project',
  dataset: 'fixture',
  content: 'Tests laufen vor dem Release.',
  contentHash: 'fixture',
  type: 'note',
  visibility: 'syncable',
  retention: 'durable',
  sensitivity: 'normal',
  status: 'active',
  writeIntent: 'explicit',
  importance: 0.8,
  confidence: 0.6,
  source: 'user',
  tags: ['Tests'],
  createdAt: 1,
  updatedAt: 2,
  meta: { category: 'Entwicklung/Prüfung' },
}
let state = {
  ...emptyMemorySyncState(base),
  capabilities: { memory_change_feed: 1 },
  metadataConflicts: [
    {
      recordId: local.id,
      kind: 'remote_update' as const,
      local,
      remote: { ...local, importance: 0.9, meta: { category: 'Qualität/Tests' } },
      at: 3,
    },
  ],
  deletionReceipts: [{ id: 'receipt-fixture', status: 'projection_pending' as const, canonical_erased: true }],
}
data.account = async () => ({
  principalId: 'synthetic',
  serverInstance: 'fixture',
  serverOrigin: 'fixture',
  accountId: 1,
  config: { baseUrl: '', deviceKey: '', clientId: '' },
})
data.enabled = async () => true
data.capture = async () => ({
  records: 5020,
  softLimit: 5000,
  storageWarning: true,
  deferred: 42,
  coverage: [
    {
      ...base,
      principalId: 'synthetic',
      projectId: 'fixture',
      conversationId: 'conversation',
      messageId: 'message-50',
      sourceLength: 500,
      updatedAt: 4,
      spans: [
        { start: 0, end: 80, status: 'stored' },
        { start: 80, end: 500, status: 'deferred' },
      ],
    },
  ],
})
data.read = async identity => (identity.scope === 'project' ? state : emptyMemorySyncState(identity))
data.resolve = async () => {
  resolutions.value++
  state = { ...state, metadataConflicts: [] }
  return state
}
data.synchronize = async () => 0
createApp({
  setup: () => () =>
    h(
      'main',
      { style: 'max-width:420px;margin:24px auto;padding:20px;color:var(--ai-fg);background:var(--ai-panel)' },
      [
        h('h1', 'Gedächtnisstatus'),
        h('p', 'Synthetische Prüfung · keine echten Daten'),
        h(MemorySyncPanel, { projectId: 'fixture' }),
        h('p', { role: 'status' }, `Auflösungen: ${resolutions.value}`),
      ]
    ),
}).mount('#app')
