import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BackgroundModelPreparation,
  type BackgroundPreparationPolicy,
} from '@/services/inference/backgroundPreparation'
import type { PreparationScope } from '@/services/inference/scopedPreparationCache'

const scope: PreparationScope = {
  principalId: 'account',
  serverInstance: 'server',
  projectId: 'project',
  sessionId: 'renderer',
  generation: 1,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function fixture() {
  let policy: BackgroundPreparationPolicy = { active: true, fingerprint: 'signed-v1', expiresAt: 1_000_000 }
  const prepare = vi.fn(async (_scope: PreparationScope, _signal: AbortSignal) => ({ modelId: 'local-model' }))
  const manager = new BackgroundModelPreparation({ policy: () => policy, prepare })
  return { manager, prepare, setPolicy: (next: BackgroundPreparationPolicy) => (policy = next) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => vi.useRealTimers())

describe('background local model readiness', () => {
  it('allows the signed coordinator adapter to refresh an expired policy with retry backoff', async () => {
    const policy = { active: true, fingerprint: 'expired-signed', expiresAt: -1 }
    const prepare = vi.fn().mockRejectedValue(new Error('Policy refresh unavailable'))
    const manager = new BackgroundModelPreparation({ policy: () => policy, prepare, refreshExpiredPolicy: true })
    manager.update({ enabled: true, busy: false, scope })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(prepare).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(prepare).toHaveBeenCalledTimes(2)
    policy.active = false
    await vi.advanceTimersByTimeAsync(120_000)
    expect(prepare).toHaveBeenCalledTimes(2)
    manager.stop()
  })
  it('waits for a complete scope and active unexpired signed policy', async () => {
    const { manager, prepare, setPolicy } = fixture()
    manager.update({ enabled: true, busy: false, scope: null })
    expect(manager.snapshot()).toMatchObject({ phase: 'waiting', reason: 'scope_unavailable' })
    for (const policy of [
      { active: false, fingerprint: 'signed', expiresAt: 100_000 },
      { active: true, expiresAt: 100_000 },
      { active: true, fingerprint: 'expired', expiresAt: -1 },
    ]) {
      setPolicy(policy)
      manager.update({ enabled: true, busy: false, scope })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(manager.snapshot()).toMatchObject({ phase: 'waiting', reason: 'policy_unavailable' })
    }
    expect(prepare).not.toHaveBeenCalled()
    setPolicy({ active: true, fingerprint: 'signed-v2', expiresAt: 1_000_000 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(prepare).toHaveBeenCalledOnce()
    expect(manager.snapshot()).toEqual({ phase: 'ready', modelId: 'local-model' })
    manager.stop()
  })

  it('does not prepare again while the current resident readiness evidence is valid', async () => {
    const { manager, prepare, setPolicy } = fixture()
    setPolicy({ active: true, fingerprint: 'signed', expiresAt: 1_000_000, readyModelId: 'resident-model' })
    manager.update({ enabled: true, busy: false, scope })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(prepare).not.toHaveBeenCalled()
    expect(manager.snapshot()).toEqual({ phase: 'ready', modelId: 'resident-model' })
    setPolicy({ active: true, fingerprint: 'signed', expiresAt: 1_000_000 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(prepare).toHaveBeenCalledOnce()
    manager.stop()
  })

  it('deduplicates ongoing startup, even through repeated updates and polling', async () => {
    const { manager, prepare } = fixture()
    const pending = deferred<{ modelId: string }>()
    prepare.mockReturnValue(pending.promise)
    manager.update({ enabled: true, busy: false, scope })
    await vi.advanceTimersByTimeAsync(30_000)
    manager.update({ enabled: true, busy: false, scope })
    expect(prepare).toHaveBeenCalledOnce()
    pending.resolve({ modelId: 'local-model' })
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.snapshot().phase).toBe('ready')
    manager.stop()
  })

  it('backs off preparation failures and never starts during foreground work', async () => {
    const { manager, prepare } = fixture()
    prepare.mockRejectedValue(new Error('private native path must not leak'))
    manager.update({ enabled: true, busy: true, scope })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(prepare).not.toHaveBeenCalled()
    manager.update({ enabled: true, busy: false, scope })
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.snapshot()).toEqual({ phase: 'error', reason: 'preparation_failed' })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(prepare).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(prepare).toHaveBeenCalledTimes(2)
    manager.stop()
  })

  it('invalidates an old scope promptly but waits for native startup to settle before another one', async () => {
    const { manager, prepare } = fixture()
    const pending = deferred<{ modelId: string }>()
    prepare.mockReturnValueOnce(pending.promise)
    manager.update({ enabled: true, busy: false, scope })
    await vi.advanceTimersByTimeAsync(0)
    const oldSignal = prepare.mock.calls[0]![1]
    manager.update({ enabled: true, busy: false, scope: { ...scope, projectId: 'replacement' } })
    expect(oldSignal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(prepare).toHaveBeenCalledOnce()
    pending.resolve({ modelId: 'stale-model' })
    await vi.advanceTimersByTimeAsync(0)
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(prepare.mock.calls[1]![0].projectId).toBe('replacement')
    expect(manager.snapshot()).toEqual({ phase: 'ready', modelId: 'local-model' })
    manager.stop()
  })

  it('detects policy changes while starting and suppresses stale readiness', async () => {
    const { manager, prepare, setPolicy } = fixture()
    const pending = deferred<{ modelId: string }>()
    prepare.mockReturnValueOnce(pending.promise)
    manager.update({ enabled: true, busy: false, scope })
    await vi.advanceTimersByTimeAsync(0)
    setPolicy({ active: false })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(prepare.mock.calls[0]![1].aborted).toBe(true)
    pending.resolve({ modelId: 'stale' })
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.snapshot()).toEqual({ phase: 'waiting', reason: 'policy_unavailable' })
    expect(prepare).toHaveBeenCalledOnce()
    manager.stop()
  })

  it('stops on disable/shutdown and never publishes late startup output', async () => {
    const { manager, prepare } = fixture()
    const pending = deferred<{ modelId: string }>()
    const changes = vi.fn()
    manager.subscribe(changes)
    prepare.mockReturnValueOnce(pending.promise)
    manager.update({ enabled: true, busy: false, scope })
    await vi.advanceTimersByTimeAsync(0)
    manager.update({ enabled: false, busy: false, scope })
    expect(prepare.mock.calls[0]![1].aborted).toBe(true)
    manager.stop()
    pending.resolve({ modelId: 'late-model' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(manager.snapshot()).toEqual({ phase: 'stopped' })
    expect(changes.mock.calls.flat()).not.toContainEqual({ phase: 'ready', modelId: 'late-model' })
    expect(prepare).toHaveBeenCalledOnce()
  })
})
