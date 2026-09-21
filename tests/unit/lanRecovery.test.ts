import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  request: vi.fn(),
  disks: new Map<string, Map<string, unknown>>(),
  listeners: new Map<string, () => void>(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, callback) => {
    mock.listeners.set(name, callback)
    return () => mock.listeners.delete(name)
  }),
}))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async (file: string) => {
      let data = mock.disks.get(file)
      if (!data) {
        data = new Map()
        mock.disks.set(file, data)
      }
      return {
        get: async (key: string) => data.get(key),
        set: async (key: string, value: unknown) => data.set(key, value),
        delete: async (key: string) => data.delete(key),
        save: async () => {},
        entries: async () => [...data.entries()],
      }
    },
  },
}))
vi.mock('@/services/api/luczorApi', () => ({ requestWithConfig: mock.request }))
vi.mock('@/services/executionGate', () => ({
  executionGate: { capture: (signal: AbortSignal) => ({ signal }) },
  invokeGuarded: (name: string, request: unknown) => mock.invoke(name, { request }),
}))
vi.mock('@/services/cloudProjectAccess', () => ({ projectLocalIdForServer: () => 'project' }))
vi.mock('@/services/chatRunManager', () => ({ hasActiveChatRuns: () => false }))
vi.mock('@/services/coordination/preferences', () => ({
  coordinationMetadata: async () => ({ platform: 'windows', active_model_id: 'model', model_ready: true }),
}))
vi.mock('@/services/coordination/lanAgents', () => ({ hasLanAgentRuns: () => false, receiveLanAgent: vi.fn() }))
import type { VerifiedAccountSnapshot } from '@/services/accountPrincipal'
const account = {
  principalId: 'account',
  accountId: 1,
  config: { clientId: 'master', baseUrl: 'https://test.invalid', deviceKey: 'key' },
} as VerifiedAccountSnapshot
const expiry = () => new Date(Date.now() + 60000).toISOString()
let stop = () => {}
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mock.disks.clear()
  mock.listeners.clear()
  vi.stubGlobal('window', new EventTarget())
  mock.invoke.mockImplementation(async (name: string) => {
    if (name === 'lan_peer_identity') return { certSha256: 'certificate' }
    if (name === 'lan_peer_start' || name === 'lan_peer_status')
      return { active: true, peers: ['laptop'], reachablePeers: [], workers: {} }
    if (name === 'lan_peer_drain') return []
  })
  mock.request.mockRejectedValue({ status: 0 })
})
afterEach(() => {
  stop()
  vi.unstubAllGlobals()
})
function cache(client = 'master') {
  mock.disks.set(
    'luczor.lan-trust.json',
    new Map([
      [
        'account:master',
        {
          signed: { user_id: 1, client_id: client, expires_at: expiry() },
          peers: [{ client_id: 'laptop', user_id: 1, expires_at: expiry() }],
        },
      ],
    ])
  )
}
describe('LAN trust lifecycle', () => {
  it('starts from scoped cached trust before server failure and keeps discovery distinct from TLS reachability', async () => {
    cache()
    const lan = await import('@/services/coordination/lan')
    stop = lan.stopLan
    await lan.refreshLan(account, new AbortController().signal)
    expect(lan.lanState).toMatchObject({
      active: true,
      cachedTrust: true,
      serverOnline: false,
      peers: ['laptop'],
      reachablePeers: [],
    })
    expect(mock.invoke.mock.calls.findIndex(([name]) => name === 'lan_peer_start')).toBeLessThan(
      mock.invoke.mock.calls.findIndex(([name]) => name === 'lan_peer_identity')
    )
    expect(mock.listeners.has('luczor://worker-tick')).toBe(true)
  })
  it('does not start another device or an invalid native trust bundle', async () => {
    cache('different-device')
    const lan = await import('@/services/coordination/lan')
    stop = lan.stopLan
    await expect(lan.refreshLan(account, new AbortController().signal)).rejects.toEqual({ status: 0 })
    expect(mock.invoke.mock.calls.some(([name]) => name === 'lan_peer_start')).toBe(false)
  })
  it('stops and removes cached permissions when server rejects the identity', async () => {
    cache()
    mock.request.mockRejectedValue({ status: 403 })
    const lan = await import('@/services/coordination/lan')
    stop = lan.stopLan
    await expect(lan.refreshLan(account, new AbortController().signal)).rejects.toEqual({ status: 403 })
    expect(lan.lanState.active).toBe(false)
    expect(mock.disks.get('luczor.lan-trust.json')?.has('account:master')).toBe(false)
    expect(mock.listeners.size).toBe(0)
  })
  it('cleans up native discovery and listeners on abort', async () => {
    cache()
    const abort = new AbortController()
    const lan = await import('@/services/coordination/lan')
    stop = lan.stopLan
    await lan.refreshLan(account, abort.signal)
    abort.abort()
    expect(lan.lanState.active).toBe(false)
    expect(mock.listeners.size).toBe(0)
    expect(mock.invoke).toHaveBeenCalledWith('lan_peer_stop')
  })
})
