import { describe, expect, it, vi } from 'vitest'
import {
  chooseMaintenanceJob,
  emptyMaintenanceJournal,
  reconcileMaintenanceJobs,
  failMaintenanceJob,
  parseMemoryChangeSet,
  parseMemoryAnnotation,
  parseMaintenanceVerification,
  assertPreservedReferences,
  MAINTENANCE_BATCH_CHARS,
  maintenanceBatchChars,
  partitionMaintenanceSources,
  maintenancePrompt,
  verificationPrompt,
  type MaintenanceJob,
} from '@/services/memory/maintenance'
import { matchesEvaluationAnswer, MAINTENANCE_EVALUATION } from '@/services/memory/maintenanceEvaluation'
import { planMaintenance } from '@/services/memory/maintenancePlanner'
import type { Message, Project } from '@/state/types'
import { luczorMemory, type MemoryRecord } from '@/services/memory/luczorMemory'
import { sqlMemoryMaintenanceAdapter } from '@/services/memory/maintenanceAdapters'
import { applyMemoryAnnotation, captureMemoryMetadata } from '@/services/memory/memoryMetadata'

const job = (id: string, projectId = 'active'): MaintenanceJob => ({
  id,
  projectId,
  kind: 'context',
  revision: 'v1',
  sources: [],
  status: 'pending',
  attempts: 0,
  nextAttemptAt: 0,
  updatedAt: 0,
})
const sources = [
  {
    id: 'a',
    revision: 'v1',
    kind: 'memory' as const,
    content: 'Nur repo.search auf src/main.ts, Port 8080. Nicht schreiben.',
  },
]
describe('durable maintenance policy', () => {
  const memory = (id: string, patch: Partial<MemoryRecord> = {}): MemoryRecord => ({
    id,
    principalId: 'owner',
    scope: 'user',
    dataset: 'user',
    content: 'Laravel bleibt unbestätigt.',
    contentHash: 'hash',
    type: 'fact',
    source: 'assistant',
    writeIntent: 'inferred',
    status: 'candidate',
    visibility: 'private',
    retention: 'durable',
    sensitivity: 'normal',
    confidence: 0.3,
    importance: 0.5,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  })

  it('wraps one strict model classification in a host-owned annotation without invented IDs or body', () => {
    const metadata = { kind: 'hypothesis', interest: null, categories: [['Software', 'Laravel']], tags: ['Laravel'] }
    expect(parseMemoryAnnotation(JSON.stringify(metadata), sources)).toEqual({
      operations: [
        {
          operation: 'annotate',
          targets: ['a'],
          sources: ['a'],
          content: '',
          reason: 'Klassifikation der Originalquelle',
          metadata,
        },
      ],
    })
    expect(parseMemoryAnnotation('{}', sources).operations[0]!.metadata).toEqual({})
    for (const value of [
      { operations: [] },
      { ...metadata, content: 'Invented body' },
      { ...metadata, targets: ['fabricated'] },
      { ...metadata, reason: 'Invented repeated user activity' },
      { ...metadata, evidence: { status: 'source_backed' } },
      { ...metadata, files: ['fake.php'] },
      [metadata],
    ])
      expect(() => parseMemoryAnnotation(JSON.stringify(value), sources)).toThrow()
    expect(() => parseMemoryAnnotation('```json\n{}\n```', sources)).toThrow()
    expect(() => parseMemoryAnnotation('{}', [])).toThrow('invalid_annotation_source')
    expect(() => parseMemoryAnnotation('{}', [sources[0]!, { ...sources[0]!, id: 'b' }])).toThrow(
      'invalid_annotation_source'
    )
  })

  it('reviews the exact classification against originals without presenting an empty replacement body', () => {
    const changes = parseMemoryAnnotation('{"kind":"hypothesis","interest":null}', sources)
    const prompt = verificationPrompt(sources, JSON.stringify(changes), 'metadata')
    const [originals, classification] = prompt.split('\nORIGINALQUELLEN:\n')[1]!.split('\nKLASSIFIKATION:\n')
    expect(JSON.parse(originals!)).toEqual(sources)
    expect(JSON.parse(classification!)).toEqual([{ sourceId: 'a', metadata: changes.operations[0]!.metadata }])
    expect(prompt).toContain('Es wird kein Text ersetzt oder gelöscht')
    expect(prompt).toContain('overrides')
    expect(prompt).toContain('erfundenem Nutzerinteresse')
    expect(prompt).not.toContain('"content":""')
    expect(() =>
      parseMaintenanceVerification(
        JSON.stringify({
          approved: true,
          checkedSources: ['a'],
          unsupportedFacts: true,
          lostFacts: false,
          lostConstraints: false,
          temporalConflict: false,
        }),
        sources
      )
    ).toThrow('verification_rejected')
  })

  it('accepts metadata-only annotations and rejects body edits, trust claims and foreign sources', () => {
    const operation = {
      operation: 'annotate',
      targets: ['a'],
      sources: ['a'],
      content: '',
      reason: 'Find by topic',
      metadata: { kind: 'hypothesis', categories: [['Software', 'Laravel']], importance: 0.4 },
    }
    expect(parseMemoryChangeSet(JSON.stringify({ operations: [operation] }), sources).operations[0]).toMatchObject(
      operation
    )
    for (const patch of [
      { content: 'Promoted fact' },
      { sources: [] },
      { targets: [] },
      { metadata: { evidence: { status: 'source_backed' } } },
      { metadata: { files: ['fake.php'] } },
    ])
      expect(() =>
        parseMemoryChangeSet(JSON.stringify({ operations: [{ ...operation, ...patch }] }), sources)
      ).toThrow()
    expect(() => parseMemoryChangeSet(JSON.stringify({ operations: [operation, operation] }), sources)).toThrow(
      'overlapping_targets'
    )
  })

  it('plans single-record metadata for assistant candidates and derived records without rewriting them', async () => {
    const records = [
      memory('assistant'),
      memory('derived', { tags: ['maintenance-derived', 'idle-optimization'] }),
      memory('sensitive', { sensitivity: 'sensitive' }),
      memory('old', { status: 'superseded' }),
      memory('expired', { expiresAt: 2 }),
      memory('foreign', { principalId: 'other' }),
    ]
    const jobs = await planMaintenance({ principalId: 'owner', projects: [], records, now: 10 })
    expect(jobs.filter(item => item.kind === 'metadata').map(item => item.sources.map(source => source.id))).toEqual([
      ['assistant'],
      ['derived'],
    ])
    expect(jobs.filter(item => item.kind === 'memory')).toHaveLength(0)
    const proposal = maintenancePrompt('metadata', jobs[0]!.material)
    expect(proposal).toContain('Nutzerwerte niemals ersetzen')
    expect(proposal).toContain('assistant')
    expect(proposal).toContain('candidate')
  })

  it('preserves metadata in source packets and does not queue its own completed classification again', async () => {
    const record = memory('stable')
    record.meta = {
      memory_metadata: captureMemoryMetadata({ ...record, classification: { categories: [['Software', 'Laravel']] } }),
    }
    const before = (await planMaintenance({ principalId: 'owner', projects: [], records: [record], now: 10 }))[0]!
    expect(JSON.parse(before.material[0]!.content).metadata.categories[0].path).toEqual(['Software', 'Laravel'])
    Object.assign(
      record,
      applyMemoryAnnotation(
        record,
        { kind: 'hypothesis', tags: ['Laravel'] },
        { origin: 'dream', now: 11, modelId: 'local' }
      )
    )
    expect(
      (await planMaintenance({ principalId: 'owner', projects: [], records: [record], now: 12 })).filter(
        item => item.kind === 'metadata'
      )
    ).toHaveLength(0)
    record.contentHash = 'changed'
    expect(
      (await planMaintenance({ principalId: 'owner', projects: [], records: [record], now: 13 })).filter(
        item => item.kind === 'metadata'
      )
    ).toHaveLength(1)
  })

  it('uses server metadata eligibility independently of destructive rewrite eligibility', async () => {
    const shared = vi.spyOn(luczorMemory, 'sharedMaintenance').mockResolvedValue({
      next: null,
      records: [
        {
          id: '1',
          revision: 'a'.repeat(64),
          content: 'Laravel bleibt unbestätigt.',
          source: 'assistant',
          scope: 'user',
          confidence: 0.3,
          metadata_needed: true,
          rewrite_eligible: false,
          metadata: { kind: 'hypothesis' },
          tags: ['Laravel'],
          importance: 0.5,
          provenance: { source_type: 'assistant' },
        },
        {
          id: '2',
          revision: 'b'.repeat(64),
          content: 'Bereits eingeordnet.',
          source: 'user',
          scope: 'user',
          confidence: 1,
          metadata_needed: false,
          rewrite_eligible: true,
        },
      ],
    })
    try {
      const jobs = await sqlMemoryMaintenanceAdapter.jobs('owner', undefined, new AbortController().signal)
      expect(jobs.filter(job => job.kind === 'metadata').map(job => job.sources.map(source => source.id))).toEqual([
        ['1'],
      ])
      expect(jobs.filter(job => job.kind === 'memory').flatMap(job => job.sources.map(source => source.id))).toEqual([
        '2',
      ])
      expect(JSON.parse(jobs.find(job => job.kind === 'metadata')!.material[0]!.content)).toMatchObject({
        metadata: { kind: 'hypothesis' },
        tags: ['Laravel'],
        provenance: { source_type: 'assistant' },
      })
    } finally {
      shared.mockRestore()
    }
  })
  it('keeps completed revisions across serialization and ignores runtime identity', () => {
    const journal = emptyMaintenanceJournal()
    journal.jobs = [{ ...job('a'), status: 'completed' }]
    const restarted = JSON.parse(JSON.stringify(journal))
    reconcileMaintenanceJobs(restarted, [job('a')], 100)
    expect(chooseMaintenanceJob(restarted, 'active', 100)).toBeUndefined()
    reconcileMaintenanceJobs(restarted, [{ ...job('a'), revision: 'v2' }], 100)
    expect(chooseMaintenanceJob(restarted, 'active', 100)?.revision).toBe('v2')
  })
  it('serves another project after at most three active-project jobs', () => {
    const journal = emptyMaintenanceJournal()
    journal.jobs = [job('a'), job('b'), job('c'), job('d'), job('other', 'other')]
    expect(Array.from({ length: 4 }, () => chooseMaintenanceJob(journal, 'active', 0)?.id)).toEqual([
      'a',
      'b',
      'c',
      'other',
    ])
  })
  it('recovers a crashed claim and bounds retries with increasing backoff', () => {
    const journal = emptyMaintenanceJournal()
    journal.jobs = [{ ...job('a'), status: 'running' }]
    reconcileMaintenanceJobs(journal, [job('a')], 10)
    expect(journal.jobs[0]?.status).toBe('retry')
    failMaintenanceJob(journal, 'a', 'v1', true, 10)
    expect(journal.jobs[0]?.attempts).toBe(0)
    for (let attempt = 0; attempt < 3; attempt++) failMaintenanceJob(journal, 'a', 'v1', false, 10)
    expect(journal.jobs[0]).toMatchObject({ attempts: 3, status: 'blocked' })
  })
  it('rejects invented sources and overlapping destructive targets', () => {
    const operation = { operation: 'rewrite', targets: ['a'], sources: ['fake'], content: 'Text', reason: 'Beleg' }
    expect(() => parseMemoryChangeSet(JSON.stringify({ operations: [operation] }), sources)).toThrow(
      'fabricated_source'
    )
    operation.sources = ['a']
    expect(() => parseMemoryChangeSet(JSON.stringify({ operations: [operation, operation] }), sources)).toThrow(
      'overlapping_targets'
    )
  })
  it('requires explicit booleans and review of every source', () => {
    const review = {
      approved: true,
      checkedSources: ['a'],
      unsupportedFacts: false,
      lostFacts: false,
      lostConstraints: false,
      temporalConflict: false,
    }
    expect(parseMaintenanceVerification(JSON.stringify(review), sources).approved).toBe(true)
    for (const violation of ['unsupportedFacts', 'lostFacts', 'lostConstraints', 'temporalConflict']) {
      expect(() => parseMaintenanceVerification(JSON.stringify({ ...review, [violation]: true }), sources)).toThrow(
        'verification_rejected'
      )
    }
    expect(() => parseMaintenanceVerification(JSON.stringify({ ...review, checkedSources: [] }), sources)).toThrow(
      'incomplete_verification'
    )
    expect(() => parseMaintenanceVerification(JSON.stringify({ ...review, approved: 'true' }), sources)).toThrow(
      'invalid_verification'
    )
  })
  it('preserves exact tool, file and numeric references regardless of model confidence', () => {
    expect(() => assertPreservedReferences(sources, 'repo.search src/main.ts Port 8080')).not.toThrow()
    expect(() => assertPreservedReferences(sources, 'Suche im Repository.')).toThrow('lost_reference')
  })
  it('lets a context package condense but never invent paths or identifiers', () => {
    const summary = [
      {
        ...sources[0]!,
        content: JSON.stringify({ text: 'repo.search in src/main.ts auf Port 8080, 534 Tests.', at: 1 }),
      },
    ]
    expect(() => assertPreservedReferences(summary, 'Suche im Repository über src/main.ts.', 'summary')).not.toThrow()
    expect(() => assertPreservedReferences(summary, 'Nutzt src/other.ts und api.fetch.', 'summary')).toThrow(
      'fabricated_reference'
    )
    expect(() => assertPreservedReferences(summary, 'Suche im Repository.', 'preserve')).toThrow('lost_reference')
    expect(() =>
      parseMaintenanceVerification(
        JSON.stringify({
          approved: true,
          checkedSources: [summary[0]!.id],
          unsupportedFacts: false,
          lostFacts: true,
          lostConstraints: false,
          temporalConflict: false,
        }),
        summary,
        { summary: true }
      )
    ).not.toThrow()
  })
  it('sizes maintenance batches to the resident context window', () => {
    expect(maintenanceBatchChars(undefined)).toBe(MAINTENANCE_BATCH_CHARS)
    expect(maintenanceBatchChars(32_768)).toBe(MAINTENANCE_BATCH_CHARS)
    expect(maintenanceBatchChars(4_096)).toBe(5_320)
    expect(maintenanceBatchChars(2_048)).toBe(2_500)
    const material = Array.from({ length: 4 }, (_, index) => ({
      ...sources[0]!,
      id: String(index),
      content: 'x'.repeat(2000),
    }))
    expect(partitionMaintenanceSources(material, 6, 5_320).map(batch => batch.length)).toEqual([2, 2])
  })
  it('compares exact answers and does not accept a persuasive model self-grade', () => {
    expect(MAINTENANCE_EVALUATION.length).toBeGreaterThanOrEqual(8)
    expect(matchesEvaluationAnswer('{"answer":"SQLite"}', 'SQLite')).toBe(true)
    expect(matchesEvaluationAnswer('{"approved":true,"confidence":1}', 'SQLite')).toBe(false)
    expect(matchesEvaluationAnswer('{"answer":"MySQL"}', 'SQLite')).toBe(false)
  })
  it('packs large sources intact instead of losing a whole fixed-size batch', () => {
    const material = Array.from({ length: 6 }, (_, index) => ({
      ...sources[0]!,
      id: String(index),
      content: 'x'.repeat(5500),
    }))
    const batches = partitionMaintenanceSources(material)
    expect(batches).toHaveLength(3)
    expect(batches.flat()).toEqual(material)
    expect(batches.every(batch => JSON.stringify(batch).length <= 15000)).toBe(true)
  })
  it('preserves semantic references but does not force storage timestamps into the rewritten text', () => {
    expect(() =>
      assertPreservedReferences(
        [
          {
            ...sources[0]!,
            content: JSON.stringify({ text: 'Port 8080, src/main.ts und repo.search.', at: 99999999 }),
          },
        ],
        'Port 8080, src/main.ts und repo.search.'
      )
    ).not.toThrow()
  })
  it('plans only accessible, nonarchived projects and completed visible chat turns', async () => {
    const project = { id: 'p1', name: 'Elbe', goals: [], archivedAt: null } as unknown as Project
    const message = (id: string, role: Message['role'], ts: number, loading = false): Message => ({
      id,
      projectId: 'p1',
      conversationId: 'chat',
      role,
      ts,
      createdAt: ts,
      content: `Text ${id}`,
      parsed: null,
      visibility: 'visible',
      raw: 'PRIVATE REASONING',
      meta: { isLoading: loading },
    })
    const messages = [
      message('user', 'user', 1),
      message('answer', 'assistant', 2),
      message('next', 'user', 3),
      message('loading', 'assistant', 4, true),
    ]
    const jobs = await planMaintenance({
      principalId: 'owner',
      records: [],
      now: 10,
      messages,
      projects: [
        project,
        { ...project, id: 'archived', archivedAt: 4 },
        { ...project, id: 'foreign', cloud: { principalId: 'other' } as Project['cloud'] },
      ],
    })
    expect(jobs.every(item => item.projectId === 'p1')).toBe(true)
    const chat = jobs.find(item => item.id.startsWith('chat:'))!
    expect(chat.sources.map(source => source.id)).toEqual(['user', 'answer'])
    expect(JSON.stringify(jobs)).not.toContain('PRIVATE REASONING')
    const revised = await planMaintenance({
      principalId: 'owner',
      records: [],
      now: 10,
      projects: [project],
      messages: messages.map(item => (item.id === 'answer' ? { ...item, meta: { userFeedback: 'down' } } : item)),
    })
    expect(revised.find(item => item.id === chat.id)?.revision).not.toBe(chat.revision)
  })
  it('retains offline receipts and exposes oversized evidence as blocked without truncating it', async () => {
    const journal = emptyMaintenanceJournal()
    journal.jobs = [{ ...job('offline'), status: 'completed' }]
    reconcileMaintenanceJobs(journal, [], 10)
    expect(journal.jobs[0]?.status).toBe('completed')
    const oversized = await planMaintenance({
      principalId: 'owner',
      records: [],
      now: 10,
      projects: [{ id: 'large', name: 'Large', summary: 'x'.repeat(16000) } as Project],
    })
    reconcileMaintenanceJobs(journal, oversized, 10)
    expect(journal.jobs.find(item => item.id === 'project:large')).toMatchObject({
      status: 'blocked',
      blockedReason: 'source_too_large',
    })
    expect(chooseMaintenanceJob(journal, 'large', 10)).toBeUndefined()
  })
})
