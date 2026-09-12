import { invoke } from '@tauri-apps/api/core'
import type { LuczorMode } from '@/services/inference/types'
import { executionAbortReason, type ExecutionAbortCode } from '@/services/inference/interruption'

export type ExecutionControls = { mode: LuczorMode; killSwitch: boolean; scope: string }
export type ExecutionTicket = Readonly<{ sessionId: string; generation: number; signal: AbortSignal }>

/** One revocable session shared by chat, teams and signed device/workflow jobs. */
export class ExecutionGate {
  private controls: ExecutionControls = { mode: 'observe', killSwitch: false, scope: '' }
  private generation = 1
  private controller = new AbortController()
  readonly sessionId = crypto.randomUUID()

  update(controls: ExecutionControls): boolean {
    if (JSON.stringify(controls) === JSON.stringify(this.controls)) return false
    const code = controls.killSwitch
      ? 'execution_kill_switch'
      : controls.scope !== this.controls.scope
        ? 'execution_scope_changed'
        : 'execution_mode_changed'
    this.controller.abort(executionAbortReason(code))
    this.controller = new AbortController()
    this.controls = { ...controls }
    this.generation++
    return true
  }

  invalidate(code: ExecutionAbortCode = 'execution_session_changed'): void {
    this.controller.abort(executionAbortReason(code))
    this.controller = new AbortController()
    this.generation++
  }

  capture(signal?: AbortSignal): ExecutionTicket {
    return Object.freeze({
      sessionId: this.sessionId,
      generation: this.generation,
      signal: signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal,
    })
  }

  assert(ticket: ExecutionTicket, mutating = false): void {
    if (ticket.signal.aborted || ticket.sessionId !== this.sessionId || ticket.generation !== this.generation)
      throw new Error('Ausführung verworfen: Sitzung, Projekt oder Steuerungsmodus wurde geändert.')
    if (this.controls.killSwitch) throw new Error('Not-Aus aktiv: Ausführung gesperrt.')
    if (mutating && this.controls.mode === 'observe') throw new Error('Im Beobachten-Modus ist diese Aktion gesperrt.')
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      generation: this.generation,
      mode: this.controls.mode,
      killSwitch: this.controls.killSwitch,
    }
  }
}

export const executionGate = new ExecutionGate()
let nativeSync: Promise<unknown> = Promise.resolve()
let initialized = false
const invalidationListeners = new Set<() => void>()

function syncNativeGate(): void {
  const payload = executionGate.snapshot()
  nativeSync = nativeSync.catch(() => {}).then(() => invoke('execution_gate_update', { payload }))
  // Consumers still await the original rejection; avoid unhandled background promises.
  void nativeSync.catch(() => {})
}

export function updateExecutionControls(controls: ExecutionControls): void {
  // Establish generation 1 before queuing any later state.
  if (!initialized) {
    initialized = true
    syncNativeGate()
  }
  const changed = executionGate.update(controls)
  if (changed) invalidationListeners.forEach(listener => listener())
  if (changed) syncNativeGate()
}

export function invalidateExecution(reason?: unknown): void {
  if (!initialized) {
    initialized = true
    syncNativeGate()
  }
  executionGate.invalidate(reason === 'execution_workspace_changed' ? reason : 'execution_session_changed')
  invalidationListeners.forEach(listener => listener())
  syncNativeGate()
}

export function onExecutionInvalidated(listener: () => void): () => void {
  invalidationListeners.add(listener)
  return () => invalidationListeners.delete(listener)
}

export async function executionPayload(ticket = executionGate.capture(), mutating = true) {
  executionGate.assert(ticket, mutating)
  if (!initialized) {
    initialized = true
    syncNativeGate()
  }
  await nativeSync
  executionGate.assert(ticket, mutating)
  return { sessionId: ticket.sessionId, generation: ticket.generation }
}

/** Rechecks after every await; native code checks this token immediately before effects. */
export async function invokeGuarded<T>(
  command: string,
  payload: Record<string, unknown> = {},
  ticket = executionGate.capture(),
  mutating = true
): Promise<T> {
  const execution = await executionPayload(ticket, mutating)
  const result = await invoke<T>(command, { payload: { ...payload, execution } })
  executionGate.assert(ticket, mutating)
  return result
}
