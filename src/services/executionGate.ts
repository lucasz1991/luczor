import { invoke } from '@tauri-apps/api/core'
import type { LuczorMode } from '@/services/inference/types'
import { executionAbortReason, type ExecutionAbortCode } from '@/services/inference/interruption'

export type ExecutionControls = { mode: LuczorMode; killSwitch: boolean; scope: string }
export type ExecutionScope = Readonly<{
  projectId: string
  conversationId?: string
  runId?: string
  workspaceBindingId?: string
}>
export type ExecutionTicket = Readonly<{
  sessionId: string
  generation: number
  signal: AbortSignal
  scope?: ExecutionScope
  scopeGeneration?: number
}>
type ScopeState = { scope: ExecutionScope; generation: number; controller: AbortController }
function scopeKey(scope: ExecutionScope): string {
  return scope.runId ? `run:${scope.runId}` : JSON.stringify(scope)
}
function normalizedScope(scope: ExecutionScope): ExecutionScope {
  const result: Record<string, string> = {}
  for (const name of ['projectId', 'conversationId', 'runId', 'workspaceBindingId'] as const) {
    const value = scope[name]
    if (value === undefined && name !== 'projectId') continue
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f]/u.test(value))
      throw new Error('Ungültige Auftragszuordnung.')
    result[name] = value
  }
  return Object.freeze(result) as ExecutionScope
}

/** One revocable session shared by chat, teams and signed device/workflow jobs. */
export class ExecutionGate {
  private controls: ExecutionControls = { mode: 'observe', killSwitch: false, scope: '' }
  private generation = 1
  private controller = new AbortController()
  private scopes = new Map<string, ScopeState>()
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
    this.scopes.clear()
    this.controls = { ...controls }
    this.generation++
    return true
  }

  invalidate(code: ExecutionAbortCode = 'execution_session_changed'): void {
    this.controller.abort(executionAbortReason(code))
    this.controller = new AbortController()
    this.scopes.clear()
    this.generation++
  }

  capture(signal?: AbortSignal, requestedScope?: ExecutionScope): ExecutionTicket {
    const signals = [this.controller.signal, ...(signal ? [signal] : [])]
    let state: ScopeState | undefined
    if (requestedScope) {
      const scope = normalizedScope(requestedScope)
      const key = scopeKey(scope)
      state = this.scopes.get(key)
      if (state && JSON.stringify(state.scope) !== JSON.stringify(scope))
        throw new Error('Die Zuordnung eines laufenden Auftrags darf nicht geändert werden.')
      if (!state) {
        state = { scope, generation: 1, controller: new AbortController() }
        this.scopes.set(key, state)
      }
      signals.push(state.controller.signal)
    }
    return Object.freeze({
      sessionId: this.sessionId,
      generation: this.generation,
      signal: AbortSignal.any(signals),
      ...(state ? { scope: state.scope, scopeGeneration: state.generation } : {}),
    })
  }

  invalidateScope(match: Partial<ExecutionScope>, code: ExecutionAbortCode = 'execution_workspace_changed') {
    if (Object.keys(match).length === 0) throw new Error('Ein Auftrag oder Projekt muss angegeben werden.')
    const revoked: Omit<ExecutionTicket, 'signal'>[] = []
    for (const state of this.scopes.values()) {
      if (!Object.entries(match).every(([key, value]) => state.scope[key as keyof ExecutionScope] === value)) continue
      revoked.push({
        sessionId: this.sessionId,
        generation: this.generation,
        scope: state.scope,
        scopeGeneration: state.generation,
      })
      state.controller.abort(executionAbortReason(code))
      state.controller = new AbortController()
      state.generation++
    }
    return revoked
  }

  assert(ticket: ExecutionTicket, mutating = false): void {
    if (ticket.signal.aborted || ticket.sessionId !== this.sessionId || ticket.generation !== this.generation)
      throw new Error('Ausführung verworfen: Sitzung, Projekt oder Steuerungsmodus wurde geändert.')
    if (ticket.scope) {
      const current = this.scopes.get(scopeKey(ticket.scope))
      if (
        !current ||
        current.generation !== ticket.scopeGeneration ||
        JSON.stringify(current.scope) !== JSON.stringify(ticket.scope)
      )
        throw new Error('Ausführung verworfen: Die Auftragszuordnung wurde geändert.')
    }
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
const registeredScopes = new Set<string>()

function syncNativeGate(): void {
  registeredScopes.clear()
  const payload = executionGate.snapshot()
  nativeSync = nativeSync.catch(() => {}).then(() => invoke('execution_gate_update', { payload }))
  // Consumers still await the original rejection; avoid unhandled background promises.
  void nativeSync.catch(() => {})
}

/** Revoke only the matching work; UI navigation must never call global invalidation. */
export function invalidateExecutionScope(match: Partial<ExecutionScope>, reason?: ExecutionAbortCode): void {
  for (const payload of executionGate.invalidateScope(match, reason)) {
    nativeSync = nativeSync.catch(() => {}).then(() => invoke('execution_scope_revoke', { payload }))
    void nativeSync.catch(() => {})
  }
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
  const payload = {
    sessionId: ticket.sessionId,
    generation: ticket.generation,
    ...(ticket.scope ? { scope: ticket.scope, scopeGeneration: ticket.scopeGeneration } : {}),
  }
  if (ticket.scope) {
    const key = JSON.stringify(payload)
    if (!registeredScopes.has(key)) {
      nativeSync = nativeSync
        .catch(() => {})
        .then(async () => {
          executionGate.assert(ticket, mutating)
          await invoke('execution_scope_register', { payload })
          executionGate.assert(ticket, mutating)
          registeredScopes.add(key)
        })
      void nativeSync.catch(() => {})
      await nativeSync
    }
  }
  executionGate.assert(ticket, mutating)
  return payload
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
