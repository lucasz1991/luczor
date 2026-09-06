import type { InferenceTarget } from '@/services/inference/types'
import type { AcceleratorBackend, StorageClass } from '@/services/inference/capacity'

export const FLASH_NEXT_MODEL_ID = 'qwen3.8-flash-next'
export const ORCAROUTER_FALLBACK_MODEL_ID = 'orcarouter-qwen3.8-27b-uncensored-q4-k-m'

export type ModelArtifactManifest = {
  url: string
  sha256: string
  sizeBytes: number
  format: 'gguf'
  quantization: string
  storageClass: StorageClass
}

export type ModelRuntimeManifest = {
  id: 'llama.cpp'
  version: string
  sha256: string
  minContextTokens: number
  maxContextTokens: number
}

export type LocalModelCapacityPolicy = {
  minTotalRamBytes: number | null
  minAvailableRamBytes: number | null
  minVramBytes: number | null
  minStorageFreeBytes: number | null
  maxStartupSeconds: number | null
  benchmarkThresholds: {
    minPrefillTokensPerSecond: number
    minDecodeTokensPerSecond: number
    maxFirstTokenMs: number
  } | null
  acceptedAccelerators?: AcceleratorBackend[]
}

export type LocalModelReleaseManifest = {
  id: string
  displayName: string
  executionTarget: InferenceTarget
  releaseChannel: 'experimental' | 'stable'
  routingRole: 'preferred' | 'fallback'
  promoted: boolean
  enabled: boolean
  capabilities: string[]
  contextLimit: number | null
  artifact: ModelArtifactManifest | null
  runtime: ModelRuntimeManifest | null
  capacityPolicy: LocalModelCapacityPolicy
  healthPolicy: { cooldownMs: number; maxConsecutiveFailures: number }
  chatTemplateHash: string | null
  evaluationReportHash: string | null
  license: string | null
}

export type LocalModelRoutingPolicy = {
  strategy: 'local_first'
  localFirst: true
  preferredModelId: typeof FLASH_NEXT_MODEL_ID
  defaultModelId: typeof FLASH_NEXT_MODEL_ID | typeof ORCAROUTER_FALLBACK_MODEL_ID
  fallbackModelIds: [typeof ORCAROUTER_FALLBACK_MODEL_ID]
  experimentalModelIds: Array<typeof FLASH_NEXT_MODEL_ID>
  experimentalOptInRequired: true
  externalExecutionTarget: 'laravel_proxy'
  externalAllowed: boolean
  externalRequiresExplicitApproval: true
  noSilentExternalFallback: true
  requiredLocalState: string[]
  decisionReasons: string[]
  egressPolicyVersion: string
}

export type LocalModelManifestPayload = {
  schemaVersion: 1
  catalogVersion: number
  policyVersion: number
  generatedAt: string
  expiresAt: string
  models: LocalModelReleaseManifest[]
  routing: LocalModelRoutingPolicy
}

export type NativeManifestVerification = { valid: boolean; canonicalPayloadSha256: string }

export interface NativeManifestVerifier {
  /** Original snake_case wire envelope; native code verifies its canonical payload. */
  verify(
    wireEnvelope: Record<string, unknown>,
    acceptance: ManifestAcceptanceState
  ): Promise<NativeManifestVerification>
}

declare const verifiedManifestBrand: unique symbol
export type VerifiedLocalModelManifest = Readonly<LocalModelManifestPayload> & {
  readonly keyId: string
  readonly payloadSha256: string
  readonly [verifiedManifestBrand]: true
}

export type ManifestAcceptanceState = {
  trustDomain: string
  acceptanceSessionId: string
  acceptanceGeneration: number
  expectedKeyId: string
  minimumCatalogVersion: number
  minimumPolicyVersion: number
  expectedSchemaVersion?: number
  expectedCatalogVersion?: number
  expectedPolicyVersion?: number
  now?: Date
  maxClockSkewMs?: number
}

