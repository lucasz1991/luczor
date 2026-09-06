import type { Message } from '@/state/types'

/** Respect device-local tool results when preparing text for server speech. */
export function serverSpeechText(message: Pick<Message, 'content' | 'meta'> | null | undefined): string {
  if (
    !message ||
    message.meta?.dataHandling === 'ephemeral' ||
    message.meta?.isLoading ||
    message.meta?.serverSpeechAllowed === false
  )
    return ''
  return [message.content, message.meta?.question]
    .filter((part): part is string => typeof part === 'string')
    .map(part => part.trim())
    .filter(Boolean)
    .join(' ')
}
