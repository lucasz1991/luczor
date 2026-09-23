import { describe, expect, it } from 'vitest'
import {
  applyMemoryAnnotation,
  captureMemoryMetadata,
  memoryCategory,
  memoryMetadataInputRevision,
  memoryMetadataOf,
  memoryMetadataSearchText,
  mergeMemoryMetadata,
  needsMemoryAnnotation,
  parseMemoryClassification,
} from '@/services/memory/memoryMetadata'

const record = (content = 'Ich interessiere mich für Laravel und Livewire.') => ({
  content,
  contentHash: content,
  source: 'user',
  writeIntent: 'automatic',
  projectId: 'project-a',
  importance: 0.5,
  tags: ['bestehend'],
  meta: {
    other: 'preserved',
    memory_metadata: captureMemoryMetadata({
      content,
      source: 'user',
      projectId: 'project-a',
      origin: { messageId: 'message-1', role: 'user', conversationId: 'chat-1', observedAt: 100 },
      now: 101,
    }),
  },
})

describe('structured memory attribution and autonomous classification', () => {
  it('captures user origin and deterministic hierarchy without another inference request', () => {
    const metadata = memoryMetadataOf(record())!
    expect(metadata.interest).toBe(0.8)
    expect(metadata.categories.map(item => item.id)).toContain('software/backend/laravel')
    expect(metadata.evidence).toMatchObject({
      status: 'user_stated',
      verifiedAt: null,
      sources: [{ id: 'message-1', role: 'user', conversationId: 'chat-1', projectId: 'project-a', observedAt: 100 }],
    })
    expect(needsMemoryAnnotation(record())).toBe(true)
  })
  it('never turns assistant repetition or storage permission into user interest or truth', () => {
    const metadata = captureMemoryMetadata({
      content: 'Ich interessiere mich für Laravel.',
      source: 'user',
      writeIntent: 'confirmed',
      origin: { messageId: 'assistant-1', role: 'assistant' },
      classification: { interest: 1 },
      now: 1,
    })
    expect(metadata.interest).toBeNull()
    expect(metadata.evidence.status).toBe('inferred')
    expect(() => parseMemoryClassification({ evidence: { status: 'source_backed' } })).toThrow()
    const item = { content: 'I like this', source: 'assistant', meta: { memory_metadata: metadata } }
    const annotated = applyMemoryAnnotation(item, { interest: 1 }, { origin: 'dream', now: 2 })
    expect(memoryMetadataOf(annotated)?.interest).toBeNull()
  })
  it('keeps unobserved path mentions distinct from verified file evidence and binds project identity', () => {
    const metadata = captureMemoryMetadata({
      content: 'Siehe `src/MixedCase.ts` und `file_23`.',
      source: 'assistant',
      projectId: 'p',
      origin: {
        files: [
          { path: 'src/Other.ts', projectId: 'other', relation: 'related' },
          {
            path: 'src/Real.ts',
            projectId: 'p',
            repositoryId: 'repo',
            relation: 'evidence',
            revision: 'sha-1',
            verifiedAt: 8,
          },
        ],
      },
      now: 9,
    })
    expect(metadata.files).toEqual([
      {
        path: 'src/Real.ts',
        projectId: 'p',
        repositoryId: 'repo',
        relation: 'evidence',
        revision: 'sha-1',
        verifiedAt: 8,
      },
      { path: 'src/MixedCase.ts', projectId: 'p', relation: 'mentioned' },
    ])
    expect(metadata.evidence.verifiedAt).toBe(8)
    expect(memoryMetadataSearchText({ meta: { memory_metadata: metadata } })).toContain('src/MixedCase.ts')
  })
  it('reuses aliases while preserving multi-level labels and rejects unsupported model fields', () => {
    expect(memoryCategory(['Softwareentwicklung', 'backend', 'laravel'])).toEqual(
      memoryCategory(['Software', 'Backend', 'Laravel'])
    )
    expect(
      parseMemoryClassification({
        categories: [
          ['Software', 'Backend'],
          ['softwareentwicklung', 'backend'],
        ],
      }).categories
    ).toHaveLength(1)
    for (const value of [
      { projectId: 'other' },
      { interest: 2 },
      { categories: [['a', 'b', 'c', 'd', 'e']] },
      { files: [] },
    ])
      expect(() => parseMemoryClassification(value)).toThrow()
  })
  it('protects explicit corrections while allowing autonomous enrichment of other fields', () => {
    const original = record()
    const corrected = {
      ...original,
      ...applyMemoryAnnotation(
        original,
        { importance: 1, interest: 0, categories: [['Arbeit', 'Regeln']], tags: ['Pflicht'] },
        { origin: 'user', now: 2 }
      ),
    }
    const result = {
      ...corrected,
      ...applyMemoryAnnotation(
        corrected,
        { importance: 0.1, interest: 1, categories: [['Freizeit']], tags: [], kind: 'rule' },
        { origin: 'dream', now: 3 }
      ),
    }
    expect(result.importance).toBe(1)
    expect(result.tags).toEqual(['Pflicht'])
    expect(result.meta.other).toBe('preserved')
    expect(memoryMetadataOf(result)).toMatchObject({
      interest: 0,
      kind: 'rule',
      categories: [{ path: ['Arbeit', 'Regeln'] }],
    })
    expect(needsMemoryAnnotation(result)).toBe(false)
  })
  it('does not enqueue its own annotation again but does re-evaluate changed source or user overrides', () => {
    const original = record()
    const annotated = {
      ...original,
      ...applyMemoryAnnotation(original, { tags: ['Laravel'] }, { origin: 'dream', now: 2 }),
    }
    expect(memoryMetadataInputRevision(annotated)).toBe(memoryMetadataInputRevision(original))
    expect(needsMemoryAnnotation(annotated)).toBe(false)
    expect(needsMemoryAnnotation({ ...annotated, contentHash: 'new-source' })).toBe(true)
    const corrected = { ...annotated, ...applyMemoryAnnotation(annotated, { interest: 0 }, { origin: 'user', now: 3 }) }
    expect(needsMemoryAnnotation(corrected)).toBe(true)
    const legacy = { content: 'Alte Erinnerung', source: 'assistant', importance: 0.5 }
    const enriched = { ...legacy, ...applyMemoryAnnotation(legacy, {}, { origin: 'dream', now: 4 }) }
    expect(needsMemoryAnnotation(enriched)).toBe(false)
  })
  it('retains source ancestry during synthesis without inheriting source verification', () => {
    const first = record('Laravel Entscheidung')
    const second = record('Livewire Entscheidung')
    second.meta.memory_metadata.evidence.sources[0]!.id = 'message-2'
    const metadata = mergeMemoryMetadata([first, second], 10)
    expect(metadata.evidence.sources.map(source => source.id)).toEqual(['message-1', 'message-2'])
    expect(metadata.evidence.status).toBe('inferred')
    expect(metadata.evidence.verifiedAt).toBeNull()
    expect(metadata.categories).toHaveLength(2)
    const firstProtected = { ...first, ...applyMemoryAnnotation(first, { interest: 0 }, { origin: 'user' }) }
    const secondProtected = { ...second, ...applyMemoryAnnotation(second, { interest: 1 }, { origin: 'user' }) }
    expect(() => mergeMemoryMetadata([firstProtected, secondProtected])).toThrow('memory_metadata_override_conflict')
  })
  it('does not transfer the highest personal interest to unrelated merged topics', () => {
    const first = record('Ich interessiere mich für Laravel.')
    const second = record('Ich interessiere mich für Gartenarbeit.')
    first.meta.memory_metadata.interest = 0.9
    second.meta.memory_metadata.interest = 0.2
    first.meta.memory_metadata.categories = [memoryCategory(['Technik', 'Laravel'])]
    second.meta.memory_metadata.categories = [memoryCategory(['Freizeit', 'Garten'])]
    expect(mergeMemoryMetadata([first, second]).interest).toBeNull()
    second.meta.memory_metadata.categories = first.meta.memory_metadata.categories
    expect(mergeMemoryMetadata([first, second]).interest).toBeCloseTo(0.55)
    second.meta.memory_metadata.interest = null
    expect(mergeMemoryMetadata([first, second]).interest).toBeNull()
  })
})
