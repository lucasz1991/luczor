import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const proxy = vi.hoisted(() => vi.fn())
vi.mock('@/services/inference/gateways', () => ({
  laravelInferenceGateway: {
    id: 'laravel-test',
    target: 'laravel_proxy',
    streamChatWithTools: proxy,
  },
}))

import type { BootstrapResponse } from '@/services/api/luczorApi'
import type { VerifiedAccountSnapshot } from '@/services/accountPrincipal'
import {
  LocalInferenceCoordinator,
  hashInferenceEgressRequest,
  localPolicyDiagnostic,
  packetBoundLaravelGateway,
  type LocalInferenceCoordinatorDependencies,
  type TurnRoutingInput,
} from '@/services/inference/coordinator'
import { decideHybridRoute } from '@/services/inference/hybridRouter'
import {
  LocalInferenceError,
  LocalModelManager,
  type LocalRuntimeTransport,
} from '@/services/inference/localModelManager'
import { verifyLocalModelManifest, type VerifiedLocalModelManifest } from '@/services/inference/modelManifest'
import type { HardwareSnapshot } from '@/services/inference/capacity'
import type { InferenceRequest, InferenceResult } from '@/services/inference/types'

const GIB = 1024 ** 3
const payloadHash = 'a'.repeat(64)
const trustDomain = `server:v1:${'b'.repeat(64)}`
const acceptanceSessionId = '00000000-0000-4000-8000-000000000001'
const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/local-model-manifest-v1.json'), 'utf8')) as {
  cases: Record<string, Record<string, unknown>>
}
const fixtureCases = new Map([
  [
    'hardware_tiers',
    JSON.parse(readFileSync(resolve('tests/fixtures/local-model-tiers-v2.json'), 'utf8')) as Record<string, unknown>,
  ],
  ['metadata_only_default', fixture.cases.metadata_only_default!],
  ['explicit_experiment', fixture.cases.explicit_experiment!],
  ['promoted_preferred', fixture.cases.promoted_preferred!],
])

async function manifest(name: string): Promise<VerifiedLocalModelManifest> {
  const payload = fixtureCases.get(name)
  if (!payload) throw new Error(`Unknown fixture case: ${name}`)
  return verifyLocalModelManifest(
    {
      key_id: 'test-key',
      algorithm: 'RSA-SHA256',
      payload_sha256: payloadHash,
      payload: structuredClone(payload),
      signature: 'test',
    },
    { verify: async () => ({ valid: true, canonicalPayloadSha256: payloadHash }) },
    {
      trustDomain,
      acceptanceSessionId,
      acceptanceGeneration: 1,
      expectedKeyId: 'test-key',
      minimumCatalogVersion: 2026083001,
      minimumPolicyVersion: 2026083001,
      now: new Date('2026-08-30T12:30:00Z'),
    }
  )
}

function bootstrap(available = true, required = true): BootstrapResponse {
  return {
    device: { id: 'device-1', name: 'Desktop', abilities: ['settings.read'] },
    user: { id: 41, name: 'Account', email: 'account@example.test' },
    runtime_settings: { api_prefix: '/api/v1', registration_enabled: false },
    routing: {
      managed_by: 'server',
      client_model_selection: false,
      ...(required ? { local_model_manifest_required: true as const } : {}),
    },
    local_model_manifest: {
      url: '/api/v1/local-model/manifest',
      schema_version: 1,
      catalog_version: 2026083001,
      policy_version: 2026083001,
      key_id: 'test-key',
      available,
    },
  }
}

function account(serverInstance = 'https://example.test/luczor-a'): VerifiedAccountSnapshot {
  return Object.freeze({
    principalId: `account:v2:${'b'.repeat(64)}`,
    serverOrigin: 'https://example.test',
    serverInstance,
    accountId: 41,
    config: Object.freeze({ baseUrl: serverInstance, deviceKey: 'device-key', clientId: 'desktop-1' }),
  })
}

