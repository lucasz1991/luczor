import { describe, expect, it, vi } from 'vitest'
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: vi.fn() }))
vi.mock('@/services/agents/hub', () => ({ agentProjectSnapshot: vi.fn() }))
vi.mock('@/services/repositoryGraph', () => ({ getRepositoryExternalPolicy: vi.fn() }))
vi.mock('@/services/api/luczorApi', () => ({ requestWithConfig: vi.fn() }))
import { getWorkflowVisionCapabilities, runWorkflowVision, workflowVisionHash } from '@/services/workflows/vision'
import type { LuczorApiConfigSnapshot, requestWithConfig } from '@/services/api/luczorApi'
import type { WorkflowNativeInvoke } from '@/services/workflows/browser'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHDcAAAAASUVORK5CYII='
const id = '8f25ec91-c8c4-4045-9100-0a66c9c50476'
async function fixture() {
  const bytes = Uint8Array.from(atob(png), char => char.charCodeAt(0))
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
  const account = {
    principalId: 'principal',
    serverOrigin: 'https://example.test',
    serverInstance: 'server',
    accountId: 1,
    config: { baseUrl: 'https://example.test', clientId: 'device', deviceKey: 'synthetic-test-only' },
  }
  const scope = {
    principalId: 'principal',
    projectId: 'project',
    expectedRootPath: 'C:/fixture',
    expectedWorkspaceUpdatedAt: 1,
    runId: id,
  }
  const project = {
    principalId: 'principal',
    projectId: 'project',
    rootPath: scope.expectedRootPath,
    workspaceUpdatedAt: 1,
    projectName: 'Fixture',
  }
  const caps = {
    schema_version: 1,
    ready: true,
    reason_code: null,
    revision: 'a'.repeat(64),
    adapter: 'openai_chat_completions',
    max_image_bytes: 2097152,
    max_pixels: 16000000,
    input_tokens_per_image: 2048,
    max_output_tokens: 1024,
    request_timeout_ms: 60000,
    models: [{ id: 'proved-vision', name: 'Vision', provider: 'openai', profile_id: 1 }],
  }
  const artifact = {
    artifact: { artifactId: id, mime: 'image/png', bytes: bytes.length, sha256: sha, width: 1, height: 1 },
    base64: png,
  }
  const answer: Record<string, unknown> = {
    ok: true,
    text: 'Ein weißes Pixel.',
    model: 'proved-vision',
    provider: 'openai',
    request_id: 'request',
    usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
    usage_source: 'reported',
    finish_reason: 'stop',
    policy_revision: caps.revision,
    artifact_sha256: sha,
    thinking_application: 'provider_not_confirmed',
  }
  const calls: Array<{ path: string; opts: Parameters<typeof requestWithConfig>[1]; config: LuczorApiConfigSnapshot }> =
    []
  const request = vi.fn(
    async (path: string, opts: Parameters<typeof requestWithConfig>[1], config: LuczorApiConfigSnapshot) => {
      calls.push({ path, opts, config })
      return { data: path.endsWith('/capabilities') ? caps : answer }
    }
  )
  const native = vi.fn(async () => artifact)
  const controller = new AbortController()
  const deps = {
    account: vi.fn(async () => account),
    project: vi.fn(async () => project),
    policy: vi.fn(async () => 'ask' as const),
    request: request as typeof requestWithConfig,
    approve: vi.fn(async () => true),
    assert: vi.fn((ticket: { signal: AbortSignal }) => ticket.signal.throwIfAborted()),
  }
  const context = {
    scope,
    ticket: { sessionId: 'session', generation: 1, signal: controller.signal },
    workflowExecutionId: id,
    invokeTask: native as WorkflowNativeInvoke,
  }
  const input = { artifactId: id, instruction: 'Beschreibe das Bild.', inference: 'external' as const }
  return { account, project, caps, artifact, answer, calls, request, native, controller, deps, context, input }
}

