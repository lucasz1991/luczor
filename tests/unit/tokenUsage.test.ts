import { describe, expect, it } from 'vitest'
import { createTokenUsageCounter, readReportedTokenUsage } from '@/services/tokenUsage'

describe('turn token accounting', () => {
  it('replaces cumulative live estimates and sums actual usage over tool rounds', () => {
    const counter = createTokenUsageCounter()
    const request = { messages: [{ role: 'user' as const, content: 'Hallo' }], tools: [] }
    counter.update(1, request, 'Ha')
    counter.update(1, request, 'Hallo')
    expect(counter.snapshot().outputTokens).toBe(2)
    const first = counter.update(1, request, 'Hallo', {
      usage: { inputTokens: 100, outputTokens: 8, totalTokens: 108 },
      rawToolCalls: [],
    })
    expect(first).toMatchObject({ inputTokens: 100, outputTokens: 8, source: 'reported', rounds: 1 })
    expect(counter.update(2, request, 'OK').source).toBe('mixed')
    expect(
      counter.update(2, request, 'OK', {
        usage: { inputTokens: 150, outputTokens: 2, totalTokens: 152 },
        rawToolCalls: [],
      })
    ).toMatchObject({ inputTokens: 250, outputTokens: 10, totalTokens: 260, rounds: 2, source: 'reported' })
  })

  it('never counts the native output reservation as generated tokens', () => {
    const usage = createTokenUsageCounter().update(1, { messages: [] }, 'OK', {
      contextUsage: {
        inputTokens: 123,
        contextTokens: 32768,
        outputTokens: 2048,
        omittedMessages: 0,
        shortenedToolResults: 0,
      },
      rawToolCalls: [],
    })
    expect(usage).toMatchObject({ inputTokens: 123, outputTokens: 1, source: 'mixed', contextTokens: 32768 })
  })

  it('rejects missing, negative, fractional and unsafe reported counters', () => {
    for (const usage of [
      null,
      {},
      { prompt_tokens: 1 },
      { prompt_tokens: -1, completion_tokens: 2 },
      { prompt_tokens: 1, completion_tokens: 0.5 },
      { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 },
    ]) {
      expect(readReportedTokenUsage(usage)).toBeUndefined()
    }
    expect(readReportedTokenUsage({ prompt_tokens: 0, completion_tokens: 3, total_tokens: 999 })).toEqual({
      inputTokens: 0,
      outputTokens: 3,
      totalTokens: 3,
    })
  })
})
