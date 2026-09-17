import type { BootstrapResponse, LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import { localResources, onLocalResourcesApplied, onLocalRuntimeReleased } from './resources'
import { localModelManifestWithApiConfig, LuczorApi } from '@/services/api/luczorApi'
import { modelPlatformTarget } from './modelPlatform'
import {
  deriveLocalModelManifestTrustDomain,
  getVerifiedAccountSnapshot,
  type VerifiedAccountSnapshot,
} from '@/services/accountPrincipal'
import { assessModelCapacity, type CapacityAssessment, type HardwareSnapshot } from '@/services/inference/capacity'
import { requiredCapabilityForTask, type InferenceCapability } from '@/services/inference/capabilities'
import { laravelInferenceGateway } from '@/services/inference/gateways'
import { hashLaravelProxyBody } from '@/services/inference/laravelProxyBody'
import {
  decideHybridRoute,
  hasVerifiedLocalReadiness,
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
  getNativeLocalModelStatus,
  recoverNativeModelMemory,
  prepareNativeLocalModel,
  tauriManifestVerifier,
  TauriLocalRuntimeTransport,
  type NativeLocalModelStatus,
} from '@/services/inference/tauriLocalRuntime'
import type { ApprovedProxyConfig, InferenceGateway, InferenceRequest, WireMessage } from '@/services/inference/types'
import { modelUsageSettings } from './modelUsageSettings'
import { openResourceRecovery } from './resourceRecovery'

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
  /**
   * The signed capability this turn actually needs. Callers that know their own
   * contract pass it explicitly; only legacy callers fall back to deriving it
   * from `taskType`, which for free-text chat is a keyword guess, not a contract.
   */
  requiredCapability?: InferenceCapability
  /** Explicit external delegation is restricted to the server-managed agent role namespace. */
  intent?: 'external_specialist'
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

export type LocalPolicyDiagnostic = Readonly<{ mode: CoordinatorMode; reason: string; message: string }>
export type InferenceConnectionResult = Readonly<{
  ok: boolean
  connected: boolean
  stale: boolean
  policy: LocalPolicyDiagnostic
  message: string
}>

const manifestSigningDiagnostics = new Map<string, string>([
  [
    'local_model_signing_key_path_unsafe',
    'Der Server hat keinen zulässigen Pfad für den Modell-Signaturschlüssel. In Produktion muss die Schlüsseldatei außerhalb des App-Verzeichnisses liegen.',
  ],
  [
    'local_model_signing_key_unreadable',
    'Der Server kann die Datei des Modell-Signaturschlüssels nicht lesen. Bitte Dateipfad und Leserechte auf dem Server prüfen.',
  ],
  [
    'local_model_signing_key_invalid',
    'Auf dem Server fehlt ein gültiger Modell-Signaturschlüssel. Bitte den dedizierten RSA-Schlüssel bereitstellen.',
  ],
  [
    'local_model_signing_key_unsafe',
    'Der Modell-Signaturschlüssel auf dem Server erfüllt die RSA-Sicherheitsanforderungen nicht.',
  ],
  [
    'local_model_signing_public_key_pin_missing',
    'Auf dem Server fehlt der SHA-256-Fingerabdruck des öffentlichen Modell-Signaturschlüssels.',
  ],
  [
    'local_model_signing_public_key_pin_invalid',
    'Der konfigurierte öffentliche Schlüsselfingerabdruck für die Modellrichtlinie ist ungültig.',
  ],
  [
    'local_model_signing_public_key_mismatch',
    'Der Modell-Signaturschlüssel auf dem Server passt nicht zum konfigurierten öffentlichen Schlüsselfingerabdruck.',
  ],
  [
    'local_model_manifest_signing_failed',
    'Der Server konnte die Modellrichtlinie nicht signieren. Bitte die Signaturkonfiguration auf dem Server prüfen.',
  ],
])

/** Only known diagnostic categories reach the UI; native errors may contain private data. */
export function localPolicyDiagnostic(mode: CoordinatorMode, reason: string): LocalPolicyDiagnostic {
  const messages = new Map<string, string>([
    ...manifestSigningDiagnostics,
    [
      'bootstrap_not_initialized',
      'Die Modellrichtlinie wurde noch nicht geladen. Bitte in den Server-Einstellungen die Verbindung testen.',
    ],
    [
      'bootstrap_unavailable',
      'Die Modellrichtlinie konnte beim Start nicht geladen werden. Bitte die Serververbindung erneut testen.',
    ],
    [
      'server_unreachable',
      'Der Server ist nicht erreichbar oder die WebView-Verbindung wird blockiert. Bitte die Serververbindung erneut testen.',
    ],
    [
      'authentication_failed',
      'Der Server hat den Device-Key abgelehnt. Bitte den Key und seine Berechtigungen prüfen.',
    ],
    [
      'manifest_discovery_missing',
      'Der Server liefert keine signierte Modellrichtlinie. Der Serverstand muss diese Funktion unterstützen.',
    ],
    [
      'manifest_discovery_invalid',
      'Die Ankündigung der Modellrichtlinie ist ungültig oder inkompatibel. Bitte den Serverstand prüfen.',
    ],
    [
      'manifest_unavailable',
      'Der Server hat die signierte Modellrichtlinie noch nicht bereitgestellt. Bitte die Modellkonfiguration auf dem Server prüfen.',
    ],
    [
      'manifest_fetch_failed',
      'Die signierte Modellrichtlinie konnte nicht vom Server geladen werden. Bitte die Verbindung erneut testen.',
    ],
    [
      'manifest_verification_failed',
      'Die Modellrichtlinie konnte nicht sicher verifiziert werden. Bitte Signatur, Gültigkeit und Versionen auf dem Server prüfen.',
    ],
    [
      'account_verification_failed',
      'Die Modellrichtlinie konnte keinem verifizierten Konto zugeordnet werden. Bitte den Device-Key prüfen und die Verbindung erneut testen.',
    ],
    [
      'manifest_session_unavailable',
      'Die native Modellverwaltung ist nicht verfügbar. Bitte die aktuelle Luczor-Desktop-App starten und die Verbindung erneut testen.',
    ],
    [
      'hardware_snapshot_failed',
      'Die lokale Hardwareanalyse für die Modellrichtlinie ist fehlgeschlagen. Bitte die Verbindung erneut testen.',
    ],
    [
      'api_identity_changed',
      'Die Server- oder Konto-Einstellungen wurden geändert. Bitte die Verbindung erneut testen.',
    ],
    [
      'manifest_refresh_failed',
      'Die Modellrichtlinie konnte nicht erneuert werden. Bitte die Serververbindung erneut testen.',
    ],
  ])
  const message =
    mode === 'active'
      ? 'Die signierte Modellrichtlinie ist geprüft. Modellbereitschaft und erforderliche Freigaben werden beim Start des Auftrags geprüft.'
      : mode === 'loading'
        ? 'Die Modellrichtlinie wird gerade geladen und geprüft. Bitte kurz warten.'
        : `${messages.get(reason) ?? 'Die signierte Modellrichtlinie ist nicht verfügbar. Bitte die Serververbindung erneut testen.'} Externer Fallback bleibt gesperrt.`
  return {
    mode,
    reason:
      messages.has(reason) || reason === 'signed_policy_active' || reason === 'bootstrap_pending'
        ? reason
        : 'policy_unavailable',
    message,
  }
}

function policyFailureReason(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'status' in error) {
    if (error.status === 401 || error.status === 403) return 'authentication_failed'
    if (error.status === 0) return 'server_unreachable'
  }
  return fallback
}

