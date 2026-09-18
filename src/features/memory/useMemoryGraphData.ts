import { computed, ref, shallowRef } from 'vue'
import type { RepositoryGraphPage } from '@/services/repositoryGraph'
import { memoryExplorerData } from './explorerData'
import { assistantProfileState } from '@/services/assistantProfile'
import { buildMemoryGraph, MODEL_NODE_ID, type MemoryInventory, type MemoryNode } from './graph'
import { dreamEffects, dreamNodeId, dreamTrace, type DreamTarget } from '@/services/memory/dreamTrace'
import { lastLocalModelStatus } from '@/services/localModelStatus'
import {
  activeMemoryLinks,
  memoryLinkNodeId,
  modelActivity,
  type MemoryLink,
  type ModelPhase,
} from '@/services/memory/modelActivity'
import type { PreparedContextArtifact } from '@/services/memory/maintenance'

/**
 * One shared data source for the knowledge space: the ambient app backdrop and the
 * memory page render the same graph, so loading, filters, selection and the transient
 * born/ghost effects live here instead of in a page component that unmounts.
 */
const project = ref('')
const query = ref('')
const system = ref('')
const selected = ref('system:0')
const inventory = shallowRef<MemoryInventory | null>(null)
const repo = shallowRef<RepositoryGraphPage | null>(null)
const remote = shallowRef<MemoryNode[]>([])
const artifacts = shallowRef<PreparedContextArtifact[]>([])
const offset = ref(0)
const repoOffset = ref(0)
const loading = ref(false)
const remoteLoading = ref(false)
const notice = ref('')
const remoteNotice = ref('')
const loadedAt = ref(0)
let epoch = 0
let identityChanging = false
let listening = false

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

const modelCore = computed(() => {
  const status = lastLocalModelStatus.value
  const name = status?.modelName ?? 'Lokales Modell'
  return {
    label: name,
    detail: `${name}\n${status?.label ?? 'Status noch nicht gelesen'}${status?.detail ? `\n${status.detail}` : ''}\n\nDas lokale Modell ist das Zentrum des Wissensraums: Von hier gehen Abrufe, Kontextübergaben und Schreibvorgänge zu den Erinnerungen aus. Farbige Verbindungen zeigen, was gerade genutzt wird.`,
  }
})
const baseGraph = computed(() =>
  buildMemoryGraph(inventory.value, repo.value, assistantProfileState.profile, artifacts.value, modelCore.value)
)
/** Full graph including shared hits and transient ghosts, before the system filter. */
const fullGraph = computed(() => {
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
  return { nodes, edges }
})
const graph = computed(() => {
  const { nodes, edges } = fullGraph.value
  // The model core stays visible under every system filter; it is the reference point.
  const visible = nodes.filter(node => !system.value || node.system === system.value || node.id === MODEL_NODE_ID)
  const ids = new Set(visible.map(node => node.id))
  return { nodes: visible, edges: edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)) }
})
const detail = computed(() => graph.value.nodes.find(node => node.id === selected.value))

// Dream state drives node animations; a ticking clock lets finished runs fade out of the view.
const dreamClock = ref(Date.now())
let dreamTimer: ReturnType<typeof setInterval> | undefined
const dream = computed(() => {
  void dreamClock.value
  return dreamEffects(dreamTrace.value)
})
/** Live model↔memory links for the view (only those whose node is currently in the graph). */
const links = computed<MemoryLink[]>(() => {
  void dreamClock.value
  void modelActivity.value
  const ids = new Set(graph.value.nodes.map(node => node.id))
  return activeMemoryLinks().filter(link => ids.has(memoryLinkNodeId(link)))
})
const phase = computed<ModelPhase>(() => (dream.value.active ? 'dreaming' : modelActivity.value.phase))

