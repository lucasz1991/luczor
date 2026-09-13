import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { executionGate, executionPayload, onExecutionInvalidated, type ExecutionTicket } from '@/services/executionGate'
import { requireProjectWorkspace } from '@/services/projectWorkspace'
import { captureWorkflowAccess } from '@/services/workflows/access'
import { cleanupWorkflowBrowser, createWorkflowBrowser } from '@/services/workflows/browser'
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
}>

type InternalSession = {
  meta: ToolSession
  ticket: ExecutionTicket
  scope: {
    principalId: string
    projectId: string
    expectedRootPath: string
    expectedWorkspaceUpdatedAt: number
    runId: string
  }
  invokeTask: <T>(command: string, payload: Record<string, unknown>, mutating?: boolean) => Promise<T>
  browser?: ReturnType<typeof createWorkflowBrowser>
}

const sessions = new Map<string, InternalSession>()
const preparing = new Map<string, Promise<InternalSession>>()
const closing = new Map<string, Promise<boolean>>()
const activeRuns = new Map<string, number>()
let browserPreparation: Promise<InternalSession> | undefined
export const toolSessionRevision = ref(0)

function notify(): void {
  toolSessionRevision.value++
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
    if (
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
    const access = await captureWorkflowAccess(ctx, ctx.projectId, kind !== 'vision')
    const workspace = await requireProjectWorkspace(ctx.projectId, access.principalId)
    if (!workspace.updatedAt) throw new Error('Die Projektzuordnung besitzt keine gültige Revision.')
    const scope = Object.freeze({
      principalId: access.principalId,
      projectId: access.projectId,
      expectedRootPath: workspace.rootPath,
      expectedWorkspaceUpdatedAt: workspace.updatedAt,
      runId: crypto.randomUUID(),
    })
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
      id: scope.runId,
      projectId: access.projectId,
      kind,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      allowedHosts: Object.freeze([...allowedHosts]),
    })
    const internal: InternalSession = { meta, ticket, scope, invokeTask }
    if (kind === 'browser') {
      internal.browser = createWorkflowBrowser({
        scope,
        invokeTask,
        allowedHosts,
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
