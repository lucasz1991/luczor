import { Store } from '@tauri-apps/plugin-store'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { requestWithConfig, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import { requestConfirmation } from '@/services/confirmation'
import { executionGate, type ExecutionTicket } from '@/services/executionGate'
import { getProjectWorkspace } from '@/services/projectWorkspace'
import { workflowAccountScope, workflowHash, workflowTextHash } from './executionLedger'
import { workflowOperations, WorkflowOperationUncertain } from './operations'
import type { WorkflowTaskBundle } from '@/services/workflowTaskRunner'
import { currentWorkflowEnvironmentHash } from './capabilities'

export type WorkflowAutomationInput = {
  status?: 'active' | 'revoked'
  allowed_tasks?: string[]
  allowed_input_sources?: Array<'input' | 'event' | 'steps'>
  allowed_output_keys?: string[]
  egress_hosts?: string[]
  export_results?: boolean
  max_steps?: number
  max_runs_per_hour?: number
  max_input_bytes?: number
  max_output_bytes?: number
}
type WorkflowShape = {
  id: number
  version?: number
  revision?: number
  name?: string
  project_external_id?: string | null
  definition?: { steps?: Array<{ key: string; type: string; payload?: Record<string, unknown> }> }
}
export type WorkflowAutomationConfig = Required<Omit<WorkflowAutomationInput, 'status'>> & {
  device_id: string
  project_external_id: string
  root_path: string
  approved_revision: number
  script_hashes: Record<string, string>
  test_binding?: Record<string, unknown>
}
export type WorkflowAutomationGrant = {
  id: number
  workflow_definition_id: number
  approved_revision: number
  status: string
  scope_hash: string
  config: WorkflowAutomationConfig
  predecessor_grant_id?: number
  repair_revision_id?: number
  test_evidence_id?: number
}
type LocalGrant = {
  grant: WorkflowAutomationGrant
  predecessors?: WorkflowAutomationGrant[]
  principalId: string
  workspaceUpdatedAt: number
  approvedAt: number
}
type LocalRepairPolicy = {
  policy: Record<string, unknown>
  policyHash: string
  principalId: string
  workspaceUpdatedAt: number
}
export const WORKFLOW_AUTOMATION_INVALIDATED = 'luczor:workflow-automation-invalidated'
const automationRevisions = new Map<string, number>()
const automationWrites = new Map<string, Promise<unknown>>()
async function writeAutomation<T>(
  scope: string,
  definitionId: number,
  revision: number | null,
  write: (store: Awaited<ReturnType<typeof storeForGrant>>) => Promise<T>
): Promise<T> {
  const key = `${scope}:${definitionId}`
  const next = (automationWrites.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (revision !== null && workflowAutomationRevision(scope, definitionId) !== revision)
        throw new Error('workflow_automation_authorization_changed')
      const result = await write(await storeForGrant())
      if (revision !== null && workflowAutomationRevision(scope, definitionId) !== revision)
        throw new Error('workflow_automation_authorization_changed')
      return result
    })
  automationWrites.set(key, next)
  try {
    return await next
  } finally {
    if (automationWrites.get(key) === next) automationWrites.delete(key)
  }
}
export function workflowAutomationRevision(scope: string, definitionId: number): number {
  return automationRevisions.get(`${scope}:${definitionId}`) ?? 0
}
function invalidateAutomation(scope: string, definitionId: number) {
  const key = `${scope}:${definitionId}`
  automationRevisions.set(key, workflowAutomationRevision(scope, definitionId) + 1)
  window.dispatchEvent(new CustomEvent(WORKFLOW_AUTOMATION_INVALIDATED, { detail: { scope, definitionId } }))
}
const TASKS = new Set([
  'context',
  'review',
  'evaluator',
  'wait.seconds',
  'memory.remember',
  'memory.recall',
  'task.create',
  'workflow',
  'browser.open',
  'browser.open_url',
  'browser.click',
  'browser.read',
  'file.read',
  'file.write',
  'api.call',
  'python.run',
  'node.run',
  'agent.dispatch',
  'llm',
  'condition',
  'approval',
  'manual',
  'device_job',
  'browser.navigate',
  'browser.fill',
  'browser.select',
  'browser.wait',
  'browser.screenshot',
  'browser.download',
  'llm.text',
  'llm.json',
  'llm.classify',
  'llm.extract',
  'llm.evaluate',
  'image.capture',
  'image.ocr',
  'image.vision',
  'image.compare',
  'agent.single',
  'agent.team',
  'data.map',
  'data.filter',
  'data.split',
  'data.collect',
  'data.merge',
  'control.foreach',
  'control.until',
  'control.parallel',
  'control.join',
  'test.assert',
])
const textList = (value: unknown, limit = 100): string[] => {
  if (
    !Array.isArray(value) ||
    value.length > limit ||
    value.some(item => typeof item !== 'string' || !item.trim() || item.length > 300)
  )
    throw new Error('workflow_automation_list_invalid')
  return [...new Set(value as string[])].sort()
}
const bounded = (value: number | undefined, fallback: number, max: number) => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error('workflow_automation_budget_invalid')
  return result
}
export const canonicalWorkflowPath = (path: string): string => {
  const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '')
  return /^[a-z]:\//iu.test(normalized) || normalized.startsWith('//')
    ? normalized.toLocaleLowerCase('en-US')
    : normalized
}

