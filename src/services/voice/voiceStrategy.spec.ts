import { describe, it, expect } from 'vitest'
import { HandsFreeMachine, splitOnPhrase, type StrategyConfig, type VoiceCompletionReason } from './voiceStrategy'
import { findVoicePhrase, findWakeWord, pendingVoicePhraseSuffix } from './voicePhrases'

function collector() {
  const commands: string[] = []
  const reasons: (VoiceCompletionReason | undefined)[] = []
  const partials: string[] = []
  return {
    commands,
    reasons,
    partials,
    onCommand: (text: string, reason?: VoiceCompletionReason) => {
      commands.push(text)
      reasons.push(reason)
    },
    onPartial: (text: string) => partials.push(text),
  }
}

const base: StrategyConfig = {
  strategy: 'safeword',
  triggerPhrase: 'luczor start',
  endPhrase: 'luczor stopp',
  continuousSilenceMs: 5000,
}

describe('splitOnPhrase', () => {
  it('splits around a phrase, whitespace/punctuation-insensitive', () => {
    const machine = splitOnPhrase('Also, Luczor Start bitte notiere das', 'luczor start')
    expect(machine).not.toBeNull()
    expect(machine!.before).toBe('Also,')
    expect(machine!.after).toBe('bitte notiere das')
  })

  it('returns null when the phrase is absent', () => {
    expect(splitOnPhrase('nur normaler Text', 'luczor start')).toBeNull()
  })

  it.each(['Luczor', 'Luxor', 'Lucor', 'Lutzor', 'Lukzor', 'Luksor', 'Lutz Or', 'Luczer'])(
    'accepts only the known product alias %s inside configured phrases',
    alias => {
      expect(splitOnPhrase(`Hey, ${alias}! Start: schreibe Grüße.`, 'hey luczor start')?.after).toBe('schreibe Grüße.')
      expect(findWakeWord(`Bitte ${alias} hören`)?.matched).toBe(alias.toLocaleLowerCase('de-DE'))
    }
  )

  it('does not fuzzy-match custom activation or close words or substrings', () => {
    expect(findWakeWord('der Schalter', 'schalte')).toBeNull()
    expect(findVoicePhrase('Luczor Sport', 'luczor stopp')).toBeNull()
    expect(findVoicePhrase('Luczor stop', 'luczor stopp')).toBeNull()
    expect(findVoicePhrase('Luczor sende', 'luczor ende')).toBeNull()
    expect(findWakeWord('Luxorius hört zu')).toBeNull()
    expect(findWakeWord('Luxar hört zu')).toBeNull()
  })

  it('normalizes case, punctuation and German Unicode while preserving original offsets', () => {
    const text = 'Bitte: ÖFFNEN, große TÜR! Jetzt.'
    const match = findVoicePhrase(text, 'öffnen große tür')!
    expect(text.slice(match.start, match.end)).toBe('ÖFFNEN, große TÜR')
    expect(splitOnPhrase('Notiz SCHLIESSEN. Fertig.', 'schließen')?.before).toBe('Notiz')
    expect(splitOnPhrase('O\u0308ffnen bitte', 'öffnen')?.after).toBe('bitte')
  })

  it('holds the longest incomplete suffix, including a split product alias', () => {
    expect(pendingVoicePhraseSuffix('Text Hey Lutz', 'hey luczor stopp')).toEqual({
      before: 'Text',
      pending: 'Hey Lutz',
    })
    expect(pendingVoicePhraseSuffix('Text Luczor anderes', 'luczor stopp')).toEqual({
      before: 'Text Luczor anderes',
      pending: '',
    })
    expect(pendingVoicePhraseSuffix('Text Luczor Stopp', 'luczor stopp').pending).toBe('')
    expect(pendingVoicePhraseSuffix('Text', '').pending).toBe('')
  })
})

