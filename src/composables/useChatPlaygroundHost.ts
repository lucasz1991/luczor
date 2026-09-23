import { onBeforeUnmount, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { LuczorMode } from '@/services/inference/types'
import { executionGate } from '@/services/executionGate'
import type { HostRequest } from '@/services/chatPlaygroundHostTypes'
import { getTool } from '@/services/tools/registry'
import { chatPlaygroundToolSessionId } from '@/services/chatPlayground'
import { closeToolSessionsForOwner } from '@/services/tools/toolSessionCoordinator'

type Options = {
  resolveMode(projectId: string, conversationId: string): LuczorMode
  validateBinding(projectId: string, conversationId: string): boolean
  bindFolder(projectId: string): Promise<void> | void
  closed(binding: { projectId: string; conversationId: string; sessionId: string }): void
}

function actionTool(request: HostRequest): { name: string; args: Record<string, unknown>; mutating: boolean } {
  const action = request.action
  switch (action.type) {
    case 'files_list':
      return { name: 'fs_list', args: { path: action.path, max_depth: 1, limit: 200 }, mutating: false }
    case 'files_read':
      return { name: 'fs_read', args: { path: action.path, max_bytes: 65_536 }, mutating: false }
    case 'terminal_run':
      return {
        name: 'project_terminal_run',
        args: { runtime: action.runtime, code: action.code, timeout_seconds: action.timeoutSeconds },
        mutating: true,
      }
    case 'browser':
      return {
        name: `browser_${action.action}`,
        args: action.url ? { url: action.url } : {},
        mutating: action.action !== 'status',
      }
    case 'bind_folder':
      throw new Error('bind_folder is handled by the application shell.')
  }
}

export function useChatPlaygroundHost(options: Options): void {
  let unlisten: UnlistenFn | undefined
  let unlistenClosed: UnlistenFn | undefined
  let unlistenReplaced: UnlistenFn | undefined
  let stopped = false
  const runs = new Map<string, AbortController>()
  const runOwners = new Map<string, string>()

  async function respond(request: HostRequest, result?: unknown, error?: unknown): Promise<void> {
    if (stopped) return
    await invoke('chat_playground_respond', {
      payload: {
        sessionId: request.sessionId,
        requestId: request.requestId,
        ...(error === undefined
          ? { result: result ?? null }
          : { error: error instanceof Error ? error.message : String(error) }),
      },
    }).catch(() => undefined)
  }

  async function handle(request: HostRequest): Promise<void> {
    try {
      if (!options.validateBinding(request.projectId, request.conversationId)) {
        throw new Error('Der gebundene Chat oder das Projekt ist nicht mehr verfügbar.')
      }
      if (request.action.type === 'bind_folder') {
        await options.bindFolder(request.projectId)
        await respond(request, { opened: true })
        return
      }
      const { name, args, mutating } = actionTool(request)
      const tool = getTool(name)
      if (!tool) throw new Error('Dieses Werkzeug ist nicht verfügbar.')
      let controller = runs.get(request.sessionId)
      if (!controller) {
        controller = new AbortController()
        runs.set(request.sessionId, controller)
      }
      const ownerToolSessionId = chatPlaygroundToolSessionId(request.projectId, request.conversationId)
      runOwners.set(request.sessionId, ownerToolSessionId)
      const scope = {
        projectId: request.projectId,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      }
      const execution = executionGate.capture(
        controller.signal,
        scope,
        options.resolveMode(request.projectId, request.conversationId)
      )
      executionGate.assert(execution, mutating)
      const result = await tool.execute(args, {
        projectId: request.projectId,
        execution,
        inferenceTarget: 'local',
        toolSessionId: ownerToolSessionId,
      })
      executionGate.assert(execution, mutating)
      await respond(request, result)
    } catch (error) {
      await respond(request, undefined, error)
    }
  }

  async function closeBinding(binding: {
    projectId: string
    conversationId: string
    sessionId: string
  }): Promise<void> {
    runs.get(binding.sessionId)?.abort(new DOMException('Chat Playground geschlossen oder neu gebunden.', 'AbortError'))
    runs.delete(binding.sessionId)
    const owner = chatPlaygroundToolSessionId(binding.projectId, binding.conversationId)
    runOwners.delete(binding.sessionId)
    await closeToolSessionsForOwner(owner).catch(() => undefined)
  }

  onMounted(async () => {
    if (!('__TAURI_INTERNALS__' in window)) return
    try {
      unlisten = await listen<HostRequest>('luczor://chat-playground-action', event => void handle(event.payload))
      unlistenClosed = await listen<{ projectId: string; conversationId: string; sessionId: string }>(
        'luczor://chat-playground-closed',
        event => {
          void closeBinding(event.payload).finally(() => options.closed(event.payload))
        }
      )
      unlistenReplaced = await listen<{ projectId: string; conversationId: string; sessionId: string }>(
        'luczor://chat-playground-session-replaced',
        event => void closeBinding(event.payload)
      )
    } catch {
      unlisten?.()
      unlistenClosed?.()
    }
  })

  onBeforeUnmount(() => {
    stopped = true
    unlisten?.()
    unlistenClosed?.()
    unlistenReplaced?.()
    for (const controller of runs.values()) {
      controller.abort(new DOMException('Chat Playground geschlossen.', 'AbortError'))
    }
    for (const owner of new Set(runOwners.values())) void closeToolSessionsForOwner(owner).catch(() => undefined)
    runs.clear()
    runOwners.clear()
  })
}
