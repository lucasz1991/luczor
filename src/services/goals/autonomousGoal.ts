/** Device-local goal scheduling. The run adapter owns chat/tool execution and evidence verification. */
export type GoalRunState = {
  text: string
  active: boolean
  status: 'idle' | 'running' | 'checking' | 'waiting' | 'blocked' | 'completed'
  revision: number
  iterations: number
  phase: 'work' | 'review'
  lastMessageId?: string
  progress?: string
  evidence?: string
  reason?: string
  updatedAt: number
  stagnantIterations?: number
  consecutiveErrors?: number
  lastFingerprint?: string
}

export type GoalStepResult = {
  status: 'continue' | 'candidate' | 'completed' | 'blocked'
  summary: string
  evidence?: string
  messageId?: string
  fingerprint?: string
}

export type AutonomousGoalDependencies = {
  read(projectId: string): GoalRunState | undefined
  /** Atomically compare the current revision before applying/persisting the next state. */
  persist(projectId: string, next: GoalRunState, expectedRevision: number): boolean | Promise<boolean>
  run(projectId: string, goal: Readonly<GoalRunState>, signal: AbortSignal): Promise<GoalStepResult>
  canRun(projectId: string): boolean
  now?: () => number
  schedule?: (callback: () => void, milliseconds: number) => () => void
  onPersistenceError?: (projectId: string, error: unknown) => void
}

export function createGoalRunState(text: string, active = false, now = Date.now()): GoalRunState {
  const goal = text.trim()
  if (goal.length > 20000) throw new Error('Das Ziel darf höchstens 20.000 Zeichen enthalten. Es wurde nichts gekürzt.')
  return {
    text: goal,
    active: active && goal.length > 0,
    status: active && goal.length > 0 ? 'waiting' : 'idle',
    revision: 1,
    iterations: 0,
    phase: 'work',
    updatedAt: now,
  }
}

