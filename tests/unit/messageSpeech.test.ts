import { describe, expect, it } from 'vitest'
import { serverSpeechText } from '../../src/services/voice/messageSpeech'

describe('server speech privacy', () => {
  it('permits completed local public output only with explicit speech consent, preserving its classification', () => {
    const message = {
      content: 'Ich lese jetzt die Projektstruktur.',
      meta: { dataHandling: 'ephemeral' as const, serverSpeechAllowed: false },
    }
    expect(serverSpeechText(message)).toBe('')
    expect(serverSpeechText(message, { allowLocalContent: true })).toBe(message.content)
    expect(message.meta).toEqual({ dataHandling: 'ephemeral', serverSpeechAllowed: false })
    expect(
      serverSpeechText({ ...message, meta: { ...message.meta, isLoading: true } }, { allowLocalContent: true })
    ).toBe('')
  })
  it('excludes device-local content and questions from server output', () => {
    expect(
      serverSpeechText({ content: 'Lokales Dateiergebnis', meta: { dataHandling: 'ephemeral', question: 'Privat?' } })
    ).toBe('')
  })

  it('waits for complete output before its privacy classification is known', () => {
    expect(serverSpeechText({ content: 'Noch in Arbeit', meta: { isLoading: true } })).toBe('')
    expect(
      serverSpeechText({ content: 'Abgebrochene Teilantwort', meta: { isLoading: false, serverSpeechAllowed: false } })
    ).toBe('')
    expect(serverSpeechText(undefined)).toBe('')
  })

  it('allows completed ordinary answers including locally generated non-private text', () => {
    expect(
      serverSpeechText({ content: ' Guten Tag. ', meta: { inferenceTarget: 'local_llama_cpp', question: 'Weiter?' } })
    ).toBe(' Guten Tag. \n\nWeiter?')
  })

  it('keeps a closing code fence separate from the spoken follow-up question', () => {
    const content = '```ts\nconst ready = true\n```'
    expect(serverSpeechText({ content, meta: { question: 'Weiter?' } })).toBe(`${content}\n\nWeiter?`)
  })
})
