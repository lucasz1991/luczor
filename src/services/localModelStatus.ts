import { localInferenceCoordinator, localPolicyDiagnostic } from '@/services/inference/coordinator'
import { hasVerifiedLocalReadiness } from '@/services/inference/hybridRouter'
import { getNativeLocalModelStatus, type NativeLocalModelStatus } from '@/services/inference/tauriLocalRuntime'
import type { LocalResourceConfigState } from '@/services/inference/resources'
import { modelUsageSettings } from '@/services/inference/modelUsageSettings'

type CoordinatorStatus = ReturnType<typeof localInferenceCoordinator.status>
type StatusState = 'unavailable' | 'loading' | 'unprepared' | 'cold' | 'ready' | 'busy' | 'blocked' | 'error'
type StatusCheck = { label: string; value: string; verified: boolean }

export type LocalModelStatusView = {
  state: StatusState
  label: string
  detail: string
  modelName: string
  modelId?: string
  prepared: boolean
  operational: boolean
  checks: StatusCheck[]
  checkedAtMs: number
  resourceConfig?: LocalResourceConfigState
  /** Context window the resident runtime was actually started with, once the plan is applied. */
  contextTokens?: number
}

export const localResourceModeLabels = {
  auto: 'Automatisch',
  gpu: 'GPU mit Automatik',
  cpu: 'Nur CPU/RAM',
  hybrid: 'Erzwungener Split',
} as const

const gpuMessages = new Map<string, string>([
  [
    'runtime_gpu_hybrid_retry',
    'GPU-Speicher war knapp: erneute automatische Aufteilung mit mehr VRAM-Reserve und größerem CPU/RAM-Anteil. Die Messwerte zeigen die tatsächlich aktive Aufteilung.',
  ],
  [
    'gpu_mode_auto_fallback_unavailable',
    'GPU-Wunsch konnte nicht erfüllt werden: keine passende Grafikkarte verfügbar. Automatik übernimmt.',
  ],
  [
    'gpu_mode_auto_fallback_unsupported',
    'Vollständiger GPU-Betrieb wird von dieser Runtime nicht unterstützt. Automatik übernimmt.',
  ],
  [
    'gpu_mode_auto_fallback_capacity',
    'Das Modell passt nicht vollständig in den verfügbaren Grafikspeicher. Automatik verteilt die Arbeit.',
  ],
  ['gpu_mode_auto_fallback_unconfirmed', 'Vollständige GPU-Auslagerung wurde nicht bestätigt. Automatik übernimmt.'],
  ['gpu_mode_auto_fallback_cpu', 'GPU-Betrieb ist derzeit nicht möglich. Die Automatik verwendet die CPU.'],
  [
    'runtime_gpu_capacity_cpu_fallback',
    'Der GPU-Start überschritt das verfügbare Speicherbudget. CPU als Ersatz aktiv.',
  ],
  ['runtime_gpu_start_failed', 'GPU-Start fehlgeschlagen; CPU als Ersatz aktiv.'],
  ['runtime_gpu_probe_unavailable', 'Die GPU-Fähigkeiten der Runtime konnten nicht geprüft werden.'],
  ['runtime_gpu_unavailable', 'Die geprüfte Runtime stellt keine passende Grafikkarte bereit.'],
  ['runtime_gpu_fit_unavailable', 'Die Runtime unterstützt keine automatische Aufteilung auf GPU und RAM.'],
  ['runtime_gpu_memory_unavailable', 'Für die GPU ist kein ausreichender freier Grafikspeicher bestätigt.'],
  ['runtime_gpu_no_layers_offloaded', 'Die Runtime hat keine Modellschichten auf die GPU ausgelagert.'],
  ['runtime_cpu_configured', 'Die freigegebene Runtime ist für CPU-Betrieb eingerichtet.'],
])

