import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppNotification } from '@/services/api/luczorApi'

const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn<() => Promise<boolean>>(),
  requestPermission: vi.fn<() => Promise<NotificationPermission>>(),
}))

const tauriCore = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

const tauriEvents = vi.hoisted(() => {
  let callback: ((event: { payload: unknown }) => void) | null = null
  return {
    listen: vi.fn(async (_event: string, listener: (event: { payload: unknown }) => void) => {
      callback = listener
      return vi.fn()
    }),
    reset: () => {
      callback = null
    },
    fire: (payload: unknown) => callback?.({ payload }),
  }
})

const localStore = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  const instance = {
    get: vi.fn(async (key: string) => values.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value)
    }),
    save: vi.fn(async () => undefined),
  }
  return {
    values,
    instance,
    load: vi.fn(async () => instance),
  }
})

const api = vi.hoisted(() => ({
  getApiConfig: vi.fn(),
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-notification', () => plugin)
vi.mock('@tauri-apps/api/core', () => tauriCore)
vi.mock('@tauri-apps/api/event', () => ({ listen: tauriEvents.listen }))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: localStore.load },
}))
vi.mock('@/services/api/luczorApi', () => ({
  APP_NOTIFICATION_CATEGORIES: ['general', 'agent', 'workflow', 'device', 'security'],
  getApiConfig: api.getApiConfig,
  LuczorApi: {
    getNotificationPreferences: api.getNotificationPreferences,
    updateNotificationPreferences: api.updateNotificationPreferences,
    listNotifications: api.listNotifications,
    markNotificationRead: api.markNotificationRead,
    markAllNotificationsRead: api.markAllNotificationsRead,
  },
}))

const notification = (overrides: Partial<AppNotification> = {}): AppNotification => ({
  id: '01J-NOTIFICATION-1',
  sequence: 42,
  category: 'workflow',
  title: 'Workflow abgeschlossen',
  body: 'Der Lauf wurde erfolgreich beendet.',
  action_url: 'luczor://notifications/01J-NOTIFICATION-1',
  data: { workflow_id: 'wf-1' },
  priority: 'normal',
  created_at: '2026-07-28T10:00:00.000Z',
  expires_at: null,
  read_at: null,
  ...overrides,
})

