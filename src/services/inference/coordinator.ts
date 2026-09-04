import type { BootstrapResponse, LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import { localModelManifestWithApiConfig, LuczorApi } from '@/services/api/luczorApi'
import {
  deriveLocalModelManifestTrustDomain,
  getVerifiedAccountSnapshot,
  type VerifiedAccountSnapshot,
} from '@/services/accountPrincipal'
import { assessModelCapacity, type CapacityAssessment, type HardwareSnapshot } from '@/services/inference/capacity'
import { laravelInferenceGateway } from '@/services/inference/gateways'
import { hashLaravelProxyBody } from '@/services/inference/laravelProxyBody'
import {
  decideHybridRoute,
  type ExternalEgressApproval,
  type HybridRoutingSettings,
  type RouteDecision,
} from '@/services/inference/hybridRouter'
import {
  LocalInferenceError,
  LocalModelManager,
  type LocalCatalogBinding,
  type LocalReadinessEvidence,
} from '@/services/inference/localModelManager'
import {
  isExecutableLocalModel,
  verifyLocalModelManifest,
  type LocalModelReleaseManifest,
  type VerifiedLocalModelManifest,
} from '@/services/inference/modelManifest'
import {
  beginNativeManifestAcceptance,
  getNativeHardwareSnapshot,
  prepareNativeLocalModel,
  tauriManifestVerifier,
  TauriLocalRuntimeTransport,
} from '@/services/inference/tauriLocalRuntime'
import type { ApprovedProxyConfig, InferenceGateway, InferenceRequest, WireMessage } from '@/services/inference/types'

export type ExternalTurnPackage = {
  /** Provider-safe messages assembled independently from local-only context. */
  messages: WireMessage[]
  packetHash: string
  approval: ExternalEgressApproval
  /** Immutable verified destination and credential identity; never serialized. */
  apiConfig: ApprovedProxyConfig
}

export type TurnRoutingInput = {
  projectId: string
  contextId?: string
  repoId?: string
  taskType?: string
  contextEgress?: 'local_only' | 'external_allowed'
  routingSettings?: Partial<HybridRoutingSettings>
  externalPackage?: ExternalTurnPackage
}

export type ResolvedTurnRoute = {
  gateway: InferenceGateway
  replacementMessages?: WireMessage[]
  decision?: RouteDecision
  externalOneShot?: true
}

type Discovery = NonNullable<BootstrapResponse['local_model_manifest']>
type CoordinatorMode = 'loading' | 'active' | 'blocked'

export type LocalInferenceCoordinatorDependencies = {
  bootstrap: () => Promise<BootstrapResponse>
  fetchManifest: (config: LuczorApiConfigSnapshot) => Promise<Record<string, unknown>>
  verifyManifest: typeof verifyLocalModelManifest
  hardwareSnapshot: () => Promise<HardwareSnapshot>
  prepareModel: (modelReleaseId: string, catalogBinding: LocalCatalogBinding) => Promise<LocalReadinessEvidence>
  accountSnapshot: () => Promise<VerifiedAccountSnapshot | null>
  manifestSession: (acceptanceGeneration: number) => Promise<string>
  manager: LocalModelManager
  now: () => Date
}

const DEFAULT_ROUTING_SETTINGS: HybridRoutingSettings = {
  preference: 'ask_external',
  experimentalFlashNext: false,
  allowDegradedLocal: false,
}

function exactDiscovery(input: BootstrapResponse['local_model_manifest']): Discovery {
  if (!input || typeof input !== 'object') throw new Error('Local-model discovery is missing.')
  const actual = Object.keys(input).sort()
  const expected = ['available', 'catalog_version', 'key_id', 'policy_version', 'schema_version', 'url']
  if (actual.length !== expected.length || actual.join('\0') !== expected.join('\0')) {
    throw new Error('Local-model discovery schema is invalid.')
  }
  if (
    input.url !== '/api/v1/local-model/manifest' ||
    input.schema_version !== 1 ||
    !Number.isSafeInteger(input.catalog_version) ||
    input.catalog_version < 1 ||
    !Number.isSafeInteger(input.policy_version) ||
    input.policy_version < 1 ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.key_id) ||
    typeof input.available !== 'boolean'
  ) {
    throw new Error('Local-model discovery values are invalid.')
  }
  return input
}

