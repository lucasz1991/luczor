import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getVerifiedAccountSnapshot: vi.fn(),
  open: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }))
vi.mock('@/services/accountPrincipal', () => ({
  getVerifiedAccountSnapshot: mocks.getVerifiedAccountSnapshot,
}))

import {
  bindProjectWorkspace,
  getProjectWorkspace,
  requireProjectWorkspace,
  resetWorkspacePrincipalCacheForTests,
  resolveWorkspacePrincipalId,
  selectAndBindProjectWorkspace,
  selectProjectWorkspaceDirectory,
  unbindProjectWorkspace,
} from '@/services/projectWorkspace'

const READY_BINDING = {
  principal_id: 'account:v2:abc',
  project_id: 'project-1',
  root_path: 'E:\\repos\\luczor',
  display_name: 'luczor',
  is_git_repository: true,
  git_root_path: 'E:\\repos\\luczor',
  status: 'ready',
  created_at: 10,
  updated_at: 20,
}

describe('project workspace service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetWorkspacePrincipalCacheForTests()
    mocks.getVerifiedAccountSnapshot.mockResolvedValue({ principalId: 'account:v2:abc' })
    mocks.invoke.mockImplementation(async command => {
      if (command === 'project_workspace_bind' || command === 'project_workspace_get') return READY_BINDING
      return null
    })
  })

  it('binds, reads and unbinds in the verified account principal without contacting the server directly', async () => {
    const bound = await bindProjectWorkspace('project-1', 'E:\\repos\\luczor')
    const loaded = await getProjectWorkspace('project-1')
    await unbindProjectWorkspace('project-1')

    expect(bound).toEqual({
      principalId: 'account:v2:abc',
      projectId: 'project-1',
      rootPath: 'E:\\repos\\luczor',
      displayName: 'luczor',
      isGitRepository: true,
      gitRootPath: 'E:\\repos\\luczor',
      status: 'ready',
      createdAt: 10,
      updatedAt: 20,
    })
    expect(loaded).toEqual(bound)
    expect(mocks.invoke.mock.calls).toEqual([
      [
        'project_workspace_bind',
        { payload: { principalId: 'account:v2:abc', projectId: 'project-1', rootPath: 'E:\\repos\\luczor' } },
      ],
      ['project_workspace_get', { payload: { principalId: 'account:v2:abc', projectId: 'project-1' } }],
      ['project_workspace_unbind', { payload: { principalId: 'account:v2:abc', projectId: 'project-1' } }],
    ])
  })

  it('derives a stable, non-secret device principal when no account is configured', async () => {
    mocks.getVerifiedAccountSnapshot.mockResolvedValue(null)
    mocks.invoke.mockResolvedValue('ab'.repeat(32))

    const first = await resolveWorkspacePrincipalId()
    const second = await resolveWorkspacePrincipalId()

    expect(first).toMatch(/^device:v1:[a-f0-9]{64}$/u)
    expect(second).toBe(first)
    expect(first).not.toContain('ab'.repeat(16))
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).toHaveBeenCalledWith('memory_key_get_or_create')
  })

  it('fails closed into the isolated literal device scope if account verification and keychain access fail', async () => {
    mocks.getVerifiedAccountSnapshot.mockRejectedValue(new Error('unverified credential'))
    mocks.invoke.mockRejectedValue(new Error('keychain unavailable'))

    await expect(resolveWorkspacePrincipalId()).resolves.toBe('device-local')
  })

  it('uses the native directory picker and leaves state unchanged when it is canceled', async () => {
    mocks.open.mockResolvedValueOnce(null).mockResolvedValueOnce('E:\\repos\\luczor')

    await expect(selectAndBindProjectWorkspace('project-1')).resolves.toBeNull()
    await expect(selectProjectWorkspaceDirectory('Ordner wählen')).resolves.toBe('E:\\repos\\luczor')

    expect(mocks.open).toHaveBeenNthCalledWith(1, {
      directory: true,
      multiple: false,
      title: 'Projektordner auswählen',
    })
    expect(mocks.open).toHaveBeenNthCalledWith(2, { directory: true, multiple: false, title: 'Ordner wählen' })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('requires a ready binding before project-bound tools may run', async () => {
    mocks.invoke.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...READY_BINDING, status: 'missing' })

    await expect(requireProjectWorkspace('project-1')).rejects.toThrow('noch kein lokaler Ordner')
    await expect(requireProjectWorkspace('project-1')).rejects.toThrow('nicht verfügbar (missing)')
  })
})