const compact = (value: string | undefined, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

/** No timers, jobs, approval tokens, or server schedules are stored with a goal. */
export function createAutonomousGoalController(dependencies: AutonomousGoalDependencies) {
  const now = dependencies.now ?? Date.now
  const schedule =
    dependencies.schedule ??
    ((callback: () => void, milliseconds: number) => {
      const timer = setTimeout(callback, milliseconds)
      return () => clearTimeout(timer)
    })
  const suspended = new Set<string>()
  let selected: string | undefined
  let pendingTimer: (() => void) | undefined
  let running: { projectId: string; controller: AbortController } | undefined
  let disposed = false
  let driving = false

  const cancelTimer = () => {
    pendingTimer?.()
    pendingTimer = undefined
  }

  async function write(
    projectId: string,
    previous: GoalRunState,
    patch: Partial<GoalRunState>
  ): Promise<GoalRunState | undefined> {
    if (dependencies.read(projectId)?.revision !== previous.revision) return undefined
    const next = { ...previous, ...patch, revision: previous.revision + 1, updatedAt: now() }
    return (await dependencies.persist(projectId, next, previous.revision)) ? next : undefined
  }

  function arrange(milliseconds = 250) {
    cancelTimer()
    if (disposed || !selected || suspended.has(selected) || !dependencies.read(selected)?.active) return
    pendingTimer = schedule(() => {
      pendingTimer = undefined
      void drive()
    }, milliseconds)
  }

  async function parkInterrupted(projectId: string, attempt: GoalRunState) {
    await write(projectId, attempt, {
      status: 'waiting',
      // A fresh work round must re-read state; interrupted tools are never replayed by this scheduler.
      phase: 'work',
      reason: 'Unterbrochen. Der nächste Abschnitt prüft zuerst den aktuellen Projektstand.',
    })
  }

  async function drive(): Promise<void> {
    if (disposed || driving || !selected || suspended.has(selected)) return
    const projectId = selected
    let delay = 250
    driving = true
    try {
      let goal = dependencies.read(projectId)
      if (!goal?.active || !goal.text.trim()) return
      // A process cannot be resumed from persisted UI state. Never replay the previous tool round.
      if (goal.status === 'running' || goal.status === 'checking') {
        goal = await write(projectId, goal, {
          status: 'waiting',
          phase: 'work',
          reason: 'Fortsetzung nach Unterbrechung: Projektstand und bisherige Ergebnisse neu prüfen.',
        })
        if (!goal) return
      }
      if (goal.status === 'completed' || goal.status === 'blocked') {
        await write(projectId, goal, { active: false })
        return
      }
      if (!dependencies.canRun(projectId)) {
        if (goal.status !== 'waiting')
          await write(projectId, goal, {
            status: 'waiting',
            reason: 'Wartet auf den Abschluss des aktuellen Auftrags.',
          })
        delay = 1000
        return
      }
      const attempt = await write(projectId, goal, {
        status: goal.phase === 'review' ? 'checking' : 'running',
        iterations: goal.iterations + 1,
        reason: undefined,
      })
      if (
        !attempt ||
        disposed ||
        selected !== projectId ||
        suspended.has(projectId) ||
        dependencies.read(projectId)?.revision !== attempt.revision
      )
        return
      if (!dependencies.canRun(projectId)) {
        await parkInterrupted(projectId, attempt)
        delay = 1000
        return
      }
      const controller = new AbortController()
      running = { projectId, controller }
      let result: GoalStepResult
      try {
        result = await dependencies.run(projectId, Object.freeze({ ...attempt }), controller.signal)
        if (
          !result ||
          !['continue', 'candidate', 'completed', 'blocked'].includes(result.status) ||
          typeof result.summary !== 'string'
        ) {
          throw new Error('Ungültiges Ergebnis des Zielabschnitts.')
        }
      } catch {
        if (controller.signal.aborted || disposed || selected !== projectId || suspended.has(projectId)) {
          if (!disposed) await parkInterrupted(projectId, attempt)
          return
        }
        const failures = (attempt.consecutiveErrors ?? 0) + 1
        await write(projectId, attempt, {
          consecutiveErrors: failures,
          active: failures < 3,
          status: failures >= 3 ? 'blocked' : 'waiting',
          reason:
            failures >= 3
              ? 'Drei aufeinanderfolgende Versuche sind fehlgeschlagen. Ziel bleibt offen; Verbindung oder Modell prüfen.'
              : 'Der Arbeitsabschnitt konnte nicht abgeschlossen werden. Ein begrenzter neuer Versuch folgt.',
        })
        delay = failures === 1 ? 1000 : 3000
        return
      } finally {
        running = undefined
      }
      if (controller.signal.aborted || disposed || selected !== projectId || suspended.has(projectId)) {
        if (!disposed) await parkInterrupted(projectId, attempt)
        return
      }
      if (dependencies.read(projectId)?.revision !== attempt.revision) return
      const summary = compact(result.summary, 4000)
      const evidence = compact(result.evidence, 8000)
      const fingerprint = compact(result.fingerprint, 1000) || summary.replace(/\s+/gu, ' ')
      const unchanged = fingerprint === (attempt.lastFingerprint ?? '')
      const stagnant = unchanged ? (attempt.stagnantIterations ?? 0) + 1 : 1
      const common: Partial<GoalRunState> = {
        progress: summary,
        lastMessageId: compact(result.messageId, 200) || attempt.lastMessageId,
        lastFingerprint: fingerprint,
        stagnantIterations: stagnant,
        consecutiveErrors: 0,
      }
      if (attempt.phase === 'review' && result.status === 'completed' && evidence) {
        await write(projectId, attempt, {
          ...common,
          active: false,
          status: 'completed',
          evidence,
          reason: 'Ziel durch Ergebnisprüfung mit Nachweis abgeschlossen.',
        })
      } else if (result.status === 'blocked' || stagnant >= 3) {
        await write(projectId, attempt, {
          ...common,
          active: false,
          status: 'blocked',
          reason:
            result.status === 'blocked'
              ? summary || 'Der Auftrag benötigt eine Klärung, bevor er fortgesetzt werden kann.'
              : 'Drei Abschnitte ohne erkennbaren Fortschritt. Ziel bleibt offen; Auftrag oder Voraussetzungen prüfen.',
        })
      } else {
        const review = attempt.phase === 'work' && (result.status === 'candidate' || result.status === 'completed')
        await write(projectId, attempt, {
          ...common,
          status: 'waiting',
          phase: review ? 'review' : 'work',
          evidence: undefined,
          reason: review
            ? 'Ergebnis liegt vor und wird vor dem Abschluss geprüft.'
            : result.status === 'completed'
              ? 'Ein prüfbarer Erfolgsnachweis fehlt. Ziel bleibt offen.'
              : undefined,
        })
      }
    } catch (error) {
      // Repeated writes cannot repair unavailable persistence. Require a deliberate kick after recovery.
      suspended.add(projectId)
      dependencies.onPersistenceError?.(projectId, error)
    } finally {
      driving = false
      arrange(delay)
    }
  }

  async function interrupt(
    projectId: string,
    reason = 'Deine neue Nachricht hat Vorrang. Das Ziel bleibt offen.'
  ): Promise<void> {
    suspended.add(projectId)
    if (selected === projectId) cancelTimer()
    if (running?.projectId === projectId) running.controller.abort(reason)
    const goal = dependencies.read(projectId)
    if (goal && goal.status !== 'completed') await write(projectId, goal, { status: 'waiting', phase: 'work', reason })
  }

  return {
    /** Call after user work finishes or explicitly (re)activating a goal. */
    kick(projectId: string): void {
      if (disposed) return
      if (selected !== projectId && running) running.controller.abort('Anderes Projekt ausgewählt.')
      selected = projectId
      suspended.delete(projectId)
      if (!driving) arrange(0)
    },
    interrupt,
    async stop(projectId: string, reason = 'Ziel pausiert. Der bisherige Fortschritt bleibt erhalten.'): Promise<void> {
      suspended.add(projectId)
      if (selected === projectId) cancelTimer()
      if (running?.projectId === projectId) running.controller.abort(reason)
      const goal = dependencies.read(projectId)
      if (goal && goal.status !== 'completed')
        await write(projectId, goal, { active: false, status: 'waiting', phase: 'work', reason })
    },
    dispose(): void {
      disposed = true
      cancelTimer()
      running?.controller.abort('Zielsteuerung beendet.')
      selected = undefined
    },
  }
}
