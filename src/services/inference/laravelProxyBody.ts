import type { InferenceRequest } from '@/services/inference/types'

export type LaravelProxyBody = Readonly<Record<string, unknown>>

function canonicalJson(value: unknown, inArray = false): string | undefined {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item, true) ?? 'null').join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined && typeof nested !== 'function' && typeof nested !== 'symbol')
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested) ?? 'null'}`).join(',')}}`
  }
  return inArray ? 'null' : undefined
}

async function sha256Utf8(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Build the complete Laravel `/proxy/chat` body. This is the single body
 * constructor used for both the approval preview and the actual fetch.
 */
export function buildLaravelProxyBody(request: InferenceRequest, clientId: string, stream: boolean): LaravelProxyBody {
  if (!clientId.trim()) throw new Error('A stable client_id is required for external inference.')

  const body: Record<string, unknown> = {
    messages: request.messages,
    ...(stream ? { stream: true } : {}),
  }
  if (request.tools?.length) {
    body.tools = request.tools
    body.tool_choice = request.toolChoice ?? 'auto'
  }
  body.client_id = clientId
  body.project_id = request.projectId
  body.task_type = request.taskType ?? 'chat.general'
  body.context_id = request.contextId
  body.repo_id = request.repoId
  body.branch = request.branch
  body.commit_sha = request.commitSha
  body.input_source = request.inputSource ?? 'keyboard'
  return Object.freeze(body)
}

/** Canonical UTF-8 bytes that are sent as the HTTP request body. */
export function serializeLaravelProxyBody(body: LaravelProxyBody): string {
  const serialized = canonicalJson(body)
  if (serialized === undefined) throw new Error('The Laravel proxy body is not serializable.')
  return serialized
}

export async function hashLaravelProxyBody(
  request: InferenceRequest,
  clientId: string,
  stream = true
): Promise<string> {
  return sha256Utf8(serializeLaravelProxyBody(buildLaravelProxyBody(request, clientId, stream)))
}

export async function hashSerializedLaravelProxyBody(serialized: string): Promise<string> {
  return sha256Utf8(serialized)
}
