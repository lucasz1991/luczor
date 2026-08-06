import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification'
import { Store } from '@tauri-apps/plugin-store'
import {
  APP_NOTIFICATION_CATEGORIES,
  LuczorApi,
  getApiConfig,
  type AppNotification,
  type NotificationListOptions,
  type NotificationListResponse,
  type NotificationPreferences,
  type NotificationPreferencesPatch,
} from '@/services/api/luczorApi'

export const REALTIME_NOTIFICATION_EVENT = 'notification.created'
export const NATIVE_NOTIFICATION_ACTION_EVENT = 'luczor:notification-action'

const MAX_SESSION_DEDUPLICATION_IDS = 512
const MAX_CATCH_UP_PAGES = 20
const NOTIFICATION_STORE_FILE = 'luczor.settings.json'
const PUSH_ENABLED_ON_DEVICE_KEY = 'push_notifications_enabled_on_device'
const PUSH_CURSOR_KEY = 'push_notifications_cursor'
const deliveredIds = new Set<string>()
const deliveryInFlightIds = new Set<string>()
const deliveredIdQueue: string[] = []
let permissionRequestInFlight: Promise<boolean> | null = null
let permissionWasRequested = false
let highestNotificationSequence = 0
let cursorLoaded = false
let cursorWriteChain: Promise<void> = Promise.resolve()
let lastKnownServerPreferences: NotificationPreferences | null = null
let catchUpInFlight: Promise<number> | null = null
let catchUpRequested = false

export class NativeNotificationPermissionError extends Error {
  constructor() {
    super('Die Betriebssystem-Berechtigung für Push-Benachrichtigungen wurde nicht erteilt.')
    this.name = 'NativeNotificationPermissionError'
  }
}

export function isAppNotification(value: unknown): value is AppNotification {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    APP_NOTIFICATION_CATEGORIES.includes(value.category as AppNotification['category']) &&
    typeof value.title === 'string' &&
    typeof value.body === 'string' &&
    (value.action_url === null || typeof value.action_url === 'string') &&
    isRecord(value.data) &&
    (value.priority === 'low' || value.priority === 'normal' || value.priority === 'high') &&
    typeof value.created_at === 'string' &&
    (value.expires_at === null || typeof value.expires_at === 'string') &&
    (value.read_at === null || typeof value.read_at === 'string')
  )
}

export async function hasNativeNotificationPermission(): Promise<boolean> {
  try {
    return await isPermissionGranted()
  } catch (error) {
    console.warn('[notifications] permission check failed', error)
    return false
  }
}

/**
 * Requests the OS permission at most once per app session. Concurrent callers
 * share one request so multiple Reverb events cannot open duplicate prompts.
 */
export async function requestNativeNotificationPermission(): Promise<boolean> {
  if (await hasNativeNotificationPermission()) return true
  if (permissionRequestInFlight) return permissionRequestInFlight
  if (permissionWasRequested) return false

  permissionWasRequested = true
  permissionRequestInFlight = requestPermission()
    .then(permission => permission === 'granted')
    .catch(error => {
      console.warn('[notifications] permission request failed', error)
      return false
    })
    .finally(() => {
      permissionRequestInFlight = null
    })
  return permissionRequestInFlight
}

export async function showNativeNotification(notification: AppNotification): Promise<boolean> {
  if (isExpired(notification) || deliveredIds.has(notification.id) || deliveryInFlightIds.has(notification.id)) {
    return false
  }

  deliveryInFlightIds.add(notification.id)
  try {
    if (!(await isPushEnabledOnThisDevice())) return false
    // Incoming background events must never trigger an OS permission prompt.
    // Permission is requested only from the explicit Settings opt-in action.
    if (!(await hasNativeNotificationPermission())) return false

    await invoke('show_native_notification', {
      payload: {
        notificationId: notification.id,
        title: notification.title,
        body: notification.body,
        category: notification.category,
        priority: notification.priority,
        actionUrl: notification.action_url,
      },
    })
    rememberDelivered(notification.id)
    return true
  } finally {
    deliveryInFlightIds.delete(notification.id)
  }
}

/** Safely handles untyped Pusher payloads without disrupting the device channel. */
export async function handleRealtimeNotification(payload: unknown): Promise<boolean> {
  if (!isAppNotification(payload)) {
    console.warn('[notifications] ignored malformed notification.created payload', payload)
    return false
  }
  let delivered = false
  try {
    delivered = await showNativeNotification(payload)
  } catch (error) {
    console.warn('[notifications] native delivery failed', error)
  }
  // A realtime event is not a safe REST high-water mark: an older offline
  // item may still be waiting in the inbox. The device channel schedules a
  // catch-up after this delivery, which advances the cursor in server order.
  return delivered
}

