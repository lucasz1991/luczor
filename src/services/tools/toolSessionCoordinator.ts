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
export const toolSessionRevision = ref(0)

function notify(): void {
  toolSessionRevision.value++
}

function sessionKey(projectId: string, kind: InternalSession['meta']['kind']): string {
  return `${projectId}:${kind}`
}

export function listToolSessions(): ToolSession[] {
  return [...sessions.values()].map(item => item.meta)
}

export async function getToolSession(
  ctx: ToolContext,
  kind: InternalSession['meta']['kind'],
  allowedHosts: readonly string[] = []
): Promise<InternalSession> {
  const ticket = ctx.execution ?? executionGate.capture(ctx.signal)
  executionGate.assert(ticket, kind !== 'vision')
  const key = sessionKey(ctx.projectId, kind)
  const existing = sessions.get(key)
  if (existing && existing.ticket.sessionId === ticket.sessionId && existing.ticket.generation === ticket.generation) {
    executionGate.assert(existing.ticket, kind !== 'vision')
    if (
      allowedHosts.length &&
      JSON.stringify([...allowedHosts].sort()) !== JSON.stringify([...existing.meta.allowedHosts].sort())
    )
      throw new Error(
        'Die Browser-Sitzung ist an andere Hosts gebunden. Sitzung zuerst schließen und mit den gewünschten Hosts neu öffnen.'
      )
    existing.meta = { ...existing.meta, updatedAt: Date.now(), status: 'active' }
    return existing
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
  sessions.set(key, internal)
  notify()
  return internal
}

export function stopToolSession(id: string): boolean {
  let changed = false
  for (const [key, session] of sessions) {
    if (session.meta.id !== id) continue
    if (session.meta.kind === 'browser') void cleanupWorkflowBrowser(session.scope).catch(() => {})
    session.meta = { ...session.meta, status: 'stopped', updatedAt: Date.now() }
    sessions.delete(key)
    changed = true
  }
  if (changed) notify()
  return changed
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
