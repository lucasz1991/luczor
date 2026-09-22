import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  account: vi.fn(),
  native: vi.fn(),
  request: vi.fn(),
  binary: vi.fn(),
  hasChunk: vi.fn(),
  entries: new Map<string, unknown>(),
  listeners: new Map<string, (event: { payload: { projectId: string } }) => void>(),
  state: { projects: [{ id: 'local', cloud: { principalId: 'owner', projectId: 7, externalId: 'global' } }] },
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: { projectId: string } }) => void) => {
    mock.listeners.set(name, handler)
    return () => mock.listeners.delete(name)
  },
}))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async () => ({
      get: async (key: string) => structuredClone(mock.entries.get(key)),
      set: async (key: string, value: unknown) => mock.entries.set(key, structuredClone(value)),
      delete: async (key: string) => mock.entries.delete(key),
      save: async () => {},
    }),
  },
}))
vi.mock('@/state/store', () => ({ state: mock.state }))
vi.mock('@/services/persistence', () => ({ saveAppStateStrict: async () => {} }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: mock.account }))
vi.mock('@/services/projectWorkspace', () => ({ getProjectWorkspace: async () => ({ status: 'ready', updatedAt: 1 }) }))
vi.mock('@/services/executionGate', () => ({
  executionGate: {
    capture: (signal?: AbortSignal) => ({ signal: signal ?? new AbortController().signal }),
    assert: (ticket: { signal: AbortSignal }) => ticket.signal.throwIfAborted(),
  },
  invokeGuarded: mock.native,
}))
vi.mock('@/services/api/luczorApi', () => ({ requestWithConfig: mock.request }))
vi.mock('@/services/runs/resourceCoordinator', () => ({
  withRunResources: (_resources: string[], _signal: AbortSignal, work: () => unknown) => work(),
}))
vi.mock('@/services/coordination/api', () => ({
  coordinationApi: () => ({ state: async () => ({ data: { epoch: 1, leader_device_id: 'master' } }) }),
}))
vi.mock('@/services/coordination/lan', () => ({ readLanChunk: async () => null }))
vi.mock('@/services/coordination/binaryTransport', () => ({
  binaryRequest: mock.binary,
  hasRemoteChunk: mock.hasChunk,
  decodeBase64: () => new Uint8Array([1]),
  encodeBase64: () => 'AQ==',
}))
import {
  MIRROR_WAKE_EVENT,
  projectMirrorState,
  setProjectFolderShared,
  startProjectMirrorChannel,
  syncProjectMirror,
} from '@/services/coordination/mirror'