async function storeForGrant() {
  return Store.load('luczor.workflow-automation.json')
}

/** Only this local UI boundary can create a standing grant; model-supplied approval flags are ignored. */
export async function configureWorkflowAutomation(
  workflow: WorkflowShape,
  input: WorkflowAutomationInput,
  context: { projectId: string; signal?: AbortSignal; execution?: ExecutionTicket }
) {
  const ticket = context.execution ?? executionGate.capture(context.signal)
  const assert = () => executionGate.assert(ticket, true)
  assert()
  const account = await getVerifiedAccountSnapshot()
  assert()
  if (!account) throw new Error('workflow_verified_account_required')
  const scope = await workflowAccountScope(account.config)
  const key = `${scope}:${workflow.id}`
  const startingRevision = workflowAutomationRevision(scope, workflow.id)
  const assertIdentity = async () => {
    assert()
    const current = await getVerifiedAccountSnapshot()
    assert()
    if (
      !current ||
      current.principalId !== account.principalId ||
      (await workflowAccountScope(current.config)) !== scope
    )
      throw new Error('workflow_automation_identity_changed')
    assert()
  }
  const configureGrant = async (
    config: WorkflowAutomationConfig,
    status: 'active' | 'revoked',
    assertCurrent: () => Promise<void>
  ) => {
    const validateGrant = async (grant: WorkflowAutomationGrant): Promise<WorkflowAutomationGrant> => {
      if (!grant?.config || typeof grant.config !== 'object' || Array.isArray(grant.config))
        throw new Error('workflow_automation_server_contract_changed')
      // The operation ledger's raw PHP response can encode an empty map as [].
      const normalized = {
        ...grant,
        config: {
          ...grant.config,
          script_hashes: Object.fromEntries(Object.entries(grant.config.script_hashes ?? {})),
        },
      }
      if (
        !Number.isSafeInteger(normalized.id) ||
        normalized.id < 1 ||
        normalized.workflow_definition_id !== workflow.id ||
        normalized.status !== status ||
        typeof normalized.scope_hash !== 'string' ||
        !normalized.scope_hash ||
        normalized.approved_revision !== config.approved_revision ||
        (await workflowHash(normalized.config)) !== (await workflowHash(config))
      )
        throw new Error('workflow_automation_server_contract_changed')
      return normalized
    }
    const grant = await workflowOperations.run({
      scope: {
        principal: account.principalId,
        account: scope,
        device: account.config.clientId,
        path: `/workflows/${workflow.id}/automation`,
      },
      args: { ...config, status },
      assertCurrent,
      async verify(operationId) {
        const response = await requestWithConfig<{
          data: { status: string; response?: { grant?: WorkflowAutomationGrant } }
        }>(`/workflow-operations/${encodeURIComponent(operationId)}`, { signal: ticket.signal }, account.config)
        if (response.data.status === 'not_found') return null
        if (response.data.status !== 'completed' || !response.data.response?.grant)
          throw new WorkflowOperationUncertain(operationId)
        // Let the shared ledger compare the original argument fingerprint before
        // validating a recovered grant against this attempt's configuration.
        return response.data.response.grant
      },
      async execute(operationId) {
        const response = await requestWithConfig<{ data: { grant: WorkflowAutomationGrant } }>(
          `/workflows/${workflow.id}/automation`,
          {
            method: 'POST',
            body: { ...config, status, operation_id: operationId, local_approved: true },
            signal: ticket.signal,
          },
          account.config
        )
        return validateGrant(response.data.grant)
      },
    })
    return validateGrant(grant)
  }
  if (input.status === 'revoked') {
    invalidateAutomation(scope, workflow.id)
    const stored = await writeAutomation(scope, workflow.id, null, async store => {
      const old = await store.get<LocalGrant>(key)
      await store.delete(key)
      await store.delete(`repair:${scope}:${workflow.id}`)
      await store.save()
      return old
    })
    window.dispatchEvent(new Event('luczor:workflow-automation-changed'))
    assert()
    const prior =
      stored?.grant ??
      (
        await requestWithConfig<{ data: { grant: WorkflowAutomationGrant | null } }>(
          `/workflows/${workflow.id}/automation`,
          { signal: ticket.signal },
          account.config
        )
      ).data.grant
    assert()
    if (!prior) return { ok: true, grant: null }
    const grant = await configureGrant(
      {
        ...prior.config,
        device_id: account.config.clientId,
        script_hashes: Object.fromEntries(Object.entries(prior.config.script_hashes ?? {})),
      },
      'revoked',
      assertIdentity
    )
    assert()
    return { ok: true, grant }
  }
  const workspace = await getProjectWorkspace(context.projectId, account.principalId)
  assert()
  if (!workspace || workspace.status !== 'ready' || !workspace.updatedAt) throw new Error('workflow_workspace_required')
  const collected: Array<{
    definitionId: number
    step: { key: string; type: string; payload?: Record<string, unknown> }
  }> = []
  const collect = async (definition: WorkflowShape, ancestors: number[]) => {
    if (ancestors.includes(definition.id) || ancestors.length > 8) throw new Error('workflow_automation_nested_cycle')
    if (definition.project_external_id !== undefined && definition.project_external_id !== context.projectId)
      throw new Error('workflow_automation_nested_project_mismatch')
    const remaining = [...(definition.definition?.steps ?? [])]
    while (remaining.length) {
      const step = remaining.shift()!
      if (collected.length >= 800) throw new Error('workflow_automation_step_limit')
      collected.push({ definitionId: definition.id, step })
      const body = step.payload?.body as { steps?: typeof remaining } | undefined
      if (['control.foreach', 'control.until'].includes(step.type) && Array.isArray(body?.steps))
        remaining.push(...body.steps)
      if (step.type === 'control.parallel' && Array.isArray(step.payload?.branches))
        for (const branch of step.payload.branches)
          if (branch && typeof branch === 'object' && Array.isArray(branch.steps)) remaining.push(...branch.steps)
      if (step.type === 'workflow') {
        const childId = step.payload?.workflow_definition_id
        if (!Number.isSafeInteger(childId) || Number(childId) < 1)
          throw new Error('workflow_automation_nested_id_invalid')
        const child = await requestWithConfig<{ data: WorkflowShape }>(
          `/workflows/${childId}`,
          { signal: ticket.signal },
          account.config
        )
        assert()
        await collect(child.data, [...ancestors, definition.id])
      }
    }
  }
  await collect(workflow, [])
  const tasks = textList(input.allowed_tasks ?? collected.map(item => item.step.type))
  if (!tasks.length || tasks.some(task => !TASKS.has(task))) throw new Error('workflow_automation_task_invalid')
  const sources = textList(input.allowed_input_sources ?? ['input', 'event', 'steps'])
  if (sources.some(source => !['input', 'event', 'steps'].includes(source)))
    throw new Error('workflow_automation_source_invalid')
  const scriptHashes: Record<string, string> = {}
  for (const { definitionId, step } of collected) {
    if (!['python.run', 'node.run', 'agent.dispatch'].includes(step.type)) continue
    const program = step.payload?.[step.type === 'agent.dispatch' ? 'prompt' : 'code']
    if (typeof program !== 'string' || !program.trim() || program.includes('{{'))
      throw new Error('workflow_automation_dynamic_program_requires_individual_approval')
    const key = definitionId === workflow.id ? step.key : `${definitionId}:${step.key}`
    const hash = await workflowTextHash(program)
    if (Object.hasOwn(scriptHashes, key) && Reflect.get(scriptHashes, key) !== hash)
      throw new Error('workflow_automation_program_identity_ambiguous')
    Reflect.set(scriptHashes, key, hash)
  }
  const config: WorkflowAutomationConfig = {
    device_id: account.config.clientId,
    project_external_id: context.projectId,
    root_path: canonicalWorkflowPath(workspace.rootPath),
    approved_revision: workflow.version ?? workflow.revision ?? 1,
    allowed_tasks: tasks,
    allowed_input_sources: sources as WorkflowAutomationConfig['allowed_input_sources'],
    allowed_output_keys: textList(input.allowed_output_keys ?? ['*']),
    egress_hosts: textList(input.egress_hosts ?? [], 30),
    export_results: input.export_results === true,
    script_hashes: scriptHashes,
    max_steps: bounded(input.max_steps, 200, 800),
    max_runs_per_hour: bounded(input.max_runs_per_hour, 20, 100),
    max_input_bytes: bounded(input.max_input_bytes, 65536, 1048576),
    max_output_bytes: bounded(input.max_output_bytes, 65536, 1048576),
  }
  if (
    config.egress_hosts.some(host => {
      const parts = host.split(':')
      return (
        parts.length > 2 ||
        !/^[a-z0-9.-]+$/iu.test(parts[0] ?? '') ||
        (parts.length === 2 && !/^\d+$/u.test(parts[1] ?? ''))
      )
    })
  )
    throw new Error('workflow_automation_host_invalid')
  const preview = JSON.stringify(
    {
      boundaries: config,
      reviewed_programs: collected
        .filter(item => ['python.run', 'node.run', 'agent.dispatch'].includes(item.step.type))
        .map(item => ({
          definition_id: item.definitionId,
          step: item.step.key,
          type: item.step.type,
          text: item.step.payload?.[item.step.type === 'agent.dispatch' ? 'prompt' : 'code'],
        })),
    },
    null,
    2
  )
  if (preview.length > 24000) throw new Error('workflow_automation_preview_too_large')
  const approved = await requestConfirmation(
    `Automatisierung „${workflow.name ?? workflow.id}“ auf diesem Gerät freigeben?\n\nDiese Grenzen gelten auch für spätere Workflow-Versionen. Neue Aktionen, größere Grenzen und geänderte Skripte oder Agentenprompts benötigen eine neue Freigabe. Not-Aus und Ausführungsmodus bleiben aktiv.\n\n${preview}`,
    'Luczor – Workflow-Automatisierung'
  )
  assert()
  if (!approved.approved || approved.error) return { ok: false, code: 'workflow_automation_not_approved' }
  const assertWorkspace = async () => {
    await assertIdentity()
    const currentWorkspace = await getProjectWorkspace(context.projectId, account.principalId)
    assert()
    if (
      currentWorkspace?.status !== 'ready' ||
      currentWorkspace.rootPath !== workspace.rootPath ||
      currentWorkspace.updatedAt !== workspace.updatedAt
    )
      throw new Error('workflow_automation_identity_changed')
  }
  const grant = await configureGrant(config, 'active', assertWorkspace)
  await assertWorkspace()
  if (workflowAutomationRevision(scope, workflow.id) !== startingRevision)
    throw new Error('workflow_automation_authorization_changed')
  invalidateAutomation(scope, workflow.id)
  await writeAutomation(scope, workflow.id, workflowAutomationRevision(scope, workflow.id), async store => {
    assert()
    await store.set(key, {
      grant,
      principalId: account.principalId,
      workspaceUpdatedAt: workspace.updatedAt!,
      approvedAt: Date.now(),
    } satisfies LocalGrant)
    await store.save()
    assert()
  })
  assert()
  window.dispatchEvent(new Event('luczor:workflow-automation-changed'))
  return { ok: true, grant }
}

