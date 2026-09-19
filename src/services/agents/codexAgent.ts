import { invoke } from '@tauri-apps/api/core'
import type { LuczorMode } from '@/services/inference/types'
import { getRepositoryExternalPolicy } from '@/services/repositoryGraph'
import { executionGate, executionPayload } from '@/services/executionGate'
import type { AgentAdapter, AgentPermission, AgentProjectSnapshot } from './types'
import { selectAgentEffort, type AgentCapabilityCatalog } from './effort'

export function getCodexModelCapabilities(): Promise<AgentCapabilityCatalog> {
  return invoke('codex_model_capabilities')
}

export type CodexJobSnapshot = {
  id: string
  principalId: string
  projectId: string
  status: 'starting' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'
  externalThreadId?: string | null
  output: string
  error?: string | null
  outputTruncated: boolean
  createdAt: number
  finishedAt?: number | null
}

export type CodexAgentDependencies = {
  invoke: typeof invoke
  externalPolicy: typeof getRepositoryExternalPolicy
  wait: () => Promise<void>
  captureExecution: (
    signal: AbortSignal,
    origin?: { projectId: string; jobId: string; mode?: LuczorMode }
  ) => {
    signal: AbortSignal
    authorize: (permission: AgentPermission) => Promise<{ sessionId: string; generation: number }>
  }
}

const defaultDependencies: CodexAgentDependencies = {
  invoke,
  externalPolicy: getRepositoryExternalPolicy,
  wait: () => new Promise(resolve => setTimeout(resolve, 400)),
  captureExecution(signal, origin) {
    // A job started from a chat keeps that chat's permission mode for its whole run.
    const ticket = origin?.mode
      ? executionGate.capture(signal, { projectId: origin.projectId, runId: `agent-job:${origin.jobId}` }, origin.mode)
      : executionGate.capture(signal)
    return {
      signal: ticket.signal,
      authorize: permission => executionPayload(ticket, permission === 'workspace-write'),
    }
  },
}

function terminal(snapshot: CodexJobSnapshot): boolean {
  return ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.status)
}

/** Native managed jobs require an executable, not merely a shell shim. */
export function getCodexRuntimeStatus() {
  return invoke<{ available: boolean; desktopAvailable: boolean; desktopProjectCreation: false; transport: string }>(
    'codex_runtime_status'
  )
}

export function listCodexJobs(principalId: string, projectId?: string) {
  return invoke<CodexJobSnapshot[]>('codex_job_list', { payload: { principalId, projectId } })
}

export function listCodexSessions(project: AgentProjectSnapshot) {
  if (!project.rootPath || !Number.isFinite(project.workspaceUpdatedAt)) {
    throw new Error('Für Codex fehlt eine aktuelle Projektordner-Zuordnung.')
  }
  return invoke<{ threadId: string; updatedAt?: number }[]>('codex_session_list', {
    payload: {
      principalId: project.principalId,
      projectId: project.projectId,
      expectedRootPath: project.rootPath,
      expectedWorkspaceUpdatedAt: project.workspaceUpdatedAt,
    },
  })
}

/** Opens the native app at the bound project; a user still creates its task there. */
export async function openCodexDesktopForProject(project: AgentProjectSnapshot, externalThreadId?: string) {
  if (!project.rootPath || !Number.isFinite(project.workspaceUpdatedAt)) {
    throw new Error('Für Codex fehlt eine aktuelle Projektordner-Zuordnung.')
  }
  return invoke<{ dispatched: true; savedProjectCreated: false }>('codex_desktop_open', {
    payload: {
      principalId: project.principalId,
      projectId: project.projectId,
      expectedRootPath: project.rootPath,
      expectedWorkspaceUpdatedAt: project.workspaceUpdatedAt,
      externalThreadId,
    },
  })
}

