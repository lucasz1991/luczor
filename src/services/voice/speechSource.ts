import { speechAbortError } from './serverTts'

/** A clip is a paragraph/sentence group, never an individual highlighted word. */
export const SPEECH_CHUNK_TARGET = 700
export const SPEECH_CHUNK_LIMIT = 1000

export type SpeechPart = { text: string; start: number }
export type SpeechSource = {
  snapshot: () => { text: string; key: string }
  next: (signal: AbortSignal) => Promise<SpeechPart | null>
  subscribe: (listener: () => void) => () => void
  readonly cancelled: boolean
}

/** Blank lines inside fenced code do not finish a paragraph. */
function paragraphEnds(text: string): number[] {
  const ends: number[] = []
  let fence = ''
  let hasContent = false
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/gu)) {
    const line = match[0]
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1] ?? ''
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''
    }
    if (line.trim()) hasContent = true
    else if (!fence && hasContent && line.endsWith('\n')) {
      ends.push(match.index + line.length)
      hasContent = false
    }
  }
  return ends
}

function sentenceEnd(text: string, limit: number): number {
  let end = 0
  for (const match of text.slice(0, limit + 1).matchAll(/[.!?…](?:[”"')\]]*)\s+/gu)) {
    end = match.index + match[0].length
  }
  return Math.min(limit, end)
}

/** Short answers stay fluent; long answers start without a 4000-character request. */
export function speechChunkEnd(text: string): number {
  if (text.length <= SPEECH_CHUNK_TARGET) return text.length
  const paragraphs = paragraphEnds(text).filter(end => end <= SPEECH_CHUNK_LIMIT)
  const preferred = paragraphs.find(end => end >= 240 && end >= SPEECH_CHUNK_TARGET / 2)
  if (preferred) return preferred
  const sentence = sentenceEnd(text, SPEECH_CHUNK_TARGET)
  if (sentence >= 240) return sentence
  if (text.length <= SPEECH_CHUNK_LIMIT) return text.length
  const whitespace = [...text.slice(0, SPEECH_CHUNK_TARGET).matchAll(/\s+/gu)].at(-1)
  let end = whitespace && whitespace.index > 0 ? whitespace.index + whitespace[0].length : SPEECH_CHUNK_TARGET
  if (/[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--
  return end
}

/** One transient, append-only public answer round. No audio or source text is persisted. */
export function createSpeechSource(initialText = '', options: { complete?: boolean; key?: string } = {}) {
  let text = initialText
  let key = options.key ?? ''
  let complete = options.complete === true
  let cancelled = false
  let cursor = 0
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach(listener => listener())

  function availableEnd(): number {
    if (cancelled) return 0
    if (complete) return text.length
    const rest = text.slice(cursor)
    const ends = paragraphEnds(rest)
    // Start after two complete paragraphs. Later batches also avoid tiny fragments.
    if (ends.length >= 2 || (cursor > 0 && (ends[0] ?? 0) >= 240)) return cursor + ends.at(-1)!
    // A long answer without paragraph breaks must not wait for its final token.
    if (rest.length > SPEECH_CHUNK_LIMIT && !/^\s*(`{3,}|~{3,})/mu.test(rest)) {
      const end = sentenceEnd(rest, SPEECH_CHUNK_TARGET)
      if (end >= 240) return cursor + end
    }
    return cursor
  }

  const source = {
    snapshot: () => ({ text, key }),
    get cancelled() {
      return cancelled
    },
    get ready() {
      return availableEnd() > cursor && !!text.slice(cursor, availableEnd()).trim()
    },
    get started() {
      return cursor > 0
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(nextText: string, done = false, nextKey = key): void {
      if (cancelled || complete) return
      // Rewritten committed text belongs to a different round; never replay it as an append.
      if (nextText.slice(0, cursor) !== text.slice(0, cursor)) {
        source.cancel()
        return
      }
      text = nextText
      key = nextKey
      complete = done
      notify()
    },
    cancel(): void {
      cancelled = true
      notify()
    },
    async next(signal: AbortSignal): Promise<SpeechPart | null> {
      while (!cancelled) {
        if (signal.aborted) throw speechAbortError()
        const end = availableEnd()
        if (end > cursor) {
          const rest = text.slice(cursor, end)
          const length = speechChunkEnd(rest)
          const start = cursor
          cursor += length
          if (rest.slice(0, length).trim()) return { text: rest.slice(0, length), start }
          continue
        }
        if (complete) return null
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            listeners.delete(wake)
            signal.removeEventListener('abort', abort)
          }
          const wake = () => {
            cleanup()
            resolve()
          }
          const abort = () => {
            cleanup()
            reject(speechAbortError())
          }
          listeners.add(wake)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
      }
      return null
    },
  }
  return source
}
