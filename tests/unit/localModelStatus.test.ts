import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { presentLocalModelStatus, readLocalModelStatus } from '@/services/localModelStatus'
import { verifyLocalModelManifest, type VerifiedLocalModelManifest } from '@/services/inference/modelManifest'
import type { localInferenceCoordinator } from '@/services/inference/coordinator'
import type { NativeLocalModelStatus } from '@/services/inference/tauriLocalRuntime'
import { DEFAULT_LOCAL_RESOURCE_CONFIG } from '@/services/inference/resources'

const now = Date.parse('2026-08-30T12:30:00Z')
let manifest: VerifiedLocalModelManifest
type CoordinatorStatus = ReturnType<typeof localInferenceCoordinator.status>

beforeAll(async () => {
  const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/local-model-manifest-v1.json'), 'utf8'))
  manifest = await verifyLocalModelManifest(
    {
      key_id: 'test-key',
      algorithm: 'RSA-SHA256',
      payload_sha256: 'a'.repeat(64),
      payload: fixture.cases.explicit_experiment,
      signature: 'test',
    },
    { verify: async () => ({ valid: true, canonicalPayloadSha256: 'a'.repeat(64) }) },
    {
      trustDomain: `server:v1:${'b'.repeat(64)}`,
      acceptanceSessionId: '00000000-0000-4000-8000-000000000001',
      acceptanceGeneration: 1,
      expectedKeyId: 'test-key',
      minimumCatalogVersion: 2026083001,
      minimumPolicyVersion: 2026083001,
      now: new Date(now),
    }
  )
})

afterEach(() => vi.useRealTimers())

it('shows the selected model before preparation instead of the server default', () => {
  const { coordinator, native } = snapshots()
  native.activeModelId = undefined
  const selected = manifest.models.find(item => item.id !== manifest.routing.defaultModelId)!
  const view = presentLocalModelStatus(coordinator, native, now, selected.id)
  expect(view.modelId).toBe(selected.id)
  expect(view.modelName).toBe(selected.displayName)
})

it('shows the admissible automatic fallback when the default cannot run', () => {
  const { coordinator, native } = snapshots()
  native.activeModelId = undefined
  const fallback = manifest.routing.fallbackModelIds[0]!
  coordinator.admissions = [{ ...coordinator.admissions[0]!, modelReleaseId: fallback, admissible: true }]
  expect(presentLocalModelStatus(coordinator, native, now).modelId).toBe(fallback)
})

function snapshots() {
  const model = manifest.models.find(item => item.id === manifest.routing.defaultModelId)!
  const coordinator: CoordinatorStatus = {
    mode: 'active',
    reason: 'signed_policy_active',
    manifest,
    admissions: [
      {
        modelReleaseId: model.id,
        enabled: true,
        executable: true,
        capacity: 'eligible',
        ready: true,
        health: 'ready',
        admissible: true,
        reasons: [],
      },
    ],
  }
  const native: NativeLocalModelStatus = {
    manifestAvailable: true,
    catalogVersion: manifest.catalogVersion,
    policyVersion: manifest.policyVersion,
    activeModelId: model.id,
    state: 'ready',
    readiness: [
      {
        modelReleaseId: model.id,
        manifestPayloadSha256: manifest.payloadSha256,
        artifactSha256: model.artifact!.sha256,
        runtimeSha256: model.runtime!.sha256,
        ready: true,
        verifiedAtMs: now - 1000,
        validUntilMs: now + 60_000,
      },
    ],
  }
  return { coordinator, native }
}

