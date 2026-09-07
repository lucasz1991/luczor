import {
  localInferenceCoordinator,
  resolveInferenceRouteForTurn,
  reinitializeLocalInferenceForCurrentApi,
} from './coordinator'
import { BackgroundModelPreparation, type BackgroundPreparationPolicy } from './backgroundPreparation'
import type { HybridRoutingSettings } from './hybridRouter'

export type BackgroundRoutingSettings = Pick<HybridRoutingSettings, 'experimentalFlashNext'>

const RETRYABLE_BOOTSTRAP_REASONS = new Set([
  'bootstrap_not_initialized',
  'bootstrap_unavailable',
  'server_unreachable',
  'manifest_fetch_failed',
  'manifest_refresh_failed',
  'manifest_session_unavailable',
  'hardware_snapshot_failed',
])

export function canRetryBackgroundPolicy(policy: BackgroundPreparationPolicy): boolean {
  return policy.mode === 'blocked' && RETRYABLE_BOOTSTRAP_REASONS.has(policy.reason ?? '')
}

/** Metadata/identity/signature recovery only; the coordinator never prepares a model here. */
export const recoverLocalBackgroundPolicy = () => reinitializeLocalInferenceForCurrentApi()

export function localBackgroundPreparationPolicy(settings?: BackgroundRoutingSettings): BackgroundPreparationPolicy {
  const status = localInferenceCoordinator.status()
  const manifest = status.manifest
  const order = manifest
    ? [
        ...(settings?.experimentalFlashNext ? (manifest.routing.experimentalModelIds ?? []) : []),
        manifest.routing.defaultModelId,
        ...manifest.routing.fallbackModelIds,
      ]
    : []
  const readyModelId = order.find(id =>
    status.admissions.some(
      model =>
        model.modelReleaseId === id &&
        model.enabled &&
        model.executable &&
        model.capacity === 'eligible' &&
        model.admissible &&
        model.ready
    )
  )
  return {
    active: status.mode === 'active',
    mode: status.mode,
    reason: status.reason,
    fingerprint: manifest?.payloadSha256,
    expiresAt: manifest ? Date.parse(manifest.expiresAt) : undefined,
    readyModelId,
  }
}

/** Main-window owner only. Route preparation reuses the coordinator's exclusive native queue. */
export function createLocalBackgroundPreparation(
  routingSettings: () => BackgroundRoutingSettings = () => ({ experimentalFlashNext: false })
): BackgroundModelPreparation {
  return new BackgroundModelPreparation({
    policy: () => localBackgroundPreparationPolicy(routingSettings()),
    refreshExpiredPolicy: true,
    async prepare(scope, signal) {
      signal.throwIfAborted()
      const route = await resolveInferenceRouteForTurn({
        projectId: scope.projectId,
        contextId: scope.sessionId,
        taskType: 'chat.general',
        contextEgress: 'local_only',
        routingSettings: { preference: 'local_only', ...routingSettings(), allowDegradedLocal: false },
      })
      signal.throwIfAborted()
      if (route.gateway.target !== 'local_llama_cpp') throw new Error('Hintergrundvorbereitung muss lokal bleiben.')
      // Do not retain the scope-bound gateway or perform an inference to keep it alive.
      return { modelId: route.decision?.modelReleaseId }
    },
  })
}
