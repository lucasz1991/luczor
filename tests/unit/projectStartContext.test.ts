import { describe, expect, it, vi } from 'vitest'
import { buildProjectStartContext } from '@/services/prompt/projectStartContext'
import { luczorMemory } from '@/services/memory/luczorMemory'
import type { MemoryRecord } from '@/services/memory/luczorMemory'
import type { Project } from '@/state/types'

const project: Project = {
  id: 'project-1',
  name: 'Luczor',
  goal: 'Das System verbessern',
  summary: 'Arbeitsstand unter E:\\private\\luczor; TOKEN=secret-value',
  goals: [
    {
      id: 'goal-1',
      title: 'Workspace binden',
      status: 'in_progress',
      priority: 'high',
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  defaults: { maxOutputTokens: 1_200 },
  focus: { activeTodoId: null, activeStepId: null },
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
}

function memory(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'memory-1',
    principalId: 'account:1',
    scope: 'project',
    dataset: 'project:1',
    content: 'Bestätigte Präferenz',
    contentHash: 'hash',
    type: 'preference',
    visibility: 'syncable',
    status: 'active',
    retention: 'durable',
    sensitivity: 'normal',
    writeIntent: 'confirmed',
    importance: 0.9,
    confidence: 0.95,
    source: 'user',
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    synced: true,
    ...overrides,
  }
}

describe('project start context', () => {
  it('uses only local retrieval and keeps private records out of provider context', async () => {
    const local = vi
      .spyOn(luczorMemory, 'recallLocal')
      .mockResolvedValue([memory({ content: 'Private project decision', visibility: 'private' })])
    const remote = vi.spyOn(luczorMemory, 'recall').mockRejectedValue(new Error('must stay local'))
    try {
      const result = await buildProjectStartContext({ project })
      expect(local).toHaveBeenCalledTimes(2)
      expect(remote).not.toHaveBeenCalled()
      expect(result.providerText).not.toContain('Private project decision')
      expect(result.sourceFragments.find(fragment => fragment.source === 'memory')?.egress).toBe('local_only')
    } finally {
      local.mockRestore()
      remote.mockRestore()
    }
  })
  it('combines project state, workspace alias and confirmed user/project memory without local paths', async () => {
    const recall = vi
      .fn()
      .mockResolvedValueOnce([memory({ id: 'user-memory', scope: 'user', content: 'Antworten auf Deutsch' })])
      .mockResolvedValueOnce([memory({ id: 'project-memory', content: 'Graph bleibt lokal' })])

    const result = await buildProjectStartContext(
      {
        project,
        workspace: {
          principalId: 'account:1',
          projectId: project.id,
          rootPath: 'E:\\private\\luczor',
          displayName: 'luczor',
          isGitRepository: true,
          status: 'ready',
        },
      },
      { recall }
    )

    expect(recall).toHaveBeenNthCalledWith(1, { scope: 'user', query: '', limit: 2 })
    expect(recall).toHaveBeenNthCalledWith(2, { scope: 'project', projectId: 'project-1', query: '', limit: 3 })
    expect(result.providerText).toContain('@project')
    expect(result.providerText).toContain('Antworten auf Deutsch')
    expect(result.providerText).toContain('Graph bleibt lokal')
    expect(result.providerText).not.toContain('E:\\private')
    expect(result.providerText).not.toContain('secret-value')
  })

  it('keeps memory failures non-blocking and never includes candidates supplied by retrieval', async () => {
    const recall = vi.fn().mockRejectedValue(new Error('offline'))
    const result = await buildProjectStartContext({ project, includeMemory: true }, { recall })

    expect(result.providerText).toContain('project-identity')
    expect(result.providerText).not.toContain('memory-')
  })
})
