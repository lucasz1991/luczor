import type { ActivityStep, ActivityStatus } from '@/components/ai/types'
import type { PendingToolCall } from '@/state/types'
import { redactProviderSecrets } from '@/services/prompt/promptContextAssembler'
import { getSafeRecordValue } from '@/services/safeRecord'

/** Numeric transport progress only; no private reasoning, prompts or tool payloads. */
export type AgentProgress = {
  agentRole?: 'planner' | 'worker' | 'reviewer'
  phase: 'routing' | 'thinking' | 'receiving' | 'tools' | 'regenerating'
  round?: number
  attempt?: number
  characters?: number
}
export type ChatActivity = { startedAt: number; finishedAt?: number; status: ActivityStatus; steps: ActivityStep[] }

/** Older stored activity labels may still include the former internal role prefix. */
export function publicActivityLabel(label: string): string {
  const match = /^(Planungsagent|Arbeitsagent|Prüfagent): (.+)$/.exec(label)
  if (!match) return label
  const phase = match[2]!
  if (phase === 'Antwort vorbereiten' || phase === 'Antwort wird geschrieben') {
    if (match[1] === 'Planungsagent') return 'Vorgehen wird ausgearbeitet'
    if (match[1] === 'Prüfagent') return 'Ergebnis wird geprüft'
  }
  return phase
}
export function createChatActivity(now = Date.now()): ChatActivity {
  return {
    startedAt: now,
    status: 'running',
    steps: [{ id: 'context', label: 'Kontext vorbereiten', status: 'running', createdAt: now }],
  }
}
export function updateChatActivity(activity: ChatActivity, event: AgentProgress, now = Date.now()): void {
  if (activity.finishedAt !== undefined) return
  // Each phase keeps its own row; token updates only refresh that phase.
  const phaseId = event.phase === 'routing' ? 'routing' : `round-${event.round ?? 1}-${event.phase}`
  const attemptId = event.attempt ? `${phaseId}-retry-${event.attempt}` : phaseId
  const id = event.agentRole ? `${event.agentRole}-${attemptId}` : attemptId
  const current = activity.steps.find(step => step.id === id)
  const label =
    event.phase === 'regenerating'
      ? 'Antwort wird neu erstellt'
      : event.phase === 'routing'
        ? 'Modell vorbereiten'
        : event.phase === 'tools'
          ? 'Werkzeuge ausführen'
          : event.phase === 'receiving'
            ? event.agentRole === 'planner'
              ? 'Vorgehen wird ausgearbeitet'
              : event.agentRole === 'reviewer'
                ? 'Ergebnis wird geprüft'
                : 'Antwort wird geschrieben'
            : event.agentRole === 'planner'
              ? 'Vorgehen vorbereiten'
              : event.agentRole === 'reviewer'
                ? 'Ergebnis prüfen'
                : 'Antwort vorbereiten'
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
    activity.steps.push({ id, label, detail, status: 'running', createdAt: now, agentRole: event.agentRole })
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
  const capability = call.name.startsWith('browser_')
    ? 'Browser'
    : call.name.startsWith('image_')
      ? 'Vision'
      : call.name === 'project_terminal_run' || call.name.endsWith('.run')
        ? 'Terminal'
        : call.name.startsWith('model_') || call.name.startsWith('local_model')
          ? 'Modell'
          : call.category === 'os'
            ? 'Desktop'
            : undefined
  return {
    id: call.id,
    label: call.name,
    createdAt: call.createdAt,
    status: TOOL_STATUS[call.status],
    capability,
    summary: toolArgumentSummary(call.args),
    model: typeof call.args.model === 'string' ? call.args.model.slice(0, 80) : undefined,
    provider: typeof call.args.provider === 'string' ? call.args.provider.slice(0, 48) : undefined,
    dataHandling: call.dataHandling,
    detail: call.status === 'proposed' && !call.requiresApproval ? 'Zur Ausführung vorbereitet' : undefined,
  }
}
/* The design board shows `tool  path/command` per row: pick the first short string arguments, never secrets. */
const SUMMARY_KEYS = ['path', 'file', 'command', 'cmd', 'query', 'pattern', 'url', 'title', 'name', 'text', 'prompt']
export function toolArgumentSummary(args: Record<string, unknown>): string | undefined {
  const parts: string[] = []
  for (const key of SUMMARY_KEYS) {
    const value = getSafeRecordValue(args, key)
    if (typeof value === 'string' && value.trim()) parts.push(value.replace(/\s+/g, ' ').trim())
    if (parts.length >= 2) break
  }
  const joined = redactProviderSecrets(parts.join(' · '))
  return joined ? (joined.length > 88 ? `${joined.slice(0, 88)}…` : joined) : undefined
}
export function activityLabel(activity: ChatActivity, waiting: boolean): string {
  if (activity.status === 'canceled') return 'Verarbeitung abgebrochen'
  if (activity.status === 'failed') return 'Verarbeitung fehlgeschlagen'
  if (activity.status === 'done') return 'Arbeitsschritte abgeschlossen'
  if (waiting) return 'Wartet auf deine Freigabe'
  return publicActivityLabel(activity.steps[activity.steps.length - 1]?.label ?? 'Luczor arbeitet')
}
