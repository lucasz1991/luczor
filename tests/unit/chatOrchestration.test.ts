import { expect, it, vi } from 'vitest'
import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import type { AgentInterruption, RunAgentOptions } from '@/services/agent'
const { prepareSpecialists, projectSnapshot, preparedDefinition } = vi.hoisted(() => ({
  preparedDefinition: vi.fn(),
  prepareSpecialists: vi.fn(),
  projectSnapshot: vi.fn(async (): Promise<import('@/services/agents/types').AgentProjectSnapshot> => ({
    projectId: 'p',
    projectName: 'Project',
    principalId: 'account',
  })),
}))
vi.mock('@/services/agents/externalSpecialists', () => ({ prepareExternalSpecialists: prepareSpecialists }))
vi.mock('@/services/toolLimits', () => ({ loadToolLimits: async () => ({ chat: 6, agent: 17 }) }))
vi.mock('@/services/agents/hub', () => ({
  agentProjectSnapshot: projectSnapshot,
}))
vi.mock('@/services/agents/teamHub', async () => {
  const { AgentTeamOrchestrator } = await import('@/services/agents/teams')
  type Executor = import('@/services/agents/teams').AgentTeamExecutor
  let execute: Executor
  const agentTeams = new AgentTeamOrchestrator({ executor: request => execute(request) })
  return {
    agentTeams,
    prepareChatAgentTeam: (
      definition: import('@/services/agents/teams').AgentTeamDefinition,
      input: import('@/services/agents/teams').AgentTeamRunInput,
      executor: Executor
    ) => {
      execute = executor
      preparedDefinition(definition)
      // Keep deadline tests fast even when production budgets scale with tool rounds.
      return agentTeams.prepare({ ...definition, deadlineMs: 5_000 }, input)
    },
  }
})
import { runChatAgentTeam } from '@/services/agents/chatOrchestration'
import { modelUsageSettings } from '@/services/inference/modelUsageSettings'
const checkpoint: AgentCheckpoint = {
  projectId: 'p',
  sessionId: 's',
  generation: 1,
  objective: 'Implementiere den Auftrag',
  messages: [{ role: 'user', content: 'Implementiere den Auftrag' }],
  completedMutations: [],
  ephemeralDataUsed: false,
}
const gateway = { id: 'local', target: 'local_llama_cpp' as const, streamChatWithTools: vi.fn() }
const result = {
  finalText: 'Belegtes Ergebnis',
  toolFailures: 0,
  toolSuccesses: 1,
  ephemeralDataUsed: false,
  tokenUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, rounds: 1, source: 'reported' as const },
}
it('runs a sequential planner-worker-reviewer graph with configured worker limit and narrow rights', async () => {
  const calls: RunAgentOptions[] = []
  const execute = vi.fn(async (options: RunAgentOptions) => {
    calls.push(options)
    options.onUsage?.(result.tokenUsage)
    return {
      ...result,
      continuation: calls.length === 2 ? checkpoint : undefined,
      ephemeralDataUsed: calls.length === 2,
    }
  })
  const response = await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'act', agentMode: true },
    gateway,
    { ...checkpoint },
    execute
  )
  expect(calls.map(call => call.maxRounds)).toEqual([1, 17, 3])
  expect(
    preparedDefinition.mock.lastCall?.[0].nodes.find((node: { id: string }) => node.id === 'worker').timeoutMs
  ).toBe(51 * 60_000)
  expect(preparedDefinition.mock.lastCall?.[0].deadlineMs).toBe(81 * 60_000)
  expect(calls.map(call => call.toolAccess)).toEqual(['none', undefined, 'read-only'])
  expect(calls.map(call => call.localReasoningMode)).toEqual([undefined, undefined, undefined])
  expect(
    calls.every(
      call =>
        call.disabledTools?.includes('agent_team_prepare') && call.disabledTools.includes('workspace_agent_prepare')
    )
  ).toBe(true)
  expect(
    calls.every(call => !call.agentMode && call.inferenceGateway === gateway && call.contextEgress === 'local_only')
  ).toBe(true)
  expect(response.continuation).toEqual(checkpoint)
  expect(response.ephemeralDataUsed).toBe(true)
  expect(response.tokenUsage.totalTokens).toBe(21)
  expect(response.finalText).toContain('Rundenlimit')
})