const SHA256 = /^[a-f0-9]{64}$/
const TRUST_DOMAIN = /^server:v1:[a-f0-9]{64}$/
const ACCEPTANCE_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/
const QUANTIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
const REQUIRED_LOCAL_STATE = [
  'model_enabled',
  'artifact_verified',
  'runtime_verified',
  'capacity_qualified',
  'health_eligible',
]

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Ungültiges Manifestfeld: ${name}.`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.join('\0') !== expected.join('\0')) {
    throw new Error(`Unbekannte oder fehlende Felder in ${name}.`)
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  return Object.freeze(value)
}

function requiredString(value: unknown, name: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || (pattern && !pattern.test(value))) {
    throw new Error(`Ungültiges Manifestfeld: ${name}.`)
  }
  return value
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`Ungültiges Manifestfeld: ${name}.`)
  return Number(value)
}

function nullableInteger(value: unknown, name: string): number | null {
  return value === null ? null : integer(value, name, 1)
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Ungültiges Manifestfeld: ${name}.`)
  return value
}

function hash(value: unknown, name: string): string {
  return requiredString(value, name, SHA256)
}

function nullableHash(value: unknown, name: string): string | null {
  return value === null ? null : hash(value, name)
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !SAFE_ID.test(item))) {
    throw new Error(`Ungültiges Manifestfeld: ${name}.`)
  }
  return [...value]
}