/**
 * The server preference is the user-wide delivery gate while the local store
 * is the explicit opt-in for this installation. Disabling one desktop must not
 * silently switch off another connected desktop owned by the same user.
 */
export async function setPushNotificationPreferences(
  patch: NotificationPreferencesPatch
): Promise<NotificationPreferences> {
  if (patch.enabled === true && !(await requestNativeNotificationPermission())) {
    throw new NativeNotificationPermissionError()
  }
  if (patch.enabled === false) {
    // Pausing this installation is local-first and must also work offline.
    await setPushEnabledOnThisDevice(false)
  }

  const { clientId } = await getApiConfig()
  const serverPatch: NotificationPreferencesPatch = { ...patch }
  if (patch.enabled === false) delete serverPatch.enabled

  let serverPreferences: NotificationPreferences
  try {
    if (Object.keys(serverPatch).length > 0) {
      serverPreferences = (await LuczorApi.updateNotificationPreferences(clientId, serverPatch)).data
    } else {
      serverPreferences = (await LuczorApi.getNotificationPreferences(clientId)).data
    }
  } catch (error) {
    if (patch.enabled !== false) throw error
    console.warn('[notifications] device paused locally while server was unavailable', error)
    return applyDevicePreference(lastKnownServerPreferences ?? fallbackServerPreferences(), false)
  }
  lastKnownServerPreferences = serverPreferences

  if (patch.enabled === true) {
    await setPushEnabledOnThisDevice(true)
  }

  return applyDevicePreference(serverPreferences, await isPushEnabledOnThisDevice())
}

export async function getPushNotificationPreferences(): Promise<NotificationPreferences> {
  const { clientId } = await getApiConfig()
  const serverPreferences = (await LuczorApi.getNotificationPreferences(clientId)).data
  lastKnownServerPreferences = serverPreferences
  return applyDevicePreference(serverPreferences, await isPushEnabledOnThisDevice())
}

export async function listPushNotifications(options: NotificationListOptions = {}): Promise<NotificationListResponse> {
  const { clientId } = await getApiConfig()
  return LuczorApi.listNotifications(clientId, options)
}

export async function markPushNotificationRead(
  id: string
): Promise<{ notification: AppNotification; unreadCount: number }> {
  const { clientId } = await getApiConfig()
  const response = await LuczorApi.markNotificationRead(id, clientId)
  return { notification: response.data, unreadCount: response.meta.unread_count }
}

export async function markAllPushNotificationsRead(
  through?: number
): Promise<{ updated: number; readAt: string; unreadCount: number }> {
  const { clientId } = await getApiConfig()
  const response = await LuczorApi.markAllNotificationsRead(clientId, through)
  return {
    updated: response.data.updated,
    readAt: response.data.read_at,
    unreadCount: response.meta.unread_count,
  }
}

/**
 * Replays notifications stored while the app was offline. The cursor is saved
 * even when this installation is opted out, so enabling later never causes a
 * burst of notifications that arrived during the paused period.
 */
export async function catchUpPushNotifications(): Promise<number> {
  if (catchUpInFlight) {
    catchUpRequested = true
    return catchUpInFlight
  }

  catchUpInFlight = (async () => {
    let total = 0
    do {
      catchUpRequested = false
      total += await runPushNotificationCatchUpPass()
    } while (catchUpRequested)
    return total
  })().finally(() => {
    catchUpInFlight = null
  })

  return catchUpInFlight
}

async function runPushNotificationCatchUpPass(): Promise<number> {
  let after = await getNotificationCursor()
  let processed = 0
  const preferences = await getPushNotificationPreferences()

  for (let page = 0; page < MAX_CATCH_UP_PAGES; page += 1) {
    const response = await listPushNotifications({ after, limit: 50 })
    for (const notification of response.data) {
      if (!isAppNotification(notification)) {
        console.warn('[notifications] ignored malformed catch-up payload', notification)
        continue
      }
      try {
        if (preferences.effective_categories[notification.category]) {
          await showNativeNotification(notification)
        }
      } catch (error) {
        console.warn('[notifications] catch-up delivery failed', error)
      }
      await advanceNotificationCursor(notification.sequence)
      after = Math.max(after, notification.sequence)
      processed += 1
    }

    after = Math.max(after, response.meta.next_after)
    await advanceNotificationCursor(after)
    if (!response.meta.has_more) break
    if (page === MAX_CATCH_UP_PAGES - 1) catchUpRequested = true
  }

  return processed
}

