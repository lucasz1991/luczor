import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Store } from '@tauri-apps/plugin-store'
import type { Project } from '@/state/types'
import type { ProjectWorkspaceBinding } from '@/services/projectWorkspace'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { executionGate, onExecutionInvalidated } from '@/services/executionGate'
import { refreshAssistantProfile } from '@/services/assistantProfile'
import { getMemoryPrefs } from '@/services/memory/luczorMemory'
import { buildProjectStartContext } from '@/services/prompt/projectStartContext'
import {
  BACKGROUND_CONTEXT_PREPARATION_KEY,
  BACKGROUND_MODEL_PREPARATION_KEY,
  DEFAULT_BACKGROUND_PREPARATION_ENABLED,
} from '@/services/inference/backgroundPreparation'
import {
  createLocalBackgroundPreparation,
  localBackgroundPreparationPolicy,
  canRetryBackgroundPolicy,
  recoverLocalBackgroundPolicy,
} from '@/services/inference/localBackgroundPreparation'
import { FLASH_EXPERIMENT_SETTING_KEY } from '@/services/inference/hybridRouter'
import { ScopedPreparationCache, type PreparationScope } from '@/services/inference/scopedPreparationCache'

type MemoryPreferences = Pick<Awaited<ReturnType<typeof getMemoryPrefs>>, 'inject' | 'injectCount'>
type ProjectContext = Awaited<ReturnType<typeof buildProjectStartContext>>
const STARTUP_MODEL_SCOPE = '__luczor_background__'
type Options = {
  project: () => Project | undefined
  workspace: () => ProjectWorkspaceBinding | null
  busy: () => boolean
  draft: () => string
}

