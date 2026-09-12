import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

type QuitDependencies = {
  begin: () => void
  drain: () => Promise<void>
  save: () => Promise<void>
  commit?: (requestId: string) => Promise<void>
  failed?: (error: unknown) => void
}

/** Explicit tray quit only; hiding or navigating the window never invokes this. */
export function createGracefulQuit(deps: QuitDependencies) {
  let pending: Promise<void> | undefined
  return (payload: unknown): Promise<void> => {
    const requestId = payload && typeof payload === 'object' && 'requestId' in payload ? payload.requestId : undefined
    if (
      typeof requestId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(requestId)
    )
      return Promise.resolve()
    if (pending) return pending
    deps.begin()
    pending = (async () => {
      // Save immediately as well as after cancellation: native owns a bounded
      // fallback if a worker or renderer fails to acknowledge shutdown.
      const results = await Promise.allSettled([deps.save(), deps.drain()])
      await deps.save()
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      if (deps.commit) await deps.commit(requestId)
      else await invoke('app_quit_commit', { payload: { requestId } })
    })().catch(error => {
      deps.failed?.(error)
    })
    return pending
  }
}

export async function listenForGracefulQuit(handler: ReturnType<typeof createGracefulQuit>): Promise<UnlistenFn> {
  if (!isTauri()) return () => {}
  return listen('luczor://app-quit-request', event => {
    void handler(event.payload)
  })
}