describe('safeword strategy', () => {
  it('finishes after silence, rearms and ignores ambient speech', () => {
    const capture = collector()
    const machine = new HandsFreeMachine({ ...base, endMode: 'either' }, capture.onCommand)
    machine.pushSegment('Luczor start bitte den Termin prüfen', 1000)
    machine.tick(5999)
    expect(capture.commands).toEqual([])
    machine.tick(6000)
    machine.tick(9000)
    expect(capture.commands).toEqual(['bitte den Termin prüfen'])
    expect(capture.reasons).toEqual(['silence'])
    expect(machine.state).toBe('armed')
    machine.pushSegment('Hintergrundgespräch', 10000)
    machine.tick(16000)
    expect(capture.commands).toHaveLength(1)
  })

  it('only-close ignores pauses and only-silence treats close words as text', () => {
    const capture = collector()
    const close = new HandsFreeMachine({ ...base, endMode: 'close_word' }, capture.onCommand)
    close.pushSegment('Luczor start Termin prüfen', 1000)
    close.tick(99999)
    expect(capture.commands).toEqual([])
    close.pushSegment('Luczor stopp', 100000)
    expect(capture.reasons).toEqual(['close_word'])
    const silence = new HandsFreeMachine({ ...base, endMode: 'silence' }, capture.onCommand)
    silence.pushSegment('Luczor start das Wort Luczor stopp erklären', 1000)
    expect(capture.commands).toHaveLength(1)
    silence.tick(6000)
    expect(capture.commands[1]).toBe('das Wort Luczor stopp erklären')
    expect(capture.reasons[1]).toBe('silence')
  })

  it('rearms after an empty wake activation times out without sending', () => {
    const capture = collector()
    const machine = new HandsFreeMachine({ ...base, endMode: 'either' }, capture.onCommand)
    machine.pushSegment('Luczor start', 1000)
    machine.tick(6000)
    expect(machine.state).toBe('armed')
    expect(capture.commands).toEqual([])
  })

  it('accepts the product alias observed in the installed Whisper base audio smoke', () => {
    const capture = collector()
    const machine = new HandsFreeMachine({ ...base, triggerPhrase: 'luczor' }, capture.onCommand)
    machine.pushSegment('Luxua, bitte den Termin für morgen prüfen. Luxua stopp.', 1000)
    expect(capture.commands).toEqual(['bitte den Termin für morgen prüfen.'])
    expect(capture.reasons).toEqual(['close_word'])
  })
  it('ignores ambient speech until the activation phrase, then dictates until the end phrase', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(base, capture.onCommand, capture.onPartial)

    machine.pushSegment('irgendein Gespräch nebenbei', 0)
    expect(machine.state).toBe('armed')
    expect(capture.commands).toEqual([])

    machine.pushSegment('Luczor Start schreibe eine Notiz', 1000)
    expect(machine.state).toBe('dictating')

    machine.pushSegment('mit mehreren Sätzen', 2000)
    expect(capture.commands).toEqual([]) // not finalized yet

    machine.pushSegment('und jetzt Luczor Stopp', 3000)
    expect(machine.state).toBe('armed')
    expect(capture.commands).toEqual(['schreibe eine Notiz mit mehreren Sätzen und jetzt'])
  })

  it('processes activation, dictation and closing inside the same final utterance', () => {
    const capture = collector()
    const states: string[] = []
    const machine = new HandsFreeMachine(base, capture.onCommand, capture.onPartial, state => states.push(state))
    machine.pushSegment('Nebenbei Luxor Start sende bitte Grüße Lutz Or Stopp weiteres Gespräch', 100)
    expect(capture.commands).toEqual(['sende bitte Grüße'])
    expect(capture.reasons).toEqual(['close_word'])
    expect(machine.state).toBe('armed')
    expect(capture.partials.slice(-1)[0]).toBe('')
    expect(states).toEqual(['dictating', 'armed'])
  })

  it('recognizes multiword controls split across several final segments without leaking them', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(
      { ...base, triggerPhrase: 'hey luczor start', endPhrase: 'luczor bitte schließen' },
      capture.onCommand,
      capture.onPartial
    )
    machine.pushSegment('Ein Nebengespräch Hey Lutz', 100)
    machine.pushSegment('Or', 200)
    expect(machine.state).toBe('armed')
    expect(capture.partials.slice(-1)[0]).toBe('')
    machine.pushSegment('Start schreibe diese Notiz Luczor', 300)
    expect(machine.state).toBe('dictating')
    expect(capture.partials.slice(-1)[0]).toBe('schreibe diese Notiz')
    machine.pushSegment('bitte', 400)
    expect(capture.partials.slice(-1)[0]).toBe('schreibe diese Notiz')
    machine.pushSegment('schließen', 500)
    expect(capture.commands).toEqual(['schreibe diese Notiz'])
    expect(capture.reasons).toEqual(['close_word'])
    expect(capture.partials.join(' ')).not.toContain('Luczor')
  })

  it('discards an interrupted wake prefix and restores an interrupted close prefix as dictation exactly once', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(base, capture.onCommand, capture.onPartial)
    machine.pushSegment('Luczor', 0)
    machine.pushSegment('ein anderes Gespräch', 100)
    machine.pushSegment('start wäre ein Wort', 200)
    expect(machine.state).toBe('armed')
    machine.pushSegment('Luczor start frage Luczor', 300)
    expect(capture.partials.slice(-1)[0]).toBe('frage')
    machine.pushSegment('nach dem Wetter', 400)
    expect(capture.partials.slice(-1)[0]).toBe('frage Luczor nach dem Wetter')
    machine.pushSegment('Luczor stopp', 500)
    expect(capture.commands).toEqual(['frage Luczor nach dem Wetter'])
  })

  it('retains actual repeated dictation words and does not treat a similar close word as submit', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(base, capture.onCommand, capture.onPartial)
    machine.pushSegment('Luczor start sehr', 100)
    machine.pushSegment('sehr gut Luczor Sport', 200)
    expect(capture.commands).toEqual([])
    expect(capture.reasons).toEqual([])
    machine.pushSegment('Luczor stopp', 300)
    expect(capture.commands).toEqual(['sehr sehr gut Luczor Sport'])
    expect(capture.reasons).toEqual(['close_word'])
  })

  it('does not send an empty command and only reports real state transitions', () => {
    const capture = collector()
    const states: string[] = []
    const machine = new HandsFreeMachine(base, capture.onCommand, capture.onPartial, state => states.push(state))
    machine.pushSegment('Luczor start Luczor stopp', 100)
    machine.finalize()
    machine.reset()
    expect(capture.commands).toEqual([])
    expect(states).toEqual(['dictating', 'armed'])
    expect(capture.reasons).toEqual([])
  })

  it('does not interpret closing before activation as a command', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(base, capture.onCommand, capture.onPartial)
    machine.pushSegment('Luczor stopp normales Gespräch', 100)
    machine.tick(99999)
    expect(capture.commands).toEqual([])
    expect(machine.state).toBe('armed')
  })
})