it('inherits admitted thinking for planner, worker and reviewer while preserving role limits', async () => {
  const calls: RunAgentOptions[] = []
  const thinkingConfig = { initialTokens: 8192, maxThinkingTokens: 65536, responseReserveTokens: 16384 }
  const onBudget = vi.fn()
  await runChatAgentTeam(
    {
      projectId: 'p',
      baseMessages: checkpoint.messages,
      mode: 'observe',
      localReasoningMode: 'auto',
      thinkingTier: 'ultra',
      thinkingConfig,
      onBudget,
    },
    gateway,
    { ...checkpoint },
    async options => {
      calls.push(options)
      return result
    }
  )
  expect(calls.map(call => call.localReasoningMode)).toEqual(['auto', 'auto', 'auto'])
  expect(
    calls.every(
      call => call.thinkingTier === 'ultra' && call.thinkingConfig === thinkingConfig && call.onBudget === onBudget
    )
  ).toBe(true)
  expect(calls.map(call => call.maxRounds)).toEqual([1, 17, 3])
  expect(calls.map(call => call.toolAccess)).toEqual(['none', undefined, 'read-only'])
})
it('stops scheduling dependent agents after cancellation', async () => {
  const controller = new AbortController()
  const execute = vi.fn(async () => {
    controller.abort()
    throw new DOMException('Stopped', 'AbortError')
  })
  await expect(
    runChatAgentTeam(
      { projectId: 'p', baseMessages: checkpoint.messages, mode: 'observe', signal: controller.signal },
      gateway,
      { ...checkpoint },
      execute
    )
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(execute).toHaveBeenCalledTimes(1)
})

it('keeps device analysis available without advertising unusable project filesystem tools', async () => {
  const execute = vi.fn(async (options: RunAgentOptions) => {
    expect(options.disabledTools).toEqual(expect.arrayContaining(['fs_list', 'fs_read', 'fs_search', 'fs_write']))
    expect(options.disabledTools).not.toContain('os_environment')
    expect(JSON.stringify(options.baseMessages)).toContain('Kein lokaler Projektordner ist gebunden')
    return result
  })
  await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'observe' },
    gateway,
    { ...checkpoint },
    execute
  )
  expect(execute).toHaveBeenCalledTimes(3)
  expect(JSON.stringify(execute.mock.calls[0]![0].baseMessages)).toContain(
    'die eigentliche Datenerhebung übernimmt unmittelbar der Arbeitsagent'
  )
})

it('retains caller restrictions and filesystem access for a bound workspace', async () => {
  projectSnapshot.mockResolvedValueOnce({
    projectId: 'p',
    projectName: 'Project',
    principalId: 'account',
    rootPath: 'E:/private',
  })
  const execute = vi.fn(async (options: RunAgentOptions) => {
    expect(options.disabledTools).toContain('os_environment')
    expect(options.disabledTools).not.toContain('fs_read')
    expect(JSON.stringify(options.baseMessages)).not.toContain('E:/private')
    return result
  })
  await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'observe', disabledTools: ['os_environment'] },
    gateway,
    { ...checkpoint },
    execute
  )
  expect(execute).toHaveBeenCalledTimes(3)
})

it('numbers reviewer progress after the actual worker rounds instead of the configured maximum', async () => {
  const progress: Array<{ agentRole?: string; round?: number }> = []
  const execute = vi.fn(async (options: RunAgentOptions) => {
    const rounds = execute.mock.calls.length === 2 ? 3 : 1
    options.onProgress?.({ phase: 'thinking', round: rounds })
    return { ...result, tokenUsage: { ...result.tokenUsage, rounds } }
  })
  await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'observe', onProgress: event => progress.push(event) },
    gateway,
    { ...checkpoint },
    execute
  )
  expect(progress.map(event => [event.agentRole, event.round])).toEqual([
    ['planner', 1],
    ['worker', 4],
    ['reviewer', 5],
  ])
})

