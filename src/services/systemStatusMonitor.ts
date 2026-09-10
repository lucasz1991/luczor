import { reactive, readonly } from 'vue'
import { readSystemMetrics, type SystemMetrics } from './systemMetrics'

export type SystemStatusAvailability = 'idle' | 'loading' | 'live' | 'unavailable' | 'stale'
export type SystemStatusResources = { cpu: number | null; ram: number | null; gpu: number | null }
export type SystemStatusPoint = SystemStatusResources & {
  at: number
  disk?: { busy: number | null; read: number | null; write: number | null }
  disks?: Record<string, { busy: number | null; read: number | null; write: number | null }>
  app: SystemStatusResources
  model: SystemStatusResources
}
export type SystemStatusState = {
  sample: SystemMetrics | null
  history: SystemStatusPoint[]
  availability: SystemStatusAvailability
  lastUpdatedAt: number | null
}

type MonitorOptions = {
  read?: () => Promise<SystemMetrics>
  now?: () => number
  intervalMs?: number
  maxHistory?: number
}

/** Zero is a measured value; absent or non-finite telemetry stays unavailable. */
export function percent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null
}

function memoryMb(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function emptyResources(): SystemStatusResources {
  return { cpu: null, ram: null, gpu: null }
}

/** Temporary device telemetry. Reads never overlap, and closed views cannot receive late samples. */
export function createSystemStatusMonitor(options: MonitorOptions = {}) {
  const read = options.read ?? readSystemMetrics
  const now = options.now ?? Date.now
  const intervalMs = Math.max(1, options.intervalMs ?? 3_500)
  const maxHistory = Math.min(40, Math.max(1, Math.floor(options.maxHistory ?? 40)))
  const state = reactive<SystemStatusState>({
    sample: null,
    history: [],
    availability: 'idle',
    lastUpdatedAt: null,
  })
  let active = false
  let disposed = false
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | null = null

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  function append(point: SystemStatusPoint) {
    state.history.push(point)
    if (state.history.length > maxHistory) state.history.splice(0, state.history.length - maxHistory)
  }

  function refresh(): Promise<void> {
    if (!active || disposed) return Promise.resolve()
    if (inFlight) return inFlight
    clearTimer()
    const requestGeneration = generation
    if (!state.sample) state.availability = 'loading'
    const current = () => active && !disposed && generation === requestGeneration
    // Enter the promise first so a synchronously throwing dependency has the same lifecycle as IPC.
    inFlight = Promise.resolve()
      .then(() => (current() ? read() : null))
      .then(sample => {
        if (!current() || sample === null) return
        const at = now()
        const disks = (Array.isArray(sample.disks) ? sample.disks : sample.disk ? [sample.disk] : []).map(disk => ({
          ...disk,
          scopes: disk.scopes ? [...disk.scopes] : undefined,
        }))
        const appDisk = disks.find(disk => disk.scopes?.includes('app')) ?? disks[0] ?? null
        state.sample = {
          disks,
          disk: appDisk,
          cpu_percent: sample.cpu_percent,
          ram_percent: sample.ram_percent,
          ram_used_mb: sample.ram_used_mb,
          ram_total_mb: sample.ram_total_mb,
          gpu_percent: sample.gpu_percent,
          gpu_source: sample.gpu_source,
          network_local: sample.network_local ? { ...sample.network_local } : undefined,
          cpu_temp_c: sample.cpu_temp_c,
          gpu_temp_c: sample.gpu_temp_c,
          app_cpu_percent: percent(sample.app_cpu_percent),
          app_ram_percent: percent(sample.app_ram_percent),
          app_ram_used_mb: memoryMb(sample.app_ram_used_mb),
          app_gpu_percent: percent(sample.app_gpu_percent),
          model_cpu_percent: sample.model_running === false ? null : percent(sample.model_cpu_percent),
          model_ram_percent: sample.model_running === false ? null : percent(sample.model_ram_percent),
          model_ram_used_mb: sample.model_running === false ? null : memoryMb(sample.model_ram_used_mb),
          model_gpu_percent: sample.model_running === false ? null : percent(sample.model_gpu_percent),
          model_running: typeof sample.model_running === 'boolean' ? sample.model_running : null,
        }
        state.lastUpdatedAt = at
        state.availability = 'live'
        const diskHistory = Object.fromEntries(
          disks.map(disk => [
            disk.mount,
            {
              busy: percent(disk.busy_percent),
              read: percent(disk.read_percent),
              write: percent(disk.write_percent),
            },
          ])
        )
        append({
          at,
          ...(appDisk
            ? {
                disk: {
                  busy: percent(appDisk.busy_percent),
                  read: percent(appDisk.read_percent),
                  write: percent(appDisk.write_percent),
                },
              }
            : {}),
          ...(Object.keys(diskHistory).length ? { disks: diskHistory } : {}),
          cpu: percent(sample.cpu_percent),
          ram: percent(sample.ram_percent),
          gpu: percent(sample.gpu_percent),
          app: {
            cpu: state.sample.app_cpu_percent ?? null,
            ram: state.sample.app_ram_percent ?? null,
            gpu: state.sample.app_gpu_percent ?? null,
          },
          model: {
            cpu: state.sample.model_cpu_percent ?? null,
            ram: state.sample.model_ram_percent ?? null,
            gpu: state.sample.model_gpu_percent ?? null,
          },
        })
      })
      .catch(() => {
        if (!current()) return
        state.availability = state.sample ? 'stale' : 'unavailable'
        append({ at: now(), ...emptyResources(), app: emptyResources(), model: emptyResources() })
      })
      .finally(() => {
        inFlight = null
        if (!active || disposed) return
        if (requestGeneration !== generation) {
          // A reopened view waits for the old native call to settle before requesting its own sample.
          void refresh()
        } else {
          timer = setTimeout(() => void refresh(), intervalMs)
        }
      })
    return inFlight
  }

  function setActive(value: boolean) {
    if (disposed || active === value) return
    active = value
    generation++
    clearTimer()
    if (active) {
      state.availability = state.sample ? 'stale' : 'loading'
      void refresh()
    } else {
      state.availability = 'idle'
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    active = false
    generation++
    clearTimer()
    state.availability = 'idle'
  }

  return { state: readonly(state), setActive, refresh, dispose }
}
