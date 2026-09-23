import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { shallowRef } from 'vue'

export type PlaygroundBinding = {
  sessionId: string
  projectId: string
  conversationId: string
  projectName: string
  workspaceName: string
  workspaceReady: boolean
  mode: 'observe' | 'act' | 'unrestricted'
  killSwitch: boolean
}

export async function openPlaygroundNative(payload: Omit<PlaygroundBinding, 'sessionId'>): Promise<PlaygroundBinding> {
  return invoke<PlaygroundBinding>('chat_playground_window_open', { payload })
}

export type PlaygroundAction =
  | { type: 'files_list'; path: string }
  | { type: 'files_read'; path: string }
  | { type: 'terminal_run'; runtime: 'node' | 'python'; code: string; timeoutSeconds: number }
  | { type: 'browser'; action: 'status' | 'open' | 'navigate' | 'close'; url?: string }
  | { type: 'bind_folder' }

type PlaygroundReply = { sessionId: string; requestId: string; result?: unknown; error?: string }
type PlaygroundNativeWindow = Window & { __LUCZOR_PLAYGROUND_NATIVE__?: boolean }

export const playgroundBinding = shallowRef<PlaygroundBinding | null>(null)
const pending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void; timer: number }>()
let unlistenReply: UnlistenFn | undefined
let unlistenState: UnlistenFn | undefined

export function isDetachedPlayground(): boolean {
  return (window as PlaygroundNativeWindow).__LUCZOR_PLAYGROUND_NATIVE__ === true
}

export async function initializePlaygroundNative(): Promise<PlaygroundBinding> {
  if (!unlistenReply) {
    unlistenReply = await listen<PlaygroundReply>('luczor://chat-playground-reply', event => {
      const reply = event.payload
      if (reply.sessionId !== playgroundBinding.value?.sessionId) return
      const waiting = pending.get(reply.requestId)
      if (!waiting) return
      clearTimeout(waiting.timer)
      pending.delete(reply.requestId)
      if (reply.error) waiting.reject(new Error(reply.error))
      else waiting.resolve(reply.result)
    })
  }
  if (!unlistenState) {
    unlistenState = await listen<PlaygroundBinding>('luczor://chat-playground-state', event => {
      setPlaygroundNativeBinding(event.payload)
    })
  }
  const binding = await invoke<PlaygroundBinding | null>('chat_playground_snapshot')
  if (!binding) throw new Error('Chat Playground ist nicht gebunden.')
  setPlaygroundNativeBinding(binding)
  return binding
}

export function setPlaygroundNativeBinding(binding: PlaygroundBinding): void {
  if (playgroundBinding.value && playgroundBinding.value.sessionId !== binding.sessionId) {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error('Das Chat Playground wurde an einen anderen Chat gebunden.'))
    }
    pending.clear()
  }
  playgroundBinding.value = binding
}

export async function requestPlaygroundAction<T = unknown>(action: PlaygroundAction): Promise<T> {
  const binding = playgroundBinding.value
  if (!binding) throw new Error('Das Chat Playground ist noch nicht mit einem Chat verbunden.')
  if (pending.size >= 12) throw new Error('Das Chat Playground verarbeitet bereits mehrere Aktionen.')
  const requestId = crypto.randomUUID()
  const result = new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('Das Hauptfenster hat nicht rechtzeitig geantwortet.'))
    }, 120_000)
    pending.set(requestId, { resolve: value => resolve(value as T), reject, timer })
  })
  try {
    await invoke('chat_playground_action', {
      payload: { sessionId: binding.sessionId, requestId, action },
    })
  } catch (error) {
    const waiting = pending.get(requestId)
    if (waiting) {
      clearTimeout(waiting.timer)
      pending.delete(requestId)
    }
    throw error
  }
  return result
}

export async function closePlaygroundNative(): Promise<void> {
  const binding = playgroundBinding.value
  if (!binding) return
  await invoke('chat_playground_window_close', { sessionId: binding.sessionId })
}

export function disposePlaygroundNative(): void {
  unlistenReply?.()
  unlistenState?.()
  unlistenReply = undefined
  unlistenState = undefined
  for (const waiting of pending.values()) {
    clearTimeout(waiting.timer)
    waiting.reject(new Error('Chat Playground geschlossen.'))
  }
  pending.clear()
  playgroundBinding.value = null
}