it('distinguishes unavailable readiness from a confirmed runtime failure and preserves the worker result', async () => {
  const execute = vi.fn(async () =>
    execute.mock.calls.length === 3
      ? {
          ...result,
          continuation: checkpoint,
          interrupted: { code: 'readiness_unavailable', message: 'Readiness unavailable' },
        }
      : { ...result, finalText: 'Gesicherte Messwerte' }
  )
  const response = await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'observe' },
    gateway,
    { ...checkpoint },
    execute
  )
  expect(response.finalText).toContain('Gesicherte Messwerte')
  expect(response.finalText).toContain('geprüfte Modellbereitschaft')
  expect(response.finalText).not.toContain('lokalen Modellstörung')
  expect(response.continuation?.toolAccess).toBe('read-only')
})

it('returns the saved checkpoint when the worker model fails before producing a result', async () => {
  const savedWorkerCheckpoint = {
    ...checkpoint,
    objective: 'Gesicherter Worker-Stand',
    completedMutations: [['mutation', { ok: true }]] as AgentCheckpoint['completedMutations'],
  }
  const execute = vi.fn(async (options: RunAgentOptions) => {
    if (execute.mock.calls.length === 1)
      return { ...result, requestId: 'planner-request', model: 'planner-model', provider: 'local' }
    options.onUsage?.(result.tokenUsage)
    await options.onCheckpoint?.(savedWorkerCheckpoint)
    throw new Error('Local model request failed')
  })

  const response = await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'act', agentMode: true },
    gateway,
    { ...checkpoint },
    execute
  )

  expect(execute).toHaveBeenCalledTimes(2)
  expect(response.continuation).toEqual(savedWorkerCheckpoint)
  expect(response.interrupted?.code).toBe('execution_failed')
  expect(response.requestId).toBeUndefined()
  expect(response.model).toBeUndefined()
  expect(response.finalText).toContain('Arbeitsagent wurde vor dem Abschluss unterbrochen')
  expect(response.finalText).toContain('Projekt- und Aufgabenstand')
})

it('returns the original checkpoint when the planning agent fails before producing a result', async () => {
  const execute = vi.fn(async () => {
    throw new Error('Local model request failed')
  })

  const response = await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'act', agentMode: true },
    gateway,
    { ...checkpoint },
    execute
  )

  expect(execute).toHaveBeenCalledOnce()
  expect(response.continuation).toEqual(checkpoint)
  expect(response.interrupted?.code).toBe('execution_failed')
  expect(response.finalText).toContain('Planungsagent wurde vor dem ersten Ergebnis unterbrochen')
})

it.each([
  ['planner', 'runtime_empty_response'],
  ['planner', 'runtime_unsafe_response'],
  ['worker', 'runtime_empty_response'],
  ['worker', 'runtime_unsafe_response'],
] as const)('does not run dependent nodes after an unusable %s response (%s)', async (role, code) => {
  const saved = {
    ...checkpoint,
    objective: 'Gesicherter Auftrag',
    completedMutations: [['saved-change', { ok: true }]] as AgentCheckpoint['completedMutations'],
  }
  const interruption: AgentInterruption = {
    code,
    message: 'Keine verwertbare öffentliche Modellantwort.',
    round: 1,
    diagnostic: {
      target: 'local_llama_cpp',
      model: 'local-worker',
      finishReason: 'length',
      durationMs: 3400,
      receivedCharacters: 0,
      outputTokens: 200,
    },
  }
  const execute = vi.fn(async (options: RunAgentOptions) => {
    if (role === 'worker' && execute.mock.calls.length === 1)
      return { ...result, finalText: 'Arbeitsplan', model: 'planner-model' }
    await options.onCheckpoint?.(saved)
    return {
      ...result,
      finalText: 'Keine verwertbare öffentliche Modellantwort. Modell: local-worker; Abschluss: length.',
      model: 'local-worker',
      provider: 'local',
      requestId: 'failed-round',
      continuation: saved,
      interrupted: interruption,
    }
  })

  const response = await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'act', agentMode: true },
    gateway,
    { ...checkpoint },
    execute
  )

  expect(execute).toHaveBeenCalledTimes(role === 'planner' ? 1 : 2)
  expect(response.interrupted).toEqual(interruption)
  expect(response.continuation).toEqual(saved)
  expect(response.model).toBe('local-worker')
  expect(response.provider).toBe('local')
  expect(response.requestId).toBeUndefined()
  expect(response.finalText).toContain(code)
  expect(response.finalText).toContain('Modell: local-worker; Abschluss: length.')
  expect(response.finalText).not.toContain('Rundenlimit')
  expect(response.agentRunEvaluations?.find(item => item.role === role)).toMatchObject({
    requestId: 'failed-round',
    interrupted: interruption,
    continuation: true,
  })
})

