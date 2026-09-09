/** A locally authorized, durable repair driver. It never executes a candidate itself or creates new grants. */
import { Store } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { requestWithConfig, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import { executionGate, type ExecutionTicket } from '@/services/executionGate'
import { getProjectWorkspace } from '@/services/projectWorkspace'
import { localResources } from '@/services/inference/resources'
import { localInferenceCoordinator } from '@/services/inference/coordinator'
import {
  canonicalWorkflowPath,
  WORKFLOW_AUTOMATION_INVALIDATED,
  workflowAutomationRevision,
  type WorkflowAutomationGrant,
} from './automation'
import { currentWorkflowEnvironmentHash, refreshWorkflowCapabilities } from './capabilities'
import { workflowAccountScope, workflowHash } from './executionLedger'
import { boundedWorkflowJson, workflowOperations, WorkflowOperationUncertain } from './operations'
import { runWorkflowLlm } from './llm'
import type { Workflow, WorkflowDefinition } from './types'
import type { WorkflowTestCase, WorkflowTestEvidence } from './workflowTests'

type LocalGrant = { principalId: string; workspaceUpdatedAt: number; grant: WorkflowAutomationGrant }
type LocalPolicy = {
  principalId: string
  workspaceUpdatedAt: number
  policyHash: string
  policy: Record<string, unknown>
}
type Source = {
  id: number
  public_id: string
  workflow_definition_id: number
  definition_version: number
  status: string
  sandbox?: boolean
  test_mode?: string | null
  root_workflow_run_id?: number | null
  budgets?: { max_repairs?: number }
  definition_snapshot: { definition: WorkflowDefinition }
  steps?: Array<{ step_key: string; status: string; error?: string | null }>
}
type Repair = {
  id: number
  source_run_id: number
  workflow_definition_id: number
  base_version: number
  status: string
  definition: WorkflowDefinition
  snapshot: unknown
  definition_hash: string
  code_hash: string
  scope: { policy: Record<string, unknown> }
}
type Evidence = WorkflowTestEvidence & { device_environment_hash: string; repair_status?: string }
type Attempt = {
  phase: 'generating' | 'candidate' | 'testing' | 'failed' | 'complete'
  candidate?: WorkflowDefinition
  repairId?: number
  definitionHash?: string
  codeHash?: string
  serverEnvironment?: string
  evidence?: Partial<Record<'definition' | 'simulation' | 'real', number>>
  error?: string
}
type RecordState = {
  source: number
  sourceHash: string
  policyHash: string
  environment: string
  version: number
  attempts: Attempt[]
  status: 'active' | 'complete' | 'exhausted' | 'blocked'
  updatedAt: number
}
type DriverStore = {
  get<T>(key: string): Promise<T | undefined>
  keys(): Promise<string[]>
  set(key: string, value: unknown): Promise<unknown>
  save(): Promise<unknown>
}
type Dependencies = {
  store(name: string): Promise<DriverStore>
  request<T>(
    path: string,
    options: { method?: 'POST'; body?: Record<string, unknown>; signal: AbortSignal },
    config: LuczorApiConfigSnapshot
  ): Promise<{ data: T }>
  identity: typeof getVerifiedAccountSnapshot
  workspace: typeof getProjectWorkspace
  environment(): Promise<string | null>
  capabilities: typeof refreshWorkflowCapabilities
  ready(): Promise<boolean>
  propose(input: Record<string, unknown>, projectId: string, ticket: ExecutionTicket): Promise<unknown>
  now(): number
}
const changesSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['changes'],
  properties: {
    changes: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step_key'],
        properties: {
          step_key: { type: 'string', minLength: 1 },
          code: { type: 'string', minLength: 1, maxLength: 16000 },
          payload: { type: 'object' },
        },
      },
    },
  },
}
export function proposeResidentWorkflowRepair(
  input: Record<string, unknown>,
  projectId: string,
  ticket: ExecutionTicket
): Promise<unknown> {
  return localResources.runPreemptibleBackground(async (_work, signal) => {
    const status = await invoke<{ state: string; activeModelId?: string }>('local_model_status')
    const backgroundTicket = { ...ticket, signal }
    executionGate.assert(backgroundTicket, true)
    if (status.state !== 'ready' || !status.activeModelId) throw new Error('workflow_repair_resident_model_unavailable')
    const gateway = await localInferenceCoordinator.residentOptimizationGateway(projectId, status.activeModelId)
    executionGate.assert(backgroundTicket, true)
    if (gateway.target !== 'local_llama_cpp') throw new Error('workflow_repair_local_model_required')
    return (
      await runWorkflowLlm(
        {
          inference: 'local',
          output_format: 'json',
          output_schema: changesSchema,
          input_bindings: input,
          timeout_seconds: 120,
          max_output_chars: 20000,
          instruction:
            'Erstelle ausschließlich einen begrenzten Reparaturvorschlag für den belegten Workflowfehler. Antworte mit changes: [{step_key, code}] für freigegebene Node/Python-Schritte oder [{step_key, payload}] für vorhandene data.*-/condition-Schritte. Keine Ausführung, neuen Schritte, Rechte, Provider, Budgets, Prüfregeln oder Fixture-Änderungen. Code ist ein vollständiger Ersatzstring. Nutze echte Fehler und vorherige Testbefunde; erfinde keinen Erfolg.',
        },
        { projectId, ticket: backgroundTicket },
        {
          local: async () => gateway,
          external: async () => {
            throw new Error('workflow_repair_external_forbidden')
          },
          assert: current => {
            current.signal.throwIfAborted()
            executionGate.assert(current, true)
          },
        }
      )
    ).data
  }, ticket.signal)
}
const defaults: Dependencies = {
  store: name => Store.load(name),
  request: requestWithConfig,
  identity: getVerifiedAccountSnapshot,
  workspace: getProjectWorkspace,
  environment: currentWorkflowEnvironmentHash,
  capabilities: refreshWorkflowCapabilities,
  ready: async () =>
    !localResources.hasWork() && (await invoke<{ state: string }>('local_model_status')).state === 'ready',
  propose: proposeResidentWorkflowRepair,
  now: Date.now,
}
const HASH = /^[a-f0-9]{64}$/u
const dataTypes = new Set(['data.map', 'data.filter', 'data.split', 'data.collect', 'data.merge', 'condition'])
const sameConfig = (left: LuczorApiConfigSnapshot, right: LuczorApiConfigSnapshot) =>
  left.baseUrl === right.baseUrl && left.clientId === right.clientId && left.deviceKey === right.deviceKey
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0