/** Re-evaluate a signed, already compiled task against the local confirmation, never trust server preapproval alone. */
export async function workflowAutomationAllows(
  bundle: WorkflowTaskBundle,
  scope: string,
  principalId: string,
  apiConfig?: LuczorApiConfigSnapshot
): Promise<boolean> {
  const metadata = bundle.workflow
  if (!metadata?.definition_id || !metadata.grant || typeof metadata.grant !== 'object') return false
  const grant = metadata.grant as WorkflowAutomationGrant
  const revision = workflowAutomationRevision(scope, metadata.definition_id)
  await automationWrites.get(`${scope}:${metadata.definition_id}`)?.catch(() => {})
  const stored = await (await storeForGrant()).get<LocalGrant>(`${scope}:${metadata.definition_id}`)
  if (!stored || stored.principalId !== principalId || stored.grant.status !== 'active') return false
  const locallyKnown = [stored.grant, ...(stored.predecessors ?? [])].find(
    item => item.id === grant.id && item.status === 'active'
  )
  const sameGrant =
    grant.status === 'active' &&
    !!locallyKnown &&
    locallyKnown.scope_hash === grant.scope_hash &&
    (await workflowHash(locallyKnown.config)) === (await workflowHash(grant.config))
  const successor = !sameGrant && (await repairGrantAllows(bundle, stored, scope, principalId, apiConfig))
  if (!sameGrant && !successor) return false
  const config = grant.config
  if (
    !Array.isArray(metadata.input_sources) ||
    metadata.input_sources.some(source => !config.allowed_input_sources.includes(source as 'input' | 'event' | 'steps'))
  )
    return false
  if (
    !Array.isArray(metadata.output_keys) ||
    (!config.allowed_output_keys.includes('*') &&
      metadata.output_keys.some(key => !config.allowed_output_keys.includes(key)))
  )
    return false
  if (!apiConfig) return false
  const current = await requestWithConfig<{ data: { grant: WorkflowAutomationGrant | null } }>(
    `/workflows/${metadata.definition_id}/automation`,
    {},
    apiConfig
  )
  if (
    current.data.grant?.status !== 'active' ||
    current.data.grant.id !== (sameGrant || grant.status === 'testing' ? stored.grant.id : grant.id) ||
    current.data.grant.scope_hash !==
      (sameGrant || grant.status === 'testing' ? stored.grant.scope_hash : grant.scope_hash)
  )
    return false
  if (
    config.device_id !== metadata.device_id ||
    config.project_external_id !== metadata.project_id ||
    !config.allowed_tasks.includes(bundle.task_key) ||
    !config.export_results
  )
    return false
  if (new TextEncoder().encode(JSON.stringify(bundle.params)).byteLength > config.max_input_bytes) return false
  const workspace = await getProjectWorkspace(config.project_external_id, principalId)
  if (
    !workspace ||
    workspace.status !== 'ready' ||
    workspace.updatedAt !== stored.workspaceUpdatedAt ||
    canonicalWorkflowPath(workspace.rootPath) !== canonicalWorkflowPath(config.root_path)
  )
    return false
  if (
    metadata.file_scope === 'workspace' &&
    metadata.workspace_root_id &&
    canonicalWorkflowPath(metadata.workspace_root_id) !== canonicalWorkflowPath(config.root_path)
  )
    return false
  if (['python.run', 'node.run', 'agent.dispatch'].includes(bundle.task_key)) {
    const program = bundle.params[bundle.task_key === 'agent.dispatch' ? 'prompt' : 'code']
    const hashKey =
      metadata.child_definition_id && metadata.child_definition_id !== metadata.definition_id
        ? `${metadata.child_definition_id}:${metadata.step_key}`
        : metadata.step_key
    if (
      typeof program !== 'string' ||
      Object.getOwnPropertyDescriptor(config.script_hashes, hashKey)?.value !== (await workflowTextHash(program))
    )
      return false
  }
  if ((bundle.task_key === 'llm' || bundle.task_key.startsWith('llm.')) && bundle.params.inference === 'external')
    return false
  // Internal browser navigation is unrestricted; API egress retains its own grant.
  if (bundle.task_key === 'api.call') {
    try {
      if (!config.egress_hosts.includes(new URL(String(bundle.params.expected_url || bundle.params.url)).host))
        return false
    } catch {
      return false
    }
  }
  const store = await storeForGrant()
  // Re-check every admission after network/identity waits, including normal and testing grants.
  const latest = await store.get<LocalGrant>(`${scope}:${metadata.definition_id}`)
  if (
    latest?.grant.id !== stored.grant.id ||
    latest.grant.scope_hash !== stored.grant.scope_hash ||
    workflowAutomationRevision(scope, metadata.definition_id) !== revision
  )
    return false
  if (successor && grant.status === 'active') {
    await writeAutomation(scope, metadata.definition_id, revision, async store => {
      const latest = await store.get<LocalGrant>(`${scope}:${metadata.definition_id}`)
      if (latest?.grant.id !== stored.grant.id || latest.grant.scope_hash !== stored.grant.scope_hash)
        throw new Error('workflow_automation_authorization_changed')
      await store.set(`${scope}:${metadata.definition_id}`, {
        ...stored,
        grant,
        predecessors: [stored.grant, ...(stored.predecessors ?? [])],
      })
      const localPolicy = await store.get<LocalRepairPolicy>(`repair:${scope}:${metadata.definition_id}`)
      if (localPolicy)
        await store.set(`repair:${scope}:${metadata.definition_id}`, {
          ...localPolicy,
          policy: successor.policy,
          policyHash: await workflowHash(successor.policy),
        })
      await store.save()
    })
  }
  return workflowAutomationRevision(scope, metadata.definition_id) === revision
}

