<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { RepositoryGraphPage } from '@/services/repositoryGraph'
import { memoryExplorerData } from './explorerData'
import { assistantProfileState } from '@/services/assistantProfile'
import MemoryGraphView from './MemoryGraphView.vue'
import MemoryDreamPanel from './MemoryDreamPanel.vue'
import { buildMemoryGraph, MEMORY_SYSTEMS, type MemoryInventory, type MemoryNode } from './graph'
import { loadMemoryGraphDisplay, memoryGraphDisplay } from './graphDisplay'
import { dreamEffects, dreamNodeId, dreamTrace } from '@/services/memory/dreamTrace'
import type { PreparedContextArtifact } from '@/services/memory/maintenance'
const props = defineProps<{ projects: Array<{ id: string; name: string }>; projectId: string }>()
const emit = defineEmits<{ close: []; settings: [] }>()
const heading = ref<HTMLElement | null>(null)
const project = ref(props.projectId)
const query = ref('')
const system = ref('')
const selected = ref('system:0')
const inventory = shallowRef<MemoryInventory | null>(null)
const repo = shallowRef<RepositoryGraphPage | null>(null)
const remote = shallowRef<MemoryNode[]>([])
const artifacts = shallowRef<PreparedContextArtifact[]>([])
const offset = ref(0),
  repoOffset = ref(0)
const loading = ref(false),
  remoteLoading = ref(false)
const notice = ref(''),
  remoteNotice = ref('')
let epoch = 0
let disposed = false
let identityChanging = false
function clear() {
  epoch++
  inventory.value = null
  repo.value = null
  remote.value = []
  artifacts.value = []
  selected.value = 'system:0'
  notice.value = ''
  remoteNotice.value = ''
  loading.value = false
  remoteLoading.value = false
}
const identityChange = () => {
  identityChanging = true
  clear()
  notice.value = 'Konto wird gewechselt. Daten wurden ausgeblendet.'
}
const identityChanged = () => {
  identityChanging = false
  void load()
}
/** Nodes that appeared or vanished with the last idle commit; shown briefly as born/ghost nodes. */
const transient = shallowRef<{ born: Set<string>; ghosts: MemoryNode[]; until: number }>({
  born: new Set(),
  ghosts: [],
  until: 0,
})
let transientTimer: ReturnType<typeof setTimeout> | undefined
function markTransient(previous: MemoryNode[], next: MemoryNode[]) {
  const before = new Map(previous.map(node => [node.id, node]))
  const after = new Set(next.map(node => node.id))
  const born = new Set(next.filter(node => node.kind !== 'System' && !before.has(node.id)).map(node => node.id))
  const ghosts = previous
    .filter(node => node.kind !== 'System' && !after.has(node.id) && node.system === 'Erinnerungen')
    .map(node => ({
      ...node,
      state: 'removed' as const,
      detail: `${node.detail}\n\nDurch die Leerlauf-Pflege ersetzt.`,
    }))
  if (!born.size && !ghosts.length) return
  transient.value = { born, ghosts, until: Date.now() + 8000 }
  if (transientTimer) clearTimeout(transientTimer)
  transientTimer = setTimeout(() => {
    transient.value = { born: new Set(), ghosts: [], until: 0 }
  }, 8000)
}