const preparationMessages = new Map<string, string>([
  [
    'resource_gpu_selection_changed',
    'Die gespeicherte Grafikkartenauswahl passt nicht mehr zu diesem Gerät. Auswahl in den Ressourceneinstellungen erneuern.',
  ],
  [
    'resource_gpu_selection_ambiguous',
    'Die gespeicherte Grafikkarte kann nicht eindeutig zugeordnet werden. Auswahl in den Ressourceneinstellungen erneuern.',
  ],
  [
    'resource_gpu_selection_unavailable',
    'Eine ausgewählte Grafikkarte ist nicht verfügbar. Auswahl prüfen oder Automatik verwenden.',
  ],
  ['gpu_full_offload_not_verified', 'Vollständiger GPU-Offload wurde nicht bestätigt.'],
  [
    'forced_split_unavailable',
    'Erzwungener Split benötigt eine passende GPU-Runtime und freien Grafikspeicher. Kein CPU-Ersatzbetrieb.',
  ],
  [
    'forced_split_metadata_unavailable',
    'Die Modellschichten konnten für den erzwungenen Split nicht sicher bestimmt werden.',
  ],
  [
    'forced_split_not_verified',
    'Die Runtime hat keinen echten CPU/GPU-Split bestätigt. Ressourcen prüfen oder Automatik wählen.',
  ],
  ['runtime_gpu_measurement_unavailable', 'Die tatsächliche GPU-Nutzung konnte beim Start nicht bestätigt werden.'],
  [
    'runtime_gpu_required_no_offload',
    'Das Modell benötigt eine GPU, aber die Runtime hat keine Modellschichten ausgelagert.',
  ],
  [
    'cpu_mode_disallowed_by_manifest',
    'Dieses Modell benötigt laut signierter Freigabe eine GPU. Bitte Automatik oder GPU-Modus wählen.',
  ],
  [
    'ram_budget_insufficient',
    'Für das Modell und den eingestellten RAM-Puffer ist nicht genug Arbeitsspeicher verfügbar.',
  ],
  ['resource_threads_invalid', 'Die eingestellte Threadanzahl passt nicht zu den verfügbaren Prozessorkernen.'],
  ['resource_ram_reserve_invalid', 'Der RAM-Puffer passt nicht zum verfügbaren Arbeitsspeicher.'],
  ['resource_vram_reserve_invalid', 'Der VRAM-Puffer passt nicht zur ausgewählten Grafikkarte.'],
  [
    'resource_thread_controls_unavailable',
    'Die Runtime unterstützt die gewählte Threadsteuerung nicht. Threadfelder auf Automatik zurücksetzen.',
  ],
  ['runtime_not_configured', 'Die lokale Modellruntime ist noch nicht eingerichtet.'],
  ['model_directory_not_configured', 'Der lokale Modellordner ist noch nicht eingerichtet.'],
  ['runtime_unavailable', 'Die eingerichtete Modellruntime ist nicht verfügbar.'],
  ['model_files_unavailable', 'Die eingerichteten Modelldateien sind nicht verfügbar.'],
  ['local_paths_invalid', 'Die lokalen Modellpfade müssen überprüft werden.'],
  ['artifact_mismatch', 'Die lokalen Modelldateien passen nicht zum signierten Katalog.'],
  ['runtime_mismatch', 'Die lokale Runtime passt nicht zum signierten Katalog.'],
  [
    'accelerator_runtime_unavailable',
    'Die geprüfte Modellruntime kann keine GPU gemäß den Modellanforderungen nutzen.',
  ],
  ['benchmark_failed', 'Die lokale Bereitschaftsprüfung wurde nicht bestanden.'],
  ['runtime_startup_ram_pressure', 'Der Modellstart wurde zum Schutz des verfügbaren Arbeitsspeichers beendet.'],
  ['storage_unavailable', 'Der eingestellte Modellordner erfüllt die Speicheranforderungen nicht.'],
  ['readiness_mismatch', 'Die Bereitschaftsbestätigung muss erneuert werden.'],
  ['local_preparation_failed', 'Die lokale Modellvorbereitung ist fehlgeschlagen.'],
])

function blankStatus(nowMs: number): LocalModelStatusView {
  return {
    state: 'unavailable',
    label: 'Status nicht verfügbar',
    detail: 'Der lokale Modellstatus konnte nicht gelesen werden. Bitte erneut aktualisieren.',
    modelName: 'Lokales Modell',
    prepared: false,
    operational: false,
    checks: [],
    checkedAtMs: nowMs,
  }
}

