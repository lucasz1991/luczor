import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureVoiceRuntime,
  getHandsFreeConfig,
  getVoiceConfig,
  handsFreeFromVoice,
  localStt,
  localTts,
  MAX_VOICE_PHRASE_CHARS,
  normalizeVoicePhrase,
  resolveVoiceSettings,
  validateVoiceSettings,
  voiceSettingsToStore,
  VOICE_DEFAULTS,
  type VoiceRuntimeStatus,
} from '@/services/voice/localVoice'

const fake = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  invoke: vi.fn(),
  manifest: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: fake.invoke, isTauri: () => false }))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: async () => ({ get: async (key: string) => fake.settings.get(key) }) },
}))
vi.mock('@/services/api/luczorApi', () => ({ LuczorApi: { voiceManifest: fake.manifest } }))

const status = (sttReady: boolean, ttsReady: boolean): VoiceRuntimeStatus => ({
  state: sttReady && ttsReady ? 'ready' : 'incomplete',
  version: 'test-v1',
  stt_ready: sttReady,
  tts_ready: ttsReady,
  error: null,
})

beforeEach(() => {
  fake.settings.clear()
  fake.invoke.mockReset()
  fake.manifest.mockReset().mockResolvedValue({ algorithm: 'RSA-SHA256', payload_json: '{}', signature: 'test' })
})

describe('visible and runtime voice settings share one contract', () => {
  it('uses the same safe defaults for the UI, voice engine and hands-free strategy', async () => {
    expect(resolveVoiceSettings({})).toEqual(VOICE_DEFAULTS)
    await expect(getVoiceConfig()).resolves.toEqual(VOICE_DEFAULTS)
    await expect(getHandsFreeConfig()).resolves.toEqual({
      strategy: 'safeword',
      triggerPhrase: VOICE_DEFAULTS.wakeWord,
      endPhrase: VOICE_DEFAULTS.endPhrase,
      continuousSilenceMs: VOICE_DEFAULTS.continuousSilenceMs,
      autoSubmit: false,
      endMode: 'either',
    })
  })

  it.each(['wakeword', 'continuous', 'push_to_talk'] as const)(
    'uses explicit visible mode %s over the hidden legacy strategy',
    async mode => {
      fake.settings.set('voice_mode', mode)
      fake.settings.set('hands_free_strategy', mode === 'continuous' ? 'safeword' : 'continuous')
      await expect(getVoiceConfig()).resolves.toMatchObject({ mode })
      await expect(getHandsFreeConfig()).resolves.toMatchObject({
        strategy: mode === 'continuous' ? 'continuous' : 'safeword',
      })
    }
  )

  it('preserves legacy continuous only while voice_mode is absent', () => {
    expect(resolveVoiceSettings({ hands_free_strategy: 'continuous' }).mode).toBe('continuous')
    expect(resolveVoiceSettings({ voice_mode: 'invalid', hands_free_strategy: 'continuous' }).mode).toBe('wakeword')
    expect(resolveVoiceSettings({ voice_mode: '', hands_free_strategy: 'continuous' }).mode).toBe('wakeword')
  })

  it('migrates a legacy trigger phrase into the same visible and actual wake word', async () => {
    fake.settings.set('voice_trigger_phrase', '  Jarvis   Start  ')
    await expect(getVoiceConfig()).resolves.toMatchObject({ wakeWord: 'jarvis start' })
    await expect(getHandsFreeConfig()).resolves.toMatchObject({ triggerPhrase: 'jarvis start' })
    fake.settings.set('voice_wake_word', 'Hallo Luczor')
    await expect(getHandsFreeConfig()).resolves.toMatchObject({ triggerPhrase: 'hallo luczor' })
    fake.settings.set('voice_wake_word', '')
    await expect(getHandsFreeConfig()).resolves.toMatchObject({ triggerPhrase: VOICE_DEFAULTS.wakeWord })
  })

  it('round-trips only visible voice keys and uses the selected close phrase, silence and send policy', async () => {
    const configured = resolveVoiceSettings({
      voice_mode: 'continuous',
      voice_wake_word: 'Jarvis Start',
      voice_end_phrase: 'Jarvis Ende',
      voice_continuous_silence_ms: 8000,
      voice_auto_submit: true,
      voice_local_stt_language: 'de-DE',
    })
    const persisted = voiceSettingsToStore(configured)
    expect(persisted).not.toHaveProperty('hands_free_strategy')
    expect(persisted).not.toHaveProperty('voice_trigger_phrase')
    for (const [key, value] of Object.entries(persisted)) fake.settings.set(key, value)
    await expect(getVoiceConfig()).resolves.toEqual(configured)
    await expect(getHandsFreeConfig()).resolves.toEqual({
      strategy: 'continuous',
      triggerPhrase: configured.wakeWord,
      endPhrase: configured.endPhrase,
      continuousSilenceMs: 8000,
      autoSubmit: true,
      endMode: 'either',
    })
  })

  it.each([undefined, false, 'true', 1, null])(
    'does not enable automatic send from a non-true stored value %s',
    value => {
      expect(resolveVoiceSettings({ voice_auto_submit: value }).autoSubmit).toBe(false)
    }
  )

  it.each([
    [undefined, 5000],
    [null, 5000],
    ['', 5000],
    ['invalid', 5000],
    [false, 5000],
    [Number.NaN, 5000],
    [0, 1000],
    [900, 1000],
    [1000, 1000],
    [8000, 8000],
    [99_000, 30_000],
  ])('bounds stored continuous silence %s to %s ms', (value, expected) => {
    expect(resolveVoiceSettings({ voice_continuous_silence_ms: value }).continuousSilenceMs).toBe(expected)
  })

  it('rejects empty, oversized or matching phrases and invalid user-entered silence', () => {
    expect(validateVoiceSettings(VOICE_DEFAULTS)).toBeNull()
    expect(validateVoiceSettings({ ...VOICE_DEFAULTS, wakeWord: '  ' })).toContain('mindestens')
    expect(validateVoiceSettings({ ...VOICE_DEFAULTS, endPhrase: '!!!' })).toContain('mindestens')
    expect(validateVoiceSettings({ ...VOICE_DEFAULTS, wakeWord: 'a'.repeat(MAX_VOICE_PHRASE_CHARS + 1) })).toContain(
      '80'
    )
    expect(normalizeVoicePhrase('LÜCZÖR, STÖPP!')).toBe('luczor stopp')
    expect(validateVoiceSettings({ ...VOICE_DEFAULTS, wakeWord: 'LÜCZÖR, STÖPP!' })).toContain('unterscheiden')
    expect(validateVoiceSettings({ ...VOICE_DEFAULTS, continuousSilenceMs: 500 })).toContain('1 und 30')
    expect(validateVoiceSettings({ ...VOICE_DEFAULTS, continuousSilenceMs: 31_000 })).toContain('1 und 30')
  })

  it('fails closed before listening when stored wake and close phrases conflict', async () => {
    fake.settings.set('voice_wake_word', 'Luczor Stopp!')
    await expect(getHandsFreeConfig()).rejects.toThrow('unterscheiden')
    expect(fake.invoke).not.toHaveBeenCalled()
  })

  it('validates Luczor speech aliases with the same canonical matcher as the engine', () => {
    expect(validateVoiceSettings({ ...VOICE_DEFAULTS, wakeWord: 'Luczor Start', endPhrase: 'Luxor Start' })).toContain(
      'unterscheiden'
    )
    expect(validateVoiceSettings({ ...VOICE_DEFAULTS, wakeWord: 'Lutz or', endPhrase: 'luczor' })).toContain(
      'unterscheiden'
    )
  })

  it('derives runtime behavior from one captured settings snapshot without a second storage read', async () => {
    const snapshot = await getVoiceConfig()
    fake.settings.set('voice_auto_submit', true)
    fake.settings.set('voice_wake_word', 'geändertes wort')
    expect(handsFreeFromVoice(snapshot)).toMatchObject({ triggerPhrase: VOICE_DEFAULTS.wakeWord, autoSubmit: false })
  })
})

