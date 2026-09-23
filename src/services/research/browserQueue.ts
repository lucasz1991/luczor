type Waiter = { signal?: AbortSignal; start: () => void; cancel: () => void }

/** FIFO ownership for complete observation transactions; aborted waiters never acquire the browser. */
export class ResearchBrowserQueue {
  private busy = false
  private waiters: Waiter[] = []

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        start: () => {
          signal?.removeEventListener('abort', waiter.cancel)
          this.busy = true
          resolve()
        },
        cancel: () => {
          this.waiters = this.waiters.filter(item => item !== waiter)
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        },
      }
      signal?.addEventListener('abort', waiter.cancel, { once: true })
      if (this.busy) this.waiters.push(waiter)
      else waiter.start()
    })
    try {
      signal?.throwIfAborted()
      return await operation()
    } finally {
      this.busy = false
      const next = this.waiters.shift()
      next?.start()
    }
  }
}

export const researchBrowserQueue = new ResearchBrowserQueue()
