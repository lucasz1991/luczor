import { describe, expect, it } from 'vitest'
import { parseSpeechVoices } from '@/services/voice/voiceCatalog'

describe('server-authorized voice catalog', () => {
  const voice = { id: 'benni', name: 'Benni', provider: 'pocket', language: 'de' }
  it('retains public names including newly provisioned voices and drops unknown metadata', () => {
    expect(parseSpeechVoices({ voices: [{ ...voice, reference_path: '/private/example' }] })).toEqual([voice])
  })
  it.each([
    null,
    { voices: 'invalid' },
    { voices: [{ ...voice, id: '../private' }] },
    { voices: [voice, voice] },
    { voices: [{ ...voice, provider: 'other' }] },
  ])('rejects malformed or ambiguous catalogs', payload => {
    expect(() => parseSpeechVoices(payload)).toThrow('Stimmenkatalog')
  })
})
