import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import type { Message } from '@/state/types'

type TranscriptMessage = Pick<
  Message,
  'id' | 'projectId' | 'conversationId' | 'role' | 'content' | 'visibility' | 'meta'
>

/** Capture a transcript boundary without turning application controls into user messages. */
export function captureChatSubmission(input: {
  projectId: string
  conversationId: string
  text: string
  messages: readonly TranscriptMessage[]
  continuation?: { checkpoint: AgentCheckpoint; messageId: string }
  goal?: boolean
}) {
  const history = input.messages.filter(
    message => message.projectId === input.projectId && message.conversationId === input.conversationId
  )
  const resume = input.continuation
  if (resume) {
    const anchor = history.findIndex(message => message.id === resume.messageId && message.role === 'assistant')
    if (resume.checkpoint.projectId !== input.projectId || anchor < 0)
      throw new Error('Dieser Arbeitsstand gehört nicht zum ausgewählten Chat.')
    if (history.slice(anchor + 1).some(message => message.role === 'user' && message.visibility === 'visible'))
      throw new Error('Eine neuere Nachricht hat diesen Arbeitsstand abgelöst. Bitte den neuesten Auftrag fortsetzen.')
  }
  return {
    text: resume?.checkpoint.objective ?? input.text.trim(),
    createsUserMessage: !resume && !input.goal,
    historyBoundaryMessageId: history.at(-1)?.id ?? '',
    // A continuation does not consume or clear an unrelated composer draft.
    consumesDraft: !resume && !input.goal,
  }
}
