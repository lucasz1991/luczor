import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  request: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
  approve: vi.fn(),
  confirm: vi.fn(),
  allows: vi.fn(),
  recover: vi.fn(),
  execute: vi.fn(),
  acknowledge: vi.fn(),
  runTask: vi.fn(),
  account: vi.fn(),
  workspace: vi.fn(),
  automationRevision: vi.fn(),
  sweep: vi.fn(),
  retain: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: mock.account }))
vi.mock('@/services/api/luczorApi', () => ({
  requestWithConfig: mock.request,
  LuczorApi: { startDeviceJob: mock.start, completeDeviceJob: mock.complete, approveDeviceJob: mock.approve },
}))
vi.mock('@/services/confirmation', () => ({ requestConfirmation: mock.confirm }))
vi.mock('@/services/projectWorkspace', () => ({ getProjectWorkspace: mock.workspace }))
vi.mock('@/services/cloudProjectAccess', () => ({ projectLocalIdForServer: (id: string) => id }))
vi.mock('@/services/coordination/mirror', () => ({ prepareMirrorTestWorkspace: vi.fn() }))
vi.mock('@/services/executionGate', () => ({
  executionGate: { assert: (ticket: { signal: AbortSignal }) => ticket.signal.throwIfAborted() },
  executionPayload: async () => ({ sessionId: 'session', generation: 1 }),
}))
vi.mock('@/services/agents/workflowAgent', () => ({ runWorkflowAgent: vi.fn() }))
vi.mock('@/services/workflowTaskRunner', () => ({ isWorkflowTaskBundle: () => true, runWorkflowTask: mock.runTask }))
vi.mock('@/services/workflows/llm', () => ({ runWorkflowLlm: vi.fn() }))
vi.mock('@/services/workflows/runResources', () => ({
  sweepWorkflowResources: mock.sweep,
  retainWorkflowResources: mock.retain,
  releaseWorkflowResources: async () => {},
}))
vi.mock('@/services/workflows/automation', () => ({
  canonicalWorkflowPath: (path: string) => path.toLowerCase().replaceAll('\\', '/'),
  workflowAutomationAllows: mock.allows,
  workflowAutomationRevision: mock.automationRevision,
  WORKFLOW_AUTOMATION_INVALIDATED: 'workflow-invalidated',
}))
vi.mock('@/services/workflows/executionLedger', () => ({
  workflowAccountScope: async () => 'account-scope',
  workflowExecutionLedger: { recover: mock.recover, execute: mock.execute, acknowledge: mock.acknowledge },
}))
import { runWorkflowDeviceJob } from '@/services/workflows/execution'
import type { DeviceJob } from '@/services/api/luczorApi'

