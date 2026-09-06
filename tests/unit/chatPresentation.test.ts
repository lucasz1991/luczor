import { describe, expect, it } from 'vitest'
import {
  clampNumber,
  compactHistory,
  localConversationHistory,
  composeProviderSystemPrompt,
  goalStatusLabel,
  normalizeConversationHistory,
  previewToolArguments,
  safeTrim,
} from '../../src/services/chatPresentation'
import type { WireMessage } from '../../src/services/openrouter.service'

describe('chat presentation helpers', () => {
  it('lets the native tokenizer budget local history beyond the old small estimate', () => {
    const history: WireMessage[] = [
      { role: 'user', content: 'a'.repeat(12000) },
      { role: 'assistant', content: 'b'.repeat(12000) },
      { role: 'user', content: 'current' },
    ]
    expect(localConversationHistory(history)).toEqual(history)
    expect(compactHistory(history, 2400)).toEqual([history[2]])
  })

  it('bounds the local IPC history while retaining the latest complete user message', () => {
    const history: WireMessage[] = Array.from({ length: 301 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: String(index),
    }))
    const result = localConversationHistory(history)
    expect(result.length).toBeLessThanOrEqual(240)
    expect(result[0]?.role).toBe('user')
    expect(result.at(-1)).toEqual(history.at(-1))
    const huge: WireMessage = { role: 'user', content: 'x'.repeat(600000) }
    expect(localConversationHistory([...history, huge]).at(-1)?.content).toContain(huge.content)
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
