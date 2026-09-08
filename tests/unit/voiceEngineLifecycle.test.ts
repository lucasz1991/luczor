import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceEngine, type VoiceEngineOptions } from '@/services/voice/voiceEngine'
import { setStatus } from '@/state/hud'
const audioMatch = vi.hoisted(() => vi.fn(() => false))
vi.mock('@/services/voice/audioTriggers', () => ({ matchAudioTrigger: audioMatch }))

vi.mock('@/state/hud', () => ({ setMicLevel: vi.fn(), pulse: vi.fn(), setStatus: vi.fn() }))
vi.mock('@/services/voice/wav', () => ({
  chunksToWavBase64: (frames: Float32Array[], sampleRate: number) =>
    JSON.stringify({ samples: frames.reduce((count, frame) => count + frame.length, 0), sampleRate }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function flush() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

function mediaStream() {
  const stop = vi.fn()
  return { stream: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  static suspended = false
  static resumePromise: Promise<void> = Promise.resolve()
  sampleRate = 48_000
  state = FakeAudioContext.suspended ? 'suspended' : 'running'
  destination = {}
  source = { connect: vi.fn(), disconnect: vi.fn() }
  processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null as unknown }
  close = vi.fn(async () => {
    this.state = 'closed'
  })
  resume = vi.fn(() => FakeAudioContext.resumePromise)
  constructor() {
    FakeAudioContext.instances.push(this)
  }
  createMediaStreamSource() {
    return this.source
  }
  createScriptProcessor() {
    return this.processor
  }
}

type CaptureHarness = {
  onFrame: (input: Float32Array) => void
  finalQueue: { frames: Float32Array[] }[]
  segment: Float32Array[]
}

const engines: VoiceEngine[] = []
let getUserMedia: ReturnType<typeof vi.fn>
let firstStream: ReturnType<typeof mediaStream>

function options(overrides: Partial<VoiceEngineOptions> = {}): VoiceEngineOptions {
  return {
    mode: 'continuous',
    handsFree: {
      strategy: 'continuous',
      triggerPhrase: '',
      endPhrase: '',
      continuousSilenceMs: Number.MAX_SAFE_INTEGER,
    },
    transcribe: vi.fn(async () => 'Hallo'),
    onCommand: vi.fn(),
    onPartial: vi.fn(),
    onUtterance: vi.fn(),
    onError: vi.fn(),
    onStateChange: vi.fn(),
    ...overrides,
  }
}

function newEngine() {
  const engine = new VoiceEngine()
  engines.push(engine)
  return engine
}

function frames(engine: VoiceEngine, count: number, volume = 0.1) {
  const harness = engine as unknown as CaptureHarness
  // 100 ms frames make snapshot/queue limits exact without wall-clock sleeps.
  for (let index = 0; index < count; index++) harness.onFrame(new Float32Array(4800).fill(volume))
}

function shortSegment(engine: VoiceEngine) {
  frames(engine, 3)
  frames(engine, 9, 0)
}

beforeEach(() => {
  vi.useFakeTimers()
  audioMatch.mockReset().mockReturnValue(false)
  FakeAudioContext.instances = []
  FakeAudioContext.suspended = false
  FakeAudioContext.resumePromise = Promise.resolve()
  firstStream = mediaStream()
  getUserMedia = vi.fn(async () => firstStream.stream)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('AudioContext', FakeAudioContext)
})

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('local STT live snapshots', () => {
  it('routes recorded audio cues without transcribing ambient speech or adding control words to the draft', async () => {
    const engine = newEngine()
    const opts = options({
      mode: 'wakeword',
      audioTriggers: { enabled: true },
      handsFree: {
        strategy: 'safeword',
        triggerPhrase: '',
        endPhrase: '',
        endMode: 'either',
        continuousSilenceMs: 5000,
      },
    })
    await engine.start(opts)
    shortSegment(engine)
    await flush()
    expect(opts.transcribe).not.toHaveBeenCalled()
    audioMatch.mockReturnValueOnce(true)
    shortSegment(engine)
    await flush()
    expect(opts.transcribe).not.toHaveBeenCalled()
    shortSegment(engine)
    await flush()
    expect(opts.onPartial).toHaveBeenLastCalledWith('Hallo')
    audioMatch.mockReturnValueOnce(true)
    shortSegment(engine)
    await flush()
    expect(opts.onCommand).toHaveBeenCalledExactlyOnceWith('Hallo', 'close_word')
    shortSegment(engine)
    await flush()
    expect(opts.transcribe).toHaveBeenCalledOnce()
  })
  it('preserves committed segments when an empty final retracts only the latest preview', async () => {
    const engine = newEngine()
    const opts = options({
      transcribe: vi
        .fn()
        .mockResolvedValueOnce('Bestätigter Satz')
        .mockResolvedValueOnce('Vermutung')
        .mockResolvedValueOnce('[BLANK_AUDIO]'),
    })
    await engine.start(opts)
    shortSegment(engine)
    await flush()
    frames(engine, 13)
    await flush()
    expect(opts.onPartial).toHaveBeenLastCalledWith('Bestätigter Satz Vermutung')
    frames(engine, 9, 0)
    await flush()
    expect(opts.onPartial).toHaveBeenLastCalledWith('Bestätigter Satz')
    expect(opts.onUtterance).toHaveBeenCalledExactlyOnceWith('Bestätigter Satz')
  })

  it.each(['interim', 'final'])('retracts a speculative preview when the next %s contains no speech', async kind => {
    const engine = newEngine()
    const opts = options({
      transcribe: vi.fn().mockResolvedValueOnce('Vermuteter Text').mockResolvedValueOnce('[BLANK_AUDIO]'),
    })
    await engine.start(opts)
    frames(engine, 13)
    await flush()
    expect(opts.onPartial).toHaveBeenLastCalledWith('Vermuteter Text')
    if (kind === 'interim') frames(engine, 13)
    else frames(engine, 9, 0)
    await flush()
    expect(opts.onPartial).toHaveBeenLastCalledWith('')
    expect(opts.onCommand).not.toHaveBeenCalled()
  })

  it('replaces interim hypotheses and commits one final transcript without duplicate words', async () => {
    const engine = newEngine()
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce('Hallo')
      .mockResolvedValueOnce('Hallo Welt')
      .mockResolvedValueOnce('Hallo Welt heute')
    const opts = options({ transcribe })
    await engine.start(opts)

    frames(engine, 13)
    await flush()
    expect(opts.onPartial).toHaveBeenLastCalledWith('Hallo')
    expect(opts.onCommand).not.toHaveBeenCalled()
    expect(opts.onUtterance).not.toHaveBeenCalled()

    frames(engine, 13)
    await flush()
    expect(opts.onPartial).toHaveBeenLastCalledWith('Hallo Welt')
    await engine.finalize()

    expect(transcribe).toHaveBeenCalledTimes(3)
    expect(opts.onUtterance).toHaveBeenCalledExactlyOnceWith('Hallo Welt heute')
    expect(opts.onCommand).toHaveBeenCalledExactlyOnceWith('Hallo Welt heute', 'manual')
    expect(engine.isRunning).toBe(false)
  })

  it('continues capture during STT and prioritizes queued finals before newer previews', async () => {
    const engine = newEngine()
    const first = deferred<string>()
    const final = deferred<string>()
    const next = deferred<string>()
    const transcribe = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(final.promise)
      .mockReturnValueOnce(next.promise)
    const opts = options({ transcribe })
    await engine.start(opts)
    frames(engine, 13)
    await flush()
    frames(engine, 9, 0)
    frames(engine, 13)
    expect(transcribe).toHaveBeenCalledTimes(1)

    first.resolve('Veraltete Vorschau')
    await flush()
    expect(opts.onPartial).not.toHaveBeenCalled()
    expect(transcribe).toHaveBeenCalledTimes(2)
    expect(JSON.parse(transcribe.mock.calls[1]![0]).samples).toBe(22 * 4800)

    final.resolve('Erster Abschnitt')
    await flush()
    expect(opts.onPartial).toHaveBeenLastCalledWith('Erster Abschnitt')
    expect(transcribe).toHaveBeenCalledTimes(3)
    expect(JSON.parse(transcribe.mock.calls[2]![0]).samples).toBe(13 * 4800)
    next.resolve('Zweiter Abschnitt')
    await flush()
    expect(opts.onPartial).toHaveBeenLastCalledWith('Erster Abschnitt Zweiter Abschnitt')
    expect(opts.onCommand).not.toHaveBeenCalled()
  })

  it('does not submit an interim close phrase, only the confirmed final', async () => {
    const engine = newEngine()
    const opts = options({
      transcribe: vi
        .fn()
        .mockResolvedValueOnce('Luczor prüfe den Plan Ende')
        .mockResolvedValueOnce('Luczor prüfe den Plan Ende'),
      handsFree: { strategy: 'safeword', triggerPhrase: 'luczor', endPhrase: 'ende', continuousSilenceMs: 5000 },
    })
    await engine.start(opts)
    frames(engine, 13)
    await flush()
    expect(opts.onPartial).toHaveBeenLastCalledWith('prüfe den Plan')
    expect(opts.onCommand).not.toHaveBeenCalled()
    frames(engine, 9, 0)
    await flush()
    expect(opts.onCommand).toHaveBeenCalledExactlyOnceWith('prüfe den Plan', 'close_word')
  })

  it('preserves the close-word reason through aliases and control phrases split across final segments', async () => {
    const engine = newEngine()
    const opts = options({
      transcribe: vi
        .fn()
        .mockResolvedValueOnce('Nebengespräch Hey Lutz')
        .mockResolvedValueOnce('Or Start sende Grüße Luczor')
        .mockResolvedValueOnce('bitte SCHLIESSEN!'),
      handsFree: {
        strategy: 'safeword',
        triggerPhrase: 'hey luczor start',
        endPhrase: 'luczor bitte schließen',
        continuousSilenceMs: 5000,
      },
    })
    await engine.start(opts)
    shortSegment(engine)
    await flush()
    expect(opts.onCommand).not.toHaveBeenCalled()
    shortSegment(engine)
    await flush()
    expect(opts.onPartial).toHaveBeenLastCalledWith('sende Grüße')
    expect(opts.onCommand).not.toHaveBeenCalled()
    shortSegment(engine)
    await flush()
    expect(opts.onCommand).toHaveBeenCalledExactlyOnceWith('sende Grüße', 'close_word')
    await engine.finalize()
    expect(opts.onCommand).toHaveBeenCalledOnce()
  })

  it('does not preserve a speculative split close reason after the final transcript revises it away', async () => {
    const engine = newEngine()
    const opts = options({
      transcribe: vi
        .fn()
        .mockResolvedValueOnce('Luczor Nachricht Lutz')
        .mockResolvedValueOnce('or stopp')
        .mockResolvedValueOnce('oder jemand anders'),
      handsFree: {
        strategy: 'safeword',
        triggerPhrase: 'luczor',
        endPhrase: 'luczor stopp',
        continuousSilenceMs: 5000,
      },
    })
    await engine.start(opts)
    shortSegment(engine)
    await flush()
    frames(engine, 13)
    await flush()
    expect(opts.onPartial).toHaveBeenLastCalledWith('Nachricht')
    expect(opts.onCommand).not.toHaveBeenCalled()
    await engine.finalize()
    expect(opts.onCommand).toHaveBeenCalledExactlyOnceWith('Nachricht Lutz oder jemand anders', 'manual')
  })

  it.each([
    { mode: 'continuous' as const, segments: ['Text Luczor stopp'] },
    { mode: 'wakeword' as const, segments: ['Luczor Text Luczor stopp'] },
    { mode: 'wakeword' as const, segments: ['Luczor', 'Text Luczor stopp'] },
  ])('does not invent a close-word reason in legacy $mode mode for $segments', async ({ mode, segments }) => {
    const engine = newEngine()
    const transcripts = [...segments]
    const opts = options({ mode, handsFree: undefined, transcribe: vi.fn(async () => transcripts.shift() ?? '') })
    await engine.start(opts)
    for (const _segment of segments) {
      shortSegment(engine)
      await flush()
    }
    expect(opts.onCommand).toHaveBeenCalledExactlyOnceWith('Text Luczor stopp')
    expect(vi.mocked(opts.onCommand).mock.calls[0]?.[1]).toBeUndefined()
  })

  it('bounds each snapshot to 15 seconds and queued finals to 20 seconds', async () => {
    const engine = newEngine()
    const pending = deferred<string>()
    const opts = options({ transcribe: vi.fn(() => pending.promise) })
    await engine.start(opts)
    frames(engine, 13)
    await flush()
    frames(engine, 137) // Final snapshot of first 15-second chunk is queued.
    expect((engine as unknown as CaptureHarness).finalQueue[0]!.frames).toHaveLength(150)
    frames(engine, 150) // Another 15 seconds would exceed the 20-second queued-audio cap.
    expect(engine.isRunning).toBe(false)
    expect(opts.onError).toHaveBeenCalledTimes(1)
    expect((engine as unknown as CaptureHarness).finalQueue).toHaveLength(0)
    expect((engine as unknown as CaptureHarness).segment).toHaveLength(0)
    pending.resolve('Darf nicht erscheinen')
    await flush()
    expect(opts.onPartial).not.toHaveBeenCalled()
  })

  it('fails visibly on queue overflow instead of dropping speech silently', async () => {
    const engine = newEngine()
    const pending = deferred<string>()
    const opts = options({ transcribe: vi.fn(() => pending.promise) })
    await engine.start(opts)
    shortSegment(engine)
    await flush()
    shortSegment(engine)
    shortSegment(engine)
    expect(engine.isRunning).toBe(true)
    shortSegment(engine)
    expect(engine.isRunning).toBe(false)
    expect(opts.onStateChange).toHaveBeenLastCalledWith('error')
    expect(opts.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'voice_backlog', message: expect.stringContaining('kommt nicht nach') })
    )
    expect(firstStream.stop).toHaveBeenCalledOnce()
    pending.resolve('Darf nicht erscheinen')
    await flush()
    expect(opts.onCommand).not.toHaveBeenCalled()
  })

  it('does not finalize committed text during newly captured speech or pending STT', async () => {
    const engine = newEngine()
    const pending = deferred<string>()
    const opts = options({
      transcribe: vi.fn().mockResolvedValueOnce('Erster Satz').mockReturnValueOnce(pending.promise),
      handsFree: { strategy: 'continuous', triggerPhrase: '', endPhrase: '', continuousSilenceMs: 1000 },
    })
    await engine.start(opts)
    shortSegment(engine)
    await flush()
    frames(engine, 3)
    await vi.advanceTimersByTimeAsync(2000)
    expect(opts.onCommand).not.toHaveBeenCalled()
    frames(engine, 9, 0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(opts.onCommand).not.toHaveBeenCalled()
    pending.resolve('Zweiter Satz')
    await flush()
    await vi.advanceTimersByTimeAsync(1250)
    expect(opts.onCommand).toHaveBeenCalledExactlyOnceWith('Erster Satz Zweiter Satz', 'silence')
  })
})

describe('voice capture lifecycle', () => {
  it('does not overwrite the TTS HUD when muted capture stops', async () => {
    const engine = newEngine()
    const opts = options()
    await engine.start(opts)
    engine.setMuted(true)
    vi.mocked(setStatus).mockClear()
    await engine.stop()
    expect(setStatus).not.toHaveBeenCalled()
    expect(opts.onStateChange).toHaveBeenLastCalledWith('stopped')
  })

  it('releases microphone permission acquired after stop without starting audio capture', async () => {
    const granted = deferred<MediaStream>()
    getUserMedia.mockReturnValueOnce(granted.promise)
    const engine = newEngine()
    const opts = options()
    const starting = engine.start(opts)
    await engine.stop()
    vi.mocked(opts.onStateChange!).mockClear()
    granted.resolve(firstStream.stream)
    await starting
    expect(firstStream.stop).toHaveBeenCalledOnce()
    expect(FakeAudioContext.instances).toHaveLength(0)
    expect(opts.onStateChange).not.toHaveBeenCalled()
    expect(engine.isRunning).toBe(false)
  })

  it('releases an older pending stream without interrupting a replacement session', async () => {
    const granted = deferred<MediaStream>()
    const replacement = mediaStream()
    getUserMedia.mockReturnValueOnce(granted.promise).mockResolvedValueOnce(replacement.stream)
    const engine = newEngine()
    const old = options()
    const starting = engine.start(old)
    await engine.stop()
    const current = options()
    await engine.start(current)
    granted.resolve(firstStream.stream)
    await starting
    expect(engine.isRunning).toBe(true)
    expect(firstStream.stop).toHaveBeenCalledOnce()
    expect(replacement.stop).not.toHaveBeenCalled()
    expect(current.onStateChange).toHaveBeenCalledExactlyOnceWith('armed')
  })

  it('releases an AudioContext whose asynchronous resume finishes after stop', async () => {
    const resumed = deferred<void>()
    FakeAudioContext.suspended = true
    FakeAudioContext.resumePromise = resumed.promise
    const engine = newEngine()
    const opts = options()
    const starting = engine.start(opts)
    await flush()
    expect(FakeAudioContext.instances).toHaveLength(1)
    await engine.stop()
    expect(firstStream.stop).toHaveBeenCalledOnce()
    expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalledOnce()
    resumed.resolve()
    await starting
    expect(firstStream.stop).toHaveBeenCalledOnce()
    expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalledOnce()
    expect(engine.isRunning).toBe(false)
  })

  it('keeps one native inference in flight across stop/start and suppresses old callbacks', async () => {
    const engine = newEngine()
    const pending = deferred<string>()
    const old = options({ transcribe: vi.fn(() => pending.promise) })
    await engine.start(old)
    frames(engine, 13)
    await flush()
    await engine.stop()
    const current = options()
    await engine.start(current)
    frames(engine, 13)
    await flush()
    expect(current.transcribe).not.toHaveBeenCalled()
    pending.resolve('Alter privater Text')
    await flush()
    expect(old.onPartial).not.toHaveBeenCalled()
    expect(old.onCommand).not.toHaveBeenCalled()
    expect(old.onError).not.toHaveBeenCalled()
    expect(current.transcribe).toHaveBeenCalledOnce()
    expect(current.onPartial).toHaveBeenLastCalledWith('Hallo')
  })

  it('invalidates pre-playback STT even after mute is lifted', async () => {
    const engine = newEngine()
    const pending = deferred<string>()
    const opts = options({
      transcribe: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce('Neuer Text'),
    })
    await engine.start(opts)
    frames(engine, 13)
    await flush()
    engine.setMuted(true)
    engine.setMuted(false)
    frames(engine, 13)
    pending.resolve('Alter Text vor TTS')
    await flush()
    expect(opts.onPartial).toHaveBeenCalledExactlyOnceWith('Neuer Text')
    expect(opts.onUtterance).not.toHaveBeenCalled()
  })

  it('stops without erasing the caller-owned visible draft and suppresses stale failures', async () => {
    const engine = newEngine()
    const pending = deferred<string>()
    const opts = options({
      transcribe: vi.fn().mockResolvedValueOnce('Sichtbarer Entwurf').mockReturnValueOnce(pending.promise),
    })
    await engine.start(opts)
    shortSegment(engine)
    await flush()
    expect(opts.onPartial).toHaveBeenLastCalledWith('Sichtbarer Entwurf')
    shortSegment(engine)
    await flush()
    await engine.stop()
    pending.reject(new Error('private native diagnostic'))
    await flush()
    expect(opts.onPartial).toHaveBeenCalledExactlyOnceWith('Sichtbarer Entwurf')
    expect(opts.onError).not.toHaveBeenCalled()
    expect(opts.onCommand).not.toHaveBeenCalled()
  })

  it('rechecks lifecycle after onUtterance stops capture', async () => {
    const engine = newEngine()
    const opts = options({
      onUtterance: () => {
        void engine.stop()
      },
    })
    await engine.start(opts)
    shortSegment(engine)
    await flush()
    expect(opts.onPartial).not.toHaveBeenCalled()
    expect(opts.onCommand).not.toHaveBeenCalled()
  })

  it('exposes sanitized local STT failures and releases microphone resources', async () => {
    const engine = newEngine()
    const opts = options({ transcribe: vi.fn().mockRejectedValue(new Error('PRIVATE TOKEN and file path')) })
    await engine.start(opts)
    shortSegment(engine)
    await flush()
    expect(engine.isRunning).toBe(false)
    expect(firstStream.stop).toHaveBeenCalledOnce()
    expect(opts.onStateChange).toHaveBeenLastCalledWith('error')
    expect(opts.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining('fehlgeschlagen') })
    )
    expect(vi.mocked(opts.onError!).mock.calls[0]![0].message).not.toContain('PRIVATE')
  })
})

describe('explicit PTT finalization', () => {
  it('stops the mic immediately, drains pending finals and current audio, then emits the full draft', async () => {
    const engine = newEngine()
    const preview = deferred<string>()
    const first = deferred<string>()
    const second = deferred<string>()
    const transcribe = vi
      .fn()
      .mockReturnValueOnce(preview.promise)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const opts = options({ transcribe })
    await engine.start(opts)
    frames(engine, 13)
    await flush()
    frames(engine, 9, 0)
    frames(engine, 4)
    const completed = engine.finalize()
    expect(engine.finalize()).toBe(completed)
    expect(firstStream.stop).toHaveBeenCalledOnce()
    frames(engine, 20)
    preview.resolve('Überholte Vorschau')
    await flush()
    expect(opts.onPartial).not.toHaveBeenCalled()
    first.resolve('Erster Teil')
    await flush()
    expect(JSON.parse(transcribe.mock.calls[2]![0]).samples).toBe(4 * 4800)
    second.resolve('Zweiter Teil')
    await completed
    expect(opts.onCommand).toHaveBeenCalledExactlyOnceWith('Erster Teil Zweiter Teil', 'manual')
    expect(engine.isRunning).toBe(false)
    expect(opts.onStateChange).toHaveBeenLastCalledWith('stopped')
  })

  it('does not stop a new capture started by the final command callback', async () => {
    const engine = newEngine()
    const replacement = mediaStream()
    const current = options()
    getUserMedia.mockResolvedValueOnce(firstStream.stream).mockResolvedValueOnce(replacement.stream)
    const opts = options({
      onCommand: () => {
        void engine.stop()
        void engine.start(current)
      },
    })
    await engine.start(opts)
    frames(engine, 4)
    await engine.finalize()
    await flush()
    expect(engine.isRunning).toBe(true)
    expect(replacement.stop).not.toHaveBeenCalled()
    expect(current.onStateChange).toHaveBeenLastCalledWith('armed')
  })

  it('cancels explicit finalization when playback invalidates the audio', async () => {
    const engine = newEngine()
    const pending = deferred<string>()
    const opts = options({ transcribe: vi.fn(() => pending.promise) })
    await engine.start(opts)
    frames(engine, 4)
    const finalized = engine.finalize()
    await flush()
    engine.setMuted(true)
    await finalized
    pending.resolve('Darf nicht erscheinen')
    await flush()
    expect(engine.isRunning).toBe(false)
    expect(opts.onCommand).not.toHaveBeenCalled()
    expect(opts.onPartial).not.toHaveBeenCalled()
  })

  it('settles finalization called while muted without decoding or executing a command', async () => {
    const engine = newEngine()
    const opts = options()
    await engine.start(opts)
    engine.setMuted(true)
    await engine.finalize()
    expect(engine.isRunning).toBe(false)
    expect(opts.transcribe).not.toHaveBeenCalled()
    expect(opts.onCommand).not.toHaveBeenCalled()
  })
})
