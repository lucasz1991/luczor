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
  hud: { killSwitch: false },
}))

vi.mock('@/services/openrouter.service', () => ({
  OpenRouterService: { streamChatWithTools: mocks.streamChatWithTools },
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

import { runAgent } from '@/services/agent'

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
      { mode: 'act', mutating: true, requiresApproval: true }
    )
    expect(mocks.awaitApproval).not.toHaveBeenCalled()
    expect(mocks.execute).toHaveBeenCalledWith({ value: 1 }, { projectId: 'project-1' })
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
})