/**
 * Handles a native notification click without ever opening an arbitrary URL.
 * The app is focused, the persisted inbox item is marked read, and the Vue
 * shell receives one internal event to open its notification settings/inbox.
 */
export async function startNativeNotificationActionListener(): Promise<() => Promise<void>> {
  const unlisten = await listen<NativeNotificationActionPayload>(NATIVE_NOTIFICATION_ACTION_EVENT, event => {
    void handleNativeNotificationAction(event.payload)
  })
  return async () => unlisten()
}

type NativeNotificationActionPayload = {
  notificationId: string
  actionUrl: string | null
}

async function handleNativeNotificationAction(payload: NativeNotificationActionPayload): Promise<void> {
  const notificationId = typeof payload.notificationId === 'string' ? payload.notificationId : null
  const actionUrl = typeof payload.actionUrl === 'string' ? payload.actionUrl : null

  if (notificationId) {
    try {
      await markPushNotificationRead(notificationId)
    } catch (error) {
      console.warn('[notifications] notification could not be marked read', error)
    }
  }

  window.dispatchEvent(
    new CustomEvent(NATIVE_NOTIFICATION_ACTION_EVENT, {
      detail: {
        notificationId,
        actionUrl: actionUrl?.startsWith('luczor://') ? actionUrl : null,
      },
    })
  )
}

async function notificationStore() {
  return Store.load(NOTIFICATION_STORE_FILE)
}

export async function isPushEnabledOnThisDevice(): Promise<boolean> {
  const store = await notificationStore()
  return (await store.get<boolean>(PUSH_ENABLED_ON_DEVICE_KEY)) === true
}

async function setPushEnabledOnThisDevice(enabled: boolean): Promise<void> {
  const store = await notificationStore()
  await store.set(PUSH_ENABLED_ON_DEVICE_KEY, enabled)
  await store.save()
}

function applyDevicePreference(
  serverPreferences: NotificationPreferences,
  deviceEnabled: boolean
): NotificationPreferences {
  const enabled = serverPreferences.enabled && deviceEnabled
  return {
    ...serverPreferences,
    enabled,
    effective_categories: Object.fromEntries(
      APP_NOTIFICATION_CATEGORIES.map(category => [
        category,
        enabled && serverPreferences.effective_categories[category],
      ])
    ) as NotificationPreferences['effective_categories'],
  }
}

function fallbackServerPreferences(): NotificationPreferences {
  const categories = Object.fromEntries(
    APP_NOTIFICATION_CATEGORIES.map(category => [category, true])
  ) as NotificationPreferences['categories']
  return {
    enabled: true,
    categories,
    effective_categories: { ...categories },
  }
}

async function getNotificationCursor(): Promise<number> {
  await cursorWriteChain
  if (cursorLoaded) return highestNotificationSequence

  const store = await notificationStore()
  const stored = await store.get<unknown>(PUSH_CURSOR_KEY)
  highestNotificationSequence = typeof stored === 'number' && Number.isSafeInteger(stored) && stored >= 0 ? stored : 0
  cursorLoaded = true
  return highestNotificationSequence
}

async function advanceNotificationCursor(sequence: number): Promise<void> {
  if (!Number.isSafeInteger(sequence) || sequence < 0) return

  cursorWriteChain = cursorWriteChain
    .catch(() => undefined)
    .then(async () => {
      if (!cursorLoaded) {
        const store = await notificationStore()
        const stored = await store.get<unknown>(PUSH_CURSOR_KEY)
        highestNotificationSequence =
          typeof stored === 'number' && Number.isSafeInteger(stored) && stored >= 0 ? stored : 0
        cursorLoaded = true
      }
      if (sequence <= highestNotificationSequence) return

      highestNotificationSequence = sequence
      const store = await notificationStore()
      await store.set(PUSH_CURSOR_KEY, sequence)
      await store.save()
    })

  await cursorWriteChain
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExpired(notification: AppNotification): boolean {
  if (!notification.expires_at) return false
  const expiresAt = Date.parse(notification.expires_at)
  return Number.isFinite(expiresAt) && expiresAt < Date.now()
}

function rememberDelivered(id: string): void {
  deliveredIds.add(id)
  deliveredIdQueue.push(id)
  if (deliveredIdQueue.length <= MAX_SESSION_DEDUPLICATION_IDS) return
  const oldest = deliveredIdQueue.shift()
  if (oldest) deliveredIds.delete(oldest)
}
