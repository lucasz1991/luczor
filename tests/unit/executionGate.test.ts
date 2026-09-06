import { describe, expect, it, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
import { ExecutionGate } from '@/services/executionGate'

describe('shared execution session', () => {
  it('blocks mutation in observe and revokes old tickets even when switching back to act', () => {
    const gate = new ExecutionGate()
    expect(() => gate.assert(gate.capture(), true)).toThrow('Beobachten')
    gate.update({ mode: 'act', killSwitch: false, scope: 'project-a' })
    const old = gate.capture()
    expect(() => gate.assert(old, true)).not.toThrow()
    gate.update({ mode: 'observe', killSwitch: false, scope: 'project-a' })
    gate.update({ mode: 'act', killSwitch: false, scope: 'project-a' })
    expect(old.signal.aborted).toBe(true)
    expect(() => gate.assert(old, true)).toThrow('Sitzung')
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
})