describe('replaceable live previews', () => {
  it('can prospectively activate and close but never changes state, submits or commits', () => {
    const capture = collector()
    const states: string[] = []
    const machine = new HandsFreeMachine(base, capture.onCommand, capture.onPartial, state => states.push(state))
    expect(machine.previewSegment('Luczor start erste Vermutung Luczor stopp')).toBe('erste Vermutung')
    expect(machine.previewSegment('Luczor start korrigierter Text')).toBe('korrigierter Text')
    expect(machine.state).toBe('armed')
    expect(states).toEqual([])
    expect(capture.commands).toEqual([])
    machine.pushSegment('Luczor start tatsächlicher Text Luczor stopp', 100)
    expect(capture.commands).toEqual(['tatsächlicher Text'])
    expect(capture.reasons).toEqual(['close_word'])
  })

  it('replaces hypotheses over the committed buffer and ignores an interim close when it is revised away', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(base, capture.onCommand, capture.onPartial)
    machine.pushSegment('Luczor start sichere Notiz', 100)
    expect(machine.previewSegment('und eins')).toBe('sichere Notiz und eins')
    expect(machine.previewSegment('und zwei Luczor stopp')).toBe('sichere Notiz und zwei')
    expect(machine.previewSegment('und dritte Version')).toBe('sichere Notiz und dritte Version')
    expect(machine.state).toBe('dictating')
    expect(capture.commands).toEqual([])
    machine.pushSegment('und endgültige Version', 200)
    machine.finalize()
    expect(capture.commands).toEqual(['sichere Notiz und endgültige Version'])
    expect(capture.reasons).toEqual(['manual'])
  })

  it('does not let an interim wake prefix influence the next final segment', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(base, capture.onCommand, capture.onPartial)
    machine.previewSegment('Luczor')
    machine.pushSegment('start dies ist weiterhin ein Nebengespräch', 100)
    expect(machine.state).toBe('armed')
    expect(capture.commands).toEqual([])
    expect(capture.partials.slice(-1)[0]).toBe('')
  })

  it('previews split close words without submitting and commits their final replacement once', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(base, capture.onCommand, capture.onPartial)
    machine.pushSegment('Luczor start Nachricht Lutz', 100)
    expect(machine.previewSegment('or stopp')).toBe('Nachricht')
    expect(machine.state).toBe('dictating')
    expect(capture.commands).toEqual([])
    machine.pushSegment('oder jemand anders', 200)
    machine.finalize()
    expect(capture.commands).toEqual(['Nachricht Lutz oder jemand anders'])
    expect(capture.reasons).toEqual(['manual'])
  })

  it('empty revisions and resets clear preview without committing it', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(base, capture.onCommand, capture.onPartial)
    machine.pushSegment('Luczor start behalten', 100)
    machine.previewSegment('nicht behalten')
    expect(machine.previewSegment('')).toBe('behalten')
    machine.previewSegment('auch nicht behalten')
    machine.pushSegment('', 200)
    expect(capture.partials.slice(-1)[0]).toBe('behalten')
    machine.reset()
    expect(capture.partials.slice(-1)[0]).toBe('')
    machine.pushSegment('Nachsatz Luczor stopp', 300)
    expect(capture.commands).toEqual([])
  })

  it('manual finalization submits committed text only, including an unconfirmed ordinary product mention', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(base, capture.onCommand, capture.onPartial)
    machine.pushSegment('Luczor start öffne Luczor', 100)
    machine.previewSegment('stopp')
    machine.finalize()
    expect(capture.commands).toEqual(['öffne Luczor'])
    expect(capture.reasons).toEqual(['manual'])
  })
})

