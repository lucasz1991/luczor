import { describe, expect, it, vi } from 'vitest'
import type { ExecutionTicket } from '@/services/executionGate'
import type { AgentProjectSnapshot } from '@/services/agents/types'
import {
  createPlanningHub,
  type PlanningControllerDependencies,
  type PlanningPreparedJobInput,
} from '@/services/planning/controller'
import type { PlanningAnalysis, PlanningPlan } from '@/services/planning/types'

const PROJECT_ID = 'shared-project-id'
const OBJECTIVE = 'Improve the project.'

function analysis(principalId: string): PlanningAnalysis {
  return {
    summary: `Private analysis for ${principalId}.`,
    findings: ['A bounded project change is needed.'],
    evidence: [`Provided context belongs to ${principalId}.`],
    assumptions: [],
    risks: [],
    openQuestions: [],
  }
}

function plan(principalId: string): PlanningPlan {
  return {
    objective: OBJECTIVE,
    analysis: analysis(principalId),
    steps: [
      {
        id: 'change',
        title: 'Apply the reviewed change',
        description: 'Implement the bounded project change.',
        dependencies: [],
        acceptanceCriteria: ['The requested behavior is present.'],
        verification: ['Run the focused regression test.'],
      },
    ],
    completionCriteria: ['The focused test passes.'],
    outOfScope: ['Deployment.'],
  }
}

function harness() {
  let principalId = 'account-a'
  let sessionSequence = 0
  let jobSequence = 0
  const jobs = new Map<string, PlanningPreparedJobInput>()
  const dependencies: PlanningControllerDependencies = {
    projectSnapshot: vi.fn(async (): Promise<AgentProjectSnapshot> => ({
      principalId,
      projectId: PROJECT_ID,
      projectName: 'Private project',
      rootPath: 'E:\\PrivateProject',
      workspaceUpdatedAt: 1,
    })),
    validateScope: vi.fn(async project => {
      if (project.principalId !== principalId) throw new Error('Account changed')
    }),
    prepareAgentJob: vi.fn(async input => {
      const id = `job-${++jobSequence}`
      jobs.set(id, input)
      return { id }
    }),
    cancelAgentJob: vi.fn(() => true),
    executePreparedAgentJob: vi.fn(async jobId => {
      const input = jobs.get(jobId)!
      const jobPrincipal = input.expectedProject!.principalId
      return { output: JSON.stringify(input.teamNodeId === 'analysis' ? analysis(jobPrincipal) : plan(jobPrincipal)) }
    }),
    prepareAgentTeam: vi.fn(() => {
      throw new Error('A stale approval must never prepare a team')
    }),
    approveAgentTeam: vi.fn(() => false),
    cancelAgentTeam: vi.fn(() => true),
    getAgentTeam: vi.fn(() => undefined),
    subscribeAgentTeams: () => () => {},
    captureExecution: signal => ({ sessionId: 'gate', generation: 1, signal }) as ExecutionTicket,
    assertExecution: ticket => {
      if (ticket.signal.aborted) throw new Error('Aborted execution')
    },
    createId: () => `planning-session-${++sessionSequence}`,
  }
  return {
    dependencies,
    hub: createPlanningHub(dependencies),
    setPrincipal: (next: string) => {
      principalId = next
    },
  }
}

describe('planning session approval and principal race regressions', () => {
  it('rejects a real prior-session approval when a new analysis reuses revision one', async () => {
    const { hub, dependencies } = harness()
    try {
      await hub.analyze(PROJECT_ID, { objective: OBJECTIVE, adapterId: 'codex' })
      const first = hub.get(PROJECT_ID)!
      await hub.analyze(PROJECT_ID, { objective: OBJECTIVE, adapterId: 'codex' })
      const second = hub.get(PROJECT_ID)!
      expect(second.revision).toBe(first.revision)
      expect(second.id).not.toBe(first.id)
      await expect(
        hub.execute(PROJECT_ID, {
          expectedSessionId: first.id,
          expectedRevision: first.revision,
          adapterId: 'codex',
          permission: 'workspace-write',
        })
      ).rejects.toThrow('Planungssitzung')
      expect(dependencies.prepareAgentTeam).not.toHaveBeenCalled()
      expect(hub.get(PROJECT_ID)).toEqual(second)
    } finally {
      hub.dispose()
    }
  })

  it('creates a fresh import identity when imported revision advancement collides with an existing approval', async () => {
    const { hub, dependencies } = harness()
    try {
      await hub.analyze(PROJECT_ID, { objective: OBJECTIVE, adapterId: 'codex' })
      const exported = hub.export(PROJECT_ID)
      hub.revise(PROJECT_ID, plan('account-a'))
      const reviewed = hub.get(PROJECT_ID)!
      await hub.restore(PROJECT_ID, exported)
      const restored = hub.get(PROJECT_ID)!
      expect(restored.revision).toBe(reviewed.revision)
      expect(restored.id).not.toBe(reviewed.id)
      expect(restored.status).toBe('review')
      expect(dependencies.prepareAgentTeam).not.toHaveBeenCalled()
      await expect(
        hub.execute(PROJECT_ID, {
          expectedSessionId: reviewed.id,
          expectedRevision: reviewed.revision,
          adapterId: 'codex',
          permission: 'workspace-write',
        })
      ).rejects.toThrow('Planungssitzung')
      expect(dependencies.prepareAgentTeam).not.toHaveBeenCalled()
    } finally {
      hub.dispose()
    }
  })

  it('cancels late account-A preparation without starting it or overwriting account-B state for the same project', async () => {
    const { hub, dependencies, setPrincipal } = harness()
    let resolvePreparation!: (job: { id: string }) => void
    const delayedPreparation = new Promise<{ id: string }>(resolve => {
      resolvePreparation = resolve
    })
    vi.mocked(dependencies.prepareAgentJob).mockImplementationOnce(() => delayedPreparation)
    try {
      const oldRun = hub.analyze(PROJECT_ID, { objective: OBJECTIVE, adapterId: 'codex' })
      const oldRunFailure = oldRun.then(
        () => undefined,
        (error: unknown) => error
      )
      await vi.waitFor(() => expect(dependencies.prepareAgentJob).toHaveBeenCalledOnce())
      expect(hub.get(PROJECT_ID)?.project.principalId).toBe('account-a')

      hub.clearAll()
      setPrincipal('account-b')
      expect(hub.get(PROJECT_ID)).toBeNull()
      await hub.analyze(PROJECT_ID, { objective: OBJECTIVE, adapterId: 'codex' })
      const newSession = hub.get(PROJECT_ID)!
      expect(newSession).toMatchObject({
        status: 'review',
        project: { principalId: 'account-b' },
        plan: plan('account-b'),
      })

      resolvePreparation({ id: 'late-account-a-job' })
      expect(await oldRunFailure).toMatchObject({ name: 'AbortError' })
      expect(dependencies.cancelAgentJob).toHaveBeenCalledWith('late-account-a-job')
      expect(vi.mocked(dependencies.executePreparedAgentJob).mock.calls.map(call => call[0])).not.toContain(
        'late-account-a-job'
      )
      expect(hub.get(PROJECT_ID)).toEqual(newSession)
      expect(dependencies.prepareAgentTeam).not.toHaveBeenCalled()
    } finally {
      hub.dispose()
    }
  })
})
