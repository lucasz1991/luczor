/**
 * One bounded, tool-free optimization at a time. The integration supplies only
 * device-local inference and stores private, attributed AI memories.
 * Foreground admission waits for actual inference cancellation/cleanup, never
 * merely for an abort signal or a timeout race.
 */
export type IdleOptimizationJob = Readonly<{
  key: string
  fingerprint: string
  boundary: string
  principalId: string
  scope: 'user' | 'project'
  projectId?: string
  prompt: string
  task?: 'context' | 'memory' | 'repository'
  sourceMemoryIds?: readonly string[]
}>

export type IdleOptimizationEligibility = Readonly<{
  available: boolean
  boundary: string
  reason?: string
}>

export type IdleContextOptimizerDependencies = {
  /** running=true must not interpret this optimizer's own occupied slot as foreign work. */
  inspect(signal: AbortSignal, running: boolean): Promise<IdleOptimizationEligibility>
  nextJob(boundary: string, signal: AbortSignal): Promise<IdleOptimizationJob | null>
  /** Must settle only after native stream cancellation and the background resource lease settle. */
  runLocal(job: IdleOptimizationJob, signal: AbortSignal): Promise<string>
  /** Must bind writes to job.principalId and preserve existing facts/project summaries. */
  commitCandidate(job: IdleOptimizationJob, content: string, signal: AbortSignal): Promise<void>
  settled?(job: IdleOptimizationJob, success: boolean, interrupted: boolean): Promise<void>
  now?(): number
}

export type IdleContextOptimizerOptions = {
  idleDelayMs: number
  intervalMs: number
  timeoutMs: number
  monitorMs: number
  errorBackoffMs: number
  successfulIntervalMs?: number
}

export type IdleContextOptimizerSnapshot = Readonly<{
  enabled: boolean
  phase: 'stopped' | 'waiting' | 'paused' | 'running' | 'committing' | 'yielding' | 'cooldown'
  /** The currently running or most recently completed locally bounded task. */
  task: 'context' | 'memory' | 'repository' | null
  reason: string | null
  foregroundJobs: number
  completed: number
  lastCompletedAt: number | null
  nextCheckAt: number | null
}>

const DEFAULTS: IdleContextOptimizerOptions = {
  // Background model work must never compete with a just-finished user turn.
  // Ten minutes is long enough to make this a real idle period, not a debounce.
  idleDelayMs: 600_000,
  intervalMs: 120_000,
  timeoutMs: 60_000,
  monitorMs: 5_000,
  errorBackoffMs: 600_000,
}
const MAX_CONTEXT_CHARS = 24_000
const MAX_CANDIDATE_CHARS = 8_000
const MAX_COMPLETED_FINGERPRINTS = 128

function aborted(): DOMException {
  return new DOMException('Idle optimization interrupted.', 'AbortError')
}

/** Cancels only the caller's wait; the background operation remains tracked until it settles. */
async function waitForDrain(operation: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!signal) return operation
  let rejectAbort: (() => void) | undefined
  const interruption = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(signal.reason ?? aborted())
    signal.addEventListener('abort', rejectAbort, { once: true })
  })
  try {
    await Promise.race([operation, interruption])
    signal.throwIfAborted()
  } finally {
    if (rejectAbort) signal.removeEventListener('abort', rejectAbort)
  }
}

export class IdleContextOptimizer {
  private readonly options: IdleContextOptimizerOptions
  private readonly listeners = new Set<(state: IdleContextOptimizerSnapshot) => void>()
  private readonly completedFingerprints = new Map<string, string>()
  private readonly now: () => number
  private timer?: ReturnType<typeof setTimeout>
  private active?: { controller: AbortController; promise: Promise<void> }
  private lastActivity: number
  private earliestCycle = 0
  private state: IdleContextOptimizerSnapshot = {
    enabled: false,
    phase: 'stopped',
    task: null,
    reason: null,
    foregroundJobs: 0,
    completed: 0,
    lastCompletedAt: null,
    nextCheckAt: null,
  }

  constructor(
    private readonly dependencies: IdleContextOptimizerDependencies,
    options: Partial<IdleContextOptimizerOptions> = {}
  ) {
    this.options = { ...DEFAULTS, ...options }
    for (const value of Object.values(this.options)) {
      if (!Number.isFinite(value) || value < 1) throw new Error('Invalid idle optimization interval.')
    }
    this.now = dependencies.now ?? Date.now
    this.lastActivity = this.now()
  }

