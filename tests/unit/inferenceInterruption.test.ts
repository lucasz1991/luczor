import { describe, expect, it } from 'vitest'
import {
  executionAbortReason,
  interruptionCode,
  interruptionMessage,
  unexpectedInferenceInterruption,
} from '@/services/inference/interruption'
import { ExecutionGate } from '@/services/executionGate'

describe('public interruption diagnostics', () => {
  it.each([
    [{ mode: 'act', killSwitch: false, scope: 'other' }, 'execution_scope_changed'],
    [{ mode: 'act', killSwitch: true, scope: 'project' }, 'execution_kill_switch'],
  ] as const)('retains the cause across a combined request signal', (controls, code) => {
    const gate = new ExecutionGate()
    gate.update({ mode: 'act', killSwitch: false, scope: 'project' })
    const ticket = gate.capture(new AbortController().signal)
    gate.update(controls)
    expect(ticket.signal.aborted).toBe(true)
    expect(interruptionCode(ticket.signal)).toBe(code)
    expect(interruptionMessage(ticket.signal)).not.toBe('Abgebrochen.')
  })

  it('reports a mode change only for the chat whose mode changed', () => {
    const gate = new ExecutionGate()
    gate.update({ mode: 'act', killSwitch: false, scope: 'project' })
    const scoped = gate.capture(
      new AbortController().signal,
      { projectId: 'p', conversationId: 'chat', runId: 'r' },
      'act'
    )
    const unscoped = gate.capture(new AbortController().signal)
    gate.update({ mode: 'observe', killSwitch: false, scope: 'project' })
    expect(scoped.signal.aborted).toBe(false)
    expect(unscoped.signal.aborted).toBe(false)
    gate.invalidateScope({ conversationId: 'chat' }, 'execution_mode_changed')
    expect(scoped.signal.aborted).toBe(true)
    expect(interruptionCode(scoped.signal)).toBe('execution_mode_changed')
    expect(interruptionMessage(scoped.signal)).toContain('Zugriffsmodus')
    expect(unscoped.signal.aborted).toBe(false)
  })

  it('distinguishes intentional stop, workspace revocation and reload', () => {
    const caller = new AbortController()
    caller.abort(executionAbortReason('user_stop'))
    expect(interruptionMessage(caller.signal)).toBe('Abgebrochen.')
    const gate = new ExecutionGate()
    const old = gate.capture()
    gate.invalidate('execution_workspace_changed')
    expect(interruptionMessage(old.signal)).toContain('Projektordner-Zuordnung')
    const current = gate.capture()
    gate.invalidate()
    expect(interruptionMessage(current.signal)).toContain('neu geladen')
  })

  it('never exposes arbitrary signal or transport error contents', () => {
    const controller = new AbortController()
    controller.abort(new Error('PRIVATE PROMPT'))
    expect(interruptionMessage(controller.signal)).not.toContain('PRIVATE')
    expect(unexpectedInferenceInterruption(new DOMException('PRIVATE', 'AbortError'))).toMatchObject({
      code: 'runtime_transport_interrupted',
    })
    expect(unexpectedInferenceInterruption(new DOMException('PRIVATE', 'TimeoutError'))).toMatchObject({
      code: 'runtime_timeout',
    })
    expect(JSON.stringify(unexpectedInferenceInterruption(new DOMException('PRIVATE', 'AbortError')))).not.toContain(
      'PRIVATE'
    )
    expect(unexpectedInferenceInterruption(new Error('ordinary'))).toBeNull()
  })
})
