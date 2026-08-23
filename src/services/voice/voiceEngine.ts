// src/services/voice/voiceEngine.ts
//
// Continuous listening with voice-activity detection (VAD) + wake-word gating.
//
// The engine captures the mic continuously, segments speech using an energy
// threshold (start on speech, cut after a silence gap), transcribes each
// segment via an injected `transcribe()` (cloud or local STT), and emits
// recognized commands.
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
import { HandsFreeMachine, type StrategyConfig } from './voiceStrategy'
import { BargeInDetector } from './bargeIn'

export type VoiceEngineMode = 'continuous' | 'wakeword'

export type VoiceEngineOptions = {
  mode: VoiceEngineMode
  wakeWord?: string
  /** Transcribe a captured utterance (WAV base64) to text. */
  transcribe: (wavBase64: string, mime: string) => Promise<string>
  /** Called with a recognized command (post wake-word for wakeword mode). */
  onCommand: (text: string) => void
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
}

// VAD tuning (frames are ~85ms at 48kHz / 4096 samples).
const START_RMS = 0.022
const END_RMS = 0.014
const MIN_VOICE_FRAMES = 3 // ~0.25s of speech to count as an utterance
const SILENCE_FRAMES = 9 // ~0.75s of silence ends a segment
const MAX_SEGMENT_FRAMES = 240 // ~20s hard cap
// SOLL §5–§7 TTS-Preroll: rolling buffer of mic audio while TTS is audible so a
// barge-in keeps the interrupting words (~0.5s before + everything after the
// interrupt until unmute, capped at ~2s).
const PREROLL_FRAMES = 6
const PREROLL_MAX_FRAMES = 24

// Whisper commonly transcribes the product name as one of these near-homophones.
// Keep aliases scoped to Luczor so a custom wake word keeps its exact semantics.
const LUCZOR_WAKE_ALIASES = ['luczor', 'luxor', 'lucor', 'lutzor', 'lukzor', 'luksor', 'lutz or']

type WakeWordToken = { normalized: string; start: number; end: number }

export type WakeWordMatch = { start: number; end: number; matched: string }

function normalizeWakeText(value: string): string {
  return value
    .toLocaleLowerCase('de-DE')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenizeWakeText(text: string): WakeWordToken[] {
  const tokens: WakeWordToken[] = []
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const raw = match[0] ?? ''
    const normalized = normalizeWakeText(raw)
    const start = match.index
    if (normalized && start !== undefined) {
      tokens.push({ normalized, start, end: start + raw.length })
    }
  }
  return tokens
}

function isAtMostOneEditAway(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false

  let leftIndex = 0
  let rightIndex = 0
  let edits = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex++
      rightIndex++
      continue
    }

    edits++
    if (edits > 1) return false
    if (left.length > right.length) leftIndex++
    else if (right.length > left.length) rightIndex++
    else {
      leftIndex++
      rightIndex++
    }
  }

  return edits + (left.length - leftIndex) + (right.length - rightIndex) <= 1
}

function wakeTokensMatch(transcriptToken: string, candidateToken: string): boolean {
  if (transcriptToken === candidateToken) return true
  // Avoid turning ordinary short words into wake words. The configured Luczor
  // name is long enough that a single edit remains useful and predictable.
  return (
    transcriptToken.length >= 4 && candidateToken.length >= 5 && isAtMostOneEditAway(transcriptToken, candidateToken)
  )
}

function wakeCandidates(wakeWord: string): string[][] {
  const requested = normalizeWakeText(wakeWord)
  if (!requested) return []

  const candidates = new Set([requested])
  if (requested === 'luczor' || LUCZOR_WAKE_ALIASES.includes(requested)) {
    for (const alias of LUCZOR_WAKE_ALIASES) candidates.add(normalizeWakeText(alias))
  }

  return [...candidates].map(candidate => candidate.split(' '))
}

/** Finds a configured wake word (including Luczor STT aliases) in original-text offsets. */
export function findWakeWord(text: string, wakeWord = 'luczor'): WakeWordMatch | null {
  const words = tokenizeWakeText(text)
  const candidates = wakeCandidates(wakeWord)

  for (let start = 0; start < words.length; start++) {
    for (const candidate of candidates) {
      if (start + candidate.length > words.length) continue
      if (!candidate.every((part, offset) => wakeTokensMatch(words[start + offset]!.normalized, part))) continue

      const first = words[start]!
      const last = words[start + candidate.length - 1]!
      return { start: first.start, end: last.end, matched: candidate.join(' ') }
    }
  }

  return null
}

export class VoiceEngine {
  private opts: VoiceEngineOptions | null = null
  private stream: MediaStream | null = null
  private audioCtx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private sampleRate = 48000

