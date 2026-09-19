import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryRecord } from '@/services/memory/luczorMemory'

const mocks = vi.hoisted(() => ({ recall: vi.fn(), recallLocal: vi.fn(), analyze: vi.fn(), remember: vi.fn() }))
vi.mock('@/services/memory/luczorMemory', () => ({ luczorMemory: mocks }))

import { memoryTools } from '@/services/tools/memory'
import { validateToolArguments } from '@/services/tools/validateArguments'

const tool = memoryTools[0]!
const CONTEXT = { projectId: 'project-1' }

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'remembered-rule',
    principalId: 'account-private',
    dataset: 'internal-dataset',
    scope: 'project',
    content: 'Antworten kurz halten.',
    contentHash: 'internal-hash',
    type: 'preference',
    source: 'user',
    tags: ['Stil'],
    featureKey: 'answer.length',
    visibility: 'syncable',
    status: 'active',
    retention: 'durable',
    sensitivity: 'normal',
    writeIntent: 'explicit',
    importance: 0.9,
    confidence: 0.9,
    createdAt: 1,
    updatedAt: 1,
    projectId: 'project-1',
    provenance: { source_ref: 'private-source-reference' },
    meta: { path: 'E:\\private\\notes.md', internal: 'private-metadata' },
    ...overrides,
  }
}

