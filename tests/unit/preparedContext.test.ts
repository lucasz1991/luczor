import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/state/types'
import { emptyMaintenanceJournal, maintenanceBatchChars, type MaintenanceJournal } from '@/services/memory/maintenance'
import type { MemoryRecord } from '@/services/memory/luczorMemory'
import { planMaintenance } from '@/services/memory/maintenancePlanner'
import { buildScopedContextPackage, type ScopedContextFragment } from '@/services/inference/contextBroker'
const fixture = vi.hoisted(() => ({
  projects: [] as Project[],
  messages: [],
  records: [] as MemoryRecord[],
  journal: null as MaintenanceJournal | null,
  account: vi.fn(),
}))
vi.mock('@/state/store', () => ({ state: fixture }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: fixture.account }))
vi.mock('@/services/memory/luczorMemory', () => ({
  luczorMemory: {
    maintenanceSnapshot: async () => ({ journal: fixture.journal, records: fixture.records }),
  },
}))
vi.mock('@/services/repositoryGraph', () => ({
  inspectRepositoryGraph: vi.fn(),
  readRepositorySnippets: vi.fn(),
  repositoryGraphStatus: vi.fn(),
}))
import { preparedContextFragments } from '@/services/memory/preparedContext'
beforeEach(async () => {
  fixture.account.mockReset().mockResolvedValue({ principalId: 'owner', serverInstance: 'server' })
  fixture.projects = [
    { id: 'p1', name: 'Elbe', summary: 'Nur lesen', goals: [], archivedAt: null } as unknown as Project,
  ]
  fixture.journal = emptyMaintenanceJournal()
  fixture.records = []
  const [job] = await planMaintenance({ principalId: 'owner', projects: fixture.projects, records: [], now: 1 })
  fixture.journal.artifacts = [
    {
      id: job!.id,
      projectId: 'p1',
      revision: job!.revision,
      kind: 'context',
      content: 'Elbe: Nur lesen. Quelle project:p1.',
      createdAt: 1,
      modelId: 'local',
      sources: job!.sources,
      localOnly: true,
    },
  ]
})

