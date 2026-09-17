import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import {
  bindRepository,
  indexRepository,
  readRepositorySnippets,
  repositoryGraphStatus,
  inspectRepositoryGraph,
  searchRepository,
  unbindRepository,
} from '@/services/repositoryGraph'

describe('repository graph principal boundary', () => {
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue({})
  })

  it('passes the verified principal explicitly to every native graph command', async () => {
    const principalId = 'account:verified-principal'

    await bindRepository(principalId, 'project-1', 'E:\\repos\\luczor')
    await indexRepository(principalId, 'project-1')
    await repositoryGraphStatus(principalId, 'project-1')
    await inspectRepositoryGraph(principalId, 'project-1', 'Memory', 40)
    await searchRepository(principalId, 'project-1', 'MemoryController', 7)
    await readRepositorySnippets(principalId, 'project-1', ['evidence-1'], 4096)
    await unbindRepository(principalId, 'project-1', true)

    expect(mocks.invoke.mock.calls).toEqual([
      ['local_graph_bind', { principalId, projectId: 'project-1', rootPath: 'E:\\repos\\luczor' }],
      ['local_graph_index', { principalId, projectId: 'project-1' }],
      ['local_graph_status', { principalId, projectId: 'project-1' }],
      ['local_graph_inspect', { principalId, projectId: 'project-1', query: 'Memory', offset: 40 }],
      ['local_graph_search', { principalId, projectId: 'project-1', query: 'MemoryController', limit: 7 }],
      [
        'local_graph_read_snippets',
        { principalId, projectId: 'project-1', evidenceIds: ['evidence-1'], maxTotalBytes: 4096 },
      ],
      ['local_graph_unbind', { principalId, projectId: 'project-1', deleteIndex: true }],
    ])
  })
})
