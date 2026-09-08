import { invoke } from '@tauri-apps/api/core'
import { LuczorApi } from '@/services/api/luczorApi'
import { Store } from '@tauri-apps/plugin-store'
import { cleanSttTranscript } from './transcript'
import { normalizeVoiceControlPhrase } from './voicePhrases'
import { voiceInputStore, isMiniVoice } from './voiceInputStore'

export type VoiceMode = 'push_to_talk' | 'continuous' | 'wakeword'
export type VoiceEndMode = 'close_word' | 'silence' | 'either'
export type VoiceConfig = { mode: VoiceMode; wakeWord: string; localSttLanguage: string }
export type ResolvedVoiceSettings = VoiceConfig & {
  endPhrase: string
  continuousSilenceMs: number
  /** Optional silence-based submission; a confirmed close word always sends. */
  autoSubmit: boolean
  endMode?: VoiceEndMode
}
export const VOICE_DEFAULTS: Readonly<ResolvedVoiceSettings> = Object.freeze({
  mode: 'wakeword',
  wakeWord: 'luczor',
  endPhrase: 'luczor stopp',
  localSttLanguage: 'de',
  continuousSilenceMs: 5000,
  autoSubmit: false,
  endMode: 'either',
})
export const MAX_VOICE_PHRASE_CHARS = 80

export type StoredVoiceSettings = {
  voice_mode?: unknown
  voice_wake_word?: unknown
  voice_trigger_phrase?: unknown
  voice_end_phrase?: unknown
  voice_local_stt_language?: unknown
  voice_continuous_silence_ms?: unknown
  voice_auto_submit?: unknown
  voice_end_mode?: unknown
  hands_free_strategy?: unknown
}

/** Compare phrases the same way German speech matching treats case, accents and punctuation. */
export function normalizeVoicePhrase(value: string): string {
  return normalizeVoiceControlPhrase(value)
}

function phraseSetting(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const clean = value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('de-DE')
  return normalizeVoicePhrase(clean) ? clean : fallback
}

/** One source for both visible settings and the runtime, including legacy preferences. */
export function resolveVoiceSettings(stored: StoredVoiceSettings): ResolvedVoiceSettings {
  const explicitMode = stored.voice_mode
  const mode =
    explicitMode === 'push_to_talk' || explicitMode === 'continuous' || explicitMode === 'wakeword'
      ? explicitMode
      : explicitMode == null && stored.hands_free_strategy === 'continuous'
        ? 'continuous'
        : VOICE_DEFAULTS.mode
  const silenceValue = stored.voice_continuous_silence_ms
  const rawSilence =
    typeof silenceValue === 'number' || (typeof silenceValue === 'string' && silenceValue.trim())
      ? Number(silenceValue)
      : Number.NaN
  const continuousSilenceMs =
    stored.voice_continuous_silence_ms != null && Number.isFinite(rawSilence)
      ? Math.max(1000, Math.min(30_000, Math.round(rawSilence)))
      : VOICE_DEFAULTS.continuousSilenceMs
  return {
    mode,
    wakeWord: phraseSetting(stored.voice_wake_word ?? stored.voice_trigger_phrase, VOICE_DEFAULTS.wakeWord),
    endPhrase: phraseSetting(stored.voice_end_phrase, VOICE_DEFAULTS.endPhrase),
    localSttLanguage: phraseSetting(stored.voice_local_stt_language, VOICE_DEFAULTS.localSttLanguage),
    continuousSilenceMs,
    autoSubmit: stored.voice_auto_submit === true,
    endMode:
      stored.voice_end_mode === 'close_word' || stored.voice_end_mode === 'silence' ? stored.voice_end_mode : 'either',
  }
}

