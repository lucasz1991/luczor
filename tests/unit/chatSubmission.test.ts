import { describe, expect, it } from 'vitest'
import { captureChatSubmission } from '@/services/chatSubmission'
import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import type { Message } from '@/state/types'

const message = (id: string, role: 'user' | 'assistant', conversationId = 'chat'): Message =>
  ({ id, role, content: id, projectId: 'project', conversationId, visibility: 'visible', meta: {} }) as Message
const checkpoint: AgentCheckpoint = {
  projectId: 'project',
  sessionId: 'session',
  generation: 1,
  objective: 'Vollständiger ursprünglicher Auftrag',
  messages: [{ role: 'user', content: 'Vollständiger ursprünglicher Auftrag' }],
  completedMutations: [],
  ephemeralDataUsed: false,
}
const input = {
  projectId: 'project',
  conversationId: 'chat',
  text: 'Ungesendeter neuer Entwurf',
  messages: [message('request', 'user'), message('partial', 'assistant')],
}

describe('chat submission ownership', () => {
  it('continues the original context without a user message and preserves the draft', () => {
    const result = captureChatSubmission({ ...input, continuation: { checkpoint, messageId: 'partial' } })
    expect(result).toEqual({
      text: checkpoint.objective,
      createsUserMessage: false,
      consumesDraft: false,
      historyBoundaryMessageId: 'partial',
    })
    expect(checkpoint.messages).toEqual([{ role: 'user', content: checkpoint.objective }])
  })
  it('admits a normal message but keeps autonomous goal control out of the transcript', () => {
    expect(captureChatSubmission(input)).toMatchObject({ createsUserMessage: true, consumesDraft: true })
    expect(captureChatSubmission({ ...input, goal: true })).toMatchObject({
      createsUserMessage: false,
      consumesDraft: false,
    })
  })
  it('refuses a checkpoint from another chat even in the same project', () => {
    expect(() =>
      captureChatSubmission({ ...input, conversationId: 'other', continuation: { checkpoint, messageId: 'partial' } })
    ).toThrow('ausgewählten Chat')
  })
  it('does not discard newer user steering by resuming an older checkpoint', () => {
    expect(() =>
      captureChatSubmission({
        ...input,
        messages: [...input.messages, message('correction', 'user')],
        continuation: { checkpoint, messageId: 'partial' },
      })
    ).toThrow('neuere Nachricht')
  })
})