it.each(['runtime_empty_response', 'runtime_unsafe_response'])(
  'keeps worker evidence and the typed diagnosis when a reviewer returns %s',
  async code => {
    const interruption: AgentInterruption = {
      code,
      message: 'Keine verwertbare öffentliche Modellantwort.',
      round: 1,
      diagnostic: {
        target: 'local_llama_cpp',
        model: 'local-reviewer',
        finishReason: 'stop',
        durationMs: 1700,
        receivedCharacters: 0,
      },
    }
    const execute = vi.fn(async () => {
      if (execute.mock.calls.length === 1) return { ...result, finalText: 'Plan' }
      if (execute.mock.calls.length === 2)
        return { ...result, finalText: 'Belegter Arbeitsstand', requestId: 'worker-request' }
      return {
        ...result,
        finalText: 'Prüfmodell: local-reviewer; Abschluss: stop; 0 öffentliche Zeichen.',
        requestId: 'failed-reviewer-request',
        continuation: checkpoint,
        interrupted: interruption,
      }
    })

    const response = await runChatAgentTeam(
      { projectId: 'p', baseMessages: checkpoint.messages, mode: 'act', agentMode: true },
      gateway,
      { ...checkpoint },
      execute
    )

    expect(execute).toHaveBeenCalledTimes(3)
    expect(response.interrupted).toEqual(interruption)
    expect(response.requestId).toBeUndefined()
    expect(response.continuation).toEqual({ ...checkpoint, toolAccess: 'read-only' })
    expect(response.finalText).toContain('Belegter Arbeitsstand')
    expect(response.finalText).toContain(`Teamprüfung wurde nicht abgeschlossen (${code})`)
    expect(response.finalText).toContain('Prüfmodell: local-reviewer; Abschluss: stop; 0 öffentliche Zeichen.')
    expect(response.finalText).not.toContain('Rundenlimit')
  }
)

it('starts the reviewer from the latest checkpoint emitted by the worker', async () => {
  const workerCheckpoint = {
    ...checkpoint,
    objective: 'Aktueller Worker-Stand',
    completedMutations: [['saved', { ok: true }]] as AgentCheckpoint['completedMutations'],
  }
  const execute = vi.fn(async (options: RunAgentOptions) => {
    if (execute.mock.calls.length === 1) return { ...result, finalText: 'Plan' }
    if (execute.mock.calls.length === 2) {
      await options.onCheckpoint?.(workerCheckpoint)
      return { ...result, finalText: 'Arbeitsstand' }
    }
    expect(options.continuation).toMatchObject({
      objective: 'Aktueller Worker-Stand',
      completedMutations: workerCheckpoint.completedMutations,
    })
    return { ...result, finalText: 'Geprüfter Arbeitsstand' }
  })

  const response = await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'act', agentMode: true },
    gateway,
    { ...checkpoint },
    execute
  )

  expect(execute).toHaveBeenCalledTimes(3)
  expect(response.finalText).toBe('Geprüfter Arbeitsstand')
})

