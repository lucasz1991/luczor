import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { executionGate, executionPayload, onExecutionInvalidated, type ExecutionTicket } from '@/services/executionGate'
import { requireProjectWorkspace } from '@/services/projectWorkspace'
import { captureWorkflowAccess } from '@/services/workflows/access'
import { cleanupWorkflowBrowser, createWorkflowBrowser, type WorkflowArtifactScope } from '@/services/workflows/browser'
import type { ToolContext } from './types'

export type ToolSessionStatus = 'active' | 'stopped' | 'expired'
export type ToolSession = Readonly<{
  id: string
  projectId: string
  kind: 'browser' | 'terminal' | 'vision' | 'model'
  status: ToolSessionStatus
  createdAt: number
  updatedAt: number
  allowedHosts: readonly string[]
  conversationId?: string
  runId?: string
}>

type InternalSession = {
  meta: ToolSession
  ticket: ExecutionTicket
  scope: WorkflowArtifactScope
  ownerToolSessionId?: string
  invokeTask: <T>(command: string, payload: Record<string, unknown>, mutating?: boolean) => Promise<T>
  browser?: ReturnType<typeof createWorkflowBrowser>
}

const sessions = new Map<string, InternalSession>()
const preparing = new Map<string, Promise<InternalSession>>()
const closing = new Map<string, Promise<boolean>>()
const activeRuns = new Map<string, number>()
const browserAvailabilityListeners = new Set<() => void>()
let browserAdmission: Promise<unknown> = Promise.resolve()
let browserPreparation: Promise<InternalSession> | undefined
export const toolSessionRevision = ref(0)

function notify(): void {
  toolSessionRevision.value++
  for (const listener of [...browserAvailabilityListeners]) listener()
}

/** Wait outside the operation queue, allowing the current owner to complete its DOM sequence. */
export async function acquireBrowserToolSession(ctx: ToolContext): Promise<InternalSession> {
  const ticket = ctx.execution ?? executionGate.capture(ctx.signal)
  const signal =
    ctx.signal && ctx.signal !== ticket.signal ? AbortSignal.any([ctx.signal, ticket.signal]) : ticket.signal
  executionGate.assert(ticket, true)
  signal.throwIfAborted()
  // An existing owner must not wait behind a contender that is waiting for that owner to close.
  if (findToolSession({ ...ctx, execution: ticket }, 'browser'))
    return getToolSession({ ...ctx, execution: ticket }, 'browser')
  const admission = browserAdmission
    .catch(() => undefined)
    .then(async () => {
      executionGate.assert(ticket, true)
      signal.throwIfAborted()
      while (
        [...sessions.values()].some(
          session =>
            session.meta.kind === 'browser' && session.meta.status === 'active' && !session.ticket.signal.aborted
        )
      ) {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            browserAvailabilityListeners.delete(changed)
            signal.removeEventListener('abort', abort)
          }
          const changed = () => {
            finish()
            resolve()
          }
          const abort = () => {
            finish()
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          }
          browserAvailabilityListeners.add(changed)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
        executionGate.assert(ticket, true)
        signal.throwIfAborted()
      }
      return getToolSession({ ...ctx, execution: ticket }, 'browser')
    })
  browserAdmission = admission.then(
    () => undefined,
    () => undefined
  )
  // A queued caller aborts immediately, even if its predecessor is still waiting.
  return new Promise<InternalSession>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    void admission.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}

function sessionKey(projectId: string, kind: InternalSession['meta']['kind'], runId?: string): string {
  return `${projectId}:${kind}:${runId ?? 'legacy'}`
}

export function listToolSessions(): ToolSession[] {
  return [...sessions.values()].map(item => item.meta)
}

/** Inspect only this caller's session. Reads and cleanup must never create one. */
export function findToolSession(ctx: ToolContext, kind: ToolSession['kind']): InternalSession | undefined {
  const ticket = ctx.execution ?? executionGate.capture(ctx.signal)
  executionGate.assert(ticket)
  const session = sessions.get(sessionKey(ctx.projectId, kind, ticket.scope?.runId ?? ctx.toolSessionId))
  if (!session || session.ticket.sessionId !== ticket.sessionId || session.ticket.generation !== ticket.generation)
    return undefined
  executionGate.assert(session.ticket)
  return session
}

