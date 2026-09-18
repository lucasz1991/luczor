import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/state/types'
import { emptyMaintenanceJournal, type MaintenanceJournal } from '@/services/memory/maintenance'
import type { idleOptimizationDependencies } from '@/services/agents/idleOptimization'
const fixture = vi.hoisted(() => ({
  journal: null as MaintenanceJournal | null,
  writes: [] as string[],
  apply: vi.fn(),
}))
vi.mock('@/services/executionGate', () => ({
  executionGate: { capture: () => ({ sessionId: 'session', generation: 1 }), assert: () => undefined },
}))
vi.mock('@/services/memory/luczorMemory', () => ({
  luczorMemory: {
    maintenanceSnapshot: async () => ({ journal: structuredClone(fixture.journal), records: [] }),
    updateMaintenance: async (_id: string, update: (journal: MaintenanceJournal) => unknown) =>
      update(fixture.journal!),
    applyMaintenance: fixture.apply,
  },
}))
vi.mock('@/services/memory/maintenanceAdapters', () => ({
  memoryMaintenanceAdapters: [],
  writableMaintenanceAdapter: () => false,
}))
vi.mock('@/services/repositoryGraph', () => ({ inspectRepositoryGraph: async () => ({ files: [], total: 0 }) }))
import { createMaintenanceWorker } from '@/services/agents/idleMaintenanceWorker'