it('does not attribute a worker continuation to a successful reviewer request', async () => {
  const execute = vi.fn(async () => {
    if (execute.mock.calls.length === 1)
      return { ...result, finalText: 'Plan', requestId: 'planner-request', toolSuccesses: 0 }
    if (execute.mock.calls.length === 2)
      return {
        ...result,
        finalText: 'Arbeitsstand',
        requestId: 'worker-request',
        continuation: checkpoint,
        toolSuccesses: 2,
      }
    return { ...result, finalText: 'Geprüfter Zwischenstand', requestId: 'reviewer-request', toolSuccesses: 0 }
  })

  const response = await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'act', agentMode: true },
    gateway,
    { ...checkpoint },
    execute
  )

  expect(response.requestId).toBeUndefined()
  expect(response.continuation).toEqual(checkpoint)
  expect(response.agentRunEvaluations).toEqual([
    {
      requestId: 'planner-request',
      role: 'planner',
      toolFailures: 0,
      toolSuccesses: 0,
      continuation: false,
      interrupted: undefined,
    },
    {
      requestId: 'worker-request',
      role: 'worker',
      toolFailures: 0,
      toolSuccesses: 2,
      continuation: true,
      interrupted: undefined,
    },
    {
      requestId: 'reviewer-request',
      role: 'reviewer',
      toolFailures: 0,
      toolSuccesses: 0,
      continuation: false,
      interrupted: undefined,
    },
  ])
})

it('keeps each local agent tool outcome attached to its own request', async () => {
  const execute = vi.fn(async () => {
    if (execute.mock.calls.length === 1)
      return { ...result, finalText: 'Plan', requestId: 'planner-request', toolSuccesses: 0 }
    if (execute.mock.calls.length === 2)
      return {
        ...result,
        finalText: 'Arbeitsstand',
        requestId: 'worker-request',
        toolFailures: 1,
        toolSuccesses: 2,
      }
    return {
      ...result,
      finalText: 'Geprüfter Arbeitsstand',
      requestId: 'reviewer-request',
      toolFailures: 0,
      toolSuccesses: 0,
    }
  })

  const response = await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'act', agentMode: true },
    gateway,
    { ...checkpoint },
    execute
  )

  expect(response.requestId).toBe('reviewer-request')
  expect(response.toolFailures).toBe(1)
  expect(response.toolSuccesses).toBe(2)
  expect(response.agentRunEvaluations?.find(item => item.role === 'worker')).toMatchObject({
    requestId: 'worker-request',
    toolFailures: 1,
    toolSuccesses: 2,
  })
  expect(response.agentRunEvaluations?.find(item => item.role === 'reviewer')).toMatchObject({
    requestId: 'reviewer-request',
    toolFailures: 0,
    toolSuccesses: 0,
  })
})

it('labels a worker inference interruption as a model issue rather than a round limit', async () => {
  const execute = vi.fn(async () => {
    if (execute.mock.calls.length === 1) return result
    if (execute.mock.calls.length === 2)
      return {
        ...result,
        continuation: checkpoint,
        interrupted: {
          code: 'runtime_tool_contract_rejected',
          message: 'Das lokale Modell konnte die Werkzeugdaten nicht verarbeiten.',
          round: 5,
        },
      }
    return result
  })

  const response = await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'act', agentMode: true },
    gateway,
    { ...checkpoint },
    execute
  )

  expect(response.interrupted?.code).toBe('runtime_tool_contract_rejected')
  expect(response.finalText).toContain('lokalen Modellstörung')
  expect(response.finalText).not.toContain('Rundenlimit')
})

