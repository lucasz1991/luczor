import { describe, expect, it, vi } from 'vitest'
import { ScopedPreparationCache, type PreparationScope } from '@/services/inference/scopedPreparationCache'

const scope: PreparationScope = {
  principalId: 'account-a',
  serverInstance: 'server-a',
  projectId: 'project-a',
  sessionId: 'renderer-a',
  generation: 1,
  workspaceRevision: 'workspace-a',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('scoped background context cache', () => {
  it('retains finite lifetime and entry bounds even for invalid numeric configuration', async () => {
    let now = 0
    const cache = new ScopedPreparationCache<string>({ maxEntries: Number.NaN, maxAgeMs: Number.NaN, now: () => now })
    for (let index = 0; index < 5; index++) await cache.prepare(scope, String(index), async () => String(index))
    expect(cache.get(scope, '0')).toBeUndefined()
    expect(cache.get(scope, '4')).toBe('4')
    now = 45_000
    expect(cache.get(scope, '4')).toBeUndefined()
  })
  it('shares an in-flight preparation and returns independent copies to every consumer', async () => {
    const cache = new ScopedPreparationCache<{ fragments: string[] }>()
    const pending = deferred<{ fragments: string[] }>()
    const producer = vi.fn(() => pending.promise)
    const first = cache.prepare(scope, 'project-memory-policy-v1', producer)
    const second = cache.prepare(scope, 'project-memory-policy-v1', producer)
    await Promise.resolve()
    expect(producer).toHaveBeenCalledOnce()
    const source = { fragments: ['safe-source'] }
    pending.resolve(source)
    const [left, right] = await Promise.all([first, second])
    left.fragments.push('consumer-edit')
    source.fragments.push('producer-edit')
    expect(right).toEqual({ fragments: ['safe-source'] })
    expect(cache.get(scope, 'project-memory-policy-v1')).toEqual(right)
  })

  it.each([
    ['principalId', 'account-b'],
    ['serverInstance', 'server-b'],
    ['projectId', 'project-b'],
    ['sessionId', 'renderer-b'],
    ['generation', 2],
    ['workspaceRevision', 'workspace-b'],
  ] as const)('rejects late results after changing %s', async (field, value) => {
    const cache = new ScopedPreparationCache<string>()
    const pending = deferred<string>()
    let producerSignal!: AbortSignal
    const previous = cache.prepare(scope, 'v1', signal => {
      producerSignal = signal
      return pending.promise
    })
    const rejected = previous.catch(error => error)
    await Promise.resolve()
    const replacement = { ...scope, [field]: value }
    await expect(cache.prepare(replacement, 'v1', async () => 'new')).resolves.toBe('new')
    expect(producerSignal.aborted).toBe(true)
    pending.resolve('private-old-result')
    expect(await rejected).toMatchObject({ name: 'AbortError' })
    expect(cache.get(scope, 'v1')).toBeUndefined()
    expect(cache.get(replacement, 'v1')).toBe('new')
  })

  it('misses changed input revisions and expires values without extending their original TTL', async () => {
    let now = 0
    const cache = new ScopedPreparationCache<string>({ now: () => now, maxAgeMs: 100 })
    const producer = vi.fn(async () => 'context')
    await cache.prepare(scope, 'v1', producer)
    expect(cache.get(scope, 'v2')).toBeUndefined()
    now = 99
    expect(cache.get(scope, 'v1')).toBe('context')
    now = 100
    expect(cache.get(scope, 'v1')).toBeUndefined()
    await cache.prepare(scope, 'v1', producer)
    expect(producer).toHaveBeenCalledTimes(2)
  })

  it('does not let one aborted consumer cancel another consumer', async () => {
    const cache = new ScopedPreparationCache<string>()
    const pending = deferred<string>()
    const cancelled = new AbortController()
    const first = cache.prepare(scope, 'v1', () => pending.promise, cancelled.signal)
    const rejected = first.catch(error => error)
    const second = cache.prepare(scope, 'v1', async () => 'wrong-producer')
    cancelled.abort()
    expect(await rejected).toMatchObject({ name: 'AbortError' })
    pending.resolve('context')
    await expect(second).resolves.toBe('context')
    expect(cache.get(scope, 'v1')).toBe('context')
  })

  it('clears revoked results and retries failed producers', async () => {
    const cache = new ScopedPreparationCache<string>()
    await expect(cache.prepare(scope, 'v1', async () => Promise.reject(new Error('retrieval')))).rejects.toThrow(
      'retrieval'
    )
    await cache.prepare(scope, 'v1', async () => 'current')
    cache.invalidate()
    expect(cache.get(scope, 'v1')).toBeUndefined()
    await expect(cache.prepare(scope, 'v1', async () => 'renewed')).resolves.toBe('renewed')
    cache.stop()
    await expect(cache.prepare(scope, 'v1', async () => 'late')).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('bounds memory and evicts the least recently used revision', async () => {
    const cache = new ScopedPreparationCache<string>({ maxEntries: 2 })
    await cache.prepare(scope, 'v1', async () => 'one')
    await cache.prepare(scope, 'v2', async () => 'two')
    expect(cache.get(scope, 'v1')).toBe('one')
    await cache.prepare(scope, 'v3', async () => 'three')
    expect(cache.get(scope, 'v2')).toBeUndefined()
    expect(cache.get(scope, 'v1')).toBe('one')
  })
})
