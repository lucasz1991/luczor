import { describe, expect, it } from 'vitest'
import {
  assessModelCapacity,
  selectModelStorage,
  type HardwareSnapshot,
  type ModelCapacityPolicy,
} from '@/services/inference/capacity'
import {
  buildScopedContextPackage,
  sanitizeInferenceMessagesForTarget,
  type ScopedContextFragment,
} from '@/services/inference/contextBroker'

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

function gpuCapacityInput(accelerators: HardwareSnapshot['accelerators'], policy: Partial<ModelCapacityPolicy> = {}) {
  const snapshot = hardware([
    {
      id: 'fixed-ssd',
      mountLabel: 'fixed-ssd',
      busType: 'nvme',
      mediaType: 'ssd',
      removable: false,
      availableBytes: 100 * GIB,
    },
  ])
  snapshot.accelerators = accelerators
  return {
    snapshot,
    modelReleaseId: 'local',
    artifactSizeBytes: GIB,
    policy: {
      minTotalRamBytes: 16 * GIB,
      minAvailableRamBytes: 8 * GIB,
      minVramBytes: 16 * GIB,
      minStorageFreeBytes: GIB,
      storageClass: 'fixed_storage' as const,
      ...policy,
    },
  }
}

describe('local inference capacity and scoped context', () => {
  it.each([undefined, 'single_device'] as const)(
    'does not pool two 8 GiB GPUs for a 16 GiB minimum under scope %s',
    acceleratorMemoryScope => {
      const input = gpuCapacityInput(
        [
          { id: 'cuda-0', backend: 'cuda', name: 'GPU 0', totalBytes: 8 * GIB },
          { id: 'cuda-1', backend: 'cuda', name: 'GPU 1', totalBytes: 8 * GIB },
        ],
        acceleratorMemoryScope === undefined ? {} : { acceleratorMemoryScope }
      )
      expect(assessModelCapacity(input)).toMatchObject({
        status: 'ineligible',
        reasons: ['vram_below_minimum'],
      })
      input.snapshot.accelerators[0]!.totalBytes = 16 * GIB
      expect(assessModelCapacity(input)).toMatchObject({ status: 'eligible', reasons: [] })
    }
  )

  it.each(['cuda', 'vulkan', 'metal'] as const)(
    'admits two distinct 8 GiB %s GPUs only for a signed compatible group and pending native verification',
    backend => {
      const input = gpuCapacityInput(
        [
          { id: 'gpu-0', backend, name: 'GPU 0', totalBytes: 8 * GIB },
          { id: 'gpu-1', backend, name: 'GPU 1', totalBytes: 8 * GIB },
        ],
        { acceleratorMemoryScope: 'compatible_group' }
      )
      expect(assessModelCapacity(input)).toMatchObject({
        status: 'eligible',
        reasons: [],
        acceleratorVerification: 'runtime_required',
      })
      input.snapshot.memory.totalBytes = 15 * GIB
      input.snapshot.memory.availableBytes = 7 * GIB
      expect(assessModelCapacity(input)).toMatchObject({
        status: 'ineligible',
        reasons: ['total_ram_below_minimum', 'available_ram_below_minimum'],
      })
    }
  )

  it.each<{ label: string; accelerators: HardwareSnapshot['accelerators'] }>([
    {
      label: 'mixed executable backends',
      accelerators: [
        { id: 'cuda-0', backend: 'cuda', name: 'GPU 0', totalBytes: 8 * GIB },
        { id: 'vulkan-0', backend: 'vulkan', name: 'GPU 1', totalBytes: 8 * GIB },
      ],
    },
    {
      label: 'duplicate physical IDs within one backend',
      accelerators: [
        { id: 'cuda-0', backend: 'cuda', name: 'GPU 0', totalBytes: 8 * GIB },
        { id: 'cuda-0', backend: 'cuda', name: 'GPU 0 duplicate', totalBytes: 8 * GIB },
      ],
    },
    {
      label: 'the same physical ID exposed through two backends',
      accelerators: [
        { id: 'gpu-0', backend: 'cuda', name: 'GPU 0 CUDA', totalBytes: 8 * GIB },
        { id: 'gpu-0', backend: 'vulkan', name: 'GPU 0 Vulkan', totalBytes: 8 * GIB },
      ],
    },
    {
      label: 'shared system RAM and dedicated host memory',
      accelerators: [
        { id: 'gpu-0', backend: 'vulkan', name: 'GPU 0', totalBytes: 4 * GIB, sharedSystemLimitBytes: 8 * GIB },
        { id: 'gpu-1', backend: 'vulkan', name: 'GPU 1', totalBytes: 4 * GIB, dedicatedSystemBytes: 8 * GIB },
      ],
    },
    {
      label: 'unverified DXGI adapters',
      accelerators: [
        { id: 'dxgi-0', backend: 'unknown', name: 'GPU 0', totalBytes: 8 * GIB, detectionSource: 'dxgi' },
        { id: 'dxgi-1', backend: 'unknown', name: 'GPU 1', totalBytes: 8 * GIB, detectionSource: 'dxgi' },
      ],
    },
    {
      label: 'unknown or non-finite dedicated VRAM',
      accelerators: [
        { id: 'gpu-0', backend: 'cuda', name: 'GPU 0', totalBytes: 8 * GIB },
        { id: 'gpu-1', backend: 'cuda', name: 'GPU 1', totalBytes: null },
        { id: 'gpu-2', backend: 'cuda', name: 'GPU 2', totalBytes: Infinity },
      ],
    },
  ])('does not pool $label under compatible_group', ({ accelerators }) => {
    const result = assessModelCapacity(gpuCapacityInput(accelerators, { acceleratorMemoryScope: 'compatible_group' }))
    expect(result).toMatchObject({ status: 'ineligible', reasons: ['vram_below_minimum'] })
  })

  it('keeps an explicit backend restriction when another backend has enough group VRAM', () => {
    const input = gpuCapacityInput(
      [
        { id: 'cuda-0', backend: 'cuda', name: 'CUDA GPU', totalBytes: 8 * GIB },
        { id: 'vulkan-0', backend: 'vulkan', name: 'Vulkan GPU 0', totalBytes: 8 * GIB },
        { id: 'vulkan-1', backend: 'vulkan', name: 'Vulkan GPU 1', totalBytes: 8 * GIB },
      ],
      { acceleratorMemoryScope: 'compatible_group', acceptedAccelerators: ['cuda'] }
    )
    expect(assessModelCapacity(input)).toMatchObject({ status: 'ineligible', reasons: ['vram_below_minimum'] })
  })

  it('defers a DXGI adapter backend to native verification without counting shared RAM as VRAM', () => {
    const snapshot = hardware([
      {
        id: 'disk',
        mountLabel: 'disk',
        busType: 'nvme',
        mediaType: 'ssd',
        removable: false,
        availableBytes: 100 * GIB,
      },
    ])
    snapshot.accelerators = [
      {
        id: 'dxgi-adapter',
        backend: 'unknown',
        name: 'Physical GPU',
        detectionSource: 'dxgi',
        totalBytes: 16 * GIB,
        availableBytes: null,
        dedicatedSystemBytes: 0,
        sharedSystemLimitBytes: 16 * GIB,
      },
    ]
    const input = {
      snapshot,
      modelReleaseId: 'local',
      artifactSizeBytes: GIB,
      policy: {
        minTotalRamBytes: GIB,
        minAvailableRamBytes: GIB,
        minVramBytes: 12 * GIB,
        minStorageFreeBytes: GIB,
        storageClass: 'fixed_storage' as const,
      },
    }
    expect(assessModelCapacity(input)).toMatchObject({
      status: 'eligible',
      acceleratorVerification: 'runtime_required',
    })
    expect(
      assessModelCapacity({ ...input, policy: { ...input.policy, acceptedAccelerators: ['cuda'] } })
    ).toMatchObject({ status: 'ineligible', reasons: ['accelerator_unavailable'] })
    snapshot.accelerators[0]!.totalBytes = 0
    expect(assessModelCapacity(input)).toMatchObject({ status: 'ineligible', reasons: ['vram_below_minimum'] })
    snapshot.accelerators[0]!.totalBytes = 16 * GIB
    delete snapshot.accelerators[0]!.detectionSource
    expect(assessModelCapacity(input)).toMatchObject({ status: 'ineligible', reasons: ['accelerator_unavailable'] })
  })

  it('prefers a fixed SSD to a roomier HDD regardless of the bus label', () => {
    const storage: HardwareSnapshot['storage'] = [
      {
        id: 'hdd',
        mountLabel: 'disk1',
        busType: 'sata',
        mediaType: 'hdd',
        removable: false,
        availableBytes: 900 * GIB,
      },
      {
        id: 'ssd',
        mountLabel: 'disk2',
        busType: 'scsi',
        mediaType: 'ssd',
        removable: false,
        availableBytes: 100 * GIB,
      },
    ]
    const policy = { minStorageFreeBytes: GIB, storageClass: 'fixed_storage' as const }
    expect(selectModelStorage(storage, policy, GIB)).toEqual({ id: 'ssd' })
    expect(selectModelStorage(storage, policy, GIB, 'hdd')).toEqual({ id: 'hdd' })
    expect(selectModelStorage(storage, policy, GIB, 'missing')).toEqual({ reason: 'storage_unavailable' })
    expect(selectModelStorage(storage, policy, GIB, null)).toEqual({ reason: 'storage_unavailable' })
  })

  it('does not admit a configured USB model location using another internal NVMe disk', () => {
    const snapshot = hardware([
      {
        id: 'usb',
        mountLabel: 'external',
        busType: 'usb',
        mediaType: 'ssd',
        removable: false,
        availableBytes: 900 * GIB,
      },
      {
        id: 'nvme',
        mountLabel: 'internal',
        busType: 'nvme',
        mediaType: 'ssd',
        removable: false,
        availableBytes: 100 * GIB,
      },
    ])
    snapshot.configuredModelStorageId = 'usb'
    const result = assessModelCapacity({
      snapshot,
      modelReleaseId: 'local',
      artifactSizeBytes: GIB,
      policy: {
        minTotalRamBytes: GIB,
        minAvailableRamBytes: GIB,
        minVramBytes: 0,
        minStorageFreeBytes: GIB,
        storageClass: 'fixed_storage',
      },
    })
    expect(result.status).toBe('ineligible')
    expect(result.reasons).toContain('storage_unavailable')
    expect(result.selectedStorageId).toBeUndefined()
  })

  it('rejects unknown free space even when a release has no storage reserve', () => {
    const storage: HardwareSnapshot['storage'] = [
      { id: 'bad', mountLabel: 'disk', busType: 'nvme', mediaType: 'ssd', removable: false, availableBytes: NaN },
    ]
    expect(selectModelStorage(storage, { minStorageFreeBytes: 0, storageClass: 'fixed_storage' }, 0)).toEqual({
      reason: 'storage_unavailable',
    })
  })

  it('distinguishes an unmeasured first CPU sample from measured resource pressure', () => {
    const snapshot = hardware([
      {
        id: 'disk',
        mountLabel: 'disk',
        busType: 'nvme',
        mediaType: 'ssd',
        removable: false,
        availableBytes: 100 * GIB,
      },
    ])
    const input = {
      snapshot,
      modelReleaseId: 'local',
      artifactSizeBytes: GIB,
      policy: {
        minTotalRamBytes: GIB,
        minAvailableRamBytes: GIB,
        minVramBytes: 0,
        minStorageFreeBytes: GIB,
        storageClass: 'fixed_storage' as const,
        maxCpuLoadPercent: 90,
      },
    }
    snapshot.cpu.loadPercent = null
    expect(assessModelCapacity(input).reasons).not.toContain('resource_pressure')
    snapshot.cpu.loadPercent = 96
    expect(assessModelCapacity(input)).toMatchObject({ status: 'degraded', reasons: ['resource_pressure'] })
  })

  it('does not charge resident model memory twice and binds residency to the signed catalog', () => {
    const snapshot = hardware([
      {
        id: 'disk',
        mountLabel: 'disk',
        busType: 'sata',
        mediaType: 'ssd',
        removable: false,
        availableBytes: 100 * GIB,
      },
    ])
    snapshot.memory.availableBytes = GIB
    snapshot.memory.residentModel = { modelReleaseId: 'local', manifestPayloadSha256: 'catalog-a' }
    const input = {
      snapshot,
      modelReleaseId: 'local',
      manifestPayloadSha256: 'catalog-a',
      artifactSizeBytes: GIB,
      policy: {
        minTotalRamBytes: 16 * GIB,
        minAvailableRamBytes: 8 * GIB,
        minVramBytes: GIB,
        minStorageFreeBytes: GIB,
        storageClass: 'fixed_storage' as const,
      },
    }
    expect(assessModelCapacity(input).reasons).not.toContain('available_ram_below_minimum')
    expect(assessModelCapacity({ ...input, manifestPayloadSha256: 'catalog-b' }).reasons).toContain(
      'available_ram_below_minimum'
    )
    expect(assessModelCapacity({ ...input, modelReleaseId: 'other' }).reasons).toContain('available_ram_below_minimum')
  })
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

  it('includes local-only active memory locally but never in an external package', async () => {
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
    const local = await buildScopedContextPackage({ scopeKey: scope, target: 'local_llama_cpp', fragments })
    const external = await buildScopedContextPackage({ scopeKey: scope, target: 'laravel_proxy', fragments })
    expect(local.text).toContain('Nur lokal bekannte Präferenz')
    expect(local.text).not.toContain('Fremder Account')
    expect(local.text).not.toContain('token=secret')
    expect(external.text).not.toContain('Nur lokal bekannte Präferenz')
    expect(external.omitted).toContainEqual({ id: 'private-memory', reason: 'local_only' })
  })

  it('preserves local paths, redacts external paths and hashes rendered content', async () => {
    const scope = {
      principalId: 'account:v2:' + 'a'.repeat(64),
      serverInstance: 'https://example.test/luczor-a',
      projectId: 'project-1',
      sessionId: 'session-1',
      taskType: 'coding.fix_bug',
    }
    const fragments: ScopedContextFragment[] = [
      {
        id: 'repository-path',
        source: 'repository',
        trust: 'untrusted_data',
        scope,
        sensitivity: 'normal',
        lifecycle: 'active',
        audiences: ['local_model', 'external_provider'],
        egress: 'allowed',
        content: 'Datei E:\\projekte\\luczor\\app\\src\\App.vue',
        contentHash: 'f'.repeat(64),
      },
    ]

    const local = await buildScopedContextPackage({ scopeKey: scope, target: 'local_llama_cpp', fragments })
    const external = await buildScopedContextPackage({ scopeKey: scope, target: 'laravel_proxy', fragments })

    expect(local.text).toContain('E:\\\\projekte\\\\luczor')
    expect(external.text).not.toContain('E:\\\\projekte')
    expect(external.text).toContain('@project')
    expect(local.selected[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(local.selected[0]?.contentHash).not.toBe(fragments[0]?.contentHash)
    expect(local.selected[0]?.contentHash).not.toBe(external.selected[0]?.contentHash)
  })

  it('sanitizes external history and tool arguments while retaining local paths', () => {
    const messages = [
      { role: 'user' as const, content: 'Öffne E:\\private\\repo\\secret.txt' },
      {
        role: 'assistant' as const,
        content: 'Pfad E:\\private\\repo',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function' as const,
            function: { name: 'read_file', arguments: '{"path":"E:\\\\private\\\\repo\\\\secret.txt"}' },
          },
        ],
      },
    ]

    const local = sanitizeInferenceMessagesForTarget(messages, 'local_llama_cpp')
    const external = sanitizeInferenceMessagesForTarget(messages, 'laravel_proxy')
    expect(local[0]?.content).toContain('E:\\private\\repo')
    expect(external[0]?.content).not.toContain('E:\\private\\repo')
    expect(external[0]?.content).toContain('@project')
    expect(external[1]?.role === 'assistant' && external[1].tool_calls?.[0]?.function.arguments).not.toContain(
      'E:\\\\private'
    )
  })
})