async function load(options: { soft?: boolean } = {}) {
  if (identityChanging || disposed) return
  const request = ++epoch
  const previous = options.soft ? baseGraph.value.nodes : []
  loading.value = true
  notice.value = ''
  remote.value = []
  remoteNotice.value = ''
  remoteLoading.value = false
  if (!options.soft) {
    inventory.value = null
    repo.value = null
  }
  try {
    const account = await memoryExplorerData.account()
    const [memories, graph, contexts] = await Promise.allSettled([
      memoryExplorerData.inventory({ query: query.value, offset: offset.value, limit: 80 }),
      account && project.value
        ? memoryExplorerData.graph(account.principalId, project.value, query.value, repoOffset.value)
        : Promise.reject(new Error('No verified project')),
      account ? memoryExplorerData.artifacts(account.principalId, project.value) : [],
    ])
    const current = await memoryExplorerData.account()
    if (disposed || epoch !== request || current?.principalId !== account?.principalId) return
    inventory.value = memories.status === 'fulfilled' ? memories.value : null
    repo.value = graph.status === 'fulfilled' ? graph.value : null
    artifacts.value = contexts.status === 'fulfilled' ? contexts.value : []
    if (options.soft) markTransient(previous, baseGraph.value.nodes)
    const messages = []
    if (memories.status === 'rejected') messages.push('Lokale Erinnerungen nicht verfügbar.')
    if (graph.status === 'rejected')
      messages.push(
        'Repo-Graph nicht verfügbar: verifiziertes Konto, verbundenes Repository und aktuelle Desktop-Version erforderlich.'
      )
    notice.value = messages.join(' ')
  } catch {
    if (request === epoch) notice.value = 'Daten konnten nicht geladen werden. Konto prüfen und erneut laden.'
  } finally {
    if (request === epoch) loading.value = false
  }
}
async function sharedSearch() {
  if (!query.value.trim() || remoteLoading.value || identityChanging) return
  const request = epoch
  remoteLoading.value = true
  remote.value = []
  remoteNotice.value = ''
  try {
    const account = await memoryExplorerData.account()
    if (!account) throw new Error('No verified account')
    const records = await memoryExplorerData.recall({
      origin: 'inspector',
      scope: 'project',
      projectId: project.value,
      query: query.value.slice(0, 256),
      limit: 20,
    })
    const current = await memoryExplorerData.account()
    if (disposed || request !== epoch || current?.principalId !== account.principalId) return
    remote.value = records.map(record => ({
      id: `shared:${record.id}`,
      label: record.content.slice(0, 72),
      system: 'SQL / Cognee',
      kind: 'Abruf-Treffer',
      detail: `${record.content.slice(0, 4000)}\n\nQuelle: ${record.source} · ${record.scope}\nKanonischer Abruf mit möglichem lokalem/SQL-Fallback. Kein Nachweis einer Cognee-Kante.`,
    }))
    remoteNotice.value = `${records.length} Treffer im gewählten Projekt (maximal 20); kein vollständiger Server-Export.`
  } catch {
    if (request === epoch)
      remoteNotice.value = 'Gemeinsamer Abruf nicht verfügbar. Anmeldung und Memory-Einstellungen prüfen.'
  } finally {
    if (request === epoch) remoteLoading.value = false
  }
}
const baseGraph = computed(() =>
  buildMemoryGraph(inventory.value, repo.value, assistantProfileState.profile, artifacts.value)
)
const graph = computed(() => {
  const data = baseGraph.value
  const born = transient.value.born
  const nodes = [
    ...data.nodes.map(node => (born.has(node.id) ? { ...node, state: 'born' as const } : node)),
    ...remote.value,
    ...transient.value.ghosts,
  ]
  const edges = [
    ...data.edges,
    ...remote.value.map(node => ({ from: 'system:3', to: node.id, kind: 'Abrufzuordnung', grouping: true })),
    ...transient.value.ghosts.map(node => ({ from: 'system:0', to: node.id, kind: 'ersetzt', grouping: true })),
  ]
  const visible = nodes.filter(node => !system.value || node.system === system.value)
  const ids = new Set(visible.map(node => node.id))
  return { nodes: visible, edges: edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)) }
})
// Dream state drives node animations; a ticking clock lets finished runs fade out of the view.
const dreamClock = ref(Date.now())
let dreamTimer: ReturnType<typeof setInterval> | undefined
const dream = computed(() => {
  void dreamClock.value
  return dreamEffects(dreamTrace.value)
})
const dreamNodeIds = computed(() => new Set(graph.value.nodes.map(node => node.id)))
function focusDreamTarget(target: { kind: 'memory' | 'file' | 'artifact' | 'source'; id: string }) {
  const id = dreamNodeId(target)
  if (dreamNodeIds.value.has(id)) selected.value = id
}
const memoryChanged = (event: Event) => {
  const origin = (event as CustomEvent<{ origin?: string }>).detail?.origin
  if (origin === 'idle' && !loading.value) void load({ soft: true })
}
const detail = computed(() => graph.value.nodes.find(node => node.id === selected.value))
watch(system, () => {
  selected.value = graph.value.nodes[0]?.id ?? ''
})
watch(project, () => {
  offset.value = 0
  repoOffset.value = 0
  clear()
  void load()
})
watch(
  () => props.projectId,
  id => {
    project.value = id
  }
)
function search() {
  offset.value = 0
  repoOffset.value = 0
  void load()
}
function page(kind: 'memory' | 'repo', direction: number) {
  if (kind === 'memory') offset.value = Math.max(0, offset.value + direction * 80)
  else repoOffset.value = Math.max(0, repoOffset.value + direction * 40)
  void load()
}
onMounted(() => {
  void nextTick(() => heading.value?.focus())
  window.addEventListener('luczor:api-identity-changing', identityChange)
  window.addEventListener('luczor:api-identity-changed', identityChanged)
  window.addEventListener('luczor:memory-changed', memoryChanged)
  dreamTimer = setInterval(() => {
    dreamClock.value = Date.now()
  }, 2000)
  void loadMemoryGraphDisplay()
  void load()
})
onBeforeUnmount(() => {
  disposed = true
  epoch++
  if (dreamTimer) clearInterval(dreamTimer)
  if (transientTimer) clearTimeout(transientTimer)
  window.removeEventListener('luczor:api-identity-changing', identityChange)
  window.removeEventListener('luczor:api-identity-changed', identityChanged)
  window.removeEventListener('luczor:memory-changed', memoryChanged)
})
</script>
<template>
  <main class="main-col memory-page">
    <header class="memory-page__header">
      <div>
        <p class="memory-page__eyebrow">LUCZOR / WISSEN &amp; KONTEXT</p>
        <h1 ref="heading" tabindex="-1">Gedächtnis</h1>
        <p>Erinnerungen, Persönlichkeit und Repository-Evidenz an einem Ort.</p>
      </div>
      <div class="memory-page__header-actions">
        <button type="button" class="ai-button" @click="emit('settings')">Projekteinstellungen</button>
        <button type="button" class="ai-button" @click="emit('close')">Zurück zum Chat</button>
      </div>
    </header>
    <form class="memory-page__filters" @submit.prevent="search">
      <label
        >Repository / Server-Projekt<select v-model="project">
          <option value="">Kein Projekt</option>
          <option v-for="item in projects" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select></label
      >
      <label
        >System<select v-model="system">
          <option value="">Alle Systeme</option>
          <option v-for="item in MEMORY_SYSTEMS" :key="item">{{ item }}</option>
        </select></label
      >
      <label class="memory-page__search"
        >Lokale Daten / Dateipfad durchsuchen<input
          v-model="query"
          maxlength="256"
          placeholder="Erinnerung oder Datei …"
      /></label>
      <button type="submit" class="ai-button" :disabled="loading">{{ loading ? 'Lädt …' : 'Aktualisieren' }}</button>
    </form>
    <p class="memory-page__scope">
      Erinnerungen: alle Bereiche des aktuellen Kontos auf diesem Gerät. Repo und Server-Abruf: ausgewähltes Projekt.
      Öffnen startet nichts; die Leerlauf-Pflege lässt sich unten bewusst anstoßen.
    </p>
    <p v-if="notice" role="status" class="memory-page__notice">{{ notice }}</p>
    <div class="memory-page__body" :aria-busy="loading">
      <section class="memory-page__map" aria-label="Gedächtniskarte">
        <div class="memory-page__map-title">
          <h2>3D-Wissensraum</h2>
          <span
            >{{ graph.nodes.length }} sichtbare Knoten ·
            {{ graph.edges.filter(edge => !edge.grouping).length }} gespeicherte Beziehungen</span
          >
        </div>
        <MemoryGraphView
          :graph="graph"
          :selected="selected"
          :dream="dream"
          :display="memoryGraphDisplay"
          @select="selected = $event"
        />
        <MemoryDreamPanel :dream="dream" :trace="dreamTrace" :project-id="project" @focus="focusDreamTarget" />
        <div class="memory-page__pages">
          <div>
            <span
              >Erinnerungen {{ inventory?.records.length ? offset + 1 : 0 }}–{{
                offset + (inventory?.records.length ?? 0)
              }}
              / {{ inventory?.filtered ?? '—' }}</span
            ><button
              type="button"
              :disabled="loading || !offset"
              aria-label="Vorherige Erinnerungen"
              @click="page('memory', -1)"
            >
              ←</button
            ><button
              type="button"
              :disabled="loading || !inventory || offset + 80 >= inventory.filtered"
              aria-label="Weitere Erinnerungen"
              @click="page('memory', 1)"
            >
              →
            </button>
          </div>
          <div>
            <span
              >Repo-Dateien {{ repo?.files.length ? repoOffset + 1 : 0 }}–{{ repoOffset + (repo?.files.length ?? 0) }} /
              {{ repo?.total ?? '—' }}</span
            ><button
              type="button"
              :disabled="loading || !repoOffset"
              aria-label="Vorherige Repo-Dateien"
              @click="page('repo', -1)"
            >
              ←</button
            ><button
              type="button"
              :disabled="loading || !repo || repoOffset + 40 >= repo.total"
              aria-label="Weitere Repo-Dateien"
              @click="page('repo', 1)"
            >
              →
            </button>
          </div>
        </div>
        <details class="memory-page__remote">
          <summary>SQL / Cognee: gemeinsame Erinnerungen durchsuchen</summary>
          <p>
            Sendet den oben eingegebenen Suchtext über die vorhandene Memory-Schnittstelle. Private lokale Inhalte
            werden nicht hochgeladen. Die Desktop-API stellt keinen vollständigen Cognee-Graphen bereit.
          </p>
          <button
            type="button"
            class="ai-button"
            :disabled="!project || !query.trim() || loading || remoteLoading"
            @click="sharedSearch"
          >
            {{ remoteLoading ? 'Sucht …' : 'Suchtext an Memory-Dienst senden' }}
          </button>
          <p v-if="remoteNotice" role="status">{{ remoteNotice }}</p>
        </details>
      </section>
      <aside class="memory-page__inspector" aria-label="Einträge und Details">
        <h2>{{ detail?.kind ?? 'Inspektor' }}</h2>
        <h3>{{ detail?.label ?? 'Eintrag auswählen' }}</h3>
        <p class="memory-page__detail">{{ detail?.detail ?? 'Knoten in der Karte oder Liste auswählen.' }}</p>
        <h2>Einträge dieser Ansicht</h2>
        <p v-if="!loading && graph.nodes.every(node => node.kind === 'System')" class="memory-page__scope">
          Keine passenden Dateneinträge geladen. Die Systemknoten sind die Legende, keine gespeicherten Erinnerungen.
        </p>
        <div class="memory-page__list">
          <button
            v-for="node in graph.nodes"
            :key="node.id"
            type="button"
            :aria-pressed="selected === node.id"
            @click="selected = node.id"
          >
            <span>{{ node.label }}</span
            ><small>{{ node.system }} · {{ node.kind }}</small>
          </button>
        </div>
      </aside>
    </div>
  </main>
