import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VerifiedAccountSnapshot } from '@/services/accountPrincipal'
import type { Envelope, AgentLease } from '@/services/coordination/lan'
const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  send: vi.fn(),
  run: vi.fn(),
  journal: null as Record<string, unknown> | null,
  state: { lease: null as unknown, reachablePeers: ['worker'] },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
vi.mock('@/services/coordination/lan', () => ({ lanState: mock.state, sendLan: mock.send }))
vi.mock('@/services/agent', () => ({ runAgent: mock.run }))
vi.mock('@/services/cloudProjectAccess', () => ({
  projectLocalIdForServer: (id: string) => {
    if (!id) throw new Error('mapping missing')
    return 'project'
  },
}))
vi.mock('@/services/executionGate', () => ({
  executionGate: {
    capture: (signal: AbortSignal, scope: unknown) => ({ signal, scope }),
    assert: (ticket: { signal: AbortSignal }) => ticket.signal.throwIfAborted(),
  },
}))
vi.mock('@/services/tools/registry', () => ({
  listTools: () => [
    { name: 'fs_read', mutating: false },
    { name: 'fs_write', mutating: true },
    { name: 'device_dispatch', mutating: true },
  ],
}))
import { receiveLanAgent, runLanAgent, hasLanAgentRuns } from '@/services/coordination/lanAgents'
const account = { principalId: 'account', accountId: 1, config: { clientId: 'worker' } } as VerifiedAccountSnapshot
const jobId = '43414f8d-1fa9-44fc-a5a5-32ba5ba25df0'
const lease = (): AgentLease => ({
  protocol_version: 1,
  scope: 'agent.read',
  user_id: 1,
  source_device_id: 'master',
  target_device_ids: ['worker'],
  epoch: 1,
  issued_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 60000).toISOString(),
  algorithm: 'RSA-SHA256',
  signature: 'verified-by-native',
})
function envelope(): Envelope {
  return {
    id: jobId,
    fromDeviceId: 'master',
    toDeviceId: 'worker',
    kind: 'job',
    payload: {
      protocol: 'luczor.agent.v1',
      operation: 'run',
      jobId,
      lease: lease(),
      task: 'Analyze supplied facts',
      role: 'review',
      context: 'facts',
      tools: [],
    },
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', new EventTarget())
  mock.journal = null
  mock.state.lease = lease()
  mock.run.mockResolvedValue({ finalText: 'Evidence result', model: 'small', tokenUsage: {} })
  mock.send.mockResolvedValue(true)
  mock.invoke.mockImplementation(async (command: string, { payload }: { payload: Record<string, unknown> }) => {
    if (command === 'device_run_journal_read') return mock.journal
    if (command === 'device_run_journal_transition') {
      mock.journal = { ...(payload.record as object), revision: Number(payload.expectedRevision) + 1 }
      return mock.journal
    }
    return undefined
  })
})
afterEach(() => vi.unstubAllGlobals())
describe('durable LAN analysis jobs', () => {
  it('journals before inference and returns a public result without recursive delegation or external fallback', async () => {
    await receiveLanAgent(envelope(), account, new AbortController().signal)
    await vi.waitFor(() => expect(hasLanAgentRuns()).toBe(false))
    expect(mock.journal).toMatchObject({ state: 'completed', result: { output: 'Evidence result' } })
    expect(mock.run).toHaveBeenCalledWith(
      expect.objectContaining({
        agentMode: false,
        toolAccess: 'none',
        contextEgress: 'local_only',
        routingSettings: { preference: 'local_only' },
      })
    )
    expect(mock.send).toHaveBeenCalledWith(
      'master',
      'result',
      expect.objectContaining({ jobId, result: expect.objectContaining({ output: 'Evidence result' }) })
    )
  })
  it('does not repeat a completed job when the exact request is delivered again', async () => {
    const message = envelope()
    await receiveLanAgent(message, account, new AbortController().signal)
    await vi.waitFor(() => expect(hasLanAgentRuns()).toBe(false))
    await receiveLanAgent(message, account, new AbortController().signal)
    expect(mock.run).toHaveBeenCalledOnce()
    expect(mock.send).toHaveBeenCalledTimes(2)
  })
  it('rejects writes and invalid authority before any model execution', async () => {
    const message = envelope()
    message.payload.tools = ['fs_write']
    await receiveLanAgent(message, account, new AbortController().signal)
    expect(mock.run).not.toHaveBeenCalled()
    mock.invoke.mockRejectedValueOnce(new Error('expired lease'))
    await receiveLanAgent(envelope(), account, new AbortController().signal)
    expect(mock.run).not.toHaveBeenCalled()
  })
  it('cancels only the owned worker task and preserves late-result rejection', async () => {
    let done!: (value: unknown) => void
    mock.run.mockImplementation(
      () =>
        new Promise(resolve => {
          done = resolve
        })
    )
    const request = envelope()
    await receiveLanAgent(request, account, new AbortController().signal)
    await vi.waitFor(() => expect(mock.run).toHaveBeenCalled())
    await receiveLanAgent(
      { ...request, payload: { protocol: 'luczor.agent.v1', operation: 'cancel', jobId } },
      account,
      new AbortController().signal
    )
    done({ finalText: 'Late result' })
    await vi.waitFor(() => expect(hasLanAgentRuns()).toBe(false))
    expect(mock.journal).toMatchObject({ state: 'cancelled', result: { status: 'cancelled', output: '' } })
  })
  it('waits for the matching target result on uncertain delivery without a second dispatch', async () => {
    mock.send.mockResolvedValue(false)
    const controller = new AbortController()
    const source = { ...account, config: { clientId: 'master' } } as VerifiedAccountSnapshot
    const pending = runLanAgent(
      source,
      'worker',
      { task: 'Review facts', role: 'review', context: '', tools: [] },
      controller.signal
    )
    await vi.waitFor(() => expect(mock.send).toHaveBeenCalled())
    const job = mock.send.mock.calls[0]![2]
    window.dispatchEvent(
      new CustomEvent('luczor://lan-result', {
        detail: {
          fromDeviceId: 'worker',
          toDeviceId: 'master',
          kind: 'result',
          payload: { protocol: 'luczor.agent.v1', jobId: job.jobId, result: { status: 'completed', output: 'answer' } },
        },
      })
    )
    await expect(pending).resolves.toMatchObject({ output: 'answer' })
    expect(mock.send).toHaveBeenCalledOnce()
  })
})
