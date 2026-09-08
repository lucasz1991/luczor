import Pusher from 'pusher-js'
import { invoke } from '@tauri-apps/api/core'
import { LuczorApi, getApiConfig, type DeviceJob, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import { runWorkflowAgent } from '@/services/agents/workflowAgent'
import { executionGate, invokeGuarded, type ExecutionTicket } from '@/services/executionGate'
import { requestConfirmation } from '@/services/confirmation'
import {
  catchUpPushNotifications,
  handleRealtimeNotification,
  REALTIME_NOTIFICATION_EVENT,
} from '@/services/notifications'
import { isWorkflowTaskBundle, runWorkflowTask, type WorkflowTaskPrimitives } from '@/services/workflowTaskRunner'
import { isDurableWorkflowJob, runWorkflowDeviceJob } from '@/services/workflows/execution'

let stop: (() => void) | null = null
const inFlight = new Set<string>()
let pollInFlight: { session: number; promise: Promise<void> } | null = null
let sessionCounter = 0
type ChannelSession = { id: number; isCurrent: () => boolean; signal: AbortSignal; config: LuczorApiConfigSnapshot }

export type DeviceJobChannelState = {
  running: boolean
  rest: 'stopped' | 'polling' | 'error'
  realtime: 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable'
  lastError: string | null
  lastPollAt: number | null
  lastRealtimeAt: number | null
}

let channelState: DeviceJobChannelState = {
  running: false,
  rest: 'stopped',
  realtime: 'stopped',
  lastError: null,
  lastPollAt: null,
  lastRealtimeAt: null,
}

const BACKGROUND_POLL_INTERVAL_MS = 60_000

export function shouldPollDeviceJobs(
  now: number,
  lastPollAt: number | null,
  visibility: DocumentVisibilityState,
  online: boolean
): boolean {
  if (!online) return false
  if (visibility === 'visible' || lastPollAt === null) return true
  return now - lastPollAt >= BACKGROUND_POLL_INTERVAL_MS
}

export function getDeviceJobChannelState(): DeviceJobChannelState {
  return { ...channelState }
}

function updateChannelState(patch: Partial<DeviceJobChannelState>): void {
  channelState = { ...channelState, ...patch }
  window.dispatchEvent(new CustomEvent('luczor://device-channel-state', { detail: getDeviceJobChannelState() }))
}

/** Synchronously retires both an established channel and a start waiting on configuration. */
export function stopDeviceJobChannel(): void {
  if (stop) {
    stop()
    return
  }
  sessionCounter++
}

export async function startDeviceJobChannel(): Promise<() => void> {
  stop?.()
  const session = ++sessionCounter
  let active = true
  const controller = new AbortController()
  let cleanupStartedResources: (() => void) | null = null
  let pusher: Pusher | null = null
  let channelName: string | null = null

  const isCurrent = () => active && session === sessionCounter
  const deactivate = (publishStoppedState: boolean) => {
    if (!active) return
    const wasCurrent = session === sessionCounter
    active = false
    controller.abort()
    if (wasCurrent) sessionCounter++
    cleanupStartedResources?.()
    if (pusher) {
      pusher.connection.unbind_all()
      if (channelName) pusher.unsubscribe(channelName)
      pusher.disconnect()
    }
    if (stop === stopThis) stop = null
    if (publishStoppedState && wasCurrent) {
      updateChannelState({ running: false, rest: 'stopped', realtime: 'stopped', lastError: null })
    }
  }
  const stopThis = () => deactivate(true)
  stop = stopThis

  let config: Awaited<ReturnType<typeof getApiConfig>>
  try {
    config = Object.freeze({ ...(await getApiConfig()) })
  } catch (error) {
    if (!isCurrent()) return stopThis
    deactivate(false)
    updateChannelState({ running: false, rest: 'stopped', realtime: 'stopped', lastError: errorMessage(error) })
    throw error
  }
  if (!isCurrent()) return stopThis
  if (!config.deviceKey) {
    deactivate(false)
    updateChannelState({
      running: false,
      rest: 'stopped',
      realtime: 'stopped',
      lastError: 'Ein Device-Key ist für den Gerätekanal erforderlich.',
    })
    throw new Error('Ein Device-Key ist für den Gerätekanal erforderlich.')
  }

  const channelSession: ChannelSession = {
    id: session,
    isCurrent,
    signal: controller.signal,
    config,
  }
  let realtimeRetryTimer: number | null = null
  let realtimeAttempt = 0
  let realtimeSetupInFlight = false

  const scheduleRealtimeSetup = (delayMs = 0) => {
    if (!active || session !== sessionCounter || realtimeSetupInFlight || pusher) return
    if (realtimeRetryTimer !== null) window.clearTimeout(realtimeRetryTimer)
    realtimeRetryTimer = window.setTimeout(() => {
      realtimeRetryTimer = null
      void setupRealtime()
    }, delayMs)
  }
  const setupRealtime = async () => {
    if (!active || session !== sessionCounter || realtimeSetupInFlight || pusher) return
    realtimeSetupInFlight = true
    const connection = await connectRealtime(config, session, () => active, controller.signal)
    realtimeSetupInFlight = false
    if (!active || session !== sessionCounter) {
      connection?.pusher.disconnect()
      return
    }
    if (connection) {
      pusher = connection.pusher
      channelName = connection.channelName
      realtimeAttempt = 0
      return
    }
    const baseDelay = Math.min(60_000, 1_000 * 2 ** Math.min(realtimeAttempt++, 6))
    const jitter = Math.floor(Math.random() * Math.min(1_000, baseDelay / 4))
    scheduleRealtimeSetup(baseDelay + jitter)
  }

  const syncNotifications = () => {
    if (!channelSession.isCurrent()) return
    void catchUpPushNotifications().catch(error => {
      if (channelSession.isCurrent()) console.warn('[notifications] catch-up failed', error)
    })
  }
  const syncWhenVisible = () => {
    if (!channelSession.isCurrent()) return
    if (document.visibilityState === 'visible') {
      syncNotifications()
      pollNow()
    }
  }
  const pollNow = () => {
    if (!active || session !== sessionCounter) return
    if (
      !shouldPollDeviceJobs(Date.now(), channelState.lastPollAt, document.visibilityState, navigator.onLine !== false)
    )
      return
    void pullPending(config.clientId, channelSession)
  }
  const syncOnline = () => {
    if (!channelSession.isCurrent()) return
    syncNotifications()
    pollNow()
    if (pusher && pusher.connection.state === 'disconnected') pusher.connect()
    if (!pusher) scheduleRealtimeSetup()
  }

  // REST is the durable transport and starts before any Reverb registration or
  // configuration request. Realtime is an optional latency optimization.
  updateChannelState({
    running: true,
    rest: 'polling',
    realtime: 'connecting',
    lastError: null,
  })
  window.addEventListener('online', syncOnline)
  document.addEventListener('visibilitychange', syncWhenVisible)
  syncNotifications()
  pollNow()
  const timer = window.setInterval(pollNow, 20_000)

  cleanupStartedResources = () => {
    window.clearInterval(timer)
    if (realtimeRetryTimer !== null) window.clearTimeout(realtimeRetryTimer)
    window.removeEventListener('online', syncOnline)
    document.removeEventListener('visibilitychange', syncWhenVisible)
  }

  void setupRealtime()

  return stopThis
}

async function pullPending(clientId: string, session: ChannelSession): Promise<void> {
  if (pollInFlight?.session === session.id) return pollInFlight.promise
  const promise = pullPendingBatch(clientId, session).finally(() => {
    if (pollInFlight?.session === session.id) pollInFlight = null
  })
  pollInFlight = { session: session.id, promise }
  return promise
}

async function pullPendingBatch(clientId: string, session: ChannelSession): Promise<void> {
  try {
    for (let count = 0; count < 25; count++) {
      if (!session.isCurrent()) return
      const response = await LuczorApi.nextDeviceJob(clientId, session.config, session.signal)
      if (!session.isCurrent()) return
      if (!response.data) break
      if (!(await safeProcessJob(clientId, response.data, session))) break
    }
    if (!session.isCurrent()) return
    updateChannelState({ rest: 'polling', lastPollAt: Date.now() })
  } catch (error) {
    if (!session.isCurrent()) return
    updateChannelState({ rest: 'error', lastError: errorMessage(error) })
    console.warn('[device-jobs] poll failed', error)
  }
}

async function connectRealtime(
  config: Awaited<ReturnType<typeof getApiConfig>>,
  session: number,
  isActive: () => boolean,
  signal: AbortSignal
): Promise<{ pusher: Pusher; channelName: string } | null> {
  try {
    if (!isActive() || session !== sessionCounter) return null
    const registration = await LuczorApi.registerDevice(config.clientId, deviceName())
    if (!isActive() || session !== sessionCounter) return null
    const realtime = (await LuczorApi.realtimeConfig()).data
    if (!isActive() || session !== sessionCounter) return null
    if (!realtime?.key) throw new Error('Der Reverb-Gerätekanal ist auf dem Server nicht konfiguriert.')

    const endpoint = new URL(config.baseUrl)
    const host = realtime.host || endpoint.hostname
    const secure = (realtime.scheme ?? endpoint.protocol.replace(':', '')) === 'https'
    const port = realtime.port || Number(endpoint.port || (secure ? 443 : 80))
    const channelName = `private-device.${config.clientId}`
    const pusher = new Pusher(realtime.key, {
      cluster: 'mt1',
      wsHost: host,
      wsPort: port,
      wssPort: port,
      forceTLS: secure,
      enabledTransports: secure ? ['wss'] : ['ws'],
      channelAuthorization: {
        customHandler: async ({ socketId, channelName: requestedChannel }, callback) => {
          const stale = () => new Error('Gerätekanalsitzung wurde beendet.')
          try {
            if (!isActive() || session !== sessionCounter) {
              callback(stale(), null)
              return
            }
            const auth = await LuczorApi.reverbAuth(
              socketId,
              requestedChannel,
              config.clientId,
              registration.session.token
            )
            if (!isActive() || session !== sessionCounter) {
              callback(stale(), null)
              return
            }
            callback(null, auth)
          } catch (error) {
            if (!isActive() || session !== sessionCounter) {
              callback(stale(), null)
              return
            }
            callback(error instanceof Error ? error : new Error(String(error)), null)
          }
        },
      },
    })
    const channel = pusher.subscribe(channelName)
    const current: ChannelSession = {
      id: session,
      isCurrent: () => isActive() && session === sessionCounter,
      signal,
      config,
    }
    channel.bind('device.job.created', (job: DeviceJob) => {
      if (current.isCurrent()) void safeProcessJob(config.clientId, job, current)
    })
    channel.bind(REALTIME_NOTIFICATION_EVENT, (payload: unknown) => {
      if (!current.isCurrent()) return
      void (async () => {
        await handleRealtimeNotification(payload)
        if (!current.isCurrent()) return
        await catchUpPushNotifications()
      })().catch(error => {
        if (current.isCurrent()) console.warn('[notifications] realtime handling failed', error)
      })
    })
    channel.bind('pusher:subscription_error', (error: unknown) => {
      if (current.isCurrent()) updateChannelState({ realtime: 'unavailable', lastError: errorMessage(error) })
    })
    pusher.connection.bind('connecting', () => {
      if (current.isCurrent()) updateChannelState({ realtime: 'connecting' })
    })
    pusher.connection.bind('connected', () => {
      if (!current.isCurrent()) return
      updateChannelState({ realtime: 'connected', lastError: null, lastRealtimeAt: Date.now() })
      void (async () => {
        await catchUpPushNotifications()
        if (!current.isCurrent()) return
        await pullPending(config.clientId, current)
      })().catch(error => {
        if (current.isCurrent()) console.warn('[notifications] catch-up failed', error)
      })
    })
    pusher.connection.bind('disconnected', () => {
      if (current.isCurrent()) updateChannelState({ realtime: 'reconnecting' })
    })
    pusher.connection.bind('unavailable', () => {
      if (current.isCurrent())
        updateChannelState({
          realtime: 'unavailable',
          lastError: 'Reverb ist nicht erreichbar; REST-Polling bleibt aktiv.',
        })
    })
    pusher.connection.bind('failed', () => {
      if (current.isCurrent())
        updateChannelState({
          realtime: 'unavailable',
          lastError: 'Reverb-Verbindung ist fehlgeschlagen; REST-Polling bleibt aktiv.',
        })
    })
    pusher.connection.bind('error', (error: unknown) => {
      if (current.isCurrent()) updateChannelState({ realtime: 'reconnecting', lastError: errorMessage(error) })
    })
    return { pusher, channelName }
  } catch (error) {
    if (isActive() && session === sessionCounter) {
      updateChannelState({ realtime: 'unavailable', lastError: errorMessage(error) })
      console.warn('[device-jobs] realtime unavailable; REST polling remains active', error)
    }
    return null
  }
}

async function safeProcessJob(clientId: string, job: DeviceJob, session: ChannelSession): Promise<boolean> {
  try {
    if (!session.isCurrent()) return false
    await processJob(clientId, job, session)
    return true
  } catch (error) {
    if (!session.isCurrent()) return false
    updateChannelState({ lastError: errorMessage(error) })
    console.warn('[device-jobs] job failed before completion', { jobId: job.id, error })
    return false
  }
}

async function processJob(clientId: string, incoming: DeviceJob, session: ChannelSession): Promise<void> {
  const job = structuredClone(incoming)
  const key = `${session.id}:${job.id}`
  if (inFlight.has(key)) return
  inFlight.add(key)
  const ticket = executionGate.capture(session.signal)
  // Only the signed personal chat scope has no tools; workspace jobs still require Act.
  const personalChat = job.tool_profile === 'workspace.chat' && job.payload?.scope === 'personal'
  const mutating =
    !personalChat &&
    !['desktop.capture_screen', 'desktop.clipboard.read', 'desktop.windows.list'].includes(job.tool_profile)
  const assertCurrent = () => {
    if (!session.isCurrent()) throw new Error('Gerätekanalsitzung wurde beendet.')
    executionGate.assert(ticket, mutating)
  }
  try {
    assertCurrent()
    await invoke('verify_device_job', { payload: job })
    assertCurrent()
    // Approval is local, complete and bound to a private immutable copy of the signed payload.
    const preview = await deviceJobApprovalPreview(job)
    assertCurrent()
    if (isDurableWorkflowJob(job)) {
      await runWorkflowDeviceJob(job, session.config, ticket, assertCurrent, preview)
      return
    }
    const confirmation = await requestConfirmation(preview, 'Luczor – Geräteauftrag freigeben')
    assertCurrent()
    if (confirmation.error) throw new Error(confirmation.error)
    const approved = confirmation.approved
    if (job.status === 'approval_required') {
      await LuczorApi.approveDeviceJob(
        job.id,
        clientId,
        approved,
        approved ? undefined : 'Rejected on local device',
        session.config,
        ticket.signal
      )
      assertCurrent()
    }
    if (!approved) {
      if (job.status === 'approval_required') return
      await LuczorApi.completeDeviceJob(
        job.id,
        clientId,
        false,
        undefined,
        'Rejected on local device',
        session.config,
        ticket.signal
      )
      return
    }
    await LuczorApi.startDeviceJob(job.id, clientId, session.config, ticket.signal)
    assertCurrent()
    try {
      const result = await executeProfile(job, ticket, assertCurrent, session.config)
      assertCurrent()
      const success = result.ok !== false
      await LuczorApi.completeDeviceJob(
        job.id,
        clientId,
        success,
        result,
        success ? undefined : 'Die Aktion meldete einen Fehler.',
        session.config,
        ticket.signal
      )
    } catch (error) {
      if (!session.isCurrent() || ticket.signal.aborted) return
      await LuczorApi.completeDeviceJob(
        job.id,
        clientId,
        false,
        undefined,
        error instanceof Error ? error.message : String(error),
        session.config,
        ticket.signal
      )
    }
  } finally {
    inFlight.delete(key)
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'error' in error) return String((error as { error: unknown }).error)
  return 'Unbekannter Gerätekanal-Fehler'
}

async function executeProfile(
  job: DeviceJob,
  ticket: ExecutionTicket,
  assertCurrent: () => void,
  config: LuczorApiConfigSnapshot
): Promise<Record<string, unknown>> {
  const payload = job.payload
  switch (job.tool_profile) {
    case 'desktop.capture_screen': {
      const shot = await invoke<{ width: number; height: number }>('capture_screen')
      return { captured: true, width: shot.width, height: shot.height }
    }
    case 'desktop.clipboard.read': {
      const text = await invoke<string>('read_clipboard')
      return { length: text.length }
    }
    case 'desktop.windows.list': {
      const windows = await invoke<unknown[]>('list_windows')
      return { count: windows.length }
    }
    case 'desktop.input.move_mouse':
      await invokeGuarded('move_mouse', { ...payload, x: Number(payload.x), y: Number(payload.y) }, ticket)
      return { ok: true }
    case 'desktop.input.click':
      await invokeGuarded('mouse_click', payload, ticket)
      return { ok: true }
    case 'desktop.input.type_text':
      await invokeGuarded('type_text', { ...payload, text: String(payload.text ?? '') }, ticket)
      return { ok: true }
    case 'desktop.input.press_key':
      await invokeGuarded('press_key', { ...payload, key: String(payload.key ?? '') }, ticket)
      return { ok: true }
    case 'desktop.open_url':
      await invokeGuarded('open_url', { url: String(payload.url ?? '') }, ticket)
      return { ok: true }
    // SOLL §14 P15b — a workflow client task compiled into a bundle.
    case 'workflow.task': {
      if (!isWorkflowTaskBundle(payload)) throw new Error('Malformed workflow.task bundle.')
      return runWorkflowTask(payload, workflowPrimitives(ticket, assertCurrent))
    }
    case 'workspace.chat': {
      const { runWebWorkspaceJob } = await import('@/services/webWorkspaceJob')
      assertCurrent()
      return runWebWorkspaceJob(payload, ticket, assertCurrent, job.id, config)
    }
    default:
      throw new Error(`Unsupported signed tool profile: ${job.tool_profile}`)
  }
}

/** Real, Tauri-backed effects for workflow client tasks (see workflowTaskRunner). */
function workflowPrimitives(ticket: ExecutionTicket, assertCurrent: () => void): WorkflowTaskPrimitives {
  async function guarded<T>(command: string, payload: Record<string, unknown>, mutating = true): Promise<T> {
    assertCurrent()
    const result = await invokeGuarded<T>(command, payload, ticket, mutating)
    assertCurrent()
    return result
  }
  return {
    openUrl: url => guarded('open_url', { url }),
    httpFetch: async (method, url, headers, body) => {
      return guarded('wf_http_request', { method, url, headers, body, timeout_seconds: 30 })
    },
    runAgent: (agent, prompt, projectDir) => {
      assertCurrent()
      return runWorkflowAgent(agent, prompt, projectDir, ticket.signal)
    },
    fileRead: path => guarded('wf_file_read', { path }, false),
    fileWrite: (path, content) => guarded('wf_file_write', { path, content }),
    runScript: (runtime, code, timeoutSeconds) =>
      guarded('wf_run_script', {
        runtime,
        code,
        timeout_seconds: timeoutSeconds ?? null,
        fullAccessAcknowledged: true,
      }),
    browserOpen: url => guarded('browser_open', { url: url ?? null }),
    browserClick: (selector, expectedUrl) => guarded('browser_click', { selector, expectedUrl }),
    browserRead: (selector, expectedUrl) => guarded('browser_read', { selector: selector ?? null, expectedUrl }, false),
  }
}

/** A human-readable approval line; workflow bundles name the concrete task. */
export async function deviceJobApprovalPreview(job: DeviceJob): Promise<string> {
  const payload = JSON.stringify(job.payload, null, 2)
  if (payload.length > 24_000)
    throw new Error('Aktion zu groß für die vollständige lokale Freigabe (maximal 24000 Zeichen).')
  const data = new TextEncoder().encode(
    JSON.stringify({ id: job.id, tool_profile: job.tool_profile, payload: job.payload })
  )
  const digest = await crypto.subtle.digest('SHA-256', data)
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  const script =
    job.tool_profile === 'workflow.task' && ['python.run', 'node.run'].includes(String(job.payload.task_key))
  return `Geräteaktion: ${job.tool_profile}\nID: ${job.id}\nSHA-256: ${hash}\n${script ? '\nLokales Skript mit Vollzugriff auf Benutzerdateien und Netzwerk. Vollzugriff-Modus erforderlich.\n' : ''}\nVollständiger Auftrag:\n${payload}\n\nEinmal ausführen?`
}

function deviceName(): string {
  return `Luczor ${navigator.platform || 'desktop'}`.slice(0, 120)
}
