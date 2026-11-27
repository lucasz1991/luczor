import { describe, expect, it } from 'vitest'
import {
  canPersistData,
  inheritedMessageDataPolicy,
  strictestDataPolicy,
  unfinishedTurnDataPolicy,
} from '@/services/runs/dataPolicy'
import { stateForPersistence } from '@/services/persistence'
import type { AppState, Message } from '@/state/types'

const message = (id: string, role: Message['role'], content: string, meta: Partial<Message['meta']> = {}): Message =>
  ({
    id,
    role,
    content,
    projectId: 'project',
    conversationId: 'chat',
    visibility: 'visible',
    ts: 1,
    createdAt: 1,
    meta: { ...meta },
  }) as Message

describe('chat data policy inheritance', () => {
  it('keeps a later answer on the device, not volatile, after a legacy device-local message', () => {
    expect(inheritedMessageDataPolicy({ dataHandling: 'ephemeral' })).toBe('local_only')
    expect(inheritedMessageDataPolicy({ dataHandling: 'syncable' })).toBe('syncable')
    expect(inheritedMessageDataPolicy({})).toBe('syncable')
  })

  it('still follows an explicit classification, including a real ephemeral source', () => {
    expect(inheritedMessageDataPolicy({ dataHandling: 'ephemeral', retentionPolicy: 'ephemeral' })).toBe('ephemeral')
    expect(inheritedMessageDataPolicy({ dataHandling: 'ephemeral', retentionPolicy: 'local_only' })).toBe('local_only')
    expect(inheritedMessageDataPolicy({ retentionPolicy: 'syncable' })).toBe('syncable')
  })

  it.each([
    [undefined, 'local_only'],
    ['syncable', 'local_only'],
    ['local_only', 'local_only'],
    ['ephemeral', 'ephemeral'],
  ] as const)('settles an unfinished turn that reached %s on %s', (known, expected) => {
    expect(unfinishedTurnDataPolicy(known)).toBe(expected)
  })

  it('does not let a failed or stopped answer erase the rest of the chat after a restart', () => {
    // The turn failed: the provisional classification is settled instead of staying `ephemeral`.
    const failed = message('failed', 'assistant', 'Teilantwort\n\n[Fehler] Modell nicht erreichbar', {
      dataHandling: 'ephemeral',
      retentionPolicy: unfinishedTurnDataPolicy(undefined),
    })
    const history = [message('question', 'user', 'Frage'), failed]
    // The next answer inherits from the visible history and is therefore stored in full.
    const next = message('next', 'assistant', 'Die eigentliche Antwort.', {
      dataHandling: 'ephemeral',
      retentionPolicy: strictestDataPolicy(...history.map(item => inheritedMessageDataPolicy(item.meta))),
    })
    expect(canPersistData(next.meta.retentionPolicy!)).toBe(true)
    const stored = stateForPersistence({ messages: [...history, next] } as unknown as AppState)
    expect(stored.messages.map(item => item.content)).toEqual([
      'Frage',
      'Teilantwort\n\n[Fehler] Modell nicht erreichbar',
      'Die eigentliche Antwort.',
    ])
    expect(stored.messages.some(item => item.meta.retentionOmitted)).toBe(false)
  })

  it('still replaces a genuinely ephemeral answer with the visible gap marker', () => {
    const stored = stateForPersistence({
      messages: [message('secret', 'assistant', 'flüchtiger Inhalt', { retentionPolicy: 'ephemeral' })],
    } as unknown as AppState)
    expect(stored.messages[0]).toMatchObject({
      content: '[Temporärer Inhalt nicht gespeichert; Quelle bei Bedarf erneut lesen.]',
      meta: { retentionOmitted: true, retentionPolicy: 'local_only' },
    })
  })
})
