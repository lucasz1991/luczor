import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoordinatedJob } from '@/services/coordination/api'

const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  account: vi.fn(),
  listen: vi.fn(),
  metadata: vi.fn(),
  request: vi.fn(),
  api: {
    heartbeat: vi.fn(),
    pending: vi.fn(),
    jobs: vi.fn(),
    job: vi.fn(),
    claim: vi.fn(),
    complete: vi.fn(),
    cancelAck: vi.fn(),
    adopt: vi.fn(),
    progress: vi.fn(),
  },
  journal: null as Record<string, unknown> | null,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mock.listen }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: mock.account }))
vi.mock('@/services/api/luczorApi', () => ({ requestWithConfig: mock.request }))
vi.mock('@/services/cloudProjectAccess', () => ({ projectLocalIdForServer: () => 'local-project' }))
vi.mock('@/services/chatRunManager', () => ({ hasActiveChatRuns: () => false }))
vi.mock('@/services/coordination/api', () => ({ coordinationApi: () => mock.api }))
vi.mock('@/services/coordination/conversations', () => ({ syncConversations: async () => {} }))
vi.mock('@/services/coordination/preferences', () => ({ coordinationMetadata: mock.metadata }))
vi.mock('@/services/coordination/lan', () => ({
  refreshLan: async () => {},
  stopLan: () => {},
  sendLan: async () => false,
  lanState: {},
}))
vi.mock('@/services/executionGate', () => ({
  executionGate: {
    capture: (signal: AbortSignal) => ({ signal }),
    assert: (ticket: { signal: AbortSignal }) => ticket.signal.throwIfAborted(),
  },
}))
import { startCoordinationChannel, stopCoordinationChannel } from '@/services/coordination/channel'

const attempt = '96795291-e4e5-4b7b-bf44-99a9c26e3489'
const baseJob: CoordinatedJob = {
  id: '41414f8d-1fa9-44fc-a5a5-32ba5ba25df0',
  protocol_version: 2,
  user_id: 1,
  source_device_id: 'old-master',
  target_device_id: 'worker',
  project_id: null,
  master_epoch: 1,
  authority_epoch: 2,
  attempt_id: attempt,
  tool_profile: 'chat.turn',
  payload: { prompt: 'Observe once' },
  payload_hash: 'a'.repeat(64),
  signature: 'signed-original-attempt',
  expires_at: '2000-01-01T00:00:00Z',
  status: 'running',
  risk_level: 'normal',
  requires_local_approval: false,
  reconciliation_required: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', new EventTarget())
  mock.journal = null
  mock.listen.mockResolvedValue(() => {})
  mock.metadata.mockResolvedValue({})
  mock.account.mockResolvedValue({
    accountId: 1,
    principalId: 'owner',
    config: { clientId: 'worker', baseUrl: 'https://server', deviceKey: 'key' },
  })
  mock.api.heartbeat.mockResolvedValue({ data: { epoch: 2, leader_device_id: 'worker' } })
  mock.api.pending.mockResolvedValue({ data: [baseJob], next_cursor: 1 })
  mock.api.jobs.mockResolvedValue({ data: [baseJob], next_cursor: 1 })
  mock.api.adopt.mockResolvedValue({ data: { ...baseJob, reconciliation_required: false } })
  mock.api.complete.mockResolvedValue({ data: { ...baseJob, status: 'completed' } })
  mock.invoke.mockImplementation(async (command: string, data: { payload: Record<string, unknown> }) => {
    if (command === 'device_run_journal_read') return mock.journal
    if (command === 'device_run_journal_list')
      return mock.journal && ['completed', 'cancelled'].includes(String(mock.journal.state))
        ? [{ runId: baseJob.id, jobId: baseJob.id }]
        : []
    if (command === 'device_run_journal_transition') {
      mock.journal = { ...(data.payload.record as object), revision: Number(data.payload.expectedRevision) + 1 }
      return mock.journal
    }
    return undefined
  })
})
afterEach(async () => {
  await stopCoordinationChannel()
  vi.unstubAllGlobals()
})

