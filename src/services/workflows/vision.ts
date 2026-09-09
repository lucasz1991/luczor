import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { agentProjectSnapshot } from '@/services/agents/hub'
import { requestWithConfig, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import { executionGate, type ExecutionTicket } from '@/services/executionGate'
import { requestPayloadApproval } from '@/services/payloadApproval'
import { getRepositoryExternalPolicy } from '@/services/repositoryGraph'
import { publicAnswerText } from '@/services/publicAnswerStream'
import type { WorkflowArtifactScope, WorkflowNativeInvoke } from './browser'

const SHA = /^[a-f0-9]{64}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu
const MAX_BYTES = 2 * 1024 * 1024
const MAX_PIXELS = 16_000_000
export type WorkflowVisionCapabilities = Readonly<{
  schema_version: 1
  ready: boolean
  reason_code: string | null
  revision: string
  adapter: 'openai_chat_completions'
  max_image_bytes: number
  max_pixels: number
  input_tokens_per_image: number
  max_output_tokens: number
  request_timeout_ms: number
  models: ReadonlyArray<{ id: string; profile_id: number; name: string; provider: string }>
}>
export type WorkflowVisionInput = Readonly<{
  artifactId?: string
  instruction?: string
  inference?: 'local' | 'external'
  outputFormat?: 'text' | 'json'
  maxOutputChars?: number
}>
export type WorkflowVisionContext = {
  scope: WorkflowArtifactScope
  invokeTask: WorkflowNativeInvoke
  ticket: ExecutionTicket
  workflowExecutionId: string
}
type Dependencies = {
  account: typeof getVerifiedAccountSnapshot
  project: typeof agentProjectSnapshot
  policy: typeof getRepositoryExternalPolicy
  request: typeof requestWithConfig
  approve: typeof requestPayloadApproval
  assert: (ticket: ExecutionTicket) => void
}
const defaults: Dependencies = {
  account: getVerifiedAccountSnapshot,
  project: agentProjectSnapshot,
  policy: getRepositoryExternalPolicy,
  request: requestWithConfig,
  approve: requestPayloadApproval,
  assert: ticket => executionGate.assert(ticket),
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
}
function short(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}
function capability(value: unknown): WorkflowVisionCapabilities {
  if (
    !object(value) ||
    value.schema_version !== 1 ||
    typeof value.ready !== 'boolean' ||
    !short(value.revision, 64) ||
    !SHA.test(value.revision) ||
    value.adapter !== 'openai_chat_completions' ||
    !(value.reason_code === null || short(value.reason_code)) ||
    !integer(value.max_image_bytes, 0, MAX_BYTES) ||
    !integer(value.max_pixels, 0, MAX_PIXELS) ||
    !integer(value.input_tokens_per_image, 0, 131072) ||
    !integer(value.max_output_tokens, 0, 131072) ||
    !integer(value.request_timeout_ms, 0, 600000) ||
    !Array.isArray(value.models) ||
    value.models.length > 100 ||
    value.models.some(
      model =>
        !object(model) ||
        !short(model.id) ||
        !short(model.name) ||
        !short(model.provider) ||
        !integer(model.profile_id, 1, Number.MAX_SAFE_INTEGER)
    ) ||
    (value.ready &&
      (value.models.length === 0 ||
        !value.max_image_bytes ||
        !value.max_pixels ||
        !value.input_tokens_per_image ||
        !value.max_output_tokens ||
        value.request_timeout_ms < 1000 ||
        value.reason_code !== null)) ||
    (!value.ready && !value.reason_code)
  )
    throw new Error('workflow_vision_capability_invalid')
  return structuredClone(value) as WorkflowVisionCapabilities
}

/** Metadata only: never exports an artifact or prepares a model. */
export async function getWorkflowVisionCapabilities(
  config: LuczorApiConfigSnapshot,
  signal?: AbortSignal,
  request: typeof requestWithConfig = requestWithConfig
): Promise<WorkflowVisionCapabilities> {
  const result = await request<{ data: unknown }>('/proxy/vision/capabilities', { signal }, config)
  signal?.throwIfAborted()
  return capability(result?.data)
}

/** Byte-lexicographic ASCII keys match the server's SORT_STRING canonical request hash. */
export async function workflowVisionHash(value: unknown): Promise<string> {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : object(item)
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .map(([key, content]) => [key, canonical(content)])
          )
        : item
  return digest(new TextEncoder().encode(JSON.stringify(canonical(value))))
}
async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function verifiedImage(raw: unknown, artifactId: string, caps: WorkflowVisionCapabilities) {
  if (!object(raw) || !object(raw.artifact) || typeof raw.base64 !== 'string')
    throw new Error('workflow_vision_artifact_invalid')
  const artifact = raw.artifact
  if (
    artifact.artifactId !== artifactId ||
    artifact.mime !== 'image/png' ||
    !short(artifact.sha256, 64) ||
    !SHA.test(artifact.sha256) ||
    !integer(artifact.bytes, 1, caps.max_image_bytes) ||
    !integer(artifact.width, 1, 16384) ||
    !integer(artifact.height, 1, 16384) ||
    artifact.width * artifact.height > caps.max_pixels ||
    raw.base64.length > Math.ceil(caps.max_image_bytes / 3) * 4 ||
    raw.base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(raw.base64)
  )
    throw new Error('workflow_vision_artifact_invalid')
  const encoded = atob(raw.base64)
  const bytes = Uint8Array.from(encoded, char => char.charCodeAt(0))
  if (
    bytes.length !== artifact.bytes ||
    bytes.length < 24 ||
    btoa(encoded) !== raw.base64 ||
    bytes.slice(0, 8).join(',') !== '137,80,78,71,13,10,26,10' ||
    String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR' ||
    new DataView(bytes.buffer).getUint32(16) !== artifact.width ||
    new DataView(bytes.buffer).getUint32(20) !== artifact.height ||
    (await digest(bytes)) !== artifact.sha256
  )
    throw new Error('workflow_vision_artifact_integrity_invalid')
  return Object.freeze({
    artifact_id: artifactId,
    mime: 'image/png' as const,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    width: artifact.width,
    height: artifact.height,
    base64: raw.base64,
  })
}