/** Retain the last page for inspection, but do not let a finished run monopolize the browser. */
export function finishToolSessions(ctx: ToolContext): void {
  const ticket = ctx.execution
  if (!ticket) return
  for (const kind of ['browser', 'terminal', 'vision', 'model'] as const) {
    const session = sessions.get(sessionKey(ctx.projectId, kind, ticket.scope?.runId ?? ctx.toolSessionId))
    if (
      !session ||
      session.ticket.sessionId !== ticket.sessionId ||
      session.ticket.generation !== ticket.generation ||
      session.ticket.scopeGeneration !== ticket.scopeGeneration
    )
      continue
    session.meta = { ...session.meta, status: 'expired', updatedAt: Date.now() }
    notify()
  }
}

/** Nested agents sharing an execution scope must not expire their parent's session. */
export function retainToolSessionRun(ctx: ToolContext): () => void {
  const ticket = ctx.execution
  const key = `${ticket?.sessionId}:${ticket?.generation}:${ctx.projectId}:${ticket?.scope?.runId ?? ctx.toolSessionId ?? 'legacy'}`
  activeRuns.set(key, (activeRuns.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (activeRuns.get(key) ?? 1) - 1
    if (remaining > 0) activeRuns.set(key, remaining)
    else {
      activeRuns.delete(key)
      finishToolSessions(ctx)
    }
  }
}

/** Host-independent, owner-scoped native cleanup, including a failed or half-open session. */
export async function closeToolSession(id: string): Promise<boolean> {
  const pending = closing.get(id)
  if (pending) return pending
  const entry = [...sessions.entries()].find(([, session]) => session.meta.id === id)
  if (!entry) return false
  const [key, session] = entry
  const operation = (async () => {
    if (session.meta.kind === 'browser') await cleanupWorkflowBrowser(session.scope)
    if (session.meta.kind === 'terminal') {
      const ticket = session.ticket.scope
        ? executionGate.capture(undefined, session.ticket.scope, session.ticket.mode)
        : executionGate.capture()
      const execution = await executionPayload(ticket, false)
      await invoke('wf_execution_cancel', {
        payload: { execution, executionId: session.scope.runId },
      })
    }
    // Keep the handle on cleanup failure; do not lose the ability to release the native window.
    if (sessions.get(key) === session) sessions.delete(key)
    session.meta = { ...session.meta, status: 'stopped', updatedAt: Date.now() }
    notify()
    return true
  })()
  closing.set(id, operation)
  try {
    return await operation
  } finally {
    closing.delete(id)
  }
}

export async function closeToolSessionsForOwner(ownerToolSessionId: string): Promise<void> {
  if (!ownerToolSessionId) return
  const ids = [...sessions.values()]
    .filter(session => session.ownerToolSessionId === ownerToolSessionId)
    .map(session => session.meta.id)
  await Promise.all(ids.map(id => closeToolSession(id)))
}

export async function getToolSession(
  ctx: ToolContext,
  kind: InternalSession['meta']['kind'],
  allowedHosts: readonly string[] = []
): Promise<InternalSession> {
  const ticket = ctx.execution ?? executionGate.capture(ctx.signal)
  executionGate.assert(ticket, kind !== 'vision')
  const key = sessionKey(ctx.projectId, kind, ticket.scope?.runId ?? ctx.toolSessionId)
  const pending = preparing.get(key)
  if (pending) {
    await pending
    return getToolSession(ctx, kind, allowedHosts)
  }
  if (kind === 'browser' && browserPreparation) {
    await browserPreparation
    return getToolSession(ctx, kind, allowedHosts)
  }
  const existing = sessions.get(key)
  if (existing && existing.ticket.sessionId === ticket.sessionId && existing.ticket.generation === ticket.generation) {
    executionGate.assert(existing.ticket, kind !== 'vision')
    if ((ctx.researchScope?.researchId ?? '') !== (existing.scope.researchId ?? ''))
      throw new Error('research_tool_scope_changed')
    if (
      kind !== 'browser' &&
      allowedHosts.length &&
      JSON.stringify([...allowedHosts].sort()) !== JSON.stringify([...existing.meta.allowedHosts].sort())
    )
      throw new Error(
        'Die Browser-Sitzung ist an andere Hosts gebunden. browser_status mit {} liest die Bindung; browser_close mit {} beendet sie. Keine Hostnamen raten. (browser_session_hosts_changed)'
      )
    existing.meta = { ...existing.meta, updatedAt: Date.now(), status: 'active' }
    return existing
  }

  const operation = createSession()
  preparing.set(key, operation)
  if (kind === 'browser') browserPreparation = operation
  try {
    return await operation
  } finally {
    if (preparing.get(key) === operation) preparing.delete(key)
    if (browserPreparation === operation) browserPreparation = undefined
  }

  async function createSession(): Promise<InternalSession> {
    if (kind === 'browser') {
      for (const session of sessions.values()) {
        if (session.meta.kind !== 'browser') continue
        if (session.meta.status === 'expired' || session.ticket.signal.aborted) await closeToolSession(session.meta.id)
        else throw new Error('workflow_browser_owned_by_another_run')
      }
    }
    let scope: WorkflowArtifactScope
    if (ctx.researchScope) {
      if (
        !ctx.researchScope.researchId ||
        ctx.researchScope.researchId !== ctx.researchScope.runId ||
        ctx.researchScope.projectId !== ctx.projectId ||
        !ctx.researchScope.principalId ||
        !ctx.researchScope.expectedRootPath ||
        !ctx.researchScope.expectedWorkspaceUpdatedAt
      )
        throw new Error('research_tool_scope_invalid')
      scope = Object.freeze({ ...ctx.researchScope })
    } else {
      const access = await captureWorkflowAccess(ctx, ctx.projectId, kind !== 'vision')
      const workspace = await requireProjectWorkspace(ctx.projectId, access.principalId)
      if (!workspace.updatedAt) throw new Error('Die Projektzuordnung besitzt keine gültige Revision.')
      scope = Object.freeze({
        principalId: access.principalId,
        projectId: access.projectId,
        expectedRootPath: workspace.rootPath,
        expectedWorkspaceUpdatedAt: workspace.updatedAt,
        runId: crypto.randomUUID(),
      })
    }
    const invokeTask = async <T>(command: string, payload: Record<string, unknown>, mutating = true): Promise<T> => {
      executionGate.assert(ticket, mutating)
      const execution = await executionPayload(ticket, mutating)
      const result = await invoke<T>(command, {
        payload: { ...payload, execution: { ...execution, workflowExecutionId: scope.runId } },
      })
      executionGate.assert(ticket, mutating)
      return result
    }
    const meta: ToolSession = Object.freeze({
      id: scope.researchId ? crypto.randomUUID() : scope.runId,
      projectId: scope.projectId,
      kind,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      allowedHosts: Object.freeze(kind === 'browser' ? [] : [...allowedHosts]),
      conversationId: ticket.scope?.conversationId,
      runId: ticket.scope?.runId,
    })
    const internal: InternalSession = {
      meta,
      ticket,
      scope,
      ...(ctx.toolSessionId ? { ownerToolSessionId: ctx.toolSessionId } : {}),
      invokeTask,
    }
    if (kind === 'browser') {
      internal.browser = createWorkflowBrowser({
        scope,
        invokeTask,
        automated: true,
      })
    }
    // Account, workspace and stop state can change while permissions are being resolved.
    executionGate.assert(ticket, kind !== 'vision')
    sessions.set(key, internal)
    notify()
    return internal
  }
}

export function stopToolSession(id: string): boolean {
  if (![...sessions.values()].some(session => session.meta.id === id)) return false
  // UI callers historically return immediately. Keep failed native cleanup visible/retryable.
  void closeToolSession(id).catch(() => {})
  return true
}

export function clearToolSessions(): void {
  if (!sessions.size) return
  for (const session of sessions.values()) {
    if (session.meta.kind === 'browser') void cleanupWorkflowBrowser(session.scope).catch(() => {})
  }
  sessions.clear()
  notify()
}

onExecutionInvalidated(clearToolSessions)
