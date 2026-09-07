import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  mounts: [] as Array<() => void | Promise<void>>,
  cleanups: [] as Array<() => void>,
  invalidations: new Set<() => void>(),
  storeChanges: new Map<string, () => void>(),
  settings: new Map<string, unknown>(),
  unlisten: vi.fn(),
  memoryObserved: true,
  generation: 1,
  build: vi.fn(),
  profile: vi.fn(),
  updateWarm: vi.fn(),
  stopWarm: vi.fn(),
  policy: vi.fn(),
  recoverPolicy: vi.fn(),
}))

vi.mock('vue', async importOriginal => ({
  ...(await importOriginal<typeof import('vue')>()),
  onMounted: (callback: () => void | Promise<void>) => fixture.mounts.push(callback),
  onBeforeUnmount: (callback: () => void) => fixture.cleanups.push(callback),
}))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async (file: string) => ({
      get: async (key: string) => fixture.settings.get(key),
      onChange: async (callback: () => void) => {
        if (file === 'luczor.memory.json' && !fixture.memoryObserved) throw new Error('No native notifications')
        fixture.storeChanges.set(file, callback)
        return fixture.unlisten
      },
    }),
  },
}))
vi.mock('@/services/accountPrincipal', () => ({
  getVerifiedAccountSnapshot: async () => ({ principalId: 'account', serverInstance: 'server' }),
}))
vi.mock('@/services/executionGate', () => ({
  executionGate: {
    capture: () => ({ sessionId: 'renderer', generation: fixture.generation, signal: new AbortController().signal }),
    assert: (ticket: { generation: number }) => {
      if (ticket.generation !== fixture.generation) throw new Error('Stale generation')
    },
  },
  onExecutionInvalidated: (listener: () => void) => {
    fixture.invalidations.add(listener)
    return () => fixture.invalidations.delete(listener)
  },
}))
vi.mock('@/services/assistantProfile', () => ({ refreshAssistantProfile: fixture.profile }))
vi.mock('@/services/memory/luczorMemory', () => ({
  getMemoryPrefs: async () => ({ inject: true, injectCount: 5 }),
}))
vi.mock('@/services/prompt/projectStartContext', () => ({ buildProjectStartContext: fixture.build }))
vi.mock('@/services/inference/localBackgroundPreparation', () => ({
  createLocalBackgroundPreparation: () => ({
    snapshot: () => ({ phase: 'disabled' }),
    subscribe: () => () => {},
    update: fixture.updateWarm,
    stop: fixture.stopWarm,
    invalidate: () => {},
  }),
  localBackgroundPreparationPolicy: fixture.policy,
  canRetryBackgroundPolicy: (policy: { mode?: string; reason?: string }) =>
    policy.mode === 'blocked' && policy.reason === 'server_unreachable',
  recoverLocalBackgroundPolicy: fixture.recoverPolicy,
}))

import { effectScope, nextTick, reactive } from 'vue'
import type { Project } from '@/state/types'
import { useBackgroundPreparation } from '@/composables/useBackgroundPreparation'

let cleanupEffects: (() => void) | undefined

