type Waiting = {
  keys: string[]
  resolve: (release: () => void) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  abort: () => void
}

/** Acquire a complete resource set atomically, so sibling jobs cannot deadlock. */
export class RunResourceCoordinator {
  private occupied = new Map<string, number>()
  private queue: Waiting[] = []
  private readonly leases = new Set<symbol>()
  private admissionPaused = false
  private stopGeneration = 0

  acquire(keys: string[], signal?: AbortSignal): Promise<() => void> {
    if (this.admissionPaused) return Promise.reject(new Error('Ressourcenvergabe ist gestoppt.'))
    signal?.throwIfAborted()
    const unique = [...new Set(keys)].sort()
    return new Promise((resolve, reject) => {
      const item: Waiting = {
        keys: unique,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(item)
          if (index < 0) return
          this.queue.splice(index, 1)
          reject(signal?.reason ?? new Error('Auftrag abgebrochen.'))
          this.drain()
        },
      }
      this.queue.push(item)
      signal?.addEventListener('abort', item.abort, { once: true })
      this.drain()
    })
  }

  /** Abort owners through the execution gate before requesting this queue stop. */
  cancelPending(reason: unknown = new Error('Alle Aufträge gestoppt.')): number {
    this.admissionPaused = true
    const generation = ++this.stopGeneration
    for (const item of this.queue.splice(0)) {
      item.signal?.removeEventListener('abort', item.abort)
      item.reject(reason)
    }
    return generation
  }

  /** Only a verified stop of every owned native/local worker permits lease recovery. */
  recoverStopped(acknowledgement: import('./drain').NativeStopAcknowledgement): number {
    if (!acknowledgement.nativeStopped || acknowledgement.generation !== this.stopGeneration || !this.admissionPaused)
      return 0
    const recovered = this.leases.size
    this.leases.clear()
    this.occupied.clear()
    return recovered
  }

  resumeAfterStop(): boolean {
    if (this.leases.size || this.queue.length) return false
    this.admissionPaused = false
    return true
  }

  snapshot(): { occupied: string[]; waiting: number } {
    return { occupied: [...this.occupied.keys()], waiting: this.queue.length }
  }

  private drain(): void {
    if (this.admissionPaused) return
    const earlier = new Set<string>()
    for (let index = 0; index < this.queue.length;) {
      const item = this.queue[index]!
      if (item.keys.some(key => (this.occupied.get(key) ?? 0) >= (key === 'script' ? 2 : 1) || earlier.has(key))) {
        item.keys.forEach(key => earlier.add(key))
        index++
        continue
      }
      this.queue.splice(index, 1)
      item.signal?.removeEventListener('abort', item.abort)
      const lease = Symbol('run-resource-lease')
      this.leases.add(lease)
      item.keys.forEach(key => this.occupied.set(key, (this.occupied.get(key) ?? 0) + 1))
      let released = false
      item.resolve(() => {
        if (released) return
        released = true
        if (!this.leases.delete(lease)) return
        item.keys.forEach(key => {
          const count = (this.occupied.get(key) ?? 1) - 1
          if (count) this.occupied.set(key, count)
          else this.occupied.delete(key)
        })
        this.drain()
      })
    }
  }
}

export const runResourceCoordinator = new RunResourceCoordinator()

export async function withRunResources<T>(
  keys: string[],
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
  onWaiting?: (waiting: boolean) => void
): Promise<T> {
  onWaiting?.(true)
  let release: (() => void) | undefined
  try {
    release = await runResourceCoordinator.acquire(keys, signal)
    signal?.throwIfAborted()
    onWaiting?.(false)
    return await work()
  } finally {
    release?.()
    onWaiting?.(false)
  }
}
