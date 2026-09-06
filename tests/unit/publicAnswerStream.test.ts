import { describe, expect, it } from 'vitest'
import { publicAnswerText } from '@/services/publicAnswerStream'

describe('public answer streaming guard', () => {
  it('releases ordinary text immediately without waiting for the full answer', () => {
    expect(publicAnswerText('H')).toBe('H')
    expect(publicAnswerText('Hallo 👋')).toBe('Hallo 👋')
  })
  it.each([
    '<think>private notes</think>',
    '<analysis>private notes</analysis>',
    '<reasoning>private notes</reasoning>',
  ])('suppresses reasoning tags even at every possible chunk boundary: %s', hidden => {
    for (let length = 1; length <= hidden.length; length++) {
      expect(publicAnswerText(hidden.slice(0, length))).toBe('')
      expect(publicAnswerText(`Hallo ${hidden.slice(0, length)}`)).toBe('Hallo ')
    }
    expect(publicAnswerText(`${hidden}Antwort`)).toBe('Antwort')
    expect(publicAnswerText(`Hallo ${hidden}Welt`)).toBe('Hallo Welt')
  })
  it.each(['We need to respond: private notes', 'Analysis: private notes', 'interne Tool-Überlegung'])(
    'withholds recognized private work-note prefixes from the first fragment: %s',
    text => {
      for (let length = 1; length <= text.length; length++) expect(publicAnswerText(text.slice(0, length))).toBe('')
      expect(publicAnswerText(text, true)).toBe('')
    }
  )
  it('does not hold disambiguated public sentences or interpret model HTML', () => {
    expect(publicAnswerText('The user interface is ready.')).toBe('The user interface is ready.')
    expect(publicAnswerText('<strong>Antwort</strong>')).toBe('<strong>Antwort</strong>')
  })
  it('keeps nested and mismatched reasoning blocks closed and recognizes whitespace variants', () => {
    expect(publicAnswerText('<think>A<analysis>B</analysis>C</think>Hallo')).toBe('Hallo')
    expect(publicAnswerText('<think>A</analysis>B')).toBe('')
    expect(publicAnswerText('Analysis \t : private notes')).toBe('')
    expect(publicAnswerText('Internal reasoning \t : private notes')).toBe('')
  })
})
