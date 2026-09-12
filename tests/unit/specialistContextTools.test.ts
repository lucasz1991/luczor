import { describe, expect, it } from 'vitest'
import { specialistContextTools } from '@/services/agents/specialistContextTools'
import type { WireMessage } from '@/services/inference/types'

describe('provider packet context tools', () => {
  it('exposes only selected tools and cannot dispatch filesystem or desktop commands', () => {
    const context = specialistContextTools([{ role: 'user', content: 'Approved message' }], ['context_read'])
    expect(context.tools.map(tool => tool.function.name)).toEqual(['context_read'])
    expect(() => context.execute('context_search', { query: 'message' })).toThrow('nicht zugeteilt')
    expect(() => context.execute('fs_read', { path: 'C:/private.txt' })).toThrow('nicht zugeteilt')
    expect(specialistContextTools([], []).tools).toEqual([])
  })

  it('uses a captured packet and bounds reads with an explicit continuation offset', () => {
    const original: WireMessage[] = [{ role: 'user', content: 'a'.repeat(6000) + 'Final part' }]
    const context = specialistContextTools(original, ['context_read'])
    original[0]!.content = 'Later local-only data'
    expect(context.execute('context_read', { index: 0 })).toEqual({
      index: 0,
      offset: 0,
      text: 'a'.repeat(6000),
      hasMore: true,
    })
    expect(context.execute('context_read', { index: 0, offset: 6000 })).toEqual({
      index: 0,
      offset: 6000,
      text: 'Final part',
      hasMore: false,
    })
    expect(() => context.execute('context_read', { index: 1 })).toThrow('nicht vorhanden')
  })

  it('caps search results and excerpts and returns no outside context', () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: 'user' as const,
      content: `${'x'.repeat(400)}Approved-${index}${'y'.repeat(1500)}`,
    }))
    const context = specialistContextTools(messages, ['context_search'])
    const results = context.execute('context_search', { query: 'approved' }) as Array<{
      index: number
      offset: number
      excerpt: string
    }>
    expect(results).toHaveLength(8)
    expect(results.every(result => result.offset === 400 && result.excerpt.length <= 720)).toBe(true)
    expect(results[0]?.index).toBe(0)
    expect(context.execute('context_search', { query: 'absent' })).toEqual([])
  })

  it.each([
    ['context_read', { index: -1 }],
    ['context_read', { index: 0.5 }],
    ['context_read', { index: 0, offset: -1 }],
    ['context_read', { index: 0, path: 'secret' }],
    ['context_search', { query: '' }],
    ['context_search', { query: 'x'.repeat(201) }],
    ['context_search', { query: 'hello', extra: 'private' }],
  ] as const)('rejects malformed %s arguments before reading', (name, args) => {
    const context = specialistContextTools([{ role: 'user', content: 'hello' }], ['context_search', 'context_read'])
    expect(() => context.execute(name, args)).toThrow()
  })
})
