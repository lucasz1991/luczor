import { describe, expect, it, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
import { ExecutionGate } from '@/services/executionGate'

describe('shared execution session', () => {
  it('blocks mutation in observe live without revoking scope-less tickets on a mode change', () => {
    const gate = new ExecutionGate()
    expect(() => gate.assert(gate.capture(), true)).toThrow('Beobachten')
    gate.update({ mode: 'act', killSwitch: false, scope: 'project-a' })
    const old = gate.capture()
    expect(() => gate.assert(old, true)).not.toThrow()
    expect(gate.update({ mode: 'observe', killSwitch: false, scope: 'project-a' })).toBe('mode')
    expect(old.signal.aborted).toBe(false)
    expect(() => gate.assert(old, true)).toThrow('Beobachten')
    expect(() => gate.assert(old, false)).not.toThrow()
    gate.update({ mode: 'act', killSwitch: false, scope: 'project-a' })
    expect(() => gate.assert(old, true)).not.toThrow()
    expect(gate.update({ mode: 'act', killSwitch: false, scope: 'project-b' })).toBe('invalidated')
    expect(old.signal.aborted).toBe(true)
    expect(() => gate.assert(old, true)).toThrow('Sitzung')
  })
  it('pins a mode per chat run so one chat changing its mode never touches another chat', () => {
    const gate = new ExecutionGate()
    gate.update({ mode: 'observe', killSwitch: false, scope: 'account' })
    const a = gate.capture(undefined, { projectId: 'p', conversationId: 'chat-a', runId: 'run-a' }, 'act')
    const b = gate.capture(undefined, { projectId: 'p', conversationId: 'chat-b', runId: 'run-b' }, 'unrestricted')
    const c = gate.capture(undefined, { projectId: 'p', conversationId: 'chat-c', runId: 'run-c' })
    expect(a.mode).toBe('act')
    expect(() => gate.assert(a, true)).not.toThrow()
    expect(() => gate.assert(b, true)).not.toThrow()
    expect(() => gate.assert(c, true)).toThrow('Beobachten')
    expect(gate.effectiveMode(b)).toBe('unrestricted')
    expect(gate.effectiveMode(c)).toBe('observe')
    // Chat A switches to observe: only its run is revoked, chat B keeps working.
    expect(gate.invalidateScope({ conversationId: 'chat-a' }, 'execution_mode_changed')).toHaveLength(1)
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    expect(() => gate.assert(b, true)).not.toThrow()
    const renewed = gate.capture(undefined, { projectId: 'p', conversationId: 'chat-a', runId: 'run-a' }, 'observe')
    expect(renewed.mode).toBe('observe')
    expect(() => gate.assert(renewed, true)).toThrow('Beobachten')
    // A running scope cannot be re-captured with another mode, and modes need a scope.
    expect(() => gate.capture(undefined, { projectId: 'p', runId: 'run-b', conversationId: 'chat-b' }, 'act')).toThrow(
      'Modus'
    )
    expect(() => gate.capture(undefined, undefined, 'act')).toThrow('Auftragszuordnung')
  })
  it('kills reads too and combines channel stop with account/project invalidation', () => {
    const gate = new ExecutionGate()
    gate.update({ mode: 'act', killSwitch: false, scope: 'project-a' })
    const channel = new AbortController()
    const ticket = gate.capture(channel.signal)
    channel.abort()
    expect(() => gate.assert(ticket)).toThrow()
    gate.update({ mode: 'act', killSwitch: true, scope: 'project-a' })
    expect(() => gate.assert(gate.capture())).toThrow('Not-Aus')
    gate.update({ mode: 'act', killSwitch: false, scope: 'project-a' })
    const read = gate.capture()
    gate.invalidate()
    expect(() => gate.assert(read)).toThrow()
  })
  it('does not invalidate a ticket when controls stay unchanged', () => {
    const gate = new ExecutionGate()
    gate.update({ mode: 'act', killSwitch: false, scope: 'project-a' })
    const ticket = gate.capture()
    gate.update({ mode: 'act', killSwitch: false, scope: 'project-a' })
    expect(() => gate.assert(ticket, true)).not.toThrow()
  })

  it('revokes a changed workspace without stopping another project or conversation', () => {
    const gate = new ExecutionGate()
    gate.update({ mode: 'act', killSwitch: false, scope: 'account-1' })
    const a = gate.capture(undefined, {
      projectId: 'a',
      runId: 'a-1',
      conversationId: 'chat-a',
      workspaceBindingId: 'wa',
    })
    const b = gate.capture(undefined, {
      projectId: 'b',
      runId: 'b-1',
      conversationId: 'chat-b',
      workspaceBindingId: 'wb',
    })
    expect(gate.invalidateScope({ projectId: 'a', workspaceBindingId: 'wa' })).toHaveLength(1)
    expect(a.signal.aborted).toBe(true)
    expect(() => gate.assert(a, true)).toThrow()
    expect(() => gate.assert(b, true)).not.toThrow()
  })

  it('keeps a run permanently bound to its originating conversation', () => {
    const gate = new ExecutionGate()
    gate.capture(undefined, { projectId: 'a', runId: 'run-1', conversationId: 'chat-a' })
    expect(() => gate.capture(undefined, { projectId: 'a', runId: 'run-1', conversationId: 'chat-b' })).toThrow(
      'Zuordnung'
    )
  })

  it('stopping one run leaves another in the same project valid while global stop revokes both', () => {
    const gate = new ExecutionGate()
    gate.update({ mode: 'act', killSwitch: false, scope: 'account-1' })
    const a = gate.capture(undefined, { projectId: 'a', runId: 'run-a' })
    const b = gate.capture(undefined, { projectId: 'a', runId: 'run-b' })
    gate.invalidateScope({ runId: 'run-a' })
    expect(a.signal.aborted).toBe(true)
    expect(() => gate.assert(b, true)).not.toThrow()
    const renewed = gate.capture(undefined, { projectId: 'a', runId: 'run-a' })
    expect(renewed.scopeGeneration).toBe(2)
    gate.invalidate()
    expect(b.signal.aborted).toBe(true)
    expect(renewed.signal.aborted).toBe(true)
  })
})
