import { localInferenceCoordinator, localPolicyDiagnostic } from '@/services/inference/coordinator'
import { hasVerifiedLocalReadiness } from '@/services/inference/hybridRouter'
import { getNativeLocalModelStatus, type NativeLocalModelStatus } from '@/services/inference/tauriLocalRuntime'

type CoordinatorStatus = ReturnType<typeof localInferenceCoordinator.status>
type StatusState = 'unavailable' | 'loading' | 'unprepared' | 'cold' | 'ready' | 'busy' | 'blocked' | 'error'
type StatusCheck = { label: string; value: string; verified: boolean }

export type LocalModelStatusView = {
  state: StatusState
  label: string
  detail: string
  modelName: string
  prepared: boolean
  operational: boolean
  checks: StatusCheck[]
  checkedAtMs: number
}

const preparationMessages = new Map<string, string>([
  ['runtime_not_configured', 'Die lokale Modellruntime ist noch nicht eingerichtet.'],
  ['model_directory_not_configured', 'Der lokale Modellordner ist noch nicht eingerichtet.'],
  ['runtime_unavailable', 'Die eingerichtete Modellruntime ist nicht verfügbar.'],
  ['model_files_unavailable', 'Die eingerichteten Modelldateien sind nicht verfügbar.'],
  ['local_paths_invalid', 'Die lokalen Modellpfade müssen überprüft werden.'],
  ['artifact_mismatch', 'Die lokalen Modelldateien passen nicht zum signierten Katalog.'],
  ['runtime_mismatch', 'Die lokale Runtime passt nicht zum signierten Katalog.'],
  ['benchmark_failed', 'Die lokale Bereitschaftsprüfung wurde nicht bestanden.'],
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

/** Read-only presentation: signed metadata alone never proves installed or running assets. */
export function presentLocalModelStatus(
  coordinator: CoordinatorStatus,
  native: NativeLocalModelStatus,
  nowMs: number
): LocalModelStatusView {
  const view = blankStatus(nowMs)
  const manifest = coordinator.manifest
  if (coordinator.mode !== 'active' || !manifest) {
    view.state = coordinator.mode === 'loading' ? 'loading' : 'blocked'
    view.label = coordinator.mode === 'loading' ? 'Modellrichtlinie wird geprüft' : 'Modellrichtlinie fehlt'
    view.detail = localPolicyDiagnostic(coordinator.mode, coordinator.reason).message
    return view
  }

  const model =
    manifest.models.find(item => item.id === native.activeModelId) ??
    manifest.models.find(item => item.id === manifest.routing.defaultModelId)
  view.modelName = model?.displayName ?? 'Lokales Modell'
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

  const admission = coordinator.admissions.find(item => item.modelReleaseId === model?.id)
  if (admission?.memory) {
    const memory = admission.memory
    const gib = (bytes: number) => (bytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1 })
    view.checks.push({
      label: 'Arbeitsspeicher',
      value: memory.resident
        ? `${gib(memory.availableBytes)} GiB frei · Modell bereits geladen`
        : `${gib(memory.availableBytes)} GiB frei · ${gib(memory.requiredAvailableBytes)} GiB zum Laden benötigt`,
      verified: memory.resident || memory.availableBytes >= memory.requiredAvailableBytes,
    })
  }
  const evidence = native.readiness.find(item => item.modelReleaseId === model?.id)
  const verified = hasVerifiedLocalReadiness(model, evidence, manifest.payloadSha256, nowMs)
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
    view.detail = 'Arbeitsspeicher, GPU oder Speicherplatz erfüllen die aktuelle Modellfreigabe nicht vollständig.'
    return view
  }
  const activeModel = native.activeModelId === model.id
  if (native.state === 'starting' || (native.state === 'busy' && !activeModel)) {
    view.state = 'loading'
    view.label = 'Lokales Modell lädt'
    view.detail = 'Der lokale Modellstart läuft. Besonders der erste Start kann länger dauern.'
    return view
  }
  if (!verified) {
    view.state = 'unprepared'
    view.label = activeModel ? 'Bereitschaft muss erneuert werden' : 'Lokale Prüfung ausstehend'
    view.detail =
      admission.reasons.map(reason => preparationMessages.get(reason)).find(Boolean) ??
      (activeModel
        ? 'Die Runtime ist geladen. Die gültige Datei- und Bereitschaftsprüfung wird beim nächsten Chat erneuert.'
        : 'Das Modell ist im Katalog vorbereitet. Lokale Dateien und Bereitschaft werden beim nächsten Chat geprüft.')
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
    return presentLocalModelStatus(after, native, dependencies.now())
  } catch {
    // Native exceptions may contain private file paths or runtime credentials.
    return blankStatus(dependencies.now())
  } finally {
    if (deadline) clearTimeout(deadline)
  }
}
