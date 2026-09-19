import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/state/types'
import type { MemoryRecord } from '@/services/memory/luczorMemory'
import type { LocalModelStatusView } from '@/services/localModelStatus'
import type { InferenceGateway, InferenceRequest, InferenceResult } from '@/services/inference/types'
import type { SystemMetrics } from '@/services/systemMetrics'
import { executionGate } from '@/services/executionGate'
import { LocalResourceController, DEFAULT_LOCAL_RESOURCE_CONFIG } from '@/services/inference/resources'
import { LocalModelManager, type LocalRuntimeTransport } from '@/services/inference/localModelManager'
import { verifyLocalModelManifest } from '@/services/inference/modelManifest'

const stored = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: vi.fn(async () => stored) } }))

import {
  createLegacyIdleOptimization as createIdleOptimization,
  idleOptimizationDependencies,
  idleOptimizationEnabled,
  loadIdleOptimizationSetting,
  saveIdleOptimizationSetting,
  IDLE_OPTIMIZATION_KEY,
} from '@/services/agents/idleOptimization'

function deferred<T>() {
  let complete!: (result: T) => void
  const promise = new Promise<T>(done => {
    complete = done
  })
  return { promise, complete }
}

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'memory-1',
    principalId: 'account-1',
    scope: 'project',
    dataset: 'project-1',
    content: 'A previously confirmed source fact.',
    contentHash: 'hash-1',
    type: 'note',
    visibility: 'private',
    status: 'active',
    retention: 'durable',
    sensitivity: 'normal',
    writeIntent: 'confirmed',
    importance: 0.5,
    priority: 'normal',
    confidence: 0.9,
    source: 'user',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const response: InferenceResult = {
  content: 'Die gespeicherten Angaben können klarer zusammengefasst werden.',
  toolCalls: [],
  rawToolCalls: [],
  finishReason: 'stop',
}

