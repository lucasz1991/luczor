import type { Message } from '@/state/types'
import { serverSpeechText } from './messageSpeech'

type SpeechMessage = Pick<Message, 'content' | 'meta'>

export type CommentarySpeechContext = {
  /** A unique turn identity; the owner also checks its active project and account. */
  scope: string
  key: string
  kind: 'status' | 'message'
}

export type CommentarySpeechResult = 'completed' | 'cancelled' | 'skipped' | 'failed'

type SpeechEntry = CommentarySpeechContext & {
  readText: (allowLocalContent: boolean) => string
  resolve: (result: CommentarySpeechResult) => void
}

type CommentarySpeechOptions = {
  speak: (text: string, options: { signal: AbortSignal; key: string }) => Promise<'completed' | 'cancelled'>
  /** Re-read automatic speech settings before each entry, rather than caching them per turn. */
  canSpeak: (context: CommentarySpeechContext) => boolean | Promise<boolean>
  isCurrent: (scope: string) => boolean
  /** Explicit, separately revocable consent for speech only; never changes message storage classification. */
  allowLocalContent?: () => boolean | Promise<boolean>
  onBlocked?: (context: CommentarySpeechContext) => void
  onError?: (error: unknown, context: CommentarySpeechContext) => void
}

const MAX_REMEMBERED_ENTRIES = 1024

function remember(set: Set<string>, value: string): void {
  set.add(value)
  if (set.size > MAX_REMEMBERED_ENTRIES) set.delete(set.values().next().value!)
}

/** A cancelled settings read must not hold up the next turn if its store never settles. */
async function enabledUnlessCancelled(read: () => boolean | Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  let abort!: () => void
  const cancelled = new Promise<boolean>(resolve => {
    abort = () => resolve(false)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve().then(read), cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/**
 * One FIFO for public activity labels, classified comments and the final answer.
 * Generated text is read again immediately before playback and uses the same
 * server-egress guard as manual speech. Raw stream chunks never enter this queue.
 */
export function createCommentarySpeechQueue(options: CommentarySpeechOptions) {
  const pending: SpeechEntry[] = []
  const keys = new Set<string>()
  const spokenText = new Set<string>()
  let generation = 0
  let running: Promise<void> | null = null
  let active: { entry: SpeechEntry; controller: AbortController } | null = null

  async function play(entry: SpeechEntry): Promise<CommentarySpeechResult> {
    const ownGeneration = generation
    const controller = new AbortController()
    active = { entry, controller }
    const current = () => ownGeneration === generation && !controller.signal.aborted && options.isCurrent(entry.scope)
    const context: CommentarySpeechContext = { scope: entry.scope, key: entry.key, kind: entry.kind }
    try {
      if (!current()) return 'cancelled'
      const enabled = await enabledUnlessCancelled(() => options.canSpeak(context), controller.signal)
      if (!current()) return 'cancelled'
      if (!enabled) return 'skipped'

      const allowLocalContent =
        entry.kind === 'message' && options.allowLocalContent
          ? await enabledUnlessCancelled(options.allowLocalContent, controller.signal)
          : false
      if (!current()) return 'cancelled'
      const text = entry.readText(allowLocalContent).replace(/\s+/gu, ' ').trim()
      if (!text && entry.kind === 'message' && entry.readText(true)) options.onBlocked?.(context)
      if (!text || text.startsWith('[Fehler]')) return 'skipped'
      const textKey = JSON.stringify([entry.scope, text])
      if (spokenText.has(textKey)) return 'skipped'
      remember(spokenText, textKey)

      // Await the actual speaker even after abort so a new entry cannot overlap
      // with an audio implementation that takes time to release its owner.
      const result = await options.speak(text, { signal: controller.signal, key: entry.key })
      return current() ? result : 'cancelled'
    } catch (error) {
      if (!current()) return 'cancelled'
      try {
        options.onError?.(error, context)
      } catch {
        // Reporting must not discard the remaining comments or the final answer.
      }
      return 'failed'
    } finally {
      if (active?.controller === controller) active = null
    }
  }

  function start(): void {
    if (running) return
    running = (async () => {
      while (pending.length) {
        const entry = pending.shift()!
        entry.resolve(await play(entry))
      }
    })().finally(() => {
      running = null
      if (pending.length) start()
    })
  }

  function enqueue(
    context: CommentarySpeechContext,
    readText: SpeechEntry['readText']
  ): Promise<CommentarySpeechResult> {
    const key = JSON.stringify([context.scope, context.key])
    if (keys.has(key)) return Promise.resolve('skipped')
    remember(keys, key)
    const result = new Promise<CommentarySpeechResult>(resolve => {
      pending.push({ ...context, readText, resolve })
    })
    start()
    return result
  }

  return {
    /** Only use for fixed application labels, never model text or tool arguments/results. */
    enqueueStatus(entry: { scope: string; key: string; text: string }) {
      return enqueue({ scope: entry.scope, key: entry.key, kind: 'status' }, () => entry.text)
    },
    enqueueMessage(entry: { scope: string; key: string; readMessage: () => SpeechMessage | null | undefined }) {
      return enqueue({ scope: entry.scope, key: entry.key, kind: 'message' }, allowLocalContent =>
        serverSpeechText(entry.readMessage(), { allowLocalContent })
      )
    },
    cancel(): void {
      generation++
      active?.controller.abort()
      active?.entry.resolve('cancelled')
      for (const entry of pending.splice(0)) entry.resolve('cancelled')
      keys.clear()
      spokenText.clear()
    },
    /** Waits for comments and any final answer already queued behind them. */
    async drain(): Promise<void> {
      while (running) await running
    },
  }
}
