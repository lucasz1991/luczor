import { describe, expect, it } from 'vitest'
import { isEnvelopeStreamPrefix, parseEnvelope, presentEnvelopeStream } from '@/services/envelope'
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

describe('incremental public envelope fields', () => {
  it.each(['summary', 'content', 'answer', 'message'])('renders %s before its string or object closes', field => {
    const prefix = `{"${field}":"`
    const text = 'Hallo Welt'
    for (let length = 1; length <= text.length; length++) {
      expect(presentEnvelopeStream(prefix + text.slice(0, length)).content).toBe(text.slice(0, length).trim())
    }
    expect(parseEnvelope(prefix + text + '"}')).toMatchObject({ summary: text, complete: true })
  })

  it('keeps an unfinished question and each unfinished bullet visible', () => {
    expect(presentEnvelopeStream('{"question":"Welche Datei')).toMatchObject({
      content: '',
      question: 'Welche Datei',
    })
    expect(presentEnvelopeStream('{"summary":"Hallo","bullets":["Datei prüfen","Änderung tes')).toMatchObject({
      content: 'Hallo',
      bullets: ['Datei prüfen', 'Änderung tes'],
    })
  })

  it('buffers only incomplete escapes and surrogate pairs while decoding Unicode', () => {
    const prefix = '{"message":"Gr'
    for (const escape of ['\\', '\\u', '\\u0', '\\u00', '\\u00f']) {
      expect(presentEnvelopeStream(prefix + escape).content).toBe('Gr')
    }
    expect(presentEnvelopeStream(prefix + '\\u00fcße').content).toBe('Grüße')
    expect(presentEnvelopeStream('{"message":"Hallo \\ud83d').content).toBe('Hallo')
    expect(presentEnvelopeStream('{"message":"Hallo \\ud83d\\udc4b').content).toBe('Hallo 👋')
    expect(presentEnvelopeStream('{"answer":"Zeile 1\\nZeile \\"2\\"').content).toBe('Zeile 1\nZeile "2"')
  })

  it('never interprets nested tool arguments or reasoning strings as public fields', () => {
    const raw =
      '{"tool_calls":[{"function":{"arguments":{"answer":"PRIVATE_TOOL"}}}],"reasoning":"PRIVATE_REASONING","answer":"Hallo"}'
    for (let length = 1; length <= raw.length; length++) {
      const visible = presentEnvelopeStream(raw.slice(0, length))
      expect(JSON.stringify([visible.content, visible.question, visible.bullets])).not.toMatch(
        /PRIVATE|tool_calls|reasoning/
      )
    }
    expect(presentEnvelopeStream(raw, true).content).toBe('Hallo')
    expect(presentEnvelopeStream('{"summary":"Analysis: private work note"}', true).content).toBe('')
  })

  it('does not extract quoted field names or unrelated JSON embedded in ordinary prose', () => {
    const prose = 'Das Feld "summary" ist ein Titel. Beispiel: {"summary":"nicht extrahieren"}'
    expect(presentEnvelopeStream(prose).content).toBe(prose)
    expect(presentEnvelopeStream('{"customer":"Ada"}').content).toBe('{"customer":"Ada"}')
    expect(presentEnvelopeStream('```json\n{"answer":"Sofo').content).toBe('Sofo')
  })

  it('skips non-string bullet values without hiding later public entries', () => {
    expect(presentEnvelopeStream('{"bullets":[null,{"answer":"hidden"},"Sichtbar","Liv')).toMatchObject({
      bullets: ['Sichtbar', 'Liv'],
    })
  })
})
