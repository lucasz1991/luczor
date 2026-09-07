import { Store } from '@tauri-apps/plugin-store'
import { DEFAULT_API_BASE_URL } from '@/services/api/endpoint'

export const SPEECH_CONSENT_FILE = 'luczor.speech-consent.json'

async function currentSpeechDestination() {
  const settings = await Store.load('luczor.settings.json')
  return {
    server: String((await settings.get<string>('luczor_api_base_url')) || DEFAULT_API_BASE_URL)
      .trim()
      .replace(/\/+$/u, ''),
    client: String((await settings.get<string>('luczor_client_id')) || ''),
  }
}

/** A speech-only opt-in, bound to the configured destination and separate from sync/storage policy. */
export async function loadLocalSpeechConsent(): Promise<boolean> {
  const store = await Store.load(SPEECH_CONSENT_FILE)
  if ((await store.get<boolean>('allow_local_content')) !== true) return false
  const destination = await currentSpeechDestination()
  return (
    (await store.get<string>('server')) === destination.server &&
    (await store.get<string>('client')) === destination.client
  )
}

export async function saveLocalSpeechConsent(allowed: boolean): Promise<void> {
  const store = await Store.load(SPEECH_CONSENT_FILE)
  await store.set('allow_local_content', false)
  await store.save()
  if (!allowed) return
  const destination = await currentSpeechDestination()
  await store.set('server', destination.server)
  await store.set('client', destination.client)
  await store.set('allow_local_content', allowed)
  await store.save()
}
