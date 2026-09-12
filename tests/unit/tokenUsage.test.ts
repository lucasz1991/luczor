import { describe, expect, it } from 'vitest'
import { createTokenUsageCounter, readReportedTokenUsage } from '@/services/tokenUsage'

describe('turn token accounting', () => {
  it('replaces a failed round input estimate with the native count without treating max_tokens as output', () => {
    const counter = createTokenUsageCounter()
    const request = { messages: [{ role: 'user' as const, content: 'a'.repeat(66000) }], tools: [] }
    const provisional = counter.update(1, request, '')
    expect(provisional.source).toBe('estimated')
    expect(provisional.inputTokens).not.toBe(19263)
    const diagnostic = {
      schemaVersion: 1,
      stage: 'generation',
      code: 'runtime_context_exceeded',
      reason: 'context_limit',
      inputTokens: 19263,
      contextTokens: 32768,
      outputTokens: 4096,
    }
    const corrected = counter.recordLocalFailure(1, diagnostic)
    expect(corrected).toMatchObject({
      inputTokens: 19263,
      outputTokens: 0,
      totalTokens: 19263,
      contextTokens: 32768,
      rounds: 1,
      source: 'mixed',
    })
    expect(counter.recordLocalFailure(1, diagnostic)).toEqual(corrected)
    expect(counter.update(1, request, 'ABCD')).toMatchObject({ inputTokens: 19263, outputTokens: 1, source: 'mixed' })
  })

  it('retains completed model rounds and partial output while correcting only the rejected round', () => {
    const counter = createTokenUsageCounter()
    counter.update(1, { messages: [] }, 'OK', {
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      rawToolCalls: [],
    })
    counter.update(2, { messages: [] }, 'ABCD')
    const usage = counter.recordLocalFailure(2, {
      schemaVersion: 1,
      stage: 'generation',
      code: 'runtime_tool_contract_rejected',
      reason: 'tool_contract',
      inputTokens: 19263,
      outputTokens: 16000,
    })
    expect(usage).toMatchObject({
      inputTokens: 19363,
      outputTokens: 21,
      totalTokens: 19384,
      rounds: 2,
      source: 'mixed',
    })
  })

  it('does not invent counts, add rounds or overwrite completed usage from missing or invalid diagnostics', () => {
    const counter = createTokenUsageCounter()
    const request = { messages: [{ role: 'user' as const, content: 'Hallo' }] }
    const initial = counter.update(1, request, 'OK')
    expect(counter.recordLocalFailure(1, { inputTokens: 19263, outputTokens: 4096 })).toEqual(initial)
    expect(
      counter.recordLocalFailure(2, {
        schemaVersion: 1,
        stage: 'generation',
        code: 'runtime_context_exceeded',
        reason: 'context_limit',
        inputTokens: 19263,
      })
    ).toEqual(initial)
    expect(
      counter.recordLocalFailure(1, {
        schemaVersion: 1,
        stage: 'generation',
        code: 'runtime_context_exceeded',
        reason: 'context_limit',
        inputTokens: -1,
        outputTokens: 4096,
      })
    ).toEqual(initial)
    const reported = counter.update(1, request, 'OK', {
      usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
      rawToolCalls: [],
    })
    expect(
      counter.recordLocalFailure(1, {
        schemaVersion: 1,
        stage: 'generation',
        code: 'runtime_context_exceeded',
        reason: 'context_limit',
        inputTokens: 19263,
      })
    ).toEqual(reported)
  })

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
