import type {
  AgentAdapter,
  AgentJob,
  AgentJobInput,
  AgentJobMetadata,
  AgentJobStatus,
  AgentOrchestratorOptions,
  AgentPermission,
  AgentProjectSnapshot,
  AgentRole,
} from './types'
import { validateAgentExecutionOptions } from './effort'
import { freezeAgentWorkflowScope } from './workflowScope'

type InternalJob = {
  metadata: AgentJobMetadata
  project: AgentProjectSnapshot
  workflowScope?: AgentJobInput['workflowScope']
  prompt: string
  resumeThreadId?: string
  output: string
  controller: AbortController
  /** Stays true until the adapter settles, even after visible cancellation. */
  executing: boolean
  discard: boolean
  approvalTimer?: ReturnType<typeof setTimeout>
}

const TERMINAL = new Set<AgentJobStatus>(['completed', 'failed', 'cancelled'])
const PERMISSIONS: readonly AgentPermission[] = ['read-only', 'workspace-write']
const ROLES: readonly AgentRole[] = ['planner', 'implementer', 'reviewer', 'join', 'assistant']

function boundedInteger(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error('Ungültiges Agentenlimit.')
  return value
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
}

function snapshotProject(project: AgentProjectSnapshot): AgentProjectSnapshot {
  if (!project || !safeIdentifier(project.principalId) || !safeIdentifier(project.projectId)) {
    throw new Error('Für den Agentenauftrag fehlt eine gültige Konto- oder Projektzuordnung.')
  }
  if (typeof project.projectName !== 'string' || project.projectName.length > 512) {
    throw new Error('Der Projektname ist ungültig.')
  }
  if (
    project.rootPath !== undefined &&
    (typeof project.rootPath !== 'string' || !project.rootPath.trim() || /[\u0000-\u001f]/u.test(project.rootPath))
  ) {
    throw new Error('Der lokale Projektordner ist ungültig.')
  }
  if (project.workspaceUpdatedAt !== undefined && !Number.isFinite(project.workspaceUpdatedAt)) {
    throw new Error('Die lokale Projektzuordnung ist ungültig.')
  }
  return Object.freeze({
    principalId: project.principalId,
    projectId: project.projectId,
    projectName: project.projectName,
    rootPath: project.rootPath,
    workspaceUpdatedAt: project.workspaceUpdatedAt,
  })
}

/**
 * Explicitly approved, project-scoped jobs. No state is restored or dispatched
 * from persisted history. Prompts and bounded results live in memory only.
 */
export class AgentOrchestrator {
  private readonly adapters = new Map<string, AgentAdapter>()
  private readonly jobs = new Map<string, InternalJob>()
  private readonly listeners = new Set<() => void>()
  private readonly maxConcurrent: number
  private readonly maxPendingPerProject: number
  private readonly maxPendingTotal: number
  private readonly maxHistory: number
  private readonly maxOutputCharacters: number
  private readonly maxPromptCharacters: number
  private readonly approvalTimeoutMs: number
  private readonly createId: () => string
  private readonly now: () => number
  private readonly lastScheduledByScope = new Map<string, number>()
  private scheduleSequence = 0
  private scheduling = false
  private disposed = false

  constructor(private readonly options: AgentOrchestratorOptions) {
    this.maxConcurrent = boundedInteger(options.maxConcurrent, 2, 8)
    this.maxPendingPerProject = boundedInteger(options.maxPendingPerProject, 8, 64)
    this.maxPendingTotal = boundedInteger(options.maxPendingTotal, 64, 256)
    this.maxHistory = boundedInteger(options.maxHistory, 50, 500)
    this.maxOutputCharacters = boundedInteger(options.maxOutputCharacters, 128_000, 1_000_000)
    this.maxPromptCharacters = boundedInteger(options.maxPromptCharacters, 32_000, 128_000)
    this.approvalTimeoutMs = boundedInteger(options.approvalTimeoutMs, 15 * 60_000, 24 * 60 * 60_000)
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.now = options.now ?? Date.now
    for (const adapter of options.adapters) {
      if (!safeIdentifier(adapter.id) || this.adapters.has(adapter.id)) throw new Error('Ungültiger Agentenadapter.')
      const resources = adapter.exclusiveResources ?? []
      if (resources.some(resource => !safeIdentifier(resource))) throw new Error('Ungültige Agentenressource.')
      this.adapters.set(
        adapter.id,
        Object.freeze({
          ...adapter,
          permissions: Object.freeze([...adapter.permissions]),
          exclusiveResources: Object.freeze([...new Set(resources)]),
        })
      )
    }
  }

