import { describe, expect, it } from 'vitest'
import { isEnvelopeStreamPrefix } from '@/services/envelope'
describe('incomplete envelope stream recognition', () => {
  it.each(['Das Feld "summary" enthält den Titel.', 'Du kannst "question" umbenennen.', 'Eine Liste heißt "bullets".'])(
    'keeps ordinary prose visible: %s',
    text => {
      expect(isEnvelopeStreamPrefix(text)).toBe(false)
    }
  )
  it.each(['{', '{ ', '{"s', '{ "summary"', '```json\n{"question":'])(
    'holds real incomplete envelope headers: %s',
    text => {
      expect(isEnvelopeStreamPrefix(text)).toBe(true)
    }
  )
  it('does not hide unrelated JSON fields', () => {
    expect(isEnvelopeStreamPrefix('{"customer":')).toBe(false)
  })
})