describe('native notification transport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    localStore.values.clear()
    localStore.values.set('push_notifications_enabled_on_device', true)
    plugin.isPermissionGranted.mockResolvedValue(true)
    plugin.requestPermission.mockResolvedValue('granted')
    tauriCore.invoke.mockResolvedValue(undefined)
    tauriEvents.reset()
    api.getApiConfig.mockResolvedValue({ clientId: 'client-1' })
    api.getNotificationPreferences.mockResolvedValue({
      data: {
        enabled: true,
        categories: { general: true, agent: true, workflow: true, device: true, security: true },
        effective_categories: { general: true, agent: true, workflow: true, device: true, security: true },
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('validates the exact notification.created payload', async () => {
    const { isAppNotification } = await import('@/services/notifications')

    expect(isAppNotification(notification())).toBe(true)
    expect(isAppNotification({ ...notification(), sequence: '42' })).toBe(false)
    expect(isAppNotification({ ...notification(), category: 'unknown' })).toBe(false)
    expect(isAppNotification({ ...notification(), data: [] })).toBe(false)
  })

  test('sends one native notification per stable server ID', async () => {
    const { showNativeNotification } = await import('@/services/notifications')
    const payload = notification()

    const [first, concurrentDuplicate] = await Promise.all([
      showNativeNotification(payload),
      showNativeNotification(payload),
    ])
    expect(first).toBe(true)
    expect(concurrentDuplicate).toBe(false)
    expect(await showNativeNotification(payload)).toBe(false)
    expect(tauriCore.invoke).toHaveBeenCalledTimes(1)
    expect(tauriCore.invoke).toHaveBeenCalledWith('show_native_notification', {
      payload: {
        notificationId: payload.id,
        title: payload.title,
        body: payload.body,
        category: 'workflow',
        priority: 'normal',
        actionUrl: payload.action_url,
      },
    })
  })

  test('does not request OS permission from an incoming background event', async () => {
    plugin.isPermissionGranted.mockResolvedValue(false)
    const { showNativeNotification } = await import('@/services/notifications')

    expect(await showNativeNotification(notification())).toBe(false)
    expect(plugin.requestPermission).not.toHaveBeenCalled()
    expect(tauriCore.invoke).not.toHaveBeenCalled()
  })

  test('does not treat an out-of-order realtime event as the REST catch-up cursor', async () => {
    const { handleRealtimeNotification } = await import('@/services/notifications')

    await expect(handleRealtimeNotification(notification({ sequence: 44 }))).resolves.toBe(true)
    expect(localStore.values.has('push_notifications_cursor')).toBe(false)
  })

  test('does not deliver on a locally paused installation', async () => {
    localStore.values.set('push_notifications_enabled_on_device', false)
    const { showNativeNotification } = await import('@/services/notifications')

    expect(await showNativeNotification(notification())).toBe(false)
    expect(plugin.isPermissionGranted).not.toHaveBeenCalled()
    expect(tauriCore.invoke).not.toHaveBeenCalled()
  })

  test('shares one permission prompt between concurrent explicit opt-ins', async () => {
    plugin.isPermissionGranted.mockResolvedValue(false)
    const serverPreferences = {
      enabled: true,
      categories: { general: true, agent: true, workflow: true, device: true, security: true },
      effective_categories: { general: true, agent: true, workflow: true, device: true, security: true },
    }
    api.updateNotificationPreferences.mockResolvedValue({ data: serverPreferences })
    const { setPushNotificationPreferences } = await import('@/services/notifications')

    const results = await Promise.all([
      setPushNotificationPreferences({ enabled: true }),
      setPushNotificationPreferences({ enabled: true }),
    ])

    expect(results).toEqual([serverPreferences, serverPreferences])
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1)
    expect(api.updateNotificationPreferences).toHaveBeenCalledTimes(2)
  })

  test('does not deliver expired or denied notifications', async () => {
    const { showNativeNotification } = await import('@/services/notifications')

    expect(await showNativeNotification(notification({ expires_at: '2000-01-01T00:00:00.000Z' }))).toBe(false)
    expect(plugin.isPermissionGranted).not.toHaveBeenCalled()

    plugin.isPermissionGranted.mockResolvedValue(false)
    plugin.requestPermission.mockResolvedValue('denied')
    expect(await showNativeNotification(notification({ id: 'denied' }))).toBe(false)
    expect(tauriCore.invoke).not.toHaveBeenCalled()
  })

  test('persists server opt-in only after native permission is granted', async () => {
    const serverPreferences = {
      enabled: true,
      categories: { general: true, agent: true, workflow: true, device: true, security: true },
      effective_categories: { general: true, agent: true, workflow: true, device: true, security: true },
    }
    api.updateNotificationPreferences.mockResolvedValue({ data: serverPreferences })
    const { setPushNotificationPreferences } = await import('@/services/notifications')

    await expect(setPushNotificationPreferences({ enabled: true })).resolves.toEqual(serverPreferences)
    expect(api.updateNotificationPreferences).toHaveBeenCalledWith('client-1', { enabled: true })
    expect(localStore.values.get('push_notifications_enabled_on_device')).toBe(true)

    vi.resetModules()
    vi.clearAllMocks()
    api.getApiConfig.mockResolvedValue({ clientId: 'client-1' })
    plugin.isPermissionGranted.mockResolvedValue(false)
    plugin.requestPermission.mockResolvedValue('denied')
    const deniedModule = await import('@/services/notifications')

    await expect(deniedModule.setPushNotificationPreferences({ enabled: true })).rejects.toThrow(
      'Betriebssystem-Berechtigung'
    )
    expect(api.updateNotificationPreferences).not.toHaveBeenCalled()
  })

  test('pauses only this installation without disabling the user-wide server gate', async () => {
    const serverPreferences = {
      enabled: true,
      categories: { general: true, agent: true, workflow: true, device: true, security: true },
      effective_categories: { general: true, agent: true, workflow: true, device: true, security: true },
    }
    api.getNotificationPreferences.mockResolvedValue({ data: serverPreferences })
    const { setPushNotificationPreferences } = await import('@/services/notifications')

    const result = await setPushNotificationPreferences({ enabled: false })

    expect(api.updateNotificationPreferences).not.toHaveBeenCalled()
    expect(api.getNotificationPreferences).toHaveBeenCalledWith('client-1')
    expect(localStore.values.get('push_notifications_enabled_on_device')).toBe(false)
    expect(result.enabled).toBe(false)
    expect(Object.values(result.effective_categories).every(value => value === false)).toBe(true)
  })

  test('pauses this installation even while the server is offline', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    api.getNotificationPreferences.mockRejectedValue(new Error('offline'))
    const { setPushNotificationPreferences } = await import('@/services/notifications')

    await expect(setPushNotificationPreferences({ enabled: false })).resolves.toMatchObject({
      enabled: false,
    })
    expect(localStore.values.get('push_notifications_enabled_on_device')).toBe(false)
    expect(warning).toHaveBeenCalledWith(
      '[notifications] device paused locally while server was unavailable',
      expect.any(Error)
    )
    warning.mockRestore()
  })

  test('catches up persisted notifications and resumes from the saved cursor', async () => {
    api.listNotifications
      .mockResolvedValueOnce({
        data: [notification({ id: 'catch-up-43', sequence: 43 })],
        meta: { next_after: 43, has_more: true, unread_count: 2 },
      })
      .mockResolvedValueOnce({
        data: [notification({ id: 'catch-up-44', sequence: 44 })],
        meta: { next_after: 44, has_more: false, unread_count: 2 },
      })
    const { catchUpPushNotifications } = await import('@/services/notifications')

    await expect(catchUpPushNotifications()).resolves.toBe(2)
    expect(api.listNotifications).toHaveBeenNthCalledWith(1, 'client-1', {
      after: 0,
      limit: 50,
    })
    expect(api.listNotifications).toHaveBeenNthCalledWith(2, 'client-1', {
      after: 43,
      limit: 50,
    })
    expect(tauriCore.invoke).toHaveBeenCalledTimes(2)
    expect(localStore.values.get('push_notifications_cursor')).toBe(44)
  })

  test('advances catch-up past categories disabled by the server without showing a toast', async () => {
    api.getNotificationPreferences.mockResolvedValue({
      data: {
        enabled: true,
        categories: { general: true, agent: true, workflow: false, device: true, security: true },
        effective_categories: { general: true, agent: true, workflow: false, device: true, security: true },
      },
    })
    api.listNotifications.mockResolvedValue({
      data: [notification({ id: 'muted-workflow', sequence: 45 })],
      meta: { next_after: 45, has_more: false, unread_count: 1 },
    })
    const { catchUpPushNotifications } = await import('@/services/notifications')

    await expect(catchUpPushNotifications()).resolves.toBe(1)
    expect(tauriCore.invoke).not.toHaveBeenCalled()
    expect(localStore.values.get('push_notifications_cursor')).toBe(45)
  })

  test('marks an activated desktop toast read and opens the internal notification view', async () => {
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', eventTarget)
    api.markNotificationRead.mockResolvedValue({
      data: notification({ read_at: '2026-07-28T12:00:00.000Z' }),
      meta: { unread_count: 0 },
    })
    const opened = vi.fn()
    eventTarget.addEventListener('luczor:notification-action', opened)
    const { startNativeNotificationActionListener } = await import('@/services/notifications')

    const stop = await startNativeNotificationActionListener()
    tauriEvents.fire({
      notificationId: '01J-NOTIFICATION-1',
      actionUrl: 'luczor://notifications/01J-NOTIFICATION-1',
    })

    await vi.waitFor(() => {
      expect(api.markNotificationRead).toHaveBeenCalledWith('01J-NOTIFICATION-1', 'client-1')
      expect(opened).toHaveBeenCalledTimes(1)
    })
    await stop()
  })
})
