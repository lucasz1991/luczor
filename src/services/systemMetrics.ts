import { invoke } from '@tauri-apps/api/core'

export type LocalNetworkCounters = {
  sent_bytes: number
  received_bytes: number
  requests: number
  active_requests: number
  failed_requests: number
}

export type DiskMetrics = {
  mount: string
  kind: 'ssd' | 'hdd' | 'unknown'
  total_bytes: number
  used_bytes: number
  busy_percent: number | null
  read_percent: number | null
  write_percent: number | null
}

export type SystemMetrics = {
  disk?: DiskMetrics | null
  cpu_percent: number
  ram_percent: number
  ram_used_mb: number
  ram_total_mb: number
  gpu_percent: number | null
  gpu_source?: 'windows_engine' | 'nvml' | 'unavailable'
  cpu_temp_c: number | null
  gpu_temp_c: number | null
  /** Process scopes use the same whole-device percentage scale as the total fields. */
  app_cpu_percent?: number | null
  app_ram_percent?: number | null
  app_ram_used_mb?: number | null
  app_gpu_percent?: number | null
  model_cpu_percent?: number | null
  model_ram_percent?: number | null
  model_ram_used_mb?: number | null
  model_gpu_percent?: number | null
  /** False means no owned local-model process; null means process state is unavailable. */
  model_running?: boolean | null
  network_local?: LocalNetworkCounters
}

export async function readSystemMetrics(): Promise<SystemMetrics> {
  return invoke<SystemMetrics>('system_metrics')
}
