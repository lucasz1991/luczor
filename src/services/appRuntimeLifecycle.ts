import { listen } from '@tauri-apps/api/event'
import { Store } from '@tauri-apps/plugin-store'
import type { Ref } from 'vue'
import type { LuczorMode } from '@/services/openrouter.service'
import { LuczorApi } from '@/services/api/luczorApi'
import { loadAppearance } from '@/services/appearance'
import { installDebugCapture, startDebugCollector } from '@/services/debug'
import { startDeviceJobChannel } from '@/services/deviceJobs'
import { NATIVE_NOTIFICATION_ACTION_EVENT, startNativeNotificationActionListener } from '@/services/notifications'
import { loadAppState } from '@/services/persistence'
import { loadPlans } from '@/services/plan'
import { luczorMemory } from '@/services/memory/luczorMemory'
import { preloadSfx } from '@/services/sfx'
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
  bootstrap: () => Promise<{ runtime_settings?: { settings?: Record<string, unknown> } }>
  listenHotkey: (listener: () => void) => Promise<void>
  refreshStatus: () => void | Promise<void>
  setStatusHeartbeat: (listener: () => void, intervalMs: number) => number
  clearStatusHeartbeat: (heartbeat: number) => void
  startDeviceJobChannel: () => Promise<StopDeviceJobs>
  flushMemoryOutbox?: () => void | Promise<void>
  warn: (message: string, error: unknown) => void
}

export type AppRuntimeLifecycle = {
  start: () => Promise<void>
  stop: () => void
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
    listenHotkey: async listener => {
      await listen('luczor://hotkey', listener)
    },
    refreshStatus,
    setStatusHeartbeat: (listener, intervalMs) => window.setInterval(listener, intervalMs),
    clearStatusHeartbeat: heartbeat => window.clearInterval(heartbeat),
    startDeviceJobChannel,
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

  async function start(): Promise<void> {
    dependencies.addNotificationActionListener(options.openNotificationCenter)
    void dependencies
      .startNotificationActionListener()
      .then(stopListener => {
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
    dependencies.hydrate(loaded)

    dependencies.ensureDefaults()
    options.openProject(options.getActiveProjectId())

    // Restore local mode first. Server bootstrap only refreshes the
    // administrator-managed unrestricted policy when it is available.
    try {
      const settings = await dependencies.loadSettingsStore()
      const defaultMode = await settings.get<string>('default_mode')
      const persistedMode = await settings.get<string>(ACTIVE_MODE_KEY)
      options.allowUnrestricted.value = (await settings.get<unknown>('allow_unrestricted')) === true
      const restoredMode = resolveStartupMode(persistedMode, defaultMode, options.allowUnrestricted.value)
      if (restoredMode) options.mode.value = restoredMode

      void (async () => {
        try {
          const bootstrap = await dependencies.bootstrap()
          const remoteAllow = bootstrap.runtime_settings?.settings?.allow_unrestricted
          if (remoteAllow === true || remoteAllow === false) {
            options.allowUnrestricted.value = remoteAllow
            await settings.set('allow_unrestricted', remoteAllow)
            if (!remoteAllow && options.mode.value === 'unrestricted') {
              options.mode.value = 'observe'
              await settings.set(ACTIVE_MODE_KEY, 'observe')
            }
            await settings.save()
          }
        } catch {
          // Offline: keep the last locally cached policy.
        }
      })()
    } catch {
      // Local settings are optional; the in-memory defaults remain valid.
    }

    try {
      await dependencies.listenHotkey(() => {
        void options.togglePushToTalk()
      })
    } catch (error) {
      dependencies.warn('[hotkey] listen failed:', error)
    }

    void dependencies.refreshStatus()
    void dependencies.flushMemoryOutbox?.()
    statusHeartbeat = dependencies.setStatusHeartbeat(() => {
      void dependencies.refreshStatus()
      // Also drives retry deadlines without requiring a new write or restart.
      void dependencies.flushMemoryOutbox?.()
    }, 30_000)

    void dependencies
      .startDeviceJobChannel()
      .then(stopChannel => {
        stopDeviceJobs = stopChannel
      })
      .catch(error => dependencies.warn('[device-jobs] unavailable', error))
  }

  function stop(): void {
    dependencies.removeNotificationActionListener(options.openNotificationCenter)
    if (statusHeartbeat !== null) dependencies.clearStatusHeartbeat(statusHeartbeat)
    stopDeviceJobs?.()
    void stopNativeNotificationActions?.()
  }

  return { start, stop }
}
