import { Store } from '@tauri-apps/plugin-store'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { requestWithConfig, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import { requestConfirmation } from '@/services/confirmation'
import { executionGate, type ExecutionTicket } from '@/services/executionGate'
import { getProjectWorkspace } from '@/services/projectWorkspace'
import { workflowAccountScope, workflowHash, workflowTextHash } from './executionLedger'
import { workflowOperations, WorkflowOperationUncertain } from './operations'
import type { WorkflowTaskBundle } from '@/services/workflowTaskRunner'

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
}
export type WorkflowAutomationGrant = {
  id: number
  workflow_definition_id: number
  approved_revision: number
  status: string
  scope_hash: string
  config: WorkflowAutomationConfig
}
type LocalGrant = {
  grant: WorkflowAutomationGrant
  principalId: string
  workspaceUpdatedAt: number
  approvedAt: number
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
  const store = await storeForGrant()
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
    const stored = await store.get<LocalGrant>(key)
    await store.delete(key)
    await store.save()
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
    for (const step of definition.definition?.steps ?? []) {
      if (collected.length >= 100) throw new Error('workflow_automation_step_limit')
      collected.push({ definitionId: definition.id, step })
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
    scriptHashes[definitionId === workflow.id ? step.key : `${definitionId}:${step.key}`] =
      await workflowTextHash(program)
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
    max_steps: bounded(input.max_steps, 100, 100),
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
  await store.set(key, {
    grant,
    principalId: account.principalId,
    workspaceUpdatedAt: workspace.updatedAt,
    approvedAt: Date.now(),
  } satisfies LocalGrant)
  await store.save()
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
  const stored = await (await storeForGrant()).get<LocalGrant>(`${scope}:${metadata.definition_id}`)
  if (
    !stored ||
    stored.principalId !== principalId ||
    stored.grant.status !== 'active' ||
    grant.status !== 'active' ||
    stored.grant.id !== grant.id ||
    stored.grant.scope_hash !== grant.scope_hash ||
    (await workflowHash(stored.grant.config)) !== (await workflowHash(grant.config))
  )
    return false
  const config = stored.grant.config
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
    current.data.grant.id !== grant.id ||
    current.data.grant.scope_hash !== grant.scope_hash
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
  if (bundle.task_key === 'llm' && bundle.params.inference === 'external') return false
  if (['api.call', 'browser.open_url', 'browser.open', 'browser.click', 'browser.read'].includes(bundle.task_key)) {
    try {
      if (!config.egress_hosts.includes(new URL(String(bundle.params.url)).host)) return false
    } catch {
      return false
    }
  }
  return true
}

export async function getLocalWorkflowAutomationGrant(scope: string, definitionId: number): Promise<LocalGrant | null> {
  return (await (await storeForGrant()).get<LocalGrant>(`${scope}:${definitionId}`)) ?? null
}