describe('coordinated effect recovery', () => {
  it('coalesces realtime wake-ups into an authenticated refresh and removes the listener on stop', async () => {
    vi.useFakeTimers()
    try {
      mock.api.pending.mockResolvedValue({ data: [] })
      mock.api.jobs.mockResolvedValue({ data: [] })
      const execute = vi.fn()
      const stop = await startCoordinationChannel(execute)
      mock.api.heartbeat.mockClear()
      for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('luczor:coordination-wake'))
      await vi.advanceTimersByTimeAsync(501)
      expect(mock.api.heartbeat).toHaveBeenCalledTimes(1)
      expect(execute).not.toHaveBeenCalled()
      stop()
      window.dispatchEvent(new Event('luczor:coordination-wake'))
      await vi.advanceTimersByTimeAsync(1000)
      expect(mock.api.heartbeat).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('never treats a running server attempt with a missing native journal as new work', async () => {
    const execute = vi.fn()
    await startCoordinationChannel(execute)
    await vi.waitFor(() => expect(mock.journal?.state).toBe('outcome_unknown'))
    expect(mock.api.claim).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(mock.api.adopt).toHaveBeenCalledWith(baseJob.id, attempt, 2)
  })

  it('replays a completed receipt after admission expiry without authorizing another native effect', async () => {
    const completion = { ok: true, result: { receipt: 'already executed' } }
    mock.journal = {
      revision: 3,
      state: 'completed',
      payloadHash: baseJob.payload_hash,
      checkpoint: { attemptId: attempt, masterEpoch: 1 },
      result: completion,
    }
    const fallback = mock.invoke.getMockImplementation()!
    mock.invoke.mockImplementation(async (command: string, data: { payload: Record<string, unknown> }) => {
      if (command === 'verify_device_job') throw new Error('Original admission expired')
      return fallback(command, data)
    })
    const execute = vi.fn()
    await startCoordinationChannel(execute)
    await vi.waitFor(() => expect(mock.api.complete).toHaveBeenCalledWith(baseJob.id, attempt, 1, completion))
    await vi.waitFor(() => expect(mock.journal?.state).toBe('acknowledged'))
    expect(mock.api.claim).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('recovers a lost completion acknowledgement when the server no longer lists the job as pending', async () => {
    mock.api.pending.mockResolvedValue({ data: [], next_cursor: 0 })
    mock.api.jobs.mockResolvedValue({
      data: [{ ...baseJob, status: 'completed', reconciliation_required: false }],
      next_cursor: 1,
    })
    const completion = { ok: true, result: { receipt: 'accepted before disconnect' } }
    mock.journal = {
      revision: 3,
      state: 'completed',
      payloadHash: baseJob.payload_hash,
      checkpoint: { attemptId: attempt, masterEpoch: 1 },
      result: completion,
    }
    const execute = vi.fn()
    await startCoordinationChannel(execute)
    await vi.waitFor(() => expect(mock.journal?.state).toBe('acknowledged'))
    expect(mock.api.complete).toHaveBeenCalledWith(baseJob.id, attempt, 1, completion)
    expect(execute).not.toHaveBeenCalled()
  })

  it('retrieves later pending pages instead of starving jobs after the first hundred', async () => {
    const { coordinationApi } =
      await vi.importActual<typeof import('@/services/coordination/api')>('@/services/coordination/api')
    const config = (await mock.account()).config
    mock.request.mockImplementation(async (_path: string, options: { query: { after: string } }) => ({
      data:
        options.query.after === '0'
          ? Array.from({ length: 100 }, (_, i) => ({ ...baseJob, id: `job-${i}` }))
          : [{ ...baseJob, id: 'later-job' }],
      next_cursor: options.query.after === '0' ? 100 : 101,
    }))
    const result = await coordinationApi(config).pending()
    expect(result.data).toHaveLength(101)
    expect(result.data.at(-1)?.id).toBe('later-job')
    expect(mock.request.mock.calls.map(([, options]) => options.query.after)).toEqual(['0', '100'])
  })

  it('stops when a full page has a non-advancing cursor rather than looping indefinitely', async () => {
    const { coordinationApi } =
      await vi.importActual<typeof import('@/services/coordination/api')>('@/services/coordination/api')
    mock.request.mockResolvedValue({ data: Array.from({ length: 100 }, () => baseJob), next_cursor: 0 })
    await expect(coordinationApi((await mock.account()).config).jobs()).rejects.toThrow('vollständig')
    expect(mock.request).toHaveBeenCalledOnce()
  })
})
