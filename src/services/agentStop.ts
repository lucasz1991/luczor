import { shallowRef } from 'vue'

export type NativeAgentStopResult = {
  complete: boolean
  processCount: number
  pendingCount: number
  errors: string[]
}
export type AgentStopState = {
  phase: 'idle' | 'stopping' | 'stopped' | 'failed'
  message: string
}
type Dependencies = {
  begin(): void
  drain(): Promise<unknown>
  stopNative(): Promise<NativeAgentStopResult>
  recover(): Promise<void>
  resume(): void
  drainMs?: number
  nativeMs?: number
  recoveryMs?: number
}
type Outcome<T> = { ok: true; value: T } | { ok: false }

/** A deadline does not prove cancellation. Only the native receipt permits recovery. */
function bounded<T>(action: () => Promise<T>, milliseconds: number): Promise<Outcome<T>> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ ok: false }), milliseconds)
    void Promise.resolve()
      .then(action)
      .then(
        value => resolve({ ok: true, value }),
        () => resolve({ ok: false })
      )
      .finally(() => clearTimeout(timer))
  })
}

/** Shared by explicit app quit and the settings recovery action. */
export function createAgentStopController(deps: Dependencies) {
  const state = shallowRef<AgentStopState>({ phase: 'idle', message: '' })
  let pending: Promise<boolean> | undefined
  let resuming = false

  function stop(): Promise<boolean> {
    if (pending) return pending
    state.value = { phase: 'stopping', message: 'Agenten werden gestoppt und ihre Ressourcen freigegeben …' }
    let begun = true
    try {
      // Synchronous admission closure: no new work can overtake the cleanup.
      deps.begin()
    } catch {
      begun = false
    }
    pending = (async () => {
      await bounded(deps.drain, deps.drainMs ?? 1_200)
      const native = await bounded(deps.stopNative, deps.nativeMs ?? 6_000)
      if (!native.ok || !native.value.complete || !begun) {
        state.value = {
          phase: 'failed',
          message:
            'Nicht alle Ausführungen konnten sicher beendet werden. Not-Aus bleibt aktiv. Bereinigung erneut versuchen.',
        }
        return false
      }
      const recovered = await bounded(deps.recover, deps.recoveryMs ?? 1_800)
      if (!recovered.ok) {
        state.value = {
          phase: 'failed',
          message:
            'Die Prozesse sind gestoppt; der lokale Laufzustand konnte noch nicht vollständig gesichert werden. Bereinigung erneut versuchen.',
        }
        return false
      }
      state.value = {
        phase: 'stopped',
        message:
          'Luczors Agenten sind gestoppt und ihre Sperren freigegeben. Ziele bleiben pausiert; Not-Aus ist aktiv.',
      }
      return true
    })().finally(() => {
      pending = undefined
    })
    return pending
  }

  function resume(): void {
    if (pending || resuming || state.value.phase !== 'stopped') return
    resuming = true
    try {
      deps.resume()
    } catch {
      state.value = { phase: 'failed', message: 'Die Ausführung bleibt gesperrt. Bereinigung erneut versuchen.' }
      return
    } finally {
      resuming = false
    }
    state.value = { phase: 'idle', message: 'Neue Ausführungen sind wieder erlaubt. Pausierte Ziele bleiben pausiert.' }
  }
  return { state, stop, resume }
}
