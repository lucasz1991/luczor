import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProjectSnapshot } from '@/services/agents/types'

const storage = vi.hoisted(() => ({ data: new Map<string, unknown>(), get: vi.fn(), set: vi.fn(), save: vi.fn() }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => storage } }))
import { getAgentProjectLink, saveAgentProjectLink } from '@/services/agents/links'

const threadId = '00000000-0000-4000-8000-000000000001'
const project: AgentProjectSnapshot = {
  principalId: 'account:test',
  projectId: 'project-test',
  projectName: 'Project',
  rootPath: 'E:\\project',
  workspaceUpdatedAt: 10,
}

beforeEach(() => {
  vi.clearAllMocks()
  storage.data.clear()
  storage.get.mockImplementation(async key => storage.data.get(key))
  storage.set.mockImplementation(async (key, value) => {
    storage.data.set(key, value)
  })
  storage.save.mockResolvedValue(undefined)
})

describe('local Codex project links', () => {
  it('reuses only the same account, project, root and workspace binding version', async () => {
    await saveAgentProjectLink(project, threadId, async () => undefined)
    expect((await getAgentProjectLink(project))?.externalThreadId).toBe(threadId)
    for (const changed of [
      { principalId: 'other' },
      { projectId: 'other' },
      { rootPath: 'E:\\other' },
      { workspaceUpdatedAt: 11 },
    ]) {
      expect(await getAgentProjectLink({ ...project, ...changed })).toBeUndefined()
    }
  })

  it('revalidates scope after store reads and refuses a stale completion write', async () => {
    storage.get.mockImplementation(async () => {
      throw new Error('not used')
    })
    const validate = vi.fn(async () => {
      throw new Error('rebound')
    })
    storage.get.mockResolvedValue([])
    await expect(saveAgentProjectLink(project, threadId, validate)).rejects.toThrow('rebound')
    expect(validate).toHaveBeenCalledWith(project)
    expect(storage.set).not.toHaveBeenCalled()
  })

  it('recovers serialization after rejected writes and stores no prompts/results', async () => {
    await expect(
      saveAgentProjectLink(project, threadId, async () => {
        throw new Error('stale')
      })
    ).rejects.toThrow()
    await saveAgentProjectLink(project, threadId, async () => undefined)
    const value = await getAgentProjectLink(project)
    expect(Object.keys(value!).sort()).toEqual([
      'adapterId',
      'externalThreadId',
      'principalId',
      'projectId',
      'updatedAt',
      'workspaceRoot',
      'workspaceUpdatedAt',
    ])
  })

  it('ignores malformed records and refuses command-like thread IDs', async () => {
    storage.data.set('links_v1', [
      { ...project, adapterId: 'codex', workspaceRoot: project.rootPath, externalThreadId: '--last', updatedAt: 1 },
    ])
    expect(await getAgentProjectLink(project)).toBeUndefined()
    await expect(saveAgentProjectLink(project, '--last', async () => undefined)).rejects.toThrow('Ungültige')
    expect(storage.set).not.toHaveBeenCalled()
  })
})
