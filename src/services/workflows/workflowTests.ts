import { requestWithConfig } from '@/services/api/luczorApi'
import { requestConfirmation } from '@/services/confirmation'
import { captureWorkflowAccess } from './access'
import { rememberLocalWorkflowRepairPolicy } from './automation'
import { boundedWorkflowJson, workflowOperations, WorkflowOperationUncertain } from './operations'
import type { Workflow, WorkflowDefinition } from './types'

export type WorkflowTestMode = 'definition' | 'simulation' | 'real'
export type WorkflowTestCase = {
  id: number
  workflow_definition_id: number
  name: string
  specification: Record<string, unknown>
  assertions_hash: string
  fixture_hash: string
}
export type WorkflowTestEvidence = {
  id: number
  workflow_definition_id: number
  workflow_test_case_id: number
  repair_revision_id?: number | null
  workflow_run_id?: number | null
  run_public_id?: string | null
  mode: WorkflowTestMode
  status: string
  definition_version?: number | null
  device_id?: string | null
  definition_hash: string
  code_hash: string
  assertions_hash: string
  fixture_hash: string
  environment_hash: string
  result?: Record<string, unknown> | null
  finished_at?: string | null
}
export type WorkflowRepair = {
  id: number
  workflow_definition_id: number
  status: string
  candidate_definition?: WorkflowDefinition
  created_at?: string
}
export type WorkflowTestState = {
  workflow: Workflow
  cases: WorkflowTestCase[]
  tests: WorkflowTestEvidence[]
  repairs: WorkflowRepair[]
  deviceId: string
}
export const workflowTestModeLabel = (mode: WorkflowTestMode) =>
  ({ definition: 'Definitionsprüfung', simulation: 'Simulation', real: 'Echter Gerätetest' })[mode]
export function workflowTestResultLabel(test: Pick<WorkflowTestEvidence, 'mode' | 'status'>): string {
  if (test.status === 'passed')
    return test.mode === 'definition'
      ? 'Definition gültig'
      : test.mode === 'simulation'
        ? 'Simulation bestanden'
        : 'Echter Test bestanden'
  return ({ running: 'Prüfung läuft', failed: 'Prüfung fehlgeschlagen', cancelled: 'Abgebrochen' } as Record<string, string>)[test.status] ?? test.status
}

