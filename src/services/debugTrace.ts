import { Store } from '@tauri-apps/plugin-store'
import { getApiConfig } from './api/luczorApi'
import type { InferenceRequest, InferenceResult } from './inference/types'

export const DEBUG_TRACE_ENABLED_KEY = 'debug_chat_trace_enabled'
const FILE = 'luczor.debug.json'
const LIMIT = 4 * 1024 * 1024
type Trace = { id: string; at: string; kind: string; data: unknown }
type Archive = { scope: string; events: Trace[]; dropped: number }
let writes: Promise<unknown> = Promise.resolve()

export async function traceEnabled(): Promise<boolean> {
  try {
    const store = await Store.load('luczor.settings.json')
    return (await store.get('debug_collection_enabled')) === true && (await store.get(DEBUG_TRACE_ENABLED_KEY)) === true
  } catch { return false }
}

export async function setTraceEnabled(enabled: boolean): Promise<void> {
  const store = await Store.load('luczor.settings.json')
  await store.set(DEBUG_TRACE_ENABLED_KEY, enabled)
  await store.save()
}

export async function debugScope(): Promise<string> {
  const config = await getApiConfig()
  const bytes = new TextEncoder().encode(JSON.stringify([config.baseUrl, config.clientId, config.deviceKey]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Public content only. Credentials, binary payloads and private reasoning never enter storage. */
export function redactTrace(value: unknown, depth = 0): unknown {
  if (depth > 32) return '[DEPTH_LIMIT]'
  if (typeof value === 'string') {
    return value
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
      .replace(/<(?:think|analysis)>[\s\S]*?(?:<\/(?:think|analysis)>|$)/gi, '[PRIVATE_REASONING_OMITTED]')
      .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk|sk-or-v1)-[a-z0-9_-]+/gi, '[REDACTED]')
      .replace(/((?:[a-z_]*password|[a-z_]*secret|[a-z_]*token|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
      .replace(/data:[^;]+;base64,[a-z0-9+/=]+/gi, '[BINARY_OMITTED]')
      .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@')
  }
  if (Array.isArray(value)) return value.map(item => redactTrace(item, depth + 1))
  if (value && typeof value === 'object') {
    if (value instanceof Error) return redactTrace({ name: value.name, message: value.message, ...value }, depth + 1)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(?:authorization|cookie|set-cookie|.*password|.*secret|.*api.?key|device.?key|access.?token|refresh.?token|reasoning(?:_content)?|analysis|image_base64|base64)$/i.test(key)
        ? '[REDACTED]' : redactTrace(item, depth + 1)]))
  }
  return typeof value === 'function' || typeof value === 'symbol' ? undefined : value
}

export async function recordTrace(kind: string, data: unknown, expectedScope?: string): Promise<void> {
  try {
    if (!(await traceEnabled())) return
    const scope = await debugScope()
    if (expectedScope && scope !== expectedScope) return
    // Snapshot before queueing: later tool mutations must not rewrite the request history.
    let safe = redactTrace(data)
    const encoded = JSON.stringify(safe)
    if (new TextEncoder().encode(encoded).length > 512 * 1024) {
      safe = { truncated: true, original_bytes: new TextEncoder().encode(encoded).length, preview: encoded.slice(0, 120_000) }
    }
    const event: Trace = { id: crypto.randomUUID(), at: new Date().toISOString(), kind, data: safe }
    writes = writes.catch(() => {}).then(async () => {
      if (!(await traceEnabled()) || await debugScope() !== scope) return
      const store = await Store.load(FILE)
      const existing = await store.get<Archive>('chat_trace')
      const archive: Archive = existing?.scope === scope ? existing : { scope, events: [], dropped: 0 }
      archive.events.push(event)
      while (archive.events.length > 500 || new TextEncoder().encode(JSON.stringify(archive)).length > LIMIT) {
        archive.events.shift()
        archive.dropped++
      }
      await store.set('chat_trace', archive)
      await store.save()
    })
    await writes
  } catch { /* Debug persistence never interrupts inference/tools. */ }
}

export async function readTrace() {
  await writes.catch(() => {})
  if (!(await traceEnabled())) return undefined
  const scope = await debugScope()
  const archive = await (await Store.load(FILE)).get<Archive>('chat_trace')
  return { enabled: true, limit_bytes: LIMIT, dropped_events: archive?.scope === scope ? archive.dropped : 0,
    events: archive?.scope === scope ? archive.events : [],
    exclusions: ['credentials', 'private_reasoning', 'binary_data'], scope }
}

export async function traceInference(
  model: string, request: InferenceRequest, perform: (request: InferenceRequest) => Promise<InferenceResult>
): Promise<InferenceResult> {
  if (!(await traceEnabled())) return perform(request)
  let scope: string
  try { scope = await debugScope() } catch { return perform(request) }
  const id = crypto.randomUUID()
  const started = performance.now()
  const link = { exchangeId: id, model, projectId: request.projectId, ...request.debugScope }
  await recordTrace('model.request', { ...link, messages: request.messages, tools: request.tools,
    toolChoice: request.toolChoice, thinkingTier: request.thinkingTier, taskType: request.taskType }, scope)
  let partial = ''
  let checkpointAt = 0
  try {
    const result = await perform({ ...request, onToken: text => {
      partial = text
      request.onToken?.(text)
      if (performance.now() - checkpointAt > 5000) {
        checkpointAt = performance.now()
        void recordTrace('model.progress', { ...link, content: text }, scope)
      }
    } })
    await recordTrace('model.response', { ...link, durationMs: performance.now() - started, result }, scope)
    return result
  } catch (error) {
    await recordTrace('model.error', { ...link, durationMs: performance.now() - started, error, partial }, scope)
    throw error
  }
}