function executableCapacity(model: LocalModelReleaseManifest) {
  if (!model.artifact || !isExecutableLocalModel(model)) return null
  const policy = model.capacityPolicy
  if (
    policy.minTotalRamBytes == null ||
    policy.minAvailableRamBytes == null ||
    policy.minVramBytes == null ||
    policy.minStorageFreeBytes == null
  ) {
    return null
  }
  return {
    artifactSizeBytes: model.artifact.sizeBytes,
    policy: {
      minTotalRamBytes: policy.minTotalRamBytes,
      minAvailableRamBytes: policy.minAvailableRamBytes,
      minVramBytes: policy.minVramBytes,
      minStorageFreeBytes: policy.minStorageFreeBytes,
      storageClass: model.artifact.storageClass,
    },
  }
}

function canonicalScope(input: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right))))
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashInferenceEgressRequest(request: InferenceRequest, clientId: string): Promise<string> {
  return hashLaravelProxyBody(request, clientId, true)
}

/** One approved hash authorizes exactly one exact provider request. */
export function packetBoundLaravelGateway(
  expectedPacketHash: string,
  approvalId: string,
  approvalExpiresAt: string,
  approvedApiConfig: ApprovedProxyConfig,
  now: () => Date = () => new Date()
): InferenceGateway {
  let consumed = false
  return Object.freeze({
    id: `laravel:approved:${approvalId}`,
    target: 'laravel_proxy' as const,
    async streamChatWithTools(request: InferenceRequest) {
      const expires = Date.parse(approvalExpiresAt)
      if (!Number.isFinite(expires) || expires <= now().getTime()) {
        throw new LocalInferenceError(
          'Die externe Paketfreigabe ist abgelaufen.',
          'external_approval_expired',
          false,
          false
        )
      }
      if (consumed) {
        throw new LocalInferenceError(
          'Eine weitere externe Runde benötigt ein neues freigegebenes Kontextpaket.',
          'external_reapproval_required',
          false,
          false
        )
      }
      const actualPacketHash = await hashInferenceEgressRequest(request, approvedApiConfig.clientId)
      if (actualPacketHash !== expectedPacketHash) {
        throw new LocalInferenceError(
          'Die tatsächlich zu sendende externe Anfrage weicht vom freigegebenen Paket ab.',
          'egress_hash_mismatch',
          false,
          false
        )
      }
      consumed = true
      return laravelInferenceGateway.streamChatWithTools({
        ...request,
        expectedProxyBodySha256: expectedPacketHash,
        expectedProxyConfig: approvedApiConfig,
        expectedProxyApprovalExpiresAt: approvalExpiresAt,
      })
    },
  })
}

function cloneMessages(messages: readonly WireMessage[]): WireMessage[] {
  return messages.map(message =>
    message.role === 'assistant' && message.tool_calls
      ? { ...message, tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function } })) }
      : { ...message }
  )
}

function capabilityForTask(taskType?: string): string {
  const normalized = String(taskType ?? '').toLocaleLowerCase('en-US')
  if (normalized.includes('plan')) return 'planning'
  if (normalized.includes('reason') || normalized.includes('analysis')) return 'reasoning'
  if (normalized.includes('execute') || normalized.includes('action') || normalized.includes('tool')) {
    return 'execution_preparation'
  }
  return 'chat'
}

