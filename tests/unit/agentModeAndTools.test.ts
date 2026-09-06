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
  resolveInferenceRouteForTurn: vi.fn(),
  hashInferenceEgressRequest: vi.fn(),
  getApiConfigSnapshot: vi.fn(),
  hud: { killSwitch: false },
}))

vi.mock('@/services/openrouter.service', () => ({
  OpenRouterService: { streamChatWithTools: mocks.streamChatWithTools },
}))
vi.mock('@/services/inference/coordinator', () => ({
  resolveInferenceRouteForTurn: mocks.resolveInferenceRouteForTurn,
  hashInferenceEgressRequest: mocks.hashInferenceEgressRequest,
}))
vi.mock('@/services/api/luczorApi', () => ({
  getApiConfigSnapshot: mocks.getApiConfigSnapshot,
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
import { LocalInferenceError } from '@/services/inference/localModelManager'

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
    mocks.resolveInferenceRouteForTurn.mockResolvedValue({
      gateway: {
        id: 'test-laravel',
        target: 'laravel_proxy',
        streamChatWithTools: mocks.streamChatWithTools,
      },
    })
    mocks.hashInferenceEgressRequest.mockResolvedValue('a'.repeat(64))
    mocks.getApiConfigSnapshot.mockResolvedValue({
      baseUrl: 'https://luczor.example/luczor-a',
      deviceKey: 'device-key',
      clientId: 'desktop-1',
    })
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
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.execute.mockResolvedValue({ name: 'Projekt 2', summary: '', goals: [] })
  })

  it('keeps temporary tool activity outside persistent messages and server audit', async () => {
    const queue = vi.fn(),
      update = vi.fn(),
      approve = vi.fn().mockResolvedValue(true)
    mocks.getTool.mockReturnValue({
      name: 'project_upsert_goal',
      category: 'project',
      mutating: true,
      requiresApproval: true,
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.streamChatWithTools
      .mockResolvedValueOnce(toolCallResult)
      .mockResolvedValueOnce({ content: 'Erledigt.', toolCalls: [], rawToolCalls: [] })
    await runAgent({
      projectId: 'p1',
      mode: 'act',
      baseMessages: [{ role: 'user', content: 'Bitte speichern' }],
      toolSession: { queue, update, approve },
    })
    expect(approve).toHaveBeenCalledWith('call-1')
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith('call-1', 'executed')
    expect(mocks.queueToolCall).not.toHaveBeenCalled()
    expect(mocks.addHiddenToolMessage).not.toHaveBeenCalled()
    expect(mocks.logAgentEvent).not.toHaveBeenCalled()
  })

  it('does not execute a late tool result after cancellation', async () => {
    const abort = new AbortController()
    mocks.streamChatWithTools.mockImplementationOnce(async () => {
      abort.abort()
      return toolCallResult
    })
    await expect(
      runAgent({
        projectId: 'p1',
        mode: 'act',
        baseMessages: [{ role: 'user', content: 'Bitte lesen' }],
        signal: abort.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('recognizes explicit execution requests but not ordinary questions', () => {
    expect(shouldRequireToolCall('ok dann speichere es jetzt')).toBe(true)
    expect(shouldRequireToolCall('prüfen bitte')).toBe(true)
    expect(shouldRequireToolCall('Du sollst die Aufgaben speichern')).toBe(true)
    expect(shouldRequireToolCall('Ändere die Projektbeschreibung.')).toBe(true)
    expect(shouldRequireToolCall('Öffne jetzt die Seite.')).toBe(true)
    expect(shouldRequireToolCall('Wie geht es dir heute?')).toBe(false)
    expect(shouldRequireToolCall('Erstelle bitte einen Plan, wie wir Dateien löschen können.')).toBe(false)
    expect(shouldRequireToolCall('Plan erstellen')).toBe(false)
    expect(shouldRequireToolCall('Plan jetzt umsetzen')).toBe(true)
    expect(shouldRequireToolCall('Noch nichts umsetzen.')).toBe(false)
    expect(shouldRequireToolCall('Den Plan noch nicht umsetzen.')).toBe(false)
    expect(shouldRequireToolCall('Ja, die Variante passt.')).toBe(false)
    expect(shouldRequireToolCall('Prüfe die Dateien für den Plan.')).toBe(true)
    expect(looksLikeInternalReasoningLeak('We need to respond: The user says hello.')).toBe(true)
    expect(looksLikeInternalReasoningLeak('Ich habe den Projektzustand geprüft.')).toBe(false)
  })

  it('names attached tools and makes the current act mode override history', () => {
    const prompt = buildSystemPreamble('act', 'Projekt 2')
    expect(prompt).toContain('AKTUELLER MODUS: HANDELN')
    expect(prompt).toContain('project_get_state, project_upsert_goal')
    expect(prompt).toContain('Behaupte niemals')
    expect(prompt).toContain('project_create ist ausschließlich')
    expect(prompt).toContain('Planung besprichst du normalerweise im Chat')
    expect(prompt).toContain('Zustimmung zu einer Variante ist noch kein Ausführungsauftrag')
  })

  it.each(['act', 'unrestricted'] as const)(
    'blocks mutations and agent starts during discussion in %s mode',
    async mode => {
      mocks.getTool.mockImplementation(name => ({
        name,
        category: 'project',
        mutating: name !== 'project_get_state',
        requiresApproval: false,
        effects: name === 'project_get_state' ? ['read'] : ['execute'],
        parameters: { type: 'object', additionalProperties: true },
        execute: mocks.execute,
      }))
      mocks.canAutoExecuteTool.mockReturnValue(true)
      const result = {
        ...toolCallResult,
        toolCalls: [{ id: 'call-1', name: 'project_upsert_goal', arguments: {} }],
        rawToolCalls: [
          { id: 'call-1', type: 'function' as const, function: { name: 'project_upsert_goal', arguments: '{}' } },
        ],
      }
      mocks.streamChatWithTools
        .mockResolvedValueOnce(result)
        .mockResolvedValueOnce({ content: 'Besprechen wir zuerst die Varianten.', toolCalls: [], rawToolCalls: [] })
      const outcome = await runAgent({
        projectId: 'project-2',
        mode,
        toolChoice: 'required',
        baseMessages: [{ role: 'user', content: 'Erstelle bitte einen Plan.' }],
      })
      expect(mocks.streamChatWithTools.mock.calls[0]![0]).toMatchObject({
        toolChoice: 'auto',
        tools: [expect.objectContaining({ function: expect.objectContaining({ name: 'project_get_state' }) })],
      })
      expect(mocks.execute).not.toHaveBeenCalled()
      expect(mocks.awaitApproval).not.toHaveBeenCalled()
      expect(mocks.updateToolCallStatus).toHaveBeenCalledWith('project-2', 'call-1', 'rejected')
      expect(outcome.toolFailures).toBe(1)
    }
  )

  it('allows necessary read tools during a planning discussion without forcing a tool call', async () => {
    mocks.streamChatWithTools
      .mockResolvedValueOnce(toolCallResult)
      .mockResolvedValueOnce({ content: 'Hier sind die besprochenen Schritte.', toolCalls: [], rawToolCalls: [] })
    await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      toolChoice: 'required',
      baseMessages: [{ role: 'user', content: 'Lass uns das Vorgehen gemeinsam planen.' }],
    })
    expect(mocks.streamChatWithTools.mock.calls[0]![0].toolChoice).toBe('auto')
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.awaitApproval).not.toHaveBeenCalled()
  })

  it.each(['Plan jetzt umsetzen', 'Aktualisiere den Plan um einen Testschritt.'])(
    'preserves normal execution after a clear follow-up request: %s',
    async text => {
      mocks.getTool.mockReturnValue({
        name: 'project_upsert_goal',
        category: 'project',
        mutating: true,
        requiresApproval: true,
        parameters: { type: 'object', additionalProperties: true },
        execute: mocks.execute,
      })
      mocks.awaitApproval.mockResolvedValue(true)
      mocks.streamChatWithTools
        .mockResolvedValueOnce(toolCallResult)
        .mockResolvedValueOnce({ content: 'Ausgeführt.', toolCalls: [], rawToolCalls: [] })
      await runAgent({
        projectId: 'project-2',
        mode: 'act',
        baseMessages: [
          { role: 'user', content: 'Lass uns das Vorgehen planen.' },
          { role: 'assistant', content: 'Vorschlag.' },
          { role: 'user', content: text },
        ],
      })
      expect(mocks.awaitApproval).toHaveBeenCalledWith('call-1')
      expect(mocks.execute).toHaveBeenCalledTimes(1)
    }
  )

  it('refreshes the live mode, forces only the first tool round and hides intermediate tool reasoning', async () => {
    const visibleTokens = vi.fn()
    const progress = vi.fn()
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
      onProgress: progress,
    })

    const firstArgs = mocks.streamChatWithTools.mock.calls[0]![0]
    const secondArgs = mocks.streamChatWithTools.mock.calls[1]![0]
    expect(firstArgs.toolChoice).toBe('required')
    expect(secondArgs.toolChoice).toBe('auto')
    expect(firstArgs.messages[0].content).toContain('AKTUELLER MODUS: HANDELN')
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(visibleTokens).toHaveBeenCalledTimes(1)
    expect(visibleTokens).toHaveBeenCalledWith('Projektzustand geprüft.')
    expect(progress).toHaveBeenCalledWith({
      phase: 'receiving',
      round: 1,
      characters: 'interne Tool-Überlegung'.length,
    })
    expect(progress).toHaveBeenCalledWith({ phase: 'thinking', round: 2 })
    expect(JSON.stringify(progress.mock.calls)).not.toContain('interne Tool-Überlegung')
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
      parameters: { type: 'object', additionalProperties: true },
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

  it('returns useful partial environment data to the current model without archiving private details', async () => {
    const partial = {
      ok: false,
      status: 'partial',
      monitors: [{ id: 1, name: 'LOCAL_MONITOR' }],
      sources: { monitors: { ok: true }, windows: { ok: false, error: 'LOCAL_WINDOW_ERROR' } },
    }
    mocks.getTool.mockReturnValue({
      name: 'os_environment',
      category: 'os',
      mutating: false,
      requiresApproval: true,
      dataHandling: 'ephemeral',
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.awaitApproval.mockResolvedValue(true)
    mocks.execute.mockResolvedValue(partial)
    mocks.streamChatWithTools
      .mockResolvedValueOnce({
        ...toolCallResult,
        toolCalls: [{ id: 'call-1', name: 'os_environment', arguments: {} }],
      })
      .mockResolvedValueOnce({
        content: 'Monitor erkannt; Fensteranalyse fehlgeschlagen.',
        toolCalls: [],
        rawToolCalls: [],
      })

    const result = await runAgent({ projectId: 'p1', baseMessages: [], mode: 'act' })

    const feedback = mocks.streamChatWithTools.mock.calls[1]![0].messages.find(
      (message: { role: string }) => message.role === 'tool'
    )
    const outcome = JSON.parse(feedback.content)
    expect(outcome.ok).toBe(false)
    expect(JSON.parse(outcome.output)).toEqual(partial)
    expect(result).toMatchObject({ toolFailures: 1, toolSuccesses: 0, ephemeralDataUsed: true })
    expect(JSON.stringify(mocks.addHiddenToolMessage.mock.calls)).not.toMatch(/LOCAL_MONITOR|LOCAL_WINDOW_ERROR/)
    expect(JSON.stringify(mocks.logAgentEvent.mock.calls)).not.toMatch(/LOCAL_MONITOR|LOCAL_WINDOW_ERROR/)
  })

  it('blocks a pending mutation when the user switches back to observe before execution', async () => {
    let runtimeMode: 'act' | 'observe' = 'act'
    mocks.getTool.mockReturnValue({
      name: 'project_upsert_goal',
      category: 'project',
      mutating: true,
      requiresApproval: true,
      parameters: { type: 'object', additionalProperties: true },
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

  it('fails closed instead of retrying a one-shot external reasoning leak', async () => {
    mocks.resolveInferenceRouteForTurn.mockResolvedValueOnce({
      gateway: {
        id: 'approved-external',
        target: 'laravel_proxy',
        streamChatWithTools: mocks.streamChatWithTools,
      },
      replacementMessages: [{ role: 'user', content: 'Hallo' }],
      externalOneShot: true,
    })
    mocks.streamChatWithTools.mockResolvedValueOnce({
      content: 'We need to respond: The user says hello. According to system...',
      toolCalls: [],
      rawToolCalls: [],
    })

    await expect(
      runAgent({
        projectId: 'project-2',
        baseMessages: [{ role: 'user', content: 'Hallo' }],
        mode: 'observe',
      })
    ).rejects.toMatchObject({ code: 'external_unsafe_response' })
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1)
  })

  it('propagates Flash opt-in and rebuilds one approved external turn only from provider-safe messages', async () => {
    mocks.resolveInferenceRouteForTurn
      .mockRejectedValueOnce(new LocalInferenceError('approval required', 'external_approval_required', false, false))
      .mockImplementationOnce(async input => ({
        gateway: {
          id: 'approved-external',
          target: 'laravel_proxy',
          streamChatWithTools: mocks.streamChatWithTools,
        },
        replacementMessages: input.externalPackage.messages,
        externalOneShot: true,
      }))
    mocks.streamChatWithTools.mockResolvedValueOnce({
      content: 'Sichere externe Antwort',
      toolCalls: [],
      rawToolCalls: [],
    })
    const approve = vi.fn(async () => true)

    const result = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'system', content: 'LOCAL_ONLY_SECRET' }],
      externalBaseMessages: [{ role: 'user', content: 'Provider-sichere Frage' }],
      mode: 'observe',
      routingSettings: { experimentalFlashNext: true },
      requestExternalApproval: approve,
    })

    expect(mocks.resolveInferenceRouteForTurn.mock.calls[0]![0]).toMatchObject({
      routingSettings: { experimentalFlashNext: true },
    })
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        packetHash: 'a'.repeat(64),
        destination: 'https://luczor.example/luczor-a',
        toolsAllowed: false,
        localReadinessMessage: 'approval required',
      })
    )
    const sent = mocks.streamChatWithTools.mock.calls[0]![0]
    expect(JSON.stringify(sent.messages)).toContain('Provider-sichere Frage')
    expect(JSON.stringify(sent.messages)).not.toContain('LOCAL_ONLY_SECRET')
    expect(JSON.stringify(sent.messages)).not.toContain('approval required')
    expect(sent).toMatchObject({ tools: [], toolChoice: 'none' })
    expect(result).toMatchObject({ finalText: 'Sichere externe Antwort', inferenceTarget: 'laravel_proxy' })
  })

  it('removes external tool claims before hashing and preserves that packet after a mode change', async () => {
    let runtimeMode: 'act' | 'observe' = 'act'
    let approvedMessages = ''
    mocks.hashInferenceEgressRequest.mockImplementation(async request => {
      approvedMessages = JSON.stringify(request.messages)
      return 'a'.repeat(64)
    })
    mocks.resolveInferenceRouteForTurn
      .mockRejectedValueOnce(new LocalInferenceError('approval required', 'external_approval_required', false, false))
      .mockImplementationOnce(async input => ({
        gateway: {
          id: 'approved-external',
          target: 'laravel_proxy',
          streamChatWithTools: mocks.streamChatWithTools,
        },
        replacementMessages: input.externalPackage.messages,
        externalOneShot: true,
      }))
    mocks.streamChatWithTools.mockResolvedValueOnce({
      content: 'Diese Anfrage hat keine Tools zur Verfügung.',
      toolCalls: [],
      rawToolCalls: [],
    })
    const preamble = buildSystemPreamble('act', 'Projekt 2')

    await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'system', content: preamble }],
      externalBaseMessages: [{ role: 'system', content: preamble }],
      mode: 'act',
      getMode: () => runtimeMode,
      requestExternalApproval: async () => {
        runtimeMode = 'observe'
        return true
      },
    })

    const sent = mocks.streamChatWithTools.mock.calls[0]![0]
    expect(JSON.stringify(sent.messages)).toBe(approvedMessages)
    expect(approvedMessages).toContain('Für diese Anfrage sind keine Tools verfügbar')
    expect(approvedMessages).not.toContain('Tatsächlich verfügbare Tools dieser Anfrage: project_get_state')
    expect(sent).toMatchObject({ tools: [], toolChoice: 'none' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('re-checks the kill switch after an approval wait', async () => {
    mocks.getTool.mockReturnValue({
      name: 'project_upsert_goal',
      category: 'project',
      mutating: true,
      requiresApproval: true,
      parameters: { type: 'object', additionalProperties: true },
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
