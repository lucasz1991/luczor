import { Store } from '@tauri-apps/plugin-store'
import { state } from '@/state/store'
import { getApiConfig, LuczorApi } from '@/services/api/luczorApi'
import { voiceRuntimeStatus, type VoiceRuntimeStatus } from '@/services/voice/localVoice'

const SETTINGS_STORE = 'luczor.settings.json'
const DEBUG_STORE = 'luczor.debug.json'
const DEBUG_EVENTS = 'events'
const MAX_EVENTS = 300
const POLL_INTERVAL_MS = 20_000
const REPORTABLE_EVENTS = new Set([
  'api_config_missing',
  'api_http_error',
  'api_network_error',
  'api_response_too_large',
  'assistant_request_failed',
  'auto_tts_failed',
  'client_event',
  'continuous_stt_failed',
  'debug_collector_failed',
  'debug_report_uploaded',
  'device_key_missing',
  'local_stt_failed',
  'local_tts_failed',
  'local_tts_playback_failed',
  'manual_tts_failed',
  'unhandledrejection',
  'voice_runtime_install_failed',
  'whisper_rs_fallback',
  'window.error',
])

export const DEBUG_COLLECTION_ENABLED_KEY = 'debug_collection_enabled'

let installed = false
let polling = false

type DebugLevel = 'info' | 'warn' | 'error'
type DebugScalar = string | number | boolean | null

export type DebugEvent = {
  at: string
  level: DebugLevel
  event: string
  detail?: DebugScalar | DebugScalar[] | { [key: string]: unknown }
}

export type DebugReportEvent = Pick<DebugEvent, 'level' | 'event'> & { count: number }

export type DebugReport = {
  version: 'luczor-debug-v2'
  created_at: string
  consent: { diagnostics_enabled: true }
  runtime: { tauri_webview: boolean }
  voice_runtime: {
    state: VoiceRuntimeStatus['state'] | 'unavailable'
    version: string | null
    stt_ready: boolean
    tts_ready: boolean
    error_present: boolean
  }
  app_state: {
    project_count: number
    message_count: number
    visible_message_count: number
    hidden_message_count: number
    messages_by_role: { user: number; assistant: number; tool: number }
  }
  debug_events: DebugReportEvent[]
}

export type DebugCollectionResult = 'disabled' | 'unconfigured' | 'idle' | 'uploaded' | 'failed'

const SENSITIVE_KEY =
  /(?:api[_-]?key|authorization|bearer|client[_-]?id|content|device[_-]?key|email|filename|message|name|password|path|prompt|project|reason|request[_-]?id|secret|source|text|token|url|wake[_-]?word)/i

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^,\s}]+/gi, '[REDACTED]')
    .replace(/[A-Z]:\\[^\s]+/gi, '[LOCAL_PATH]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .slice(0, 240)
}

function sanitizeLocalDetail(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[OMITTED]'
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeLocalDetail(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[OMITTED]' : sanitizeLocalDetail(item, depth + 1)])
    )
  }
  return undefined
}

function normalizeEventName(value: unknown): string {
  if (typeof value !== 'string') return 'client_event'
  const normalized = value.trim().slice(0, 80)
  return /^[a-z0-9_.:-]+$/i.test(normalized) ? normalized : 'client_event'
}

function reportableEventName(value: unknown): string {
  const normalized = normalizeEventName(value)
  return REPORTABLE_EVENTS.has(normalized) ? normalized : 'client_event'
}

function normalizeLevel(value: unknown): DebugLevel {
  return value === 'info' || value === 'warn' || value === 'error' ? value : 'error'
}

function safeTechnicalVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().slice(0, 40)
  const numeric = normalized.startsWith('v') ? normalized.slice(1) : normalized
  const parts = numeric.split('.')
  const isSafe =
    parts.length >= 2 &&
    parts.length <= 4 &&
    parts.every(part => part.length >= 1 && part.length <= 4 && [...part].every(char => char >= '0' && char <= '9'))
  return isSafe ? normalized : null
}

export async function loadDebugCollectionEnabled(): Promise<boolean> {
  const store = await Store.load(SETTINGS_STORE)
  return (await store.get<unknown>(DEBUG_COLLECTION_ENABLED_KEY)) === true
}

export async function getDebugCollectionEnabled(): Promise<boolean> {
  try {
    return await loadDebugCollectionEnabled()
  } catch {
    return false
  }
}

export async function setDebugCollectionEnabled(enabled: boolean): Promise<void> {
  const store = await Store.load(SETTINGS_STORE)
  await store.set(DEBUG_COLLECTION_ENABLED_KEY, enabled === true)
  await store.save()
}

export async function clearDebugData(): Promise<void> {
  const store = await Store.load(DEBUG_STORE)
  await store.clear()
  await store.save()
}

