import { listen } from '@tauri-apps/api/event'
import { Store } from '@tauri-apps/plugin-store'
import type { Ref } from 'vue'
import type { LuczorMode } from '@/services/openrouter.service'
import { LuczorApi, type BootstrapResponse } from '@/services/api/luczorApi'
import { loadAppearance } from '@/services/appearance'
import { installDebugCapture, startDebugCollector } from '@/services/debug'
import { startDeviceJobChannel, stopDeviceJobChannel } from '@/services/deviceJobs'
import { NATIVE_NOTIFICATION_ACTION_EVENT, startNativeNotificationActionListener } from '@/services/notifications'
import { loadAppState } from '@/services/persistence'
import { loadPlans } from '@/services/plan'
import { luczorMemory } from '@/services/memory/luczorMemory'
import { preloadSfx } from '@/services/sfx'
import {
  beginLocalInferenceBootstrap,
  initializeLocalInference,
  markLocalInferenceBootstrapUnavailable,
} from '@/services/inference/coordinator'
import { refreshStatus } from '@/services/status'
import { startHud } from '@/state/hud'
import { mutations } from '@/state/store'
import type { AppState } from '@/state/types'

export const ACTIVE_MODE_KEY = 'active_mode'

type StopDeviceJobs = () => void
type StopNotificationActions = () => Promise<void>

export type RuntimeSettingsStore = {
  get<T>(key: string): Promise<T | null | undefined>
  set(key: string, value: unknown): Promise<void>
  save(): Promise<void>
}

export type AppRuntimeLifecycleOptions = {
  mode: Ref<LuczorMode>
  allowUnrestricted: Ref<boolean>
  getActiveProjectId: () => string
  openProject: (projectId: string) => void
  openNotificationCenter: () => void
  togglePushToTalk: () => void | Promise<void>
}

export type AppRuntimeLifecycleDependencies = {
  addNotificationActionListener: (listener: () => void) => void
  removeNotificationActionListener: (listener: () => void) => void
  startNotificationActionListener: () => Promise<StopNotificationActions>
  installDebugCapture: () => void
  startDebugCollector: () => void | Promise<void>
  preloadSfx: () => void
  startHud: () => void
  loadAppearance: () => void | Promise<void>
  loadPlans: () => void | Promise<void>
  loadAppState: () => Promise<AppState>
  hydrate: (loaded: AppState) => void
  ensureDefaults: () => void
  loadSettingsStore: () => Promise<RuntimeSettingsStore>
  bootstrap: () => Promise<BootstrapResponse | { runtime_settings?: { settings?: Record<string, unknown> } }>
  beginLocalInferenceBootstrap?: () => Promise<number>
  initializeLocalInference?: (bootstrap: BootstrapResponse, expectedPendingGeneration?: number) => Promise<boolean>
  markLocalInferenceBootstrapUnavailable?: (expectedGeneration?: number) => void
  listenHotkey: (listener: () => void) => Promise<void>
  refreshStatus: () => void | Promise<void>
  setStatusHeartbeat: (listener: () => void, intervalMs: number) => number
  clearStatusHeartbeat: (heartbeat: number) => void
  startDeviceJobChannel: () => Promise<StopDeviceJobs>
  stopDeviceJobChannel: () => void
  flushMemoryOutbox?: () => void | Promise<void>
  warn: (message: string, error: unknown) => void
}

export type AppRuntimeLifecycle = {
  start: () => Promise<void>
  stop: () => void
  suspendWork: () => void
  resumeWork: () => void
}

function isLuczorMode(value: unknown): value is LuczorMode {
  return value === 'observe' || value === 'act' || value === 'unrestricted'
}

export function resolveStartupMode(
  persistedMode: unknown,
  defaultMode: unknown,
  allowUnrestricted: boolean
): LuczorMode | null {
  const candidate = isLuczorMode(persistedMode) ? persistedMode : defaultMode
  if (!isLuczorMode(candidate)) return null
  return candidate === 'unrestricted' && !allowUnrestricted ? 'observe' : candidate
}

