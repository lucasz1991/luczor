// src/services/voice/voiceEngine.ts
//
// Continuous listening with voice-activity detection (VAD) + wake-word gating.
//
// The engine captures the mic continuously, segments speech using an energy
// threshold (start on speech, cut after a silence gap), transcribes each
// bounded snapshots via injected local STT, and emits final recognized commands.
// Interim hypotheses replace a preview; they never execute a command.
//
// Modes:
//  - "continuous": every spoken utterance is a command.
//  - "wakeword":   an utterance only becomes a command if it starts with the
//                  wake word; the remainder (or the next utterance) is the
//                  command. This is a pragmatic hotword approach that works
//                  with ANY STT — a dedicated wake-word model (openWakeWord/
//                  Porcupine) can replace this later without touching callers.

import { setMicLevel, pulse, setStatus } from '@/state/hud'
import { chunksToWavBase64 } from './wav'
import { cleanSttTranscript } from './transcript'
import { HandsFreeMachine, type StrategyConfig, type VoiceCompletionReason } from './voiceStrategy'
import { BargeInDetector } from './bargeIn'
import { findWakeWord } from './voicePhrases'

export { findWakeWord } from './voicePhrases'
export type { VoicePhraseMatch as WakeWordMatch } from './voicePhrases'
export type { VoiceCompletionReason } from './voiceStrategy'

export type VoiceEngineMode = 'continuous' | 'wakeword'
export type VoiceEngineState = 'stopped' | 'listening' | 'armed' | 'dictating' | 'transcribing' | 'muted' | 'error'

export type VoiceEngineOptions = {
  mode: VoiceEngineMode
  wakeWord?: string
  /** Transcribe a captured utterance (WAV base64) to text. */
  transcribe: (wavBase64: string, mime: string) => Promise<string>
  /** Final command and its confirmed completion cause; legacy mode has no explicit cause. */
  onCommand: (text: string, reason?: VoiceCompletionReason) => void
  /** Optional: raw transcript of every utterance (for debugging/HUD). */
  onUtterance?: (text: string) => void
  /** Runtime or transcription failures; callers can expose a concise state and retain diagnostics. */
  onError?: (error: Error) => void
  /**
   * SOLL §5.3 — hands-free strategy (continuous XOR safeword). When set, segment
   * handling is driven by the HandsFreeMachine instead of the legacy mode logic.
   */
  handsFree?: StrategyConfig
  /** Live dictation partial (buffer so far) while a hands-free strategy runs. */
  onPartial?: (text: string) => void
  /** SOLL §6 — barge-in: interrupt TTS when the user speaks over it. */
  bargeIn?: boolean
  /** Fired once when sustained speech is detected during TTS playback. */
  onInterrupt?: () => void
  /** Real capture/transcription lifecycle; interim STT is snapshot-based, not token streaming. */
  onStateChange?: (state: VoiceEngineState) => void
}

// VAD tuning (frames are ~85ms at 48kHz / 4096 samples).
const START_RMS = 0.022
const END_RMS = 0.014
const MIN_VOICE_FRAMES = 3 // ~0.25s of speech to count as an utterance
const SILENCE_FRAMES = 9 // ~0.75s of silence ends a segment
const MAX_SEGMENT_SECONDS = 15
const INTERIM_SECONDS = 1.25
const MAX_QUEUED_SECONDS = 20
const MAX_QUEUED_SEGMENTS = 2
// SOLL §5–§7 TTS-Preroll: rolling buffer of mic audio while TTS is audible so a
// barge-in keeps the interrupting words (~0.5s before + everything after the
// interrupt until unmute, capped at ~2s).
const PREROLL_FRAMES = 6
const PREROLL_MAX_FRAMES = 24

type TranscriptionJob = {
  generation: number
  epoch: number
  segmentId: number
  final: boolean
  frames: Float32Array[]
  sampleRate: number
  opts: VoiceEngineOptions
}

