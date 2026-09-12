import { reactive } from 'vue'
import { captureWorkflowAccess } from './access'
import { workflowTools } from '@/services/tools/workflows'
import { getProjectWorkspace } from '@/services/projectWorkspace'
import { executionGate } from '@/services/executionGate'
import type { ToolContext } from '@/services/tools/types'
import type { WorkflowApi } from './api'
import type { Workflow, WorkflowRevision, WorkflowRun, WorkflowTask, WorkflowTrigger } from './types'
import type { WorkflowDefinition } from './types'
import { validateWorkflowDeviceTargets } from './deviceTarget'

type Connection = { api: WorkflowApi; deviceId: string; rootPath: string; baseUrl: string }
export type WorkflowControllerDependencies = {
  connect(projectId: string, signal: AbortSignal): Promise<Connection>
  perform(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>
}
const defaults: WorkflowControllerDependencies = {
  async connect(projectId, signal) {
    const access = await captureWorkflowAccess({ projectId, signal }, undefined, false)
    const workspace = await getProjectWorkspace(projectId, access.principalId)
    await access.check()
    return {
      api: access.api,
      deviceId: access.config.clientId,
      rootPath: workspace?.status === 'ready' ? workspace.rootPath : '',
      baseUrl: access.config.baseUrl,
    }
  },
  async perform(name, args, ctx) {
    const tool = workflowTools.find(item => item.name === name)
    if (!tool) throw new Error('Unbekannte Workflow-Aktion.')
    return tool.execute(args, ctx)
  },
}
export class WorkflowController {
  readonly view = reactive({
    projectId: '',
    workflows: [] as Workflow[],
    catalog: [] as WorkflowTask[],
    selected: null as Workflow | null,
    runs: [] as WorkflowRun[],
    run: null as WorkflowRun | null,
    triggers: [] as WorkflowTrigger[],
    revision: null as WorkflowRevision | null,
    grant: null as Record<string, unknown> | null,
    sources: {
      repositories: [] as Array<{ id: number; full_name: string }>,
      tasks: [] as Array<{ id: number; title: string }>,
      workflows: [] as Array<{ id: number; name: string }>,
    },
    sourcesError: '',
    deviceId: '',
    rootPath: '',
    baseUrl: '',
    busy: false,
    error: '',
    notice: '',
    deliveries: [] as Array<{
      id: number
      status: string
      last_error?: string | null
      error?: string | null
      created_at?: string
    }>,
  })
  private abort = new AbortController()
  private generation = 0
  private connection?: Connection
  constructor(private readonly deps: WorkflowControllerDependencies = defaults) {}
  reset(projectId = '') {
    this.abort.abort()
    this.abort = new AbortController()
    this.generation++
    this.connection = undefined
    Object.assign(this.view, {
      projectId,
      workflows: [],
      catalog: [],
      selected: null,
      runs: [],
      run: null,
      revision: null,
      triggers: [],
      grant: null,
      deviceId: '',
      rootPath: '',
      baseUrl: '',
      busy: false,
      error: '',
      notice: '',
      deliveries: [],
      sourcesError: '',
      sources: { repositories: [], tasks: [], workflows: [] },
    })
  }
  private current(generation: number) {
    if (generation !== this.generation || this.abort.signal.aborted)
      throw new DOMException('Workflow-Ansicht gewechselt.', 'AbortError')
  }
  private async reconnect(generation: number) {
    const connection = await this.deps.connect(this.view.projectId, this.abort.signal)
    this.current(generation)
    this.connection = connection
    Object.assign(this.view, {
      deviceId: connection.deviceId,
      rootPath: connection.rootPath,
      baseUrl: connection.baseUrl,
    })
    return connection.api
  }
  private async guarded<T>(operation: (generation: number) => Promise<T>): Promise<T | undefined> {
    if (this.view.busy) return undefined
    const generation = this.generation
    this.view.busy = true
    this.view.error = ''
    try {
      return await operation(generation)
    } catch (error) {
      if (generation === this.generation)
        this.view.error = error instanceof Error ? error.message : 'Workflow-Aktion fehlgeschlagen.'
      return undefined
    } finally {
      if (generation === this.generation) this.view.busy = false
    }
  }
  async load(projectId: string, workflowId?: number) {
    if (projectId !== this.view.projectId) this.reset(projectId)
    return this.guarded(async generation => {
      const connection = await this.deps.connect(projectId, this.abort.signal)
      this.current(generation)
      this.connection = connection
      Object.assign(this.view, {
        deviceId: connection.deviceId,
        rootPath: connection.rootPath,
        baseUrl: connection.baseUrl,
      })
      const [catalog, workflows] = await Promise.all([connection.api.catalog(), connection.api.list(projectId)])
      this.current(generation)
      this.view.catalog = catalog.data
      this.view.workflows = workflows.data
      try {
        const sources = await connection.api.sources(projectId)
        this.current(generation)
        this.view.sources = sources.data
      } catch (error) {
        this.current(generation)
        this.view.sourcesError = error instanceof Error ? error.message : 'Ereignisquellen sind nicht verfügbar.'
      }
      const selectedId = workflowId ?? this.view.selected?.id
      if (selectedId) await this.selectInternal(selectedId, generation)
    })
  }
  private async selectInternal(id: number, generation: number) {
    const api = this.connection!.api
    const workflow = await api.get(id)
    this.current(generation)
    if (workflow.data.project_external_id !== this.view.projectId)
      throw new Error('Dieser Workflow gehört zu einem anderen Projekt.')
    const [runs, triggers, automation] = await Promise.all([api.runs(id), api.triggers(id), api.automation(id)])
    this.current(generation)
    this.view.selected = workflow.data
    this.view.runs = runs.data
    this.view.triggers = triggers.data
    this.view.grant = automation.data.grant
    this.view.revision = null
    if (this.view.run && this.view.run.workflow_definition_id !== id) this.view.run = null
  }
  select(id: number) {
    return this.guarded(async generation => {
      await this.reconnect(generation)
      return this.selectInternal(id, generation)
    })
  }
  loadRevision(version: number) {
    return this.guarded(async generation => {
      if (!this.connection || !this.view.selected) return
      await this.reconnect(generation)
      const response = await this.connection.api.revision(this.view.selected.id, version)
      this.current(generation)
      this.view.revision = response.data
    })
  }
  async action(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    return this.guarded(async generation => {
      if (['workflow_create', 'workflow_update', 'workflow_validate'].includes(name) && args.definition !== undefined)
        validateWorkflowDeviceTargets(args.definition as WorkflowDefinition, this.view.catalog)
      const output = await this.deps.perform(name, args, {
        projectId: this.view.projectId,
        signal: this.abort.signal,
        execution: executionGate.capture(this.abort.signal),
      })
      this.current(generation)
      const result = output as Record<string, unknown>
      if (result?.ok === false) throw new Error(String(result.error ?? 'Workflow-Aktion fehlgeschlagen.'))
      const reference = result?.workflow_ref as { id?: number; runId?: string } | undefined
      if (reference?.id && this.connection) {
        await this.reconnect(generation)
        const listed = await this.connection.api.list(this.view.projectId)
        this.current(generation)
        this.view.workflows = listed.data
        await this.selectInternal(reference.id, generation)
        if (reference.runId) {
          const run = await this.connection.api.run(reference.runId)
          this.current(generation)
          this.view.run = run.data
        }
      }
      return result
    })
  }
  async refreshRun(runId: string) {
    return this.guarded(async generation => {
      if (!this.connection || !this.view.selected) return
      await this.reconnect(generation)
      const response = await this.connection.api.run(runId)
      this.current(generation)
      if (response.data.workflow_definition_id !== this.view.selected.id)
        throw new Error('Der Lauf gehört zu einem anderen Workflow.')
      this.view.run = response.data
      const listed = await this.connection.api.runs(this.view.selected.id)
      this.current(generation)
      this.view.runs = listed.data
    })
  }
  async approveStep(id: number, output?: Record<string, unknown>) {
    return this.guarded(async generation => {
      if (!this.connection || !this.view.run?.steps?.some(step => step.id === id))
        throw new Error('Der Schritt ist nicht ausgewählt.')
      const ticket = executionGate.capture(this.abort.signal)
      executionGate.assert(ticket, true)
      await this.reconnect(generation)
      executionGate.assert(ticket, true)
      const response =
        output === undefined ? await this.connection.api.approve(id) : await this.connection.api.complete(id, output)
      this.current(generation)
      executionGate.assert(ticket, true)
      const run = await this.connection.api.run(this.view.run.public_id)
      this.current(generation)
      this.view.run = run.data
      return response
    })
  }
  deliveries(triggerId: number) {
    return this.guarded(async generation => {
      if (!this.connection || !this.view.triggers.some(trigger => trigger.id === triggerId)) return
      await this.reconnect(generation)
      const result = await this.connection.api.deliveries(triggerId)
      this.current(generation)
      this.view.deliveries = result.data
    })
  }
  retryDelivery(id: number) {
    return this.guarded(async generation => {
      if (!this.connection || !this.view.deliveries.some(item => item.id === id)) return
      const ticket = executionGate.capture(this.abort.signal)
      executionGate.assert(ticket, true)
      await this.reconnect(generation)
      executionGate.assert(ticket, true)
      await this.connection.api.retryDelivery(id)
      this.current(generation)
      executionGate.assert(ticket, true)
      this.view.notice = 'Die Zustellung wurde erneut eingereiht.'
    })
  }
}