  snapshot(): IdleContextOptimizerSnapshot {
    return { ...this.state }
  }

  subscribe(listener: (state: IdleContextOptimizerSnapshot) => void): () => void {
    this.listeners.add(listener)
    this.notify(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(listener: (state: IdleContextOptimizerSnapshot) => void): void {
    try {
      listener(this.snapshot())
    } catch {
      /* A view must not interrupt model ownership or cleanup. */
    }
  }

  private publish(changes: Partial<IdleContextOptimizerSnapshot>): void {
    this.state = { ...this.state, ...changes }
    for (const listener of this.listeners) this.notify(listener)
  }

  start(): void {
    if (this.state.enabled) return
    this.lastActivity = this.now()
    this.publish({ enabled: true, phase: this.active ? 'yielding' : 'waiting', reason: null })
    this.schedule()
  }

  async stop(): Promise<void> {
    this.clearTimer()
    this.publish({ enabled: false, phase: this.active ? 'yielding' : 'stopped', reason: 'disabled' })
    this.active?.controller.abort(aborted())
    await this.active?.promise
    if (!this.state.enabled) this.publish({ phase: 'stopped' })
  }

  /**
   * Schedule one otherwise normal, bounded pass immediately. This does not
   * bypass eligibility, resource ownership, memory consent, or the local-only
   * gateway checks in cycle().
   */
  requestNow(): boolean {
    if (!this.state.enabled || this.active || this.state.foregroundJobs) return false
    // Keep a one-millisecond delay: browsers and timer test environments do
    // not consistently dispatch a newly registered zero-delay timeout.
    this.lastActivity = this.now() - this.options.idleDelayMs + 1
    this.earliestCycle = this.now()
    this.clearTimer()
    this.publish({ phase: 'waiting', task: null, reason: 'manual_requested' })
    this.schedule()
    return true
  }

  /** Prompt typing, account/project changes and emergency-stop changes reset the idle grace. */
  interrupt(reason = 'interrupted'): void {
    this.lastActivity = this.now()
    this.clearTimer()
    this.active?.controller.abort(aborted())
    this.publish({
      phase: this.active ? 'yielding' : this.state.enabled ? 'paused' : 'stopped',
      reason,
    })
    this.schedule()
  }

  /** Acquire before context/model preparation; release after the complete foreground workflow. */
  async acquireForeground(signal?: AbortSignal): Promise<{ release(): void }> {
    signal?.throwIfAborted()
    this.publish({ foregroundJobs: this.state.foregroundJobs + 1 })
    this.interrupt('foreground')
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.lastActivity = this.now()
      this.publish({ foregroundJobs: Math.max(0, this.state.foregroundJobs - 1) })
      this.schedule()
    }
    try {
      const pending = this.active?.promise
      if (pending) await waitForDrain(pending, signal)
      signal?.throwIfAborted()
      return { release }
    } catch (error) {
      release()
      throw error
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.publish({ nextCheckAt: null })
  }

  private schedule(): void {
    if (!this.state.enabled || this.active || this.state.foregroundJobs || this.timer !== undefined) return
    const at = Math.max(this.now(), this.lastActivity + this.options.idleDelayMs, this.earliestCycle)
    this.publish({ nextCheckAt: at })
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.publish({ nextCheckAt: null })
        if (!this.state.enabled || this.state.foregroundJobs || this.active) return
        const controller = new AbortController()
        // Register ownership before any injected asynchronous operation can admit a foreground job.
        const promise = Promise.resolve().then(() => this.cycle(controller))
        const active = { controller, promise }
        this.active = active
        void promise.finally(() => {
          if (this.active !== active) return
          this.active = undefined
          if (!this.state.enabled) this.publish({ phase: 'stopped' })
          else if (controller.signal.aborted) this.publish({ phase: 'paused' })
          this.schedule()
        })
      },
      Math.max(0, at - this.now())
    )
  }