function revisionSnapshots(revision = 2) {
  const result = snapshots()
  const { native } = result
  native.resourceConfig = {
    requested: { ...DEFAULT_LOCAL_RESOURCE_CONFIG },
    applied: { ...DEFAULT_LOCAL_RESOURCE_CONFIG },
    revision,
    appliedRevision: revision,
    pending: false,
    reasonCode: null,
  }
  native.readiness[0]!.resourceRevision = revision
  native.resourcePlan = {
    resourceRevision: revision,
    schemaVersion: 1,
    profile: 'balanced',
    logicalCores: 20,
    physicalCores: 10,
    availableLogicalCores: 20,
    threads: 8,
    threadsBatch: 16,
    reservedLogicalCores: 4,
    totalRamBytes: 32 * 1024 ** 3,
    availableRamBytes: 12 * 1024 ** 3,
    ramHeadroomBytes: 2 * 1024 ** 3,
    batchSize: 512,
    microBatchSize: 128,
    contextTokens: 32768,
    mmap: false,
    loadMode: 'buffered',
    parallelSlots: 1,
    applied: true,
    reasonCodes: [],
  }
  native.acceleration = {
    resourceRevision: revision,
    backend: 'cuda',
    deviceNames: ['Measured test GPU'],
    offloadedLayers: 66,
    totalLayers: 66,
    gpuMemoryBytes: 18 * 1024 ** 3,
    mode: 'gpu',
    verified: true,
    reasonCode: null,
  }
  return result
}

