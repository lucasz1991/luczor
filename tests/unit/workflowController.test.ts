import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/services/tools/workflows', () => ({ workflowTools: [] }))
import { WorkflowController } from '@/services/workflows/controller'
import { executionGate } from '@/services/executionGate'
import type { WorkflowApi } from '@/services/workflows/api'
import type { Workflow, WorkflowRun } from '@/services/workflows/types'

const workflow = (id = 1, projectId = 'p'): Workflow => ({
  id,
  name: 'Review',
  version: 2,
  project_id: 3,
  project_external_id: projectId,
  status: 'active',
  is_locked: false,
  definition: { steps: [{ key: 'a', type: 'context', payload: {} }] },
})
function fixture() {
  const api = {
    catalog: vi.fn(async () => ({ data: [] })),
    list: vi.fn(async () => ({ data: [workflow()] })),
    sources: vi.fn(async () => ({ data: { repositories: [], tasks: [], workflows: [] } })),
    get: vi.fn(async (id: number) => ({ data: workflow(id) })),
    runs: vi.fn(async () => ({ data: [] })),
    triggers: vi.fn(async () => ({ data: [] })),
    automation: vi.fn(async () => ({ data: { grant: null } })),
    run: vi.fn(async (): Promise<{ data: WorkflowRun }> => ({
      data: { id: 9, public_id: 'run', workflow_definition_id: 1, status: 'cancelling', sandbox: true },
    })),
    approve: vi.fn(),
    complete: vi.fn(),
    revision: vi.fn(),
    deliveries: vi.fn(),
    retryDelivery: vi.fn(),
  }
  const perform = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    ok: true,
    workflow_ref: { id: 1, runId: 'run' },
  }))
  const controller = new WorkflowController({
    connect: async () => ({
      api: api as unknown as WorkflowApi,
      deviceId: 'device',
      rootPath: 'C:/workspace',
      baseUrl: 'https://test.invalid',
    }),
    perform,
  })
  return { api, perform, controller }
}
beforeEach(() => executionGate.update({ mode: 'act', killSwitch: false, scope: crypto.randomUUID() }))
describe('shared workflow view state', () => {
  it('preserves persistent step targets and revision checks while leaving a captured run definition untouched', async () => {
    const testCase = fixture()
    await testCase.controller.load('p', 1)
    testCase.controller.view.catalog = [
      {
        key: 'browser.read',
        label: 'Browser',
        runner: 'client',
        kind: 'task',
        mutating: false,
        requires_approval: false,
        allowed_in_definition: true,
        params: {},
      },
    ]
    const frozen = structuredClone(workflow().definition)
    const definition = {
      steps: [
        { key: 'a', type: 'browser.read', payload: {}, device_target: { kind: 'specific', device_id: 'laptop' } },
      ],
    }
    await testCase.controller.action('workflow_update', { workflow_id: 1, expected_version: 2, definition })
    expect(testCase.perform).toHaveBeenCalledWith(
      'workflow_update',
      expect.objectContaining({ expected_version: 2, definition }),
      expect.anything()
    )
    expect(frozen).toEqual(workflow().definition)
    testCase.perform.mockClear()
    definition.steps[0]!.device_target.device_id = ''
    expect(
      await testCase.controller.action('workflow_update', { workflow_id: 1, expected_version: 2, definition })
    ).toBeUndefined()
    expect(testCase.perform).not.toHaveBeenCalled()
    expect(testCase.controller.view.error).toContain('Geräte-ID')
  })
  it('rebinds API requests after changing from observe to act', async () => {
    const testCase = fixture()
    executionGate.update({ mode: 'observe', killSwitch: false, scope: 'p' })
    const connect = vi.fn(async () => {
      const ticket = executionGate.capture()
      return {
        api: {
          ...testCase.api,
          list: async () => {
            executionGate.assert(ticket)
            return { data: [workflow()] }
          },
          run: async () => {
            executionGate.assert(ticket)
            return testCase.api.run()
          },
        } as unknown as WorkflowApi,
        deviceId: 'device',
        rootPath: 'C:/workspace',
        baseUrl: 'https://test.invalid',
      }
    })
    const controller = new WorkflowController({ connect, perform: testCase.perform })
    await controller.load('p', 1)
    executionGate.update({ mode: 'act', killSwitch: false, scope: 'p' })
    const result = await controller.action('workflow_run_start', { workflow_id: 1 })
    expect(result?.ok).toBe(true)
    expect(controller.view.error).toBe('')
    expect(controller.view.run?.status).toBe('cancelling')
    expect(connect).toHaveBeenCalledTimes(2)
  })
  it('loads project-bound data and refreshes actual run state after a shared tool action', async () => {
    const testCase = fixture()
    await testCase.controller.load('p', 1)
    await testCase.controller.action('workflow_run_cancel', { workflow_id: 1, run_id: 'run' })
    expect(testCase.perform).toHaveBeenCalledWith(
      'workflow_run_cancel',
      { workflow_id: 1, run_id: 'run' },
      expect.objectContaining({ projectId: 'p' })
    )
    expect(testCase.controller.view.run?.status).toBe('cancelling')
    expect(testCase.api.list).toHaveBeenCalledTimes(2)
  })
  it('discards a late load when the project context is reset', async () => {
    const testCase = fixture()
    let resolve!: (value: { data: Workflow }) => void
    testCase.api.get.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const loading = testCase.controller.load('p', 1)
    await vi.waitFor(() => expect(testCase.api.get).toHaveBeenCalled())
    testCase.controller.reset('other')
    resolve({ data: workflow() })
    await loading
    expect(testCase.controller.view.projectId).toBe('other')
    expect(testCase.controller.view.selected).toBeNull()
    expect(testCase.controller.view.workflows).toEqual([])
    expect(testCase.controller.view.error).toBe('')
  })
  it('rejects a cross-project definition before loading its private runs', async () => {
    const testCase = fixture()
    testCase.api.get.mockResolvedValueOnce({ data: workflow(1, 'foreign') })
    await testCase.controller.load('p', 1)
    expect(testCase.controller.view.selected).toBeNull()
    expect(testCase.api.runs).not.toHaveBeenCalled()
    expect(testCase.controller.view.error).toContain('anderen Projekt')
  })
  it('does not confuse a server conflict with a successful save', async () => {
    const testCase = fixture()
    await testCase.controller.load('p', 1)
    testCase.perform.mockRejectedValueOnce(new Error('Version conflict'))
    expect(await testCase.controller.action('workflow_update', { expected_version: 1 })).toBeUndefined()
    expect(testCase.controller.view.selected?.version).toBe(2)
    expect(testCase.controller.view.error).toBe('Version conflict')
  })
  it('retains cancellation pending until the actual server status changes', async () => {
    const testCase = fixture()
    await testCase.controller.load('p', 1)
    await testCase.controller.refreshRun('run')
    expect(testCase.controller.view.run?.status).toBe('cancelling')
    testCase.api.run.mockResolvedValueOnce({
      data: { id: 9, public_id: 'run', workflow_definition_id: 1, status: 'cancelled', sandbox: true },
    })
    await testCase.controller.refreshRun('run')
    expect(testCase.controller.view.run?.status).toBe('cancelled')
  })
  it('blocks step approvals under Not-Aus and rejects nonselected steps', async () => {
    const testCase = fixture()
    await testCase.controller.load('p', 1)
    await testCase.controller.approveStep(999)
    expect(testCase.api.approve).not.toHaveBeenCalled()
    testCase.controller.view.run = {
      id: 1,
      public_id: 'run',
      workflow_definition_id: 1,
      status: 'waiting',
      sandbox: false,
      steps: [{ id: 2, step_key: 'a', type: 'file.write', status: 'awaiting_approval' }],
    }
    executionGate.update({ mode: 'act', killSwitch: true, scope: 'p' })
    await testCase.controller.approveStep(2)
    expect(testCase.api.approve).not.toHaveBeenCalled()
    expect(testCase.controller.view.error).toContain('Not-Aus')
  })
})
