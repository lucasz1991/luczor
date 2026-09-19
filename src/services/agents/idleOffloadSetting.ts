import { shallowRef } from 'vue'
import { Store } from '@tauri-apps/plugin-store'

/**
 * Low-RAM admission: allow smaller source batches below the normal RAM reserve only
 * while the worker's physical-memory and system-wide swap headroom checks pass.
 * This setting neither reserves a page file nor measures or guarantees OS paging.
 * Kept in its own module so the maintenance worker does not pull the optimizer wiring.
 */
export const IDLE_EMERGENCY_OFFLOAD_KEY = 'local_idle_emergency_offload'
export const idleEmergencyOffload = shallowRef(true)

export async function loadIdleEmergencyOffloadSetting(): Promise<void> {
  const store = await Store.load('luczor.settings.json')
  const saved = await store.get<unknown>(IDLE_EMERGENCY_OFFLOAD_KEY).catch(() => undefined)
  idleEmergencyOffload.value = saved == null || saved === true
}

export async function saveIdleEmergencyOffloadSetting(enabled: boolean): Promise<void> {
  const store = await Store.load('luczor.settings.json')
  await store.set(IDLE_EMERGENCY_OFFLOAD_KEY, enabled)
  await store.save()
  idleEmergencyOffload.value = enabled
}
