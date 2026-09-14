import type { HardwareSnapshot } from './capacity'
import type { LocalResourceConfig, ResourcePercentageLimits } from './resources'

const GIB = 1024 ** 3
const MIB = 1024 ** 2
export const MAXIMUM_RESOURCE_PERCENTAGES: Readonly<ResourcePercentageLimits> = Object.freeze({
  responseCpu: 100, contextCpu: 100, ram: 100, gpu: 100,
})
const bytes = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const percentBudget = (value: number, percent: number) => Math.floor(value / 100) * percent + Math.floor((value % 100) * percent / 100)

/** Inventory-based capacity estimate, not a stress test or measured model fit. */
export function resourceSystemCheck(hardware: HardwareSnapshot, config: LocalResourceConfig) {
  const logical = hardware.cpu.logicalCores
  const available = Math.min(logical, hardware.cpu.availableLogicalCores ?? logical)
  if (!Number.isSafeInteger(available) || available < 1 ||
      !bytes(hardware.memory.totalBytes) || !bytes(hardware.memory.availableBytes) || hardware.memory.totalBytes < 2 * GIB)
    throw new Error('resource_system_check_incomplete')
  const maximumThreads = Math.max(1, available - (available === 1 ? 0 : available < 8 ? 1 : 2))
  const ramReserve = Math.min(4 * GIB, Math.max(GIB, Math.floor(hardware.memory.totalBytes / 12)))
  const availableRam = Math.min(hardware.memory.availableBytes, hardware.memory.totalBytes)
  const maximumRam = Math.max(0, availableRam - ramReserve)
  const limits = config.percentageLimits ?? MAXIMUM_RESOURCE_PERCENTAGES
  if (Object.values(limits).some(value => !Number.isInteger(value) || value < 1 || value > 100))
    throw new Error('resource_percentage_invalid')
  const gpus = hardware.accelerators
    .filter(gpu => config.gpuDeviceIds === null || config.gpuDeviceIds.includes(gpu.id))
    .map(gpu => {
      // Integrated/shared capacity and missing telemetry are not free dedicated VRAM.
      const free = bytes(gpu.availableBytes) && bytes(gpu.totalBytes) ? Math.min(gpu.availableBytes, gpu.totalBytes) : null
      const maximum = free === null ? null : Math.max(0, Math.floor(free / MIB) - 1024) * MIB
      return { id: gpu.id, name: gpu.name, maximum, budget: maximum === null ? null : percentBudget(maximum / MIB, limits.gpu) * MIB }
    })
  return {
    capturedAtMs: hardware.capturedAtMs, maximumThreads, maximumRam, ramReserve,
    responseThreads: Math.max(1, percentBudget(maximumThreads, limits.responseCpu)),
    contextThreads: Math.max(1, percentBudget(maximumThreads, limits.contextCpu)),
    ramBudget: percentBudget(maximumRam, limits.ram), gpus,
  }
}

export function percentageResourceConfig(hardware: HardwareSnapshot, config: LocalResourceConfig, limits: ResourcePercentageLimits): LocalResourceConfig {
  const next = { ...config, percentageLimits: { ...limits } }
  const check = resourceSystemCheck(hardware, next)
  return { ...next, threads: check.responseThreads, threadsBatch: check.contextThreads,
    ramReserveBytes: check.ramReserve + check.maximumRam - check.ramBudget,
    // The runtime calculates a separate reserve per selected GPU.
    vramReserveBytes: null }
}

/** Resolved byte/thread fields may differ after native fresh-hardware validation. */
export function sameResourceIntent(first: LocalResourceConfig, second: LocalResourceConfig): boolean {
  if (!first.percentageLimits || !second.percentageLimits) return JSON.stringify(first) === JSON.stringify(second)
  return first.mode === second.mode && JSON.stringify(first.gpuDeviceIds) === JSON.stringify(second.gpuDeviceIds) &&
    JSON.stringify(first.percentageLimits) === JSON.stringify(second.percentageLimits)
}
