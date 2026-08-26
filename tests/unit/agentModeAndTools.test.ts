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
  setStatus: vi.fn(),
  pulse: vi.fn(),
  setLastTool: vi.fn(),
}))
vi.mock('@/services/api/sync', () => ({ logAgentEvent: mocks.logAgentEvent }))

import { buildSystemPreamble, looksLikeInternalReasoningLeak, runAgent, shouldRequireToolCall } from '@/services/agent'

const toolCallResult = {
  content: 'interne Tool-Überlegung',
  requestId: 'request-1',
  toolCalls: [{ id: 'call-1', name: 'project_get_state', arguments: {} }],
  rawToolCalls: [
    {
      id: 'call-1',
      type: 'function' as const,
      function: { name: 'project_get_state', arguments: '{}' },
    },
  ],
}

describe('agent mode and tool reliability', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.hud.killSwitch = false
    mocks.toOpenAITools.mockReturnValue([
      { type: 'function', function: { name: 'project_get_state', parameters: {} } },
      { type: 'function', function: { name: 'project_upsert_goal', parameters: {} } },
    ])
    mocks.loadExecutionPolicy.mockResolvedValue({ autoExecuteMutatingTools: false })
    mocks.canAutoExecuteTool.mockReturnValue(false)
    mocks.getTool.mockReturnValue({
      name: 'project_get_state',
      category: 'project',
      mutating: false,
      requiresApproval: false,
      execute: mocks.execute,
    })
    mocks.execute.mockResolvedValue({ name: 'Projekt 2', summary: '', goals: [] })
  })

  it('recognizes explicit execution requests but not ordinary questions', () => {
    expect(shouldRequireToolCall('ok dann speichere es jetzt')).toBe(true)
    expect(shouldRequireToolCall('prüfen bitte')).toBe(true)
    expect(shouldRequireToolCall('Du sollst die Aufgaben speichern')).toBe(true)
    expect(shouldRequireToolCall('Ändere die Projektbeschreibung.')).toBe(true)
    expect(shouldRequireToolCall('Öffne jetzt die Seite.')).toBe(true)
    expect(shouldRequireToolCall('Wie geht es dir heute?')).toBe(false)
    expect(looksLikeInternalReasoningLeak('We need to respond: The user says hello.')).toBe(true)
    expect(looksLikeInternalReasoningLeak('Ich habe den Projektzustand geprüft.')).toBe(false)
  })

  it('names attached tools and makes the current act mode override history', () => {
    const prompt = buildSystemPreamble('act', 'Projekt 2')
    expect(prompt).toContain('AKTUELLER MODUS: HANDELN')
    expect(prompt).toContain('project_get_state, project_upsert_goal')
    expect(prompt).toContain('Behaupte niemals')
    expect(prompt).toContain('project_create ist ausschließlich')
  })

  it('refreshes the live mode, forces only the first tool round and hides intermediate tool reasoning', async () => {
    const visibleTokens = vi.fn()
    mocks.streamChatWithTools
      .mockImplementationOnce(async args => {
        args.onToken?.('interne Tool-Überlegung')
        return toolCallResult
      })
      .mockImplementationOnce(async args => {
        args.onToken?.('Projektzustand geprüft.')
        return { content: 'Projektzustand geprüft.', toolCalls: [], rawToolCalls: [] }
      })

    const result = await runAgent({
      projectId: 'project-2',
      baseMessages: [
        { role: 'system', content: buildSystemPreamble('observe', 'Projekt 2') },
        { role: 'user', content: 'prüfen bitte' },
      ],
      mode: 'observe',
      getMode: () => 'act',
      toolChoice: 'required',
      onToken: visibleTokens,
    })

    const firstArgs = mocks.streamChatWithTools.mock.calls[0]![0]
    const secondArgs = mocks.streamChatWithTools.mock.calls[1]![0]
    expect(firstArgs.toolChoice).toBe('required')
    expect(secondArgs.toolChoice).toBe('auto')
    expect(firstArgs.messages[0].content).toContain('AKTUELLER MODUS: HANDELN')
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(visibleTokens).toHaveBeenCalledTimes(1)
    expect(visibleTokens).toHaveBeenCalledWith('Projektzustand geprüft.')
    expect(result.finalText).toBe('Projektzustand geprüft.')
  })

  it('returns the concrete tool output instead of a generic Fertig fallback', async () => {
    mocks.streamChatWithTools
      .mockResolvedValueOnce(toolCallResult)
      .mockResolvedValueOnce({ content: '', toolCalls: [], rawToolCalls: [] })

    const result = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'prüfen' }],
      mode: 'observe',
    })

    expect(result.finalText).toContain('project_get_state wurde erfolgreich ausgeführt')
    expect(result.finalText).toContain('"name":"Projekt 2"')
    expect(result.finalText).not.toBe('Fertig.')
  })

  it('keeps ephemeral tool content out of durable history and server telemetry', async () => {
    mocks.getTool.mockReturnValue({
      name: 'project_get_state',
      category: 'project',
      mutating: false,
      requiresApproval: true,
      dataHandling: 'ephemeral',
      execute: mocks.execute,
    })
    mocks.awaitApproval.mockResolvedValue(true)
    mocks.execute.mockResolvedValue({ text: 'LOCAL_SECRET' })
    mocks.streamChatWithTools
      .mockResolvedValueOnce(toolCallResult)
      .mockResolvedValueOnce({ content: 'Gelesen.', toolCalls: [], rawToolCalls: [] })

    const result = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'lies lokal' }],
      mode: 'act',
    })

    expect(mocks.addHiddenToolMessage).toHaveBeenCalledWith(
      'project-2',
      {
        ok: true,
        output: { redacted: true, output_type: 'object', item_count: undefined },
      },
      expect.objectContaining({ dataHandling: 'ephemeral' })
    )
    expect(mocks.logAgentEvent).toHaveBeenCalledWith(
      'tool.executed',
      expect.objectContaining({ output: null, output_redacted: true, error: null })
    )
    expect(JSON.stringify(mocks.addHiddenToolMessage.mock.calls)).not.toContain('LOCAL_SECRET')
    expect(JSON.stringify(mocks.logAgentEvent.mock.calls)).not.toContain('LOCAL_SECRET')
    expect(result.ephemeralDataUsed).toBe(true)
  })

  it('blocks a pending mutation when the user switches back to observe before execution', async () => {
    let runtimeMode: 'act' | 'observe' = 'act'
    mocks.getTool.mockReturnValue({
      name: 'project_upsert_goal',
      category: 'project',
      mutating: true,
      requiresApproval: true,
      execute: mocks.execute,
    })
    mocks.awaitApproval.mockImplementation(async () => {
      runtimeMode = 'observe'
      return true
    })
    mocks.streamChatWithTools
      .mockResolvedValueOnce({
        ...toolCallResult,
        toolCalls: [{ id: 'call-1', name: 'project_upsert_goal', arguments: { title: 'Ziel', status: 'open' } }],
        rawToolCalls: [],
      })
      .mockResolvedValueOnce({ content: '', toolCalls: [], rawToolCalls: [] })

    const result = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Speichere das Ziel' }],
      mode: 'act',
      getMode: () => runtimeMode,
    })

    expect(mocks.awaitApproval).toHaveBeenCalledOnce()
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(result.finalText).toContain('Modus wurde vor der Ausführung auf Beobachten geändert')
  })

  it('discards leaked internal reasoning and retries once with a user-facing answer', async () => {
    const visibleTokens = vi.fn()
    mocks.streamChatWithTools
      .mockImplementationOnce(async args => {
        args.onToken?.('We need to respond: The user says hello. According to system...')
        return {
          content: 'We need to respond: The user says hello. According to system...',
          toolCalls: [],
          rawToolCalls: [],
        }
      })
      .mockImplementationOnce(async args => {
        args.onToken?.('Hallo! Wie kann ich helfen?')
        return { content: 'Hallo! Wie kann ich helfen?', toolCalls: [], rawToolCalls: [] }
      })

    const result = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Hallo' }],
      mode: 'observe',
      onToken: visibleTokens,
    })

    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(2)
    expect(visibleTokens).toHaveBeenCalledTimes(1)
    expect(visibleTokens).toHaveBeenCalledWith('Hallo! Wie kann ich helfen?')
    expect(result.finalText).toBe('Hallo! Wie kann ich helfen?')
  })

  it('re-checks the kill switch after an approval wait', async () => {
    mocks.getTool.mockReturnValue({
      name: 'project_upsert_goal',
      category: 'project',
      mutating: true,
      requiresApproval: true,
      execute: mocks.execute,
    })
    mocks.awaitApproval.mockImplementation(async () => {
      mocks.hud.killSwitch = true
      return true
    })
    mocks.streamChatWithTools.mockResolvedValueOnce({
      content: '',
      requestId: 'request-kill-switch',
      toolCalls: [{ id: 'call-kill', name: 'project_upsert_goal', arguments: { title: 'X', status: 'open' } }],
      rawToolCalls: [
        {
          id: 'call-kill',
          type: 'function' as const,
          function: { name: 'project_upsert_goal', arguments: '{"title":"X","status":"open"}' },
        },
      ],
    })

    await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Speichere das Ziel' }],
      mode: 'act',
      maxRounds: 1,
    })

    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.updateToolCallStatus).toHaveBeenCalledWith('project-2', 'call-kill', 'rejected')
  })
})