/** Called only by the local UI after its confirmed policy operation completes. */
export async function rememberLocalWorkflowRepairPolicy(
  workflowId: number,
  policy: Record<string, unknown>,
  context: { projectId: string; execution?: ExecutionTicket }
): Promise<void> {
  const ticket = context.execution ?? executionGate.capture()
  executionGate.assert(ticket, true)
  const account = await getVerifiedAccountSnapshot()
  if (!account) throw new Error('workflow_verified_account_required')
  const scope = await workflowAccountScope(account.config)
  const revision = workflowAutomationRevision(scope, workflowId)
  const store = await storeForGrant()
  const key = `repair:${scope}:${workflowId}`
  if (policy.enabled === false) {
    invalidateAutomation(scope, workflowId)
    await writeAutomation(scope, workflowId, null, async store => {
      await store.delete(key)
      await store.save()
    })
    return
  }
  const prior = await store.get<LocalGrant>(`${scope}:${workflowId}`)
  const workspace = await getProjectWorkspace(context.projectId, account.principalId)
  if (
    !prior ||
    prior.principalId !== account.principalId ||
    prior.grant.status !== 'active' ||
    prior.grant.id !== policy.grant_id ||
    prior.grant.scope_hash !== policy.scope_hash ||
    policy.device_id !== account.config.clientId ||
    workspace?.status !== 'ready' ||
    workspace.updatedAt !== prior.workspaceUpdatedAt
  )
    throw new Error('workflow_repair_local_predecessor_required')
  executionGate.assert(ticket, true)
  const current = await getVerifiedAccountSnapshot()
  if (!current || current.principalId !== account.principalId || (await workflowAccountScope(current.config)) !== scope)
    throw new Error('workflow_repair_identity_changed')
  if (workflowAutomationRevision(scope, workflowId) !== revision)
    throw new Error('workflow_automation_authorization_changed')
  invalidateAutomation(scope, workflowId)
  await writeAutomation(scope, workflowId, workflowAutomationRevision(scope, workflowId), async store => {
    executionGate.assert(ticket, true)
    const latest = await store.get<LocalGrant>(`${scope}:${workflowId}`)
    if (latest?.grant.id !== prior.grant.id || latest.grant.scope_hash !== prior.grant.scope_hash)
      throw new Error('workflow_repair_local_predecessor_required')
    await store.set(key, {
      policy: structuredClone(policy),
      policyHash: await workflowHash(policy),
      principalId: account.principalId,
      workspaceUpdatedAt: prior.workspaceUpdatedAt,
    } satisfies LocalRepairPolicy)
    await store.save()
    executionGate.assert(ticket, true)
  })
}

