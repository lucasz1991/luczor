import { describe, expect, it } from 'vitest'
import { buildRepositoryContextQuery, hasRepositoryTaskSignal } from '@/services/repositoryContextQuery'

describe('repository query planning', () => {
  it('recognizes ordinary implementation requests and source references without a coding task label', () => {
    expect(hasRepositoryTaskSignal('Bitte diese Funktion hinzufügen')).toBe(true)
    expect(hasRepositoryTaskSignal('Wie funktioniert src/services/agent.ts:900?')).toBe(true)
    expect(hasRepositoryTaskSignal('Bitte loadSession reparieren')).toBe(true)
    expect(hasRepositoryTaskSignal('Wie ist das Wetter heute?')).toBe(false)
  })

  it('uses retained task context on a continuation and searches exact source identifiers first', () => {
    const result = buildRepositoryContextQuery('weiterarbeiten', 'Repariere resumeAgent in src/services/agent.ts:900')
    expect(result.contextual).toBe(true)
    expect(result.queries[0]).toBe('src/services/agent.ts')
    expect(result.queries).toContain('resumeAgent')
    expect(result.focusQuery).toContain('resumeAgent')
    expect(result.focusQuery).not.toContain('weiterarbeiten')
  })

  it('filters conversational filler and bounds native requests for long user prompts', () => {
    const result = buildRepositoryContextQuery(
      `${'Bitte ich möchte dass du das und die '.repeat(100)} src/App.vue reparieren`
    )
    expect(result.queries[0]).toBe('src/App.vue')
    expect(result.focusQuery.split(' ').length).toBeLessThanOrEqual(20)
    expect(result.queries.length).toBeLessThanOrEqual(4)
    expect(result.queries.every(query => query.length <= 4096)).toBe(true)
  })

  it('deduplicates Windows paths and preserves exact filename case', () => {
    const result = buildRepositoryContextQuery('src\\services\\Agent.ts und src/services/Agent.ts')
    expect(result.identifiers).toEqual(['src/services/Agent.ts'])
  })
})
