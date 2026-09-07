import type { WireMessage } from '@/services/inference/types'

export type ToolOutcome = { ok: boolean; output?: unknown; error?: string }
export type AgentCheckpoint = {
  projectId: string
  sessionId: string
  generation: number
  objective: string
  messages: WireMessage[]
  completedMutations: [string, ToolOutcome][]
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

/** Keep a bounded handoff copy; executable arguments and the archive remain untouched. */
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
    .map(message => {
      if (message.role === 'tool' && message.content.length > 1200)
        return {
          ...message,
          content:
            message.content.slice(0, 1200) + '\n[Auszug für Agentenübergabe; fehlende Details gezielt erneut lesen.]',
        }
      return structuredClone(message)
    })
}
