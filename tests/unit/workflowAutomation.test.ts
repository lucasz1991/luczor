import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  values: new Map<string, Map<string, unknown>>(),
  confirm: vi.fn(),
  request: vi.fn(),
  workspace: vi.fn(),
  account: vi.fn(),
  assert: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async (file: string) => {
      const values = mock.values.get(file) ?? new Map<string, unknown>()
      mock.values.set(file, values)
      return {
        get: async (key: string) => structuredClone(values.get(key)),
        set: async (key: string, value: unknown) => {
          values.set(key, structuredClone(value))
        },
        delete: async (key: string) => values.delete(key),
        save: async () => {},
      }
    },
  },
}))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: mock.account }))
vi.mock('@/services/confirmation', () => ({ requestConfirmation: mock.confirm }))
vi.mock('@/services/api/luczorApi', () => ({ requestWithConfig: mock.request }))
vi.mock('@/services/projectWorkspace', () => ({ getProjectWorkspace: mock.workspace }))
vi.mock('@/services/executionGate', () => ({
  executionGate: {
    assert: mock.assert,
    capture: () => ({ sessionId: 'session', generation: 1, signal: new AbortController().signal }),
  },
}))
import {
  configureWorkflowAutomation,
  workflowAutomationAllows,
  type WorkflowAutomationGrant,
} from '@/services/workflows/automation'
import { workflowAccountScope, workflowTextHash } from '@/services/workflows/executionLedger'
import type { WorkflowTaskBundle } from '@/services/workflowTaskRunner'
import { WorkflowOperationUncertain } from '@/services/workflows/operations'

const apiConfig = { baseUrl: 'https://luczor.test', clientId: 'device-1', deviceKey: 'test-secret' }
const workflow = {
  id: 7,
  version: 3,
  name: 'Build',
  definition: { steps: [{ key: 'build', type: 'node.run', payload: { code: 'console.log(1)' } }] },
}
let grant: WorkflowAutomationGrant
beforeEach(() => {
  vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  vi.clearAllMocks()
  mock.values.clear()
  mock.confirm.mockResolvedValue({ approved: true })
  mock.account.mockResolvedValue({ principalId: 'user:1', config: apiConfig })
  mock.workspace.mockResolvedValue({ status: 'ready', rootPath: 'E:\\Project', updatedAt: 17 })
  mock.request.mockImplementation(
    async (_path: string, options: { method?: string; body?: Record<string, unknown> }) => {
      if (options.method === 'POST') {
        const { status, operation_id, local_approved, ...config } = options.body!
        void operation_id
        void local_approved
        grant = {
          id: 12,
          workflow_definition_id: Number(_path.split('/')[2]),
          approved_revision: Number(config.approved_revision),
          scope_hash: 'confirmed-config',
          status: String(status),
          config: config as unknown as WorkflowAutomationGrant['config'],
        }
      }
      return { data: { grant } }
    }
  )
})
afterEach(() => vi.unstubAllGlobals())

