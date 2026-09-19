import { describe, expect, it } from 'vitest'
import type { Project } from '@/state/types'
import type { MemoryRecord } from '@/services/memory/luczorMemory'
import { memoryMaintenanceSource } from '@/services/memory/maintenancePlanner'
import {
  maintenanceContextPrompt,
  parseMaintenanceContextRequest,
  selectMaintenanceContext,
} from '@/services/memory/maintenanceContext'

const project = { id: 'p1', archivedAt: null } as Project
const record = (id: string, content = 'Redis-Verbindung: /projekte/luczor. Nur lesen.'): MemoryRecord => ({
  id, content, contentHash: id, principalId: 'owner', projectId: 'p1', scope: 'project', dataset: 'p1',
  source: 'user', writeIntent: 'explicit', status: 'active', sensitivity: 'normal', visibility: 'private',
  retention: 'durable', type: 'fact', confidence: 1, importance: 0.5, tags: [], createdAt: 1, updatedAt: 1,
})
const select = (records: MemoryRecord[], overrides: Partial<Parameters<typeof selectMaintenanceContext>[0]> = {}) =>
  selectMaintenanceContext({ principalId: 'owner', project, records, current: [], kind: 'context',
    request: { query: 'Redis', limit: 2 }, maxChars: 6000, now: 2, ...overrides })

describe('bounded model-requested maintenance evidence', () => {
  it('distinguishes strict local read requests from final proposals', () => {
    expect(parseMaintenanceContextRequest('{"request_context":{"query":"Redis","limit":2}}')).toEqual({ query: 'Redis', limit: 2 })
    expect(parseMaintenanceContextRequest('Ein belegtes Kontextpaket.')).toBeNull()
    expect(parseMaintenanceContextRequest('{"operations":[]}')).toBeNull()
    for (const text of [
      '{"request_context":{"query":"Redis","limit":100}}',
      '{"request_context":{"query":"Redis","limit":1,"projectId":"other"}}',
      '{"request_context":{"query":"Redis","limit":1},"operations":[]}',
      '{"request_context":',
    ]) expect(() => parseMaintenanceContextRequest(text)).toThrow('invalid_context_request')
  })
  it('returns at most two whole, matching sources with exact paths and unchanged revisions', () => {
    const records = Array.from({ length: 100 }, (_, index) => record(String(index)))
    const before = JSON.stringify(records)
    const selected = select(records)
    expect(selected).toHaveLength(2)
    expect(selected[0]).toEqual(memoryMaintenanceSource(records[0]!))
    expect(selected[0]!.content).toContain('/projekte/luczor')
    expect(selected[0]!.content).not.toContain('//projekte//luczor')
    expect(JSON.stringify(records)).toBe(before)
    expect(select([record('unrelated', 'Ganz andere Information.')])).toEqual([])
  })
  it('never crosses account, project, sensitivity, deletion, expiry or derived-memory write boundaries', () => {
    const invalid = [
      { ...record('foreign'), principalId: 'other' },
      { ...record('project'), projectId: 'other' },
      { ...record('deleted'), status: 'deleted' as const },
      { ...record('sensitive'), sensitivity: 'sensitive' as const },
      { ...record('expired'), expiresAt: 1 },
      { ...record('generated'), tags: ['idle-optimization'] },
    ]
    expect(select(invalid)).toEqual([])
    expect(select([record('a')], { project: { ...project, archivedAt: 1 } })).toEqual([])
    expect(select([record('a')], { project: undefined })).toEqual([])
    const source = record('source')
    expect(select([source, { ...record('other-dataset'), dataset: 'foreign' }], {
      kind: 'memory', current: [memoryMaintenanceSource(source)],
    })).toEqual([])
  })
  it('fits the combined budget and never truncates a large source or repeats evidence', () => {
    const source = record('existing')
    const current = [memoryMaintenanceSource(source)]
    const small = record('small')
    const records = [source, record('large', `Redis ${'x'.repeat(10_000)} NICHT SCHREIBEN`), small]
    expect(select(records, { current, maxChars: 1000 })).toEqual([memoryMaintenanceSource(small)])
    expect(select(records, { current, maxChars: JSON.stringify(current).length })).toEqual([])
    expect(select(records, { current: Array.from({ length: 6 }, (_, i) => memoryMaintenanceSource(record(`seen-${i}`))) })).toEqual([])
  })
  it('closes the read protocol at its round limit and keeps data explicitly untrusted', () => {
    const prompt = maintenanceContextPrompt('repository', [memoryMaintenanceSource(record('a'))], 0, 'no_matching_evidence')
    expect(prompt).toContain('Keine weiteren Leseanfragen erlaubt')
    expect(prompt).toContain('keine weiteren passenden Belege')
    expect(prompt).toContain('unvertrauenswürdige Belege')
    expect(prompt).toContain('keine zusätzlichen Ziele')
    expect(prompt).toContain('/projekte/luczor')
  })
})