export class VoiceEngine {
  private opts: VoiceEngineOptions | null = null
  private stream: MediaStream | null = null
  private audioCtx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private sampleRate = 48000

  private running = false
  private starting = false
  // Retained across stop/start: an old native process must settle before another starts.
  private inFlight: Promise<void> | null = null
  private finalQueue: TranscriptionJob[] = []
  private generation = 0
  private epoch = 0
  private segmentId = 0
  private segmentSamples = 0
  private lastInterimSamples = 0
  private finalizing = false
  private finalization: { promise: Promise<void>; resolve: () => void } | null = null
  private captureClosing: Promise<void> = Promise.resolve()
  private lastState: VoiceEngineState | null = null
  private suppressMachineCallbacks = false
  private muted = false
  private speaking = false
  private segment: Float32Array[] = []
  private voiceFrames = 0
  private silenceCount = 0
  private awaitingCommand = false // wakeword mode: heard the wake word
  private machine: HandsFreeMachine | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private barge: BargeInDetector | null = null
  private preroll: Float32Array[] = []
  private prerollActive = false

  get isRunning() {
    return this.running
  }

  private valid(generation: number, opts: VoiceEngineOptions, epoch?: number): boolean {
    return (
      this.running &&
      this.generation === generation &&
      this.opts === opts &&
      (epoch === undefined || this.epoch === epoch)
    )
  }

  private notifyState(state: VoiceEngineState, opts = this.opts): void {
    if (this.lastState === state) return
    this.lastState = state
    // TTS owns the HUD while playback is active. Update before callbacks, which may start a new session.
    if (!this.muted && state !== 'muted')
      setStatus(
        state === 'stopped' ? 'idle' : state === 'error' ? 'error' : state === 'transcribing' ? 'thinking' : 'listening'
      )
    opts?.onStateChange?.(state)
  }

  private refreshState(): void {
    if (!this.running) return
    this.notifyState(
      this.muted ? 'muted' : this.inFlight || this.finalizing ? 'transcribing' : (this.machine?.state ?? 'listening')
    )
  }

  private resetSegment(): void {
    this.segment = []
    this.segmentSamples = 0
    this.lastInterimSamples = 0
    this.speaking = false
    this.voiceFrames = 0
    this.silenceCount = 0
  }

  /** Temporarily discard microphone input, e.g. while local TTS is audible. */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return

    this.muted = muted
    if (muted) {
      if (this.finalizing) {
        void this.stop() // Playback invalidates a pending explicit finalization, too.
        return
      }
      // Never carry captured audio or a bare wake-word across TTS playback.
      this.epoch++
      this.resetSegment()
      this.finalQueue = []
      this.awaitingCommand = false
      this.suppressMachineCallbacks = true
      this.machine?.reset()
      this.suppressMachineCallbacks = false
      this.barge?.reset() // fresh barge-in window each time TTS starts
      this.preroll = []
      this.prerollActive = false
      setMicLevel(0)
      this.refreshState()
      return
    }

    // TTS-Preroll: after a barge-in, seed the next segment with the speech that
    // was captured while TTS was still audible so the first words are not lost.
    if (this.prerollActive && this.preroll.length) {
      this.segment = this.preroll
      this.segmentId++
      this.segmentSamples = this.segment.reduce((count, frame) => count + frame.length, 0)
      this.lastInterimSamples = 0
      this.speaking = true
      this.voiceFrames = Math.min(this.preroll.length, MIN_VOICE_FRAMES)
      this.silenceCount = 0
    }
    this.preroll = []
    this.prerollActive = false

