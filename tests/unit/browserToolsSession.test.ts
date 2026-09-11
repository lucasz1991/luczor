import { beforeEach, describe, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@/services/workflows/access', () => ({
  captureWorkflowAccess: vi.fn(async (_ctx, projectId) => ({ principalId: 'owner', projectId })),
}))
vi.mock('@/services/projectWorkspace', () => ({
  requireProjectWorkspace: vi.fn(async () => ({ rootPath: 'E:/workspace', updatedAt: 10 })),
}))
import { browserTools } from '@/services/tools/browser'
import { clearToolSessions, getToolSession } from '@/services/tools/toolSessionCoordinator'
import { updateExecutionControls } from '@/services/executionGate'
import { browserPanel } from '@/services/browserPanel'
const context = { projectId: 'project' }
const execute = (name: string, args: Record<string, unknown>) =>
  browserTools.find(tool => tool.name === name)!.execute(args, context)

beforeEach(() => {
  clearToolSessions()
  native.invoke.mockReset().mockImplementation(async (command, input) => {
    if (command === 'wf_browser_action')
      return {
        ok: true,
        sessionId: 'native-session',
        tabId: 'luczor-browser',
        url: input.payload.url ?? 'https://example.test',
        data: { text: 'page', truncated: false },
      }
    return true
  })
  updateExecutionControls({ mode: 'act', killSwitch: false, scope: 'project' })
  browserPanel.expanded = false
})

describe('chat browser native session', () => {
  it('sends a stable execution identity matching its artifact run for open and navigation', async () => {
    await execute('browser_open', { url: 'https://example.test/first', allowed_hosts: ['example.test'] })
    await execute('browser_navigate', { url: 'https://example.test/second' })
    const calls = native.invoke.mock.calls.filter(([command]) => command === 'wf_browser_action')
    expect(calls).toHaveLength(2)
    const first = calls[0]![1].payload
    const second = calls[1]![1].payload
    expect(first.execution.workflowExecutionId).toBe(first.scope.runId)
    expect(second.execution.workflowExecutionId).toBe(first.execution.workflowExecutionId)
    expect(second.allowedHosts).toEqual(['example.test'])
    expect(second.expectedUrl).toBeUndefined()
    expect(second.sessionId).toBe('native-session')
    expect(browserPanel.expanded).toBe(true)
  })
  it('rejects absent host boundaries before native calls and rejects cross-host navigation', async () => {
    await expect(execute('browser_open', {})).rejects.toThrow()
    expect(native.invoke.mock.calls.some(([command]) => command === 'wf_browser_action')).toBe(false)
    await execute('browser_open', { allowed_hosts: ['example.test:8443'] })
    await expect(execute('browser_navigate', { url: 'https://example.test:8443/a' })).resolves.toMatchObject({
      ok: true,
    })
    await expect(execute('browser_navigate', { url: 'https://example.test/a' })).rejects.toThrow('außerhalb')
    await expect(execute('browser_navigate', { url: 'https://sub.example.test:8443/a' })).rejects.toThrow('außerhalb')
  })
  it('never silently changes the hosts of an existing session', async () => {
    const first = await getToolSession(context, 'browser', ['example.test'])
    await expect(getToolSession(context, 'browser', ['other.test'])).rejects.toThrow('andere Hosts')
    expect((await getToolSession(context, 'browser')).meta.id).toBe(first.meta.id)
  })
  it('surfaces actionable native failures and allows explicit session closure', async () => {
    native.invoke.mockImplementation(async command => {
      if (command === 'wf_browser_action') throw 'workflow_browser_host_boundary_unavailable'
      return true
    })
    await expect(execute('browser_open', { allowed_hosts: ['example.test'] })).rejects.toThrow(
      'auf diesem System nicht verfügbar'
    )
    expect(browserPanel.error).toContain('workflow_browser_host_boundary_unavailable')
  })
  it('does not execute after Not-Aus', async () => {
    await execute('browser_open', { allowed_hosts: ['example.test'] })
    updateExecutionControls({ mode: 'act', killSwitch: true, scope: 'project' })
    const before = native.invoke.mock.calls.filter(([command]) => command === 'wf_browser_action').length
    await expect(execute('browser_navigate', { url: 'https://example.test' })).rejects.toThrow('Not-Aus')
    expect(native.invoke.mock.calls.filter(([command]) => command === 'wf_browser_action')).toHaveLength(before)
  })
})
