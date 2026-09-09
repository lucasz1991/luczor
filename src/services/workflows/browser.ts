/** Workflow browser operations always target one native run-bound session. */
import { invoke } from '@tauri-apps/api/core'
export type WorkflowArtifactScope = Readonly<{
  principalId: string
  projectId: string
  expectedRootPath: string
  expectedWorkspaceUpdatedAt: number
  runId: string
}>
export type WorkflowNativeInvoke = <T>(
  command: string,
  payload: Record<string, unknown>,
  mutating?: boolean
) => Promise<T>
export type WorkflowArtifact = Readonly<{
  artifactId: string
  mime: string
  bytes: number
  sha256: string
  name: string
  width?: number | null
  height?: number | null
}>
export type WorkflowBrowserResult = Readonly<{
  ok: boolean
  sessionId: string
  tabId: string
  url: string
  data: Record<string, unknown>
}>
type BrowserOptions = { sessionId?: string; expectedTabId?: string; expectedUrl?: string; timeoutMs?: number }

/** The original run can release its own window even after its execution ticket was revoked. */
export function cleanupWorkflowBrowser(scope: WorkflowArtifactScope): Promise<boolean> {
  return invoke('wf_browser_cleanup', { payload: { ...scope } })
}

export function createWorkflowBrowser(context: {
  scope: WorkflowArtifactScope
  invokeTask: WorkflowNativeInvoke
  allowedHosts?: readonly string[]
  automated?: boolean
}) {
  const scope = Object.freeze({ ...context.scope })
  const allowedHosts = context.allowedHosts ? Object.freeze([...context.allowedHosts]) : undefined
  let sessionId: string | undefined
  const execute = async (action: string, options: Record<string, unknown> = {}, mutating = true) => {
    const requestedSession = typeof options.sessionId === 'string' ? options.sessionId : sessionId
    const result = await context.invokeTask<WorkflowBrowserResult>(
      'wf_browser_action',
      {
        ...options,
        scope,
        allowedHosts,
        automated: context.automated === true,
        action,
        sessionId: requestedSession,
      },
      mutating
    )
    if (!result.ok || !result.sessionId || (requestedSession && result.sessionId !== requestedSession))
      throw new Error('workflow_browser_session_changed')
    sessionId = action === 'close' ? undefined : result.sessionId
    return result
  }
  return {
    open: (url?: string, options: BrowserOptions = {}) => execute('open', { ...options, url }),
    navigate: (url: string, options: BrowserOptions = {}) => execute('navigate', { ...options, url }),
    click: (selector: string, options: BrowserOptions = {}) => execute('click', { ...options, selector }),
    fill: (selector: string, value: string, options: BrowserOptions = {}) =>
      execute('fill', { ...options, selector, value }),
    select: (selector: string, value: string, options: BrowserOptions = {}) =>
      execute('select', { ...options, selector, value }),
    wait: (selector?: string, options: BrowserOptions = {}) => execute('wait', { ...options, selector }, false),
    read: async (selector?: string, options: BrowserOptions = {}) => {
      const result = await execute('read', { ...options, selector }, false)
      if (typeof result.data.text !== 'string' || typeof result.data.truncated !== 'boolean')
        throw new Error('workflow_browser_read_invalid')
      return {
        ok: true,
        sessionId: result.sessionId,
        tabId: result.tabId,
        url: result.url,
        text: result.data.text,
        truncated: result.data.truncated,
      }
    },
    screenshot: (name?: string, options: BrowserOptions = {}) => execute('screenshot', { ...options, name }, false),
    download: (url: string, name?: string, options: BrowserOptions = {}) =>
      execute('download', { ...options, url, name }),
    close: (options: BrowserOptions = {}) => execute('close', options),
  }
}
