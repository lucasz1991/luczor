import { invoke } from '@tauri-apps/api/core'
import { executionGate, executionPayload, type ExecutionTicket } from '@/services/executionGate'
import type { WorkflowArtifact, WorkflowArtifactScope } from '@/services/workflows/browser'

export type ResearchBinding = Readonly<{
  principalId: string
  projectId: string
  chatId: string
  runId: string
  rootPath: string
  revision: number
  workflowScope: WorkflowArtifactScope
}>
export type ResearchPrepareInput = {
  principalId: string
  projectId: string
  chatId: string
  runId: string
  target: 'project' | 'central'
  workspaceProjectId?: string
  centralRoot?: string
  slug: string
  title: string
}
export type ResearchFileReceipt = { path: string; bytes: number; sha256: string }

async function call<T>(command: string, payload: Record<string, unknown>, ticket: ExecutionTicket, mutating = false) {
  executionGate.assert(ticket, mutating)
  const execution = await executionPayload(ticket, mutating)
  const result = await invoke<T>(command, { payload: { ...payload, execution } })
  executionGate.assert(ticket, mutating)
  return result
}

export function researchPreview(input: ResearchPrepareInput, ticket: ExecutionTicket) {
  return call<{ rootPath: string; workflowScope: WorkflowArtifactScope }>('research_preview', input, ticket)
}
export function researchPrepare(
  input: ResearchPrepareInput & { expectedRootPath: string; resume?: boolean },
  ticket: ExecutionTicket
) {
  return call<ResearchBinding>('research_prepare', input, ticket, true)
}
export function researchRead(runId: string, path: string, ticket: ExecutionTicket, maxBytes?: number) {
  return call<ResearchFileReceipt & { content: string }>('research_read', { runId, path, maxBytes }, ticket)
}
export function researchWrite(
  runId: string,
  path: string,
  content: string,
  ticket: ExecutionTicket,
  expectedSha256?: string
) {
  return call<ResearchFileReceipt>('research_write', { runId, path, content, expectedSha256 }, ticket, true)
}
export function researchExportArtifact(runId: string, artifactId: string, path: string, ticket: ExecutionTicket) {
  return call<ResearchFileReceipt & { mime: string }>(
    'research_export_artifact',
    { runId, artifactId, path },
    ticket,
    true
  )
}
export function researchReadArtifact(runId: string, artifactId: string, ticket: ExecutionTicket) {
  return call<{ artifact: WorkflowArtifact; base64: string }>('research_read_artifact', { runId, artifactId }, ticket)
}
export function researchVerify(runId: string, files: { path: string; sha256: string }[], ticket: ExecutionTicket) {
  return call<{ ok: boolean; files: ResearchFileReceipt[] }>('research_verify', { runId, files }, ticket)
}
export function researchOpen(runId: string, ticket: ExecutionTicket, path?: string, principalId?: string) {
  return call<boolean>('research_open', { runId, path, principalId }, ticket)
}
/** Owner cleanup remains possible after the ticket is revoked; this cannot create or renew a grant. */
export function researchRelease(runId: string, ticket: ExecutionTicket) {
  const { sessionId, generation, scope, scopeGeneration } = ticket
  return invoke<boolean>('research_release', {
    payload: { runId, execution: { sessionId, generation, scope, scopeGeneration } },
  })
}
