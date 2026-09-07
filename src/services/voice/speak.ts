import { getApiConfigSnapshot, LuczorApiError } from '@/services/api/luczorApi'
import { setStatus } from '@/state/hud'
import { MAX_TTS_TEXT_CHARS, serverTts, speechAbortError } from './serverTts'
import { beginReadAlong, endReadAlong, sentenceSpeechPosition, updateReadAlong } from './readAlong'

type SpeechSession = { controller: AbortController; stopAudio?: () => void; readAlongOwner: number }
let active: SpeechSession | null = null
let suspensionDepth = 0

function current(session: SpeechSession): boolean {
  return active === session && !session.controller.signal.aborted
}

/** Split long unpunctuated output too; every request stays within the server contract. */
export function splitSentences(text: string): string[] {
  const sentences = text
    .replace(/\s+/gu, ' ')
    .trim()
    .split(/(?<=[.!?:])\s+/u)
  const result: string[] = []
  for (const sentence of sentences) {
    let rest = sentence
    while (rest.length > MAX_TTS_TEXT_CHARS) {
      const space = rest.lastIndexOf(' ', MAX_TTS_TEXT_CHARS)
      let end = space > 0 ? space : MAX_TTS_TEXT_CHARS
      // Avoid cutting a Unicode surrogate pair in long text without spaces.
      const previous = rest.charCodeAt(end - 1)
      if (previous >= 0xd800 && previous <= 0xdbff) end--
      result.push(rest.slice(0, end))
      rest = rest.slice(end).trimStart()
    }
    if (rest) result.push(rest)
  }
  return result
}

function play(
  clip: Blob,
  volume: number,
  session: SpeechSession,
  start: number,
  length: number,
  playbackRate = 1
): Promise<void> {
  if (!current(session)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const source = URL.createObjectURL(clip)
    let audio: HTMLAudioElement
    try {
      audio = new Audio(source)
    } catch {
      URL.revokeObjectURL(source)
      reject(new Error('Audio-Wiedergabe konnte nicht gestartet werden.'))
      return
    }
    audio.volume = volume
    audio.playbackRate = playbackRate
    let settled = false
    let frame: number | undefined
    let playing = false
    const updatePosition = () => {
      if (current(session) && playing)
        updateReadAlong(
          session.readAlongOwner,
          'playing',
          sentenceSpeechPosition(start, length, audio.currentTime, audio.duration)
        )
    }
    const tick = () => {
      frame = undefined
      if (settled || !playing || !current(session)) return
      updatePosition()
      if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(tick)
    }
    const stopFrames = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      audio.onended = null
      audio.onerror = null
      audio.onplaying = null
      audio.onwaiting = null
      audio.onpause = null
      audio.ontimeupdate = null
      audio.ondurationchange = null
      playing = false
      stopFrames()
      session.stopAudio = undefined
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      URL.revokeObjectURL(source)
      if (error) reject(error)
      else resolve()
    }
    session.stopAudio = () => finish()
    audio.onended = () => finish()
    audio.onerror = () => finish(new Error('Audio-Wiedergabe fehlgeschlagen.'))
    audio.onplaying = () => {
      if (current(session)) {
        setStatus('speaking')
        playing = true
        stopFrames()
        tick()
      }
    }
    audio.onwaiting = () => {
      playing = false
      stopFrames()
      if (current(session)) {
        setStatus('thinking')
        updateReadAlong(session.readAlongOwner, 'waiting')
      }
    }
    audio.onpause = () => {
      if (!settled) audio.onwaiting?.(new Event('waiting'))
    }
    audio.ontimeupdate = updatePosition
    audio.ondurationchange = updatePosition
    try {
      void audio.play().catch(() => finish(new Error('Audio-Wiedergabe konnte nicht gestartet werden.')))
    } catch {
      finish(new Error('Audio-Wiedergabe konnte nicht gestartet werden.'))
    }
  })
}

function cancelSession(session: SpeechSession | null): void {
  session?.controller.abort()
  session?.stopAudio?.()
  if (session) endReadAlong(session.readAlongOwner)
}

export type SpeakOptions = { rate?: number; volume?: number; signal?: AbortSignal; key?: string; voiceId?: string }
export type SpeakResult = 'completed' | 'cancelled'

