import { Store } from '@tauri-apps/plugin-store'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { requestWithConfig } from '@/services/api/luczorApi'
import { requestConfirmation } from '@/services/confirmation'
import { executionGate, type ExecutionTicket } from '@/services/executionGate'
import { getProjectWorkspace } from '@/services/projectWorkspace'
import { workflowAccountScope, workflowHash, workflowTextHash } from './executionLedger'
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
type WorkflowShape = { id: number; version?: number; revision?: number; name?: string; definition?: { steps?: Array<{ key: string; type: string; payload?: Record<string, unknown> }> } }
export type WorkflowAutomationConfig = Required<Omit<WorkflowAutomationInput, 'status'>> & {
  device_id: string
  project_external_id: string
  root_path: string
  approved_revision: number
  script_hashes: Record<string, string>
}
export type WorkflowAutomationGrant = { id: number; workflow_definition_id: number; approved_revision: number; status: string; scope_hash: string; config: WorkflowAutomationConfig }
type LocalGrant = { grant: WorkflowAutomationGrant; principalId: string; workspaceUpdatedAt: number; approvedAt: number }
const TASKS = new Set(['context', 'review', 'evaluator', 'wait.seconds', 'memory.remember', 'memory.recall', 'task.create', 'workflow', 'browser.open', 'browser.open_url', 'browser.click', 'browser.read', 'file.read', 'file.write', 'api.call', 'python.run', 'node.run', 'agent.dispatch', 'llm'])
const textList = (value: unknown, limit = 100): string[] => {
  if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 300)) throw new Error('workflow_automation_list_invalid')
  return [...new Set(value as string[])].sort()
}
const bounded = (value: number | undefined, fallback: number, max: number) => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error('workflow_automation_budget_invalid')
  return result
}
export const canonicalWorkflowPath = (path: string): string => path.replace(/\\/gu, '/').replace(/\/+$/u, '').toLocaleLowerCase('en-US')

async function storeForGrant() { return Store.load('luczor.workflow-automation.json') }

/** Only this local UI boundary can create a standing grant; model-supplied approval flags are ignored. */
export async function configureWorkflowAutomation(workflow: WorkflowShape, input: WorkflowAutomationInput, context: { projectId: string; signal?: AbortSignal; execution?: ExecutionTicket }) {
  const ticket = context.execution ?? executionGate.capture(context.signal)
  const assert = () => executionGate.assert(ticket, true)
  assert()
  const account = await getVerifiedAccountSnapshot()
  assert()
  if (!account) throw new Error('workflow_verified_account_required')
  const scope = await workflowAccountScope(account.config)
  const key = `${scope}:${workflow.id}`
  const store = await storeForGrant()
  if (input.status === 'revoked') {
    await store.delete(key)
    await store.save()
    assert()
    const response = await requestWithConfig<{ data: { grant: WorkflowAutomationGrant } }>(`/workflows/${workflow.id}/automation`, { method: 'POST', body: { status: 'revoked', device_id: account.config.clientId, operation_id: crypto.randomUUID(), local_approved: true }, signal: ticket.signal }, account.config)
    assert()
    window.dispatchEvent(new Event('luczor:workflow-automation-changed'))
    return { ok: true, grant: response.data.grant }
  }
  const workspace = await getProjectWorkspace(context.projectId, account.principalId)
  assert()
  if (!workspace || workspace.status !== 'ready' || !workspace.updatedAt) throw new Error('workflow_workspace_required')
  const tasks = textList(input.allowed_tasks ?? workflow.definition?.steps?.map(step => step.type) ?? [])
  if (!tasks.length || tasks.some(task => !TASKS.has(task))) throw new Error('workflow_automation_task_invalid')
  const sources = textList(input.allowed_input_sources ?? ['input', 'event', 'steps'])
  if (sources.some(source => !['input', 'event', 'steps'].includes(source))) throw new Error('workflow_automation_source_invalid')
  const scriptHashes: Record<string, string> = {}
  for (const step of workflow.definition?.steps ?? []) {
    if (!['python.run', 'node.run', 'agent.dispatch'].includes(step.type)) continue
    const program = step.payload?.[step.type === 'agent.dispatch' ? 'prompt' : 'code']
    if (typeof program !== 'string' || !program.trim() || program.includes('{{')) throw new Error('workflow_automation_dynamic_program_requires_individual_approval')
    scriptHashes[step.key] = await workflowTextHash(program)
  }
  const config: WorkflowAutomationConfig = {
    device_id: account.config.clientId, project_external_id: context.projectId, root_path: workspace.rootPath,
    approved_revision: workflow.version ?? workflow.revision ?? 1, allowed_tasks: tasks,
    allowed_input_sources: sources as WorkflowAutomationConfig['allowed_input_sources'],
    allowed_output_keys: textList(input.allowed_output_keys ?? ['*']), egress_hosts: textList(input.egress_hosts ?? [], 30),
    export_results: input.export_results === true, script_hashes: scriptHashes,
    max_steps: bounded(input.max_steps, 100, 100), max_runs_per_hour: bounded(input.max_runs_per_hour, 20, 100),
    max_input_bytes: bounded(input.max_input_bytes, 65536, 1048576), max_output_bytes: bounded(input.max_output_bytes, 65536, 1048576),
  }
  if (config.egress_hosts.some(host => !/^[a-z0-9.-]+(?::\d+)?$/iu.test(host))) throw new Error('workflow_automation_host_invalid')
  const preview = JSON.stringify(config, null, 2)
  const approved = await requestConfirmation(`Automatisierung „${workflow.name ?? workflow.id}“ auf diesem Gerät freigeben?\n\nDiese Grenzen gelten auch für spätere Workflow-Versionen. Neue Aktionen, größere Grenzen und geänderte Skripte oder Agentenprompts benötigen eine neue Freigabe. Not-Aus und Ausführungsmodus bleiben aktiv.\n\n${preview}`, 'Luczor – Workflow-Automatisierung')
  assert()
  if (!approved.approved || approved.error) return { ok: false, code: 'workflow_automation_not_approved' }
  const current = await getVerifiedAccountSnapshot()
  const currentWorkspace = await getProjectWorkspace(context.projectId, account.principalId)
  assert()
  if (!current || current.principalId !== account.principalId || (await workflowAccountScope(current.config)) !== scope || currentWorkspace?.rootPath !== workspace.rootPath || currentWorkspace?.updatedAt !== workspace.updatedAt) throw new Error('workflow_automation_identity_changed')
  const response = await requestWithConfig<{ data: { grant: WorkflowAutomationGrant } }>(`/workflows/${workflow.id}/automation`, { method: 'POST', body: { ...config, status: 'active', operation_id: crypto.randomUUID(), local_approved: true }, signal: ticket.signal }, account.config)
  assert()
  const grant = response.data.grant
  if (!grant || grant.status !== 'active' || !grant.scope_hash || (await workflowHash(grant.config)) !== (await workflowHash(config))) throw new Error('workflow_automation_server_contract_changed')
  await store.set(key, { grant, principalId: account.principalId, workspaceUpdatedAt: workspace.updatedAt, approvedAt: Date.now() } satisfies LocalGrant)
  await store.save()
  assert()
  window.dispatchEvent(new Event('luczor:workflow-automation-changed'))
  return { ok: true, grant }
}

