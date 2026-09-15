/** Vue adaptations of Beautiful UI. See vendor/beautiful-ui/LICENSE. */
export type ActivityStatus = 'pending' | 'running' | 'done' | 'failed' | 'waiting' | 'canceled'
export type ActivityStep = {
  id: string
  label: string
  createdAt?: number
  agentRole?: 'planner' | 'worker' | 'reviewer'
  detail?: string
  status: ActivityStatus
  capability?: string
  /** Short, redacted preview of the leading string arguments (path, command, query). */
  summary?: string
  model?: string
  provider?: string
  dataHandling?: 'syncable' | 'ephemeral'
}
export type ContextItem = { id: string; title: string; content: string; source: string; kind?: string }
export type SearchItem = {
  id: string
  label: string
  description?: string
  icon?: string
  busy?: boolean
  cloud?: boolean
  chats?: Array<{ id: string; label: string; busy?: boolean; status?: string }>
}
export type TableColumn = { key: string; label: string }
export type TableRecord = { id: string; [key: string]: string | number }
export type DiffRecord = { id: string; label: string; before: string; after: string }
export type Insight = { id: string; title: string; value: string; description: string; points: number[] }
export const statusLabels: Record<ActivityStatus, string> = {
  pending: 'Offen',
  running: 'Läuft',
  done: 'Erledigt',
  failed: 'Fehlgeschlagen',
  waiting: 'Freigabe nötig',
  canceled: 'Abgebrochen',
}
