// src/services/approvals.ts
//
// Promise-based human-in-the-loop gate.
//
// The agent loop calls `awaitApproval(toolCallId)` and suspends until the UI
// resolves it via `resolveApproval(toolCallId, true|false)`. This keeps the
// agentic control flow linear while the approval itself is driven by user
// clicks in the Vue layer.

type Resolver = { settle: (approved: boolean) => void }

const resolvers = new Map<string, Resolver>()

/** Suspend until the user approves or rejects the given tool call. */
export function awaitApproval(toolCallId: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise<boolean>(resolve => {
    // If a stale resolver exists for this id, reject it first.
    const prev = resolvers.get(toolCallId)
    if (prev) prev.settle(false)
    const abort = () => settle(false)
    const settle = (approved: boolean) => {
      if (resolvers.get(toolCallId)?.settle !== settle) return
      resolvers.delete(toolCallId)
      signal?.removeEventListener('abort', abort)
      resolve(approved)
    }
    resolvers.set(toolCallId, { settle })
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Resolve a pending approval. No-op if nothing is waiting on this id. */
export function resolveApproval(toolCallId: string, approved: boolean): void {
  resolvers.get(toolCallId)?.settle(approved)
}

/** Reject every outstanding approval (e.g. on stop/cancel). */
export function rejectAllApprovals(): void {
  for (const r of [...resolvers.values()]) r.settle(false)
}

export function hasPendingApproval(toolCallId: string): boolean {
  return resolvers.has(toolCallId)
}
