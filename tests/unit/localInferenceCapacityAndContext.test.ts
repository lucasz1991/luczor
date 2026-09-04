import { describe, expect, it } from 'vitest'
import { assessModelCapacity, selectModelStorage, type HardwareSnapshot } from '@/services/inference/capacity'
import { buildScopedContextPackage, type ScopedContextFragment } from '@/services/inference/contextBroker'

const GIB = 1024 ** 3

function hardware(storage: HardwareSnapshot['storage']): HardwareSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: 'snapshot-1',
    capturedAtMs: Date.parse('2026-08-30T12:00:00Z'),
    platform: 'windows',
    arch: 'x86_64',
    cpu: { logicalCores: 20, physicalCores: 10, features: [], loadPercent: 5 },
    memory: { totalBytes: 32 * GIB, availableBytes: 24 * GIB },
    accelerators: [{ id: 'cuda-0', backend: 'cuda', name: 'GPU', totalBytes: 24 * GIB, availableBytes: 22 * GIB }],
    storage,
  }
}

describe('local inference capacity and scoped context', () => {
  it('selects generic fixed NVMe and rejects USB without drive-letter rules', () => {
    const storage: HardwareSnapshot['storage'] = [
      {
        id: 'external-fast',
        mountLabel: 'E:\\',
        busType: 'usb',
        mediaType: 'ssd',
        removable: true,
        availableBytes: 700 * GIB,
      },
      {
        id: 'internal-paging',
        mountLabel: 'D:\\',
        busType: 'nvme',
        mediaType: 'ssd',
        removable: false,
        availableBytes: 600 * GIB,
      },
    ]
    expect(
      selectModelStorage(storage, { minStorageFreeBytes: 100 * GIB, storageClass: 'fixed_nvme_required' }, 18 * GIB)
    ).toEqual({ id: 'internal-paging' })
    expect(
      selectModelStorage(
        storage.filter(item => item.id === 'external-fast'),
        { minStorageFreeBytes: 100 * GIB, storageClass: 'fixed_nvme_required' },
        18 * GIB
      )
    ).toEqual({ reason: 'fixed_nvme_storage_required' })
  })

  it('fails closed for unknown NVMe bus, total RAM, VRAM and signed free-space thresholds', () => {
    const snapshot = hardware([
      {
        id: 'unknown-ssd',
        mountLabel: 'X:\\',
        busType: 'unknown',
        mediaType: 'ssd',
        removable: false,
        availableBytes: 500 * GIB,
      },
    ])
    const assessment = assessModelCapacity({
      snapshot,
      modelReleaseId: 'flash',
      artifactSizeBytes: 18 * GIB,
      policy: {
        minTotalRamBytes: 64 * GIB,
        minAvailableRamBytes: 16 * GIB,
        minVramBytes: 25 * GIB,
        minStorageFreeBytes: 600 * GIB,
        storageClass: 'fixed_nvme_required',
      },
      now: new Date('2026-08-30T12:00:00Z'),
    })
    expect(assessment.status).toBe('ineligible')
    expect(assessment.reasons).toEqual(
      expect.arrayContaining(['total_ram_below_minimum', 'vram_below_minimum', 'fixed_nvme_storage_required'])
    )
  })

  it('treats unknown measured VRAM as ineligible for a signed positive threshold', () => {
    const snapshot = hardware([
      {
        id: 'fixed',
        mountLabel: 'fixed',
        busType: 'sata',
        mediaType: 'ssd',
        removable: false,
        availableBytes: 500 * GIB,
      },
    ])
    snapshot.accelerators = [{ id: 'cuda-unknown', backend: 'cuda', name: 'GPU' }]
    const assessment = assessModelCapacity({
      snapshot,
      modelReleaseId: 'orca',
      artifactSizeBytes: 18 * GIB,
      policy: {
        minTotalRamBytes: 32 * GIB,
        minAvailableRamBytes: 16 * GIB,
        minVramBytes: 20 * GIB,
        minStorageFreeBytes: 40 * GIB,
        storageClass: 'fixed_storage',
      },
    })
    expect(assessment.status).toBe('ineligible')
    expect(assessment.reasons).toContain('vram_below_minimum')
  })

  it('includes local-only active memory locally but never in an external package', () => {
    const scope = {
      principalId: 'account:v2:' + 'a'.repeat(64),
      serverInstance: 'https://example.test/luczor-a',
      projectId: 'project-1',
      sessionId: 'session-1',
      taskType: 'chat',
    }
    const fragments: ScopedContextFragment[] = [
      {
        id: 'private-memory',
        source: 'memory',
        trust: 'user_confirmed',
        scope,
        sensitivity: 'sensitive',
        lifecycle: 'active',
        audiences: ['local_model', 'external_provider'],
        egress: 'local_only',
        content: 'Nur lokal bekannte Präferenz',
        contentHash: '1'.repeat(64),
      },
      {
        id: 'wrong-account',
        source: 'memory',
        trust: 'user_confirmed',
        scope: { ...scope, principalId: 'account:v2:' + 'b'.repeat(64) },
        sensitivity: 'normal',
        lifecycle: 'active',
        audiences: ['local_model'],
        egress: 'local_only',
        content: 'Fremder Account',
        contentHash: '2'.repeat(64),
      },
      {
        id: 'secret',
        source: 'memory',
        trust: 'user_confirmed',
        scope,
        sensitivity: 'secret',
        lifecycle: 'active',
        audiences: ['local_model'],
        egress: 'local_only',
        content: 'token=secret',
        contentHash: '3'.repeat(64),
      },
    ]
    const local = buildScopedContextPackage({ scopeKey: scope, target: 'local_llama_cpp', fragments })
    const external = buildScopedContextPackage({ scopeKey: scope, target: 'laravel_proxy', fragments })
    expect(local.text).toContain('Nur lokal bekannte Präferenz')
    expect(local.text).not.toContain('Fremder Account')
    expect(local.text).not.toContain('token=secret')
    expect(external.text).not.toContain('Nur lokal bekannte Präferenz')
    expect(external.omitted).toContainEqual({ id: 'private-memory', reason: 'local_only' })
  })
})
