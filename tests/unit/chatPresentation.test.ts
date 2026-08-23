import { describe, expect, it } from 'vitest'
import {
  clampNumber,
  compactHistory,
  goalStatusLabel,
  previewToolArguments,
  safeTrim,
} from '../../src/services/chatPresentation'
import type { WireMessage } from '../../src/services/openrouter.service'

describe('chat presentation helpers', () => {
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
