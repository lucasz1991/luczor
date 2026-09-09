import { invoke } from '@tauri-apps/api/core'
import { executionGate, executionPayload } from '@/services/executionGate'
import { getRepositoryExternalPolicy } from '@/services/repositoryGraph'
import { selectAgentEffort, type AgentCapabilityCatalog } from './effort'
import type { AgentAdapter, AgentEffort, AgentPermission } from './types'

export const CLAUDE_CAPABILITIES: AgentCapabilityCatalog = Object.freeze({
  revision: 'claude-code-2.1.266-documented',
  source: 'sdk-documentation',
  models: [
    ...['claude-opus-4-6', 'claude-sonnet-4-6'].map(model => ({
      model,
      supportedEfforts: ['low', 'medium', 'high', 'max'] as const,
    })),
    ...[
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-fable-5-1',
    ].map(model => ({ model, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const })),
  ],
})
export type ClaudeJobSnapshot = {
  id: string
  principalId: string
  projectId: string
  status: string
  output: string
  outputTruncated: boolean
  error?: string | null
  model?: string | null
  appliedEffort?: AgentEffort | null
  toolCalls: number
}
export type ClaudeAgentDependencies = {
  invoke: typeof invoke
  externalPolicy: typeof getRepositoryExternalPolicy
  wait: () => Promise<void>
  captureExecution: (signal: AbortSignal) => {
    signal: AbortSignal
    authorize: (permission: AgentPermission) => Promise<{ sessionId: string; generation: number }>
  }
}
const dependencies: ClaudeAgentDependencies = {
  invoke,
  externalPolicy: getRepositoryExternalPolicy,
  wait: () => new Promise(resolve => setTimeout(resolve, 250)),
  captureExecution(signal) {
    const ticket = executionGate.capture(signal)
    return {
      signal: ticket.signal,
      authorize: permission => executionPayload(ticket, permission === 'workspace-write'),
    }
  },
}
const terminal = (status: string) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(status)
export function getClaudeRuntimeStatus() {
  return invoke<{
    available: boolean
    sdkVersion: string
    cliVersion: string
    executionProfile: 'host-user'
    reason?: string
  }>('claude_runtime_status')
}

export function createClaudeAgentAdapter(api: ClaudeAgentDependencies = dependencies): AgentAdapter {
  return {
    id: 'claude',
    permissions: ['read-only', 'workspace-write'],
    async run(request) {
      if (request.executionProfile !== 'host-user')
        throw new Error('Claude benötigt das freigegebene Profil Windows · Benutzerrechte.')
      if (request.externalThreadId)
        throw new Error('Claude-Aufträge verwenden derzeit eigenständige, nicht fortgesetzte Sitzungen.')
      if ((await api.externalPolicy()) === 'deny')
        throw new Error('Die Repository-Richtlinie verbietet externe Coding-Agenten.')
      if (!request.project.rootPath || !Number.isFinite(request.project.workspaceUpdatedAt))
        throw new Error('Claude benötigt eine aktuelle Projektzuordnung.')
      const execution = api.captureExecution(request.signal)
      const signal = execution.signal
      if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError')
      const selection =
        request.effortSelection ??
        selectAgentEffort({
          adapter: 'claude',
          tier: request.thinkingTier,
          model: request.model,
          role: request.role,
          override: request.effort,
          catalog: CLAUDE_CAPABILITIES,
        })
      const scope = { principalId: request.project.principalId, projectId: request.project.projectId }
      const permit = await execution.authorize(request.permission)
      if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError')
      let snapshot = await api.invoke<ClaudeJobSnapshot>('claude_job_start', {
        payload: {
          ...scope,
          expectedRootPath: request.project.rootPath,
          expectedWorkspaceUpdatedAt: request.project.workspaceUpdatedAt,
          prompt: request.prompt,
          model: request.model,
          effort: selection.requestedEffort,
          defaultModelRevision: request.defaultModelRevision,
          permission: request.permission,
          executionProfile: 'host-user',
          hostAccessAcknowledged: true,
          execution: permit,
          timeoutSeconds: 900,
          maxTurns: request.maxTurns ?? 24,
          maxBudgetUsd: request.maxBudgetUsd,
        },
      })
      const payload = { ...scope, jobId: snapshot.id }
      let cancellation: Promise<ClaudeJobSnapshot | undefined> | undefined
      let transportFailed = false
      const cancel = () => {
        if (!terminal(snapshot.status))
          cancellation ??= api.invoke<ClaudeJobSnapshot>('claude_job_cancel', { payload }).catch(() => undefined)
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        if (signal.aborted) cancel()
        while (!terminal(snapshot.status)) {
          if (cancellation) {
            const stopped = await cancellation
            if (stopped && terminal(stopped.status)) {
              snapshot = stopped
              break
            }
            cancellation = undefined
          }
          if (!signal.aborted && !transportFailed) {
            try {
              request.onOutput(snapshot.output)
            } catch {
              transportFailed = true
              cancel()
            }
          }
          await api.wait()
          if (signal.aborted || transportFailed) cancel()
          try {
            snapshot = await api.invoke<ClaudeJobSnapshot>('claude_job_status', { payload })
          } catch {
            transportFailed = true
            cancel()
          }
        }
        if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError')
        if (transportFailed || snapshot.status !== 'completed' || !snapshot.output.trim())
          throw new Error(snapshot.error ?? 'Claude-Auftrag lieferte kein verwertbares Ergebnis.')
        return {
          output: snapshot.output,
          runtimeEvidence: Object.freeze({
            ...(snapshot.model ? { model: snapshot.model, modelSource: 'runtime' as const } : {}),
            toolGateChecks: snapshot.toolCalls,
          }),
          effortSelection: Object.freeze({
            ...selection,
            model: snapshot.model ?? selection.model,
            appliedEffort: snapshot.appliedEffort ?? undefined,
            status: snapshot.appliedEffort ? ('confirmed' as const) : selection.status,
          }),
        }
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
  }
}
