import type { Message } from '@/state/types'

/** Respect device-local tool results when preparing text for server speech. */
export function serverSpeechText(
  message: Pick<Message, 'content' | 'meta'> | null | undefined,
  options: { allowLocalContent?: boolean; allowStreaming?: boolean } = {}
): string {
  if (
    !message ||
    (message.meta?.isLoading && !(options.allowStreaming && options.allowLocalContent)) ||
    (!options.allowLocalContent &&
      (message.meta?.dataHandling === 'ephemeral' || message.meta?.serverSpeechAllowed === false))
  )
    return ''
  return [message.content, message.meta?.question?.trim()]
    .filter((part): part is string => typeof part === 'string')
    .filter(part => !!part.trim())
    .join('\n\n')
}