function resourceChecks(native: NativeLocalModelStatus): StatusCheck[] {
  const checks: StatusCheck[] = []
  const plan = native.resourcePlan
  const gib = (bytes: number) => (bytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1 })
  if (plan) {
    const loadMode = plan.loadMode ?? (plan.mmap ? 'mmap' : 'runtime_default')
    const fileAccess =
      loadMode === 'buffered'
        ? plan.applied
          ? 'Gepuffertes Laden aktiv · keine vollständige Dateispeicherabbildung'
          : 'Gepuffertes Laden vorgesehen · noch nicht angewandt'
        : loadMode === 'mmap'
          ? plan.applied
            ? 'Speicherabbildung aktiv · Dateiseiten und RAM-Cache werden vom Betriebssystem verwaltet'
            : 'Speicherabbildung vorgesehen · noch nicht angewandt'
          : 'Die Runtime bestimmt den Dateizugriff'
    const profiles = { memory_saving: 'Speicherschonend', balanced: 'Ausgewogen', throughput: 'Hoher Durchsatz' }
    checks.push(
      {
        label: 'Automatische Abstimmung',
        value: `${profiles[plan.profile]} · ${plan.applied ? 'beim Modellstart angewandt' : 'Startprüfung läuft'}`,
        verified: plan.applied,
      },
      {
        label: 'CPU-Aufteilung',
        value: `${plan.threads} Antwortthreads · ${plan.threadsBatch} Kontextthreads`,
        verified: plan.applied,
      },
      {
        label: 'CPU-Spielraum',
        value: `${plan.availableLogicalCores} verfügbare logische Kerne · ${plan.reservedLogicalCores} nicht für das Modell verplant`,
        verified: plan.applied,
      },
      {
        label: 'RAM beim Modellstart',
        value: `${gib(plan.availableRamBytes)} / ${gib(plan.totalRamBytes)} GiB frei · ${gib(plan.ramHeadroomBytes)} GiB Pufferziel`,
        verified: plan.applied,
      },
      {
        label: 'Kontextverarbeitung',
        value: `${plan.batchSize} Tokens je Batch · ${plan.microBatchSize} je Rechenschritt · ${plan.contextTokens.toLocaleString('de-DE')} Kontexttokens`,
        verified: plan.applied,
      },
      {
        label: 'Dateizugriff',
        value: fileAccess,
        verified: plan.applied,
      }
    )
  }
  const storage = native.modelStorage
  if (storage) {
    const media = {
      nvme: 'NVMe-SSD',
      ssd: 'SSD',
      hdd: 'Festplatte',
      mixed: 'Gemischte Datenträger',
      unknown: 'Unbekannt',
    }
    const fixed = storage.busTypes.includes('usb')
      ? ' · USB'
      : storage.fixed === true
        ? ' · festes Laufwerk'
        : storage.fixed === false
          ? ' · wechselbar'
          : ''
    checks.push({
      label: 'Modellspeicher',
      value: `${media[storage.storageType]}${fixed}${storage.availableBytes === null ? '' : ` · ${gib(storage.availableBytes)} GiB frei beim Start`}`,
      verified: storage.storageType !== 'unknown' && storage.fixed !== null,
    })
  }
  return checks
}

function matchesResourceRevision(revision: unknown, appliedRevision: unknown): boolean {
  if (typeof appliedRevision !== 'number' || !Number.isSafeInteger(appliedRevision) || appliedRevision < 0) return false
  if (revision === undefined) return appliedRevision === 0
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision === appliedRevision
}

