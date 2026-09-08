import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  guarded: vi.fn(),
  request: vi.fn(),
  localGrant: vi.fn(),
  workspace: vi.fn(),
  account: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: mock.account }))
vi.mock('@/services/api/luczorApi', () => ({ requestWithConfig: mock.request }))
vi.mock('@/services/executionGate', () => ({
  executionGate: {
    capture: (signal: AbortSignal) => ({ signal }),
    assert: (ticket: { signal: AbortSignal }) => ticket.signal.throwIfAborted(),
  },
  invokeGuarded: mock.guarded,
  onExecutionInvalidated: () => () => {},
}))
vi.mock('@/services/projectWorkspace', () => ({ getProjectWorkspace: mock.workspace }))
vi.mock('@/services/workflows/automation', () => ({
  canonicalWorkflowPath: (path: string) => path.toLowerCase().replaceAll('\\', '/'),
  getLocalWorkflowAutomationGrant: mock.localGrant,
}))
import { startWorkflowWatchers, stopWorkflowWatchers } from '@/services/workflows/watcher'

const config = { baseUrl: 'https://luczor.test', clientId: 'device-1', deviceKey: 'key' }
const trigger = {
  id: 3,
  public_id: 'trigger-3',
  workflow_definition_id: 7,
  project_external_id: 'project-1',
  enabled: true,
  config: { device_id: 'device-1', root_path: 'e:/project', paths: ['src/**'], excludes: ['src/cache/**'] },
}
const grant = {
  id: 4,
  status: 'active',
  scope_hash: 'scope-grant',
  config: { root_path: 'e:/project', allowed_input_sources: ['event'] },
}
const event = {
  id: 'stable-event',
  watcherId: 'trigger-3',
  rootPath: 'E:\\Project',
  changes: [{ path: 'src/app.ts', kind: 'modified' }],
  occurredAt: 1700000000000,
  originRunId: 'origin-run',
}
beforeEach(() => {
  vi.resetAllMocks()
  mock.invoke.mockResolvedValue(undefined)
  mock.account.mockResolvedValue({ principalId: 'user:1', config })
  mock.workspace.mockResolvedValue({ status: 'ready', rootPath: 'E:\\Project', updatedAt: 17 })
  mock.localGrant.mockResolvedValue({ principalId: 'user:1', workspaceUpdatedAt: 17, grant })
  mock.guarded.mockImplementation(async (command: string) => (command === 'wf_watch_drain' ? [event] : undefined))
  mock.request.mockImplementation(async (path: string) =>
    path === '/workflow-triggers/device'
      ? { data: [trigger] }
      : path.endsWith('/automation')
        ? { data: { grant } }
        : { data: { status: 'accepted' } }
  )
})
afterEach(() => {
  stopWorkflowWatchers()
  vi.useRealTimers()
})
describe('workflow watcher lifecycle and durable delivery', () => {
  it('admits only the locally confirmed bound root and forwards causal metadata without content', async () => {
    await startWorkflowWatchers()
    expect(mock.guarded).toHaveBeenCalledWith(
      'wf_watch_start',
      expect.objectContaining({
        principalId: 'user:1',
        projectId: 'project-1',
        expectedRootPath: 'E:\\Project',
        expectedWorkspaceUpdatedAt: 17,
        paths: ['src/**'],
        excludes: ['src/cache/**'],
      }),
      expect.anything(),
      true
    )
    expect(mock.request).toHaveBeenCalledWith(
      '/workflow-events',
      expect.objectContaining({
        body: {
          trigger_id: 3,
          event_id: 'stable-event',
          device_id: 'device-1',
          root_path: 'e:/project',
          changes: event.changes,
          occurred_at: new Date(event.occurredAt).toISOString(),
          origin_run_id: 'origin-run',
        },
      }),
      config
    )
    expect(mock.guarded).toHaveBeenCalledWith(
      'wf_watch_ack',
      expect.objectContaining({ eventIds: ['stable-event'] }),
      expect.anything(),
      false
    )
  })
  it('keeps the same durable event unacknowledged after a failed HTTP delivery', async () => {
    mock.request.mockImplementation(async (path: string) => {
      if (path === '/workflow-events') throw new Error('offline')
      return path === '/workflow-triggers/device' ? { data: [trigger] } : { data: { grant } }
    })
    await startWorkflowWatchers()
    expect(mock.guarded.mock.calls.some(call => call[0] === 'wf_watch_ack')).toBe(false)
  })
  it('does not start an enabled server trigger without matching local consent', async () => {
    mock.localGrant.mockResolvedValue(null)
    await startWorkflowWatchers()
    expect(mock.guarded.mock.calls.some(call => call[0] === 'wf_watch_start')).toBe(false)
    expect(mock.request.mock.calls.some(call => call[0] === '/workflow-events')).toBe(false)
  })
  it('stops a remotely revoked watcher and discards its queued metadata before delivery', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mock.guarded.mockImplementation(async (command: string) => (command === 'wf_watch_drain' ? [] : undefined))
    await startWorkflowWatchers()
    mock.invoke.mockClear()
    mock.request.mockClear()
    mock.guarded.mockClear()
    mock.request.mockImplementation(async (path: string) =>
      path === '/workflow-triggers/device' ? { data: [trigger] } : { data: { grant: { ...grant, status: 'revoked' } } }
    )
    mock.guarded.mockImplementation(async (command: string) => (command === 'wf_watch_drain' ? [event] : undefined))
    await vi.advanceTimersByTimeAsync(15000)
    await vi.waitFor(() => expect(mock.guarded.mock.calls.some(call => call[0] === 'wf_watch_ack')).toBe(true))
    expect(mock.invoke).toHaveBeenCalledWith('wf_watch_stop', expect.anything())
    expect(mock.guarded.mock.calls.some(call => call[0] === 'wf_watch_start')).toBe(false)
    expect(mock.request.mock.calls.some(call => call[0] === '/workflow-events')).toBe(false)
  })
  it('does not transfer an existing grant to a rebound project folder', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mock.guarded.mockImplementation(async (command: string) => (command === 'wf_watch_drain' ? [] : undefined))
    await startWorkflowWatchers()
    mock.invoke.mockClear()
    mock.guarded.mockClear()
    mock.request.mockClear()
    mock.workspace.mockResolvedValue({ status: 'ready', rootPath: 'E:\\OtherProject', updatedAt: 18 })
    mock.guarded.mockImplementation(async (command: string) => (command === 'wf_watch_drain' ? [event] : undefined))
    await vi.advanceTimersByTimeAsync(15000)
    await vi.waitFor(() => expect(mock.guarded.mock.calls.some(call => call[0] === 'wf_watch_ack')).toBe(true))
    expect(mock.invoke).toHaveBeenCalledWith('wf_watch_stop', expect.anything())
    expect(mock.guarded.mock.calls.some(call => call[0] === 'wf_watch_start')).toBe(false)
    expect(mock.request.mock.calls.some(call => call[0] === '/workflow-events')).toBe(false)
  })
})