function createDefaultDependencies(): AppRuntimeLifecycleDependencies {
  return {
    addNotificationActionListener: listener => {
      window.addEventListener(NATIVE_NOTIFICATION_ACTION_EVENT, listener)
    },
    removeNotificationActionListener: listener => {
      window.removeEventListener(NATIVE_NOTIFICATION_ACTION_EVENT, listener)
    },
    startNotificationActionListener: startNativeNotificationActionListener,
    installDebugCapture,
    startDebugCollector,
    preloadSfx,
    startHud,
    loadAppearance,
    loadPlans,
    loadAppState,
    hydrate: loaded => mutations.hydrate(loaded),
    ensureDefaults: () => mutations.ensureDefaults(),
    loadSettingsStore: () => Store.load('luczor.settings.json'),
    bootstrap: () => LuczorApi.bootstrap(),
    beginLocalInferenceBootstrap,
    initializeLocalInference,
    markLocalInferenceBootstrapUnavailable,
    listenHotkey: async listener => {
      await listen('luczor://hotkey', listener)
    },
    refreshStatus,
    setStatusHeartbeat: (listener, intervalMs) => window.setInterval(listener, intervalMs),
    clearStatusHeartbeat: heartbeat => window.clearInterval(heartbeat),
    startDeviceJobChannel,
    stopDeviceJobChannel,
    flushMemoryOutbox: () => luczorMemory.flushPendingSync(),
    warn: (message, error) => console.warn(message, error),
  }
}