function artifact(value: unknown, modelId: string): ModelArtifactManifest | null {
  if (value === null) return null
  const item = record(value, `${modelId}.artifact`)
  exactKeys(item, ['url', 'sha256', 'size_bytes', 'format', 'quantization', 'storage_class'], `${modelId}.artifact`)
  const url = requiredString(item.url, `${modelId}.artifact.url`)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Ungültige Artefakt-URL für ${modelId}.`)
  }
  if (parsed.protocol !== 'https:') throw new Error(`Unsichere Artefakt-URL für ${modelId}.`)
  if (item.format !== 'gguf') throw new Error(`Ungültiges Artefaktformat für ${modelId}.`)
  if (item.storage_class !== 'fixed_nvme_required' && item.storage_class !== 'fixed_storage') {
    throw new Error(`Unbekannte Storage-Klasse für ${modelId}.`)
  }
  return {
    url,
    sha256: hash(item.sha256, `${modelId}.artifact.sha256`),
    sizeBytes: integer(item.size_bytes, `${modelId}.artifact.size_bytes`, 1),
    format: 'gguf',
    quantization: requiredString(item.quantization, `${modelId}.artifact.quantization`, QUANTIZATION_ID),
    storageClass: item.storage_class,
  }
}

function runtime(value: unknown, modelId: string): ModelRuntimeManifest | null {
  if (value === null) return null
  const item = record(value, `${modelId}.runtime`)
  exactKeys(item, ['id', 'version', 'sha256', 'min_context_tokens', 'max_context_tokens'], `${modelId}.runtime`)
  if (item.id !== 'llama.cpp') throw new Error(`Unbekannte Runtime für ${modelId}.`)
  const minimum = integer(item.min_context_tokens, `${modelId}.runtime.min_context_tokens`, 1)
  const maximum = integer(item.max_context_tokens, `${modelId}.runtime.max_context_tokens`, minimum)
  return {
    id: 'llama.cpp',
    version: requiredString(item.version, `${modelId}.runtime.version`, SAFE_ID),
    sha256: hash(item.sha256, `${modelId}.runtime.sha256`),
    minContextTokens: minimum,
    maxContextTokens: maximum,
  }
}

function capacityPolicy(value: unknown, modelId: string): LocalModelCapacityPolicy {
  const item = record(value, `${modelId}.capacity_policy`)
  exactKeys(
    item,
    [
      'min_available_ram_bytes',
      'min_total_ram_bytes',
      'min_vram_bytes',
      'min_storage_free_bytes',
      'max_startup_seconds',
      'benchmark_thresholds',
    ],
    `${modelId}.capacity_policy`
  )
  let benchmarkThresholds: LocalModelCapacityPolicy['benchmarkThresholds'] = null
  if (item.benchmark_thresholds !== null) {
    const benchmark = record(item.benchmark_thresholds, `${modelId}.benchmark_thresholds`)
    exactKeys(
      benchmark,
      ['min_prefill_tokens_per_second', 'min_decode_tokens_per_second', 'max_first_token_ms'],
      `${modelId}.benchmark_thresholds`
    )
    const prefill = Number(benchmark.min_prefill_tokens_per_second)
    const decode = Number(benchmark.min_decode_tokens_per_second)
    if (!Number.isFinite(prefill) || prefill <= 0 || !Number.isFinite(decode) || decode <= 0) {
      throw new Error(`Ungültige Benchmark-Schwelle für ${modelId}.`)
    }
    benchmarkThresholds = {
      minPrefillTokensPerSecond: prefill,
      minDecodeTokensPerSecond: decode,
      maxFirstTokenMs: integer(benchmark.max_first_token_ms, `${modelId}.benchmark.max_first_token_ms`, 1),
    }
  }
  return {
    minTotalRamBytes: nullableInteger(item.min_total_ram_bytes, `${modelId}.min_total_ram_bytes`),
    minAvailableRamBytes: nullableInteger(item.min_available_ram_bytes, `${modelId}.min_available_ram_bytes`),
    minVramBytes: nullableInteger(item.min_vram_bytes, `${modelId}.min_vram_bytes`),
    minStorageFreeBytes: nullableInteger(item.min_storage_free_bytes, `${modelId}.min_storage_free_bytes`),
    maxStartupSeconds: nullableInteger(item.max_startup_seconds, `${modelId}.max_startup_seconds`),
    benchmarkThresholds,
  }
}

function parseModel(value: unknown): LocalModelReleaseManifest {
  const item = record(value, 'model')
  exactKeys(
    item,
    [
      'id',
      'display_name',
      'execution_target',
      'release_channel',
      'routing_role',
      'promoted',
      'enabled',
      'capabilities',
      'context_limit',
      'artifact',
      'runtime',
      'capacity_policy',
      'health_policy',
      'chat_template_hash',
      'evaluation_report_hash',
      'license',
    ],
    'model'
  )
  const id = requiredString(item.id, 'model.id', SAFE_ID)
  if (id !== FLASH_NEXT_MODEL_ID && id !== ORCAROUTER_FALLBACK_MODEL_ID) {
    throw new Error(`Unbekanntes lokales Modell: ${id}.`)
  }
  if (item.execution_target !== 'local_llama_cpp') throw new Error(`Unbekanntes Ausführungsziel für ${id}.`)
  if (item.release_channel !== 'experimental' && item.release_channel !== 'stable') {
    throw new Error(`Unbekannter Releasekanal für ${id}.`)
  }
  if (item.routing_role !== 'preferred' && item.routing_role !== 'fallback') {
    throw new Error(`Unbekannte Routingrolle für ${id}.`)
  }
  const health = record(item.health_policy, `${id}.health_policy`)
  exactKeys(health, ['cooldown_ms', 'max_consecutive_failures'], `${id}.health_policy`)
  const parsed: LocalModelReleaseManifest = {
    id,
    displayName: requiredString(item.display_name, `${id}.display_name`),
    executionTarget: 'local_llama_cpp',
    releaseChannel: item.release_channel,
    routingRole: item.routing_role,
    promoted: requiredBoolean(item.promoted, `${id}.promoted`),
    enabled: requiredBoolean(item.enabled, `${id}.enabled`),
    capabilities: stringList(item.capabilities, `${id}.capabilities`),
    contextLimit: nullableInteger(item.context_limit, `${id}.context_limit`),
    artifact: artifact(item.artifact, id),
    runtime: runtime(item.runtime, id),
    capacityPolicy: capacityPolicy(item.capacity_policy, id),
    healthPolicy: {
      cooldownMs: integer(health.cooldown_ms, `${id}.health_policy.cooldown_ms`, 1_000),
      maxConsecutiveFailures: integer(
        health.max_consecutive_failures,
        `${id}.health_policy.max_consecutive_failures`,
        1
      ),
    },
    chatTemplateHash: nullableHash(item.chat_template_hash, `${id}.chat_template_hash`),
    evaluationReportHash: nullableHash(item.evaluation_report_hash, `${id}.evaluation_report_hash`),
    license: item.license === null ? null : requiredString(item.license, `${id}.license`),
  }
  if (parsed.enabled && !isExecutableLocalModel(parsed)) {
    throw new Error(`Aktives lokales Modell ${id} besitzt keine vollständigen verifizierbaren Metadaten.`)
  }
  return parsed
}

function parseRouting(value: unknown): LocalModelRoutingPolicy {
  const item = record(value, 'routing')
  exactKeys(
    item,
    [
      'strategy',
      'local_first',
      'preferred_model_id',
      'default_model_id',
      'fallback_model_ids',
      'experimental_model_ids',
      'experimental_opt_in_required',
      'external_execution_target',
      'external_allowed',
      'external_requires_explicit_approval',
      'no_silent_external_fallback',
      'required_local_state',
      'decision_reasons',
      'egress_policy_version',
    ],
    'routing'
  )
  const fallbacks = stringList(item.fallback_model_ids, 'routing.fallback_model_ids')
  const experimental = stringList(item.experimental_model_ids, 'routing.experimental_model_ids')
  const state = stringList(item.required_local_state, 'routing.required_local_state')
  if (
    item.strategy !== 'local_first' ||
    item.local_first !== true ||
    item.preferred_model_id !== FLASH_NEXT_MODEL_ID ||
    (item.default_model_id !== FLASH_NEXT_MODEL_ID && item.default_model_id !== ORCAROUTER_FALLBACK_MODEL_ID) ||
    fallbacks.length !== 1 ||
    fallbacks[0] !== ORCAROUTER_FALLBACK_MODEL_ID ||
    experimental.some(modelId => modelId !== FLASH_NEXT_MODEL_ID) ||
    item.experimental_opt_in_required !== true ||
    item.external_execution_target !== 'laravel_proxy' ||
    item.external_requires_explicit_approval !== true ||
    item.no_silent_external_fallback !== true ||
    REQUIRED_LOCAL_STATE.some(required => !state.includes(required))
  ) {
    throw new Error('Unsichere oder unbekannte Routing-Policy im Modellmanifest.')
  }
  return {
    strategy: 'local_first',
    localFirst: true,
    preferredModelId: FLASH_NEXT_MODEL_ID,
    defaultModelId: item.default_model_id,
    fallbackModelIds: [ORCAROUTER_FALLBACK_MODEL_ID],
    experimentalModelIds: experimental as Array<typeof FLASH_NEXT_MODEL_ID>,
    experimentalOptInRequired: true,
    externalExecutionTarget: 'laravel_proxy',
    externalAllowed: requiredBoolean(item.external_allowed, 'routing.external_allowed'),
    externalRequiresExplicitApproval: true,
    noSilentExternalFallback: true,
    requiredLocalState: state,
    decisionReasons: stringList(item.decision_reasons, 'routing.decision_reasons'),
    egressPolicyVersion: requiredString(item.egress_policy_version, 'routing.egress_policy_version', SAFE_ID),
  }
}

function decodeEnvelope(input: unknown): {
  wire: Record<string, unknown>
  keyId: string
  payloadSha256: string
  signature: string
  payload: LocalModelManifestPayload
} {
  const wire = record(input, 'envelope')
  exactKeys(wire, ['key_id', 'algorithm', 'payload_sha256', 'payload', 'signature'], 'envelope')
  if (wire.algorithm !== 'RSA-SHA256') throw new Error('Unbekannter Manifest-Signaturalgorithmus.')
  const payloadWire = record(wire.payload, 'payload')
  exactKeys(
    payloadWire,
    ['schema_version', 'catalog_version', 'policy_version', 'generated_at', 'expires_at', 'models', 'routing'],
    'payload'
  )
  if (!Array.isArray(payloadWire.models)) throw new Error('Ungültiger Modellkatalog.')
  const models = payloadWire.models.map(parseModel)
  if (models.length !== 2 || new Set(models.map(item => item.id)).size !== 2) {
    throw new Error('Der lokale Modellkatalog ist unvollständig oder mehrdeutig.')
  }
  const schemaVersion = integer(payloadWire.schema_version, 'schema_version', 1)
  if (schemaVersion !== 1) throw new Error('Nicht unterstützte Manifest-Schemaversion.')
  const routing = parseRouting(payloadWire.routing)
  const flash = models.find(item => item.id === FLASH_NEXT_MODEL_ID)
  const fallback = models.find(item => item.id === ORCAROUTER_FALLBACK_MODEL_ID)
  if (
    !flash ||
    !fallback ||
    flash.routingRole !== 'preferred' ||
    fallback.routingRole !== 'fallback' ||
    (flash.promoted ? flash.releaseChannel !== 'stable' : flash.releaseChannel !== 'experimental') ||
    !fallback.promoted ||
    fallback.releaseChannel !== 'stable' ||
    (flash.promoted && routing.defaultModelId !== FLASH_NEXT_MODEL_ID) ||
    (!flash.promoted && routing.defaultModelId !== ORCAROUTER_FALLBACK_MODEL_ID) ||
    (flash.promoted && routing.experimentalModelIds.includes(FLASH_NEXT_MODEL_ID)) ||
    (!flash.promoted && !routing.experimentalModelIds.includes(FLASH_NEXT_MODEL_ID))
  ) {
    throw new Error('Default-, Promotion- und Experimentstatus des Modellmanifests widersprechen sich.')
  }
  return {
    wire,
    keyId: requiredString(wire.key_id, 'key_id', SAFE_ID),
    payloadSha256: hash(wire.payload_sha256, 'payload_sha256'),
    signature: requiredString(wire.signature, 'signature'),
    payload: {
      schemaVersion: 1,
      catalogVersion: integer(payloadWire.catalog_version, 'catalog_version', 1),
      policyVersion: integer(payloadWire.policy_version, 'policy_version', 1),
      generatedAt: requiredString(payloadWire.generated_at, 'generated_at'),
      expiresAt: requiredString(payloadWire.expires_at, 'expires_at'),
      models,
      routing,
    },
  }
}

export function isExecutableLocalModel(model: LocalModelReleaseManifest): boolean {
  const policy = model.capacityPolicy
  return !!(
    model.enabled &&
    model.executionTarget === 'local_llama_cpp' &&
    model.artifact &&
    model.runtime &&
    model.contextLimit &&
    policy.minAvailableRamBytes &&
    policy.minTotalRamBytes &&
    policy.minVramBytes &&
    policy.minStorageFreeBytes &&
    policy.maxStartupSeconds &&
    policy.benchmarkThresholds &&
    model.chatTemplateHash &&
    model.evaluationReportHash &&
    model.license
  )
}

export async function verifyLocalModelManifest(
  input: unknown,
  verifier: NativeManifestVerifier,
  state: ManifestAcceptanceState
): Promise<VerifiedLocalModelManifest> {
  if (!TRUST_DOMAIN.test(state.trustDomain)) throw new Error('Ungültige Manifest-Trust-Domain.')
  if (!ACCEPTANCE_SESSION_ID.test(state.acceptanceSessionId)) {
    throw new Error('Ungültige Manifest-Akzeptanzsitzung.')
  }
  if (!Number.isSafeInteger(state.acceptanceGeneration) || state.acceptanceGeneration < 1) {
    throw new Error('Ungültige Manifest-Akzeptanzgeneration.')
  }
  const envelope = decodeEnvelope(input)
  if (envelope.keyId !== state.expectedKeyId) throw new Error('Unbekannter Manifest-Signaturschlüssel.')
  if (
    envelope.payload.catalogVersion < state.minimumCatalogVersion ||
    envelope.payload.policyVersion < state.minimumPolicyVersion
  ) {
    throw new Error('Manifest-Downgrade wurde abgewiesen.')
  }
  const generated = Date.parse(envelope.payload.generatedAt)
  const expires = Date.parse(envelope.payload.expiresAt)
  const now = (state.now ?? new Date()).getTime()
  const skew = Math.max(0, state.maxClockSkewMs ?? 5 * 60_000)
  if (!Number.isFinite(generated) || !Number.isFinite(expires) || expires <= generated) {
    throw new Error('Ungültiges Manifest-Gültigkeitsfenster.')
  }
  if (generated > now + skew) throw new Error('Manifest wurde in der Zukunft ausgestellt.')
  if (expires <= now) throw new Error('Modellmanifest ist abgelaufen.')

  if (
    (state.expectedSchemaVersion !== undefined && envelope.payload.schemaVersion !== state.expectedSchemaVersion) ||
    (state.expectedCatalogVersion !== undefined && envelope.payload.catalogVersion !== state.expectedCatalogVersion) ||
    (state.expectedPolicyVersion !== undefined && envelope.payload.policyVersion !== state.expectedPolicyVersion)
  ) {
    throw new Error('Bootstrap discovery and signed manifest versions differ.')
  }

  const verification = await verifier.verify(envelope.wire, state)
  if (
    !verification.valid ||
    verification.canonicalPayloadSha256.toLowerCase() !== envelope.payloadSha256.toLowerCase()
  ) {
    throw new Error('Modellmanifest konnte nicht kryptografisch verifiziert werden.')
  }
  return deepFreeze({
    ...envelope.payload,
    keyId: envelope.keyId,
    payloadSha256: envelope.payloadSha256,
  }) as VerifiedLocalModelManifest
}