it('labels a reviewer inference interruption as a model issue rather than a round limit', async () => {
  const execute = vi.fn(async () => {
    if (execute.mock.calls.length === 1) return { ...result, finalText: 'Plan' }
    if (execute.mock.calls.length === 2) return { ...result, finalText: 'Belegter Arbeitsstand' }
    return {
      ...result,
      finalText: 'Die Prüfrunde wurde unterbrochen.',
      continuation: checkpoint,
      interrupted: {
        code: 'runtime_context_exceeded',
        message: 'Der Kontext wurde abgelehnt.',
        round: 2,
      },
    }
  })

  const response = await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'act', agentMode: true },
    gateway,
    { ...checkpoint },
    execute
  )

  expect(response.interrupted?.code).toBe('runtime_context_exceeded')
  expect(response.continuation).toEqual({ ...checkpoint, toolAccess: 'read-only' })
  expect(response.finalText).toContain('Belegter Arbeitsstand')
  expect(response.finalText).not.toContain('Die Prüfrunde wurde unterbrochen.')
  expect(response.finalText).toContain('Teamprüfung wurde nicht abgeschlossen')
  expect(response.finalText).toContain('lokalen Modellstörung')
  expect(response.finalText).not.toContain('Rundenlimit')
})

it('returns the worker result as unreviewed when the reviewer throws before producing a result', async () => {
  const savedWorkerCheckpoint = {
    ...checkpoint,
    completedMutations: [['worker-write', { ok: true }]] as AgentCheckpoint['completedMutations'],
  }
  const execute = vi.fn(async (options: RunAgentOptions) => {
    if (execute.mock.calls.length === 1) return { ...result, finalText: 'Plan', requestId: 'planner-request' }
    if (execute.mock.calls.length === 2) {
      await options.onCheckpoint?.(savedWorkerCheckpoint)
      return { ...result, finalText: 'Arbeitsstand', requestId: 'worker-request' }
    }
    throw new Error('Reviewer runtime failed')
  })

  const response = await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'act', agentMode: true },
    gateway,
    { ...checkpoint },
    execute
  )

  expect(execute).toHaveBeenCalledTimes(3)
  expect(response.finalText).toContain('Arbeitsstand')
  expect(response.finalText).toContain('Teamprüfung wurde nicht abgeschlossen')
  expect(response.interrupted).toMatchObject({
    code: 'execution_failed',
    message: 'Der Prüfagent wurde vor dem Abschluss unterbrochen.',
  })
  expect(response.requestId).toBeUndefined()
  expect(response.continuation).toMatchObject({
    toolAccess: 'read-only',
    completedMutations: savedWorkerCheckpoint.completedMutations,
  })
})

it('ignores an invalid reviewer result and preserves the valid worker result as needing review', async () => {
  const execute = vi.fn(async () => {
    if (execute.mock.calls.length === 1) return { ...result, finalText: 'Plan' }
    if (execute.mock.calls.length === 2) return { ...result, finalText: 'Arbeitsstand', requestId: 'worker-request' }
    return { ...result, finalText: '', requestId: 'invalid-reviewer-request' }
  })

  const response = await runChatAgentTeam(
    { projectId: 'p', baseMessages: checkpoint.messages, mode: 'act', agentMode: true },
    gateway,
    { ...checkpoint },
    execute
  )

  expect(response.finalText).toContain('Arbeitsstand')
  expect(response.finalText).toContain('Teamprüfung wurde nicht abgeschlossen')
  expect(response.interrupted?.code).toBe('invalid_result')
  expect(response.requestId).toBeUndefined()
  expect(response.continuation?.toolAccess).toBe('read-only')
})

it('preserves the original checkpoint when the global team deadline interrupts the planner', async () => {
  vi.useFakeTimers()
  try {
    const execute = vi.fn(
      (options: RunAgentOptions) =>
        new Promise<never>((_resolve, reject) => {
          options.interruptionSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('Deadline', 'AbortError')),
            { once: true }
          )
        })
    )
    const pending = runChatAgentTeam(
      { projectId: 'p', baseMessages: checkpoint.messages, mode: 'act', agentMode: true },
      gateway,
      { ...checkpoint },
      execute
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(execute).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5_000)
    const response = await pending

    expect(response.continuation).toEqual(checkpoint)
    expect(response.interrupted?.code).toBe('run_timeout')
    expect(response.requestId).toBeUndefined()
    expect(response.finalText).toContain('Planungsagent wurde vor dem ersten Ergebnis unterbrochen')
  } finally {
    vi.useRealTimers()
  }
})

