import type { ContextPackage } from '@/services/inference/contextBroker'
import type { PromptFragment, PromptFragmentSource } from '@/services/prompt/promptContextAssembler'
import type { PromptContextDetails } from '@/services/contextController'

/** One assembled start context: either a live preview of the current draft or what a run received. */
export type ContextSnapshot = {
  kind: 'preview' | 'run'
  at: number
  projectId: string
  conversationId: string
  messageId?: string
  taskType: string
  prompt: string
  /** Source fragments before the broker applied scope/egress/budget rules. */
  fragments: PromptFragment[]
  local: ContextPackage
  external: ContextPackage
  retrieval?: Pick<PromptContextDetails, 'repositoryDiagnostics' | 'memoryDiagnostics'>
}

export const CONTEXT_SOURCE_LABELS: Record<PromptFragmentSource, string> = {
  runtime: 'Laufzeit',
  project: 'Projekt',
  memory: 'Erinnerungen',
  repository: 'Repository',
  tool: 'Werkzeug-Ergebnisse',
  history: 'Verlauf',
}

export const CONTEXT_SOURCE_ORDER: PromptFragmentSource[] = [
  'runtime',
  'project',
  'memory',
  'repository',
  'tool',
  'history',
]

export const CONTEXT_EGRESS_LABELS = {
  allowed: 'lokal + extern',
  approval_required: 'extern nur nach Freigabe',
  local_only: 'nur lokal',
} as const

export const CONTEXT_TRUST_LABELS = {
  policy: 'Regel',
  user_confirmed: 'bestätigt',
  untrusted_data: 'Daten',
} as const

export const CONTEXT_OMISSION_LABELS: Record<string, string> = {
  scope_mismatch: 'anderer Geltungsbereich',
  inactive: 'nicht mehr aktiv',
  audience_mismatch: 'nicht für dieses Ziel',
  secret: 'Geheimnis · zurückgehalten',
  approval_required: 'Freigabe fehlt',
  local_only: 'nur lokal',
  fragment_limit: 'Fragmentlimit',
  budget: 'Zeichenbudget',
  empty: 'leer',
  duplicate: 'doppelt',
}

/** Human-readable name for a fragment id such as `memory-project-42` or `active-plan`. */
export function fragmentTitle(fragment: PromptFragment): string {
  const known: Record<string, string> = {
    'project-identity': 'Projektidentität',
    'project-goal': 'Projektziel',
    'project-goals': 'Projektziele',
    'project-summary': 'Projektzusammenfassung',
    'project-workspace': 'Projektordner',
    'active-plan': 'Aktiver Plan',
    'recent-tool-outcomes': 'Letzte Werkzeug-Ergebnisse',
    'query-context': 'Treffer zur Anfrage',
    'local-workspace-path': 'Lokaler Projektpfad',
  }
  if (known[fragment.id]) return known[fragment.id]!
  if (fragment.id.startsWith('session-memory-candidate:')) return 'Unbestätigter Auszug dieses Chats'
  if (fragment.id.startsWith('query-memory-')) return 'Passende aktive Erinnerung'
  if (fragment.id.startsWith('memory-')) {
    const type = fragment.provenance?.type
    return type ? `Erinnerung · ${type}` : 'Erinnerung'
  }
  return fragment.id.replace(/[-_]+/g, ' ')
}
