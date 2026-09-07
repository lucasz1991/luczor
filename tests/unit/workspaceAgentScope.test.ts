import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InferenceGateway, InferenceRequest, InferenceResult } from '@/services/inference/types'
import type { ToolDef, WorkspaceScope } from '@/services/tools/types'

const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  resolve: vi.fn(),
  getTool: vi.fn(),
  descriptors: vi.fn(),
  executeWorkspace: vi.fn(),
  executeProject: vi.fn(),
  approve: vi.fn(),
  queue: vi.fn(),
  update: vi.fn(),
  hidden: vi.fn(),
  audit: vi.fn(),
  invoke: vi.fn(),
  hud: { killSwitch: false },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/services/inference/coordinator', () => ({
  resolveInferenceRouteForTurn: mocks.resolve,
  hashInferenceEgressRequest: vi.fn(),
}))
vi.mock('@/services/api/luczorApi', () => ({ getApiConfigSnapshot: vi.fn() }))
vi.mock('@/services/tools/registry', () => ({ getTool: mocks.getTool, toOpenAITools: mocks.descriptors }))
vi.mock('@/services/approvals', () => ({ awaitApproval: mocks.approve }))
vi.mock('@/services/executionPolicy', () => ({
  loadExecutionPolicy: vi.fn(async () => ({ autoExecuteMutatingTools: false })),
  canAutoExecuteTool: vi.fn(() => false),
}))
vi.mock('@/state/store', () => ({
  mutations: {
    queueToolCall: mocks.queue,
    updateToolCallStatus: mocks.update,
    addHiddenToolMessage: mocks.hidden,
  },
}))
vi.mock('@/state/hud', () => ({ hud: mocks.hud, setStatus: vi.fn(), pulse: vi.fn(), setLastTool: vi.fn() }))
vi.mock('@/services/api/sync', () => ({ logAgentEvent: mocks.audit }))

import { runAgent } from '@/services/agent'
import { updateExecutionControls } from '@/services/executionGate'

const workspaceScope: WorkspaceScope = { principalId: 'device:v1:scoped-account', projectIds: ['selected', 'target'] }
let generation = 0
const definitions = new Map<string, ToolDef>()
const baseMessages = [{ role: 'user' as const, content: 'Lies die Übersicht.' }]
function gateway(target: InferenceGateway['target'] = 'local_llama_cpp'): InferenceGateway {
  return { id: `test-${target}`, target, streamChatWithTools: mocks.stream }
}
function response(toolName?: string): InferenceResult {
  return {
    content: toolName ? '' : 'Die Übersicht ist vollständig.',
    finishReason: toolName ? 'tool_calls' : 'stop',
    toolCalls: toolName ? [{ id: 'workspace-call', name: toolName, arguments: {}, rawArguments: '{}' }] : [],
    rawToolCalls: toolName
      ? [{ id: 'workspace-call', type: 'function', function: { name: toolName, arguments: '{}' } }]
      : [],
  }
}
function firstRequest(): InferenceRequest {
  const request = mocks.stream.mock.calls[0]?.[0] as InferenceRequest | undefined
  if (!request) throw new Error('Expected an inference request')
  return request
}
function descriptorNames(request: InferenceRequest): string[] {
  return (request.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.stream.mockReset()
  mocks.resolve.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
  mocks.hud.killSwitch = false
  definitions.clear()
  definitions.set('project_get_state', {
    name: 'project_get_state',
    category: 'project',
    description: 'Read selected project state.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    mutating: false,
    requiresApproval: false,
    execute: mocks.executeProject,
  })
  definitions.set('workspace_overview', {
    name: 'workspace_overview',
    category: 'app',
    description: 'Read local workspace metadata.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    mutating: false,
    requiresApproval: false,
    dataHandling: 'ephemeral',
    workspaceOnly: true,
    execute: mocks.executeWorkspace,
  })
  mocks.getTool.mockImplementation((name: string) => definitions.get(name))
  mocks.descriptors.mockImplementation(() =>
    [...definitions.values()].map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  )
  mocks.executeWorkspace.mockResolvedValue({ ok: true, projects: [{ project_id: 'target' }] })
  mocks.executeProject.mockResolvedValue({ ok: true, project_id: 'selected' })
  mocks.approve.mockResolvedValue(true)
  mocks.resolve.mockResolvedValue({ gateway: gateway() })
  mocks.stream.mockResolvedValue(response())
  updateExecutionControls({ mode: 'act', killSwitch: false, scope: `workspace-agent-tests-${++generation}` })
})

