import { invoke } from '@tauri-apps/api/core'
import { Store } from '@tauri-apps/plugin-store'

const SETTINGS_FILE = 'luczor.settings.json'
const LEGACY_DEVICE_KEY = 'luczor_device_key'

let migrationInFlight: Promise<string> | null = null
let cachedDeviceKey = ''
let cacheReady = false

/**
 * Load the device key from the OS credential store. On first use, migrate the
 * former plaintext Store value and remove only that legacy field after a
 * successful native write plus read-back verification.
 */
export function loadDeviceKey(): Promise<string> {
  if (cacheReady) return Promise.resolve(cachedDeviceKey)
  if (!migrationInFlight) {
    migrationInFlight = migrateLegacyDeviceKey()
      .then(value => {
        cachedDeviceKey = value
        cacheReady = true
        return value
      })
      .finally(() => {
        migrationInFlight = null
      })
  }
  return migrationInFlight
}

export async function saveDeviceKey(rawValue: string): Promise<void> {
  const value = rawValue.trim()
  if (!value) {
    // Remove the legacy plaintext first. If that fails, retain the protected
    // credential and fail the save instead of allowing plaintext to rehydrate
    // a credential that the user just cleared on the next startup.
    await deleteLegacyDeviceKey()
    await invoke('device_key_delete')
    cachedDeviceKey = ''
    cacheReady = true
    return
  }

  if (!cacheReady || cachedDeviceKey !== value) await writeAndVerify(value)
  await deleteLegacyDeviceKey()
  cachedDeviceKey = value
  cacheReady = true
}

async function migrateLegacyDeviceKey(): Promise<string> {
  const secure = await invoke<string | null>('device_key_get')
  const settings = await Store.load(SETTINGS_FILE)
  const legacyRaw = await settings.get<string>(LEGACY_DEVICE_KEY)

  if (secure) {
    if (legacyRaw !== undefined) {
      await settings.delete(LEGACY_DEVICE_KEY)
      await settings.save()
    }
    return secure
  }

  const legacy = (legacyRaw ?? '').trim()
  if (!legacy) {
    if (legacyRaw !== undefined) {
      await settings.delete(LEGACY_DEVICE_KEY)
      await settings.save()
    }
    return ''
  }

  await writeAndVerify(legacy)
  await settings.delete(LEGACY_DEVICE_KEY)
  await settings.save()
  return legacy
}

async function writeAndVerify(value: string): Promise<void> {
  await invoke('device_key_set', { payload: { value } })
  const verified = await invoke<string | null>('device_key_get')
  if (verified !== value) {
    throw new Error('Der Device-Key konnte im Betriebssystem-Schlüsselspeicher nicht verifiziert werden.')
  }
}

async function deleteLegacyDeviceKey(): Promise<void> {
  const settings = await Store.load(SETTINGS_FILE)
  if ((await settings.get(LEGACY_DEVICE_KEY)) === undefined) return
  await settings.delete(LEGACY_DEVICE_KEY)
  await settings.save()
}