/** Main-renderer background owner; source fragments are rebound to the actual turn only at send time. */
export function useBackgroundPreparation(options: Options) {
  const modelEnabled = ref(DEFAULT_BACKGROUND_PREPARATION_ENABLED)
  const contextEnabled = ref(DEFAULT_BACKGROUND_PREPARATION_ENABLED)
  const experimentalFlashNext = ref(false)
  const warm = createLocalBackgroundPreparation(() => ({ experimentalFlashNext: experimentalFlashNext.value }))
  const status = shallowRef(warm.snapshot())
  const policyStatus = shallowRef<{ phase: 'waiting' | 'retrying' | 'failed' | 'ready'; retryAt?: number }>({
    phase: 'waiting',
  })
  const cache = new ScopedPreparationCache<ProjectContext>()
  const unsubscribers: Array<() => void> = [warm.subscribe(value => (status.value = value))]
  let scope: PreparationScope | null = null
  let memoryRevision = 0
  let memoryObserved = false
  let active = false
  let stopped = false
  let identityChanging = false
  let epoch = 0
  let policyFingerprint: string | undefined
  let scopePreparation: Promise<void> | undefined
  let prefetchTimer: ReturnType<typeof setTimeout> | undefined
  let settingsTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let policyRecovery: Promise<void> | undefined
  let policyRetryAt = Date.now() + 10_000
  let policyFailures = 0

  function recoverPolicy(): void {
    if (policyRecovery || !modelEnabled.value || options.busy() || Date.now() < policyRetryAt) return
    const policy = localBackgroundPreparationPolicy()
    if (!canRetryBackgroundPolicy(policy)) return
    const generation = epoch
    policyStatus.value = { phase: 'retrying' }
    policyRetryAt = Date.now() + Math.min(300_000, 60_000 * 2 ** policyFailures)
    const work = recoverLocalBackgroundPolicy()
      .then(result => {
        if (stopped || identityChanging || generation !== epoch || result.stale) return
        if (result.ok) {
          policyFailures = 0
          policyStatus.value = { phase: 'ready' }
          tick()
        } else {
          policyFailures++
          policyStatus.value = { phase: 'failed', retryAt: policyRetryAt }
        }
      })
      .catch(() => {
        if (stopped || identityChanging || generation !== epoch) return
        policyFailures++
        policyStatus.value = { phase: 'failed', retryAt: policyRetryAt }
      })
      .finally(() => {
        if (policyRecovery === work) policyRecovery = undefined
      })
    policyRecovery = work
  }

  function invalidate(): void {
    epoch++
    scope = null
    cache.invalidate()
    warm.invalidate()
  }

  function updateWarm(): void {
    warm.update({ enabled: active && modelEnabled.value && !identityChanging, busy: options.busy(), scope })
  }

  async function prepareScope(): Promise<void> {
    if (scopePreparation) return scopePreparation
    const generation = epoch
    const ticket = executionGate.capture()
    const project = options.project()
    const projectId = project?.id ?? STARTUP_MODEL_SCOPE
    if (project?.archivedAt || !localBackgroundPreparationPolicy().active) return
    const work = (async () => {
      const account = await getVerifiedAccountSnapshot()
      executionGate.assert(ticket)
      if (
        !account ||
        stopped ||
        identityChanging ||
        generation !== epoch ||
        (options.project()?.id ?? STARTUP_MODEL_SCOPE) !== projectId
      )
        return
      scope = {
        principalId: account.principalId,
        serverInstance: account.serverInstance,
        projectId,
        sessionId: ticket.sessionId,
        generation: ticket.generation,
        workspaceRevision: String(options.workspace()?.updatedAt ?? ''),
      }
      updateWarm()
      schedulePrefetch()
    })()
      .catch(() => {})
      .finally(() => {
        if (scopePreparation === work) scopePreparation = undefined
      })
    scopePreparation = work
    return work
  }

  async function projectContext(
    project: Project,
    workspace: ProjectWorkspaceBinding | null | undefined,
    preferences: MemoryPreferences,
    ticket = executionGate.capture()
  ): Promise<ProjectContext> {
    executionGate.assert(ticket)
    const startingEpoch = epoch
    const startingMemoryRevision = memoryRevision
    const preparedScope = scope
    const canReuse =
      contextEnabled.value &&
      (!preferences.inject || memoryObserved) &&
      preparedScope?.projectId === project.id &&
      preparedScope.sessionId === ticket.sessionId &&
      preparedScope.generation === ticket.generation &&
      preparedScope.workspaceRevision === String(workspace?.updatedAt ?? '')
    const snapshot = JSON.parse(JSON.stringify({ project, workspace })) as {
      project: Project
      workspace: typeof workspace
    }
    const build = async (signal?: AbortSignal) => {
      signal?.throwIfAborted()
      executionGate.assert(ticket)
      const result = await buildProjectStartContext({
        ...snapshot,
        includeMemory: preferences.inject,
        memoryLimit: preferences.injectCount,
      })
      signal?.throwIfAborted()
      executionGate.assert(ticket)
      return result
    }
    if (!canReuse || !preparedScope) return build()
    const revisionInput = JSON.stringify({
      project: {
        id: snapshot.project.id,
        name: snapshot.project.name,
        goal: snapshot.project.goal,
        summary: snapshot.project.summary,
        goals: snapshot.project.goals,
      },
      workspace: snapshot.workspace,
      preferences,
      memoryRevision,
      policyFingerprint,
    })
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(revisionInput))
    executionGate.assert(ticket)
    if (startingEpoch !== epoch || startingMemoryRevision !== memoryRevision || !contextEnabled.value) return build()
    const revision = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    try {
      return await cache.prepare(preparedScope, revision, build, ticket.signal)
    } catch (error) {
      executionGate.assert(ticket)
      // Memory changes may revoke only the prepared source, without invalidating this chat turn.
      if (error instanceof DOMException && error.name === 'AbortError') return build()
      throw error
    }
  }

  function schedulePrefetch(): void {
    if (prefetchTimer) clearTimeout(prefetchTimer)
    if (!active || !contextEnabled.value || !scope || options.busy() || identityChanging) return
    prefetchTimer = setTimeout(() => {
      prefetchTimer = undefined
      const project = options.project()
      if (!project || !scope || options.busy() || !active || !contextEnabled.value) return
      const ticket = executionGate.capture()
      void getMemoryPrefs()
        .then(preferences => projectContext(project, options.workspace(), preferences, ticket))
        .catch(() => {})
      // This service already provides identity-bound, deduplicated 60-second caching.
      void refreshAssistantProfile().catch(() => {})
    }, 350)
  }

  function tick(): void {
    if (!active || stopped || identityChanging) return
    const policy = localBackgroundPreparationPolicy()
    if (policy.fingerprint !== policyFingerprint) {
      policyFingerprint = policy.fingerprint
      invalidate()
    }
    if (policy.active) policyStatus.value = { phase: 'ready' }
    else recoverPolicy()
    if (!scope && (modelEnabled.value || contextEnabled.value)) void prepareScope()
    updateWarm()
  }

  async function loadSettings(): Promise<void> {
    const store = await Store.load('luczor.settings.json')
    const [model, context, flash] = await Promise.all([
      store.get<unknown>(BACKGROUND_MODEL_PREPARATION_KEY),
      store.get<unknown>(BACKGROUND_CONTEXT_PREPARATION_KEY),
      store.get<unknown>(FLASH_EXPERIMENT_SETTING_KEY),
    ])
    if (stopped) return
    modelEnabled.value = model !== false
    contextEnabled.value = context !== false
    experimentalFlashNext.value = flash === true
    if (!contextEnabled.value) cache.invalidate()
    tick()
    schedulePrefetch()
  }

  function changing(): void {
    identityChanging = true
    invalidate()
    policyFailures = 0
    policyRetryAt = Date.now() + 10_000
    policyStatus.value = { phase: 'waiting' }
  }
  function changed(): void {
    identityChanging = false
    tick()
  }
  function stop(): void {
    if (stopped) return
    stopped = true
    active = false
    epoch++
    if (heartbeat) clearInterval(heartbeat)
    if (prefetchTimer) clearTimeout(prefetchTimer)
    if (settingsTimer) clearTimeout(settingsTimer)
    warm.stop()
    cache.stop()
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
    window.removeEventListener('beforeunload', stop)
    window.removeEventListener('luczor:api-identity-changing', changing)
    window.removeEventListener('luczor:api-identity-changed', changed)
  }

  unsubscribers.push(onExecutionInvalidated(invalidate))
  watch(
    () => {
      const project = options.project()
      return JSON.stringify({
        project: project && {
          id: project.id,
          name: project.name,
          goal: project.goal,
          summary: project.summary,
          goals: project.goals,
          archivedAt: project.archivedAt,
        },
        workspace: options.workspace(),
      })
    },
    () => {
      cache.invalidate()
      if (scope && scope.projectId !== (options.project()?.id ?? STARTUP_MODEL_SCOPE)) invalidate()
      tick()
      schedulePrefetch()
    }
  )
  watch(options.busy, () => {
    updateWarm()
    schedulePrefetch()
  })
  watch(options.draft, schedulePrefetch)
  async function observeStore(file: string, callback: () => void): Promise<boolean> {
    try {
      const store = await Store.load(file)
      const unlisten = await store.onChange(callback)
      if (stopped) {
        unlisten()
        return false
      }
      unsubscribers.push(unlisten)
      return true
    } catch {
      return false
    }
  }
  onMounted(async () => {
    window.addEventListener('beforeunload', stop)
    window.addEventListener('luczor:api-identity-changing', changing)
    window.addEventListener('luczor:api-identity-changed', changed)
    await loadSettings().catch(() => {})
    // Failure to observe memory disables memory caching, without disabling live settings.
    memoryObserved = await observeStore('luczor.memory.json', () => {
      memoryRevision++
      cache.invalidate()
      schedulePrefetch()
    })
    await observeStore('luczor.settings.json', () => {
      cache.invalidate()
      if (settingsTimer) clearTimeout(settingsTimer)
      settingsTimer = setTimeout(() => void loadSettings().catch(() => {}), 100)
    })
    if (stopped) return
    active = true
    heartbeat = setInterval(tick, 5_000)
    tick()
  })
  onBeforeUnmount(stop)
  return { modelEnabled, contextEnabled, status, policyStatus, projectContext, invalidate, stop }
}
