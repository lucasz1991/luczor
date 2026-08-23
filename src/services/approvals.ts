// src/services/approvals.ts
//
// Promise-based human-in-the-loop gate.
//
// The agent loop calls `awaitApproval(toolCallId)` and suspends until the UI
// resolves it via `resolveApproval(toolCallId, true|false)`. This keeps the
// agentic control flow linear while the approval itself is driven by user
// clicks in the Vue layer.

type Resolver = (approved: boolean) => void

const resolvers = new Map<string, Resolver>()

/** Suspend until the user approves or rejects the given tool call. */
export function awaitApproval(toolCallId: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    // If a stale resolver exists for this id, reject it first.
    const prev = resolvers.get(toolCallId)
    if (prev) prev(false)
    resolvers.set(toolCallId, resolve)
  })
}

/** Resolve a pending approval. No-op if nothing is waiting on this id. */
export function resolveApproval(toolCallId: string, approved: boolean): void {
  const r = resolvers.get(toolCallId)
  if (!r) return
  resolvers.delete(toolCallId)
  r(approved)
}

/** Reject every outstanding approval (e.g. on stop/cancel). */
export function rejectAllApprovals(): void {
  for (const [id, r] of resolvers) {
    resolvers.delete(id)
    r(false)
  }
}

export function hasPendingApproval(toolCallId: string): boolean {
  return resolvers.has(toolCallId)
}
