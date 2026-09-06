import { invoke } from '@tauri-apps/api/core'
import { getRepositoryExternalPolicy } from '@/services/repositoryGraph'
import type { AgentAdapter, AgentProjectSnapshot } from './types'

export type CodexJobSnapshot = {
  id: string
  status: 'starting' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'timed_out'
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
}

const defaultDependencies: CodexAgentDependencies = {
  invoke,
  externalPolicy: getRepositoryExternalPolicy,
  wait: () => new Promise(resolve => setTimeout(resolve, 400)),
}

function terminal(snapshot: CodexJobSnapshot): boolean {
  return ['completed', 'failed', 'cancelled', 'timed_out'].includes(snapshot.status)
}

/** Native managed jobs require an executable, not merely a shell shim. */
export function getCodexRuntimeStatus() {
  return invoke<{ available: boolean; desktopProjectCreation: false; transport: string }>('codex_runtime_status')
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
      if ((await dependencies.externalPolicy()) === 'deny')
        throw new Error('Die Repository-Richtlinie verbietet externe Coding-Agenten.')
      if (request.signal.aborted) throw new DOMException('Abgebrochen', 'AbortError')
      if (!request.project.rootPath || !Number.isFinite(request.project.workspaceUpdatedAt)) {
        throw new Error('Für Codex fehlt eine aktuelle Projektordner-Zuordnung.')
      }
      const scope = { principalId: request.project.principalId, projectId: request.project.projectId }
      let snapshot: CodexJobSnapshot
      try {
        snapshot = await dependencies.invoke<CodexJobSnapshot>('codex_job_start', {
          payload: {
            ...scope,
            expectedRootPath: request.project.rootPath,
            expectedWorkspaceUpdatedAt: request.project.workspaceUpdatedAt,
            prompt: request.prompt,
            permission: request.permission,
            model: request.model,
            externalThreadId: request.externalThreadId,
            timeoutSeconds: 900,
          },
        })
      } catch {
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
      request.signal.addEventListener('abort', cancel, { once: true })
      try {
        if (request.signal.aborted) cancel()
        while (!terminal(snapshot)) {
          if (cancellation) {
            const acknowledgement = await cancellation
            if (acknowledgement && terminal(acknowledgement)) {
              snapshot = acknowledgement
              break
            }
            if (!acknowledgement) cancellation = undefined
          }
          if (!request.signal.aborted && !transportFailed) {
            try {
              request.onOutput(snapshot.output)
            } catch {
              /* UI observers cannot release a native worker. */
            }
          }
          await dependencies.wait()
          if ((request.signal.aborted || transportFailed) && !cancellation) cancel()
          try {
            snapshot = await dependencies.invoke<CodexJobSnapshot>('codex_job_status', { payload })
          } catch {
            // Failed polling cannot release the workspace while writes may
            // still be running. Retry until native state is terminal.
            transportFailed = true
            cancel()
          }
        }
        if (request.signal.aborted) throw new DOMException('Abgebrochen', 'AbortError')
        if (transportFailed || snapshot.status !== 'completed')
          throw new Error('Codex-Auftrag wurde nicht abgeschlossen. Bitte den Laufzeitstatus prüfen.')
        return {
          output: snapshot.output + (snapshot.outputTruncated ? '\n\n[Ausgabe gekürzt]' : ''),
          externalThreadId: snapshot.externalThreadId ?? undefined,
        }
      } finally {
        request.signal.removeEventListener('abort', cancel)
      }
    },
  }
}