/** One explicitly approved image request; provider uncertainty is never retried here. */
export async function runWorkflowVision(
  input: WorkflowVisionInput,
  context: WorkflowVisionContext,
  deps: Dependencies = defaults
): Promise<Record<string, unknown>> {
  input = Object.freeze({ ...input })
  const scope = Object.freeze({ ...context.scope })
  const executionId = context.workflowExecutionId
  const assert = () => {
    context.ticket.signal.throwIfAborted()
    deps.assert(context.ticket)
  }
  assert()
  if (input.inference !== 'external') throw new Error('workflow_vision_multimodal_runtime_unavailable')
  if (
    !input.artifactId ||
    !UUID.test(input.artifactId) ||
    !UUID.test(scope.runId) ||
    !UUID.test(executionId) ||
    !input.instruction?.trim() ||
    input.instruction.length > 12000 ||
    !['text', 'json'].includes(input.outputFormat ?? 'text') ||
    !integer(input.maxOutputChars ?? 12000, 256, 20000)
  )
    throw new Error('workflow_vision_input_invalid')
  const instruction = input.instruction
  const format = input.outputFormat ?? 'text'
  const maximum = input.maxOutputChars ?? 12000
  const account = await deps.account()
  if (!account || account.principalId !== scope.principalId) throw new Error('workflow_vision_scope_changed')
  const config = Object.freeze({ ...account.config })
  const current = async () => {
    assert()
    const active = await deps.account()
    const project = await deps.project(scope.projectId)
    assert()
    if (
      !active ||
      active.principalId !== scope.principalId ||
      active.config.baseUrl !== config.baseUrl ||
      active.config.clientId !== config.clientId ||
      active.config.deviceKey !== config.deviceKey ||
      project.principalId !== scope.principalId ||
      project.projectId !== scope.projectId ||
      project.rootPath !== scope.expectedRootPath ||
      project.workspaceUpdatedAt !== scope.expectedWorkspaceUpdatedAt
    )
      throw new Error('workflow_vision_scope_changed')
    if ((await deps.policy()) === 'deny') throw new Error('workflow_vision_external_policy_denied')
    assert()
  }
  await current()
  const caps = await getWorkflowVisionCapabilities(config, context.ticket.signal, deps.request)
  if (!caps.ready) throw new Error('workflow_vision_multimodal_runtime_unavailable')
  await current()
  const raw = await context.invokeTask<unknown>(
    'wf_image_action',
    {
      action: 'prepare_vision',
      artifactId: input.artifactId,
      scope,
    },
    false
  )
  const image = await verifiedImage(raw, input.artifactId, caps)
  await current()
  const body = Object.freeze({
    schema_version: 1,
    client_id: config.clientId,
    project_id: scope.projectId,
    workflow_id: scope.runId,
    workflow_execution_id: executionId,
    instruction,
    output_format: format,
    max_output_chars: maximum,
    policy_revision: caps.revision,
    image,
  })
  const hash = await workflowVisionHash(body)
  const expiresAt = Date.now() + 120000
  const approved = await deps.approve(
    {
      title: 'Workflow: Bildanalyse einmal freigeben',
      kind: 'inference',
      destination: `${config.baseUrl}/api/v1/proxy/vision`,
      hash,
      content: JSON.stringify(body, null, 2),
      imagePreview: `data:image/png;base64,${image.base64}`,
    },
    context.ticket.signal
  )
  if (!approved || Date.now() >= expiresAt) throw new Error('workflow_vision_approval_denied')
  await current()
  const latest = await getWorkflowVisionCapabilities(config, context.ticket.signal, deps.request)
  if (!latest.ready || latest.revision !== caps.revision) throw new Error('workflow_vision_policy_changed')
  await current()
  const result = await deps.request<{ data: unknown }>(
    '/proxy/vision',
    {
      method: 'POST',
      signal: context.ticket.signal,
      timeoutMs: caps.request_timeout_ms + 15000,
      body: { ...body, approval: { hash, token: crypto.randomUUID(), expires_at: new Date(expiresAt).toISOString() } },
    },
    config
  )
  await current()
  const answer = result?.data
  if (
    !object(answer) ||
    answer.ok !== true ||
    answer.policy_revision !== caps.revision ||
    answer.artifact_sha256 !== image.sha256 ||
    !short(answer.model) ||
    !short(answer.provider) ||
    !caps.models.some(model => model.id === answer.model && model.provider === answer.provider) ||
    !short(answer.request_id) ||
    answer.finish_reason !== 'stop' ||
    !['reported', 'unavailable'].includes(String(answer.usage_source)) ||
    answer.thinking_application !== 'provider_not_confirmed'
  )
    throw new Error('workflow_vision_response_invalid')
  // Whitelist the public response. Neither the source PNG nor arbitrary provider fields reach the ledger.
  const payload = format === 'json' ? JSON.stringify(answer.data) : answer.text
  if (
    typeof payload !== 'string' ||
    !payload.trim() ||
    payload.length > maximum ||
    payload.includes('data:image/') ||
    payload.includes(image.base64) ||
    (format === 'json' && !object(answer.data) && !Array.isArray(answer.data))
  )
    throw new Error('workflow_vision_response_invalid')
  const publicText = publicAnswerText(payload, true)
  if (publicText !== payload) throw new Error('workflow_vision_public_response_invalid')
  const usage = Object.fromEntries(
    Object.entries(object(answer.usage) ? answer.usage : {}).filter(
      ([key, value]) =>
        ['input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens'].includes(key) &&
        integer(value, 0, 1_000_000_000)
    )
  )
  return {
    ok: true,
    outcome: 'success',
    ...(format === 'json' ? { data: answer.data } : { text: publicText }),
    inference_target: 'external_proxy',
    model: answer.model,
    provider: answer.provider,
    request_id: answer.request_id,
    finish_reason: answer.finish_reason,
    usage,
    usage_source: answer.usage_source,
    policy_revision: caps.revision,
    artifact_sha256: image.sha256,
    thinking_application: answer.thinking_application,
  }
}