async function approvedBundle(): Promise<{ bundle: WorkflowTaskBundle; scope: string }> {
  await configureWorkflowAutomation(workflow, { export_results: true }, { projectId: 'project-1' })
  return {
    scope: await workflowAccountScope(apiConfig),
    bundle: {
      task_key: 'node.run',
      params: { code: 'console.log(1)' },
      workflow: {
        run: 'run',
        step_id: 1,
        step_key: 'build',
        definition_id: 7,
        revision: 4,
        device_id: 'device-1',
        project_id: 'project-1',
        file_scope: 'workspace',
        workspace_root_id: 'E:\\Project',
        input_sources: ['input'],
        output_keys: ['stdout'],
        grant,
      },
    },
  }
}
describe('local workflow automation grant', () => {
  it('requires an actual local confirmation before posting and persists exact raw program hashes', async () => {
    mock.confirm.mockResolvedValueOnce({ approved: false })
    await expect(
      configureWorkflowAutomation(workflow, { export_results: true }, { projectId: 'project-1' })
    ).resolves.toMatchObject({ ok: false })
    expect(mock.request).not.toHaveBeenCalled()
    await configureWorkflowAutomation(workflow, { export_results: true }, { projectId: 'project-1' })
    expect(grant.config.script_hashes.build).toBe(await workflowTextHash('console.log(1)'))
    expect(mock.values.get('luczor.workflow-automation.json')?.size).toBe(1)
  })
  it('accepts a future revision only inside the original action/source/output/program envelope', async () => {
    const { bundle, scope } = await approvedBundle()
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(true)
    bundle.params.code = 'console.log(2)'
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(false)
  })
  it('rechecks current server revocation even when the signed job contains the old active grant', async () => {
    const { bundle, scope } = await approvedBundle()
    mock.request.mockResolvedValueOnce({ data: { grant: { ...grant, status: 'revoked' } } })
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(false)
  })
  it('refuses absent local consent, changed workspace binding, and unapproved input sources', async () => {
    const { bundle, scope } = await approvedBundle()
    await expect(workflowAutomationAllows(bundle, scope, 'different-account', apiConfig)).resolves.toBe(false)
    mock.workspace.mockResolvedValueOnce({ status: 'ready', rootPath: 'E:\\Other', updatedAt: 18 })
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(false)
    bundle.workflow.input_sources = ['local_secrets']
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(false)
  })
  it('recovers a lost grant response without another POST and preserves the actual approval boundary', async () => {
    const readOnlyWorkflow = { ...workflow, definition: { steps: [{ key: 'read', type: 'file.read' }] } }
    const server = mock.request.getMockImplementation()!
    mock.request.mockImplementationOnce(async (...args) => {
      await server(...args)
      throw new Error('response lost after commit')
    })
    await expect(configureWorkflowAutomation(readOnlyWorkflow, {}, { projectId: 'project-1' })).rejects.toBeInstanceOf(
      WorkflowOperationUncertain
    )
    const operationId = mock.request.mock.calls[0]![1].body.operation_id
    const pending = mock.values.get('luczor.workflow-operations.json')!.get('pending')
    expect(pending).toEqual([expect.objectContaining({ operationId })])
    expect(JSON.stringify(pending)).not.toContain(apiConfig.deviceKey)
    expect(JSON.stringify(pending)).not.toContain(workflow.name)
    expect(mock.values.get('luczor.workflow-automation.json')?.size).toBe(0)
    mock.request.mockImplementation(async (path: string) => {
      expect(path).toBe(`/workflow-operations/${operationId}`)
      return {
        data: {
          status: 'completed',
          response: { grant: { ...grant, config: { ...grant.config, script_hashes: [] } } },
        },
      }
    })
    const recovered = await configureWorkflowAutomation(readOnlyWorkflow, {}, { projectId: 'project-1' })
    expect(recovered).toMatchObject({ ok: true, grant: { config: { script_hashes: {} } } })
    expect(mock.confirm).toHaveBeenCalledTimes(2)
    expect(mock.request.mock.calls.filter(call => call[1].method === 'POST')).toHaveLength(1)
    expect(mock.values.get('luczor.workflow-automation.json')?.size).toBe(1)
    expect(mock.values.get('luczor.workflow-operations.json')?.get('pending')).toEqual([])
  })
  it('reuses the persisted operation ID only after the server explicitly reports it absent', async () => {
    const server = mock.request.getMockImplementation()!
    mock.request.mockRejectedValueOnce(new Error('request lost'))
    await expect(configureWorkflowAutomation(workflow, {}, { projectId: 'project-1' })).rejects.toBeInstanceOf(
      WorkflowOperationUncertain
    )
    const operationId = mock.request.mock.calls[0]![1].body.operation_id
    mock.request.mockImplementation(async (...args) =>
      args[0].startsWith('/workflow-operations/') ? { data: { status: 'not_found' } } : server(...args)
    )
    await configureWorkflowAutomation(workflow, {}, { projectId: 'project-1' })
    const posts = mock.request.mock.calls.filter(call => call[1].method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[1]![1].body.operation_id).toBe(operationId)
  })
  it('does not send changed grant boundaries while an earlier operation remains unconfirmed', async () => {
    mock.request.mockRejectedValueOnce(new Error('offline'))
    await expect(configureWorkflowAutomation(workflow, {}, { projectId: 'project-1' })).rejects.toBeInstanceOf(
      WorkflowOperationUncertain
    )
    mock.request.mockResolvedValue({ data: { status: 'not_found' } })
    await expect(
      configureWorkflowAutomation(workflow, { max_runs_per_hour: 21 }, { projectId: 'project-1' })
    ).rejects.toBeInstanceOf(WorkflowOperationUncertain)
    expect(mock.request.mock.calls.filter(call => call[1].method === 'POST')).toHaveLength(1)
  })
  it('revokes local permission before remote delivery and recovers a lost revocation without another POST', async () => {
    await configureWorkflowAutomation(workflow, {}, { projectId: 'project-1' })
    const server = mock.request.getMockImplementation()!
    const dispatch = vi.mocked(window.dispatchEvent)
    dispatch.mockClear()
    mock.request.mockImplementationOnce(async (...args) => {
      expect(mock.values.get('luczor.workflow-automation.json')?.size).toBe(0)
      expect(dispatch).toHaveBeenCalledOnce()
      await server(...args)
      throw new Error('revocation response lost')
    })
    await expect(
      configureWorkflowAutomation(workflow, { status: 'revoked' }, { projectId: 'project-1' })
    ).rejects.toBeInstanceOf(WorkflowOperationUncertain)
    const operationId = mock.request.mock.calls[1]![1].body.operation_id
    mock.request.mockImplementation(async (path: string) =>
      path.startsWith('/workflow-operations/')
        ? { data: { status: 'completed', response: { grant } } }
        : { data: { grant } }
    )
    await expect(
      configureWorkflowAutomation(workflow, { status: 'revoked' }, { projectId: 'project-1' })
    ).resolves.toMatchObject({ ok: true, grant: { status: 'revoked' } })
    expect(mock.request).toHaveBeenCalledWith(`/workflow-operations/${operationId}`, expect.anything(), apiConfig)
    expect(mock.request.mock.calls.filter(call => call[1].method === 'POST')).toHaveLength(2)
    expect(mock.values.get('luczor.workflow-automation.json')?.size).toBe(0)
  })
  it('rejects a recovered grant with changed boundaries before persisting local consent', async () => {
    const server = mock.request.getMockImplementation()!
    mock.request.mockImplementationOnce(async (...args) => {
      await server(...args)
      throw new Error('response lost')
    })
    await expect(configureWorkflowAutomation(workflow, {}, { projectId: 'project-1' })).rejects.toBeInstanceOf(
      WorkflowOperationUncertain
    )
    mock.request.mockResolvedValue({
      data: {
        status: 'completed',
        response: { grant: { ...grant, config: { ...grant.config, export_results: true } } },
      },
    })
    await expect(configureWorkflowAutomation(workflow, {}, { projectId: 'project-1' })).rejects.toThrow(
      'workflow_automation_server_contract_changed'
    )
    expect(mock.values.get('luczor.workflow-automation.json')?.size).toBe(0)
    expect(mock.request.mock.calls.filter(call => call[1].method === 'POST')).toHaveLength(1)
  })
  it('does not mistake a recovered active grant for a newly requested revocation', async () => {
    const server = mock.request.getMockImplementation()!
    mock.request.mockImplementationOnce(async (...args) => {
      await server(...args)
      throw new Error('response lost')
    })
    await expect(configureWorkflowAutomation(workflow, {}, { projectId: 'project-1' })).rejects.toBeInstanceOf(
      WorkflowOperationUncertain
    )
    mock.request.mockImplementation(async (path: string) =>
      path.startsWith('/workflow-operations/')
        ? { data: { status: 'completed', response: { grant } } }
        : { data: { grant } }
    )
    await expect(
      configureWorkflowAutomation(workflow, { status: 'revoked' }, { projectId: 'project-1' })
    ).rejects.toThrow('Ein vorheriger Auftrag wurde wiederhergestellt')
    expect(mock.values.get('luczor.workflow-automation.json')?.size).toBe(0)
    expect(mock.request.mock.calls.filter(call => call[1].method === 'POST')).toHaveLength(1)
  })
  it.each(['account', 'server', 'device', 'credential', 'workflow'] as const)(
    'does not reuse a pending grant operation across a changed %s boundary',
    async boundary => {
      const server = mock.request.getMockImplementation()!
      mock.request.mockRejectedValueOnce(new Error('offline'))
      await expect(configureWorkflowAutomation(workflow, {}, { projectId: 'project-1' })).rejects.toBeInstanceOf(
        WorkflowOperationUncertain
      )
      const operationId = mock.request.mock.calls[0]![1].body.operation_id
      const nextConfig = {
        ...apiConfig,
        ...(boundary === 'server' ? { baseUrl: 'https://other.test' } : {}),
        ...(boundary === 'device' ? { clientId: 'device-2' } : {}),
        ...(boundary === 'credential' ? { deviceKey: 'rotated-test-secret' } : {}),
      }
      mock.account.mockResolvedValue({ principalId: boundary === 'account' ? 'user:2' : 'user:1', config: nextConfig })
      mock.request.mockImplementation(server)
      await configureWorkflowAutomation(
        boundary === 'workflow' ? { ...workflow, id: 8 } : workflow,
        {},
        { projectId: 'project-1' }
      )
      const posts = mock.request.mock.calls.filter(call => call[1].method === 'POST')
      expect(posts).toHaveLength(2)
      expect(posts[1]![1].body.operation_id).not.toBe(operationId)
      expect(mock.request.mock.calls.some(call => call[0].startsWith('/workflow-operations/'))).toBe(false)
      expect(mock.values.get('luczor.workflow-operations.json')!.get('pending')).toEqual([
        expect.objectContaining({ operationId }),
      ])
    }
  )
})
