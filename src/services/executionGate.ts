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
  /** Mode pinned to this scope (a chat's own permission mode); scope-less tickets follow the device default. */
  mode?: LuczorMode
}>
type ScopeState = { scope: ExecutionScope; generation: number; controller: AbortController; mode?: LuczorMode }
function scopeKey(scope: ExecutionScope): string {
  return scope.runId ? `run:${scope.runId}` : JSON.stringify(scope)
}
function normalizedScope(scope: ExecutionScope): ExecutionScope {
  const result: Array<[string, string]> = []
  const fields = {
    projectId: scope.projectId,
    conversationId: scope.conversationId,
    runId: scope.runId,
    workspaceBindingId: scope.workspaceBindingId,
  }
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined && name !== 'projectId') continue
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f]/u.test(value))
      throw new Error('Ungültige Auftragszuordnung.')
    result.push([name, value])
  }
  return Object.freeze(Object.fromEntries(result)) as ExecutionScope
}

/** One revocable session shared by chat, teams and signed device/workflow jobs. */
export class ExecutionGate {
  private controls: ExecutionControls = { mode: 'observe', killSwitch: false, scope: '' }
  private generation = 1
  private controller = new AbortController()
  private scopes = new Map<string, ScopeState>()
  readonly sessionId = crypto.randomUUID()

  /**
   * Kill switch and account/project scope changes revoke every ticket. A change of the
   * device default mode alone applies live: scope-less work is re-checked on its next
   * mutation, while scoped work keeps the mode pinned at capture time. Chats therefore
   * switch or change their own mode without aborting each other.
   */
  update(controls: ExecutionControls): 'unchanged' | 'mode' | 'invalidated' {
    if (JSON.stringify(controls) === JSON.stringify(this.controls)) return 'unchanged'
    if (controls.killSwitch === this.controls.killSwitch && controls.scope === this.controls.scope) {
      this.controls = { ...controls }
      return 'mode'
    }
    const code = controls.killSwitch ? 'execution_kill_switch' : 'execution_scope_changed'
    this.controller.abort(executionAbortReason(code))
    this.controller = new AbortController()
    this.scopes.clear()
    this.controls = { ...controls }
    this.generation++
    return 'invalidated'
  }

  invalidate(code: ExecutionAbortCode = 'execution_session_changed'): void {
    this.controller.abort(executionAbortReason(code))
    this.controller = new AbortController()
    this.scopes.clear()
    this.generation++
  }

  capture(signal?: AbortSignal, requestedScope?: ExecutionScope, mode?: LuczorMode): ExecutionTicket {
    const signals = [this.controller.signal, ...(signal ? [signal] : [])]
    let state: ScopeState | undefined
    if (mode !== undefined && !requestedScope) throw new Error('Ein eigener Modus benötigt eine Auftragszuordnung.')
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
      if (mode !== undefined) {
        if (state.mode !== undefined && state.mode !== mode)
          throw new Error('Der Modus eines laufenden Auftrags darf nicht geändert werden.')
        state.mode = mode
      }
      signals.push(state.controller.signal)
    }
    return Object.freeze({
      sessionId: this.sessionId,
      generation: this.generation,
      signal: AbortSignal.any(signals),
      ...(state ? { scope: state.scope, scopeGeneration: state.generation } : {}),
      ...(state?.mode !== undefined ? { mode: state.mode } : {}),
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
        ...(state.mode !== undefined ? { mode: state.mode } : {}),
      })
      state.controller.abort(executionAbortReason(code))
      state.controller = new AbortController()
      state.generation++
      // The next capture for this scope pins the mode current at that time.
      delete state.mode
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
    if (mutating && this.effectiveMode(ticket) === 'observe')
      throw new Error('Im Beobachten-Modus ist diese Aktion gesperrt.')
  }

  /** The scope's pinned mode when present, otherwise the live device default. */
  effectiveMode(ticket?: Pick<ExecutionTicket, 'mode'>): LuczorMode {
    return ticket?.mode ?? this.controls.mode
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
let nativeSyncEpoch = 0
let initialized = false
const invalidationListeners = new Set<() => void>()
const registeredScopes = new Set<string>()

function queueNativeSync(operation: () => Promise<unknown>): Promise<unknown> {
  const epoch = nativeSyncEpoch
  nativeSync = nativeSync
    .catch(() => {})
    .then(() => {
      if (epoch !== nativeSyncEpoch) throw executionAbortReason('execution_session_changed')
      return operation()
    })
  // Consumers still await the original rejection; avoid unhandled background promises.
  void nativeSync.catch(() => {})
  return nativeSync
}

function awaitNativeSync(signal: AbortSignal): Promise<unknown> {
  const pending = nativeSync
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? executionAbortReason('execution_session_changed'))
    }
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    pending.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

function syncNativeGate(): void {
  registeredScopes.clear()
  const payload = executionGate.snapshot()
  queueNativeSync(() => invoke('execution_gate_update', { payload }))
}

/** Revoke only the matching work; UI navigation must never call global invalidation. */
export function invalidateExecutionScope(match: Partial<ExecutionScope>, reason?: ExecutionAbortCode): void {
  for (const payload of executionGate.invalidateScope(match, reason)) {
    queueNativeSync(() => invoke('execution_scope_revoke', { payload }))
  }
}

export function updateExecutionControls(controls: ExecutionControls): void {
  // Establish generation 1 before queuing any later state.
  if (!initialized) {
    initialized = true
    syncNativeGate()
  }
  const outcome = executionGate.update(controls)
  if (outcome === 'unchanged') return
  if (outcome === 'invalidated') {
    invalidationListeners.forEach(listener => listener())
    syncNativeGate()
    return
  }
  // Mode only: the native policy follows live; registered scopes and their pinned modes stay valid.
  const payload = executionGate.snapshot()
  queueNativeSync(() => invoke('execution_gate_update', { payload }))
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

/** Only after native workers have stopped may a hung transport queue be abandoned. */
export function recoverExecutionAfterStop(acknowledgement: { nativeStopped: true }): void {
  if (!acknowledgement.nativeStopped || !executionGate.snapshot().killSwitch)
    throw new Error('Die Wiederherstellung benötigt bestätigten Stopp und aktiven Not-Aus.')
  nativeSyncEpoch++
  nativeSync = Promise.resolve()
  initialized = true
  // Keep the current session, mode and kill switch; the higher generation also
  // prevents an already-sent stale native update from restoring an old policy.
  executionGate.invalidate('execution_kill_switch')
  invalidationListeners.forEach(listener => listener())
  syncNativeGate()
}

export async function executionPayload(ticket = executionGate.capture(), mutating = true) {
  executionGate.assert(ticket, mutating)
  if (!initialized) {
    initialized = true
    syncNativeGate()
  }
  await awaitNativeSync(ticket.signal)
  executionGate.assert(ticket, mutating)
  const payload = {
    sessionId: ticket.sessionId,
    generation: ticket.generation,
    ...(ticket.scope ? { scope: ticket.scope, scopeGeneration: ticket.scopeGeneration } : {}),
  }
  if (ticket.scope) {
    // The pinned mode is registered with the scope; the permit itself carries only identity.
    const registration = { ...payload, ...(ticket.mode !== undefined ? { mode: ticket.mode } : {}) }
    const key = JSON.stringify(registration)
    if (!registeredScopes.has(key)) {
      queueNativeSync(async () => {
        executionGate.assert(ticket, mutating)
        await invoke('execution_scope_register', { payload: registration })
        executionGate.assert(ticket, mutating)
        registeredScopes.add(key)
      })
      await awaitNativeSync(ticket.signal)
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
