import { LuczorApi } from '@/services/api/luczorApi'

export type SpeechVoice = { id: string; name: string; provider: 'piper' | 'pocket'; language: string }
export const validSpeechVoiceId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id)

export function parseSpeechVoices(payload: unknown): SpeechVoice[] {
  const voices = (payload as { voices?: unknown } | null)?.voices
  if (!Array.isArray(voices) || voices.length > 100)
    throw new Error('Der Server hat keinen gültigen Stimmenkatalog geliefert.')
  const result: SpeechVoice[] = []
  const seen = new Set<string>()
  for (const value of voices) {
    const voice = value as Partial<SpeechVoice> | null
    if (
      !voice ||
      typeof voice.id !== 'string' ||
      !validSpeechVoiceId(voice.id) ||
      seen.has(voice.id) ||
      typeof voice.name !== 'string' ||
      !voice.name.trim() ||
      voice.name.length > 120 ||
      !['piper', 'pocket'].includes(voice.provider ?? '') ||
      voice.language !== 'de'
    )
      throw new Error('Der Server hat keinen gültigen Stimmenkatalog geliefert.')
    seen.add(voice.id)
    result.push({ id: voice.id, name: voice.name, provider: voice.provider!, language: voice.language })
  }
  return result
}

export async function loadSpeechVoices(signal?: AbortSignal): Promise<SpeechVoice[]> {
  return parseSpeechVoices(await LuczorApi.speechVoices(signal))
}
