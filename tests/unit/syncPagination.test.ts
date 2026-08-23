import { describe, expect, it, vi } from 'vitest'
import { collectSyncPullPages, type SyncContinuation, type SyncPullResponse } from '@/services/api/luczorApi'

const continuation = (suffix: string, hasMore = true): SyncContinuation => ({
  projects: { has_more: hasMore, cursor: `projects-${suffix}` },
  messages: { has_more: false, cursor: `messages-${suffix}` },
  memories: { has_more: false, cursor: `memories-${suffix}` },
  summaries: { has_more: false, cursor: `summaries-${suffix}` },
})

const page = (suffix: string, hasMore: boolean, projects: unknown[] = []): SyncPullResponse => ({
  data: { projects, messages: [], memories: [], summaries: [] },
  cursor: `legacy-${suffix}`,
  has_more: hasMore,
  continuation: continuation(suffix, hasMore),
})

describe('sync snapshot pagination', () => {
  it('passes every opaque bucket cursor and returns only the final legacy cursor', async () => {
    const pull = vi
      .fn()
      .mockResolvedValueOnce(page('one', true, [{ id: 1 }]))
      .mockResolvedValueOnce(page('two', false, [{ id: 2 }]))

    const result = await collectSyncPullPages(pull, { since: '2026-08-01T00:00:00Z', limit: 100 })

    expect(pull).toHaveBeenNthCalledWith(1, {
      since: '2026-08-01T00:00:00Z',
      limit: 100,
      cursors: undefined,
    })
    expect(pull).toHaveBeenNthCalledWith(2, {
      since: '2026-08-01T00:00:00Z',
      limit: 100,
      cursors: {
        projects: 'projects-one',
        messages: 'messages-one',
        memories: 'memories-one',
        summaries: 'summaries-one',
      },
    })
    expect(result.cursor).toBe('legacy-two')
    expect(result.data.projects).toEqual([{ id: 1 }, { id: 2 }])
    expect(result).toMatchObject({ pages: 2, item_count: 2, has_more: false })
  })

  it('fails closed when a continuation token is missing', async () => {
    const invalid = page('one', true)
    invalid.continuation.messages.cursor = ''

    await expect(collectSyncPullPages(async () => invalid)).rejects.toThrow(/messages continuation cursor/i)
  })

  it('stops repeated continuations and bounded pagination', async () => {
    const repeated = page('same', true)
    await expect(collectSyncPullPages(async () => repeated)).rejects.toThrow(/repeated/i)

    let sequence = 0
    await expect(collectSyncPullPages(async () => page(String(sequence++), true), { maxPages: 2 })).rejects.toThrow(
      /page limit/i
    )
  })
})