  private async cycle(controller: AbortController): Promise<void> {
    const { signal } = controller
    let monitor: ReturnType<typeof setTimeout> | undefined
    let finished = false
    let jobBoundary: string | undefined
    const abort = (reason: string) => {
      if (finished || signal.aborted) return
      this.publish({ phase: 'yielding', reason })
      controller.abort(aborted())
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    let selectedJob: IdleOptimizationJob | undefined
    let success = false
    const monitorEligibility = () => {
      monitor = setTimeout(async () => {
        try {
          const current = await this.dependencies.inspect(signal, true)
          if (finished || signal.aborted) return
          if (!current.available) abort(current.reason ?? 'runtime_unavailable')
          else if (current.boundary !== jobBoundary) abort('boundary_changed')
          else monitorEligibility()
        } catch {
          if (!finished) abort('runtime_unavailable')
        }
      }, this.options.monitorMs)
    }
    try {
      signal.throwIfAborted()
      const eligibility = await this.dependencies.inspect(signal, false)
      signal.throwIfAborted()
      if (!eligibility.available || !eligibility.boundary) {
        this.publish({ phase: 'paused', task: null, reason: eligibility.reason ?? 'runtime_unavailable' })
        return
      }
      jobBoundary = eligibility.boundary
      this.publish({ phase: 'running', task: null, reason: 'gathering_sources' })
      monitorEligibility()
      timeout = setTimeout(() => abort('timeout'), this.options.timeoutMs)
      const job = await this.dependencies.nextJob(eligibility.boundary, signal)
      selectedJob = job ?? undefined
      signal.throwIfAborted()
      if (!job) {
        this.publish({ phase: 'paused', task: null, reason: 'no_context' })
        return
      }
      if (
        job.boundary !== eligibility.boundary ||
        !job.key ||
        !job.fingerprint ||
        !job.principalId ||
        !job.prompt.trim() ||
        job.prompt.length > MAX_CONTEXT_CHARS ||
        (job.scope === 'project' && !job.projectId)
      ) {
        this.publish({ phase: 'paused', reason: 'invalid_context' })
        return
      }
      const completedKey = JSON.stringify([
        job.boundary,
        job.principalId,
        job.scope,
        job.projectId,
        job.key,
        job.fingerprint,
      ])
      if (this.completedFingerprints.get(completedKey) === job.fingerprint) {
        this.publish({ phase: 'paused', reason: 'unchanged_context' })
        return
      }
      jobBoundary = job.boundary
      const beforeRun = await this.dependencies.inspect(signal, false)
      signal.throwIfAborted()
      if (!beforeRun.available || beforeRun.boundary !== job.boundary) {
        this.publish({ phase: 'paused', reason: 'boundary_changed' })
        return
      }
      this.publish({
        phase: 'running',
        task: job.task ?? (job.scope === 'project' ? 'context' : 'memory'),
        reason: null,
      })
      const content = (await this.dependencies.runLocal(job, signal)).trim()
      signal.throwIfAborted()
      if (!content || content.length > MAX_CANDIDATE_CHARS) throw new Error('invalid_candidate')
      const current = await this.dependencies.inspect(signal, true)
      signal.throwIfAborted()
      if (!current.available || current.boundary !== job.boundary) {
        this.publish({ phase: 'paused', reason: current.reason ?? 'boundary_changed' })
        return
      }
      this.publish({ phase: 'committing' })
      await this.dependencies.commitCandidate(job, content, signal)
      success = true
      signal.throwIfAborted()
      this.completedFingerprints.delete(completedKey)
      this.completedFingerprints.set(completedKey, job.fingerprint)
      if (this.completedFingerprints.size > MAX_COMPLETED_FINGERPRINTS)
        this.completedFingerprints.delete(this.completedFingerprints.keys().next().value!)
      this.publish({
        phase: 'cooldown',
        reason: 'candidate_ready',
        completed: this.state.completed + 1,
        lastCompletedAt: this.now(),
      })
    } catch {
      if (!signal.aborted) {
        this.publish({ phase: 'cooldown', reason: 'failed' })
        this.earliestCycle = this.now() + this.options.errorBackoffMs
      } else if (this.state.reason === 'timeout') {
        this.earliestCycle = this.now() + this.options.errorBackoffMs
      }
    } finally {
      finished = true
      clearTimeout(timeout)
      if (monitor !== undefined) clearTimeout(monitor)
      if (selectedJob) {
        try {
          await this.dependencies.settled?.(selectedJob, success, signal.aborted)
        } catch {
          /* A future pass recovers a stale lease. */
        }
      }
      const delay =
        this.state.reason === 'candidate_ready'
          ? (this.options.successfulIntervalMs ?? this.options.intervalMs)
          : this.options.intervalMs
      this.earliestCycle = Math.max(this.earliestCycle, this.now() + delay)
    }
  }
}
