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
  packetBoundLaravelGateway,
  type LocalInferenceCoordinatorDependencies,
} from '@/services/inference/coordinator'
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

describe('local inference coordinator and approved external gateway', () => {
  beforeEach(() => {
    proxy.mockReset()
    proxy.mockResolvedValue({ content: 'extern', toolCalls: [], rawToolCalls: [], finishReason: 'stop' })
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

  it('refreshes expired native readiness before a later turn', async () => {
    const harness = makeHarness(await manifest('explicit_experiment'))
    await harness.coordinator.initialize(bootstrap())
    expect(harness.prepareModel).toHaveBeenCalledTimes(1)
    harness.advance(11 * 60_000)
    await harness.coordinator.resolveTurn({ projectId: 'project-1', taskType: 'chat' })
    expect(harness.prepareModel).toHaveBeenCalledTimes(2)
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
