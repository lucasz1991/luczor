import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { presentLocalModelStatus, readLocalModelStatus } from '@/services/localModelStatus'
import { verifyLocalModelManifest, type VerifiedLocalModelManifest } from '@/services/inference/modelManifest'
import type { localInferenceCoordinator } from '@/services/inference/coordinator'
import type { NativeLocalModelStatus } from '@/services/inference/tauriLocalRuntime'

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

describe('local model readiness presentation', () => {
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
