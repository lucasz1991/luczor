import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  save: vi.fn(),
  resolvePrincipal: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: mocks.load } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/services/projectWorkspace', () => ({ resolveWorkspacePrincipalId: mocks.resolvePrincipal }))

const disk = new Map<string, unknown>()
const fixture = (title: string) => ({ steps: [{ title, status: 'pending' }], note: '', updatedAt: 1 })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.clearAllMocks()
  disk.clear()
  mocks.load.mockResolvedValue({ get: mocks.get, set: mocks.set, save: mocks.save })
  mocks.get.mockImplementation(async (key: string) => structuredClone(disk.get(key)))
  mocks.set.mockImplementation(async (key: string, value: unknown) => {
    disk.set(key, structuredClone(value))
  })
  mocks.save.mockResolvedValue(undefined)
  mocks.resolvePrincipal.mockResolvedValue('account-a')
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('principal-scoped model checklists', () => {
  it('starts closed and keeps the same project isolated across account changes', async () => {
    const plans = await import('@/services/plan')
    expect(plans.getPlan('shared').steps).toEqual([])
    expect(() => plans.setPlan('shared', ['unbound'])).toThrow('Kontoidentität')
    plans.bindPlanPrincipal('account-a')
    plans.setPlan('shared', ['Private A'])
    plans.bindPlanPrincipal(null)
    expect(plans.buildPlanContext('shared')).toBe('')
    plans.bindPlanPrincipal('account-b')
    expect(plans.getPlan('shared').steps).toEqual([])
    expect(plans.buildPlanContext('shared', 'account-a')).toBe('')
    expect(() => plans.setPlan('shared', ['late A'], undefined, 'account-a')).toThrow('Kontoidentität')
    expect(() => plans.clearPlan('shared', 'account-a')).toThrow('Kontoidentität')
    plans.setPlan('shared', ['Private B'])
    plans.bindPlanPrincipal('account-a')
    expect(plans.getPlan('shared').steps[0]?.title).toBe('Private A')
    plans.bindPlanPrincipal('account-b')
    expect(plans.getPlan('shared').steps[0]?.title).toBe('Private B')
  })

  it('leaves legacy records on disk without adopting or exposing them', async () => {
    const legacy = { shared: fixture('Unattributed old private plan') }
    disk.set('byProject', legacy)
    disk.set('byPrincipal', { 'account-b': { shared: fixture('B persisted') } })
    const plans = await import('@/services/plan')
    plans.bindPlanPrincipal('account-a')
    await plans.loadPlans()
    expect(plans.getPlan('shared').steps).toEqual([])
    plans.setPlan('shared', ['New verified A'])
    await vi.advanceTimersByTimeAsync(400)
    expect(disk.get('byProject')).toEqual(legacy)
    expect(mocks.get).not.toHaveBeenCalledWith('byProject')
    expect(mocks.set).not.toHaveBeenCalledWith('byProject', expect.anything())
    expect(disk.get('byPrincipal')).toMatchObject({
      'account-a': { shared: { steps: [{ title: 'New verified A' }] } },
      'account-b': { shared: fixture('B persisted') },
    })
  })

  it('cannot overwrite a new plan or resurrect a cleared plan when disk loading finishes late', async () => {
    const pending = deferred<unknown>()
    mocks.get.mockReturnValueOnce(pending.promise)
    const plans = await import('@/services/plan')
    plans.bindPlanPrincipal('account-a')
    const loading = plans.loadPlans()
    plans.setPlan('shared', ['New while loading'])
    plans.clearPlan('removed')
    pending.resolve({
      'account-a': { shared: fixture('Old disk'), removed: fixture('Deleted old'), other: fixture('Keep') },
    })
    await loading
    expect(plans.getPlan('shared').steps[0]?.title).toBe('New while loading')
    expect(plans.getPlan('removed').steps).toEqual([])
    expect(plans.getPlan('other').steps[0]?.title).toBe('Keep')
  })

  it('serializes immutable save snapshots so a delayed older save cannot win', async () => {
    const plans = await import('@/services/plan')
    plans.bindPlanPrincipal('account-a')
    await plans.loadPlans()
    const firstSave = deferred<void>()
    mocks.save.mockReturnValueOnce(firstSave.promise)
    plans.setPlan('shared', ['First'])
    await vi.advanceTimersByTimeAsync(400)
    expect(mocks.set).toHaveBeenCalledTimes(1)
    plans.setPlan('shared', ['Second'])
    await vi.advanceTimersByTimeAsync(400)
    expect(mocks.set).toHaveBeenCalledTimes(1)
    expect(mocks.set.mock.calls[0]?.[1]).toMatchObject({ 'account-a': { shared: { steps: [{ title: 'First' }] } } })
    firstSave.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.set).toHaveBeenCalledTimes(2)
    expect(disk.get('byPrincipal')).toMatchObject({ 'account-a': { shared: { steps: [{ title: 'Second' }] } } })
  })

  it('never replaces unseen stored accounts after a load failure and can retry later', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.get.mockRejectedValueOnce(new Error('Unavailable'))
    const plans = await import('@/services/plan')
    plans.bindPlanPrincipal('account-a')
    plans.setPlan('shared', ['A new'])
    await vi.advanceTimersByTimeAsync(400)
    expect(plans.planState.loaded).toBe(false)
    expect(mocks.set).not.toHaveBeenCalled()
    disk.set('byPrincipal', { 'account-b': { shared: fixture('B untouched') } })
    plans.setPlan('shared', ['A newer'])
    await vi.advanceTimersByTimeAsync(400)
    expect(disk.get('byPrincipal')).toMatchObject({ 'account-b': { shared: fixture('B untouched') } })
  })

  it('rejects delayed tool results after account changes and after execution revocation', async () => {
    const plans = await import('@/services/plan')
    const { planTools } = await import('@/services/tools/plans')
    const { executionGate } = await import('@/services/executionGate')
    const update = planTools.find(tool => tool.name === 'plan_update')!
    const read = planTools.find(tool => tool.name === 'plan_get')!
    plans.bindPlanPrincipal('account-a')
    plans.setPlan('shared', ['Private A'])
    const account = deferred<string>()
    mocks.resolvePrincipal.mockReturnValueOnce(account.promise)
    const pendingUpdate = update.execute({ steps: ['Late result'] }, { projectId: 'shared' })
    plans.bindPlanPrincipal('account-b')
    account.resolve('account-a')
    await expect(pendingUpdate).rejects.toThrow('Kontoidentität')
    expect(plans.getPlan('shared').steps).toEqual([])
    plans.bindPlanPrincipal('account-a')
    const cancelled = deferred<string>()
    mocks.resolvePrincipal.mockReturnValueOnce(cancelled.promise)
    const pendingRead = read.execute({}, { projectId: 'shared' })
    executionGate.invalidate()
    cancelled.resolve('account-a')
    await expect(pendingRead).rejects.toThrow('Ausführung verworfen')
    expect(plans.getPlan('shared').steps[0]?.title).toBe('Private A')
  })

  it('lets a current verified tool maintain the display-only normalized checklist', async () => {
    const plans = await import('@/services/plan')
    const { planTools } = await import('@/services/tools/plans')
    plans.bindPlanPrincipal('account-a')
    const update = planTools.find(tool => tool.name === 'plan_update')!
    expect(update.mutating).toBe(false)
    expect(update.requiresApproval).toBe(false)
    const result = await update.execute(
      {
        steps: [
          { title: 'First', status: 'in_progress' },
          { title: 'Second', status: 'in_progress' },
        ],
      },
      { projectId: 'shared' }
    )
    expect(result).toMatchObject({
      ok: true,
      current_step: 'First',
      steps: [{ status: 'in_progress' }, { status: 'pending' }],
    })
  })
})
