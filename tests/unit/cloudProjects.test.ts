import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, Project } from '@/state/types'

const harness = vi.hoisted(() => ({
  request: vi.fn(),
  save: vi.fn(),
  account: vi.fn(),
  state: {} as AppState,
}))
vi.mock('@/state/store', () => ({ state: harness.state }))
vi.mock('@/services/api/luczorApi', () => ({ requestWithConfig: harness.request }))
vi.mock('@/services/persistence', () => ({ saveAppStateStrict: harness.save }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: harness.account }))
import {
  cloudProjectsState,
  copyCloudProject,
  configureCloudProjectWorkload,
  importCloudProject,
  invalidateCloudProjects,
  publishCloudProject,
  snapshotForCloud,
  syncCloudProjects,
  validateSnapshot,
  saveCloudProjectFile,
  type CloudProjectDocument,
  type CloudProjectSnapshot,
} from '@/services/api/cloudProjects'
import { canAccessCloudProject, cloudProjectPrincipal, projectExternalIdForServer } from '@/services/cloudProjectAccess'

const account = {
  principalId: 'account-a',
  serverOrigin: 'https://luczor.test',
  serverInstance: 'https://luczor.test',
  accountId: 1,
  config: { baseUrl: 'https://luczor.test', deviceKey: 'key-a', clientId: 'device-a' },
}
const project = (): Project => ({
  id: 'default',
  name: 'Projekt',
  goals: [],
  summary: 'Lokal',
  defaults: { maxOutputTokens: 2048 },
  focus: { activeTodoId: null, activeStepId: null },
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
})
const remote = (snapshot = snapshotForCloud('default'), revision = 1): CloudProjectDocument => ({
  project_id: 7,
  external_id: 'default',
  revision,
  snapshot: structuredClone(snapshot),
  updated_at: '2026-09-12T10:00:00Z',
  updated_by_device: 'device-b',
})
let cloud: CloudProjectDocument

beforeEach(() => {
  invalidateCloudProjects()
  vi.clearAllMocks()
  Object.assign(harness.state, {
    version: 1,
    global: { defaults: { maxOutputTokens: 2048 }, memories: [], ui: {} },
    projects: [project()],
    messages: [],
    summaries: [],
    pending: { toolCallsByProject: {} },
    todos: [],
    todoSteps: [],
    projectMemories: [],
  })
  harness.account.mockResolvedValue(account)
  harness.save.mockResolvedValue(undefined)
  cloud = remote()
  harness.request.mockImplementation(
    async (
      path: string,
      options: { method?: string; body?: { snapshot: CloudProjectSnapshot; expected_revision: number } }
    ) => {
      if (path === '/projects' && options.method === 'POST') return { data: { id: 7 } }
      if (path === '/projects/7/cloud' && options.method === 'PUT') {
        cloud = remote(options.body!.snapshot, options.body!.expected_revision + 1)
        return { data: structuredClone(cloud) }
      }
      if (path === '/projects/7/cloud') return { data: structuredClone(cloud) }
      throw new Error(`Unexpected API request: ${path}`)
    }
  )
})

