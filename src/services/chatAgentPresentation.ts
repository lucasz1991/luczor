import type { ActivityStatus, ActivityStep } from '@/components/ai/types'
import { publicActivityLabel, type ChatActivity } from './chatActivity'

export type ChatAgentRole = 'planner' | 'worker' | 'reviewer'
export type ChatAgentStatus = ActivityStatus | 'unknown'
export type ChatAgentPresentation = {
  role: ChatAgentRole
  label: string
  icon: string
  status: ChatAgentStatus
  statusLabel: string
  phase: string
  detail?: string
  model?: string
  provider?: string
}

const roles = [
  { role: 'planner', label: 'Planung', icon: 'grid' },
  { role: 'worker', label: 'Bearbeitung', icon: 'tool' },
  { role: 'reviewer', label: 'Prüfung', icon: 'shield' },
] as const

const labels = new Map<ChatAgentStatus, string>([
  ['pending', 'Offen'],
  ['running', 'Arbeitet'],
  ['done', 'Abgeschlossen'],
  ['failed', 'Fehlgeschlagen'],
  ['waiting', 'Wartet'],
  ['canceled', 'Abgebrochen'],
  ['unknown', 'Status offen'],
])

function roleStatus(step: ActivityStep, activity: ChatActivity, loading: boolean): ChatAgentStatus {
  if (step.status !== 'running') return step.status
  if (activity.status === 'failed' || activity.status === 'canceled') return activity.status
  if (activity.finishedAt === undefined && loading && activity.status === 'running') return 'running'
  if (activity.finishedAt === undefined && loading && activity.status === 'waiting') return 'waiting'
  // A stale streaming row is not proof that a role has finished or is still executing.
  return 'unknown'
}

/** Only roles observed in public activity events, never an invented expected team. */
export function presentChatAgents(activity?: ChatActivity, loading = false): ChatAgentPresentation[] {
  if (!activity) return []
  return roles.flatMap(({ role, label, icon }) => {
    const latest = activity.steps.filter(step => step.id.startsWith(`${role}-`)).at(-1)
    if (!latest) return []
    const status = roleStatus(latest, activity, loading)
    return [
      {
        role,
        label,
        icon,
        status,
        statusLabel: labels.get(status)!,
        phase: publicActivityLabel(latest.label),
        detail: latest.detail,
        model: latest.model,
        provider: latest.provider,
      },
    ]
  })
}