/** UI actions share account/project/revocation and uncertain-write recovery with chat tools. */
export function createWorkflowTests(projectId: string, signal: AbortSignal) {
  const connect = async (workflowId: number, mutating: boolean) => {
    const access = await captureWorkflowAccess({ projectId, signal }, undefined, mutating)
    const workflow = await access.workflow(workflowId)
    const request = async <T>(path: string) => {
      await access.check()
      const response = await requestWithConfig<{ data: T }>(path, { signal: access.execution.signal }, access.config)
      await access.check()
      return response.data
    }
    const owned = <T extends { workflow_definition_id: number }>(item: T): T => {
      if (item.workflow_definition_id !== workflowId) throw new Error('Die Testdaten gehören zu einem anderen Workflow.')
      return item
    }
    const caseById = async (id: number) => {
      const cases = await request<WorkflowTestCase[]>(`/workflows/${workflowId}/test-cases`)
      const found = cases.find(item => item.id === id)
      if (!found) throw new Error('Der gespeicherte Testfall ist nicht mehr verfügbar.')
      return owned(found)
    }
    const confirm = async (message: string) => {
      if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window))
        throw new Error('Diese Gerätefreigabe ist nur in der Desktop-App verfügbar.')
      const result = await requestConfirmation(message, 'Luczor – Workflow-Testfreigabe')
      await access.check()
      if (!result.approved || result.error) throw new Error(result.error || 'Die Gerätefreigabe wurde nicht erteilt.')
    }
    const write = <T>(path: string, args: Record<string, unknown>, expectedVersion?: number) => {
      boundedWorkflowJson(args)
      return workflowOperations.run<T>({
        scope: { principal: access.principalId, server: access.config.baseUrl, device: access.config.clientId, workflowId, path },
        args,
        assertCurrent: access.check,
        async verify(operationId) {
          const result = await request<{ status: string; response?: T }>(`/workflow-operations/${encodeURIComponent(operationId)}`)
          if (result.status === 'not_found') return null
          if (result.status !== 'completed' || result.response === undefined) throw new WorkflowOperationUncertain(operationId)
          return result.response
        },
        async execute(operationId) {
          if (expectedVersion !== undefined && (await access.workflow(workflowId)).version !== expectedVersion)
            throw Object.assign(new Error('Die Workflow-Version wurde geändert. Bitte den aktuellen Stand laden.'), { status: 409 })
          await access.check()
          const result = await requestWithConfig<{ data: T }>(path, {
            method: 'POST', body: { ...args, operation_id: operationId }, signal: access.execution.signal,
          }, access.config)
          await access.check()
          return result.data
        },
      })
    }
    return { access, workflow, request, owned, caseById, confirm, write }
  }
  return {
    async load(workflowId: number): Promise<WorkflowTestState> {
      const ctx = await connect(workflowId, false)
      const [cases, tests, repairs] = await Promise.all([
        ctx.request<WorkflowTestCase[]>(`/workflows/${workflowId}/test-cases`),
        ctx.request<WorkflowTestEvidence[]>(`/workflows/${workflowId}/tests`),
        ctx.request<WorkflowRepair[]>(`/workflows/${workflowId}/repairs`),
      ])
      cases.forEach(ctx.owned); tests.forEach(ctx.owned); repairs.forEach(ctx.owned)
      return { workflow: ctx.workflow, cases, tests, repairs, deviceId: ctx.access.config.clientId }
    },
    async refresh(workflowId: number, evidenceId: number) {
      const ctx = await connect(workflowId, false)
      return ctx.owned(await ctx.request<WorkflowTestEvidence>(`/workflow-tests/${evidenceId}`))
    },
    async createCase(workflowId: number, name: string, specification: Record<string, unknown>, authorizeReal: boolean) {
      const ctx = await connect(workflowId, true)
      // Persist only a detached copy. Pasted/model-produced flags cannot authorize local work.
      const spec = JSON.parse(boundedWorkflowJson(specification)) as Record<string, unknown>
      delete spec.real_test_authorized
      delete spec.device_id
      if (authorizeReal) {
        const preview = JSON.stringify({ workflow: ctx.workflow.name, version: ctx.workflow.version, device: ctx.access.config.clientId, specification: spec }, null, 2)
        if (preview.length > 24000) throw new Error('Der Testfall ist für eine vollständige Gerätefreigabe zu groß.')
        await ctx.confirm(`Diesen unveränderlichen Testfall für echte Tests auf diesem Gerät freigeben? Einzelne Dateizugriffe, Skripte und andere Effekte behalten ihre bestehenden Freigaben.\n\n${preview}`)
        spec.real_test_authorized = true
        spec.device_id = ctx.access.config.clientId
      }
      return ctx.owned(await ctx.write<WorkflowTestCase>(`/workflows/${workflowId}/test-cases`, { name, specification: spec }))
    },
    async start(workflowId: number, expectedVersion: number, caseId: number, mode: WorkflowTestMode, repairId?: number) {
      const ctx = await connect(workflowId, true)
      const testCase = await ctx.caseById(caseId)
      const deviceBound = testCase.specification.real_test_authorized === true && testCase.specification.device_id === ctx.access.config.clientId
      if (mode === 'real') {
        if (!deviceBound) throw new Error('Für diesen Testfall fehlt die Freigabe auf dem aktuellen Gerät.')
        await ctx.confirm(`Echten Test „${testCase.name}“ starten?\nWorkflow: ${ctx.workflow.name}, Version ${expectedVersion}\nGerät: ${ctx.access.config.clientId}\nFixture: ${testCase.fixture_hash}\nPrüfregeln: ${testCase.assertions_hash}${repairId ? `\nReparaturentwurf: ${repairId}` : ''}\n\nDieser Lauf kann tatsächliche Modellaufrufe, Skripte und Dateiänderungen ausführen. Die bisherigen Geräte- und Schrittfreigaben gelten weiterhin.`)
      }
      return ctx.owned(await ctx.write<WorkflowTestEvidence>(`/workflows/${workflowId}/tests`, {
        mode, test_case_id: caseId, expected_version: expectedVersion,
        ...(deviceBound ? { device_id: ctx.access.config.clientId } : {}),
        ...(repairId ? { repair_revision_id: repairId } : {}),
      }, expectedVersion))
    },
    async configureRepair(workflowId: number, expectedVersion: number, input: { testCaseId: number; enabled: boolean; autoActivate: boolean; allowScriptRepair: boolean; maxRepairs: number }) {
      const ctx = await connect(workflowId, true)
      const testCase = await ctx.caseById(input.testCaseId)
      if (testCase.specification.real_test_authorized !== true || testCase.specification.device_id !== ctx.access.config.clientId)
        throw new Error('Die Reparatur braucht einen für dieses Gerät freigegebenen Testfall.')
      if (!Number.isInteger(input.maxRepairs) || input.maxRepairs < 0 || input.maxRepairs > 2)
        throw new Error('Höchstens zwei Reparaturversuche sind zulässig.')
      const body = { expected_version: expectedVersion, enabled: input.enabled, auto_activate: input.autoActivate,
        allow_script_repair: input.allowScriptRepair, max_repairs: input.maxRepairs, test_case_id: testCase.id,
        device_id: ctx.access.config.clientId, local_approved: true }
      await ctx.confirm(`${input.enabled ? 'Begrenzte automatische Reparaturen freigeben' : 'Automatische Reparaturen deaktivieren'}?\n\n${JSON.stringify({ workflow: ctx.workflow.name, ...body, assertions_hash: testCase.assertions_hash, fixture_hash: testCase.fixture_hash }, null, 2)}\n\nPrüfregeln und Rechte-/Kostenrahmen bleiben verbindlich. Aktivierung erst nach bestandenem echten Test; laufende Aufträge behalten ihre Version.`)
      const policy = await ctx.write<Record<string, unknown>>(`/workflows/${workflowId}/repair-policy`, body, expectedVersion)
      await ctx.access.check()
      for (const key of ['enabled', 'auto_activate', 'allow_script_repair', 'max_repairs', 'test_case_id', 'device_id'] as const) {
        if (policy[key] !== body[key]) throw new Error('Die gespeicherte Reparaturfreigabe weicht von der bestätigten Auswahl ab.')
      }
      if (policy.assertions_hash !== testCase.assertions_hash || policy.fixture_hash !== testCase.fixture_hash)
        throw new Error('Die gespeicherte Reparaturfreigabe gehört zu anderen Testdaten.')
      await rememberLocalWorkflowRepairPolicy(workflowId, policy, { projectId, execution: ctx.access.execution })
      await ctx.access.check()
      return policy
    },
    async propose(workflowId: number, expectedVersion: number, sourceRunId: number, definition: WorkflowDefinition) {
      const ctx = await connect(workflowId, true)
      return ctx.owned(await ctx.write<WorkflowRepair>(`/workflows/${workflowId}/repairs`, { source_run_id: sourceRunId, expected_version: expectedVersion, definition }, expectedVersion))
    },
    async activate(workflowId: number, repairId: number) {
      const ctx = await connect(workflowId, true)
      const repair = (await ctx.request<WorkflowRepair[]>(`/workflows/${workflowId}/repairs`)).find(item => item.id === repairId)
      if (!repair || ctx.owned(repair).status !== 'proposed') throw new Error('Der Reparaturentwurf ist nicht mehr verfügbar.')
      await ctx.confirm(`Geprüften Reparaturentwurf ${repairId} für künftige Läufe von „${ctx.workflow.name}“ aktivieren? Der Server prüft die echte Testevidenz und den unveränderten Freigaberahmen erneut.`)
      return ctx.write<Record<string, unknown>>(`/workflow-repairs/${repairId}/activate`, {})
    },
  }
}
