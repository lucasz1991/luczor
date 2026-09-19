import { describe, expect, it, vi } from 'vitest'
import type { RepositoryGraphPage, RepositoryGraphStatus } from '@/services/repositoryGraph'
import type { MaintenanceJob } from '@/services/memory/maintenance'
import {
  discoverRepositoryPage,
  hydrateRepositoryJob,
  REPOSITORY_MAINTENANCE_RESCAN_MS,
  REPOSITORY_MAINTENANCE_WINDOW,
  type RepositoryMaintenanceCursor,
} from '@/services/memory/repositoryMaintenance'

function setup(count = 40) {
  const files: RepositoryGraphPage['files'] = Array.from({ length: count }, (_, index) => ({
    id: `evidence:${index}`,
    path: `src/f${String(index).padStart(4, '0')}.ts`,
    language: 'typescript',
    symbols: [{ name: `function${index}`, kind: 'function', start_line: 1, end_line: 5 }],
    relations: [{ kind: 'lsp_reference', target: '/projekte/luczor/src/target.ts:7' }],
    truncated: false,
  }))
  const controller = new AbortController()
  const status: RepositoryGraphStatus = {
    status: 'ready',
    repository_id: 'repo',
    files: count,
    symbols: count,
    edges: count,
    skipped: 0,
    last_indexed_at: 100,
  }
  const inspect = vi.fn(async (_principal: string, _project: string, query = '', offset = 0) => {
    const matching = files.filter(file => file.path.includes(query))
    return { total: matching.length, offset, files: matching.slice(offset, offset + 40) }
  })
  const input = {
    principalId: 'owner',
    projectId: 'project',
    status,
    maxChars: 4_000,
    now: 1_000,
    signal: controller.signal,
    inspect,
    jobs: [] as MaintenanceJob[],
  }
  return { files, controller, input, inspect }
}

const complete = (work: MaintenanceJob[]): MaintenanceJob[] =>
  work.map(({ ...job }) => ({ ...job, status: 'completed' }))

