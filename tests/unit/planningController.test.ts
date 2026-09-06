import { describe, expect, it, vi } from 'vitest'
import type { ExecutionTicket } from '@/services/executionGate'
import { AgentTeamOrchestrator, type AgentTeamDefinition } from '@/services/agents/teams'
import type { AgentProjectSnapshot, AgentRunResult } from '@/services/agents/types'
import {
  createPlanningHub,
  type PlanningControllerDependencies,
  type PlanningPreparedJobInput,
} from '@/services/planning/controller'
import type { PlanningAnalysis, PlanningPlan } from '@/services/planning/types'

const PROJECT: AgentProjectSnapshot = {
  principalId: 'principal-1',
  projectId: 'project-1',
  projectName: 'Planning Project',
  rootPath: 'E:\\Project',
  workspaceUpdatedAt: 7,
}

const ANALYSIS: PlanningAnalysis = {
  summary: 'The requested change has two independently verifiable parts.',
  findings: ['The implementation path and its verification can be separated.'],
  evidence: ['src/example.ts was read in the synthetic adapter.'],
  assumptions: [],
  risks: ['A dependent step must not start before its prerequisite.'],
  openQuestions: [],
}

const PLAN: PlanningPlan = {
  objective: 'Implement the reviewed change safely.',
  analysis: ANALYSIS,
  steps: [
    {
      id: 'foundation',
      title: 'Foundation',
      description: 'Implement the bounded foundation.',
      dependencies: [],
      acceptanceCriteria: ['The foundation behavior is present.'],
      verification: ['Run the focused foundation check.'],
    },
    {
      id: 'integration',
      title: 'Integration',
      description: 'Connect and verify the foundation.',
      dependencies: ['foundation'],
      acceptanceCriteria: ['The integration uses the foundation.'],
      verification: ['Run the focused integration check.'],
    },
  ],
  completionCriteria: ['Both focused checks have concrete recorded results.'],
  outOfScope: ['Unrelated refactors.'],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function createHarness(options: { analysis?: PlanningAnalysis; plan?: PlanningPlan } = {}) {
  let gateGeneration = 1
  let mode: 'observe' | 'act' = 'act'
  let jobSequence = 0
  let teamSequence = 0
  let planningSequence = 0
  const preparedJobs: PlanningPreparedJobInput[] = []
  const jobInputs = new Map<string, PlanningPreparedJobInput>()
  const cancelledJobs: string[] = []
  const definitions: AgentTeamDefinition[] = []
  const teamExecutor = vi.fn(async request => {
    request.onPreparedPrompt(request.prompt.length)
    request.onPhase('running')
    request.onOutput(`live-${request.nodeId}`)
    return { output: `result-${request.nodeId}` }
  })
  const teams = new AgentTeamOrchestrator({
    executor: teamExecutor,
    validateScope: async () => undefined,
    createId: () => `team-${++teamSequence}`,
  })
  const validateScope = vi.fn(async (): Promise<void> => undefined)
  const executePreparedAgentJob = vi.fn(async (jobId: string, signal?: AbortSignal): Promise<AgentRunResult> => {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const input = jobInputs.get(jobId)!
    return {
      output: JSON.stringify(input.teamNodeId === 'analysis' ? (options.analysis ?? ANALYSIS) : (options.plan ?? PLAN)),
    }
  })
  const dependencies: PlanningControllerDependencies = {
    projectSnapshot: vi.fn(async () => PROJECT),
    validateScope,
    prepareAgentJob: vi.fn(async input => {
      preparedJobs.push(input)
      const id = `job-${++jobSequence}`
      jobInputs.set(id, input)
      return { id }
    }),
    cancelAgentJob: vi.fn(jobId => {
      cancelledJobs.push(jobId)
      return true
    }),
    executePreparedAgentJob,
    prepareAgentTeam: (definition, input) => {
      definitions.push(definition)
      return teams.prepare(definition, input)
    },
    approveAgentTeam: runId => teams.approveRun(runId),
    cancelAgentTeam: runId => teams.cancelRun(runId),
    getAgentTeam: runId => teams.getRun(runId),
    subscribeAgentTeams: listener => teams.subscribe(listener),
    captureExecution: signal =>
      Object.freeze({ sessionId: 'planning-test', generation: gateGeneration, signal: signal! }) as ExecutionTicket,
    assertExecution: (ticket, mutating = false) => {
      if (ticket.signal.aborted || ticket.generation !== gateGeneration) throw new Error('scope changed')
      if (mutating && mode === 'observe') throw new Error('observe mode')
    },
    createId: () => `planning-session-${++planningSequence}`,
    now: () => Date.UTC(2026, 8, 6, 8, 0, 0),
  }
  const hub = createPlanningHub(dependencies)
  return {
    hub,
    teams,
    dependencies,
    preparedJobs,
    cancelledJobs,
    definitions,
    teamExecutor,
    validateScope,
    executePreparedAgentJob,
    invalidateGate: () => gateGeneration++,
    setMode: (next: 'observe' | 'act') => {
      mode = next
    },
  }
}

describe('planning controller', () => {
  it('runs two approved read-only stages, then executes exactly the reviewed DAG only after the button call', async () => {
    const harness = createHarness()
    try {
      await harness.hub.analyze(PROJECT.projectId, { objective: PLAN.objective, adapterId: 'codex' })
      const reviewed = harness.hub.get(PROJECT.projectId)!
      expect(reviewed).toMatchObject({ status: 'review', revision: 1, plan: PLAN })
      expect(harness.preparedJobs.map(job => [job.teamRunId, job.teamNodeId, job.permission])).toEqual([
        ['planning-session-1', 'analysis', 'read-only'],
        ['planning-session-1', 'plan', 'read-only'],
      ])
      expect(harness.definitions).toHaveLength(0)
      expect(harness.teamExecutor).not.toHaveBeenCalled()

      await harness.hub.execute(PROJECT.projectId, {
        expectedSessionId: reviewed.id,
        expectedRevision: reviewed.revision,
        adapterId: 'codex',
        permission: 'read-only',
      })

      const definition = harness.definitions[0]!
      expect(definition.nodes.map(node => [node.id, node.role, node.dependencies])).toEqual([
        ['plan-step-1', 'implementer', []],
        ['plan-step-2', 'implementer', ['plan-step-1']],
        ['plan-final-review', 'reviewer', ['plan-step-1', 'plan-step-2']],
        ['plan-final-join', 'join', ['plan-step-1', 'plan-step-2', 'plan-final-review']],
      ])
      expect(definition.nodes.some(node => node.role === 'planner')).toBe(false)
      expect(definition.nodes.every(node => node.promptAssembly === 'exact-reviewed')).toBe(true)
      expect(definition.nodes[0]!.prompt).toContain(JSON.stringify(PLAN.steps[0]))
      expect(harness.hub.get(PROJECT.projectId)).toMatchObject({
        status: 'completed',
        output: expect.stringContaining('keine automatische Abnahme'),
      })
    } finally {
      harness.hub.dispose()
      harness.teams.dispose()
    }
  })

  it('rejects an invalid generated plan visibly and never prepares an execution team', async () => {
    const cyclic: PlanningPlan = {
      ...PLAN,
      steps: [
        { ...PLAN.steps[0]!, dependencies: ['integration'] },
        { ...PLAN.steps[1]!, dependencies: ['foundation'] },
      ],
    }
    const harness = createHarness({ plan: cyclic })
    try {
      await expect(
        harness.hub.analyze(PROJECT.projectId, { objective: PLAN.objective, adapterId: 'codex' })
      ).rejects.toThrow('zyklus')
      expect(harness.hub.get(PROJECT.projectId)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('zyklus'),
      })
      expect(harness.definitions).toHaveLength(0)
    } finally {
      harness.hub.dispose()
      harness.teams.dispose()
    }
  })

  it('cancels a staged job when the execution generation changes immediately after preparation', async () => {
    const harness = createHarness()
    vi.mocked(harness.dependencies.prepareAgentJob).mockImplementationOnce(async input => {
      harness.preparedJobs.push(input)
      harness.invalidateGate()
      return { id: 'orphan-candidate' }
    })
    try {
      await expect(
        harness.hub.analyze(PROJECT.projectId, { objective: PLAN.objective, adapterId: 'codex' })
      ).rejects.toThrow('scope changed')
      expect(harness.cancelledJobs).toContain('orphan-candidate')
      expect(harness.executePreparedAgentJob).not.toHaveBeenCalled()
      expect(harness.hub.get(PROJECT.projectId)?.status).toBe('interrupted')
    } finally {
      harness.hub.dispose()
      harness.teams.dispose()
    }
  })

  it('ignores a late analysis result after interruption and preserves a reviewed plan across later gate changes', async () => {
    const harness = createHarness()
    const late = deferred<AgentRunResult>()
    harness.executePreparedAgentJob.mockImplementationOnce(() => late.promise)
    try {
      const pending = harness.hub.analyze(PROJECT.projectId, { objective: PLAN.objective, adapterId: 'codex' })
      await vi.waitFor(() => expect(harness.executePreparedAgentJob).toHaveBeenCalledOnce())
      harness.hub.interruptActive()
      late.resolve({ output: JSON.stringify(ANALYSIS) })
      await expect(pending).rejects.toThrow()
      expect(harness.hub.get(PROJECT.projectId)).toMatchObject({ status: 'interrupted', plan: null })
      expect(harness.preparedJobs).toHaveLength(1)

      await harness.hub.analyze(PROJECT.projectId, { objective: PLAN.objective, adapterId: 'codex' })
      expect(harness.hub.get(PROJECT.projectId)?.status).toBe('review')
      harness.invalidateGate()
      harness.hub.interruptActive()
      expect(harness.hub.get(PROJECT.projectId)).toMatchObject({ status: 'review', plan: PLAN })
    } finally {
      harness.hub.dispose()
      harness.teams.dispose()
    }
  })

  it('blocks stale revisions, open questions, duplicate execution clicks and non-Codex mutations', async () => {
    const harness = createHarness()
    try {
      await harness.hub.analyze(PROJECT.projectId, { objective: PLAN.objective, adapterId: 'codex' })
      harness.hub.revise(PROJECT.projectId, {
        ...PLAN,
        steps: PLAN.steps.map(step => (step.id === 'foundation' ? { ...step, title: 'Reviewed foundation' } : step)),
      })
      await expect(
        harness.hub.execute(PROJECT.projectId, {
          expectedSessionId: harness.hub.get(PROJECT.projectId)!.id,
          expectedRevision: 1,
          adapterId: 'codex',
          permission: 'read-only',
        })
      ).rejects.toThrow('Revision')
      await expect(
        harness.hub.execute(PROJECT.projectId, {
          expectedSessionId: 'stale-planning-session',
          expectedRevision: 2,
          adapterId: 'codex',
          permission: 'read-only',
        })
      ).rejects.toThrow('Planungssitzung')
      expect(harness.definitions).toHaveLength(0)

      const running = harness.hub.execute(PROJECT.projectId, {
        expectedSessionId: harness.hub.get(PROJECT.projectId)!.id,
        expectedRevision: 2,
        adapterId: 'codex',
        permission: 'read-only',
      })
      await expect(
        harness.hub.execute(PROJECT.projectId, {
          expectedSessionId: harness.hub.get(PROJECT.projectId)!.id,
          expectedRevision: 1,
          adapterId: 'codex',
          permission: 'read-only',
        })
      ).rejects.toThrow('bereits')
      await running

      harness.hub.revise(PROJECT.projectId, {
        ...PLAN,
        analysis: { ...ANALYSIS, openQuestions: ['Which deployment target is approved?'] },
      })
      await expect(
        harness.hub.execute(PROJECT.projectId, {
          expectedSessionId: harness.hub.get(PROJECT.projectId)!.id,
          expectedRevision: 3,
          adapterId: 'codex',
          permission: 'read-only',
        })
      ).rejects.toThrow('Offene Fragen')
      harness.hub.revise(PROJECT.projectId, PLAN)
      await expect(
        harness.hub.execute(PROJECT.projectId, {
          expectedSessionId: harness.hub.get(PROJECT.projectId)!.id,
          expectedRevision: 4,
          adapterId: 'local',
          permission: 'workspace-write',
        })
      ).rejects.toThrow('ausschließlich mit Codex')
    } finally {
      harness.hub.dispose()
      harness.teams.dispose()
    }
  })

  it('rechecks scope after awaits and enforces the fresh mutating execution ticket', async () => {
    const harness = createHarness()
    const result = deferred<AgentRunResult>()
    let scopeValid = true
    harness.validateScope.mockImplementation(async () => {
      if (!scopeValid) throw new Error('workspace changed')
    })
    harness.executePreparedAgentJob.mockImplementationOnce(() => result.promise)
    try {
      const pending = harness.hub.analyze(PROJECT.projectId, { objective: PLAN.objective, adapterId: 'codex' })
      await vi.waitFor(() => expect(harness.executePreparedAgentJob).toHaveBeenCalledOnce())
      scopeValid = false
      result.resolve({ output: JSON.stringify(ANALYSIS) })
      await expect(pending).rejects.toThrow('workspace changed')
      expect(harness.hub.get(PROJECT.projectId)?.status).toBe('interrupted')

      scopeValid = true
      await harness.hub.analyze(PROJECT.projectId, { objective: PLAN.objective, adapterId: 'codex' })
      harness.setMode('observe')
      await expect(
        harness.hub.execute(PROJECT.projectId, {
          expectedSessionId: harness.hub.get(PROJECT.projectId)!.id,
          expectedRevision: 1,
          adapterId: 'codex',
          permission: 'workspace-write',
        })
      ).rejects.toThrow('observe mode')
      expect(harness.definitions).toHaveLength(0)
    } finally {
      harness.hub.dispose()
      harness.teams.dispose()
    }
  })

  it('exports only a passive reviewed source and restores it against the current principal and canonical workspace', async () => {
    const source = createHarness()
    const target = createHarness()
    try {
      await source.hub.analyze(PROJECT.projectId, { objective: PLAN.objective, adapterId: 'codex' })
      const exported = source.hub.export(PROJECT.projectId)
      const payload = JSON.parse(exported) as { session: Record<string, unknown> }
      expect(payload.session).toMatchObject({ status: 'review', execution: null, error: '', output: '' })

      payload.session.project = { ...PROJECT, rootPath: 'e:/project/' }
      await target.hub.restore(PROJECT.projectId, JSON.stringify(payload))
      expect(target.hub.get(PROJECT.projectId)).toMatchObject({
        status: 'review',
        revision: 2,
        execution: null,
        plan: PLAN,
      })
      expect(target.preparedJobs).toHaveLength(0)
      expect(target.definitions).toHaveLength(0)

      payload.session.project = { ...PROJECT, principalId: 'other-principal' }
      await expect(target.hub.restore(PROJECT.projectId, JSON.stringify(payload))).rejects.toThrow(
        'Konto oder Workspace'
      )
    } finally {
      source.hub.dispose()
      source.teams.dispose()
      target.hub.dispose()
      target.teams.dispose()
    }
  })

  it('keeps passive project drafts separately and clears all private planning state on identity change', async () => {
    const harness = createHarness()
    vi.mocked(harness.dependencies.projectSnapshot).mockImplementation(async projectId => ({
      ...PROJECT,
      projectId,
      projectName: projectId,
    }))
    try {
      await harness.hub.analyze('project-1', { objective: PLAN.objective, adapterId: 'codex' })
      await harness.hub.analyze('project-2', { objective: PLAN.objective, adapterId: 'codex' })
      expect(harness.hub.get('project-1')?.status).toBe('review')
      expect(harness.hub.get('project-2')?.status).toBe('review')

      harness.hub.clearAll()
      expect(harness.hub.get('project-1')).toBeNull()
      expect(harness.hub.get('project-2')).toBeNull()
    } finally {
      harness.hub.dispose()
      harness.teams.dispose()
    }
  })

  it('fails promptly and cancels when a prepared team run disappears before observation', async () => {
    const harness = createHarness()
    try {
      await harness.hub.analyze(PROJECT.projectId, { objective: PLAN.objective, adapterId: 'codex' })
      vi.spyOn(harness.dependencies, 'getAgentTeam').mockReturnValue(undefined)
      await expect(
        harness.hub.execute(PROJECT.projectId, {
          expectedSessionId: harness.hub.get(PROJECT.projectId)!.id,
          expectedRevision: 1,
          adapterId: 'codex',
          permission: 'read-only',
        })
      ).rejects.toThrow('nicht mehr verfügbar')
      expect(harness.hub.get(PROJECT.projectId)?.status).toBe('interrupted')
    } finally {
      harness.hub.dispose()
      harness.teams.dispose()
    }
  })
})
