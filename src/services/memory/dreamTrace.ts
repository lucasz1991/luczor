import { shallowRef } from 'vue'

/**
 * Session-local, bounded trace of idle memory maintenance ("dreaming").
 * It records which sources a run read, which decisions the model proposed and
 * what was committed, so the knowledge-space view can animate the process.
 * Only identifiers, short labels and reasons are kept – never full memory text.
 */
export type DreamStage =
  'scanning' | 'selecting' | 'preparing' | 'generating' | 'verifying' | 'committing' | 'done' | 'failed' | 'interrupted'

export type DreamOperation = 'read' | 'keep' | 'rewrite' | 'merge' | 'conflict' | 'remove' | 'create' | 'artifact'

export type DreamTarget = { kind: 'memory' | 'file' | 'artifact' | 'source'; id: string; label?: string }

export type DreamDecision = {
  at: number
  op: DreamOperation
  targets: DreamTarget[]
  reason?: string
}

export type DreamStep = { at: number; stage: DreamStage; title: string; detail?: string }

export type DreamRun = {
  id: string
  startedAt: number
  endedAt?: number
  jobKey: string
  task: 'context' | 'memory' | 'repository' | 'evaluation' | 'shared'
  scope: 'user' | 'project'
  projectId?: string
  modelId?: string
  steps: DreamStep[]
  decisions: DreamDecision[]
  outcome?: 'success' | 'failed' | 'interrupted'
  error?: string
}

export type DreamTrace = {
  /** The run currently in progress, or null while the worker sleeps. */
  current: DreamRun | null
  /** Most recent finished runs, newest first. */
  history: DreamRun[]
  /** Why the last eligibility check declined to dream (changes only). */
  lastSkip: { at: number; reason: string } | null
  /** Bounded scan summary from the last work-list pass. */
  scan: { at: number; work: number; queued: number; blocked: number; waitingForGate: number } | null
  /** Emergency offload state: RAM is below the normal reserve and the pass leans on the page file. */
  offload: { at: number; active: boolean; freeRamMiB: number; swapFreeMiB: number } | null
}

const MAX_HISTORY = 12
const MAX_STEPS = 60
const MAX_DECISIONS = 120
const MAX_LABEL = 72

const empty = (): DreamTrace => ({ current: null, history: [], lastSkip: null, scan: null, offload: null })

export const dreamTrace = shallowRef<DreamTrace>(empty())

if (typeof window !== 'undefined')
  window.addEventListener('luczor:api-identity-changing', () => {
    dreamTrace.value = empty()
  })

const patch = (changes: Partial<DreamTrace>) => {
  dreamTrace.value = { ...dreamTrace.value, ...changes }
}

const label = (value: string | undefined) => (value ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL) : undefined)

export function dreamTargetLabel(target: DreamTarget): string {
  return target.label ?? target.id
}

/** Eligibility declined; only reason changes are recorded so polling stays quiet. */
export function recordDreamSkip(reason: string): void {
  const last = dreamTrace.value.lastSkip
  if (last?.reason === reason) return
  patch({ lastSkip: { at: Date.now(), reason } })
}

export function recordDreamScan(scan: Omit<NonNullable<DreamTrace['scan']>, 'at'>): void {
  patch({ scan: { at: Date.now(), ...scan } })
}

export function recordDreamOffload(state: Omit<NonNullable<DreamTrace['offload']>, 'at'>): void {
  const last = dreamTrace.value.offload
  if (last && last.active === state.active && !state.active) return
  patch({ offload: { at: Date.now(), ...state } })
}

export function beginDreamRun(input: {
  jobKey: string
  task: DreamRun['task']
  scope: DreamRun['scope']
  projectId?: string
  sources: DreamTarget[]
  reason?: string
}): void {
  const now = Date.now()
  const stale = dreamTrace.value.current
  const history = stale
    ? [{ ...stale, endedAt: now, outcome: 'interrupted' as const }, ...dreamTrace.value.history]
    : dreamTrace.value.history
  const run: DreamRun = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    startedAt: now,
    jobKey: input.jobKey,
    task: input.task,
    scope: input.scope,
    projectId: input.projectId,
    steps: [
      ...(dreamTrace.value.scan && now - dreamTrace.value.scan.at < 120_000
        ? [
            {
              at: dreamTrace.value.scan.at,
              stage: 'scanning' as const,
              title: 'Quellen gesichtet',
              detail: `${dreamTrace.value.scan.work} Aufträge · ${dreamTrace.value.scan.queued} wartend · ${dreamTrace.value.scan.blocked} blockiert`,
            },
          ]
        : []),
      ...(dreamTrace.value.offload?.active
        ? [
            {
              at: dreamTrace.value.offload.at,
              stage: 'preparing' as const,
              title: 'Notfall-Auslagerung',
              detail: `RAM ${dreamTrace.value.offload.freeRamMiB} MiB frei · Auslagerungsdatei ${dreamTrace.value.offload.swapFreeMiB} MiB frei · langsamer`,
            },
          ]
        : []),
      { at: now, stage: 'selecting', title: 'Auftrag gewählt', detail: label(input.reason) },
    ],
    decisions: input.sources.length
      ? [
          {
            at: now,
            op: 'read',
            targets: input.sources.map(target => ({ ...target, label: label(target.label) })),
            reason: 'Quellen werden gelesen',
          },
        ]
      : [],
  }
  patch({ current: run, history: history.slice(0, MAX_HISTORY), lastSkip: null })
}

