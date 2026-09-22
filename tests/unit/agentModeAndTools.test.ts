import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runChatAgentTeam: vi.fn(),
  prepareExternalSpecialists: vi.fn(),
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
  assistantProfileWithApiConfig: vi.fn(),
  resolveDeviceAssistance: vi.fn(),
  executeDeviceAssistance: vi.fn(),
  hud: { killSwitch: false },
}))

vi.mock('@/services/agents/chatOrchestration', () => ({ runChatAgentTeam: mocks.runChatAgentTeam }))
vi.mock('@/services/agents/externalSpecialists', () => ({
  prepareExternalSpecialists: mocks.prepareExternalSpecialists,
}))
vi.mock('@/services/agents/deviceAssistance', () => ({
  resolveAssistanceTarget: mocks.resolveDeviceAssistance,
  executeDeviceAssistance: mocks.executeDeviceAssistance,
  assistanceWorkerSummary: () => ({ devices: [] }),
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
  assistantProfileWithApiConfig: mocks.assistantProfileWithApiConfig,
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
import { ChatEffectJournalError } from '@/services/chatEffectJournal'
import { executionGate } from '@/services/executionGate'
import { modelUsageSettings } from '@/services/inference/modelUsageSettings'
import type { InferenceRequest } from '@/services/inference/types'
import { resetAssistantProfile } from '@/services/assistantProfile'
import {
  buildLaravelProxyBody,
  hashLaravelProxyBody,
  serializeLaravelProxyBody,
} from '@/services/inference/laravelProxyBody'

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

const durableTaskCreate = {
  taskCreateRecoveryReady: true,
  onCheckpoint: async () => undefined,
} as const

describe('agent mode and tool reliability', () => {
  it.each(['local_llama_cpp', 'laravel_proxy'] as const)(
    'marks private retrieval only when its local packet is used: %s',
    async target => {
      mocks.streamChatWithTools.mockResolvedValueOnce({ content: 'Answer', toolCalls: [], rawToolCalls: [] })
      const result = await runAgent({
        projectId: 'project-2',
        mode: 'observe',
        toolAccess: 'none',
        baseMessages: [{ role: 'user', content: 'Question' }],
        localOnlyContextUsed: true,
        inferenceGateway: { id: 'fixture', target, streamChatWithTools: mocks.streamChatWithTools },
      })
      expect(result.ephemeralDataUsed).toBe(target === 'local_llama_cpp')
    }
  )
  it('keeps exact context at side-effect checkpoints and on completed answers, bound to the conversation', async () => {
    const objective = 'Requirement\n'.repeat(1000) + 'Never modify protected.ts'
    const saved: import('@/services/agents/chatCheckpoint').AgentCheckpoint[] = []
    mocks.streamChatWithTools
      .mockResolvedValueOnce(toolCallResult)
      .mockResolvedValueOnce({ content: 'Completed public answer', toolCalls: [], rawToolCalls: [] })
    const result = await runAgent({
      projectId: 'project-2',
      conversationId: 'conversation-a',
      mode: 'act',
      baseMessages: [{ role: 'user', content: objective }],
      onCheckpoint: value => {
        saved.push(value)
      },
      maxRounds: 2,
    })
    expect(saved.length).toBeGreaterThan(0)
    expect(
      saved.every(value => value.messages.some(message => message.role === 'user' && message.content === objective))
    ).toBe(true)
    expect(result.continuation).toBeUndefined()
    expect(result.workingContext?.messages).toContainEqual({ role: 'user', content: objective })
    expect(result.workingContext?.messages.some(message => message.role === 'tool')).toBe(true)
    expect(result.workingContext?.messages.at(-1)).toEqual({ role: 'assistant', content: 'Completed public answer' })
    await expect(
      runAgent({
        projectId: 'project-2',
        conversationId: 'conversation-b',
        mode: 'act',
        baseMessages: [],
        continuation: result.workingContext,
      })
    ).rejects.toThrow('Kontositzung')
  })

  it('does not repeat a write with an uncertain result under a new model call', async () => {
    mocks.getTool.mockReturnValue({
      name: 'project_get_state',
      category: 'project',
      mutating: true,
      requiresApproval: false,
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.execute.mockRejectedValueOnce(new Error('Connection lost after write'))
    mocks.streamChatWithTools.mockResolvedValueOnce(toolCallResult)
    const first = await runAgent({
      projectId: 'project-2',
      mode: 'act',
      baseMessages: [{ role: 'user', content: 'Update project' }],
      maxRounds: 1,
    })
    expect(first.continuation?.uncertainMutations).toHaveLength(1)
    mocks.streamChatWithTools
      .mockResolvedValueOnce({
        ...toolCallResult,
        toolCalls: toolCallResult.toolCalls.map(call => ({ ...call, id: 'different-id' })),
        rawToolCalls: toolCallResult.rawToolCalls.map(call => ({ ...call, id: 'different-id' })),
      })
      .mockResolvedValueOnce({ content: 'Write remains unverified.', toolCalls: [], rawToolCalls: [] })
    const next = await runAgent({
      projectId: 'project-2',
      mode: 'act',
      baseMessages: [],
      continuation: first.continuation,
      maxRounds: 2,
    })
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(next.toolFailures).toBe(1)
    expect(next.workingContext?.uncertainMutations).toHaveLength(1)
  })

  it('recovers a native context limit with a smaller retrievable projection and no tool replay', async () => {
    const evidence = 'Original source evidence\n'.repeat(3000)
    mocks.execute.mockResolvedValueOnce({ ok: true, path: 'exact.ts', content: evidence })
    mocks.streamChatWithTools
      .mockResolvedValueOnce(toolCallResult)
      .mockRejectedValueOnce(new LocalInferenceError('Context full', 'runtime_context_exceeded', false, false))
      .mockResolvedValueOnce({ content: 'Continued after compaction.', toolCalls: [], rawToolCalls: [] })
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      baseMessages: [{ role: 'user', content: 'Read the project' }],
      maxRounds: 2,
      inferenceGateway: {
        id: 'local',
        target: 'local_llama_cpp',
        contextTokens: 131072,
        streamChatWithTools: mocks.streamChatWithTools,
      },
    })
    expect(result.interrupted).toBeUndefined()
    expect(result.finalText).toBe('Continued after compaction.')
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(3)
    const second = mocks.streamChatWithTools.mock.calls[1]![0] as InferenceRequest
    const third = mocks.streamChatWithTools.mock.calls[2]![0] as InferenceRequest
    expect(JSON.stringify(third.messages).length).toBeLessThan(JSON.stringify(second.messages).length)
    expect(JSON.stringify(third.messages)).toContain('contextCompacted')
    expect(
      result.workingContext!.messages.some(
        message => message.role === 'tool' && message.content.includes(evidence.slice(0, 24))
      )
    ).toBe(true)
  })

  it.each([
    ['local', 'local_llama_cpp', 'LOCAL_SYSTEM'],
    ['free', 'local_llama_cpp', 'COORDINATOR_SYSTEM'],
  ] as const)('applies the internal profile for preset %s and target %s only', async (preset, target, expected) => {
    const previous = modelUsageSettings.value
    modelUsageSettings.value = { ...previous, externalEnabled: true }
    mocks.assistantProfileWithApiConfig.mockResolvedValue({
      data: {
        persona: { name: 'Old', slug: 'old', prompt: 'LEGACY_PERSONALITY' },
        skills: [],
        revision: 'profiles',
        internal_models: {
          standard: { enabled: true, personality: 'LOCAL_PERSONALITY', system_prompt: 'LOCAL_SYSTEM' },
          external_agents: {
            enabled: true,
            personality: 'COORDINATOR_PERSONALITY',
            system_prompt: 'COORDINATOR_SYSTEM',
          },
        },
      },
    })
    const externalBaseMessages = [{ role: 'user' as const, content: 'Public question' }]
    mocks.resolveInferenceRouteForTurn.mockResolvedValue({
      gateway: { id: 'fixture', target, streamChatWithTools: mocks.streamChatWithTools },
    })
    mocks.streamChatWithTools.mockResolvedValue({
      content: 'Ergebnis',
      toolCalls: [],
      rawToolCalls: [],
      finishReason: 'stop',
    })
    try {
      await runAgent({
        projectId: 'project-2',
        mode: 'observe',
        maxRounds: 1,
        baseMessages: [{ role: 'user', content: 'Local question' }],
        externalBaseMessages,
        agentMode: true,
        agentTeamPreset: preset,
        contextEgress: 'external_allowed',
      })
      const request = mocks.streamChatWithTools.mock.calls[0]![0] as InferenceRequest
      const contents = JSON.stringify(request.messages)
      expect(contents).toContain(expected)
      expect(contents).not.toContain('LEGACY_PERSONALITY')
      expect(contents).not.toContain(expected === 'LOCAL_SYSTEM' ? 'COORDINATOR_SYSTEM' : 'LOCAL_SYSTEM')
      expect(request.contextBudget?.categories.profile).toBeGreaterThan(0)
      expect(externalBaseMessages).toEqual([{ role: 'user', content: 'Public question' }])
    } finally {
      modelUsageSettings.value = previous
    }
  })
  it('does not retrieve or inject internal profiles into an approved external turn', async () => {
    const messages = [{ role: 'user' as const, content: 'Public question' }]
    mocks.resolveInferenceRouteForTurn.mockResolvedValue({
      gateway: { id: 'external', target: 'laravel_proxy', streamChatWithTools: mocks.streamChatWithTools },
      externalOneShot: true,
      replacementMessages: messages,
    })
    mocks.assistantProfileWithApiConfig.mockRejectedValue(new Error('Must not be called for external turns'))
    mocks.streamChatWithTools.mockResolvedValue({
      content: 'Ergebnis',
      toolCalls: [],
      rawToolCalls: [],
      finishReason: 'stop',
    })
    await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      maxRounds: 1,
      baseMessages: [{ role: 'user', content: 'LOCAL_ONLY' }],
      externalBaseMessages: messages,
      agentMode: true,
      agentTeamPreset: 'free',
      internalProfileMode: 'external_agents',
    })
    expect(mocks.streamChatWithTools.mock.calls[0]![0].messages).toEqual(messages)
    expect(mocks.assistantProfileWithApiConfig).not.toHaveBeenCalled()
  })
  it('observes the selected fitted request before inference, even when diagnostics fail', async () => {
    const onContextRequest = vi.fn(() => {
      throw new Error('diagnostics unavailable')
    })
    mocks.streamChatWithTools.mockImplementationOnce(async (request: InferenceRequest) => {
      expect(onContextRequest).toHaveBeenCalledOnce()
      expect(onContextRequest.mock.calls[0]).toEqual([{ target: 'local_llama_cpp', messages: request.messages }])
      expect(request).not.toHaveProperty('onContextRequest')
      return { content: 'Hallo!', toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
    })
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      baseMessages: [{ role: 'user', content: 'Hallo!' }],
      maxRounds: 1,
      onContextRequest,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(result.finalText).toBe('Hallo!')
    expect(onContextRequest).toHaveBeenCalledOnce()
  })

  it('corrects the photographed HTTP 200 status echo without publishing invented counters', async () => {
    const fake =
      'Die nächste Modellrunde wurde unterbrochen: Tokenzählung und Kontextprüfung · HTTP 200: Der Auftrag wurde erfolgreich bearbeitet. Tokenbudget: Eingabe (gezählt) 28.000 · Kontext 43.000 · Ausgabelimit 7.000.\n\nDer Auftrag wurde in einen bereinigten Fortsetzungsstatus überführt.'
    let stale!: InferenceRequest
    mocks.streamChatWithTools
      .mockImplementationOnce(async (request: InferenceRequest) => {
        stale = request
        for (let end = 1; end <= fake.length; end++) request.onToken?.(fake.slice(0, end))
        return {
          content: fake,
          toolCalls: [],
          rawToolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 5645, outputTokens: 204, totalTokens: 5849 },
          contextUsage: {
            inputTokens: 5645,
            contextTokens: 8192,
            outputTokens: 1000,
            omittedMessages: 0,
            shortenedToolResults: 0,
          },
        }
      })
      .mockImplementationOnce(async (request: InferenceRequest) => {
        stale.onToken?.('Dieser alte Callback darf nicht sichtbar werden.')
        request.onToken?.('Welchen Teil soll ich als Nächstes prüfen?')
        return {
          content: 'Welchen Teil soll ich als Nächstes prüfen?',
          toolCalls: [],
          rawToolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 5700, outputTokens: 20, totalTokens: 5720 },
          contextUsage: {
            inputTokens: 5700,
            contextTokens: 8192,
            outputTokens: 1000,
            omittedMessages: 0,
            shortenedToolResults: 0,
          },
        }
      })
    const onToken = vi.fn(),
      onResponseReset = vi.fn(),
      onRoundComplete = vi.fn()
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      baseMessages: [{ role: 'user', content: 'ok los' }],
      maxRounds: 1,
      onToken,
      onResponseReset,
      onRoundComplete,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(result.interrupted).toBeUndefined()
    expect(result.finalText).toBe('Welchen Teil soll ich als Nächstes prüfen?')
    expect(onToken.mock.calls.flat().join('')).not.toMatch(/HTTP|43.000|alte Callback/)
    expect(onRoundComplete).toHaveBeenCalledOnce()
    expect(onResponseReset).toHaveBeenCalledExactlyOnceWith({ round: 1 })
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(2)
    const first = mocks.streamChatWithTools.mock.calls[0]![0] as InferenceRequest
    const second = mocks.streamChatWithTools.mock.calls[1]![0] as InferenceRequest
    expect(second.messages.slice(0, -1)).toEqual(first.messages)
    expect(JSON.stringify(second.messages)).not.toContain(fake)
    expect(second.toolChoice).toEqual(first.toolChoice)
    expect(result.tokenUsage).toMatchObject({
      inputTokens: 11345,
      outputTokens: 224,
      contextTokens: 8192,
      source: 'reported',
      rounds: 2,
    })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('bounds status-echo corrections and keeps the exhausted result out of speech callbacks', async () => {
    const fake = 'Die nächste Modellrunde wurde unterbrochen: HTTP 200 · Kontext 43.000.'
    mocks.streamChatWithTools.mockImplementation(async (request: InferenceRequest) => {
      request.onToken?.(fake)
      return { content: fake, toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
    })
    const onToken = vi.fn(),
      onRoundComplete = vi.fn()
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      baseMessages: [{ role: 'user', content: 'ok los' }],
      maxRounds: 1,
      onToken,
      onRoundComplete,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(3)
    expect(result.interrupted?.code).toBe('runtime_status_echo')
    expect(result.continuation).toBeDefined()
    expect(JSON.stringify(result.continuation!.messages)).not.toContain(fake)
    expect(onToken.mock.calls.flat().join('')).toBe('')
    expect(onRoundComplete).not.toHaveBeenCalled()
  })

  it('rejects the new photographed paraphrase after a first correction instead of releasing a fake RAM error', async () => {
    const attempts = [
      'Die nächste Modellrunde wurde unterbrochen: Tokenzählung und Kontextprüfung · HTTP 200: erfolgreich.',
      'Die lokale Modellrunde 1 wurde vor dem Abschluss Untergrenze erreicht: Tokenzählung und Kontextprüfung · HTTP 503: Nicht ausreichend Ressourcen. Der Tokenbudgetstand ist: Eingabe (gezählt) 25.750 · Kontext 40.000 · Ausgabe 6.000.\n\nDer Auftrag wurde in einen bereinigten Fortsetzungsrunde überführt.',
      'Welche konkrete Aufgabe soll ich im Projekt als Nächstes bearbeiten?',
    ]
    let attempt = 0
    mocks.streamChatWithTools.mockImplementation(async (request: InferenceRequest) => {
      const content = attempts[attempt++]!
      for (let end = 1; end <= content.length; end++) request.onToken?.(content.slice(0, end))
      return { content, toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
    })
    const onToken = vi.fn(),
      onResponseReset = vi.fn(),
      onRoundComplete = vi.fn()
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      maxRounds: 1,
      baseMessages: [{ role: 'user', content: 'so jetzt aber' }],
      onToken,
      onResponseReset,
      onRoundComplete,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(result.finalText).toBe(attempts[2])
    expect(result.interrupted).toBeUndefined()
    expect(onToken.mock.calls.flat().join('')).not.toMatch(/HTTP|40.000|Untergrenze|Ressourcen/)
    expect(onResponseReset).toHaveBeenCalledTimes(2)
    expect(onRoundComplete).toHaveBeenCalledOnce()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it.each(['???', 'ok los'])(
    'withholds XML function-call output for an ambiguous follow-up %s without forcing execution',
    async objective => {
      const xml =
        '<output>\n<function-call>\n<name>project_get_state</name>\n<arguments>{"include_goals":true}</arguments>\n</function-call>\n</output>'
      mocks.streamChatWithTools
        .mockImplementationOnce(async (request: InferenceRequest) => {
          for (let end = 1; end <= xml.length; end++) request.onToken?.(xml.slice(0, end))
          return { content: xml, toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
        })
        .mockResolvedValueOnce({
          content: 'Was möchtest du prüfen lassen?',
          toolCalls: [],
          rawToolCalls: [],
          finishReason: 'stop',
        })
      const onToken = vi.fn(),
        onRoundComplete = vi.fn(),
        onResponseReset = vi.fn()
      const result = await runAgent({
        projectId: 'project-2',
        mode: 'observe',
        baseMessages: [{ role: 'user', content: objective }],
        maxRounds: 1,
        onToken,
        onRoundComplete,
        onResponseReset,
        inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
      })
      expect(result.finalText).toBe('Was möchtest du prüfen lassen?')
      expect(mocks.streamChatWithTools.mock.calls[1]![0].toolChoice).toBe('auto')
      expect(onToken.mock.calls.flat().join('')).not.toContain('<')
      expect(onRoundComplete).toHaveBeenCalledOnce()
      expect(onResponseReset).toHaveBeenCalledOnce()
      expect(mocks.execute).not.toHaveBeenCalled()
    }
  )

  it('does not replay completed tools when a later answer echoes status', async () => {
    mocks.streamChatWithTools
      .mockResolvedValueOnce({ ...toolCallResult, content: 'Ich prüfe den Zustand.' })
      .mockResolvedValueOnce({
        content: 'Die nächste Modellrunde wurde unterbrochen: HTTP 200',
        toolCalls: [],
        rawToolCalls: [],
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        content: 'Das Projekt ist geprüft.',
        toolCalls: [],
        rawToolCalls: [],
        finishReason: 'stop',
      })
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      baseMessages: [{ role: 'user', content: 'Prüfe das Projekt' }],
      maxRounds: 2,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(result.interrupted).toBeUndefined()
    expect(mocks.execute).toHaveBeenCalledOnce()
    const retry = mocks.streamChatWithTools.mock.calls[2]![0] as InferenceRequest
    expect(retry.messages.filter(message => message.role === 'tool')).toHaveLength(1)
  })

  it('allows one tool-format repair in each later round without replaying earlier effects', async () => {
    const plain = {
      content: '{"name":"project_get_state","arguments":{}}',
      toolCalls: [],
      rawToolCalls: [],
      finishReason: 'stop',
    }
    const next = {
      ...toolCallResult,
      content: '',
      finishReason: 'tool_calls',
      requestId: 'request-2',
      toolCalls: [{ id: 'call-2', name: 'project_get_state', arguments: {} }],
      rawToolCalls: [
        { id: 'call-2', type: 'function' as const, function: { name: 'project_get_state', arguments: '{}' } },
      ],
    }
    mocks.streamChatWithTools
      .mockResolvedValueOnce(plain)
      .mockResolvedValueOnce({ ...toolCallResult, content: '', finishReason: 'tool_calls' })
      .mockResolvedValueOnce(plain)
      .mockResolvedValueOnce(next)
      .mockResolvedValueOnce({
        content: 'Beide Prüfungen abgeschlossen.',
        toolCalls: [],
        rawToolCalls: [],
        finishReason: 'stop',
      })
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      maxRounds: 3,
      baseMessages: [{ role: 'user', content: 'Prüfe den Projektzustand zweimal mit Tools.' }],
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(result.interrupted).toBeUndefined()
    expect(result.finalText).toBe('Beide Prüfungen abgeschlossen.')
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(5)
    expect(mocks.execute).toHaveBeenCalledTimes(2)
    const lastRequest = mocks.streamChatWithTools.mock.calls[4]![0] as InferenceRequest
    const maps = lastRequest.messages.filter(
      message => message.role === 'system' && message.content.startsWith('[Luczor Tool map]')
    )
    expect(maps).toHaveLength(1)
    expect(maps[0]?.content).toContain('project_get_state')
    expect(maps[0]?.content).toContain('2 (2/0)')
    expect(mocks.streamChatWithTools.mock.calls[1]![0].toolChoice).toBe('required')
    expect(mocks.streamChatWithTools.mock.calls[3]![0].toolChoice).toBe('required')
    const corrected = mocks.streamChatWithTools.mock.calls[3]![0] as InferenceRequest
    expect(
      corrected.messages.filter(
        message =>
          message.role === 'system' &&
          message.content?.startsWith('Die vorige Antwort beschrieb einen Werkzeugaufruf nur als Text;')
      )
    ).toHaveLength(1)
    expect(
      mocks.streamChatWithTools.mock.calls[3]![0].messages.filter(
        (message: { role: string }) => message.role === 'tool'
      )
    ).toHaveLength(1)
  })

  it.each(['status', 'xml'] as const)('does not start a %s correction after cancellation during reset', async kind => {
    const controller = new AbortController()
    mocks.streamChatWithTools.mockResolvedValueOnce({
      content:
        kind === 'status'
          ? 'Die nächste Modellrunde wurde unterbrochen: HTTP 200'
          : '<function-call><name>project_get_state</name></function-call>',
      toolCalls: [],
      rawToolCalls: [],
      finishReason: 'stop',
    })
    await expect(
      runAgent({
        projectId: 'project-2',
        mode: 'observe',
        baseMessages: [{ role: 'user', content: '???' }],
        maxRounds: 1,
        signal: controller.signal,
        onResponseReset: () => controller.abort(),
        inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
      })
    ).rejects.toThrow()
    expect(mocks.streamChatWithTools).toHaveBeenCalledOnce()
  })

  it('preserves an explicitly requested literal status quotation', async () => {
    const content = 'Die nächste Modellrunde wurde unterbrochen: HTTP 200'
    mocks.streamChatWithTools.mockResolvedValueOnce({ content, toolCalls: [], rawToolCalls: [], finishReason: 'stop' })
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      baseMessages: [{ role: 'user', content: `Zitiere wörtlich: ${content}` }],
      maxRounds: 1,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(result.finalText).toBe(content)
    expect(mocks.streamChatWithTools).toHaveBeenCalledOnce()
  })

  it('does not change or replay an externally approved response', async () => {
    const content = 'Die nächste Modellrunde wurde unterbrochen: HTTP 200'
    mocks.streamChatWithTools.mockResolvedValueOnce({ content, toolCalls: [], rawToolCalls: [], finishReason: 'stop' })
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      baseMessages: [{ role: 'user', content: 'ok los' }],
      maxRounds: 1,
      inferenceGateway: { id: 'external', target: 'laravel_proxy', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(result.finalText).toBe(content)
    expect(mocks.streamChatWithTools).toHaveBeenCalledOnce()
  })
  it('repairs textual local tool output once, then executes only the structured response', async () => {
    const pseudo = {
      content: '```json\n<tools>{"name":"project_get_state","arguments":{}}</tools>\n```',
      finishReason: 'stop',
      toolCalls: [],
      rawToolCalls: [],
    }
    mocks.streamChatWithTools
      .mockResolvedValueOnce(pseudo)
      .mockResolvedValueOnce(toolCallResult)
      .mockResolvedValueOnce({ content: 'Geprüft.', finishReason: 'stop', toolCalls: [], rawToolCalls: [] })
    const onToken = vi.fn()
    await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      baseMessages: [{ role: 'user', content: 'tools testen bitte' }],
      maxRounds: 2,
      onToken,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(mocks.streamChatWithTools.mock.calls[1]![0].toolChoice).toBe('required')
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(onToken.mock.calls.flat().join('')).not.toContain('<tools>')
  })

  it('bounds repeated pseudo calls and preserves the task without executing text', async () => {
    mocks.streamChatWithTools.mockResolvedValue({
      content: '{"name":"project_get_state","arguments":{}}',
      finishReason: 'stop',
      toolCalls: [],
      rawToolCalls: [],
    })
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      baseMessages: [{ role: 'user', content: 'Prüfe den Zustand' }],
      maxRounds: 1,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(2)
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(result.interrupted?.code).toBe('runtime_text_tool_output')
  })

  it('does not force a call for an explanation of a tool example', async () => {
    mocks.streamChatWithTools.mockResolvedValue({
      content: '{"name":"project_get_state","arguments":{}}',
      finishReason: 'stop',
      toolCalls: [],
      rawToolCalls: [],
    })
    await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      baseMessages: [{ role: 'user', content: 'Erkläre das Beispiel für project_get_state' }],
      maxRounds: 2,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(mocks.streamChatWithTools).toHaveBeenCalledOnce()
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('loads a requested local tool for the next round without executing it during selection', async () => {
    mocks.toOpenAITools.mockReturnValue(
      ['project_get_state', 'fs_read', ...Array.from({ length: 10 }, (_, index) => `extra_${index}`)].map(name => ({
        type: 'function',
        function: { name, description: name, parameters: { type: 'object' } },
      }))
    )
    mocks.streamChatWithTools
      .mockResolvedValueOnce({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'select-1', name: 'tools_select', arguments: { names: ['fs_read'] } }],
        rawToolCalls: [
          { id: 'select-1', type: 'function', function: { name: 'tools_select', arguments: '{"names":["fs_read"]}' } },
        ],
      })
      .mockResolvedValueOnce({ content: 'Auswahl bereit.', finishReason: 'stop', toolCalls: [], rawToolCalls: [] })
    await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'hi' }],
      mode: 'observe',
      maxRounds: 2,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(
      mocks.streamChatWithTools.mock.calls[0]![0].tools.map(
        (tool: { function: { name: string } }) => tool.function.name
      )
    ).not.toContain('fs_read')
    expect(
      mocks.streamChatWithTools.mock.calls[1]![0].tools.map(
        (tool: { function: { name: string } }) => tool.function.name
      )
    ).toContain('fs_read')
  })
  it('bounds browser host guessing, preserves matching tool replies and continues unrelated work', async () => {
    mocks.toOpenAITools.mockReturnValue(
      ['browser_open', 'browser_close', 'browser_status', 'project_get_state'].map(name => ({
        type: 'function',
        function: { name, parameters: { type: 'object' } },
      }))
    )
    const browserExecute = vi.fn(async () => {
      throw new Error('browser_session_hosts_changed')
    })
    mocks.getTool.mockImplementation(name => ({
      name,
      category: 'app',
      mutating: false,
      requiresApproval: false,
      parameters: { type: 'object', properties: { allowed_hosts: { type: 'array', items: { type: 'string' } } } },
      execute: name === 'browser_open' ? browserExecute : mocks.execute,
    }))
    for (let index = 0; index < 5; index++) {
      const args = { allowed_hosts: [`guess-${index}.test`] }
      mocks.streamChatWithTools.mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: `guess-${index}`, name: 'browser_open', arguments: args }],
        rawToolCalls: [
          {
            id: `guess-${index}`,
            type: 'function',
            function: { name: 'browser_open', arguments: JSON.stringify(args) },
          },
        ],
      })
    }
    mocks.streamChatWithTools.mockResolvedValueOnce(toolCallResult).mockResolvedValueOnce({
      content: 'Browser benötigt eine Korrektur; Projektzustand ist geprüft.',
      toolCalls: [],
      rawToolCalls: [],
    })
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'act',
      baseMessages: [{ role: 'user', content: 'Browser und Projekt prüfen.' }],
      maxRounds: 8,
    })
    expect(browserExecute).toHaveBeenCalledTimes(3)
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(result.toolFailures).toBe(5)
    const lastRequest = mocks.streamChatWithTools.mock.calls.at(-1)![0]
    expect(lastRequest.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'browser_close',
      'browser_status',
      'project_get_state',
    ])
    const replies = lastRequest.messages.filter((message: { role: string }) => message.role === 'tool')
    expect(replies).toHaveLength(6)
    expect(new Set(replies.map((message: { tool_call_id: string }) => message.tool_call_id)).size).toBe(6)
    expect(replies[3].content).toContain('tool_recovery_required')
  })

  it('stops before tools and receipts when current remote authority is unavailable', async () => {
    const beforeToolExecution = vi.fn(async () => {
      throw new Error('lease expired')
    })
    const receipt = vi.fn()
    mocks.streamChatWithTools.mockResolvedValueOnce(toolCallResult)
    await expect(
      runAgent({
        projectId: 'project-2',
        mode: 'act',
        baseMessages: [{ role: 'user', content: 'Prüfe den Zustand.' }],
        beforeToolExecution,
        effectJournal: { before: receipt },
      })
    ).rejects.toThrow('Auftragsfreigabe')
    expect(beforeToolExecution).toHaveBeenCalledOnce()
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(receipt).not.toHaveBeenCalled()
    expect(mocks.streamChatWithTools).toHaveBeenCalledOnce()
  })
  it('offers only workcopy-capable tools and rejects unsupported tools even if the model requests them', async () => {
    const workflowScope = {
      principalId: 'person',
      projectId: 'project-2',
      runId: '11111111-1111-4111-8111-111111111111',
      expectedRootPath: 'E:/frozen-workcopy',
      expectedWorkspaceUpdatedAt: 42,
    }
    mocks.toOpenAITools.mockReturnValue([
      { type: 'function', function: { name: 'fs_read', parameters: {} } },
      { type: 'function', function: { name: 'project_get_state', parameters: {} } },
    ])
    mocks.streamChatWithTools.mockResolvedValueOnce(toolCallResult)
    const result = await runAgent({
      projectId: 'project-2',
      principalScopeId: 'person',
      mode: 'observe',
      workflowScope,
      baseMessages: [{ role: 'user', content: 'Prüfe den Zustand.' }],
      maxRounds: 1,
    })
    expect(
      mocks.streamChatWithTools.mock.calls[0]![0].tools.map(
        (tool: { function: { name: string } }) => tool.function.name
      )
    ).toEqual(['fs_read'])
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(result.toolFailures).toBe(1)
  })
  it('journals a scoped mutation before executing and keeps its result attached to the original chat', async () => {
    const order: string[] = []
    const finish = vi.fn(async () => {
      order.push('completed')
    })
    const before = vi.fn(async () => {
      order.push('started')
      return { finish }
    })
    mocks.getTool.mockReturnValue({
      name: 'project_get_state',
      category: 'project',
      mutating: true,
      requiresApproval: false,
      parameters: { type: 'object' },
      execute: mocks.execute,
    })
    mocks.execute.mockImplementation(async () => {
      order.push('effect')
      return { ok: true }
    })
    mocks.streamChatWithTools
      .mockResolvedValueOnce(toolCallResult)
      .mockResolvedValueOnce({ content: 'Erledigt.', toolCalls: [], rawToolCalls: [] })
    await runAgent({
      projectId: 'project-2',
      conversationId: 'original-chat',
      runId: 'original-run',
      effectJournal: { before },
      mode: 'act',
      baseMessages: [{ role: 'user', content: 'Speichern' }],
    })
    expect(order).toEqual(['started', 'effect', 'completed'])
    expect(finish).toHaveBeenCalledWith(true)
    expect(mocks.queueToolCall).toHaveBeenCalledWith(
      'project-2',
      expect.objectContaining({ conversationId: 'original-chat', runId: 'original-run' })
    )
    expect(mocks.addHiddenToolMessage).toHaveBeenCalledWith(
      'project-2',
      expect.anything(),
      expect.objectContaining({ conversationId: 'original-chat', runId: 'original-run' })
    )
    const queued = mocks.queueToolCall.mock.calls[0]![1]
    expect(queued.id).not.toBe('call-1')
    const continuation = mocks.streamChatWithTools.mock.calls[1]![0].messages
    expect(continuation.find((message: { role: string }) => message.role === 'tool')?.tool_call_id).toBe(queued.id)
    expect(
      continuation.find((message: { tool_calls?: unknown[] }) => message.tool_calls?.length)?.tool_calls[0]?.id
    ).toBe(queued.id)
    expect(toolCallResult.toolCalls[0]!.id).toBe('call-1')
  })
  it('keeps provider tool IDs distinct between different background runs', async () => {
    for (const runId of ['first-run', 'second-run']) {
      mocks.streamChatWithTools
        .mockResolvedValueOnce(toolCallResult)
        .mockResolvedValueOnce({ content: 'Gelesen.', toolCalls: [], rawToolCalls: [] })
      await runAgent({
        projectId: 'project-2',
        conversationId: runId,
        runId,
        mode: 'observe',
        baseMessages: [{ role: 'user', content: 'Lies den Zustand.' }],
      })
    }
    const ids = mocks.queueToolCall.mock.calls.map(call => call[1].id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })
  it('propagates a child cancellation into its inherited execution permit without revoking the parent', async () => {
    const parent = executionGate.capture(undefined, { projectId: 'project-2', runId: crypto.randomUUID() })
    const child = new AbortController()
    mocks.streamChatWithTools.mockResolvedValueOnce(toolCallResult)
    mocks.execute.mockImplementation(async (_args, context) => {
      expect(context.execution.scope).toEqual(parent.scope)
      expect(context.execution.signal.aborted).toBe(false)
      child.abort(new DOMException('Child stopped', 'AbortError'))
      expect(context.signal.aborted).toBe(true)
      expect(context.execution.signal.aborted).toBe(true)
      expect(parent.signal.aborted).toBe(false)
      context.signal.throwIfAborted()
    })
    await expect(
      runAgent({
        projectId: 'project-2',
        execution: parent,
        signal: child.signal,
        mode: 'observe',
        baseMessages: [{ role: 'user', content: 'Lies den Zustand.' }],
      })
    ).rejects.toBeDefined()
    executionGate.assert(parent)
  })
  it('fails before any mutation if the durable effect receipt is unavailable', async () => {
    mocks.getTool.mockReturnValue({
      name: 'project_get_state',
      category: 'project',
      mutating: true,
      requiresApproval: false,
      parameters: { type: 'object' },
      execute: mocks.execute,
    })
    mocks.streamChatWithTools.mockResolvedValueOnce(toolCallResult)
    await expect(
      runAgent({
        projectId: 'project-2',
        mode: 'act',
        effectJournal: {
          before: async () => {
            throw new ChatEffectJournalError()
          },
        },
        baseMessages: [{ role: 'user', content: 'Speichern' }],
      })
    ).rejects.toThrow('Laufjournal')
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.streamChatWithTools).toHaveBeenCalledOnce()
  })
  it.each(['balanced', 'ultra'] as const)(
    'preserves successful tools when %s transport aborts without a stop signal',
    async thinkingTier => {
      mocks.streamChatWithTools
        .mockResolvedValueOnce(toolCallResult)
        .mockRejectedValueOnce(new DOMException('PRIVATE transport detail', 'AbortError'))
      const signal = new AbortController().signal
      const result = await runAgent({
        projectId: 'project-2',
        mode: 'act',
        thinkingTier,
        signal,
        baseMessages: [{ role: 'user', content: 'Lies den Projektzustand und analysiere ihn.' }],
        maxRounds: 3,
        inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
      })
      expect(signal.aborted).toBe(false)
      expect(result.interrupted).toMatchObject({ code: 'runtime_transport_interrupted', round: 2 })
      expect(result.toolSuccesses).toBe(1)
      expect(result.continuation).toBeDefined()
      expect(result.finalText).toContain('Modellverbindung')
      expect(result.finalText).not.toContain('PRIVATE')
      expect(mocks.execute).toHaveBeenCalledOnce()
      expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(2)
    }
  )

  it('reports a first-round unsolicited abort as a transport failure', async () => {
    mocks.streamChatWithTools.mockRejectedValueOnce(new DOMException('opaque network interruption', 'AbortError'))
    await expect(
      runAgent({
        projectId: 'project-2',
        mode: 'observe',
        thinkingTier: 'ultra',
        toolAccess: 'none',
        baseMessages: [{ role: 'user', content: 'Hallo' }],
        inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
      })
    ).rejects.toMatchObject({ name: 'LocalInferenceError', code: 'runtime_transport_interrupted' })
    expect(mocks.streamChatWithTools).toHaveBeenCalledOnce()
  })

  it('publishes counted native failure input to the chat footer even when the first request throws', async () => {
    const onUsage = vi.fn()
    mocks.streamChatWithTools.mockRejectedValueOnce(
      new LocalInferenceError('Der Anfrageparameter wurde abgewiesen.', 'runtime_request_rejected', false, false, {
        schemaVersion: 1,
        stage: 'generation',
        httpStatus: 400,
        code: 'runtime_request_rejected',
        reason: 'parameter_value',
        parameter: 'max_tokens',
        inputTokens: 19263,
        contextTokens: 32768,
        outputTokens: 4096,
      })
    )
    await expect(
      runAgent({
        projectId: 'project-2',
        mode: 'observe',
        toolAccess: 'none',
        baseMessages: [{ role: 'user', content: 'Prüfe den Projektzustand.' }],
        onUsage,
        inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
      })
    ).rejects.toMatchObject({ code: 'runtime_request_rejected' })
    expect(onUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inputTokens: 19263,
        outputTokens: 0,
        totalTokens: 19263,
        contextTokens: 32768,
        source: 'mixed',
        rounds: 1,
      })
    )
  })

  it('corrects only the failed local round and retains completed tool round token usage', async () => {
    const onUsage = vi.fn()
    const objective =
      'Lies und prüfe das Projekt. ' + 'Kontext '.repeat(900) + '/projekte/luczor\nDiese Datei niemals löschen.'
    mocks.streamChatWithTools
      .mockResolvedValueOnce({
        ...toolCallResult,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      })
      .mockRejectedValueOnce(
        new LocalInferenceError(
          'Der aktuelle Auftrag überschreitet das Kontextfenster.',
          'runtime_context_exceeded',
          false,
          false,
          {
            schemaVersion: 1,
            stage: 'tokenization',
            httpStatus: 400,
            code: 'runtime_context_exceeded',
            reason: 'context_limit',
            inputTokens: 19263,
            contextTokens: 32768,
            outputTokens: 16000,
          }
        )
      )
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      baseMessages: [{ role: 'user', content: objective }],
      maxRounds: 3,
      onUsage,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(result.interrupted?.code).toBe('runtime_context_exceeded')
    expect(result.continuation?.messages).toContainEqual({ role: 'user', content: objective })
    expect(result.finalText).toContain('Der vollständige Arbeitskontext bleibt lokal erhalten.')
    expect(result.tokenUsage).toMatchObject({
      inputTokens: 19363,
      outputTokens: 20,
      totalTokens: 19383,
      source: 'mixed',
      rounds: 2,
    })
    expect(onUsage).toHaveBeenLastCalledWith(result.tokenUsage)
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(2)
  })

  it('does not parse native counts from an error message without a verified diagnostic', async () => {
    const onUsage = vi.fn()
    mocks.streamChatWithTools.mockRejectedValueOnce(
      new LocalInferenceError('Input 19263, output limit 16000', 'runtime_context_exceeded', false, false)
    )
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      toolAccess: 'none',
      baseMessages: [{ role: 'user', content: 'Hallo' }],
      onUsage,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(result.tokenUsage.source).toBe('estimated')
    expect(result.tokenUsage.inputTokens).not.toBe(19263)
    expect(result.tokenUsage.outputTokens).toBe(0)
    expect(onUsage).toHaveBeenLastCalledWith(result.tokenUsage)
  })

  it.each(['', 'Der erste geprüfte Befund liegt vor.'])(
    'retains a first-round control interruption and its public partial text: %s',
    async partial => {
      mocks.streamChatWithTools.mockImplementationOnce(async (request: InferenceRequest) => {
        if (partial) request.onToken?.(partial)
        throw new LocalInferenceError(
          'Die Denksteuerung wurde nicht bestätigt.',
          'runtime_reasoning_control_unavailable',
          false,
          !!partial
        )
      })
      const checkpoint = vi.fn(async () => {})
      const result = await runAgent({
        projectId: 'project-2',
        baseMessages: [{ role: 'user', content: 'Erstelle einen Prüfplan.' }],
        mode: 'observe',
        toolAccess: 'none',
        maxRounds: 1,
        onCheckpoint: checkpoint,
        inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
      })
      expect(result.interrupted).toMatchObject({ code: 'runtime_reasoning_control_unavailable', round: 1 })
      expect(result.continuation).toBeDefined()
      expect(checkpoint).toHaveBeenCalled()
      expect(mocks.streamChatWithTools).toHaveBeenCalledOnce()
      expect(result.finalText).toContain(partial || 'Die Denksteuerung wurde nicht bestätigt.')
      expect(
        result.continuation!.messages.filter(message => message.role === 'assistant').map(message => message.content)
      ).toEqual(partial ? [partial] : [])
    }
  )
  it('stops a repeated answer without deleting it or restarting and rejects late callbacks', async () => {
    const partial = 'Geprüfter Zwischenstand. Fertig. Warte auf deine Anweisung.'
    let staleRequest!: InferenceRequest
    mocks.streamChatWithTools.mockImplementationOnce(async (request: InferenceRequest) => {
      staleRequest = request
      request.onToken?.(partial)
      throw new LocalInferenceError('Wiederholung automatisch gestoppt.', 'runtime_output_repeated', false, true)
    })
    const published = vi.fn()
    const reset = vi.fn()
    const progress = vi.fn()
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      baseMessages: [{ role: 'user', content: 'Prüfe das Projekt.' }],
      maxRounds: 1,
      onToken: published,
      onResponseReset: reset,
      onProgress: progress,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    staleRequest.onToken?.('Veraltete Ausgabe darf nicht zurückkehren.')
    expect(result.interrupted?.code).toBe('runtime_output_repeated')
    expect(result.continuation).toBeDefined()
    expect(result.finalText).toContain(partial)
    expect(result.finalText).toContain('kein automatischer Neuanlauf')
    expect(published.mock.calls.map(([content]) => content)).toEqual([partial])
    expect(reset).not.toHaveBeenCalled()
    expect(progress.mock.calls.some(([event]) => event.phase === 'regenerating')).toBe(false)
    expect(mocks.streamChatWithTools).toHaveBeenCalledOnce()
    expect(result.tokenUsage.rounds).toBe(1)
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it.each(['Fertig. '.repeat(40), ''])(
    'keeps a loop stop silent without retries, even with no public output: %j',
    async partial => {
      mocks.streamChatWithTools.mockImplementation(async (request: InferenceRequest) => {
        request.onToken?.(partial)
        throw new LocalInferenceError('Wiederholung automatisch gestoppt.', 'runtime_output_repeated', false, true)
      })
      const published = vi.fn()
      const completed = vi.fn()
      const reset = vi.fn()
      const result = await runAgent({
        projectId: 'project-2',
        mode: 'observe',
        maxRounds: 1,
        baseMessages: [{ role: 'user', content: 'Prüfe das Projekt.' }],
        onToken: published,
        onRoundComplete: completed,
        onResponseReset: reset,
        inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
      })
      expect(mocks.streamChatWithTools).toHaveBeenCalledOnce()
      expect(reset).not.toHaveBeenCalled()
      expect(published.mock.calls.map(([content]) => content)).toEqual(partial ? [partial] : [])
      expect(completed).not.toHaveBeenCalled()
      expect(result.interrupted?.code).toBe('runtime_output_repeated')
      expect(result.finalText).toContain(partial.trim())
      expect(result.finalText).not.toMatch(/zwei automatischen|entfernt|verworfen/)
      expect(
        result.continuation!.messages.filter(message => message.role === 'assistant').map(message => message.content)
      ).not.toContain(partial)
      expect(result.tokenUsage.rounds).toBe(1)
      expect(mocks.execute).not.toHaveBeenCalled()
    }
  )

  it('preserves a completed tool round after a loop and continues only on an explicit new call', async () => {
    const contexts: string[] = []
    mocks.streamChatWithTools.mockResolvedValueOnce({ ...toolCallResult, content: 'Ich prüfe den Projektzustand.' })
    mocks.streamChatWithTools.mockImplementationOnce(async (request: InferenceRequest) => {
      contexts.push(JSON.stringify(request.messages.filter(message => message.role === 'tool')))
      request.onToken?.('Bisherige Teilantwort.')
      throw new LocalInferenceError('Wiederholung.', 'runtime_output_repeated', false, true)
    })
    mocks.streamChatWithTools.mockImplementationOnce(async (request: InferenceRequest) => {
      contexts.push(JSON.stringify(request.messages.filter(message => message.role === 'tool')))
      return { content: 'Die Prüfung ist abgeschlossen.', toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
    })
    const completed = vi.fn()
    const result = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      maxRounds: 2,
      baseMessages: [{ role: 'user', content: 'Prüfe das Projekt.' }],
      onRoundComplete: completed,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(result.finalText).toContain('Bisherige Teilantwort.')
    expect(result.interrupted?.code).toBe('runtime_output_repeated')
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(2)
    const resumed = await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      maxRounds: 1,
      baseMessages: [{ role: 'user', content: 'Bitte fortsetzen.' }],
      continuation: result.continuation,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(resumed.finalText).toBe('Die Prüfung ist abgeschlossen.')
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(3)
    expect(new Set(contexts).size).toBe(1)
    expect(contexts[0]).toContain('call-1')
    expect(completed.mock.calls.filter(([event]) => event.kind === 'commentary')).toHaveLength(1)
  })

  it.each(['abort', 'scope'] as const)('does not restart after %s during repeated output', async stop => {
    const controller = new AbortController()
    mocks.streamChatWithTools.mockImplementationOnce(async (request: InferenceRequest) => {
      request.onToken?.('Teilantwort.')
      throw new LocalInferenceError('Wiederholung.', 'runtime_output_repeated', false, true)
    })
    const task = runAgent({
      projectId: 'project-2',
      mode: 'observe',
      maxRounds: 1,
      signal: controller.signal,
      baseMessages: [{ role: 'user', content: 'Prüfe das Projekt.' }],
      onToken: () => {
        if (stop === 'abort') controller.abort()
        else executionGate.invalidate('execution_session_changed')
      },
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    await expect(task).rejects.toThrow()
    expect(mocks.streamChatWithTools).toHaveBeenCalledOnce()
  })

  it('does not retry or alter an external request for a local repetition error code', async () => {
    mocks.streamChatWithTools.mockRejectedValueOnce(
      new LocalInferenceError('Wiederholung.', 'runtime_output_repeated', false, false)
    )
    const reset = vi.fn()
    await runAgent({
      projectId: 'project-2',
      mode: 'observe',
      maxRounds: 1,
      baseMessages: [{ role: 'user', content: 'Prüfe das Projekt.' }],
      onResponseReset: reset,
      inferenceGateway: { id: 'external', target: 'laravel_proxy', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(mocks.streamChatWithTools).toHaveBeenCalledOnce()
    expect(reset).not.toHaveBeenCalled()
  })

  it.each(['off', 'auto', undefined] as const)(
    'forwards local reasoning mode %s only to local inference',
    async localReasoningMode => {
      mocks.streamChatWithTools.mockResolvedValue({
        content: 'Drei beleggebundene Schritte.',
        toolCalls: [],
        rawToolCalls: [],
        finishReason: 'stop',
      })
      await runAgent({
        projectId: 'project-2',
        baseMessages: [{ role: 'user', content: 'Plane kurz drei Schritte.' }],
        mode: 'observe',
        maxRounds: 1,
        toolAccess: 'none',
        localReasoningMode,
        inferenceGateway: {
          id: 'local-planner',
          target: 'local_llama_cpp',
          streamChatWithTools: mocks.streamChatWithTools,
        },
      })
      const sent = mocks.streamChatWithTools.mock.calls[0]?.[0] as InferenceRequest
      expect(sent.reasoningMode).toBe(localReasoningMode)
      expect('reasoningMode' in sent).toBe(localReasoningMode !== undefined)
    }
  )

  it('keeps external approval bytes and hashes independent of local reasoning metadata', async () => {
    const request: InferenceRequest = {
      messages: [{ role: 'user', content: 'Approved external question' }],
      projectId: 'project-2',
      taskType: 'agent.plan',
      tools: [],
      toolChoice: 'none',
    }
    const base = serializeLaravelProxyBody(buildLaravelProxyBody(request, 'client-1', true))
    const modes = ['auto', 'off'] as const
    for (const reasoningMode of modes) {
      const withLocalMode = { ...request, reasoningMode }
      expect(serializeLaravelProxyBody(buildLaravelProxyBody(withLocalMode, 'client-1', true))).toBe(base)
      expect(await hashLaravelProxyBody(withLocalMode, 'client-1')).toBe(
        await hashLaravelProxyBody(request, 'client-1')
      )
    }
  })

  it('runs an explicitly requested workflow team before an ordinary chat round', async () => {
    const gateway = { id: 'local', target: 'local_llama_cpp' as const, streamChatWithTools: mocks.streamChatWithTools }
    mocks.runChatAgentTeam.mockResolvedValue({ finalText: 'Team fertig' })
    const response = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Bearbeite das Projekt' }],
      mode: 'act',
      agentMode: true,
      forceAgentTeam: true,
      inferenceGateway: gateway,
      maxRounds: 2,
    })
    expect(mocks.runChatAgentTeam).toHaveBeenCalledOnce()
    expect(mocks.streamChatWithTools).not.toHaveBeenCalled()
    expect(response.finalText).toBe('Team fertig')
  })

  it('answers a simple adaptive chat directly and exposes targeted assistance without a forced team', async () => {
    mocks.streamChatWithTools.mockResolvedValue({
      content: 'Hallo!',
      toolCalls: [],
      rawToolCalls: [],
      finishReason: 'stop',
    })
    const response = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Hallo' }],
      mode: 'act',
      agentMode: true,
      maxRounds: 2,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(mocks.runChatAgentTeam).not.toHaveBeenCalled()
    expect(mocks.streamChatWithTools).toHaveBeenCalledOnce()
    const sent = mocks.streamChatWithTools.mock.calls[0]![0] as InferenceRequest
    expect(sent.tools).toEqual(
      expect.arrayContaining(
        ['agent_assist', 'agent_assist_status', 'agent_assist_stop'].map(name =>
          expect.objectContaining({ function: expect.objectContaining({ name }) })
        )
      )
    )
    expect(response.finalText).toBe('Hallo!')
  })

  it.each([2, 4])(
    'keeps working during own-device delegation and protects collected output with %i rounds',
    async maxRounds => {
      let finish!: (value: unknown) => void
      mocks.resolveDeviceAssistance.mockImplementation(task => ({ ...task, target: 'device', device_id: 'laptop' }))
      mocks.executeDeviceAssistance.mockImplementation(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      )
      const call = {
        id: 'device-assist',
        name: 'agent_assist',
        arguments: { task: 'Check the supplied design', role: 'review', target: 'auto' },
      }
      mocks.streamChatWithTools
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [call],
          rawToolCalls: [
            { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } },
          ],
          finishReason: 'tool_calls',
        })
        .mockImplementationOnce(async () => {
          expect(mocks.executeDeviceAssistance).toHaveBeenCalledOnce()
          finish({ status: 'completed', output: 'PRIVATE DEVICE EVIDENCE' })
          return { content: 'Local independent work done', toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
        })
        .mockImplementationOnce(async (request: InferenceRequest) => {
          expect(JSON.stringify(request.messages)).toContain('PRIVATE DEVICE EVIDENCE')
          return { content: 'Combined device result', toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
        })
      const response = await runAgent({
        projectId: 'project-2',
        baseMessages: [{ role: 'user', content: 'Analyze design and verify independently' }],
        externalBaseMessages: [{ role: 'user', content: 'Approved design context' }],
        mode: 'act',
        agentMode: true,
        maxRounds,
        inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
      })
      expect(response.finalText).toBe('Combined device result')
      expect(response.ephemeralDataUsed).toBe(true)
      expect(mocks.prepareExternalSpecialists).not.toHaveBeenCalled()
    }
  )

  it('keeps explicitly local-only context on this device even if a peer was selected', async () => {
    mocks.resolveDeviceAssistance.mockImplementation(task => ({ ...task, target: 'device', device_id: 'laptop' }))
    const call = {
      id: 'private-device-assist',
      name: 'agent_assist',
      arguments: { task: 'Check design', role: 'review', target: 'device', device_id: 'laptop' },
    }
    mocks.streamChatWithTools
      .mockResolvedValue({ content: 'Done locally', toolCalls: [], rawToolCalls: [], finishReason: 'stop' })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [call],
        rawToolCalls: [
          { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } },
        ],
        finishReason: 'tool_calls',
      })
    await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Check design' }],
      externalBaseMessages: [{ role: 'user', content: 'Must remain here' }],
      contextEgress: 'local_only',
      mode: 'act',
      agentMode: true,
      maxRounds: 2,
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(mocks.executeDeviceAssistance).not.toHaveBeenCalled()
  })

  it('continues local inference while an external subtask runs and reserves a tools-free synthesis round', async () => {
    const previous = modelUsageSettings.value
    modelUsageSettings.value = { ...previous, externalEnabled: true }
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => {
      finish = resolve
    })
    const execute = vi.fn(() => pending)
    mocks.prepareExternalSpecialists.mockResolvedValue({ roles: ['research'], execute })
    const call = {
      id: 'assist1',
      name: 'agent_assist',
      arguments: { task: 'PRIVATE LOCAL LABEL', role: 'research', target: 'external' },
    }
    mocks.streamChatWithTools
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [call],
        rawToolCalls: [
          { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } },
        ],
        finishReason: 'tool_calls',
      })
      .mockImplementationOnce(async () => {
        finish({
          role: 'research',
          output: 'Checked result',
          tokenUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, rounds: 1, source: 'reported' },
        })
        return { content: 'Provisional response', toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
      })
      .mockImplementationOnce(async (request: InferenceRequest) => {
        expect(request.toolChoice).toBe('none')
        expect(request.tools).toEqual([])
        expect(JSON.stringify(request.messages)).toContain('Checked result')
        return { content: 'Combined final answer', toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
      })
    try {
      const response = await runAgent({
        projectId: 'project-2',
        baseMessages: [
          { role: 'system', content: 'PRIVATE LOCAL CONTEXT' },
          { role: 'user', content: 'Inspect options' },
        ],
        externalBaseMessages: [{ role: 'user', content: 'PUBLIC CONTEXT' }],
        contextEgress: 'external_allowed',
        agentTeamPreset: 'free',
        mode: 'act',
        agentMode: true,
        maxRounds: 2,
        inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
      })
      expect(mocks.prepareExternalSpecialists).toHaveBeenCalledOnce()
      expect(response.finalText).toBe('Combined final answer')
      expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(3)
      expect(mocks.runChatAgentTeam).not.toHaveBeenCalled()
      expect(JSON.stringify(mocks.prepareExternalSpecialists.mock.calls)).not.toContain('PRIVATE')
      expect(response.specialistOutcomes).toHaveLength(1)
      expect(response.tokenUsage.totalTokens).toBeGreaterThanOrEqual(5)
    } finally {
      modelUsageSettings.value = previous
    }
  })

  it('retains a resumable checkpoint at the limit without starting a team', async () => {
    mocks.streamChatWithTools.mockResolvedValue(toolCallResult)
    const first = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Lies das Projekt' }],
      mode: 'observe',
      maxRounds: 1,
    })
    expect(first.continuation?.messages.some(message => message.role === 'tool')).toBe(true)
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1)
    mocks.streamChatWithTools.mockResolvedValueOnce({ content: 'Fertig', toolCalls: [], rawToolCalls: [] })
    const next = await runAgent({
      projectId: 'project-2',
      baseMessages: [],
      mode: 'observe',
      continuation: first.continuation,
      maxRounds: 1,
    })
    expect(next.finalText).toBe('Fertig')
    expect(next.continuation).toBeUndefined()
    await expect(
      runAgent({
        projectId: 'other',
        baseMessages: [],
        mode: 'observe',
        continuation: first.continuation,
        maxRounds: 1,
      })
    ).rejects.toThrow('Projekt- und Kontositzung')
  })

  it('does not execute a successful mutation twice when continuing', async () => {
    mocks.getTool.mockReturnValue({
      name: 'project_get_state',
      category: 'project',
      mutating: true,
      requiresApproval: false,
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.streamChatWithTools.mockResolvedValue(toolCallResult)
    const first = await runAgent({
      ...durableTaskCreate,
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Speichere das Projekt' }],
      mode: 'act',
      maxRounds: 1,
    })
    expect(first.continuation?.completedMutations).toHaveLength(1)
    await runAgent({
      projectId: 'project-2',
      baseMessages: [],
      mode: 'act',
      continuation: first.continuation,
      maxRounds: 1,
    })
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })

  it('requires task-list verification before retrying an uncertain task create across continuation', async () => {
    const externalId = 'b8f4f761-f868-49f2-91de-7e6813f46855'
    const taskCreateExecute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        code: 'task_create_outcome_unknown',
        error: 'Der Ausgang von task_create ist unklar.',
        retry: 'verify_before_retry',
        next_tool: 'task_list',
        next_arguments: { project_id: 'project-2', external_id: externalId },
        match_title: 'Graph vervollständigen',
        match_task_id: externalId,
      })
      .mockResolvedValue({ ok: true, task_id: 'new-task' })
    const taskListExecute = vi.fn().mockResolvedValue({
      ok: true,
      tasks: [
        {
          title: 'Graph vervollständigen',
          external_id: '11111111-1111-4111-8111-111111111111',
        },
        {
          title: 'Graph vervollständigen',
          external_id: externalId,
        },
      ],
    })
    const taskCreate = {
      name: 'task_create',
      category: 'app',
      mutating: true,
      requiresApproval: false,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          project_id: { type: 'string' },
        },
        required: ['title'],
      },
      execute: taskCreateExecute,
    }
    const taskList = {
      name: 'task_list',
      category: 'app',
      mutating: false,
      requiresApproval: false,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { project_id: { type: 'string' }, external_id: { type: 'string' } },
      },
      execute: taskListExecute,
    }
    const call = (id: string, name: string, args: Record<string, unknown>) => ({
      content: '',
      toolCalls: [{ id, name, arguments: args }],
      rawToolCalls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
    })
    mocks.getTool.mockImplementation(name => (name === 'task_create' ? taskCreate : taskList))
    mocks.toOpenAITools.mockReturnValue(
      [taskCreate, taskList].map(tool => ({
        type: 'function',
        function: { name: tool.name, parameters: tool.parameters },
      }))
    )
    mocks.streamChatWithTools
      .mockResolvedValueOnce(call('create-unknown', 'task_create', { title: 'Graph vervollständigen' }))
      .mockResolvedValueOnce({ content: 'Schreibausgang unklar.', toolCalls: [], rawToolCalls: [] })

    const first = await runAgent({
      ...durableTaskCreate,
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Lege die Aufgabe an.' }],
      mode: 'act',
      maxRounds: 2,
    })

    expect(first.continuation?.pendingTaskCreateVerifications).toEqual([
      {
        projectId: 'project-2',
        title: 'Graph vervollständigen',
        externalId,
        fingerprint: expect.any(String),
        fingerprintHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        state: 'unknown',
      },
    ])
    expect(first.finalText).toContain('Verifikationsstand bleibt zum Weiterarbeiten erhalten')
    mocks.streamChatWithTools
      .mockResolvedValueOnce(call('blind-retry', 'task_create', { title: 'Graph vervollständigen' }))
      .mockResolvedValueOnce(
        call('changed-blind-retry', 'task_create', {
          title: '  GRAPH  vervollsta\u0308ndigen ',
          description: 'Noch ungeprüfte Variante',
        })
      )
      .mockResolvedValueOnce(call('verify', 'task_list', { project_id: 'project-2', external_id: externalId }))
      .mockResolvedValueOnce(
        call('verified-retry', 'task_create', {
          title: 'Graph vervollständigen',
          project_id: 'project-2',
        })
      )
      .mockResolvedValueOnce(call('equivalent-retry', 'task_create', { title: 'Graph vervollsta\u0308ndigen' }))
      .mockResolvedValueOnce(
        call('different-task', 'task_create', {
          title: 'Graph vervollständigen',
          description: 'Eigenständige zweite Aufgabe',
        })
      )
      .mockResolvedValueOnce({ content: 'Aufgaben geprüft.', toolCalls: [], rawToolCalls: [] })

    const resumed = await runAgent({
      ...durableTaskCreate,
      projectId: 'project-2',
      baseMessages: [],
      mode: 'act',
      continuation: first.continuation,
      maxRounds: 7,
    })

    expect(resumed.finalText).toBe('Aufgaben geprüft.')
    expect(taskCreateExecute).toHaveBeenCalledTimes(2)
    expect(taskCreateExecute.mock.calls[1]![0]).toMatchObject({
      title: 'Graph vervollständigen',
      description: 'Eigenständige zweite Aufgabe',
    })
    expect(taskListExecute).toHaveBeenCalledWith(
      { project_id: 'project-2', external_id: externalId },
      expect.anything()
    )
    expect(resumed.toolFailures).toBe(2)
    expect(resumed.toolSuccesses).toBe(4)
  })

  it('retains an exact empty task lookup and retries the same operation id', async () => {
    const externalId = '29ee4734-99c0-4f4c-8f06-33df65bce0d5'
    const taskCreateExecute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        code: 'task_create_outcome_unknown',
        error: 'Der Ausgang von task_create ist unklar.',
        retry: 'verify_before_retry',
        next_tool: 'task_list',
        next_arguments: { project_id: 'project-2', external_id: externalId },
        match_title: 'Release prüfen',
        match_task_id: externalId,
      })
      .mockResolvedValueOnce({ ok: true, task_id: externalId })
    const taskListExecute = vi.fn().mockResolvedValue({
      ok: true,
      tasks: [],
      task_create_idempotency: 'external_id_v1',
      filtered_external_id: externalId,
    })
    const taskCreate = {
      name: 'task_create',
      category: 'app',
      mutating: true,
      requiresApproval: false,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string' }, description: { type: 'string' } },
        required: ['title'],
      },
      execute: taskCreateExecute,
    }
    const taskList = {
      name: 'task_list',
      category: 'app',
      mutating: false,
      requiresApproval: false,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { project_id: { type: 'string' }, external_id: { type: 'string' } },
      },
      execute: taskListExecute,
    }
    const call = (id: string, name: string, args: Record<string, unknown>) => ({
      content: '',
      toolCalls: [{ id, name, arguments: args }],
      rawToolCalls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
    })
    mocks.getTool.mockImplementation(name => (name === 'task_create' ? taskCreate : taskList))
    mocks.toOpenAITools.mockReturnValue(
      [taskCreate, taskList].map(tool => ({
        type: 'function',
        function: { name: tool.name, parameters: tool.parameters },
      }))
    )
    mocks.streamChatWithTools.mockResolvedValueOnce(
      call('create', 'task_create', { title: 'Release prüfen', description: 'Ursprüngliche Details' })
    )

    const uncertain = await runAgent({
      ...durableTaskCreate,
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Lege die Aufgabe an.' }],
      mode: 'act',
      maxRounds: 1,
    })

    mocks.streamChatWithTools
      .mockResolvedValueOnce(call('verify', 'task_list', { external_id: externalId }))
      .mockResolvedValueOnce({ content: 'Noch nicht gespeichert.', toolCalls: [], rawToolCalls: [] })
    const verifiedAbsent = await runAgent({
      ...durableTaskCreate,
      projectId: 'project-2',
      baseMessages: [],
      mode: 'act',
      continuation: uncertain.continuation,
      maxRounds: 2,
    })

    expect(verifiedAbsent.continuation?.pendingTaskCreateVerifications).toEqual([
      expect.objectContaining({ externalId, state: 'verified_absent' }),
    ])
    expect(verifiedAbsent.finalText).toContain('derselben external_id')

    mocks.streamChatWithTools
      .mockResolvedValueOnce(call('retry', 'task_create', { title: 'Release prüfen' }))
      .mockResolvedValueOnce({ content: 'Aufgabe gespeichert.', toolCalls: [], rawToolCalls: [] })
    const completed = await runAgent({
      ...durableTaskCreate,
      projectId: 'project-2',
      baseMessages: [],
      mode: 'act',
      continuation: verifiedAbsent.continuation,
      pendingTaskCreateVerifications: verifiedAbsent.continuation?.pendingTaskCreateVerifications?.map(item => ({
        ...item,
        fingerprint: undefined,
      })),
      maxRounds: 2,
    })

    expect(taskCreateExecute).toHaveBeenCalledTimes(2)
    expect(taskCreateExecute.mock.calls[1]![0]).toEqual({ title: 'Release prüfen', external_id: externalId })
    expect(completed.continuation).toBeUndefined()
    expect(completed.finalText).toBe('Aufgabe gespeichert.')
  })

  it('retains and verifies an uncertain chat create with the same operation id after a history reset', async () => {
    let externalId = ''
    const chatCreateExecute = vi
      .fn()
      .mockImplementationOnce(async (args: Record<string, unknown>) => {
        externalId = String(args.external_id)
        return {
          ok: false,
          code: 'conversation_create_outcome_unknown',
          error: 'Die POST-Antwort ging verloren.',
          retry: 'verify_before_retry',
          next_tool: 'chat_list',
          next_arguments: { project_id: 'project-2', external_id: externalId },
          match_title: 'Projektanalyse',
          match_conversation_id: externalId,
        }
      })
      .mockResolvedValueOnce({ ok: true, conversation_id: 'replayed-chat' })
    const chatListExecute = vi.fn(async () => ({
      ok: true,
      conversations: [],
      conversation_create_idempotency: 'external_id_v1',
      filtered_external_id: externalId,
    }))
    const chatCreate = {
      name: 'chat_create',
      category: 'app',
      mutating: true,
      requiresApproval: false,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string' }, project_id: { type: 'string' } },
      },
      execute: chatCreateExecute,
    }
    const chatList = {
      name: 'chat_list',
      category: 'app',
      mutating: false,
      requiresApproval: false,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { project_id: { type: 'string' }, external_id: { type: 'string' } },
      },
      execute: chatListExecute,
    }
    const call = (id: string, name: string, args: Record<string, unknown>) => ({
      content: '',
      toolCalls: [{ id, name, arguments: args }],
      rawToolCalls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
    })
    mocks.getTool.mockImplementation(name => (name === 'chat_create' ? chatCreate : chatList))
    mocks.toOpenAITools.mockReturnValue(
      [chatCreate, chatList].map(tool => ({
        type: 'function',
        function: { name: tool.name, parameters: tool.parameters },
      }))
    )
    mocks.streamChatWithTools
      .mockResolvedValueOnce(call('create-chat', 'chat_create', { title: 'Projektanalyse' }))
      .mockRejectedValueOnce(
        new LocalInferenceError('Ungültiger lokaler Tool-Verlauf.', 'runtime_tool_contract_rejected', false, false)
      )

    const interrupted = await runAgent({
      ...durableTaskCreate,
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Lege einen Projektchat an.' }],
      mode: 'act',
      maxRounds: 2,
    })

    expect(externalId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(interrupted.continuation?.pendingTaskCreateVerifications).toEqual([
      expect.objectContaining({ kind: 'conversation', externalId, state: 'unknown' }),
    ])
    expect(interrupted.continuation?.messages.at(-1)?.content).toContain('chat_list')
    expect(interrupted.continuation?.messages.at(-1)?.content).not.toContain('exakte task_list-Prüfung')

    mocks.streamChatWithTools
      .mockResolvedValueOnce(call('verify-chat', 'chat_list', { external_id: externalId }))
      .mockResolvedValueOnce(call('retry-chat', 'chat_create', { title: 'Projektanalyse' }))
      .mockResolvedValueOnce({ content: 'Chat gespeichert.', toolCalls: [], rawToolCalls: [] })
    const completed = await runAgent({
      ...durableTaskCreate,
      projectId: 'project-2',
      baseMessages: [],
      continuation: interrupted.continuation,
      mode: 'act',
      maxRounds: 3,
    })

    expect(chatListExecute).toHaveBeenCalledWith({ external_id: externalId }, expect.anything())
    expect(chatCreateExecute).toHaveBeenNthCalledWith(
      2,
      { title: 'Projektanalyse', external_id: externalId },
      expect.anything()
    )
    expect(completed.continuation).toBeUndefined()
    expect(completed.finalText).toBe('Chat gespeichert.')
  })

  it('checkpoints a task operation id before a team interruption can hide the POST outcome', async () => {
    const interruption = new AbortController()
    const checkpoints: import('@/services/agents/chatCheckpoint').AgentCheckpoint[] = []
    const taskCreateExecute = vi.fn(async (args: Record<string, unknown>) => {
      const externalId = String(args.external_id)
      expect(externalId).toMatch(/^[0-9a-f-]{36}$/u)
      expect(checkpoints.at(-1)?.pendingTaskCreateVerifications).toEqual([
        expect.objectContaining({ externalId, state: 'unknown' }),
      ])
      interruption.abort()
      return {
        ok: false,
        code: 'task_create_outcome_unknown',
        error: 'Die Antwort ging nach dem POST verloren.',
        retry: 'verify_before_retry',
        next_tool: 'task_list',
        next_arguments: { project_id: 'project-2', external_id: externalId },
        match_title: 'Timeout-Aufgabe',
        match_task_id: externalId,
      }
    })
    const taskCreate = {
      name: 'task_create',
      category: 'app',
      mutating: true,
      requiresApproval: false,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
      execute: taskCreateExecute,
    }
    mocks.getTool.mockReturnValue(taskCreate)
    mocks.toOpenAITools.mockReturnValue([
      { type: 'function', function: { name: taskCreate.name, parameters: taskCreate.parameters } },
    ])
    mocks.streamChatWithTools.mockResolvedValueOnce({
      content: '',
      toolCalls: [{ id: 'create-timeout', name: 'task_create', arguments: { title: 'Timeout-Aufgabe' } }],
      rawToolCalls: [
        {
          id: 'create-timeout',
          type: 'function' as const,
          function: { name: 'task_create', arguments: JSON.stringify({ title: 'Timeout-Aufgabe' }) },
        },
      ],
    })

    const response = await runAgent({
      taskCreateRecoveryReady: true,
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Lege die Timeout-Aufgabe an.' }],
      mode: 'act',
      interruptionSignal: interruption.signal,
      onCheckpoint: checkpoint => {
        checkpoints.push(checkpoint)
      },
      maxRounds: 2,
    })

    const externalId = String(taskCreateExecute.mock.calls[0]![0].external_id)
    expect(response.interrupted?.code).toBe('team_node_interrupted')
    expect(response.continuation?.pendingTaskCreateVerifications).toEqual([
      expect.objectContaining({ externalId, state: 'unknown' }),
    ])
    expect(response.continuation?.messages.some(message => message.role === 'tool')).toBe(true)
  })

  it('keeps other uncertain creates untouched during an exact task lookup', async () => {
    const ids = {
      first: '4af86574-4593-459f-a78c-cfe7e8266908',
      second: 'edb3faee-a142-470a-a213-57479a62276a',
    }
    const taskCreateExecute = vi.fn(async (args: Record<string, unknown>) => {
      const externalId = args.description === 'A' ? ids.first : ids.second
      return {
        ok: false,
        code: 'task_create_outcome_unknown',
        error: 'Der Ausgang ist unklar.',
        retry: 'verify_before_retry',
        next_tool: 'task_list',
        next_arguments: { project_id: 'project-2', external_id: externalId },
        match_title: args.title,
        match_task_id: externalId,
      }
    })
    const taskListExecute = vi.fn().mockResolvedValue({
      ok: true,
      tasks: [],
      task_create_idempotency: 'external_id_v1',
      filtered_external_id: ids.first,
    })
    const taskCreate = {
      name: 'task_create',
      category: 'app',
      mutating: true,
      requiresApproval: false,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string' }, description: { type: 'string' } },
        required: ['title'],
      },
      execute: taskCreateExecute,
    }
    const taskList = {
      name: 'task_list',
      category: 'app',
      mutating: false,
      requiresApproval: false,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { project_id: { type: 'string' }, external_id: { type: 'string' } },
      },
      execute: taskListExecute,
    }
    const calls = [
      { id: 'create-a', name: 'task_create', arguments: { title: 'Erste Aufgabe', description: 'A' } },
      { id: 'create-b', name: 'task_create', arguments: { title: 'Zweite Aufgabe', description: 'B' } },
    ]
    mocks.getTool.mockImplementation(name => (name === 'task_create' ? taskCreate : taskList))
    mocks.toOpenAITools.mockReturnValue(
      [taskCreate, taskList].map(tool => ({
        type: 'function',
        function: { name: tool.name, parameters: tool.parameters },
      }))
    )
    mocks.streamChatWithTools.mockResolvedValueOnce({
      content: '',
      toolCalls: calls,
      rawToolCalls: calls.map(call => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    })
    const uncertain = await runAgent({
      ...durableTaskCreate,
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Lege beide Aufgaben an.' }],
      mode: 'act',
      maxRounds: 1,
    })

    mocks.streamChatWithTools.mockResolvedValueOnce({
      content: '',
      toolCalls: [
        {
          id: 'verify-a',
          name: 'task_list',
          arguments: { project_id: 'project-2', external_id: ids.first },
        },
      ],
      rawToolCalls: [
        {
          id: 'verify-a',
          type: 'function' as const,
          function: {
            name: 'task_list',
            arguments: JSON.stringify({ project_id: 'project-2', external_id: ids.first }),
          },
        },
      ],
    })
    const verified = await runAgent({
      ...durableTaskCreate,
      projectId: 'project-2',
      baseMessages: [],
      mode: 'act',
      continuation: uncertain.continuation,
      maxRounds: 1,
    })

    expect(verified.continuation?.pendingTaskCreateVerifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalId: ids.first, state: 'verified_absent' }),
        expect.objectContaining({ externalId: ids.second, state: 'unknown' }),
      ])
    )
  })

  it('keeps a mutation-safe checkpoint when a later local model round fails', async () => {
    mocks.getTool.mockReturnValue({
      name: 'project_get_state',
      category: 'project',
      mutating: true,
      requiresApproval: false,
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.streamChatWithTools
      .mockResolvedValueOnce(toolCallResult)
      .mockRejectedValueOnce(
        new LocalInferenceError(
          'Das lokale Modell konnte die Werkzeugdaten nicht verarbeiten. Das Modell bleibt geladen.',
          'runtime_tool_contract_rejected',
          false,
          false
        )
      )

    const interrupted = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Speichere das Projekt' }],
      mode: 'act',
      maxRounds: 3,
    })

    expect(interrupted.interrupted).toMatchObject({ code: 'runtime_tool_contract_rejected', round: 2 })
    expect(interrupted.continuation?.completedMutations).toHaveLength(1)
    expect(interrupted.continuation?.messages.some(message => message.role === 'tool')).toBe(true)
    expect(interrupted.finalText).toContain('Arbeitsfortschritt bleibt erhalten')

    mocks.streamChatWithTools
      .mockResolvedValueOnce(toolCallResult)
      .mockResolvedValueOnce({ content: 'Fortsetzung abgeschlossen.', toolCalls: [], rawToolCalls: [] })
    const resumed = await runAgent({
      projectId: 'project-2',
      baseMessages: [],
      mode: 'act',
      continuation: interrupted.continuation,
      maxRounds: 2,
    })

    expect(resumed.finalText).toBe('Fortsetzung abgeschlossen.')
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })

  it('retains completed changes and reports a parameter rejection without retrying the failing round', async () => {
    mocks.getTool.mockReturnValue({
      name: 'project_get_state',
      category: 'project',
      mutating: true,
      requiresApproval: false,
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    const diagnosticMessage = 'Die Antwortgenerierung wurde abgelehnt (HTTP 400). Parameter: enable_thinking.'
    mocks.streamChatWithTools.mockResolvedValueOnce(toolCallResult).mockRejectedValueOnce(
      new LocalInferenceError(diagnosticMessage, 'runtime_request_rejected', false, false, {
        schemaVersion: 1,
        stage: 'generation',
        httpStatus: 400,
        code: 'runtime_request_rejected',
        parameter: 'enable_thinking',
        reason: 'parameter_type',
      })
    )
    const interrupted = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Speichere den Projektfortschritt.' }],
      mode: 'act',
      maxRounds: 5,
    })
    expect(interrupted.interrupted).toMatchObject({ code: 'runtime_request_rejected', round: 2 })
    expect(interrupted.finalText).toContain(diagnosticMessage)
    expect(interrupted.continuation?.completedMutations).toHaveLength(1)
    // An invalid parameter is not evidence that the saved tool history is corrupt.
    expect(interrupted.continuation?.messages.some(message => message.role === 'tool')).toBe(true)
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(2)
    mocks.streamChatWithTools
      .mockResolvedValueOnce(toolCallResult)
      .mockResolvedValueOnce({ content: 'Fortsetzung abgeschlossen.', toolCalls: [], rawToolCalls: [] })
    const resumed = await runAgent({
      projectId: 'project-2',
      baseMessages: [],
      mode: 'act',
      continuation: interrupted.continuation,
      maxRounds: 2,
    })
    expect(resumed.finalText).toBe('Fortsetzung abgeschlossen.')
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch an agent twice after rebuilding a rejected local tool history', async () => {
    const dispatchResult = {
      content: 'Agent wird gestartet.',
      requestId: 'dispatch-request-1',
      toolCalls: [
        {
          id: 'dispatch-call-1',
          name: 'agent_dispatch',
          arguments: { agent: 'codex', prompt: 'Prüfe das Projekt.' },
        },
      ],
      rawToolCalls: [
        {
          id: 'dispatch-call-1',
          type: 'function' as const,
          function: {
            name: 'agent_dispatch',
            arguments: JSON.stringify({ agent: 'codex', prompt: 'Prüfe das Projekt.' }),
          },
        },
      ],
    }
    mocks.getTool.mockReturnValue({
      name: 'agent_dispatch',
      category: 'app',
      mutating: true,
      requiresApproval: false,
      effects: ['write'],
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.streamChatWithTools
      .mockResolvedValueOnce(dispatchResult)
      .mockRejectedValueOnce(
        new LocalInferenceError(
          'Das lokale Modell konnte die Werkzeugdaten nicht verarbeiten. Das Modell bleibt geladen.',
          'runtime_tool_contract_rejected',
          false,
          false
        )
      )

    const interrupted = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Delegiere die Prüfung.' }],
      mode: 'act',
      maxRounds: 3,
    })

    expect(interrupted.continuation?.completedMutations).toHaveLength(1)

    mocks.streamChatWithTools
      .mockResolvedValueOnce(dispatchResult)
      .mockResolvedValueOnce({ content: 'Agentenprüfung abgeschlossen.', toolCalls: [], rawToolCalls: [] })
    const resumed = await runAgent({
      projectId: 'project-2',
      baseMessages: [],
      mode: 'act',
      continuation: interrupted.continuation,
      maxRounds: 2,
    })

    expect(resumed.finalText).toBe('Agentenprüfung abgeschlossen.')
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })

  it('rebuilds a continuation whose first inference rejects the previous tool history', async () => {
    mocks.streamChatWithTools.mockResolvedValueOnce(toolCallResult)
    const first = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Lies zuerst den Stand.' }],
      mode: 'observe',
      maxRounds: 1,
    })
    mocks.streamChatWithTools.mockRejectedValueOnce(
      new LocalInferenceError(
        'Das lokale Modell konnte die Nachrichtenstruktur nicht verarbeiten. Das Modell bleibt geladen.',
        'runtime_chat_history_rejected',
        false,
        false
      )
    )

    const result = await runAgent({
      projectId: 'project-2',
      baseMessages: [],
      mode: 'act',
      continuation: first.continuation,
      maxRounds: 2,
    })

    expect(result.interrupted?.code).toBe('runtime_chat_history_rejected')
    expect(result.continuation?.messages.some(message => message.role === 'tool')).toBe(true)
  })

  it('does not advertise or execute an internally disabled team-start tool', async () => {
    const nestedToolCall = {
      content: '',
      toolCalls: [{ id: 'nested', name: 'agent_team_prepare', arguments: { objective: 'Nested' } }],
      rawToolCalls: [
        {
          id: 'nested',
          type: 'function' as const,
          function: { name: 'agent_team_prepare', arguments: '{"objective":"Nested"}' },
        },
      ],
    }
    const nestedTool = {
      name: 'agent_team_prepare',
      category: 'app',
      mutating: true,
      requiresApproval: false,
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    }
    mocks.toOpenAITools.mockReturnValue([
      { type: 'function', function: { name: 'agent_team_prepare', parameters: nestedTool.parameters } },
    ])
    mocks.getTool.mockReturnValue(nestedTool)
    mocks.streamChatWithTools
      .mockResolvedValueOnce(nestedToolCall)
      .mockResolvedValueOnce({ content: 'Ohne verschachteltes Team fortgesetzt.', toolCalls: [], rawToolCalls: [] })

    const result = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Bearbeite das Projekt' }],
      mode: 'act',
      disabledTools: ['agent_team_prepare'],
      maxRounds: 2,
    })

    expect(mocks.streamChatWithTools.mock.calls[0]![0].tools).toEqual([])
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(result.toolFailures).toBe(1)
    expect(result.finalText).toBe('Ohne verschachteltes Team fortgesetzt.')
  })

  it('allows repeated desktop input after continuation because the target state can change', async () => {
    mocks.getTool.mockReturnValue({
      name: 'project_get_state',
      category: 'os',
      mutating: true,
      effects: ['input'],
      requiresApproval: false,
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.streamChatWithTools.mockResolvedValue(toolCallResult)
    const first = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Bediene den Dialog' }],
      mode: 'act',
      maxRounds: 1,
    })
    await runAgent({
      projectId: 'project-2',
      baseMessages: [],
      mode: 'act',
      continuation: first.continuation,
      maxRounds: 1,
    })
    expect(mocks.execute).toHaveBeenCalledTimes(2)
  })

  it('preserves read-only restrictions when continuing a reviewer checkpoint', async () => {
    mocks.getTool.mockReturnValue({
      name: 'project_get_state',
      category: 'project',
      mutating: true,
      requiresApproval: false,
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.streamChatWithTools.mockResolvedValue(toolCallResult)
    const first = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Prüfe das Ergebnis' }],
      mode: 'act',
      toolAccess: 'read-only',
      maxRounds: 1,
    })
    expect(first.continuation?.toolAccess).toBe('read-only')
    await runAgent({
      projectId: 'project-2',
      baseMessages: [],
      mode: 'act',
      continuation: first.continuation,
      maxRounds: 1,
    })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('recovers in round six from malformed arguments without rerunning successful mutations', async () => {
    const callResult = (id: string, name: string, rawArguments = '{}') => ({
      content: '',
      toolCalls: [
        {
          id,
          name,
          arguments: rawArguments.startsWith('{"title"') ? {} : { title: 'Valid', status: 'open' },
          rawArguments,
        },
      ],
      rawToolCalls: [{ id, type: 'function' as const, function: { name, arguments: rawArguments } }],
    })
    for (let i = 0; i < 4; i++) mocks.streamChatWithTools.mockResolvedValueOnce(callResult(`read-${i}`, 'fs_read'))
    const good = callResult('summary', 'project_set_summary')
    const bad = callResult('goal-bad', 'project_upsert_goal', '{"title":"unfinished')
    mocks.streamChatWithTools.mockResolvedValueOnce({
      content: '',
      toolCalls: [...good.toolCalls, ...bad.toolCalls],
      rawToolCalls: [...good.rawToolCalls, ...bad.rawToolCalls],
    })
    mocks.streamChatWithTools
      .mockImplementationOnce(async (request: InferenceRequest) => {
        const calls = request.messages.flatMap(message =>
          message.role === 'assistant' ? (message.tool_calls ?? []) : []
        )
        for (const call of calls) expect(JSON.parse(call.function.arguments)).toBeTypeOf('object')
        const failed = request.messages.find(message => message.role === 'tool' && message.tool_call_id === 'goal-bad')
        expect(JSON.parse(failed!.content)).toMatchObject({
          ok: false,
          error: expect.stringContaining('nicht ausgeführt'),
        })
        expect(mocks.execute).toHaveBeenCalledTimes(5)
        return callResult('goal-fixed', 'project_upsert_goal', '{"status":"open","title":"Valid"}')
      })
      .mockResolvedValueOnce({ content: 'Ziel gespeichert.', toolCalls: [], rawToolCalls: [] })
    const result = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Bitte Projektziel speichern.' }],
      mode: 'act',
      maxRounds: 8,
    })
    expect(result.finalText).toBe('Ziel gespeichert.')
    expect(result.toolFailures).toBe(1)
    expect(result.toolSuccesses).toBe(6)
    expect(mocks.execute).toHaveBeenCalledTimes(6)
    expect(bad.rawToolCalls[0]!.function.arguments).toBe('{"title":"unfinished')
  })

  beforeEach(() => {
    vi.resetAllMocks()
    resetAssistantProfile()
    mocks.assistantProfileWithApiConfig.mockResolvedValue({ data: { persona: null, skills: [], revision: 'empty' } })
    mocks.resolveDeviceAssistance.mockImplementation(task => task)
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
    expect(approve).toHaveBeenCalledWith('call-1', expect.anything())
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith('call-1', 'executed')
    expect(mocks.queueToolCall).not.toHaveBeenCalled()
    expect(mocks.addHiddenToolMessage).not.toHaveBeenCalled()
    expect(mocks.logAgentEvent).not.toHaveBeenCalled()
  })

  it.each([true, false])('passes complete tool evidence to the next local model round (ok=%s)', async ok => {
    const output = {
      path: '/projekte/luczor',
      windows: 'E:\\projekte\\luczor',
      content: 'line\r\n'.repeat(2500) + 'END: do not delete',
    }
    mocks.execute.mockResolvedValue(
      ok ? output : { ok: false, error: 'detail '.repeat(600) + '/projekte/luczor', output }
    )
    mocks.streamChatWithTools
      .mockResolvedValueOnce(toolCallResult)
      .mockResolvedValueOnce({ content: 'Geprüft.', toolCalls: [], rawToolCalls: [] })
    await runAgent({
      projectId: 'p1',
      mode: 'observe',
      baseMessages: [{ role: 'user', content: 'Prüfe das Projekt' }],
      inferenceGateway: { id: 'local', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    const request = mocks.streamChatWithTools.mock.calls[1]![0] as InferenceRequest
    const receipt = request.messages.find(message => message.role === 'tool')!
    const error = 'detail '.repeat(600) + '/projekte/luczor'
    // Failed tool envelopes remain raw evidence inside the normalized outcome.
    expect(JSON.parse(receipt.content)).toEqual(
      ok ? { ok: true, output } : { ok: false, error, output: { ok: false, error, output } }
    )
    expect(request.contextBudget?.shortenedToolResults).toBe(0)
  })

  it('queues approval-required tools as approved in unrestricted mode without opening a pending approval', async () => {
    mocks.getTool.mockReturnValue({
      name: 'project_upsert_goal',
      category: 'project',
      mutating: true,
      requiresApproval: true,
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.streamChatWithTools.mockResolvedValueOnce({
      ...toolCallResult,
      toolCalls: [{ id: 'call-unrestricted', name: 'project_upsert_goal', arguments: { title: 'Ziel' } }],
      rawToolCalls: [
        {
          id: 'call-unrestricted',
          type: 'function' as const,
          function: { name: 'project_upsert_goal', arguments: '{"title":"Ziel"}' },
        },
      ],
    })

    await runAgent({
      projectId: 'p1',
      mode: 'unrestricted',
      baseMessages: [{ role: 'user', content: 'Speichere das Ziel' }],
      maxRounds: 1,
    })

    expect(mocks.queueToolCall).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        id: 'call-unrestricted',
        requiresApproval: true,
        status: 'approved',
      })
    )
    expect(mocks.awaitApproval).not.toHaveBeenCalled()
    expect(mocks.execute).toHaveBeenCalledOnce()
  })

  it('does not execute a late tool result after cancellation', async () => {
    const abort = new AbortController()
    mocks.streamChatWithTools.mockImplementationOnce(async () => {
      abort.abort()
      return toolCallResult
    })
    await expect(
      runAgent({
        taskCreateRecoveryReady: true,
        projectId: 'p1',
        mode: 'act',
        baseMessages: [{ role: 'user', content: 'Bitte lesen' }],
        signal: abort.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('releases an approval wait when the team scheduler interrupts the node', async () => {
    const interruption = new AbortController()
    mocks.getTool.mockReturnValue({
      name: 'project_upsert_goal',
      category: 'project',
      mutating: true,
      requiresApproval: true,
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.streamChatWithTools.mockResolvedValueOnce({
      ...toolCallResult,
      toolCalls: [{ id: 'call-approval', name: 'project_upsert_goal', arguments: { title: 'Ziel' } }],
      rawToolCalls: [],
    })
    mocks.awaitApproval.mockImplementation(
      async (_id: string, signal: AbortSignal) =>
        new Promise<boolean>(resolve => {
          signal.addEventListener('abort', () => resolve(false), { once: true })
          queueMicrotask(() => interruption.abort())
        })
    )

    const result = await runAgent({
      ...durableTaskCreate,
      projectId: 'p1',
      mode: 'act',
      baseMessages: [{ role: 'user', content: 'Bitte speichern' }],
      interruptionSignal: interruption.signal,
      inferenceGateway: {
        id: 'local',
        target: 'local_llama_cpp',
        streamChatWithTools: mocks.streamChatWithTools,
      },
    })

    expect(result.interrupted?.code).toBe('team_node_interrupted')
    expect(result.continuation).toBeDefined()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('blocks task creation when durable recovery state is unavailable', async () => {
    mocks.getTool.mockReturnValue({
      name: 'task_create',
      category: 'project',
      mutating: true,
      requiresApproval: false,
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.streamChatWithTools.mockResolvedValueOnce({
      content: '',
      requestId: 'request-task',
      toolCalls: [{ id: 'call-task', name: 'task_create', arguments: { title: 'Analyse' } }],
      rawToolCalls: [],
    })

    const result = await runAgent({
      projectId: 'p1',
      mode: 'unrestricted',
      baseMessages: [{ role: 'user', content: 'Aufgabe anlegen' }],
      taskCreateRecoveryReady: false,
      maxRounds: 1,
    })

    expect(result.toolFailures).toBe(1)
    expect(JSON.stringify(mocks.addHiddenToolMessage.mock.calls)).toContain('task_create_recovery_unavailable')
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('does not post a new task unless its pre-write checkpoint was persisted', async () => {
    mocks.getTool.mockReturnValue({
      name: 'task_create',
      category: 'project',
      mutating: true,
      requiresApproval: false,
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.streamChatWithTools.mockResolvedValueOnce({
      content: '',
      requestId: 'request-task',
      toolCalls: [{ id: 'call-task', name: 'task_create', arguments: { title: 'Analyse' } }],
      rawToolCalls: [],
    })

    await expect(
      runAgent({
        taskCreateRecoveryReady: true,
        projectId: 'p1',
        mode: 'unrestricted',
        baseMessages: [{ role: 'user', content: 'Aufgabe anlegen' }],
        onCheckpoint: async () => {
          throw new Error('disk full')
        },
        maxRounds: 1,
      })
    ).rejects.toThrow('Sicherheitsstatus vor dem Anlegen')
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('carries an unresolved task write into a normal typed turn without a continuation', async () => {
    mocks.getTool.mockReturnValue({
      name: 'task_create',
      category: 'project',
      mutating: true,
      requiresApproval: false,
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.streamChatWithTools.mockResolvedValueOnce({
      content: '',
      requestId: 'request-task',
      toolCalls: [{ id: 'call-task', name: 'task_create', arguments: { title: 'Analyse' } }],
      rawToolCalls: [],
    })

    const result = await runAgent({
      ...durableTaskCreate,
      projectId: 'p1',
      mode: 'unrestricted',
      baseMessages: [{ role: 'user', content: 'Lege Analyse an' }],
      pendingTaskCreateVerifications: [
        {
          projectId: 'p1',
          title: 'Analyse',
          externalId: '11111111-1111-4111-8111-111111111111',
          state: 'unknown',
        },
      ],
      maxRounds: 1,
    })

    expect(result.toolFailures).toBe(1)
    expect(result.continuation?.pendingTaskCreateVerifications?.[0]?.externalId).toBe(
      '11111111-1111-4111-8111-111111111111'
    )
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('does not turn an unrelated answer into a continuation because the project has a pending task write', async () => {
    mocks.streamChatWithTools.mockResolvedValueOnce({
      content: 'Die Projektzusammenfassung ist aktuell.',
      toolCalls: [],
      rawToolCalls: [],
    })

    const result = await runAgent({
      projectId: 'p1',
      mode: 'observe',
      baseMessages: [{ role: 'user', content: 'Wie lautet die Zusammenfassung?' }],
      pendingTaskCreateVerifications: [
        {
          projectId: 'p1',
          title: 'Andere Aufgabe',
          externalId: '11111111-1111-4111-8111-111111111111',
          state: 'unknown',
        },
      ],
    })

    expect(result.finalText).toBe('Die Projektzusammenfassung ist aktuell.')
    expect(result.continuation).toBeUndefined()
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

  it('makes local context shortening visible without changing the stored input messages', async () => {
    mocks.streamChatWithTools.mockResolvedValueOnce({
      content: 'Antwort',
      toolCalls: [],
      rawToolCalls: [],
      contextUsage: {
        inputTokens: 6000,
        contextTokens: 8192,
        outputTokens: 2048,
        omittedMessages: 4,
        shortenedToolResults: 0,
      },
    })
    const baseMessages = [{ role: 'user' as const, content: 'Hallo' }]
    const outcome = await runAgent({ projectId: 'project-2', mode: 'observe', baseMessages })
    expect(outcome.finalText).toContain('gespeicherte Chatverlauf bleibt vollständig erhalten')
    expect(baseMessages).toEqual([{ role: 'user', content: 'Hallo' }])
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
      expect(mocks.awaitApproval).toHaveBeenCalledWith('call-1', expect.anything())
      expect(mocks.execute).toHaveBeenCalledTimes(1)
    }
  )

  it('refreshes the live mode, forces only the first tool round and hides recognized private work notes', async () => {
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

  it('publishes live text before completion and replaces usage estimates with runtime counts', async () => {
    const visibleTokens = vi.fn()
    const onUsage = vi.fn()
    let complete!: () => void
    const delayed = new Promise<void>(resolve => {
      complete = resolve
    })
    let started!: () => void
    const receiving = new Promise<void>(resolve => {
      started = resolve
    })
    mocks.streamChatWithTools.mockImplementationOnce(async args => {
      args.onToken('H')
      args.onToken('Hallo')
      started()
      await delayed
      return {
        content: 'Hallo!',
        toolCalls: [],
        rawToolCalls: [],
        usage: { inputTokens: 123, outputTokens: 3, totalTokens: 126 },
      }
    })
    const result = runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'Hallo' }],
      mode: 'observe',
      onToken: visibleTokens,
      onUsage,
    })
    await receiving
    expect(visibleTokens.mock.calls).toEqual([['H'], ['Hallo']])
    expect(onUsage.mock.calls.at(-1)?.[0]).toMatchObject({ source: 'estimated', outputTokens: 2, rounds: 1 })
    complete()
    expect((await result).tokenUsage).toMatchObject({
      source: 'reported',
      inputTokens: 123,
      outputTokens: 3,
      totalTokens: 126,
      rounds: 1,
    })
    expect(visibleTokens).toHaveBeenLastCalledWith('Hallo!')
  })

  it('retains completed public commentary before the next round starts without publishing an empty buffer', async () => {
    const visibleTokens = vi.fn()
    const completedRounds = vi.fn()
    mocks.streamChatWithTools
      .mockImplementationOnce(async args => {
        args.onToken('Ich prüfe den Projektzustand.')
        return {
          ...toolCallResult,
          content: 'Ich prüfe den Projektzustand.',
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        }
      })
      .mockImplementationOnce(async args => {
        expect(completedRounds).toHaveBeenCalledWith({
          round: 1,
          content: 'Ich prüfe den Projektzustand.',
          kind: 'commentary',
          serverSpeechAllowed: true,
        })
        args.onToken('Geprüft.')
        return {
          content: 'Geprüft.',
          toolCalls: [],
          rawToolCalls: [],
          usage: { inputTokens: 130, outputTokens: 4, totalTokens: 134 },
        }
      })
    const result = await runAgent({
      projectId: 'project-2',
      baseMessages: [{ role: 'user', content: 'prüfen bitte' }],
      mode: 'observe',
      onToken: visibleTokens,
      onRoundComplete: completedRounds,
    })
    expect(visibleTokens.mock.calls).toEqual([['Ich prüfe den Projektzustand.'], ['Geprüft.']])
    expect(completedRounds).toHaveBeenLastCalledWith({
      round: 2,
      content: 'Geprüft.',
      kind: 'answer',
      serverSpeechAllowed: true,
    })
    expect(result.tokenUsage).toMatchObject({
      inputTokens: 230,
      outputTokens: 24,
      totalTokens: 254,
      rounds: 2,
      source: 'reported',
    })
  })

  it('keeps later commentary local after an ephemeral tool result and never retains private work notes', async () => {
    const completedRounds = vi.fn()
    mocks.getTool.mockReturnValue({
      name: 'project_get_state',
      category: 'project',
      mutating: false,
      requiresApproval: false,
      dataHandling: 'ephemeral',
      parameters: { type: 'object', additionalProperties: true },
      execute: mocks.execute,
    })
    mocks.streamChatWithTools
      .mockResolvedValueOnce(toolCallResult)
      .mockResolvedValueOnce({ ...toolCallResult, content: 'Ich prüfe die lokale Auswahl.' })
      .mockResolvedValueOnce({ content: 'Geprüft.', toolCalls: [], rawToolCalls: [] })
    await runAgent({ projectId: 'p1', baseMessages: [], mode: 'observe', onRoundComplete: completedRounds })
    expect(completedRounds.mock.calls.map(call => call[0])).toEqual([
      { round: 2, content: 'Ich prüfe die lokale Auswahl.', kind: 'commentary', serverSpeechAllowed: false },
      { round: 3, content: 'Geprüft.', kind: 'answer', serverSpeechAllowed: false },
    ])
  })

  it('retains tool evidence but marks an empty final model response as incomplete', async () => {
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
    expect(result.interrupted?.code).toBe('runtime_empty_response')
    expect(result.continuation).toBeDefined()
  })

  it('does not turn a first-round empty response into success or retry it blindly', async () => {
    mocks.streamChatWithTools.mockResolvedValueOnce({
      content: '',
      toolCalls: [],
      rawToolCalls: [],
      finishReason: 'length',
      requestId: 'empty-response',
      model: 'local-test-model',
      usage: { inputTokens: 18, outputTokens: 128, totalTokens: 146 },
    })
    const result = await runAgent({
      projectId: 'p1',
      baseMessages: [{ role: 'user', content: 'Analysiere den Stand' }],
      mode: 'observe',
      inferenceGateway: { id: 'local-test', target: 'local_llama_cpp', streamChatWithTools: mocks.streamChatWithTools },
    })
    expect(result.interrupted).toMatchObject({
      code: 'runtime_empty_response',
      round: 1,
      diagnostic: {
        target: 'local_llama_cpp',
        model: 'local-test-model',
        finishReason: 'length',
        receivedCharacters: 0,
        outputTokens: 128,
      },
    })
    expect(result.requestId).toBe('empty-response')
    expect(result.finalText).toContain('Ausgabelimit')
    expect(result.continuation?.objective).toBe('Analysiere den Stand')
    expect(mocks.streamChatWithTools).toHaveBeenCalledOnce()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('does not persist arbitrary finish metadata or attribute an empty round to an earlier request', async () => {
    mocks.streamChatWithTools.mockResolvedValueOnce(toolCallResult).mockResolvedValueOnce({
      content: '',
      toolCalls: [],
      rawToolCalls: [],
      finishReason: 'Authorization Bearer PRIVATE',
    })
    const result = await runAgent({ projectId: 'p1', baseMessages: [], mode: 'observe' })
    expect(result.requestId).toBeUndefined()
    expect(result.interrupted?.diagnostic?.finishReason).toBe('unknown')
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
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
    expect(outcome.output).toEqual(partial)
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
      localReasoningMode: 'off',
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
    expect(sent).not.toHaveProperty('reasoningMode')
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
