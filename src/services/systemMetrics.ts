import { invoke } from '@tauri-apps/api/core'

export type SystemMetrics = {
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
}

export async function readSystemMetrics(): Promise<SystemMetrics> {
  return invoke<SystemMetrics>('system_metrics')
}