describe('continuous strategy', () => {
  const cfg: StrategyConfig = { ...base, strategy: 'continuous' }

  it('dictates from first speech and finalizes after a long pause', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(cfg, capture.onCommand, capture.onPartial)

    machine.pushSegment('erster Satz', 0)
    machine.pushSegment('zweiter Satz', 1000)
    expect(machine.state).toBe('dictating')

    machine.tick(3000) // < 5s since last segment -> no finalize
    expect(capture.commands).toEqual([])

    machine.tick(6001) // >= 5s -> finalize
    expect(machine.state).toBe('armed')
    expect(capture.commands).toEqual(['erster Satz zweiter Satz'])
    expect(capture.reasons).toEqual(['silence'])
  })

  it('finalizes early on an optional end phrase', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(cfg, capture.onCommand, capture.onPartial)
    machine.pushSegment('kurze Nachricht Luczor Stopp', 0)
    expect(capture.commands).toEqual(['kurze Nachricht'])
    expect(capture.reasons).toEqual(['close_word'])
    expect(machine.state).toBe('armed')
  })

  it('defers silence submission during ongoing speech/transcription using a monotonic clock', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(cfg, capture.onCommand, capture.onPartial)
    machine.pushSegment('Ein Satz', 1000)
    machine.touchSpeech(5500)
    machine.touchSpeech(2000)
    machine.touchSpeech(Number.NaN)
    machine.tick(10000)
    expect(capture.commands).toEqual([])
    machine.tick(10500)
    expect(capture.commands).toEqual(['Ein Satz'])
  })

  it('never auto-submits an interim-only draft', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(cfg, capture.onCommand, capture.onPartial)
    expect(machine.previewSegment('nur eine Hypothese Luczor stopp')).toBe('nur eine Hypothese')
    machine.tick(100000)
    expect(machine.state).toBe('armed')
    expect(capture.commands).toEqual([])
  })

  it('handles a split close phrase in continuous mode', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(cfg, capture.onCommand, capture.onPartial)
    machine.pushSegment('Mein Text Luxor', 100)
    machine.pushSegment('Stopp', 200)
    expect(capture.commands).toEqual(['Mein Text'])
    expect(capture.reasons).toEqual(['close_word'])
  })

  it('does not turn an interim-only close suffix into a close-word completion on silence', () => {
    const capture = collector()
    const machine = new HandsFreeMachine(cfg, capture.onCommand, capture.onPartial)
    machine.pushSegment('Frage an Luxor', 100)
    machine.previewSegment('Stopp')
    expect(capture.commands).toEqual([])
    expect(capture.reasons).toEqual([])
    machine.tick(5100)
    expect(capture.commands).toEqual(['Frage an Luxor'])
    expect(capture.reasons).toEqual(['silence'])
  })
})
