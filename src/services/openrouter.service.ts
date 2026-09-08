// src/services/openrouter.service.ts
import { createCorrelationId, getApiConfig, readBoundedResponseText } from '@/services/api/luczorApi'
import { apiTransportFetch } from '@/services/api/transportTarget'
import { readReportedTokenUsage } from '@/services/tokenUsage'
import type {
  ApprovedProxyConfig,
  InferenceRequest,
  InferenceResult,
  ParsedToolCall,
  WireToolCall,
} from '@/services/inference/types'
import {
  buildLaravelProxyBody,
  hashSerializedLaravelProxyBody,
  serializeLaravelProxyBody,
} from '@/services/inference/laravelProxyBody'

export type { LuczorMode, ParsedToolCall, ToolChoice, WireMessage, WireToolCall } from '@/services/inference/types'

const MAX_STREAM_BYTES = 8 * 1024 * 1024
const MAX_STREAM_LINE_CHARS = 1024 * 1024
const MAX_STREAM_CONTENT_CHARS = 4 * 1024 * 1024
const MAX_TOOL_CALLS = 128
const MAX_TOOL_ARGUMENT_CHARS = 1024 * 1024

export type ChatResult = InferenceResult
type ChatWithToolsArgs = Omit<InferenceRequest, 'onToken'>

/** Read the server routing metadata headers into a ChatResult fragment. */
function readLuczorHeaders(
  headers: Headers
): Pick<ChatResult, 'requestId' | 'correlationId' | 'model' | 'provider' | 'useCase'> {
  return {
    requestId: headers.get('X-Luczor-Request-Id') ?? undefined,
    correlationId: headers.get('X-Luczor-Correlation-Id') ?? undefined,
    model: headers.get('X-Luczor-Model-Id') ?? undefined,
    provider: headers.get('X-Luczor-Provider') ?? undefined,
    useCase: headers.get('X-Luczor-Use-Case') ?? undefined,
  }
}

type StreamChatArgs = InferenceRequest

function safeParseArgs(raw: string): Record<string, unknown> {
  const s = (raw ?? '').trim()
  if (!s) return {}
  try {
    const parsed = JSON.parse(s)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function readStreamError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null

  const error = (payload as { error?: unknown }).error
  if (!error || typeof error !== 'object') return null

  const details = error as { code?: unknown; message?: unknown; status?: unknown }
  const code = typeof details.code === 'string' ? details.code.slice(0, 128) : 'stream_error'
  const message =
    typeof details.message === 'string' && details.message.trim()
      ? details.message.trim().slice(0, 2048)
      : 'Der Server hat den Antwort-Stream abgebrochen.'
  const status = Number.isInteger(details.status) ? ` (HTTP ${String(details.status)})` : ''

  return `${message} [${code}]${status}`
}

/**
 * Resolve the chat endpoint + headers. When the server proxy is enabled the
 * request is sent to the Laravel proxy (authenticated with the device key) and
 * the server injects the real OpenRouter key — so no provider key on the client.
 */
async function getEndpoint(expected: ApprovedProxyConfig): Promise<{
  url: string
  headers: Record<string, string>
  proxied: boolean
  clientId: string
}> {
  const cfg = await getApiConfig()
  if (cfg.baseUrl !== expected.baseUrl || cfg.clientId !== expected.clientId || cfg.deviceKey !== expected.deviceKey) {
    throw new Error('Die aktuelle Server-/Geräteidentität weicht von der externen Freigabe ab.')
  }
  if (!cfg.deviceKey) {
    throw new Error('Server-Proxy aktiv, aber Device-Key fehlt (Settings → Server).')
  }
  return {
    url: `${cfg.baseUrl}/api/v1/proxy/chat`,
    headers: {
      Authorization: `Bearer ${cfg.deviceKey}`,
      'Content-Type': 'application/json',
      'X-Luczor-Correlation-Id': createCorrelationId(),
    },
    proxied: true,
    clientId: cfg.clientId,
  }
}

function assertApprovalNotExpired(args: InferenceRequest): void {
  const expires = Date.parse(args.expectedProxyApprovalExpiresAt ?? '')
  if (!Number.isFinite(expires) || expires <= Date.now()) {
    throw new Error('Die externe Anfrage besitzt keine gültige paketgebundene Freigabe.')
  }
}

function approvedConfig(args: InferenceRequest): ApprovedProxyConfig {
  assertApprovalNotExpired(args)
  if (!args.expectedProxyConfig) {
    throw new Error('Die externe Anfrage besitzt keine gültige paketgebundene Freigabe.')
  }
  return args.expectedProxyConfig
}

async function approvedProxyBody(args: InferenceRequest, clientId: string, stream: boolean): Promise<string> {
  const expected = args.expectedProxyBodySha256?.toLocaleLowerCase('en-US')
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error('Die externe Anfrage besitzt keine gültige paketgebundene Freigabe.')
  }
  const serialized = serializeLaravelProxyBody(buildLaravelProxyBody(args, clientId, stream))
  const actual = await hashSerializedLaravelProxyBody(serialized)
  if (actual !== expected) {
    throw new Error('Die finalen Proxy-Bytes weichen vom freigegebenen externen Paket ab.')
  }
  return serialized
}