export async function recordDebugEvent(level: DebugLevel, event: string, detail?: unknown): Promise<void> {
  if (!(await getDebugCollectionEnabled())) return

  try {
    const store = await Store.load(DEBUG_STORE)
    const stored = (await store.get<DebugEvent[]>(DEBUG_EVENTS)) ?? []
    const events = Array.isArray(stored) ? stored : []
    const safeDetail = sanitizeLocalDetail(detail)
    const next: DebugEvent = {
      at: new Date().toISOString(),
      level: normalizeLevel(level),
      event: normalizeEventName(event),
      ...(safeDetail === undefined ? {} : { detail: safeDetail as DebugEvent['detail'] }),
    }

    // A concurrent opt-out must win over an event already being prepared.
    if (!(await getDebugCollectionEnabled())) return
    await store.set(DEBUG_EVENTS, [...events, next].slice(-MAX_EVENTS))
    await store.save()
  } catch {
    // Diagnostics must never interfere with the assistant.
  }
}

async function readReportEvents(): Promise<DebugReportEvent[]> {
  try {
    const store = await Store.load(DEBUG_STORE)
    const events = (await store.get<DebugEvent[]>(DEBUG_EVENTS)) ?? []
    if (!Array.isArray(events)) return []
    const counts = new Map<string, DebugReportEvent>()
    for (const storedEvent of events.slice(-MAX_EVENTS)) {
      const level = normalizeLevel(storedEvent?.level)
      const event = reportableEventName(storedEvent?.event)
      const key = `${level}:${event}`
      const current = counts.get(key)
      if (current) current.count += 1
      else counts.set(key, { level, event, count: 1 })
    }
    return [...counts.values()]
  } catch {
    return []
  }
}

function summarizeVoiceRuntime(status: VoiceRuntimeStatus | null): DebugReport['voice_runtime'] {
  if (!status) {
    return {
      state: 'unavailable',
      version: null,
      stt_ready: false,
      tts_ready: false,
      error_present: true,
    }
  }
  return {
    state: status.state,
    version: safeTechnicalVersion(status.version),
    stt_ready: status.stt_ready === true,
    tts_ready: status.tts_ready === true,
    error_present: typeof status.error === 'string' && status.error.length > 0,
  }
}

function summarizeAppState(): DebugReport['app_state'] {
  const roleCounts = { user: 0, assistant: 0, tool: 0 }
  let visible = 0
  let hidden = 0
  for (const message of state.messages) {
    if (message.visibility === 'hidden') hidden += 1
    else visible += 1
    roleCounts[message.role] += 1
  }
  return {
    project_count: state.projects.length,
    message_count: state.messages.length,
    visible_message_count: visible,
    hidden_message_count: hidden,
    messages_by_role: roleCounts,
  }
}

export async function buildDebugReport(): Promise<DebugReport> {
  if (!(await getDebugCollectionEnabled())) {
    throw new Error('Diagnostic collection is disabled.')
  }

  let voice: VoiceRuntimeStatus | null = null
  try {
    voice = await voiceRuntimeStatus()
  } catch {
    // Only report that the runtime was unavailable; never include native error text or local paths.
  }

  return {
    version: 'luczor-debug-v2',
    created_at: new Date().toISOString(),
    consent: { diagnostics_enabled: true },
    runtime: {
      tauri_webview: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
    },
    voice_runtime: summarizeVoiceRuntime(voice),
    app_state: summarizeAppState(),
    debug_events: await readReportEvents(),
  }
}

export function installDebugCapture(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('luczor:debug', event => {
    const detail = (event as CustomEvent).detail as { level?: DebugLevel; event?: string; detail?: unknown }
    void recordDebugEvent(detail?.level ?? 'error', detail?.event ?? 'client_event', detail?.detail)
  })
  window.addEventListener('error', event => {
    void recordDebugEvent('error', 'window.error', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
    })
  })
  window.addEventListener('unhandledrejection', event => {
    void recordDebugEvent('error', 'unhandledrejection', { reason: String(event.reason) })
  })
}

export async function collectRequestedDebugReport(): Promise<DebugCollectionResult> {
  if (!(await getDebugCollectionEnabled())) return 'disabled'

  try {
    const cfg = await getApiConfig()
    if (!cfg.deviceKey) return 'unconfigured'
    const response = await LuczorApi.pollDebugRequest()
    const request = response.data
    if (!request?.id) return 'idle'

    if (!(await getDebugCollectionEnabled())) return 'disabled'
    const report = await buildDebugReport()
    // Consent can be revoked while the report is assembled; never upload after that point.
    if (!(await getDebugCollectionEnabled())) return 'disabled'
    await LuczorApi.completeDebugRequest(request.id, report)
    await recordDebugEvent('info', 'debug_report_uploaded')
    return 'uploaded'
  } catch (error) {
    await recordDebugEvent('warn', 'debug_collector_failed', { message: String(error) })
    return 'failed'
  }
}

/**
 * Starts a local timer only. Every collection attempt independently verifies
 * explicit consent before reading API configuration or contacting the server.
 */
export async function startDebugCollector(): Promise<void> {
  if (polling) return
  polling = true
  installDebugCapture()
  await collectRequestedDebugReport()
  if (typeof window !== 'undefined') {
    window.setInterval(() => void collectRequestedDebugReport(), POLL_INTERVAL_MS)
  }
}
