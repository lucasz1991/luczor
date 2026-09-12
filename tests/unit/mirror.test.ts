import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  account: vi.fn(),
  native: vi.fn(),
  request: vi.fn(),
  binary: vi.fn(),
  hasChunk: vi.fn(),
  entries: new Map<string, unknown>(),
  state: { projects: [{ id: 'local', cloud: { principalId: 'owner', projectId: 7, externalId: 'global' } }] },
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
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
import { syncProjectMirror } from '@/services/coordination/mirror'

const base = '/projects/7/mirror'
const sha = 'a'.repeat(64)
type Options = { method?: string; body?: Record<string, unknown> }
beforeEach(() => {
  vi.clearAllMocks()
  mock.entries.clear()
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

describe('durable full project mirror upload', () => {
  it('seals stale-base master changes as a proposal so disjoint assistant changes can merge', async () => {
    mock.entries.set('owner:local', { revision: 1, localHash: 'previous' })
    let proposed = false
    mock.request.mockImplementation(async (path: string) => {
      if (path === base) return { data: { revision: 2, manifest_id: 'current' } }
      if (path.endsWith('/proposals')) return { data: [] }
      if (path.endsWith('/manifests'))
        return { data: { manifest_id: 'draft', base_revision: 1, revision: null, status: 'draft' } }
      if (path.endsWith('/propose')) {
        proposed = true
        return { data: { status: 'proposed' } }
      }
      if (path.endsWith('/lease')) return { data: { lease_id: 'lease' } }
      if (path.endsWith('/publish')) {
        if (!proposed) throw new Error('mirror_revision_conflict: stale draft cannot be merged')
        return { data: { revision: 3, manifest_id: 'merged', status: 'published' } }
      }
      return { data: {} }
    })
    await syncProjectMirror('local')
    expect(proposed).toBe(true)
    expect(mock.request).toHaveBeenCalledWith(
      `${base}/manifests/draft/publish`,
      expect.objectContaining({ body: expect.objectContaining({ expected_revision: 2 }) }),
      expect.anything()
    )
    expect(mock.entries.get('owner:local')).toMatchObject({ revision: 2, localHash: 'changed' })
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
      if (path === base) return { data: { revision: 0, manifest_id: null } }
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
      if (path === base) return { data: { revision: 3, manifest_id: 'merged' } }
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
    expect(mock.entries.get('owner:local')).toMatchObject({ revision: 2, localHash: 'changed' })
  })
})
