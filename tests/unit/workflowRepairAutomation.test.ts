import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
const mock = vi.hoisted(() => ({ stores: new Map<string, Map<string, unknown>>() }))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async (name: string) => {
      let values = mock.stores.get(name)
      if (!values) {
        values = new Map()
        mock.stores.set(name, values)
      }
      return {
        get: async (key: string) => structuredClone(values.get(key)),
        keys: async () => [...values.keys()],
        set: async (key: string, value: unknown) => {
          values.set(key, structuredClone(value))
        },
        save: async () => {},
      }
    },
  },
}))
vi.mock('@/services/workflows/llm', () => ({ runWorkflowLlm: vi.fn() }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: vi.fn() }))
vi.mock('@/services/workflows/capabilities', () => ({
  currentWorkflowEnvironmentHash: vi.fn(),
  refreshWorkflowCapabilities: vi.fn(),
}))
import { Store } from '@tauri-apps/plugin-store'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { executionGate, type ExecutionTicket } from '@/services/executionGate'
import {
  applyWorkflowRepairChanges,
  createWorkflowRepairDriver,
  readLocalWorkflowRepairStatus,
} from '@/services/workflows/repairAutomation'
import { workflowAccountScope, workflowHash } from '@/services/workflows/executionLedger'
import { WORKFLOW_AUTOMATION_INVALIDATED } from '@/services/workflows/automation'
import type { Workflow } from '@/services/workflows/types'

const config = { baseUrl: 'https://workflow.test', clientId: 'device-1', deviceKey: 'test-key' }
const identity = {
  principalId: 'user-1',
  config,
  accountId: 1,
  serverOrigin: 'https://workflow.test',
  serverInstance: 'instance',
}
const HASH = (letter: string) => letter.repeat(64)
type Evidence = Record<string, unknown> & { id: number; mode: string; status: string; repair_revision_id: number }
type Repair = Record<string, unknown> & { id: number; status: string; definition: unknown }
let workflow: Workflow
let source: Record<string, unknown>
let policy: Record<string, unknown>
let scope: string
let time: number
let environment: string
let repairs: Repair[]
let proofs: Evidence[]
let posts: Array<{ path: string; body: Record<string, unknown> }>
let operationResults: Map<string, unknown>
let beforeRequest: ((path: string) => void | Promise<void>) | undefined
let failAfterProposal: boolean
let failAfterTest: boolean
let failProposalStatus: number | undefined
let autoActivate: boolean
let recordKey: string
let lastSignal: AbortSignal | undefined
const project = {
  projectId: 'project-1',
  principalId: 'user-1',
  rootPath: 'E:/project',
  status: 'ready' as const,
  updatedAt: 7,
  displayName: 'Project',
  isGitRepository: false,
}
type Deps = NonNullable<Parameters<typeof createWorkflowRepairDriver>[0]>
let deps: Deps
let propose: Mock<Deps['propose']>