export class LocalInferenceCoordinator {
  private mode: CoordinatorMode = 'blocked'
  private reason = 'bootstrap_not_initialized'
  private manifest?: VerifiedLocalModelManifest
  private discovery?: Discovery
  private bootstrap?: BootstrapResponse
  private account?: VerifiedAccountSnapshot
  private assessments = new Map<string, CapacityAssessment>()
  private readiness = new Map<string, LocalReadinessEvidence>()
  private catalogBinding?: LocalCatalogBinding
  private generation = 0

  constructor(private readonly dependencies: LocalInferenceCoordinatorDependencies) {}

  beginBootstrap(): number {
    this.dependencies.manager.invalidateCatalogBoundary()
    this.generation += 1
    this.clearPolicyState()
    this.mode = 'loading'
    this.reason = 'bootstrap_pending'
    return this.generation
  }

  markBootstrapUnavailable(reason = 'bootstrap_unavailable', expectedGeneration?: number): void {
    if (expectedGeneration !== undefined && expectedGeneration !== this.generation) return
    this.dependencies.manager.invalidateCatalogBoundary()
    this.generation += 1
    this.clearPolicyState()
    this.mode = 'blocked'
    this.reason = reason
  }

  invalidateApiIdentity(): number {
    this.markBootstrapUnavailable('api_identity_changed')
    return this.generation
  }

  status(): { mode: CoordinatorMode; reason: string; manifest?: VerifiedLocalModelManifest } {
    return { mode: this.mode, reason: this.reason, manifest: this.manifest }
  }

  async initialize(bootstrap: BootstrapResponse, expectedPendingGeneration?: number): Promise<boolean> {
    if (expectedPendingGeneration !== undefined && expectedPendingGeneration !== this.generation) {
      return false
    }
    this.dependencies.manager.invalidateCatalogBoundary()
    const generation = ++this.generation
    this.clearPolicyState()
    this.mode = 'loading'
    this.reason = 'bootstrap_pending'
    this.bootstrap = bootstrap

    try {
      const acceptanceSessionId = await this.dependencies.manifestSession(generation)
      if (!this.isCurrent(generation)) return false
      if (!bootstrap.local_model_manifest) {
        this.blockGeneration(generation, 'manifest_discovery_missing')
        return true
      }
      const discovery = exactDiscovery(bootstrap.local_model_manifest)
      this.discovery = discovery
      if (!discovery.available) throw new Error('Local-model manifest is unavailable.')
      const account = await this.dependencies.accountSnapshot()
      if (!this.isCurrent(generation)) return false
      if (!account || account.accountId !== bootstrap.user.id) {
        throw new Error('Verified account principal does not match bootstrap.')
      }
      const trustDomain = await deriveLocalModelManifestTrustDomain(account)
      if (!this.isCurrent(generation)) return false
      const envelope = await this.dependencies.fetchManifest(account.config)
      if (!this.isCurrent(generation)) return false
      const verified = await this.dependencies.verifyManifest(envelope, tauriManifestVerifier, {
        trustDomain,
        acceptanceSessionId,
        acceptanceGeneration: generation,
        expectedKeyId: discovery.key_id,
        minimumCatalogVersion: discovery.catalog_version,
        minimumPolicyVersion: discovery.policy_version,
        expectedSchemaVersion: discovery.schema_version,
        expectedCatalogVersion: discovery.catalog_version,
        expectedPolicyVersion: discovery.policy_version,
        now: this.dependencies.now(),
      })
      if (!this.isCurrent(generation)) return false
      if (
        verified.catalogVersion !== discovery.catalog_version ||
        verified.policyVersion !== discovery.policy_version ||
        verified.schemaVersion !== discovery.schema_version
      ) {
        throw new Error('Bootstrap discovery and signed manifest versions differ.')
      }

      const snapshot = await this.dependencies.hardwareSnapshot()
      if (!this.isCurrent(generation)) return false
      const assessments = new Map<string, CapacityAssessment>()
      for (const model of verified.models) {
        const capacity = executableCapacity(model)
        if (!capacity) continue
        assessments.set(
          model.id,
          assessModelCapacity({
            snapshot,
            modelReleaseId: model.id,
            policy: capacity.policy,
            artifactSizeBytes: capacity.artifactSizeBytes,
            now: this.dependencies.now(),
            validForMs: Math.max(1_000, Date.parse(verified.expiresAt) - this.dependencies.now().getTime()),
          })
        )
      }

      if (!this.isCurrent(generation)) return false
      this.account = account
      this.manifest = verified
      this.catalogBinding = Object.freeze({
        acceptanceSessionId,
        acceptanceGeneration: generation,
        manifestPayloadSha256: verified.payloadSha256,
      })
      this.assessments = assessments
      this.readiness.clear()
      const candidates = [verified.routing.defaultModelId, ...verified.routing.fallbackModelIds]
      for (const modelId of [...new Set(candidates)]) {
        await this.prepareIfEligible(modelId, generation)
        if (!this.isCurrent(generation)) return false
      }
      this.mode = 'active'
      this.reason = 'signed_policy_active'
      return true
    } catch (error) {
      this.blockGeneration(generation, error instanceof Error ? error.message : 'manifest_initialization_failed')
      return this.isCurrent(generation)
    }
  }

