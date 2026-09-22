import { describe, expect, it } from 'vitest'
import {
  clampNumber,
  compactHistory,
  conversationHistoryForInference,
  localConversationHistory,
  composeProviderSystemPrompt,
  goalStatusLabel,
  normalizeConversationHistory,
  previewToolArguments,
  safeTrim,
} from '../../src/services/chatPresentation'
import type { WireMessage } from '../../src/services/openrouter.service'
import type { Message } from '../../src/state/types'

describe('chat presentation helpers', () => {
  it('retains device-local answers and completed public rounds in local follow-up context only', () => {
    const history: Pick<Message, 'role' | 'content' | 'visibility' | 'meta'>[] = [
      { role: 'user', content: 'Read the local project', visibility: 'visible', meta: {} },
      {
        role: 'assistant',
        content: 'The exact file is E:/projekte/luczor/notes.md.',
        visibility: 'visible',
        meta: {
          dataHandling: 'ephemeral',
          commentary: [
            {
              id: 'round-1',
              round: 1,
              content: 'Verified the local repository.',
              createdAt: 1,
              serverSpeechAllowed: false,
            },
          ],
        },
      },
      { role: 'tool', content: 'Hidden raw receipt', visibility: 'hidden', meta: { dataHandling: 'ephemeral' } },
      { role: 'assistant', content: 'Still running', visibility: 'visible', meta: { isLoading: true } },
      { role: 'user', content: 'Use the file from your answer.', visibility: 'visible', meta: {} },
    ]
    const original = structuredClone(history)
    const local = conversationHistoryForInference(history, 'local')
    expect(local.ephemeralDataUsed).toBe(true)
    expect(local.messages).toEqual([
      { role: 'user', content: history[0]!.content },
      { role: 'assistant', content: `Verified the local repository.\n\n${history[1]!.content}` },
      { role: 'user', content: history[4]!.content },
    ])
    const external = conversationHistoryForInference(history, 'external')
    expect(external).toEqual({ messages: [local.messages[0], local.messages[2]], ephemeralDataUsed: false })
    expect(history).toEqual(original)
  })

  it('tracks the privacy of historical commentary independently and avoids duplicate final text', () => {
    const history: Pick<Message, 'role' | 'content' | 'visibility' | 'meta'>[] = [
      { role: 'user', content: 'Proceed', visibility: 'visible', meta: {} },
      {
        role: 'assistant',
        content: 'Done',
        visibility: 'visible',
        meta: {
          commentary: [
            { id: 'a', round: 1, content: 'Local observation', createdAt: 1, serverSpeechAllowed: false },
            { id: 'b', round: 2, content: 'Done', createdAt: 2, serverSpeechAllowed: true },
          ],
        },
      },
    ]
    expect(conversationHistoryForInference(history, 'local')).toMatchObject({
      messages: [expect.anything(), { role: 'assistant', content: 'Local observation\n\nDone' }],
      ephemeralDataUsed: true,
    })
    expect(conversationHistoryForInference(history, 'external')).toMatchObject({
      messages: [expect.anything(), { role: 'assistant', content: 'Done' }],
      ephemeralDataUsed: false,
    })
  })

  it('keeps goal-only assistant history anchored to the saved user goal without synthetic continuation prompts', () => {
    const history: Pick<Message, 'role' | 'content' | 'visibility' | 'meta'>[] = [
      {
        role: 'assistant',
        content: 'Step one is verified.',
        visibility: 'visible',
        meta: { dataHandling: 'ephemeral' },
      },
    ]
    const selected = conversationHistoryForInference(history, 'local', { initialUserContext: 'Implement the report.' })
    expect(localConversationHistory(selected.messages)).toEqual([
      { role: 'user', content: 'Gespeichertes Nutzerziel:\nImplement the report.' },
      { role: 'assistant', content: 'Step one is verified.' },
    ])
    expect(selected.ephemeralDataUsed).toBe(true)
    const nextPrompt = conversationHistoryForInference(
      [...history, { role: 'user', content: 'Now check the remaining requirement.', visibility: 'visible', meta: {} }],
      'local',
      { initialUserContext: 'Implement the report.' }
    )
    expect(localConversationHistory(nextPrompt.messages)).toEqual([
      ...selected.messages,
      { role: 'user', content: 'Now check the remaining requirement.' },
    ])
    expect(nextPrompt.ephemeralDataUsed).toBe(true)
    expect(
      conversationHistoryForInference(history, 'external', { initialUserContext: 'Implement the report.' }).messages
    ).toEqual([])
  })

  it('removes local UI status before merging adjacent assistant turns, without changing storage', () => {
    const history: WireMessage[] = [
      { role: 'user', content: 'Prüfe den Zustand' },
      { role: 'assistant', content: 'Projekt wurde gelesen.' },
      {
        role: 'assistant',
        content:
          'Die lokale Modellrunde 2 wurde vor dem Abschluss unterbrochen: HTTP 400\nDer bisherige Arbeitsfortschritt bleibt erhalten.',
      },
      { role: 'assistant', content: 'Die nächste Modellrunde wurde unterbrochen: HTTP 200 · Kontext 43.000.' },
      { role: 'user', content: 'ok los' },
    ]
    const original = structuredClone(history)
    expect(localConversationHistory(history)).toEqual([history[0], history[1], history[4]])
    expect(history).toEqual(original)
  })
  it('lets the native tokenizer budget local history beyond the old small estimate', () => {
    const history: WireMessage[] = [
      { role: 'user', content: 'a'.repeat(12000) },
      { role: 'assistant', content: 'b'.repeat(12000) },
      { role: 'user', content: 'current' },
    ]
    expect(localConversationHistory(history)).toEqual(history)
    expect(compactHistory(history, 2400)).toEqual([history[2]])
  })

  it('preserves the complete local archive beyond former IPC limits', () => {
    const history: WireMessage[] = Array.from({ length: 301 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: String(index),
    }))
    const result = localConversationHistory(history)
    expect(result).toEqual(history)
    expect(result[0]?.role).toBe('user')
    expect(result.at(-1)).toEqual(history.at(-1))
    const huge: WireMessage = { role: 'user', content: 'x'.repeat(600000) }
    const complete = localConversationHistory([...history, huge])
    expect(complete.at(-1)?.content).toContain(huge.content)
    expect(complete[0]).toEqual(history[0])
  })

  it('keeps the newest messages within the estimated history budget', () => {
    const history: WireMessage[] = [
      { role: 'user', content: 'a'.repeat(16) },
      { role: 'assistant', content: 'b'.repeat(16) },
      { role: 'user', content: 'c'.repeat(16) },
    ]

    expect(compactHistory(history, 8)).toEqual(history.slice(1))
  })

  it('always retains the newest message when it exceeds the budget', () => {
    const newest: WireMessage = { role: 'user', content: 'important'.repeat(100) }

    expect(compactHistory([newest], 1)).toEqual([newest])
  })

  it('keeps the system policy and project context in one template-safe turn', () => {
    expect(composeProviderSystemPrompt('Policy', 'Project context')).toBe('Policy\n\nProject context')
    expect(composeProviderSystemPrompt('Policy', '')).toBe('Policy')
  })

  it('keeps UI greetings and consecutive status events out of the provider transcript', () => {
    const history: WireMessage[] = [
      { role: 'assistant', content: 'Willkommen. Was ist das Ziel?' },
      { role: 'assistant', content: 'Mikrofon nicht verfügbar.' },
      { role: 'user', content: 'Hallo' },
      { role: 'user', content: 'Bist du da?' },
      { role: 'assistant', content: 'Ja.' },
      { role: 'assistant', content: '[Fehler] Alte lokale Runtime-Störung.' },
      { role: 'assistant', content: 'Mikrofon-Fehler: Requested device not found' },
      { role: 'assistant', content: 'Zuhören fehlgeschlagen: Requested device not found' },
      { role: 'user', content: 'Antworte kurz.' },
    ]

    expect(normalizeConversationHistory(history)).toEqual([
      { role: 'user', content: 'Hallo\n\nBist du da?' },
      { role: 'assistant', content: 'Ja.' },
      { role: 'user', content: 'Antworte kurz.' },
    ])
  })

  it('drops a leading assistant turn exposed by history compaction', () => {
    const history: WireMessage[] = [
      { role: 'user', content: 'older user' },
      { role: 'assistant', content: 'newer assistant' },
      { role: 'user', content: 'newest user' },
    ]

    const compacted = compactHistory(normalizeConversationHistory(history), 7)
    expect(normalizeConversationHistory(compacted)).toEqual([{ role: 'user', content: 'newest user' }])
  })

  it('normalizes common presentation values', () => {
    expect(clampNumber(12, 0, 10)).toBe(10)
    expect(safeTrim('  Luczor  ')).toBe('Luczor')
    expect(safeTrim(null)).toBe('')
    expect(goalStatusLabel('blocked')).toBe('Blockiert')
    expect(goalStatusLabel('unexpected')).toBe('Offen')
  })

  it('limits tool argument previews', () => {
    const preview = previewToolArguments({ prompt: '123456789' }, 8)

    expect(preview).toHaveLength(9)
    expect(preview.endsWith('…')).toBe(true)
  })
})
