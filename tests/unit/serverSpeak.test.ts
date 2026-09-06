import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hud } from '@/state/hud'
import { getApiConfigSnapshot, LuczorApiError } from '@/services/api/luczorApi'
import { serverTts, MAX_TTS_TEXT_CHARS } from '@/services/voice/serverTts'
import { splitSentences, stopSpeak, streamSpeak, suspendSpeech } from '@/services/voice/speak'

vi.mock('@/services/api/luczorApi', async importOriginal => ({
  ...(await importOriginal<typeof import('@/services/api/luczorApi')>()),
  getApiConfigSnapshot: vi.fn(),
}))
vi.mock('@/services/voice/serverTts', async importOriginal => ({
  ...(await importOriginal<typeof import('@/services/voice/serverTts')>()),
  serverTts: vi.fn(),
}))

const config = { baseUrl: 'https://luczor.example.test', deviceKey: 'device-key', clientId: 'first' }
const clip = new Blob(['RIFF0000WAVE'], { type: 'audio/wav' })
const synth = vi.mocked(serverTts)
const snapshot = vi.mocked(getApiConfigSnapshot)

class AudioMock {
  static instances: AudioMock[] = []
  volume = 1
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  onplaying: (() => void) | null = null
  onwaiting: (() => void) | null = null
  play = vi.fn(async () => undefined)
  pause = vi.fn()
  removeAttribute = vi.fn()
  load = vi.fn()
  constructor(public src: string) {
    AudioMock.instances.push(this)
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

describe('server speech sessions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    AudioMock.instances = []
    snapshot.mockResolvedValue({ ...config })
    synth.mockResolvedValue(clip)
    vi.stubGlobal('Audio', AudioMock)
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${AudioMock.instances.length}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    hud.status = 'idle'
  })