describe('scoped workflow vision', () => {
  it('exports exactly one owned PNG after policy checks and approves its immutable bytes', async () => {
    const test = await fixture()
    const result = await runWorkflowVision(test.input, test.context, test.deps)
    expect(test.native).toHaveBeenCalledWith(
      'wf_image_action',
      { action: 'prepare_vision', artifactId: id, scope: test.context.scope },
      false
    )
    const posts = test.calls.filter(call => call.opts.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.opts.timeoutMs).toBe(75000)
    const body = posts[0]!.opts.body as Record<string, unknown>
    const { approval, ...reviewed } = body
    expect(approval).toMatchObject({ hash: await workflowVisionHash(reviewed) })
    expect(test.deps.approve).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: await workflowVisionHash(reviewed),
        content: JSON.stringify(reviewed, null, 2),
        imagePreview: `data:image/png;base64,${png}`,
      }),
      test.controller.signal
    )
    expect(result).toMatchObject({
      ok: true,
      model: 'proved-vision',
      usage: { total_tokens: 15 },
      artifact_sha256: test.artifact.artifact.sha256,
    })
    expect(JSON.stringify(result)).not.toContain(png)
  })
  it('does not infer vision support from a text model or absent selection', async () => {
    const test = await fixture()
    await expect(runWorkflowVision({ ...test.input, inference: 'local' }, test.context, test.deps)).rejects.toThrow(
      'multimodal_runtime_unavailable'
    )
    test.caps.ready = false
    test.caps.reason_code = 'contract_missing' as unknown as null
    await expect(runWorkflowVision(test.input, test.context, test.deps)).rejects.toThrow(
      'multimodal_runtime_unavailable'
    )
    expect(test.native).not.toHaveBeenCalled()
    expect(test.deps.approve).not.toHaveBeenCalled()
  })
  it('blocks a denied project policy before reading or sending the image', async () => {
    const test = await fixture()
    test.deps.policy.mockResolvedValue('deny' as 'ask')
    await expect(runWorkflowVision(test.input, test.context, test.deps)).rejects.toThrow('external_policy_denied')
    expect(test.native).not.toHaveBeenCalled()
    expect(test.request).not.toHaveBeenCalled()
  })
  it.each(['denial', 'abort', 'account', 'workspace', 'policy', 'rotation', 'expiry'])(
    'does not dispatch after %s while awaiting approval',
    async reason => {
      const test = await fixture()
      test.deps.approve.mockImplementation(async () => {
        if (reason === 'abort') test.controller.abort()
        if (reason === 'account') test.account.principalId = 'other'
        if (reason === 'workspace') test.project.workspaceUpdatedAt++
        if (reason === 'policy') test.deps.policy.mockResolvedValue('deny' as 'ask')
        if (reason === 'rotation') test.caps.revision = 'b'.repeat(64)
        if (reason === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 130000)
        return reason !== 'denial'
      })
      try {
        await expect(runWorkflowVision(test.input, test.context, test.deps)).rejects.toThrow()
      } finally {
        vi.restoreAllMocks()
      }
      expect(test.calls.some(call => call.opts.method === 'POST')).toBe(false)
    }
  )
  it.each(['hash', 'length', 'dimensions', 'artifact', 'budget', 'base64'])(
    'rejects an invalid image %s before approval',
    async part => {
      const test = await fixture()
      if (part === 'hash') test.artifact.artifact.sha256 = 'b'.repeat(64)
      if (part === 'length') test.artifact.artifact.bytes++
      if (part === 'dimensions') test.artifact.artifact.width++
      if (part === 'artifact') test.artifact.artifact.artifactId = crypto.randomUUID()
      if (part === 'budget') test.caps.max_image_bytes = 16
      if (part === 'base64') test.artifact.base64 += '\n'
      await expect(runWorkflowVision(test.input, test.context, test.deps)).rejects.toThrow('workflow_vision_artifact')
      expect(test.deps.approve).not.toHaveBeenCalled()
      expect(test.calls.some(call => call.opts.method === 'POST')).toBe(false)
    }
  )
  it('does not retry a provider error with an uncertain consumed approval', async () => {
    const test = await fixture()
    test.request.mockImplementation(async (path, opts, config) => {
      test.calls.push({ path, opts, config })
      if (opts.method === 'POST') throw new Error('workflow_vision_approval_consumed')
      return { data: test.caps }
    })
    await expect(runWorkflowVision(test.input, test.context, test.deps)).rejects.toThrow('approval_consumed')
    expect(test.calls.filter(call => call.opts.method === 'POST')).toHaveLength(1)
  })
  it.each(['model', 'revision', 'finish', 'reasoning', 'image'])(
    'rejects invalid %s result without committing success',
    async field => {
      const test = await fixture()
      if (field === 'model') test.answer.model = 'unproved-text-model'
      if (field === 'revision') test.answer.policy_revision = 'b'.repeat(64)
      if (field === 'finish') test.answer.finish_reason = 'length'
      if (field === 'reasoning') test.answer.text = '<think>hidden</think>public'
      if (field === 'image') test.answer.text = png
      await expect(runWorkflowVision(test.input, test.context, test.deps)).rejects.toThrow('response_invalid')
    }
  )
  it('whitelists JSON and tokens, excludes raw provider metadata and avoids invented usage', async () => {
    const test = await fixture()
    Object.assign(test.answer, {
      data: { label: 'white' },
      reasoning_content: 'private',
      image: png,
      usage_source: 'unavailable',
      usage: {},
    })
    const result = await runWorkflowVision({ ...test.input, outputFormat: 'json' }, test.context, test.deps)
    expect(result).toMatchObject({ data: { label: 'white' }, usage_source: 'unavailable', usage: {} })
    expect(result).not.toHaveProperty('reasoning_content')
    expect(result).not.toHaveProperty('image')
  })
  it('freezes the instruction before asynchronous preparation', async () => {
    const test = await fixture()
    test.deps.account.mockImplementation(async () => {
      test.input.instruction = 'Changed'
      return test.account
    })
    await runWorkflowVision(test.input, test.context, test.deps)
    expect(test.calls.find(call => call.opts.method === 'POST')!.opts.body).toMatchObject({
      instruction: 'Beschreibe das Bild.',
    })
  })
  it('rejects a catalog label without a complete bounded multimodal proof', async () => {
    const test = await fixture()
    test.caps.max_pixels = 16000001
    await expect(getWorkflowVisionCapabilities(test.account.config, undefined, test.deps.request)).rejects.toThrow(
      'capability_invalid'
    )
  })
})
