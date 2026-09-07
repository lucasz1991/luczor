/** Renderer-local preparation scope. Never use a new assistant-message ID as the session ID. */
export type PreparationScope = Readonly<{
  principalId: string
  serverInstance: string
  projectId: string
  sessionId: string
  generation: number
  workspaceRevision?: string
}>

export function preparationScopeKey(scope: PreparationScope): string {
  const fields = [scope.principalId, scope.serverInstance, scope.projectId, scope.sessionId]
  if (fields.some(value => !value.trim()) || !Number.isSafeInteger(scope.generation) || scope.generation < 1)
    throw new Error('Die Kontextvorbereitung benötigt eine vollständige, aktuelle Sitzung.')
  return JSON.stringify([...fields, scope.generation, scope.workspaceRevision ?? ''])
}

type Entry<T> = {
  controller: AbortController
  promise: Promise<T>
  expiresAt: number
  value?: T
  ready: boolean
}

function aborted(): DOMException {
  return new DOMException('Kontextvorbereitung verworfen.', 'AbortError')
}

/** Cancelling one consumer must not cancel another consumer of the same prepared value. */
async function consume<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return structuredClone(await promise)
  let onAbort = () => {}
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(aborted())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const value = await Promise.race([promise, cancellation])
    signal.throwIfAborted()
    return structuredClone(value)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Small, in-memory cache for source fragments, never turn packets, approvals or gateways.
 * Callers provide a revision covering every input (project/memory/preferences/policy).
 * A scope change aborts all producers; late results cannot enter a replacement scope.
 */
export class ScopedPreparationCache<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private scopeKey?: string
  private stopped = false
  private readonly maxAgeMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: { maxAgeMs?: number; maxEntries?: number; now?: () => number } = {}) {
    const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs! : 45_000
    const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries! : 4
    this.maxAgeMs = Math.max(1, Math.min(300_000, maxAgeMs))
    this.maxEntries = Math.max(1, Math.min(16, Math.floor(maxEntries)))
    this.now = options.now ?? Date.now
  }

  get(scope: PreparationScope, revision: string): T | undefined {
    if (this.stopped || preparationScopeKey(scope) !== this.scopeKey) return undefined
    const entry = this.entries.get(revision)
    if (!entry?.ready) return undefined
    if (entry.expiresAt <= this.now()) {
      this.remove(revision)
      return undefined
    }
    this.touch(revision, entry)
    return structuredClone(entry.value)
  }

  prepare(
    scope: PreparationScope,
    revision: string,
    producer: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.stopped) return Promise.reject(aborted())
    signal?.throwIfAborted()
    if (!revision.trim() || revision.length > 4096) throw new Error('Ungültige Kontextrevision.')
    const key = preparationScopeKey(scope)
    if (key !== this.scopeKey) {
      this.invalidate()
      this.scopeKey = key
    }
    let existing = this.entries.get(revision)
    if (existing?.ready && existing.expiresAt <= this.now()) {
      this.remove(revision)
      existing = undefined
    }
    if (existing) {
      this.touch(revision, existing)
      return consume(existing.promise, signal)
    }
    while (this.entries.size >= this.maxEntries) this.remove(this.entries.keys().next().value!)
    const controller = new AbortController()
    const entry: Entry<T> = { controller, ready: false, expiresAt: 0, promise: Promise.resolve(undefined as T) }
    this.entries.set(revision, entry)
    entry.promise = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted()
        return producer(controller.signal)
      })
      .then(value => {
        if (controller.signal.aborted || this.scopeKey !== key || this.entries.get(revision) !== entry) throw aborted()
        entry.value = structuredClone(value)
        entry.ready = true
        entry.expiresAt = this.now() + this.maxAgeMs
        return entry.value
      })
      .catch(error => {
        if (this.entries.get(revision) === entry) this.entries.delete(revision)
        throw error
      })
    return consume(entry.promise, signal)
  }

  invalidate(): void {
    for (const entry of this.entries.values()) entry.controller.abort()
    this.entries.clear()
    this.scopeKey = undefined
  }

  stop(): void {
    this.stopped = true
    this.invalidate()
  }

  private remove(revision: string): void {
    this.entries.get(revision)?.controller.abort()
    this.entries.delete(revision)
  }

  private touch(revision: string, entry: Entry<T>): void {
    this.entries.delete(revision)
    this.entries.set(revision, entry)
  }
}
