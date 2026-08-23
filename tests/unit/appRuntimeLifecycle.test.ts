import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { AppState } from '@/state/types'
import {
  ACTIVE_MODE_KEY,
  createAppRuntimeLifecycle,
  resolveStartupMode,
  type AppRuntimeLifecycleDependencies,
  type RuntimeSettingsStore,
} from '@/services/appRuntimeLifecycle'

function createHarness(remoteAllow: boolean | undefined = true) {
  const values = new Map<string, unknown>()
  const settings: RuntimeSettingsStore = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined
    },
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value)
    }),
    save: vi.fn(async () => undefined),
  }

  let notificationAction: (() => void) | null = null
  let hotkeyAction: (() => void) | null = null
  let heartbeatAction: (() => void) | null = null
  const stopNotifications = vi.fn(async () => undefined)
  const stopDeviceJobs = vi.fn()
  const order: string[] = []

  const dependencies: AppRuntimeLifecycleDependencies = {
    addNotificationActionListener: vi.fn(listener => {
      notificationAction = listener
    }),
    removeNotificationActionListener: vi.fn(),
    startNotificationActionListener: vi.fn(async () => stopNotifications),
    installDebugCapture: vi.fn(),
    startDebugCollector: vi.fn(),
    preloadSfx: vi.fn(),
    startHud: vi.fn(),
    loadAppearance: vi.fn(),
    loadPlans: vi.fn(),
    loadAppState: vi.fn(async () => ({ version: 1 }) as AppState),
    hydrate: vi.fn(() => order.push('hydrate')),
    ensureDefaults: vi.fn(() => order.push('ensure-defaults')),
    loadSettingsStore: vi.fn(async () => settings),
    bootstrap: vi.fn(async () => ({
      runtime_settings: {
        settings: remoteAllow === undefined ? {} : { allow_unrestricted: remoteAllow },
      },
    })),
    listenHotkey: vi.fn(async listener => {
      hotkeyAction = listener
    }),
    refreshStatus: vi.fn(),
    setStatusHeartbeat: vi.fn((listener, intervalMs) => {
      expect(intervalMs).toBe(30_000)
      heartbeatAction = listener
      return 17
    }),
    clearStatusHeartbeat: vi.fn(),
    startDeviceJobChannel: vi.fn(async () => stopDeviceJobs),
    warn: vi.fn(),
  }

  return {
    values,
    settings,
    dependencies,
    stopNotifications,
    stopDeviceJobs,
    order,
    triggerNotification: () => notificationAction?.(),
    triggerHotkey: () => hotkeyAction?.(),
    triggerHeartbeat: () => heartbeatAction?.(),
  }
}

describe('app runtime lifecycle', () => {
  it('resolves persisted modes fail-closed against the unrestricted policy', () => {
    expect(resolveStartupMode('act', 'observe', false)).toBe('act')
    expect(resolveStartupMode('unrestricted', 'act', false)).toBe('observe')
    expect(resolveStartupMode('unrestricted', 'observe', true)).toBe('unrestricted')
    expect(resolveStartupMode('invalid', 'act', false)).toBe('act')
    expect(resolveStartupMode('invalid', 'invalid', true)).toBeNull()
  })

  it('owns startup listeners, hydration, hotkey, heartbeat and symmetric cleanup', async () => {
    const harness = createHarness(true)
    harness.values.set('default_mode', 'observe')
    harness.values.set(ACTIVE_MODE_KEY, 'act')
    harness.values.set('allow_unrestricted', false)
    const mode = ref<'observe' | 'act' | 'unrestricted'>('observe')
    const allowUnrestricted = ref(false)
    const openProject = vi.fn(() => harness.order.push('open-project'))
    const openNotificationCenter = vi.fn()
    const togglePushToTalk = vi.fn()
    const lifecycle = createAppRuntimeLifecycle(
      {
        mode,
        allowUnrestricted,
        getActiveProjectId: () => 'project-1',
        openProject,
        openNotificationCenter,
        togglePushToTalk,
      },
      harness.dependencies
    )

    await lifecycle.start()
    await vi.waitFor(() => expect(harness.settings.save).toHaveBeenCalledOnce())

    expect(mode.value).toBe('act')
    expect(allowUnrestricted.value).toBe(true)
    expect(harness.order).toEqual(['hydrate', 'ensure-defaults', 'open-project'])
    expect(openProject).toHaveBeenCalledWith('project-1')
    expect(harness.dependencies.installDebugCapture).toHaveBeenCalledOnce()
    expect(harness.dependencies.startDebugCollector).toHaveBeenCalledOnce()
    expect(harness.dependencies.preloadSfx).toHaveBeenCalledOnce()
    expect(harness.dependencies.startHud).toHaveBeenCalledOnce()
    expect(harness.dependencies.loadAppearance).toHaveBeenCalledOnce()
    expect(harness.dependencies.loadPlans).toHaveBeenCalledOnce()
    expect(harness.dependencies.refreshStatus).toHaveBeenCalledOnce()

    harness.triggerNotification()
    harness.triggerHotkey()
    harness.triggerHeartbeat()
    expect(openNotificationCenter).toHaveBeenCalledOnce()
    expect(togglePushToTalk).toHaveBeenCalledOnce()
    expect(harness.dependencies.refreshStatus).toHaveBeenCalledTimes(2)

    lifecycle.stop()
    expect(harness.dependencies.removeNotificationActionListener).toHaveBeenCalledWith(openNotificationCenter)
    expect(harness.dependencies.clearStatusHeartbeat).toHaveBeenCalledWith(17)
    expect(harness.stopDeviceJobs).toHaveBeenCalledOnce()
    expect(harness.stopNotifications).toHaveBeenCalledOnce()
  })

  it('applies a remote unrestricted revocation and persists the safe mode', async () => {
    const harness = createHarness(false)
    harness.values.set(ACTIVE_MODE_KEY, 'unrestricted')
    harness.values.set('allow_unrestricted', true)
    const mode = ref<'observe' | 'act' | 'unrestricted'>('observe')
    const allowUnrestricted = ref(false)
    const lifecycle = createAppRuntimeLifecycle(
      {
        mode,
        allowUnrestricted,
        getActiveProjectId: () => 'project-1',
        openProject: vi.fn(),
        openNotificationCenter: vi.fn(),
        togglePushToTalk: vi.fn(),
      },
      harness.dependencies
    )

    await lifecycle.start()
    await vi.waitFor(() => expect(harness.settings.save).toHaveBeenCalledOnce())

    expect(allowUnrestricted.value).toBe(false)
    expect(mode.value).toBe('observe')
    expect(harness.values.get(ACTIVE_MODE_KEY)).toBe('observe')
  })
})