function staleConnectionResult(): InferenceConnectionResult {
  const policy = localPolicyDiagnostic('blocked', 'api_identity_changed')
  return {
    ok: false,
    connected: false,
    stale: true,
    policy,
    message: 'Die Verbindungseinstellungen haben sich während der Prüfung geändert. Bitte erneut testen.',
  }
}

export type LocalInferenceCoordinatorDependencies = {
  bootstrap: () => Promise<BootstrapResponse>
  fetchManifest: (config: LuczorApiConfigSnapshot) => Promise<Record<string, unknown>>
  verifyManifest: typeof verifyLocalModelManifest
  hardwareSnapshot: () => Promise<HardwareSnapshot>
  resourceMode?: () => Promise<'auto' | 'gpu' | 'cpu' | 'hybrid'>
  recoverMemory?: () => Promise<HardwareSnapshot>
  nativeStatus?: () => Promise<NativeLocalModelStatus>
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

const EXTERNAL_SPECIALIST_TASK_TYPES = new Set(['agent.planning', 'agent.research', 'agent.coding', 'agent.review'])

function externalSpecialistUnavailableMessage(reason: RouteDecision['reason']): string {
  if (reason === 'external_approval_required') {
    return 'Der externe Spezialist benötigt eine ausdrückliche Freigabe dieses Nachrichtenpakets.'
  }
  if (reason === 'local_only_blocked') {
    return 'Dieser Auftrag ist auf lokale Modelle beschränkt. Ein externer Spezialist ist dafür nicht freigegeben.'
  }
  return 'Die signierte Modellrichtlinie erlaubt für diesen Auftrag keinen externen Spezialisten.'
}

/**
 * Reasons a later attempt can plausibly clear: load, memory, thermal and
 * resource-revision conditions, plus a startup that ran out of its signed budget.
 * Integrity, catalog and configuration failures are deliberately absent — those
 * never fix themselves, so they must not hold back the external offer.
 */
const RETRYABLE_LOCAL_PREPARATION_REASONS: ReadonlySet<string> = new Set([
  'readiness_pending',
  'capacity_unknown',
  'available_ram_below_minimum',
  'runtime_startup_ram_pressure',
  'resource_pressure',
  'thermal_limit',
  'accelerator_unavailable',
  'benchmark_failed',
  'local_preparation_failed',
  'runtime_download_failed',
  'resource_config_pending',
  'resource_config_busy',
  'resource_revision_mismatch',
  'resource_revision_required',
])

const localReadinessMessages = new Map<string, string>([
  ['runtime_platform_mismatch', 'Die hinterlegte Runtime passt nicht zur Linux-Plattform oder Prozessorarchitektur.'],
  ['runtime_download_unavailable', 'Die signierte Runtime oder Modelldatei wurde vom Server nicht bereitgestellt.'],
  [
    'runtime_download_failed',
    'Der Download einer lokalen Modellressource ist fehlgeschlagen. Bitte die Verbindung pr�fen.',
  ],
  [
    'runtime_installation_failed',
    'Die lokale Modellinstallation kann Dateien nicht anlegen oder lesen. Bitte Speicherplatz und Zugriffsrechte pr�fen.',
  ],
  [
    'runtime_installed_checksum_mismatch',
    'Eine bereits installierte Modellressource stimmt nicht mit der signierten Pr�fsumme �berein.',
  ],

  ['model_disabled', 'Der signierte Katalog hat das lokale Modell noch nicht aktiviert.'],
  ['release_not_executable', 'Im signierten Katalog fehlen ausführbare Modell- oder Runtime-Metadaten.'],
  ['capability_unavailable', 'Die lokalen Modelle unterstützen die angeforderte Aufgabe nicht.'],
  ['capacity_unknown', 'Die lokale Hardwarebereitschaft konnte noch nicht bestätigt werden.'],
  ['total_ram_below_minimum', 'Der Arbeitsspeicher unterschreitet die signierte Modellanforderung.'],
  ['available_ram_below_minimum', 'Für das lokale Modell ist gerade zu wenig Arbeitsspeicher frei.'],
  ['accelerator_unavailable', 'Für das lokale Modell ist keine geeignete GPU verfügbar.'],
  [
    'accelerator_runtime_unavailable',
    'Die geprüfte Modellruntime kann keine GPU gemäß den Modellanforderungen nutzen.',
  ],
  [
    'cpu_mode_disallowed_by_manifest',
    'Dieses Modellprofil verlangt laut Serverfreigabe eine GPU und passt nicht zu Nur CPU/RAM. Bitte ein CPU-freigegebenes Profil oder die automatische Modellwahl verwenden.',
  ],
  ['vram_below_minimum', 'Der GPU-Speicher unterschreitet die signierte Modellanforderung.'],
  ['storage_unavailable', 'Für das lokale Modell ist kein geeigneter Speicherplatz verfügbar.'],
  ['runtime_startup_ram_pressure', 'Der Modellstart wurde zum Schutz des verfügbaren Arbeitsspeichers beendet.'],
  ['fixed_nvme_storage_required', 'Das lokale Modell benötigt geeigneten internen NVMe-Speicher.'],
  ['resource_pressure', 'Die aktuelle Systemauslastung lässt das lokale Modell nicht zu.'],
  [
    'cpu_mode_disallowed_by_manifest',
    'Dieses Modell benötigt laut signierter Freigabe eine GPU. Bitte Automatik oder GPU-Modus wählen.',
  ],
  [
    'runtime_gpu_required_no_offload',
    'Die signierte Freigabe verlangt GPU-Nutzung, aber keine Modellschicht wurde ausgelagert.',
  ],
  ['thermal_limit', 'Die Temperaturgrenze verhindert momentan die lokale Modellnutzung.'],
  ['health_cooldown', 'Das lokale Modell wartet nach einem Fehler auf einen erneuten Versuch.'],
  ['health_error', 'Die lokale Modellruntime befindet sich im Fehlerzustand.'],
  ['runtime_not_configured', 'Die lokale Modellruntime ist in dieser App noch nicht eingerichtet.'],
  ['model_directory_not_configured', 'Der lokale Modellordner ist in dieser App noch nicht eingerichtet.'],
  ['runtime_unavailable', 'Die eingerichtete lokale Modellruntime ist nicht verfügbar.'],
  ['model_files_unavailable', 'Die eingerichteten lokalen Modelldateien sind nicht verfügbar.'],
  ['local_paths_invalid', 'Die eingerichteten lokalen Modellpfade sind ungültig.'],
  ['artifact_mismatch', 'Die lokalen Modelldateien passen nicht zum signierten Katalog.'],
  ['runtime_mismatch', 'Die lokale Modellruntime passt nicht zum signierten Katalog.'],
  ['benchmark_failed', 'Das lokale Modell hat die vorgeschriebene Bereitschaftsprüfung nicht bestanden.'],
  ['readiness_mismatch', 'Die lokale Bereitschaftsbestätigung ist veraltet oder passt nicht zum signierten Modell.'],
  ['readiness_pending', 'Die Bereitschaft des lokalen Modells ist noch nicht bestätigt.'],
  ['resource_config_pending', 'Die neuen Ressourceneinstellungen werden nach dem laufenden Auftrag angewandt.'],
  ['resource_config_busy', 'Der laufende Auftrag verwendet noch die bisherigen Ressourceneinstellungen.'],
  [
    'resource_revision_mismatch',
    'Die Ressourcenverteilung hat sich geändert; die Modellbereitschaft wird erneut geprüft.',
  ],
  ['resource_revision_required', 'Die Modellvorbereitung benötigt die aktuelle Ressourcenverteilung.'],
  [
    'resource_gpu_selection_changed',
    'Die gespeicherte Grafikkarte hat sich geändert. Bitte die Geräteauswahl aktualisieren.',
  ],
  [
    'resource_gpu_selection_ambiguous',
    'Die Grafikkartenauswahl ist nicht eindeutig. Bitte die automatische Auswahl verwenden.',
  ],
  ['resource_gpu_selection_unavailable', 'Eine ausgewählte Grafikkarte ist nicht verfügbar.'],
  [
    'resource_thread_controls_unavailable',
    'Diese Runtime unterstützt die gewählten Threadoptionen nicht. Bitte Automatik verwenden.',
  ],
  ['ram_budget_insufficient', 'Der freie Arbeitsspeicher reicht für Modell, Kontext und Sicherheitsreserve nicht aus.'],
  ['runtime_gpu_measurement_unavailable', 'Die tatsächliche GPU-Auslagerung konnte noch nicht bestätigt werden.'],
  ['runtime_gpu_capacity_unavailable', 'Der freie Grafikspeicher reicht unter Berücksichtigung der Reserve nicht aus.'],
  ['gpu_full_offload_not_verified', 'Die vollständige GPU-Auslagerung wurde nicht bestätigt.'],
  [
    'forced_split_unavailable',
    'Erzwungener Split benötigt eine passende GPU-Runtime mit freiem Grafikspeicher. Es erfolgt kein CPU-Ersatzbetrieb.',
  ],
  [
    'forced_split_metadata_unavailable',
    'Die Schichtaufteilung dieses Modells konnte nicht sicher bestimmt werden. Bitte Automatik verwenden.',
  ],
  [
    'forced_split_not_verified',
    'Der erzwungene CPU/GPU-Split wurde von der Runtime nicht bestätigt. Bitte Ressourcen prüfen oder Automatik wählen.',
  ],
  [
    'runtime_platform_protection_unavailable',
    'Die lokale Runtime ist in diesem App-Build unter Linux/macOS noch gesperrt: Dateischutz oder Prozessabsicherung fehlen. Dies ist kein RAM- oder GPU-Mangel.',
  ],
  [
    'local_preparation_failed',
    'Die lokale Modellvorbereitung ist fehlgeschlagen. Bitte die lokale Einrichtung prüfen.',
  ],
])

/** Match complete known native errors; never expose arbitrary native paths or error details. */
function preparationFailureReason(error: unknown): string {
  const nativeMessage = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  const reasons = new Map<string, string>([
    ['The server runtime does not match this Linux architecture.', 'runtime_platform_mismatch'],
    ['The signed runtime libraries are not a Linux release.', 'runtime_platform_mismatch'],
    ['The signed runtime libraries do not match this platform.', 'runtime_platform_mismatch'],
    ['The server has not provided the signed Linux runtime or model resource.', 'runtime_download_unavailable'],
    ['The server has not provided the signed local runtime or model resource.', 'runtime_download_unavailable'],
    ['Model resource download failed.', 'runtime_download_failed'],
    ['Model download interrupted.', 'runtime_download_failed'],
    ['Cannot create local-model installation directory.', 'runtime_installation_failed'],
    ['Cannot make verified local runtime executable.', 'runtime_installation_failed'],
    ['Cannot create model download file.', 'runtime_installation_failed'],
    ['Insufficient storage for model download.', 'storage_unavailable'],
    ['Installed model resource checksum mismatch.', 'runtime_installed_checksum_mismatch'],
    ['Installed model resource size mismatch.', 'runtime_installed_checksum_mismatch'],
    [
      'Local-model execution is disabled on this platform until immutable artifact guards are available.',
      'runtime_platform_protection_unavailable',
    ],
    [
      'Local-model execution is disabled on this platform until parent-death process protection is available.',
      'runtime_platform_protection_unavailable',
    ],
    [
      'Local-model runtime paths are not configured. Configure local-model/runtime-paths.json or both runtime environment paths.',
      'runtime_not_configured',
    ],
    ['Both local-model runtime environment paths must be configured together.', 'local_paths_invalid'],
    ['Local-model runtime path configuration has an invalid schema.', 'local_paths_invalid'],
    ['Local-model runtime path configuration version is unsupported.', 'local_paths_invalid'],
    ['Local-model runtime path configuration exceeds its size limit or is not a file.', 'local_paths_invalid'],
    ['Local-model runtime path configuration exceeds its size limit.', 'local_paths_invalid'],
    ['Local-model runtime path configuration cannot be read.', 'local_paths_invalid'],
    ['Local-model configuration directory is unavailable.', 'local_paths_invalid'],
    ['Local-model runtime path cannot be inspected.', 'local_paths_invalid'],
    ['Local-model runtime paths must not contain symbolic links or reparse points.', 'local_paths_invalid'],
    ['LUCZOR_LLAMA_CPP_BIN is not configured.', 'runtime_not_configured'],
    ['LUCZOR_LOCAL_MODEL_DIR is not configured.', 'model_directory_not_configured'],
    ['Configured llama.cpp runtime is unavailable.', 'runtime_unavailable'],
    ['Configured local-model directory is unavailable.', 'model_files_unavailable'],
    ['Configured GGUF file is unavailable.', 'model_files_unavailable'],
    ['Local-model runtime and model directory must be absolute local paths.', 'local_paths_invalid'],
    ['Configured local-model files are invalid.', 'local_paths_invalid'],
    ['Configured GGUF size does not match the signed manifest.', 'artifact_mismatch'],
    ['Configured GGUF hash does not match the signed manifest.', 'artifact_mismatch'],
    ['Configured llama.cpp runtime hash does not match the signed manifest.', 'runtime_mismatch'],
    ['Local model readiness evidence is stale or mismatched.', 'readiness_mismatch'],
    ['Total RAM is below the signed model threshold.', 'total_ram_below_minimum'],
    ['Available RAM is below the signed model threshold.', 'available_ram_below_minimum'],
    ['GPU VRAM is below the signed model threshold.', 'vram_below_minimum'],
    ['No compatible GPU runtime satisfies the signed model capacity policy.', 'accelerator_runtime_unavailable'],
    [
      'Local runtime startup stopped to protect available RAM (runtime_startup_ram_pressure).',
      'runtime_startup_ram_pressure',
    ],
    ['Model storage does not satisfy the signed storage class or free-space threshold.', 'storage_unavailable'],
    ['Local benchmark did not meet the signed capacity thresholds.', 'benchmark_failed'],
    ['Local benchmark request failed.', 'benchmark_failed'],
  ])
  return (
    reasons.get(nativeMessage) ??
    (localReadinessMessages.has(nativeMessage) ? nativeMessage : 'local_preparation_failed')
  )
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
    ![1, 2].includes(input.schema_version) ||
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
      acceleratorMemoryScope: policy.acceleratorMemoryScope,
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
  now: () => Date = () => new Date(),
  expectedTaskType?: string
): InferenceGateway {
  let consumed = false
  return Object.freeze({
    id: `laravel:approved:${approvalId}`,
    target: 'laravel_proxy' as const,
    async streamChatWithTools(request: InferenceRequest) {
      if (expectedTaskType !== undefined && request.taskType !== expectedTaskType) {
        throw new LocalInferenceError(
          'Die externe Anfrage gehört nicht zur ausgewählten Spezialistenaufgabe.',
          'routing_intent_invalid',
          false,
          false
        )
      }
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

export type LocalModelAdmission = Readonly<{
  modelReleaseId: string
  enabled: boolean
  executable: boolean
  capacity: CapacityAssessment['status'] | 'unknown'
  memory?: CapacityAssessment['memory']
  ready: boolean
  health: ReturnType<LocalModelManager['getHealth']>['state']
  admissible: boolean
  reasons: readonly string[]
}>

export class LocalInferenceCoordinator {
  private preparation?: { modelId: string; generation: number }
  private mode: CoordinatorMode = 'blocked'
  private reason = 'bootstrap_not_initialized'
  private manifest?: VerifiedLocalModelManifest
  private discovery?: Discovery
  private bootstrap?: BootstrapResponse
  private account?: VerifiedAccountSnapshot
  private assessments = new Map<string, CapacityAssessment>()
  private lastMemoryRecoveryAt = -Infinity
  private readiness = new Map<string, LocalReadinessEvidence>()
  private preparationFailures = new Map<string, string>()
  /** Retryable preparation attempts per release, bounded by its signed health policy. */
  private preparationRetries = new Map<string, number>()
  private catalogBinding?: LocalCatalogBinding
  private generation = 0
  private resourceEpoch = 0
  private resourceRevision = 0
  private localScope?: { projectId: string; digest: string }
  private preparationTail: Promise<void> = Promise.resolve()
  private recovery?: { generation: number; diagnoseUnavailable: boolean; promise: Promise<InferenceConnectionResult> }

  constructor(private readonly dependencies: LocalInferenceCoordinatorDependencies) {}

  /** Called only behind the whole-job resource barrier; never between tool rounds. */
  async unloadResidentForModelChange(selectedModelId: string | null, onUnloading: (id: string) => void): Promise<void> {
    const generation = this.generation
    const previous = this.preparationTail
    let releaseQueue: () => void = () => undefined
    this.preparationTail = new Promise<void>(resolve => {
      releaseQueue = resolve
    })
    await previous
    try {
      this.requireActiveGeneration(generation)
      if (
        selectedModelId &&
        !this.manifest?.models.some(
          model => model.id === selectedModelId && model.enabled && isExecutableLocalModel(model)
        )
      ) {
        throw new Error('local_model_selection_unavailable')
      }
      if (!this.dependencies.nativeStatus) throw new Error('local_model_status_unavailable')
      const native = await this.dependencies.nativeStatus()
      this.requireActiveGeneration(generation)
      if (native.activeModelId) {
        const release = this.manifest?.models.find(model => model.id === native.activeModelId)
        if (!release || !this.catalogBinding) throw new Error('local_model_resident_binding_unavailable')
        onUnloading(release.id)
        await this.dependencies.manager.stop(release, this.catalogBinding)
        this.requireActiveGeneration(generation)
      }
      // Re-measure capacity after confirmed process termination, without its old allocations.
      this.readiness.clear()
      this.assessments.clear()
      this.preparationFailures.clear()
      this.preparationRetries.clear()
      this.localScope = undefined
      await this.refreshCapacityIfStale(generation)
    } finally {
      releaseQueue()
    }
  }

  resourcesApplied(revision: number): void {
    if (revision <= this.resourceRevision) return
    this.runtimeReleased()
    this.resourceRevision = revision
  }

  /** A successful idle systemcheck removed residency without changing settings. */
  runtimeReleased(): void {
    this.dependencies.manager.invalidateResourceBoundary()
    this.resourceEpoch += 1
    this.localScope = undefined
    this.assessments.clear()
    this.readiness.clear()
    this.preparationFailures.clear()
    this.preparationRetries.clear()
  }

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

  /** Explicit retry also repairs a startup failure with unchanged server credentials. */
  reinitialize(options: { diagnoseUnavailable?: boolean } = {}): Promise<InferenceConnectionResult> {
    if (this.recovery?.generation === this.generation) {
      this.recovery.diagnoseUnavailable ||= options.diagnoseUnavailable === true
      return this.recovery.promise
    }
    const generation = this.beginBootstrap()
    const recovery = {
      generation,
      diagnoseUnavailable: options.diagnoseUnavailable === true,
      promise: Promise.resolve(staleConnectionResult()),
    }
    this.recovery = recovery
    recovery.promise = (async (): Promise<InferenceConnectionResult> => {
      let failureReason = 'manifest_session_unavailable'
      try {
        await this.dependencies.manifestSession(generation)
        if (!this.isCurrent(generation)) return staleConnectionResult()
        failureReason = 'server_unreachable'
        const bootstrap = await this.dependencies.bootstrap()
        if (!this.isCurrent(generation)) return staleConnectionResult()
        await this.initialize(bootstrap, generation)
        if (this.recovery !== recovery || !this.isCurrent(recovery.generation)) return staleConnectionResult()
        if (recovery.diagnoseUnavailable && this.reason === 'manifest_unavailable') {
          await this.diagnoseUnavailableManifest(bootstrap, recovery.generation)
          if (this.recovery !== recovery || !this.isCurrent(recovery.generation)) return staleConnectionResult()
        }
        const policy = localPolicyDiagnostic(this.mode, this.reason)
        return {
          ok: policy.mode === 'active',
          connected: true,
          stale: false,
          policy,
          message: `Server verbunden. ${policy.message}`,
        }
      } catch (error) {
        if (this.recovery !== recovery || !this.isCurrent(recovery.generation)) return staleConnectionResult()
        this.markBootstrapUnavailable(policyFailureReason(error, failureReason), recovery.generation)
        const policy = localPolicyDiagnostic(this.mode, this.reason)
        return { ok: false, connected: false, stale: false, policy, message: policy.message }
      } finally {
        if (this.recovery === recovery) this.recovery = undefined
      }
    })()
    return recovery.promise
  }

  /** Read only, explicitly requested diagnostics never accept or activate an envelope. */
  private async diagnoseUnavailableManifest(bootstrap: BootstrapResponse, generation: number): Promise<void> {
    let failureReason = 'account_verification_failed'
    try {
      const account = await this.dependencies.accountSnapshot()
      if (!this.isCurrent(generation)) return
      if (!account || account.accountId !== bootstrap.user?.id) {
        this.blockGeneration(generation, failureReason)
        return
      }
      failureReason = 'manifest_unavailable'
      await this.dependencies.fetchManifest(account.config)
      // Even an unexpected HTTP 200 cannot override discovery.available=false.
    } catch (error) {
      if (!this.isCurrent(generation)) return
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        error.status === 503 &&
        'code' in error &&
        typeof error.code === 'string' &&
        manifestSigningDiagnostics.has(error.code)
      ) {
        failureReason = error.code
      }
      this.blockGeneration(generation, policyFailureReason(error, failureReason))
    }
  }

  status(): {
    mode: CoordinatorMode
    reason: string
    appliedResourceRevision?: number
    preparingModelId?: string
    manifest?: VerifiedLocalModelManifest
    admissions: readonly LocalModelAdmission[]
  } {
    return {
      mode: this.mode,
      reason: this.reason,
      appliedResourceRevision: this.resourceRevision,
      preparingModelId: this.preparation?.generation === this.generation ? this.preparation.modelId : undefined,
      manifest: this.manifest,
      admissions: this.modelAdmissions(),
    }
  }

  modelAdmissions(taskType?: string, capability?: InferenceCapability): readonly LocalModelAdmission[] {
    const requiredCapability = capability ?? requiredCapabilityForTask(taskType)
    const now = this.dependencies.now().getTime()
    return Object.freeze(
      (this.manifest?.models ?? []).map(model => {
        const assessment = this.assessments.get(model.id)
        const readiness = this.readiness.get(model.id)
        const health = this.dependencies.manager.getHealth(model)
        const executable = isExecutableLocalModel(model)
        const capacityAccepted = assessment?.status === 'eligible' || assessment?.status === 'degraded'
        const ready = hasVerifiedLocalReadiness(model, readiness, this.manifest!.payloadSha256, now)
        const reasons = [] as string[]
        if (!model.enabled) reasons.push('model_disabled')
        if (!executable) reasons.push('release_not_executable')
        if (!model.capabilities.includes(requiredCapability)) reasons.push('capability_unavailable')
        if (!assessment) reasons.push('capacity_unknown')
        else if (!capacityAccepted) reasons.push(...assessment.reasons)
        if (health.state === 'cooldown' || health.state === 'error') reasons.push(`health_${health.state}`)
        if (!ready) reasons.push(this.preparationFailures.get(model.id) ?? 'readiness_pending')
        return Object.freeze({
          modelReleaseId: model.id,
          enabled: model.enabled,
          executable,
          capacity: assessment?.status ?? 'unknown',
          memory: assessment?.memory,
          ready,
          health: health.state,
          admissible:
            this.mode === 'active' &&
            model.enabled &&
            executable &&
            model.capabilities.includes(requiredCapability) &&
            capacityAccepted &&
            health.state !== 'cooldown' &&
            health.state !== 'error',
          reasons: Object.freeze(reasons),
        })
      })
    )
  }

  reconcileNativeStatus(native: NativeLocalModelStatus): void {
    if (
      !this.manifest ||
      native.catalogVersion !== this.manifest.catalogVersion ||
      native.policyVersion !== this.manifest.policyVersion
    )
      return
    if ((native.resourceConfig?.appliedRevision ?? 0) < this.resourceRevision) return
    if (native.resourceConfig && native.resourceConfig.appliedRevision !== this.resourceRevision) {
      this.resourcesApplied(native.resourceConfig.appliedRevision)
    }
    for (const model of this.manifest.models) {
      const evidence = native.readiness.find(item => item.modelReleaseId === model.id)
      const running = native.activeModelId === model.id && (native.state === 'ready' || native.state === 'busy')
      if (
        running &&
        (evidence?.resourceRevision ?? 0) === this.resourceRevision &&
        hasVerifiedLocalReadiness(model, evidence, this.manifest.payloadSha256, this.dependencies.now().getTime())
      ) {
        this.readiness.set(model.id, evidence!)
      } else {
        this.readiness.delete(model.id)
      }
    }
  }

  async initialize(bootstrap: BootstrapResponse, expectedPendingGeneration?: number): Promise<boolean> {
    if (expectedPendingGeneration !== undefined && expectedPendingGeneration !== this.generation) {
      return false
    }
    this.dependencies.manager.invalidateCatalogBoundary()
    const generation = ++this.generation
    if (expectedPendingGeneration !== undefined && this.recovery?.generation === expectedPendingGeneration) {
      this.recovery.generation = generation
    }
    this.clearPolicyState()
    this.mode = 'loading'
    this.reason = 'bootstrap_pending'
    this.bootstrap = bootstrap

    let failureReason = 'manifest_session_unavailable'
    try {
      const acceptanceSessionId = await this.dependencies.manifestSession(generation)
      if (!this.isCurrent(generation)) return false
      if (!bootstrap.local_model_manifest) {
        this.blockGeneration(generation, 'manifest_discovery_missing')
        return true
      }
      failureReason = 'manifest_discovery_invalid'
      const discovery = exactDiscovery(bootstrap.local_model_manifest)
      this.discovery = discovery
      if (!discovery.available) {
        this.blockGeneration(generation, 'manifest_unavailable')
        return true
      }
      failureReason = 'account_verification_failed'
      const account = await this.dependencies.accountSnapshot()
      if (!this.isCurrent(generation)) return false
      if (!account || account.accountId !== bootstrap.user.id) {
        throw new Error('Verified account principal does not match bootstrap.')
      }
      const trustDomain = await deriveLocalModelManifestTrustDomain(account)
      if (!this.isCurrent(generation)) return false
      failureReason = 'manifest_fetch_failed'
      const envelope = await this.dependencies.fetchManifest(account.config)
      if (!this.isCurrent(generation)) return false
      failureReason = 'manifest_verification_failed'
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

      failureReason = 'hardware_snapshot_failed'
      const executionMode = await this.dependencies.resourceMode?.()
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
            executionMode,
            modelReleaseId: model.id,
            manifestPayloadSha256: verified.payloadSha256,
            policy: capacity.policy,
            artifactSizeBytes: capacity.artifactSizeBytes,
            now: this.dependencies.now(),
            validForMs: 30_000,
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
      this.mode = 'active'
      this.reason = 'signed_policy_active'
      return true
    } catch (error) {
      this.blockGeneration(generation, policyFailureReason(error, failureReason))
      return this.isCurrent(generation)
    }
  }

  /** Local idle work never refreshes a catalog, prepares a runtime or selects a fallback. */
  async residentOptimizationGateway(projectId: string, modelId: string): Promise<InferenceGateway> {
    const generation = this.generation
    this.requireActiveGeneration(generation)
    const manifest = this.manifest!
    const release = manifest.models.find(model => model.id === modelId)
    const readiness = this.readiness.get(modelId)
    if (
      Date.parse(manifest.expiresAt) <= this.dependencies.now().getTime() + 65_000 ||
      !hasVerifiedLocalReadiness(
        release,
        readiness,
        manifest.payloadSha256,
        this.dependencies.now().getTime() + 65_000
      ) ||
      !release ||
      !readiness ||
      ['busy', 'cooldown', 'error', 'degraded'].includes(this.dependencies.manager.getHealth(release).state)
    ) {
      throw new LocalInferenceError(
        'Leerlaufoptimierung wartet auf ein bereits bereites lokales Modell.',
        'idle_model_not_ready',
        false,
        false
      )
    }
    const digest =
      this.localScope?.projectId === projectId
        ? this.localScope.digest
        : await this.scopeDigest({ projectId }, generation)
    this.requireActiveGeneration(generation)
    return this.dependencies.manager.gateway(release, readiness, this.catalogBinding!, digest, true)
  }

  async resolveTurn(input: TurnRoutingInput): Promise<ResolvedTurnRoute> {
    if (
      input.intent !== undefined &&
      (input.intent !== 'external_specialist' || !EXTERNAL_SPECIALIST_TASK_TYPES.has(input.taskType ?? ''))
    ) {
      throw new LocalInferenceError(
        'Die externe Spezialistenroute ist nur für freigegebene Agentenaufgaben verfügbar.',
        'routing_intent_invalid',
        false,
        false
      )
    }
    const preferExternal = input.intent === 'external_specialist'
    let generation = this.generation
    if (this.mode !== 'active' || !this.manifest || !this.bootstrap || !this.account) {
      throw new LocalInferenceError(
        localPolicyDiagnostic(this.mode, this.reason).message,
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
    // An explicit external composer choice must not pay for a local cold start
    // it will never use. It still grants no permission: the external branch of
    // decideHybridRoute keeps demanding routing.externalAllowed plus a per-turn
    // approval bound to this exact packet hash.
    const skipLocalPreparation = preferExternal || settings.preference === 'force_external'
    if (!skipLocalPreparation && this.dependencies.nativeStatus) {
      const native = await this.dependencies.nativeStatus()
      this.requireActiveGeneration(generation)
      this.reconcileNativeStatus(native)
    }
    if (!skipLocalPreparation) await this.refreshCapacityIfStale(generation)
    this.requireActiveGeneration(generation)
    const requiredCapability = input.requiredCapability ?? requiredCapabilityForTask(input.taskType)
    const localReadinessPending = skipLocalPreparation
      ? false
      : await this.prepareFirstAdmissibleCandidate(settings, requiredCapability, generation)
    // A cold start/benchmark can outlive the short hardware snapshot. Re-measure
    // after preparation so its own newly allocated RAM is counted as resident.
    if (!skipLocalPreparation) await this.refreshCapacityIfStale(generation, false)
    this.requireActiveGeneration(generation)
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
      requiredCapability,
      preferExternal,
      localReadinessPending,
      now: this.dependencies.now(),
    })

    if (decision.target === 'local_llama_cpp' && decision.modelReleaseId) {
      const release = this.manifest.models.find(model => model.id === decision.modelReleaseId)
      const readiness = this.readiness.get(decision.modelReleaseId)
      if (!release || !readiness) throw new Error('Selected local release lost readiness.')
      const scopeDigest = await this.scopeDigest(input, generation)
      this.localScope = { projectId: input.projectId, digest: scopeDigest }
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
          this.dependencies.now,
          preferExternal ? input.taskType : undefined
        ),
        replacementMessages: cloneMessages(input.externalPackage.messages),
        decision,
        externalOneShot: true,
      }
    }
    const unavailableMessage = preferExternal
      ? externalSpecialistUnavailableMessage(decision.reason)
      : this.unavailableRouteMessage(settings, input.taskType, decision.reason, requiredCapability)
    if (!preferExternal && decision.reason === 'local_only_blocked') openResourceRecovery(unavailableMessage)
    throw new LocalInferenceError(
      unavailableMessage,
      decision.reason,
      false,
      false
    )
  }

  private async prepareIfEligible(modelId: string, generation = this.generation, allowDegraded = false): Promise<void> {
    const previous = this.preparationTail
    let releaseQueue: () => void = () => undefined
    this.preparationTail = new Promise<void>(resolve => {
      releaseQueue = resolve
    })
    await previous
    try {
      await this.prepareIfEligibleExclusive(modelId, generation, allowDegraded)
    } finally {
      releaseQueue()
    }
  }

  private async prepareIfEligibleExclusive(modelId: string, generation: number, allowDegraded: boolean): Promise<void> {
    if (!this.isCurrent(generation) || !this.manifest || !this.catalogBinding) return
    const manifestHash = this.manifest.payloadSha256
    const resourceEpoch = this.resourceEpoch
    const catalogBinding = this.catalogBinding
    const model = this.manifest.models.find(candidate => candidate.id === modelId)
    const current = this.readiness.get(modelId)
    if (hasVerifiedLocalReadiness(model, current, manifestHash, this.dependencies.now().getTime())) {
      return
    }
    this.readiness.delete(modelId)
    this.preparationFailures.delete(modelId)
    const assessment = this.assessments.get(modelId)
    if (assessment?.status !== 'eligible' && !(allowDegraded && assessment?.status === 'degraded')) return
    const preparation = { modelId, generation }
    this.preparation = preparation
    try {
      const readiness = await this.dependencies.prepareModel(modelId, catalogBinding)
      if (
        this.isCurrent(generation) &&
        this.resourceEpoch === resourceEpoch &&
        this.manifest?.payloadSha256 === manifestHash &&
        this.catalogBinding === catalogBinding
      ) {
        if ((readiness.resourceRevision ?? 0) < this.resourceRevision) {
          this.preparationFailures.set(modelId, 'resource_revision_mismatch')
        } else if (hasVerifiedLocalReadiness(model, readiness, manifestHash, this.dependencies.now().getTime())) {
          this.resourceRevision = readiness.resourceRevision ?? 0
          this.readiness.set(modelId, readiness)
        } else {
          this.preparationFailures.set(modelId, 'readiness_mismatch')
        }
      }
    } catch (error) {
      if (this.isCurrent(generation) && this.resourceEpoch === resourceEpoch) {
        this.readiness.delete(modelId)
        this.preparationFailures.set(modelId, preparationFailureReason(error))
      }
    } finally {
      if (this.preparation === preparation) this.preparation = undefined
    }
  }

  /**
   * Returns true when a candidate cleared every static gate but has no verified
   * readiness yet. That is a warming runtime, not an unavailable one, so routing
   * keeps waiting instead of offering external egress. A release that keeps
   * failing lands in cooldown/error and stops counting as pending.
   */
  private async prepareFirstAdmissibleCandidate(
    settings: HybridRoutingSettings,
    requiredCapability: InferenceCapability,
    generation: number
  ): Promise<boolean> {
    if (!this.manifest) return false
    const experimental = settings.experimentalFlashNext
      ? this.manifest.routing.experimentalModelIds.filter(modelId => {
          const model = this.manifest?.models.find(candidate => candidate.id === modelId)
          return model && !model.promoted
        })
      : []
    const ids = settings.localModelId
      ? [settings.localModelId]
      : [...new Set([...experimental, this.manifest.routing.defaultModelId, ...this.manifest.routing.fallbackModelIds])]
    if (this.manifest.schemaVersion === 2) {
      ids.sort(
        (left, right) =>
          Number(!!this.assessments.get(right)?.memory?.resident) -
          Number(!!this.assessments.get(left)?.memory?.resident)
      )
    }
    let pending = false
    for (const modelId of ids) {
      const model = this.manifest.models.find(candidate => candidate.id === modelId)
      const assessment = this.assessments.get(modelId)
      const health = model ? this.dependencies.manager.getHealth(model) : undefined
      const capacityAccepted =
        assessment?.status === 'eligible' || (assessment?.status === 'degraded' && settings.allowDegradedLocal)
      if (
        !model ||
        !isExecutableLocalModel(model) ||
        !model.capabilities.includes(requiredCapability) ||
        !capacityAccepted ||
        health?.state === 'cooldown' ||
        health?.state === 'error'
      ) {
        continue
      }
      await this.prepareIfEligible(modelId, generation, settings.allowDegradedLocal)
      this.requireActiveGeneration(generation)
      const readiness = this.readiness.get(modelId)
      if (hasVerifiedLocalReadiness(model, readiness, this.manifest.payloadSha256, this.dependencies.now().getTime())) {
        this.preparationRetries.delete(modelId)
        return false
      }
      const failure = this.preparationFailures.get(modelId) ?? 'readiness_pending'
      if (!RETRYABLE_LOCAL_PREPARATION_REASONS.has(failure)) {
        this.preparationRetries.delete(modelId)
        continue
      }
      // A retryable local start keeps the turn local until the signed health
      // policy has seen enough attempts. Without this, one slow or resource-tight
      // cold start diverts the very next turn into the external approval dialog.
      const attempts = (this.preparationRetries.get(modelId) ?? 0) + 1
      this.preparationRetries.set(modelId, attempts)
      if (attempts <= Math.max(1, model.healthPolicy.maxConsecutiveFailures)) pending = true
    }
    return pending
  }

  private unavailableRouteMessage(
    settings: HybridRoutingSettings,
    taskType: string | undefined,
    reason: RouteDecision['reason'],
    capability?: InferenceCapability
  ): string {
    const manifest = this.manifest!
    const candidates = new Set<string>(
      settings.localModelId
        ? [settings.localModelId]
        : [
            ...(settings.experimentalFlashNext ? manifest.routing.experimentalModelIds : []),
            manifest.routing.defaultModelId,
            ...manifest.routing.fallbackModelIds,
          ]
    )
    const admissions = this.modelAdmissions(taskType, capability).filter(model => candidates.has(model.modelReleaseId))
    const enabledCandidates = admissions.filter(model => model.enabled)
    const attempted = enabledCandidates.filter(model => this.preparationFailures.has(model.modelReleaseId))
    const diagnostics = (attempted.length ? attempted : enabledCandidates.length ? enabledCandidates : admissions)
      .filter(model => candidates.has(model.modelReleaseId))
      .flatMap(model => {
        if (!model.enabled) return ['model_disabled']
        if (!model.executable) return ['release_not_executable']
        if (model.capacity === 'degraded' && !settings.allowDegradedLocal) {
          return this.assessments.get(model.modelReleaseId)?.reasons ?? ['resource_pressure']
        }
        return model.reasons.filter(item => item !== 'readiness_pending' || model.reasons.length === 1)
      })
    const messages = [
      ...new Set(
        diagnostics
          .map(code => {
            if (code === 'available_ram_below_minimum') {
              const memory = enabledCandidates
                .map(model => this.assessments.get(model.modelReleaseId)?.memory)
                .find(item => item && !item.resident && item.availableBytes < item.requiredAvailableBytes)
              if (memory) {
                const gib = (bytes: number) => (bytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1 })
                return `Zu wenig freier RAM: ${gib(memory.availableBytes)} GiB verfügbar, ${gib(memory.requiredAvailableBytes)} GiB für den Modellstart benötigt. Luczor prüft den Speicher beim nächsten Versuch erneut.`
              }
            }
            return localReadinessMessages.get(code)
          })
          .filter(Boolean)
      ),
    ]
    const local = messages.slice(0, 3).join(' ') || localReadinessMessages.get('readiness_pending')!
    const external =
      reason === 'local_readiness_pending'
        ? 'Luczor bereitet das lokale Modell noch vor und wechselt deshalb nicht von selbst zu einem externen Modell. Für einen externen Lauf im Eingabefeld den Modus „Externes Modell" wählen.'
        : reason === 'external_approval_required'
          ? 'Ein externer Fallback ist nur nach ausdrücklicher Freigabe dieses Nachrichtenpakets möglich.'
          : reason === 'local_only_blocked'
            ? 'Dieser Chat ist auf lokale Modelle eingestellt.'
            : 'Die Modellrichtlinie erlaubt für diesen Auftrag keinen externen Fallback.'
    return `${local} ${external}`
  }

  private async refreshCapacityIfStale(generation: number, recheckRejected = true): Promise<void> {
    if (!this.isCurrent(generation) || !this.manifest) return
    const manifest = this.manifest
    const executionMode = await this.dependencies.resourceMode?.()
    if (!this.isCurrent(generation)) return
    const now = this.dependencies.now().getTime()
    const residentCandidate = manifest.models.some(model => {
      const assessment = this.assessments.get(model.id)
      return (
        model.enabled &&
        isExecutableLocalModel(model) &&
        assessment?.memory?.resident &&
        assessment.status === 'eligible' &&
        hasVerifiedLocalReadiness(model, this.readiness.get(model.id), manifest.payloadSha256, now)
      )
    })
    const stale = manifest.models.some(model => {
      if (!model.enabled) return false
      const capacity = executableCapacity(model)
      const assessment = this.assessments.get(model.id)
      return (
        capacity &&
        (!assessment ||
          assessment.validUntilMs <= now ||
          (recheckRejected && !residentCandidate && assessment.status === 'ineligible'))
      )
    })
    if (!stale) return
    let snapshot = await this.dependencies.hardwareSnapshot()
    if (!this.isCurrent(generation) || this.manifest?.payloadSha256 !== manifest.payloadSha256) return
    const memoryBlocked = manifest.models.some(
      model =>
        model.enabled &&
        isExecutableLocalModel(model) &&
        snapshot.memory.availableBytes < (model.capacityPolicy.minAvailableRamBytes ?? 0) &&
        !(
          snapshot.memory.residentModel?.modelReleaseId === model.id &&
          snapshot.memory.residentModel.manifestPayloadSha256 === manifest.payloadSha256
        )
    )
    const residentRelease = manifest.models.find(model => model.id === snapshot.memory.residentModel?.modelReleaseId)
    const residentInCurrentCatalog =
      residentRelease?.enabled &&
      isExecutableLocalModel(residentRelease) &&
      snapshot.memory.residentModel?.manifestPayloadSha256 === manifest.payloadSha256
    if (
      memoryBlocked &&
      !residentInCurrentCatalog &&
      this.dependencies.recoverMemory &&
      now - this.lastMemoryRecoveryAt >= 60_000
    ) {
      this.lastMemoryRecoveryAt = now
      try {
        snapshot = await this.dependencies.recoverMemory()
      } catch {
        /* Reassess the measured snapshot if trimming is unavailable. */
      }
      if (!this.isCurrent(generation) || this.manifest?.payloadSha256 !== manifest.payloadSha256) return
    }
    for (const model of manifest.models) {
      const capacity = executableCapacity(model)
      if (!capacity) continue
      this.assessments.set(
        model.id,
        assessModelCapacity({
          snapshot,
          executionMode,
          modelReleaseId: model.id,
          manifestPayloadSha256: manifest.payloadSha256,
          policy: capacity.policy,
          artifactSizeBytes: capacity.artifactSizeBytes,
          now: this.dependencies.now(),
          validForMs: 30_000,
        })
      )
    }
  }

  private async scopeDigest(input: TurnRoutingInput, generation: number): Promise<string> {
    const bootstrap = this.bootstrap
    const account = this.account
    const deviceId = bootstrap?.device.id
    const desktopSessionId = this.catalogBinding?.acceptanceSessionId
    const principalId = account?.principalId ?? ''
    if (!principalId || !deviceId?.trim() || !desktopSessionId || !input.projectId.trim()) {
      throw new LocalInferenceError('Der lokale Inferenzscope ist unvollständig.', 'scope_unavailable', false, false)
    }
    // This digest owns the resident process, not a conversation or task. Each
    // inference still submits its full messages with native prompt caching off.
    // The manifest session is stable across turns but changes on renderer reload.
    const digest = await sha256(
      canonicalScope({
        schema: 'luczor-local-runtime-scope-v2',
        principalId,
        deviceId,
        serverInstance: account!.serverInstance,
        desktopSessionId,
        projectId: input.projectId,
        repoId: input.repoId ?? 'none',
      })
    )
    this.requireActiveGeneration(generation)
    return digest
  }

  private clearPolicyState(): void {
    this.localScope = undefined
    this.bootstrap = undefined
    this.discovery = undefined
    this.manifest = undefined
    this.account = undefined
    this.catalogBinding = undefined
    this.assessments.clear()
    this.readiness.clear()
    this.preparationFailures.clear()
    this.preparationRetries.clear()
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
  fetchManifest: async config =>
    localModelManifestWithApiConfig(config, undefined, modelPlatformTarget(await getNativeHardwareSnapshot())),
  verifyManifest: verifyLocalModelManifest,
  hardwareSnapshot: getNativeHardwareSnapshot,
  resourceMode: async () => (await localResources.get()).applied.mode,
  recoverMemory: recoverNativeModelMemory,
  nativeStatus: getNativeLocalModelStatus,
  prepareModel: prepareNativeLocalModel,
  accountSnapshot: getVerifiedAccountSnapshot,
  manifestSession: beginNativeManifestAcceptance,
  manager: defaultManager,
  now: () => new Date(),
})

onLocalResourcesApplied(state => {
  localInferenceCoordinator.resourcesApplied(state.appliedRevision)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('luczor:resources-applied'))
})
onLocalRuntimeReleased(() => {
  localInferenceCoordinator.runtimeReleased()
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('luczor:resources-applied'))
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

/** Re-check the current identity explicitly; overlapping requests share one generation. */
export function reinitializeLocalInferenceForCurrentApi(
  options: { diagnoseUnavailable?: boolean } = {}
): Promise<InferenceConnectionResult> {
  return localInferenceCoordinator.reinitialize(options)
}

export function resolveInferenceRouteForTurn(input: TurnRoutingInput): Promise<ResolvedTurnRoute> {
  const usage = modelUsageSettings.value
  return localInferenceCoordinator.resolveTurn({
    ...input,
    routingSettings: {
      ...input.routingSettings,
      localModelId: input.routingSettings?.localModelId ?? usage.localModelId,
      ...(!usage.externalEnabled ? { preference: 'local_only' as const } : {}),
    },
    ...(!usage.externalEnabled ? { contextEgress: 'local_only' as const, externalPackage: undefined } : {}),
  })
}
