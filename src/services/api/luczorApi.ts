// src/services/api/luczorApi.ts
//
// Typed client for the Luczor Admin API (Laravel, admin_api_app).
//
// Auth: a Custom Device Key sent as `Authorization: Bearer <key>`
// (the server also accepts `X-Api-Key`). Base URL + a stable client_id live in
// the local settings store; the device key lives in the OS credential store.
//
// Endpoints (all under /api/v1):
//   GET  /health                      (no auth)
//   GET  /bootstrap                   (settings.read)
//   GET  /model-profiles              (settings.read)
//   GET  /runtime-settings            (settings.read)
//   GET  /realtime/config             (device.connect)
//   POST /sync/push                   (sync.write)
//   GET  /sync/pull?since=ISO         (sync.read)
//   POST /agent-events                (brain.write)

import { Store } from '@tauri-apps/plugin-store'
import { loadDeviceKey, saveDeviceKey } from '@/services/secureDeviceKey'
import { DEFAULT_API_BASE_URL } from './endpoint'
import { apiTransportFetch } from './transportTarget'
import type { AssistantProfile } from '@/services/assistantProfileTypes'
import { projectExternalIdForServer } from '@/services/cloudProjectAccess'

const SETTINGS_FILE = 'luczor.settings.json'
const API_PREFIX = '/api/v1'
const MAX_API_RESPONSE_BYTES = 5 * 1024 * 1024
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000

/** Production API. Always used when the user has not set a custom URL. */
export const DEFAULT_BASE_URL = DEFAULT_API_BASE_URL

/* =========================================================
 * Response/request types (match admin_api_app controllers)
 * ========================================================= */
export type RuntimeSettings = {
  api_prefix: string
  registration_enabled: boolean
  /** Admin-managed client defaults (Setting::asMap()); consumed by pullServerDefaults. */
  settings?: Record<string, unknown>
}

export type BootstrapResponse = {
  assistant_profile?: AssistantProfile
  device: { id: string | null; name: string | null; abilities: string[] }
  user: { id: number | null; name: string | null; email: string | null }
  runtime_settings: RuntimeSettings
  routing: {
    managed_by: 'server'
    client_model_selection: false
    legacy_scope?: 'external_provider'
    external_routing_managed_by?: 'server'
    external_client_model_selection?: false
    local_routing_managed_by?: 'desktop_signed_policy'
    local_model_manifest_required?: true
  }
  local_model_manifest?: {
    url: '/api/v1/local-model/manifest'
    schema_version: 1 | 2
    catalog_version: number
    policy_version: number
    key_id: string
    available: boolean
  }
  realtime?: { key: string | null; host: string | null; port: number; scheme: string | null }
}

export type RealtimeConfig = {
  key: string | null
  host: string | null
  port: number
  scheme: string | null
}

export type SyncBatch = {
  client_id: string
  projects?: unknown[]
  messages?: unknown[]
  memories?: unknown[]
  summaries?: unknown[]
}

export type SyncPushResponse = { ok: boolean; counts: Record<string, number>; cursor: string }
export const SYNC_BUCKETS = ['projects', 'messages', 'memories', 'summaries'] as const
export type SyncBucket = (typeof SYNC_BUCKETS)[number]
export type SyncBucketData = Record<SyncBucket, unknown[]>
export type SyncContinuation = Record<SyncBucket, { has_more: boolean; cursor: string }>
export type SyncPullResponse = {
  data: SyncBucketData
  cursor: string
  has_more: boolean
  continuation: SyncContinuation
}
export type SyncPullOptions = {
  since?: string
  limit?: number
  cursors?: Partial<Record<SyncBucket, string>>
}
export type SyncPullAllOptions = Omit<SyncPullOptions, 'cursors'> & {
  maxPages?: number
  maxItems?: number
}
export type SyncPullAllResponse = SyncPullResponse & { pages: number; item_count: number }

export type AgentEventInput = {
  external_id?: string
  event_type?: string
  payload: Record<string, unknown>
  occurred_at_client?: number | string
}

export type LuczorApiConfig = {
  baseUrl: string
  deviceKey: string
  clientId: string
}

export type LuczorApiConfigSnapshot = Readonly<LuczorApiConfig>

