import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentTeamOrchestrator, type AgentTeamDefinition } from '@/services/agents/teams'
import {
  DEFAULT_LOCAL_RESOURCE_CONFIG,
  LocalResourceController,
  type LocalResourceConfigState,
} from '@/services/inference/resources'

const project = {
  principalId: 'principal',
  projectId: 'project',
  projectName: 'Test',
  workspaceUpdatedAt: 1,
}
const definition: AgentTeamDefinition = {
  id: 'resource-team',
  label: 'Resource team',
  nodes: [
    {
      id: 'planner',
      label: 'Plan',
      role: 'planner',
      adapterId: 'chat',
      permission: 'read-only',
      dependencies: [],
      prompt: 'Plan the task.',
    },
    {
      id: 'worker',
      label: 'Work',
      role: 'implementer',
      adapterId: 'chat',
      permission: 'read-only',
      dependencies: ['planner'],
      prompt: 'Execute the task.',
    },
  ],
}
const flush = async () => {
  for (let index = 0; index < 50; index++) await Promise.resolve()
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function setup() {
  let state: LocalResourceConfigState = {
    requested: { ...DEFAULT_LOCAL_RESOURCE_CONFIG },
    applied: { ...DEFAULT_LOCAL_RESOURCE_CONFIG },
    revision: 0,
    appliedRevision: 0,
    pending: false,
    reasonCode: null,
  }
  const native = new Set<string>()
  const controller = new LocalResourceController({
    enabled: () => true,
    get: async () => structuredClone(state),
    set: async (config, revision) => {
      if (revision !== state.revision) throw new Error('resource_config_revision_conflict')
      state = { ...state, requested: config, revision: revision + 1, pending: true }
      return structuredClone(state)
    },
    apply: async () => {
      if (native.size) throw new Error('resource_config_busy')
      state = { ...state, applied: state.requested, appliedRevision: state.revision, pending: false }
      return structuredClone(state)
    },
    begin: async leaseId => {
      if (state.pending) throw new Error('resource_mode_switch_pending')
      native.add(leaseId)
      return { leaseId, resourceRevision: state.appliedRevision }
    },
    end: async leaseId => {
      native.delete(leaseId)
    },
  })
  return { controller, native }
}
afterEach(() => vi.useRealTimers())

describe('team scheduler and resource barrier integration', () => {
  it('finishes dependent children on the old revision before admitting a new top-level job', async () => {
    vi.useFakeTimers()
    const { controller, native } = setup()
    const first = deferred()
    const observed: Array<[string, number]> = []
    const teams = new AgentTeamOrchestrator({
      acquireResources: async (runId, signal) => (await controller.acquireGroup(`team:${runId}`, signal)).release,
      executor: request =>
        controller.run(
          async work => {
            observed.push([request.nodeId, work.resourceRevision])
            if (request.nodeId === 'planner') await first.promise
            return { output: 'Completed with evidence.' }
          },
          request.signal,
          controller.group(`team:${request.runId}`)
        ),
    })
    const run = teams.prepare(definition, { project, objective: 'Finish both steps.', approvalMode: 'team' })
    try {
      teams.approveRun(run.id)
      await flush()
      expect(observed).toEqual([['planner', 0]])
      await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'cpu' }, 0)
      const incoming = controller.acquire()
      await flush()
      first.resolve()
      await flush()
      await vi.advanceTimersByTimeAsync(200)
      const next = await incoming
      expect(observed).toEqual([
        ['planner', 0],
        ['worker', 0],
      ])
      expect(teams.getRun(run.id)?.status).toBe('completed')
      expect(next.work.resourceRevision).toBe(1)
      await next.release()
      expect(native.size).toBe(0)
    } finally {
      first.resolve()
      teams.dispose()
    }
  })

  it('cancels the last waiting node without waiting for another active workflow to finish', async () => {
    vi.useFakeTimers()
    const { controller, native } = setup()
    const other = await controller.acquire()
    await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'gpu' }, 0)
    const execute = vi.fn(async () => ({ output: 'Should not run.' }))
    const teams = new AgentTeamOrchestrator({
      acquireResources: async (runId, signal) => (await controller.acquireGroup(`team:${runId}`, signal)).release,
      executor: execute,
    })
    const run = teams.prepare(definition, { project, objective: 'Cancel queued work.', approvalMode: 'team' })
    try {
      teams.approveRun(run.id)
      await flush()
      teams.cancelNode(run.id, 'planner')
      await flush()
      expect(teams.getRun(run.id)?.nodes.find(node => node.id === 'planner')?.status).toBe('cancelled')
      expect(teams.getRun(run.id)?.status).toBe('failed')
      expect(execute).not.toHaveBeenCalled()
      expect(native.size).toBe(1)
      await other.release()
      await vi.advanceTimersByTimeAsync(200)
      expect(native.size).toBe(0)
      expect(controller.group(`team:${run.id}`)).toBeUndefined()
    } finally {
      teams.dispose()
      await other.release()
    }
  })

  it('does not begin a new resource wait after the run is cancelled during scope validation', async () => {
    vi.useFakeTimers()
    const scope = deferred()
    const { controller } = setup()
    const other = await controller.acquire()
    await controller.set({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'cpu' }, 0)
    const execute = vi.fn(async () => ({ output: 'Should not run.' }))
    const teams = new AgentTeamOrchestrator({
      validateScope: () => scope.promise,
      acquireResources: async (runId, signal) => (await controller.acquireGroup(`team:${runId}`, signal)).release,
      executor: execute,
    })
    const run = teams.prepare(definition, { project, objective: 'Cancel before admission.', approvalMode: 'team' })
    try {
      teams.approveRun(run.id)
      await flush()
      teams.cancelRun(run.id)
      scope.resolve()
      await flush()
      expect(teams.getRun(run.id)?.status).toBe('cancelled')
      expect(execute).not.toHaveBeenCalled()
    } finally {
      scope.resolve()
      teams.dispose()
      await other.release()
      await vi.advanceTimersByTimeAsync(200)
    }
  })
})