function fixture() {
  let busy = false
  let project: Project | undefined = {
    id: 'project-1',
    name: 'Project source',
    summary: 'The verified project summary.',
    goals: [],
    defaults: { maxOutputTokens: 512 },
    focus: { activeTodoId: null, activeStepId: null },
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
  const state = {
    requested: { ...DEFAULT_LOCAL_RESOURCE_CONFIG },
    applied: { ...DEFAULT_LOCAL_RESOURCE_CONFIG },
    revision: 1,
    appliedRevision: 1,
    pending: false,
    reasonCode: null,
  }
  const nativeBegin = vi.fn(async (leaseId: string) => ({ leaseId, resourceRevision: 1 }))
  const nativeEnd = vi.fn(async () => undefined)
  const resources = new LocalResourceController({
    enabled: () => true,
    get: async () => state,
    set: async () => state,
    apply: async () => state,
    begin: nativeBegin,
    end: nativeEnd,
  })
  const account = {
    principalId: 'account-1',
    serverInstance: 'server-1',
    serverOrigin: 'https://example.test',
    accountId: 1,
    config: { baseUrl: 'https://example.test', deviceKey: 'fixture-key', clientId: 'device-1' },
  }
  const policy = {
    mode: 'active',
    manifest: { payloadSha256: 'catalog-1' },
    appliedResourceRevision: 1,
  } as ReturnType<typeof idleOptimizationDependencies.policy>
  const status: LocalModelStatusView = {
    state: 'ready',
    label: 'Ready',
    detail: 'Verified fixture',
    modelName: 'Local model',
    modelId: 'local-1',
    prepared: true,
    operational: true,
    checks: [],
    checkedAtMs: Date.now(),
    resourceConfig: state,
  }
  const metrics: SystemMetrics = {
    cpu_percent: 10,
    ram_percent: 50,
    ram_used_mb: 16_384,
    ram_total_mb: 32_768,
    gpu_percent: 0,
    cpu_temp_c: null,
    gpu_temp_c: null,
  }
  const preferences = { autoRemember: true, inject: true, injectCount: 5 }
  const stream = vi.fn(async (_request: InferenceRequest) => ({ ...response }))
  const localGateway: InferenceGateway = { id: 'resident-only', target: 'local_llama_cpp', streamChatWithTools: stream }
  const recall = vi.fn<typeof idleOptimizationDependencies.recall>(async () => [memory()])
  const remember = vi.fn<typeof idleOptimizationDependencies.remember>(async () => memory({ status: 'active' }))
  const deps: typeof idleOptimizationDependencies = {
    prepare: vi.fn(async () => 'local-1'),
    refreshPolicy: vi.fn(async () => undefined),
    native: () => true,
    account: vi.fn(async () => account),
    preferences: vi.fn(async () => preferences),
    status: vi.fn(async () => status),
    metrics: vi.fn(async () => metrics),
    policy: () => policy,
    gateway: vi.fn(async () => localGateway),
    recall,
    candidates: vi.fn(async () => []),
    sharedRecall: vi.fn(async () => []),
    improve: vi.fn(async () => 'not_scheduled' as const),
    graphStatus: vi.fn(async () => ({ status: 'unbound' as const, files: 0, symbols: 0, edges: 0, skipped: 0 })),
    graphIndex: vi.fn(async () => undefined),
    graphSearch: vi.fn(async () => ({ repository_id: 'repo-1', hits: [] })),
    graphSnippets: vi.fn(async () => ({ snippets: [], omitted: [] })),
    remember,
    resources,
  }
  const optimizer = createIdleOptimization({ project: () => project, busy: () => busy }, deps)
  resources.setForegroundAdmission(signal => optimizer.acquireForeground(signal))
  return {
    optimizer,
    deps,
    stream,
    recall,
    remember,
    status,
    metrics,
    preferences,
    account,
    policy,
    resources,
    nativeBegin,
    nativeEnd,
    localGateway,
    setBusy: (value: boolean) => {
      busy = value
    },
    setProject: (value: Project | undefined) => {
      project = value
    },
    project,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-30T12:30:00Z'))
  vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  // Keep the real SHA-256 semantics without work escaping the deterministic timer/microtask queue.
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_algorithm, source) => {
    const bytes =
      source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer
  })
  idleOptimizationEnabled.value = true
  executionGate.update({ mode: 'observe', killSwitch: false, scope: 'idle-test' })
  stored.get.mockReset()
  stored.set.mockReset()
  stored.save.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('idle optimization integration', () => {
  it('consolidates bounded user chat observations locally with source IDs, without reusing assistant guesses', async () => {
    const harness = fixture()
    vi.mocked(harness.deps.candidates).mockResolvedValue([
      memory({ id: 'chat-user', status: 'candidate', content: 'Bitte nutze kurze Antworten im Projekt.' }),
      memory({ id: 'chat-ai', status: 'candidate', source: 'assistant', content: 'Unsupported assistant guess' }),
      memory({ id: 'secret', status: 'candidate', sensitivity: 'secret', content: 'Excluded secret' }),
    ])
    harness.optimizer.start()
    await vi.advanceTimersByTimeAsync(600_000)
    const prompt = JSON.stringify(harness.stream.mock.calls[0]?.[0].messages)
    expect(prompt).toContain('Bitte nutze kurze Antworten')
    expect(prompt).toContain('candidate')
    expect(prompt).not.toMatch(/Unsupported assistant guess|Excluded secret/)
    expect(harness.remember.mock.calls[0]?.[0]).toMatchObject({
      writeIntent: 'system',
      retention: 'durable',
      visibility: 'private',
      provenance: { source_memory_ids: ['chat-user', 'memory-1'] },
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.deps.candidates).toHaveBeenCalledOnce()
    expect(JSON.stringify(harness.stream.mock.calls[1]?.[0].messages)).not.toContain('Bitte nutze kurze Antworten')
    await harness.optimizer.stop()
  })

  it('includes canonical SQL/Cognee evidence and schedules scoped maintenance without uploading private AI content', async () => {
    const harness = fixture()
    vi.mocked(harness.deps.sharedRecall).mockResolvedValue([
      memory({ id: 'server-7', source: 'cognee_revalidated', content: 'Canonical server decision' }),
    ])
    harness.optimizer.start()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(JSON.stringify(harness.stream.mock.calls[0]?.[0].messages)).toContain('Canonical server decision')
    expect(harness.deps.improve).toHaveBeenCalledWith('project', {
      projectId: 'project-1',
      expectedPrincipalId: 'account-1',
      signal: expect.any(AbortSignal),
    })
    expect(harness.remember.mock.calls[0]?.[0].visibility).toBe('private')
    await harness.optimizer.stop()
  })

  it('updates and analyzes a bound repository after both memory scopes and keeps its proposal private', async () => {
    const harness = fixture()
    vi.mocked(harness.deps.graphStatus).mockResolvedValue({
      status: 'ready',
      files: 1,
      symbols: 1,
      edges: 0,
      skipped: 0,
    })
    vi.mocked(harness.deps.graphSnippets).mockResolvedValue({
      omitted: [],
      snippets: [
        {
          evidence_id: 'e-1',
          relative_path: 'src/example.ts',
          content: 'class Example {}',
          content_hash: 'hash-1',
          start_line: 1,
          end_line: 1,
          redactions: 0,
        },
      ],
    })
    harness.optimizer.start()
    await vi.advanceTimersByTimeAsync(602_000)
    expect(harness.deps.graphIndex).toHaveBeenCalledWith('account-1', 'project-1', expect.any(AbortSignal))
    expect(harness.stream).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(harness.stream.mock.calls[2]?.[0].messages)).toContain('class Example')
    expect(harness.remember.mock.calls[2]?.[0]).toMatchObject({
      visibility: 'private',
      provenance: { repository_local_only: true },
    })
    expect(harness.deps.improve).toHaveBeenCalledTimes(2)
    await harness.optimizer.stop()
  })

  it('uses bounded local context and automatically stores private, durable, account-bound AI memories', async () => {
    const harness = fixture()
    harness.recall.mockResolvedValue([
      memory(),
      memory({ id: 'unconfirmed', status: 'candidate', content: 'Never treat candidate as fact' }),
      memory({ id: 'secret', sensitivity: 'secret', content: 'Never send secret' }),
      memory({ id: 'generated', tags: ['idle-optimization'], content: 'Never recursively optimize own output' }),
    ])
    harness.optimizer.start()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(harness.recall).toHaveBeenCalledWith({ query: '', scope: 'project', projectId: 'project-1', limit: 12 })
    const request = harness.stream.mock.calls[0]?.[0]
    expect(request).toMatchObject({ taskType: 'context.optimize', tools: [], toolChoice: 'none' })
    expect(JSON.stringify(request?.messages)).toContain('previously confirmed')
    expect(JSON.stringify(request?.messages)).not.toMatch(/Never treat|Never send|Never recursively/)
    expect(harness.remember).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPrincipalId: 'account-1',
        projectId: 'project-1',
        scope: 'project',
        source: 'assistant',
        writeIntent: 'system',
        visibility: 'private',
        retention: 'durable',
        confidence: 0.35,
        type: 'context_optimization',
        tags: ['idle-optimization'],
        provenance: {
          source_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          source_memory_ids: ['memory-1'],
          generated_locally: true,
        },
      })
    )
    expect(harness.project?.summary).toBe('The verified project summary.')
    expect(harness.nativeBegin).toHaveBeenCalledTimes(1)
    expect(harness.nativeEnd).toHaveBeenCalledTimes(1)
    await harness.optimizer.stop()
  })

  it('alternates project and user memory without adding project context to the user run, then deduplicates', async () => {
    const harness = fixture()
    harness.optimizer.start()
    await vi.advanceTimersByTimeAsync(600_000)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(harness.recall.mock.calls[1]?.[0]).toMatchObject({ scope: 'user', projectId: undefined })
    expect(JSON.stringify(harness.stream.mock.calls[1]?.[0].messages)).not.toContain('verified project summary')
    expect(harness.remember.mock.calls[1]?.[0]).toMatchObject({ scope: 'user', projectId: undefined })
    await vi.advanceTimersByTimeAsync(240_000)
    expect(harness.stream).toHaveBeenCalledTimes(2)
    expect(harness.remember).toHaveBeenCalledTimes(2)
    await harness.optimizer.stop()
  })

  it('never admits an external gateway even if a dependency returns one', async () => {
    const harness = fixture()
    vi.mocked(harness.deps.gateway).mockResolvedValue({ ...harness.localGateway, target: 'laravel_proxy' })
    harness.optimizer.start()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(harness.stream).not.toHaveBeenCalled()
    expect(harness.remember).not.toHaveBeenCalled()
    expect(harness.optimizer.snapshot().reason).toBe('failed')
    await harness.optimizer.stop()
  })

  it.each([
    [
      'native_required',
      (harness: ReturnType<typeof fixture>) => {
        harness.deps.native = () => false
      },
    ],
    [
      'runtime_unavailable',
      (harness: ReturnType<typeof fixture>) => {
        harness.status.state = 'cold'
        harness.status.operational = false
      },
    ],
    [
      'memory_disabled',
      (harness: ReturnType<typeof fixture>) => {
        harness.preferences.autoRemember = false
      },
    ],
    [
      'memory_pressure',
      (harness: ReturnType<typeof fixture>) => {
        harness.metrics.ram_used_mb = harness.metrics.ram_total_mb - 4095
      },
    ],
    [
      'memory_pressure',
      (harness: ReturnType<typeof fixture>) => {
        harness.status.resourceConfig!.applied.ramReserveBytes = 24 * 1024 ** 3
      },
    ],
    [
      'memory_pressure',
      (harness: ReturnType<typeof fixture>) => {
        harness.metrics.ram_used_mb = Number.NaN
      },
    ],
    [
      'cpu_pressure',
      (harness: ReturnType<typeof fixture>) => {
        harness.metrics.cpu_percent = 76
      },
    ],
    [
      'resource_switch',
      (harness: ReturnType<typeof fixture>) => {
        harness.status.resourceConfig!.pending = true
      },
    ],
    [
      'foreground',
      (harness: ReturnType<typeof fixture>) => {
        harness.setBusy(true)
      },
    ],
    [
      'scope_unavailable',
      (harness: ReturnType<typeof fixture>) => {
        harness.setProject(undefined)
      },
    ],
  ])('pauses for %s without invoking a model or retrieving memory', async (reason, change) => {
    const harness = fixture()
    change(harness)
    harness.optimizer.start()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(harness.deps.gateway).not.toHaveBeenCalled()
    expect(harness.recall).not.toHaveBeenCalled()
    expect(harness.optimizer.snapshot().reason).toBe(reason)
    await harness.optimizer.stop()
  })

  it.each(['account', 'catalog', 'resources', 'project', 'project revision'])(
    'rejects a result after a %s boundary change',
    async change => {
      const harness = fixture()
      const pending = deferred<InferenceResult>()
      harness.stream.mockImplementation(() => pending.promise)
      harness.optimizer.start()
      await vi.advanceTimersByTimeAsync(600_000)
      if (change === 'account') harness.account.principalId = 'account-2'
      if (change === 'catalog') harness.policy.manifest = { ...harness.policy.manifest!, payloadSha256: 'catalog-2' }
      if (change === 'resources') harness.policy.appliedResourceRevision = 2
      if (change === 'project') harness.setProject({ ...harness.project!, id: 'project-2' })
      if (change === 'project revision') {
        harness.project!.summary = 'A newly updated source summary.'
        harness.project!.updatedAt += 1
      }
      pending.complete(response)
      await vi.advanceTimersByTimeAsync(0)
      expect(harness.remember).not.toHaveBeenCalled()
      await harness.optimizer.stop()
    }
  )

  it('native resource admission preempts background, drains it, and holds foreground ownership across child jobs', async () => {
    const harness = fixture()
    const pending = deferred<InferenceResult>()
    harness.stream.mockImplementation(() => pending.promise)
    harness.optimizer.start()
    await vi.advanceTimersByTimeAsync(600_000)
    let userAdmitted = false
    const admission = harness.resources.acquire().then(lease => {
      userAdmitted = true
      return lease
    })
    expect(harness.stream.mock.calls[0]?.[0].signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(userAdmitted).toBe(false)
    pending.complete(response)
    const rootLease = await admission
    const child = await harness.resources.acquire(undefined, rootLease.work)
    await rootLease.release()
    expect(harness.optimizer.snapshot().foregroundJobs).toBe(1)
    await child.release()
    expect(harness.optimizer.snapshot().foregroundJobs).toBe(0)
    expect(harness.remember).not.toHaveBeenCalled()
    expect(harness.resources.hasWork()).toBe(false)
    await harness.optimizer.stop()
  })

  it('does not accept tool calls, token-limit truncation or reasoning-only output as memory', async () => {
    for (const rejected of [
      { ...response, finishReason: 'length' },
      { ...response, finishReason: 'error' },
      { ...response, finishReason: 'content_filter' },
      {
        ...response,
        rawToolCalls: [{ id: 'call', type: 'function' as const, function: { name: 'fs_read', arguments: '{}' } }],
      },
      { ...response, content: '<think>Private reasoning only</think>' },
    ]) {
      const harness = fixture()
      harness.stream.mockResolvedValue(rejected)
      harness.optimizer.start()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(harness.remember).not.toHaveBeenCalled()
      await harness.optimizer.stop()
    }
  })

  it('defaults missing local settings to enabled and only updates visible state after durable save', async () => {
    stored.get.mockResolvedValue(undefined)
    idleOptimizationEnabled.value = false
    await loadIdleOptimizationSetting()
    expect(idleOptimizationEnabled.value).toBe(true)
    expect(stored.get).toHaveBeenCalledWith(IDLE_OPTIMIZATION_KEY)
    stored.save.mockRejectedValueOnce(new Error('Local settings store unavailable'))
    await expect(saveIdleOptimizationSetting(false)).rejects.toThrow('Local settings store unavailable')
    expect(idleOptimizationEnabled.value).toBe(true)
    stored.save.mockResolvedValue(undefined)
    await saveIdleOptimizationSetting(false)
    expect(stored.set).toHaveBeenCalledWith(IDLE_OPTIMIZATION_KEY, false)
    expect(idleOptimizationEnabled.value).toBe(false)
  })

  it.each(['false', 'true', 1, {}, []])('keeps malformed persisted setting %j disabled', async saved => {
    stored.get.mockResolvedValue(saved)
    idleOptimizationEnabled.value = true
    await loadIdleOptimizationSetting()
    expect(idleOptimizationEnabled.value).toBe(false)
  })
})

