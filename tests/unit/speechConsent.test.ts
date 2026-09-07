import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '@tauri-apps/plugin-store'
import { loadLocalSpeechConsent, saveLocalSpeechConsent, SPEECH_CONSENT_FILE } from '@/services/voice/speechConsent'

vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: vi.fn() } }))
const settings = new Map<string, unknown>()
const consent = new Map<string, unknown>()
const saved: unknown[] = []
beforeEach(() => {
  settings.clear()
  consent.clear()
  saved.length = 0
  settings.set('luczor_api_base_url', 'https://luczor.example.test')
  settings.set('luczor_client_id', 'client-one')
  vi.mocked(Store.load).mockImplementation(
    async filename =>
      ({
        get: async (key: string) => (filename === SPEECH_CONSENT_FILE ? consent : settings).get(key),
        set: async (key: string, value: unknown) => {
          ;(filename === SPEECH_CONSENT_FILE ? consent : settings).set(key, value)
        },
        save: async () => {
          saved.push(Object.fromEntries(consent))
        },
      }) as unknown as Store
  )
})

describe('local speech consent', () => {
  it('defaults to blocked, records explicit consent for the destination and revokes it', async () => {
    expect(await loadLocalSpeechConsent()).toBe(false)
    await saveLocalSpeechConsent(true)
    expect(saved[0]).toEqual({ allow_local_content: false })
    expect(await loadLocalSpeechConsent()).toBe(true)
    await saveLocalSpeechConsent(false)
    expect(await loadLocalSpeechConsent()).toBe(false)
    expect(settings.size).toBe(2)
  })

  it('does not carry consent to another server or client', async () => {
    await saveLocalSpeechConsent(true)
    settings.set('luczor_api_base_url', 'https://other.example.test')
    expect(await loadLocalSpeechConsent()).toBe(false)
    settings.set('luczor_api_base_url', 'https://luczor.example.test')
    settings.set('luczor_client_id', 'client-two')
    expect(await loadLocalSpeechConsent()).toBe(false)
  })
})
