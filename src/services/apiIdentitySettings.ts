import { getApiConfig, DEFAULT_BASE_URL } from '@/services/api/luczorApi'
import { saveDeviceKey } from '@/services/secureDeviceKey'
import { invalidateLocalInferenceApiIdentity } from '@/services/inference/coordinator'
import { suspendSpeech } from '@/services/voice/speak'

// Deliberately nonempty: an empty URL would reactivate getApiConfig's production default.
export const DISABLED_API_BASE_URL = 'about:blank'

type IdentityStore = {
  set(key: string, value: string): Promise<void>
  save(): Promise<void>
}

type IdentityWriterDependencies = {
  readIdentity(): Promise<{ baseUrl: string; deviceKey: string }>
  writeDeviceKey(value: string): Promise<void>
  suspendSpeech(): () => void
  beforeChange(): Promise<void>
}

/** Serialize identity writes; never expose one account's key to another server on partial failure. */
export function createApiIdentityWriter(dependencies: IdentityWriterDependencies) {
  let pending: Promise<unknown> = Promise.resolve()
  let resumeBlockedSpeech: (() => void) | null = null

  return (store: IdentityStore, rawBaseUrl: string, rawDeviceKey: string): Promise<boolean> => {
    const baseUrl = rawBaseUrl.trim().replace(/\/+$/u, '') || DEFAULT_BASE_URL
    const deviceKey = rawDeviceKey.trim()
    const operation = pending.then(async () => {
      let writesStarted = false
      try {
        const target = new URL(baseUrl)
        if (
          !['https:', 'http:'].includes(target.protocol) ||
          target.username ||
          target.password ||
          target.search ||
          target.hash
        ) {
          throw new Error('Invalid server URL')
        }
        const previous = await dependencies.readIdentity()
        if (!resumeBlockedSpeech && previous.baseUrl === baseUrl && previous.deviceKey === deviceKey) return false
        resumeBlockedSpeech ??= dependencies.suspendSpeech()
        await dependencies.beforeChange()

        // Persist the disconnected state BEFORE touching either the native key or its cache.
        // This also closes the mixed-identity window if the app exits at any later await.
        writesStarted = true
        await store.set('luczor_api_base_url', DISABLED_API_BASE_URL)
        await store.save()
        // Clear first even when retrying the old key: an earlier native write may have
        // succeeded before verification failed, while the JS key cache still holds the old key.
        await dependencies.writeDeviceKey('')
        if (deviceKey) await dependencies.writeDeviceKey(deviceKey)
        await store.set('luczor_api_base_url', baseUrl)
        await store.save()

        resumeBlockedSpeech()
        resumeBlockedSpeech = null
        return true
      } catch {
        resumeBlockedSpeech ??= dependencies.suspendSpeech()
        if (writesStarted) {
          try {
            await store.set('luczor_api_base_url', DISABLED_API_BASE_URL)
            await store.save()
          } catch {
            // The speech lock remains held. Before key writes the old pair is intact;
            // afterwards the persisted base is disconnected or belongs to the verified new key.
          }
        }
        // Never expose native errors: credential-store errors may echo key material.
        throw new Error(
          'Server-Einstellungen konnten nicht sicher gespeichert werden. Bitte Server-URL und Device-Key prüfen. Die Sprachausgabe bleibt gesperrt, bis die Server-Einstellungen erneut erfolgreich gespeichert wurden.'
        )
      }
    })
    pending = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}

// A failed save keeps its lock across Settings close/reopen. A successful retry releases it.
export const persistApiIdentity = createApiIdentityWriter({
  readIdentity: getApiConfig,
  writeDeviceKey: saveDeviceKey,
  suspendSpeech,
  async beforeChange() {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('luczor:voice-stop'))
    await invalidateLocalInferenceApiIdentity()
  },
})