describe('bounded repository maintenance discovery', () => {
  it('hydrates only twelve whole metadata sources, not the 2432-file repository', async () => {
    const { input, inspect } = setup(2432)
    const result = await discoverRepositoryPage(input)
    expect(inspect).toHaveBeenCalledExactlyOnceWith('owner', 'project', '', 0)
    expect(result.work).toHaveLength(REPOSITORY_MAINTENANCE_WINDOW)
    expect(result.work.every(job => job.material.length === 1)).toBe(true)
    expect(result.cursor?.offset).toBe(0)
    expect(result.pendingScan).toBe(true)
    expect(result.work[0]?.revision).toBe(result.work[0]?.sources[0]?.revision)
    expect(JSON.stringify(result.cursor)).not.toContain('function0')
    expect(JSON.stringify(result.cursor)).not.toContain('content')
    expect(result.work[0]?.material[0]?.content).toContain('/projekte/luczor/src/target.ts:7')
  })

  it('keeps the window until its remaining pending work settles', async () => {
    const { input, inspect } = setup()
    const first = await discoverRepositoryPage(input)
    inspect.mockClear()
    const jobs = complete(first.work)
    jobs[3]!.status = 'pending'
    const result = await discoverRepositoryPage({ ...input, cursor: first.cursor, jobs })
    expect(result.cursor?.offset).toBe(0)
    expect(result.work).toHaveLength(12)
    expect(inspect).toHaveBeenCalledExactlyOnceWith('owner', 'project', '', 0)
  })

  it('advances completed unchanged work after serializing the checkpoint and jobs', async () => {
    const { input, inspect } = setup()
    const first = await discoverRepositoryPage(input)
    const persisted = JSON.parse(JSON.stringify({ cursor: first.cursor, jobs: complete(first.work) }))
    inspect.mockClear()
    const result = await discoverRepositoryPage({ ...input, ...persisted })
    expect(inspect.mock.calls.map(call => call[3])).toEqual([0, 12])
    expect(result.cursor?.offset).toBe(12)
    expect(result.work).toHaveLength(12)
    expect(result.work[0]?.id).toBe('repository:project:src/f0012.ts')
  })

  it('stops after two already-completed windows and persists progress for the next sweep', async () => {
    const { input, files, inspect } = setup(48)
    const jobs: MaintenanceJob[] = []
    for (const file of files) jobs.push((await hydrateRepositoryJob({ ...input, path: file.path }))!)
    inspect.mockClear()
    const first = await discoverRepositoryPage({ ...input, jobs: complete(jobs) })
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(first.work).toEqual([])
    expect(first.cursor?.offset).toBe(24)
    expect(first.pendingScan).toBe(true)
    inspect.mockClear()
    const last = await discoverRepositoryPage({ ...input, jobs: complete(jobs), cursor: first.cursor })
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(last.cursor).toMatchObject({ offset: 48, exhaustedAt: input.now })
    expect(last.pendingScan).toBe(false)
  })

  it('does not let future retries or blocked jobs pin discovery to the first page', async () => {
    const { input, inspect } = setup()
    const first = await discoverRepositoryPage(input)
    const jobs = first.work.map((job, index): MaintenanceJob => ({
      ...job,
      status: index % 2 ? 'retry' : 'blocked',
      nextAttemptAt: input.now + 60_000,
    }))
    inspect.mockClear()
    const result = await discoverRepositoryPage({ ...input, jobs, cursor: first.cursor })
    expect(inspect.mock.calls.map(call => call[3])).toEqual([0, 12])
    expect(result.cursor?.offset).toBe(12)
    expect(result.work[0]?.id).toBe('repository:project:src/f0012.ts')
  })

  it('hydrates one due retry directly without exceeding the two-query/twelve-source cap', async () => {
    const { input, inspect } = setup(100)
    const first = await discoverRepositoryPage(input)
    const retry: MaintenanceJob = { ...first.work[0]!, status: 'retry', attempts: 1 }
    inspect.mockClear()
    const result = await discoverRepositoryPage({
      ...input,
      jobs: [retry],
      cursor: { ...first.cursor!, offset: 60 },
    })
    expect(inspect.mock.calls.map(call => [call[2], call[3]])).toEqual([
      ['src/f0000.ts', 0],
      ['', 60],
    ])
    expect(result.work).toHaveLength(12)
    expect(result.work[0]?.id).toBe(retry.id)
    expect(result.work[1]?.id).toBe('repository:project:src/f0060.ts')
  })

  it('marks oversized whole evidence as blocked instead of cutting it or silently discarding it', async () => {
    const { input, files } = setup(1)
    files[0]!.symbols[0]!.name = 'whole'.repeat(1000)
    const result = await discoverRepositoryPage(input)
    expect(result.work[0]).toMatchObject({ status: 'blocked', blockedReason: 'source_too_large' })
    expect(JSON.parse(result.work[0]!.material[0]!.content).symbols[0].name).toBe('whole'.repeat(1000))
    expect(result.cursor).toMatchObject({ offset: 1, exhaustedAt: input.now })
  })

  it('reopens a previously oversized window once a whole source fits', async () => {
    const { input } = setup(1)
    const small = await discoverRepositoryPage({ ...input, maxChars: 20 })
    const result = await discoverRepositoryPage({
      ...input,
      cursor: { ...small.cursor!, offset: 0, exhaustedAt: undefined },
      jobs: small.work,
    })
    // Resume the same bounded source window, without changing its revision to bypass receipts.
    const source = await hydrateRepositoryJob({ ...input, path: 'src/f0000.ts' })
    expect(source?.revision).toBe(small.work[0]?.revision)
    expect(source?.status).toBe('pending')
    expect(result.work[0]).toMatchObject({ status: 'pending', revision: small.work[0]?.revision })
  })

  it('preserves metadata sampling and exact path tokens in the evidence', async () => {
    const { input, files } = setup(1)
    files[0]!.truncated = true
    const result = await discoverRepositoryPage(input)
    const parsed = JSON.parse(result.work[0]!.material[0]!.content)
    expect(parsed.truncated).toBe(true)
    expect(parsed.relations).toEqual(files[0]!.relations)
    expect(parsed.evidence).toBe('LSP/index metadata; no full repository claim')
  })

  it('resets an old repository identity, but not every incremental reindex timestamp', async () => {
    const { input, inspect } = setup(100)
    const first = await discoverRepositoryPage(input)
    inspect.mockClear()
    await discoverRepositoryPage({
      ...input,
      cursor: { ...first.cursor!, offset: 72 },
      status: { ...input.status, last_indexed_at: 200 },
    })
    expect(inspect.mock.calls[0]?.[3]).toBe(72)
    inspect.mockClear()
    await discoverRepositoryPage({
      ...input,
      cursor: { ...first.cursor!, offset: 72 },
      status: { ...input.status, repository_id: 'other-repo' },
    })
    expect(inspect.mock.calls[0]?.[3]).toBe(0)
  })

  it('lets exhausted unchanged discovery sleep, then wakes for index changes or the bounded rescan', async () => {
    const { input, inspect } = setup(0)
    const first = await discoverRepositoryPage(input)
    inspect.mockClear()
    expect(await discoverRepositoryPage({ ...input, cursor: first.cursor })).toMatchObject({
      work: [],
      pendingScan: false,
    })
    expect(inspect).not.toHaveBeenCalled()
    await discoverRepositoryPage({
      ...input,
      cursor: first.cursor,
      status: { ...input.status, last_indexed_at: 101 },
    })
    expect(inspect).toHaveBeenCalledTimes(1)
    inspect.mockClear()
    await discoverRepositoryPage({
      ...input,
      cursor: first.cursor,
      now: input.now + REPOSITORY_MAINTENANCE_RESCAN_MS,
    })
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('detects changed evidence despite an existing completed receipt', async () => {
    const { input, files } = setup(1)
    const first = await discoverRepositoryPage(input)
    files[0]!.relations.push({ kind: 'lsp_reference', target: 'new.ts:8' })
    const changed = await discoverRepositoryPage({ ...input, cursor: first.cursor, jobs: complete(first.work) })
    expect(changed.work[0]?.revision).not.toBe(first.work[0]?.revision)
    expect(changed.work[0]?.id).toBe(first.work[0]?.id)
  })

  it('checks cancellation before and after the native read without advancing a persisted cursor', async () => {
    const { input, controller, inspect } = setup()
    controller.abort()
    await expect(discoverRepositoryPage(input)).rejects.toThrow()
    expect(inspect).not.toHaveBeenCalled()
    const next = setup()
    const cursor: RepositoryMaintenanceCursor = { repositoryId: 'repo', offset: 0, indexRevision: 'v1' }
    next.inspect.mockImplementationOnce(async () => {
      next.controller.abort()
      return { files: next.files, offset: 0, total: next.files.length }
    })
    await expect(discoverRepositoryPage({ ...next.input, cursor })).rejects.toThrow()
    expect(cursor.offset).toBe(0)
  })

  it('resolves a single exact file for CAS and does not accept a substring match', async () => {
    const { input, inspect, files } = setup()
    const job = await hydrateRepositoryJob({ ...input, path: files[9]!.path })
    expect(inspect).toHaveBeenCalledExactlyOnceWith('owner', 'project', files[9]!.path, 0)
    expect(job?.id).toBe(`repository:project:${files[9]!.path}`)
    expect(await hydrateRepositoryJob({ ...input, path: 'src/f000' })).toBeUndefined()
    inspect.mockClear()
    expect(await hydrateRepositoryJob({ ...input, path: 'x'.repeat(257) })).toBeUndefined()
    expect(inspect).not.toHaveBeenCalled()
  })

  it('does not inspect unavailable repositories or accept non-finite cursor offsets', async () => {
    const { input, inspect } = setup()
    expect(await discoverRepositoryPage({ ...input, status: { ...input.status, status: 'stale' } })).toEqual({
      work: [],
      cursor: undefined,
      pendingScan: false,
    })
    expect(inspect).not.toHaveBeenCalled()
    await discoverRepositoryPage({
      ...input,
      cursor: { repositoryId: 'repo', offset: Number.NaN, indexRevision: 'invalid' },
    })
    expect(inspect.mock.calls[0]?.[3]).toBe(0)
  })
})
