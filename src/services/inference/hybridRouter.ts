import type { CapacityAssessment } from '@/services/inference/capacity'
import type { InferenceTarget } from '@/services/inference/types'
import type { LocalModelHealth, LocalReadinessEvidence } from '@/services/inference/localModelManager'
import {
  FLASH_NEXT_MODEL_ID,
  type LocalModelReleaseManifest,
  type VerifiedLocalModelManifest,
} from '@/services/inference/modelManifest'

export const FLASH_EXPERIMENT_SETTING_KEY = 'local_model_flash_experiment'

export type RoutingPreference = 'local_only' | 'ask_external' | 'allow_external'

export type HybridRoutingSettings = {
  preference: RoutingPreference
  experimentalFlashNext: boolean
  allowDegradedLocal: boolean
}

export type ExternalEgressApproval = {
  approvalId: string
  packetHash: string
  expiresAt: string
}

export type RouteDecisionReason =
  | 'experimental_local_selected'
  | 'promoted_local_selected'
  | 'stable_local_fallback_selected'
  | 'local_capacity_unavailable'
  | 'local_model_cooldown'
  | 'external_approval_required'
  | 'external_approved'
  | 'local_only_blocked'
  | 'external_policy_blocked'

export type RouteDecision = {
  id: string
  policyVersion: number
  target: InferenceTarget | 'blocked'
  modelReleaseId?: string
  reason: RouteDecisionReason
  capacityAssessmentId?: string
  egressPacketHash?: string
  approvalId?: string
}

/** Preparation and routing must accept exactly the same signed readiness evidence. */
export function hasVerifiedLocalReadiness(
  model: LocalModelReleaseManifest | undefined,
  readiness: LocalReadinessEvidence | undefined,
  manifestPayloadSha256: string,
  nowMs: number
): boolean {
  return !!(
    model?.artifact &&
    model.runtime &&
    readiness?.ready &&
    readiness.modelReleaseId === model.id &&
    readiness.manifestPayloadSha256 === manifestPayloadSha256 &&
    readiness.artifactSha256 === model.artifact.sha256 &&
    readiness.runtimeSha256 === model.runtime.sha256 &&
    Number.isFinite(readiness.validUntilMs) &&
    readiness.validUntilMs > nowMs
  )
}

function availableLocally(
  model: LocalModelReleaseManifest | undefined,
  assessment: CapacityAssessment | undefined,
  health: LocalModelHealth | undefined,
  readiness: LocalReadinessEvidence | undefined,
  manifestPayloadSha256: string,
  settings: HybridRoutingSettings,
  requiredCapability: string,
  now: Date
): boolean {
  if (
    !model?.enabled ||
    !model.capabilities.includes(requiredCapability) ||
    model.executionTarget !== 'local_llama_cpp' ||
    !hasVerifiedLocalReadiness(model, readiness, manifestPayloadSha256, now.getTime()) ||
    !assessment ||
    assessment.modelReleaseId !== model.id ||
    !Number.isFinite(assessment.validUntilMs) ||
    assessment.validUntilMs <= now.getTime() ||
    !health ||
    health.modelReleaseId !== model.id
  ) {
    return false
  }
  if (assessment.status === 'ineligible' || (assessment.status === 'degraded' && !settings.allowDegradedLocal)) {
    return false
  }
  return health?.state !== 'cooldown' && health?.state !== 'error'
}

function validApproval(approval: ExternalEgressApproval | undefined, now: Date): approval is ExternalEgressApproval {
  return !!(
    approval?.approvalId.trim() &&
    /^[a-f0-9]{64}$/.test(approval.packetHash) &&
    Date.parse(approval.expiresAt) > now.getTime()
  )
}

