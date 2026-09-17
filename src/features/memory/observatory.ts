import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { emitTo, listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { luczorMemory, getMemoryPrefs } from '@/services/memory/luczorMemory'
import { snapshotMemoryActivity, type MemoryActivitySnapshot } from '@/services/memory/activity'
import { memoryUsageSnapshot } from '@/services/memory/usage'
import { repositoryGraphStatus, type RepositoryGraphStatus } from '@/services/repositoryGraph'
import { idleOptimizationStatus, idleMemoryMaintenance } from '@/services/agents/idleOptimization'
import { assistantProfileState } from '@/services/assistantProfile'

export type MemoryStatusSnapshot = {
  at: number
  inventoryAt: number
  projectId: string
  projectName: string
  activity: MemoryActivitySnapshot
  usage: ReturnType<typeof memoryUsageSnapshot>
  inventory: { total: number; active: number; candidates: number; pending: number; synced: number } | null
  graph: Pick<
    RepositoryGraphStatus,
    'status' | 'files' | 'symbols' | 'edges' | 'skipped' | 'last_indexed_at' | 'lsp'
  > | null
  preferences: Awaited<ReturnType<typeof getMemoryPrefs>> | null
  idle: { phase: string; task: string | null; completed: number; nextCheckAt: number | null } | null
  maintenance: string
  profile: { source: string; skills: number; persona: boolean }
}
const REQUEST = 'luczor-memory-status-request'
const SNAPSHOT = 'luczor-memory-status-snapshot'
const OPEN = 'luczor-memory-explorer-open'
export const memoryStatus = shallowRef<MemoryStatusSnapshot | null>(null)
let refreshHost: (() => Promise<void>) | undefined
const native = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** Main is the sole reader. The diagnostics webview receives counts, never decrypted content. */
export function useMemoryObservatoryHost(project: () => { id: string; name: string } | undefined, open: () => void) {
  let disposed = false
  let epoch = 0
  let inFlight: Promise<void> | undefined
  const releases: Array<() => void> = []
  const publish = () => {
    if (native()) void emitTo('luczor-system-status', SNAPSHOT, memoryStatus.value).catch(() => undefined)
  }
  const reset = () => {
    epoch++
    memoryStatus.value = null
    publish()
  }
  const refresh = async () => {
    if (disposed) return
    if (inFlight) return inFlight
    const generation = epoch
    const selected = project()
    inFlight = (async () => {
      let data = memoryStatus.value
      if (!data || Date.now() - data.inventoryAt > 30_000 || data.projectId !== (selected?.id ?? '')) {
        const account = await getVerifiedAccountSnapshot()
        const [inventory, graph, preferences] = await Promise.all([
          luczorMemory.inspectLocal({ limit: 1 }).catch(() => null),
          selected && account ? repositoryGraphStatus(account.principalId, selected.id).catch(() => null) : null,
          getMemoryPrefs().catch(() => null),
        ])
        const current = await getVerifiedAccountSnapshot()
        if (
          generation !== epoch ||
          disposed ||
          selected?.id !== project()?.id ||
          current?.principalId !== account?.principalId
        )
          return
        data = {
          at: Date.now(),
          inventoryAt: Date.now(),
          projectId: selected?.id ?? '',
          projectName: selected?.name ?? 'Kein Projekt',
          activity: snapshotMemoryActivity(),
          usage: memoryUsageSnapshot(),
          inventory: inventory
            ? {
                total: inventory.total,
                active: inventory.active,
                candidates: inventory.candidates,
                pending: inventory.pending,
                synced: inventory.synced,
              }
            : null,
          graph: graph
            ? {
                status: graph.status,
                files: graph.files,
                symbols: graph.symbols,
                edges: graph.edges,
                skipped: graph.skipped,
                last_indexed_at: graph.last_indexed_at,
                lsp: graph.lsp,
              }
            : null,
          preferences,
          idle: null,
          maintenance: 'idle',
          profile: { source: '', skills: 0, persona: false },
        }
      }
      if (generation !== epoch || disposed || !data) return
      const idle = idleOptimizationStatus.value
      memoryStatus.value = {
        ...data,
        at: Date.now(),
        activity: snapshotMemoryActivity(),
        usage: memoryUsageSnapshot(),
        idle: idle
          ? { phase: idle.phase, task: idle.task, completed: idle.completed, nextCheckAt: idle.nextCheckAt }
          : null,
        maintenance: idleMemoryMaintenance.value,
        profile: {
          source: assistantProfileState.source,
          skills: assistantProfileState.profile.skills.length,
          persona: !!assistantProfileState.profile.persona,
        },
      }
      publish()
    })()
      .catch(() => {
        if (epoch === generation) {
          memoryStatus.value = null
          publish()
        }
      })
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }
  refreshHost = refresh
  watch(() => project()?.id, reset, { flush: 'sync' })
  onMounted(() => {
    window.addEventListener('luczor:api-identity-changing', reset)
    if (!native()) return
    for (const [name, handler] of [
      [REQUEST, () => void refresh()],
      [OPEN, open],
    ] as const) {
      void listen(name, handler)
        .then(release => (disposed ? release() : releases.push(release)))
        .catch(() => undefined)
    }
  })
  onBeforeUnmount(() => {
    disposed = true
    reset()
    releases.forEach(release => release())
    if (refreshHost === refresh) refreshHost = undefined
    window.removeEventListener('luczor:api-identity-changing', reset)
  })
}

export function useMemoryStatus(active: () => boolean, secondary = false) {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  let unlisten: (() => void) | undefined
  let disposed = false
  const refresh = () => {
    now.value = Date.now()
    if (secondary && native()) void emitTo('main', REQUEST).catch(() => undefined)
    else void refreshHost?.()
  }
  onMounted(async () => {
    if (secondary && native()) {
      try {
        const release = await listen<MemoryStatusSnapshot | null>(SNAPSHOT, event => {
          memoryStatus.value = event.payload
          now.value = Date.now()
        })
        if (disposed) release()
        else {
          unlisten = release
          if (active()) refresh()
        }
      } catch {
        /* Explicit unavailable state remains visible. */
      }
    }
  })
  watch(
    active,
    enabled => {
      if (timer) clearInterval(timer)
      timer = undefined
      if (enabled) {
        refresh()
        timer = setInterval(refresh, 2000)
      }
    },
    { immediate: true }
  )
  onBeforeUnmount(() => {
    disposed = true
    if (timer) clearInterval(timer)
    unlisten?.()
  })
  return { snapshot: memoryStatus, now, refresh }
}
export async function openMemoryExplorerFromStatus() {
  if (native()) await invoke('system_status_open_memory')
}
