import type { ExecutionTicket } from '@/services/executionGate'
import { localResources } from '@/services/inference/resources'
import type { ManagedAgentJobObserver } from '@/services/agents/managedJob'
import type { AgentTeamDefinition, AgentTeamRun, AgentTeamRunInput } from '@/services/agents/teams'
import type {
  AgentJob,
  AgentPermission,
  AgentProjectSnapshot,
  AgentRole,
  AgentRunResult,
} from '@/services/agents/types'
import {
  MAX_PLANNING_IMPORT_CHARACTERS,
  LOCAL_PLANNING_ACCESS_LIMIT,
  normalizePlanningClarifications,
  normalizePlanningObjective,
  parsePlanningAnalysis,
  parsePlanningJson,
  parsePlanningPlan,
  validatePlanningAnalysis,
  validatePlanningPlan,
} from './validation'
import {
  PLANNING_EXPORT_VERSION,
  type PlanningAdapterId,
  type PlanningAnalysis,
  type PlanningAnalyzeInput,
  type PlanningExecuteInput,
  type PlanningExport,
  type PlanningHub,
  type PlanningPlan,
  type PlanningSession,
  type PlanningSessionStatus,
} from './types'

export type PlanningPreparedJobInput = Readonly<{
  projectId: string
  adapterId: PlanningAdapterId
  prompt: string
  role: AgentRole
  permission: AgentPermission
  model?: string
  includeMemory?: boolean
  teamRunId?: string
  teamNodeId?: string
  expectedProject?: AgentProjectSnapshot
}>

export type PlanningControllerDependencies = Readonly<{
  projectSnapshot(projectId: string): Promise<AgentProjectSnapshot>
  validateScope(project: AgentProjectSnapshot, permission: AgentPermission): void | Promise<void>
  prepareAgentJob(input: PlanningPreparedJobInput): Promise<Pick<AgentJob, 'id'>>
  cancelAgentJob(jobId: string): boolean
  executePreparedAgentJob(
    jobId: string,
    signal?: AbortSignal,
    observer?: ManagedAgentJobObserver
  ): Promise<AgentRunResult>
  prepareAgentTeam(definition: AgentTeamDefinition, input: AgentTeamRunInput): AgentTeamRun
  approveAgentTeam(runId: string): boolean
  cancelAgentTeam(runId: string): boolean
  getAgentTeam(runId: string): AgentTeamRun | undefined
  subscribeAgentTeams(listener: () => void): () => void
  captureExecution(signal?: AbortSignal): ExecutionTicket
  assertExecution(ticket: ExecutionTicket, mutating?: boolean): void
  createId?: () => string
  now?: () => number
}>

type ActiveOperation = {
  controller: AbortController
  ticket: ExecutionTicket
  project?: AgentProjectSnapshot
  sessionId?: string
  jobId?: string
  teamRunId?: string
}

class PlanningInterruptedError extends Error {}

const ACTIVE_STATUSES = new Set<PlanningSessionStatus>(['analyzing', 'planning', 'executing'])
const TEAM_TERMINAL = new Set<AgentTeamRun['status']>(['completed', 'failed', 'cancelled'])
const SESSION_KEYS = [
  'id',
  'revision',
  'project',
  'objective',
  'status',
  'analysis',
  'plan',
  'execution',
  'error',
  'output',
] as const
const PROJECT_REQUIRED_KEYS = ['principalId', 'projectId', 'projectName'] as const
const PROJECT_OPTIONAL_KEYS = ['rootPath', 'workspaceUpdatedAt'] as const
const ANALYSIS_SCHEMA = JSON.stringify(
  {
    summary: 'string',
    findings: ['string'],
    evidence: ['string'],
    assumptions: ['string'],
    risks: ['string'],
    openQuestions: ['string'],
  },
  null,
  2
)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(): DOMException {
  return new DOMException('Planung abgebrochen.', 'AbortError')
}

function canonicalRoot(value?: string): string {
  if (!value) return ''
  const slash = value.replace(/\\/gu, '/').replace(/\/+$/u, '')
  return /^[a-z]:\//iu.test(slash) || slash.startsWith('//') ? slash.toLowerCase() : slash
}

function sameProject(left: AgentProjectSnapshot, right: AgentProjectSnapshot): boolean {
  return (
    left.principalId === right.principalId &&
    left.projectId === right.projectId &&
    canonicalRoot(left.rootPath) === canonicalRoot(right.rootPath) &&
    left.workspaceUpdatedAt === right.workspaceUpdatedAt
  )
}