/** Pure, deterministic routing. It never invokes a gateway and therefore cannot silently fall back. */
export function decideHybridRoute(input: {
  manifest: VerifiedLocalModelManifest
  assessments: ReadonlyMap<string, CapacityAssessment>
  health: ReadonlyMap<string, LocalModelHealth>
  readiness: ReadonlyMap<string, LocalReadinessEvidence>
  settings: HybridRoutingSettings
  contextEgress: 'local_only' | 'external_allowed'
  externalApproval?: ExternalEgressApproval
  /** Hash of the external package assembled for this exact turn. */
  expectedEgressPacketHash?: string
  now?: Date
  decisionId?: string
  requiredCapability?: string
  /** An explicitly selected specialist route; never grants external permission. */
  preferExternal?: boolean
}): RouteDecision {
  const now = input.now ?? new Date()
  const decisionId = input.decisionId ?? crypto.randomUUID()
  const models = new Map(input.manifest.models.map(model => [model.id, model]))
  const requiredCapability = input.requiredCapability ?? 'chat'
  const flash = models.get(FLASH_NEXT_MODEL_ID)

  const flashAvailable =
    !input.preferExternal &&
    availableLocally(
      flash,
      input.assessments.get(FLASH_NEXT_MODEL_ID),
      input.health.get(FLASH_NEXT_MODEL_ID),
      input.readiness.get(FLASH_NEXT_MODEL_ID),
      input.manifest.payloadSha256,
      input.settings,
      requiredCapability,
      now
    )
  const explicitFlashExperiment =
    input.settings.experimentalFlashNext &&
    input.manifest.routing.experimentalModelIds.includes(FLASH_NEXT_MODEL_ID) &&
    !flash?.promoted
  if (flashAvailable && explicitFlashExperiment) {
    return {
      id: decisionId,
      policyVersion: input.manifest.policyVersion,
      target: 'local_llama_cpp',
      modelReleaseId: FLASH_NEXT_MODEL_ID,
      reason: 'experimental_local_selected',
      capacityAssessmentId: input.assessments.get(FLASH_NEXT_MODEL_ID)?.snapshotId,
    }
  }

  const defaultModel = models.get(input.manifest.routing.defaultModelId)
  if (
    !input.preferExternal &&
    availableLocally(
      defaultModel,
      input.assessments.get(input.manifest.routing.defaultModelId),
      input.health.get(input.manifest.routing.defaultModelId),
      input.readiness.get(input.manifest.routing.defaultModelId),
      input.manifest.payloadSha256,
      input.settings,
      requiredCapability,
      now
    )
  ) {
    return {
      id: decisionId,
      policyVersion: input.manifest.policyVersion,
      target: 'local_llama_cpp',
      modelReleaseId: input.manifest.routing.defaultModelId,
      reason:
        input.manifest.routing.defaultModelId === FLASH_NEXT_MODEL_ID
          ? 'promoted_local_selected'
          : 'stable_local_fallback_selected',
      capacityAssessmentId: input.assessments.get(input.manifest.routing.defaultModelId)?.snapshotId,
    }
  }

  // The signed fallback list is consulted only after the signed default is
  // unavailable. Today it contains Orca, but the ordering stays policy-owned.
  for (const fallbackId of input.preferExternal ? [] : input.manifest.routing.fallbackModelIds) {
    if (fallbackId === input.manifest.routing.defaultModelId) continue
    const candidate = models.get(fallbackId)
    if (
      availableLocally(
        candidate,
        input.assessments.get(fallbackId),
        input.health.get(fallbackId),
        input.readiness.get(fallbackId),
        input.manifest.payloadSha256,
        input.settings,
        requiredCapability,
        now
      )
    ) {
      return {
        id: decisionId,
        policyVersion: input.manifest.policyVersion,
        target: 'local_llama_cpp',
        modelReleaseId: fallbackId,
        reason: 'stable_local_fallback_selected',
        capacityAssessmentId: input.assessments.get(fallbackId)?.snapshotId,
      }
    }
  }

  if (input.contextEgress === 'local_only' || input.settings.preference === 'local_only') {
    return {
      id: decisionId,
      policyVersion: input.manifest.policyVersion,
      target: 'blocked',
      reason: 'local_only_blocked',
    }
  }

  if (
    !input.manifest.routing.externalAllowed ||
    (input.settings.preference !== 'ask_external' && input.settings.preference !== 'allow_external')
  ) {
    return {
      id: decisionId,
      policyVersion: input.manifest.policyVersion,
      target: 'blocked',
      reason: 'external_policy_blocked',
    }
  }

  const approval = input.externalApproval
  const approvalValid =
    !!input.expectedEgressPacketHash &&
    validApproval(approval, now) &&
    approval.packetHash === input.expectedEgressPacketHash
  if (!approvalValid) {
    return {
      id: decisionId,
      policyVersion: input.manifest.policyVersion,
      target: 'blocked',
      reason: 'external_approval_required',
    }
  }

  return {
    id: decisionId,
    policyVersion: input.manifest.policyVersion,
    target: 'laravel_proxy',
    reason: 'external_approved',
    egressPacketHash: input.expectedEgressPacketHash,
    approvalId: approval!.approvalId,
  }
}
