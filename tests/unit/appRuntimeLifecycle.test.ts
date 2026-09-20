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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

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
  const stopDeviceJobChannel = vi.fn()
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
    beginLocalInferenceBootstrap: vi.fn(async () => 41),
    initializeLocalInference: vi.fn(async () => true),
    markLocalInferenceBootstrapUnavailable: vi.fn(),
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
    stopDeviceJobChannel,
    warn: vi.fn(),
  }

  return {
    values,
    settings,
    dependencies,
    stopNotifications,
    stopDeviceJobs,
    stopDeviceJobChannel,
    order,
    triggerNotification: () => notificationAction?.(),
    triggerHotkey: () => hotkeyAction?.(),
    triggerHeartbeat: () => heartbeatAction?.(),
  }
}

describe('app runtime lifecycle', () => {
  it('does not revive startup after quit interrupts hydration or a late notification subscription', async () => {
    const harness = createHarness()
    const hydration = deferred<AppState>()
    const notification = deferred<() => Promise<void>>()
    vi.mocked(harness.dependencies.loadAppState).mockReturnValue(hydration.promise)
    vi.mocked(harness.dependencies.startNotificationActionListener).mockReturnValue(notification.promise)
    const lifecycle = createAppRuntimeLifecycle(
      {
        mode: ref('observe'),
        allowUnrestricted: ref(false),
        getActiveProjectId: () => 'project-1',
        openProject: vi.fn(),
        openNotificationCenter: vi.fn(),
        togglePushToTalk: vi.fn(),
      },
      harness.dependencies
    )
    const started = lifecycle.start()
    await vi.waitFor(() => expect(harness.dependencies.loadAppState).toHaveBeenCalledOnce())
    lifecycle.stop()
    hydration.resolve({ version: 1 } as AppState)
    notification.resolve(harness.stopNotifications)
    await started
    await Promise.resolve()
    expect(harness.stopNotifications).toHaveBeenCalledOnce()
    expect(harness.dependencies.hydrate).not.toHaveBeenCalled()
    expect(harness.dependencies.listenHotkey).not.toHaveBeenCalled()
    expect(harness.dependencies.setStatusHeartbeat).not.toHaveBeenCalled()
    expect(harness.dependencies.startDeviceJobChannel).not.toHaveBeenCalled()
  })

  it('keeps device work suspended through late startup until explicitly resumed without rehydrating', async () => {
    const harness = createHarness()
    const hydration = deferred<AppState>()
    vi.mocked(harness.dependencies.loadAppState).mockReturnValue(hydration.promise)
    const lifecycle = createAppRuntimeLifecycle(
      {
        mode: ref('observe'),
        allowUnrestricted: ref(false),
        getActiveProjectId: () => 'project-1',
        openProject: vi.fn(),
        openNotificationCenter: vi.fn(),
        togglePushToTalk: vi.fn(),
      },
      harness.dependencies
    )
    const started = lifecycle.start()
    lifecycle.suspendWork()
    hydration.resolve({ version: 1 } as AppState)
    await started
    expect(harness.dependencies.startDeviceJobChannel).not.toHaveBeenCalled()
    lifecycle.resumeWork()
    await Promise.resolve()
    expect(harness.dependencies.startDeviceJobChannel).toHaveBeenCalledOnce()
    expect(harness.dependencies.loadAppState).toHaveBeenCalledOnce()
    lifecycle.suspendWork()
    lifecycle.stop()
    lifecycle.resumeWork()
    expect(harness.dependencies.startDeviceJobChannel).toHaveBeenCalledOnce()
  })

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
    expect(harness.dependencies.beginLocalInferenceBootstrap).toHaveBeenCalledOnce()
    expect(vi.mocked(harness.dependencies.beginLocalInferenceBootstrap!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(harness.dependencies.bootstrap).mock.invocationCallOrder[0]!
    )
    expect(harness.dependencies.initializeLocalInference).toHaveBeenCalledWith(expect.anything(), 41)
    expect(harness.dependencies.markLocalInferenceBootstrapUnavailable).not.toHaveBeenCalled()

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
    expect(harness.stopDeviceJobChannel).toHaveBeenCalledOnce()
    expect(harness.stopNotifications).toHaveBeenCalledOnce()
  })

  it('stops synchronously on identity-changing and restarts only after identity-changed', async () => {
    const events = new EventTarget()
    vi.stubGlobal('window', events)
    try {
      const harness = createHarness()
      const lifecycle = createAppRuntimeLifecycle(
        {
          mode: ref('observe'),
          allowUnrestricted: ref(false),
          getActiveProjectId: () => 'project-1',
          openProject: vi.fn(),
          openNotificationCenter: vi.fn(),
          togglePushToTalk: vi.fn(),
        },
        harness.dependencies
      )
      await lifecycle.start()
      await vi.waitFor(() => expect(harness.dependencies.startDeviceJobChannel).toHaveBeenCalledOnce())

      events.dispatchEvent(new Event('luczor:api-identity-changing'))
      expect(harness.stopDeviceJobChannel).toHaveBeenCalledOnce()
      expect(harness.stopDeviceJobs).toHaveBeenCalledOnce()
      expect(harness.dependencies.startDeviceJobChannel).toHaveBeenCalledOnce()

      events.dispatchEvent(new Event('luczor:api-identity-changed'))
      await vi.waitFor(() => expect(harness.dependencies.startDeviceJobChannel).toHaveBeenCalledTimes(2))
      lifecycle.stop()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('disposes late channel starts and an old stop callback cannot replace the restarted channel', async () => {
    const events = new EventTarget()
    vi.stubGlobal('window', events)
    try {
      const harness = createHarness()
      const oldStart = deferred<() => void>()
      const newStart = deferred<() => void>()
      const oldStop = vi.fn()
      const newStop = vi.fn()
      vi.mocked(harness.dependencies.startDeviceJobChannel)
        .mockImplementationOnce(() => oldStart.promise)
        .mockImplementationOnce(() => newStart.promise)
      const lifecycle = createAppRuntimeLifecycle(
        {
          mode: ref('observe'),
          allowUnrestricted: ref(false),
          getActiveProjectId: () => 'project-1',
          openProject: vi.fn(),
          openNotificationCenter: vi.fn(),
          togglePushToTalk: vi.fn(),
        },
        harness.dependencies
      )
      await lifecycle.start()
      events.dispatchEvent(new Event('luczor:api-identity-changing'))
      events.dispatchEvent(new Event('luczor:api-identity-changed'))
      newStart.resolve(newStop)
      await Promise.resolve()
      oldStart.resolve(oldStop)
      await Promise.resolve()
      expect(oldStop).toHaveBeenCalledOnce()
      expect(newStop).not.toHaveBeenCalled()
      lifecycle.stop()
      expect(newStop).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not retain a channel whose start resolves after runtime stop', async () => {
    const harness = createHarness()
    const pendingStart = deferred<() => void>()
    const lateStop = vi.fn()
    vi.mocked(harness.dependencies.startDeviceJobChannel).mockImplementationOnce(() => pendingStart.promise)
    const lifecycle = createAppRuntimeLifecycle(
      {
        mode: ref('observe'),
        allowUnrestricted: ref(false),
        getActiveProjectId: () => 'project-1',
        openProject: vi.fn(),
        openNotificationCenter: vi.fn(),
        togglePushToTalk: vi.fn(),
      },
      harness.dependencies
    )
    await lifecycle.start()
    lifecycle.stop()
    pendingStart.resolve(lateStop)
    await Promise.resolve()
    expect(lateStop).toHaveBeenCalledOnce()
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

  it('keeps local inference blocked when bootstrap fails', async () => {
    const harness = createHarness()
    vi.mocked(harness.dependencies.bootstrap).mockRejectedValueOnce(new Error('offline'))
    const lifecycle = createAppRuntimeLifecycle(
      {
        mode: ref('observe'),
        allowUnrestricted: ref(false),
        getActiveProjectId: () => 'project-1',
        openProject: vi.fn(),
        openNotificationCenter: vi.fn(),
        togglePushToTalk: vi.fn(),
      },
      harness.dependencies
    )

    await lifecycle.start()
    await vi.waitFor(() => expect(harness.dependencies.markLocalInferenceBootstrapUnavailable).toHaveBeenCalledWith(41))
    expect(harness.dependencies.beginLocalInferenceBootstrap).toHaveBeenCalledOnce()
    expect(harness.dependencies.initializeLocalInference).not.toHaveBeenCalled()
  })

  it('does not start network bootstrap when the native renderer boundary cannot be reset', async () => {
    const harness = createHarness()
    vi.mocked(harness.dependencies.beginLocalInferenceBootstrap!).mockRejectedValueOnce(
      new Error('native boundary unavailable')
    )
    const lifecycle = createAppRuntimeLifecycle(
      {
        mode: ref('observe'),
        allowUnrestricted: ref(false),
        getActiveProjectId: () => 'project-1',
        openProject: vi.fn(),
        openNotificationCenter: vi.fn(),
        togglePushToTalk: vi.fn(),
      },
      harness.dependencies
    )

    await lifecycle.start()

    expect(harness.dependencies.bootstrap).not.toHaveBeenCalled()
    expect(harness.dependencies.initializeLocalInference).not.toHaveBeenCalled()
    expect(harness.dependencies.markLocalInferenceBootstrapUnavailable).toHaveBeenCalled()
  })

  it('does not apply remote policy from a bootstrap superseded by a newer identity generation', async () => {
    const harness = createHarness(true)
    vi.mocked(harness.dependencies.initializeLocalInference!).mockResolvedValueOnce(false)
    harness.values.set('allow_unrestricted', false)
    const allowUnrestricted = ref(false)
    const lifecycle = createAppRuntimeLifecycle(
      {
        mode: ref<'observe' | 'act' | 'unrestricted'>('observe'),
        allowUnrestricted,
        getActiveProjectId: () => 'project-1',
        openProject: vi.fn(),
        openNotificationCenter: vi.fn(),
        togglePushToTalk: vi.fn(),
      },
      harness.dependencies
    )

    await lifecycle.start()
    await vi.waitFor(() => expect(harness.dependencies.initializeLocalInference).toHaveBeenCalledOnce())
    expect(allowUnrestricted.value).toBe(false)
    expect(harness.settings.save).not.toHaveBeenCalled()
  })
})