  private running = false
  private busy = false // transcription in flight
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

  /** Temporarily discard microphone input, e.g. while local TTS is audible. */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return

    this.muted = muted
    if (muted) {
      // Never carry captured audio or a bare wake-word across TTS playback.
      this.segment = []
      this.speaking = false
      this.voiceFrames = 0
      this.silenceCount = 0
      this.awaitingCommand = false
      this.machine?.reset()
      this.barge?.reset() // fresh barge-in window each time TTS starts
      this.preroll = []
      this.prerollActive = false
      setMicLevel(0)
      return
    }

    // TTS-Preroll: after a barge-in, seed the next segment with the speech that
    // was captured while TTS was still audible so the first words are not lost.
    if (this.prerollActive && this.preroll.length) {
      this.segment = this.preroll
      this.speaking = true
      this.voiceFrames = Math.min(this.preroll.length, MIN_VOICE_FRAMES)
      this.silenceCount = 0
    }
    this.preroll = []
    this.prerollActive = false

    if (this.running && !this.busy) setStatus('listening')
  }

  async start(opts: VoiceEngineOptions): Promise<void> {
    if (this.running) return
    this.opts = opts
    this.awaitingCommand = false

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })
    this.audioCtx = new AudioContext()
    this.sampleRate = this.audioCtx.sampleRate
    this.source = this.audioCtx.createMediaStreamSource(this.stream)
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1)
    this.processor.onaudioprocess = e => this.onFrame(e.inputBuffer.getChannelData(0))
    this.source.connect(this.processor)
    this.processor.connect(this.audioCtx.destination)

    this.running = true
    setStatus('listening')

    // SOLL §6 — barge-in detector (≈0.25s of speech over TTS -> interrupt).
    if (opts.bargeIn && opts.onInterrupt) {
      this.barge = new BargeInDetector(START_RMS, 3)
    }

    // SOLL §5.3 — drive continuous/safeword dictation via the state machine.
    if (opts.handsFree) {
      this.machine = new HandsFreeMachine(opts.handsFree, opts.onCommand, opts.onPartial)
      this.tickTimer = setInterval(() => {
        if (this.running && !this.muted) this.machine?.tick(Date.now())
      }, 500)
    }
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    this.machine?.reset()
    this.machine = null
    this.barge = null
    try {
      this.processor?.disconnect()
      this.source?.disconnect()
    } catch {
      /* ignore */
    }
    this.processor = null
    this.source = null
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
    try {
      await this.audioCtx?.close()
    } catch {
      /* ignore */
    }
    this.audioCtx = null
    this.segment = []
    this.speaking = false
    this.voiceFrames = 0
    this.silenceCount = 0
    this.preroll = []
    this.prerollActive = false
    setMicLevel(0)
    setStatus('idle')
  }

  private onFrame(input: Float32Array) {
    if (!this.running) return
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
        if (this.barge.push(rms)) {
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

    // While a transcription is in flight, don't start a new segment.
    if (this.busy) return

    if (!this.speaking) {
      if (rms > START_RMS) {
        this.speaking = true
        this.segment = [new Float32Array(input)]
        this.voiceFrames = 1
        this.silenceCount = 0
      }
      return
    }

    // speaking
    this.segment.push(new Float32Array(input))
    if (rms > END_RMS) {
      this.voiceFrames++
      this.silenceCount = 0
    } else {
      this.silenceCount++
    }

    if (this.silenceCount >= SILENCE_FRAMES || this.segment.length >= MAX_SEGMENT_FRAMES) {
      const voiced = this.voiceFrames
      const seg = this.segment
      this.speaking = false
      this.segment = []
      this.voiceFrames = 0
      this.silenceCount = 0

      if (voiced >= MIN_VOICE_FRAMES) {
        void this.finishSegment(seg)
      }
    }
  }

  private async finishSegment(seg: Float32Array[]): Promise<void> {
    const opts = this.opts
    if (!opts || !this.running) return

    this.busy = true
    setStatus('thinking')
    pulse('network', 0.6)
    try {
      const wav = chunksToWavBase64(seg, this.sampleRate)
      const text = cleanSttTranscript(await opts.transcribe(wav, 'audio/wav'))
      // A request that began just before TTS must not yield an echo command.
      if (!text || !this.running || this.muted) return
      opts.onUtterance?.(text)
      if (!this.running || this.muted) return

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
    } catch (e) {
      console.error('[VoiceEngine] segment failed:', e)
      opts.onError?.(e instanceof Error ? e : new Error(String(e)))
    } finally {
      this.busy = false
      if (this.running) setStatus('listening')
    }
  }
}