function hardware(): HardwareSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: 'hardware-1',
    capturedAtMs: Date.parse('2026-08-30T12:30:00Z'),
    platform: 'windows',
    arch: 'x86_64',
    cpu: { logicalCores: 20, physicalCores: 10, features: [], loadPercent: 5 },
    memory: { totalBytes: 64 * GIB, availableBytes: 48 * GIB },
    accelerators: [{ id: 'cuda-0', backend: 'cuda', name: 'GPU', totalBytes: 32 * GIB, availableBytes: 30 * GIB }],
    storage: [
      {
        id: 'internal-nvme',
        mountLabel: 'internal',
        busType: 'nvme',
        mediaType: 'ssd',
        removable: false,
        availableBytes: 700 * GIB,
      },
    ],
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function makeHarness(verified: VerifiedLocalModelManifest, serverInstance = 'https://example.test/luczor-a') {
  let nowMs = Date.parse('2026-08-30T12:30:00Z')
  const requests: Array<{ scopeDigest: string; modelReleaseId: string }> = []
  const transport: LocalRuntimeTransport = {
    stream: vi.fn(async (_release, request): Promise<InferenceResult> => {
      requests.push({ scopeDigest: request.scopeDigest, modelReleaseId: request.modelReleaseId })
      return { content: 'lokal', toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
    }),
    cancel: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  }
  const manager = new LocalModelManager(
    transport,
    () => new Date(nowMs),
    () => 'request-1'
  )
  const prepareModel = vi.fn(async modelReleaseId => {
    const release = verified.models.find(model => model.id === modelReleaseId)!
    return {
      modelReleaseId,
      manifestPayloadSha256: verified.payloadSha256,
      artifactSha256: release.artifact!.sha256,
      runtimeSha256: release.runtime!.sha256,
      ready: true,
      verifiedAtMs: nowMs,
      validUntilMs: nowMs + 10 * 60_000,
    }
  })
  const dependencies: LocalInferenceCoordinatorDependencies = {
    bootstrap: vi.fn(async () => bootstrap()),
    fetchManifest: vi.fn(async () => ({})),
    verifyManifest: vi.fn(async () => verified),
    hardwareSnapshot: vi.fn(async () => hardware()),
    prepareModel,
    accountSnapshot: vi.fn(async () => account(serverInstance)),
    manifestSession: vi.fn(async () => acceptanceSessionId),
    manager,
    now: () => new Date(nowMs),
  }
  return {
    coordinator: new LocalInferenceCoordinator(dependencies),
    dependencies,
    prepareModel,
    requests,
    advance(ms: number) {
      nowMs += ms
    },
  }
}

const basicRequest: InferenceRequest = {
  messages: [{ role: 'user', content: 'Hallo' }],
  tools: [],
  toolChoice: 'none',
  projectId: 'project-1',
  taskType: 'chat',
}

it('honors a fixed local selection even when another signed model is ready', async () => {
  const verified = await manifest('hardware_tiers')
  const input = readyRoutingInput(verified)
  const selected = verified.models[0]!.id
  input.settings.localModelId = selected
  expect(decideHybridRoute(input).modelReleaseId).toBe(selected)
  input.readiness = new Map([...input.readiness].filter(([id]) => id !== selected))
  input.settings.preference = 'local_only'
  expect(decideHybridRoute(input).target).toBe('blocked')
})

it('prepares only the selected model and does not prepare a fallback for an unknown selection', async () => {
  const verified = await manifest('hardware_tiers')
  const harness = makeHarness(verified)
  await harness.coordinator.initialize(bootstrap())
  harness.prepareModel.mockClear()
  await expect(
    harness.coordinator.resolveTurn({
      projectId: 'project-1',
      routingSettings: { localModelId: 'missing-model', preference: 'local_only' },
    })
  ).rejects.toBeDefined()
  expect(harness.prepareModel).not.toHaveBeenCalled()
})

async function approvedSpecialist(taskType = 'agent.research') {
  const request: InferenceRequest = { ...basicRequest, taskType }
  const packetHash = await hashInferenceEgressRequest(request, 'desktop-1')
  const input: TurnRoutingInput = {
    projectId: 'project-1',
    taskType,
    intent: 'external_specialist',
    externalPackage: {
      messages: request.messages,
      apiConfig: account().config,
      packetHash,
      approval: { approvalId: 'specialist-approval', packetHash, expiresAt: '2026-08-30T12:31:00Z' },
    },
  }
  return { input, request }
}

function readyRoutingInput(verified: VerifiedLocalModelManifest): Parameters<typeof decideHybridRoute>[0] {
  const now = new Date('2026-08-30T12:30:00Z')
  return {
    manifest: verified,
    settings: { preference: 'ask_external', experimentalFlashNext: false, allowDegradedLocal: false },
    contextEgress: 'external_allowed',
    now,
    assessments: new Map(
      verified.models.map(model => [
        model.id,
        {
          snapshotId: 'hardware-ready',
          modelReleaseId: model.id,
          status: 'eligible',
          reasons: [],
          assessedAtMs: now.getTime(),
          validUntilMs: now.getTime() + 60_000,
        },
      ])
    ),
    health: new Map(
      verified.models.map(model => [
        model.id,
        { modelReleaseId: model.id, state: 'ready', consecutiveFailures: 0, updatedAt: now.toISOString() },
      ])
    ),
    readiness: new Map(
      verified.models.map(model => [
        model.id,
        {
          modelReleaseId: model.id,
          manifestPayloadSha256: verified.payloadSha256,
          artifactSha256: model.artifact!.sha256,
          runtimeSha256: model.runtime!.sha256,
          ready: true,
          verifiedAtMs: now.getTime(),
          validUntilMs: now.getTime() + 60_000,
        },
      ])
    ),
  }
}

describe('explicit specialist routing preference', () => {
  it.each(['experimental', 'default', 'fallback'] as const)(
    'bypasses the ready local %s only when explicitly preferred and still requires approval',
    async candidate => {
      const verified = await manifest(candidate === 'experimental' ? 'explicit_experiment' : 'promoted_preferred')
      const input = readyRoutingInput(verified)
      if (candidate === 'fallback') {
        input.manifest = {
          ...verified,
          models: verified.models.map(model =>
            model.id === verified.routing.defaultModelId ? { ...model, enabled: false } : model
          ),
        }
      }
      input.settings.experimentalFlashNext = candidate === 'experimental'
      expect(decideHybridRoute(input).target).toBe('local_llama_cpp')
      expect(decideHybridRoute({ ...input, preferExternal: true })).toMatchObject({
        target: 'blocked',
        reason: 'external_approval_required',
      })
      expect(
        decideHybridRoute({
          ...input,
          preferExternal: true,
          expectedEgressPacketHash: payloadHash,
          externalApproval: { approvalId: 'approved', packetHash: payloadHash, expiresAt: '2026-08-30T12:31:00Z' },
        })
      ).toMatchObject({ target: 'laravel_proxy', reason: 'external_approved' })
    }
  )

  it('waits for a warming local candidate instead of offering external egress', async () => {
    const input = readyRoutingInput(await manifest('promoted_preferred'))
    input.readiness = new Map()
    expect(decideHybridRoute(input)).toMatchObject({ target: 'blocked', reason: 'external_approval_required' })
    expect(decideHybridRoute({ ...input, localReadinessPending: true })).toMatchObject({
      target: 'blocked',
      reason: 'local_readiness_pending',
    })
    expect(
      decideHybridRoute({
        ...input,
        localReadinessPending: true,
        settings: { ...input.settings, preference: 'force_external' },
      })
    ).toMatchObject({ target: 'blocked', reason: 'external_approval_required' })
  })

  it('skips every local candidate for the explicit external composer mode', async () => {
    const input = readyRoutingInput(await manifest('promoted_preferred'))
    expect(decideHybridRoute(input).target).toBe('local_llama_cpp')
    input.settings.preference = 'force_external'
    expect(decideHybridRoute(input)).toMatchObject({ target: 'blocked', reason: 'external_approval_required' })
    expect(
      decideHybridRoute({
        ...input,
        expectedEgressPacketHash: payloadHash,
        externalApproval: { approvalId: 'approved', packetHash: payloadHash, expiresAt: '2026-08-30T12:31:00Z' },
      })
    ).toMatchObject({ target: 'laravel_proxy', reason: 'external_approved' })
  })

  it.each(['context', 'policy', 'hash', 'expiry'] as const)(
    'does not let the external composer mode override the %s gate',
    async gate => {
      const input = readyRoutingInput(await manifest('promoted_preferred'))
      input.settings.preference = 'force_external'
      input.expectedEgressPacketHash = payloadHash
      input.externalApproval = { approvalId: 'approved', packetHash: payloadHash, expiresAt: '2026-08-30T12:31:00Z' }
      if (gate === 'context') input.contextEgress = 'local_only'
      if (gate === 'policy') {
        input.manifest = { ...input.manifest, routing: { ...input.manifest.routing, externalAllowed: false } }
      }
      if (gate === 'hash') input.externalApproval.packetHash = 'f'.repeat(64)
      if (gate === 'expiry') input.externalApproval.expiresAt = '2026-08-30T12:29:00Z'
      expect(decideHybridRoute(input)).toMatchObject({
        target: 'blocked',
        reason:
          gate === 'context'
            ? 'local_only_blocked'
            : gate === 'policy'
              ? 'external_policy_blocked'
              : 'external_approval_required',
      })
    }
  )

  it.each(['context', 'preference', 'policy', 'hash', 'expiry'] as const)(
    'does not let explicit preference override the %s gate',
    async gate => {
      const input = readyRoutingInput(await manifest('promoted_preferred'))
      input.preferExternal = true
      input.expectedEgressPacketHash = payloadHash
      input.externalApproval = { approvalId: 'approved', packetHash: payloadHash, expiresAt: '2026-08-30T12:31:00Z' }
      if (gate === 'context') input.contextEgress = 'local_only'
      if (gate === 'preference') input.settings.preference = 'local_only'
      if (gate === 'policy') {
        input.manifest = { ...input.manifest, routing: { ...input.manifest.routing, externalAllowed: false } }
      }
      if (gate === 'hash') input.externalApproval.packetHash = 'f'.repeat(64)
      if (gate === 'expiry') input.externalApproval.expiresAt = '2026-08-30T12:29:00Z'
      expect(decideHybridRoute(input)).toMatchObject({
        target: 'blocked',
        reason:
          gate === 'context' || gate === 'preference'
            ? 'local_only_blocked'
            : gate === 'policy'
              ? 'external_policy_blocked'
              : 'external_approval_required',
      })
    }
  )
})

describe('local inference coordinator and approved external gateway', () => {
  it('keeps the last verified repository scope for resident-only optimization without preparing again', async () => {
    const verified = await manifest('promoted_preferred')
    const harness = makeHarness(verified)
    await harness.coordinator.initialize(bootstrap())
    const foreground = await harness.coordinator.resolveTurn({
      projectId: 'project-1',
      repoId: 'repo-1',
      routingSettings: { preference: 'local_only' },
    })
    await foreground.gateway.streamChatWithTools(basicRequest)
    harness.prepareModel.mockClear()
    const idle = await harness.coordinator.residentOptimizationGateway('project-1', harness.requests[0]!.modelReleaseId)
    await idle.streamChatWithTools({ ...basicRequest, taskType: 'context.optimize' })
    expect(harness.requests).toHaveLength(2)
    expect(harness.requests[1]?.scopeDigest).toBe(harness.requests[0]?.scopeDigest)
    expect(harness.prepareModel).not.toHaveBeenCalled()
  })

  it('idle routing cannot prepare a cold model, refresh policy or choose a provider fallback', async () => {
    const verified = await manifest('promoted_preferred')
    const harness = makeHarness(verified)
    await harness.coordinator.initialize(bootstrap())
    await expect(
      harness.coordinator.residentOptimizationGateway('p1', verified.routing.defaultModelId)
    ).rejects.toMatchObject({ code: 'idle_model_not_ready' })
    expect(harness.prepareModel).not.toHaveBeenCalled()
    const evidence = await harness.prepareModel(verified.routing.defaultModelId)
    harness.prepareModel.mockClear()
    harness.coordinator.reconcileNativeStatus({
      manifestAvailable: true,
      catalogVersion: verified.catalogVersion,
      policyVersion: verified.policyVersion,
      activeModelId: evidence.modelReleaseId,
      state: 'ready',
      readiness: [evidence],
    })
    const gateway = await harness.coordinator.residentOptimizationGateway('p1', evidence.modelReleaseId)
    expect(gateway.target).toBe('local_llama_cpp')
    await gateway.streamChatWithTools(basicRequest)
    expect(harness.requests).toHaveLength(1)
    harness.advance(10 * 60_000)
    await expect(harness.coordinator.residentOptimizationGateway('p1', evidence.modelReleaseId)).rejects.toMatchObject({
      code: 'idle_model_not_ready',
    })
    expect(harness.prepareModel).not.toHaveBeenCalled()
  })
  it('never replaces current resource readiness with a late status from an older revision', async () => {
    const verified = await manifest('promoted_preferred')
    const harness = makeHarness(verified)
    await harness.coordinator.initialize(bootstrap())
    const evidence = await harness.prepareModel(verified.routing.defaultModelId)
    const config = {
      mode: 'auto' as const,
      gpuDeviceIds: null,
      threads: null,
      threadsBatch: null,
      ramReserveBytes: null,
      vramReserveBytes: null,
    }
    const native = (revision: number) => ({
      manifestAvailable: true,
      catalogVersion: verified.catalogVersion,
      policyVersion: verified.policyVersion,
      activeModelId: evidence.modelReleaseId,
      state: 'ready' as const,
      resourceConfig: {
        requested: config,
        applied: config,
        revision,
        appliedRevision: revision,
        pending: false,
        reasonCode: null,
      },
      readiness: [{ ...evidence, resourceRevision: revision }],
    })
    harness.coordinator.reconcileNativeStatus(native(2))
    expect(
      harness.coordinator.modelAdmissions().find(item => item.modelReleaseId === evidence.modelReleaseId)?.ready
    ).toBe(true)
    harness.coordinator.reconcileNativeStatus(native(1))
    harness.coordinator.resourcesApplied(1)
    harness.coordinator.reconcileNativeStatus({ ...native(1), readiness: [] })
    expect(
      harness.coordinator.modelAdmissions().find(item => item.modelReleaseId === evidence.modelReleaseId)?.ready
    ).toBe(true)
  })

  it('rejects old preparation evidence after an applied resource revision', async () => {
    const harness = makeHarness(await manifest('promoted_preferred'))
    await harness.coordinator.initialize(bootstrap())
    harness.coordinator.resourcesApplied(2)
    await expect(
      harness.coordinator.resolveTurn({ projectId: 'project-1', routingSettings: { preference: 'local_only' } })
    ).rejects.toMatchObject({ code: 'local_only_blocked' })
    expect(harness.coordinator.modelAdmissions().filter(item => item.ready)).toEqual([])
  })

  it('prepares a physical DXGI candidate but blocks routing when native backend verification fails', async () => {
    const harness = makeHarness(await manifest('promoted_preferred'))
    const snapshot = hardware()
    snapshot.accelerators = [
      {
        id: 'dxgi-physical',
        name: 'Physical GPU',
        backend: 'unknown',
        detectionSource: 'dxgi',
        totalBytes: 32 * GIB,
        availableBytes: null,
        sharedSystemLimitBytes: 32 * GIB,
      },
    ]
    vi.mocked(harness.dependencies.hardwareSnapshot).mockResolvedValue(snapshot)
    harness.prepareModel.mockRejectedValue(
      new Error('No compatible GPU runtime satisfies the signed model capacity policy.')
    )
    await harness.coordinator.initialize(bootstrap())
    await expect(
      harness.coordinator.resolveTurn({ projectId: 'project-1', routingSettings: { preference: 'local_only' } })
    ).rejects.toMatchObject({ code: 'local_only_blocked' })
    expect(harness.prepareModel).toHaveBeenCalled()
    expect(harness.coordinator.modelAdmissions('chat').some(model => model.ready)).toBe(false)
    expect(
      harness.coordinator
        .modelAdmissions('chat')
        .some(model => model.reasons.includes('accelerator_runtime_unavailable'))
    ).toBe(true)
    expect(harness.requests).toEqual([])
    expect(proxy).not.toHaveBeenCalled()
  })

  it('chooses the strongest eligible tier and keeps that resident tier on subsequent requests', async () => {
    const verified = await manifest('hardware_tiers')
    const harness = makeHarness(verified)
    const limited = hardware()
    limited.memory.availableBytes = 7 * GIB
    vi.mocked(harness.dependencies.hardwareSnapshot).mockResolvedValue(limited)
    await harness.coordinator.initialize({
      ...bootstrap(),
      local_model_manifest: { ...bootstrap().local_model_manifest!, schema_version: 2 },
    })
    const input: TurnRoutingInput = { projectId: 'project-1', routingSettings: { preference: 'local_only' } }
    const first = await harness.coordinator.resolveTurn(input)
    expect(first.decision?.modelReleaseId).toBe('local-tier-balanced')
    expect(harness.prepareModel).toHaveBeenCalledOnce()
    const resident = hardware()
    resident.memory.residentModel = {
      modelReleaseId: 'local-tier-balanced',
      manifestPayloadSha256: verified.payloadSha256,
    }
    resident.memory.availableBytes = GIB
    harness.dependencies.recoverMemory = vi.fn(async () => resident)
    vi.mocked(harness.dependencies.hardwareSnapshot).mockResolvedValue(resident)
    harness.advance(31_000)
    const second = await harness.coordinator.resolveTurn(input)
    expect(second.decision?.modelReleaseId).toBe('local-tier-balanced')
    expect(harness.prepareModel).toHaveBeenCalledOnce()
    expect(harness.dependencies.recoverMemory).not.toHaveBeenCalled()
    vi.mocked(harness.dependencies.hardwareSnapshot).mockClear()
    harness.advance(2_000)
    const third = await harness.coordinator.resolveTurn(input)
    expect(third.decision?.modelReleaseId).toBe('local-tier-balanced')
    expect(harness.dependencies.hardwareSnapshot).not.toHaveBeenCalled()
    expect(harness.dependencies.recoverMemory).not.toHaveBeenCalled()
  })

  it('does not reuse renderer readiness after the native process stopped', async () => {
    const verified = await manifest('explicit_experiment')
    const harness = makeHarness(verified)
    await harness.coordinator.initialize(bootstrap())
    const input: TurnRoutingInput = { projectId: 'project-1', routingSettings: { preference: 'local_only' } }
    await harness.coordinator.resolveTurn(input)
    harness.dependencies.nativeStatus = vi.fn(async () => ({
      manifestAvailable: true,
      catalogVersion: verified.catalogVersion,
      policyVersion: verified.policyVersion,
      activeModelId: null,
      state: 'stopped' as const,
      readiness: [],
      reasonCode: null,
    }))
    await harness.coordinator.resolveTurn(input)
    expect(harness.prepareModel).toHaveBeenCalledTimes(2)
  })
  beforeEach(() => {
    proxy.mockReset()
    proxy.mockResolvedValue({ content: 'extern', toolCalls: [], rawToolCalls: [], finishReason: 'stop' })
  })

  it.each(['agent.planning', 'agent.research', 'agent.coding', 'agent.review'])(
    'routes an approved %s specialist externally without preparing a local model',
    async taskType => {
      const harness = makeHarness(await manifest('promoted_preferred'))
      await harness.coordinator.initialize(bootstrap())
      vi.mocked(harness.dependencies.hardwareSnapshot).mockClear()
      const { input, request } = await approvedSpecialist(taskType)

      const route = await harness.coordinator.resolveTurn(input)

      expect(route).toMatchObject({ gateway: { target: 'laravel_proxy' }, externalOneShot: true })
      expect(harness.prepareModel).not.toHaveBeenCalled()
      expect(harness.dependencies.hardwareSnapshot).not.toHaveBeenCalled()
      await expect(route.gateway.streamChatWithTools(request)).resolves.toMatchObject({ content: 'extern' })
      expect(proxy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ taskType }))
    }
  )

  it.each(['chat.general', 'planning.agent', 'agent.extraction', 'agent.admin', ' agent.research ', undefined])(
    'fails closed for specialist task type %s',
    async taskType => {
      const harness = makeHarness(await manifest('promoted_preferred'))
      await harness.coordinator.initialize(bootstrap())
      await expect(
        harness.coordinator.resolveTurn({
          projectId: 'project-1',
          taskType,
          intent: 'external_specialist',
        })
      ).rejects.toMatchObject({ code: 'routing_intent_invalid' })
      expect(harness.prepareModel).not.toHaveBeenCalled()
      expect(proxy).not.toHaveBeenCalled()
    }
  )

  it('shares one native preparation between background warmup and an immediately submitted chat', async () => {
    const verified = await manifest('promoted_preferred')
    const harness = makeHarness(verified)
    const ready = await harness.prepareModel.getMockImplementation()!(verified.routing.defaultModelId)
    const pending = deferred<typeof ready>()
    harness.prepareModel.mockImplementationOnce(() => pending.promise)
    await harness.coordinator.initialize(bootstrap())
    const warmup = harness.coordinator.resolveTurn({
      projectId: '__luczor_background__',
      contextId: 'renderer',
      taskType: 'chat.general',
      contextEgress: 'local_only',
      routingSettings: { preference: 'local_only' },
    })
    await vi.waitFor(() => expect(harness.prepareModel).toHaveBeenCalledOnce())
    const foreground = harness.coordinator.resolveTurn({
      projectId: 'project-1',
      taskType: 'chat.general',
      contextEgress: 'local_only',
      routingSettings: { preference: 'local_only' },
    })
    pending.resolve(ready)
    const routes = await Promise.all([warmup, foreground])
    expect(routes.every(route => route.gateway.target === 'local_llama_cpp')).toBe(true)
    expect(harness.prepareModel).toHaveBeenCalledOnce()
    expect(harness.requests).toHaveLength(0)
  })

  it('does not wait behind a local preparation already in progress', async () => {
    const verified = await manifest('promoted_preferred')
    const harness = makeHarness(verified)
    const ready = await harness.prepareModel.getMockImplementation()!(verified.routing.defaultModelId)
    const pending = deferred<typeof ready>()
    harness.prepareModel.mockImplementationOnce(() => pending.promise)
    await harness.coordinator.initialize(bootstrap())
    const localRoute = harness.coordinator.resolveTurn({ projectId: 'project-1', taskType: 'chat' })
    await vi.waitFor(() => expect(harness.prepareModel).toHaveBeenCalledOnce())

    const { input } = await approvedSpecialist()
    await expect(harness.coordinator.resolveTurn(input)).resolves.toMatchObject({
      gateway: { target: 'laravel_proxy' },
    })
    expect(harness.prepareModel).toHaveBeenCalledOnce()

    pending.resolve(ready)
    await expect(localRoute).resolves.toMatchObject({ gateway: { target: 'local_llama_cpp' } })
    expect(proxy).not.toHaveBeenCalled()
  })

  it('keeps an ordinary agent task local unless specialist intent is explicitly selected', async () => {
    const harness = makeHarness(await manifest('promoted_preferred'))
    await harness.coordinator.initialize(bootstrap())
    const { input } = await approvedSpecialist('agent.coding')
    delete input.intent
    await expect(harness.coordinator.resolveTurn(input)).resolves.toMatchObject({
      gateway: { target: 'local_llama_cpp' },
    })
    expect(harness.prepareModel).toHaveBeenCalledOnce()
    expect(proxy).not.toHaveBeenCalled()
  })

  it('rejects an unknown routing intent at runtime', async () => {
    const harness = makeHarness(await manifest('promoted_preferred'))
    await harness.coordinator.initialize(bootstrap())
    const { input } = await approvedSpecialist()
    await expect(
      harness.coordinator.resolveTurn({
        ...input,
        intent: 'automatic_external',
      } as unknown as TurnRoutingInput)
    ).rejects.toMatchObject({ code: 'routing_intent_invalid' })
    expect(harness.prepareModel).not.toHaveBeenCalled()
    expect(proxy).not.toHaveBeenCalled()
  })

  it('cannot skip an expired signed policy when specialist policy refresh fails', async () => {
    const harness = makeHarness(await manifest('promoted_preferred'))
    await harness.coordinator.initialize(bootstrap())
    const { input } = await approvedSpecialist()
    input.externalPackage!.approval.expiresAt = '2026-08-30T14:00:00Z'
    harness.advance(31 * 60_000)
    vi.mocked(harness.dependencies.bootstrap).mockRejectedValueOnce(new Error('offline'))
    await expect(harness.coordinator.resolveTurn(input)).rejects.toMatchObject({ code: 'manifest_expired' })
    expect(harness.dependencies.bootstrap).toHaveBeenCalledOnce()
    expect(harness.prepareModel).not.toHaveBeenCalled()
    expect(proxy).not.toHaveBeenCalled()
  })

  it('requires specialist approval without reporting an unattempted local preparation failure', async () => {
    const harness = makeHarness(await manifest('promoted_preferred'))
    await harness.coordinator.initialize(bootstrap())
    await expect(
      harness.coordinator.resolveTurn({
        projectId: 'project-1',
        taskType: 'agent.research',
        intent: 'external_specialist',
      })
    ).rejects.toMatchObject({
      code: 'external_approval_required',
      message: expect.stringContaining('externe Spezialist'),
    })
    expect(harness.prepareModel).not.toHaveBeenCalled()
    expect(proxy).not.toHaveBeenCalled()
  })

  it.each(['local_context', 'local_preference', 'signed_denial', 'unavailable_policy', 'changed_identity'] as const)(
    'keeps specialist routing blocked for %s even with an approved package',
    async gate => {
      const verified = await manifest('promoted_preferred')
      const harness = makeHarness(
        gate === 'signed_denial' ? { ...verified, routing: { ...verified.routing, externalAllowed: false } } : verified
      )
      await harness.coordinator.initialize(bootstrap(gate !== 'unavailable_policy'))
      const { input } = await approvedSpecialist()
      if (gate === 'local_context') input.contextEgress = 'local_only'
      if (gate === 'local_preference') input.routingSettings = { preference: 'local_only' }
      if (gate === 'changed_identity') harness.coordinator.invalidateApiIdentity()
      await expect(harness.coordinator.resolveTurn(input)).rejects.toMatchObject({
        code:
          gate === 'local_context' || gate === 'local_preference'
            ? 'local_only_blocked'
            : gate === 'signed_denial'
              ? 'external_policy_blocked'
              : 'local_policy_unavailable',
      })
      expect(harness.prepareModel).not.toHaveBeenCalled()
      expect(proxy).not.toHaveBeenCalled()
    }
  )

  it('keeps the specialist approval bound to the account, exact body and single request', async () => {
    const harness = makeHarness(await manifest('promoted_preferred'))
    await harness.coordinator.initialize(bootstrap())
    const { input, request } = await approvedSpecialist()
    await expect(
      harness.coordinator.resolveTurn({
        ...input,
        externalPackage: { ...input.externalPackage!, apiConfig: { ...account().config, clientId: 'another-client' } },
      })
    ).rejects.toMatchObject({ code: 'egress_client_mismatch' })

    const route = await harness.coordinator.resolveTurn(input)
    await expect(route.gateway.streamChatWithTools({ ...request, taskType: 'agent.coding' })).rejects.toMatchObject({
      code: 'routing_intent_invalid',
    })
    await expect(
      route.gateway.streamChatWithTools({
        ...request,
        messages: [{ role: 'user', content: 'changed packet' }],
      })
    ).rejects.toMatchObject({
      code: 'egress_hash_mismatch',
    })
    expect(proxy).not.toHaveBeenCalled()
    await route.gateway.streamChatWithTools(request)
    await expect(route.gateway.streamChatWithTools(request)).rejects.toMatchObject({
      code: 'external_reapproval_required',
    })
    expect(proxy).toHaveBeenCalledOnce()
  })

  it('selects signed Orca default, explicit Flash experiment, and promoted Flash default', async () => {
    const experimental = makeHarness(await manifest('explicit_experiment'))
    await experimental.coordinator.initialize(bootstrap())
    const normal = await experimental.coordinator.resolveTurn({ projectId: 'project-1', taskType: 'chat' })
    expect(normal.decision?.modelReleaseId).toContain('orcarouter')
    const optedIn = await experimental.coordinator.resolveTurn({
      projectId: 'project-1',
      taskType: 'chat',
      routingSettings: { experimentalFlashNext: true },
    })
    expect(optedIn.decision?.modelReleaseId).toBe('qwen3.8-flash-next')

    const promoted = makeHarness(await manifest('promoted_preferred'))
    await promoted.coordinator.initialize(bootstrap())
    const preferred = await promoted.coordinator.resolveTurn({ projectId: 'project-1', taskType: 'chat' })
    expect(preferred.decision?.modelReleaseId).toBe('qwen3.8-flash-next')
  })

  it('fetches and persists policy inside the exact verified server trust domain', async () => {
    const harness = makeHarness(await manifest('metadata_only_default'), 'https://example.test/luczor-a')
    const verifiedAccount = account('https://example.test/luczor-a')
    vi.mocked(harness.dependencies.accountSnapshot).mockResolvedValue(verifiedAccount)

    await harness.coordinator.initialize(bootstrap())

    expect(harness.dependencies.fetchManifest).toHaveBeenCalledWith(verifiedAccount.config)
    expect(vi.mocked(harness.dependencies.verifyManifest).mock.calls[0]?.[2]).toMatchObject({
      trustDomain: expect.stringMatching(/^server:v1:[a-f0-9]{64}$/),
      acceptanceSessionId,
      acceptanceGeneration: expect.any(Number),
    })
  })

  it('waits for local preparation before offering any external fallback', async () => {
    const verified = await manifest('explicit_experiment')
    const harness = makeHarness(verified)
    const preparation = harness.prepareModel.getMockImplementation()!
    const ready = await preparation(verified.routing.defaultModelId)
    const pending = deferred<typeof ready>()
    harness.prepareModel.mockImplementationOnce(() => pending.promise)
    await harness.coordinator.initialize(bootstrap())
    let settled = false
    const route = harness.coordinator.resolveTurn({ projectId: 'project-1', taskType: 'chat' })
    void route.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.waitFor(() => expect(harness.prepareModel).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    expect(proxy).not.toHaveBeenCalled()
    pending.resolve(ready)
    expect((await route).decision?.target).toBe('local_llama_cpp')
    expect(proxy).not.toHaveBeenCalled()
  })

  it.each([
    { modelReleaseId: 'another-release' },
    { manifestPayloadSha256: 'f'.repeat(64) },
    { artifactSha256: 'f'.repeat(64) },
    { runtimeSha256: 'f'.repeat(64) },
    { ready: false },
    { validUntilMs: Number.POSITIVE_INFINITY },
    { validUntilMs: 1 },
  ])('tries the signed local fallback when default readiness is invalid: %j', async invalid => {
    const harness = makeHarness(await manifest('promoted_preferred'))
    const preparation = harness.prepareModel.getMockImplementation()!
    harness.prepareModel.mockImplementationOnce(async modelId => ({ ...(await preparation(modelId)), ...invalid }))
    await harness.coordinator.initialize(bootstrap())

    const route = await harness.coordinator.resolveTurn({ projectId: 'project-1', taskType: 'chat' })

    expect(route.decision?.target).toBe('local_llama_cpp')
    expect(route.decision?.modelReleaseId).toContain('orcarouter')
    expect(harness.prepareModel).toHaveBeenCalledTimes(2)
    expect(harness.coordinator.modelAdmissions('chat')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelReleaseId: 'qwen3.8-flash-next',
          ready: false,
          reasons: ['readiness_mismatch'],
        }),
      ])
    )
    expect(proxy).not.toHaveBeenCalled()
  })

  it('honors a signed external denial without requesting a futile payload approval', async () => {
    const verified = await manifest('metadata_only_default')
    const harness = makeHarness({ ...verified, routing: { ...verified.routing, externalAllowed: false } })
    await harness.coordinator.initialize(bootstrap())

    await expect(harness.coordinator.resolveTurn({ projectId: 'project-1', taskType: 'chat' })).rejects.toMatchObject({
      code: 'external_policy_blocked',
      message: expect.stringContaining('keinen externen Fallback'),
    })
    expect(harness.prepareModel).not.toHaveBeenCalled()
    expect(proxy).not.toHaveBeenCalled()
  })

  it.each([
    [
      'Local-model execution is disabled on this platform until immutable artifact guards are available.',
      'runtime_platform_protection_unavailable',
      'Dateischutz oder Prozessabsicherung fehlen',
    ],
    [
      'Local-model execution is disabled on this platform until parent-death process protection is available.',
      'runtime_platform_protection_unavailable',
      'Dateischutz oder Prozessabsicherung fehlen',
    ],
    [
      'The server has not provided the signed Linux runtime or model resource.',
      'runtime_download_unavailable',
      'nicht bereitgestellt',
    ],
    ['The server runtime does not match this Linux architecture.', 'runtime_platform_mismatch', 'Prozessorarchitektur'],
    ['Installed model resource checksum mismatch.', 'runtime_installed_checksum_mismatch', 'Pr�fsumme'],
    ['LUCZOR_LLAMA_CPP_BIN is not configured.', 'runtime_not_configured', 'noch nicht eingerichtet'],
    [
      'Local runtime startup stopped to protect available RAM (runtime_startup_ram_pressure).',
      'runtime_startup_ram_pressure',
      'zum Schutz des verfügbaren Arbeitsspeichers',
    ],
    [
      'Model storage does not satisfy the signed storage class or free-space threshold.',
      'storage_unavailable',
      'kein geeigneter Speicherplatz',
    ],
    [
      'Local-model runtime paths are not configured. Configure local-model/runtime-paths.json or both runtime environment paths.',
      'runtime_not_configured',
      'noch nicht eingerichtet',
    ],
    [
      'Local-model runtime path configuration has an invalid schema.',
      'local_paths_invalid',
      'Modellpfade sind ungültig',
    ],
    ['Configured GGUF file is unavailable.', 'model_files_unavailable', 'Modelldateien sind nicht verfügbar'],
    [
      'Configured GGUF hash does not match the signed manifest.',
      'artifact_mismatch',
      'passen nicht zum signierten Katalog',
    ],
    [
      'Configured llama.cpp runtime hash does not match the signed manifest.',
      'runtime_mismatch',
      'passt nicht zum signierten Katalog',
    ],
    [
      'Local benchmark did not meet the signed capacity thresholds.',
      'benchmark_failed',
      'Bereitschaftsprüfung nicht bestanden',
    ],
    [
      'Private failure C:\\Users\\secret-user token=secret-data',
      'local_preparation_failed',
      'Modellvorbereitung ist fehlgeschlagen',
    ],
  ])('reports safe local readiness for %s', async (nativeError, reason, message) => {
    const harness = makeHarness(await manifest('explicit_experiment'))
    harness.prepareModel.mockRejectedValue(new Error(nativeError))
    await harness.coordinator.initialize(bootstrap())

    const failure = await harness.coordinator
      .resolveTurn({
        projectId: 'project-1',
        taskType: 'chat',
        routingSettings: { preference: 'local_only' },
      })
      .catch(error => error)
    expect(failure).toBeInstanceOf(LocalInferenceError)
    expect(failure).toMatchObject({ code: 'local_only_blocked', message: expect.stringContaining(message) })
    expect(failure.message).not.toContain(nativeError)
    const admissions = harness.coordinator.modelAdmissions('chat')
    expect(admissions).toEqual(expect.arrayContaining([expect.objectContaining({ ready: false, reasons: [reason] })]))
    expect(JSON.stringify(admissions)).not.toContain(nativeError)
    expect(proxy).not.toHaveBeenCalled()
  })

  it.each([
    ['resource_revision_mismatch', 'Ressourcenverteilung hat sich geändert'],
    ['resource_gpu_selection_changed', 'gespeicherte Grafikkarte hat sich geändert'],
    ['ram_budget_insufficient', 'Modell, Kontext und Sicherheitsreserve'],
    ['runtime_gpu_measurement_unavailable', 'GPU-Auslagerung konnte noch nicht bestätigt'],
    ['gpu_full_offload_not_verified', 'vollständige GPU-Auslagerung wurde nicht bestätigt'],
  ])('explains resource preparation failure %s without claiming CPU execution', async (code, message) => {
    const harness = makeHarness(await manifest('explicit_experiment'))
    harness.prepareModel.mockRejectedValue(new Error(code))
    await harness.coordinator.initialize(bootstrap())
    await expect(
      harness.coordinator.resolveTurn({
        projectId: 'project-1',
        taskType: 'chat',
        routingSettings: { preference: 'local_only' },
      })
    ).rejects.toMatchObject({ code: 'local_only_blocked', message: expect.stringContaining(message) })
    expect(harness.coordinator.modelAdmissions('chat')).toEqual(
      expect.arrayContaining([expect.objectContaining({ ready: false, reasons: [code] })])
    )
    expect(proxy).not.toHaveBeenCalled()
  })

  it('keeps a retryable local start local until the signed health policy is exhausted', async () => {
    const harness = makeHarness(await manifest('explicit_experiment'))
    harness.prepareModel.mockRejectedValue(
      'Local runtime startup stopped to protect available RAM (runtime_startup_ram_pressure).'
    )
    await harness.coordinator.initialize(bootstrap())
    for (const _attempt of [1, 2]) {
      await expect(harness.coordinator.resolveTurn({ projectId: 'project-1' })).rejects.toMatchObject({
        code: 'local_readiness_pending',
        message: expect.stringContaining('Externes Modell'),
      })
    }
    await expect(harness.coordinator.resolveTurn({ projectId: 'project-1' })).rejects.toMatchObject({
      code: 'external_approval_required',
    })
  })

  it('routes the composer by its explicit capability instead of prompt keywords', async () => {
    const verified = await manifest('promoted_preferred')
    const narrowed = {
      ...verified,
      models: verified.models.map(model => ({ ...model, capabilities: ['chat'] })),
    } as unknown as typeof verified
    const harness = makeHarness(narrowed)
    await harness.coordinator.initialize(bootstrap())
    // 'coding.fix_bug' is what inferTaskType() produces for a sentence containing
    // "bug"; deriving the capability from it would demand execution_preparation.
    await expect(
      harness.coordinator.resolveTurn({ projectId: 'project-1', taskType: 'coding.fix_bug' })
    ).rejects.toMatchObject({ code: 'external_approval_required' })
    expect(harness.prepareModel).not.toHaveBeenCalled()
    const route = await harness.coordinator.resolveTurn({
      projectId: 'project-1',
      taskType: 'coding.fix_bug',
      requiredCapability: 'chat',
    })
    expect(route.decision?.target).toBe('local_llama_cpp')
  })

  it('clears readiness failures after successful local retry and after identity changes', async () => {
    const harness = makeHarness(await manifest('explicit_experiment'))
    harness.prepareModel.mockRejectedValueOnce('Configured GGUF file is unavailable.')
    await harness.coordinator.initialize(bootstrap())
    await expect(harness.coordinator.resolveTurn({ projectId: 'project-1' })).rejects.toMatchObject({
      code: 'external_approval_required',
      message: expect.stringContaining('Modelldateien sind nicht verfügbar'),
    })
    expect((await harness.coordinator.resolveTurn({ projectId: 'project-1' })).decision?.target).toBe('local_llama_cpp')
    expect(harness.coordinator.modelAdmissions()).toEqual(
      expect.arrayContaining([expect.objectContaining({ ready: true, reasons: [] })])
    )
    await harness.coordinator.initialize(bootstrap())
    expect(harness.coordinator.modelAdmissions()).toEqual(
      expect.arrayContaining([expect.objectContaining({ ready: false, reasons: ['readiness_pending'] })])
    )
  })

  it('explains insufficient local memory before any model is prepared', async () => {
    const harness = makeHarness(await manifest('explicit_experiment'))
    const snapshot = hardware()
    snapshot.memory.availableBytes = 1
    vi.mocked(harness.dependencies.hardwareSnapshot).mockResolvedValue(snapshot)
    await harness.coordinator.initialize(bootstrap())
    await expect(
      harness.coordinator.resolveTurn({
        projectId: 'project-1',
        routingSettings: { preference: 'local_only' },
      })
    ).rejects.toMatchObject({
      code: 'local_only_blocked',
      message: expect.stringContaining('Zu wenig freier RAM:'),
    })
    expect(harness.prepareModel).not.toHaveBeenCalled()
    expect(proxy).not.toHaveBeenCalled()
  })

  it('rechecks a RAM rejection on the next request and tries own-memory recovery only once per minute', async () => {
    const harness = makeHarness(await manifest('explicit_experiment'))
    const low = hardware()
    low.memory.availableBytes = 1
    vi.mocked(harness.dependencies.hardwareSnapshot).mockResolvedValue(low)
    harness.dependencies.recoverMemory = vi.fn(async () => low)
    await harness.coordinator.initialize(bootstrap())
    const input: TurnRoutingInput = { projectId: 'project-1', routingSettings: { preference: 'local_only' } }
    vi.mocked(harness.dependencies.hardwareSnapshot).mockClear()
    await expect(harness.coordinator.resolveTurn(input)).rejects.toMatchObject({ code: 'local_only_blocked' })
    expect(harness.dependencies.hardwareSnapshot).toHaveBeenCalledOnce()
    await expect(harness.coordinator.resolveTurn(input)).rejects.toMatchObject({ code: 'local_only_blocked' })
    expect(harness.dependencies.hardwareSnapshot).toHaveBeenCalledTimes(2)
    expect(harness.dependencies.recoverMemory).toHaveBeenCalledOnce()
    vi.mocked(harness.dependencies.hardwareSnapshot).mockResolvedValue(hardware())
    const route = await harness.coordinator.resolveTurn(input)
    expect(route.gateway.target).toBe('local_llama_cpp')
    expect(harness.prepareModel).toHaveBeenCalledOnce()
  })

  it('prepares locally after memory recovery succeeds without external fallback', async () => {
    const harness = makeHarness(await manifest('explicit_experiment'))
    const low = hardware()
    low.memory.availableBytes = 1
    vi.mocked(harness.dependencies.hardwareSnapshot).mockResolvedValue(low)
    harness.dependencies.recoverMemory = vi.fn(async () => hardware())
    await harness.coordinator.initialize(bootstrap())
    const route = await harness.coordinator.resolveTurn({
      projectId: 'project-1',
      routingSettings: { preference: 'local_only' },
    })
    expect(route.gateway.target).toBe('local_llama_cpp')
    expect(proxy).not.toHaveBeenCalled()
  })

  it('reports the actual task capability when local chat-only models cannot prepare execution', async () => {
    const verified = await manifest('explicit_experiment')
    const harness = makeHarness({
      ...verified,
      models: verified.models.map(model => ({ ...model, capabilities: ['chat'] })),
    })
    await harness.coordinator.initialize(bootstrap())
    await expect(
      harness.coordinator.resolveTurn({
        projectId: 'project-1',
        taskType: 'coding.agent',
        routingSettings: { preference: 'local_only' },
      })
    ).rejects.toMatchObject({
      code: 'local_only_blocked',
      message: expect.stringContaining('angeforderte Aufgabe nicht'),
    })
    expect(harness.prepareModel).not.toHaveBeenCalled()
    expect(proxy).not.toHaveBeenCalled()
  })

  it('discards a late native preparation error after a policy identity change', async () => {
    const harness = makeHarness(await manifest('explicit_experiment'))
    const pending = deferred<void>()
    harness.prepareModel.mockImplementationOnce(async () => {
      await pending.promise
      throw new Error('Configured GGUF file is unavailable.')
    })
    await harness.coordinator.initialize(bootstrap())
    const route = harness.coordinator.resolveTurn({ projectId: 'project-1' }).catch(error => error)
    await vi.waitFor(() => expect(harness.prepareModel).toHaveBeenCalledTimes(1))
    await harness.coordinator.initialize(bootstrap())
    pending.resolve()
    expect(await route).toMatchObject({ code: 'local_policy_unavailable' })
    expect(harness.coordinator.modelAdmissions()).toEqual(
      expect.arrayContaining([expect.objectContaining({ ready: false, reasons: ['readiness_pending'] })])
    )
    expect(JSON.stringify(harness.coordinator.modelAdmissions())).not.toContain('model_files_unavailable')
  })

  it('refreshes expired native readiness before a later turn', async () => {
    const harness = makeHarness(await manifest('explicit_experiment'))
    await harness.coordinator.initialize(bootstrap())
    expect(harness.prepareModel).not.toHaveBeenCalled()
    await harness.coordinator.resolveTurn({ projectId: 'project-1', taskType: 'chat' })
    expect(harness.prepareModel).toHaveBeenCalledTimes(1)
    harness.advance(11 * 60_000)
    await harness.coordinator.resolveTurn({ projectId: 'project-1', taskType: 'chat' })
    expect(harness.prepareModel).toHaveBeenCalledTimes(2)
  })

  it('prepares only the chosen candidate and exposes truthful admission state', async () => {
    const harness = makeHarness(await manifest('promoted_preferred'))
    await harness.coordinator.initialize(bootstrap())

    expect(harness.prepareModel).not.toHaveBeenCalled()
    expect(harness.coordinator.modelAdmissions('chat')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ enabled: true, executable: true, admissible: true, ready: false }),
      ])
    )

    await harness.coordinator.resolveTurn({ projectId: 'project-1', taskType: 'chat' })
    expect(harness.prepareModel).toHaveBeenCalledTimes(1)
    expect(harness.prepareModel).toHaveBeenCalledWith('qwen3.8-flash-next', expect.any(Object))
    expect(harness.coordinator.modelAdmissions('chat')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelReleaseId: 'qwen3.8-flash-next', admissible: true, ready: true }),
      ])
    )
  })

  it('refreshes expired policy through a fresh bootstrap so version rollouts do not require restart', async () => {
    const first = await manifest('metadata_only_default')
    const second = {
      ...first,
      catalogVersion: first.catalogVersion + 1,
      policyVersion: first.policyVersion + 1,
      generatedAt: '2026-08-30T13:00:00Z',
      expiresAt: '2026-08-30T14:00:00Z',
      payloadSha256: 'c'.repeat(64),
    } satisfies VerifiedLocalModelManifest
    const harness = makeHarness(first)
    vi.mocked(harness.dependencies.verifyManifest).mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const freshBootstrap = bootstrap()
    freshBootstrap.local_model_manifest!.catalog_version = second.catalogVersion
    freshBootstrap.local_model_manifest!.policy_version = second.policyVersion
    vi.mocked(harness.dependencies.bootstrap).mockResolvedValue(freshBootstrap)

    await harness.coordinator.initialize(bootstrap())
    harness.advance(31 * 60_000)
    await expect(harness.coordinator.resolveTurn({ projectId: 'project-1' })).rejects.toMatchObject({
      code: 'external_approval_required',
    })
    expect(harness.dependencies.bootstrap).toHaveBeenCalledTimes(1)
    expect(harness.dependencies.manifestSession).toHaveBeenCalledTimes(3)
    expect(vi.mocked(harness.dependencies.manifestSession).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(harness.dependencies.bootstrap).mock.invocationCallOrder[0]!
    )
    expect(harness.coordinator.status().manifest).toMatchObject({
      catalogVersion: second.catalogVersion,
      policyVersion: second.policyVersion,
      payloadSha256: second.payloadSha256,
    })
  })

  it('reuses the resident scope across task and conversation changes within one project and repository', async () => {
    const harness = makeHarness(await manifest('explicit_experiment'))
    await harness.coordinator.initialize(bootstrap())
    const turns = [
      { taskType: 'chat.general', contextId: 'conversation-1' },
      { taskType: 'coding.agent', contextId: 'conversation-2' },
      { taskType: 'planning.agent', contextId: 'conversation-3' },
    ]
    for (const turn of turns) {
      const input = { projectId: 'project-1', repoId: 'repo-1', ...turn }
      const route = await harness.coordinator.resolveTurn(input)
      await route.gateway.streamChatWithTools({ ...basicRequest, ...input })
    }
    expect(harness.requests).toHaveLength(3)
    expect(new Set(harness.requests.map(request => request.scopeDigest)).size).toBe(1)
    expect(new Set(harness.requests.map(request => request.modelReleaseId)).size).toBe(1)
    expect(harness.prepareModel).toHaveBeenCalledTimes(1)

    // A verified policy refresh within the same desktop session is not a new
    // process-ownership identity; its native catalog boundary is checked separately.
    await harness.coordinator.initialize(bootstrap())
    const refreshed = await harness.coordinator.resolveTurn({ projectId: 'project-1', repoId: 'repo-1' })
    await refreshed.gateway.streamChatWithTools(basicRequest)
    expect(harness.requests[3]?.scopeDigest).toBe(harness.requests[0]?.scopeDigest)
  })

  it.each(['project', 'repository', 'principal', 'device', 'server', 'desktop session'] as const)(
    'isolates the resident scope when the %s boundary changes',
    async boundary => {
      const harness = makeHarness(await manifest('explicit_experiment'))
      const input = { projectId: 'project-1', repoId: 'repo-1', contextId: 'conversation-1', taskType: 'chat' }
      await harness.coordinator.initialize(bootstrap())
      const first = await harness.coordinator.resolveTurn(input)
      await first.gateway.streamChatWithTools(basicRequest)

      const nextBootstrap = bootstrap()
      const nextInput = { ...input }
      if (boundary === 'project') nextInput.projectId = 'project-2'
      if (boundary === 'repository') nextInput.repoId = 'repo-2'
      if (boundary === 'device') nextBootstrap.device.id = 'device-2'
      if (boundary === 'principal') {
        nextBootstrap.user.id = 42
        vi.mocked(harness.dependencies.accountSnapshot).mockResolvedValue({
          ...account(),
          principalId: `account:v2:${'c'.repeat(64)}`,
          accountId: 42,
        })
      }
      if (boundary === 'server') {
        vi.mocked(harness.dependencies.accountSnapshot).mockResolvedValue(account('https://example.test/luczor-b'))
      }
      if (boundary === 'desktop session') {
        vi.mocked(harness.dependencies.manifestSession).mockResolvedValue('00000000-0000-4000-8000-000000000002')
      }
      await harness.coordinator.initialize(nextBootstrap)
      const second = await harness.coordinator.resolveTurn(nextInput)
      await second.gateway.streamChatWithTools({ ...basicRequest, projectId: nextInput.projectId })
      expect(harness.requests[0]?.scopeDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(harness.requests[1]?.scopeDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(harness.requests[0]?.scopeDigest).not.toBe(harness.requests[1]?.scopeDigest)
    }
  )

  it('binds scope digests to the verified account server instance including deployment path', async () => {
    const verified = await manifest('explicit_experiment')
    const first = makeHarness(verified, 'https://example.test/luczor-a')
    const second = makeHarness(verified, 'https://example.test/luczor-b')
    await first.coordinator.initialize(bootstrap())
    await second.coordinator.initialize(bootstrap())
    const firstRoute = await first.coordinator.resolveTurn({ projectId: 'project-1', taskType: 'chat' })
    const secondRoute = await second.coordinator.resolveTurn({ projectId: 'project-1', taskType: 'chat' })
    await firstRoute.gateway.streamChatWithTools(basicRequest)
    await secondRoute.gateway.streamChatWithTools(basicRequest)
    expect(first.requests[0]?.scopeDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(second.requests[0]?.scopeDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(first.requests[0]?.scopeDigest).not.toBe(second.requests[0]?.scopeDigest)
  })

  it('invalidates both local and external routing immediately when API identity changes', async () => {
    const harness = makeHarness(await manifest('explicit_experiment'))
    await harness.coordinator.initialize(bootstrap())
    await expect(harness.coordinator.resolveTurn({ projectId: 'project-1' })).resolves.toMatchObject({
      gateway: { target: 'local_llama_cpp' },
    })

    harness.coordinator.invalidateApiIdentity()
    const packetHash = await hashInferenceEgressRequest(basicRequest, 'desktop-1')
    for (const input of [
      { projectId: 'project-1' },
      {
        projectId: 'project-1',
        externalPackage: {
          messages: basicRequest.messages,
          apiConfig: account('https://other.example/luczor-b').config,
          packetHash,
          approval: {
            approvalId: 'approval-after-change',
            packetHash,
            expiresAt: '2026-08-30T12:31:00Z',
          },
        },
      },
    ]) {
      await expect(harness.coordinator.resolveTurn(input)).rejects.toMatchObject({
        code: 'local_policy_unavailable',
      })
    }
    expect(proxy).not.toHaveBeenCalled()
  })

  it('does not let a late server-A bootstrap overwrite a newer server-B generation', async () => {
    const first = await manifest('metadata_only_default')
    const second = {
      ...first,
      catalogVersion: first.catalogVersion + 1,
      policyVersion: first.policyVersion + 1,
      payloadSha256: 'd'.repeat(64),
    } satisfies VerifiedLocalModelManifest
    const harness = makeHarness(first)
    const firstEnvelope = deferred<Record<string, unknown>>()
    const secondEnvelope = deferred<Record<string, unknown>>()
    vi.mocked(harness.dependencies.fetchManifest)
      .mockImplementationOnce(() => firstEnvelope.promise)
      .mockImplementationOnce(() => secondEnvelope.promise)
    vi.mocked(harness.dependencies.verifyManifest).mockResolvedValue(second)
    vi.mocked(harness.dependencies.accountSnapshot).mockResolvedValue(account('https://example.test/luczor-b'))

    const bootstrapA = bootstrap()
    const bootstrapB = bootstrap()
    bootstrapB.local_model_manifest!.catalog_version = second.catalogVersion
    bootstrapB.local_model_manifest!.policy_version = second.policyVersion
    const initializeA = harness.coordinator.initialize(bootstrapA)
    await vi.waitFor(() => expect(harness.dependencies.fetchManifest).toHaveBeenCalledTimes(1))
    const initializeB = harness.coordinator.initialize(bootstrapB)
    await vi.waitFor(() => expect(harness.dependencies.fetchManifest).toHaveBeenCalledTimes(2))
    secondEnvelope.resolve({ server: 'B' })
    await initializeB
    firstEnvelope.resolve({ server: 'A' })
    await initializeA

    expect(harness.coordinator.status()).toMatchObject({
      mode: 'active',
      manifest: {
        catalogVersion: second.catalogVersion,
        policyVersion: second.policyVersion,
        payloadSha256: second.payloadSha256,
      },
    })
    expect(harness.dependencies.verifyManifest).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale lifecycle failure ticket after a newer bootstrap became active', async () => {
    const harness = makeHarness(await manifest('metadata_only_default'))
    const staleGeneration = harness.coordinator.beginBootstrap()
    await harness.coordinator.initialize(bootstrap())
    harness.coordinator.markBootstrapUnavailable('late-server-a-failure', staleGeneration)
    expect(harness.coordinator.status()).toMatchObject({
      mode: 'active',
      reason: 'signed_policy_active',
    })
  })

  it('ignores a stale bootstrap success response after a newer bootstrap became active', async () => {
    const first = await manifest('metadata_only_default')
    const second = {
      ...first,
      catalogVersion: first.catalogVersion + 1,
      policyVersion: first.policyVersion + 1,
      payloadSha256: 'e'.repeat(64),
    } satisfies VerifiedLocalModelManifest
    const harness = makeHarness(second)
    const staleGeneration = harness.coordinator.beginBootstrap()
    const bootstrapB = bootstrap()
    bootstrapB.local_model_manifest!.catalog_version = second.catalogVersion
    bootstrapB.local_model_manifest!.policy_version = second.policyVersion
    await harness.coordinator.initialize(bootstrapB)

    await expect(harness.coordinator.initialize(bootstrap(), staleGeneration)).resolves.toBe(false)
    expect(harness.coordinator.status()).toMatchObject({
      mode: 'active',
      manifest: { payloadSha256: second.payloadSha256 },
    })
    expect(harness.dependencies.fetchManifest).toHaveBeenCalledTimes(1)
  })

  it('blocks unavailable/invalid signed policy without calling Laravel', async () => {
    const harness = makeHarness(await manifest('metadata_only_default'))
    await harness.coordinator.initialize(bootstrap(false))
    await expect(harness.coordinator.resolveTurn({ projectId: 'project-1' })).rejects.toMatchObject({
      code: 'local_policy_unavailable',
    })
    expect(proxy).not.toHaveBeenCalled()

    const invalid = makeHarness(await manifest('metadata_only_default'))
    vi.mocked(invalid.dependencies.verifyManifest).mockRejectedValueOnce(new Error('invalid signature'))
    await invalid.coordinator.initialize(bootstrap())
    await expect(invalid.coordinator.resolveTurn({ projectId: 'project-1' })).rejects.toBeInstanceOf(
      LocalInferenceError
    )
    expect(proxy).not.toHaveBeenCalled()
  })

  it('repairs a failed startup for unchanged credentials and shares an overlapping retry', async () => {
    const harness = makeHarness(await manifest('metadata_only_default'))
    harness.coordinator.markBootstrapUnavailable()
    const pending = deferred<BootstrapResponse>()
    vi.mocked(harness.dependencies.bootstrap).mockReturnValueOnce(pending.promise)

    const first = harness.coordinator.reinitialize()
    const second = harness.coordinator.reinitialize()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(harness.dependencies.bootstrap).toHaveBeenCalledOnce())
    await expect(harness.coordinator.resolveTurn({ projectId: 'project-1' })).rejects.toThrow('gerade geladen')
    pending.resolve(bootstrap())

    await expect(first).resolves.toMatchObject({ ok: true, connected: true, stale: false, policy: { mode: 'active' } })
    expect(harness.dependencies.fetchManifest).toHaveBeenCalledOnce()
    expect(harness.prepareModel).not.toHaveBeenCalled()
    expect(proxy).not.toHaveBeenCalled()
  })

  it('shares a retry while the signed manifest is still being verified', async () => {
    const verified = await manifest('metadata_only_default')
    const harness = makeHarness(verified)
    const pending = deferred<VerifiedLocalModelManifest>()
    vi.mocked(harness.dependencies.verifyManifest).mockReturnValueOnce(pending.promise)
    const first = harness.coordinator.reinitialize()
    await vi.waitFor(() => expect(harness.dependencies.verifyManifest).toHaveBeenCalledOnce())
    expect(harness.coordinator.reinitialize()).toBe(first)
    pending.resolve(verified)
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(harness.dependencies.bootstrap).toHaveBeenCalledOnce()
  })

  it.each(['missing', 'unavailable', 'invalid'] as const)(
    'reports API connectivity separately from %s policy without exposing native errors',
    async state => {
      const harness = makeHarness(await manifest('metadata_only_default'))
      const boot = bootstrap(state !== 'unavailable')
      if (state === 'missing') delete boot.local_model_manifest
      if (state === 'invalid') {
        vi.mocked(harness.dependencies.verifyManifest).mockRejectedValueOnce(new Error('SECRET_NATIVE_CREDENTIAL'))
      }
      vi.mocked(harness.dependencies.bootstrap).mockResolvedValueOnce(boot)
      const result = await harness.coordinator.reinitialize()
      expect(result).toMatchObject({ ok: false, connected: true, stale: false, policy: { mode: 'blocked' } })
      expect(result.message).toContain('Server verbunden.')
      expect(result.message).toContain('Externer Fallback bleibt gesperrt.')
      expect(JSON.stringify(result)).not.toContain('SECRET_NATIVE_CREDENTIAL')
      expect(JSON.stringify(harness.coordinator.status())).not.toContain('SECRET_NATIVE_CREDENTIAL')
      expect(proxy).not.toHaveBeenCalled()
    }
  )

  it('does not let an obsolete retry report success or replace a newer account policy', async () => {
    const harness = makeHarness(await manifest('metadata_only_default'))
    const stale = deferred<BootstrapResponse>()
    vi.mocked(harness.dependencies.bootstrap).mockReturnValueOnce(stale.promise)
    const oldRequest = harness.coordinator.reinitialize()
    await vi.waitFor(() => expect(harness.dependencies.bootstrap).toHaveBeenCalledOnce())
    harness.coordinator.invalidateApiIdentity()
    const newRequest = harness.coordinator.reinitialize()
    await expect(newRequest).resolves.toMatchObject({ ok: true, stale: false })
    stale.resolve(bootstrap(false))
    await expect(oldRequest).resolves.toMatchObject({ ok: false, stale: true })
    expect(harness.coordinator.status().mode).toBe('active')
    expect(harness.dependencies.fetchManifest).toHaveBeenCalledOnce()
  })

  it.each([0, 401, 403])('reports bootstrap failure %s safely and permits a later retry', async status => {
    const harness = makeHarness(await manifest('metadata_only_default'))
    vi.mocked(harness.dependencies.bootstrap).mockRejectedValueOnce({ status, message: 'SECRET_HEADER' })
    const result = await harness.coordinator.reinitialize()
    expect(result).toMatchObject({ ok: false, connected: false, stale: false })
    expect(result.policy.reason).toBe(status === 0 ? 'server_unreachable' : 'authentication_failed')
    expect(JSON.stringify(result)).not.toContain('SECRET_HEADER')
    await expect(harness.coordinator.reinitialize()).resolves.toMatchObject({ ok: true })
  })

  it('normalizes unknown diagnostics rather than exposing arbitrary errors', () => {
    expect(JSON.stringify(localPolicyDiagnostic('blocked', 'SECRET_PRIVATE_PATH'))).not.toContain('SECRET_PRIVATE_PATH')
    expect(localPolicyDiagnostic('loading', 'bootstrap_pending').message).not.toContain('gesperrt')
  })

  it('does not probe an unavailable manifest during ordinary startup or background recovery', async () => {
    const harness = makeHarness(await manifest('metadata_only_default'))
    vi.mocked(harness.dependencies.bootstrap).mockResolvedValue(bootstrap(false))
    await harness.coordinator.initialize(bootstrap(false))
    await harness.coordinator.reinitialize()
    expect(harness.dependencies.accountSnapshot).not.toHaveBeenCalled()
    expect(harness.dependencies.fetchManifest).not.toHaveBeenCalled()
  })

  it.each([
    ['local_model_signing_key_path_unsafe', 'zulässigen Pfad'],
    ['local_model_signing_key_unreadable', 'nicht lesen'],
    ['local_model_signing_key_invalid', 'gültiger Modell-Signaturschlüssel'],
    ['local_model_signing_key_unsafe', 'RSA-Sicherheitsanforderungen'],
    ['local_model_signing_public_key_pin_missing', 'fehlt der SHA-256-Fingerabdruck'],
    ['local_model_signing_public_key_pin_invalid', 'Schlüsselfingerabdruck für die Modellrichtlinie ist ungültig'],
    ['local_model_signing_public_key_mismatch', 'passt nicht'],
    ['local_model_manifest_signing_failed', 'nicht signieren'],
  ])('reports safe signing diagnostic %s only on explicit connection testing', async (code, expected) => {
    const harness = makeHarness(await manifest('metadata_only_default'))
    vi.mocked(harness.dependencies.bootstrap).mockResolvedValueOnce(bootstrap(false))
    vi.mocked(harness.dependencies.fetchManifest).mockRejectedValueOnce({
      status: 503,
      code,
      message: 'SECRET_PRIVATE_KEY',
    })
    const result = await harness.coordinator.reinitialize({ diagnoseUnavailable: true })
    expect(result).toMatchObject({
      ok: false,
      connected: true,
      stale: false,
      policy: { mode: 'blocked', reason: code },
    })
    expect(result.message).toContain(expected)
    expect(JSON.stringify(result)).not.toContain('SECRET_PRIVATE_KEY')
    expect(harness.dependencies.fetchManifest).toHaveBeenCalledExactlyOnceWith(account().config)
    expect(harness.dependencies.verifyManifest).not.toHaveBeenCalled()
    expect(harness.prepareModel).not.toHaveBeenCalled()
    expect(proxy).not.toHaveBeenCalled()
  })

  it('keeps unexpected successful diagnostic envelopes blocked until a fresh valid bootstrap', async () => {
    const harness = makeHarness(await manifest('metadata_only_default'))
    vi.mocked(harness.dependencies.bootstrap).mockResolvedValueOnce(bootstrap(false))
    const result = await harness.coordinator.reinitialize({ diagnoseUnavailable: true })
    expect(result).toMatchObject({ ok: false, connected: true, policy: { reason: 'manifest_unavailable' } })
    expect(harness.dependencies.verifyManifest).not.toHaveBeenCalled()
    await expect(harness.coordinator.resolveTurn({ projectId: 'project-1' })).rejects.toMatchObject({
      code: 'local_policy_unavailable',
    })
    await expect(harness.coordinator.reinitialize()).resolves.toMatchObject({ ok: true })
    expect(harness.dependencies.verifyManifest).toHaveBeenCalledOnce()
  })

  it.each([
    { status: 503, code: 'SECRET_UNTRUSTED_CODE', message: 'SECRET_BODY' },
    { status: 500, code: 'local_model_signing_key_unreadable', message: 'SECRET_BODY' },
  ])('does not trust unknown diagnostics or signing codes outside HTTP 503', async error => {
    const harness = makeHarness(await manifest('metadata_only_default'))
    vi.mocked(harness.dependencies.bootstrap).mockResolvedValueOnce(bootstrap(false))
    vi.mocked(harness.dependencies.fetchManifest).mockRejectedValueOnce(error)
    const result = await harness.coordinator.reinitialize({ diagnoseUnavailable: true })
    expect(result.policy.reason).toBe('manifest_unavailable')
    expect(JSON.stringify(result)).not.toContain('SECRET_')
  })

  it('requires the diagnostic account to match the authenticated bootstrap', async () => {
    const harness = makeHarness(await manifest('metadata_only_default'))
    vi.mocked(harness.dependencies.bootstrap).mockResolvedValueOnce(bootstrap(false))
    vi.mocked(harness.dependencies.accountSnapshot).mockResolvedValueOnce({ ...account(), accountId: 99 })
    const result = await harness.coordinator.reinitialize({ diagnoseUnavailable: true })
    expect(result.policy.reason).toBe('account_verification_failed')
    expect(harness.dependencies.fetchManifest).not.toHaveBeenCalled()
  })

  it('stops before diagnostic fetch when identity changes during account verification', async () => {
    const harness = makeHarness(await manifest('metadata_only_default'))
    const pending = deferred<VerifiedAccountSnapshot>()
    vi.mocked(harness.dependencies.bootstrap).mockResolvedValueOnce(bootstrap(false))
    vi.mocked(harness.dependencies.accountSnapshot).mockReturnValueOnce(pending.promise)
    const result = harness.coordinator.reinitialize({ diagnoseUnavailable: true })
    await vi.waitFor(() => expect(harness.dependencies.accountSnapshot).toHaveBeenCalledOnce())
    harness.coordinator.invalidateApiIdentity()
    pending.resolve(account())
    await expect(result).resolves.toMatchObject({ ok: false, stale: true })
    expect(harness.dependencies.fetchManifest).not.toHaveBeenCalled()
  })

  it('ignores a late diagnostic failure after a newer account becomes active', async () => {
    const harness = makeHarness(await manifest('metadata_only_default'))
    let rejectOld!: (reason: unknown) => void
    vi.mocked(harness.dependencies.bootstrap).mockResolvedValueOnce(bootstrap(false))
    vi.mocked(harness.dependencies.fetchManifest).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectOld = reject
      })
    )
    const oldResult = harness.coordinator.reinitialize({ diagnoseUnavailable: true })
    await vi.waitFor(() => expect(harness.dependencies.fetchManifest).toHaveBeenCalledOnce())
    harness.coordinator.invalidateApiIdentity()
    await expect(harness.coordinator.reinitialize()).resolves.toMatchObject({ ok: true })
    rejectOld({ status: 503, code: 'local_model_signing_key_unreadable' })
    await expect(oldResult).resolves.toMatchObject({ ok: false, stale: true })
    expect(harness.coordinator.status().mode).toBe('active')
  })

  it('upgrades an overlapping background recovery to one explicit diagnostic check', async () => {
    const harness = makeHarness(await manifest('metadata_only_default'))
    const pending = deferred<BootstrapResponse>()
    vi.mocked(harness.dependencies.bootstrap).mockReturnValueOnce(pending.promise)
    const background = harness.coordinator.reinitialize()
    const explicit = harness.coordinator.reinitialize({ diagnoseUnavailable: true })
    expect(explicit).toBe(background)
    await vi.waitFor(() => expect(harness.dependencies.bootstrap).toHaveBeenCalledOnce())
    pending.resolve(bootstrap(false))
    await expect(explicit).resolves.toMatchObject({ ok: false, connected: true })
    expect(harness.dependencies.fetchManifest).toHaveBeenCalledOnce()
  })

  it.each([true, false, undefined])(
    'blocks servers without signed manifest discovery (required=%s)',
    async required => {
      const harness = makeHarness(await manifest('metadata_only_default'))
      const oldBootstrap = bootstrap()
      delete oldBootstrap.local_model_manifest
      if (required === true) oldBootstrap.routing.local_model_manifest_required = true
      else if (required === false) {
        ;(oldBootstrap.routing as Record<string, unknown>).local_model_manifest_required = false
      } else delete oldBootstrap.routing.local_model_manifest_required

      await harness.coordinator.initialize(oldBootstrap)
      expect(harness.dependencies.manifestSession).toHaveBeenCalledTimes(1)
      await expect(
        harness.coordinator.resolveTurn({
          projectId: 'project-1',
          externalPackage: {
            messages: basicRequest.messages,
            apiConfig: account().config,
            packetHash: 'a'.repeat(64),
            approval: {
              approvalId: 'approval-1',
              packetHash: 'a'.repeat(64),
              expiresAt: '2026-08-30T12:31:00Z',
            },
          },
        })
      ).rejects.toMatchObject({ code: 'local_policy_unavailable' })
      expect(proxy).not.toHaveBeenCalled()
    }
  )

  it('blocks local-only context even when an external package was constructed', async () => {
    const harness = makeHarness(await manifest('metadata_only_default'))
    await harness.coordinator.initialize(bootstrap())
    const packetHash = await hashInferenceEgressRequest(basicRequest, 'desktop-1')
    await expect(
      harness.coordinator.resolveTurn({
        projectId: 'project-1',
        contextEgress: 'local_only',
        externalPackage: {
          messages: basicRequest.messages,
          apiConfig: account().config,
          packetHash,
          approval: { approvalId: 'approval-1', packetHash, expiresAt: '2026-08-30T12:31:00Z' },
        },
      })
    ).rejects.toMatchObject({ code: 'local_only_blocked' })
    expect(proxy).not.toHaveBeenCalled()
  })

  it('allows one exact approved external request and never leaks a later tool result', async () => {
    const packetHash = await hashInferenceEgressRequest(basicRequest, 'desktop-1')
    const gateway = packetBoundLaravelGateway(
      packetHash,
      'approval-1',
      '2026-08-30T12:31:00Z',
      account().config,
      () => new Date('2026-08-30T12:30:00Z')
    )
    await expect(gateway.streamChatWithTools(basicRequest)).resolves.toMatchObject({ content: 'extern' })
    expect(proxy).toHaveBeenCalledTimes(1)

    const withLocalToolResult: InferenceRequest = {
      ...basicRequest,
      messages: [
        ...basicRequest.messages,
        { role: 'tool', tool_call_id: 'call-1', name: 'local_secret_tool', content: 'local-only result' },
      ],
    }
    await expect(gateway.streamChatWithTools(withLocalToolResult)).rejects.toMatchObject({
      code: 'external_reapproval_required',
    })
    expect(proxy).toHaveBeenCalledTimes(1)
  })
})
