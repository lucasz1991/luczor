export type ModelSwitchState = {
  revision: number
  phase: 'idle' | 'waiting' | 'unloading' | 'loading' | 'ready' | 'failed'
  selectedModelId: string | null
  previousModelId?: string
  activeModelId?: string
}

type SwitchRequest = { revision: number; modelId: string | null; assertCurrent(): void }
type Dependencies = {
  exclusive(operation: () => Promise<void>): Promise<void>
  unload(modelId: string | null, onUnloading: (id: string) => void): Promise<void>
  prepare(modelId: string | null): Promise<string>
}

/** One main-window owner; selection changes coalesce while native IPC drains. */
export class LocalModelSwitch {
  private state: ModelSwitchState = { revision: 0, phase: 'idle', selectedModelId: null }
  private latest?: SwitchRequest
  private draining?: Promise<void>
  private generation = 0
  private readonly listeners = new Set<(state: ModelSwitchState) => void>()

  constructor(private readonly dependencies: Dependencies) {}

  snapshot(): ModelSwitchState {
    return { ...this.state }
  }

  subscribe(listener: (state: ModelSwitchState) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  private publish(state: ModelSwitchState): void {
    this.state = state
    for (const listener of this.listeners) listener(this.snapshot())
  }

  request(modelId: string | null, assertCurrent: () => void): Promise<void> {
    const request = { revision: this.state.revision + 1, modelId, assertCurrent }
    this.latest = request
    this.publish({ revision: request.revision, selectedModelId: modelId, phase: 'waiting' })
    return this.startDrain()
  }

  /** Native-confirmed stop retires the pending switch without changing the saved selection. */
  recoverAfterStop(): void {
    this.generation++
    this.latest = undefined
    this.draining = undefined
    this.publish({ revision: this.state.revision + 1, phase: 'idle', selectedModelId: this.state.selectedModelId })
  }

  private startDrain(): Promise<void> {
    if (!this.draining) {
      const startingRequest = this.latest
      const generation = this.generation
      const work = this.dependencies.exclusive(() => this.drain(generation))
      this.draining = work
      void work.then(
        () => this.finish(work),
        () => {
          if (this.draining !== work || this.generation !== generation) return
          this.publish({ ...this.state, phase: 'failed' })
          if (this.latest === startingRequest) this.latest = undefined
          this.finish(work)
        }
      )
    }
    return this.draining
  }

  private finish(work: Promise<void>): void {
    if (this.draining !== work) return
    this.draining = undefined
    // An updated selection can arrive after drain() returns but before the outer
    // exclusive operation settles. It still needs its own drain, not a stuck Waiting.
    if (this.latest) void this.startDrain().catch(() => undefined)
  }

  private async drain(generation: number): Promise<void> {
    while (this.latest && this.generation === generation) {
      const request = this.latest
      let previousModelId: string | undefined
      const publish = (phase: ModelSwitchState['phase'], activeModelId?: string) => {
        if (this.latest === request && this.generation === generation)
          this.publish({
            revision: request.revision,
            selectedModelId: request.modelId,
            previousModelId,
            activeModelId,
            phase,
          })
      }
      try {
        request.assertCurrent()
        publish('unloading')
        await this.dependencies.unload(request.modelId, id => {
          previousModelId = id
          publish('unloading')
        })
        if (this.generation !== generation) return
        request.assertCurrent()
        // A newer selection arrived while stopping: load only that selection.
        if (this.latest !== request) continue
        publish('loading')
        const activeModelId = await this.dependencies.prepare(request.modelId)
        if (this.generation !== generation) return
        request.assertCurrent()
        publish('ready', activeModelId)
      } catch {
        // Never expose native errors, catalog bindings or credential-bearing paths.
        publish('failed')
      }
      if (this.latest === request) this.latest = undefined
    }
  }
}

export const modelSwitchIsPending = (state: ModelSwitchState): boolean =>
  state.phase === 'waiting' || state.phase === 'unloading' || state.phase === 'loading'