  async resolveTurn(input: TurnRoutingInput): Promise<ResolvedTurnRoute> {
    let generation = this.generation
    if (this.mode !== 'active' || !this.manifest || !this.bootstrap || !this.account) {
      throw new LocalInferenceError(
        'Die signierte lokale Modellrichtlinie ist nicht verfügbar; externer Fallback bleibt gesperrt.',
        'local_policy_unavailable',
        false,
        false
      )
    }
    if (Date.parse(this.manifest.expiresAt) <= this.dependencies.now().getTime()) {
      try {
        const refreshGeneration = this.beginBootstrap()
        generation = refreshGeneration
        await this.dependencies.manifestSession(refreshGeneration)
        if (!this.isCurrent(refreshGeneration)) {
          throw new Error('API identity changed before policy refresh.')
        }
        const freshBootstrap = await this.dependencies.bootstrap()
        if (!this.isCurrent(refreshGeneration)) throw new Error('API identity changed during policy refresh.')
        await this.initialize(freshBootstrap, refreshGeneration)
        generation = this.generation
      } catch {
        if (this.isCurrent(generation)) this.markBootstrapUnavailable('manifest_refresh_failed')
      }
      if (this.mode !== 'active' || !this.manifest) {
        throw new LocalInferenceError('Das lokale Modellmanifest ist abgelaufen.', 'manifest_expired', false, false)
      }
    }

    const settings = { ...DEFAULT_ROUTING_SETTINGS, ...input.routingSettings }
    await this.refreshCapacityIfStale(generation)
    this.requireActiveGeneration(generation)
    for (const modelId of [this.manifest.routing.defaultModelId, ...this.manifest.routing.fallbackModelIds]) {
      await this.prepareIfEligible(modelId, generation)
      this.requireActiveGeneration(generation)
    }
    if (settings.experimentalFlashNext) {
      const experimentalId = this.manifest.routing.experimentalModelIds[0]
      if (experimentalId) await this.prepareIfEligible(experimentalId, generation)
      this.requireActiveGeneration(generation)
    }
    const externalHash = input.externalPackage?.packetHash

    const health = new Map(
      this.manifest.models.map(model => [model.id, this.dependencies.manager.getHealth(model)] as const)
    )
    const decision = decideHybridRoute({
      manifest: this.manifest,
      assessments: this.assessments,
      readiness: this.readiness,
      health,
      settings,
      contextEgress: input.contextEgress ?? 'external_allowed',
      externalApproval: input.externalPackage?.approval,
      expectedEgressPacketHash: externalHash,
      requiredCapability: capabilityForTask(input.taskType),
      now: this.dependencies.now(),
    })

    if (decision.target === 'local_llama_cpp' && decision.modelReleaseId) {
      const release = this.manifest.models.find(model => model.id === decision.modelReleaseId)
      const readiness = this.readiness.get(decision.modelReleaseId)
      if (!release || !readiness) throw new Error('Selected local release lost readiness.')
      const scopeDigest = await this.scopeDigest(input, generation)
      const catalogBinding = this.catalogBinding
      if (!catalogBinding) throw new Error('Selected local release lost its native catalog binding.')
      return {
        gateway: this.dependencies.manager.gateway(release, readiness, catalogBinding, scopeDigest),
        decision,
      }
    }
    if (decision.target === 'laravel_proxy' && input.externalPackage) {
      const approvedConfig = input.externalPackage.apiConfig
      if (
        approvedConfig.clientId !== this.account.config.clientId ||
        approvedConfig.baseUrl !== this.account.config.baseUrl ||
        approvedConfig.deviceKey !== this.account.config.deviceKey
      ) {
        throw new LocalInferenceError(
          'Die externe Freigabe gehört nicht zur aktuellen Client-Identität.',
          'egress_client_mismatch',
          false,
          false
        )
      }
      return {
        gateway: packetBoundLaravelGateway(
          input.externalPackage.packetHash,
          input.externalPackage.approval.approvalId,
          input.externalPackage.approval.expiresAt,
          approvedConfig,
          this.dependencies.now
        ),
        replacementMessages: cloneMessages(input.externalPackage.messages),
        decision,
        externalOneShot: true,
      }
    }
    throw new LocalInferenceError(
      'Keine zulässige Inferenzroute ist für diesen Turn verfügbar.',
      decision.reason,
      false,
      false
    )
  }

