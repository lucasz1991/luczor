/** Workflow browser operations always target one native run-bound session. */
import { invoke } from '@tauri-apps/api/core'
import { browserFailureOutcome, getBrowserFailure, type BrowserFailureDiagnostic } from '@/services/browserFailure'
export type WorkflowArtifactScope = Readonly<{
  principalId: string
  projectId: string
  expectedRootPath: string
  expectedWorkspaceUpdatedAt: number
  runId: string
  /** Native research registry resolves this scope without a project-folder binding. */
  researchId?: string
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
export type BrowserObservation =
  | (WorkflowBrowserResult & { status: 'ok'; guidance?: string })
  | {
      status: 'unavailable'
      code: string
      guidance: string
      next_tool: 'browser_dom_scan'
      browserFailure?: BrowserFailureDiagnostic
    }
export type WorkflowBrowserActionResult = WorkflowBrowserResult & {
  observation: BrowserObservation
}
export type BrowserOptions = {
  sessionId?: string
  expectedTabId?: string
  expectedUrl?: string
  timeoutMs?: number
}
export type BrowserScanOptions = BrowserOptions & {
  selector?: string
  query?: string
  offset?: number
  limit?: number
}
export type BrowserReadOptions = BrowserOptions & {
  offset?: number
  maxChars?: number
}
export type BrowserReadResult = Record<string, unknown> & {
  ok: boolean
  sessionId: string
  tabId: string
  url: string
  text: string
  truncated: boolean
}

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
  let sessionId: string | undefined
  let attemptedOpen = false
  const execute = async (action: string, options: Record<string, unknown> = {}, mutating = true) => {
    const requestedSession = typeof options.sessionId === 'string' ? options.sessionId : sessionId
    if (action === 'open') attemptedOpen = true
    const result = await context.invokeTask<WorkflowBrowserResult>(
      'wf_browser_action',
      {
        ...options,
        scope,
        // Legacy host lists no longer restrict the user's internal browser.
        allowedHosts: undefined,
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
  const executeAndObserve = async (
    action: string,
    options: Record<string, unknown>
  ): Promise<WorkflowBrowserActionResult> => {
    // Keep the confirmed action outside the observation catch; a read cannot undo its receipt.
    const result = await execute(action, options)
    try {
      const observed = await execute(
        'scan',
        {
          sessionId: result.sessionId,
          expectedTabId: result.tabId,
          limit: 40,
          timeoutMs: 3000,
        },
        false
      )
      if (
        observed.tabId !== result.tabId ||
        typeof observed.url !== 'string' ||
        observed.data.version !== 1 ||
        !Array.isArray(observed.data.elements) ||
        !Number.isSafeInteger(observed.data.offset) ||
        Number(observed.data.offset) < 0
      )
        throw new Error('workflow_browser_observation_invalid')
      const documentUrl = observed.data.documentUrl
      const guidance =
        typeof documentUrl === 'string' && documentUrl !== observed.url
          ? 'The document URL differs from the browser URL. This is not a normal loaded target page; control may be limited. Check the task URL or project_path before navigating to a corrected target. Do not treat this as proof that the requested page loaded.'
          : observed.url === 'about:blank' && observed.data.elements.length === 0
            ? 'This is an empty blank page. To test forms or links, use browser_navigate with the task URL or an existing project_path returned by fs_write/fs_list, then use its observation. A screenshot cannot add interactive elements.'
            : undefined
      return {
        ...result,
        observation: {
          ...observed,
          status: 'ok',
          ...(guidance ? { guidance } : {}),
        },
      }
    } catch (error) {
      const failure = browserFailureOutcome(error)
      const diagnostic = getBrowserFailure(error)
      return {
        ...result,
        observation: {
          status: 'unavailable',
          code: typeof failure.output?.code === 'string' ? failure.output.code : 'browser_observation_unavailable',
          next_tool: 'browser_dom_scan',
          guidance:
            'The action completed. Only its following DOM observation is unavailable. Do not repeat the action; use browser_dom_scan when access remains permitted.',
          ...(diagnostic ? { browserFailure: diagnostic } : {}),
        },
      }
    }
  }
  return {
    /** An attempt can leave an observable native page even when no identity was returned. */
    hasAttemptedOpen: () => attemptedOpen,
    /** Confirmed by a successful own-scope native response; diagnostic IDs never establish ownership. */
    hasNativeSession: () => sessionId !== undefined,
    open: (url?: string, options: BrowserOptions = {}) => executeAndObserve('open', { ...options, url }),
    navigate: (url: string, options: BrowserOptions = {}) => executeAndObserve('navigate', { ...options, url }),
    click: (selector: string, options: BrowserOptions = {}) => executeAndObserve('click', { ...options, selector }),
    fill: (selector: string, value: string, options: BrowserOptions = {}) =>
      executeAndObserve('fill', { ...options, selector, value }),
    select: (selector: string, value: string, options: BrowserOptions = {}) =>
      executeAndObserve('select', { ...options, selector, value }),
    wait: (selector?: string, options: BrowserOptions = {}) => execute('wait', { ...options, selector }, false),
    scan: (options: BrowserScanOptions = {}) => execute('scan', options, false),
    read: async (selector?: string, options: BrowserReadOptions = {}): Promise<BrowserReadResult> => {
      const result = await execute('read', { ...options, selector }, false)
      if (typeof result.data.text !== 'string' || typeof result.data.truncated !== 'boolean')
        throw new Error('workflow_browser_read_invalid')
      return {
        ...result.data,
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