export function createAppRuntimeLifecycle(
  options: AppRuntimeLifecycleOptions,
  dependencies: AppRuntimeLifecycleDependencies = createDefaultDependencies()
): AppRuntimeLifecycle {
  let stopDeviceJobs: StopDeviceJobs | null = null
  let stopNativeNotificationActions: StopNotificationActions | null = null
  let statusHeartbeat: number | null = null
  let runtimeActive = false
  let runtimeReady = false
  let lifecycleGeneration = 0
  let identityChanging = false
  let workSuspended = false
  let deviceChannelGeneration = 0
  let identityListenersInstalled = false

  const invalidateDeviceChannel = () => {
    deviceChannelGeneration++
    dependencies.stopDeviceJobChannel()
    const knownStop = stopDeviceJobs
    stopDeviceJobs = null
    knownStop?.()
  }
  const startCurrentDeviceChannel = () => {
    if (!runtimeActive || !runtimeReady || identityChanging || workSuspended) return
    const generation = ++deviceChannelGeneration
    void dependencies
      .startDeviceJobChannel()
      .then(stopChannel => {
        if (
          !runtimeActive ||
          !runtimeReady ||
          identityChanging ||
          workSuspended ||
          generation !== deviceChannelGeneration
        ) {
          stopChannel()
          return
        }
        stopDeviceJobs?.()
        stopDeviceJobs = stopChannel
      })
      .catch(error => {
        if (runtimeActive && runtimeReady && !identityChanging && generation === deviceChannelGeneration) {
          dependencies.warn('[device-jobs] unavailable', error)
        }
      })
  }
  const onIdentityChanging = () => {
    identityChanging = true
    invalidateDeviceChannel()
  }
  const onIdentityChanged = () => {
    identityChanging = false
    startCurrentDeviceChannel()
  }

  async function start(): Promise<void> {
    const generation = ++lifecycleGeneration
    runtimeActive = true
    runtimeReady = false
    const current = () => runtimeActive && lifecycleGeneration === generation
    if (!identityListenersInstalled && typeof window !== 'undefined') {
      window.addEventListener('luczor:api-identity-changing', onIdentityChanging)
      window.addEventListener('luczor:api-identity-changed', onIdentityChanged)
      identityListenersInstalled = true
    }
    let localBootstrapGeneration: number | undefined
    let localManifestBoundaryReady = false
    try {
      if (!dependencies.beginLocalInferenceBootstrap) {
        throw new Error('Native local-model manifest boundary is unavailable.')
      }
      localBootstrapGeneration = await dependencies.beginLocalInferenceBootstrap()
      if (!current()) return
      localManifestBoundaryReady = true
    } catch (error) {
      if (!current()) return
      dependencies.markLocalInferenceBootstrapUnavailable?.(localBootstrapGeneration)
      dependencies.warn('[local-model] native manifest boundary unavailable', error)
    }

    dependencies.addNotificationActionListener(options.openNotificationCenter)
    void dependencies
      .startNotificationActionListener()
      .then(stopListener => {
        if (!current()) {
          void stopListener()
          return
        }
        stopNativeNotificationActions = stopListener
      })
      .catch(error => dependencies.warn('[notifications] native action listener unavailable', error))

    dependencies.installDebugCapture()
    void dependencies.startDebugCollector()
    dependencies.preloadSfx()
    dependencies.startHud()
    void dependencies.loadAppearance()

    void dependencies.loadPlans()
    const loaded = await dependencies.loadAppState()
    if (!current()) return
    dependencies.hydrate(loaded)

    dependencies.ensureDefaults()
    options.openProject(options.getActiveProjectId())

    // Restore local mode first. Server bootstrap only refreshes the
    // administrator-managed unrestricted policy when it is available.
    try {
      const settings = await dependencies.loadSettingsStore()
      if (!current()) return
      const defaultMode = await settings.get<string>('default_mode')
      const persistedMode = await settings.get<string>(ACTIVE_MODE_KEY)
      const allow = (await settings.get<unknown>('allow_unrestricted')) === true
      if (!current()) return
      options.allowUnrestricted.value = allow
      const restoredMode = resolveStartupMode(persistedMode, defaultMode, options.allowUnrestricted.value)
      if (restoredMode) options.mode.value = restoredMode

      if (localManifestBoundaryReady)
        void (async () => {
          try {
            const bootstrap = await dependencies.bootstrap()
            if (!current()) return
            if (dependencies.initializeLocalInference) {
              const accepted = await dependencies.initializeLocalInference(
                bootstrap as BootstrapResponse,
                localBootstrapGeneration
              )
              if (!accepted || !current()) return
            }
            const remoteAllow = bootstrap.runtime_settings?.settings?.allow_unrestricted
            if (remoteAllow === true || remoteAllow === false) {
              options.allowUnrestricted.value = remoteAllow
              await settings.set('allow_unrestricted', remoteAllow)
              if (!current()) return
              if (!remoteAllow && options.mode.value === 'unrestricted') {
                options.mode.value = 'observe'
                await settings.set(ACTIVE_MODE_KEY, 'observe')
                if (!current()) return
              }
              await settings.save()
            }
          } catch {
            if (current()) dependencies.markLocalInferenceBootstrapUnavailable?.(localBootstrapGeneration)
            // No signed policy is restored from disk; routing stays blocked.
          }
        })()
    } catch {
      // Local settings are optional; the in-memory defaults remain valid.
    }

    if (!current()) return
    try {
      await dependencies.listenHotkey(() => {
        if (current()) void options.togglePushToTalk()
      })
    } catch (error) {
      dependencies.warn('[hotkey] listen failed:', error)
    }

    if (!current()) return
    void dependencies.refreshStatus()
    void dependencies.flushMemoryOutbox?.()
    statusHeartbeat = dependencies.setStatusHeartbeat(() => {
      if (!current()) return
      void dependencies.refreshStatus()
      // Also drives retry deadlines without requiring a new write or restart.
      void dependencies.flushMemoryOutbox?.()
    }, 30_000)

    runtimeReady = true
    startCurrentDeviceChannel()
  }

  function stop(): void {
    lifecycleGeneration++
    runtimeActive = false
    runtimeReady = false
    identityChanging = false
    if (identityListenersInstalled && typeof window !== 'undefined') {
      window.removeEventListener('luczor:api-identity-changing', onIdentityChanging)
      window.removeEventListener('luczor:api-identity-changed', onIdentityChanged)
      identityListenersInstalled = false
    }
    invalidateDeviceChannel()
    dependencies.removeNotificationActionListener(options.openNotificationCenter)
    if (statusHeartbeat !== null) dependencies.clearStatusHeartbeat(statusHeartbeat)
    statusHeartbeat = null
    void stopNativeNotificationActions?.()
    stopNativeNotificationActions = null
  }

  return {
    start,
    stop,
    suspendWork() {
      workSuspended = true
      invalidateDeviceChannel()
    },
    resumeWork() {
      if (!workSuspended) return
      workSuspended = false
      startCurrentDeviceChannel()
    },
  }
}
