import { describe, expect, it } from 'vitest'
import { planContext, recordSubmittedContext } from '@/services/contextPlanner'
import type { PromptFragment } from '@/services/prompt/promptContextAssembler'

const scopeKey = { principalId: 'p', serverInstance: 's', projectId: 'project', sessionId: 'chat', taskType: 'chat' }
const fragment = (id: string, content: string, extra: Partial<PromptFragment> = {}): PromptFragment => ({
  id,
  content,
  source: 'memory',
  trust: 'untrusted_data',
  scope: 'project',
  egress: 'allowed',
  ...extra,
})

describe('shared context planner', () => {
  it('deduplicates the same source from start/query retrieval while keeping distinct revisions', async () => {
    const plan = await planContext({
      scopeKey,
      query: 'SQLite',
      fragments: [
        fragment('start', 'SQLite als Datenbank', { provenance: { recordId: '42', revision: '1' } }),
        fragment('query', 'SQLite als Datenbank', { priority: 80, provenance: { recordId: '42', revision: '1' } }),
        fragment('correction', 'PostgreSQL als Datenbank', {
          provenance: { recordId: '42', revision: '2', staleness: 'contradiction' },
        }),
      ],
    })
    expect(plan.local.selected.map(item => item.id)).toEqual(['query', 'correction'])
    expect(plan.local.omitted).toContainEqual({ id: 'start', reason: 'duplicate' })
    expect(plan.diagnostics.local).toMatchObject({ found: 3, selected: 2, submitted: null })
  })

  it('lets current relevance outrank a generic high-importance record under a small real budget', async () => {
    const plan = await planContext({
      scopeKey,
      query: 'Datei SQLite',
      local: { windowTokens: 600 },
      reserveTokens: 100,
      fragments: [
        fragment('generic', 'Allgemeine Vorliebe '.repeat(12), { priority: 90 }),
        fragment('relevant', 'Datei SQLite enthält die Arbeitsergebnisse.', { priority: 10 }),
      ],
    })
    expect(plan.local.selected[0]?.id).toBe('relevant')
    expect(plan.local.charCount).toBeLessThanOrEqual(plan.local.budget.maxChars)
    expect(plan.diagnostics.local).toMatchObject({ windowKnown: true, windowTokens: 600 })
  })

  it('preserves the stricter egress of duplicate sources and never edits originals', async () => {
    const fragments = [
      fragment('public-copy', 'SQLite', { priority: 90, provenance: { recordId: 'x' } }),
      fragment('private-copy', 'SQLite', { egress: 'local_only', provenance: { recordId: 'x' } }),
    ]
    const plan = await planContext({ scopeKey, fragments, query: 'SQLite' })
    expect(plan.local.selected).toHaveLength(1)
    expect(plan.external.selected).toHaveLength(0)
    expect(fragments[0]!.egress).toBe('allowed')
  })

  it('counts actual fitted submission independently of retrieval and package selection', async () => {
    const plan = await planContext({
      scopeKey,
      fragments: [fragment('a', 'Quelle A'), fragment('b', 'Quelle B')],
      query: '',
    })
    const aLine = plan.local.text.split('\n').find(line => line.includes('"id":"a"'))!
    recordSubmittedContext(plan, 'local_llama_cpp', [
      { role: 'system', content: aLine },
      { role: 'user', content: plan.local.text },
    ])
    expect(plan.diagnostics.local).toMatchObject({ found: 2, selected: 2, submitted: 1, submittedIds: ['a'] })
    expect(plan.diagnostics.external.submitted).toBeNull()
    recordSubmittedContext(plan, 'local_llama_cpp', [])
    expect(plan.diagnostics.local.submitted).toBe(0)
  })

  it('marks a missing model window as estimated and retains sources when history is very long', async () => {
    const plan = await planContext({
      scopeKey,
      query: '',
      fragments: [fragment('evidence', 'Aktueller Beleg')],
      local: { history: [{ role: 'user', content: 'historischer Auftrag '.repeat(10000) }] },
    })
    expect(plan.diagnostics.local.windowKnown).toBe(false)
    expect(plan.local.selected).toHaveLength(1)
  })
})
