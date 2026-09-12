import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  resolveWorkspacePrincipalId: vi.fn(),
  getProjectWorkspace: vi.fn(),
  getRepositoryExternalPolicy: vi.fn(),
  executionAssert: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/services/projectWorkspace', () => ({
  resolveWorkspacePrincipalId: mocks.resolveWorkspacePrincipalId,
  getProjectWorkspace: mocks.getProjectWorkspace,
}))
vi.mock('@/services/repositoryGraph', () => ({
  getRepositoryExternalPolicy: mocks.getRepositoryExternalPolicy,
}))
vi.mock('@/services/executionGate', () => {
  const ticket = { sessionId: 'execution-session', generation: 7, signal: new AbortController().signal }
  return {
    executionGate: { capture: () => ticket, assert: mocks.executionAssert },
    invokeGuarded: async (
      command: string,
      payload: Record<string, unknown>,
      supplied: typeof ticket,
      mutating: boolean
    ) => {
      mocks.executionAssert(supplied, mutating)
      const result = await mocks.invoke(command, {
        payload: { ...payload, execution: { sessionId: supplied.sessionId, generation: supplied.generation } },
      })
      mocks.executionAssert(supplied, mutating)
      return result
    },
  }
})

import { filesystemTools, workspaceRelativePath } from '@/services/tools/filesystem'

const CONTEXT = { projectId: 'project-1' }

function tool(name: string) {
  const definition = filesystemTools.find(candidate => candidate.name === name)
  if (!definition) throw new Error(`missing tool ${name}`)
  return definition
}