export function validateVoiceSettings(
  config: Pick<ResolvedVoiceSettings, 'wakeWord' | 'endPhrase' | 'continuousSilenceMs'>
): string | null {
  if (!normalizeVoicePhrase(config.wakeWord) || !normalizeVoicePhrase(config.endPhrase)) {
    return 'Bitte ein Wake-Word und ein Close-Word mit mindestens einem Buchstaben oder einer Zahl eingeben.'
  }
  if (
    config.wakeWord.trim().length > MAX_VOICE_PHRASE_CHARS ||
    config.endPhrase.trim().length > MAX_VOICE_PHRASE_CHARS
  ) {
    return `Wake-Word und Close-Word dürfen jeweils höchstens ${MAX_VOICE_PHRASE_CHARS} Zeichen enthalten.`
  }
  if (normalizeVoicePhrase(config.wakeWord) === normalizeVoicePhrase(config.endPhrase)) {
    return 'Wake-Word und Close-Word müssen sich unterscheiden.'
  }
  if (
    !Number.isFinite(config.continuousSilenceMs) ||
    config.continuousSilenceMs < 1000 ||
    config.continuousSilenceMs > 30_000
  ) {
    return 'Die Stille bis zum Diktatabschluss muss zwischen 1 und 30 Sekunden liegen.'
  }
  return null
}

export function voiceSettingsToStore(config: ResolvedVoiceSettings) {
  return {
    voice_mode: config.mode,
    voice_wake_word: config.wakeWord,
    voice_end_phrase: config.endPhrase,
    voice_local_stt_language: config.localSttLanguage,
    voice_continuous_silence_ms: config.continuousSilenceMs,
    voice_auto_submit: config.autoSubmit,
    voice_end_mode: config.endMode ?? 'either',
  }
}
export type VoiceRuntimeStatus = {
  state: 'ready' | 'missing' | 'incomplete' | 'error'
  version: string | null
  stt_ready: boolean
  tts_ready: boolean
  error: string | null
}

let installPromise: Promise<VoiceRuntimeStatus> | null = null

function reportVoiceEvent(level: 'warn' | 'error', event: string, detail: unknown): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('luczor:debug', { detail: { level, event, detail } }))
}

export async function getVoiceConfig(): Promise<ResolvedVoiceSettings> {
  const settings = await voiceInputStore('luczor.settings.json')
  const [voiceMode, wakeWord, triggerPhrase, endPhrase, language, silence, autoSubmit, legacyStrategy] =
    await Promise.all([
      settings.get('voice_mode'),
      settings.get('voice_wake_word'),
      settings.get('voice_trigger_phrase'),
      settings.get('voice_end_phrase'),
      settings.get('voice_local_stt_language'),
      settings.get('voice_continuous_silence_ms'),
      settings.get('voice_auto_submit'),
      settings.get('hands_free_strategy'),
    ])
  return resolveVoiceSettings({
    voice_mode: voiceMode,
    voice_wake_word: wakeWord,
    voice_trigger_phrase: triggerPhrase,
    voice_end_phrase: endPhrase,
    voice_local_stt_language: language,
    voice_continuous_silence_ms: silence,
    voice_auto_submit: autoSubmit,
    hands_free_strategy: legacyStrategy,
    voice_end_mode: await settings.get('voice_end_mode'),
  })
}

export type HandsFreeStrategyConfig = {
  endMode?: VoiceEndMode
  strategy: 'continuous' | 'safeword'
  triggerPhrase: string
  endPhrase: string
  continuousSilenceMs: number
  autoSubmit: boolean
}

/** Derive hands-free behavior from the exact visible voice snapshot held by the caller. */
export function handsFreeFromVoice(config: ResolvedVoiceSettings): HandsFreeStrategyConfig {
  const error = validateVoiceSettings(config)
  if (error) throw new Error(error)
  return {
    strategy: config.mode === 'continuous' ? 'continuous' : 'safeword',
    triggerPhrase: config.wakeWord,
    endPhrase: config.endPhrase,
    continuousSilenceMs: config.continuousSilenceMs,
    autoSubmit: config.autoSubmit,
    endMode: config.endMode ?? 'either',
  }
}

export async function saveVoiceConfig(config: ResolvedVoiceSettings): Promise<void> {
  const error = validateVoiceSettings(config)
  if (error) throw new Error(error)
  const settings = await voiceInputStore('luczor.settings.json')
  const values = voiceSettingsToStore(resolveVoiceSettings(voiceSettingsToStore(config)))
  for (const [key, value] of Object.entries(values)) await settings.set(key, value)
  await settings.save()
  window.dispatchEvent(new Event('luczor:voice-settings-changed'))
}

export async function getHandsFreeConfig(): Promise<HandsFreeStrategyConfig> {
  return handsFreeFromVoice(await getVoiceConfig())
}