async function repairGrantAllows(
  bundle: WorkflowTaskBundle,
  stored: LocalGrant,
  scope: string,
  principalId: string,
  apiConfig?: LuczorApiConfigSnapshot
): Promise<false | { policy: Record<string, unknown> }> {
  const grant = bundle.workflow.grant as WorkflowAutomationGrant
  if (
    !apiConfig ||
    !['testing', 'active'].includes(grant.status) ||
    grant.predecessor_grant_id !== stored.grant.id ||
    !Number.isSafeInteger(grant.repair_revision_id) ||
    !Number.isSafeInteger(grant.test_evidence_id) ||
    grant.workflow_definition_id !== bundle.workflow.definition_id
  )
    return false
  const local = await (await storeForGrant()).get<LocalRepairPolicy>(`repair:${scope}:${bundle.workflow.definition_id}`)
  if (
    !local ||
    local.principalId !== principalId ||
    local.workspaceUpdatedAt !== stored.workspaceUpdatedAt ||
    local.policy.enabled !== true ||
    local.policy.grant_id !== stored.grant.id ||
    local.policy.scope_hash !== stored.grant.scope_hash ||
    (await workflowHash(local.policy)) !== local.policyHash
  )
    return false
  const unchangedConfig = (config: WorkflowAutomationConfig) => {
    const { script_hashes: _scripts, test_binding: _binding, approved_revision: _revision, ...bounds } = config
    return bounds
  }
  if (
    (await workflowHash(unchangedConfig(grant.config))) !== (await workflowHash(unchangedConfig(stored.grant.config)))
  )
    return false
  if (
    local.policy.allow_script_repair !== true &&
    (await workflowHash(grant.config.script_hashes)) !== (await workflowHash(stored.grant.config.script_hashes))
  )
    return false
  const { data: evidence } = await requestWithConfig<{ data: Record<string, unknown> }>(
    `/workflow-tests/${grant.test_evidence_id}`,
    {},
    apiConfig
  )
  const environmentHash = await currentWorkflowEnvironmentHash()
  if (!environmentHash || evidence.device_environment_hash !== environmentHash) return false
  if (
    evidence.mode !== 'real' ||
    evidence.workflow_definition_id !== grant.workflow_definition_id ||
    evidence.repair_revision_id !== grant.repair_revision_id ||
    evidence.device_id !== apiConfig.clientId ||
    evidence.workflow_test_case_id !== local.policy.test_case_id ||
    evidence.assertions_hash !== local.policy.assertions_hash ||
    evidence.fixture_hash !== local.policy.fixture_hash
  )
    return false
  const currentPolicy = evidence.repair_policy as Record<string, unknown> | undefined
  if (!currentPolicy || (await workflowHash(currentPolicy)) !== evidence.repair_policy_hash) return false
  const basePolicy = { ...currentPolicy, grant_id: local.policy.grant_id, scope_hash: local.policy.scope_hash }
  if ((await workflowHash(basePolicy)) !== local.policyHash) return false
  if (grant.status === 'testing') {
    if (
      !['queued', 'running'].includes(String(evidence.status)) ||
      evidence.repair_status !== 'proposed' ||
      bundle.workflow.test_mode !== 'real' ||
      !bundle.workflow.test_run ||
      bundle.workflow.test_run !== evidence.run_public_id ||
      currentPolicy.grant_id !== stored.grant.id ||
      currentPolicy.scope_hash !== stored.grant.scope_hash
    )
      return false
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
    if (
      (await workflowHash(binding)) !== (await workflowHash(bundle.workflow.test_binding)) ||
      (await workflowHash(binding)) !== (await workflowHash(grant.config.test_binding))
    )
      return false
  } else {
    if (
      evidence.status !== 'passed' ||
      evidence.repair_status !== 'activated' ||
      currentPolicy.grant_id !== grant.id ||
      currentPolicy.scope_hash !== grant.scope_hash ||
      grant.config.test_binding !== undefined ||
      grant.approved_revision !== bundle.workflow.revision
    )
      return false
  }
  return { policy: currentPolicy }
}

export async function getLocalWorkflowAutomationGrant(scope: string, definitionId: number): Promise<LocalGrant | null> {
  return (await (await storeForGrant()).get<LocalGrant>(`${scope}:${definitionId}`)) ?? null
}