export function recordDreamStep(stage: DreamStage, title: string, detail?: string): void {
  const run = dreamTrace.value.current
  if (!run) return
  patch({
    current: {
      ...run,
      steps: [...run.steps, { at: Date.now(), stage, title, detail: label(detail) }].slice(-MAX_STEPS),
    },
  })
}

export function recordDreamModel(modelId: string): void {
  const run = dreamTrace.value.current
  if (!run) return
  patch({ current: { ...run, modelId } })
}

export function recordDreamDecision(op: DreamOperation, targets: DreamTarget[], reason?: string): void {
  const run = dreamTrace.value.current
  if (!run) return
  patch({
    current: {
      ...run,
      decisions: [
        ...run.decisions,
        {
          at: Date.now(),
          op,
          targets: targets.map(target => ({ ...target, label: label(target.label) })),
          reason: label(reason),
        },
      ].slice(-MAX_DECISIONS),
    },
  })
}

export function endDreamRun(outcome: NonNullable<DreamRun['outcome']>, error?: string): void {
  const run = dreamTrace.value.current
  if (!run) return
  const now = Date.now()
  const stage: DreamStage = outcome === 'success' ? 'done' : outcome === 'failed' ? 'failed' : 'interrupted'
  const finalStep: DreamStep = {
    at: now,
    stage,
    title: outcome === 'success' ? 'Abgeschlossen' : outcome === 'failed' ? 'Verworfen' : 'Unterbrochen',
    detail: label(error),
  }
  const finished: DreamRun = {
    ...run,
    endedAt: now,
    outcome,
    error: label(error),
    steps: [...run.steps, finalStep].slice(-MAX_STEPS),
  }
  patch({ current: null, history: [finished, ...dreamTrace.value.history].slice(0, MAX_HISTORY) })
}

/** Node-level effects the 3D view animates; the newest run wins. */
export function dreamEffects(trace: DreamTrace): {
  active: boolean
  run: DreamRun | null
  reading: Set<string>
  removing: Set<string>
  conflicts: Set<string>
  touched: Set<string>
} {
  const run = trace.current ?? trace.history[0] ?? null
  const reading = new Set<string>()
  const removing = new Set<string>()
  const conflicts = new Set<string>()
  const touched = new Set<string>()
  if (run) {
    const recent = !run.endedAt || Date.now() - run.endedAt < 15_000
    for (const decision of run.decisions) {
      for (const target of decision.targets) {
        const id = dreamNodeId(target)
        if (!recent) continue
        touched.add(id)
        if (decision.op === 'read' && !run.endedAt) reading.add(id)
        if (decision.op === 'remove') removing.add(id)
        if (decision.op === 'conflict') conflicts.add(id)
      }
    }
  }
  return { active: !!trace.current, run, reading, removing, conflicts, touched }
}

/** Maps a trace target to the id scheme used by buildMemoryGraph(). */
export function dreamNodeId(target: DreamTarget): string {
  if (target.kind === 'memory') return `memory:${target.id}`
  if (target.kind === 'file') return `file:${target.id}`
  if (target.kind === 'artifact') return `artifact:${target.id}`
  return `source:${target.id}`
}

export const DREAM_STAGE_LABELS: Record<DreamStage, string> = {
  scanning: 'Quellen sichten',
  selecting: 'Auftrag wählen',
  preparing: 'Modell vorbereiten',
  generating: 'Entwurf erzeugen',
  verifying: 'Gegenprüfung',
  committing: 'Übernehmen',
  done: 'Abgeschlossen',
  failed: 'Verworfen',
  interrupted: 'Unterbrochen',
}

export const DREAM_OPERATION_LABELS: Record<DreamOperation, string> = {
  read: 'gelesen',
  keep: 'behalten',
  rewrite: 'umgeschrieben',
  merge: 'zusammengeführt',
  conflict: 'Konflikt markiert',
  remove: 'entfernt',
  create: 'erzeugt',
  artifact: 'Kontextpaket',
}

export const DREAM_SKIP_LABELS: Record<string, string> = {
  native_required: 'Nur in der Desktop-App verfügbar',
  disabled: 'Idle-Optimierung ist ausgeschaltet',
  foreground: 'Vordergrundarbeit hat Vorrang',
  scope_unavailable: 'Kein verifiziertes Konto oder Modellprofil',
  memory_disabled: 'Automatisches Erinnern ist ausgeschaltet',
  runtime_unavailable: 'Lokales Modell nicht bereit',
  resource_switch: 'Ressourcenwechsel läuft',
  memory_pressure: 'Zu wenig freier Arbeitsspeicher – auch für die Notfall-Auslagerung',
  no_swap: 'Keine Auslagerungsdatei verfügbar – Notfall-Auslagerung nicht möglich',
  cpu_pressure: 'CPU ist ausgelastet',
  boundary_changed: 'Konto, Projekt oder Sitzung haben gewechselt',
  model_start_consent_required: 'Modellstart im Leerlauf braucht Zustimmung',
  manual_requested: 'Manuell angefordert',
  no_work: 'Nichts zu pflegen',
}

export function resetDreamTraceForTests(): void {
  dreamTrace.value = empty()
}
