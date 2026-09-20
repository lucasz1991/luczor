import { describe, expect, it, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
import { invoke } from '@tauri-apps/api/core'
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
    const chatA = gate.capture(undefined, { projectId: 'p', conversationId: 'chat-a', runId: 'run-a' }, 'act')
    const chatB = gate.capture(undefined, { projectId: 'p', conversationId: 'chat-b', runId: 'run-b' }, 'unrestricted')
    const chatC = gate.capture(undefined, { projectId: 'p', conversationId: 'chat-c', runId: 'run-c' })
    expect(chatA.mode).toBe('act')
    expect(() => gate.assert(chatA, true)).not.toThrow()
    expect(() => gate.assert(chatB, true)).not.toThrow()
    expect(() => gate.assert(chatC, true)).toThrow('Beobachten')
    expect(gate.effectiveMode(chatB)).toBe('unrestricted')
    expect(gate.effectiveMode(chatC)).toBe('observe')
    // Chat A switches to observe: only its run is revoked, chat B keeps working.
    expect(gate.invalidateScope({ conversationId: 'chat-a' }, 'execution_mode_changed')).toHaveLength(1)
    expect(chatA.signal.aborted).toBe(true)
    expect(chatB.signal.aborted).toBe(false)
    expect(() => gate.assert(chatB, true)).not.toThrow()
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
    const ticketA = gate.capture(undefined, {
      projectId: 'a',
      runId: 'a-1',
      conversationId: 'chat-a',
      workspaceBindingId: 'wa',
    })
    const ticketB = gate.capture(undefined, {
      projectId: 'b',
      runId: 'b-1',
      conversationId: 'chat-b',
      workspaceBindingId: 'wb',
    })
    expect(gate.invalidateScope({ projectId: 'a', workspaceBindingId: 'wa' })).toHaveLength(1)
    expect(ticketA.signal.aborted).toBe(true)
    expect(() => gate.assert(ticketA, true)).toThrow()
    expect(() => gate.assert(ticketB, true)).not.toThrow()
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
    const ticketA = gate.capture(undefined, { projectId: 'a', runId: 'run-a' })
    const ticketB = gate.capture(undefined, { projectId: 'a', runId: 'run-b' })
    gate.invalidateScope({ runId: 'run-a' })
    expect(ticketA.signal.aborted).toBe(true)
    expect(() => gate.assert(ticketB, true)).not.toThrow()
    const renewed = gate.capture(undefined, { projectId: 'a', runId: 'run-a' })
    expect(renewed.scopeGeneration).toBe(2)
    gate.invalidate()
    expect(ticketB.signal.aborted).toBe(true)
    expect(renewed.signal.aborted).toBe(true)
  })
})

describe('native execution synchronization recovery', () => {
  it('recovers a hung policy sync, rejects waiting work and never sends abandoned queued policies', async () => {
    vi.resetModules()
    const gate = await import('@/services/executionGate')
    let finishOld!: () => void
    const stuck = new Promise<void>(resolve => {
      finishOld = resolve
    })
    const native = vi.mocked(invoke).mockReset().mockResolvedValue(undefined)
    native.mockImplementationOnce(() => stuck)
    gate.updateExecutionControls({ mode: 'act', killSwitch: false, scope: 'account' })
    const ticket = gate.executionGate.capture()
    const waiting = gate.executionPayload(ticket).catch(error => error)
    await vi.waitFor(() => expect(native).toHaveBeenCalledOnce())
    expect(() => gate.recoverExecutionAfterStop({ nativeStopped: true })).toThrow('Not-Aus')
    gate.updateExecutionControls({ mode: 'act', killSwitch: true, scope: 'account' })
    expect(await waiting).toMatchObject({ name: 'AbortError' })
    const before = gate.executionGate.snapshot()
    gate.recoverExecutionAfterStop({ nativeStopped: true })
    const recovered = gate.executionGate.snapshot()
    expect(recovered).toEqual({ ...before, generation: before.generation + 1 })
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2))
    expect(native.mock.calls[1]).toEqual(['execution_gate_update', { payload: recovered }])
    await expect(gate.executionPayload()).rejects.toThrow('Not-Aus')
    gate.updateExecutionControls({ mode: 'act', killSwitch: false, scope: 'account' })
    await expect(gate.executionPayload()).resolves.toMatchObject({ generation: recovered.generation + 1 })
    const callCount = native.mock.calls.length
    finishOld()
    for (let index = 0; index < 12; index++) await Promise.resolve()
    expect(native).toHaveBeenCalledTimes(callCount)
    expect(ticket.signal.aborted).toBe(true)
  })

  it('cancels a hung scope registration and fences its late result while fresh scoped work resumes', async () => {
    vi.resetModules()
    const gate = await import('@/services/executionGate')
    const native = vi.mocked(invoke).mockReset().mockResolvedValue(undefined)
    gate.updateExecutionControls({ mode: 'observe', killSwitch: false, scope: 'account' })
    await gate.executionPayload(undefined, false)
    let finishOld!: () => void
    const stuck = new Promise<void>(resolve => {
      finishOld = resolve
    })
    native.mockImplementationOnce(() => stuck)
    const old = gate.executionGate.capture(undefined, { projectId: 'project', runId: 'old' }, 'act')
    const waiting = gate.executionPayload(old).catch(error => error)
    await vi.waitFor(() => expect(native.mock.calls.at(-1)?.[0]).toBe('execution_scope_register'))
    gate.invalidateExecutionScope({ runId: 'old' })
    expect(await waiting).toMatchObject({ name: 'AbortError' })
    gate.updateExecutionControls({ mode: 'observe', killSwitch: true, scope: 'account' })
    gate.recoverExecutionAfterStop({ nativeStopped: true })
    gate.updateExecutionControls({ mode: 'observe', killSwitch: false, scope: 'account' })
    const fresh = gate.executionGate.capture(undefined, { projectId: 'project', runId: 'fresh' }, 'act')
    await expect(gate.executionPayload(fresh)).resolves.toMatchObject({ scope: fresh.scope })
    await expect(gate.executionPayload()).rejects.toThrow('Beobachten')
    finishOld()
    for (let index = 0; index < 12; index++) await Promise.resolve()
    expect(native.mock.calls.filter(([command]) => command === 'execution_scope_revoke')).toHaveLength(0)
    expect(native.mock.calls.filter(([command]) => command === 'execution_scope_register')).toHaveLength(2)
    await expect(gate.executionPayload(fresh)).resolves.toMatchObject({ scope: fresh.scope })
    expect(native.mock.calls.filter(([command]) => command === 'execution_scope_register')).toHaveLength(2)
  })
})
