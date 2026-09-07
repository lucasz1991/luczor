import type { ChatCommentary, Message } from '@/state/types'
import { presentEnvelopeStream } from '@/services/envelope'

/** A completed, public model round. It is retained independently of the next round. */
export function completedCommentary(
  round: { round: number; content: string; serverSpeechAllowed: boolean },
  now = Date.now()
): ChatCommentary | null {
  const shown = presentEnvelopeStream(round.content, true)
  const content = [shown.content, shown.question, ...shown.bullets.map(item => `- ${item}`)]
    .filter(Boolean)
    .join('\n\n')
    .trim()
  return content
    ? {
        id: `round-${round.round}`,
        round: round.round,
        content,
        createdAt: now,
        serverSpeechAllowed: round.serverSpeechAllowed,
      }
    : null
}

export function commentaryForSpeech(entry: ChatCommentary | undefined): Pick<Message, 'content' | 'meta'> | undefined {
  if (!entry) return undefined
  return {
    content: entry.content,
    meta: {
      serverSpeechAllowed: entry.serverSpeechAllowed,
      dataHandling: entry.serverSpeechAllowed ? 'syncable' : 'ephemeral',
    },
  }
}