export function createCodexAgentAdapter(dependencies: CodexAgentDependencies = defaultDependencies): AgentAdapter {
  return {
    id: 'codex',
    permissions: ['read-only', 'workspace-write'],
    async run(request) {
      const guarded = dependencies.captureExecution(request.signal, {
        projectId: request.project.projectId,
        jobId: request.jobId,
        mode: request.mode,
      })
      const signal = guarded.signal
      if ((await dependencies.externalPolicy()) === 'deny')
        throw new Error('Die Repository-Richtlinie verbietet externe Coding-Agenten.')
      if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError')
      if (!request.project.rootPath || !Number.isFinite(request.project.workspaceUpdatedAt)) {
        throw new Error('Für Codex fehlt eine aktuelle Projektordner-Zuordnung.')
      }
      const scope = { principalId: request.project.principalId, projectId: request.project.projectId }
      let effortSelection = request.effortSelection
      if (!effortSelection && (request.thinkingTier || request.effort)) {
        const catalog = await dependencies.invoke<AgentCapabilityCatalog>('codex_model_capabilities')
        effortSelection = selectAgentEffort({
          adapter: 'codex',
          tier: request.thinkingTier,
          role: request.role,
          model: request.model,
          override: request.effort,
          catalog,
        })
      }
      if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError')
      let snapshot: CodexJobSnapshot
      try {
        const execution = await guarded.authorize(request.permission)
        if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError')
        snapshot = await dependencies.invoke<CodexJobSnapshot>('codex_job_start', {
          payload: {
            ...scope,
            expectedRootPath: request.workflowScope?.expectedRootPath ?? request.project.rootPath,
            expectedWorkspaceUpdatedAt: request.project.workspaceUpdatedAt,
            workflowScope: request.workflowScope,
            prompt: request.prompt,
            permission: request.permission,
            model: request.model,
            defaultModelRevision: request.defaultModelRevision,
            effort: effortSelection?.requestedEffort,
            capabilityRevision: effortSelection?.capabilityRevision,
            externalThreadId: request.externalThreadId,
            timeoutSeconds: 900,
            execution,
          },
        })
      } catch {
        if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError')
        throw new Error('Der native Codex-Auftrag konnte nicht gestartet werden.')
      }
      const payload = { ...scope, jobId: snapshot.id }
      let cancellation: Promise<CodexJobSnapshot | undefined> | undefined
      let transportFailed = false
      const cancel = () => {
        if (terminal(snapshot)) return
        // A cancellation request is not acknowledgement of a stopped worker.
        cancellation ??= dependencies.invoke<CodexJobSnapshot>('codex_job_cancel', { payload }).catch(() => undefined)
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        if (signal.aborted) cancel()
        while (!terminal(snapshot)) {
          if (cancellation) {
            const acknowledgement = await cancellation
            if (acknowledgement && terminal(acknowledgement)) {
              snapshot = acknowledgement
              break
            }
            if (!acknowledgement) cancellation = undefined
          }
          if (!signal.aborted && !transportFailed) {
            try {
              request.onOutput(snapshot.output)
            } catch {
              /* UI observers cannot release a native worker. */
            }
          }
          await dependencies.wait()
          if ((signal.aborted || transportFailed) && !cancellation) cancel()
          try {
            snapshot = await dependencies.invoke<CodexJobSnapshot>('codex_job_status', { payload })
          } catch {
            // Failed polling cannot release the workspace while writes may
            // still be running. Retry until native state is terminal.
            transportFailed = true
            cancel()
          }
        }
        if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError')
        if (transportFailed || snapshot.status !== 'completed')
          throw new Error('Codex-Auftrag wurde nicht abgeschlossen. Bitte den Laufzeitstatus prüfen.')
        return {
          output: snapshot.output + (snapshot.outputTruncated ? '\n\n[Ausgabe gekürzt]' : ''),
          externalThreadId: snapshot.externalThreadId ?? undefined,
          effortSelection,
        }
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
  }
}
