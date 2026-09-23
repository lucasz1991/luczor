import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(),
  getTool: vi.fn(),
  toOpenAITools: vi.fn(),
  execute: vi.fn(),
  awaitApproval: vi.fn(),
  loadExecutionPolicy: vi.fn(),
  canAutoExecuteTool: vi.fn(),
  queueToolCall: vi.fn(),
  updateToolCallStatus: vi.fn(),
  addHiddenToolMessage: vi.fn(),
  setStatus: vi.fn(),
  pulse: vi.fn(),
  setLastTool: vi.fn(),
  logAgentEvent: vi.fn(),
  createAdaptiveAssistance: vi.fn(),
  hud: { killSwitch: false },
}))

vi.mock('@/services/openrouter.service', () => ({
  OpenRouterService: { streamChatWithTools: mocks.streamChatWithTools },
}))
vi.mock('@/services/inference/coordinator', () => ({
  resolveInferenceRouteForTurn: vi.fn(async () => ({
    gateway: {
      id: 'test-laravel',
      target: 'laravel_proxy',
      streamChatWithTools: mocks.streamChatWithTools,
    },
  })),
}))
vi.mock('@/services/tools/registry', () => ({
  getTool: mocks.getTool,
  toOpenAITools: mocks.toOpenAITools,
}))
vi.mock('@/services/approvals', () => ({ awaitApproval: mocks.awaitApproval }))
vi.mock('@/services/executionPolicy', () => ({
  loadExecutionPolicy: mocks.loadExecutionPolicy,
  canAutoExecuteTool: mocks.canAutoExecuteTool,
}))
vi.mock('@/state/store', () => ({
  mutations: {
    queueToolCall: mocks.queueToolCall,
    updateToolCallStatus: mocks.updateToolCallStatus,
    addHiddenToolMessage: mocks.addHiddenToolMessage,
  },
}))
vi.mock('@/state/hud', () => ({
  hud: mocks.hud,
  setStatus: mocks.setStatus,
  pulse: mocks.pulse,
  setLastTool: mocks.setLastTool,
}))
vi.mock('@/services/api/sync', () => ({ logAgentEvent: mocks.logAgentEvent }))
vi.mock('@/services/agents/adaptiveAssistance', () => ({ createAdaptiveAssistance: mocks.createAdaptiveAssistance }))

import { runAgent } from '@/services/agent'
import { executionGate } from '@/services/executionGate'
import type { ToolDef } from '@/services/tools/types'
import { mutationKey } from '@/services/agents/chatCheckpoint'
import type { createAdaptiveAssistance } from '@/services/agents/adaptiveAssistance'

function arrangeApprovalGatedTool() {
  mocks.streamChatWithTools
    .mockResolvedValueOnce({
      content: '',
      requestId: 'request-1',
      toolCalls: [{ id: 'call-1', name: 'write_tool', arguments: { value: 1 } }],
      rawToolCalls: [],
    })
    .mockResolvedValueOnce({
      content: 'Erledigt.',
      requestId: 'request-2',
      toolCalls: [],
      rawToolCalls: [],
    })
  mocks.getTool.mockReturnValue({
    name: 'write_tool',
    category: 'project',
    mutating: true,
    requiresApproval: true,
    parameters: { type: 'object', additionalProperties: true },
    execute: mocks.execute,
  })
  mocks.execute.mockResolvedValue({ ok: true })
}

