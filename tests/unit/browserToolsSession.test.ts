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
import {
  clearToolSessions,
  acquireBrowserToolSession,
  closeToolSession,
  getToolSession,
  listToolSessions,
  retainToolSessionRun,
} from '@/services/tools/toolSessionCoordinator'
import { executionGate, updateExecutionControls } from '@/services/executionGate'
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
  it('queues competing owners fairly and skips an aborted waiter without blocking the current owner', async () => {
    const ownerContext = {
      projectId: 'project',
      execution: executionGate.capture(undefined, { projectId: 'project', runId: 'owner' }),
    }
    const owner = await acquireBrowserToolSession(ownerContext)
    const aborted = new AbortController()
    const cancelled = acquireBrowserToolSession({
      projectId: 'project',
      execution: executionGate.capture(aborted.signal, { projectId: 'project', runId: 'cancelled-waiter' }),
    })
    const next = acquireBrowserToolSession({
      projectId: 'project',
      execution: executionGate.capture(undefined, { projectId: 'project', runId: 'next-waiter' }),
    })
    aborted.abort()
    await expect(cancelled).rejects.toBeDefined()
    expect((await acquireBrowserToolSession(ownerContext)).meta.id).toBe(owner.meta.id)
    await closeToolSession(owner.meta.id)
    const acquired = await next
    expect(acquired.ticket.scope?.runId).toBe('next-waiter')
    expect(listToolSessions()).toHaveLength(1)
  })
  it('shares a registered research artifact scope across browser, terminal and vision without a project workspace', async () => {
    const { requireProjectWorkspace } = await import('@/services/projectWorkspace')
    vi.mocked(requireProjectWorkspace).mockClear()
    const researchScope = {
      principalId: 'owner',
      projectId: 'project',
      expectedRootPath: 'C:/Research/run',
      expectedWorkspaceUpdatedAt: 22,
      runId: 'research-id',
      researchId: 'research-id',
    }
    const ctx = {
      projectId: 'project',
      researchScope,
      execution: executionGate.capture(undefined, {
        projectId: 'project',
        conversationId: 'chat',
        runId: 'research-id',
      }),
    }
    const browser = await getToolSession(ctx, 'browser')
    const terminal = await getToolSession(ctx, 'terminal')
    const vision = await getToolSession(ctx, 'vision')
    expect(browser.scope).toEqual(researchScope)
    expect(terminal.scope).toEqual(researchScope)
    expect(vision.scope).toEqual(researchScope)
    expect(new Set([browser.meta.id, terminal.meta.id, vision.meta.id]).size).toBe(3)
    expect(requireProjectWorkspace).not.toHaveBeenCalled()
    await browser.browser!.open('https://example.com')
    expect(native.invoke).toHaveBeenCalledWith(
      'wf_browser_action',
      expect.objectContaining({
        payload: expect.objectContaining({
          scope: researchScope,
          execution: expect.objectContaining({ workflowExecutionId: 'research-id' }),
        }),
      })
    )
    await expect(getToolSession({ ...ctx, researchScope: undefined }, 'terminal')).rejects.toThrow('scope_changed')
  })
  it('rejects executable URLs before reserving a session and ignores legacy host lists', async () => {
    await expect(
      execute('browser_open', { url: 'javascript:alert(1)', allowed_hosts: ['wrong.test'] })
    ).rejects.toThrow('workflow_browser_url_invalid')
    expect(listToolSessions()).toEqual([])
    await execute('browser_open', { url: 'https://example.test', allowed_hosts: ['Example.TEST', 'example.test'] })
    expect(listToolSessions()[0]?.allowedHosts).toEqual([])
  })
  it('reports the owned boundary and closes without guessed hosts through native owner cleanup', async () => {
    await execute('browser_open', { allowed_hosts: ['example.test'] })
    const id = listToolSessions()[0]!.id
    await expect(execute('browser_status', {})).resolves.toMatchObject({
      session: { id, allowed_hosts: [] },
    })
    await expect(execute('browser_close', { allowed_hosts: ['wrong.test'] })).resolves.toEqual({
      ok: true,
      closed: true,
      already_closed: false,
    })
    expect(native.invoke).toHaveBeenCalledWith('wf_browser_cleanup', {
      payload: {
        principalId: 'owner',
        projectId: 'project',
        expectedRootPath: 'E:/workspace',
        expectedWorkspaceUpdatedAt: 10,
        runId: id,
      },
    })
    expect(listToolSessions()).toEqual([])
    await execute('browser_open', { allowed_hosts: ['other.test'] })
    expect(listToolSessions()[0]?.allowedHosts).toEqual([])
  })
  it('does not create sessions for reads, status or idempotent close', async () => {
    await expect(execute('browser_dom_read', {})).rejects.toThrow('browser_open')
    await expect(execute('browser_status', {})).resolves.toMatchObject({ session: null })
    await expect(execute('browser_close', {})).resolves.toMatchObject({ closed: false, already_closed: true })
    expect(listToolSessions()).toEqual([])
    expect(native.invoke.mock.calls.filter(([command]) => command.startsWith('wf_browser'))).toEqual([])
  })
  it('keeps a failed cleanup retryable and awaits cleanup before opening a replacement', async () => {
    await execute('browser_open', { allowed_hosts: ['example.test'] })
    const id = listToolSessions()[0]!.id
    native.invoke.mockRejectedValueOnce('workflow_browser_cleanup_pending')
    await expect(execute('browser_close', {})).rejects.toThrow('noch geschlossen')
    expect(listToolSessions()[0]?.id).toBe(id)
    await expect(execute('browser_close', {})).resolves.toMatchObject({ closed: true })
    expect(listToolSessions()).toEqual([])
  })
  it('does not expose or close another active run and frees completed run ownership for the next chat', async () => {
    const firstCtx = {
      ...context,
      execution: executionGate.capture(undefined, { projectId: 'project', runId: 'browser-first' }),
    }
    const secondCtx = {
      ...context,
      execution: executionGate.capture(undefined, { projectId: 'project', runId: 'browser-second' }),
    }
    const finish = retainToolSessionRun(firstCtx)
    const nestedFinish = retainToolSessionRun(firstCtx)
    const open = browserTools.find(tool => tool.name === 'browser_open')!
    await open.execute({ allowed_hosts: ['private.test'] }, firstCtx)
    await expect(
      browserTools.find(tool => tool.name === 'browser_status')!.execute({}, secondCtx)
    ).resolves.toMatchObject({ session: null })
    await expect(
      browserTools.find(tool => tool.name === 'browser_close')!.execute({}, secondCtx)
    ).resolves.toMatchObject({ closed: false })
    nestedFinish()
    expect(listToolSessions()[0]?.status).toBe('active')
    let secondOpened = false
    const waiting = open.execute({ allowed_hosts: ['other.test'] }, secondCtx).then(result => {
      secondOpened = true
      return result
    })
    await Promise.resolve()
    expect(secondOpened).toBe(false)
    finish()
    expect(listToolSessions()[0]?.status).toBe('expired')
    await waiting
    expect(listToolSessions()).toHaveLength(1)
    expect(listToolSessions()[0]?.allowedHosts).toEqual([])
    const commands = native.invoke.mock.calls.map(([command]) => command)
    expect(commands.indexOf('wf_browser_cleanup')).toBeLessThan(commands.lastIndexOf('wf_browser_action'))
  })
  it('shares an in-flight session creation and rejects admission revoked during preparation', async () => {
    const [first, second] = await Promise.all([
      getToolSession(context, 'browser', ['example.test']),
      getToolSession(context, 'browser', ['example.test']),
    ])
    expect(first.meta.id).toBe(second.meta.id)
    clearToolSessions()
    const controller = new AbortController()
    const pending = getToolSession({ ...context, signal: controller.signal }, 'browser', ['example.test'])
    controller.abort()
    await expect(pending).rejects.toThrow('Ausführung verworfen')
    expect(listToolSessions()).toEqual([])
  })
  it('never reuses another run’s execution permit inside the same project', async () => {
    const firstController = new AbortController()
    const firstTicket = executionGate.capture(firstController.signal, { projectId: 'project', runId: 'first-run' })
    const secondTicket = executionGate.capture(undefined, { projectId: 'project', runId: 'second-run' })
    const first = await getToolSession({ ...context, execution: firstTicket }, 'terminal')
    const second = await getToolSession({ ...context, execution: secondTicket }, 'terminal')
    expect(first.meta.id).not.toBe(second.meta.id)
    expect((await getToolSession({ ...context, execution: secondTicket }, 'terminal')).meta.id).toBe(second.meta.id)
    firstController.abort()
    await expect(first.invokeTask('wf_run_script', {})).rejects.toThrow('Ausführung verworfen')
    await expect(second.invokeTask('wf_run_script', {})).resolves.toBe(true)
    expect(secondTicket.signal.aborted).toBe(false)
  })
  it('sends a stable execution identity matching its artifact run for open and navigation', async () => {
    await execute('browser_open', { url: 'https://example.test/first', allowed_hosts: ['example.test'] })
    await execute('browser_navigate', { url: 'https://example.test/second' })
    const calls = native.invoke.mock.calls.filter(([command]) => command === 'wf_browser_action')
    expect(calls).toHaveLength(2)
    const first = calls[0]![1].payload
    const second = calls[1]![1].payload
    expect(first.execution.workflowExecutionId).toBe(first.scope.runId)
    expect(second.execution.workflowExecutionId).toBe(first.execution.workflowExecutionId)
    expect(second.allowedHosts).toBeUndefined()
    expect(second.expectedUrl).toBeUndefined()
    expect(second.sessionId).toBe('native-session')
    expect(browserPanel.expanded).toBe(true)
  })
  it('navigates between domains and files without closing the owned session', async () => {
    await execute('browser_open', {})
    const first = listToolSessions()[0]!.id
    for (const url of ['https://example.test:8443/a', 'https://other.test/a', 'file:///home/user/index.html']) {
      await expect(execute('browser_navigate', { url })).resolves.toMatchObject({ ok: true })
      expect(listToolSessions()[0]!.id).toBe(first)
    }
  })
  it('does not bind sessions to a host list', async () => {
    const first = await getToolSession(context, 'browser', ['example.test'])
    expect((await getToolSession(context, 'browser', ['other.test'])).meta.id).toBe(first.meta.id)
  })
  it('passes bounded scans as reads without requesting a screenshot', async () => {
    await execute('browser_open', { url: 'https://example.test' })
    await execute('browser_dom_scan', { query: 'Save', offset: 80, limit: 20 })
    expect(native.invoke).toHaveBeenLastCalledWith(
      'wf_browser_action',
      expect.objectContaining({
        payload: expect.objectContaining({ action: 'scan', query: 'Save', offset: 80, limit: 20 }),
      })
    )
    expect(native.invoke.mock.calls.some(([, input]) => input?.payload?.action === 'screenshot')).toBe(false)
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