beforeEach(async () => {
  mock.stores.clear()
  vi.clearAllMocks()
  vi.mocked(getVerifiedAccountSnapshot).mockResolvedValue(identity)
  const window = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} })
  vi.stubGlobal('window', window)
  executionGate.update({ mode: 'act', killSwitch: false, scope: crypto.randomUUID() })
  scope = await workflowAccountScope(config)
  time = 100000
  environment = HASH('e')
  repairs = []
  proofs = []
  posts = []
  operationResults = new Map()
  beforeRequest = undefined
  failAfterProposal = false
  failAfterTest = false
  failProposalStatus = undefined
  autoActivate = false
  policy = {
    enabled: true,
    auto_activate: true,
    allow_script_repair: true,
    device_id: config.clientId,
    test_case_id: 8,
    assertions_hash: HASH('a'),
    fixture_hash: HASH('f'),
    max_repairs: 2,
    grant_id: 6,
    scope_hash: HASH('b'),
  }
  workflow = {
    id: 7,
    name: 'JSON transform',
    version: 3,
    project_id: 1,
    project_external_id: 'project-1',
    status: 'active',
    is_locked: false,
    repair_policy: policy,
    definition: {
      schema_version: 2,
      steps: [
        { key: 'compute', type: 'node.run', payload: { code: 'bad()', device_id: config.clientId, input: {} } },
        {
          key: 'verify',
          type: 'test.assert',
          payload: { assertions: [{ path: 'ok', operator: 'eq', value: true }] },
          depends_on: ['compute'],
        },
      ],
    },
  }
  source = {
    id: 20,
    public_id: 'source-20',
    workflow_definition_id: 7,
    definition_version: 3,
    status: 'failed',
    sandbox: false,
    test_mode: null,
    root_workflow_run_id: null,
    budgets: { max_repairs: 2 },
    definition_snapshot: { definition: structuredClone(workflow.definition), version: 3 },
    steps: [{ step_key: 'compute', status: 'failed', error: 'ReferenceError: bad is not defined' }],
  }
  recordKey = `${scope}:7:20`
  const grants = await Store.load('luczor.workflow-automation.json')
  await grants.set(`repair:${scope}:7`, {
    principalId: identity.principalId,
    workspaceUpdatedAt: 7,
    policy,
    policyHash: await workflowHash(policy),
  })
  await grants.set(`${scope}:7`, {
    principalId: identity.principalId,
    workspaceUpdatedAt: 7,
    grant: {
      id: 6,
      status: 'active',
      scope_hash: HASH('b'),
      config: { project_external_id: 'project-1', root_path: 'e:/project' },
    },
  })
  propose = vi.fn<Deps['propose']>(async () => ({
    changes: [{ step_key: 'compute', code: 'process.stdout.write("{}")' }],
  }))
  deps = {
    store: name => Store.load(name),
    identity: async () => identity,
    workspace: async () => project,
    now: () => time,
    environment: async () => environment,
    ready: async () => true,
    capabilities: vi.fn(async () => ({})),
    propose,
    request: async <T>(
      path: string,
      options: { method?: 'POST'; body?: Record<string, unknown>; signal: AbortSignal }
    ) => {
      lastSignal = options.signal
      await beforeRequest?.(path)
      const body = options.body
      let response: unknown
      if (options.method === 'POST') {
        posts.push({ path, body: structuredClone(body!) })
        if (path === '/workflows/7/repairs') {
          if (failProposalStatus)
            throw Object.assign(new Error('workflow_repair_rights_or_cost_scope_changed'), {
              status: failProposalStatus,
            })
          const repair: Repair = {
            id: repairs.length + 30,
            workflow_definition_id: 7,
            source_run_id: 20,
            base_version: 3,
            status: 'proposed',
            definition: structuredClone(body!.definition),
            snapshot: { definition: body!.definition },
            definition_hash: HASH('d'),
            code_hash: HASH('c'),
            scope: { policy: structuredClone(policy) },
          }
          repairs.push(repair)
          response = repair
        } else if (path === '/workflows/7/tests') {
          const evidence: Evidence = {
            id: proofs.length + 40,
            workflow_definition_id: 7,
            workflow_test_case_id: 8,
            repair_revision_id: body!.repair_revision_id as number,
            mode: body!.mode as string,
            status: body!.mode === 'definition' ? 'passed' : 'running',
            definition_hash: HASH('d'),
            code_hash: HASH('c'),
            assertions_hash: HASH('a'),
            fixture_hash: HASH('f'),
            environment_hash: HASH('9'),
            device_environment_hash: environment,
            device_id: config.clientId,
            repair_status: 'proposed',
          }
          proofs.push(evidence)
          response = evidence
        } else throw new Error(`unexpected POST ${path}`)
        operationResults.set(body!.operation_id as string, structuredClone(response))
        if (failAfterProposal && path.endsWith('/repairs')) {
          failAfterProposal = false
          throw new Error('network response lost')
        }
        if (failAfterTest && path.endsWith('/tests')) {
          failAfterTest = false
          throw new Error('test response lost')
        }
      } else if (path === '/workflows/7') response = workflow
      else if (path === '/workflows/7/automation')
        response = { grant: { id: 6, scope_hash: HASH('b'), status: 'active' } }
      else if (path === '/workflows/7/test-cases')
        response = [
          {
            id: 8,
            workflow_definition_id: 7,
            assertions_hash: HASH('a'),
            fixture_hash: HASH('f'),
            specification: { real_test_authorized: true, device_id: config.clientId },
          },
        ]
      else if (path === '/workflows/7/repairs') response = repairs
      else if (path === '/workflows/7/runs') response = [source]
      else if (path === '/workflow-runs/source-20') response = source
      else if (path === '/workflows/7/tests') response = proofs
      else if (path.startsWith('/workflow-tests/')) {
        response = proofs.find(item => item.id === Number(path.split('/').at(-1)))
        const proof = response as Evidence
        if (autoActivate && proof.mode === 'real' && proof.status === 'passed') {
          proof.repair_status = 'activated'
          repairs.find(item => item.id === proof.repair_revision_id)!.status = 'activated'
          workflow.version = 4
          workflow.repair_policy = { ...policy, grant_id: 99, scope_hash: HASH('z') }
        }
      } else if (path.startsWith('/workflow-operations/')) {
        const saved = operationResults.get(path.split('/').at(-1)!)
        response = saved ? { status: 'completed', response: saved } : { status: 'not_found' }
      } else throw new Error(`unexpected GET ${path}`)
      return { data: structuredClone(response) as T }
    },
  }
})

