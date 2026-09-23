import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  principal: vi.fn(),
  workspace: vi.fn(),
  status: vi.fn(),
  search: vi.fn(),
  read: vi.fn(),
  policy: vi.fn(),
}))
vi.mock('@/services/projectWorkspace', () => ({
  resolveWorkspacePrincipalId: mock.principal,
  getProjectWorkspace: mock.workspace,
}))
vi.mock('@/services/repositoryGraph', () => ({
  repositoryGraphStatus: mock.status,
  searchRepository: mock.search,
  readRepositorySnippets: mock.read,
  getRepositoryExternalPolicy: mock.policy,
}))
import { repositoryTools } from '@/services/tools/repository'
import { executionGate } from '@/services/executionGate'
import { focusedTools } from '@/services/inference/focusedTools'
import { toolDiscovery, searchToolCatalog } from '@/services/tools/discovery'

const tool = (name: string) => repositoryTools.find(tool => tool.name === name)!
const context = { projectId: 'project', inferenceTarget: 'local' as const }
const workspace = { rootPath: 'E:/synthetic', status: 'ready', updatedAt: 10 }
const ready = {
  status: 'ready',
  repository_id: 'repo',
  files: 2,
  symbols: 3,
  edges: 2,
  lsp: { status: 'error', reason: 'lsp_worker_failed', scanned: 0, files: 2 },
}

describe('repository graph tools', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    executionGate.update({ mode: 'observe', killSwitch: false, scope: 'account' })
    mock.principal.mockResolvedValue('account')
    mock.workspace.mockResolvedValue(workspace)
    mock.status.mockResolvedValue(ready)
    mock.policy.mockResolvedValue('deny')
    mock.search.mockResolvedValue({
      repository_id: 'repo',
      hits: [{ evidence_id: 'exact-1', relative_path: 'src/exact.ts', stale: false }],
    })
    mock.read.mockResolvedValue({
      snippets: [{ evidence_id: 'exact-1', relative_path: 'src/exact.ts', content_hash: 'verified' }],
      omitted: [],
    })
  })

  it('keeps syntax graph retrieval usable with explicit failed LSP status and exact source references', async () => {
    expect(await tool('repository_search').execute({ query: 'Symbol' }, context)).toMatchObject({
      status: { lsp: { status: 'error' } },
      next_tool: 'repository_read',
      hits: [{ evidence_id: 'exact-1', relative_path: 'src/exact.ts' }],
    })
    expect(mock.search).toHaveBeenCalledExactlyOnceWith('account', 'project', 'Symbol', 4, 'agent')
    await tool('repository_read').execute({ evidence_ids: ['exact-1'], query: 'Symbol' }, context)
    expect(mock.read).toHaveBeenCalledExactlyOnceWith('account', 'project', ['exact-1'], 16 * 1024, 'agent', 'Symbol')
  })

  it('reports absent indexes and explicitly falls back to file search without reindexing', async () => {
    mock.status.mockResolvedValue({ ...ready, status: 'unindexed' })
    expect(await tool('repository_search').execute({ query: 'Symbol' }, context)).toMatchObject({
      hits: [],
      next_tool: 'fs_search',
    })
    expect(mock.search).not.toHaveBeenCalled()
  })

  it('can return graph status alone while keeping a non-empty optional tool schema', async () => {
    expect(tool('repository_status').parameters).toMatchObject({ properties: { include_lsp: { type: 'boolean' } } })
    expect(await tool('repository_status').execute({}, context)).toHaveProperty('lsp', ready.lsp)
    expect(await tool('repository_status').execute({ include_lsp: false }, context)).not.toHaveProperty('lsp')
    await expect(tool('repository_status').execute({ include_lsp: 'no' }, context)).rejects.toThrow()
    expect(mock.status).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid selectors/IDs and range values before any native search', async () => {
    await expect(tool('repository_search').execute({ query: 'Symbol', limit: 100 }, context)).rejects.toThrow('Bereich')
    await expect(tool('repository_read').execute({ path: '#css' }, context)).rejects.toThrow('Pflichtfeld')
    expect(mock.search).not.toHaveBeenCalled()
    expect(mock.read).not.toHaveBeenCalled()
  })

  it('fences mismatched projects, work copies, changed accounts and late workspace rebindings', async () => {
    const execution = executionGate.capture(undefined, { projectId: 'other', runId: 'other-run' })
    await expect(tool('repository_status').execute({}, { ...context, execution })).rejects.toThrow('scope_mismatch')
    expect(mock.status).not.toHaveBeenCalled()
    mock.principal.mockResolvedValueOnce('account').mockResolvedValueOnce('other')
    await expect(tool('repository_status').execute({}, context)).rejects.toThrow('scope_changed')
    mock.principal.mockResolvedValue('account')
    mock.workspace.mockResolvedValueOnce(workspace).mockResolvedValueOnce({ ...workspace, updatedAt: 11 })
    await expect(tool('repository_status').execute({}, context)).rejects.toThrow('scope_changed')
  })

  it('never sends locally scoped graph evidence to an unapproved external route', async () => {
    for (const policy of ['deny', 'ask']) {
      mock.policy.mockResolvedValue(policy)
      await expect(
        tool('repository_search').execute({ query: 'Symbol' }, { ...context, inferenceTarget: 'external' })
      ).rejects.toThrow('repository_external_access_unavailable')
    }
    expect(mock.search).not.toHaveBeenCalled()
    mock.policy.mockResolvedValue('allow_selected')
    await expect(
      tool('repository_search').execute({ query: 'Symbol' }, { ...context, inferenceTarget: 'external' })
    ).resolves.toHaveProperty('hits')
  })

  it('discards an answer arriving after Stop', async () => {
    const controller = new AbortController()
    mock.search.mockImplementation(async () => {
      controller.abort()
      return { repository_id: 'repo', hits: [] }
    })
    await expect(
      tool('repository_search').execute({ query: 'Symbol' }, { ...context, signal: controller.signal })
    ).rejects.toThrow()
  })

  it('advertises graph search for code tasks with German and English discovery terms', () => {
    const pool = [
      ...repositoryTools,
      ...[
        'project_get_state',
        'fs_list',
        'fs_read',
        'fs_search',
        'agent_assist',
        'agent_assist_status',
        'agent_assist_stop',
        'workspace_get',
        'os_environment',
        'task_list',
      ].map(name => ({ name, description: 'code file project', parameters: {} })),
    ].map(definition => ({
      type: 'function' as const,
      function: { name: definition.name, description: definition.description, parameters: definition.parameters },
    }))
    for (const objective of ['Analysiere den Quellcode und seine Referenzen.', 'Funktion finden', 'Find callers']) {
      const selected = focusedTools(objective, () => []).select(pool)
      expect(selected.map(tool => tool.function.name)).toContain('repository_search')
    }
    expect(toolDiscovery(pool[0]!)).toMatchObject({ category: 'knowledge/repository/read' })
    for (const query of ['LSP', 'Sprachserver', 'Aufrufer', 'references'])
      expect(
        searchToolCatalog(pool, query).some(hit => hit.tool.function.name === 'repository_search' && hit.score > 0)
      ).toBe(true)
  })
})