describe('local model readiness presentation', () => {
  it.each(['readiness', 'resourcePlan', 'acceleration'] as const)(
    'rejects stale, absent and invalid resource revisions in %s without reusing start/GPU measurements',
    target => {
      for (const revision of [1, 3, undefined, null, '2', 2.5]) {
        const { coordinator, native } = revisionSnapshots()
        const evidence =
          target === 'readiness'
            ? native.readiness[0]!
            : target === 'resourcePlan'
              ? native.resourcePlan!
              : native.acceleration!
        Object.assign(evidence, { resourceRevision: revision })
        const view = presentLocalModelStatus(coordinator, native, now)
        expect(view).toMatchObject({ state: 'unprepared', operational: false, prepared: false })
        expect(view.detail).toContain('angewandte Einstellung')
        expect(
          view.checks.some(check =>
            ['CPU-Aufteilung', 'GPU-Modellpuffer', 'Modellschichten auf GPU'].includes(check.label)
          )
        ).toBe(false)
        expect(view.checks).toContainEqual({
          label: 'Grafikkarte',
          value: 'Verwendete GPU noch nicht bestätigt',
          verified: false,
        })
        expect(JSON.stringify(view)).not.toContain('Measured test GPU')
      }
    }
  )

  it('accepts omitted evidence revisions only for legacy applied revision zero', () => {
    const { coordinator, native } = revisionSnapshots(0)
    delete native.readiness[0]!.resourceRevision
    delete native.resourcePlan!.resourceRevision
    delete native.acceleration!.resourceRevision
    expect(presentLocalModelStatus(coordinator, native, now)).toMatchObject({ prepared: true, operational: true })
    delete native.resourceConfig
    expect(presentLocalModelStatus(coordinator, native, now)).toMatchObject({ prepared: true, operational: true })
    native.acceleration!.resourceRevision = 1
    expect(presentLocalModelStatus(coordinator, native, now)).toMatchObject({ prepared: false, operational: false })
  })

  it('continues to display current work while a different requested revision is still pending', () => {
    const { coordinator, native } = revisionSnapshots(1)
    native.state = 'busy'
    native.resourceConfig!.revision = 2
    native.resourceConfig!.requested.mode = 'cpu'
    native.resourceConfig!.pending = true
    const view = presentLocalModelStatus(coordinator, native, now)
    expect(view).toMatchObject({ state: 'busy', operational: true, prepared: true, label: 'Einsatzbereit · arbeitet' })
    expect(view.resourceConfig).toMatchObject({ revision: 2, appliedRevision: 1, pending: true })
    expect(view.checks).toContainEqual({ label: 'Modellschichten auf GPU', value: '66 / 66', verified: true })
    expect(view.checks).toContainEqual({
      label: 'CPU-Aufteilung',
      value: '8 Antwortthreads · 16 Kontextthreads',
      verified: true,
    })
  })

  it.each(['gpu', 'hybrid', 'cpu', 'unknown'] as const)('keeps a GPU card visible for current %s evidence', mode => {
    const { coordinator, native } = revisionSnapshots()
    native.acceleration!.mode = mode
    if (mode === 'hybrid') native.acceleration!.offloadedLayers = 33
    if (mode === 'cpu' || mode === 'unknown') native.acceleration!.deviceNames = []
    if (mode === 'cpu') {
      native.acceleration!.backend = 'cpu'
      native.acceleration!.offloadedLayers = 0
      native.acceleration!.gpuMemoryBytes = null
    }
    const view = presentLocalModelStatus(coordinator, native, now)
    const card = view.checks.find(check => check.label === 'Grafikkarte')
    expect(card).toEqual({
      label: 'Grafikkarte',
      value:
        mode === 'cpu'
          ? 'Keine GPU für die Modellberechnung'
          : mode === 'unknown'
            ? 'Verwendete GPU noch nicht bestätigt'
            : 'Measured test GPU',
      verified: mode !== 'unknown',
    })
    expect(view.checks.find(check => check.label === 'Modellschichten auf GPU')?.value).toBe(
      mode === 'unknown' ? undefined : `${mode === 'gpu' ? 66 : mode === 'hybrid' ? 33 : 0} / 66`
    )
    expect(view.checks.some(check => check.label === 'GPU-Modellpuffer')).toBe(mode === 'gpu' || mode === 'hybrid')
  })

  it('retains the GPU placeholder when no acceleration evidence has arrived', () => {
    const { coordinator, native } = snapshots()
    expect(presentLocalModelStatus(coordinator, native, now).checks).toContainEqual({
      label: 'Grafikkarte',
      value: 'Verwendete GPU noch nicht bestätigt',
      verified: false,
    })
  })

  it.each(['cpu_mode_disallowed_by_manifest', 'runtime_gpu_required_no_offload'] as const)(
    'explains a signed GPU requirement: %s',
    reasonCode => {
      const { coordinator, native } = snapshots()
      native.reasonCode = reasonCode
      const view = presentLocalModelStatus(coordinator, native, now)
      expect(view).toMatchObject({ state: 'error', operational: false })
      expect(view.detail).toContain('GPU')
      expect(view.detail).toContain(
        reasonCode === 'cpu_mode_disallowed_by_manifest'
          ? 'Bitte Automatik oder GPU-Modus wählen.'
          : 'keine Modellschichten ausgelagert'
      )
    }
  )

  it('retains requested and applied device settings separately without granting readiness', () => {
    const { coordinator, native } = snapshots()
    const automatic = {
      mode: 'auto' as const,
      gpuDeviceIds: null,
      threads: null,
      threadsBatch: null,
      ramReserveBytes: null,
      vramReserveBytes: null,
    }
    native.resourceConfig = {
      requested: { ...automatic, mode: 'gpu' },
      applied: automatic,
      revision: 2,
      appliedRevision: 1,
      pending: true,
      reasonCode: 'resource_config_pending',
    }
    native.readiness = []
    const view = presentLocalModelStatus(coordinator, native, now)
    expect(view.resourceConfig).toEqual(native.resourceConfig)
    expect(view.resourceConfig).not.toBe(native.resourceConfig)
    expect(view.operational).toBe(false)
    const blocked = presentLocalModelStatus({ ...coordinator, mode: 'blocked' }, native, now)
    expect(blocked.resourceConfig?.pending).toBe(true)
    expect(blocked.operational).toBe(false)
  })

  it('uses fixed diagnostic text for GPU fallback reasons and omits unknown raw details', () => {
    const { coordinator, native } = snapshots()
    native.acceleration = {
      backend: 'cpu',
      mode: 'cpu',
      verified: true,
      deviceNames: [],
      offloadedLayers: 0,
      totalLayers: null,
      gpuMemoryBytes: null,
      reasonCode: 'runtime_gpu_memory_unavailable',
    }
    expect(presentLocalModelStatus(coordinator, native, now).checks).toContainEqual({
      label: 'GPU-Hinweis',
      value: 'Für die GPU ist kein ausreichender freier Grafikspeicher bestätigt.',
      verified: false,
    })
    native.acceleration.reasonCode = 'unknown-secret-path'
    expect(JSON.stringify(presentLocalModelStatus(coordinator, native, now))).not.toContain('unknown-secret-path')
    native.acceleration.fallbackReasonCode = 'gpu_mode_auto_fallback_capacity'
    expect(presentLocalModelStatus(coordinator, native, now).checks).toContainEqual({
      label: 'GPU-Hinweis',
      value: 'Das Modell passt nicht vollständig in den verfügbaren Grafikspeicher. Automatik verteilt die Arbeit.',
      verified: false,
    })
    native.acceleration.fallbackReasonCode = 'gpu_mode_auto_fallback_unconfirmed'
    expect(presentLocalModelStatus(coordinator, native, now).checks).toContainEqual({
      label: 'GPU-Hinweis',
      value: 'Vollständige GPU-Auslagerung wurde nicht bestätigt. Automatik übernimmt.',
      verified: false,
    })
  })

  it('shows applied resource parameters without treating them as a performance benchmark', () => {
    const { coordinator, native } = snapshots()
    native.resourcePlan = {
      schemaVersion: 1,
      profile: 'balanced',
      logicalCores: 20,
      physicalCores: 10,
      availableLogicalCores: 20,
      threads: 10,
      threadsBatch: 18,
      reservedLogicalCores: 2,
      totalRamBytes: 32 * 1024 ** 3,
      availableRamBytes: 14 * 1024 ** 3,
      ramHeadroomBytes: 2 * 1024 ** 3,
      batchSize: 512,
      microBatchSize: 128,
      contextTokens: 32768,
      mmap: true,
      parallelSlots: 1,
      applied: true,
      reasonCodes: [],
    }
    native.modelStorage = {
      storageType: 'nvme',
      busTypes: ['nvme'],
      fixed: true,
      availableBytes: 716 * 1024 ** 3,
      totalBytes: 931 * 1024 ** 3,
      reasonCode: null,
    }
    const checks = presentLocalModelStatus(coordinator, native, now).checks
    expect(checks).toContainEqual({
      label: 'Automatische Abstimmung',
      value: 'Ausgewogen · beim Modellstart angewandt',
      verified: true,
    })
    expect(checks).toContainEqual({
      label: 'CPU-Aufteilung',
      value: '10 Antwortthreads · 18 Kontextthreads',
      verified: true,
    })
    expect(checks).toContainEqual({
      label: 'RAM beim Modellstart',
      value: '14 / 32 GiB frei · 2 GiB Pufferziel',
      verified: true,
    })
    expect(checks).toContainEqual({
      label: 'Modellspeicher',
      value: 'NVMe-SSD · festes Laufwerk · 716 GiB frei beim Start',
      verified: true,
    })
    native.resourcePlan.mmap = false
    native.resourcePlan.loadMode = 'buffered'
    expect(presentLocalModelStatus(coordinator, native, now).checks).toContainEqual({
      label: 'Dateizugriff',
      value: 'Gepuffertes Laden aktiv · keine vollständige Dateispeicherabbildung',
      verified: true,
    })
    native.resourcePlan.applied = false
    expect(presentLocalModelStatus(coordinator, native, now).checks).toContainEqual({
      label: 'Dateizugriff',
      value: 'Gepuffertes Laden vorgesehen · noch nicht angewandt',
      verified: false,
    })
    expect(presentLocalModelStatus(coordinator, native, now).checks).toContainEqual({
      label: 'Automatische Abstimmung',
      value: 'Ausgewogen · Startprüfung läuft',
      verified: false,
    })
    native.activeModelId = 'another-model'
    expect(
      presentLocalModelStatus(coordinator, native, now).checks.some(check => check.label === 'CPU-Aufteilung')
    ).toBe(false)
  })

  it('does not label unclassified storage as an internal SSD', () => {
    const { coordinator, native } = snapshots()
    native.modelStorage = {
      storageType: 'unknown',
      busTypes: [],
      fixed: null,
      availableBytes: null,
      totalBytes: null,
      reasonCode: 'unavailable',
    }
    expect(presentLocalModelStatus(coordinator, native, now).checks).toContainEqual({
      label: 'Modellspeicher',
      value: 'Unbekannt',
      verified: false,
    })
    native.modelStorage = { ...native.modelStorage, storageType: 'ssd', busTypes: ['usb'], fixed: true }
    expect(presentLocalModelStatus(coordinator, native, now).checks).toContainEqual({
      label: 'Modellspeicher',
      value: 'SSD · USB',
      verified: true,
    })
  })

  it('reports measured CUDA layer offload instead of inferring it from GPU presence', () => {
    const { coordinator, native } = snapshots()
    native.acceleration = {
      backend: 'cuda',
      deviceNames: ['NVIDIA GeForce RTX 3090'],
      offloadedLayers: 49,
      totalLayers: 65,
      gpuMemoryBytes: 20 * 1024 ** 3,
      mode: 'hybrid',
      verified: true,
      reasonCode: null,
    }
    const checks = presentLocalModelStatus(coordinator, native, now).checks
    expect(checks).toContainEqual({ label: 'Modellberechnung', value: 'GPU + CPU · CUDA', verified: true })
    expect(checks).toContainEqual({ label: 'Modellschichten auf GPU', value: '49 / 65', verified: true })
    native.acceleration.verified = false
    const unconfirmed = presentLocalModelStatus(coordinator, native, now).checks
    expect(unconfirmed).toContainEqual({
      label: 'Modellberechnung',
      value: 'GPU-Nutzung noch nicht bestätigt',
      verified: false,
    })
    expect(unconfirmed.some(check => check.label === 'GPU-Modellpuffer')).toBe(false)
  })

  it('reports an explicit CPU recovery without treating it as a runtime failure', () => {
    const { coordinator, native } = snapshots()
    native.acceleration = {
      backend: 'cpu',
      deviceNames: [],
      offloadedLayers: 0,
      totalLayers: 65,
      gpuMemoryBytes: null,
      mode: 'cpu',
      verified: true,
      reasonCode: 'runtime_gpu_start_failed',
    }
    const view = presentLocalModelStatus(coordinator, native, now)
    expect(view.operational).toBe(true)
    expect(view.checks).toContainEqual({
      label: 'GPU-Hinweis',
      value: 'GPU-Start fehlgeschlagen; CPU als Ersatz aktiv.',
      verified: false,
    })
  })

  it('requires native matching evidence and a loaded runtime for operational readiness', () => {
    const { coordinator, native } = snapshots()
    const view = presentLocalModelStatus(coordinator, native, now)
    expect(view).toMatchObject({ prepared: true, operational: true, state: 'ready', label: 'Einsatzbereit' })
    expect(view.checks.find(item => item.label === 'Modelldatei')?.value).toBe('Lokal verifiziert')
    expect(view.modelName).toBe(manifest.models.find(item => item.id === manifest.routing.defaultModelId)!.displayName)
  })

  it('distinguishes verified files from a warm model', () => {
    const { coordinator, native } = snapshots()
    native.state = 'stopped'
    native.activeModelId = undefined
    expect(presentLocalModelStatus(coordinator, native, now)).toMatchObject({
      prepared: true,
      operational: false,
      state: 'cold',
    })
  })

  it('never treats catalog metadata or manager health as verified local files', () => {
    const { coordinator, native } = snapshots()
    native.readiness = []
    native.state = 'stopped'
    native.activeModelId = undefined
    const view = presentLocalModelStatus(coordinator, native, now)
    expect(view).toMatchObject({ prepared: false, operational: false, state: 'unprepared' })
    expect(view.checks.find(item => item.label === 'Modelldatei')?.value).toContain('lokal ungeprüft')
  })

  it.each(['expired', 'manifest', 'artifact', 'runtime'] as const)('rejects %s readiness evidence', mismatch => {
    const { coordinator, native } = snapshots()
    const evidence = native.readiness[0]!
    if (mismatch === 'expired') evidence.validUntilMs = now
    if (mismatch === 'manifest') evidence.manifestPayloadSha256 = 'c'.repeat(64)
    if (mismatch === 'artifact') evidence.artifactSha256 = 'c'.repeat(64)
    if (mismatch === 'runtime') evidence.runtimeSha256 = 'c'.repeat(64)
    expect(presentLocalModelStatus(coordinator, native, now)).toMatchObject({
      prepared: false,
      operational: false,
      state: 'unprepared',
    })
  })

  it('shows loading before a runtime exists, then active inference', () => {
    const { coordinator, native } = snapshots()
    native.state = 'busy'
    expect(presentLocalModelStatus(coordinator, native, now)).toMatchObject({ state: 'busy', operational: true })
    native.activeModelId = undefined
    expect(presentLocalModelStatus(coordinator, native, now)).toMatchObject({ state: 'loading', operational: false })
  })

  it('does not present an old native catalog or an expired signed policy as usable', () => {
    const { coordinator, native } = snapshots()
    expect(presentLocalModelStatus(coordinator, native, Date.parse(manifest.expiresAt))).toMatchObject({
      state: 'blocked',
      operational: false,
    })
    native.catalogVersion = 1
    expect(presentLocalModelStatus(coordinator, native, now)).toMatchObject({ state: 'blocked', operational: false })
  })

  it('blocks readiness when capacity or runtime health is not eligible', () => {
    const { coordinator, native } = snapshots()
    coordinator.admissions = [{ ...coordinator.admissions[0]!, capacity: 'degraded' }]
    expect(presentLocalModelStatus(coordinator, native, now)).toMatchObject({ state: 'blocked', operational: false })
    coordinator.admissions = [{ ...coordinator.admissions[0]!, capacity: 'eligible', health: 'cooldown' }]
    expect(presentLocalModelStatus(coordinator, native, now).label).toBe('Wartezeit nach Modellfehler')
  })

  it('maps setup failures without exposing unexpected native information', () => {
    const { coordinator, native } = snapshots()
    native.readiness = []
    native.activeModelId = undefined
    native.state = 'stopped'
    coordinator.admissions = [{ ...coordinator.admissions[0]!, reasons: ['runtime_not_configured'] }]
    expect(presentLocalModelStatus(coordinator, native, now).detail).toContain('noch nicht eingerichtet')
    native.reasonCode = 'PRIVATE_PATH_AND_KEY'
    const view = presentLocalModelStatus(coordinator, native, now)
    expect(view.state).toBe('error')
    expect(JSON.stringify(view)).not.toContain('PRIVATE_PATH_AND_KEY')
  })
})