  private async prepareIfEligible(modelId: string, generation = this.generation): Promise<void> {
    if (!this.isCurrent(generation) || !this.manifest || !this.catalogBinding) return
    const manifestHash = this.manifest.payloadSha256
    const catalogBinding = this.catalogBinding
    const current = this.readiness.get(modelId)
    if (
      current?.ready &&
      Number.isFinite(current.validUntilMs) &&
      current.validUntilMs > this.dependencies.now().getTime() &&
      current.manifestPayloadSha256 === manifestHash
    ) {
      return
    }
    this.readiness.delete(modelId)
    if (this.assessments.get(modelId)?.status !== 'eligible') return
    try {
      const readiness = await this.dependencies.prepareModel(modelId, catalogBinding)
      if (
        this.isCurrent(generation) &&
        this.manifest?.payloadSha256 === manifestHash &&
        this.catalogBinding === catalogBinding
      ) {
        this.readiness.set(modelId, readiness)
      }
    } catch {
      if (this.isCurrent(generation)) this.readiness.delete(modelId)
    }
  }

  private async refreshCapacityIfStale(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || !this.manifest) return
    const manifest = this.manifest
    const now = this.dependencies.now().getTime()
    const stale = manifest.models.some(model => {
      const capacity = executableCapacity(model)
      const assessment = this.assessments.get(model.id)
      return capacity && (!assessment || assessment.validUntilMs <= now)
    })
    if (!stale) return
    const snapshot = await this.dependencies.hardwareSnapshot()
    if (!this.isCurrent(generation) || this.manifest?.payloadSha256 !== manifest.payloadSha256) return
    for (const model of manifest.models) {
      const capacity = executableCapacity(model)
      if (!capacity) continue
      this.assessments.set(
        model.id,
        assessModelCapacity({
          snapshot,
          modelReleaseId: model.id,
          policy: capacity.policy,
          artifactSizeBytes: capacity.artifactSizeBytes,
          now: this.dependencies.now(),
          validForMs: Math.max(1_000, Date.parse(manifest.expiresAt) - this.dependencies.now().getTime()),
        })
      )
    }
  }

  private async scopeDigest(input: TurnRoutingInput, generation: number): Promise<string> {
    const bootstrap = this.bootstrap
    const account = this.account
    const deviceId = bootstrap?.device.id
    const principalId = account?.principalId ?? ''
    if (!principalId || !input.projectId.trim()) {
      throw new LocalInferenceError('Der lokale Inferenzscope ist unvollständig.', 'scope_unavailable', false, false)
    }
    const digest = await sha256(
      canonicalScope({
        schema: 'luczor-local-scope-v1',
        principalId,
        deviceId: deviceId ?? 'none',
        serverInstance: account!.serverInstance,
        projectId: input.projectId,
        contextId: input.contextId ?? 'none',
        repoId: input.repoId ?? 'none',
        taskType: input.taskType ?? 'chat.general',
      })
    )
    this.requireActiveGeneration(generation)
    return digest
  }

  private clearPolicyState(): void {
    this.bootstrap = undefined
    this.discovery = undefined
    this.manifest = undefined
    this.account = undefined
    this.catalogBinding = undefined
    this.assessments.clear()
    this.readiness.clear()
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation
  }

  private blockGeneration(generation: number, reason: string): void {
    if (!this.isCurrent(generation)) return
    this.clearPolicyState()
    this.mode = 'blocked'
    this.reason = reason
  }

  private requireActiveGeneration(generation: number): void {
    if (
      !this.isCurrent(generation) ||
      this.mode !== 'active' ||
      !this.manifest ||
      !this.bootstrap ||
      !this.account ||
      !this.catalogBinding
    ) {
      throw new LocalInferenceError(
        'Die Server-/Account-Identität hat sich während der Routenentscheidung geändert.',
        'local_policy_unavailable',
        false,
        false
      )
    }
  }
}

