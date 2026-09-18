import type { WireMessage } from '@/services/inference/types'

export type ToolOutcome = { ok: boolean; output?: unknown; error?: string }
export type PendingTaskCreateVerification = {
  /** Missing on legacy entries and therefore interpreted as task. */
  kind?: 'task' | 'conversation'
  projectId: string
  /** Account + server binding; prevents a delayed checkpoint crossing an identity boundary. */
  principalScopeId?: string
  title: string
  externalId: string
  /** Canonical task_create payload identity. Older in-memory checkpoints may not contain it. */
  fingerprint?: string
  /** SHA-256 of the canonical payload; safe for durable exact-match recovery. */
  fingerprintHash?: string
  state: 'unknown' | 'verified_absent' | 'verified_present'
  taskId?: string
  resourceId?: string
}
export type AgentCheckpoint = {
  thinkingTier?: import('@/services/inference/thinking').ThinkingTier
  thinkingConfig?: import('@/services/inference/thinking').ThinkingConfig
  projectId: string
  /** Account + server binding used for safe generation rebasing. */
  principalScopeId?: string
  /** Workspace binding active when this checkpoint was produced. */
  workspaceBindingId?: string
  sessionId: string
  generation: number
  objective: string
  messages: WireMessage[]
  completedMutations: [string, ToolOutcome][]
  /** Ambiguous task/conversation POSTs must be checked before the same logical create can run again. */
  pendingTaskCreateVerifications?: PendingTaskCreateVerification[]
  ephemeralDataUsed: boolean
  toolAccess?: 'read-only' | 'none'
}

/** Key only for a successful mutation in this user turn, never a persisted cache. */
export function mutationKey(name: string, args: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonical(item)])
      )
    return value
  }
  return JSON.stringify([name, canonical(args)])
}

/** Limit handoff to the current round, preserving its complete evidence. */
export function teamMessages(messages: WireMessage[]): WireMessage[] {
  let latestUser = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages.at(index)?.role === 'user') {
      latestUser = index
      break
    }
  }
  return messages
    .filter((message, index) => message.role === 'system' || index >= latestUser)
    .map(message => structuredClone(message))
}
