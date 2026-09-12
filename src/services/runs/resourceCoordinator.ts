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

  acquire(keys: string[], signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    const unique = [...new Set(keys)].sort()
    return new Promise((resolve, reject) => {
      const item: Waiting = {
        keys: unique, signal, resolve, reject,
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

  private drain(): void {
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
      item.keys.forEach(key => this.occupied.set(key, (this.occupied.get(key) ?? 0) + 1))
      let released = false
      item.resolve(() => {
        if (released) return
        released = true
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
  keys: string[], signal: AbortSignal | undefined, work: () => Promise<T>, onWaiting?: (waiting: boolean) => void
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
