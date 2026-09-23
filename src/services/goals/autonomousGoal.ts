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
  /** Set only by the run adapter after an independent inline review with successful evidence reads. */
  reviewVerified?: boolean
}

export type AttachedGoalRun = (goal: Readonly<GoalRunState>, signal: AbortSignal) => Promise<GoalStepResult>

export type AutonomousGoalDependencies = {
  read(projectId: string): GoalRunState | undefined
  /** Atomically compare the current revision before applying/persisting the next state. */
  persist(projectId: string, next: GoalRunState, expectedRevision: number): boolean | Promise<boolean>
  run(projectId: string, goal: Readonly<GoalRunState>, signal: AbortSignal): Promise<GoalStepResult>
  canRun(projectId: string): boolean
  now?: () => number
  schedule?: (callback: () => void, milliseconds: number) => () => void
  onPersistenceError?: (projectId: string, error: unknown) => void
  /** Upper bound of goal sections executing at the same time (default 3). */
  maxConcurrent?: number
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

/**
 * No timers, jobs, approval tokens, or server schedules are stored with a goal.
 * Every id (a chat) drives independently, so several chats can pursue their own
 * goals side by side; `maxConcurrent` bounds how many sections run at once.
 */
export function createAutonomousGoalController(dependencies: AutonomousGoalDependencies) {
  const now = dependencies.now ?? Date.now
  const schedule =
    dependencies.schedule ??
    ((callback: () => void, milliseconds: number) => {
      const timer = setTimeout(callback, milliseconds)
      return () => clearTimeout(timer)
    })
  const maxConcurrent = Math.max(1, dependencies.maxConcurrent ?? 3)
  type Driver = {
    pendingTimer?: () => void
    driving: boolean
    settled?: Promise<void>
    running?: { controller: AbortController; settled: Promise<void> }
  }
  const drivers = new Map<string, Driver>()
  const suspended = new Set<string>()
  let disposed = false

  const driver = (id: string): Driver => {
    let entry = drivers.get(id)
    if (!entry) {
      entry = { driving: false }
      drivers.set(id, entry)
    }
    return entry
  }
  const cancelTimer = (id: string) => {
    const entry = drivers.get(id)
    entry?.pendingTimer?.()
    if (entry) entry.pendingTimer = undefined
  }
  const runningCount = () => [...drivers.values()].filter(entry => entry.running).length

  async function write(
    id: string,
    previous: GoalRunState,
    patch: Partial<GoalRunState>
  ): Promise<GoalRunState | undefined> {
    if (dependencies.read(id)?.revision !== previous.revision) return undefined
    const next = { ...previous, ...patch, revision: previous.revision + 1, updatedAt: now() }
    return (await dependencies.persist(id, next, previous.revision)) ? next : undefined
  }

  function arrange(id: string, milliseconds = 250) {
    cancelTimer(id)
    if (disposed || suspended.has(id) || !dependencies.read(id)?.active) return
    const entry = driver(id)
    entry.pendingTimer = schedule(() => {
      entry.pendingTimer = undefined
      void drive(id)
    }, milliseconds)
  }

  async function parkInterrupted(id: string, attempt: GoalRunState) {
    await write(id, attempt, {
      status: 'waiting',
      // A fresh work round must re-read state; interrupted tools are never replayed by this scheduler.
      phase: 'work',
      reason: 'Unterbrochen. Der nächste Abschnitt prüft zuerst den aktuellen Projektstand.',
    })
  }

  async function drive(id: string, attachedRun?: AttachedGoalRun): Promise<void> {
    const entry = driver(id)
    if (disposed || entry.driving || suspended.has(id)) return
    let delay = 250
    entry.driving = true
    let markSettled!: () => void
    entry.settled = new Promise<void>(resolve => {
      markSettled = resolve
    })
    try {
      let goal = dependencies.read(id)
      if (!goal?.active || !goal.text.trim()) return
      // A process cannot be resumed from persisted UI state. Never replay the previous tool round.
      if (goal.status === 'running' || goal.status === 'checking') {
        goal = await write(id, goal, {
          status: 'waiting',
          phase: 'work',
          reason: 'Fortsetzung nach Unterbrechung: Projektstand und bisherige Ergebnisse neu prüfen.',
        })
        if (!goal) return
      }
      if (goal.status === 'completed' || goal.status === 'blocked') {
        await write(id, goal, { active: false })
        return
      }
      if (!attachedRun && (!dependencies.canRun(id) || runningCount() >= maxConcurrent)) {
        if (goal.status !== 'waiting')
          await write(id, goal, {
            status: 'waiting',
            reason: 'Wartet auf den Abschluss des aktuellen Auftrags.',
          })
        delay = 1000
        return
      }
      const attempt = await write(id, goal, {
        status: goal.phase === 'review' ? 'checking' : 'running',
        iterations: goal.iterations + 1,
        reason: undefined,
      })
      if (!attempt || disposed || suspended.has(id) || dependencies.read(id)?.revision !== attempt.revision) return
      if (!attachedRun && (!dependencies.canRun(id) || runningCount() >= maxConcurrent)) {
        await parkInterrupted(id, attempt)
        delay = 1000
        return
      }
      const controller = new AbortController()
      entry.running = { controller, settled: entry.settled }
      let result: GoalStepResult
      try {
        result = attachedRun
          ? await attachedRun(Object.freeze({ ...attempt }), controller.signal)
          : await dependencies.run(id, Object.freeze({ ...attempt }), controller.signal)
        if (
          !result ||
          !['continue', 'candidate', 'completed', 'blocked'].includes(result.status) ||
          typeof result.summary !== 'string'
        ) {
          throw new Error('Ungültiges Ergebnis des Zielabschnitts.')
        }
      } catch {
        if (controller.signal.aborted || disposed || suspended.has(id)) {
          if (!disposed) await parkInterrupted(id, attempt)
          return
        }
        const failures = (attempt.consecutiveErrors ?? 0) + 1
        await write(id, attempt, {
          consecutiveErrors: failures,
          active: !attachedRun && failures < 3,
          status: attachedRun || failures >= 3 ? 'blocked' : 'waiting',
          reason: attachedRun
            ? 'Die laufende Zielbearbeitung wurde unterbrochen. Das Ziel bleibt offen; Fortschritt und Modellzustand prüfen.'
            : failures >= 3
              ? 'Drei aufeinanderfolgende Versuche sind fehlgeschlagen. Ziel bleibt offen; Verbindung oder Modell prüfen.'
              : 'Der Arbeitsabschnitt konnte nicht abgeschlossen werden. Ein begrenzter neuer Versuch folgt.',
        })
        delay = failures === 1 ? 1000 : 3000
        return
      }
      if (controller.signal.aborted || disposed || suspended.has(id)) {
        if (!disposed) await parkInterrupted(id, attempt)
        return
      }
      if (dependencies.read(id)?.revision !== attempt.revision) return
      const summary = compact(result.summary, 4000)
      const evidence = compact(result.evidence, 8000)
      // Narration is not evidence. Missing host progress cannot reset stagnation
      // merely because the model paraphrases the same unfinished work.
      const fingerprint = compact(result.fingerprint, 1000)
      const unchanged = fingerprint === (attempt.lastFingerprint ?? '')
      const stagnant = unchanged ? (attempt.stagnantIterations ?? 0) + 1 : 1
      const common: Partial<GoalRunState> = {
        progress: summary,
        lastMessageId: compact(result.messageId, 200) || attempt.lastMessageId,
        lastFingerprint: fingerprint,
        stagnantIterations: stagnant,
        consecutiveErrors: 0,
      }
      if ((attempt.phase === 'review' || result.reviewVerified === true) && result.status === 'completed' && evidence) {
        await write(id, attempt, {
          ...common,
          active: false,
          status: 'completed',
          evidence,
          reason: 'Ziel durch Ergebnisprüfung mit Nachweis abgeschlossen.',
        })
      } else if (result.status === 'blocked' || stagnant >= 3) {
        await write(id, attempt, {
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
        await write(id, attempt, {
          ...common,
          status: 'waiting',
          phase: review ? 'review' : 'work',
          evidence: review ? evidence || undefined : undefined,
          reason: review
            ? 'Ergebnis liegt vor und wird vor dem Abschluss geprüft.'
            : result.status === 'completed'
              ? 'Ein prüfbarer Erfolgsnachweis fehlt. Ziel bleibt offen.'
              : undefined,
        })
      }
    } catch (error) {
      // Repeated writes cannot repair unavailable persistence. Require a deliberate kick after recovery.
      suspended.add(id)
      dependencies.onPersistenceError?.(id, error)
    } finally {
      entry.running = undefined
      entry.driving = false
      markSettled()
      entry.settled = undefined
      // Native-confirmed recovery detached this owner. Its late completion cannot schedule a new run.
      if (drivers.get(id) !== entry) return
      arrange(id, delay)
      // A finished section frees a slot: let other waiting goals try again promptly.
      for (const other of drivers.keys()) if (other !== id && !drivers.get(other)?.running) arrange(other, delay)
    }
  }

  async function interrupt(
    id: string,
    reason = 'Deine neue Nachricht hat Vorrang. Das Ziel bleibt offen.'
  ): Promise<void> {
    suspended.add(id)
    cancelTimer(id)
    const active = drivers.get(id)?.running
    const settled = drivers.get(id)?.settled
    active?.controller.abort(reason)
    const goal = dependencies.read(id)
    try {
      if (
        goal &&
        goal.status !== 'completed' &&
        (goal.status !== 'waiting' || goal.phase !== 'work' || goal.reason !== reason)
      )
        await write(id, goal, { status: 'waiting', phase: 'work', reason })
    } finally {
      // The chat adapter releases its busy state before the user's request is admitted.
      await settled
    }
  }

  return {
    /** Synchronous admission fence; the binding persists the paused states separately. */
    cancelAll(ids: Iterable<string>, reason: string): void {
      for (const id of new Set([...drivers.keys(), ...ids])) {
        suspended.add(id)
        cancelTimer(id)
        drivers.get(id)?.running?.controller.abort(reason)
      }
    },
    /** Only after native cleanup has confirmed that old work can no longer run. */
    recoverAfterStop(): void {
      for (const [id, entry] of drivers) {
        suspended.add(id)
        cancelTimer(id)
        entry.running?.controller.abort('Globale Ausführung beendet.')
      }
      drivers.clear()
    },
    /** Attach an already admitted foreground chat turn without creating another prompt or run. */
    async runAttached(id: string, run: AttachedGoalRun): Promise<void> {
      if (disposed || !dependencies.read(id)?.active) return
      const entry = driver(id)
      if (entry.driving)
        throw new Error('Die vorherige Zielbearbeitung muss vor dem neuen Auftrag vollständig beendet sein.')
      cancelTimer(id)
      suspended.delete(id)
      await drive(id, run)
    },
    /** Call after user work finishes or explicitly (re)activating a goal. */
    kick(id: string): void {
      if (disposed) return
      suspended.delete(id)
      if (!driver(id).driving) arrange(id, 0)
    },
    /** Includes admission/result persistence so foreground preemption drains the whole lifecycle. */
    isRunning(id: string): boolean {
      return !!drivers.get(id)?.driving
    },
    interrupt,
    async stop(id: string, reason = 'Ziel pausiert. Der bisherige Fortschritt bleibt erhalten.'): Promise<void> {
      suspended.add(id)
      cancelTimer(id)
      const active = drivers.get(id)?.running
      const settled = drivers.get(id)?.settled
      active?.controller.abort(reason)
      const goal = dependencies.read(id)
      try {
        if (
          goal &&
          goal.status !== 'completed' &&
          (goal.active || goal.status !== 'waiting' || goal.phase !== 'work' || goal.reason !== reason)
        )
          await write(id, goal, { active: false, status: 'waiting', phase: 'work', reason })
      } finally {
        await settled
      }
    },
    dispose(): void {
      disposed = true
      for (const id of drivers.keys()) cancelTimer(id)
      for (const entry of drivers.values()) entry.running?.controller.abort('Zielsteuerung beendet.')
    },
  }
}
