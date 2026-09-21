import { getSafeRecordValue } from '@/services/safeRecord'

/** Deliberate allowlist: no prompts, answers, tool arguments, keys, file names or addresses. */
type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {}
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value.slice(-200) : [])
const select = (value: unknown, keys: readonly string[]): RecordValue => {
  const source = record(value)
  return Object.fromEntries(
    keys.flatMap(key => {
      const item = getSafeRecordValue(source, key)
      return item === null ||
        typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item)) ||
        (typeof item === 'string' && item.length <= 200)
        ? [[key, item]]
        : []
    })
  )
}
export type CoordinationDiagnosticInput = {
  native: boolean
  clientId?: string
  build?: unknown
  desktop?: unknown
  model?: unknown
  cluster?: unknown
  lan?: unknown
  mirrors?: unknown
  journals?: unknown
  checks?: Record<string, 'ok' | 'unavailable' | 'not_requested'>
}
export function buildCoordinationDiagnostic(input: CoordinationDiagnosticInput, now = new Date()) {
  const model = record(input.model),
    cluster = record(input.cluster),
    leader = record(cluster.coordinator)
  const config = record(model.resourceConfig),
    lan = record(input.lan)
  return {
    schema: 'luczor.device-cluster.diagnostic.v1',
    capturedAt: now.toISOString(),
    native: input.native,
    device: select({ clientId: input.clientId }, ['clientId']),
    checks: input.checks ?? {},
    build: {
      ...select(record(input.build).build, ['appVersion', 'platform', 'arch', 'contractFingerprint']),
      ...select(input.build, ['runtimeFingerprint']),
      frontendFingerprint: import.meta.env.VITE_WORKFLOW_CODE_HASH ?? 'development-unverified',
    },
    desktop: select(input.desktop, ['backend', 'semanticInput', 'windowInput']),
    model: {
      ...select(model, [
        'manifestAvailable',
        'catalogVersion',
        'policyVersion',
        'activeModelId',
        'state',
        'reasonCode',
      ]),
      resources: {
        ...select(config, ['appliedRevision', 'pending']),
        requested: select(config.requested, ['mode', 'revision']),
        applied: select(config.applied, ['mode', 'revision']),
        plan: select(model.resourcePlan, [
          'contextTokens',
          'threads',
          'threadsBatch',
          'totalRamBytes',
          'availableRamBytes',
          'ramHeadroomBytes',
          'parallelSlots',
          'applied',
        ]),
      },
      acceleration: select(model.acceleration, [
        'backend',
        'mode',
        'verified',
        'offloadedLayers',
        'totalLayers',
        'gpuMemoryBytes',
        'reasonCode',
        'fallbackReasonCode',
      ]),
      readiness: rows(model.readiness).map(item =>
        select(item, ['modelId', 'ready', 'reasonCode', 'contextTokens', 'checkedAt'])
      ),
    },
    coordination: {
      ...select(cluster, ['running', 'connected', 'pending']),
      errorPresent: !!cluster.error,
      ...select(leader, [
        'leader_device_id',
        'preferred_device_id',
        'epoch',
        'lease_expires_at',
        'role',
        'handoff_pending',
      ]),
      devices: rows(leader.devices).map(item =>
        select(item, ['client_id', 'platform', 'available', 'model_tier', 'active_model_id', 'model_tier_source'])
      ),
      jobs: rows(cluster.jobs).map(item =>
        select(item, [
          'id',
          'protocol_version',
          'source_device_id',
          'target_device_id',
          'project_id',
          'conversation_id',
          'master_epoch',
          'authority_epoch',
          'attempt_id',
          'status',
          'lease_expires_at',
          'reconciliation_required',
          'cancel_requested',
        ])
      ),
    },
    lan: {
      ...select(lan, ['active', 'transferred', 'cachedTrust', 'serverOnline', 'authorityEpoch']),
      peerCount: Array.isArray(lan.peers) ? lan.peers.length : 0,
      reachablePeerCount: Array.isArray(lan.reachablePeers) ? lan.reachablePeers.length : 0,
      workers: Object.values(record(lan.workers))
        .slice(0, 64)
        .map(worker => select(worker, ['protocol', 'ready', 'busy', 'modelId', 'platform', 'tier'])),
      agentLease: select(lan.lease, ['scope', 'epoch', 'expires_at']),
      storedResultCount: Array.isArray(lan.received) ? lan.received.length : 0,
      errorPresent: !!lan.error,
    },
    mirrors: Object.entries(record(input.mirrors))
      .slice(0, 200)
      .map(([projectId, item]) => ({
        projectId,
        ...select(item, ['busy', 'revision', 'files', 'transferred', 'bytes', 'paused']),
        errorPresent: !!record(item).error,
      })),
    journals: rows(input.journals).map(item => ({
      ...select(item, [
        'kind',
        'deviceId',
        'jobId',
        'runId',
        'conversationId',
        'projectId',
        'state',
        'revision',
        'createdAt',
        'updatedAt',
      ]),
      checkpoint: select(record(item).checkpoint, ['lastEventSequence', 'attemptId', 'masterEpoch']),
    })),
  }
}
