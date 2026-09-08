import { memoryPriority } from './memoryPriority'
import type { MemoryRecord } from './luczorMemory'

export type MemoryAnalysis = {
  scope: 'user' | 'project'
  analyzed: number
  truncated: boolean
  priorities: Partial<Record<ReturnType<typeof memoryPriority>, number>>
  duplicates: Array<{ ids: string[]; count: number }>
  possible_conflicts: Array<{ ids: string[]; count: number }>
  expired_count: number
  review_count: number
  candidate_count: number
  changed_records: 0
  recommendations: string[]
}

/** Input must already be filtered by principal, exact scope and the DLP gate. */
export function analyzeMemoryRecords(records: MemoryRecord[], scope: 'user' | 'project'): MemoryAnalysis {
  const sampled = [...records].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 1000)
  const active = sampled.filter(record => record.status === 'active')
  const priorities = new Map<ReturnType<typeof memoryPriority>, number>()
  const byContent = new Map<string, MemoryRecord[]>()
  const byFeature = new Map<string, MemoryRecord[]>()
  for (const record of active) {
    const priority = memoryPriority(record.importance)
    priorities.set(priority, (priorities.get(priority) ?? 0) + 1)
    const normalized = record.content.replace(/\s+/gu, ' ').trim()
    byContent.set(normalized, [...(byContent.get(normalized) ?? []), record])
    if (record.featureKey) byFeature.set(record.featureKey, [...(byFeature.get(record.featureKey) ?? []), record])
  }
  const groups = (entries: MemoryRecord[][]) =>
    entries
      .filter(group => group.length > 1)
      .slice(0, 20)
      .map(group => ({ ids: group.map(record => record.id), count: group.length }))
  const expired = active.filter(record => record.expiresAt && record.expiresAt <= Date.now())
  return {
    scope,
    analyzed: sampled.length,
    truncated: records.length > sampled.length,
    priorities: Object.fromEntries(priorities),
    duplicates: groups([...byContent.values()]),
    possible_conflicts: groups(
      [...byFeature.values()].filter(group => new Set(group.map(record => record.contentHash)).size > 1)
    ),
    expired_count: expired.length,
    review_count: active.filter(
      record => !expired.includes(record) && record.updatedAt < Date.now() - 90 * 24 * 60 * 60_000
    ).length,
    candidate_count: sampled.filter(record => record.status === 'candidate').length,
    changed_records: 0,
    recommendations: [
      'Identische Inhalte werden beim Abruf einmal verwendet; alle Versionen bleiben erhalten.',
      'Unbestätigte Kandidaten und verschiedene Aussagen zum selben Merkmal zuerst prüfen.',
      'Alter ist nur ein Prüfhinweis und kein Beleg für eine falsche Erinnerung.',
    ],
  }
}