it.each(['team_node_interrupted', 'runtime_empty_response'])(
  'keeps the global reviewer deadline authoritative when cancellation returns %s',
  async interruptedCode => {
    vi.useFakeTimers()
    try {
      const reviewerContinuation = { ...checkpoint, objective: 'Reviewer fortsetzen' }
      const execute = vi.fn((options: RunAgentOptions) => {
        if (execute.mock.calls.length === 1) return Promise.resolve({ ...result, finalText: 'Plan' })
        if (execute.mock.calls.length === 2)
          return Promise.resolve({ ...result, finalText: 'Arbeitsstand', requestId: 'worker-request' })
        return new Promise<
          typeof result & { continuation: AgentCheckpoint; interrupted: { code: string; message: string } }
        >(resolve => {
          options.interruptionSignal?.addEventListener(
            'abort',
            () =>
              resolve({
                ...result,
                finalText: 'Prüfung unterbrochen',
                continuation: reviewerContinuation,
                interrupted: { code: interruptedCode, message: 'Deadline' },
              }),
            {
              once: true,
            }
          )
        })
      })
      const pending = runChatAgentTeam(
        { projectId: 'p', baseMessages: checkpoint.messages, mode: 'act', agentMode: true },
        gateway,
        { ...checkpoint },
        execute
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(execute).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(5_000)
      const response = await pending

      expect(response.finalText).toContain('Arbeitsstand')
      expect(response.finalText).toContain('Teamprüfung wurde nicht abgeschlossen')
      expect(response.interrupted?.code).toBe('run_timeout')
      expect(response.requestId).toBeUndefined()
      expect(response.continuation).toEqual({ ...reviewerContinuation, toolAccess: 'read-only' })
    } finally {
      vi.useRealTimers()
    }
  }
)

it('uses parallel distinct external roles and passes their proposals only to the local tool worker', async () => {
  modelUsageSettings.value = { ...modelUsageSettings.value, externalEnabled: true }
  const outcomes: Array<{ role: string }> = []
  prepareSpecialists.mockResolvedValue({
    roles: ['research', 'coding', 'review'],
    preset: { max_parallel: 2 },
    promptCharacters: () => 100,
    execute: async (role: string) => {
      const value = { role, output: `PUBLIC-${role}`, model: `${role}:free`, tokenUsage: result.tokenUsage }
      outcomes.push(value)
      return value
    },
  })
  const calls: RunAgentOptions[] = []
  const rounds: number[] = []
  const execute = vi.fn(async (options: RunAgentOptions) => {
    calls.push(options)
    options.onRoundComplete?.({ round: 1, content: 'Local', kind: 'answer', serverSpeechAllowed: false })
    return result
  })
  const response = await runChatAgentTeam(
    {
      projectId: 'p',
      baseMessages: [{ role: 'user', content: 'LOCAL_SECRET' }],
      externalBaseMessages: [{ role: 'user', content: 'PUBLIC' }],
      requestAgentTeamApproval: () => true,
      mode: 'act',
      onRoundComplete: event => rounds.push(event.round),
    },
    gateway,
    { ...checkpoint, messages: [{ role: 'user', content: 'LOCAL_SECRET' }] },
    execute
  )
  expect(prepareSpecialists.mock.calls[0]![0].messages).toEqual([{ role: 'user', content: 'PUBLIC' }])
  expect(outcomes.map(value => value.role).sort()).toEqual(['coding', 'research', 'review'])
  expect(JSON.stringify(calls[1]!.baseMessages)).toContain('PUBLIC-coding')
  expect(calls.every(call => call.inferenceGateway === gateway)).toBe(true)
  expect(new Set(rounds).size).toBe(rounds.length)
  expect(response.specialistOutcomes).toHaveLength(3)
})
