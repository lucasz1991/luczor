import type { ChatCommentary, Message } from '@/state/types'
import { commentaryForSpeech } from '@/services/chatCommentary'
import { createSpeechSource } from './speechSource'
import type { createCommentarySpeechQueue, CommentarySpeechResult } from './commentarySpeech'

type SpeechMessage = Pick<Message, 'content' | 'meta'>

/** Binds live public paragraphs to their retained comment/final answer, without reading them twice. */
export function createProgressiveCommentary(options: {
  scope: string
  answerKey: string
  queue: ReturnType<typeof createCommentarySpeechQueue>
  readMessage: () => SpeechMessage | undefined
}) {
  type Round = {
    source: ReturnType<typeof createSpeechSource>
    readMessage: () => SpeechMessage | undefined
    result?: Promise<CommentarySpeechResult>
  }
  let round: Round | null = null
  let serial = 0
  let cancelled = false
  const sources = new Set<ReturnType<typeof createSpeechSource>>()

  function update(): void {
    if (cancelled) return
    const message = options.readMessage()
    if (!message?.content || message.content.startsWith('[Fehler]')) return
    if (!round) {
      round = { source: createSpeechSource('', { key: options.answerKey }), readMessage: options.readMessage }
      sources.add(round.source)
    }
    round.source.update(message.content)
    if (!round.result && round.source.ready) {
      const own = round
      own.result = options.queue.enqueueMessage({
        scope: options.scope,
        key: `${options.answerKey}:stream-${++serial}`,
        source: own.source,
        readMessage: () => own.readMessage(),
      })
    }
  }

  function finish(key: string, readMessage: () => SpeechMessage | undefined): void {
    if (cancelled) return
    const own = round
    round = null
    const enqueueFinal = () => {
      if (!cancelled) return options.queue.enqueueMessage({ scope: options.scope, key, readMessage })
    }
    if (!own?.result) {
      if (own) sources.delete(own.source)
      void enqueueFinal()
      return
    }
    own.readMessage = readMessage
    const finalMessage = readMessage()
    const question = finalMessage?.meta?.question?.trim()
    const finalSource = (finalMessage?.content ?? '') + (question ? `\n\n${question}` : '')
    own.source.update(finalSource, true, key)
    // Queue this fallback synchronously behind the stream. Its privacy/settings
    // read happens there, and a consumed stream prefix can never be repeated.
    void options.queue.enqueueMessage({
      scope: options.scope,
      key,
      readMessage: () => (own.source.started || own.source.cancelled ? undefined : readMessage()),
    })
    void own.result.then(() => {
      sources.delete(own.source)
    })
  }

  return {
    update,
    resetCurrent() {
      if (!round) return
      const own = round
      round = null
      own.source.cancel()
      options.queue.cancelSource(own.source)
      sources.delete(own.source)
    },
    completeCommentary(entry: ChatCommentary) {
      const key = options.answerKey.replace(/:answer$/u, `:${entry.id}`)
      finish(key, () => commentaryForSpeech(entry))
    },
    completeAnswer() {
      finish(options.answerKey, options.readMessage)
    },
    cancel() {
      cancelled = true
      for (const source of sources) source.cancel()
      sources.clear()
      round = null
    },
  }
}