describe('read-only native status refresh', () => {
  it('does not revive a late ready reply after the coordinator has invalidated its resource evidence', async () => {
    const { coordinator, native } = revisionSnapshots(1)
    const after = {
      ...coordinator,
      admissions: coordinator.admissions.map(admission => ({ ...admission, ready: false, admissible: false })),
    }
    const view = await readLocalModelStatus({
      coordinator: vi.fn().mockReturnValueOnce(coordinator).mockReturnValueOnce(after),
      native: async () => native,
      now: () => now,
    })
    expect(view).toMatchObject({ prepared: false, operational: false, state: 'unprepared' })
    expect(JSON.stringify(view)).not.toContain('Measured test GPU')
    expect(view.checks.some(check => check.label === 'GPU-Modellpuffer')).toBe(false)
  })

  it('drops a reply if the account or policy changes while native status is being read', async () => {
    const { coordinator, native } = snapshots()
    const readCoordinator = vi
      .fn()
      .mockReturnValueOnce(coordinator)
      .mockReturnValueOnce({ ...coordinator, manifest: undefined, mode: 'blocked' })
    const view = await readLocalModelStatus({
      coordinator: readCoordinator,
      native: async () => native,
      now: () => now,
    })
    expect(view).toMatchObject({ operational: false, prepared: false, label: 'Modellstatus wird erneuert' })
  })

  it('returns a bounded, safe failure for unavailable native IPC', async () => {
    const { coordinator } = snapshots()
    const view = await readLocalModelStatus({
      coordinator: () => coordinator,
      native: async () => {
        throw new Error('PRIVATE_NATIVE_DATA')
      },
      now: () => now,
    })
    expect(view.state).toBe('unavailable')
    expect(JSON.stringify(view)).not.toContain('PRIVATE_NATIVE_DATA')
  })

  it('ends a hung native status read after five seconds', async () => {
    vi.useFakeTimers()
    const { coordinator } = snapshots()
    const pending = readLocalModelStatus({
      coordinator: () => coordinator,
      native: () => new Promise(() => {}),
      now: () => now,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await pending).state).toBe('unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })
})
