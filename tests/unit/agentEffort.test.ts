import { describe, expect, it } from 'vitest'
import { selectAgentEffort, validateAgentExecutionOptions, type AgentCapabilityCatalog } from '@/services/agents/effort'
import { CLAUDE_CAPABILITIES } from '@/services/agents/claudeAgent'

const catalog: AgentCapabilityCatalog = {
  revision: 'r1',
  source: 'codex-cache',
  models: [
    { model: 'six-levels', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { model: 'four-levels', supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
  ],
}

describe('model-specific managed effort selection', () => {
  it.each([
    ['fast', 'low'],
    ['balanced', 'medium'],
    ['thorough', 'high'],
    ['max', 'max'],
    ['ultra', 'ultra'],
  ] as const)('maps %s without treating a token budget as a provider effort', (tier, expected) => {
    expect(selectAgentEffort({ adapter: 'codex', tier, model: 'six-levels', catalog })).toMatchObject({
      requestedEffort: expected,
      status: 'requested',
      capabilitySource: 'codex-cache',
    })
  })
  it('caps the requested effort to the specific model capability', () => {
    expect(selectAgentEffort({ adapter: 'codex', tier: 'ultra', model: 'four-levels', catalog })).toMatchObject({
      requestedEffort: 'xhigh',
      reason: 'model_effort_ceiling',
    })
  })
  it('lets an appropriate role exceed the prompt tier, while preserving an explicit override', () => {
    expect(
      selectAgentEffort({ adapter: 'codex', tier: 'fast', role: 'reviewer', model: 'six-levels', catalog })
    ).toMatchObject({ requestedEffort: 'high', reason: 'role_requires_deeper_review' })
    expect(
      selectAgentEffort({
        adapter: 'codex',
        tier: 'fast',
        role: 'reviewer',
        override: 'low',
        model: 'six-levels',
        catalog,
      })
    ).toMatchObject({ requestedEffort: 'low', reason: 'node_override' })
  })
  it.each([undefined, 'unknown-model'])('never guesses a default model or effort for %s', model => {
    const result = selectAgentEffort({ adapter: 'codex', tier: 'ultra', model, catalog })
    expect(result.status).toBe('unknown')
    expect(result.requestedEffort).toBeUndefined()
    expect(result.appliedEffort).toBeUndefined()
  })
  it('rejects an unsupported explicit override instead of silently changing model or level', () => {
    expect(() => selectAgentEffort({ adapter: 'codex', model: 'four-levels', override: 'ultra', catalog })).toThrow(
      'unterstützt'
    )
    expect(() => selectAgentEffort({ adapter: 'codex', override: 'high', catalog })).toThrow('nicht bestätigt')
  })
  it('uses only levels documented for each Claude model, leaving aliases unresolved', () => {
    expect(
      selectAgentEffort({ adapter: 'claude', tier: 'max', model: 'claude-opus-4-6', catalog: CLAUDE_CAPABILITIES })
        .requestedEffort
    ).toBe('high')
    expect(
      selectAgentEffort({ adapter: 'claude', tier: 'ultra', model: 'claude-opus-4-6', catalog: CLAUDE_CAPABILITIES })
        .requestedEffort
    ).toBe('max')
    expect(
      selectAgentEffort({ adapter: 'claude', tier: 'max', model: 'claude-opus-4-7', catalog: CLAUDE_CAPABILITIES })
        .requestedEffort
    ).toBe('xhigh')
    expect(
      selectAgentEffort({ adapter: 'claude', tier: 'ultra', model: 'opus', catalog: CLAUDE_CAPABILITIES }).status
    ).toBe('unknown')
  })
  it('rejects malformed budgets and tiers before enqueue', () => {
    for (const input of [
      { maxTurns: 0 },
      { maxTurns: 201 },
      { maxTurns: 1.5 },
      { maxBudgetUsd: NaN },
      { maxBudgetUsd: -1 },
      { maxBudgetUsd: 101 },
      { thinkingTier: 'invented' },
    ]) {
      expect(() =>
        validateAgentExecutionOptions(input as Parameters<typeof validateAgentExecutionOptions>[0])
      ).toThrow()
    }
  })
  it('preserves Claude context suffixes while matching the verified base model capabilities', () => {
    expect(
      selectAgentEffort({ adapter: 'claude', tier: 'max', model: 'claude-opus-5[1m]', catalog: CLAUDE_CAPABILITIES })
    ).toMatchObject({ model: 'claude-opus-5[1m]', requestedEffort: 'xhigh' })
    expect(
      selectAgentEffort({ adapter: 'claude', tier: 'max', model: 'claude-opus-5[2m]', catalog: CLAUDE_CAPABILITIES })
        .status
    ).toBe('unknown')
    expect(selectAgentEffort({ adapter: 'codex', tier: 'max', model: 'six-levels[1m]', catalog }).status).toBe(
      'unknown'
    )
  })
})
