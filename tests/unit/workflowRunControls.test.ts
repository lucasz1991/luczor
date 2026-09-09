import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ request: vi.fn(), access: vi.fn(), values: new Map<string, unknown>() }))
vi.mock('@/services/api/luczorApi', () => ({ requestWithConfig: mock.request }))
vi.mock('@/services/workflows/access', () => ({ captureWorkflowAccess: mock.access }))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async () => ({
      get: async (key: string) => structuredClone(mock.values.get(key)),
      set: async (key: string, value: unknown) => mock.values.set(key, structuredClone(value)),
      save: async () => {},
    }),
  },
}))
import { createWorkflowApi, stopWorkflowAfterStep } from '@/services/workflows/api'
import { executionGate } from '@/services/executionGate'
import type { WorkflowRun } from '@/services/workflows/types'
const config = { baseUrl: 'https://workflow.test', deviceKey: 'secret-test-device', clientId: 'device-1' }
let run: WorkflowRun
let response: WorkflowRun
beforeEach(() => {
  vi.clearAllMocks()
  mock.values.clear()
  executionGate.update({ mode: 'act', killSwitch: false, scope: crypto.randomUUID() })
  run = { id: 15, public_id: 'public-run', workflow_definition_id: 7, status: 'running', sandbox: false }
  response = {
    ...run,
    budget_state: { boundary_stop: { status: 'pending', requested_at: '2026-09-09' } },
  } as WorkflowRun
  mock.access.mockImplementation(async (ctx: { signal?: AbortSignal }, _project: unknown, mutating: boolean) => {
    const ticket = executionGate.capture(ctx.signal)
    const check = async () => executionGate.assert(ticket, mutating)
    await check()
    return {
      principalId: 'user:1',
      config,
      api: createWorkflowApi(config, ticket.signal),
      check,
      workflow: async (id: number) => {
        await check()
        if (id !== 7) throw new Error('foreign workflow')
      },
    }
  })
  mock.request.mockImplementation(async (path: string, options) => {
    if (options?.method === 'POST') return { data: response }
    if (path.startsWith('/workflow-operations/')) return { data: { status: 'not_found' } }
    return { data: run }
  })
})
describe('workflow boundary stop requests', () => {
  it('sends a replayable explicit boundary stop and preserves the pending running state', async () => {
    const result = await stopWorkflowAfterStep('project-1', 7, '15')
    expect(result.status).toBe('running')
    expect(result).toMatchObject({ budget_state: { boundary_stop: { status: 'pending' } } })
    expect(mock.request).toHaveBeenCalledWith(
      '/workflow-runs/public-run/stop-after-step',
      expect.objectContaining({
        method: 'POST',
        body: { operation_id: expect.stringMatching(/^[a-f0-9-]{36}$/u) },
      }),
      config
    )
    expect(mock.values.get('pending')).toEqual([])
  })
  it('rejects a selected run from another workflow before any stop', async () => {
    run.workflow_definition_id = 99
    await expect(stopWorkflowAfterStep('project-1', 7, 'public-run')).rejects.toThrow('anderen Workflow')
    expect(mock.request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(0)
  })
  it('recovers a lost response with the original operation ID and never sends a duplicate stop', async () => {
    let operationId = ''
    mock.request.mockImplementation(async (path: string, options) => {
      if (options.method === 'POST') {
        operationId = options.body.operation_id
        throw new Error('lost after commit')
      }
      if (path === `/workflow-operations/${operationId}`) return { data: { status: 'completed', response } }
      return { data: run }
    })
    await expect(stopWorkflowAfterStep('project-1', 7, 'public-run')).rejects.toThrow('unklar')
    expect(JSON.stringify(mock.values.get('pending'))).not.toContain(config.deviceKey)
    await expect(stopWorkflowAfterStep('project-1', 7, 'public-run')).resolves.toEqual(response)
    expect(mock.request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1)
  })
  it('rejects a late response when the execution scope changed', async () => {
    mock.request.mockImplementation(async (_path, options) => {
      if (options.method === 'POST') {
        executionGate.update({ mode: 'observe', killSwitch: false, scope: 'new-project' })
        return { data: response }
      }
      return { data: run }
    })
    await expect(stopWorkflowAfterStep('project-1', 7, 'public-run')).rejects.toThrow('unklar')
  })
  it('accepts only the requested run or its proven root as response identity', async () => {
    run = { ...run, root_workflow_run_id: 2 } as WorkflowRun
    response = { ...response, id: 2, workflow_definition_id: 3, public_id: 'root-run' }
    await expect(stopWorkflowAfterStep('project-1', 7, 'public-run')).resolves.toEqual(response)
    response = { ...response, id: 999 }
    await expect(stopWorkflowAfterStep('project-1', 7, 'public-run')).rejects.toThrow('unklar')
  })
})
