import { invoke } from '@tauri-apps/api/core'
import { LuczorApi } from '@/services/api/luczorApi'
import { Store } from '@tauri-apps/plugin-store'
import { cleanSttTranscript } from './transcript'

export type VoiceMode = 'push_to_talk' | 'continuous' | 'wakeword'
export type VoiceConfig = { mode: VoiceMode; wakeWord: string; localSttLanguage: string }
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

export async function getVoiceConfig(): Promise<VoiceConfig> {
  const settings = await Store.load('luczor.settings.json')
  const storedMode = await settings.get<VoiceMode>('voice_mode')
  const mode =
    storedMode === 'continuous' || storedMode === 'wakeword' || storedMode === 'push_to_talk' ? storedMode : 'wakeword'
  return {
    mode,
    wakeWord: ((await settings.get<string>('voice_wake_word')) ?? 'luczor').trim().toLowerCase() || 'luczor',
    localSttLanguage: ((await settings.get<string>('voice_local_stt_language')) ?? 'de').trim().toLowerCase() || 'de',
  }
}

export type HandsFreeStrategyConfig = {
  strategy: 'continuous' | 'safeword'
  triggerPhrase: string
  endPhrase: string
  continuousSilenceMs: number
}

/** SOLL §5.3 — the hands-free dictation strategy chosen by the user (XOR). */
export async function getHandsFreeConfig(): Promise<HandsFreeStrategyConfig> {
  const settings = await Store.load('luczor.settings.json')
  const raw = await settings.get<string>('hands_free_strategy')
  const strategy = raw === 'continuous' ? 'continuous' : 'safeword'
  const silence = Number(await settings.get<number>('voice_continuous_silence_ms'))
  return {
    strategy,
    triggerPhrase: ((await settings.get<string>('voice_trigger_phrase')) ?? 'luczor start').trim(),
    endPhrase: ((await settings.get<string>('voice_end_phrase')) ?? 'luczor stopp').trim(),
    continuousSilenceMs: Number.isFinite(silence) && silence >= 1000 ? silence : 5000,
  }
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
    return await invoke<VoiceRuntimeStatus>('voice_runtime_status')
  } catch (error) {
    throw parseVoiceError(error)
  }
}

/** Downloads and verifies Whisper.cpp/Piper once per manifest version. No local paths are stored in settings. */
export async function ensureVoiceRuntime(): Promise<VoiceRuntimeStatus> {
  const existing = await voiceRuntimeStatus()
  if (existing.stt_ready && existing.tts_ready) return existing
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
  return installPromise
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
  await ensureVoiceRuntime()
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
