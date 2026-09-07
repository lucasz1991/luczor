import { preparationScopeKey, type PreparationScope } from './scopedPreparationCache'

export const BACKGROUND_MODEL_PREPARATION_KEY = 'background_model_preparation'
export const BACKGROUND_CONTEXT_PREPARATION_KEY = 'background_context_preparation'
export const DEFAULT_BACKGROUND_PREPARATION_ENABLED = true

export type BackgroundPreparationPolicy = Readonly<{
  active: boolean
  mode?: 'loading' | 'active' | 'blocked'
  reason?: string
  fingerprint?: string
  expiresAt?: number
  /** Only a currently valid, enabled and admissible signed model belongs here. */
  readyModelId?: string
}>

export type BackgroundPreparationState = Readonly<{
  phase: 'disabled' | 'waiting' | 'preparing' | 'ready' | 'error' | 'stopped'
  modelId?: string
  reason?: 'scope_unavailable' | 'policy_unavailable' | 'busy' | 'preparation_failed'
}>

export type BackgroundPreparationInput = Readonly<{
  enabled: boolean
  busy: boolean
  scope: PreparationScope | null
}>

export type BackgroundPreparationDependencies = {
  policy: () => BackgroundPreparationPolicy
  /** Prepare signed local files only. Never generate a chat or choose an external route. */
  prepare: (scope: PreparationScope, signal: AbortSignal) => Promise<{ modelId?: string }>
  /** The supplied adapter must reverify an expired signed policy before any native preparation. */
  refreshExpiredPolicy?: boolean
  now?: () => number
  pollIntervalMs?: number
  retryDelayMs?: number
}

/**
 * Keeps signed local readiness available while the main renderer is open.
 * Ready evidence is checked before preparation, so polling never reloads resident weights.
 * Native preparation currently has no per-request abort API: an invalidated operation keeps
 * its slot until it settles, then its result is discarded. Catalog changes cancel it natively.
 */
export class BackgroundModelPreparation {
  private input: BackgroundPreparationInput = { enabled: false, busy: false, scope: null }
  private state: BackgroundPreparationState = { phase: 'disabled' }
  private readonly listeners = new Set<(state: BackgroundPreparationState) => void>()
  private timer?: ReturnType<typeof setTimeout>
  private active?: { controller: AbortController; key: string; promise: Promise<void> }
  private key?: string
  private retryAt = 0
  private stopped = false
  private readonly now: () => number
  private readonly pollIntervalMs: number
  private readonly retryDelayMs: number

  constructor(private readonly dependencies: BackgroundPreparationDependencies) {
    this.now = dependencies.now ?? Date.now
    this.pollIntervalMs = Math.max(1_000, dependencies.pollIntervalMs ?? 5_000)
    this.retryDelayMs = Math.max(10_000, dependencies.retryDelayMs ?? 60_000)
  }

  update(input: BackgroundPreparationInput): void {
    if (this.stopped) return
    this.input = { ...input, scope: input.scope ? { ...input.scope } : null }
    this.check()
  }

  snapshot(): BackgroundPreparationState {
    return { ...this.state }
  }

  subscribe(listener: (state: BackgroundPreparationState) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  invalidate(): void {
    this.update({ ...this.input, scope: null })
  }

  /** Stop scheduling without unloading a model another foreground request may be using. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.active?.controller.abort()
    this.publish({ phase: 'stopped' })
    this.listeners.clear()
  }

  private check(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const policy = this.dependencies.policy()
    const policyValid = policy.active && !!policy.fingerprint && Number(policy.expiresAt) > this.now()
    const canRefresh =
      this.dependencies.refreshExpiredPolicy === true &&
      policy.active &&
      !!policy.fingerprint &&
      Number.isFinite(policy.expiresAt) &&
      Number(policy.expiresAt) <= this.now()
    const nextKey =
      this.input.enabled && this.input.scope && (policyValid || canRefresh)
        ? `${preparationScopeKey(this.input.scope)}:${policy.fingerprint}`
        : undefined
    if (nextKey !== this.key) {
      this.active?.controller.abort()
      this.key = nextKey
      this.retryAt = 0
    }
    if (!this.input.enabled) {
      this.publish({ phase: 'disabled' })
      return
    }
    this.timer = setTimeout(() => this.check(), this.pollIntervalMs)
    if (!this.input.scope) return this.publish({ phase: 'waiting', reason: 'scope_unavailable' })
    if (!policyValid && !canRefresh) return this.publish({ phase: 'waiting', reason: 'policy_unavailable' })
    if (this.input.busy) return this.publish({ phase: 'waiting', reason: 'busy' })
    if (policyValid && policy.readyModelId) return this.publish({ phase: 'ready', modelId: policy.readyModelId })
    if (this.active || this.now() < this.retryAt) return

    const controller = new AbortController()
    const scope = { ...this.input.scope }
    const operation = { controller, key: nextKey!, promise: Promise.resolve() }
    this.active = operation
    this.publish({ phase: 'preparing' })
    operation.promise = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted()
        return this.dependencies.prepare(scope, controller.signal)
      })
      .then(result => {
        if (controller.signal.aborted || this.key !== operation.key || this.stopped) return
        const current = this.dependencies.policy()
        if (!current.active || current.fingerprint !== policy.fingerprint || Number(current.expiresAt) <= this.now())
          return
        this.retryAt = this.now() + this.retryDelayMs
        this.publish({ phase: 'ready', modelId: result.modelId })
      })
      .catch(() => {
        if (controller.signal.aborted || this.key !== operation.key || this.stopped) return
        this.retryAt = this.now() + this.retryDelayMs
        this.publish({ phase: 'error', reason: 'preparation_failed' })
      })
      .finally(() => {
        if (this.active === operation) this.active = undefined
        if (!this.stopped && this.key !== operation.key) this.check()
      })
  }

  private publish(state: BackgroundPreparationState): void {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return
    this.state = state
    for (const listener of this.listeners) listener(this.snapshot())
  }
}