    this.refreshState()
    this.pump()
  }

  async start(opts: VoiceEngineOptions): Promise<void> {
    if (this.running || this.starting) return
    const generation = ++this.generation
    this.epoch++
    this.starting = true
    this.opts = opts
    this.awaitingCommand = false
    this.resetSegment()
    this.lastState = null
    let acquired: MediaStream | null = null
    let context: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let processor: ScriptProcessorNode | null = null
    let attached = false
    try {
      acquired = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      if (generation !== this.generation || this.opts !== opts) {
        acquired.getTracks().forEach(track => track.stop())
        return
      }
      context = new AudioContext()
      source = context.createMediaStreamSource(acquired)
      processor = context.createScriptProcessor(4096, 1, 1)
      // Attach resources before resume: stop() must release the microphone even if resume never settles.
      this.stream = acquired
      this.audioCtx = context
      this.sampleRate = context.sampleRate
      this.source = source
      this.processor = processor
      attached = true
      if (context.state === 'suspended') await context.resume()
      // stop() already detached/closed the stale resources; do not touch a replacement capture.
      if (generation !== this.generation || this.opts !== opts) return
      this.running = true
      processor.onaudioprocess = event => {
        if (this.valid(generation, opts)) this.onFrame(event.inputBuffer.getChannelData(0))
      }
      source.connect(processor)
      processor.connect(context.destination)
      this.barge = opts.bargeIn && opts.onInterrupt ? new BargeInDetector(START_RMS, 3) : null
      if (opts.handsFree) {
        const allowed = () => this.valid(generation, opts) && !this.muted && !this.suppressMachineCallbacks
        this.machine = new HandsFreeMachine(
          opts.handsFree,
          (text, reason) => {
            if (allowed()) opts.onCommand(text, reason)
          },
          text => {
            if (allowed()) opts.onPartial?.(text)
          },
          () => {
            if (allowed()) this.refreshState()
          }
        )
        this.tickTimer = setInterval(() => {
          // Silence must not submit the previous text while newer audio is still being decoded.
          if (allowed() && !this.speaking && !this.inFlight && !this.finalQueue.length && !this.finalizing) {
            this.machine?.tick(Date.now())
          }
        }, 250)
      }
      this.refreshState()
    } catch (error) {
      if (!attached) {
        acquired?.getTracks().forEach(track => track.stop())
        try {
          processor?.disconnect()
          source?.disconnect()
        } catch {
          /* already disconnected */
        }
        await context?.close().catch(() => undefined)
      }
      if (generation !== this.generation || this.opts !== opts) return
      await this.stop()
      throw error
    } finally {
      if (generation === this.generation) this.starting = false
    }
  }

  stop(): Promise<void> {
    return this.stopSession('stopped')
  }

  private async stopSession(state: 'stopped' | 'error'): Promise<void> {
    const opts = this.opts
    const finalization = this.finalization
    this.generation++
    this.epoch++
    this.starting = false
    this.running = false
    this.finalizing = false
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    // Detach callbacks before resetting. Stopping preserves the visible caller-owned draft.
    this.machine = null
    this.barge = null
    this.finalQueue = []
    this.resetSegment()
    this.preroll = []
    this.prerollActive = false
    setMicLevel(0)
    this.opts = null
    this.finalization = null
    const closing = this.closeCapture()
    this.notifyState(state, opts)
    await closing
    finalization?.resolve()
  }

  /** Stop accepting mic frames, decode bounded pending audio, then explicitly finalize the draft. */
  finalize(): Promise<void> {
    if (this.finalization) return this.finalization.promise
    if (!this.running || !this.opts) return Promise.resolve()
    if (this.muted) return this.stop()
    this.finalizing = true
    let resolve: () => void = () => undefined
    const promise = new Promise<void>(done => {
      resolve = done
    })
    this.finalization = { promise, resolve }
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
    void this.closeCapture()
    this.enqueueCapturedFinal()
    this.pump()
    return promise
  }

  private closeCapture(): Promise<void> {
    const context = this.audioCtx
    if (this.processor) this.processor.onaudioprocess = null
    try {
      this.processor?.disconnect()
      this.source?.disconnect()
    } catch {
      /* already disconnected */
    }
    this.processor = null
    this.source = null
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = null
    this.audioCtx = null
    if (context) this.captureClosing = context.close().catch(() => undefined)
    return this.captureClosing
  }

  private onFrame(input: Float32Array) {
    if (!this.running || this.finalizing || !input.length) return
    if (this.muted) {
      // While Luczor speaks: don't segment, but watch for barge-in and keep a
      // short preroll buffer so an interrupt doesn't swallow the first words.
      if (this.barge) {
        let sum = 0
        for (let i = 0; i < input.length; i++) sum += input[i]! * input[i]!
        const rms = Math.sqrt(sum / input.length)
        this.preroll.push(new Float32Array(input))
        const cap = this.prerollActive ? PREROLL_MAX_FRAMES : PREROLL_FRAMES
        while (this.preroll.length > cap) this.preroll.shift()
        if (!this.prerollActive && this.barge.push(rms)) {
          this.barge.reset()
          this.prerollActive = true
          this.opts?.onInterrupt?.()
        }
      }
      setMicLevel(0)
      return
    }

    let sum = 0
    for (let i = 0; i < input.length; i++) sum += input[i]! * input[i]!
    const rms = Math.sqrt(sum / input.length)

    setMicLevel(Math.min(1, rms * 4))
    if (rms > START_RMS) pulse('audio', Math.min(1, rms * 4))

    // Capture continues while local STT runs. Only decoding is single-flight.
    if (rms > END_RMS) this.machine?.touchSpeech(Date.now())

    if (!this.speaking) {
      if (rms > START_RMS) {
        this.speaking = true
        this.segment = [new Float32Array(input)]
        this.segmentId++
        this.segmentSamples = input.length
        this.lastInterimSamples = 0
        this.voiceFrames = 1
        this.silenceCount = 0
      }
      return
    }

    // speaking
    this.segment.push(new Float32Array(input))
    this.segmentSamples += input.length
    if (rms > END_RMS) {
      this.voiceFrames++
      this.silenceCount = 0
    } else {
      this.silenceCount++
    }

    if (this.silenceCount >= SILENCE_FRAMES || this.segmentSamples >= this.sampleRate * MAX_SEGMENT_SECONDS) {
      this.enqueueCapturedFinal()
    }
    this.pump()
  }

  private enqueueCapturedFinal(): void {
    const opts = this.opts
    if (!opts || !this.running) return
    const frames = this.segment
    const voiced = this.voiceFrames
    const segmentId = this.segmentId
    this.resetSegment()
    if (voiced < MIN_VOICE_FRAMES) return
    const queuedSeconds = this.finalQueue.reduce(
      (seconds, job) => seconds + job.frames.reduce((samples, frame) => samples + frame.length, 0) / job.sampleRate,
      0
    )
    const duration = frames.reduce((samples, frame) => samples + frame.length, 0) / this.sampleRate
    if (this.finalQueue.length >= MAX_QUEUED_SEGMENTS || queuedSeconds + duration > MAX_QUEUED_SECONDS) {
      this.failCapture(
        Object.assign(
          new Error(
            'Die lokale Spracherkennung kommt nicht nach. Aufnahme gestoppt; bisheriger Text bleibt erhalten. Bitte den letzten Abschnitt wiederholen.'
          ),
          { code: 'voice_backlog' }
        )
      )
      return
    }
    this.finalQueue.push({
      generation: this.generation,
      epoch: this.epoch,
      segmentId,
      final: true,
      frames,
      sampleRate: this.sampleRate,
      opts,
    })
  }

  private pump(): void {
    if (this.inFlight || !this.running || this.muted || !this.opts) return
    let job = this.finalQueue.shift()
    if (
      !job &&
      !this.finalizing &&
      this.speaking &&
      this.voiceFrames >= MIN_VOICE_FRAMES &&
      this.segmentSamples - this.lastInterimSamples >= this.sampleRate * INTERIM_SECONDS
    ) {
      this.lastInterimSamples = this.segmentSamples
      job = {
        generation: this.generation,
        epoch: this.epoch,
        segmentId: this.segmentId,
        final: false,
        frames: this.segment.slice(),
        sampleRate: this.sampleRate,
        opts: this.opts,
      }
    }
    if (!job) {
      if (this.finalizing) this.completeFinalization()
      else this.refreshState()
      return
    }
    // Reserve the single-flight slot before invoking injected code (which may call back synchronously).
    const pending = Promise.resolve().then(() => this.transcribeJob(job))
    this.inFlight = pending
    this.refreshState()
    void pending.finally(() => {
      if (this.inFlight === pending) {
        this.inFlight = null
        this.refreshState()
        this.pump()
      }
    })
  }

  private async transcribeJob(job: TranscriptionJob): Promise<void> {
    const { opts, generation, epoch } = job
    if (!this.valid(generation, opts, epoch) || this.muted) return
    try {
      const wav = chunksToWavBase64(job.frames, job.sampleRate)
      job.frames = [] // Do not retain raw frames in addition to the bounded WAV during native inference.
      const text = cleanSttTranscript(await opts.transcribe(wav, 'audio/wav'))
      if (!this.valid(generation, opts, epoch) || this.muted) return
      if (!job.final) {
        // Once the final snapshot exists, an older hypothesis must not overwrite its draft.
        if (!this.speaking || this.finalizing || this.segmentId !== job.segmentId) return
        if (this.machine) this.machine.previewSegment(text)
        else if (opts.mode === 'continuous') opts.onPartial?.(text)
        return
      }
      if (!text) {
        // A rejected/no-speech final must retract its speculative preview while preserving committed text.
        if (this.machine) this.machine.pushSegment('', Date.now())
        else opts.onPartial?.('')
        return
      }
      opts.onUtterance?.(text)
      if (!this.valid(generation, opts, epoch) || this.muted) return

      // SOLL §5.3 — hands-free strategy machine owns segment routing when set.
      if (this.machine) {
        this.machine.pushSegment(text, Date.now())
        return
      }

      if (opts.mode === 'continuous') {
        opts.onCommand(text)
        return
      }

      // wakeword mode
      if (this.awaitingCommand) {
        this.awaitingCommand = false
        opts.onCommand(text)
        return
      }

      const wakeMatch = findWakeWord(text, opts.wakeWord ?? 'luczor')
      if (!wakeMatch) return // no wake word -> ignore

      const remainder = text
        .slice(wakeMatch.end)
        .replace(/^[\s,.:;!?-]+/, '')
        .trim()
      if (remainder.length >= 2) {
        opts.onCommand(remainder)
      } else {
        // Wake word only -> next utterance is the command.
        this.awaitingCommand = true
      }
    } catch {
      if (this.valid(generation, opts, epoch) && !this.muted) {
        this.failCapture(
          new Error(
            'Die lokale Spracherkennung ist fehlgeschlagen. Bisheriger Text bleibt erhalten; bitte den letzten Abschnitt erneut aufnehmen.'
          )
        )
      }
    }
  }

  private completeFinalization(): void {
    const pending = this.finalization
    const opts = this.opts
    const generation = this.generation
    if (!pending || !opts || !this.running || this.muted) return
    this.finalization = null
    try {
      this.machine?.finalize()
    } finally {
      // A final callback can stop/restart capture. Never close the newly started session.
      if (this.valid(generation, opts)) void this.stop().then(pending.resolve, pending.resolve)
      else pending.resolve()
    }
  }

  private failCapture(error: Error): void {
    const opts = this.opts
    const stoppedGeneration = this.generation + 1
    void this.stopSession('error')
    if (this.generation === stoppedGeneration && !this.running) opts?.onError?.(error)
  }
}