function parseVoiceError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  try {
    const parsed = JSON.parse(raw) as { code?: string; message?: string }
    if (parsed?.message) return Object.assign(new Error(parsed.message), { code: parsed.code })
  } catch {
    // Tauri can wrap command errors; keep its original message when not structured.
  }
  return new Error(raw)
}

export async function voiceRuntimeStatus(): Promise<VoiceRuntimeStatus> {
  try {
    return await invoke<VoiceRuntimeStatus>(isMiniVoice() ? 'voice_input_status' : 'voice_runtime_status')
  } catch (error) {
    throw parseVoiceError(error)
  }
}

/** STT readiness is independent of local Piper; explicit localTts callers can request TTS. */
export async function ensureVoiceRuntime(capability: 'stt' | 'tts' = 'stt'): Promise<VoiceRuntimeStatus> {
  const existing = await voiceRuntimeStatus()
  const ready = (status: VoiceRuntimeStatus) => (capability === 'tts' ? status.tts_ready : status.stt_ready)
  if (ready(existing)) return existing
  if (isMiniVoice())
    throw new Error(
      'Lokale Spracherkennung fehlt. Bitte einmal im Hauptfenster die Spracheingabe starten, um sie vorzubereiten.'
    )
  installPromise ??= (async () => {
    try {
      const manifest = await LuczorApi.voiceManifest()
      return await invoke<VoiceRuntimeStatus>('install_voice_runtime', { payload: manifest })
    } catch (error) {
      const parsed = parseVoiceError(error)
      reportVoiceEvent('error', 'voice_runtime_install_failed', {
        message: parsed.message,
        code: (parsed as Error & { code?: string }).code,
      })
      throw parsed
    } finally {
      installPromise = null
    }
  })()
  const installed = await installPromise
  if (!ready(installed)) {
    throw new Error(
      capability === 'tts'
        ? 'Die lokale Sprachausgabe ist nicht bereit.'
        : 'Die lokale Spracherkennung ist nicht bereit.'
    )
  }
  return installed
}

export type SttEngine = 'whisper_local' | 'whisper_rs'

/** Admin-selectable STT engine (server default synced into the local store). */
export async function getSttEngine(): Promise<SttEngine> {
  const settings = await Store.load('luczor.settings.json')
  const value = (await settings.get<string>('voice_stt_engine')) ?? 'whisper_local'
  return value === 'whisper_rs' ? 'whisper_rs' : 'whisper_local'
}

export async function localStt(base64: string, language?: string): Promise<string> {
  await ensureVoiceRuntime()
  if (isMiniVoice()) {
    const result = await invoke<{ text: string }>('voice_input_stt', {
      payload: { base64, language: language ?? 'de' },
    })
    return cleanSttTranscript(result.text)
  }
  const engine = await getSttEngine()
  const language_ = language ?? 'de'
  const run = async (command: string): Promise<string> => {
    const response = await invoke<{ text: string }>(command, { payload: { base64, language: language_ } })
    return cleanSttTranscript(response?.text)
  }

  try {
    if (engine === 'whisper_rs') {
      try {
        return await run('local_stt_rs')
      } catch (error) {
        const parsed = parseVoiceError(error)
        // Build without whisper-rs -> transparently fall back to whisper.cpp.
        if ((parsed as Error & { code?: string }).code === 'whisper_rs_not_built') {
          reportVoiceEvent('warn', 'whisper_rs_fallback', { message: parsed.message })
          return await run('local_stt')
        }
        throw parsed
      }
    }
    return await run('local_stt')
  } catch (error) {
    const parsed = parseVoiceError(error)
    reportVoiceEvent('error', 'local_stt_failed', {
      message: parsed.message,
      code: (parsed as Error & { code?: string }).code,
    })
    throw parsed
  }
}

export async function localTts(text: string): Promise<{ base64: string; mime: string }> {
  await ensureVoiceRuntime('tts')
  try {
    return await invoke<{ base64: string; mime: string }>('local_tts', { payload: { text } })
  } catch (error) {
    const parsed = parseVoiceError(error)
    reportVoiceEvent('error', 'local_tts_failed', {
      message: parsed.message,
      code: (parsed as Error & { code?: string }).code,
    })
    throw parsed
  }
}
