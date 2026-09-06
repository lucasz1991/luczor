import { describe, expect, it } from 'vitest'
import { findWakeWord, VoiceEngine } from '@/services/voice/voiceEngine'
import { BargeInDetector } from '@/services/voice/bargeIn'
import { cleanSttTranscript, isSttPlaceholderTranscript } from '@/services/voice/transcript'
import { encodeWavPCM16, resampleMono, STT_SAMPLE_RATE } from '@/services/voice/wav'

describe('Luczor wake-word matching', () => {
  it.each([
    ['Luczor, starte den Timer', 'luczor'],
    ['Luxor, starte den Timer', 'luxor'],
    ['Lutz or starte den Timer', 'lutz or'],
    ['Luczer starte den Timer', 'luczer'],
  ])('accepts the STT variant %s', (text, matched) => {
    expect(findWakeWord(text, 'luczor')).toMatchObject({ matched })
  })

  it('returns original-text offsets for the command remainder', () => {
    const text = 'Bitte Luxor, starte den Timer'
    const wake = findWakeWord(text, 'luczor')

    expect(wake).not.toBeNull()
    expect(
      text
        .slice(wake!.end)
        .replace(/^[\s,.:;!?-]+/, '')
        .trim()
    ).toBe('starte den Timer')
  })

  it('does not apply Luczor aliases to a custom wake word', () => {
    expect(findWakeWord('Luxor, starte den Timer', 'jarvis')).toBeNull()
  })
})

describe('STT placeholder filtering', () => {
  it.each(['[BLANK_AUDIO]', '[Musik]', '[MUSIC] [BLANK_AUDIO]', '<|silence|>'])(
    'drops a non-speech marker %s',
    text => {
      expect(isSttPlaceholderTranscript(text)).toBe(true)
      expect(cleanSttTranscript(text)).toBe('')
    }
  )

  it('preserves actual commands', () => {
    expect(isSttPlaceholderTranscript('Musik starten')).toBe(false)
    expect(cleanSttTranscript('Musik starten')).toBe('Musik starten')
  })
})

describe('TTS preroll after barge-in (SOLL §5–§7)', () => {
  const frame = (value: number) => new Float32Array(4096).fill(value)

  function mutedEngine(detector: BargeInDetector, onInterrupt: () => void) {
    const engine = new VoiceEngine() as any
    engine.opts = {
      mode: 'continuous',
      transcribe: async () => '',
      onCommand: () => {},
      bargeIn: true,
      onInterrupt,
    }
    engine.running = true
    engine.muted = true
    engine.barge = detector
    return engine
  }

  it('seeds the next segment with the speech captured during TTS', () => {
    let interrupted = 0
    const engine = mutedEngine(new BargeInDetector(0.022, 3), () => interrupted++)

    for (let i = 0; i < 4; i++) engine.onFrame(frame(0.5)) // loud speech over TTS
    expect(interrupted).toBe(1)
    expect(engine.prerollActive).toBe(true)
    expect(engine.preroll.length).toBe(4)

    engine.setMuted(false)
    expect(engine.speaking).toBe(true) // segment seeded, VAD continues it
    expect(engine.segment.length).toBe(4)
    expect(engine.preroll.length).toBe(0)
    expect(engine.prerollActive).toBe(false)
  })

  it('keeps only the rolling window without an interrupt and discards it on unmute', () => {
    const engine = mutedEngine(new BargeInDetector(0.9, 3), () => {})

    for (let i = 0; i < 10; i++) engine.onFrame(frame(0.5)) // below threshold -> no interrupt
    expect(engine.preroll.length).toBe(6) // ~0.5s rolling cap

    engine.setMuted(false)
    expect(engine.speaking).toBe(false) // no barge-in -> nothing seeded
    expect(engine.segment.length).toBe(0)
    expect(engine.preroll.length).toBe(0)
  })

  it('drops the buffer when a new TTS playback starts', () => {
    const engine = mutedEngine(new BargeInDetector(0.022, 3), () => {})
    for (let i = 0; i < 4; i++) engine.onFrame(frame(0.5))
    expect(engine.prerollActive).toBe(true)

    engine.muted = false // simulate unmuted gap without setMuted bookkeeping
    engine.setMuted(true) // next TTS starts -> fresh window
    expect(engine.preroll.length).toBe(0)
    expect(engine.prerollActive).toBe(false)
  })
})

describe('voice WAV encoding', () => {
  it('downsamples captured audio to the requested rate by averaging source intervals', () => {
    const samples = new Float32Array([0, 3, 6, 9, 12, 15])

    expect([...resampleMono(samples, 6, 2)]).toEqual([3, 12])
  })

  it('writes 16 kHz mono headers by default', () => {
    const wav = encodeWavPCM16([new Float32Array(48)], 48_000)
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)

    expect(view.getUint32(24, true)).toBe(STT_SAMPLE_RATE)
    expect(view.getUint32(40, true)).toBe(32) // 48 kHz -> 16 kHz: 16 PCM16 samples
  })
})