async function prepareSmallBatches() {
  fixture.records = Array.from({ length: 6 }, (_, index): MemoryRecord => ({
    id: `source-${index}`,
    principalId: 'owner',
    projectId: 'p1',
    scope: 'project',
    dataset: 'project',
    content: `Beleg ${index}: Nur lesen. ${'Hintergrund. '.repeat(140)}`,
    contentHash: `hash-${index}`,
    type: 'fact',
    visibility: 'private',
    status: 'active',
    retention: 'durable',
    sensitivity: 'normal',
    writeIntent: 'explicit',
    importance: 0.5,
    confidence: 1,
    source: 'user',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  }))
  const input = { principalId: 'owner', projects: fixture.projects, records: fixture.records, now: 1 }
  const generated = (await planMaintenance({ ...input, maxBatchChars: maintenanceBatchChars(4096) })).filter(job =>
    job.id.startsWith('context:')
  )
  const retrieval = (await planMaintenance(input)).filter(job => job.id.startsWith('context:'))
  expect(generated).toHaveLength(3)
  expect(retrieval).toHaveLength(1)
  expect(generated[0]!.revision).not.toBe(retrieval[0]!.revision)
  expect(retrieval.some(job => job.id === generated[1]!.id)).toBe(false)
  fixture.journal!.artifacts = generated.map(job => ({
    id: job.id,
    projectId: job.projectId,
    revision: job.revision,
    kind: 'context',
    content: `Nur lesen. Quellen ${job.sources.map(source => source.id).join(', ')}.`,
    createdAt: 1,
    modelId: 'local',
    sources: job.sources,
    localOnly: true,
  }))
  return generated
}
describe('prepared orientation and fallback boundaries', () => {
  it('uses current context as attributed local-only untrusted data', async () => {
    expect(await preparedContextFragments('p1', 'Elbe')).toEqual([
      expect.objectContaining({
        id: 'prepared:project:p1',
        egress: 'local_only',
        trust: 'untrusted_data',
        content: expect.stringContaining('Nur lesen'),
      }),
    ])
  })
  it('omits stale, deleted and inaccessible source projects without generating anything', async () => {
    fixture.projects[0]!.summary = 'Nicht mehr lesen'
    expect(await preparedContextFragments('p1', 'Elbe')).toEqual([])
    fixture.projects = []
    expect(await preparedContextFragments('p1', 'Elbe')).toEqual([])
  })
  it('never delivers an artifact after an account switch', async () => {
    fixture.account.mockResolvedValueOnce({ principalId: 'owner' }).mockResolvedValueOnce({ principalId: 'other' })
    expect(await preparedContextFragments('p1', 'Elbe')).toEqual([])
  })
  it('retrieves unchanged source-bound artifacts regardless of the generation batch budget', async () => {
    const generated = await prepareSmallBatches()
    expect((await preparedContextFragments('p1', 'lesen')).map(fragment => fragment.id)).toEqual(
      generated.map(job => `prepared:${job.id}`)
    )
  })
  it.each(['changed', 'deleted', 'superseded', 'sensitive', 'expired', 'foreign'] as const)(
    'invalidates a small-batch artifact when any source is %s, without dropping unaffected batches',
    async change => {
      const generated = await prepareSmallBatches()
      const source = fixture.records[0]!
      if (change === 'changed') {
        source.content = 'Schreiben erlaubt.'
        source.contentHash = 'updated'
        source.updatedAt = 2
      } else if (change === 'deleted') fixture.records.shift()
      else if (change === 'superseded') source.status = 'superseded'
      else if (change === 'sensitive') source.sensitivity = 'sensitive'
      else if (change === 'expired') source.expiresAt = 1
      else source.principalId = 'other'
      expect((await preparedContextFragments('p1', 'lesen')).map(fragment => fragment.id)).toEqual(
        generated.slice(1).map(job => `prepared:${job.id}`)
      )
    }
  )
  it('requires every source, the original binding hash and the original project scope', async () => {
    await prepareSmallBatches()
    fixture.journal!.artifacts[0]!.sources = []
    fixture.journal!.artifacts[1]!.revision = 'unbound'
    fixture.journal!.artifacts[2]!.projectId = undefined
    expect(await preparedContextFragments('p1', 'lesen')).toEqual([])
  })
  it('includes an artifact whole or omits it, never cuts off its final restriction', async () => {
    const scopeKey = {
      principalId: 'owner',
      serverInstance: 'server',
      projectId: 'p1',
      sessionId: 's1',
      taskType: 'chat.general',
    }
    const fragment: ScopedContextFragment = {
      id: 'prepared:project:p1',
      source: 'memory',
      trust: 'untrusted_data',
      scope: scopeKey,
      sensitivity: 'normal',
      lifecycle: 'active',
      audiences: ['local_model'],
      egress: 'local_only',
      contentHash: 'hash',
      content: `${'Belegte Orientierung. '.repeat(100)}NICHT SCHREIBEN.`,
    }
    const included = await buildScopedContextPackage({ scopeKey, target: 'local_llama_cpp', fragments: [fragment] })
    expect(included.text).toContain('NICHT SCHREIBEN.')
    const omitted = await buildScopedContextPackage({
      scopeKey,
      target: 'local_llama_cpp',
      fragments: [fragment],
      budget: { maxChars: 1000 },
    })
    expect(omitted.selected).toEqual([])
    expect(omitted.omitted).toContainEqual({ id: fragment.id, reason: 'budget' })
    const external = await buildScopedContextPackage({ scopeKey, target: 'laravel_proxy', fragments: [fragment] })
    expect(external.selected).toEqual([])
  })
})