describe('resident-only inference budget', () => {
  it('forces a tool-free short answer with thinking disabled and never prepares expired readiness', async () => {
    const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/local-model-manifest-v1.json'), 'utf8'))
    const payloadHash = 'a'.repeat(64)
    const binding = {
      acceptanceSessionId: '00000000-0000-4000-8000-000000000001',
      acceptanceGeneration: 1,
      manifestPayloadSha256: payloadHash,
    }
    const manifest = await verifyLocalModelManifest(
      {
        key_id: 'test-key',
        algorithm: 'RSA-SHA256',
        payload_sha256: payloadHash,
        payload: structuredClone(fixture.cases.explicit_experiment),
        signature: 'test',
      },
      { verify: async () => ({ valid: true, canonicalPayloadSha256: payloadHash }) },
      {
        trustDomain: `server:v1:${'b'.repeat(64)}`,
        ...binding,
        expectedKeyId: 'test-key',
        minimumCatalogVersion: 2026083001,
        minimumPolicyVersion: 2026083001,
        now: new Date(),
      }
    )
    const release = manifest.models.find(model => model.id.includes('orcarouter'))!
    const readiness = {
      modelReleaseId: release.id,
      manifestPayloadSha256: payloadHash,
      artifactSha256: release.artifact!.sha256,
      runtimeSha256: release.runtime!.sha256,
      ready: true,
      verifiedAtMs: Date.now() - 1_000,
      validUntilMs: Date.now() + 120_000,
    }
    const transport: LocalRuntimeTransport = {
      prepare: vi.fn(),
      stream: vi.fn(async () => response),
      cancel: vi.fn(),
      stop: vi.fn(),
    }
    const manager = new LocalModelManager(transport)
    const gateway = manager.gateway(release, readiness, binding, 'b'.repeat(64), true)
    await gateway.streamChatWithTools({
      messages: [{ role: 'user', content: 'Summarize local context' }],
      tools: [{ name: 'bad' }],
      toolChoice: 'required',
      taskType: 'chat.general',
    })
    expect(transport.stream).toHaveBeenCalledWith(
      release,
      expect.objectContaining({
        taskType: 'context.optimize',
        tools: [],
        toolChoice: 'none',
        maxOutputTokens: 768,
        reasoningMode: 'off',
      })
    )
    vi.setSystemTime(Date.now() + 180_000)
    await expect(
      gateway.streamChatWithTools({ messages: [{ role: 'user', content: 'Expired' }] })
    ).rejects.toMatchObject({ code: 'readiness_unavailable' })
    expect(transport.prepare).not.toHaveBeenCalled()
    expect(transport.stream).toHaveBeenCalledTimes(1)
  })
})