const config = { baseUrl: 'https://luczor.test', clientId: 'device-1', deviceKey: 'test-key' }
const executionId = '07af2021-c556-453c-b172-62eeea8c103e'
function fixture() {
  const controller = new AbortController()
  const job = {
    id: 'job-1',
    tool_profile: 'workflow.task',
    status: 'queued',
    payload: {
      task_key: 'file.write',
      params: { path: 'result.txt', content: 'Result' },
      workflow: {
        run: 'run-1',
        step_id: 1,
        step_key: 'write',
        execution_id: executionId,
        definition_id: 1,
        project_id: 'project-1',
        device_id: 'device-1',
        file_scope: 'workspace',
        workspace_root_id: 'E:\\Project',
      },
    },
  } as unknown as DeviceJob
  return { job, controller, ticket: { sessionId: 'session', generation: 1, signal: controller.signal } }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', new EventTarget())
  mock.automationRevision.mockReturnValue(0)
  mock.invoke.mockResolvedValue(undefined)
  mock.account.mockResolvedValue({ principalId: 'user:1', config })
  mock.workspace.mockResolvedValue({ rootPath: 'E:\\Project', updatedAt: 10, status: 'ready' })
  mock.request.mockResolvedValue({ data: { status: 'queued' } })
  mock.allows.mockResolvedValue(false)
  mock.confirm.mockResolvedValue({ approved: true })
  mock.execute.mockImplementation(
    async (_scope: string, _id: string, _payload: unknown, effect: () => Promise<unknown>) => effect()
  )
  mock.runTask.mockResolvedValue({ ok: true, result: 'saved' })
})
afterEach(() => vi.unstubAllGlobals())
describe('signed workflow device lifecycle', () => {
  it('releases completed sessions before a child uses the signed root browser scope', async () => {
    const { job, ticket } = fixture()
    const payload = job.payload as import('@/services/workflowTaskRunner').WorkflowTaskBundle
    payload.task_key = 'browser.open'
    payload.params = { url: 'https://example.test' }
    payload.workflow.resource_run = 'root-resource-run'
    mock.runTask.mockImplementationOnce(async (_bundle, primitives) => {
      await primitives.browserSession.open('https://example.test')
      return { ok: true }
    })
    await runWorkflowDeviceJob(job, config, ticket, () => {}, 'preview')
    expect(mock.sweep).toHaveBeenCalledWith(config, expect.any(AbortSignal))
    expect(mock.sweep.mock.invocationCallOrder[0]).toBeLessThan(mock.retain.mock.invocationCallOrder[0]!)
    expect(mock.retain).toHaveBeenCalledWith(expect.objectContaining({ runId: 'root-resource-run' }), config, undefined)
    expect(mock.invoke).toHaveBeenCalledWith(
      'wf_browser_action',
      expect.objectContaining({
        payload: expect.objectContaining({
          scope: expect.objectContaining({ runId: 'root-resource-run' }),
          execution: expect.objectContaining({ workflowExecutionId: executionId }),
        }),
      })
    )
  })
  it('cancels a locally revoked automatic grant during device start before any effects', async () => {
    const { job, ticket } = fixture()
    mock.allows.mockResolvedValue(true)
    mock.start.mockImplementation(async () => {
      mock.automationRevision.mockReturnValue(1)
      window.dispatchEvent(
        new CustomEvent('workflow-invalidated', { detail: { scope: 'account-scope', definitionId: 1 } })
      )
    })
    await expect(runWorkflowDeviceJob(job, config, ticket, () => {}, 'preview')).rejects.toThrow(
      'workflow_automation_revoked'
    )
    expect(mock.runTask).not.toHaveBeenCalled()
    expect(mock.invoke).toHaveBeenCalledWith(
      'wf_execution_cancel',
      expect.objectContaining({ payload: expect.objectContaining({ executionId }) })
    )
  })
  it('resends a durable result without repeating approval, start or effects', async () => {
    const { job, ticket } = fixture()
    mock.recover.mockResolvedValue({ ok: true, result: 'saved earlier' })
    await runWorkflowDeviceJob(job, config, ticket, () => {}, 'preview')
    expect(mock.confirm).not.toHaveBeenCalled()
    expect(mock.start).not.toHaveBeenCalled()
    expect(mock.runTask).not.toHaveBeenCalled()
    expect(mock.complete).toHaveBeenCalledWith(
      'job-1',
      'device-1',
      true,
      { ok: true, result: 'saved earlier' },
      undefined,
      config,
      expect.any(AbortSignal)
    )
    expect(mock.acknowledge).toHaveBeenCalledWith('account-scope', executionId)
  })
  it('does not replace a completed result with failure after acknowledgment loss', async () => {
    const { job, ticket } = fixture()
    mock.complete.mockRejectedValueOnce(new Error('connection lost'))
    await expect(runWorkflowDeviceJob(job, config, ticket, () => {}, 'preview')).rejects.toThrow('connection lost')
    expect(mock.runTask).toHaveBeenCalledOnce()
    expect(mock.complete).toHaveBeenCalledOnce()
    expect(mock.acknowledge).not.toHaveBeenCalled()
  })
  it('stops after session cancellation while a local confirmation was open', async () => {
    const { job, ticket, controller } = fixture()
    mock.confirm.mockImplementationOnce(async () => {
      controller.abort()
      return { approved: true }
    })
    await expect(runWorkflowDeviceJob(job, config, ticket, () => {}, 'preview')).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(mock.start).not.toHaveBeenCalled()
    expect(mock.invoke).toHaveBeenCalledWith(
      'wf_execution_cancel',
      expect.objectContaining({ payload: expect.objectContaining({ executionId }) })
    )
  })
  it('acknowledges server cancellation before admitting any effect', async () => {
    const { job, ticket } = fixture()
    mock.request.mockResolvedValueOnce({ data: { status: 'cancelled', cancel_requested: true } })
    await expect(runWorkflowDeviceJob(job, config, ticket, () => {}, 'preview')).rejects.toThrow('workflow_cancelled')
    expect(mock.start).not.toHaveBeenCalled()
    expect(mock.request).toHaveBeenCalledWith(
      '/devices/jobs/job-1/cancel-ack',
      expect.objectContaining({ method: 'POST', body: { client_id: 'device-1' } }),
      config
    )
  })
  it('rejects a rebound signed workspace before approval or execution', async () => {
    const { job, ticket } = fixture()
    mock.workspace.mockResolvedValueOnce({ rootPath: 'E:\\Other', updatedAt: 11, status: 'ready' })
    await expect(runWorkflowDeviceJob(job, config, ticket, () => {}, 'preview')).rejects.toThrow('root_changed')
    expect(mock.confirm).not.toHaveBeenCalled()
    expect(mock.runTask).not.toHaveBeenCalled()
  })
})
