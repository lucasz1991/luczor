import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), workspace: vi.fn(), principal: vi.fn(), session: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/services/projectWorkspace', () => ({
  requireProjectWorkspace: mocks.workspace,
  resolveWorkspacePrincipalId: mocks.principal,
}))
vi.mock('@/services/tools/toolSessionCoordinator', () => ({ getToolSession: mocks.session }))
vi.mock('@/services/executionGate', () => ({
  executionGate: {
    capture: (signal?: AbortSignal) => ({ signal }),
    assert: (ticket: { signal?: AbortSignal }) => ticket.signal?.throwIfAborted(),
  },
  executionPayload: async () => ({ sessionId: 'session', generation: 1 }),
}))
import { terminalTools } from '@/services/tools/terminal'

const scope = {
  principalId: 'person',
  projectId: 'project',
  runId: '11111111-1111-4111-8111-111111111111',
  expectedRootPath: 'E:/frozen-workcopy',
  expectedWorkspaceUpdatedAt: 42,
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.workspace.mockResolvedValue({ rootPath: 'E:/canonical', updatedAt: 42, status: 'ready' })
  mocks.principal.mockResolvedValue('person')
  mocks.invoke.mockResolvedValue({ ok: true, stdout: 'Build complete' })
})
describe('workflow local-agent terminal', () => {
  it('runs in the registered copy and keeps workflow cancellation identity', async () => {
    await terminalTools[0]!.execute(
      { runtime: 'node', code: 'console.log(process.cwd())' },
      { projectId: 'project', workflowScope: scope }
    )
    expect(mocks.invoke).toHaveBeenCalledWith('wf_run_script', {
      payload: expect.objectContaining({
        scope,
        execution: { sessionId: 'session', generation: 1, workflowExecutionId: scope.runId },
      }),
    })
    expect(mocks.session).not.toHaveBeenCalled()
  })
  it('rejects another owner or changed source binding without invoking a canonical session', async () => {
    for (const change of [{ principalId: 'other' }, { expectedWorkspaceUpdatedAt: 43 }]) {
      await expect(
        terminalTools[0]!.execute(
          { runtime: 'node', code: 'doWork()' },
          {
            projectId: 'project',
            workflowScope: { ...scope, ...change },
          }
        )
      ).rejects.toThrow('Projektfreigabe')
    }
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.session).not.toHaveBeenCalled()
  })
})
