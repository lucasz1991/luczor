import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceRefresh, watchWorkspaceBinding } from '@/services/workspaceRefresh'
import type { ProjectWorkspaceBinding } from '@/services/projectWorkspace'

const binding = (projectId = 'p1', principalId = 'account-a'): ProjectWorkspaceBinding => ({
  projectId,
  principalId,
  rootPath: 'E:\\project',
  displayName: 'Project',
  status: 'ready',
  isGitRepository: false,
  updatedAt: 1,
})
function deferred<T>() {
  let resolve!: (result: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function fixture() {
  let projectId = 'p1'
  let principalId = 'account-a'
  const apply = vi.fn()
  const failed = vi.fn()
  const load = vi.fn<(projectId: string, principalId: string) => Promise<ProjectWorkspaceBinding | null>>()
  const refresh = createWorkspaceRefresh({
    projectId: () => projectId,
    principal: async () => principalId,
    load,
    apply,
    failed,
  })
  return {
    refresh,
    apply,
    failed,
    load,
    project: (next: string) => {
      projectId = next
      refresh.invalidate()
    },
    principal: (next: string) => {
      principalId = next
    },
  }
}

describe('workspace identity and refresh lifecycle', () => {
  it('keeps a live execution signal when the same native binding is read again', () => {
    const current = ref<ProjectWorkspaceBinding | null>(binding())
    const execution = new AbortController()
    const changed = vi.fn(() => execution.abort())
    const stop = watchWorkspaceBinding(() => current.value, changed)
    current.value = { ...binding() }
    expect(changed).not.toHaveBeenCalled()
    expect(execution.signal.aborted).toBe(false)
    current.value = { ...binding(), displayName: 'Renamed display only' }
    expect(changed).not.toHaveBeenCalled()
    current.value = { ...binding(), updatedAt: 2 }
    expect(changed).toHaveBeenCalledTimes(1)
    expect(execution.signal.aborted).toBe(true)
    stop()
  })

  it.each(['principalId', 'projectId', 'rootPath', 'gitRootPath', 'status'] as const)(
    'invalidates actual changes in the protected %s binding field',
    field => {
      const current = ref<ProjectWorkspaceBinding | null>(binding())
      const changed = vi.fn()
      const stop = watchWorkspaceBinding(() => current.value, changed)
      current.value = { ...binding(), [field]: field === 'status' ? 'missing' : 'changed' }
      expect(changed).toHaveBeenCalledTimes(1)
      stop()
    }
  )

  it('loads with an explicit principal and applies a correctly scoped current result', async () => {
    const context = fixture()
    context.load.mockResolvedValue(binding())
    await context.refresh.refresh()
    expect(context.load).toHaveBeenCalledWith('p1', 'account-a')
    expect(context.apply).toHaveBeenCalledWith(binding())
    expect(context.failed).not.toHaveBeenCalled()
  })

  it('discards an old project response even after switching away and back', async () => {
    const context = fixture()
    const pending = deferred<ProjectWorkspaceBinding | null>()
    context.load.mockReturnValue(pending.promise)
    const reading = context.refresh.refresh()
    await Promise.resolve()
    context.project('p2')
    context.project('p1')
    pending.resolve(binding())
    await reading
    expect(context.apply).not.toHaveBeenCalled()
    expect(context.failed).not.toHaveBeenCalled()
  })

  it('does not apply a binding if the verified principal changed while loading', async () => {
    const context = fixture()
    const pending = deferred<ProjectWorkspaceBinding | null>()
    context.load.mockReturnValue(pending.promise)
    const reading = context.refresh.refresh()
    await Promise.resolve()
    context.principal('account-b')
    pending.resolve(binding())
    await reading
    expect(context.apply).not.toHaveBeenCalled()
    expect(context.failed).not.toHaveBeenCalled()
  })

  it('does not clear a newer successful refresh when an older request fails late', async () => {
    const context = fixture()
    const old = deferred<ProjectWorkspaceBinding | null>()
    context.load.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ...binding(), updatedAt: 2 })
    const previousRead = context.refresh.refresh()
    await Promise.resolve()
    await context.refresh.refresh()
    old.reject(new Error('Old native read failed'))
    await previousRead
    expect(context.apply).toHaveBeenCalledExactlyOnceWith({ ...binding(), updatedAt: 2 })
    expect(context.failed).not.toHaveBeenCalled()
  })

  it('rejects mismatched native project or principal data', async () => {
    const context = fixture()
    context.load.mockResolvedValue(binding('p2', 'account-b'))
    await context.refresh.refresh()
    expect(context.apply).not.toHaveBeenCalled()
    expect(context.failed).toHaveBeenCalledTimes(1)
  })

  it('discards pending results after disposal', async () => {
    const context = fixture()
    const pending = deferred<ProjectWorkspaceBinding | null>()
    context.load.mockReturnValue(pending.promise)
    const reading = context.refresh.refresh()
    await Promise.resolve()
    context.refresh.dispose()
    pending.resolve(binding())
    await reading
    expect(context.apply).not.toHaveBeenCalled()
    expect(context.failed).not.toHaveBeenCalled()
  })
})