/** Read-only presentation: signed metadata alone never proves installed or running assets. */
export function presentLocalModelStatus(
  coordinator: CoordinatorStatus,
  native: NativeLocalModelStatus,
  nowMs: number,
  selectedModelId?: string | null
): LocalModelStatusView {
  const view = blankStatus(nowMs)
  if (native.resourceConfig) view.resourceConfig = structuredClone(native.resourceConfig)
  if (native.resourcePlan?.applied && native.resourcePlan.contextTokens > 0)
    view.contextTokens = native.resourcePlan.contextTokens
  const manifest = coordinator.manifest
  if (coordinator.mode !== 'active' || !manifest) {
    view.state = coordinator.mode === 'loading' ? 'loading' : 'blocked'
    view.label = coordinator.mode === 'loading' ? 'Modellrichtlinie wird geprüft' : 'Modellrichtlinie fehlt'
    view.detail = localPolicyDiagnostic(coordinator.mode, coordinator.reason).message
    return view
  }

  const eligibleId = [manifest.routing.defaultModelId, ...manifest.routing.fallbackModelIds].find(id =>
    coordinator.admissions.some(admission => admission.modelReleaseId === id && admission.admissible)
  )
  const model =
    manifest.models.find(item => item.id === coordinator.preparingModelId) ??
    manifest.models.find(item => item.id === native.activeModelId) ??
    manifest.models.find(item => item.id === (selectedModelId ?? eligibleId ?? manifest.routing.defaultModelId))
  view.modelName = model?.displayName ?? 'Lokales Modell'
  if (model) view.modelId = model.id
  const catalogValid =
    native.manifestAvailable &&
    native.catalogVersion === manifest.catalogVersion &&
    native.policyVersion === manifest.policyVersion &&
    Date.parse(manifest.expiresAt) > nowMs
  view.checks.push({
    label: 'Signierter Katalog',
    value: catalogValid ? `${manifest.catalogVersion} · Policy ${manifest.policyVersion}` : 'Erneute Prüfung nötig',
    verified: catalogValid,
  })
  if (!catalogValid) {
    view.state = 'blocked'
    view.label = 'Katalogabgleich erforderlich'
    view.detail =
      'Die aktuelle native Modellrichtlinie ist abgelaufen oder passt nicht zur App. Serververbindung erneut testen.'
    return view
  }

  if (coordinator.preparingModelId === model?.id && model) {
    view.state = 'loading'
    view.label =
      native.activeModelId && native.activeModelId !== model.id
        ? 'Lokales Modell wird gewechselt'
        : 'Lokales Modell lädt'
    view.detail = `${model.displayName}: Dateien werden geprüft und das Modell wird vorbereitet. Die Dauer hängt von Dateigröße und Gerät ab.`
    return view
  }

  const admission = coordinator.admissions.find(item => item.modelReleaseId === model?.id)
  const activeModel = native.activeModelId === model?.id
  const evidence = native.readiness.find(item => item.modelReleaseId === model?.id)
  const appliedRevision = native.resourceConfig === undefined ? 0 : native.resourceConfig.appliedRevision
  const resourcesCurrent =
    matchesResourceRevision(appliedRevision, appliedRevision) &&
    (!evidence || matchesResourceRevision(evidence.resourceRevision, appliedRevision)) &&
    (!activeModel ||
      !native.resourcePlan ||
      matchesResourceRevision(native.resourcePlan.resourceRevision, appliedRevision)) &&
    (!activeModel ||
      !native.acceleration ||
      matchesResourceRevision(native.acceleration.resourceRevision, appliedRevision))
  const showRuntimeMeasurements = activeModel && resourcesCurrent && admission?.ready !== false
  if (admission?.memory) {
    const memory = admission.memory
    const resident = memory.resident && resourcesCurrent && admission.ready
    const gib = (bytes: number) => (bytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1 })
    view.checks.push({
      label: 'Arbeitsspeicher',
      value: resident
        ? `${gib(memory.availableBytes)} GiB frei · Modell bereits geladen`
        : `${gib(memory.availableBytes)} GiB frei · ${gib(memory.requiredAvailableBytes)} GiB zum Laden benötigt`,
      verified: resident || memory.availableBytes >= memory.requiredAvailableBytes,
    })
  }
  if (showRuntimeMeasurements) view.checks.push(...resourceChecks(native))
  const acceleration = showRuntimeMeasurements ? native.acceleration : undefined
  if (acceleration) {
    const confirmed = acceleration.verified && acceleration.mode !== 'unknown'
    const mode = { gpu: 'GPU', hybrid: 'GPU + CPU', cpu: 'CPU', unknown: 'Noch nicht bestätigt' }[acceleration.mode]
    const backend = { cuda: 'CUDA', vulkan: 'Vulkan', metal: 'Metal', cpu: 'CPU', unknown: '' }[acceleration.backend]
    view.checks.push({
      label: 'Modellberechnung',
      value: confirmed
        ? `${mode}${backend && backend !== mode ? ` · ${backend}` : ''}`
        : 'GPU-Nutzung noch nicht bestätigt',
      verified: confirmed,
    })
    view.checks.push({
      label: 'Grafikkarte',
      value:
        confirmed && acceleration.mode === 'cpu'
          ? 'Keine GPU für die Modellberechnung'
          : acceleration.deviceNames.length
            ? acceleration.deviceNames.join(' · ')
            : 'Verwendete GPU noch nicht bestätigt',
      verified: confirmed && (acceleration.mode === 'cpu' || acceleration.deviceNames.length > 0),
    })
    if (confirmed && acceleration.offloadedLayers !== null)
      view.checks.push({
        label: 'Modellschichten auf GPU',
        value: `${acceleration.offloadedLayers}${acceleration.totalLayers !== null ? ` / ${acceleration.totalLayers}` : ''}`,
        verified: true,
      })
    if (confirmed && acceleration.gpuMemoryBytes !== null)
      view.checks.push({
        label: 'GPU-Modellpuffer',
        value: `${(acceleration.gpuMemoryBytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GiB`,
        verified: true,
      })
    const gpuMessage =
      gpuMessages.get(acceleration.fallbackReasonCode ?? '') ?? gpuMessages.get(acceleration.reasonCode ?? '')
    if (gpuMessage)
      view.checks.push({
        label: 'GPU-Hinweis',
        value: gpuMessage,
        verified: false,
      })
  } else {
    view.checks.push({ label: 'Modellberechnung', value: 'GPU-/CPU-Nutzung noch nicht bestätigt', verified: false })
    view.checks.push({ label: 'Grafikkarte', value: 'Verwendete GPU noch nicht bestätigt', verified: false })
  }
  const verified =
    resourcesCurrent &&
    admission?.ready === true &&
    hasVerifiedLocalReadiness(model, evidence, manifest.payloadSha256, nowMs)
  view.prepared = !!(model?.enabled && admission?.executable && verified)
  view.checks.push(
    {
      label: 'Modelldatei',
      value: verified ? 'Lokal verifiziert' : model?.artifact ? 'Im Katalog · lokal ungeprüft' : 'Nicht hinterlegt',
      verified,
    },
    {
      label: 'Runtime',
      value: model?.runtime
        ? `${model.runtime.id} ${model.runtime.version} · ${verified ? 'verifiziert' : 'lokal ungeprüft'}`
        : 'Nicht hinterlegt',
      verified,
    }
  )
  if (verified && evidence) {
    view.checks.push({
      label: 'Bereitschaft geprüft',
      value: new Date(evidence.verifiedAtMs).toLocaleTimeString('de-DE'),
      verified: true,
    })
  }
  if (!model?.enabled || !admission?.executable) {
    view.state = 'unprepared'
    view.label = 'Noch nicht vorbereitet'
    view.detail = !model?.enabled
      ? 'Der signierte Katalog hat das lokale Modell noch nicht aktiviert.'
      : 'Im Katalog fehlen ausführbare Modell- oder Runtime-Angaben.'
    return view
  }
  if (native.state === 'error' || native.reasonCode || admission.health === 'error') {
    view.state = 'error'
    view.label = 'Lokaler Modellfehler'
    view.detail =
      preparationMessages.get(native.reasonCode ?? '') ??
      'Die lokale Runtime meldet einen Fehler. Die vorhandene Einrichtung und den nächsten Chatversuch prüfen.'
    return view
  }
  if (native.state === 'cooldown' || admission.health === 'cooldown') {
    view.state = 'blocked'
    view.label = 'Wartezeit nach Modellfehler'
    view.detail = 'Das lokale Modell wartet nach einem Fehler vor dem nächsten Versuch.'
    return view
  }
  if (admission.capacity !== 'eligible') {
    view.state = 'blocked'
    view.label = 'Systemressourcen nicht bestätigt'
    view.detail = admission.reasons.includes('total_ram_below_minimum')
      ? `Der gesamte nutzbare Arbeitsspeicher liegt unter der signierten Mindestgrenze von ${((model.capacityPolicy.minTotalRamBytes ?? 0) / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GiB. Die Anzeige des freien RAM ist eine getrennte Startprüfung.`
      : 'Arbeitsspeicher, GPU oder Speicherplatz erfüllen die aktuelle Modellfreigabe nicht vollständig.'
    return view
  }
  if (native.state === 'starting' || (native.state === 'busy' && !activeModel)) {
    view.state = 'loading'
    view.label = 'Lokales Modell lädt'
    view.detail = 'Der lokale Modellstart läuft. Besonders der erste Start kann länger dauern.'
    return view
  }
  if (!verified) {
    view.state = 'unprepared'
    view.label = activeModel ? 'Bereitschaft muss erneuert werden' : 'Lokale Prüfung ausstehend'
    view.detail = !resourcesCurrent
      ? 'Die Ressourcenverteilung wurde geändert. Bereitschaft und Messwerte müssen für die angewandte Einstellung erneut bestätigt werden.'
      : (admission.reasons.map(reason => preparationMessages.get(reason)).find(Boolean) ??
        (activeModel
          ? 'Die Runtime ist geladen. Die gültige Datei- und Bereitschaftsprüfung wird beim nächsten Chat erneuert.'
          : 'Das Modell ist im Katalog vorbereitet. Lokale Dateien und Bereitschaft werden beim nächsten Chat geprüft.'))
    return view
  }
  if (activeModel && (native.state === 'ready' || native.state === 'busy')) {
    view.state = native.state
    view.operational = true
    view.label = native.state === 'busy' ? 'Einsatzbereit · arbeitet' : 'Einsatzbereit'
    view.detail =
      native.state === 'busy'
        ? 'Das verifizierte lokale Modell bearbeitet gerade einen Auftrag.'
        : 'Modelldatei und Runtime sind verifiziert; die native Runtime meldet das Modell als geladen.'
    return view
  }
  view.state = 'cold'
  view.label = 'Vorbereitet · noch nicht geladen'
  view.detail =
    'Die lokalen Dateien sind verifiziert. Die Runtime startet beim nächsten Chat; ein Kaltstart kann länger dauern.'
  return view
}