  enqueue(input: AgentJobInput): AgentJob {
    validateAgentExecutionOptions(input)
    if (this.disposed) throw new Error('Die Agentenzentrale ist geschlossen.')
    const adapter = this.adapters.get(input.adapterId)
    if (!adapter) throw new Error('Der gewählte Agent ist nicht verfügbar.')
    if (!PERMISSIONS.includes(input.permission) || !adapter.permissions.includes(input.permission)) {
      throw new Error('Dieser Agent unterstützt die gewählte Freigabe nicht.')
    }
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > this.maxPromptCharacters) {
      throw new Error(`Der Auftrag muss zwischen 1 und ${this.maxPromptCharacters} Zeichen enthalten.`)
    }
    const project = snapshotProject(input.project)
    const workflowScope = freezeAgentWorkflowScope(input.workflowScope, project)
    if (workflowScope && (!['codex', 'claude'].includes(input.adapterId) || input.externalThreadId))
      throw new Error('Workflow-Arbeitskopien dürfen keine fremde Agentensitzung übernehmen.')
    if (input.permission === 'workspace-write' && !project.rootPath) {
      throw new Error('Für Schreibzugriff muss dem Projekt ein lokaler Ordner zugeordnet sein.')
    }
    const role = input.role ?? 'assistant'
    if (!ROLES.includes(role)) throw new Error('Die Agentenrolle ist ungültig.')
    if (input.model !== undefined && !safeIdentifier(input.model)) throw new Error('Das gewählte Modell ist ungültig.')
    if (
      input.defaultModelRevision !== undefined &&
      (!input.model ||
        !/^[a-f0-9]{64}$/u.test(input.defaultModelRevision) ||
        !input.defaultModelSource ||
        !/^[a-zA-Z0-9_.:-]{1,80}$/u.test(input.defaultModelSource))
    )
      throw new Error('Ungültige Standardmodell-Bindung.')
    if (input.externalThreadId !== undefined && !safeIdentifier(input.externalThreadId)) {
      throw new Error('Die externe Aufgaben-ID ist ungültig.')
    }
    if (input.teamRunId !== undefined && !safeIdentifier(input.teamRunId)) throw new Error('Die Team-ID ist ungültig.')
    if (input.teamNodeId !== undefined && !safeIdentifier(input.teamNodeId))
      throw new Error('Die Teamknoten-ID ist ungültig.')
    const pending = [...this.jobs.values()].filter(job => !TERMINAL.has(job.metadata.status) || job.executing)
    if (pending.length >= this.maxPendingTotal) throw new Error('Die Agentenwarteschlange ist voll.')
    if (pending.filter(job => this.sameProject(job.project, project)).length >= this.maxPendingPerProject) {
      throw new Error('Die Agentenwarteschlange für dieses Projekt ist voll.')
    }
    const id = this.createId()
    if (!safeIdentifier(id) || this.jobs.has(id))
      throw new Error('Es konnte keine eindeutige Agenten-ID erstellt werden.')
    const job: InternalJob = {
      project,
      workflowScope,
      prompt: input.prompt,
      resumeThreadId: input.externalThreadId,
      output: '',
      controller: new AbortController(),
      executing: false,
      discard: false,
      metadata: Object.freeze({
        id,
        principalId: project.principalId,
        projectId: project.projectId,
        adapterId: adapter.id,
        model: input.model,
        defaultModelRevision: input.defaultModelRevision,
        defaultModelSource: input.defaultModelSource,
        thinkingTier: input.thinkingTier,
        effort: input.effort,
        effortSelection: input.effortSelection && Object.freeze({ ...input.effortSelection }),
        executionProfile: input.executionProfile,
        maxTurns: input.maxTurns,
        maxBudgetUsd: input.maxBudgetUsd,
        role,
        permission: input.permission,
        teamRunId: input.teamRunId,
        teamNodeId: input.teamNodeId,
        status: 'awaiting_approval',
        createdAt: this.now(),
        approvalExpiresAt: this.now() + this.approvalTimeoutMs,
      }),
    }
    this.jobs.set(id, job)
    job.approvalTimer = setTimeout(() => {
      const current = this.jobs.get(id)
      if (!current || current.metadata.status !== 'awaiting_approval') return
      current.prompt = ''
      this.update(current, {
        status: 'cancelled',
        finishedAt: this.now(),
        errorCode: 'approval_expired',
      })
      this.prune()
      this.schedule()
    }, this.approvalTimeoutMs)
    this.publish(job)
    return this.liveRecord(job)
  }

  /** Only a trusted user approval UI should call this method. */
  approve(id: string): boolean {
    const job = this.jobs.get(id)
    if (this.disposed || !job || job.metadata.status !== 'awaiting_approval') return false
    this.clearApprovalTimer(job)
    this.update(job, { status: 'queued', approvalExpiresAt: undefined })
    this.schedule()
    return true
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job || TERMINAL.has(job.metadata.status)) return false
    this.clearApprovalTimer(job)
    job.controller.abort()
    job.prompt = ''
    job.resumeThreadId = undefined
    this.update(job, { status: 'cancelled', finishedAt: this.now() })
    this.prune()
    this.schedule()
    return true
  }

  /** On identity change, stop work and discard that account's live content. */
  clearPrincipal(principalId: string): void {
    for (const job of [...this.jobs.values()]) {
      if (job.project.principalId !== principalId) continue
      job.output = ''
      this.cancel(job.metadata.id)
      job.discard = true
      if (!job.executing) this.jobs.delete(job.metadata.id)
    }
    this.notify()
  }

  getJob(id: string): AgentJob | undefined {
    const job = this.jobs.get(id)
    return job ? this.liveRecord(job) : undefined
  }

  listJobs(principalId: string, projectId?: string): readonly AgentJob[] {
    return Object.freeze(
      [...this.jobs.values()]
        .filter(job => job.project.principalId === principalId && (!projectId || job.project.projectId === projectId))
        .map(job => this.liveRecord(job))
        .reverse()
    )
  }

  getOutput(id: string): string {
    return this.jobs.get(id)?.output ?? ''
  }

  /** Terminal UI state plus a settled adapter/native worker. */
  isSettled(id: string): boolean {
    const job = this.jobs.get(id)
    return !!job && TERMINAL.has(job.metadata.status) && !job.executing
  }

  /** Trusted review UI only; this value must never enter shared metadata or logs. */
  getPrompt(id: string): string {
    return this.jobs.get(id)?.prompt ?? ''
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    for (const job of this.jobs.values()) {
      this.cancel(job.metadata.id)
      job.output = ''
    }
    this.listeners.clear()
  }

  /** Stop admission and wait for native adapters to release every owned worker. */
  async shutdown(): Promise<void> {
    this.disposed = true
    for (const job of this.jobs.values()) this.cancel(job.metadata.id)
    if (![...this.jobs.values()].some(job => job.executing)) return
    await new Promise<void>(resolve => {
      const inspect = () => {
        if ([...this.jobs.values()].some(job => job.executing)) return
        unsubscribe()
        resolve()
      }
      const unsubscribe = this.subscribe(inspect)
      inspect()
    })
  }

  private sameProject(left: AgentProjectSnapshot, right: AgentProjectSnapshot): boolean {
    return left.principalId === right.principalId && left.projectId === right.projectId
  }

  private sharesWorkspace(left: AgentProjectSnapshot, right: AgentProjectSnapshot): boolean {
    if (this.sameProject(left, right)) return true
    if (!left.rootPath || !right.rootPath) return false
    const canonical = (root: string) => {
      // Native bindings already resolve paths; only account for Windows casing here.
      return /^[a-z]:[\\/]|^\\\\/iu.test(root) ? root.replace(/\\/gu, '/').toLowerCase() : root
    }
    const leftRoot = canonical(left.rootPath).replace(/\/+$/u, '')
    const rightRoot = canonical(right.rootPath).replace(/\/+$/u, '')
    return leftRoot === rightRoot || leftRoot.startsWith(`${rightRoot}/`) || rightRoot.startsWith(`${leftRoot}/`)
  }

  private conflicts(left: InternalJob, right: InternalJob): boolean {
    if (left.resumeThreadId && right.resumeThreadId && left.resumeThreadId === right.resumeThreadId) return true
    if (
      this.sharesWorkspace(left.project, right.project) &&
      (left.metadata.permission === 'workspace-write' || right.metadata.permission === 'workspace-write')
    ) {
      return true
    }
    const leftResources = this.adapters.get(left.metadata.adapterId)?.exclusiveResources ?? []
    const rightResources = new Set(this.adapters.get(right.metadata.adapterId)?.exclusiveResources ?? [])
    return leftResources.some(resource => rightResources.has(resource))
  }

  private fairnessKey(job: InternalJob): string {
    return `${job.project.principalId}\u0000${job.project.projectId}\u0000${job.metadata.teamRunId ?? 'single'}`
  }

  private clearApprovalTimer(job: InternalJob): void {
    if (job.approvalTimer) clearTimeout(job.approvalTimer)
    job.approvalTimer = undefined
  }

  private liveRecord(job: InternalJob): AgentJob {
    return Object.freeze({ ...job.metadata, project: job.project })
  }

  private update(job: InternalJob, patch: Partial<AgentJobMetadata>): void {
    job.metadata = Object.freeze({ ...job.metadata, ...patch })
    this.publish(job)
  }

  private publish(job: InternalJob): void {
    try {
      this.options.onMetadata?.(job.metadata)
    } catch {
      // A history consumer cannot interrupt cancellation or release a workspace lock.
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A UI subscriber must not alter the execution state machine.
      }
    }
  }

  private schedule(): void {
    if (this.scheduling || this.disposed) return
    this.scheduling = true
    queueMicrotask(() => {
      this.scheduling = false
      if (this.disposed) return
      const running = [...this.jobs.values()].filter(candidate => candidate.executing)
      while (running.length < this.maxConcurrent) {
        const candidates = [...this.jobs.values()]
          .filter(
            job =>
              !job.executing && job.metadata.status === 'queued' && !running.some(active => this.conflicts(active, job))
          )
          .sort((left, right) => {
            const leftTurn = this.lastScheduledByScope.get(this.fairnessKey(left)) ?? 0
            const rightTurn = this.lastScheduledByScope.get(this.fairnessKey(right)) ?? 0
            return leftTurn - rightTurn || left.metadata.createdAt - right.metadata.createdAt
          })
        const job = candidates[0]
        if (!job) break
        job.executing = true
        running.push(job)
        this.lastScheduledByScope.set(this.fairnessKey(job), ++this.scheduleSequence)
        void this.execute(job)
      }
    })
  }

  private async execute(job: InternalJob): Promise<void> {
    let phase: 'scope' | 'run' | 'result' = 'scope'
    try {
      await this.options.validateScope(job.project, job.metadata.permission)
      if (job.controller.signal.aborted || this.disposed) return
      this.update(job, { status: 'running', startedAt: this.now() })
      // Subscribers can cancel or switch identities while rendering the new state.
      if (job.controller.signal.aborted || this.disposed) return
      phase = 'run'
      const adapter = this.adapters.get(job.metadata.adapterId)!
      const result = await adapter.run(
        Object.freeze({
          jobId: job.metadata.id,
          project: job.project,
          prompt: job.prompt,
          permission: job.metadata.permission,
          role: job.metadata.role,
          model: job.metadata.model,
          defaultModelRevision: job.metadata.defaultModelRevision,
          defaultModelSource: job.metadata.defaultModelSource,
          thinkingTier: job.metadata.thinkingTier,
          effort: job.metadata.effort,
          effortSelection: job.metadata.effortSelection,
          executionProfile: job.metadata.executionProfile,
          workflowScope: job.workflowScope,
          maxTurns: job.metadata.maxTurns,
          maxBudgetUsd: job.metadata.maxBudgetUsd,
          externalThreadId: job.resumeThreadId,
          teamRunId: job.metadata.teamRunId,
          teamNodeId: job.metadata.teamNodeId,
          signal: job.controller.signal,
          onPhase: phase => {
            if (job.controller.signal.aborted || this.disposed || TERMINAL.has(job.metadata.status)) return
            if (phase === job.metadata.status) return
            this.update(job, { status: phase })
          },
          onOutput: (output: string) => {
            if (
              job.controller.signal.aborted ||
              this.disposed ||
              !['running', 'awaiting_external_approval'].includes(job.metadata.status)
            )
              return
            if (typeof output !== 'string') return
            job.output = output.slice(0, this.maxOutputCharacters)
            this.notify()
          },
        })
      )
      if (job.controller.signal.aborted || this.disposed) return
      phase = 'scope'
      await this.options.validateScope(job.project, job.metadata.permission)
      if (job.controller.signal.aborted || this.disposed) return
      phase = 'result'
      if (
        !result ||
        typeof result.output !== 'string' ||
        (result.externalThreadId !== undefined && !safeIdentifier(result.externalThreadId)) ||
        (result.runtimeEvidence?.model !== undefined &&
          (!safeIdentifier(result.runtimeEvidence.model) || result.runtimeEvidence.modelSource !== 'runtime')) ||
        (result.runtimeEvidence?.toolGateChecks !== undefined &&
          (!Number.isSafeInteger(result.runtimeEvidence.toolGateChecks) || result.runtimeEvidence.toolGateChecks < 0))
      ) {
        throw new Error('Ungültiges Agentenergebnis.')
      }
      job.output = result.output.slice(0, this.maxOutputCharacters)
      this.update(job, {
        status: 'completed',
        finishedAt: this.now(),
        externalThreadId: result.externalThreadId,
        effortSelection: result.effortSelection ?? job.metadata.effortSelection,
        runtimeEvidence:
          result.runtimeEvidence &&
          Object.freeze({
            model: result.runtimeEvidence.model,
            modelSource: result.runtimeEvidence.modelSource,
            toolGateChecks: result.runtimeEvidence.toolGateChecks,
          }),
      })
    } catch {
      if (!job.controller.signal.aborted && !this.disposed) {
        if (phase === 'scope') job.output = ''
        this.update(job, {
          status: 'failed',
          finishedAt: this.now(),
          errorCode: phase === 'scope' ? 'scope_changed' : phase === 'result' ? 'invalid_result' : 'execution_failed',
        })
      }
    } finally {
      job.executing = false
      this.clearApprovalTimer(job)
      job.prompt = ''
      job.resumeThreadId = undefined
      if (job.discard) {
        this.jobs.delete(job.metadata.id)
        this.notify()
      }
      this.prune()
      this.notify()
      this.schedule()
    }
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter(job => TERMINAL.has(job.metadata.status) && !job.executing)
    const excess = finished.length - this.maxHistory
    if (excess <= 0) return
    for (const job of finished.slice(0, excess)) this.jobs.delete(job.metadata.id)
    if (this.lastScheduledByScope.size > this.maxHistory * 4) {
      const liveKeys = new Set([...this.jobs.values()].map(job => this.fairnessKey(job)))
      for (const key of this.lastScheduledByScope.keys()) if (!liveKeys.has(key)) this.lastScheduledByScope.delete(key)
    }
    this.notify()
  }
}