describe('portable user-owned cloud projects', () => {
  it('publishes only public portable data and never device paths, raw output or account memories', async () => {
    Object.assign(harness.state.projects[0]!, { rootPath: 'C:\\secret', apiKey: 'secret' })
    harness.state.messages = [
      {
        id: 'public',
        projectId: 'default',
        role: 'assistant',
        content: 'Fertig',
        ts: 2,
        createdAt: 2,
        visibility: 'visible',
        raw: 'PRIVATE_REASONING',
        parsed: { secret: true },
        meta: { model: 'local' },
      },
      {
        id: 'private',
        projectId: 'default',
        role: 'tool',
        content: 'PRIVATE_FILE',
        ts: 3,
        createdAt: 3,
        visibility: 'hidden',
        parsed: null,
        meta: { dataHandling: 'ephemeral' },
      },
    ]
    await publishCloudProject('default')
    const body = harness.request.mock.calls[1]![1].body
    expect(body.expected_revision).toBe(0)
    expect(body.snapshot.messages).toEqual([
      { id: 'public', role: 'assistant', content: 'Fertig', ts: 2, createdAt: 2, visibility: 'visible' },
    ])
    expect(JSON.stringify(body)).not.toMatch(/secret|PRIVATE|rootPath|defaults|parsed|meta/)
    expect(harness.state.projects[0]!.cloud).toMatchObject({ principalId: 'account-a', projectId: 7, revision: 1 })
    expect(harness.save).toHaveBeenCalledOnce()
  })

  it('publishes later changes against the last applied revision', async () => {
    await publishCloudProject('default')
    harness.state.projects[0]!.summary = 'Fortschritt'
    await syncCloudProjects('default')
    expect(cloud.snapshot.project.summary).toBe('Fortschritt')
    expect(harness.state.projects[0]!.cloud!.revision).toBe(2)
    expect(harness.request.mock.calls.at(-1)![1].body.expected_revision).toBe(1)
  })

  it('keeps private project records on the device during upload and remote refresh', async () => {
    harness.state.global.memories.push(
      Object.assign(
        {
          id: 'private-memory',
          projectId: 'default',
          kind: 'note' as const,
          key: 'private',
          value: 'PRIVATE_MEMORY',
          priority: 3 as const,
          active: true,
          createdAt: 1,
          updatedAt: 1,
          source: { by: 'user' as const },
        },
        { visibility: 'private' }
      )
    )
    harness.state.messages.push({
      id: 'private-answer',
      projectId: 'default',
      role: 'assistant',
      content: 'PRIVATE_ANSWER',
      ts: 1,
      createdAt: 1,
      parsed: null,
      visibility: 'visible',
      meta: { serverSpeechAllowed: false },
    })
    await publishCloudProject('default')
    expect(cloud.snapshot.memories).toEqual([])
    expect(cloud.snapshot.messages).toEqual([])
    cloud.revision++
    cloud.snapshot.project.summary = 'Remote change'
    await syncCloudProjects('default')
    expect(harness.state.global.memories[0]!.value).toBe('PRIVATE_MEMORY')
    expect(harness.state.messages[0]!.content).toBe('PRIVATE_ANSWER')
  })

  it('recovers a committed write after a lost acknowledgement without a second PUT', async () => {
    harness.request.mockImplementationOnce(async () => ({ data: { id: 7 } }))
    harness.request.mockImplementationOnce(async (_path, options) => {
      cloud = remote(options.body.snapshot, 1)
      throw Object.assign(new Error('network lost'), { status: 0 })
    })
    await publishCloudProject('default')
    expect(harness.state.projects[0]!.cloud!.revision).toBe(1)
    expect(harness.request.mock.calls.filter(call => call[1].method === 'PUT')).toHaveLength(1)
  })

  it('preserves live content when a remote pull cannot be saved to disk', async () => {
    await publishCloudProject('default')
    cloud.snapshot.project.summary = 'Remote content'
    cloud.revision = 2
    harness.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(syncCloudProjects('default')).rejects.toThrow('disk full')
    expect(harness.state.projects[0]!.summary).toBe('Lokal')
    expect(harness.state.projects[0]!.cloud!.revision).toBe(1)
  })

  it('keeps concurrent edits made while the remote candidate is being persisted', async () => {
    await publishCloudProject('default')
    cloud.snapshot.project.summary = 'Remote content'
    cloud.revision = 2
    harness.save.mockImplementationOnce(async () => {
      harness.state.projects[0]!.summary = 'Edited during disk write'
    })
    await expect(syncCloudProjects('default')).rejects.toThrow('während des Speicherns')
    expect(harness.state.projects[0]!.summary).toBe('Edited during disk write')
    expect(harness.state.projects[0]!.cloud!.revision).toBe(1)
  })

  it('persists a conflict review copy already paused, before the first save', async () => {
    await publishCloudProject('default')
    const snapshots: AppState[] = []
    harness.save.mockImplementation(async value => {
      snapshots.push(JSON.parse(JSON.stringify(value)))
    })
    const id = await copyCloudProject('default')
    expect(
      snapshots.every(snapshot => snapshot.projects.find(project => project.id === id)?.cloud?.paused === true)
    ).toBe(true)
    expect(harness.state.projects.find(project => project.id === id)!.name).toContain('Cloud-Kopie')
    expect(harness.state.projects[0]!.name).toBe('Projekt')
  })

  it('imports newer remote content only when local portable state is unchanged and keeps local tool observations', async () => {
    await publishCloudProject('default')
    harness.state.messages.push({
      id: 'local-only',
      projectId: 'default',
      role: 'tool',
      content: 'LOCAL',
      ts: 2,
      createdAt: 2,
      parsed: null,
      visibility: 'hidden',
      meta: { dataHandling: 'ephemeral' },
    })
    cloud.snapshot.project.summary = 'Auf dem Laptop fertig'
    cloud.revision = 2
    await syncCloudProjects('default')
    expect(harness.state.projects[0]!.summary).toBe('Auf dem Laptop fertig')
    expect(harness.state.messages[0]!.content).toBe('LOCAL')
    expect(harness.state.projects[0]!.cloud!.revision).toBe(2)
  })

  it('keeps both sides intact when two devices have edited the project', async () => {
    await publishCloudProject('default')
    harness.state.projects[0]!.summary = 'Lokale Arbeit'
    cloud.snapshot.project.summary = 'Laptop-Arbeit'
    cloud.revision = 2
    const before = harness.request.mock.calls.length
    await syncCloudProjects('default')
    expect(harness.state.projects[0]!.summary).toBe('Lokale Arbeit')
    expect(cloud.snapshot.project.summary).toBe('Laptop-Arbeit')
    expect(cloudProjectsState.status.default!.state).toBe('conflict')
    expect(harness.request.mock.calls.slice(before).every(call => call[1].method === 'GET')).toBe(true)
  })

  it('does not apply a late remote response over newly changed local content', async () => {
    await publishCloudProject('default')
    cloud.revision = 2
    cloud.snapshot.project.summary = 'Cloud'
    harness.request.mockImplementationOnce(async () => {
      harness.state.projects[0]!.summary = 'Neue lokale Änderung'
      return { data: structuredClone(cloud) }
    })
    await syncCloudProjects('default')
    expect(harness.state.projects[0]!.summary).toBe('Neue lokale Änderung')
    expect(cloudProjectsState.status.default!.state).toBe('pending')
  })

  it('keeps same-named local projects when importing from another device and maps server child records', async () => {
    cloud.snapshot.project.summary = 'Remote'
    const id = await importCloudProject(7)
    expect(id).not.toBe('default')
    expect(harness.state.projects.find(item => item.id === 'default')!.summary).toBe('Lokal')
    const imported = harness.state.projects.find(item => item.id === id)!
    expect(imported.cloud).toMatchObject({ externalId: 'default', projectId: 7 })
    expect(imported).not.toHaveProperty('rootPath')
    expect(projectExternalIdForServer(id)).toBe('default')
    expect(await importCloudProject(7)).toBe(id)
  })

  it('rejects stale results and hides cached projects after the account changes', async () => {
    await publishCloudProject('default')
    expect(canAccessCloudProject(harness.state.projects[0]!)).toBe(true)
    harness.request.mockImplementationOnce(async () => {
      invalidateCloudProjects()
      return { data: remote() }
    })
    await expect(syncCloudProjects('default')).rejects.toThrow('Benutzerzuordnung')
    expect(canAccessCloudProject(harness.state.projects[0]!)).toBe(false)
    cloudProjectPrincipal.value = 'account-b'
    expect(() => projectExternalIdForServer('default')).toThrow('anderen Benutzer')
  })

  it('never synchronizes between tool rounds or during another active workload', async () => {
    const dispose = configureCloudProjectWorkload(() => true)
    try {
      await expect(publishCloudProject('default')).rejects.toThrow('Auftrag läuft')
    } finally {
      dispose()
    }
    expect(harness.request).not.toHaveBeenCalled()
  })

  it('does not report a durable link after local persistence failed', async () => {
    harness.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(publishCloudProject('default')).rejects.toThrow('disk full')
    expect(harness.state.projects[0]!.cloud).toBeUndefined()
  })

  it('rejects oversized and unsafe snapshots without silently truncating content', () => {
    const snapshot = snapshotForCloud('default')
    expect(() =>
      validateSnapshot({
        ...snapshot,
        messages: [{ id: '__proto__', role: 'assistant', content: 'x', ts: 1, createdAt: 1 }],
      })
    ).toThrow('ID')
    expect(() => validateSnapshot({ ...snapshot, messages: Array.from({ length: 2001 }, () => ({})) })).toThrow('2000')
    expect(() =>
      validateSnapshot({ ...snapshot, messages: [{ id: 'tool', role: 'tool', content: 'secret' }] })
    ).toThrow('öffentliche')
  })

  it('submits selected text files with their revision and preserves file conflicts', async () => {
    await publishCloudProject('default')
    const conflict = Object.assign(new Error('Dateikonflikt'), { status: 409 })
    harness.request.mockRejectedValueOnce(conflict)
    await expect(saveCloudProjectFile('default', 'docs/readme.md', 'text', 4)).rejects.toBe(conflict)
    expect(harness.request.mock.calls.at(-1)![1].body).toEqual({
      path: 'docs/readme.md',
      content: 'text',
      expected_revision: 4,
    })
    await expect(saveCloudProjectFile('default', 'large.txt', 'x'.repeat(1024 * 1024 + 1), 0)).rejects.toThrow('1 MiB')
  })
})