/** Re-evaluate a signed, already compiled task against the local confirmation, never trust server preapproval alone. */
export async function workflowAutomationAllows(bundle: WorkflowTaskBundle, scope: string, principalId: string): Promise<boolean> {
  const metadata = bundle.workflow
  if (!metadata?.definition_id || !metadata.grant || typeof metadata.grant !== 'object') return false
  const grant = metadata.grant as WorkflowAutomationGrant
  const stored = await (await storeForGrant()).get<LocalGrant>(`${scope}:${metadata.definition_id}`)
  if (!stored || stored.principalId !== principalId || stored.grant.status !== 'active' || grant.status !== 'active' || stored.grant.id !== grant.id || stored.grant.scope_hash !== grant.scope_hash || (await workflowHash(stored.grant.config)) !== (await workflowHash(grant.config))) return false
  const config = stored.grant.config
  if (config.device_id !== metadata.device_id || config.project_external_id !== metadata.project_id || !config.allowed_tasks.includes(bundle.task_key) || !config.export_results) return false
  if (new TextEncoder().encode(JSON.stringify(bundle.params)).byteLength > config.max_input_bytes) return false
  const workspace = await getProjectWorkspace(config.project_external_id, principalId)
  if (!workspace || workspace.status !== 'ready' || workspace.updatedAt !== stored.workspaceUpdatedAt || canonicalWorkflowPath(workspace.rootPath) !== canonicalWorkflowPath(config.root_path)) return false
  if (metadata.file_scope === 'workspace' && metadata.workspace_root_id && canonicalWorkflowPath(metadata.workspace_root_id) !== canonicalWorkflowPath(config.root_path)) return false
  if (['python.run', 'node.run', 'agent.dispatch'].includes(bundle.task_key)) {
    const program = bundle.params[bundle.task_key === 'agent.dispatch' ? 'prompt' : 'code']
    if (typeof program !== 'string' || config.script_hashes[metadata.step_key] !== await workflowTextHash(program)) return false
  }
  if (bundle.task_key === 'llm' && bundle.params.inference === 'external') return false
  if (['api.call', 'browser.open_url', 'browser.open', 'browser.click', 'browser.read'].includes(bundle.task_key)) {
    try { if (!config.egress_hosts.includes(new URL(String(bundle.params.url)).host)) return false } catch { return false }
  }
  return true
}

export async function getLocalWorkflowAutomationGrant(scope: string, definitionId: number): Promise<LocalGrant | null> {
  return (await (await storeForGrant()).get<LocalGrant>(`${scope}:${definitionId}`)) ?? null
}