async function load(options: { soft?: boolean } = {}) {
  if (identityChanging) return
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
    const [memories, graphPage, contexts] = await Promise.allSettled([
      memoryExplorerData.inventory({ query: query.value, offset: offset.value, limit: 80 }),
      account && project.value
        ? memoryExplorerData.graph(account.principalId, project.value, query.value, repoOffset.value)
        : Promise.reject(new Error('No verified project')),
      account ? memoryExplorerData.artifacts(account.principalId, project.value) : [],
    ])
    const current = await memoryExplorerData.account()
    if (epoch !== request || current?.principalId !== account?.principalId) return
    inventory.value = memories.status === 'fulfilled' ? memories.value : null
    repo.value = graphPage.status === 'fulfilled' ? graphPage.value : null
    artifacts.value = contexts.status === 'fulfilled' ? contexts.value : []
    if (options.soft) markTransient(previous, baseGraph.value.nodes)
    const messages = []
    if (memories.status === 'rejected') messages.push('Lokale Erinnerungen nicht verfügbar.')
    if (graphPage.status === 'rejected')
      messages.push(
        'Repo-Graph nicht verfügbar: verifiziertes Konto, verbundenes Repository und aktuelle Desktop-Version erforderlich.'
      )
    notice.value = messages.join(' ')
    loadedAt.value = Date.now()
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
    if (request !== epoch || current?.principalId !== account.principalId) return
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
/** Switch the project the repository graph and server recall are scoped to. */
function setProject(id: string) {
  if (project.value === id) return
  project.value = id
  offset.value = 0
  repoOffset.value = 0
  clear()
  void load()
}
function setSystem(value: string) {
  system.value = value
  selected.value = graph.value.nodes[0]?.id ?? ''
}
function focusDreamTarget(target: DreamTarget) {
  const id = dreamNodeId(target)
  if (graph.value.nodes.some(node => node.id === id)) selected.value = id
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
let reloadTimer: ReturnType<typeof setTimeout> | undefined
/** Any write (dream, chat, user) refreshes the space softly so new/replaced memories animate in. */
const memoryChanged = () => {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    reloadTimer = undefined
    if (!loading.value && loadedAt.value) void load({ soft: true })
  }, 900)
}

/** Idempotent: the first consumer (the app backdrop) wires the listeners for the app's lifetime. */
function ensureListening() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('luczor:api-identity-changing', identityChange)
  window.addEventListener('luczor:api-identity-changed', identityChanged)
  window.addEventListener('luczor:memory-changed', memoryChanged)
  // One second keeps link expiry and dream fades smooth without re-rendering every frame.
  dreamTimer = setInterval(() => {
    dreamClock.value = Date.now()
  }, 1000)
}

/** Loads once per project unless data is missing or stale (used by the ambient backdrop). */
function ensureLoaded(projectId: string, maxAgeMs = 300_000) {
  ensureListening()
  if (project.value !== projectId) {
    setProject(projectId)
    return
  }
  if (!loading.value && (!loadedAt.value || Date.now() - loadedAt.value > maxAgeMs)) void load()
}

export function useMemoryGraphData() {
  return {
    project,
    query,
    system,
    selected,
    inventory,
    repo,
    remote,
    artifacts,
    offset,
    repoOffset,
    loading,
    remoteLoading,
    notice,
    remoteNotice,
    graph,
    fullGraph,
    detail,
    dream,
    dreamTrace,
    links,
    phase,
    load,
    sharedSearch,
    search,
    page,
    setProject,
    setSystem,
    focusDreamTarget,
    ensureListening,
    ensureLoaded,
  }
}

/** Test hook: drop listeners and timers created by ensureListening(). */
export function resetMemoryGraphDataForTests(): void {
  if (listening && typeof window !== 'undefined') {
    window.removeEventListener('luczor:api-identity-changing', identityChange)
    window.removeEventListener('luczor:api-identity-changed', identityChanged)
    window.removeEventListener('luczor:memory-changed', memoryChanged)
  }
  listening = false
  if (dreamTimer) clearInterval(dreamTimer)
  if (transientTimer) clearTimeout(transientTimer)
  if (reloadTimer) clearTimeout(reloadTimer)
  dreamTimer = undefined
  transientTimer = undefined
  reloadTimer = undefined
  clear()
  project.value = ''
  query.value = ''
  system.value = ''
  loadedAt.value = 0
}