describe('project-bound filesystem tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveWorkspacePrincipalId.mockResolvedValue('account:v2:abc')
    mocks.getProjectWorkspace.mockResolvedValue({
      projectId: 'project-1',
      rootPath: 'E:\\private\\luczor',
      displayName: 'luczor',
      isGitRepository: true,
      status: 'ready',
      updatedAt: 42,
    })
    mocks.getRepositoryExternalPolicy.mockResolvedValue('allow_selected')
    mocks.invoke.mockResolvedValue({ ok: true })
    mocks.executionAssert.mockImplementation(() => undefined)
  })

  it('exposes only relative model arguments and approval-gates every read and write', () => {
    expect(filesystemTools.map(definition => definition.name)).toEqual([
      'workspace_get',
      'fs_list',
      'fs_stat',
      'fs_read',
      'fs_search',
      'fs_write',
      'fs_create_dir',
      'fs_move',
      'fs_delete',
    ])

    for (const definition of filesystemTools) {
      expect(definition.requiresApproval).toBe(true)
      const schema = JSON.stringify(definition.parameters)
      expect(schema).not.toMatch(/principal|project_id|projectId|root_path|rootPath|absolute/iu)
    }

    for (const name of [
      'fs_list',
      'fs_stat',
      'fs_read',
      'fs_search',
      'fs_write',
      'fs_create_dir',
      'fs_move',
      'fs_delete',
    ]) {
      expect(tool(name).dataHandling).toBe('ephemeral')
      expect(tool(name).scope).toBe('project')
    }
  })
  it('sends registered workflow scope for file operations and rejects a rebound source before IPC', async () => {
    const workflowScope = {
      principalId: 'account:v2:abc',
      projectId: 'project-1',
      runId: '11111111-1111-4111-8111-111111111111',
      expectedRootPath: 'E:/frozen-copy',
      expectedWorkspaceUpdatedAt: 42,
    }
    await tool('fs_write').execute({ path: 'result.txt', content: 'Build result' }, { ...CONTEXT, workflowScope })
    expect(mocks.invoke).toHaveBeenCalledWith('project_fs_write', {
      payload: expect.objectContaining({ expectedRootPath: 'E:/frozen-copy', workflowScope, path: 'result.txt' }),
    })
    mocks.invoke.mockClear()
    mocks.getProjectWorkspace.mockResolvedValueOnce({ rootPath: 'E:/new-source', updatedAt: 43, status: 'ready' })
    await expect(
      tool('fs_read').execute({ path: 'result.txt' }, { ...CONTEXT, inferenceTarget: 'local', workflowScope })
    ).rejects.toThrow('Projektfreigabe')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('normalizes harmless paths and rejects absolute paths and traversal before native IPC', () => {
    expect(workspaceRelativePath('src\\services/./memory.ts')).toBe('src/services/memory.ts')
    expect(workspaceRelativePath('', '.')).toBe('.')

    expect(() => workspaceRelativePath('..\\secret.txt')).toThrow("must not contain '..'")
    expect(() => workspaceRelativePath('src/../secret.txt')).toThrow("must not contain '..'")
    expect(() => workspaceRelativePath('E:\\private\\secret.txt')).toThrow('must be relative')
    expect(() => workspaceRelativePath('\\\\server\\share\\secret.txt')).toThrow('must be relative')
    expect(() => workspaceRelativePath('/etc/passwd')).toThrow('must be relative')
  })

  it('binds native reads to the captured execution generation and exact workspace version', async () => {
    await tool('fs_list').execute({ path: 'src', max_depth: 3, limit: 25 }, CONTEXT)
    await tool('fs_read').execute({ path: 'README.md', max_bytes: 1000 }, CONTEXT)

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'project_fs_list', {
      payload: {
        principalId: 'account:v2:abc',
        projectId: 'project-1',
        expectedRootPath: 'E:\\private\\luczor',
        expectedWorkspaceUpdatedAt: 42,
        path: 'src',
        maxDepth: 3,
        limit: 25,
        execution: { sessionId: 'execution-session', generation: 7 },
      },
    })
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'project_fs_read', {
      payload: {
        principalId: 'account:v2:abc',
        projectId: 'project-1',
        expectedRootPath: 'E:\\private\\luczor',
        expectedWorkspaceUpdatedAt: 42,
        path: 'README.md',
        maxBytes: 1000,
        startLine: null,
        endLine: null,
        execution: { sessionId: 'execution-session', generation: 7 },
      },
    })

    await expect(tool('fs_read').execute({ path: 'README.md', start_line: 20, end_line: 10 }, CONTEXT)).rejects.toThrow(
      'end_line must be greater than or equal to start_line'
    )
  })

  it('cannot bypass the repository egress policy through direct filesystem reads', async () => {
    mocks.getRepositoryExternalPolicy.mockResolvedValue('deny')

    await expect(tool('fs_read').execute({ path: 'README.md' }, CONTEXT)).rejects.toThrow('nicht an das externe Modell')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('routes bounded mutations and rejects attempts to mutate the workspace root', async () => {
    await tool('fs_write').execute(
      { path: 'src/new.ts', content: 'export {}', expected_sha256: 'a'.repeat(64) },
      CONTEXT
    )
    await tool('fs_move').execute({ from_path: 'src/old.ts', to_path: 'src/new.ts' }, CONTEXT)

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'project_fs_write', {
      payload: {
        principalId: 'account:v2:abc',
        projectId: 'project-1',
        expectedRootPath: 'E:\\private\\luczor',
        expectedWorkspaceUpdatedAt: 42,
        path: 'src/new.ts',
        content: 'export {}',
        expectedSha256: 'a'.repeat(64),
        execution: { sessionId: 'execution-session', generation: 7 },
      },
    })
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'project_fs_move', {
      payload: {
        principalId: 'account:v2:abc',
        projectId: 'project-1',
        expectedRootPath: 'E:\\private\\luczor',
        expectedWorkspaceUpdatedAt: 42,
        fromPath: 'src/old.ts',
        toPath: 'src/new.ts',
        execution: { sessionId: 'execution-session', generation: 7 },
      },
    })

    await expect(tool('fs_delete').execute({ path: '.' }, CONTEXT)).rejects.toThrow('inside the active project')
    await expect(tool('fs_create_dir').execute({ path: '..' }, CONTEXT)).rejects.toThrow("must not contain '..'")
  })

  it('returns workspace metadata to the model without returning the local absolute path', async () => {
    const result = await tool('workspace_get').execute({}, CONTEXT)

    expect(result).toEqual({ bound: true, status: 'ready', display_name: 'luczor', is_git_repository: true })
    expect(JSON.stringify(result)).not.toContain('E:\\private\\luczor')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
