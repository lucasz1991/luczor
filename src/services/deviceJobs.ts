import Pusher from 'pusher-js'
import { invoke } from '@tauri-apps/api/core'
import { LuczorApi, getApiConfig, type DeviceJob } from '@/services/api/luczorApi'
import { runAgentCli } from '@/services/agents'
import {
  catchUpPushNotifications,
  handleRealtimeNotification,
  REALTIME_NOTIFICATION_EVENT,
} from '@/services/notifications'
import { isWorkflowTaskBundle, runWorkflowTask, type WorkflowTaskPrimitives } from '@/services/workflowTaskRunner'

let stop: (() => void) | null = null
const inFlight = new Set<string>()
let pollInFlight: Promise<void> | null = null
let sessionCounter = 0

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

export async function startDeviceJobChannel(): Promise<() => void> {
  stop?.()
  const session = ++sessionCounter
  const config = await getApiConfig()
  if (!config.deviceKey) {
    updateChannelState({
      running: false,
      rest: 'stopped',
      realtime: 'stopped',
      lastError: 'Ein Device-Key ist für den Gerätekanal erforderlich.',
    })
    throw new Error('Ein Device-Key ist für den Gerätekanal erforderlich.')
  }

  let active = true
  let pusher: Pusher | null = null
  let channelName: string | null = null
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
    const connection = await connectRealtime(config, session, () => active)
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
    void catchUpPushNotifications().catch(error => console.warn('[notifications] catch-up failed', error))
  }
  const syncWhenVisible = () => {
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
    void pullPending(config.clientId)
  }
  const syncOnline = () => {
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

  stop = () => {
    if (!active) return
    active = false
    sessionCounter++
    window.clearInterval(timer)
    if (realtimeRetryTimer !== null) window.clearTimeout(realtimeRetryTimer)
    window.removeEventListener('online', syncOnline)
    document.removeEventListener('visibilitychange', syncWhenVisible)
    if (pusher) {
      pusher.connection.unbind_all()
      if (channelName) pusher.unsubscribe(channelName)
      pusher.disconnect()
    }
    updateChannelState({
      running: false,
      rest: 'stopped',
      realtime: 'stopped',
      lastError: null,
    })
    stop = null
  }

  void setupRealtime()

  return stop
}

async function pullPending(clientId: string): Promise<void> {
  if (pollInFlight) return pollInFlight
  pollInFlight = pullPendingBatch(clientId).finally(() => {
    pollInFlight = null
  })
  return pollInFlight
}

async function pullPendingBatch(clientId: string): Promise<void> {
  try {
    for (let count = 0; count < 25; count++) {
      const response = await LuczorApi.nextDeviceJob(clientId)
      if (!response.data) break
      if (!(await safeProcessJob(clientId, response.data))) break
    }
    updateChannelState({ rest: 'polling', lastPollAt: Date.now() })
  } catch (error) {
    updateChannelState({ rest: 'error', lastError: errorMessage(error) })
    console.warn('[device-jobs] poll failed', error)
  }
}

