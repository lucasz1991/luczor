import { describe, expect, it } from 'vitest'
import { buildMemoryGraph, projectMemoryGraph, type MemoryInventory } from '@/features/memory/graph'

describe('memory explorer evidence model', () => {
  it('keeps system grouping distinct from real indexed relations without exposing profile prompts', () => {
    const inventory = {
      records: [
        {
          id: 'one',
          content: 'Remember this',
          type: 'fact',
          scope: 'project',
          status: 'active',
          source: 'user',
          visibility: 'private',
          retention: 'durable',
          confidence: 1,
          updatedAt: 1000,
          synced: true,
        },
      ],
    } as MemoryInventory
    const graph = buildMemoryGraph(
      inventory,
      {
        total: 1,
        offset: 0,
        files: [
          {
            id: 'file',
            path: 'src/app.ts',
            language: 'typescript',
            symbols: [],
            truncated: false,
            relations: [{ kind: 'import', target: './helper' }],
          },
        ],
      },
      { revision: '1', skills: [], persona: { name: 'Luczor', slug: 'luczor', prompt: 'PRIVATE_SYSTEM_PROMPT' } }
    )
    expect(graph.nodes.filter(node => node.kind === 'System')).toHaveLength(4)
    expect(graph.edges.filter(edge => !edge.grouping)).toEqual([
      { from: 'file:file', to: 'file:file:relation:0', kind: 'import' },
    ])
    expect(graph.edges.find(edge => edge.to === 'system:3')?.grouping).toBe(true)
    expect(JSON.stringify(graph)).not.toContain('PRIVATE_SYSTEM_PROMPT')
    const ids = new Set(graph.nodes.map(node => node.id))
    expect(graph.edges.every(edge => ids.has(edge.from) && ids.has(edge.to))).toBe(true)
  })
  it('is deterministic, depth sorted and really changes projection on rotation', () => {
    const graph = buildMemoryGraph(null, null, { revision: '1', persona: null, skills: [] })
    const initial = projectMemoryGraph(graph.nodes, 0, 0, 1)
    expect(projectMemoryGraph(graph.nodes, 0, 0, 1)).toEqual(initial)
    expect(projectMemoryGraph(graph.nodes, 1, 0.3, 1)).not.toEqual(initial)
    const rotated = projectMemoryGraph(graph.nodes, 1, 0.3, 2)
    expect(rotated.every(node => Number.isFinite(node.left) && Number.isFinite(node.top))).toBe(true)
    expect(rotated.map(node => node.depth)).toEqual(rotated.map(node => node.depth).sort((left, right) => right - left))
  })
  it('draws stored provenance only when both memories are on the visible page', () => {
    const graph = buildMemoryGraph(
      {
        records: [
          { id: 'source', content: 'Source', updatedAt: 1000 },
          { id: 'derived', content: 'Derived', updatedAt: 1000, sourceIds: ['source', 'other-page'] },
        ],
      } as MemoryInventory,
      null,
      { persona: null, skills: [], revision: '1' }
    )
    expect(graph.edges.filter(edge => !edge.grouping)).toEqual([
      { from: 'memory:source', to: 'memory:derived', kind: 'Gespeicherte Herkunft' },
    ])
  })
})