const state = () =>
  mock.stores.get('luczor.workflow-repairs.json')?.get(recordKey) as
    { status: string; attempts: Array<{ phase: string; error?: string; candidate?: unknown }> } | undefined
async function tick(driver: ReturnType<typeof createWorkflowRepairDriver>) {
  time += 31000
  await driver.poll(config, new AbortController().signal)
}
async function setupTests(driver: ReturnType<typeof createWorkflowRepairDriver>) {
  await tick(driver)
  await tick(driver)
  await tick(driver)
}

describe('bounded authorized workflow repair driver', () => {
  it('creates a local proposal, persists a copied candidate, then runs definition/simulation/real in order and confirms server activation', async () => {
    const driver = createWorkflowRepairDriver(deps)
    await setupTests(driver)
    expect(posts.map(item => item.body.mode ?? 'proposal')).toEqual(['proposal', 'definition'])
    expect(propose).toHaveBeenCalledOnce()
    expect(propose.mock.calls[0]?.[0]).toMatchObject({
      failure: [{ step_key: 'compute', error: 'ReferenceError: bad is not defined' }],
    })
    expect(workflow.definition.steps[0]?.payload.code).toBe('bad()')
    expect((repairs[0]?.definition as Workflow['definition']).steps[1]).toEqual(workflow.definition.steps[1])
    await tick(driver)
    expect(posts.at(-1)?.body.mode).toBe('simulation')
    await tick(driver)
    expect(posts.filter(item => item.body.mode === 'real')).toHaveLength(0)
    proofs.find(item => item.mode === 'simulation')!.status = 'passed'
    await tick(driver)
    expect(posts.at(-1)?.body.mode).toBe('real')
    proofs.find(item => item.mode === 'real')!.status = 'passed'
    autoActivate = true
    await tick(driver)
    expect(state()?.status).toBe('complete')
    expect(workflow.version).toBe(4)
    expect(posts.some(item => item.path.endsWith('/activate') || 'local_approved' in item.body)).toBe(false)
  })

  it('requires a locally recorded matching predecessor and never treats server policy as approval', async () => {
    mock.stores.get('luczor.workflow-automation.json')!.delete(`repair:${scope}:7`)
    await tick(createWorkflowRepairDriver(deps))
    expect(propose).not.toHaveBeenCalled()
    expect(posts).toEqual([])
  })

  it('does not prepare a model when none is already ready', async () => {
    deps.ready = async () => false
    await tick(createWorkflowRepairDriver(deps))
    expect(propose).not.toHaveBeenCalled()
    expect(state()).toBeUndefined()
  })

  it.each(['is_locked', 'is_edit_locked', 'disabled'])(
    'does not generate proposals for a server lock or disabled workflow: %s',
    async state => {
      if (state === 'disabled') workflow.status = 'disabled'
      else Reflect.set(workflow, state, true)
      await tick(createWorkflowRepairDriver(deps))
      expect(propose).not.toHaveBeenCalled()
      expect(posts).toEqual([])
    }
  )

  it('aborts an in-flight proposal immediately on local revocation and cannot save or send its late result', async () => {
    propose.mockImplementation(async (_input: unknown, _project: string, ticket: ExecutionTicket) => {
      window.dispatchEvent(new CustomEvent(WORKFLOW_AUTOMATION_INVALIDATED, { detail: { scope, definitionId: 7 } }))
      expect(ticket.signal.aborted).toBe(true)
      return { changes: [{ step_key: 'compute', code: 'late()' }] }
    })
    await expect(tick(createWorkflowRepairDriver(deps))).rejects.toThrow()
    expect(posts).toEqual([])
    expect(state()?.attempts[0]?.phase).toBe('generating')
  })

  it('does not accept a workspace rebind after a network wait', async () => {
    const original = deps.workspace
    beforeRequest = path => {
      if (path === '/workflows/7/test-cases') deps.workspace = async () => ({ ...project, updatedAt: 8 })
    }
    await expect(tick(createWorkflowRepairDriver(deps))).rejects.toThrow('authorization_changed')
    expect(propose).not.toHaveBeenCalled()
    expect(posts).toEqual([])
    deps.workspace = original
  })

  it('counts rejected candidates as attempts and stops at two without changing assertions', async () => {
    propose.mockResolvedValue({ changes: [{ step_key: 'verify', payload: { assertions: [] } }] })
    const driver = createWorkflowRepairDriver(deps)
    await tick(driver)
    await tick(driver)
    await tick(driver)
    await tick(driver)
    expect(propose).toHaveBeenCalledTimes(2)
    expect(state()?.status).toBe('exhausted')
    expect(posts).toEqual([])
  })

  it('persists the two-attempt ceiling across driver recreation and interrupted proposal markers', async () => {
    propose.mockRejectedValue(new Error('proposal failed'))
    await tick(createWorkflowRepairDriver(deps))
    const stored = state()!
    stored.attempts[0]!.phase = 'generating'
    await tick(createWorkflowRepairDriver(deps))
    expect(propose).toHaveBeenCalledTimes(1)
    await tick(createWorkflowRepairDriver(deps))
    await tick(createWorkflowRepairDriver(deps))
    expect(propose).toHaveBeenCalledTimes(2)
    expect(state()?.status).toBe('exhausted')
  })

  it('shows a durable exhausted result without leaking raw model errors, code or another account status', async () => {
    propose.mockRejectedValue(new Error('private candidate code and prompt text'))
    await tick(createWorkflowRepairDriver(deps))
    await tick(createWorkflowRepairDriver(deps))
    await tick(createWorkflowRepairDriver(deps))
    const result = await readLocalWorkflowRepairStatus(7, 'project-1')
    expect(result).toMatchObject({ status: 'exhausted', attempts: 2, label: 'Reparaturautomatik angehalten' })
    expect(JSON.stringify(result)).not.toContain('private candidate')
    expect(JSON.stringify(result)).not.toContain('bad()')
    expect(await readLocalWorkflowRepairStatus(7, 'other-project')).toBeNull()
    vi.mocked(getVerifiedAccountSnapshot).mockResolvedValue({ ...identity, principalId: 'other-user' })
    expect(await readLocalWorkflowRepairStatus(7, 'project-1')).toBeNull()
    expect(posts).toEqual([])
  })

  it.each([null, '', '2', -1, 3, 1.5])(
    'refuses malformed local repair limit %s even with its matching saved hash',
    async value => {
      policy.max_repairs = value
      const store = await Store.load('luczor.workflow-automation.json')
      const saved = await store.get<Record<string, unknown>>(`repair:${scope}:7`)
      await store.set(`repair:${scope}:7`, { ...saved, policy, policyHash: await workflowHash(policy) })
      await tick(createWorkflowRepairDriver(deps))
      expect(propose).not.toHaveBeenCalled()
      expect(posts).toEqual([])
    }
  )

  it.each(['no_error', 'cancelled', 'old_version', 'test_run', 'child_run'])(
    'requires actual current root failure evidence: %s',
    async variant => {
      if (variant === 'no_error') source.steps = [{ step_key: 'compute', status: 'failed', error: '' }]
      if (variant === 'cancelled') source.status = 'cancelled'
      if (variant === 'old_version') source.definition_version = 2
      if (variant === 'test_run') source.test_mode = 'real'
      if (variant === 'child_run') source.root_workflow_run_id = 19
      await tick(createWorkflowRepairDriver(deps))
      expect(propose).not.toHaveBeenCalled()
      expect(state()).toBeUndefined()
    }
  )

  it('reconciles an uncertain proposal POST before retry and never creates the same candidate twice', async () => {
    const driver = createWorkflowRepairDriver(deps)
    await tick(driver)
    failAfterProposal = true
    await expect(tick(driver)).rejects.toThrow('unklar')
    await tick(driver)
    expect(posts.filter(item => item.path.endsWith('/repairs'))).toHaveLength(1)
    expect(state()?.attempts[0]?.phase).toBe('testing')
    expect(mock.stores.get('luczor.workflow-operations.json')?.get('pending')).toEqual([])
  })

  it('recovers a lost simulation response separately from completed definition evidence without duplicating the test', async () => {
    let driver = createWorkflowRepairDriver(deps)
    await setupTests(driver)
    failAfterTest = true
    await expect(tick(driver)).rejects.toThrow('unklar')
    driver = createWorkflowRepairDriver(deps)
    await tick(driver)
    expect(posts.filter(item => item.body.mode === 'simulation')).toHaveLength(1)
    expect(mock.stores.get('luczor.workflow-operations.json')?.get('pending')).toEqual([])
    proofs.find(item => item.mode === 'simulation')!.status = 'passed'
    await tick(driver)
    expect(posts.filter(item => item.body.mode === 'real')).toHaveLength(1)
  })

  it('reconciles externally triggered autoactivation only from the recorded exact three passing evidences', async () => {
    const driver = createWorkflowRepairDriver(deps)
    await setupTests(driver)
    await tick(driver)
    proofs.find(item => item.mode === 'simulation')!.status = 'passed'
    await tick(driver)
    proofs.find(item => item.mode === 'real')!.status = 'passed'
    repairs[0]!.status = 'activated'
    workflow.version = 4
    workflow.repair_policy = { ...policy, grant_id: 99, scope_hash: HASH('d') }
    const count = posts.length
    await tick(createWorkflowRepairDriver(deps))
    expect(state()?.status).toBe('complete')
    expect(posts).toHaveLength(count)
    expect(propose).toHaveBeenCalledTimes(1)
  })

  it('does not confirm autoactivation with a changed fixture, even when the server repair is activated', async () => {
    const driver = createWorkflowRepairDriver(deps)
    await setupTests(driver)
    await tick(driver)
    proofs.find(item => item.mode === 'simulation')!.status = 'passed'
    await tick(driver)
    const real = proofs.find(item => item.mode === 'real')!
    real.status = 'passed'
    real.fixture_hash = HASH('b')
    repairs[0]!.status = 'activated'
    workflow.version = 4
    workflow.repair_policy = { ...policy, grant_id: 99 }
    await tick(createWorkflowRepairDriver(deps))
    expect(state()?.status).toBe('active')
  })

  it('never starts a real test after mismatched simulation hashes or changed device environment', async () => {
    const driver = createWorkflowRepairDriver(deps)
    await setupTests(driver)
    await tick(driver)
    const simulation = proofs.find(item => item.mode === 'simulation')!
    simulation.status = 'passed'
    simulation.code_hash = HASH('x')
    await tick(driver)
    expect(state()?.attempts[0]?.phase).toBe('failed')
    expect(posts.some(item => item.body.mode === 'real')).toBe(false)
    environment = HASH('q')
    await tick(driver)
    expect(propose).toHaveBeenCalledTimes(1)
  })

  it('waits while tests run and keeps one account tick active at a time', async () => {
    let release!: () => void
    propose.mockImplementation(async () => {
      await new Promise<void>(resolve => {
        release = resolve
      })
      return { changes: [{ step_key: 'compute', code: 'fixed()' }] }
    })
    const driver = createWorkflowRepairDriver(deps)
    const first = tick(driver)
    await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce())
    const second = driver.poll(config, new AbortController().signal)
    release()
    await Promise.all([first, second])
    expect(propose).toHaveBeenCalledOnce()
  })

  it('rejects a changed server policy without sending proposals or tests', async () => {
    workflow.repair_policy = { ...policy, max_repairs: 1 }
    await tick(createWorkflowRepairDriver(deps))
    expect(posts).toEqual([])
    expect(propose).not.toHaveBeenCalled()
  })

  it('uses a new attempt after definitive server rejection but preserves unresolved requests', async () => {
    const driver = createWorkflowRepairDriver(deps)
    await tick(driver)
    failProposalStatus = 409
    await tick(driver)
    expect(state()?.attempts[0]?.phase).toBe('failed')
    await tick(driver)
    expect(propose).toHaveBeenCalledTimes(2)
    expect(lastSignal?.aborted).toBe(false)
  })
})

describe('repair changes preserve protected graph semantics', () => {
  it('rejects script edits without the explicit script-repair right, new steps, mixed fields and scope expansion', () => {
    expect(() =>
      applyWorkflowRepairChanges(workflow.definition, { changes: [{ step_key: 'compute', code: 'ok()' }] }, false)
    ).toThrow('not_authorized')
    expect(() =>
      applyWorkflowRepairChanges(workflow.definition, { changes: [{ step_key: 'new', code: 'ok()' }] }, true)
    ).toThrow('unknown')
    expect(() =>
      applyWorkflowRepairChanges(
        workflow.definition,
        { changes: [{ step_key: 'compute', code: 'ok()', payload: {} }] },
        true
      )
    ).toThrow('not_authorized')
    const data = { steps: [{ key: 'map', type: 'data.map', payload: { device_id: 'old', expression: 'input' } }] }
    expect(() =>
      applyWorkflowRepairChanges(data, { changes: [{ step_key: 'map', payload: { device_id: 'new' } }] }, true)
    ).toThrow('scope_expansion')
  })
})
