import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  lan: {
    active: true,
    authorityEpoch: 2,
    reachablePeers: ['laptop'],
    workers: {} as Record<string, unknown>,
    lease: null as Record<string, unknown> | null,
  },
  cluster: { connected: false, coordinator: null as Record<string, unknown> | null },
  jobs: new Map<string, string>(),
}))
vi.mock('@/services/coordination/lan', () => ({ lanState: state.lan }))
vi.mock('@/services/coordination/channel', () => ({ deviceCluster: state.cluster }))
vi.mock('@/services/coordination/lanAgents', () => ({
  DEVICE_READ_TOOLS: ['fs_read'],
  deviceAgentJobs: state.jobs,
  runLanAgent: vi.fn(),
}))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: vi.fn() }))
vi.mock('@/services/cloudProjectAccess', () => ({ projectExternalIdForServer: vi.fn() }))
vi.mock('@/services/coordination/api', () => ({ coordinationApi: vi.fn() }))
import { deviceWorkers, resolveAssistanceTarget } from '@/services/agents/deviceAssistance'
beforeEach(() => {
  state.lan.active = true
  state.lan.authorityEpoch = 2
  state.lan.reachablePeers = ['laptop']
  state.lan.workers = { laptop: { protocol: 1, ready: true, busy: false, modelId: 'small', tier: 1 } }
  state.lan.lease = { epoch: 2, target_device_ids: ['laptop'], expires_at: new Date(Date.now() + 60000).toISOString() }
  state.cluster.connected = false
  state.cluster.coordinator = null
  state.jobs.clear()
})
const task = { target: 'auto' as const, task: 'Review independently', role: 'review' as const, tools: [] }
describe('adaptive worker choice', () => {
  it('prefers a ready own LAN model to an external provider, including during server outage', () => {
    expect(resolveAssistanceTarget(task, true, true)).toMatchObject({ target: 'device', device_id: 'laptop' })
    expect(deviceWorkers()[0]).toMatchObject({ ready: true, transport: 'lan' })
  })
  it.each(['busy', 'expired', 'old-epoch', 'unreachable', 'not-ready', 'incompatible', 'reserved'])(
    'does not dispatch to a %s worker',
    reason => {
      const presence = state.lan.workers.laptop as Record<string, unknown>
      if (reason === 'busy') presence.busy = true
      if (reason === 'expired') state.lan.lease!.expires_at = '2000-01-01'
      if (reason === 'old-epoch') state.lan.authorityEpoch++
      if (reason === 'unreachable') state.lan.reachablePeers = []
      if (reason === 'not-ready') presence.ready = false
      if (reason === 'incompatible') presence.protocol = 0
      if (reason === 'reserved') state.jobs.set('job', 'laptop')
      expect(resolveAssistanceTarget(task, true, true).target).toBe('external')
      expect(() => resolveAssistanceTarget(task, true, false)).toThrow('Kein freier')
    }
  )
  it('respects context restrictions and explicitly targeted device IDs', () => {
    expect(() => resolveAssistanceTarget(task, false, false)).toThrow()
    expect(() => resolveAssistanceTarget({ ...task, device_id: 'unknown' }, true, true)).toThrow()
    expect(() => resolveAssistanceTarget({ ...task, tools: ['fs_write'] }, true, true)).toThrow()
  })
  it('uses the server for a ready own device when direct LAN is unavailable', () => {
    state.cluster.connected = true
    state.cluster.coordinator = {
      role: 'master',
      leader_device_id: 'master',
      devices: [{ client_id: 'remote', available: true, model_ready: true, agent_protocol: 1 }],
    }
    state.lan.reachablePeers = []
    expect(resolveAssistanceTarget(task, true, true)).toMatchObject({ target: 'device', device_id: 'remote' })
    expect(deviceWorkers()[0]?.transport).toBe('server')
  })
})