export class OpenRouterService {
  /**
   * Single non-streaming chat completion with tool-calling enabled.
   *
   * Returns the assistant's text and/or the tool calls it wants to make.
   * The caller (agent loop) executes tools, appends results, and calls again.
   */
  static async chatWithTools(args: ChatWithToolsArgs): Promise<ChatResult> {
    const endpoint = await getEndpoint(approvedConfig(args))
    const serializedBody = await approvedProxyBody(args, endpoint.clientId, false)
    assertApprovalNotExpired(args)

    const res = await apiTransportFetch(endpoint.url, {
      method: 'POST',
      headers: endpoint.headers,
      body: serializedBody,
      signal: args.signal,
      redirect: 'error',
      credentials: 'omit',
    })

    if (!res.ok) {
      const txt = await readBoundedResponseText(res, 256 * 1024).catch(() => '')
      throw new Error(`OpenRouter HTTP ${res.status}: ${txt || res.statusText}`)
    }

    const json: any = JSON.parse(await readBoundedResponseText(res))
    const choice = json?.choices?.[0]
    const message = choice?.message ?? {}

    const content = typeof message.content === 'string' ? message.content : ''
    const finishReason = String(choice?.finish_reason ?? 'stop')

    const rawToolCalls: WireToolCall[] = Array.isArray(message.tool_calls)
      ? message.tool_calls
          .filter((tc: any) => tc?.function?.name)
          .map((tc: any) => ({
            id: String(tc.id ?? `call_${Math.random().toString(16).slice(2)}`),
            type: 'function' as const,
            function: {
              name: String(tc.function.name),
              arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : '{}',
            },
          }))
      : []

    const toolCalls: ParsedToolCall[] = rawToolCalls.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParseArgs(tc.function.arguments),
      rawArguments: tc.function.arguments,
    }))

    return {
      content,
      toolCalls,
      rawToolCalls,
      finishReason,
      usage: readReportedTokenUsage(json?.usage),
      ...readLuczorHeaders(res.headers),
    }
  }

  /**
   * Streaming chat completion with tool-calling.
   *
   * Streams `content` tokens (via onToken) while also accumulating any
   * `tool_calls` deltas. Resolves with the same ChatResult shape once the
   * stream ends, so the agent loop can treat it like chatWithTools.
   */
  static async streamChatWithTools(args: StreamChatArgs): Promise<ChatResult> {
    const endpoint = await getEndpoint(approvedConfig(args))
    // Rebuild and hash immediately before fetch. A client-id/config or request
    // mutation after the UI approval therefore fails closed.
    const serializedBody = await approvedProxyBody(args, endpoint.clientId, true)
    assertApprovalNotExpired(args)

    const res = await apiTransportFetch(endpoint.url, {
      method: 'POST',
      headers: endpoint.headers,
      body: serializedBody,
      signal: args.signal,
      redirect: 'error',
      credentials: 'omit',
    })

    if (!res.ok || !res.body) {
      const txt = await readBoundedResponseText(res, 256 * 1024).catch(() => '')
      throw new Error(`OpenRouter HTTP ${res.status}: ${txt || res.statusText}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')

    let buffer = ''
    let content = ''
    let receivedBytes = 0
    let finishReason = 'stop'
    let sawTerminalMarker = false
    let usage: InferenceResult['usage']
    const toolAcc: Array<{ id: string; name: string; args: string }> = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      receivedBytes += value.byteLength
      if (receivedBytes > MAX_STREAM_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Die Streaming-Antwort überschreitet das sichere Größenlimit.')
      }

      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_STREAM_LINE_CHARS) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Die Streaming-Antwort enthält einen zu großen Datenblock.')
      }
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // keep the trailing partial line

      for (const line of lines) {
        const l = line.trim()
        if (!l || l.startsWith(':')) continue // skip keep-alive comments
        if (!l.startsWith('data:')) continue

        const data = l.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') {
          sawTerminalMarker = true
          continue
        }

        let json: any
        try {
          json = JSON.parse(data)
        } catch {
          continue
        }

        const streamError = readStreamError(json)
        if (streamError !== null) {
          await reader.cancel().catch(() => undefined)
          throw new Error(streamError)
        }

        // Usage-only terminal frames deliberately have no choices/delta.
        usage = readReportedTokenUsage(json?.usage) ?? usage
        const choice = json?.choices?.[0]
        const delta = choice?.delta
        if (choice?.finish_reason) {
          finishReason = String(choice.finish_reason)
          sawTerminalMarker = true
        }
        if (!delta) continue

        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content
          if (content.length > MAX_STREAM_CONTENT_CHARS) {
            await reader.cancel().catch(() => undefined)
            throw new Error('Die Streaming-Antwort überschreitet das sichere Inhaltslimit.')
          }
          args.onToken?.(content)
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc?.index === 'number' ? tc.index : 0
            if (!Number.isSafeInteger(idx) || idx < 0 || idx >= MAX_TOOL_CALLS) continue
            const slot = (toolAcc[idx] ??= { id: '', name: '', args: '' })
            if (tc?.id) slot.id = String(tc.id)
            if (tc?.function?.name) slot.name = String(tc.function.name)
            if (typeof tc?.function?.arguments === 'string') {
              if (slot.args.length + tc.function.arguments.length > MAX_TOOL_ARGUMENT_CHARS) {
                await reader.cancel().catch(() => undefined)
                throw new Error('Ein Tool-Aufruf überschreitet das sichere Argumentlimit.')
              }
              slot.args += tc.function.arguments
            }
          }
        }
      }
    }

    buffer += decoder.decode()
    const trailing = buffer.trim()
    if (trailing) {
      if (trailing === 'data: [DONE]') sawTerminalMarker = true
      else throw new Error('Die Streaming-Antwort endete mit einem unvollständigen Datenblock.')
    }
    if (!sawTerminalMarker) {
      throw new Error('Die Streaming-Antwort endete ohne terminalen Abschlussmarker.')
    }

    const rawToolCalls: WireToolCall[] = toolAcc
      .filter(t => t && t.name)
      .map(t => ({
        id: t.id || `call_${Math.random().toString(16).slice(2)}`,
        type: 'function' as const,
        function: { name: t.name, arguments: t.args || '{}' },
      }))

    const toolCalls: ParsedToolCall[] = rawToolCalls.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParseArgs(tc.function.arguments),
      rawArguments: tc.function.arguments,
    }))

    return { content, toolCalls, rawToolCalls, finishReason, usage, ...readLuczorHeaders(res.headers) }
  }
}
