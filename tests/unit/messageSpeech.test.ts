import { describe, expect, it } from 'vitest'
import { serverSpeechText } from '../../src/services/voice/messageSpeech'

describe('server speech privacy', () => {
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
    ).toBe('Guten Tag. Weiter?')
  })
})