export type VoiceManifestResponse = {
  algorithm: 'RSA-SHA256'
  payload_json: string
  signature: string
}

export type DeviceSession = { token: string; nonce: string; expires_at: string }
export type DeviceJob = {
  id: string
  tool_profile: string
  status: 'approval_required' | 'queued' | 'running' | string
  risk_level: string
  requires_local_approval: boolean
  payload: Record<string, unknown>
  payload_hash: string
  signature: string
  expires_at: string | null
}

export const APP_NOTIFICATION_CATEGORIES = ['general', 'agent', 'workflow', 'device', 'security'] as const
export type AppNotificationCategory = (typeof APP_NOTIFICATION_CATEGORIES)[number]
export type NotificationCategoryPreferences = Record<AppNotificationCategory, boolean>
export type NotificationPriority = 'low' | 'normal' | 'high'

export type AppNotification = {
  id: string
  sequence: number
  category: AppNotificationCategory
  title: string
  body: string
  action_url: string | null
  data: Record<string, unknown>
  priority: NotificationPriority
  created_at: string
  expires_at: string | null
  read_at: string | null
}

export type NotificationPreferences = {
  enabled: boolean
  categories: NotificationCategoryPreferences
  effective_categories: NotificationCategoryPreferences
}

export type NotificationPreferencesPatch = {
  enabled?: boolean
  categories?: Partial<NotificationCategoryPreferences>
}

export type NotificationListOptions = {
  after?: number
  limit?: number
  unreadOnly?: boolean
}

export type NotificationListResponse = {
  data: AppNotification[]
  meta: {
    next_after: number
    has_more: boolean
    unread_count: number
  }
}

/* =========================================================
 * Config (persisted in the settings store)
 * ========================================================= */
