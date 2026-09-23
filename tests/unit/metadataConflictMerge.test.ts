import { describe, expect, it } from 'vitest'
import { safeDisjointMetadataMerge } from '@/services/memory/metadataConflictMerge'

describe('safe disjoint metadata changes', () => {
  it('combines disjoint nested changes and treats key order as irrelevant', () => {
    const base = { version: 1, kind: 'unknown', classification: { source: 'chat', checked: 1 }, overrides: [] }
    const local = { ...base, kind: 'decision' }
    const remote = { overrides: [], classification: { checked: 2, source: 'chat' }, kind: 'unknown', version: 1 }
    expect(safeDisjointMetadataMerge(base, local, remote)).toEqual({ ...local, classification: remote.classification })
    expect(base.kind).toBe('unknown')
  })
  it('rejects same-leaf, array, delete-versus-edit and explicitly protected conflicts', () => {
    expect(safeDisjointMetadataMerge({ kind: 'unknown' }, { kind: 'fact' }, { kind: 'rule' })).toBeNull()
    expect(safeDisjointMetadataMerge({ tags: [] }, { tags: ['a'] }, { tags: ['b'] })).toBeNull()
    expect(
      safeDisjointMetadataMerge({ classification: { source: 'chat' } }, {}, { classification: { source: 'dream' } })
    ).toBeNull()
    expect(
      safeDisjointMetadataMerge(
        { kind: 'fact', overrides: [] },
        { kind: 'fact', overrides: ['kind'] },
        { kind: 'rule', overrides: [] }
      )
    ).toBeNull()
  })
  it('keeps one-sided removal and refuses exotic, cyclic or excessive objects', () => {
    expect(
      safeDisjointMetadataMerge({ kind: 'fact', interest: 1 }, { kind: 'fact' }, { kind: 'rule', interest: 1 })
    ).toEqual({ kind: 'rule' })
    expect(safeDisjointMetadataMerge({}, { value: new Date() }, {})).toBeNull()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(safeDisjointMetadataMerge({}, cyclic, {})).toBeNull()
    expect(safeDisjointMetadataMerge({}, { value: 'x'.repeat(128001) }, {})).toBeNull()
  })
})