function setup() {
  const project: Project = {
    id: 'p1',
    name: 'Elbe',
    summary: 'Nur lesen.',
    goals: [],
    defaults: { maxOutputTokens: 1000 },
    focus: { activeStepId: null, activeTodoId: null },
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
  const stream = vi.fn(async (request: { messages: Array<{ content: string }> }) => {
    const prompt = request.messages[1]!.content
    const content = prompt.startsWith('Unabhängige Prüfung')
      ? JSON.stringify({
          approved: true,
          checkedSources: ['project:p1'],
          unsupportedFacts: false,
          lostFacts: false,
          lostConstraints: false,
          temporalConflict: false,
        })
      : 'Elbe: Nur lesen. Quelle project:p1.'
    return { content, toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
  })
  const deps = {
    native: () => true,
    account: async () => ({ principalId: 'owner', serverInstance: 'server' }),
    policy: () => ({ mode: 'active', manifest: { payloadSha256: 'signed' }, appliedResourceRevision: 1 }),
    preferences: async () => ({ autoRemember: true }),
    status: vi.fn(async () => ({ operational: true, state: 'ready', modelId: 'installed' })),
    metrics: async () => ({ ram_total_mb: 16000, ram_used_mb: 4000, cpu_percent: 5 }),
    resources: { hasWork: () => false, runBackground: async (operation: () => Promise<string>) => operation() },
    gateway: async () => ({ target: 'local_llama_cpp', streamChatWithTools: stream }),
    prepare: vi.fn(async (_signal: AbortSignal) => 'installed'),
    graphStatus: async () => ({ status: 'unbound' }),
    improve: async () => 'not_scheduled',
  } as unknown as typeof idleOptimizationDependencies
  fixture.apply.mockImplementation(async input => {
    await input.validate()
    fixture.writes.push(input.artifact.content)
    fixture.journal!.jobs.find(job => job.id === input.jobId)!.status = 'completed'
  })
  const create = () =>
    createMaintenanceWorker({ project: () => project, projects: () => [project], busy: () => false }, deps, () => true)
  return { project, deps, stream, create }
}
beforeEach(() => {
  vi.useFakeTimers()
  fixture.journal = emptyMaintenanceJournal()
  fixture.writes = []
  fixture.apply.mockReset()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
async function run(optimizer: ReturnType<typeof createMaintenanceWorker>) {
  optimizer.start()
  optimizer.requestNow()
  await vi.advanceTimersByTimeAsync(2)
  await vi.waitFor(() => expect(['cooldown', 'paused']).toContain(optimizer.snapshot().phase))
}
describe('mounted persistent maintenance worker', () => {
  it('reviews separately, saves an artifact and does no inference for unchanged sources after restart', async () => {
    const testCase = setup()
    const first = testCase.create()
    await run(first)
    expect(testCase.stream).toHaveBeenCalledTimes(2)
    expect(fixture.writes).toHaveLength(1)
    await first.stop()
    const restarted = testCase.create()
    await run(restarted)
    expect(testCase.stream).toHaveBeenCalledTimes(2)
    await restarted.stop()
  })
  it('keeps dreaming on the page file under RAM pressure, but refuses without swap or below the floor', async () => {
    const { dreamTrace, resetDreamTraceForTests } = await import('@/services/memory/dreamTrace')
    const { idleEmergencyOffload } = await import('@/services/agents/idleOffloadSetting')
    resetDreamTraceForTests()
    const testCase = setup()
    // 2 GiB free of 16 GiB: below the 4 GiB reserve, above the 3 % floor, with a page file to lean on.
    testCase.deps.metrics = async () =>
      ({ ram_total_mb: 16000, ram_used_mb: 14000, swap_total_mb: 32000, swap_used_mb: 4000, cpu_percent: 5 }) as never
    const offloaded = testCase.create()
    await run(offloaded)
    expect(testCase.stream).toHaveBeenCalledTimes(2)
    expect(fixture.writes).toHaveLength(1)
    expect(dreamTrace.value.history[0]?.steps.some(step => step.title === 'Notfall-Auslagerung')).toBe(true)
    await offloaded.stop()

    fixture.journal = emptyMaintenanceJournal()
    testCase.stream.mockClear()
    testCase.deps.metrics = async () => ({ ram_total_mb: 16000, ram_used_mb: 14000, cpu_percent: 5 }) as never
    const noSwap = testCase.create()
    await run(noSwap)
    expect(noSwap.snapshot().reason).toBe('no_swap')
    expect(testCase.stream).not.toHaveBeenCalled()
    await noSwap.stop()

    testCase.deps.metrics = async () =>
      ({ ram_total_mb: 16000, ram_used_mb: 15700, swap_total_mb: 32000, swap_used_mb: 4000, cpu_percent: 5 }) as never
    const floor = testCase.create()
    await run(floor)
    expect(floor.snapshot().reason).toBe('memory_pressure')
    await floor.stop()

    idleEmergencyOffload.value = false
    testCase.deps.metrics = async () =>
      ({ ram_total_mb: 16000, ram_used_mb: 14000, swap_total_mb: 32000, swap_used_mb: 4000, cpu_percent: 5 }) as never
    const disabled = testCase.create()
    await run(disabled)
    expect(disabled.snapshot().reason).toBe('memory_pressure')
    await disabled.stop()
    idleEmergencyOffload.value = true
  })
  it('rejects a changed project revision before storing the generated artifact', async () => {
    const testCase = setup()
    const original = testCase.stream.getMockImplementation()!
    testCase.stream.mockImplementation(async request => {
      const response = await original(request)
      if (request.messages[1]!.content.startsWith('Unabhängige Prüfung'))
        testCase.project.summary = 'Nutzer hat geändert.'
      return response
    })
    const worker = testCase.create()
    await run(worker)
    expect(fixture.writes).toHaveLength(0)
    expect(fixture.journal!.jobs[0]?.status).toBe('retry')
    await worker.stop()
  })
  it('waits for native preparation to actually settle before granting foreground access', async () => {
    const testCase = setup()
    fixture.journal!.consent = { installedModelStart: true, automaticRewrite: false }
    vi.mocked(testCase.deps.status).mockResolvedValue({ operational: false, state: 'missing' } as never)
    let finish!: (model: string) => void
    vi.mocked(testCase.deps.prepare).mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const worker = testCase.create()
    worker.start()
    worker.requestNow()
    await vi.advanceTimersByTimeAsync(2)
    await vi.waitFor(() => expect(testCase.deps.prepare).toHaveBeenCalledTimes(1))
    let admitted = false
    const foreground = worker.acquireForeground().then(lease => {
      admitted = true
      return lease
    })
    await Promise.resolve()
    expect(admitted).toBe(false)
    finish('installed')
    const lease = await foreground
    expect(admitted).toBe(true)
    expect(testCase.stream).not.toHaveBeenCalled()
    expect(fixture.writes).toHaveLength(0)
    lease.release()
    await worker.stop()
  })
  it('closes an existing rewrite gate after a later independent context review fails', async () => {
    const testCase = setup()
    fixture.journal!.quality = {
      policy: 'luczor-maintenance-v1',
      modelId: 'installed',
      catalogHash: 'signed',
      passed: true,
      at: 1,
      reason: 'passed',
    }
    const original = testCase.stream.getMockImplementation()!
    testCase.stream.mockImplementation(async request => {
      const response = await original(request)
      if (request.messages[1]!.content.startsWith('Unabhängige Prüfung')) {
        const review = JSON.parse(response.content)
        response.content = JSON.stringify({ ...review, approved: false, lostConstraints: true })
      }
      return response
    })
    const worker = testCase.create()
    await run(worker)
    expect(fixture.writes).toHaveLength(0)
    expect(fixture.journal!.quality).toMatchObject({ passed: false, reason: 'review_failure' })
    await worker.stop()
  })
})