async function setup(waitForContext = true) {
  const sources = reactive({
    project: {
      id: 'project',
      name: 'Project',
      summary: 'summary',
      goals: [],
      updatedAt: 1,
    } as unknown as Project,
    busy: false,
    draft: '',
  })
  const effects = effectScope()
  cleanupEffects = () => effects.stop()
  const api = effects.run(() =>
    useBackgroundPreparation({
      project: () => sources.project,
      workspace: () => null,
      busy: () => sources.busy,
      draft: () => sources.draft,
    })
  )!
  for (const mount of fixture.mounts) await mount()
  await vi.advanceTimersByTimeAsync(400)
  if (waitForContext) {
    await vi.waitFor(() => expect(fixture.build).toHaveBeenCalledOnce())
    await api.projectContext(sources.project, null, { inject: true, injectCount: 5 })
  }
  return { api, sources }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  vi.clearAllMocks()
  fixture.mounts.length = 0
  fixture.cleanups.length = 0
  fixture.invalidations.clear()
  fixture.storeChanges.clear()
  fixture.settings.clear()
  fixture.memoryObserved = true
  fixture.generation = 1
  fixture.build.mockImplementation(async () => ({ providerText: 'initial', sourceFragments: [] }))
  fixture.profile.mockResolvedValue({ revision: 'profile' })
  fixture.policy.mockReturnValue({ active: true, mode: 'active', fingerprint: 'policy' })
  fixture.recoverPolicy.mockResolvedValue({ ok: false, stale: false })
  vi.stubGlobal('window', new EventTarget())
})
afterEach(() => {
  for (const cleanup of fixture.cleanups) cleanup()
  cleanupEffects?.()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('main-window background preparation integration', () => {
  it('recovers a transient startup failure without needing the user to send a chat', async () => {
    fixture.policy.mockReturnValue({ active: false, mode: 'blocked', reason: 'server_unreachable' })
    fixture.recoverPolicy.mockImplementation(async () => {
      fixture.policy.mockReturnValue({ active: true, mode: 'active', fingerprint: 'recovered-policy' })
      return { ok: true, stale: false }
    })
    const { api } = await setup(false)
    expect(fixture.recoverPolicy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fixture.recoverPolicy).toHaveBeenCalledOnce()
    expect(api.policyStatus.value).toEqual({ phase: 'ready' })
    expect(fixture.updateWarm).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        scope: expect.objectContaining({ projectId: 'project' }),
      })
    )
  })

  it('backs off repeated startup failures and does not retry loading or rejected policies', async () => {
    fixture.policy.mockReturnValue({ active: false, mode: 'blocked', reason: 'server_unreachable' })
    const { api } = await setup(false)
    await vi.advanceTimersByTimeAsync(9_600)
    expect(fixture.recoverPolicy).toHaveBeenCalledOnce()
    expect(api.policyStatus.value).toEqual({ phase: 'failed', retryAt: 80_000 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fixture.recoverPolicy).toHaveBeenCalledTimes(2)
    expect(api.policyStatus.value).toEqual({ phase: 'failed', retryAt: 200_000 })
    fixture.policy.mockReturnValue({ active: false, mode: 'loading', reason: 'bootstrap_pending' })
    await vi.advanceTimersByTimeAsync(120_000)
    fixture.policy.mockReturnValue({ active: false, mode: 'blocked', reason: 'manifest_verification_failed' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fixture.recoverPolicy).toHaveBeenCalledTimes(2)
  })

  it('does not recover policies when model preparation is disabled', async () => {
    fixture.settings.set('background_model_preparation', false)
    fixture.policy.mockReturnValue({ active: false, mode: 'blocked', reason: 'server_unreachable' })
    await setup(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fixture.recoverPolicy).not.toHaveBeenCalled()
  })

  it.each(['unmount', 'generation'] as const)('does not adopt a late policy recovery after %s', async boundary => {
    let finish!: (result: { ok: boolean; stale: boolean }) => void
    fixture.policy.mockReturnValue({ active: false, mode: 'blocked', reason: 'server_unreachable' })
    fixture.recoverPolicy.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )
    const { api } = await setup(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fixture.recoverPolicy).toHaveBeenCalledOnce()
    if (boundary === 'unmount') api.stop()
    else {
      fixture.generation++
      for (const invalidate of fixture.invalidations) invalidate()
    }
    const priorCalls = fixture.updateWarm.mock.calls.length
    finish({ ok: true, stale: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.updateWarm).toHaveBeenCalledTimes(priorCalls)
    expect(fixture.build).not.toHaveBeenCalled()
  })
  it('keeps live settings available and bypasses memory caching when memory notifications fail', async () => {
    fixture.memoryObserved = false
    const { api, sources } = await setup()
    fixture.build.mockClear()
    await api.projectContext(sources.project, null, { inject: true, injectCount: 5 })
    await api.projectContext(sources.project, null, { inject: true, injectCount: 5 })
    expect(fixture.build).toHaveBeenCalledTimes(2)
    fixture.settings.set('background_context_preparation', false)
    fixture.storeChanges.get('luczor.settings.json')!()
    await vi.advanceTimersByTimeAsync(150)
    expect(api.contextEnabled.value).toBe(false)
  })
  it('prepares model readiness without inventing project context when no project is selected', async () => {
    const effects = effectScope()
    cleanupEffects = () => effects.stop()
    effects.run(() =>
      useBackgroundPreparation({
        project: () => undefined,
        workspace: () => null,
        busy: () => false,
        draft: () => '',
      })
    )
    for (const mount of fixture.mounts) await mount()
    await vi.advanceTimersByTimeAsync(500)
    expect(fixture.updateWarm).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        scope: expect.objectContaining({ projectId: '__luczor_background__' }),
      })
    )
    expect(fixture.build).not.toHaveBeenCalled()
  })
  it('warms by default and reuses sources despite message timestamps changing', async () => {
    const { api, sources } = await setup()
    expect(fixture.updateWarm).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        scope: expect.objectContaining({ principalId: 'account', projectId: 'project', sessionId: 'renderer' }),
      })
    )
    expect(fixture.profile).toHaveBeenCalledOnce()
    sources.project.updatedAt = 2
    sources.busy = true
    await nextTick()
    await expect(api.projectContext(sources.project, null, { inject: true, injectCount: 5 })).resolves.toEqual({
      providerText: 'initial',
      sourceFragments: [],
    })
    expect(fixture.build).toHaveBeenCalledOnce()
  })

  it('invalidates memory and project source changes before the next send', async () => {
    const { api, sources } = await setup()
    fixture.build.mockResolvedValue({ providerText: 'memory-revised', sourceFragments: [] })
    fixture.storeChanges.get('luczor.memory.json')!()
    await expect(api.projectContext(sources.project, null, { inject: true, injectCount: 5 })).resolves.toMatchObject({
      providerText: 'memory-revised',
    })
    expect(fixture.build).toHaveBeenCalledTimes(2)
    sources.project.summary = 'new scope facts'
    await nextTick()
    await api.projectContext(sources.project, null, { inject: true, injectCount: 5 })
    expect(fixture.build).toHaveBeenCalledTimes(3)
  })

  it('honors live settings and clears listeners and background work on unmount', async () => {
    const { api, sources } = await setup()
    fixture.settings.set('background_model_preparation', false)
    fixture.settings.set('background_context_preparation', false)
    fixture.storeChanges.get('luczor.settings.json')!()
    await vi.advanceTimersByTimeAsync(150)
    expect(api.modelEnabled.value).toBe(false)
    expect(api.contextEnabled.value).toBe(false)
    expect(fixture.updateWarm).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }))
    await api.projectContext(sources.project, null, { inject: true, injectCount: 5 })
    await api.projectContext(sources.project, null, { inject: true, injectCount: 5 })
    expect(fixture.build).toHaveBeenCalledTimes(3)
    api.stop()
    const calls = fixture.updateWarm.mock.calls.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fixture.updateWarm).toHaveBeenCalledTimes(calls)
    expect(fixture.unlisten).toHaveBeenCalledTimes(2)
    expect(fixture.stopWarm).toHaveBeenCalledOnce()
  })
})
