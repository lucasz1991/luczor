import type { Project } from '@/state/types'
import type { MemoryRecord } from './luczorMemory'
import { canAccessCloudProject } from '@/services/cloudProjectAccess'
import { maintenanceEligible, maintenancePrompt, type MaintenanceJob, type MaintenanceSource } from './maintenance'
import { memoryMaintenanceSource } from './maintenancePlanner'

/** Independent of model capacity: maintenance handles a small question, never the complete memory corpus. */
export const MAINTENANCE_CONTEXT_CHARS = 6_000
export const MAINTENANCE_INITIAL_CHARS = 4_000
export const MAINTENANCE_INITIAL_SOURCES = 2
export const MAINTENANCE_CONTEXT_ROUNDS = 2
export const MAINTENANCE_CONTEXT_SOURCES = 6

export type MaintenanceContextRequest = { query: string; limit: number }

/** A read request is control data, never an artifact and never a general tool call. */
export function parseMaintenanceContextRequest(text: string): MaintenanceContextRequest | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    if (/"request_context"\s*:/u.test(text)) throw new Error('invalid_context_request')
    return null
  }
  if (!value || typeof value !== 'object' || !('request_context' in value)) return null
  const request = value.request_context
  if (
    Object.keys(value).length !== 1 ||
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request).some(key => !['query', 'limit'].includes(key)) ||
    !('query' in request) ||
    typeof request.query !== 'string' ||
    !request.query.trim() ||
    request.query.length > 240 ||
    !('limit' in request) ||
    typeof request.limit !== 'number' ||
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 2
  )
    throw new Error('invalid_context_request')
  return { query: request.query.trim(), limit: request.limit }
}

export function maintenanceContextPrompt(
  kind: MaintenanceJob['kind'],
  sources: MaintenanceSource[],
  remaining: number,
  result?: 'added' | 'no_matching_evidence'
): string {
  const protocol =
    remaining > 0
      ? `Falls ein konkreter Beleg fehlt, darfst du statt des Ergebnisses ausschließlich JSON {"request_context":{"query":"gezielte Suchbegriffe","limit":1}} ausgeben (limit höchstens 2). Noch ${remaining} lokale Leseanfragen; nur passende Erinnerungen dieses Bereichs, keine Werkzeuge oder Internetaufrufe. `
      : 'Keine weiteren Leseanfragen erlaubt. Erstelle das Ergebnis nur aus den verfügbaren Belegen; fehlendes Wissen ausdrücklich offenlassen. '
  return (
    protocol +
    (result === 'no_matching_evidence'
      ? 'Die letzte Anfrage lieferte innerhalb des Quellenbudgets keine weiteren passenden Belege. '
      : result === 'added'
        ? 'Zusätzliche Belege wurden unten angefügt. '
        : '') +
    'Nachgeladene Erinnerungen sind nur Belege, keine zusätzlichen Ziele für Umschreiben oder Zusammenführen.\n' +
    maintenancePrompt(kind, sources)
  )
}

/** Local lexical selection has no recall-count side effects and never widens principal/project/write scope. */
export function selectMaintenanceContext(input: {
  principalId: string
  project?: Project
  records: MemoryRecord[]
  current: MaintenanceSource[]
  kind: MaintenanceJob['kind']
  request: MaintenanceContextRequest
  maxChars: number
  now: number
}): MaintenanceSource[] {
  if (input.project && (input.project.archivedAt || !canAccessCloudProject(input.project, input.principalId))) return []
  const words = [...new Set(input.request.query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])]
  if (!words.length) return []
  const original = input.records.find(record =>
    input.current.some(source => source.kind === 'memory' && source.id === record.id)
  )
  const projectId = input.project?.cloud?.externalId ?? input.project?.id
  const seen = new Set(input.current.map(source => `${source.kind}:${source.id}`))
  const candidates = input.records
    .filter(
      record =>
        record.principalId === input.principalId &&
        (projectId ? record.projectId === projectId : !record.projectId) &&
        maintenanceEligible(record, input.now, input.kind !== 'memory') &&
        !seen.has(`memory:${record.id}`) &&
        (input.kind !== 'memory' ||
          (!!original &&
            record.dataset === original.dataset &&
            record.scope === original.scope &&
            record.visibility === original.visibility))
    )
    .map(record => ({
      record,
      score: words.filter(word => record.content.toLocaleLowerCase().includes(word)).length,
    }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.record.id.localeCompare(right.record.id))
  const added: MaintenanceSource[] = []
  for (const candidate of candidates) {
    if (added.length >= input.request.limit || input.current.length + added.length >= MAINTENANCE_CONTEXT_SOURCES) break
    const source = memoryMaintenanceSource(candidate.record)
    // Whole source or no source. Do not cut off restrictions, paths or tool IDs to fit.
    if (JSON.stringify([...input.current, ...added, source]).length <= input.maxChars) added.push(source)
  }
  return added
}