function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `c_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
}

async function store() {
  return Store.load(SETTINGS_FILE)
}

/** Load config, minting a stable client_id on first use. */
export async function getApiConfig(): Promise<LuczorApiConfig> {
  const s = await store()
  const stored = ((await s.get<string>('luczor_api_base_url')) ?? '').trim().replace(/\/+$/, '')
  const baseUrl = stored || DEFAULT_BASE_URL // default always applies
  const deviceKey = (await loadDeviceKey()).trim()

  let clientId = ((await s.get<string>('luczor_client_id')) ?? '').trim()
  if (!clientId) {
    clientId = `luczor_${randomId()}`
    await s.set('luczor_client_id', clientId)
    await s.save()
  }
  return { baseUrl, deviceKey, clientId }
}

/**
 * Capture the complete API identity once. Callers that combine authentication
 * with account-scoped local state must keep using this exact immutable object
 * for the whole operation.
 */
export async function getApiConfigSnapshot(): Promise<LuczorApiConfigSnapshot> {
  return Object.freeze({ ...(await getApiConfig()) })
}

export async function saveApiConfig(baseUrl: string, deviceKey: string): Promise<void> {
  const s = await store()
  await s.set('luczor_api_base_url', baseUrl.trim().replace(/\/+$/, ''))
  await s.save()
  await saveDeviceKey(deviceKey)
}

export function isConfigured(cfg: LuczorApiConfig): boolean {
  return !!cfg.baseUrl && !!cfg.deviceKey
}

/* =========================================================
 * Transport
 * ========================================================= */
export class LuczorApiError extends Error {
  status: number
  correlationId?: string
  code?: string

  constructor(status: number, message: string, correlationId?: string, code?: unknown) {
    super(message)
    this.name = 'LuczorApiError'
    this.status = status
    this.correlationId = correlationId
    this.code = typeof code === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(code) ? code : undefined
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('Request aborted.')
  error.name = 'AbortError'
  return error
}

function abortDeadline(callerSignal: AbortSignal | null | undefined, timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Fetch timeout must be greater than zero.')

  const controller = new AbortController()
  let rejectCancellation: (reason: Error) => void = () => undefined
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })
  const cancelFromCaller = () => {
    const reason = callerSignal ? abortError(callerSignal) : new Error('Request aborted.')
    controller.abort(reason)
    rejectCancellation(reason)
  }
  if (callerSignal?.aborted) cancelFromCaller()
  else callerSignal?.addEventListener('abort', cancelFromCaller, { once: true })
  const timeoutId = globalThis.setTimeout(() => {
    const error = new Error(`Request timed out after ${timeoutMs} ms.`)
    error.name = 'TimeoutError'
    controller.abort(error)
    rejectCancellation(error)
  }, timeoutMs)

  return {
    signal: controller.signal,
    cancellation,
    dispose() {
      globalThis.clearTimeout(timeoutId)
      callerSignal?.removeEventListener('abort', cancelFromCaller)
    },
  }
}

/**
 * Execute a fetch with a hard deadline. The explicit rejection race is
 * intentional: it also settles callers when a test double or non-conforming
 * transport ignores AbortSignal entirely.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  if (init.signal?.aborted) throw abortError(init.signal)
  const deadline = abortDeadline(init.signal, timeoutMs)

  try {
    return await Promise.race([apiTransportFetch(input, { ...init, signal: deadline.signal }), deadline.cancellation])
  } finally {
    deadline.dispose()
  }
}

/** Create a request identifier that Laravel can safely preserve and return. */
export function createCorrelationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, token => {
    const random = Math.floor(Math.random() * 16)
    return (token === 'x' ? random : (random & 0x3) | 0x8).toString(16)
  })
}

/**
 * Read a Fetch response incrementally and stop before an untrusted server can
 * make the WebView buffer an arbitrarily large body.
 */
export async function readBoundedResponseText(
  response: Response,
  maxBytes = MAX_API_RESPONSE_BYTES,
  signal?: AbortSignal
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Response limit must be a positive integer.')
  if (signal?.aborted) throw abortError(signal)

  const declaredLength = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new LuczorApiError(0, `Serverantwort überschreitet das Limit von ${maxBytes} Bytes.`)
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let receivedBytes = 0
  let text = ''
  let rejectCancellation: (reason: Error) => void = () => undefined
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })
  const cancelRead = () => {
    if (!signal) return
    const reason = abortError(signal)
    void reader.cancel(reason).catch(() => undefined)
    rejectCancellation(reason)
  }
  if (signal?.aborted) cancelRead()
  else signal?.addEventListener('abort', cancelRead, { once: true })

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), cancellation])
      if (done) break
      receivedBytes += value.byteLength
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new LuczorApiError(0, `Serverantwort überschreitet das Limit von ${maxBytes} Bytes.`)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    signal?.removeEventListener('abort', cancelRead)
    try {
      reader.releaseLock()
    } catch {
      // An abort may leave a non-conforming reader pending; cancellation was
      // already requested and the deadline race must still settle the caller.
    }
  }
}

export async function fetchBoundedResponseWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  maxBytes = MAX_API_RESPONSE_BYTES
): Promise<{ response: Response; text: string }> {
  if (init.signal?.aborted) throw abortError(init.signal)
  const deadline = abortDeadline(init.signal, timeoutMs)
  try {
    const operation = (async () => {
      const response = await apiTransportFetch(input, { ...init, signal: deadline.signal })
      const text = await readBoundedResponseText(response, maxBytes, deadline.signal)
      return { response, text }
    })()
    return await Promise.race([operation, deadline.cancellation])
  } finally {
    deadline.dispose()
  }
}

function emitDebug(level: 'warn' | 'error', event: string, detail: unknown): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('luczor:debug', { detail: { level, event, detail } }))
}

export type RequestOptions = {
  method?: string
  body?: unknown
  /** Set false for the public /health endpoint. */
  auth?: boolean
  query?: Record<string, string | undefined>
  signal?: AbortSignal
  /** Explicit bounded long-running operation deadline; ordinary API requests retain ten seconds. */
  timeoutMs?: number
  headers?: Record<string, string>
}

function syncPullQuery(options: SyncPullOptions | string = {}): Record<string, string | undefined> {
  const normalized = typeof options === 'string' ? { since: options } : options
  if (
    normalized.limit != null &&
    (!Number.isInteger(normalized.limit) || normalized.limit < 1 || normalized.limit > 500)
  ) {
    throw new Error('Sync pull limit must be an integer between 1 and 500.')
  }
  const query: Record<string, string | undefined> = {
    since: normalized.since,
    limit: normalized.limit == null ? undefined : String(normalized.limit),
  }
  for (const bucket of SYNC_BUCKETS) {
    const cursor = syncCursor(normalized.cursors, bucket)
    if (cursor) setSyncCursorQuery(query, bucket, cursor)
  }
  return query
}

function syncCursor(cursors: Partial<Record<SyncBucket, string>> | undefined, bucket: SyncBucket): string | undefined {
  if (!cursors) return undefined
  switch (bucket) {
    case 'projects':
      return cursors.projects
    case 'messages':
      return cursors.messages
    case 'memories':
      return cursors.memories
    case 'summaries':
      return cursors.summaries
  }
}

function setSyncCursorQuery(query: Record<string, string | undefined>, bucket: SyncBucket, cursor: string): void {
  switch (bucket) {
    case 'projects':
      query['cursors[projects]'] = cursor
      break
    case 'messages':
      query['cursors[messages]'] = cursor
      break
    case 'memories':
      query['cursors[memories]'] = cursor
      break
    case 'summaries':
      query['cursors[summaries]'] = cursor
      break
  }
}

function syncBucketData(page: SyncPullResponse, bucket: SyncBucket): unknown[] {
  switch (bucket) {
    case 'projects':
      return page.data.projects
    case 'messages':
      return page.data.messages
    case 'memories':
      return page.data.memories
    case 'summaries':
      return page.data.summaries
  }
}

function syncBucketContinuation(page: SyncPullResponse, bucket: SyncBucket): { has_more: boolean; cursor: string } {
  switch (bucket) {
    case 'projects':
      return page.continuation.projects
    case 'messages':
      return page.continuation.messages
    case 'memories':
      return page.continuation.memories
    case 'summaries':
      return page.continuation.summaries
  }
}

function validateSyncPullPage(page: SyncPullResponse): void {
  if (
    !page ||
    typeof page !== 'object' ||
    typeof page.cursor !== 'string' ||
    !page.cursor ||
    typeof page.has_more !== 'boolean'
  ) {
    throw new Error('Sync pull returned an invalid page envelope.')
  }
  if (!page.data || !page.continuation) throw new Error('Sync pull returned incomplete pagination data.')
  let bucketHasMore = false
  for (const bucket of SYNC_BUCKETS) {
    if (!Array.isArray(syncBucketData(page, bucket))) throw new Error(`Sync pull returned invalid ${bucket} data.`)
    const continuation = syncBucketContinuation(page, bucket)
    if (!continuation || typeof continuation.has_more !== 'boolean' || typeof continuation.cursor !== 'string') {
      throw new Error(`Sync pull returned an invalid ${bucket} continuation.`)
    }
    bucketHasMore ||= continuation.has_more
  }
  if (bucketHasMore !== page.has_more) throw new Error('Sync pull returned inconsistent pagination state.')
}

/**
 * Drain one frozen sync snapshot. The legacy time cursor is returned only from
 * the final page; repeated/missing continuation tokens and resource bounds
 * fail closed instead of silently skipping records or looping forever.
 */
export async function collectSyncPullPages(
  pullPage: (options: SyncPullOptions) => Promise<SyncPullResponse>,
  options: SyncPullAllOptions = {}
): Promise<SyncPullAllResponse> {
  const maxPages = options.maxPages ?? 1_000
  const maxItems = options.maxItems ?? 500_000
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) {
    throw new Error('Sync pull maxPages must be between 1 and 10000.')
  }
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 5_000_000) {
    throw new Error('Sync pull maxItems must be between 1 and 5000000.')
  }

  const data: SyncBucketData = { projects: [], messages: [], memories: [], summaries: [] }
  const seenContinuations = new Set<string>()
  let cursors: Partial<Record<SyncBucket, string>> | undefined
  let itemCount = 0

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const page = await pullPage({ since: options.since, limit: options.limit, cursors })
    validateSyncPullPage(page)
    data.projects.push(...page.data.projects)
    data.messages.push(...page.data.messages)
    data.memories.push(...page.data.memories)
    data.summaries.push(...page.data.summaries)
    itemCount +=
      page.data.projects.length + page.data.messages.length + page.data.memories.length + page.data.summaries.length
    if (itemCount > maxItems) throw new Error('Sync pull exceeded the configured item limit.')

    if (!page.has_more) {
      return { ...page, data, pages: pageNumber, item_count: itemCount }
    }

    const next: Record<SyncBucket, string> = {
      projects: page.continuation.projects.cursor,
      messages: page.continuation.messages.cursor,
      memories: page.continuation.memories.cursor,
      summaries: page.continuation.summaries.cursor,
    }
    for (const bucket of SYNC_BUCKETS) {
      const cursor = syncCursor(next, bucket)
      if (!cursor) throw new Error(`Sync pull omitted the ${bucket} continuation cursor.`)
    }
    const fingerprint = [next.projects, next.messages, next.memories, next.summaries].join('|')
    if (seenContinuations.has(fingerprint)) {
      throw new Error('Sync pull repeated a continuation and was stopped.')
    }
    seenContinuations.add(fingerprint)
    cursors = next
  }

  throw new Error('Sync pull exceeded the configured page limit.')
}

export function syncPullAll(options: SyncPullAllOptions = {}): Promise<SyncPullAllResponse> {
  return collectSyncPullPages(page => request<SyncPullResponse>('/sync/pull', { query: syncPullQuery(page) }), options)
}

async function request<T>(path: string, opts: RequestOptions = {}, config?: LuczorApiConfigSnapshot): Promise<T> {
  if (opts.signal?.aborted) throw abortError(opts.signal)
  return requestWithConfig<T>(path, opts, config ?? (await getApiConfigSnapshot()))
}

export async function requestWithConfig<T>(
  path: string,
  opts: RequestOptions,
  cfg: LuczorApiConfigSnapshot
): Promise<T> {
  // An identity change may have invalidated the caller while configuration was loading.
  if (opts.signal?.aborted) throw abortError(opts.signal)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 615000) {
    throw new Error('API request timeout must be an integer between 1000 and 615000 milliseconds.')
  }
  const requestCorrelationId = createCorrelationId()
  if (!cfg.baseUrl) {
    emitDebug('error', 'api_config_missing', { path })
    throw new LuczorApiError(0, 'Keine Server-URL konfiguriert (Settings → Server).')
  }

  const qs = opts.query
    ? Object.entries(opts.query)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : ''
  const url = `${cfg.baseUrl}${API_PREFIX}${path}${qs ? `?${qs}` : ''}`

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Luczor-Correlation-Id': requestCorrelationId,
  }
  if (opts.body != null) headers['Content-Type'] = 'application/json'
  if (opts.auth !== false) {
    if (!cfg.deviceKey) {
      emitDebug('error', 'device_key_missing', { path })
      throw new LuczorApiError(0, 'Kein Device-Key konfiguriert (Settings → Server).')
    }
    headers['Authorization'] = `Bearer ${cfg.deviceKey}`
  }
  Object.assign(headers, opts.headers ?? {})

  let res: Response
  let text = ''
  try {
    const result = await fetchBoundedResponseWithTimeout(
      url,
      {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body != null ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
        redirect: 'error',
        credentials: 'omit',
      },
      timeoutMs,
      MAX_API_RESPONSE_BYTES
    )
    res = result.response
    text = result.text
  } catch (e: any) {
    if (e instanceof LuczorApiError) {
      e.correlationId = requestCorrelationId
      emitDebug('error', 'api_response_too_large', { path, correlation_id: requestCorrelationId })
      throw e
    }
    emitDebug('error', 'api_network_error', {
      path,
      correlation_id: requestCorrelationId,
      message: e?.message ?? String(e),
    })
    throw new LuczorApiError(0, `Verbindung fehlgeschlagen: ${e?.message ?? String(e)}`, requestCorrelationId)
  }

  if (res.redirected) {
    emitDebug('error', 'api_redirect_rejected', { path, correlation_id: requestCorrelationId })
    throw new LuczorApiError(
      0,
      'Server-Redirects sind für die gebundene API-Identität nicht zulässig.',
      requestCorrelationId
    )
  }

  const correlationId = res.headers.get('X-Luczor-Correlation-Id') || requestCorrelationId
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON body */
  }

  if (!res.ok) {
    emitDebug(res.status >= 500 ? 'error' : 'warn', 'api_http_error', {
      path,
      status: res.status,
      correlation_id: correlationId,
      message: json?.message ?? (text || res.statusText),
    })
    throw new LuczorApiError(
      res.status,
      json?.message ?? `HTTP ${res.status}: ${text || res.statusText}`,
      correlationId,
      json?.code
    )
  }
  return json as T
}

/** Authenticate `/bootstrap` with the exact configuration snapshot supplied. */
export function bootstrapWithApiConfig(
  config: LuczorApiConfigSnapshot,
  signal?: AbortSignal
): Promise<BootstrapResponse> {
  return requestWithConfig<BootstrapResponse>('/bootstrap', { signal }, config)
}

/** Fetch the signed local-model envelope with the exact verified API identity. */
export function localModelManifestWithApiConfig(
  config: LuczorApiConfigSnapshot,
  signal?: AbortSignal,
  platform?: string
): Promise<Record<string, unknown>> {
  const path = platform ? `/local-model/manifest?platform=${encodeURIComponent(platform)}` : '/local-model/manifest'
  return requestWithConfig<Record<string, unknown>>(path, { signal }, config)
}

export function assistantProfileWithApiConfig(
  config: LuczorApiConfigSnapshot,
  signal?: AbortSignal
): Promise<{ data: AssistantProfile }> {
  return requestWithConfig<{ data: AssistantProfile }>('/assistant-profile', { signal }, config)
}

/* =========================================================
 * Public API
 * ========================================================= */
export const LuczorApi = {
  agentTeamPolicy: (signal?: AbortSignal) => request<unknown>('/agent-team-policy', { signal }),
  getConfig: getApiConfig,
  getConfigSnapshot: getApiConfigSnapshot,
  saveConfig: saveApiConfig,
  isConfigured,

  health: () => request<{ status?: string; time?: string }>('/health', { auth: false }),
  bootstrap: (signal?: AbortSignal) => request<BootstrapResponse>('/bootstrap', { signal }),
  speechVoices: (signal?: AbortSignal) => request<unknown>('/voice/voices', { signal }),
  localModelManifest: () => request<Record<string, unknown>>('/local-model/manifest'),
  realtimeConfig: () => request<{ data: RealtimeConfig }>('/realtime/config'),
  runtimeSettings: () =>
    request<{ data: RuntimeSettings; routing: { managed_by: 'server'; client_model_selection: false } }>(
      '/runtime-settings'
    ),
  voiceManifest: () => request<VoiceManifestResponse>('/voice/manifest'),
  pollDebugRequest: async (config?: LuczorApiConfigSnapshot) => {
    const cfg = config ?? (await getApiConfig())
    return request<{ data: { id: string; requested_at: string } | null }>(
      '/devices/debug/poll',
      {
        query: { client_id: cfg.clientId },
      },
      cfg
    )
  },
  completeDebugRequest: async (id: string, report: Record<string, unknown>, config?: LuczorApiConfigSnapshot) => {
    const cfg = config ?? (await getApiConfig())
    return request<{ ok: boolean }>(
      `/devices/debug/${encodeURIComponent(id)}/complete`,
      {
        method: 'POST',
        body: { client_id: cfg.clientId, report },
      },
      cfg
    )
  },

  registerDevice: (clientId: string, name: string) =>
    request<{ data: unknown; session: DeviceSession }>('/devices/register', {
      method: 'POST',
      body: { client_id: clientId, name },
    }),
  nextDeviceJob: (clientId: string, config?: LuczorApiConfigSnapshot, signal?: AbortSignal) =>
    request<{ data: DeviceJob | null }>('/devices/jobs/next', { query: { client_id: clientId }, signal }, config),
  approveDeviceJob: (
    id: string,
    clientId: string,
    approved: boolean,
    reason?: string,
    config?: LuczorApiConfigSnapshot,
    signal?: AbortSignal
  ) =>
    request<{ data: DeviceJob }>(
      `/devices/jobs/${encodeURIComponent(id)}/approve`,
      { method: 'POST', body: { client_id: clientId, approved, reason }, signal },
      config
    ),
  startDeviceJob: (id: string, clientId: string, config?: LuczorApiConfigSnapshot, signal?: AbortSignal) =>
    request<{ data: DeviceJob }>(
      `/devices/jobs/${encodeURIComponent(id)}/start`,
      { method: 'POST', body: { client_id: clientId }, signal },
      config
    ),
  completeDeviceJob: (
    id: string,
    clientId: string,
    ok: boolean,
    result?: Record<string, unknown>,
    error?: string,
    config?: LuczorApiConfigSnapshot,
    signal?: AbortSignal
  ) =>
    request<{ data: DeviceJob }>(
      `/devices/jobs/${encodeURIComponent(id)}/complete`,
      { method: 'POST', body: { client_id: clientId, ok, result, error }, signal },
      config
    ),
  reverbAuth: (socketId: string, channelName: string, clientId: string, sessionToken: string) =>
    request<{ auth: string }>('/reverb/auth', {
      method: 'POST',
      body: { socket_id: socketId, channel_name: channelName, client_id: clientId },
      headers: { 'X-Device-Session': sessionToken },
    }),

  getNotificationPreferences: (clientId: string) =>
    request<{ data: NotificationPreferences }>('/notification-preferences', {
      query: { client_id: clientId },
    }),
  updateNotificationPreferences: (clientId: string, patch: NotificationPreferencesPatch) =>
    request<{ data: NotificationPreferences }>('/notification-preferences', {
      method: 'PUT',
      body: { client_id: clientId, ...patch },
    }),
  listNotifications: (clientId: string, options: NotificationListOptions = {}) =>
    request<NotificationListResponse>('/notifications', {
      query: {
        client_id: clientId,
        after: String(options.after ?? 0),
        limit: String(options.limit ?? 50),
        unread_only: options.unreadOnly ? '1' : '0',
      },
    }),
  markNotificationRead: (id: string, clientId: string) =>
    request<{ data: AppNotification; meta: { unread_count: number } }>(
      `/notifications/${encodeURIComponent(id)}/read`,
      { method: 'POST', body: { client_id: clientId } }
    ),
  markAllNotificationsRead: (clientId: string, through?: number) =>
    request<{ data: { updated: number; read_at: string }; meta: { unread_count: number } }>('/notifications/read-all', {
      method: 'POST',
      body: { client_id: clientId, ...(through == null ? {} : { through }) },
    }),

  syncPush: (batch: SyncBatch) => request<SyncPushResponse>('/sync/push', { method: 'POST', body: batch }),
  syncPull: (options: SyncPullOptions | string = {}) =>
    request<SyncPullResponse>('/sync/pull', { query: syncPullQuery(options) }),
  syncPullAll,

  getPreferences: () =>
    request<{ preferences: Record<string, { value: unknown; updated_at: string | null }> }>('/preferences'),
  putPreferences: (preferences: Array<{ key: string; value: unknown; updated_at?: string }>) =>
    request<{ applied: string[]; skipped: string[] }>('/preferences', { method: 'PUT', body: { preferences } }),

  // Projects / conversations / tasks (agent-tool backing, server is SoR).
  createProject: (externalId: string, name: string, signal?: AbortSignal, config?: LuczorApiConfigSnapshot) => {
    const options = { method: 'POST', body: { external_id: projectExternalIdForServer(externalId), name }, signal }
    return config
      ? requestWithConfig<{ data: unknown }>('/projects', options, config)
      : request<{ data: unknown }>('/projects', options)
  },
  listProjects: () => request<{ data: unknown[] }>('/projects'),
  createConversation: (
    body: { external_id?: string; title?: string; project_id?: string; client_id?: string },
    signal?: AbortSignal,
    config?: LuczorApiConfigSnapshot
  ) => {
    const options = {
      method: 'POST',
      body: { ...body, project_id: projectExternalIdForServer(body.project_id) },
      signal,
    }
    return config
      ? requestWithConfig<{ data: { external_id: string }; meta?: { replayed?: boolean } }>(
          '/conversations',
          options,
          config
        )
      : request<{ data: { external_id: string }; meta?: { replayed?: boolean } }>('/conversations', options)
  },
  listConversations: (
    query?: { project_id?: string; external_id?: string },
    signal?: AbortSignal,
    config?: LuczorApiConfigSnapshot
  ) => {
    const options = { query: { ...query, project_id: projectExternalIdForServer(query?.project_id) }, signal }
    return config
      ? requestWithConfig<{
          data: unknown[]
          meta?: { conversation_create_idempotency?: string; filters?: { external_id?: string | null } }
        }>('/conversations', options, config)
      : request<{
          data: unknown[]
          meta?: { conversation_create_idempotency?: string; filters?: { external_id?: string | null } }
        }>('/conversations', options)
  },
  verifyConversationCreate: (
    externalId: string,
    projectId?: string,
    signal?: AbortSignal,
    config?: LuczorApiConfigSnapshot
  ) => {
    const options = {
      method: 'POST',
      body: { external_id: externalId, project_id: projectExternalIdForServer(projectId) },
      signal,
    }
    return config
      ? requestWithConfig<{
          data: { external_id: string; exists: boolean }
          meta: { conversation_create_idempotency: string; filters: { external_id: string } }
        }>('/conversations/verify-create', options, config)
      : request<{
          data: { external_id: string; exists: boolean }
          meta: { conversation_create_idempotency: string; filters: { external_id: string } }
        }>('/conversations/verify-create', options)
  },
  createTask: (
    body: {
      external_id?: string
      title: string
      description?: string
      priority?: string
      project_id?: string
      conversation_id?: string
      due_at?: string
      client_id?: string
    },
    signal?: AbortSignal,
    config?: LuczorApiConfigSnapshot
  ) => {
    const options = {
      method: 'POST',
      body: { ...body, project_id: projectExternalIdForServer(body.project_id) },
      signal,
    }
    return config
      ? requestWithConfig<{ data: { external_id: string } }>('/tasks', options, config)
      : request<{ data: { external_id: string } }>('/tasks', options)
  },
  listTasks: (
    query?: { status?: string; project_id?: string; conversation_id?: string; external_id?: string },
    signal?: AbortSignal,
    config?: LuczorApiConfigSnapshot
  ) => {
    const options = { query: { ...query, project_id: projectExternalIdForServer(query?.project_id) }, signal }
    return config
      ? requestWithConfig<{
          data: unknown[]
          meta?: { task_create_idempotency?: string; filters?: { external_id?: string | null } }
        }>('/tasks', options, config)
      : request<{
          data: unknown[]
          meta?: { task_create_idempotency?: string; filters?: { external_id?: string | null } }
        }>('/tasks', options)
  },
  verifyTaskCreate: (
    externalId: string,
    projectId?: string,
    signal?: AbortSignal,
    config?: LuczorApiConfigSnapshot
  ) => {
    const options = {
      method: 'POST',
      body: { external_id: externalId, project_id: projectExternalIdForServer(projectId) },
      signal,
    }
    return config
      ? requestWithConfig<{
          data: { external_id: string; exists: boolean }
          meta: { task_create_idempotency: string; filters: { external_id: string } }
        }>('/tasks/verify-create', options, config)
      : request<{
          data: { external_id: string; exists: boolean }
          meta: { task_create_idempotency: string; filters: { external_id: string } }
        }>('/tasks/verify-create', options)
  },
  updateTask: (
    externalId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    config?: LuczorApiConfigSnapshot
  ) => {
    const path = `/tasks/${encodeURIComponent(externalId)}`
    const options = {
      method: 'PATCH',
      body: {
        ...body,
        ...(typeof body.project_id === 'string' ? { project_id: projectExternalIdForServer(body.project_id) } : {}),
      },
      signal,
    }
    return config
      ? requestWithConfig<{ data: unknown }>(path, options, config)
      : request<{ data: unknown }>(path, options)
  },

  agentEvent: (evt: AgentEventInput, clientId: string) =>
    request<{ ok: boolean; id: number }>('/agent-events', {
      method: 'POST',
      body: { client_id: clientId, ...evt },
    }),

  evaluateLlmRun: (requestId: string, evaluation: Record<string, unknown>) =>
    request<{ data: unknown }>(`/llm/runs/request/${encodeURIComponent(requestId)}/evaluate`, {
      method: 'POST',
      body: evaluation,
    }),
}
