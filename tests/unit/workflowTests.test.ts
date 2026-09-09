import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  request: vi.fn(),
  confirm: vi.fn(),
  access: vi.fn(),
  remember: vi.fn(),
  capabilities: vi.fn(),
  values: new Map<string, unknown>(),
  changed: false,
}))
vi.mock('@/services/api/luczorApi', () => ({ requestWithConfig: mock.request }))
vi.mock('@/services/confirmation', () => ({ requestConfirmation: mock.confirm }))
vi.mock('@/services/workflows/access', () => ({ captureWorkflowAccess: mock.access }))
vi.mock('@/services/workflows/automation', () => ({ rememberLocalWorkflowRepairPolicy: mock.remember }))
vi.mock('@/services/workflows/capabilities', () => ({ refreshWorkflowCapabilities: mock.capabilities }))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async () => ({
      get: async (key: string) => structuredClone(mock.values.get(key)),
      set: async (key: string, value: unknown) => mock.values.set(key, structuredClone(value)),
      save: async () => {},
    }),
  },
}))

import { executionGate } from '@/services/executionGate'
import {
  createWorkflowTests,
  workflowTestResultLabel,
  type WorkflowTestCase,
  type WorkflowTestEvidence,
} from '@/services/workflows/workflowTests'
import type { Workflow } from '@/services/workflows/types'

const config = { baseUrl: 'https://workflow.test', clientId: 'device-1', deviceKey: 'test-key' }
let workflow: Workflow
let testCase: WorkflowTestCase
let evidence: WorkflowTestEvidence
let policy: Record<string, unknown>
const service = () => createWorkflowTests('project-1', new AbortController().signal)
const posts = () => mock.request.mock.calls.filter(([, options]) => options?.method === 'POST')

