import { expect, it, vi } from 'vitest'
import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import type { RunAgentOptions } from '@/services/agent'
const { prepareSpecialists } = vi.hoisted(() => ({ prepareSpecialists: vi.fn() }))
vi.mock('@/services/agents/externalSpecialists', () => ({ prepareExternalSpecialists: prepareSpecialists }))
vi.mock('@/services/toolLimits', () => ({ loadToolLimits: async () => ({ chat: 6, agent: 17 }) }))
vi.mock('@/services/agents/hub', () => ({
  agentProjectSnapshot: async () => ({ projectId: 'p', projectName: 'Project', principalId: 'account' }),
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
      return agentTeams.prepare(definition, input)
    },
  }
})
import { runChatAgentTeam } from '@/services/agents/chatOrchestration'
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
  expect(calls.map(call => call.toolAccess)).toEqual(['none', undefined, 'read-only'])
  expect(
    calls.every(call => !call.agentMode && call.inferenceGateway === gateway && call.contextEgress === 'local_only')
  ).toBe(true)
  expect(response.continuation).toEqual(checkpoint)
  expect(response.ephemeralDataUsed).toBe(true)
  expect(response.tokenUsage.totalTokens).toBe(21)
  expect(response.finalText).toContain('Rundenlimit')
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

it('uses parallel distinct external roles and passes their proposals only to the local tool worker', async () => {
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