/** Preserve the entire original graph. The model can only replace explicitly eligible existing payloads/code. */
export function applyWorkflowRepairChanges(
  definition: WorkflowDefinition,
  result: unknown,
  allowScript: boolean
): WorkflowDefinition {
  const answer = result as { changes?: Array<{ step_key: string; code?: string; payload?: Record<string, unknown> }> }
  if (
    !answer ||
    typeof answer !== 'object' ||
    Object.keys(answer).some(key => key !== 'changes') ||
    !Array.isArray(answer.changes) ||
    !answer.changes.length ||
    answer.changes.length > 8
  )
    throw new Error('workflow_repair_changes_invalid')
  const copy = JSON.parse(boundedWorkflowJson(definition)) as WorkflowDefinition
  const seen = new Set<string>()
  for (const change of answer.changes) {
    if (
      !change ||
      Object.keys(change).some(key => !['step_key', 'code', 'payload'].includes(key)) ||
      seen.has(change.step_key)
    )
      throw new Error('workflow_repair_changes_invalid')
    seen.add(change.step_key)
    const step = copy.steps.find(step => step.key === change.step_key)
    if (!step) throw new Error('workflow_repair_step_unknown')
    if (
      ['node.run', 'python.run'].includes(step.type) &&
      allowScript &&
      typeof change.code === 'string' &&
      change.code.trim() &&
      change.code.length <= 16000 &&
      !change.code.includes('{{') &&
      change.payload === undefined
    )
      step.payload.code = change.code
    else if (
      dataTypes.has(step.type) &&
      change.code === undefined &&
      change.payload &&
      typeof change.payload === 'object' &&
      !Array.isArray(change.payload)
    ) {
      for (const field of ['device_id', 'project_id', 'root_path', 'workflow_definition_id', 'max_iterations'])
        if (JSON.stringify(Reflect.get(step.payload, field)) !== JSON.stringify(Reflect.get(change.payload, field)))
          throw new Error('workflow_repair_scope_expansion')
      step.payload = JSON.parse(boundedWorkflowJson(change.payload)) as Record<string, unknown>
    } else throw new Error('workflow_repair_change_not_authorized')
  }
  if (boundedWorkflowJson(copy) === boundedWorkflowJson(definition)) throw new Error('workflow_repair_no_change')
  return copy
}

