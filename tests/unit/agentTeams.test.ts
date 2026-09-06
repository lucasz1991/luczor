import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentTeamOrchestrator,
  createStandardAgentTeamDefinition,
  type AgentTeamDefinition,
  type AgentTeamExecutionRequest,
} from '@/services/agents/teams'
import type { AgentProjectSnapshot, AgentRunResult } from '@/services/agents/types'

const PROJECT: AgentProjectSnapshot = {
  principalId: 'principal',
  projectId: 'project',
  projectName: 'Project',
  rootPath: 'E:\\project',
  workspaceUpdatedAt: 1,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 16; index++) await Promise.resolve()
}

function twoRoots(adapterId: 'codex' | 'local' = 'codex'): AgentTeamDefinition {
  return {
    id: `two-${adapterId}`,
    label: 'Two roots',
    maxParallel: 2,
    nodes: [
      {
        id: 'one',
        label: 'One',
        role: 'planner',
        adapterId,
        permission: 'read-only',
        dependencies: [],
        prompt: 'First task',
      },
      {
        id: 'two',
        label: 'Two',
        role: 'reviewer',
        adapterId,
        permission: 'read-only',
        dependencies: [],
        prompt: 'Second task',
      },
    ],
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('agent team DAG scheduler', () => {
  it('preserves reviewed-plan assembly through scheduling and rejects unknown assembly modes', async () => {
    const requests: AgentTeamExecutionRequest[] = []
    const teams = new AgentTeamOrchestrator({
      executor: async request => {
        requests.push(request)
        request.onPreparedPrompt(request.prompt.length)
        return { output: 'done' }
      },
    })
    const definition = twoRoots()
    const run = teams.prepare(
      {
        ...definition,
        nodes: definition.nodes.map(node => ({
          ...node,
          promptAssembly: 'exact-reviewed' as const,
        })),
      },
      { project: PROJECT, objective: 'Execute the reviewed plan.', approvalMode: 'team' }
    )
    teams.approveRun(run.id)
    await vi.waitFor(() => expect(teams.getRun(run.id)?.status).toBe('completed'))
    expect(requests).toHaveLength(2)
    expect(requests.every(request => request.promptAssembly === 'exact-reviewed')).toBe(true)
    expect(() =>
      teams.prepare(
        {
          ...definition,
          nodes: definition.nodes.map(node => ({
            ...node,
            promptAssembly: 'untrusted' as 'project',
          })),
        },
        { project: PROJECT, objective: 'Invalid.', approvalMode: 'team' }
      )
    ).toThrow('Kontextzusammenstellung')
    teams.dispose()
  })
  it('runs a planner, two parallel workers, reviewer and join with structured predecessor records', async () => {
    const calls: AgentTeamExecutionRequest[] = []
    const workers = new Map<string, ReturnType<typeof deferred<AgentRunResult>>>()
    const executor = vi.fn(async (request: AgentTeamExecutionRequest) => {
      calls.push(request)
      request.onPhase('running')
      if (request.nodeId.startsWith('implementer')) {
        const gate = deferred<AgentRunResult>()
        workers.set(request.nodeId, gate)
        return gate.promise
      }
      return { output: `${request.nodeId}-output` }
    })
    const teams = new AgentTeamOrchestrator({ executor, maxConcurrent: 3 })
    const run = teams.prepare(
      createStandardAgentTeamDefinition({ planner: 'codex', implementer: 'codex', reviewer: 'codex' }),
      { project: PROJECT, objective: 'Build and verify the feature.', approvalMode: 'team' }
    )

    teams.approveRun(run.id)
    await vi.waitFor(() =>
      expect(calls.map(call => call.nodeId)).toEqual(['planner', 'implementer-primary', 'implementer-edge'])
    )
    expect(calls[1]!.prompt).toContain('"nodeId":"planner"')
    expect(calls[1]!.prompt).toContain('planner-output')
    workers.get('implementer-primary')!.resolve({ output: 'primary-output' })
    workers.get('implementer-edge')!.resolve({ output: 'edge-output' })
    await vi.waitFor(() => expect(calls.some(call => call.nodeId === 'reviewer')).toBe(true))
    const review = calls.find(call => call.nodeId === 'reviewer')!
    expect(review.prompt).toContain('primary-output')
    expect(review.prompt).toContain('edge-output')
    await vi.waitFor(() => expect(calls.some(call => call.nodeId === 'join')).toBe(true))
    const join = calls.find(call => call.nodeId === 'join')!
    expect(join.prompt).toContain('reviewer-output')
    await vi.waitFor(() => expect(teams.getRun(run.id)?.status).toBe('completed'))
    expect(teams.getRun(run.id)?.nodes.every(node => node.status === 'completed')).toBe(true)
  })

  it('serializes the local GPU while allowing two Codex readers on one workspace', async () => {
    const localGates: ReturnType<typeof deferred<AgentRunResult>>[] = []
    const localCalls: AgentTeamExecutionRequest[] = []
    const localTeams = new AgentTeamOrchestrator({
      maxConcurrent: 3,
      executor: async request => {
        localCalls.push(request)
        const gate = deferred<AgentRunResult>()
        localGates.push(gate)
        return gate.promise
      },
    })
    const localRun = localTeams.prepare(twoRoots('local'), {
      project: PROJECT,
      objective: 'Use the local runtime fairly.',
      approvalMode: 'team',
    })
    localTeams.approveRun(localRun.id)
    await flush()
    expect(localCalls).toHaveLength(1)
    localGates[0]!.resolve({ output: 'one' })
    await flush()
    expect(localCalls).toHaveLength(2)
    localTeams.cancelRun(localRun.id)
    localGates[1]!.resolve({ output: 'late' })

    const readGates: ReturnType<typeof deferred<AgentRunResult>>[] = []
    const readCalls: AgentTeamExecutionRequest[] = []
    const readTeams = new AgentTeamOrchestrator({
      maxConcurrent: 3,
      executor: async request => {
        readCalls.push(request)
        const gate = deferred<AgentRunResult>()
        readGates.push(gate)
        return gate.promise
      },
    })
    const readRun = readTeams.prepare(twoRoots('codex'), {
      project: PROJECT,
      objective: 'Read in parallel.',
      approvalMode: 'team',
    })
    readTeams.approveRun(readRun.id)
    await flush()
    expect(readCalls).toHaveLength(2)
    readTeams.cancelRun(readRun.id)
    readGates.forEach(gate => gate.resolve({ output: 'late' }))
  })

  it('uses reader-writer workspace leases and starts a writer only after both readers settle', async () => {
    const calls: AgentTeamExecutionRequest[] = []
    const gates = new Map<string, ReturnType<typeof deferred<AgentRunResult>>>()
    const definition: AgentTeamDefinition = {
      ...twoRoots(),
      id: 'readers-writer',
      maxParallel: 3,
      nodes: [
        ...twoRoots().nodes,
        {
          id: 'writer',
          label: 'Writer',
          role: 'implementer',
          adapterId: 'codex',
          permission: 'workspace-write',
          dependencies: [],
          prompt: 'Write only after readers release the workspace.',
        },
      ],
    }
    const teams = new AgentTeamOrchestrator({
      maxConcurrent: 3,
      executor: async request => {
        calls.push(request)
        const gate = deferred<AgentRunResult>()
        gates.set(request.nodeId, gate)
        return gate.promise
      },
    })
    const run = teams.prepare(definition, {
      project: PROJECT,
      objective: 'Exercise workspace leases.',
      approvalMode: 'team',
    })
    teams.approveRun(run.id)
    await flush()
    expect(calls.map(call => call.nodeId)).toEqual(['one', 'two'])
    gates.get('one')!.resolve({ output: 'one' })
    await flush()
    expect(calls).toHaveLength(2)
    gates.get('two')!.resolve({ output: 'two' })
    await flush()
    expect(calls.map(call => call.nodeId)).toEqual(['one', 'two', 'writer'])
    teams.cancelRun(run.id)
    gates.get('writer')!.resolve({ output: 'late' })
  })

  it('propagates failure to descendants without cancelling independent completed work', async () => {
    const teams = new AgentTeamOrchestrator({
      executor: async request => {
        if (request.nodeId === 'one') throw new Error('private provider failure')
        return { output: 'independent result' }
      },
    })
    const definition: AgentTeamDefinition = {
      id: 'failure-propagation',
      label: 'Failure propagation',
      nodes: [
        twoRoots().nodes[0]!,
        twoRoots().nodes[1]!,
        {
          id: 'child',
          label: 'Child',
          role: 'reviewer',
          adapterId: 'codex',
          permission: 'read-only',
          dependencies: ['one'],
          prompt: 'Must not run after failure.',
        },
      ],
    }
    const run = teams.prepare(definition, { project: PROJECT, objective: 'Test propagation.', approvalMode: 'team' })
    teams.approveRun(run.id)
    await vi.waitFor(() => expect(teams.getRun(run.id)?.status).toBe('failed'))
    const nodes = teams.getRun(run.id)!.nodes
    expect(nodes.find(node => node.id === 'one')).toMatchObject({ status: 'failed', errorCode: 'execution_failed' })
    expect(nodes.find(node => node.id === 'two')).toMatchObject({ status: 'completed' })
    expect(nodes.find(node => node.id === 'child')).toMatchObject({ status: 'skipped', errorCode: 'dependency_failed' })
  })

  it('keeps a cancelled worker slot occupied until its executor settles, then serves another run', async () => {
    const gates: ReturnType<typeof deferred<AgentRunResult>>[] = []
    const calls: AgentTeamExecutionRequest[] = []
    const teams = new AgentTeamOrchestrator({
      maxConcurrent: 1,
      executor: async request => {
        calls.push(request)
        const gate = deferred<AgentRunResult>()
        gates.push(gate)
        return gate.promise
      },
    })
    const first = teams.prepare(twoRoots(), { project: PROJECT, objective: 'First run.', approvalMode: 'team' })
    const second = teams.prepare(twoRoots(), { project: PROJECT, objective: 'Second run.', approvalMode: 'team' })
    teams.approveRun(first.id)
    teams.approveRun(second.id)
    await flush()
    expect(calls).toHaveLength(1)
    teams.cancelRun(first.id)
    await flush()
    expect(calls).toHaveLength(1)
    gates[0]!.resolve({ output: 'late' })
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.runId).toBe(second.id)
    teams.cancelRun(second.id)
    gates[1]!.resolve({ output: 'late' })
  })

  it('round-robins ready nodes across runs instead of draining the oldest run', async () => {
    const gates: ReturnType<typeof deferred<AgentRunResult>>[] = []
    const calls: AgentTeamExecutionRequest[] = []
    const teams = new AgentTeamOrchestrator({
      maxConcurrent: 1,
      executor: async request => {
        calls.push(request)
        const gate = deferred<AgentRunResult>()
        gates.push(gate)
        return gate.promise
      },
    })
    const first = teams.prepare(twoRoots(), { project: PROJECT, objective: 'First.', approvalMode: 'team' })
    const second = teams.prepare(twoRoots(), {
      project: { ...PROJECT, projectId: 'other' },
      objective: 'Second.',
      approvalMode: 'team',
    })
    teams.approveRun(first.id)
    teams.approveRun(second.id)
    await flush()
    expect(calls[0]!.runId).toBe(first.id)
    gates[0]!.resolve({ output: 'done' })
    await flush()
    expect(calls[1]!.runId).toBe(second.id)
    teams.cancelRun(first.id)
    teams.cancelRun(second.id)
    gates[1]!.resolve({ output: 'late' })
  })

  it('expires team and per-node approvals and exposes structured timeout codes', async () => {
    vi.useFakeTimers()
    const executor = vi.fn(async () => ({ output: 'done' }))
    const teams = new AgentTeamOrchestrator({ executor })
    const expired = teams.prepare(
      { ...twoRoots(), approvalTimeoutMs: 1_000 },
      { project: PROJECT, objective: 'Never approved.', approvalMode: 'team' }
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(teams.getRun(expired.id)).toMatchObject({ status: 'cancelled', errorCode: 'approval_expired' })

    const perNode = teams.prepare(
      { ...twoRoots(), id: 'per-node-timeout', approvalTimeoutMs: 1_000 },
      { project: PROJECT, objective: 'Node approval expires.', approvalMode: 'per-node' }
    )
    teams.approveRun(perNode.id)
    expect(teams.getRun(perNode.id)?.nodes[0]?.status).toBe('awaiting_approval')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(teams.getRun(perNode.id)?.status).toBe('failed')
    expect(teams.getRun(perNode.id)?.nodes.every(node => node.errorCode === 'approval_expired')).toBe(true)
    expect(executor).not.toHaveBeenCalled()
  })

  it('enforces total prompt and run-time budgets', async () => {
    const promptTeams = new AgentTeamOrchestrator({ executor: async () => ({ output: 'done' }) })
    const promptDefinition: AgentTeamDefinition = {
      ...twoRoots(),
      id: 'prompt-budget',
      maxPromptCharacters: 2_000,
      nodes: twoRoots().nodes.map(node => ({ ...node, prompt: 'x'.repeat(900), maxPromptCharacters: 2_000 })),
    }
    const promptRun = promptTeams.prepare(promptDefinition, {
      project: PROJECT,
      objective: 'y'.repeat(200),
      approvalMode: 'team',
    })
    promptTeams.approveRun(promptRun.id)
    await vi.waitFor(() => expect(promptTeams.getRun(promptRun.id)?.status).toBe('failed'))
    expect(promptTeams.getRun(promptRun.id)?.nodes.some(node => node.errorCode === 'prompt_budget_exceeded')).toBe(true)

    const assembledTeams = new AgentTeamOrchestrator({
      executor: async request => {
        request.onPreparedPrompt(2_001)
        return { output: 'must not be accepted' }
      },
    })
    const assembledRun = assembledTeams.prepare(
      {
        ...twoRoots(),
        id: 'assembled-prompt-budget',
        nodes: twoRoots().nodes.map(item => ({ ...item, maxPromptCharacters: 2_000 })),
      },
      { project: PROJECT, objective: 'Count the final provider prompt.', approvalMode: 'team' }
    )
    assembledTeams.approveRun(assembledRun.id)
    await vi.waitFor(() => expect(assembledTeams.getRun(assembledRun.id)?.status).toBe('failed'))
    expect(
      assembledTeams.getRun(assembledRun.id)?.nodes.every(item => item.errorCode === 'prompt_budget_exceeded')
    ).toBe(true)

    vi.useFakeTimers()
    const gate = deferred<AgentRunResult>()
    const timedTeams = new AgentTeamOrchestrator({ executor: async () => gate.promise })
    const timedRun = timedTeams.prepare(
      { ...twoRoots(), id: 'run-timeout', deadlineMs: 5_000 },
      { project: PROJECT, objective: 'Time bounded.', approvalMode: 'team' }
    )
    timedTeams.approveRun(timedRun.id)
    await flush()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(timedTeams.getRun(timedRun.id)).toMatchObject({ status: 'cancelling', errorCode: 'run_timeout' })
    gate.resolve({ output: 'late' })
    await flush()
    expect(timedTeams.getRun(timedRun.id)).toMatchObject({ status: 'failed', errorCode: 'run_timeout' })
  })
})
