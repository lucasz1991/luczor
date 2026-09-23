<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { projectExternalIdForServer } from '@/services/cloudProjectAccess'
import type { MemorySyncState } from '@/services/memory/memorySyncState'
import { memorySyncPanelData as services } from './memorySyncPanelData'

const props = defineProps<{ projectId: string }>()
const sync = ref<MemorySyncState[]>([])
const capture = ref<Awaited<ReturnType<typeof services.capture>> | null>(null)
const busy = ref(false)
const error = ref('')
const serverEnabled = ref(true)
let generation = 0
const coverage = computed(
  () =>
    capture.value?.coverage
      .filter(item => !props.projectId || item.projectId === props.projectId)
      .slice(-12)
      .reverse() ?? []
)
const receiptLabels = {
  canonical_erased: 'Auf dem Server entfernt',
  projection_pending: 'Server gelöscht; Suchindex wird bereinigt',
  complete: 'Server und Suchindex bereinigt',
  blocked: 'Server gelöscht; Suchindex benötigt einen neuen Versuch',
}
async function load() {
  const current = ++generation
  try {
    const enabled = await services.enabled()
    const account = await services.account()
    const status = await services.capture(account?.principalId ?? 'device-local')
    const identities = account
      ? [
          { expectedPrincipalId: account.principalId, serverInstance: account.serverInstance, scope: 'user' as const },
          ...(props.projectId
            ? [
                {
                  expectedPrincipalId: account.principalId,
                  serverInstance: account.serverInstance,
                  scope: 'project' as const,
                  projectId: projectExternalIdForServer(props.projectId, account.principalId),
                },
              ]
            : []),
        ]
      : []
    const states = await Promise.all(identities.map(identity => services.read(identity)))
    if (current !== generation) return
    serverEnabled.value = enabled
    capture.value = status
    sync.value = states
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : 'Speicherstatus nicht verfügbar.'
  }
}
async function resolve(snapshot: MemorySyncState, recordId: string, choice: 'keep_local' | 'use_server' | 'keep_both') {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await services.resolve(snapshot.identity, recordId, choice)
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Konflikt wurde inzwischen geändert.'
  } finally {
    busy.value = false
  }
}
async function synchronize() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await services.synchronize()
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Abgleich noch nicht vollständig.'
  } finally {
    busy.value = false
  }
}
function clear() {
  generation++
  sync.value = []
  capture.value = null
  error.value = ''
}
watch(
  () => props.projectId,
  () => {
    clear()
    void load()
  },
  { immediate: true }
)
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => void load(), 30_000)
})
window.addEventListener('luczor:api-identity-changing', clear)
window.addEventListener('luczor:api-identity-changed', load)
onBeforeUnmount(() => {
  generation++
  clearInterval(timer)
  window.removeEventListener('luczor:api-identity-changing', clear)
  window.removeEventListener('luczor:api-identity-changed', load)
})
</script>

<template>
  <section class="memory-sync-panel" aria-label="Gedächtniserfassung und Abgleich">
    <h3>Erfassung &amp; Abgleich</h3>
    <p v-if="capture">
      {{ capture.records.toLocaleString('de-DE') }} lokale Erinnerungen · {{ capture.deferred }} Auszüge zur
      Nachbearbeitung.
    </p>
    <p v-if="capture?.storageWarning" role="status">
      Die Warnschwelle von {{ capture.softLimit.toLocaleString('de-DE') }} Einträgen ist überschritten. Erinnerungen
      werden deshalb nicht gelöscht.
    </p>
    <p v-if="!serverEnabled">Servergedächtnis ausgeschaltet. Private lokale Erinnerungen bleiben auf diesem Gerät.</p>
    <button type="button" class="ai-button" :disabled="busy || !serverEnabled || !sync.length" @click="synchronize">
      {{ busy ? 'Wird verarbeitet …' : 'Jetzt synchronisieren' }}
    </button>
    <p v-if="error" role="alert">{{ error }}</p>
    <div v-for="snapshot in sync" :key="JSON.stringify(snapshot.identity)">
      <p v-if="snapshot.lastError" role="status">Abgleich offen: {{ snapshot.lastError }}</p>
      <p v-if="snapshot.capabilities && snapshot.capabilities.memory_change_feed !== 1">
        Dieser Server unterstützt den Änderungsfeed noch nicht.
      </p>
      <details v-for="conflict in snapshot.metadataConflicts" :key="conflict.recordId">
        <summary>
          Änderungskonflikt · {{ conflict.kind === 'remote_delete' ? 'Serverlöschung' : 'Neue Serverversion' }}
        </summary>
        <p>Lokal: {{ conflict.local.content }}</p>
        <p v-if="conflict.remote">Server: {{ conflict.remote.content }}</p>
        <pre>{{ JSON.stringify({ lokal: conflict.local.meta, server: conflict.remote?.meta }, null, 2) }}</pre>
        <p>Bei einer Serverlöschung bleibt „Lokal behalten“ als private Kopie auf diesem Gerät.</p>
        <div class="memory-sync-actions">
          <button
            type="button"
            class="ai-button"
            :disabled="busy"
            @click="resolve(snapshot, conflict.recordId, 'keep_local')"
          >
            Lokal behalten
          </button>
          <button
            type="button"
            class="ai-button"
            :disabled="busy"
            @click="resolve(snapshot, conflict.recordId, 'use_server')"
          >
            Server übernehmen
          </button>
          <button
            type="button"
            class="ai-button"
            :disabled="busy"
            @click="resolve(snapshot, conflict.recordId, 'keep_both')"
          >
            Lokale Kopie + Server
          </button>
        </div>
      </details>
      <details v-if="snapshot.deletionReceipts.length">
        <summary>Löschbelege ({{ snapshot.deletionReceipts.length }})</summary>
        <p v-for="receipt in snapshot.deletionReceipts" :key="receipt.id">{{ receiptLabels[receipt.status] }}</p>
      </details>
    </div>
    <details v-if="coverage.length">
      <summary>Erfassungsabdeckung der letzten Nachrichten</summary>
      <p v-for="item in coverage" :key="`${item.messageId}:${item.segmentId ?? ''}`">
        Nachricht {{ item.messageId.slice(0, 8) }}:
        {{ item.spans.filter(span => span.status === 'stored').length }} erfasst,
        {{ item.spans.filter(span => span.status === 'deferred').length }} ausstehend,
        {{ item.spans.filter(span => span.status === 'excluded').length }} bewusst ausgeschlossen.
      </p>
    </details>
  </section>
</template>

<style scoped>
.memory-sync-panel {
  border-top: 1px solid var(--ai-border);
  margin-top: 12px;
  padding-top: 12px;
  font-size: 12px;
}
.memory-sync-panel p {
  overflow-wrap: anywhere;
}
.memory-sync-panel pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 240px;
  overflow: auto;
}
.memory-sync-panel details {
  margin-top: 8px;
}
.memory-sync-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
