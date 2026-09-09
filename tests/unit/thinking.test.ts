import { describe, expect, it } from 'vitest'
import {
  isThinkingTier,
  readThinkingProgress,
  resolveThinkingConfig,
  THINKING_TIERS,
} from '@/services/inference/thinking'

describe('per-turn thinking contract', () => {
  it('keeps adaptive initial goals while doubling ceilings and reserves and adding Ultra', () => {
    expect(THINKING_TIERS.map(tier => resolveThinkingConfig(tier))).toEqual([
      { initialTokens: 512, maxThinkingTokens: 4096, responseReserveTokens: 4096 },
      { initialTokens: 1024, maxThinkingTokens: 8192, responseReserveTokens: 4096 },
      { initialTokens: 2048, maxThinkingTokens: 16384, responseReserveTokens: 8192 },
      { initialTokens: 4096, maxThinkingTokens: 32768, responseReserveTokens: 8192 },
      { initialTokens: 8192, maxThinkingTokens: 65536, responseReserveTokens: 16384 },
    ])
    expect(resolveThinkingConfig()).toEqual(resolveThinkingConfig('balanced'))
  })
  it.each([
    { initialTokens: 0 },
    { initialTokens: 8193 },
    { initialTokens: 1.5 },
    { maxThinkingTokens: 65537 },
    { maxThinkingTokens: Number.NaN },
    { responseReserveTokens: 255 },
    { maxThinkingTokens: 65536, responseReserveTokens: 65537 },
  ])('rejects invalid expert values at the shared native boundary: %j', config => {
    expect(() => resolveThinkingConfig('balanced', config)).toThrow()
  })
  it('freezes a copy so settings edits cannot change an admitted turn', () => {
    const source = { initialTokens: 1024 }
    const result = resolveThinkingConfig('balanced', source)
    source.initialTokens = 4096
    expect(result.initialTokens).toBe(1024)
    expect(Object.isFrozen(result)).toBe(true)
    expect(isThinkingTier('__proto__')).toBe(false)
  })
  it('projects only public counters and keeps unknown counts unknown', () => {
    const event = {
      requestId: 'request',
      tier: 'ultra',
      phase: 'thinking',
      generatedTokens: null,
      softTargetTokens: 8192,
      thinkingLimitTokens: 20000,
      requestedThinkingLimitTokens: 65536,
      outputLimitTokens: 32700,
      responseReserveTokens: 8192,
      warning: true,
      canExtend: false,
      canAnswer: true,
      answerRequested: false,
      elapsedMs: 920,
      sequence: 2,
      reasoningContent: 'PRIVATE',
      template: 'PRIVATE',
      path: 'PRIVATE',
    }
    const progress = readThinkingProgress(event)
    expect(progress?.generatedTokens).toBeNull()
    expect(JSON.stringify(progress)).not.toContain('PRIVATE')
    expect(readThinkingProgress({ ...event, generatedTokens: -1 })).toBeNull()
    expect(readThinkingProgress({ ...event, sequence: 0.5 })).toBeNull()
  })
})