</template>
<style scoped>
.memory-page {
  container-type: inline-size;
  padding: 24px;
  overflow: auto;
  min-width: 0;
  color: var(--ai-ink);
  background: var(--ai-page);
  font: 13px/1.5 var(--ai-font);
}
.memory-page__header {
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}
.memory-page__header-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
h1,
h2,
h3,
p {
  margin: 0;
}
h1 {
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.03em;
}
h2 {
  font-size: 14px;
  font-weight: 600;
}
h3 {
  font-size: 16px;
  margin: 8px 0;
  overflow-wrap: anywhere;
}
.memory-page__eyebrow {
  color: var(--ai-accent);
  font-size: 10px;
  letter-spacing: 0.12em;
  margin-bottom: 4px;
}
header p:last-child,
.memory-page__scope {
  color: var(--ai-muted);
}
.memory-page__filters {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 12px;
}
label {
  display: grid;
  gap: 4px;
  font-size: 11px;
  color: var(--ai-muted);
  min-width: 120px;
  max-width: 100%;
}
input,
select {
  box-sizing: border-box;
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--ai-line);
  border-radius: 6px;
  padding: 8px;
  background: var(--ai-surface);
  color: var(--ai-ink);
  font: 13px var(--ai-font);
}
.memory-page__search {
  flex: 1;
}
.memory-page__scope {
  font-size: 11px;
  margin: 12px 0 16px;
}
.memory-page__notice {
  padding: 12px;
  border-left: 2px solid var(--ai-accent);
  background: var(--ai-surface);
  margin-bottom: 16px;
}
.memory-page__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 24px;
}
.memory-page__map {
  min-width: 0;
}
.memory-page__map-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.memory-page__map-title span {
  color: var(--ai-muted);
  font-size: 11px;
}
.memory-page__pages {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 12px;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}
.memory-page__pages > div {
  display: flex;
  align-items: center;
  gap: 4px;
}
.memory-page__pages span {
  margin-right: 8px;
}
button {
  cursor: pointer;
  font: inherit;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
.memory-page__pages button {
  width: 40px;
  min-height: 40px;
  border: 1px solid var(--ai-line);
  border-radius: 6px;
  color: var(--ai-ink);
  background: var(--ai-surface);
}
.memory-page__inspector {
  border-left: 1px solid var(--ai-line);
  padding-left: 20px;
  min-width: 0;
}
.memory-page__detail {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ai-muted);
  font-size: 12px;
  max-height: 280px;
  overflow: auto;
  margin-bottom: 24px;
}
.memory-page__list {
  max-height: 340px;
  overflow: auto;
  margin-top: 12px;
}
.memory-page__list button {
  display: grid;
  width: 100%;
  padding: 8px;
  min-height: 44px;
  text-align: left;
  border: 0;
  border-bottom: 1px solid var(--ai-line);
  background: transparent;
  color: var(--ai-ink);
}
.memory-page__list button[aria-pressed='true'] {
  background: var(--ai-surface);
  box-shadow: inset 2px 0 var(--ai-accent);
}
.memory-page__list span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.memory-page__list small {
  color: var(--ai-muted);
  font-size: 10px;
}
.memory-page__remote {
  margin-top: 20px;
  border-top: 1px solid var(--ai-line);
  padding-top: 16px;
}
.memory-page__remote summary {
  cursor: pointer;
  min-height: 40px;
}
.memory-page__remote p {
  margin: 8px 0;
  color: var(--ai-muted);
  font-size: 12px;
}
@media (max-width: 1050px) {
  .memory-page__body {
    grid-template-columns: minmax(0, 1fr);
  }
  .memory-page__inspector {
    border-left: 0;
    border-top: 1px solid var(--ai-line);
    padding: 16px 0 0;
  }
  .memory-page__list {
    max-height: 220px;
  }
}
@container (max-width: 800px) {
  .memory-page__body {
    grid-template-columns: minmax(0, 1fr);
  }
  .memory-page__inspector {
    border-left: 0;
    border-top: 1px solid var(--ai-line);
    padding: 16px 0 0;
  }
}
@container (max-width: 450px) {
  .memory-page__filters label {
    flex: 1 1 100%;
  }
}
@media (max-width: 600px) {
  .memory-page {
    padding: 16px;
  }
  .memory-page__filters label {
    flex: 1 1 100%;
  }
}
</style>
