import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ invoke: vi.fn(), request: vi.fn(), revision: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
vi.mock('@/services/api/luczorApi', () => ({ requestWithConfig: mock.request }))
vi.mock('@/services/workflows/automation', () => ({
  WORKFLOW_AUTOMATION_INVALIDATED: 'workflow-invalidated',
  workflowAutomationRevision: mock.revision,
}))
import {
  retainWorkflowResources,
  releaseWorkflowAccountResources,
  sweepWorkflowResources,
  releaseAllWorkflowResources,
  recoverWorkflowResourcesAfterStop,
} from '@/services/workflows/runResources'
const config = { baseUrl: 'https://test', clientId: 'device', deviceKey: 'key' }
const scope = {
  principalId: 'user',
  projectId: 'project',
  expectedRootPath: 'E:/project',
  expectedWorkspaceUpdatedAt: 2,
  runId: 'run',
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', new EventTarget())
  mock.invoke.mockResolvedValue({ ok: true })
  mock.revision.mockReturnValue(1)
})
afterEach(async () => {
  await releaseWorkflowAccountResources(config)
  vi.unstubAllGlobals()
})
it('retains the original cleanup scope when a rebound workspace attempts to reuse the run', async () => {
  retainWorkflowResources(scope, config)
  expect(() =>
    retainWorkflowResources({ ...scope, expectedRootPath: 'E:/other', expectedWorkspaceUpdatedAt: 3 }, config)
  ).toThrow('scope_changed')
  await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('wf_browser_cleanup', { payload: scope }))
})
it('clears native-confirmed ownership without letting a late cleanup forget a new session', async () => {
  retainWorkflowResources(scope, config)
  let finish!: () => void
  mock.invoke.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  const old = releaseAllWorkflowResources()
  recoverWorkflowResourcesAfterStop()
  retainWorkflowResources(scope, config)
  finish()
  await old
  await releaseAllWorkflowResources()
  expect(mock.invoke).toHaveBeenCalledTimes(2)
})
it('closes a granted browser immediately on local revocation between steps', async () => {
  retainWorkflowResources(scope, config, { accountScope: 'account', definitionId: 3, revision: 1 })
  window.dispatchEvent(
    new CustomEvent('workflow-invalidated', { detail: { scope: 'another-account', definitionId: 3 } })
  )
  expect(mock.invoke).not.toHaveBeenCalled()
  window.dispatchEvent(new CustomEvent('workflow-invalidated', { detail: { scope: 'account', definitionId: 3 } }))
  await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('wf_browser_cleanup', { payload: scope }))
})
it('keeps the session across working rounds and only releases a confirmed terminal run', async () => {
  retainWorkflowResources(scope, config)
  mock.request.mockResolvedValueOnce({ data: { public_id: 'run', status: 'running' } })
  await sweepWorkflowResources(config, new AbortController().signal)
  expect(mock.invoke).not.toHaveBeenCalled()
  mock.request.mockResolvedValueOnce({ data: { public_id: 'run', status: 'completed' } })
  await sweepWorkflowResources(config, new AbortController().signal)
  expect(mock.invoke).toHaveBeenCalledWith('wf_browser_cleanup', { payload: scope })
})
