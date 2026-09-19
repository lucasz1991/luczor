import { Store } from '@tauri-apps/plugin-store'
import { getApiConfig } from './api/luczorApi'
import type { InferenceRequest, InferenceResult } from './inference/types'

export const DEBUG_TRACE_ENABLED_KEY = 'debug_chat_trace_enabled'
const FILE = 'luczor.debug.json'
const LIMIT = 4 * 1024 * 1024
type Trace = { id: string; at: string; kind: string; data: unknown }
type Archive = { scope: string; events: Trace[]; dropped: number; coalescedProgress?: number }
let writes: Promise<unknown> = Promise.resolve()

/** Count the submitted contract without copying message content or tool arguments. */
function modelRequestSummary(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const request = value as Record<string, unknown>
  if (!Array.isArray(request.messages)) return undefined
  const roles = { system: 0, user: 0, assistant: 0, tool: 0 }
  let contentCharacters = 0
  let toolArgumentCharacters = 0
  let toolCallCount = 0
  for (const message of request.messages as InferenceRequest['messages']) {
    if (!message || !Object.hasOwn(roles, message.role)) continue
    roles[message.role] += 1
    if (typeof message.content === 'string') contentCharacters += message.content.length
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      toolCallCount += message.tool_calls.length
      for (const call of message.tool_calls) {
        if (typeof call?.function?.arguments === 'string') toolArgumentCharacters += call.function.arguments.length
      }
    }
  }
  const tools = Array.isArray(request.tools) ? request.tools : []
  return {
    messageCount: request.messages.length,
    roles,
    contentCharacters,
    toolCallCount,
    toolArgumentCharacters,
    toolSchemaCount: tools.length,
    toolSchemaCharacters: JSON.stringify(tools).length,
  }
}

/** Each progress payload is a full public snapshot; retain the latest per exchange. */
function coalesceProgress(archive: Archive): void {
  const seen = new Set<string>()
  const retained: Trace[] = []
  let coalesced = 0
  for (const event of [...archive.events].reverse()) {
    const exchange =
      event.kind === 'model.progress' && event.data && typeof event.data === 'object'
        ? (event.data as Record<string, unknown>).exchangeId
        : undefined
    if (typeof exchange === 'string' && exchange.length > 0) {
      if (seen.has(exchange)) {
        coalesced += 1
        continue
      }
      seen.add(exchange)
    }
    retained.push(event)
  }
  archive.events = retained.reverse()
  archive.coalescedProgress = (archive.coalescedProgress ?? 0) + coalesced
}

export async function traceEnabled(): Promise<boolean> {
  try {
    const store = await Store.load('luczor.settings.json')
    return (await store.get('debug_collection_enabled')) === true && (await store.get(DEBUG_TRACE_ENABLED_KEY)) === true
  } catch {
    return false
  }
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
    if (/^\s*[\[{]/.test(value)) {
      try {
        return JSON.stringify(redactTrace(JSON.parse(value), depth + 1))
      } catch {
        /* Plain text. */
      }
    }
    return value
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
      .replace(/<(?:think|analysis)>[\s\S]*?(?:<\/(?:think|analysis)>|$)/gi, '[PRIVATE_REASONING_OMITTED]')
      .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk|sk-or-v1)-[a-z0-9_-]+/gi, '[REDACTED]')
      .replace(
        /(\b(?:[a-z_]*password|[a-z_]*secret|[a-z_]*token|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
        '$1[REDACTED]'
      )
      .replace(/data:[^;]+;base64,[a-z0-9+/=]+/gi, '[BINARY_OMITTED]')
      .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@')
  }
  if (Array.isArray(value)) return value.map(item => redactTrace(item, depth + 1))
  if (value && typeof value === 'object') {
    if (value instanceof Error) return redactTrace({ ...value, name: value.name, message: value.message }, depth + 1)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:authorization|cookie|set-cookie|token|.*password|.*secret|.*api.?key|device.?key|access.?token|refresh.?token|reasoning(?:_content)?|analysis|image_base64|base64)$/i.test(
          key
        )
          ? '[REDACTED]'
          : redactTrace(item, depth + 1),
      ])
    )
  }
  return typeof value === 'function' || typeof value === 'symbol' ? undefined : value
}