async function connectRealtime(
  config: Awaited<ReturnType<typeof getApiConfig>>,
  session: number,
  isActive: () => boolean
): Promise<{ pusher: Pusher; channelName: string } | null> {
  try {
    const registration = await LuczorApi.registerDevice(config.clientId, deviceName())
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
          try {
            const auth = await LuczorApi.reverbAuth(
              socketId,
              requestedChannel,
              config.clientId,
              registration.session.token
            )
            callback(null, auth)
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)), null)
          }
        },
      },
    })
    const channel = pusher.subscribe(channelName)
    channel.bind('device.job.created', (job: DeviceJob) => void safeProcessJob(config.clientId, job))
    channel.bind(REALTIME_NOTIFICATION_EVENT, (payload: unknown) => {
      void handleRealtimeNotification(payload).finally(() => {
        void catchUpPushNotifications().catch(error => console.warn('[notifications] catch-up failed', error))
      })
    })
    channel.bind('pusher:subscription_error', (error: unknown) => {
      updateChannelState({ realtime: 'unavailable', lastError: errorMessage(error) })
    })
    pusher.connection.bind('connecting', () => updateChannelState({ realtime: 'connecting' }))
    pusher.connection.bind('connected', () => {
      updateChannelState({ realtime: 'connected', lastError: null, lastRealtimeAt: Date.now() })
      void catchUpPushNotifications().catch(error => console.warn('[notifications] catch-up failed', error))
      void pullPending(config.clientId)
    })
    pusher.connection.bind('disconnected', () => {
      if (isActive()) updateChannelState({ realtime: 'reconnecting' })
    })
    pusher.connection.bind('unavailable', () => {
      if (isActive())
        updateChannelState({
          realtime: 'unavailable',
          lastError: 'Reverb ist nicht erreichbar; REST-Polling bleibt aktiv.',
        })
    })
    pusher.connection.bind('failed', () => {
      if (isActive())
        updateChannelState({
          realtime: 'unavailable',
          lastError: 'Reverb-Verbindung ist fehlgeschlagen; REST-Polling bleibt aktiv.',
        })
    })
    pusher.connection.bind('error', (error: unknown) => {
      if (isActive()) updateChannelState({ realtime: 'reconnecting', lastError: errorMessage(error) })
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

async function safeProcessJob(clientId: string, job: DeviceJob): Promise<boolean> {
  try {
    await processJob(clientId, job)
    return true
  } catch (error) {
    updateChannelState({ lastError: errorMessage(error) })
    console.warn('[device-jobs] job failed before completion', { jobId: job.id, error })
    return false
  }
}

async function processJob(clientId: string, job: DeviceJob): Promise<void> {
  if (inFlight.has(job.id)) return
  inFlight.add(job.id)
  try {
    await invoke('verify_device_job', { payload: job })
    if (job.status === 'approval_required') {
      const approved = window.confirm(approvalPrompt(job))
      await LuczorApi.approveDeviceJob(job.id, clientId, approved, approved ? undefined : 'Rejected on local device')
      if (!approved) return
    }
    await LuczorApi.startDeviceJob(job.id, clientId)
    try {
      const result = await executeProfile(job)
      await LuczorApi.completeDeviceJob(job.id, clientId, true, result)
    } catch (error) {
      await LuczorApi.completeDeviceJob(
        job.id,
        clientId,
        false,
        undefined,
        error instanceof Error ? error.message : String(error)
      )
    }
  } finally {
    inFlight.delete(job.id)
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'error' in error) return String((error as { error: unknown }).error)
  return 'Unbekannter Gerätekanal-Fehler'
}

async function executeProfile(job: DeviceJob): Promise<Record<string, unknown>> {
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
      await invoke('move_mouse', { payload: { x: Number(payload.x), y: Number(payload.y) } })
      return { ok: true }
    case 'desktop.input.click':
      await invoke('mouse_click', { payload })
      return { ok: true }
    case 'desktop.input.type_text':
      await invoke('type_text', { payload: { text: String(payload.text ?? '') } })
      return { ok: true }
    case 'desktop.input.press_key':
      await invoke('press_key', { payload: { key: String(payload.key ?? '') } })
      return { ok: true }
    case 'desktop.open_url':
      await invoke('open_url', { payload: { url: String(payload.url ?? '') } })
      return { ok: true }
    // SOLL §14 P15b — a workflow client task compiled into a bundle.
    case 'workflow.task': {
      if (!isWorkflowTaskBundle(payload)) throw new Error('Malformed workflow.task bundle.')
      return runWorkflowTask(payload, WORKFLOW_TASK_PRIMITIVES)
    }
    default:
      throw new Error(`Unsupported signed tool profile: ${job.tool_profile}`)
  }
}

/** Real, Tauri-backed effects for workflow client tasks (see workflowTaskRunner). */
const WORKFLOW_TASK_PRIMITIVES: WorkflowTaskPrimitives = {
  openUrl: url => invoke('open_url', { payload: { url } }),
  httpFetch: async (method, url, headers, body) => {
    return invoke<{ status: number; ok: boolean; body: string; truncated: boolean }>('wf_http_request', {
      payload: { method, url, headers, body, timeout_seconds: 30 },
    })
  },
  runAgent: (agent, prompt, projectDir) => runAgentCli(agent as 'claude' | 'codex', prompt, projectDir),
  fileRead: path => invoke('wf_file_read', { payload: { path } }),
  fileWrite: (path, content) => invoke('wf_file_write', { payload: { path, content } }),
  runScript: (runtime, code, timeoutSeconds) =>
    invoke('wf_run_script', { payload: { runtime, code, timeout_seconds: timeoutSeconds ?? null } }),
  browserOpen: url => invoke('browser_open', { payload: { url: url ?? null } }),
  browserClick: selector => invoke('browser_click', { payload: { selector } }),
  browserRead: selector => invoke('browser_read', { payload: { selector: selector ?? null } }),
}

/** A human-readable approval line; workflow bundles name the concrete task. */
function approvalPrompt(job: DeviceJob): string {
  if (job.tool_profile === 'workflow.task' && isWorkflowTaskBundle(job.payload)) {
    const wf = job.payload.workflow
    return `Workflow-Aktion: ${job.payload.task_key}\nSchritt „${wf?.step_key ?? '?'}" · Lauf ${wf?.run ?? '?'}\n\nAusführen?`
  }
  return `Remote action: ${job.tool_profile}`
}

function deviceName(): string {
  return `Luczor ${navigator.platform || 'desktop'}`.slice(0, 120)
}
