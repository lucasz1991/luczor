import { shallowRef } from 'vue'
import { Store } from '@tauri-apps/plugin-store'

/**
 * Emergency offload: when free RAM drops below the normal reserve, a dream may still run
 * by leaning on the OS page file / SSD (mmap-loaded weights, smaller batches) instead of
 * aborting. Slower, but it lets large maintenance backlogs finish on tight machines.
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
