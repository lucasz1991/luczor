import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/state/types'
import { emptyMaintenanceJournal, type MaintenanceJournal } from '@/services/memory/maintenance'
import { planMaintenance } from '@/services/memory/maintenancePlanner'
import { buildScopedContextPackage, type ScopedContextFragment } from '@/services/inference/contextBroker'
const fixture = vi.hoisted(() => ({
  projects: [] as Project[],
  messages: [],
  journal: null as MaintenanceJournal | null,
  account: vi.fn(),
}))
vi.mock('@/state/store', () => ({ state: fixture }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: fixture.account }))
vi.mock('@/services/memory/luczorMemory', () => ({
  luczorMemory: {
    maintenanceSnapshot: async () => ({ journal: fixture.journal, records: [] }),
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
