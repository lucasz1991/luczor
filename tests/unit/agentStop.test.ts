import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentStopController } from '@/services/agentStop'

const receipt = { complete: true, processCount: 2, pendingCount: 0, errors: [] }
function fixture() {
  const deps = {
    begin: vi.fn(),
    drain: vi.fn(async () => undefined),
    stopNative: vi.fn(async () => receipt),
    recover: vi.fn(async () => undefined),
    resume: vi.fn(),
    drainMs: 10,
    nativeMs: 20,
    recoveryMs: 10,
  }
  return { deps, control: createAgentStopController(deps) }
}
afterEach(() => vi.useRealTimers())

describe('global agent stop', () => {
  it('closes admission immediately, deduplicates clicks and resumes only after explicit successful recovery', async () => {
    const { deps, control } = fixture()
    const stopping = control.stop()
    expect(deps.begin).toHaveBeenCalledOnce()
    expect(control.stop()).toBe(stopping)
    control.resume()
    expect(deps.resume).not.toHaveBeenCalled()
    expect(await stopping).toBe(true)
    expect(deps.stopNative).toHaveBeenCalledOnce()
    expect(deps.recover).toHaveBeenCalledOnce()
    expect(control.state.value.phase).toBe('stopped')
    expect(deps.resume).not.toHaveBeenCalled()
    control.resume()
    expect(deps.resume).toHaveBeenCalledOnce()
  })

  it('recovers an uncooperative JavaScript run only after native stop is confirmed', async () => {
    vi.useFakeTimers()
    const { deps, control } = fixture()
    deps.drain.mockImplementation(() => new Promise(() => {}))
    const stopping = control.stop()
    await vi.advanceTimersByTimeAsync(9)
    expect(deps.stopNative).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await stopping).toBe(true)
    expect(deps.recover).toHaveBeenCalledOnce()
  })

  it.each(['timeout', 'partial', 'rejected'] as const)(
    'retains admission closure when native cleanup is %s',
    async failure => {
      vi.useFakeTimers()
      const { deps, control } = fixture()
      if (failure === 'timeout') deps.stopNative.mockImplementation(() => new Promise(() => {}))
      if (failure === 'partial') deps.stopNative.mockResolvedValue({ ...receipt, complete: false, pendingCount: 1 })
      if (failure === 'rejected') deps.stopNative.mockRejectedValue(new Error('private detail'))
      const stopping = control.stop()
      await vi.advanceTimersByTimeAsync(30)
      expect(await stopping).toBe(false)
      expect(deps.recover).not.toHaveBeenCalled()
      control.resume()
      expect(deps.resume).not.toHaveBeenCalled()
      expect(control.state.value.message).not.toContain('private detail')
    }
  )

  it('does not claim a clean state when recovery persistence fails, and permits retry', async () => {
    const { deps, control } = fixture()
    deps.recover.mockRejectedValueOnce(new Error('storage unavailable'))
    expect(await control.stop()).toBe(false)
    expect(control.state.value.phase).toBe('failed')
    expect(await control.stop()).toBe(true)
  })
})
