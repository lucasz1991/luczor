export type AcceleratorBackend = 'cuda' | 'vulkan' | 'metal' | 'cpu' | 'unknown'
export type StorageBusType = 'nvme' | 'sata' | 'scsi' | 'usb' | 'unknown'
export type StorageMediaType = 'ssd' | 'hdd' | 'unknown'
export type StorageClass = 'fixed_nvme_required' | 'fixed_storage'

export type HardwareSnapshot = {
  schemaVersion: 1
  snapshotId: string
  capturedAtMs: number
  platform: string
  arch: string
  cpu: {
    logicalCores: number
    physicalCores?: number
    features: string[]
    loadPercent: number
  }
  memory: {
    totalBytes: number
    availableBytes: number
    residentModel?: { modelReleaseId: string; manifestPayloadSha256: string } | null
  }
  accelerators: Array<{
    id: string
    backend: AcceleratorBackend
    name: string
    totalBytes?: number
    availableBytes?: number
  }>
  storage: Array<{
    id: string
    mountLabel: string
    busType: StorageBusType
    mediaType: StorageMediaType
    removable: boolean
    availableBytes: number
  }>
  thermal?: { cpuC?: number; gpuC?: number }
  runtime?: { id: string; version: string; devices: string[] }
}

export type ModelCapacityPolicy = {
  minTotalRamBytes: number
  minAvailableRamBytes: number
  minVramBytes: number
  minStorageFreeBytes: number
  storageClass: StorageClass
  acceptedAccelerators?: AcceleratorBackend[]
  maxCpuLoadPercent?: number
  maxGpuTemperatureC?: number
}

export type CapacityStatus = 'eligible' | 'degraded' | 'ineligible'
export type CapacityReason =
  | 'total_ram_below_minimum'
  | 'available_ram_below_minimum'
  | 'accelerator_unavailable'
  | 'vram_below_minimum'
  | 'storage_unavailable'
  | 'fixed_nvme_storage_required'
  | 'resource_pressure'
  | 'thermal_limit'

export type CapacityAssessment = {
  snapshotId: string
  modelReleaseId: string
  status: CapacityStatus
  reasons: CapacityReason[]
  selectedStorageId?: string
  assessedAtMs: number
  validUntilMs: number
  memory?: { availableBytes: number; requiredAvailableBytes: number; resident: boolean }
  benchmark?: {
    prefillTokensPerSecond: number
    decodeTokensPerSecond: number
    timeToFirstTokenMs: number
    peakRamBytes: number
    peakVramBytes?: number
    contextTokens: number
  }
}

type StorageSelection = { id?: string; reason?: CapacityReason }

function finiteNonNegative(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function storagePriority(busType: StorageBusType): number {
  if (busType === 'nvme') return 0
  if (busType === 'sata') return 1
  if (busType === 'scsi') return 2
  return 3
}

export function selectModelStorage(
  storage: HardwareSnapshot['storage'],
  policy: Pick<ModelCapacityPolicy, 'minStorageFreeBytes' | 'storageClass'>,
  artifactSizeBytes: number
): StorageSelection {
  const requiredBytes = Math.max(finiteNonNegative(policy.minStorageFreeBytes), finiteNonNegative(artifactSizeBytes))
  const fixed = storage.filter(
    item => !item.removable && item.busType !== 'usb' && finiteNonNegative(item.availableBytes) >= requiredBytes
  )
  const eligible = policy.storageClass === 'fixed_nvme_required' ? fixed.filter(item => item.busType === 'nvme') : fixed

  const selected = [...eligible].sort(
    (left, right) =>
      storagePriority(left.busType) - storagePriority(right.busType) ||
      right.availableBytes - left.availableBytes ||
      left.id.localeCompare(right.id)
  )[0]

  if (selected) return { id: selected.id }
  return {
    reason: policy.storageClass === 'fixed_nvme_required' ? 'fixed_nvme_storage_required' : 'storage_unavailable',
  }
}

export function assessModelCapacity(input: {
  snapshot: HardwareSnapshot
  modelReleaseId: string
  manifestPayloadSha256?: string
  policy: ModelCapacityPolicy
  artifactSizeBytes: number
  now?: Date
  validForMs?: number
}): CapacityAssessment {
  const { snapshot, policy } = input
  const reasons: CapacityReason[] = []

  if (finiteNonNegative(snapshot.memory.totalBytes) < finiteNonNegative(policy.minTotalRamBytes)) {
    reasons.push('total_ram_below_minimum')
  }
  const resident =
    !!input.manifestPayloadSha256 &&
    snapshot.memory.residentModel?.modelReleaseId === input.modelReleaseId &&
    snapshot.memory.residentModel.manifestPayloadSha256 === input.manifestPayloadSha256
  if (!resident && finiteNonNegative(snapshot.memory.availableBytes) < finiteNonNegative(policy.minAvailableRamBytes)) {
    reasons.push('available_ram_below_minimum')
  }

  const accepted = new Set(policy.acceptedAccelerators ?? ['cuda', 'vulkan', 'metal'])
  const accelerators = snapshot.accelerators.filter(item => accepted.has(item.backend))
  if (!accelerators.length && finiteNonNegative(policy.minVramBytes) > 0) {
    reasons.push('accelerator_unavailable')
  } else if (
    finiteNonNegative(policy.minVramBytes) > 0 &&
    !accelerators.some(item => finiteNonNegative(item.totalBytes) >= finiteNonNegative(policy.minVramBytes))
  ) {
    reasons.push('vram_below_minimum')
  }

  const storage = selectModelStorage(snapshot.storage, policy, input.artifactSizeBytes)
  if (storage.reason) reasons.push(storage.reason)

  const degraded: CapacityReason[] = []
  if (policy.maxCpuLoadPercent != null && snapshot.cpu.loadPercent > policy.maxCpuLoadPercent) {
    degraded.push('resource_pressure')
  }
  if (
    policy.maxGpuTemperatureC != null &&
    snapshot.thermal?.gpuC != null &&
    snapshot.thermal.gpuC > policy.maxGpuTemperatureC
  ) {
    degraded.push('thermal_limit')
  }

  const now = input.now ?? new Date()
  const validUntil = new Date(now.getTime() + Math.max(1_000, input.validForMs ?? 5 * 60_000))
  return {
    snapshotId: snapshot.snapshotId,
    modelReleaseId: input.modelReleaseId,
    status: reasons.length ? 'ineligible' : degraded.length ? 'degraded' : 'eligible',
    reasons: [...reasons, ...degraded],
    selectedStorageId: storage.id,
    assessedAtMs: now.getTime(),
    validUntilMs: validUntil.getTime(),
    memory: {
      availableBytes: snapshot.memory.availableBytes,
      requiredAvailableBytes: policy.minAvailableRamBytes,
      resident,
    },
  }
}
