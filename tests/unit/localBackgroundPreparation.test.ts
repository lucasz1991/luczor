import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dependencies = vi.hoisted(() => ({ status: vi.fn(), resolve: vi.fn(), recover: vi.fn() }))
vi.mock('@/services/inference/coordinator', () => ({
  localInferenceCoordinator: { status: dependencies.status },
  resolveInferenceRouteForTurn: dependencies.resolve,
  reinitializeLocalInferenceForCurrentApi: dependencies.recover,
}))

import {
  createLocalBackgroundPreparation,
  localBackgroundPreparationPolicy,
  canRetryBackgroundPolicy,
} from '@/services/inference/localBackgroundPreparation'

function status(ready = false) {
  return {
    mode: 'active',
    manifest: {
      payloadSha256: 'signed-hash',
      expiresAt: new Date(1_000_000).toISOString(),
      routing: { defaultModelId: 'primary', fallbackModelIds: ['fallback'] },
    },
    admissions: [
      { modelReleaseId: 'primary', enabled: true, executable: true, capacity: 'eligible', admissible: true, ready },
    ],
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.resetAllMocks()
  dependencies.status.mockReturnValue(status())
})
afterEach(() => vi.useRealTimers())

describe('local background preparation adapter', () => {
  it('prepares once after an applied resource change without waiting for the previous retry delay', async () => {
    const current = { ...status(), appliedResourceRevision: 1 }
    dependencies.status.mockReturnValue(current)
    dependencies.resolve.mockResolvedValue({
      gateway: { target: 'local_llama_cpp' },
      decision: { modelReleaseId: 'primary' },
    })
    const manager = createLocalBackgroundPreparation()
    const input = {
      enabled: true,
      busy: false,
      scope: { principalId: 'p', serverInstance: 's', projectId: 'project', sessionId: 'session', generation: 1 },
    }
    manager.update(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(dependencies.resolve).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5000)
    expect(dependencies.resolve).toHaveBeenCalledOnce()
    current.appliedResourceRevision = 2
    await vi.advanceTimersByTimeAsync(5000)
    expect(dependencies.resolve).toHaveBeenCalledTimes(2)
    current.admissions[0]!.ready = true
    await vi.advanceTimersByTimeAsync(15000)
    expect(dependencies.resolve).toHaveBeenCalledTimes(2)
    manager.stop()
  })

  it('retries only transient blocked bootstrap states, without overriding signed policy rejection', () => {
    expect(canRetryBackgroundPolicy({ active: false, mode: 'blocked', reason: 'server_unreachable' })).toBe(true)
    expect(canRetryBackgroundPolicy({ active: false, mode: 'loading', reason: 'bootstrap_pending' })).toBe(false)
    for (const reason of ['manifest_verification_failed', 'manifest_unavailable', 'account_verification_failed']) {
      expect(canRetryBackgroundPolicy({ active: false, mode: 'blocked', reason })).toBe(false)
    }
  })

  it('passes the saved Flash preference through while retaining the signed fallback and capacity policy', async () => {
    const stream = vi.fn()
    dependencies.resolve.mockResolvedValue({
      gateway: { target: 'local_llama_cpp', streamChatWithTools: stream },
      decision: { modelReleaseId: 'fallback' },
    })
    const manager = createLocalBackgroundPreparation(() => ({ experimentalFlashNext: true }))
    manager.update({
      enabled: true,
      busy: false,
      scope: { principalId: 'p', serverInstance: 's', projectId: 'project', sessionId: 'session', generation: 1 },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(dependencies.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        routingSettings: { preference: 'local_only', experimentalFlashNext: true, allowDegradedLocal: false },
      })
    )
    expect(manager.snapshot()).toEqual({ phase: 'ready', modelId: 'fallback' })
    expect(stream).not.toHaveBeenCalled()
    manager.stop()
  })
  it('resolves only the signed local route and never invokes its model gateway', async () => {
    const stream = vi.fn()
    dependencies.resolve.mockResolvedValue({
      gateway: { target: 'local_llama_cpp', streamChatWithTools: stream },
      decision: { modelReleaseId: 'primary' },
    })
    const manager = createLocalBackgroundPreparation()
    manager.update({
      enabled: true,
      busy: false,
      scope: { principalId: 'p', serverInstance: 's', projectId: 'project', sessionId: 'session', generation: 1 },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(dependencies.resolve).toHaveBeenCalledWith({
      projectId: 'project',
      contextId: 'session',
      taskType: 'chat.general',
      contextEgress: 'local_only',
      routingSettings: { preference: 'local_only', experimentalFlashNext: false, allowDegradedLocal: false },
    })
    expect(stream).not.toHaveBeenCalled()
    expect(manager.snapshot()).toEqual({ phase: 'ready', modelId: 'primary' })
    manager.stop()
  })

  it('uses fresh admission evidence only for enabled, eligible standard/fallback models', () => {
    const current = status(true)
    dependencies.status.mockReturnValue(current)
    expect(localBackgroundPreparationPolicy().readyModelId).toBe('primary')
    current.admissions[0]!.enabled = false
    expect(localBackgroundPreparationPolicy().readyModelId).toBeUndefined()
    current.admissions[0]!.enabled = true
    current.admissions[0]!.capacity = 'degraded'
    expect(localBackgroundPreparationPolicy().readyModelId).toBeUndefined()
    current.admissions[0]!.capacity = 'eligible'
    current.admissions[0]!.admissible = false
    expect(localBackgroundPreparationPolicy().readyModelId).toBeUndefined()
  })
})
