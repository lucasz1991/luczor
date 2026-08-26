import { describe, expect, it } from 'vitest'
import { messagesForSync, projectsForSync } from '@/services/api/sync'
import type { Message } from '@/state/types'

function message(id: string, dataHandling: 'syncable' | 'ephemeral'): Message {
  return {
    id,
    projectId: 'project-1',
    role: 'tool',
    content: '',
    ts: 1,
    createdAt: 1,
    parsed: { ok: true, output: id === 'local' ? 'LOCAL_SECRET' : { ok: true } },
    visibility: 'hidden',
    meta: { toolName: 'test_tool', dataHandling },
  }
}

describe('sync privacy allowlists', () => {
  it('excludes ephemeral tool observations from the server archive', () => {
    const result = messagesForSync([message('local', 'ephemeral'), message('safe', 'syncable')])

    expect(result.map(item => item.id)).toEqual(['safe'])
    expect(JSON.stringify(result)).not.toContain('LOCAL_SECRET')
  })

  it('never includes local workspace or repository path metadata in projects', () => {
    const result = projectsForSync([
      {
        id: 'project-1',
        name: 'Luczor',
        summary: 'Status',
        root_path: 'E:\\private\\luczor',
        project_dir: 'E:\\private\\luczor',
        workspace: { canonicalPath: 'E:\\private\\luczor' },
        graph: { repositoryPath: 'E:\\private\\luczor' },
      },
    ])

    expect(result).toEqual([
      expect.objectContaining({
        id: 'project-1',
        name: 'Luczor',
        summary: 'Status',
      }),
    ])
    expect(JSON.stringify(result)).not.toContain('E:\\private')
    expect(result[0]).not.toHaveProperty('workspace')
    expect(result[0]).not.toHaveProperty('graph')
  })
})