describe('provider-safe explicit memory recall tool', () => {
  it('accepts bounded model classifications but rejects asserted evidence and ownership', async () => {
    const remember = memoryTools.find(item => item.name === 'memory_remember')!
    mocks.remember.mockResolvedValue(memory())
    const classification = {
      kind: 'decision',
      categories: [['Software', 'Backend']],
      tags: ['migration'],
      interest: 0.4,
    }
    expect(() =>
      validateToolArguments(remember.parameters, {
        content: 'Die Migration bleibt reversibel.',
        priority: 'normal',
        classification,
      })
    ).not.toThrow()
    await remember.execute(
      { content: 'Die Migration bleibt reversibel.', priority: 'normal', classification },
      { ...CONTEXT, toolSessionId: 'run-a' }
    )
    expect(mocks.remember).toHaveBeenCalledWith(
      expect.objectContaining({ classification, sourceRef: 'run-a', source: 'assistant', writeIntent: 'system' })
    )
    for (const forbidden of [
      { evidence: { status: 'source_backed' } },
      { projectId: 'foreign' },
      { confirmed: true },
    ]) {
      await expect(
        remember.execute({ content: 'Claim', priority: 'normal', classification: forbidden }, CONTEXT)
      ).rejects.toThrow('invalid_memory_classification')
    }
    expect(mocks.remember).toHaveBeenCalledTimes(1)
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.recall.mockResolvedValue([memory()])
    mocks.recallLocal.mockResolvedValue([
      memory({ source: 'assistant', writeIntent: 'system', confidence: 0.35, visibility: 'private' }),
    ])
  })

  it('exposes one read-only ephemeral search without model-selected project or account identifiers', () => {
    expect(memoryTools).toHaveLength(3)
    expect(tool).toMatchObject({
      name: 'memory_recall',
      mutating: false,
      requiresApproval: false,
      dataHandling: 'ephemeral',
      effects: ['read'],
    })
    expect(tool.parameters).toMatchObject({ additionalProperties: false, required: ['query'] })
    expect(JSON.stringify(tool.parameters)).not.toMatch(/project_id|projectId|principal|dataset|user_id/u)
  })

  it('uses the active project and returns only compact public evidence fields', async () => {
    const result = await tool.execute({ query: '  Antwortlänge  ' }, CONTEXT)
    expect(mocks.recall).toHaveBeenCalledExactlyOnceWith({
      query: 'Antwortlänge',
      scope: 'project',
      projectId: 'project-1',
      limit: 6,
    })
    expect(result).toEqual({
      scope: 'project',
      truncated: false,
      memories: [
        {
          id: 'remembered-rule',
          content: 'Antworten kurz halten.',
          type: 'preference',
          source: 'user',
          confidence: 0.9,
          write_intent: 'explicit',
          priority: 'high',
          priority_label: 'Wichtig',
          tags: ['Stil'],
          feature_key: 'answer.length',
        },
      ],
    })
    expect(JSON.stringify(result)).not.toMatch(/principal|dataset|contentHash|provenance|private|meta|projectId/u)
  })

  it('retrieves user preferences without leaking or attaching the current project partition', async () => {
    await tool.execute({ query: 'Sprache', scope: 'user', limit: 20 }, CONTEXT)
    expect(mocks.recall).toHaveBeenCalledExactlyOnceWith({ query: 'Sprache', scope: 'user', limit: 20 })
  })

  it('retrieves private AI notes only for a host-selected local target and never forwards its query', async () => {
    const result = await tool.execute({ query: 'Antwort' }, { ...CONTEXT, inferenceTarget: 'local' })
    expect(mocks.recallLocal).toHaveBeenCalledExactlyOnceWith({
      query: 'Antwort',
      scope: 'project',
      projectId: 'project-1',
      limit: 6,
    })
    expect(mocks.recall).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      memories: [expect.objectContaining({ source: 'assistant', confidence: 0.35, write_intent: 'system' })],
    })
    mocks.recallLocal.mockClear()
    await tool.execute({ query: 'Antwort' }, { ...CONTEXT, inferenceTarget: 'external' })
    expect(mocks.recallLocal).not.toHaveBeenCalled()
    expect(mocks.recall).toHaveBeenCalledOnce()
  })

  it('accepts the grammar-compatible search boundary in both schema and execution', async () => {
    const args = { query: 'a'.repeat(1999) }
    expect(tool.parameters).toMatchObject({ properties: { query: { minLength: 1, maxLength: 1999 } } })
    expect(() => validateToolArguments(tool.parameters, args)).not.toThrow()
    await tool.execute(args, CONTEXT)
    expect(mocks.recall).toHaveBeenCalledExactlyOnceWith({
      ...args,
      scope: 'project',
      projectId: 'project-1',
      limit: 6,
    })
  })

  it('rejects the b10809 grammar boundary before schema dispatch or memory I/O', async () => {
    const args = { query: 'a'.repeat(2000) }
    expect(() => validateToolArguments(tool.parameters, args)).toThrow('Textlänge')
    await expect(tool.execute(args, CONTEXT)).rejects.toThrow('between 1 and 1999 characters')
    expect(mocks.recall).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { query: null },
    { query: 7 },
    { query: '' },
    { query: '   ' },
    { query: '!!!' },
    { query: 'a'.repeat(2001) },
    { query: 'Text\u0000' },
    { query: 'Text', scope: 'private' },
    { query: 'Text', scope: null },
    { query: 'Text', scope: 'global' },
    { query: 'Text', limit: 0 },
    { query: 'Text', limit: 21 },
    { query: 'Text', limit: 1.5 },
    { query: 'Text', limit: '6' },
    { query: 'Text', limit: Number.NaN },
    { query: 'Text', limit: Infinity },
    { query: 'Text', project_id: 'other-project' },
    { query: 'Text', principalId: 'other-account' },
    { query: 'Text', include_private: true },
  ])('rejects invalid arguments before any memory or network I/O: %j', async args => {
    await expect(tool.execute(args, CONTEXT)).rejects.toThrow()
    expect(mocks.recall).not.toHaveBeenCalled()
  })

  it('requires an active project for project scope', async () => {
    await expect(tool.execute({ query: 'Navigation' }, { projectId: '' })).rejects.toThrow('active project')
    expect(mocks.recall).not.toHaveBeenCalled()
  })

  it('redacts absolute paths inside otherwise eligible content and tags', async () => {
    mocks.recall.mockResolvedValue([
      memory({
        content: 'Der Ordner liegt in E:\\private\\reports.',
        tags: ['E:\\private\\reports'],
      }),
    ])
    const result = await tool.execute({ query: 'Ordner' }, CONTEXT)
    expect(JSON.stringify(result)).not.toContain('private')
    expect(JSON.stringify(result)).not.toContain('E:')
  })

  it('bounds the complete response and reports truncation instead of cutting JSON in the agent loop', async () => {
    mocks.recall.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) => memory({ id: `memory-${index}`, content: 'Antwort '.repeat(500) }))
    )
    const result = await tool.execute({ query: 'Antwort', limit: 20 }, CONTEXT)
    expect(result).toMatchObject({ truncated: true })
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(7000)
    expect(JSON.parse(JSON.stringify(result)).memories.length).toBeGreaterThan(0)
  })

  it('returns explicit empty evidence and propagates a failed principal check', async () => {
    mocks.recall.mockResolvedValueOnce([])
    await expect(tool.execute({ query: 'Unbekannt' }, CONTEXT)).resolves.toEqual({
      scope: 'project',
      memories: [],
      truncated: false,
    })
    mocks.recall.mockRejectedValueOnce(new Error('verified account unavailable'))
    await expect(tool.execute({ query: 'Navigation' }, CONTEXT)).rejects.toThrow('verified account unavailable')
  })

  it('analyzes only the selected personal scope without a model-selected account or project', async () => {
    const analyze = memoryTools.find(item => item.name === 'memory_analyze')!
    mocks.analyze.mockResolvedValue({
      local: {
        scope: 'user',
        analyzed: 0,
        truncated: false,
        priorities: {},
        duplicates: [],
        possible_conflicts: [],
        candidate_count: 0,
        expired_count: 0,
        review_count: 0,
        recommendations: [],
      },
      server: null,
    })
    await analyze.execute({ scope: 'user' }, CONTEXT)
    expect(mocks.analyze).toHaveBeenCalledExactlyOnceWith('user', {})
    await expect(analyze.execute({ scope: 'user', user_id: 2 }, CONTEXT)).rejects.toThrow()
  })

  it('uses execution-policy approval for a durable private note without inventing user confirmation', async () => {
    const remember = memoryTools.find(item => item.name === 'memory_remember')!
    expect(remember).toMatchObject({ mutating: true, requiresApproval: true, dataHandling: 'ephemeral' })
    mocks.remember.mockResolvedValue(memory())
    await remember.execute({ content: 'Antworten kurz halten.', priority: 'high' }, CONTEXT)
    expect(mocks.remember).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        projectId: 'project-1',
        scope: 'project',
        priority: 'high',
        writeIntent: 'system',
        source: 'assistant',
        confidence: 0.35,
        visibility: 'private',
      })
    )
    await expect(
      remember.execute({ content: 'Andere Daten', priority: 'critical', projectId: 'p2' }, CONTEXT)
    ).rejects.toThrow()
  })
})