beforeEach(() => {
  vi.clearAllMocks()
  mock.values.clear()
  mock.changed = false
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  executionGate.update({ mode: 'act', killSwitch: false, scope: crypto.randomUUID() })
  workflow = {
    id: 7,
    name: 'Build',
    version: 3,
    project_id: 1,
    project_external_id: 'project-1',
    status: 'active',
    is_locked: false,
    definition: { steps: [{ key: 'a', type: 'context', payload: {} }] },
  }
  testCase = {
    id: 8,
    workflow_definition_id: 7,
    name: 'Fixture',
    assertions_hash: 'assertion-hash',
    fixture_hash: 'fixture-hash',
    specification: {
      input: {},
      fixtures: {},
      assertions: [{ step_key: 'a', path: 'ok', operator: 'eq', value: true }],
      real_test_authorized: true,
      device_id: 'device-1',
    },
  }
  evidence = {
    id: 9,
    workflow_definition_id: 7,
    workflow_test_case_id: 8,
    mode: 'real',
    status: 'running',
    definition_hash: 'definition',
    code_hash: 'code',
    assertions_hash: testCase.assertions_hash,
    fixture_hash: testCase.fixture_hash,
    environment_hash: 'environment',
  }
  policy = {
    enabled: true,
    auto_activate: true,
    allow_script_repair: false,
    max_repairs: 2,
    test_case_id: 8,
    device_id: config.clientId,
    assertions_hash: testCase.assertions_hash,
    fixture_hash: testCase.fixture_hash,
    grant_id: 1,
    scope_hash: 'original-grant',
    authorized_at: '2026-09-09',
  }
  mock.confirm.mockResolvedValue({ approved: true })
  mock.remember.mockResolvedValue(undefined)
  mock.capabilities.mockResolvedValue({ data: {} })
  mock.access.mockImplementation(async (ctx: { signal: AbortSignal }, _project: unknown, mutating: boolean) => {
    const execution = executionGate.capture(ctx.signal)
    const check = async () => {
      executionGate.assert(execution, mutating)
      if (mock.changed) throw new Error('Kontoverbindung geändert')
    }
    await check()
    return {
      config,
      principalId: 'user:1',
      execution,
      check,
      workflow: async () => {
        await check()
        return structuredClone(workflow)
      },
    }
  })
  mock.request.mockImplementation(
    async (path: string, options: { method?: string; body?: Record<string, unknown> }) => {
      if (options?.method === 'POST') {
        if (path.endsWith('/test-cases')) return { data: { ...testCase, specification: options.body?.specification } }
        if (path.endsWith('/repair-policy')) return { data: policy }
        return { data: evidence }
      }
      if (path.includes('/workflow-operations/')) return { data: { status: 'not_found' } }
      if (path.endsWith('/test-cases')) return { data: [testCase] }
      if (path.endsWith('/tests')) return { data: [evidence] }
      if (path.endsWith('/repairs')) return { data: [] }
      return { data: evidence }
    }
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('device workflow tests and recovery', () => {
  it('strips pasted approval/device flags unless this native action is explicitly confirmed', async () => {
    const created = await service().createCase(7, 'Fixture', testCase.specification, false)
    expect(created.specification).not.toHaveProperty('real_test_authorized')
    expect(created.specification).not.toHaveProperty('device_id')
    expect(testCase.specification.real_test_authorized).toBe(true)
    expect(mock.confirm).not.toHaveBeenCalled()
  })
  it('persists the current verified device only after a complete local fixture preview', async () => {
    const created = await service().createCase(
      7,
      'Fixture',
      { ...testCase.specification, device_id: 'forged-device' },
      true
    )
    expect(created.specification.device_id).toBe('device-1')
    expect(mock.confirm.mock.calls[0]?.[0]).toContain('assertions')
    expect(mock.confirm.mock.calls[0]?.[0]).not.toContain('forged-device')
  })
  it('sends no mutation when native confirmation is declined or unavailable in a web preview', async () => {
    mock.confirm.mockResolvedValueOnce({ approved: false })
    await expect(service().createCase(7, 'Fixture', testCase.specification, true)).rejects.toThrow('nicht erteilt')
    vi.stubGlobal('window', {})
    await expect(service().createCase(7, 'Fixture', testCase.specification, true)).rejects.toThrow('Desktop-App')
    expect(posts()).toHaveLength(0)
  })
  it('rechecks revocation after an asynchronous confirmation', async () => {
    mock.confirm.mockImplementationOnce(async () => {
      executionGate.update({ mode: 'observe', killSwitch: false, scope: 'other-project' })
      return { approved: true }
    })
    await expect(service().start(7, 3, 8, 'real')).rejects.toThrow('geändert')
    expect(posts()).toHaveLength(0)
  })
  it('blocks an old-account result during load and a cross-workflow evidence response', async () => {
    mock.request.mockImplementationOnce(async () => {
      mock.changed = true
      return { data: [testCase] }
    })
    await expect(service().load(7)).rejects.toThrow('Kontoverbindung geändert')
    mock.changed = false
    mock.request.mockResolvedValueOnce({ data: { ...evidence, workflow_definition_id: 999 } })
    await expect(service().refresh(7, 9)).rejects.toThrow('anderen Workflow')
  })
  it('requires a saved current-device fixture for real starts', async () => {
    testCase.specification.device_id = 'other-device'
    await expect(service().start(7, 3, 8, 'real')).rejects.toThrow('aktuellen Gerät')
    expect(posts()).toHaveLength(0)
    expect(mock.confirm).not.toHaveBeenCalled()
  })
  it('refreshes actual capabilities only after approval and prevents a start when probing fails', async () => {
    mock.capabilities.mockImplementationOnce(async () => {
      expect(mock.confirm).toHaveBeenCalledOnce()
      throw new Error('workflow_capability_native_contract_missing')
    })
    await expect(service().start(7, 3, 8, 'real')).rejects.toThrow('native_contract_missing')
    expect(posts()).toHaveLength(0)
    expect(mock.capabilities).toHaveBeenCalledWith(config, expect.any(AbortSignal))
  })
  it('binds all repair test modes to the same approved device environment', async () => {
    await service().start(7, 3, 8, 'simulation', 42)
    expect(posts()[0]?.[1].body).toMatchObject({
      mode: 'simulation',
      device_id: 'device-1',
      repair_revision_id: 42,
      expected_version: 3,
    })
    expect(mock.confirm).not.toHaveBeenCalled()
  })
  it('leaves unbound definition checks without an invented device', async () => {
    testCase.specification = { input: {}, fixtures: {}, assertions: [] }
    await service().start(7, 3, 8, 'definition')
    expect(posts()[0]?.[1].body).not.toHaveProperty('device_id')
  })
  it('prevents stale-version starts without poisoning the operations ledger', async () => {
    workflow.version = 4
    await expect(service().start(7, 3, 8, 'definition')).rejects.toThrow('Version wurde geändert')
    expect(posts()).toHaveLength(0)
    expect(mock.values.get('pending')).toEqual([])
  })
  it('recovers a lost start response by its original operation ID without a second start', async () => {
    const firstRequest = mock.request.getMockImplementation()!
    let committedOperation = ''
    mock.request.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') {
        committedOperation = options.body.operation_id
        throw new Error('Connection lost after commit')
      }
      if (path.endsWith(`/workflow-operations/${committedOperation}`))
        return { data: { status: 'completed', response: evidence } }
      return firstRequest(path, options)
    })
    await expect(service().start(7, 3, 8, 'definition')).rejects.toThrow('unklar')
    expect(await service().start(7, 3, 8, 'definition')).toEqual(evidence)
    expect(posts()).toHaveLength(1)
    expect(mock.values.get('pending')).toEqual([])
  })
  it('records the exact locally approved server repair policy and rejects widened responses', async () => {
    const input = { testCaseId: 8, enabled: true, autoActivate: true, allowScriptRepair: false, maxRepairs: 2 }
    await service().configureRepair(7, 3, input)
    expect(mock.remember).toHaveBeenCalledWith(7, policy, expect.objectContaining({ projectId: 'project-1' }))
    mock.remember.mockClear()
    policy.allow_script_repair = true
    await expect(service().configureRepair(7, 3, input)).rejects.toThrow('bestätigten Auswahl')
    expect(mock.remember).not.toHaveBeenCalled()
  })
  it('blocks mutation in observe mode before any network access', async () => {
    executionGate.update({ mode: 'observe', killSwitch: false, scope: 'p' })
    await expect(service().start(7, 3, 8, 'definition')).rejects.toThrow('Beobachten')
    expect(mock.request).not.toHaveBeenCalled()
  })
  it('never labels a passed definition check or simulated test as real acceptance', () => {
    expect(workflowTestResultLabel({ mode: 'definition', status: 'passed' })).toBe('Definition gültig')
    expect(workflowTestResultLabel({ mode: 'simulation', status: 'passed' })).toBe('Simulation bestanden')
    expect(workflowTestResultLabel({ mode: 'real', status: 'running' })).toBe('Prüfung läuft')
    expect(workflowTestResultLabel({ mode: 'real', status: 'failed' })).toBe('Prüfung fehlgeschlagen')
  })
})
