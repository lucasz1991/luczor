import { describe, expect, it, vi } from 'vitest'
import { voiceInputStore } from '@/services/voice/voiceInputStore'
const fake = vi.hoisted(() => ({ invoke: vi.fn(), load: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: fake.invoke }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'luczor-mini' }) }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: fake.load } }))
describe('Mini voice settings bridge', () => {
  it('uses only the voice-specific native store and sends only changed keys', async () => {
    fake.invoke.mockResolvedValueOnce({ voice_end_mode: 'either', voice_continuous_silence_ms: 5000 })
    const store = await voiceInputStore('luczor.settings.json')
    expect(fake.load).not.toHaveBeenCalled()
    await expect(store.get('device_key')).resolves.toBeUndefined()
    await store.set('voice_continuous_silence_ms', 3000)
    await expect(store.get('voice_continuous_silence_ms')).resolves.toBe(3000)
    await store.save()
    expect(fake.invoke).toHaveBeenLastCalledWith('voice_input_store', {
      resource: 'settings',
      values: { voice_continuous_silence_ms: 3000 },
    })
  })
})
