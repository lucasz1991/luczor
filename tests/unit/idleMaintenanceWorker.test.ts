import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/state/types'
import type { MemoryRecord } from '@/services/memory/luczorMemory'
import { emptyMaintenanceJournal, type MaintenanceJournal } from '@/services/memory/maintenance'
import type { idleOptimizationDependencies } from '@/services/agents/idleOptimization'
import { memoryUsageEvents, resetMemoryUsage } from '@/services/memory/usage'
import { applyMemoryAnnotation, captureMemoryMetadata } from '@/services/memory/memoryMetadata'
const fixture = vi.hoisted(() => ({
  journal: null as MaintenanceJournal | null,
  writes: [] as string[],
  apply: vi.fn(),
  records: [] as MemoryRecord[],
  beforeUpdate: null as (() => Promise<void>) | null,
  afterUpdate: null as (() => Promise<void>) | null,
}))
vi.mock('@/services/executionGate', () => ({
  executionGate: { capture: () => ({ sessionId: 'session', generation: 1 }), assert: () => undefined },
}))
vi.mock('@/services/memory/luczorMemory', () => ({
  luczorMemory: {
    maintenanceSnapshot: async () => ({
      journal: structuredClone(fixture.journal),
      records: structuredClone(fixture.records),
    }),
    updateMaintenance: async (_id: string, update: (journal: MaintenanceJournal) => unknown) => {
      const before = fixture.beforeUpdate
      fixture.beforeUpdate = null
      await before?.()
      const result = update(fixture.journal!)
      const after = fixture.afterUpdate
      fixture.afterUpdate = null
      await after?.()
      return result
    },
    applyMaintenance: fixture.apply,
  },
}))
vi.mock('@/services/memory/maintenanceAdapters', () => ({
  memoryMaintenanceAdapters: [],
  writableMaintenanceAdapter: () => false,
}))
vi.mock('@/services/repositoryGraph', () => ({ inspectRepositoryGraph: async () => ({ files: [], total: 0 }) }))
import { createMaintenanceWorker, maintenanceProgress } from '@/services/agents/idleMaintenanceWorker'

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
  resetMemoryUsage()
  vi.useFakeTimers()
  fixture.journal = emptyMaintenanceJournal()
  fixture.writes = []
  fixture.records = []
  fixture.beforeUpdate = null
  fixture.afterUpdate = null
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
  it.each(['beforeUpdate', 'afterUpdate'] as const)(
    'fences a late %s transaction from replacing the recovered dream state',
    async checkpoint => {
      const { beginDreamRun, dreamTrace, resetDreamTraceForTests } = await import('@/services/memory/dreamTrace')
      resetDreamTraceForTests()
      const testCase = setup()
      let release!: () => void
      const blocked = new Promise<void>(resolve => {
        release = resolve
      })
      const entered = vi.fn(() => blocked)
      if (checkpoint === 'beforeUpdate') fixture.beforeUpdate = entered
      else fixture.afterUpdate = entered
      const worker = testCase.create()
      worker.start()
      worker.requestNow()
      await vi.advanceTimersByTimeAsync(2)
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
      const stopping = worker.stop()
      worker.recoverAfterStop()
      beginDreamRun({ jobKey: 'new-owner', task: 'context', scope: 'project', projectId: 'p1', sources: [] })
      const current = dreamTrace.value.current
      const progress = { ...maintenanceProgress.value, queued: 123 }
      maintenanceProgress.value = progress
      const journal = structuredClone(fixture.journal)
      release()
      await stopping
      expect(dreamTrace.value.current).toBe(current)
      expect(maintenanceProgress.value).toBe(progress)
      expect(fixture.journal).toEqual(journal)
      expect(testCase.stream).not.toHaveBeenCalled()
      expect(fixture.apply).not.toHaveBeenCalled()
      resetDreamTraceForTests()
    }
  )

  it.each(['beforeUpdate', 'afterUpdate'] as const)(
    'does not let late settled %s cleanup change a newer job',
    async checkpoint => {
      const { dreamTrace, resetDreamTraceForTests } = await import('@/services/memory/dreamTrace')
      resetDreamTraceForTests()
      const testCase = setup()
      let release!: () => void
      const blocked = new Promise<void>(resolve => {
        release = resolve
      })
      const entered = vi.fn(() => blocked)
      testCase.stream.mockImplementationOnce(async () => {
        if (checkpoint === 'beforeUpdate') fixture.beforeUpdate = entered
        else fixture.afterUpdate = entered
        throw new Error('runtime_generation_failed')
      })
      const worker = testCase.create()
      worker.start()
      worker.requestNow()
      await vi.advanceTimersByTimeAsync(2)
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
      const stopping = worker.stop()
      worker.recoverAfterStop()
      testCase.project.summary = 'Nur lesen. Neue bestätigte Quelle.'
      let releaseNew!: () => void
      const newBlocked = new Promise<void>(resolve => {
        releaseNew = resolve
      })
      const normalStream = testCase.stream.getMockImplementation()!
      testCase.stream.mockImplementationOnce(async request => {
        await newBlocked
        return normalStream(request)
      })
      worker.start()
      worker.requestNow()
      await vi.advanceTimersByTimeAsync(2)
      await vi.waitFor(() => expect(testCase.stream).toHaveBeenCalledTimes(2))
      const current = dreamTrace.value.current
      const progress = maintenanceProgress.value
      const journal = structuredClone(fixture.journal)
      release()
      await stopping
      expect(dreamTrace.value.current).toBe(current)
      expect(maintenanceProgress.value).toBe(progress)
      expect(fixture.journal).toEqual(journal)
      releaseNew()
      await vi.waitFor(() => expect(fixture.apply).toHaveBeenCalledOnce())
      await worker.stop()
      resetDreamTraceForTests()
    }
  )

  function candidate(): MemoryRecord {
    const record: MemoryRecord = {
      id: 'ai-candidate',
      principalId: 'owner',
      projectId: 'p1',
      scope: 'project',
      dataset: 'p1',
      content: 'Laravel könnte verwendet werden; nicht bestätigt.',
      contentHash: 'candidate-hash',
      source: 'assistant',
      writeIntent: 'inferred',
      status: 'candidate',
      sensitivity: 'normal',
      visibility: 'private',
      retention: 'durable',
      type: 'fact',
      confidence: 0.3,
      importance: 0.5,
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    }
    record.meta = { memory_metadata: captureMemoryMetadata(record) }
    return record
  }
  function classificationStream(approved = true) {
    return async (request: { messages: Array<{ content: string }> }) => ({
      content: request.messages[1]!.content.startsWith('Unabhängige Prüfung')
        ? JSON.stringify({
            approved,
            checkedSources: ['ai-candidate'],
            unsupportedFacts: !approved,
            lostFacts: false,
            lostConstraints: false,
            temporalConflict: false,
          })
        : JSON.stringify({
            kind: 'hypothesis',
            categories: [['Software', 'Laravel']],
            tags: ['Laravel'],
            importance: 0.6,
          }),
      toolCalls: [],
      rawToolCalls: [],
      finishReason: 'stop',
    })
  }

  it('annotates existing AI candidates by default after review without rewrite consent or provider improve', async () => {
    const testCase = setup()
    fixture.records = [candidate()]
    const original = structuredClone(fixture.records[0]!)
    testCase.stream.mockImplementation(classificationStream())
    testCase.deps.improve = vi.fn()
    fixture.apply.mockImplementation(async input => {
      await input.validate()
      expect(input.artifact).toBeUndefined()
      const record = fixture.records[0]!
      Object.assign(
        record,
        applyMemoryAnnotation(record, input.changes.operations[0].metadata, {
          origin: 'dream',
          now: 10,
          modelId: input.modelId,
        })
      )
      fixture.journal!.jobs.find(job => job.id === input.jobId)!.status = 'completed'
    })
    const optimizer = testCase.create()
    try {
      await run(optimizer)
      expect(testCase.stream).toHaveBeenCalledTimes(2)
      expect(fixture.apply).toHaveBeenCalledOnce()
      expect(fixture.apply.mock.calls[0]![0].jobId).toBe('metadata:p1:ai-candidate')
      const reviewPrompt = testCase.stream.mock.calls[1]![0].messages[1]!.content
      expect(JSON.parse(reviewPrompt.split('\nKLASSIFIKATION:\n')[1]!)).toEqual([
        {
          sourceId: 'ai-candidate',
          metadata: fixture.apply.mock.calls[0]![0].changes.operations[0].metadata,
        },
      ])
      expect(fixture.records[0]).toMatchObject({
        content: original.content,
        source: 'assistant',
        status: 'candidate',
        confidence: 0.3,
        tags: ['Laravel'],
      })
      expect(testCase.deps.improve).not.toHaveBeenCalled()
      expect(fixture.journal!.consent).toBeUndefined()
      expect(fixture.journal!.quality).toBeUndefined()
    } finally {
      optimizer.stop()
    }
  })

  it('respects metadata opt-out while ordinary context preparation remains available', async () => {
    const testCase = setup()
    fixture.records = [candidate()]
    fixture.journal!.consent = { automaticRewrite: false, installedModelStart: false, metadataAnnotations: false }
    const optimizer = testCase.create()
    try {
      await run(optimizer)
      expect(fixture.apply.mock.calls[0]![0].jobId).toBe('project:p1')
      expect(fixture.records[0]!.tags).toEqual([])
      expect(fixture.journal!.jobs.find(job => job.kind === 'metadata')?.status).toBe('pending')
    } finally {
      optimizer.stop()
    }
  })

  it.each(['generation', 'commit'] as const)(
    'keeps source retries unchanged when metadata is disabled during %s',
    async phase => {
      const testCase = setup()
      fixture.records = [candidate()]
      testCase.stream.mockImplementation(async request => {
        const response = await classificationStream()(request)
        if (phase === 'generation')
          fixture.journal!.consent = { automaticRewrite: false, installedModelStart: false, metadataAnnotations: false }
        return response
      })
      fixture.apply.mockImplementation(async () => {
        throw new Error('metadata_annotations_disabled')
      })
      const original = structuredClone(fixture.records)
      const optimizer = testCase.create()
      try {
        await run(optimizer)
        expect(fixture.journal!.jobs.find(job => job.kind === 'metadata')).toMatchObject({
          status: 'retry',
          attempts: 0,
        })
        expect(maintenanceProgress.value.stage).toBe('paused')
        expect(fixture.records).toEqual(original)
        expect(fixture.apply).toHaveBeenCalledTimes(phase === 'generation' ? 0 : 1)
      } finally {
        optimizer.stop()
      }
    }
  )

  it('rejects an unapproved metadata proposal without changing the independent rewrite quality gate', async () => {
    const testCase = setup()
    fixture.records = [candidate()]
    const original = structuredClone(fixture.records)
    fixture.journal!.quality = {
      policy: 'test',
      modelId: 'installed',
      passed: true,
      at: 1,
      reason: 'passed',
      catalogHash: 'signed',
    }
    testCase.stream.mockImplementation(classificationStream(false))
    const optimizer = testCase.create()
    try {
      await run(optimizer)
      expect(fixture.apply).not.toHaveBeenCalled()
      expect(fixture.records).toEqual(original)
      expect(fixture.journal!.jobs.find(job => job.kind === 'metadata')).toMatchObject({ status: 'retry', attempts: 1 })
      expect(fixture.journal!.quality.passed).toBe(true)
    } finally {
      optimizer.stop()
    }
  })
  it.each(['idle_model_busy', 'idle_model_cooldown', 'model_cooldown', 'resource_background_unavailable'])(
    'defers %s without burning source retries or closing the quality gate',
    async reason => {
      const testCase = setup()
      fixture.journal!.quality = {
        policy: 'test',
        passed: true,
        modelId: 'installed',
        at: Date.now(),
        reason: 'passed',
      }
      const quality = structuredClone(fixture.journal!.quality)
      testCase.deps.prepare = vi.fn(async () => {
        throw new Error(reason)
      })
      const optimizer = testCase.create()
      await run(optimizer)
      expect(optimizer.snapshot()).toMatchObject({ phase: 'paused', reason })
      expect(fixture.journal!.jobs.some(job => job.status === 'retry')).toBe(true)
      expect(fixture.journal!.jobs.every(job => job.attempts === 0)).toBe(true)
      expect(fixture.journal!.quality).toEqual(quality)
      expect(fixture.writes).toHaveLength(0)
      optimizer.stop()
    }
  )

  it('loads a missing local memory on request and binds and reviews all evidence before saving', async () => {
    const testCase = setup()
    testCase.stream.mockImplementation(async request => {
      const prompt = request.messages[1]!.content
      let content: string
      if (prompt.startsWith('Unabhängige Prüfung')) {
        content = JSON.stringify({
          approved: true,
          checkedSources: ['project:p1', 'redis'],
          unsupportedFacts: false,
          lostFacts: false,
          lostConstraints: false,
          temporalConflict: false,
        })
      } else if (!fixture.records.length) {
        fixture.records.push({
          id: 'redis',
          principalId: 'owner',
          projectId: 'p1',
          scope: 'project',
          dataset: 'p1',
          content: 'Redis: /projekte/luczor. Nur lesen.',
          contentHash: 'h',
          source: 'user',
          writeIntent: 'explicit',
          status: 'active',
          sensitivity: 'normal',
          visibility: 'private',
          retention: 'durable',
          type: 'fact',
          confidence: 1,
          importance: 0.5,
          tags: [],
          createdAt: 1,
          updatedAt: 1,
        })
        content = '{"request_context":{"query":"Redis","limit":2}}'
      } else {
        content = 'Elbe: Nur lesen. Redis: /projekte/luczor. Quellen project:p1 und redis.'
      }
      return { content, toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
    })
    const worker = testCase.create()
    try {
      await run(worker)
      expect(testCase.stream).toHaveBeenCalledTimes(3)
      expect(testCase.stream.mock.calls[1]![0].messages[1]!.content).toContain('/projekte/luczor')
      expect(testCase.stream.mock.calls[1]![0].messages[1]!.content).not.toContain('//projekte//luczor')
      expect(testCase.stream.mock.calls[2]![0].messages[1]!.content).toContain('/projekte/luczor')
      expect(fixture.writes).toHaveLength(1)
      expect(fixture.apply.mock.calls[0]![0].artifact.sources.map((source: { id: string }) => source.id)).toEqual([
        'project:p1',
        'redis',
      ])
      expect(fixture.apply.mock.calls[0]![0].sources).toHaveLength(2)
      expect(fixture.apply.mock.calls[0]![0].artifact.revision).not.toBe(fixture.apply.mock.calls[0]![0].revision)
      expect(memoryUsageEvents().find(item => item.origin === 'idle')).toMatchObject({ retrieved: 2, evaluated: 2 })
    } finally {
      await worker.stop()
    }
  })
  it('does not save a context request or loop indefinitely when a model keeps asking for more', async () => {
    const testCase = setup()
    testCase.stream.mockResolvedValue({
      content: '{"request_context":{"query":"missing","limit":1}}',
      toolCalls: [],
      rawToolCalls: [],
      finishReason: 'stop',
    })
    const worker = testCase.create()
    try {
      await run(worker)
      expect(testCase.stream).toHaveBeenCalledTimes(3)
      expect(fixture.writes).toEqual([])
      expect(fixture.journal!.jobs[0]?.status).toBe('retry')
    } finally {
      await worker.stop()
    }
  })
  it('continues partial LSP work on a later index pass without pretending the whole graph is ready', async () => {
    const testCase = setup()
    let scanned = 0
    testCase.deps.graphStatus = async () => ({
      status: 'ready',
      files: 714,
      symbols: 1000,
      edges: 10,
      skipped: 0,
      lsp: { status: 'partial', scanned, files: 714, edges: 4, reason: 'lsp_batch_limit' },
    })
    testCase.deps.graphIndex = vi.fn(async () => {
      scanned += 20
    })
    const worker = testCase.create()
    try {
      await run(worker)
      expect(testCase.deps.graphIndex).toHaveBeenCalledOnce()
      expect(maintenanceProgress.value.repository).toBe('Basisindex bereit · LSP 20/714 (partial)')
      await worker.stop()
      await vi.advanceTimersByTimeAsync(300_001)
      await run(worker)
      expect(testCase.deps.graphIndex).toHaveBeenCalledTimes(2)
      expect(maintenanceProgress.value.repository).toBe('Basisindex bereit · LSP 40/714 (partial)')
    } finally {
      await worker.stop()
    }
  })
  it('renews resident readiness even without cold-start consent before drafting and review', async () => {
    const testCase = setup()
    const worker = testCase.create()
    await run(worker)
    expect(testCase.deps.prepare).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), 'installed')
    expect(testCase.stream).toHaveBeenCalledTimes(2)
    expect(fixture.writes).toHaveLength(1)
    expect(memoryUsageEvents().find(item => item.origin === 'idle')).toMatchObject({ included: 1, evaluated: 1 })
    await worker.stop()
  })
  it('does not fall back to cold preparation if the resident disappears during renewal', async () => {
    const testCase = setup()
    vi.mocked(testCase.deps.prepare).mockRejectedValue(new Error('idle_model_not_ready'))
    const worker = testCase.create()
    await run(worker)
    expect(testCase.deps.prepare).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), 'installed')
    expect(testCase.stream).not.toHaveBeenCalled()
    expect(fixture.writes).toHaveLength(0)
    expect(memoryUsageEvents().find(item => item.origin === 'idle')).toMatchObject({ included: 0, evaluated: 0 })
    await worker.stop()
  })
  it('counts submitted evidence even when generation fails without claiming review or answer use', async () => {
    const testCase = setup()
    testCase.stream.mockImplementation(async () => {
      expect(memoryUsageEvents().find(item => item.origin === 'idle')).toMatchObject({ included: 1, evaluated: 0 })
      throw new Error('runtime_generation_failed')
    })
    const worker = testCase.create()
    await run(worker)
    expect(testCase.stream).toHaveBeenCalledOnce()
    expect(fixture.writes).toHaveLength(0)
    expect(memoryUsageEvents().find(item => item.origin === 'idle')).toMatchObject({ included: 1, evaluated: 0 })
    await worker.stop()
  })
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
  it('allows small work under RAM pressure with headroom, but refuses without swap or below the floor', async () => {
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
    expect(dreamTrace.value.history[0]?.steps.some(step => step.title === 'RAM-schonender Modus')).toBe(true)
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