describe('local speech input readiness is independent of server speech output', () => {
  it('uses ready STT without downloading Piper even when the combined runtime is incomplete', async () => {
    fake.invoke.mockImplementation(async (command: string) =>
      command === 'voice_runtime_status' ? status(true, false) : { text: ' Hallo Welt ' }
    )
    await expect(ensureVoiceRuntime()).resolves.toMatchObject({ stt_ready: true, tts_ready: false })
    await expect(localStt('test-audio', 'de')).resolves.toBe('Hallo Welt')
    expect(fake.manifest).not.toHaveBeenCalled()
    expect(fake.invoke).not.toHaveBeenCalledWith('install_voice_runtime', expect.anything())
    expect(fake.invoke).toHaveBeenCalledWith('local_stt', { payload: { base64: 'test-audio', language: 'de' } })
  })

  it('downloads and verifies a runtime when STT itself is missing', async () => {
    fake.invoke.mockImplementation(async (command: string) =>
      command === 'voice_runtime_status' ? status(false, false) : status(true, false)
    )
    await expect(ensureVoiceRuntime()).resolves.toMatchObject({ stt_ready: true, tts_ready: false })
    expect(fake.manifest).toHaveBeenCalledOnce()
    expect(fake.invoke).toHaveBeenCalledWith(
      'install_voice_runtime',
      expect.objectContaining({ payload: expect.any(Object) })
    )
  })

  it('does not claim STT ready after an installer returns only a ready TTS engine', async () => {
    fake.invoke.mockResolvedValue(status(false, true))
    await expect(ensureVoiceRuntime()).rejects.toThrow('Spracherkennung ist nicht bereit')
  })

  it('requires actual local TTS readiness only for an explicit localTts call', async () => {
    fake.invoke.mockImplementation(async (command: string) => {
      if (command === 'voice_runtime_status') return status(true, false)
      if (command === 'install_voice_runtime') return status(true, true)
      return { base64: 'test-wav', mime: 'audio/wav' }
    })
    await expect(localTts('Hallo')).resolves.toMatchObject({ base64: 'test-wav' })
    expect(fake.manifest).toHaveBeenCalledOnce()
    expect(fake.invoke).toHaveBeenCalledWith('local_tts', { payload: { text: 'Hallo' } })
  })

  it('does not run localTts when installation still leaves Piper unavailable', async () => {
    fake.invoke.mockResolvedValue(status(true, false))
    await expect(localTts('Hallo')).rejects.toThrow('Sprachausgabe ist nicht bereit')
    expect(fake.invoke).not.toHaveBeenCalledWith('local_tts', expect.anything())
  })
})