describe('agent workspace isolation', () => {
  it('omits workspace descriptors and their runtime instructions from ordinary project chat', async () => {
    await runAgent({ projectId: 'selected', mode: 'act', baseMessages, inferenceGateway: gateway() })
    expect(descriptorNames(firstRequest())).toEqual(['project_get_state'])
    expect(JSON.stringify(firstRequest().messages)).not.toContain('workspace_overview')
  })

  it('rejects a model-invented workspace call even when it knows the registered tool name', async () => {
    mocks.stream.mockResolvedValueOnce(response('workspace_overview')).mockResolvedValueOnce(response())
    const result = await runAgent({ projectId: 'selected', mode: 'act', baseMessages, inferenceGateway: gateway() })
    expect(result.toolFailures).toBe(1)
    expect(result.toolSuccesses).toBe(0)
    expect(mocks.executeWorkspace).not.toHaveBeenCalled()
    expect(mocks.update).toHaveBeenCalledWith('selected', 'workspace-call', 'rejected')
    expect(descriptorNames(firstRequest())).not.toContain('workspace_overview')
  })

  it('makes workspace tools available only with trusted scope and passes that scope outside the model packet', async () => {
    mocks.stream.mockResolvedValueOnce(response('workspace_overview')).mockResolvedValueOnce(response())
    const journal = { queue: vi.fn(), update: vi.fn(), approve: vi.fn() }
    const result = await runAgent({
      projectId: 'selected',
      mode: 'act',
      baseMessages,
      workspaceScope,
      inferenceGateway: gateway(),
      toolSession: journal,
    })
    expect(descriptorNames(firstRequest())).toEqual(['project_get_state', 'workspace_overview'])
    expect(mocks.executeWorkspace).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        projectId: 'selected',
        inferenceTarget: 'local',
        workspaceScope,
        execution: expect.objectContaining({ signal: expect.any(AbortSignal) }),
      })
    )
    expect(firstRequest()).not.toHaveProperty('workspaceScope')
    expect(JSON.stringify(firstRequest())).not.toContain(workspaceScope.principalId)
    expect(result).toMatchObject({ toolSuccesses: 1, ephemeralDataUsed: true })
    expect(journal.update).toHaveBeenCalledWith('workspace-call', 'executed')
    expect(mocks.queue).not.toHaveBeenCalled()
    expect(mocks.hidden).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('forces coordinator routing to local-only despite permissive caller fallback settings', async () => {
    await runAgent({
      projectId: 'selected',
      mode: 'act',
      baseMessages,
      workspaceScope,
      contextEgress: 'external_allowed',
      routingSettings: { preference: 'ask_external' },
    })
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        contextEgress: 'local_only',
        routingSettings: expect.objectContaining({ preference: 'local_only' }),
      })
    )
    expect(mocks.stream).toHaveBeenCalledOnce()
  })

  it.each(['injected', 'resolved'])(
    'rejects a %s external gateway before any workspace content is sent',
    async origin => {
      const externalGateway = gateway('laravel_proxy')
      mocks.resolve.mockResolvedValue({ gateway: externalGateway })
      await expect(
        runAgent({
          projectId: 'selected',
          mode: 'act',
          baseMessages,
          workspaceScope,
          ...(origin === 'injected' ? { inferenceGateway: externalGateway } : {}),
        })
      ).rejects.toThrow(/lokal|Arbeitsbereich/u)
      expect(mocks.stream).not.toHaveBeenCalled()
      expect(mocks.executeWorkspace).not.toHaveBeenCalled()
    }
  )

  it('retains narrower tool-access restrictions even in workspace mode', async () => {
    mocks.stream.mockResolvedValueOnce(response('workspace_overview')).mockResolvedValueOnce(response())
    const result = await runAgent({
      projectId: 'selected',
      mode: 'act',
      baseMessages,
      workspaceScope,
      inferenceGateway: gateway(),
      toolAccess: 'none',
    })
    expect(descriptorNames(firstRequest())).toEqual([])
    expect(mocks.executeWorkspace).not.toHaveBeenCalled()
    expect(result.toolFailures).toBe(1)
  })

  it('stops a workspace mutation after its pending approval is revoked by a mode change', async () => {
    definitions.set('workspace_project_update', {
      name: 'workspace_project_update',
      category: 'app',
      description: 'Update an explicit project.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      mutating: true,
      requiresApproval: true,
      dataHandling: 'ephemeral',
      workspaceOnly: true,
      execute: mocks.executeWorkspace,
    })
    mocks.stream.mockResolvedValueOnce(response('workspace_project_update'))
    mocks.approve.mockImplementationOnce(async () => {
      updateExecutionControls({ mode: 'observe', killSwitch: false, scope: 'revoked' })
      return true
    })
    await expect(
      runAgent({
        projectId: 'selected',
        mode: 'act',
        baseMessages,
        workspaceScope,
        inferenceGateway: gateway(),
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.approve).toHaveBeenCalledWith('workspace-call')
    expect(mocks.executeWorkspace).not.toHaveBeenCalled()
  })
})