type StatusDependencies = {
  coordinator: () => CoordinatorStatus
  native: () => Promise<NativeLocalModelStatus>
  now: () => number
}

/** No network request, preparation, download, or model start is triggered by a status read. */
export async function readLocalModelStatus(
  dependencies: StatusDependencies = {
    coordinator: () => localInferenceCoordinator.status(),
    native: async () => {
      const status = await getNativeLocalModelStatus()
      localInferenceCoordinator.reconcileNativeStatus(status)
      return status
    },
    now: Date.now,
  }
): Promise<LocalModelStatusView> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const before = dependencies.coordinator()
    const native = await Promise.race([
      dependencies.native(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Status timeout')), 5_000)
      }),
    ])
    const after = dependencies.coordinator()
    if (before.manifest !== after.manifest || before.mode !== after.mode || before.reason !== after.reason) {
      return {
        ...blankStatus(dependencies.now()),
        label: 'Modellstatus wird erneuert',
        detail: 'Die Modellrichtlinie hat sich während der Abfrage geändert. Der Status wird erneut abgeglichen.',
      }
    }
    return presentLocalModelStatus(after, native, dependencies.now(), modelUsageSettings.value.localModelId)
  } catch {
    // Native exceptions may contain private file paths or runtime credentials.
    return blankStatus(dependencies.now())
  } finally {
    if (deadline) clearTimeout(deadline)
  }
}