function exactRecord(value: unknown, label: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} muss ein Objekt sein.`)
  const source = value as Record<string, unknown>
  const keys = Object.keys(source)
  if (keys.length !== allowedKeys.length || keys.some(key => !allowedKeys.includes(key))) {
    throw new Error(`${label} enthält fehlende oder unbekannte Felder.`)
  }
  return source
}

function cloneSession(session: PlanningSession): PlanningSession {
  return Object.freeze({ ...session })
}

function planningAnalysisPrompt(objective: string, clarifications: string, adapterId: PlanningAdapterId): string {
  const access =
    adapterId === 'codex'
      ? [
          'Untersuche den gebundenen Projektordner ausschließlich lesend.',
          'Nenne unter evidence nur tatsächlich gelesene Dateien, ausgeführte Nur-Lese-Prüfungen oder ausdrücklich fehlenden Zugriff.',
          'Behaupte keine Dateiinspektion, keinen Test und keinen Ist-Zustand ohne konkreten Beleg.',
        ].join('\n')
      : [
          'Du hast keine Datei-, Tool- oder Computersteuerung und kennst nur den bereitgestellten Projektkontext.',
          `Die App ergänzt diese verbindliche Zugriffsgrenze selbst: ${LOCAL_PLANNING_ACCESS_LIMIT}`,
          'Liefere höchstens 15 eigene evidence-Einträge und insgesamt höchstens 5500 Zeichen JSON.',
          'Kennzeichne alle weiteren Angaben als Kontextangabe oder Annahme, nicht als eigene Prüfung.',
        ].join('\n')
  return [
    'PLANUNGSMODUS · PHASE ANALYSE · NUR LESEN',
    'Analysiere Ziel, Ist-Hinweise, Grenzen, Risiken und offene Fragen. Verändere nichts.',
    access,
    `Ziel:\n${objective}`,
    clarifications ? `Klarstellungen des Benutzers:\n${clarifications}` : 'Klarstellungen des Benutzers: keine.',
    'Antworte ausschließlich als vollständiges JSON-Objekt mit exakt diesem Schema; Markdown-JSON-Fences sind erlaubt:',
    ANALYSIS_SCHEMA,
    'Alle Felder sind Pflichtfelder. evidence benötigt mindestens einen konkreten Beleg oder eine ausdrückliche Zugriffsgrenze.',
    adapterId === 'codex'
      ? 'Grenzen: höchstens 6000 Zeichen JSON, summary 2000 Zeichen, je Liste 16 Einträge und je Eintrag 1000 Zeichen.'
      : 'Grenzen: höchstens 5500 Zeichen Modell-JSON vor dem Zugriffshinweis, summary 2000 Zeichen, je Liste 16 Einträge und je Eintrag 1000 Zeichen.',
  ].join('\n\n')
}

function planningPlanPrompt(objective: string, clarifications: string, analysis: PlanningAnalysis): string {
  return [
    'PLANUNGSMODUS · PHASE PLAN · NUR LESEN',
    'Erstelle aus der geprüften Analyse einen vollständigen, ausführbaren und überprüfbaren DAG-Plan. Verändere nichts.',
    'Erfinde keine neue Analyse. Kopiere objective und analysis im Ergebnis inhaltlich exakt aus den folgenden JSON-Daten.',
    `Freigegebenes Ziel:\n${JSON.stringify(objective)}`,
    `Geprüfte Analyse:\n${JSON.stringify(analysis)}`,
    clarifications ? `Klarstellungen des Benutzers:\n${clarifications}` : 'Klarstellungen des Benutzers: keine.',
    [
      'Antworte ausschließlich als vollständiges JSON-Objekt mit exakt diesen Feldern:',
      '{',
      '  "objective": string,',
      '  "analysis": { summary, findings, evidence, assumptions, risks, openQuestions },',
      '  "steps": [{ id, title, description, dependencies, acceptanceCriteria, verification }],',
      '  "completionCriteria": string[],',
      '  "outOfScope": string[]',
      '}',
    ].join('\n'),
    'Regeln: 1 bis 12 Schritte; stabile eindeutige IDs aus a-z, 0-9, Punkt, Unterstrich oder Bindestrich; nur bekannte Abhängigkeiten; keine Zyklen; jeder Schritt benötigt Akzeptanzkriterien und konkrete Verifikation.',
    'Gesamtgrenze: 12000 Zeichen JSON. Schritt-Titel maximal 240, Beschreibung maximal 2000, Listeneinträge maximal 800 Zeichen.',
    'Offene fachliche Fragen bleiben in analysis.openQuestions sichtbar und blockieren später bewusst die Ausführung.',
  ].join('\n\n')
}

export function createPlanningExecutionDefinition(
  sessionId: string,
  revision: number,
  plan: PlanningPlan,
  input: Pick<PlanningExecuteInput, 'adapterId' | 'model' | 'permission'>
): AgentTeamDefinition {
  if (!sessionId || sessionId.length > 128 || /[\u0000-\u001f\u007f]/u.test(sessionId)) {
    throw new Error('Die Planungssitzung besitzt keine gültige ID.')
  }
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Die Planrevision ist ungültig.')
  if (!['codex', 'local', 'policy'].includes(input.adapterId)) throw new Error('Ungültiger Ausführungsagent.')
  if (!['read-only', 'workspace-write'].includes(input.permission)) throw new Error('Ungültige Ausführungsfreigabe.')
  if (input.permission === 'workspace-write' && input.adapterId !== 'codex') {
    throw new Error('Workspace-Schreibzugriff ist im Planungsmodus ausschließlich mit Codex möglich.')
  }
  if (input.model?.trim() && input.adapterId !== 'codex') {
    throw new Error('Lokale und richtliniengesteuerte Modelle wählen ihr signiertes Modellprofil selbst.')
  }
  const reviewedPlan = validatePlanningPlan(plan)
  const permission: AgentPermission = input.permission === 'workspace-write' ? 'workspace-write' : 'read-only'
  const nodeIds = new Map(reviewedPlan.steps.map((step, index) => [step.id, `plan-step-${index + 1}`]))
  const exactPlan = JSON.stringify(reviewedPlan)
  const stepNodes: AgentTeamDefinition['nodes'] = reviewedPlan.steps.map((step, index) => ({
    id: `plan-step-${index + 1}`,
    label: `${index + 1}. ${step.title}`,
    role: 'implementer',
    adapterId: input.adapterId,
    permission,
    dependencies: step.dependencies.map(dependency => nodeIds.get(dependency)!),
    prompt: [
      'Führe ausschließlich den folgenden bereits geprüften Planschritt aus. Plane den Auftrag nicht neu.',
      permission === 'read-only'
        ? 'Arbeite nur lesend und liefere konkrete Patch- oder Handlungsvorschläge; verändere den Workspace nicht.'
        : 'Ändere nur, was dieser Planschritt und der freigegebene Gesamtplan verlangen.',
      `Geprüfte Analyse und Zugriffsgrenzen:\n${JSON.stringify(reviewedPlan.analysis)}`,
      `Unveränderlicher Planschritt:\n${JSON.stringify(step)}`,
      `Verbindliche Gesamt-Abnahmekriterien:\n${JSON.stringify(reviewedPlan.completionCriteria)}`,
      `Außerhalb des Umfangs:\n${JSON.stringify(reviewedPlan.outOfScope)}`,
      'Berichte tatsächliche Änderungen, Nachweise, fehlgeschlagene Prüfungen und unbekannte Punkte getrennt.',
    ].join('\n\n'),
    model: input.model?.trim() || undefined,
    promptAssembly: 'exact-reviewed',
    maxPromptCharacters: 23_000,
  }))
  const stepNodeIds = stepNodes.map(node => node.id)
  const reviewId = 'plan-final-review'
  return Object.freeze({
    id: `reviewed-plan-v1-${sessionId}-${revision}`,
    label: 'Geprüften Plan ausführen · Review · Abschluss',
    maxParallel: Math.min(4, Math.max(1, reviewedPlan.steps.length)),
    maxPromptCharacters: Math.min(512_000, (reviewedPlan.steps.length + 2) * 23_000),
    deadlineMs: 60 * 60_000,
    approvalTimeoutMs: 10 * 60_000,
    nodes: Object.freeze([
      ...stepNodes,
      Object.freeze({
        id: reviewId,
        label: 'Abschlussreview gegen Abnahmekriterien',
        role: 'reviewer' as const,
        adapterId: input.adapterId,
        permission: 'read-only' as const,
        dependencies: Object.freeze(stepNodeIds),
        prompt: [
          'Prüfe die Ausführung gegen den unveränderlichen validierten Plan. Führe keine neue Umsetzung und keine Neuplanung aus.',
          `Validierter Plan:\n${exactPlan}`,
          'Erstelle für jedes acceptanceCriteria-, verification- und completionCriteria-Element einen Eintrag mit Status belegt, fehlgeschlagen oder unbekannt.',
          'Nenne ausschließlich tatsächlich vorliegende Nachweise aus den Vorgängerergebnissen. Fehlender Nachweis ist unbekannt, nicht bestanden.',
        ].join('\n\n'),
        model: input.model?.trim() || undefined,
        promptAssembly: 'exact-reviewed' as const,
        maxPromptCharacters: 23_000,
      }),
      Object.freeze({
        id: 'plan-final-join',
        label: 'Ausführungsergebnis und Restgrenzen',
        role: 'join' as const,
        adapterId: input.adapterId,
        permission: 'read-only' as const,
        dependencies: Object.freeze([...stepNodeIds, reviewId]),
        prompt: [
          'Konsolidiere die tatsächlichen Ergebnisse und das Abschlussreview. Plane und implementiere nichts Neues.',
          'Zeige Ergebnis, Belege, fehlgeschlagene oder unbekannte Abnahmepunkte und Restgrenzen ausdrücklich.',
          'Behaupte weder „Plan erfüllt“ noch „Tests bestanden“, wenn das Abschlussreview dafür keinen konkreten Nachweis enthält.',
        ].join('\n\n'),
        model: input.model?.trim() || undefined,
        promptAssembly: 'exact-reviewed' as const,
        maxPromptCharacters: 23_000,
      }),
    ]),
  })
}

export class PlanningController implements PlanningHub {
  private readonly sessions = new Map<string, PlanningSession>()
  private readonly operations = new Map<string, ActiveOperation>()
  private readonly listeners = new Set<() => void>()
  private readonly createId: () => string
  private readonly now: () => number
  private readonly stopTeamSubscription: () => void

  constructor(private readonly dependencies: PlanningControllerDependencies) {
    this.createId = dependencies.createId ?? (() => crypto.randomUUID())
    this.now = dependencies.now ?? Date.now
    this.stopTeamSubscription = dependencies.subscribeAgentTeams(() => this.syncTeamSnapshots())
  }

  get(projectId: string): PlanningSession | null {
    const session = this.sessions.get(projectId)
    return session ? cloneSession(session) : null
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async analyze(projectId: string, input: PlanningAnalyzeInput): Promise<void> {
    const objective = normalizePlanningObjective(input.objective)
    const clarifications = normalizePlanningClarifications(input.clarifications)
    this.validateAdapter(input.adapterId, input.model)
    if (this.operations.has(projectId))
      throw new Error('Für dieses Projekt läuft bereits eine Planung oder Ausführung.')
    const operation = this.beginOperation(projectId)
    let resourceLease:
      Awaited<ReturnType<typeof import('@/services/inference/resources').localResources.acquireGroup>> | undefined
    try {
      this.assertOperation(projectId, operation, false)
      const project = await this.dependencies.projectSnapshot(projectId)
      this.assertOperation(projectId, operation, false)
      this.assertProjectSnapshot(projectId, project)
      operation.project = project
      await this.scopeCheckpoint(projectId, operation, 'read-only')
      const session: PlanningSession = Object.freeze({
        id: this.newSessionId(),
        revision: 1,
        project: Object.freeze({ ...project }),
        objective,
        status: 'analyzing',
        analysis: null,
        plan: null,
        execution: null,
        error: '',
        output: '',
      })
      operation.sessionId = session.id
      resourceLease = await localResources.acquireGroup(`team:${session.id}`, operation.ticket.signal)
      this.assertOperation(projectId, operation, false)
      this.sessions.set(projectId, session)
      this.notify()

      const analysisJob = await this.prepareManagedJob(projectId, operation, {
        projectId,
        adapterId: input.adapterId,
        prompt: planningAnalysisPrompt(objective, clarifications, input.adapterId),
        role: 'planner',
        permission: 'read-only',
        model: input.model?.trim() || undefined,
        includeMemory: false,
        teamRunId: session.id,
        teamNodeId: 'analysis',
        expectedProject: project,
      })
      const analysisResult = await this.checkedAwait(projectId, operation, 'read-only', () =>
        this.dependencies.executePreparedAgentJob(analysisJob.id, operation.ticket.signal)
      )
      operation.jobId = undefined
      const analysis = parsePlanningAnalysis(analysisResult.output, input.adapterId)
      this.assertOperation(projectId, operation, false)
      this.update(projectId, current => ({
        ...current,
        status: 'planning',
        analysis,
        output: 'Analyse abgeschlossen. Der prüfbare Plan wird erstellt.',
      }))

      const planJob = await this.prepareManagedJob(projectId, operation, {
        projectId,
        adapterId: input.adapterId,
        prompt: planningPlanPrompt(objective, clarifications, analysis),
        role: 'planner',
        permission: 'read-only',
        model: input.model?.trim() || undefined,
        includeMemory: false,
        teamRunId: session.id,
        teamNodeId: 'plan',
        expectedProject: project,
      })
      const planResult = await this.checkedAwait(projectId, operation, 'read-only', () =>
        this.dependencies.executePreparedAgentJob(planJob.id, operation.ticket.signal)
      )
      operation.jobId = undefined
      const plan = parsePlanningPlan(planResult.output, { objective, analysis })
      this.assertOperation(projectId, operation, false)
      this.update(projectId, current => ({
        ...current,
        status: 'review',
        analysis,
        plan,
        error: '',
        output: `Plan mit ${plan.steps.length} Schritten ist zur Prüfung bereit.`,
      }))
    } catch (error) {
      this.failCurrentOperation(projectId, operation, error)
      throw error
    } finally {
      try {
        await resourceLease?.release()
      } finally {
        if (this.operations.get(projectId) === operation) this.operations.delete(projectId)
      }
    }
  }

  revise(projectId: string, input: PlanningPlan): void {
    if (this.operations.has(projectId))
      throw new Error('Eine laufende Planung oder Ausführung muss zuerst beendet werden.')
    const current = this.requireSession(projectId)
    const plan = validatePlanningPlan(input)
    if (current.revision >= Number.MAX_SAFE_INTEGER)
      throw new Error('Die Planrevision kann nicht weiter erhöht werden.')
    this.sessions.set(
      projectId,
      Object.freeze({
        ...current,
        revision: current.revision + 1,
        objective: plan.objective,
        status: 'review',
        analysis: plan.analysis,
        plan,
        execution: null,
        error: '',
        output: `Überarbeiteter Plan mit ${plan.steps.length} Schritten ist zur Prüfung bereit.`,
      })
    )
    this.notify()
  }

  async execute(projectId: string, input: PlanningExecuteInput): Promise<void> {
    const current = this.requireSession(projectId)
    if (this.operations.has(projectId) || ACTIVE_STATUSES.has(current.status)) {
      throw new Error('Für dieses Projekt läuft bereits eine Planung oder Ausführung.')
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== current.revision) {
      throw new Error('Der geprüfte Plan wurde inzwischen geändert. Bitte die aktuelle Revision erneut freigeben.')
    }
    if (input.expectedSessionId !== current.id) {
      throw new Error(
        'Die freigegebene Planungssitzung wurde inzwischen ersetzt. Bitte den aktuellen Plan erneut freigeben.'
      )
    }
    if (!current.plan) throw new Error('Es liegt kein validierter Plan zur Ausführung vor.')
    if (current.plan.analysis.openQuestions.length) {
      throw new Error('Offene Fragen müssen vor der Ausführung im geprüften Plan geklärt werden.')
    }
    this.validateAdapter(input.adapterId, input.model)
    if (!['read-only', 'workspace-write'].includes(input.permission)) throw new Error('Ungültige Ausführungsfreigabe.')
    if (input.permission === 'workspace-write' && input.adapterId !== 'codex') {
      throw new Error('Workspace-Schreibzugriff ist im Planungsmodus ausschließlich mit Codex möglich.')
    }
    if (input.adapterId === 'codex' && !current.project.rootPath) {
      throw new Error('Für die Codex-Ausführung muss dem Projekt ein lokaler Ordner zugeordnet sein.')
    }

    const reviewedPlan = validatePlanningPlan(current.plan, {
      objective: current.objective,
      analysis: current.analysis ?? undefined,
    })
    const operation = this.beginOperation(projectId)
    operation.project = current.project
    operation.sessionId = current.id
    this.update(projectId, session => ({ ...session, status: 'executing', execution: null, error: '', output: '' }))
    try {
      await this.scopeCheckpoint(projectId, operation, input.permission)
      this.assertRevision(projectId, operation, input.expectedRevision)
      const definition = createPlanningExecutionDefinition(current.id, current.revision, reviewedPlan, input)
      const run = this.dependencies.prepareAgentTeam(definition, {
        project: current.project,
        objective: `Geprüfte Planrevision ${current.revision} ausführen. Ziel: ${reviewedPlan.objective}`,
        approvalMode: 'team',
      })
      operation.teamRunId = run.id
      this.update(projectId, session => ({ ...session, execution: run }))
      this.assertOperation(projectId, operation, input.permission === 'workspace-write')
      this.assertRevision(projectId, operation, input.expectedRevision)
      if (!this.dependencies.approveAgentTeam(run.id)) {
        throw new Error('Das Agententeam konnte nicht aus der geprüften Revision gestartet werden.')
      }
      const terminal = await this.checkedAwait(projectId, operation, input.permission, () =>
        this.waitForTeam(run.id, operation.ticket.signal)
      )
      this.assertRevision(projectId, operation, input.expectedRevision)
      if (terminal.status !== 'completed') {
        throw new Error(`Planausführung beendet (${terminal.errorCode ?? terminal.status}).`)
      }
      const join = terminal.nodes.find(node => node.id === 'plan-final-join')
      this.update(projectId, session => ({
        ...session,
        status: 'completed',
        execution: terminal,
        error: '',
        output: [
          'Ausführung beendet. Das Abschlussreview und die ausgewiesenen Restgrenzen sind keine automatische Abnahme.',
          join?.output ?? '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      }))
    } catch (error) {
      this.failCurrentOperation(projectId, operation, error)
      throw error
    } finally {
      if (this.operations.get(projectId) === operation) this.operations.delete(projectId)
    }
  }

  cancel(projectId: string): void {
    this.stopOperation(projectId, 'cancelled')
  }

  interruptActive(): void {
    for (const projectId of [...this.operations.keys()]) this.stopOperation(projectId, 'interrupted')
  }

  clearAll(): void {
    for (const operation of this.operations.values()) {
      operation.controller.abort()
      if (operation.jobId) this.dependencies.cancelAgentJob(operation.jobId)
      if (operation.teamRunId) this.dependencies.cancelAgentTeam(operation.teamRunId)
    }
    this.operations.clear()
    if (!this.sessions.size) return
    this.sessions.clear()
    this.notify()
  }

  export(projectId: string): string {
    const current = this.requireSession(projectId)
    const normalized: PlanningSession = Object.freeze({
      ...current,
      status: current.plan ? 'review' : 'idle',
      execution: null,
      error: '',
      output: '',
    })
    const payload: PlanningExport = Object.freeze({
      version: PLANNING_EXPORT_VERSION,
      exportedAt: new Date(this.now()).toISOString(),
      session: normalized,
    })
    const json = JSON.stringify(payload, null, 2)
    if (json.length > MAX_PLANNING_IMPORT_CHARACTERS) throw new Error('Der Planungsstand ist zu groß für den Export.')
    return json
  }

  async restore(projectId: string, json: string): Promise<void> {
    if (this.operations.has(projectId))
      throw new Error('Eine laufende Planung oder Ausführung muss zuerst beendet werden.')
    const restored = this.validateExport(parsePlanningJson(json))
    if (restored.project.projectId !== projectId) throw new Error('Der Planungsimport gehört zu einem anderen Projekt.')
    const operation = this.beginOperation(projectId)
    try {
      this.assertOperation(projectId, operation, false)
      const project = await this.dependencies.projectSnapshot(projectId)
      this.assertOperation(projectId, operation, false)
      this.assertProjectSnapshot(projectId, project)
      operation.project = project
      await this.scopeCheckpoint(projectId, operation, 'read-only')
      if (!sameProject(restored.project, project)) {
        throw new PlanningInterruptedError('Der Planungsimport gehört nicht zum aktuellen Konto oder Workspace.')
      }
      this.sessions.set(
        projectId,
        Object.freeze({
          ...restored,
          id: this.newSessionId(),
          revision: restored.revision + 1,
          project: Object.freeze({ ...project }),
          status: restored.plan ? 'review' : 'idle',
          execution: null,
          error: '',
          output: '',
        })
      )
      this.notify()
    } catch (error) {
      throw error
    } finally {
      if (this.operations.get(projectId) === operation) this.operations.delete(projectId)
    }
  }

  dispose(): void {
    this.clearAll()
    this.stopTeamSubscription()
    this.listeners.clear()
  }

  private beginOperation(projectId: string): ActiveOperation {
    if (
      projectId !== projectId.trim() ||
      !projectId ||
      projectId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(projectId)
    ) {
      throw new Error('Ungültige Projekt-ID.')
    }
    if (this.operations.has(projectId))
      throw new Error('Für dieses Projekt läuft bereits eine Planung oder Ausführung.')
    const controller = new AbortController()
    const operation: ActiveOperation = {
      controller,
      ticket: this.dependencies.captureExecution(controller.signal),
    }
    this.operations.set(projectId, operation)
    return operation
  }

  private stopOperation(projectId: string, status: 'cancelled' | 'interrupted'): void {
    const operation = this.operations.get(projectId)
    if (!operation) return
    this.operations.delete(projectId)
    operation.controller.abort()
    if (operation.jobId) this.dependencies.cancelAgentJob(operation.jobId)
    if (operation.teamRunId) this.dependencies.cancelAgentTeam(operation.teamRunId)
    const session = this.sessions.get(projectId)
    if (session && ACTIVE_STATUSES.has(session.status)) {
      const execution = operation.teamRunId
        ? (this.dependencies.getAgentTeam(operation.teamRunId) ?? session.execution)
        : session.execution
      this.sessions.set(
        projectId,
        Object.freeze({
          ...session,
          status,
          execution,
          error:
            status === 'cancelled' ? 'Planung abgebrochen.' : 'Planung durch Scope- oder Moduswechsel unterbrochen.',
        })
      )
      this.notify()
    }
  }

  private assertOperation(projectId: string, operation: ActiveOperation, mutating: boolean): void {
    if (this.operations.get(projectId) !== operation || operation.controller.signal.aborted) throw abortError()
    try {
      this.dependencies.assertExecution(operation.ticket, mutating)
    } catch (error) {
      throw new PlanningInterruptedError(errorMessage(error))
    }
  }

  private async scopeCheckpoint(
    projectId: string,
    operation: ActiveOperation,
    permission: AgentPermission
  ): Promise<void> {
    this.assertOperation(projectId, operation, permission === 'workspace-write')
    if (!operation.project) throw new PlanningInterruptedError('Projekt-Snapshot fehlt.')
    try {
      await this.dependencies.validateScope(operation.project, permission)
    } catch (error) {
      throw new PlanningInterruptedError(errorMessage(error))
    }
    this.assertOperation(projectId, operation, permission === 'workspace-write')
  }

  private async checkedAwait<T>(
    projectId: string,
    operation: ActiveOperation,
    permission: AgentPermission,
    invoke: () => Promise<T>
  ): Promise<T> {
    await this.scopeCheckpoint(projectId, operation, permission)
    const result = await invoke()
    this.assertOperation(projectId, operation, permission === 'workspace-write')
    await this.scopeCheckpoint(projectId, operation, permission)
    return result
  }

  private async prepareManagedJob(
    projectId: string,
    operation: ActiveOperation,
    input: PlanningPreparedJobInput
  ): Promise<Pick<AgentJob, 'id'>> {
    await this.scopeCheckpoint(projectId, operation, 'read-only')
    const job = await this.dependencies.prepareAgentJob(input)
    operation.jobId = job.id
    try {
      this.assertOperation(projectId, operation, false)
      await this.scopeCheckpoint(projectId, operation, 'read-only')
      return job
    } catch (error) {
      this.dependencies.cancelAgentJob(job.id)
      operation.jobId = undefined
      throw error
    }
  }

  private assertRevision(projectId: string, operation: ActiveOperation, revision: number): void {
    this.assertOperation(projectId, operation, false)
    const session = this.requireSession(projectId)
    if (session.id !== operation.sessionId || session.revision !== revision) {
      throw new PlanningInterruptedError('Die freigegebene Planrevision ist nicht mehr aktuell.')
    }
  }

  private failCurrentOperation(projectId: string, operation: ActiveOperation, error: unknown): void {
    if (this.operations.get(projectId) !== operation) return
    const interrupted = error instanceof PlanningInterruptedError || operation.ticket.signal.aborted
    operation.controller.abort()
    if (operation.jobId) this.dependencies.cancelAgentJob(operation.jobId)
    if (operation.teamRunId) this.dependencies.cancelAgentTeam(operation.teamRunId)
    const session = this.sessions.get(projectId)
    if (!session) return
    const execution = operation.teamRunId
      ? (this.dependencies.getAgentTeam(operation.teamRunId) ?? session.execution)
      : session.execution
    this.sessions.set(
      projectId,
      Object.freeze({
        ...session,
        status: interrupted ? 'interrupted' : 'failed',
        execution,
        error: interrupted ? 'Planung durch Scope- oder Moduswechsel unterbrochen.' : errorMessage(error),
      })
    )
    this.notify()
  }

  private waitForTeam(runId: string, signal: AbortSignal): Promise<AgentTeamRun> {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {}
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        unsubscribe()
        signal.removeEventListener('abort', onAbort)
        callback()
      }
      const inspect = () => {
        const run = this.dependencies.getAgentTeam(runId)
        if (!run) {
          finish(() => reject(new PlanningInterruptedError('Der Agententeamlauf ist nicht mehr verfügbar.')))
          return
        }
        if (!TEAM_TERMINAL.has(run.status)) return
        finish(() => resolve(run))
      }
      const onAbort = () => finish(() => reject(abortError()))
      unsubscribe = this.dependencies.subscribeAgentTeams(() => queueMicrotask(inspect))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      inspect()
    })
  }

  private syncTeamSnapshots(): void {
    let changed = false
    for (const [projectId, session] of this.sessions) {
      if (!session.execution) continue
      const current = this.dependencies.getAgentTeam(session.execution.id)
      if (!current || current === session.execution) continue
      this.sessions.set(projectId, Object.freeze({ ...session, execution: current }))
      changed = true
    }
    if (changed) this.notify()
  }

  private update(projectId: string, updater: (session: PlanningSession) => PlanningSession): void {
    const current = this.requireSession(projectId)
    this.sessions.set(projectId, Object.freeze(updater(current)))
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // UI observers cannot alter planning state.
      }
    }
  }

  private requireSession(projectId: string): PlanningSession {
    const session = this.sessions.get(projectId)
    if (!session) throw new Error('Für dieses Projekt besteht keine Planungssitzung.')
    return session
  }

  private assertProjectSnapshot(projectId: string, project: AgentProjectSnapshot): void {
    if (
      project.projectId !== projectId ||
      !project.principalId ||
      !project.projectName ||
      (project.rootPath !== undefined && !project.rootPath)
    ) {
      throw new PlanningInterruptedError('Der Projekt-Snapshot entspricht nicht dem angeforderten Projekt.')
    }
  }

  private validateAdapter(adapterId: PlanningAdapterId, model?: string): void {
    if (!['codex', 'local', 'policy'].includes(adapterId)) throw new Error('Ungültiger Planungsagent.')
    if (model !== undefined && (!model.trim() || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model))) {
      throw new Error('Ungültige Modell-ID.')
    }
    if (model?.trim() && adapterId !== 'codex') {
      throw new Error('Lokale und richtliniengesteuerte Modelle wählen ihr signiertes Modellprofil selbst.')
    }
  }

  private newSessionId(): string {
    const id = this.createId()
    if (
      typeof id !== 'string' ||
      !id ||
      id.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(id) ||
      [...this.sessions.values()].some(session => session.id === id)
    ) {
      throw new Error('Es konnte keine eindeutige Planungssitzung erstellt werden.')
    }
    return id
  }

  private validateExport(value: unknown): PlanningSession {
    const envelope = exactRecord(value, 'Planungsimport', ['version', 'exportedAt', 'session'])
    if (Reflect.get(envelope, 'version') !== PLANNING_EXPORT_VERSION) {
      throw new Error('Die Version des Planungsimports wird nicht unterstützt.')
    }
    const exportedAt = Reflect.get(envelope, 'exportedAt')
    if (typeof exportedAt !== 'string' || !Number.isFinite(Date.parse(exportedAt))) {
      throw new Error('Der Planungsimport besitzt keinen gültigen Exportzeitpunkt.')
    }
    const source = exactRecord(Reflect.get(envelope, 'session'), 'Planungsimport.session', SESSION_KEYS)
    const projectSource = Reflect.get(source, 'project')
    if (!projectSource || typeof projectSource !== 'object' || Array.isArray(projectSource)) {
      throw new Error('Planungsimport.session.project muss ein Objekt sein.')
    }
    const projectRecord = projectSource as Record<string, unknown>
    const projectKeys = Object.keys(projectRecord)
    if (
      PROJECT_REQUIRED_KEYS.some(key => !Object.prototype.hasOwnProperty.call(projectRecord, key)) ||
      projectKeys.some(key => !new Set<string>([...PROJECT_REQUIRED_KEYS, ...PROJECT_OPTIONAL_KEYS]).has(key))
    ) {
      throw new Error('Planungsimport.session.project enthält fehlende oder unbekannte Felder.')
    }
    const principalId = Reflect.get(projectRecord, 'principalId')
    const importedProjectId = Reflect.get(projectRecord, 'projectId')
    const projectName = Reflect.get(projectRecord, 'projectName')
    const rootPath = Reflect.get(projectRecord, 'rootPath')
    const workspaceUpdatedAt = Reflect.get(projectRecord, 'workspaceUpdatedAt')
    if (
      typeof principalId !== 'string' ||
      !principalId ||
      principalId.length > 256 ||
      typeof importedProjectId !== 'string' ||
      !importedProjectId ||
      importedProjectId.length > 256 ||
      typeof projectName !== 'string' ||
      projectName.length > 512 ||
      (rootPath !== undefined && (typeof rootPath !== 'string' || !rootPath || rootPath.length > 4_096)) ||
      (workspaceUpdatedAt !== undefined &&
        (typeof workspaceUpdatedAt !== 'number' || !Number.isSafeInteger(workspaceUpdatedAt) || workspaceUpdatedAt < 0))
    ) {
      throw new Error('Planungsimport.session.project ist ungültig.')
    }
    const project: AgentProjectSnapshot = Object.freeze({
      principalId,
      projectId: importedProjectId,
      projectName,
      rootPath: rootPath as string | undefined,
      workspaceUpdatedAt: workspaceUpdatedAt as number | undefined,
    })
    const id = Reflect.get(source, 'id')
    const revision = Reflect.get(source, 'revision')
    const status = Reflect.get(source, 'status')
    const execution = Reflect.get(source, 'execution')
    const error = Reflect.get(source, 'error')
    const output = Reflect.get(source, 'output')
    if (typeof id !== 'string' || !id || id.length > 128 || /[\u0000-\u001f\u007f]/u.test(id)) {
      throw new Error('Planungsimport.session.id ist ungültig.')
    }
    if (!Number.isSafeInteger(revision) || Number(revision) < 1 || Number(revision) >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Planungsimport.session.revision ist ungültig.')
    }
    if (!['idle', 'review'].includes(String(status)) || execution !== null || error !== '' || output !== '') {
      throw new Error('Aktiver oder ausführbarer Laufzeitstatus darf nicht importiert werden.')
    }
    const objective = normalizePlanningObjective(Reflect.get(source, 'objective'))
    const rawAnalysis = Reflect.get(source, 'analysis')
    const analysis = rawAnalysis === null ? null : validatePlanningAnalysis(rawAnalysis)
    const rawPlan = Reflect.get(source, 'plan')
    const plan = rawPlan === null ? null : validatePlanningPlan(rawPlan, { objective, analysis: analysis ?? undefined })
    if ((plan && !analysis) || (status === 'review' && !plan) || (status === 'idle' && plan)) {
      throw new Error('Planungsimport.session besitzt einen widersprüchlichen Reviewstatus.')
    }
    return Object.freeze({
      id,
      revision: Number(revision),
      project,
      objective,
      status: status as PlanningSessionStatus,
      analysis,
      plan,
      execution: null,
      error: '',
      output: '',
    })
  }
}

export function createPlanningHub(dependencies: PlanningControllerDependencies): PlanningController {
  return new PlanningController(dependencies)
}