export function createWorkflowRepairDriver(deps: Dependencies = defaults) {
  const running = new Map<string, Promise<void>>()
  const recent = new Map<string, number>()
  let cursor = 0
  async function tick(config: LuczorApiConfigSnapshot, parentSignal: AbortSignal) {
    const scope = await workflowAccountScope(config)
    const policyStore = await deps.store('luczor.workflow-automation.json')
    const keys = (await policyStore.keys()).filter(key => key.startsWith(`repair:${scope}:`)).sort()
    if (!keys.length) return
    const key = keys[cursor++ % keys.length]!
    const workflowId = Number(key.slice(`repair:${scope}:`.length))
    if (!id(workflowId)) return
    const local = await policyStore.get<LocalPolicy>(key)
    const grant = await policyStore.get<LocalGrant>(`${scope}:${workflowId}`)
    if (
      !local ||
      !grant ||
      local.policy.enabled !== true ||
      local.policy.auto_activate !== true ||
      !id(local.policy.test_case_id) ||
      local.policy.device_id !== config.clientId ||
      !Number.isSafeInteger(local.policy.max_repairs) ||
      Number(local.policy.max_repairs) < 1 ||
      Number(local.policy.max_repairs) > 2
    )
      return
    const initial = await deps.identity()
    if (
      !initial ||
      !sameConfig(initial.config, config) ||
      initial.principalId !== local.principalId ||
      grant.principalId !== initial.principalId ||
      local.workspaceUpdatedAt !== grant.workspaceUpdatedAt ||
      grant.grant.status !== 'active' ||
      local.policy.grant_id !== grant.grant.id ||
      local.policy.scope_hash !== grant.grant.scope_hash ||
      (await workflowHash(local.policy)) !== local.policyHash
    )
      return
    const projectId = grant.grant.config.project_external_id
    const revision = workflowAutomationRevision(scope, workflowId)
    const controller = new AbortController()
    const ticket = executionGate.capture(AbortSignal.any([parentSignal, controller.signal]))
    const invalidate = (event: Event) => {
      const detail = (event as CustomEvent<{ scope: string; definitionId: number }>).detail
      if (detail?.scope === scope && detail.definitionId === workflowId)
        controller.abort(new Error('workflow_repair_revoked'))
    }
    window.addEventListener(WORKFLOW_AUTOMATION_INVALIDATED, invalidate)
    const check = async () => {
      executionGate.assert(ticket, true)
      if (workflowAutomationRevision(scope, workflowId) !== revision) throw new Error('workflow_repair_revoked')
      const [current, workspace, remembered, predecessor] = await Promise.all([
        deps.identity(),
        deps.workspace(projectId, initial.principalId),
        policyStore.get<LocalPolicy>(key),
        policyStore.get<LocalGrant>(`${scope}:${workflowId}`),
      ])
      executionGate.assert(ticket, true)
      if (
        !current ||
        !sameConfig(current.config, config) ||
        current.principalId !== initial.principalId ||
        workspace?.status !== 'ready' ||
        workspace.updatedAt !== local.workspaceUpdatedAt ||
        canonicalWorkflowPath(workspace.rootPath) !== canonicalWorkflowPath(grant.grant.config.root_path) ||
        remembered?.policyHash !== local.policyHash ||
        remembered.principalId !== initial.principalId ||
        remembered.workspaceUpdatedAt !== local.workspaceUpdatedAt ||
        (await workflowHash(remembered.policy)) !== local.policyHash ||
        predecessor?.grant.id !== grant.grant.id ||
        predecessor.principalId !== initial.principalId ||
        predecessor.workspaceUpdatedAt !== grant.workspaceUpdatedAt ||
        predecessor.grant.status !== 'active' ||
        predecessor.grant.scope_hash !== grant.grant.scope_hash ||
        workflowAutomationRevision(scope, workflowId) !== revision
      )
        throw new Error('workflow_repair_authorization_changed')
    }
    const request = async <T>(path: string, body?: Record<string, unknown>): Promise<T> => {
      await check()
      const result = await deps.request<T>(
        path,
        { signal: ticket.signal, ...(body ? { method: 'POST' as const, body } : {}) },
        config
      )
      await check()
      return result.data
    }
    const write = <T>(path: string, args: Record<string, unknown>, knownResult?: T) =>
      workflowOperations.run<T>({
        scope: {
          account: scope,
          workflowId,
          path,
          ...(args.mode ? { mode: args.mode, repairId: args.repair_revision_id } : {}),
        },
        args,
        assertCurrent: check,
        verify: async operationId => {
          const result = await request<{ status: string; response?: T }>(`/workflow-operations/${operationId}`)
          if (result.status === 'not_found') return null
          if (result.status !== 'completed' || result.response === undefined)
            throw new WorkflowOperationUncertain(operationId)
          return result.response
        },
        execute: operationId =>
          knownResult === undefined
            ? request<T>(path, { ...args, operation_id: operationId })
            : Promise.resolve(knownResult),
      })
    try {
      await check()
      const workflow = await request<Workflow & { expanded_snapshot?: Source['definition_snapshot'] }>(
        `/workflows/${workflowId}`
      )
      // Another UI/evidence reader may already have triggered server autoactivation. Reconcile only our recorded hashes; never restart that source.
      const stateStore = await deps.store('luczor.workflow-repairs.json')
      if (workflow.project_external_id === projectId) {
        for (const stateKey of (await stateStore.keys())
          .filter(key => key.startsWith(`${scope}:${workflowId}:`))
          .slice(-200)) {
          const state = await stateStore.get<RecordState>(stateKey)
          const priorAttempt = state?.attempts.at(-1)
          if (
            !state ||
            state.status !== 'active' ||
            state.version >= workflow.version ||
            priorAttempt?.phase !== 'testing' ||
            !priorAttempt.repairId
          )
            continue
          const activated = (await request<Repair[]>(`/workflows/${workflowId}/repairs`)).find(
            item => item.id === priorAttempt.repairId && item.status === 'activated'
          )
          if (
            !activated ||
            activated.workflow_definition_id !== workflowId ||
            activated.source_run_id !== state.source ||
            activated.base_version !== state.version ||
            activated.definition_hash !== priorAttempt.definitionHash ||
            activated.code_hash !== priorAttempt.codeHash ||
            (await workflowHash(activated.scope.policy)) !== state.policyHash
          )
            continue
          const proofs = await request<Evidence[]>(`/workflows/${workflowId}/tests`)
          if (
            !['definition', 'simulation', 'real'].every(mode =>
              proofs.some(
                item =>
                  item.mode === mode &&
                  item.status === 'passed' &&
                  item.workflow_definition_id === workflowId &&
                  item.repair_revision_id === activated.id &&
                  item.definition_hash === priorAttempt.definitionHash &&
                  item.code_hash === priorAttempt.codeHash &&
                  item.environment_hash === priorAttempt.serverEnvironment &&
                  item.device_environment_hash === state.environment &&
                  item.device_id === config.clientId &&
                  item.workflow_test_case_id === activated.scope.policy.test_case_id &&
                  item.assertions_hash === activated.scope.policy.assertions_hash &&
                  item.fixture_hash === activated.scope.policy.fixture_hash
              )
            )
          )
            continue
          await check()
          priorAttempt.phase = 'complete'
          state.status = 'complete'
          state.updatedAt = deps.now()
          await stateStore.set(stateKey, state)
          await stateStore.save()
          await check()
          return
        }
      }
      if (
        workflow.project_external_id !== projectId ||
        workflow.is_locked ||
        workflow.is_edit_locked ||
        workflow.status !== 'active' ||
        (await workflowHash(workflow.repair_policy)) !== local.policyHash
      )
        return
      const serverGrant = await request<{ grant: WorkflowAutomationGrant | null }>(
        `/workflows/${workflowId}/automation`
      )
      if (
        serverGrant.grant?.status !== 'active' ||
        serverGrant.grant.id !== grant.grant.id ||
        serverGrant.grant.scope_hash !== grant.grant.scope_hash
      )
        return
      const environment = await deps.environment()
      await check()
      if (!environment || !HASH.test(environment)) return
      const testCase = (await request<WorkflowTestCase[]>(`/workflows/${workflowId}/test-cases`)).find(
        item => item.id === local.policy.test_case_id
      )
      if (
        !testCase ||
        testCase.workflow_definition_id !== workflowId ||
        testCase.fixture_hash !== local.policy.fixture_hash ||
        testCase.assertions_hash !== local.policy.assertions_hash ||
        testCase.specification.real_test_authorized !== true ||
        testCase.specification.device_id !== config.clientId
      )
        return
      const repairs = await request<Repair[]>(`/workflows/${workflowId}/repairs`)
      const sources = await request<Source[]>(`/workflows/${workflowId}/runs`)
      const source = sources.find(
        run =>
          run.status === 'failed' &&
          !run.sandbox &&
          !run.test_mode &&
          !run.root_workflow_run_id &&
          run.workflow_definition_id === workflowId &&
          run.definition_version === workflow.version
      )
      if (!source) return
      const full = await request<Source>(`/workflow-runs/${source.public_id}`)
      if (
        full.id !== source.id ||
        full.status !== 'failed' ||
        full.workflow_definition_id !== workflowId ||
        full.definition_version !== workflow.version ||
        full.sandbox ||
        full.test_mode ||
        full.root_workflow_run_id ||
        !full.definition_snapshot?.definition ||
        !full.steps?.some(step => step.status === 'failed' && typeof step.error === 'string' && step.error.trim())
      )
        return
      const sourceHash = await workflowHash(full.definition_snapshot)
      if (workflow.expanded_snapshot && (await workflowHash(workflow.expanded_snapshot)) !== sourceHash) return
      const store = stateStore
      const recordKey = `${scope}:${workflowId}:${source.id}`
      let record = await store.get<RecordState>(recordKey)
      if (
        record &&
        (record.status !== 'active' ||
          record.sourceHash !== sourceHash ||
          record.policyHash !== local.policyHash ||
          record.environment !== environment ||
          record.version !== workflow.version)
      )
        return
      record ??= {
        source: source.id,
        sourceHash,
        policyHash: local.policyHash,
        environment,
        version: workflow.version,
        attempts: [],
        status: 'active',
        updatedAt: deps.now(),
      }
      const save = async () => {
        await check()
        record.updatedAt = deps.now()
        boundedWorkflowJson(record)
        await store.set(recordKey, structuredClone(record))
        await store.save()
        await check()
        window.dispatchEvent(
          new CustomEvent('luczor:workflow-repair-progress', {
            detail: {
              workflowId,
              sourceRunId: source.id,
              status: record.status,
              attempt: record.attempts.length,
              phase: record.attempts.at(-1)?.phase,
            },
          })
        )
      }
      const currentServer = async () => {
        await check()
        const latest = await request<Workflow>(`/workflows/${workflowId}`)
        const latestGrant = await request<{ grant: WorkflowAutomationGrant | null }>(
          `/workflows/${workflowId}/automation`
        )
        if (
          latest.version !== record.version ||
          latest.project_external_id !== projectId ||
          latest.is_locked ||
          latest.is_edit_locked ||
          latest.status !== 'active' ||
          (await workflowHash(latest.repair_policy)) !== local.policyHash ||
          latestGrant.grant?.status !== 'active' ||
          latestGrant.grant.id !== grant.grant.id ||
          latestGrant.grant.scope_hash !== grant.grant.scope_hash ||
          (await deps.environment()) !== record.environment
        )
          throw new Error('workflow_repair_snapshot_changed')
        await check()
      }
      let attempt = record.attempts.at(-1)
      if (!attempt || attempt.phase === 'failed') {
        const existing = repairs.filter(item => item.source_run_id === source.id)
        const limit = Math.min(2, Number(local.policy.max_repairs ?? 2), full.budgets?.max_repairs ?? 2)
        if (Math.max(record.attempts.length, existing.length) >= limit) {
          record.status = 'exhausted'
          await save()
          return
        }
        if (!(await deps.ready())) return
        await check()
        attempt = { phase: 'generating' }
        record.attempts.push(attempt)
        await save()
        try {
          const result = await deps.propose(
            {
              steps: workflow.definition.steps.filter(
                step =>
                  dataTypes.has(step.type) ||
                  (local.policy.allow_script_repair === true && ['node.run', 'python.run'].includes(step.type))
              ),
              failure: full.steps
                ?.filter(step => step.status === 'failed')
                .map(step => ({ step_key: step.step_key, error: step.error?.slice(0, 3000) })),
              previous_failure: record.attempts.at(-2)?.error ?? null,
            },
            projectId,
            ticket
          )
          await currentServer()
          attempt.candidate = applyWorkflowRepairChanges(
            workflow.definition,
            result,
            local.policy.allow_script_repair === true
          )
          attempt.phase = 'candidate'
        } catch (error) {
          if (ticket.signal.aborted) throw error
          attempt.phase = 'failed'
          attempt.error = error instanceof Error ? error.message.slice(0, 300) : 'proposal_failed'
        }
        await save()
        return
      }
      if (attempt.phase === 'generating') {
        attempt.phase = 'failed'
        attempt.error = 'proposal_interrupted_before_durable_result'
        await save()
        return
      }
      try {
        if (attempt.phase === 'candidate') {
          if (!attempt.candidate) throw new Error('workflow_repair_candidate_missing')
          await currentServer()
          const knownRepair = repairs.find(
            item =>
              item.source_run_id === source.id &&
              boundedWorkflowJson(item.definition) === boundedWorkflowJson(attempt.candidate)
          )
          const repair = await write<Repair>(
            `/workflows/${workflowId}/repairs`,
            {
              source_run_id: source.id,
              expected_version: workflow.version,
              definition: attempt.candidate,
            },
            knownRepair
          )
          if (
            !id(repair.id) ||
            repair.workflow_definition_id !== workflowId ||
            repair.source_run_id !== source.id ||
            repair.base_version !== workflow.version ||
            repair.status !== 'proposed' ||
            boundedWorkflowJson(repair.definition) !== boundedWorkflowJson(attempt.candidate) ||
            (await workflowHash(repair.scope.policy)) !== local.policyHash ||
            !HASH.test(repair.definition_hash) ||
            !HASH.test(repair.code_hash)
          )
            throw new Error('workflow_repair_candidate_mismatch')
          attempt.repairId = repair.id
          attempt.definitionHash = repair.definition_hash
          attempt.codeHash = repair.code_hash
          attempt.phase = 'testing'
          attempt.evidence = {}
          await save()
          return
        }
        if (attempt.phase !== 'testing' || !attempt.repairId) return
        const repair = repairs.find(item => item.id === attempt.repairId)
        if (
          !repair ||
          repair.workflow_definition_id !== workflowId ||
          repair.base_version !== record.version ||
          repair.definition_hash !== attempt.definitionHash ||
          repair.code_hash !== attempt.codeHash ||
          boundedWorkflowJson(repair.definition) !== boundedWorkflowJson(attempt.candidate) ||
          (await workflowHash(repair.scope.policy)) !== local.policyHash
        )
          throw new Error('workflow_repair_candidate_changed')
        const evidence = await request<Evidence[]>(`/workflows/${workflowId}/tests`)
        for (const mode of ['definition', 'simulation', 'real'] as const) {
          await currentServer()
          const found = evidence
            .filter(item => item.repair_revision_id === repair.id && item.mode === mode)
            .sort((left, right) => right.id - left.id)[0]
          const testArgs = {
            mode,
            test_case_id: testCase.id,
            device_id: config.clientId,
            expected_version: record.version,
            repair_revision_id: repair.id,
          }
          if (!found) {
            if (mode === 'definition') {
              await deps.capabilities(config, ticket.signal)
              await currentServer()
            }
            const started = await write<Evidence>(`/workflows/${workflowId}/tests`, testArgs)
            if (
              !id(started.id) ||
              started.repair_revision_id !== repair.id ||
              started.mode !== mode ||
              started.workflow_definition_id !== workflowId
            )
              throw new Error('workflow_repair_test_mismatch')
            if (
              started.definition_hash !== repair.definition_hash ||
              started.code_hash !== repair.code_hash ||
              started.assertions_hash !== testCase.assertions_hash ||
              started.fixture_hash !== testCase.fixture_hash ||
              started.device_environment_hash !== record.environment ||
              started.device_id !== config.clientId ||
              started.workflow_test_case_id !== testCase.id ||
              !HASH.test(started.environment_hash)
            )
              throw new Error('workflow_repair_test_evidence_changed')
            attempt.serverEnvironment ??= started.environment_hash
            if (attempt.serverEnvironment !== started.environment_hash)
              throw new Error('workflow_repair_server_environment_changed')
            attempt.evidence ??= {}
            Reflect.set(attempt.evidence, mode, started.id)
            if (mode === 'real' && started.status === 'passed') {
              record.status = started.repair_status === 'activated' ? 'complete' : 'blocked'
              attempt.phase = record.status === 'complete' ? 'complete' : 'testing'
              if (record.status === 'blocked') attempt.error = 'activation_not_confirmed'
            }
            await save()
            return
          }
          // Clear a durable uncertain write using its original arguments before the next mode can start.
          await write<Evidence>(`/workflows/${workflowId}/tests`, testArgs, found)
          const refreshed = await request<Evidence>(`/workflow-tests/${found.id}`)
          if (mode === 'definition' && !attempt.serverEnvironment && HASH.test(refreshed.environment_hash))
            attempt.serverEnvironment = refreshed.environment_hash
          if (
            refreshed.id !== found.id ||
            refreshed.repair_revision_id !== repair.id ||
            refreshed.workflow_definition_id !== workflowId ||
            refreshed.mode !== mode ||
            refreshed.workflow_test_case_id !== testCase.id ||
            refreshed.device_id !== config.clientId ||
            refreshed.definition_hash !== repair.definition_hash ||
            refreshed.code_hash !== repair.code_hash ||
            refreshed.assertions_hash !== testCase.assertions_hash ||
            refreshed.fixture_hash !== testCase.fixture_hash ||
            refreshed.device_environment_hash !== record.environment ||
            refreshed.environment_hash !== attempt.serverEnvironment
          )
            throw new Error('workflow_repair_test_evidence_changed')
          if (refreshed.status === 'running') return
          if (refreshed.status !== 'passed') {
            attempt.phase = 'failed'
            attempt.error = String(refreshed.result?.error ?? `test_${mode}_failed`).slice(0, 300)
            await save()
            return
          }
          if (mode === 'real') {
            // Refresh performs the existing server-side autoactivation; this driver never bypasses it with a manual activation call.
            if (refreshed.repair_status !== 'activated') {
              record.status = 'blocked'
              attempt.error = String(refreshed.result?.activation_error ?? 'activation_not_confirmed').slice(0, 300)
            } else {
              attempt.phase = 'complete'
              record.status = 'complete'
            }
            await save()
            return
          }
        }
      } catch (error) {
        if (ticket.signal.aborted || error instanceof WorkflowOperationUncertain) throw error
        await check()
        attempt.phase = 'failed'
        attempt.error = error instanceof Error ? error.message.slice(0, 300) : 'workflow_repair_failed'
        await save()
      }
    } finally {
      window.removeEventListener(WORKFLOW_AUTOMATION_INVALIDATED, invalidate)
    }
  }
  return {
    poll(config: LuczorApiConfigSnapshot, signal: AbortSignal): Promise<void> {
      if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window) || signal.aborted)
        return Promise.resolve()
      const key = `${config.baseUrl}:${config.clientId}`
      if (running.has(key)) return running.get(key)!
      if (deps.now() - (recent.get(key) ?? -Infinity) < 30000) return Promise.resolve()
      recent.set(key, deps.now())
      const work = tick(Object.freeze({ ...config }), signal).finally(() => {
        if (running.get(key) === work) running.delete(key)
      })
      running.set(key, work)
      return work
    },
  }
}
const repairDriver = createWorkflowRepairDriver()
export const pollWorkflowRepairs = (config: LuczorApiConfigSnapshot, signal: AbortSignal) =>
  repairDriver.poll(config, signal)