const defaultManager = new LocalModelManager(new TauriLocalRuntimeTransport())

export const localInferenceCoordinator = new LocalInferenceCoordinator({
  bootstrap: () => LuczorApi.bootstrap(),
  fetchManifest: config => localModelManifestWithApiConfig(config),
  verifyManifest: verifyLocalModelManifest,
  hardwareSnapshot: getNativeHardwareSnapshot,
  prepareModel: prepareNativeLocalModel,
  accountSnapshot: getVerifiedAccountSnapshot,
  manifestSession: beginNativeManifestAcceptance,
  manager: defaultManager,
  now: () => new Date(),
})

export async function beginLocalInferenceBootstrap(): Promise<number> {
  const generation = localInferenceCoordinator.beginBootstrap()
  try {
    await beginNativeManifestAcceptance(generation)
    return generation
  } catch (error) {
    localInferenceCoordinator.markBootstrapUnavailable('manifest_session_unavailable', generation)
    throw error
  }
}

export function initializeLocalInference(
  bootstrap: BootstrapResponse,
  expectedPendingGeneration?: number
): Promise<boolean> {
  return localInferenceCoordinator.initialize(bootstrap, expectedPendingGeneration)
}

export function markLocalInferenceBootstrapUnavailable(expectedGeneration?: number): void {
  localInferenceCoordinator.markBootstrapUnavailable('bootstrap_unavailable', expectedGeneration)
}

export async function invalidateLocalInferenceApiIdentity(): Promise<void> {
  const generation = localInferenceCoordinator.invalidateApiIdentity()
  await beginNativeManifestAcceptance(generation)
}

/** Re-bootstrap only after a changed server/device identity has been persisted. */
export async function reinitializeLocalInferenceForCurrentApi(): Promise<void> {
  const generation = await beginLocalInferenceBootstrap()
  try {
    await initializeLocalInference(await LuczorApi.bootstrap(), generation)
  } catch (error) {
    markLocalInferenceBootstrapUnavailable(generation)
    throw error
  }
}

export function resolveInferenceRouteForTurn(input: TurnRoutingInput): Promise<ResolvedTurnRoute> {
  return localInferenceCoordinator.resolveTurn(input)
}