  afterEach(() => {
    stopSpeak()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('announces speaking only when audio is actually playing and revokes audio on completion', async () => {
    const speech = streamSpeak('Hallo Welt!', { rate: 1.5, volume: 0.4 })
    await flush()
    const audio = AudioMock.instances[0]!
    expect(hud.status).toBe('thinking')
    expect(audio.volume).toBe(0.4)
    expect(synth).toHaveBeenCalledWith('Hallo Welt!', config, expect.objectContaining({ speed: 1.5 }))
    audio.onplaying?.()
    expect(hud.status).toBe('speaking')
    audio.onended?.()
    await expect(speech).resolves.toBe('completed')
    expect(hud.status).toBe('idle')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(audio.src)
    expect(audio.removeAttribute).toHaveBeenCalledWith('src')
  })

  it('cancels before configuration loading completes and never sends the late text', async () => {
    const pendingConfig = deferred<typeof config>()
    snapshot.mockReturnValue(pendingConfig.promise)
    const speech = streamSpeak('Bitte nicht senden.')
    stopSpeak()
    await expect(speech).resolves.toBe('cancelled')
    pendingConfig.resolve(config)
    await flush()
    expect(synth).not.toHaveBeenCalled()
    expect(AudioMock.instances).toHaveLength(0)
  })

  it('aborts synthesis and prevents playback when an ignored request resolves after stop', async () => {
    const pendingClip = deferred<Blob>()
    synth.mockReturnValue(pendingClip.promise)
    const speech = streamSpeak('Bitte abbrechen.')
    await flush()
    const signal = synth.mock.calls[0]![2]!.signal!
    stopSpeak()
    await expect(speech).resolves.toBe('cancelled')
    expect(signal.aborted).toBe(true)
    pendingClip.resolve(clip)
    await flush()
    expect(AudioMock.instances).toHaveLength(0)
  })

  it('supersedes an older pending session without resetting the current playback status', async () => {
    const firstClip = deferred<Blob>()
    synth.mockReturnValueOnce(firstClip.promise)
    const first = streamSpeak('Erste Ausgabe.')
    await flush()
    const second = streamSpeak('Zweite Ausgabe.')
    await flush()
    const audio = AudioMock.instances[0]!
    audio.onplaying?.()
    firstClip.resolve(clip)
    await first
    expect(hud.status).toBe('speaking')
    expect(AudioMock.instances).toHaveLength(1)
    audio.onended?.()
    await second
  })

  it('stops prior playback before starting another session and revokes both URLs', async () => {
    const first = streamSpeak('Erste Ausgabe.')
    await flush()
    const oldAudio = AudioMock.instances[0]!
    const second = streamSpeak('Zweite Ausgabe.')
    expect(oldAudio.pause).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldAudio.src)
    await flush()
    expect(AudioMock.instances).toHaveLength(2)
    stopSpeak()
    await Promise.all([first, second])
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(hud.status).toBe('idle')
  })

  it('prefetches only one sentence while playing and freezes the API identity for the full utterance', async () => {
    const mutableConfig = { ...config }
    snapshot.mockResolvedValue(mutableConfig)
    const speech = streamSpeak('Erster Satz. Zweiter Satz. Dritter Satz.')
    await flush()
    expect(synth).toHaveBeenCalledTimes(2)
    expect(snapshot).toHaveBeenCalledOnce()
    expect(Object.isFrozen(synth.mock.calls[0]![1])).toBe(true)
    mutableConfig.deviceKey = 'different-key'
    mutableConfig.baseUrl = 'https://changed.example.test'
    AudioMock.instances[0]!.onended?.()
    await flush()
    expect(synth).toHaveBeenCalledTimes(3)
    expect(synth.mock.calls[2]![1]).toEqual(config)
    AudioMock.instances[1]!.onended?.()
    await flush()
    AudioMock.instances[2]!.onended?.()
    await speech
  })

  it('observes a rejected prefetch immediately and surfaces it only after the current clip', async () => {
    synth.mockResolvedValueOnce(clip).mockRejectedValueOnce(new LuczorApiError(503, 'Sprachdienst nicht verfügbar.'))
    const outcome = streamSpeak('Erster Satz. Zweiter Satz.').catch((error: unknown) => error)
    await flush()
    expect(AudioMock.instances).toHaveLength(1)
    AudioMock.instances[0]!.onended?.()
    await expect(outcome).resolves.toMatchObject({ status: 503 })
    expect(AudioMock.instances).toHaveLength(1)
    expect(hud.status).toBe('idle')
  })

  it('cancels prefetch and audio together on explicit stop', async () => {
    const pendingClip = deferred<Blob>()
    synth.mockResolvedValueOnce(clip).mockReturnValueOnce(pendingClip.promise)
    const speech = streamSpeak('Erster Satz. Zweiter Satz.')
    await flush()
    const signal = synth.mock.calls[1]![2]!.signal!
    const audio = AudioMock.instances[0]!
    stopSpeak()
    pendingClip.reject(new Error('request cancelled'))
    await speech
    expect(signal.aborted).toBe(true)
    expect(audio.pause).toHaveBeenCalledOnce()
    expect(audio.onplaying).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
  })

  it('cleans up playback failures and cancels any prefetched audio', async () => {
    const outcome = streamSpeak('Erster Satz. Zweiter Satz.').catch((error: unknown) => error)
    await flush()
    AudioMock.instances[0]!.onerror?.()
    await expect(outcome).resolves.toMatchObject({ message: 'Audio-Wiedergabe fehlgeschlagen.' })
    expect(synth.mock.calls[1]![2]!.signal!.aborted).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
  })

  it('lets a caller cancel only its own session', async () => {
    const caller = new AbortController()
    const first = streamSpeak('Sprachtest.', { signal: caller.signal })
    await flush()
    const second = streamSpeak('Eine neue Ausgabe.')
    await flush()
    caller.abort()
    const audio = AudioMock.instances[1]!
    expect(audio.pause).not.toHaveBeenCalled()
    audio.onended?.()
    await Promise.all([first, second])
  })

  it('splits long punctuation-free output at the server limit without losing Unicode characters', () => {
    const text = 'a'.repeat(MAX_TTS_TEXT_CHARS - 1) + '😀' + 'b'.repeat(MAX_TTS_TEXT_CHARS + 5)
    const parts = splitSentences(text)
    expect(parts.every(part => part.length <= MAX_TTS_TEXT_CHARS)).toBe(true)
    expect(parts.join('')).toBe(text)
    expect(parts[0]).toHaveLength(MAX_TTS_TEXT_CHARS - 1)
    expect(splitSentences('   ')).toEqual([])
  })

  it('bounds long multiword sentences and does not send empty requests', () => {
    const parts = splitSentences('Wort '.repeat(2100))
    expect(parts.every(part => part.length > 0 && part.length <= MAX_TTS_TEXT_CHARS)).toBe(true)
    expect(parts.join(' ')).toBe('Wort '.repeat(2100).trim())
  })

  it('blocks new snapshots until all identity writes finish and resumes idempotently', async () => {
    const firstResume = suspendSpeech()
    const secondResume = suspendSpeech()
    try {
      await expect(streamSpeak('Noch nicht senden.')).rejects.toThrow('Server-Einstellungen werden gespeichert')
      firstResume()
      firstResume()
      await expect(streamSpeak('Noch nicht senden.')).rejects.toThrow('Server-Einstellungen werden gespeichert')
      expect(snapshot).not.toHaveBeenCalled()
    } finally {
      firstResume()
      secondResume()
    }
    const speech = streamSpeak('Jetzt senden.')
    await flush()
    AudioMock.instances[0]!.onended?.()
    await expect(speech).resolves.toBe('completed')
    expect(snapshot).toHaveBeenCalledOnce()
  })
})