describe('runAgent auto execution', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.hud.killSwitch = false
    mocks.toOpenAITools.mockReturnValue([])
    mocks.loadExecutionPolicy.mockResolvedValue({ autoExecuteMutatingTools: true })
  })

  function researchTool(): ToolDef {
    return {
      name: 'research_read',
      category: 'app',
      description: 'Read captured research source',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { observation_id: { type: 'string', minLength: 1 } },
        required: ['observation_id'],
      },
      mutating: true,
      requiresApproval: true,
      retentionPolicy: 'local_only',
      risk: 'sensitive',
      scope: 'project',
      execute: mocks.execute,
    }
  }
  function researchCalls(name = 'research_read', args: Record<string, unknown> = { observation_id: 'observed-one' }) {
    mocks.streamChatWithTools
      .mockResolvedValueOnce({
        content: '',
        requestId: 'research-request',
        toolCalls: [{ id: 'research-call', name, arguments: args }],
        rawToolCalls: [],
      })
      .mockResolvedValueOnce({ content: 'Quellen gelesen.', toolCalls: [], rawToolCalls: [] })
    mocks.execute.mockResolvedValue({ ok: true, source_id: 'verified-source' })
  }

  it('keeps run-bound submission closures out of delegated local analysis', async () => {
    type AssistanceInput = Parameters<typeof createAdaptiveAssistance>[0]
    let assistance!: AssistanceInput
    mocks.createAdaptiveAssistance.mockImplementation((input: AssistanceInput) => {
      assistance = input
    })
    const submit: ToolDef = {
      ...researchTool(),
      name: 'research_submit_review',
      mutating: false,
      requiresApproval: false,
      effects: ['read'],
    }
    const read: ToolDef = {
      ...researchTool(),
      name: 'context_read',
      mutating: false,
      requiresApproval: false,
      effects: ['read'],
    }
    mocks.getTool.mockImplementation((name: string) => (name === 'context_read' ? read : undefined))
    mocks.toOpenAITools.mockReturnValue([
      { type: 'function', function: { name: read.name, description: read.description, parameters: read.parameters } },
    ])
    mocks.streamChatWithTools
      .mockImplementationOnce(async () => {
        await assistance.execute(
          { target: 'local', role: 'review', task: 'Analyze the supplied evidence.', tools: ['context_read', submit.name] },
          new AbortController().signal
        )
        return { content: 'Analyse übernommen.', toolCalls: [], rawToolCalls: [] }
      })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'child-submit', name: submit.name, arguments: {} }],
        rawToolCalls: [],
      })
      .mockResolvedValueOnce({ content: 'Begrenzte Analyse geliefert.', toolCalls: [], rawToolCalls: [] })
    await runAgent({
      projectId: 'project-1',
      baseMessages: [{ role: 'user', content: 'Review sources.' }],
      mode: 'act',
      agentMode: true,
      additionalTools: [submit],
      initialToolNames: [submit.name],
      inferenceGateway: { id: 'local-test', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(assistance.localTools).toContain('context_read')
    expect(assistance.localTools).not.toContain(submit.name)
    expect(mocks.streamChatWithTools.mock.calls[1]?.[0].tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: submit.name }) })])
    )
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('admits only a run-bound research adapter through its narrow grant and retains its scope locally', async () => {
    researchCalls()
    const tool = researchTool()
    const grant = vi.fn(() => true)
    const researchScope = {
      principalId: 'owner',
      projectId: 'project-1',
      expectedRootPath: 'C:/Research/one',
      expectedWorkspaceUpdatedAt: 1,
      runId: 'run-one',
      researchId: 'run-one',
    }
    const result = await runAgent({
      projectId: 'project-1',
      conversationId: 'chat-one',
      runId: 'run-one',
      baseMessages: [{ role: 'user', content: 'Read current sources.' }],
      mode: 'act',
      additionalTools: [tool],
      initialToolNames: [tool.name],
      researchScope,
      toolApprovalGrant: grant,
      inferenceGateway: { id: 'test-local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(grant).toHaveBeenCalledWith(tool, { observation_id: 'observed-one' }, expect.anything())
    expect(mocks.awaitApproval).not.toHaveBeenCalled()
    expect(mocks.execute).toHaveBeenCalledWith(
      { observation_id: 'observed-one' },
      expect.objectContaining({ researchScope })
    )
    expect(result.workingContext?.dataPolicy).toBe('local_only')
    expect(mocks.streamChatWithTools.mock.calls[0]![0].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: 'research_read' }) }),
      ])
    )
  })

  it('never applies a research grant to a globally registered tool', async () => {
    arrangeApprovalGatedTool()
    const grant = vi.fn(() => true)
    mocks.awaitApproval.mockResolvedValue(false)
    await runAgent({ projectId: 'project-1', baseMessages: [], mode: 'act', toolApprovalGrant: grant })
    expect(grant).not.toHaveBeenCalled()
    expect(mocks.awaitApproval).toHaveBeenCalledOnce()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('reexecutes verified research probes with fresh journal identities, including legacy cached/uncertain continuation', async () => {
    const tool = researchTool()
    const researchScope = {
      principalId: 'owner',
      projectId: 'project-1',
      expectedRootPath: 'C:/Research/probe',
      expectedWorkspaceUpdatedAt: 1,
      runId: 'repeat-run',
      researchId: 'repeat-run',
    }
    const seen = new Set<string>()
    const before = vi.fn(async (call: { operationId?: string }) => {
      if (!call.operationId || seen.has(call.operationId)) throw new Error('journal identity reused')
      seen.add(call.operationId)
      return { finish: vi.fn(async () => undefined) }
    })
    mocks.execute.mockResolvedValue({ ok: true, observation_id: 'fresh-observation' })
    const call = {
      content: '',
      toolCalls: [{ id: 'same-provider-id', name: tool.name, arguments: { observation_id: 'known' } }],
      rawToolCalls: [],
    }
    mocks.streamChatWithTools
      .mockResolvedValueOnce(call)
      .mockResolvedValueOnce(call)
      .mockResolvedValueOnce({ content: 'Read twice.', toolCalls: [], rawToolCalls: [] })
    const options = {
      projectId: 'project-1',
      conversationId: 'chat',
      runId: 'repeat-run',
      baseMessages: [],
      mode: 'act' as const,
      researchScope,
      additionalTools: [tool],
      initialToolNames: [tool.name],
      toolApprovalGrant: () => true,
      effectJournal: { before },
      onCheckpoint: async () => undefined,
      inferenceGateway: {
        id: 'test-local',
        target: 'local_llama_cpp' as const,
        streamChatWithTools: mocks.streamChatWithTools,
      },
    }
    const first = await runAgent(options)
    expect(mocks.execute).toHaveBeenCalledTimes(2)
    expect(seen.size).toBe(2)
    const key = mutationKey(tool.name, { observation_id: 'known' })
    mocks.streamChatWithTools
      .mockResolvedValueOnce(call)
      .mockResolvedValueOnce({ content: 'Reread after resume.', toolCalls: [], rawToolCalls: [] })
    await runAgent({
      ...options,
      continuation: {
        ...first.workingContext!,
        completedMutations: [[key, { ok: true, output: { observation_id: 'expired' } }]],
        uncertainMutations: [key],
        operationIds: [[key, 'previous-operation']],
      },
    })
    expect(mocks.execute).toHaveBeenCalledTimes(3)
    expect(seen.size).toBe(3)
    expect(seen.has('previous-operation')).toBe(false)
  })

  it('rejects adapter name collisions and non-research overrides before a provider request', async () => {
    const tool = researchTool()
    await expect(
      runAgent({
        projectId: 'project-1',
        baseMessages: [],
        mode: 'act',
        additionalTools: [{ ...tool, name: 'fs_write' }],
      })
    ).rejects.toThrow()
    mocks.getTool.mockReturnValue(tool)
    await expect(
      runAgent({ projectId: 'project-1', baseMessages: [], mode: 'act', additionalTools: [tool] })
    ).rejects.toThrow()
    expect(mocks.streamChatWithTools).not.toHaveBeenCalled()
  })

  it.each(['observe', 'kill-switch', 'invalid-arguments', 'disabled'] as const)(
    'keeps %s ahead of a research grant',
    async constraint => {
      researchCalls(
        'research_read',
        constraint === 'invalid-arguments'
          ? { observation_id: 'known', file: 'C:/secret' }
          : { observation_id: 'known' }
      )
      const grant = vi.fn(() => true)
      const tool = researchTool()
      if (constraint === 'kill-switch') mocks.hud.killSwitch = true
      await runAgent({
        projectId: 'project-1',
        baseMessages: [],
        mode: constraint === 'observe' ? 'observe' : 'act',
        additionalTools: [tool],
        initialToolNames: [tool.name],
        toolApprovalGrant: grant,
        disabledTools: constraint === 'disabled' ? [tool.name] : undefined,
        inferenceGateway: {
          id: 'test-local',
          target: 'local_llama_cpp',
          streamChatWithTools: mocks.streamChatWithTools,
        },
      })
      expect(mocks.execute).not.toHaveBeenCalled()
      expect(grant).not.toHaveBeenCalled()
    }
  )

  it('discards tokens and the final result after a project/account change even if the provider ignores abort', async () => {
    const onToken = vi.fn()
    const onProgress = vi.fn()
    mocks.streamChatWithTools.mockImplementation(async options => {
      executionGate.invalidate()
      options.onToken('Old account response')
      return { content: 'Old account response', toolCalls: [], rawToolCalls: [] }
    })
    await expect(
      runAgent({ projectId: 'p1', baseMessages: [], mode: 'act', onToken, onProgress })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(onToken).not.toHaveBeenCalled()
    expect(onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'receiving' }))
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('bypasses only the per-call approval when policy allows the act-mode tool', async () => {
    arrangeApprovalGatedTool()
    mocks.canAutoExecuteTool.mockReturnValue(true)

    const result = await runAgent({
      projectId: 'project-1',
      baseMessages: [{ role: 'user', content: 'Führe es aus' }],
      mode: 'act',
    })

    expect(result.finalText).toBe('Erledigt.')
    expect(mocks.canAutoExecuteTool).toHaveBeenCalledWith(
      { autoExecuteMutatingTools: true },
      expect.objectContaining({ mode: 'act', mutating: true, requiresApproval: true })
    )
    expect(mocks.awaitApproval).not.toHaveBeenCalled()
    expect(mocks.execute).toHaveBeenCalledWith(
      { value: 1 },
      expect.objectContaining({ projectId: 'project-1', signal: expect.any(AbortSignal), inferenceTarget: 'local' })
    )
  })

  it('keeps observe mode strict even when auto execution is enabled', async () => {
    arrangeApprovalGatedTool()
    mocks.canAutoExecuteTool.mockReturnValue(true)

    const result = await runAgent({
      projectId: 'project-1',
      baseMessages: [{ role: 'user', content: 'Führe es aus' }],
      mode: 'observe',
    })

    expect(result.finalText).toBe('Erledigt.')
    expect(mocks.canAutoExecuteTool).not.toHaveBeenCalled()
    expect(mocks.awaitApproval).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(result.toolFailures).toBe(1)
  })

  it('keeps the kill switch ahead of auto execution', async () => {
    arrangeApprovalGatedTool()
    mocks.hud.killSwitch = true
    mocks.canAutoExecuteTool.mockReturnValue(true)

    const result = await runAgent({
      projectId: 'project-1',
      baseMessages: [{ role: 'user', content: 'Führe es aus' }],
      mode: 'act',
    })

    expect(mocks.canAutoExecuteTool).not.toHaveBeenCalled()
    expect(mocks.awaitApproval).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(result.toolFailures).toBe(1)
  })

  it('honors auto-execution revocation between tools returned in the same round', async () => {
    arrangeApprovalGatedTool()
    mocks.streamChatWithTools.mockReset()
    mocks.streamChatWithTools
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 'call-1', name: 'write_tool', arguments: { value: 1 } },
          { id: 'call-2', name: 'write_tool', arguments: { value: 2 } },
        ],
        rawToolCalls: [],
      })
      .mockResolvedValueOnce({ content: 'Beide Änderungen ausgeführt.', toolCalls: [], rawToolCalls: [] })
    mocks.loadExecutionPolicy
      .mockResolvedValueOnce({ autoExecuteMutatingTools: true })
      .mockResolvedValueOnce({ autoExecuteMutatingTools: false })
    mocks.canAutoExecuteTool.mockImplementation(policy => policy.autoExecuteMutatingTools)
    mocks.awaitApproval.mockResolvedValue(true)

    const result = await runAgent({ projectId: 'p1', baseMessages: [], mode: 'act' })

    expect(mocks.loadExecutionPolicy).toHaveBeenCalledTimes(2)
    expect(mocks.awaitApproval).toHaveBeenCalledExactlyOnceWith('call-2', expect.anything())
    expect(mocks.execute).toHaveBeenNthCalledWith(1, { value: 1 }, expect.objectContaining({ projectId: 'p1' }))
    expect(mocks.execute).toHaveBeenNthCalledWith(2, { value: 2 }, expect.objectContaining({ projectId: 'p1' }))
    expect(result.toolSuccesses).toBe(2)
  })

  it('rejects a queued tool when canceled while its live policy is loading', async () => {
    arrangeApprovalGatedTool()
    const abort = new AbortController()
    mocks.loadExecutionPolicy.mockImplementation(async () => {
      abort.abort()
      return { autoExecuteMutatingTools: true }
    })

    await expect(
      runAgent({ projectId: 'p1', baseMessages: [], mode: 'act', signal: abort.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.awaitApproval).not.toHaveBeenCalled()
    expect(mocks.updateToolCallStatus).toHaveBeenCalledWith('p1', 'call-1', 'rejected')
  })

  it.each(['observe', 'kill_switch'] as const)('rechecks %s after loading the live policy', async change => {
    arrangeApprovalGatedTool()
    let mode: 'act' | 'observe' = 'act'
    mocks.loadExecutionPolicy.mockImplementation(async () => {
      if (change === 'observe') mode = 'observe'
      else mocks.hud.killSwitch = true
      return { autoExecuteMutatingTools: true }
    })

    const result = await runAgent({ projectId: 'p1', baseMessages: [], mode: 'act', getMode: () => mode })

    expect(result.toolFailures).toBe(1)
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.awaitApproval).not.toHaveBeenCalled()
    expect(mocks.canAutoExecuteTool).not.toHaveBeenCalled()
  })

  it.each([
    [{ ok: false, error: 'Aktion fehlgeschlagen.' }, 'Aktion fehlgeschlagen.'],
    [{ ok: false, code: 1, stderr: 'CLI ist nicht angemeldet.' }, 'CLI ist nicht angemeldet.'],
    [{ ok: false, timed_out: true }, 'Zeitlimit'],
    [{ ok: false, code: 7 }, 'Exit-Code 7'],
    [{ ok: false }, 'als fehlgeschlagen gemeldet'],
  ])('records a structured action failure instead of a successful invocation: %j', async (output, expectedError) => {
    arrangeApprovalGatedTool()
    mocks.canAutoExecuteTool.mockReturnValue(true)
    mocks.execute.mockResolvedValue(output)
    mocks.streamChatWithTools.mockReset()
    mocks.streamChatWithTools
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'call-1', name: 'write_tool', arguments: {} }],
        rawToolCalls: [],
      })
      .mockResolvedValueOnce({ content: '', toolCalls: [], rawToolCalls: [] })

    const result = await runAgent({ projectId: 'p1', baseMessages: [], mode: 'act' })

    expect(result).toMatchObject({ toolFailures: 1, toolSuccesses: 0 })
    expect(result.finalText).toContain(expectedError)
    expect(mocks.updateToolCallStatus).toHaveBeenCalledWith('p1', 'call-1', 'failed')
    expect(mocks.logAgentEvent).toHaveBeenCalledWith('tool.failed', expect.objectContaining({ ok: false }))
    const feedback = mocks.streamChatWithTools.mock.calls[1]![0].messages.find(
      (message: { role: string }) => message.role === 'tool'
    )
    expect(JSON.parse(feedback.content)).toMatchObject({ ok: false, error: expect.stringContaining(expectedError) })
  })
})