export async function recordTrace(kind: string, data: unknown, expectedScope?: string): Promise<void> {
  try {
    if (!(await traceEnabled())) return
    const scope = await debugScope()
    if (expectedScope && scope !== expectedScope) return
    // Snapshot before queueing: later tool mutations must not rewrite the request history.
    const requestSummary = kind === 'model.request' ? modelRequestSummary(data) : undefined
    let safe = redactTrace(requestSummary ? { ...(data as Record<string, unknown>), requestSummary } : data)
    const encoded = JSON.stringify(safe)
    if (new TextEncoder().encode(encoded).length > 512 * 1024) {
      const exchangeId = safe && typeof safe === 'object' ? (safe as Record<string, unknown>).exchangeId : undefined
      safe = {
        truncated: true,
        original_bytes: new TextEncoder().encode(encoded).length,
        ...(typeof exchangeId === 'string' && /^[a-z0-9-]{1,100}$/i.test(exchangeId) ? { exchangeId } : {}),
        ...(requestSummary ? { requestSummary } : {}),
        preview: encoded.slice(0, 120_000),
      }
    }
    const event: Trace = { id: crypto.randomUUID(), at: new Date().toISOString(), kind, data: safe }
    writes = writes
      .catch(() => {})
      .then(async () => {
        if (!(await traceEnabled()) || (await debugScope()) !== scope) return
        const store = await Store.load(FILE)
        const existing = await store.get<Archive>('chat_trace')
        const archive: Archive = existing?.scope === scope ? existing : { scope, events: [], dropped: 0 }
        archive.events.push(event)
        coalesceProgress(archive)
        while (archive.events.length > 500 || new TextEncoder().encode(JSON.stringify(archive)).length > LIMIT) {
          archive.events.shift()
          archive.dropped++
        }
        await store.set('chat_trace', archive)
        await store.save()
      })
    await writes
  } catch {
    /* Debug persistence never interrupts inference/tools. */
  }
}

export async function readTrace() {
  await writes.catch(() => {})
  if (!(await traceEnabled())) return undefined
  const scope = await debugScope()
  const archive = await (await Store.load(FILE)).get<Archive>('chat_trace')
  return {
    enabled: true,
    limit_bytes: LIMIT,
    dropped_events: archive?.scope === scope ? archive.dropped : 0,
    coalesced_progress_events: archive?.scope === scope ? (archive.coalescedProgress ?? 0) : 0,
    events: archive?.scope === scope ? archive.events : [],
    exclusions: ['credentials', 'private_reasoning', 'binary_data'],
    scope,
  }
}

export async function traceInference(
  model: string,
  request: InferenceRequest,
  perform: (request: InferenceRequest) => Promise<InferenceResult>
): Promise<InferenceResult> {
  if (!(await traceEnabled())) return perform(request)
  let scope: string
  try {
    scope = await debugScope()
  } catch {
    return perform(request)
  }
  const id = crypto.randomUUID()
  const started = performance.now()
  const link = { exchangeId: id, model, projectId: request.projectId, ...request.debugScope }
  await recordTrace(
    'model.request',
    {
      ...link,
      messages: request.messages,
      tools: request.tools,
      toolChoice: request.toolChoice,
      thinkingTier: request.thinkingTier,
      contextBudget: request.contextBudget,
      taskType: request.taskType,
    },
    scope
  )
  let partial = ''
  let checkpointAt = 0
  try {
    const result = await perform({
      ...request,
      onToken: text => {
        partial = text
        request.onToken?.(text)
        if (performance.now() - checkpointAt > 5000) {
          checkpointAt = performance.now()
          void recordTrace('model.progress', { ...link, content: text }, scope)
        }
      },
    })
    await recordTrace('model.response', { ...link, durationMs: performance.now() - started, result }, scope)
    return result
  } catch (error) {
    await recordTrace('model.error', { ...link, durationMs: performance.now() - started, error, partial }, scope)
    throw error
  }
}
