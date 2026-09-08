import { getApiConfigSnapshot, LuczorApiError } from '@/services/api/luczorApi'
import { setStatus } from '@/state/hud'
import { serverTts, speechAbortError } from './serverTts'
import {
  beginReadAlong,
  endReadAlong,
  sentenceSpeechPosition,
  updateReadAlong,
  updateReadAlongSource,
} from './readAlong'
import { createSpeechSource, speechChunkEnd, type SpeechSource } from './speechSource'
import { prepareSpokenText } from './spokenText'

type SpeechSession = { controller: AbortController; stopAudio?: () => void; readAlongOwner: number }
let active: SpeechSession | null = null
let suspensionDepth = 0

function current(session: SpeechSession): boolean {
  return active === session && !session.controller.signal.aborted
}

/** Group sentences/paragraphs into fluent clips with a bounded preparation time. */
export function splitSentences(text: string): string[] {
  const result: string[] = []
  let rest = text.trim()
  while (rest) {
    const end = speechChunkEnd(rest)
    result.push(rest.slice(0, end).trim())
    rest = rest.slice(end).trimStart()
  }
  return result
}

function play(
  clip: Blob,
  volume: number,
  session: SpeechSession,
  sourcePositions: number[],
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
          sourcePositions[sentenceSpeechPosition(0, sourcePositions.length - 1, audio.currentTime, audio.duration)]
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

export type SpeakOptions = {
  rate?: number
  volume?: number
  signal?: AbortSignal
  key?: string
  voiceId?: string
  source?: SpeechSource
  /** Revalidate settings, scope and local-content consent before each request/playback. */
  beforeChunk?: () => boolean | Promise<boolean>
}
export type SpeakResult = 'completed' | 'cancelled'

/** One cancellable playback owner, continuous paragraph clips, at most one clip prefetched. */
export async function streamSpeak(text: string, opts: SpeakOptions = {}): Promise<SpeakResult> {
  if (suspensionDepth > 0) {
    throw new LuczorApiError(0, 'Die Server-Einstellungen werden gespeichert. Bitte danach erneut sprechen lassen.')
  }
  if (opts.signal?.aborted) return 'cancelled'
  if (!opts.source && !text?.trim()) return 'completed'
  const source = opts.source ?? createSpeechSource(text, { complete: true, key: opts.key })
  cancelSession(active)
  const session: SpeechSession = {
    controller: new AbortController(),
    readAlongOwner: beginReadAlong(source.snapshot().key, source.snapshot().text),
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
  const refreshSource = () => {
    if (source.cancelled) cancelSession(session)
    else updateReadAlongSource(session.readAlongOwner, source.snapshot().text, source.snapshot().key)
  }
  const unsubscribe = source.subscribe(refreshSource)
  // Keep cancellation observed even if the final abort only cleans up a prefetch.
  void cancellation.catch(() => undefined)
  try {
    const config = Object.freeze({ ...(await Promise.race([getApiConfigSnapshot(), cancellation])) })
    if (!current(session)) return 'cancelled'
    type Prepared = ReturnType<typeof prepareSpokenText>
    const pieces: Prepared[] = []
    let mappedSource = ''
    let mappedText: Prepared = { text: '', sourcePositions: [0] }
    const permitted = async () => {
      if (opts.beforeChunk && !(await Promise.race([opts.beforeChunk(), cancellation]))) {
        cancelSession(session)
        return false
      }
      return current(session)
    }
    const prepareNext = async () => {
      while (!pieces.length && current(session)) {
        const part = await source.next(session.controller.signal)
        if (!part) return null
        // Keep the surrounding Markdown context even when a long code block or
        // formatted sentence crosses a clip boundary. Only this part is sent.
        const sourceText = source.snapshot().text
        if (mappedSource !== sourceText) {
          mappedSource = sourceText
          mappedText = prepareSpokenText(sourceText)
        }
        const start = mappedText.sourcePositions.findIndex(position => position >= part.start)
        const end = mappedText.sourcePositions.findIndex(position => position >= part.start + part.text.length)
        const prepared: Prepared = {
          text: mappedText.text.slice(start, end),
          sourcePositions: mappedText.sourcePositions.slice(start, end + 1),
        }
        // Symbol expansion also respects the small clip limit, with its own source mapping.
        let offset = 0
        while (offset < prepared.text.length) {
          const length = speechChunkEnd(prepared.text.slice(offset))
          const raw = prepared.text.slice(offset, offset + length)
          const left = raw.length - raw.trimStart().length
          const right = raw.trimEnd().length
          if (right > left)
            pieces.push({
              text: raw.slice(left, right),
              sourcePositions: prepared.sourcePositions.slice(offset + left, offset + right + 1),
            })
          offset += length
        }
      }
      const part = pieces.shift()
      if (!part || !(await permitted())) return null
      const clip = await serverTts(part.text, config, {
        speed: v2 ? 1 : rate,
        signal: session.controller.signal,
        ...(voiceId ? { voiceId } : {}),
      })
      return { clip, sourcePositions: part.sourcePositions }
    }
    // Both outcomes are observed immediately, including a failed or cancelled prefetch.
    const next = () =>
      prepareNext().then(
        value => ({ value, error: null }),
        (error: unknown) => ({ value: null, error })
      )
    let pending = next()
    while (current(session)) {
      setStatus('thinking')
      updateReadAlong(session.readAlongOwner, 'preparing')
      const result = await Promise.race([pending, cancellation])
      if (!current(session)) return 'cancelled'
      if (result.error) throw result.error
      if (!result.value) break
      if (!(await permitted())) return 'cancelled'
      updateReadAlong(session.readAlongOwner, 'preparing', result.value.sourcePositions[0])
      pending = next()
      await play(result.value.clip, volume, session, result.value.sourcePositions, v2 ? rate : 1)
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
    const wasCurrent = active === session
    unsubscribe()
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
