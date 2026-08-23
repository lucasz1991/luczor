import { invoke } from '@tauri-apps/api/core'

export type SystemMetrics = {
  cpu_percent: number
  ram_percent: number
  ram_used_mb: number
  ram_total_mb: number
  gpu_percent: number | null
  cpu_temp_c: number | null
  gpu_temp_c: number | null
}

export async function readSystemMetrics(): Promise<SystemMetrics> {
  return invoke<SystemMetrics>('system_metrics')
}