const base = '/projects/7/mirror'
const sha = 'a'.repeat(64)
type Options = { method?: string; body?: Record<string, unknown> }
beforeEach(() => {
  vi.clearAllMocks()
  mock.entries.clear()
  mock.listeners.clear()
  mock.account.mockResolvedValue({
    accountId: 1,
    principalId: 'owner',
    config: { clientId: 'master', baseUrl: 'https://server', deviceKey: 'key' },
  })
  mock.native.mockImplementation(async (command: string) => {
    if (command === 'project_mirror_scan')
      return {
        manifestHash: 'changed',
        snapshotId: 'snapshot',
        totalEntries: 1,
        entries: [{ path: '.env', type: 'file', size: 1, sha256: sha, chunks: [{ sha256: sha, size: 1 }] }],
      }
    if (command === 'project_mirror_chunk_read') return { dataBase64: 'AQ==' }
    return undefined
  })
  mock.hasChunk.mockResolvedValue(false)
  mock.binary.mockResolvedValue(new Uint8Array())
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('durable full project mirror upload', () => {
  function server(options: {
    revision: number
    shared?: boolean
    merged?: boolean
    conflicts?: number
    publish?: (body: Record<string, unknown>) => void
    create?: (body: Record<string, unknown>) => void
  }) {
    const calls: string[] = []
    let revision = options.revision
    mock.request.mockImplementation(async (path: string, request: Options) => {
      calls.push(`${request.method ?? 'GET'} ${path.slice(base.length) || '/'}`)
      if (path === base)
        return {
          data: { revision, manifest_id: revision ? `head-${revision}` : null, folder_shared: options.shared ?? true },
        }
      if (path.endsWith('/settings'))
        return { data: { revision, manifest_id: null, folder_shared: request.body?.folder_shared } }
      if (path.endsWith('/proposals')) return { data: [] }
      if (path.endsWith('/manifests')) {
        options.create?.(request.body ?? {})
        return {
          data: { manifest_id: 'draft', base_revision: request.body?.base_revision, revision: null, status: 'draft' },
        }
      }
      if (path.endsWith('/lease')) return { data: { lease_id: 'lease' } }
      if (path.endsWith('/publish')) {
        options.publish?.(request.body ?? {})
        revision++
        return {
          data: {
            revision,
            manifest_id: options.merged ? `head-${revision}` : 'draft',
            status: 'published',
            conflict_count: options.conflicts ?? 0,
          },
        }
      }
      if (path.includes('/manifests/head-'))
        return {
          data: {
            revision,
            manifest_id: `head-${revision}`,
            entries: [{ path: 'peer', type: 'file', size: 1, sha256: sha, chunks: [{ sha256: sha, size: 1 }] }],
            next_offset: null,
          },
        }
      return { data: {} }
    })
    return calls
  }
  function applyNative() {
    mock.native.mockImplementation(async (command: string) => {
      if (command === 'project_mirror_scan')
        return {
          manifestHash: 'changed',
          snapshotId: 'snapshot',
          totalEntries: 1,
          entries: [{ path: '.env', type: 'file', size: 1, sha256: sha, chunks: [{ sha256: sha, size: 1 }] }],
        }
      if (command === 'project_mirror_chunk_read') return { dataBase64: 'AQ==' }
      if (command === 'project_mirror_stage_begin') return { stageId: 'stage' }
      if (command === 'project_mirror_stage_commit') return { manifestHash: 'applied', backupPath: '' }
      return undefined
    })
  }

  it('pushes a stale base directly, lets the server merge and applies the merged head in the same run', async () => {
    mock.entries.set('owner:local', { revision: 1, localHash: 'previous', baseManifestId: 'head-1' })
    applyNative()
    const bodies: Record<string, unknown>[] = []
    const calls = server({
      revision: 2,
      merged: true,
      conflicts: 1,
      create: body => bodies.push(body),
      publish: body => bodies.push(body),
    })
    await syncProjectMirror('local')
    expect(bodies[0]).toMatchObject({ base_revision: 1, base_manifest_id: 'head-1', proposal: false, draft: true })
    expect(bodies[1]).toMatchObject({ expected_revision: 2 })
    expect(calls).not.toContain('POST /manifests/draft/propose')
    expect(mock.native).toHaveBeenCalledWith(
      'project_mirror_stage_begin',
      expect.objectContaining({ expectedLocalManifestHash: 'changed' }),
      expect.anything(),
      true
    )
    expect(mock.native).toHaveBeenCalledWith(
      'project_mirror_stage_commit',
      expect.objectContaining({ stageId: 'stage' }),
      expect.anything(),
      true
    )
    expect(mock.entries.get('owner:local')).toEqual({ revision: 3, localHash: 'applied', baseManifestId: 'head-3' })
    expect(mock.entries.has('owner:local:upload')).toBe(false)
    expect(projectMirrorState.local).toMatchObject({ busy: false, error: '', conflicts: 1 })
    expect(projectMirrorState.local?.stage).toContain('1 Konfliktkopie')
  })

  it('lets an assistant device publish without a job or master role', async () => {
    mock.account.mockResolvedValue({
      accountId: 1,
      principalId: 'owner',
      config: { clientId: 'assistant', baseUrl: 'https://server', deviceKey: 'key' },
    })
    const calls = server({ revision: 0 })
    await syncProjectMirror('local')
    expect(calls).toContain('POST /manifests/draft/publish')
    expect(calls).not.toContain('POST /manifests/draft/propose')
    expect(mock.entries.get('owner:local')).toEqual({ revision: 1, localHash: 'changed', baseManifestId: 'draft' })
    expect(projectMirrorState.local?.stage).toBe('Ordner vollständig abgeglichen')
  })

  it('keeps device-job uploads on assistants as proposals for the master', async () => {
    mock.account.mockResolvedValue({
      accountId: 1,
      principalId: 'owner',
      config: { clientId: 'assistant', baseUrl: 'https://server', deviceKey: 'key' },
    })
    const bodies: Record<string, unknown>[] = []
    const calls = server({ revision: 1, create: body => bodies.push(body) })
    await syncProjectMirror('local', undefined, 'job')
    expect(bodies[0]).toMatchObject({ proposal: true, job_id: 'job' })
    expect(calls).toContain('POST /manifests/draft/propose')
    expect(calls).not.toContain('POST /manifests/draft/publish')
    expect(mock.entries.get('owner:local')).toMatchObject({ proposalHash: 'changed' })
  })

  it('pulls a newer head when the folder is unchanged and applies only in place', async () => {
    mock.entries.set('owner:local', { revision: 1, localHash: 'changed', baseManifestId: 'head-1' })
    applyNative()
    const calls = server({ revision: 2 })
    await syncProjectMirror('local')
    expect(calls).not.toContain('POST /manifests')
    expect(calls).toContain('GET /manifests/head-2')
    expect(mock.entries.get('owner:local')).toEqual({ revision: 2, localHash: 'applied', baseManifestId: 'head-2' })
  })

  it.each(['mirror_revision_conflict', 'mirror_lease_expired'])(
    'retries a transient publish race against the fresh head and then fails visibly (%s)',
    async code => {
      let publishes = 0
      mock.request.mockImplementation(async (path: string) => {
        if (path === base) return { data: { revision: 2, manifest_id: 'head', folder_shared: true } }
        if (path.endsWith('/proposals')) return { data: [] }
        if (path.endsWith('/manifests'))
          return { data: { manifest_id: 'draft', base_revision: 0, revision: null, status: 'draft' } }
        if (path.endsWith('/lease')) return { data: { lease_id: 'lease' } }
        if (path.endsWith('/publish')) {
          publishes++
          throw Object.assign(new Error('Conflict'), { status: 409, code })
        }
        return { data: {} }
      })
      await expect(syncProjectMirror('local')).rejects.toThrow('Conflict')
      expect(publishes).toBe(3)
      expect(mock.entries.has('owner:local:upload')).toBe(true)
      expect(projectMirrorState.local).toMatchObject({ busy: false, error: 'Conflict' })
    }
  )

  it('does not touch the folder while the server switch is off and remembers the switch locally', async () => {
    const calls = server({ revision: 3, shared: false })
    await syncProjectMirror('local')
    expect(calls).toEqual(['GET /'])
    expect(mock.native).not.toHaveBeenCalled()
    expect(mock.state.projects[0]?.cloud).toMatchObject({ folderShared: false })
    expect(projectMirrorState.local).toMatchObject({
      shared: false,
      stage: 'Projektordner wird nicht global gespeichert',
    })
  })

  it('turns the account-wide switch on through the server and starts the first sync at once', async () => {
    const calls = server({ revision: 0 })
    await setProjectFolderShared('local', true)
    expect(mock.request).toHaveBeenCalledWith(
      `${base}/settings`,
      expect.objectContaining({ method: 'PUT', body: { folder_shared: true } }),
      expect.anything()
    )
    expect(mock.state.projects[0]?.cloud).toMatchObject({ folderShared: true })
    await vi.waitFor(() => expect(calls).toContain('POST /manifests/draft/publish'))
    await setProjectFolderShared('local', false)
    expect(mock.state.projects[0]?.cloud).toMatchObject({ folderShared: false })
    expect(projectMirrorState.local).toMatchObject({ shared: false })
  })

  it('wakes a project immediately when another device publishes a revision', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('navigator', { onLine: true })
    server({ revision: 0 })
    const controller = new AbortController()
    const stop = await startProjectMirrorChannel(controller.signal)
    try {
      await vi.advanceTimersByTimeAsync(0)
      const before = mock.request.mock.calls.length
      window.dispatchEvent(new CustomEvent(MIRROR_WAKE_EVENT, { detail: { project_id: 7, revision: 2 } }))
      await vi.advanceTimersByTimeAsync(300)
      expect(mock.request.mock.calls.length).toBe(before)
      await vi.advanceTimersByTimeAsync(400)
      expect(mock.request.mock.calls.length).toBeGreaterThan(before)
    } finally {
      stop()
    }
  })

  it('backs off failed background syncs even when filesystem events keep arriving and stops after cleanup', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('navigator', { onLine: true })
    mock.request.mockRejectedValue(new Error('Request timed out'))
    const controller = new AbortController()
    const stop = await startProjectMirrorChannel(controller.signal)
    const event = { payload: { projectId: 'local' } }
    const tick = () => mock.listeners.get('luczor://worker-tick')?.(event)
    const dirty = () => mock.listeners.get('luczor://project-mirror-dirty')?.(event)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(mock.request).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60000)
      tick()
      await vi.advanceTimersByTimeAsync(0)
      expect(mock.request).toHaveBeenCalledTimes(2)
      dirty()
      await vi.advanceTimersByTimeAsync(60000)
      tick()
      await vi.advanceTimersByTimeAsync(0)
      expect(mock.request).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(60000)
      tick()
      await vi.advanceTimersByTimeAsync(0)
      expect(mock.request).toHaveBeenCalledTimes(3)
      const lateTick = mock.listeners.get('luczor://worker-tick')!
      stop()
      await vi.advanceTimersByTimeAsync(600000)
      lateTick(event)
      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(0)
      expect(mock.request).toHaveBeenCalledTimes(3)
    } finally {
      stop()
    }
  })

  it('reuses the same append operation after a lost ACK and skips an already uploaded private chunk', async () => {
    const appendIds: unknown[] = []
    let appendFailed = false
    let uploaded = false
    mock.hasChunk.mockImplementation(async () => uploaded)
    mock.binary.mockImplementation(async () => {
      uploaded = true
      return new Uint8Array()
    })
    mock.request.mockImplementation(async (path: string, options: Options) => {
      if (path === base) return { data: { revision: 0, manifest_id: null, folder_shared: true } }
      if (path.endsWith('/proposals')) return { data: [] }
      if (path.endsWith('/manifests'))
        return { data: { manifest_id: 'same-draft', base_revision: 0, revision: null, status: 'draft' } }
      if (path.endsWith('/entries')) {
        appendIds.push(options.body?.operation_id)
        if (!appendFailed) {
          appendFailed = true
          throw new Error('connection lost after server append commit')
        }
      }
      if (path.endsWith('/lease')) return { data: { lease_id: 'lease' } }
      if (path.endsWith('/publish')) return { data: { revision: 1, manifest_id: 'same-draft', status: 'published' } }
      return { data: {} }
    })
    await expect(syncProjectMirror('local')).rejects.toThrow('connection lost')
    await syncProjectMirror('local')
    expect(appendIds).toHaveLength(2)
    expect(appendIds[1]).toBe(appendIds[0])
    expect(mock.binary).toHaveBeenCalledOnce()
    expect(mock.entries.has('owner:local:upload')).toBe(false)
  })

  it('recovers an already merged accepted draft without appending or publishing it again', async () => {
    mock.entries.set('owner:local', { revision: 1, localHash: 'previous' })
    mock.entries.set('owner:local:upload', {
      hash: 'changed',
      epoch: 1,
      baseRevision: 1,
      operationId: 'original',
      draftId: 'draft',
      offset: 1,
      publishId: 'publish',
    })
    mock.request.mockImplementation(async (path: string) => {
      if (path === base) return { data: { revision: 3, manifest_id: 'merged', folder_shared: true } }
      if (path.endsWith('/proposals')) return { data: [] }
      if (path.endsWith('/manifests'))
        return {
          data: {
            manifest_id: 'draft',
            base_revision: 1,
            revision: null,
            status: 'accepted',
            merged_manifest_id: 'merged',
          },
        }
      if (path.endsWith('/publish') || path.endsWith('/entries'))
        throw new Error('immutable accepted draft must not be published again')
      return { data: { lease_id: 'lease' } }
    })
    await syncProjectMirror('local')
    expect(mock.entries.has('owner:local:upload')).toBe(false)
    expect(mock.entries.get('owner:local')).toMatchObject({
      revision: 2,
      localHash: 'changed',
      baseManifestId: 'draft',
    })
  })
})