export type LocalWorkflowRepairStatus = {
  sourceRunId: number
  attempts: number
  phase: Attempt['phase'] | null
  status: RecordState['status']
  label: string
  reason: string | null
  updatedAt: number
}

/** Read-only UI projection: never expose candidate code, prompts, raw model errors or execution payloads. */
export async function readLocalWorkflowRepairStatus(
  workflowId: number,
  projectId: string
): Promise<LocalWorkflowRepairStatus | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null
  const account = await getVerifiedAccountSnapshot()
  if (!account) return null
  const scope = await workflowAccountScope(account.config)
  const grants = await Store.load('luczor.workflow-automation.json')
  const grant = await grants.get<LocalGrant>(`${scope}:${workflowId}`)
  if (grant?.principalId !== account.principalId || grant.grant.config.project_external_id !== projectId) return null
  const store = await Store.load('luczor.workflow-repairs.json')
  const records = await Promise.all(
    (await store.keys())
      .filter(key => key.startsWith(`${scope}:${workflowId}:`))
      .slice(-200)
      .map(key => store.get<RecordState>(key))
  )
  const record = records
    .filter((item): item is RecordState => !!item && Array.isArray(item.attempts) && Number.isFinite(item.updatedAt))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]
  const current = await getVerifiedAccountSnapshot()
  if (!record || !current || current.principalId !== account.principalId || !sameConfig(current.config, account.config))
    return null
  const attempt = record.attempts.at(-1)
  const failure = attempt?.error ?? ''
  const reason = !failure
    ? null
    : /resource_background|proposal_interrupted/u.test(failure)
      ? 'Ein Vordergrundauftrag oder eine Unterbrechung hatte Vorrang.'
      : /resident|idle_model|model|readiness|timeout/u.test(failure)
        ? 'Das bereits geladene lokale Modell konnte keinen gültigen Reparaturvorschlag liefern.'
        : /evidence|hash|environment|snapshot|fixture/u.test(failure)
          ? 'Prüfnachweis, unveränderlicher Ausgangsstand oder Geräteumgebung stimmen nicht mehr überein.'
          : /activation/u.test(failure)
            ? 'Die serverseitige Aktivierung wurde nicht bestätigt.'
            : /test_/u.test(failure)
              ? 'Eine vorgeschriebene Prüfung wurde nicht bestanden.'
              : /authorized|scope|rights|revoked/u.test(failure)
                ? 'Der Vorschlag liegt außerhalb der bestehenden Reparaturfreigabe.'
                : 'Der Reparaturvorschlag konnte nicht vollständig erstellt oder validiert werden.'
  const label =
    record.status === 'complete'
      ? 'Reparatur geprüft und aktiviert'
      : ['exhausted', 'blocked'].includes(record.status)
        ? 'Reparaturautomatik angehalten'
        : attempt?.phase === 'failed'
          ? 'Reparaturversuch fehlgeschlagen'
          : attempt?.phase === 'generating'
            ? 'Lokaler Reparaturvorschlag wird vorbereitet'
            : attempt?.phase === 'candidate'
              ? 'Reparaturvorschlag gesichert'
              : 'Reparatur wird geprüft'
  return {
    sourceRunId: record.source,
    attempts: Math.min(2, record.attempts.length),
    phase: attempt?.phase ?? null,
    status: record.status,
    label,
    reason,
    updatedAt: record.updatedAt,
  }
}
