import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  prepare: vi.fn(),
  execute: vi.fn(),
}))

vi.mock('@/state/store', () => ({
  state: {
    global: { ui: { lastProjectId: 'active' } },
    projects: [{ id: 'active', name: 'Active', archivedAt: null }],
  },
}))
vi.mock('@/services/agents/hub', () => ({
  agentProjectSnapshot: mocks.snapshot,
  prepareAgentJob: mocks.prepare,
}))
vi.mock('@/services/agents/managedJob', () => ({ executePreparedAgentJob: mocks.execute }))

import { runWorkflowAgent } from '@/services/agents/workflowAgent'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.snapshot.mockResolvedValue({
    principalId: 'principal',
    projectId: 'active',
    projectName: 'Active',
    rootPath: 'E:\\Project',
    workspaceUpdatedAt: 1,
  })
  mocks.prepare.mockResolvedValue({ id: 'managed-job' })
  mocks.execute.mockResolvedValue({ output: 'Done' })
})

describe('managed workflow agent bridge', () => {
  it('keeps the signed reviewed prompt exact and dispatches it through a managed workspace-write job', async () => {
    await expect(runWorkflowAgent('codex', 'Exact signed prompt', 'e:/project')).resolves.toEqual({
      ok: true,
      code: 0,
      stdout: 'Done',
      stderr: '',
    })
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'active',
        prompt: 'Exact signed prompt',
        role: 'implementer',
        permission: 'workspace-write',
        promptAssembly: 'exact-reviewed',
      })
    )
    expect(mocks.execute).toHaveBeenCalledWith('managed-job', undefined)
  })

  it('rejects unmanaged agents and any project directory outside the exact active workspace', async () => {
    await expect(runWorkflowAgent('other', 'Task')).rejects.toThrow('verwalteter Luczor-Agent')
    await expect(runWorkflowAgent('codex', 'Task', 'E:\\other')).rejects.toThrow('aktiven Luczor-Projekt')
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('preserves confirmed worker observations and an explicit read-only role through the real job lifecycle', async () => {
    const effortSelection = {
      tier: 'fast',
      requestedEffort: 'high',
      appliedEffort: 'high',
      status: 'confirmed',
      reason: 'role_requires_deeper_review',
    }
    const runtimeEvidence = { model: 'actual-runtime-model', modelSource: 'runtime', toolGateChecks: 3 }
    mocks.execute.mockResolvedValue({ output: 'Reviewed', effortSelection, runtimeEvidence })
    expect(
      await runWorkflowAgent('claude', 'Review exact', undefined, undefined, 'active', {
        role: 'reviewer',
        permission: 'read-only',
        thinkingTier: 'fast',
      })
    ).toMatchObject({ effortSelection, runtimeEvidence, stdout: 'Reviewed' })
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ permission: 'read-only', role: 'reviewer', prompt: 'Review exact' })
    )
  })

  it('forwards cancellation and waits on the managed job promise', async () => {
    const controller = new AbortController()
    mocks.execute.mockImplementation(async (_id, signal: AbortSignal) => {
      expect(signal).toBe(controller.signal)
      throw new DOMException('cancelled', 'AbortError')
    })
    controller.abort()
    await expect(runWorkflowAgent('codex', 'Task', undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
