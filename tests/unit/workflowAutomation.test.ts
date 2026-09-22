import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  values: new Map<string, Map<string, unknown>>(),
  confirm: vi.fn(),
  request: vi.fn(),
  workspace: vi.fn(),
  account: vi.fn(),
  assert: vi.fn(),
  beforeSet: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async (file: string) => {
      const values = mock.values.get(file) ?? new Map<string, unknown>()
      mock.values.set(file, values)
      return {
        get: async (key: string) => structuredClone(values.get(key)),
        set: async (key: string, value: unknown) => {
          const snapshot = structuredClone(value)
          await mock.beforeSet(file, key, snapshot)
          values.set(key, snapshot)
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
vi.mock('@/services/workflows/capabilities', () => ({
  currentWorkflowEnvironmentHash: async () => 'device-environment',
}))
import {
  configureWorkflowAutomation,
  workflowAutomationAllows,
  rememberLocalWorkflowRepairPolicy,
  workflowAutomationRevision,
  type WorkflowAutomationGrant,
} from '@/services/workflows/automation'
import { workflowAccountScope, workflowTextHash, workflowHash } from '@/services/workflows/executionLedger'
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
  mock.beforeSet.mockReset().mockResolvedValue(undefined)
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function delayStoreWrite(key: string) {
  const entered = deferred()
  const release = deferred()
  let intercepted = false
  mock.beforeSet.mockImplementation(async (file: string, candidateKey: string) => {
    if (file === 'luczor.workflow-automation.json' && candidateKey === key && !intercepted) {
      intercepted = true
      entered.resolve()
      await release.promise
    }
  })
  return { entered: entered.promise, release: () => release.resolve() }
}

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
  it('allows internal browser domains and files independently from the API host grant', async () => {
    const { bundle, scope } = await approvedBundle()
    await configureWorkflowAutomation(
      workflow,
      {
        export_results: true,
        allowed_tasks: ['browser.navigate', 'browser.read', 'api.call'],
        egress_hosts: [],
      },
      { projectId: 'project-1' }
    )
    bundle.workflow.grant = grant
    for (const url of ['https://new-domain.test/page', 'file:///home/user/Projekt/index.html']) {
      bundle.task_key = 'browser.navigate'
      bundle.params = { url }
      await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(true)
    }
    bundle.task_key = 'browser.read'
    bundle.params = { browser_session_id: 'session-a' }
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(true)
    bundle.task_key = 'api.call'
    bundle.params = { url: 'https://new-domain.test/page' }
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(false)
    bundle.task_key = 'browser.click'
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(false)
  })
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
    expect(mock.values.get('luczor.workflow-automation.json')?.size ?? 0).toBe(0)
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
      expect(dispatch.mock.calls.filter(([event]) => event.type === 'luczor:workflow-automation-changed')).toHaveLength(
        1
      )
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
    expect(mock.values.get('luczor.workflow-automation.json')?.size ?? 0).toBe(0)
    expect(mock.request.mock.calls.filter(call => call[1].method === 'POST')).toHaveLength(1)
  })
  it('rejects a stale successful automation GET after a local revocation', async () => {
    const { bundle, scope } = await approvedBundle()
    const server = mock.request.getMockImplementation()!
    const reachedGet = deferred()
    const releaseGet = deferred()
    const oldResponse = structuredClone(grant)
    mock.request.mockImplementation(async (path: string, options) => {
      if (path === '/workflows/7/automation' && options.method !== 'POST') {
        reachedGet.resolve()
        await releaseGet.promise
        return { data: { grant: oldResponse } }
      }
      return server(path, options)
    })
    const admission = workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)
    try {
      await reachedGet.promise
      await configureWorkflowAutomation(workflow, { status: 'revoked' }, { projectId: 'project-1' })
    } finally {
      releaseGet.resolve()
    }
    await expect(admission).resolves.toBe(false)
    expect(mock.values.get('luczor.workflow-automation.json')?.size).toBe(0)
  })
  it('orders revocation after an already pending grant write and leaves no resurrected grant', async () => {
    const scope = await workflowAccountScope(apiConfig)
    const delayed = delayStoreWrite(`${scope}:7`)
    const initial = configureWorkflowAutomation(workflow, { export_results: true }, { projectId: 'project-1' }).then(
      value => value,
      error => error
    )
    let revoke: Promise<unknown> | undefined
    try {
      await delayed.entered
      const revision = workflowAutomationRevision(scope, 7)
      revoke = configureWorkflowAutomation(workflow, { status: 'revoked' }, { projectId: 'project-1' })
      await vi.waitFor(() => expect(workflowAutomationRevision(scope, 7)).toBeGreaterThan(revision))
    } finally {
      delayed.release()
    }
    expect(await initial).toMatchObject({ message: 'workflow_automation_authorization_changed' })
    await expect(revoke).resolves.toMatchObject({ ok: true, grant: { status: 'revoked' } })
    expect(mock.values.get('luczor.workflow-automation.json')?.size).toBe(0)
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

describe('locally authorized repair lineage', () => {
  async function repairBundle() {
    const { bundle, scope } = await approvedBundle()
    const original = structuredClone(grant)
    const policy = {
      enabled: true,
      auto_activate: true,
      allow_script_repair: true,
      device_id: 'device-1',
      test_case_id: 3,
      assertions_hash: 'assertions',
      fixture_hash: 'fixtures',
      max_repairs: 2,
      grant_id: original.id,
      scope_hash: original.scope_hash,
      authorized_at: '2026-09-09T00:00:00Z',
    }
    await rememberLocalWorkflowRepairPolicy(7, policy, { projectId: 'project-1' })
    const evidence: Record<string, unknown> = {
      id: 21,
      mode: 'real',
      status: 'running',
      workflow_definition_id: 7,
      repair_revision_id: 17,
      device_id: 'device-1',
      workflow_test_case_id: 3,
      assertions_hash: policy.assertions_hash,
      fixture_hash: policy.fixture_hash,
      definition_hash: 'definition',
      code_hash: 'code',
      environment_hash: 'environment',
      device_environment_hash: 'device-environment',
      run_public_id: 'test-run',
      repair_status: 'proposed',
      repair_policy: policy,
      repair_policy_hash: await workflowHash(policy),
    }
    const binding = {
      run: evidence.run_public_id,
      test_evidence_id: evidence.id,
      repair_revision_id: evidence.repair_revision_id,
      definition_hash: evidence.definition_hash,
      code_hash: evidence.code_hash,
      environment_hash: evidence.environment_hash,
      assertions_hash: evidence.assertions_hash,
      fixture_hash: evidence.fixture_hash,
    }
    const next: WorkflowAutomationGrant = {
      ...original,
      id: 13,
      status: 'testing',
      predecessor_grant_id: original.id,
      repair_revision_id: 17,
      test_evidence_id: 21,
      scope_hash: 'testing-config',
      config: {
        ...original.config,
        script_hashes: { build: await workflowTextHash('console.log(2)') },
        test_binding: binding,
      },
    }
    bundle.params.code = 'console.log(2)'
    Object.assign(bundle.workflow, { grant: next, test_mode: 'real', test_run: 'test-run', test_binding: binding })
    mock.request.mockImplementation(async (path: string) =>
      path === '/workflow-tests/21' ? { data: evidence } : { data: { grant } }
    )
    return { bundle, scope, original, next, policy, evidence }
  }
  it('allows a changed script only in its exact running real-test binding', async () => {
    const { bundle, scope } = await repairBundle()
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(true)
    bundle.workflow.test_run = 'another-run'
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(false)
    bundle.workflow.test_run = 'test-run'
    bundle.params.code = 'console.log(99)'
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(false)
  })
  it('rejects increased rights, altered fixtures, failed evidence and local revocation', async () => {
    const { bundle, scope, next, evidence } = await repairBundle()
    next.config.max_output_bytes++
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(false)
    next.config.max_output_bytes--
    evidence.fixture_hash = 'different'
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(false)
    evidence.fixture_hash = 'fixtures'
    evidence.status = 'failed'
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(false)
    evidence.status = 'running'
    await rememberLocalWorkflowRepairPolicy(7, { enabled: false }, { projectId: 'project-1' })
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(false)
  })
  it('adopts a passed active successor while preserving a frozen predecessor run', async () => {
    const { bundle, scope, original, next, policy, evidence } = await repairBundle()
    next.status = 'active'
    next.approved_revision = 4
    next.config.approved_revision = 4
    delete next.config.test_binding
    next.scope_hash = 'active-successor'
    grant = next
    const updatedPolicy = { ...policy, grant_id: next.id, scope_hash: next.scope_hash }
    Object.assign(evidence, {
      status: 'passed',
      repair_status: 'activated',
      repair_policy: updatedPolicy,
      repair_policy_hash: await workflowHash(updatedPolicy),
    })
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(true)
    const stored = mock.values.get('luczor.workflow-automation.json')!.get(`${scope}:7`) as {
      grant: WorkflowAutomationGrant
      predecessors: WorkflowAutomationGrant[]
    }
    expect(stored.grant.id).toBe(next.id)
    expect(stored.predecessors[0]!.id).toBe(original.id)
    bundle.workflow.grant = original
    bundle.params.code = 'console.log(1)'
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(true)
    grant = { ...next, status: 'revoked' }
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(false)
  })
  it('does not turn a bare server testing flag into local authorization', async () => {
    const { bundle, scope } = await repairBundle()
    mock.values.get('luczor.workflow-automation.json')!.delete(`repair:${scope}:7`)
    await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(false)
  })
  it('rejects stale repair evidence after disabling repair authorization during its GET', async () => {
    const { bundle, scope, evidence } = await repairBundle()
    const reachedGet = deferred()
    const releaseGet = deferred()
    const oldEvidence = structuredClone(evidence)
    mock.request.mockImplementation(async (path: string) => {
      if (path === '/workflow-tests/21') {
        reachedGet.resolve()
        await releaseGet.promise
        return { data: oldEvidence }
      }
      return { data: { grant } }
    })
    const admission = workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)
    try {
      await reachedGet.promise
      await rememberLocalWorkflowRepairPolicy(7, { enabled: false }, { projectId: 'project-1' })
    } finally {
      releaseGet.resolve()
    }
    await expect(admission).resolves.toBe(false)
  })
  it('invalidates a pending testing admission when an enabled policy is replaced with narrower rights', async () => {
    const { bundle, scope, policy, evidence } = await repairBundle()
    const reachedGet = deferred()
    const releaseGet = deferred()
    const oldEvidence = structuredClone(evidence)
    mock.request.mockImplementation(async (path: string) => {
      if (path === '/workflow-tests/21') {
        reachedGet.resolve()
        await releaseGet.promise
        return { data: oldEvidence }
      }
      return { data: { grant } }
    })
    const admission = workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)
    try {
      await reachedGet.promise
      await rememberLocalWorkflowRepairPolicy(7, { ...policy, allow_script_repair: false }, { projectId: 'project-1' })
    } finally {
      releaseGet.resolve()
    }
    await expect(admission).resolves.toBe(false)
    expect(mock.values.get('luczor.workflow-automation.json')!.get(`repair:${scope}:7`)).toMatchObject({
      policy: { enabled: true, allow_script_repair: false },
    })
  })
  it('does not restore an enabled policy when its delayed Store.set settles after a disable', async () => {
    const { scope, policy } = await repairBundle()
    const delayed = delayStoreWrite(`repair:${scope}:7`)
    const writing = rememberLocalWorkflowRepairPolicy(
      7,
      { ...policy, max_repairs: 1 },
      { projectId: 'project-1' }
    ).then(
      () => null,
      error => error
    )
    let revoke: Promise<void> | undefined
    try {
      await delayed.entered
      const revision = workflowAutomationRevision(scope, 7)
      revoke = rememberLocalWorkflowRepairPolicy(7, { enabled: false }, { projectId: 'project-1' })
      await vi.waitFor(() => expect(workflowAutomationRevision(scope, 7)).toBeGreaterThan(revision))
    } finally {
      delayed.release()
    }
    expect(await writing).toMatchObject({ message: 'workflow_automation_authorization_changed' })
    await revoke
    expect(mock.values.get('luczor.workflow-automation.json')!.has(`repair:${scope}:7`)).toBe(false)
  })
  it('does not restore a successor or its policy when adoption is interrupted by full local revocation', async () => {
    const { bundle, scope, next, policy, evidence } = await repairBundle()
    next.status = 'active'
    next.approved_revision = 4
    next.config.approved_revision = 4
    delete next.config.test_binding
    next.scope_hash = 'active-successor'
    grant = next
    const updatedPolicy = { ...policy, grant_id: next.id, scope_hash: next.scope_hash }
    Object.assign(evidence, {
      status: 'passed',
      repair_status: 'activated',
      repair_policy: updatedPolicy,
      repair_policy_hash: await workflowHash(updatedPolicy),
    })
    const server = mock.request.getMockImplementation()!
    mock.request.mockImplementation(
      async (path: string, options: { method?: string; body?: Record<string, unknown> }) => {
        if (options.method === 'POST') {
          const { status, operation_id: _operation, local_approved: _approval, ...config } = options.body!
          grant = { ...grant, status: String(status), config: config as WorkflowAutomationGrant['config'] }
          return { data: { grant } }
        }
        return server(path, options)
      }
    )
    const delayed = delayStoreWrite(`${scope}:7`)
    const adoption = workflowAutomationAllows(bundle, scope, 'user:1', apiConfig).then(
      value => value,
      error => error
    )
    let revoke: Promise<unknown> | undefined
    try {
      await delayed.entered
      const revision = workflowAutomationRevision(scope, 7)
      revoke = configureWorkflowAutomation(workflow, { status: 'revoked' }, { projectId: 'project-1' })
      await vi.waitFor(() => expect(workflowAutomationRevision(scope, 7)).toBeGreaterThan(revision))
    } finally {
      delayed.release()
    }
    expect(await adoption).toMatchObject({ message: 'workflow_automation_authorization_changed' })
    await expect(revoke).resolves.toMatchObject({ ok: true, grant: { status: 'revoked' } })
    expect(mock.values.get('luczor.workflow-automation.json')?.size).toBe(0)
  })
  it('keeps an actually frozen predecessor authorized after five independently tested successors', async () => {
    const { bundle, scope, original, policy, evidence } = await repairBundle()
    const frozen = structuredClone(bundle)
    frozen.workflow.grant = original
    frozen.params.code = 'console.log(1)'
    mock.request.mockImplementation(async (path: string) =>
      path.startsWith('/workflow-tests/') ? { data: evidence } : { data: { grant } }
    )
    let predecessor = original
    for (let index = 0; index < 5; index++) {
      const code = `console.log(${index + 2})`
      const successor: WorkflowAutomationGrant = {
        ...predecessor,
        id: 13 + index,
        predecessor_grant_id: predecessor.id,
        repair_revision_id: 17 + index,
        test_evidence_id: 21 + index,
        status: 'active',
        approved_revision: 4 + index,
        scope_hash: `active-successor-${index}`,
        config: {
          ...predecessor.config,
          approved_revision: 4 + index,
          script_hashes: { build: await workflowTextHash(code) },
        },
      }
      grant = successor
      const currentPolicy = { ...policy, grant_id: successor.id, scope_hash: successor.scope_hash }
      Object.assign(evidence, {
        id: successor.test_evidence_id,
        repair_revision_id: successor.repair_revision_id,
        status: 'passed',
        repair_status: 'activated',
        repair_policy: currentPolicy,
        repair_policy_hash: await workflowHash(currentPolicy),
      })
      bundle.workflow.grant = successor
      bundle.workflow.revision = successor.approved_revision
      bundle.params.code = code
      await expect(workflowAutomationAllows(bundle, scope, 'user:1', apiConfig)).resolves.toBe(true)
      predecessor = successor
    }
    await expect(workflowAutomationAllows(frozen, scope, 'user:1', apiConfig)).resolves.toBe(true)
    frozen.params.code = 'console.log(99)'
    await expect(workflowAutomationAllows(frozen, scope, 'user:1', apiConfig)).resolves.toBe(false)
  })
})
