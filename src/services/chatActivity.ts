import type { ActivityStep, ActivityStatus } from '@/components/ai/types'
import type { PendingToolCall } from '@/state/types'

/** Numeric transport progress only; no private reasoning, prompts or tool payloads. */
export type AgentProgress = {
  phase: 'routing' | 'thinking' | 'receiving' | 'tools'
  round?: number
  characters?: number
}
export type ChatActivity = { startedAt: number; finishedAt?: number; status: ActivityStatus; steps: ActivityStep[] }
export function createChatActivity(now = Date.now()): ChatActivity {
  return {
    startedAt: now,
    status: 'running',
    steps: [{ id: 'context', label: 'Kontext vorbereiten', status: 'running' }],
  }
}
export function updateChatActivity(activity: ChatActivity, event: AgentProgress): void {
  if (activity.finishedAt !== undefined) return
  const id = event.phase === 'routing' ? 'routing' : `round-${event.round ?? 1}`
  const current = activity.steps.find(step => step.id === id)
  const label =
    event.phase === 'routing'
      ? 'Modell vorbereiten'
      : event.phase === 'tools'
        ? 'Tool-Aufrufe verarbeiten'
        : event.phase === 'receiving'
          ? 'Antwort empfangen'
          : 'Anfrage verarbeiten'
  const detail =
    event.characters === undefined
      ? event.round
        ? `Runde ${event.round}`
        : undefined
      : `${event.characters.toLocaleString('de-DE')} Zeichen empfangen · Runde ${event.round ?? 1}`
  if (current) {
    current.label = label
    current.detail = detail
  } else {
    activity.steps.forEach(step => {
      if (step.status === 'running') step.status = 'done'
    })
    activity.steps.push({ id, label, detail, status: 'running' })
  }
}
export function finishChatActivity(
  activity: ChatActivity,
  status: 'done' | 'failed' | 'canceled',
  now = Date.now()
): void {
  if (activity.finishedAt !== undefined) return
  activity.finishedAt = now
  activity.status = status
  activity.steps.forEach(step => {
    if (step.status === 'running') step.status = status
  })
}
const TOOL_STATUS: Record<PendingToolCall['status'], ActivityStatus> = {
  proposed: 'waiting',
  approved: 'pending',
  executing: 'running',
  executed: 'done',
  failed: 'failed',
  rejected: 'canceled',
  canceled: 'canceled',
}
export function presentToolCall(call: PendingToolCall): ActivityStep {
  return {
    id: call.id,
    label: call.name,
    status: TOOL_STATUS[call.status],
    detail: call.status === 'proposed' && !call.requiresApproval ? 'Zur Ausführung vorbereitet' : undefined,
  }
}
export function activityLabel(activity: ChatActivity, waiting: boolean): string {
  if (activity.status === 'canceled') return 'Verarbeitung abgebrochen'
  if (activity.status === 'failed') return 'Verarbeitung fehlgeschlagen'
  if (activity.status === 'done') return 'Arbeitsschritte abgeschlossen'
  if (waiting) return 'Wartet auf deine Freigabe'
  return activity.steps[activity.steps.length - 1]?.label ?? 'Luczor arbeitet'
}
