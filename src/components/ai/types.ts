/** Vue adaptations of Beautiful UI. See vendor/beautiful-ui/LICENSE. */
export type ActivityStatus = 'pending' | 'running' | 'done' | 'failed' | 'waiting' | 'canceled'
export type ActivityStep = { id: string; label: string; detail?: string; status: ActivityStatus }
export type ContextItem = { id: string; title: string; content: string; source: string; kind?: string }
export type SearchItem = { id: string; label: string; description?: string; icon?: string }
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