/** Server TTS with one prefetched sentence and a single cancellable playback owner. */
export async function streamSpeak(text: string, opts: SpeakOptions = {}): Promise<SpeakResult> {
  if (suspensionDepth > 0) {
    throw new LuczorApiError(0, 'Die Server-Einstellungen werden gespeichert. Bitte danach erneut sprechen lassen.')
  }
  const sentences = splitSentences(text ?? '')
  if (opts.signal?.aborted) return 'cancelled'
  if (!sentences.length) return 'completed'
  cancelSession(active)
  const session: SpeechSession = {
    controller: new AbortController(),
    readAlongOwner: beginReadAlong(opts.key ?? '', sentences.join(' ')),
  }
  active = session
  setStatus('thinking')
  const rate = Number.isFinite(opts.rate) ? Math.max(0.5, Math.min(2, opts.rate!)) : 1
  const volume = Number.isFinite(opts.volume) ? Math.max(0, Math.min(1, opts.volume!)) : 0.9
  const voiceId = opts.voiceId?.trim()
  const v2 = !!voiceId && voiceId !== 'piper'
  let rejectCancellation: (error: Error) => void = () => undefined
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })
  const abort = () => rejectCancellation(speechAbortError())
  session.controller.signal.addEventListener('abort', abort, { once: true })
  const callerAbort = () => {
    if (active === session) stopSpeak()
  }
  opts.signal?.addEventListener('abort', callerAbort, { once: true })
  // Keep cancellation observed even if the final abort only cleans up a prefetch.
  void cancellation.catch(() => undefined)
  try {
    const config = Object.freeze({ ...(await Promise.race([getApiConfigSnapshot(), cancellation])) })
    if (!current(session)) return 'cancelled'
    const synth = (sentence: string) =>
      serverTts(sentence, config, {
        speed: v2 ? 1 : rate,
        signal: session.controller.signal,
        ...(voiceId ? { voiceId } : {}),
      }).then(
        clip => ({ clip, error: null }),
        (error: unknown) => ({ clip: null, error })
      )
    const iterator = sentences[Symbol.iterator]()
    let nextSentence = iterator.next()
    let pending = synth(nextSentence.value!)
    let sentenceStart = 0
    while (!nextSentence.done && current(session)) {
      setStatus('thinking')
      updateReadAlong(session.readAlongOwner, 'preparing', sentenceStart)
      const result = await Promise.race([pending, cancellation])
      if (!current(session)) return 'cancelled'
      if (!result.clip) throw result.error
      const sentenceLength = nextSentence.value.length
      nextSentence = iterator.next()
      // Attach both handlers immediately: a failed prefetch can never escape as an unhandled rejection.
      if (!nextSentence.done) pending = synth(nextSentence.value)
      await play(result.clip, volume, session, sentenceStart, sentenceLength, v2 ? rate : 1)
      sentenceStart += sentenceLength + 1
    }
    return current(session) ? 'completed' : 'cancelled'
  } catch (error) {
    if (!current(session)) return 'cancelled'
    const safeError =
      error instanceof LuczorApiError || (error instanceof Error && error.message.startsWith('Audio-Wiedergabe'))
        ? error
        : new Error('Server-Sprachausgabe fehlgeschlagen. Bitte die Server-Einstellungen prüfen.')
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('luczor:debug', {
          detail: { level: 'error', event: 'server_tts_playback_failed', detail: { message: safeError.message } },
        })
      )
    }
    throw safeError
  } finally {
    const wasCurrent = current(session)
    session.controller.signal.removeEventListener('abort', abort)
    opts.signal?.removeEventListener('abort', callerAbort)
    cancelSession(session)
    if (wasCurrent) {
      active = null
      setStatus('idle')
    }
  }
}

export function stopSpeak(): void {
  cancelSession(active)
  active = null
  setStatus('idle')
}

/** Block new snapshots during an API identity update that writes URL and key separately. */
export function suspendSpeech(): () => void {
  suspensionDepth++
  stopSpeak()
  let resumed = false
  return () => {
    if (resumed) return
    resumed = true
    suspensionDepth--
  }
}
