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

import { setMicLevel, pulse, setStatus } from "@/state/hud";
import { chunksToWavBase64 } from "./wav";

export type VoiceEngineMode = "continuous" | "wakeword";

export type VoiceEngineOptions = {
  mode: VoiceEngineMode;
  wakeWord?: string;
  /** Transcribe a captured utterance (WAV base64) to text. */
  transcribe: (wavBase64: string, mime: string) => Promise<string>;
  /** Called with a recognized command (post wake-word for wakeword mode). */
  onCommand: (text: string) => void;
  /** Optional: raw transcript of every utterance (for debugging/HUD). */
  onUtterance?: (text: string) => void;
  /** Runtime or transcription failures; callers can expose a concise state and retain diagnostics. */
  onError?: (error: Error) => void;
};

// VAD tuning (frames are ~85ms at 48kHz / 4096 samples).
const START_RMS = 0.022;
const END_RMS = 0.014;
const MIN_VOICE_FRAMES = 3; // ~0.25s of speech to count as an utterance
const SILENCE_FRAMES = 9; // ~0.75s of silence ends a segment
const MAX_SEGMENT_FRAMES = 240; // ~20s hard cap

export class VoiceEngine {
  private opts: VoiceEngineOptions | null = null;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sampleRate = 48000;

  private running = false;
  private busy = false; // transcription in flight
  private speaking = false;
  private segment: Float32Array[] = [];
  private voiceFrames = 0;
  private silenceCount = 0;
  private awaitingCommand = false; // wakeword mode: heard the wake word

  get isRunning() {
    return this.running;
  }

  async start(opts: VoiceEngineOptions): Promise<void> {
    if (this.running) return;
    this.opts = opts;
    this.awaitingCommand = false;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.audioCtx = new AudioContext();
    this.sampleRate = this.audioCtx.sampleRate;
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => this.onFrame(e.inputBuffer.getChannelData(0));
    this.source.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);

    this.running = true;
    setStatus("listening");
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    this.processor = null;
    this.source = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try {
      await this.audioCtx?.close();
    } catch {
      /* ignore */
    }
    this.audioCtx = null;
    this.segment = [];
    this.speaking = false;
    this.voiceFrames = 0;
    this.silenceCount = 0;
    setMicLevel(0);
    setStatus("idle");
  }

  private onFrame(input: Float32Array) {
    if (!this.running) return;

    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i]! * input[i]!;
    const rms = Math.sqrt(sum / input.length);

    setMicLevel(Math.min(1, rms * 4));
    if (rms > START_RMS) pulse("audio", Math.min(1, rms * 4));

    // While a transcription is in flight, don't start a new segment.
    if (this.busy) return;

    if (!this.speaking) {
      if (rms > START_RMS) {
        this.speaking = true;
        this.segment = [new Float32Array(input)];
        this.voiceFrames = 1;
        this.silenceCount = 0;
      }
      return;
    }

    // speaking
    this.segment.push(new Float32Array(input));
    if (rms > END_RMS) {
      this.voiceFrames++;
      this.silenceCount = 0;
    } else {
      this.silenceCount++;
    }

    if (this.silenceCount >= SILENCE_FRAMES || this.segment.length >= MAX_SEGMENT_FRAMES) {
      const voiced = this.voiceFrames;
      const seg = this.segment;
      this.speaking = false;
      this.segment = [];
      this.voiceFrames = 0;
      this.silenceCount = 0;

      if (voiced >= MIN_VOICE_FRAMES) {
        void this.finishSegment(seg);
      }
    }
  }

  private async finishSegment(seg: Float32Array[]): Promise<void> {
    const opts = this.opts;
    if (!opts || !this.running) return;

    this.busy = true;
    setStatus("thinking");
    pulse("network", 0.6);
    try {
      const wav = chunksToWavBase64(seg, this.sampleRate);
      const text = (await opts.transcribe(wav, "audio/wav")).trim();
      if (!text) return;
      opts.onUtterance?.(text);

      if (opts.mode === "continuous") {
        opts.onCommand(text);
        return;
      }

      // wakeword mode
      const wake = (opts.wakeWord ?? "luczor").toLowerCase();
      if (this.awaitingCommand) {
        this.awaitingCommand = false;
        opts.onCommand(text);
        return;
      }

      const lower = text.toLowerCase();
      const idx = lower.indexOf(wake);
      if (idx === -1) return; // no wake word -> ignore

      const remainder = text.slice(idx + wake.length).replace(/^[\s,.:;!?-]+/, "").trim();
      if (remainder.length >= 2) {
        opts.onCommand(remainder);
      } else {
        // Wake word only -> next utterance is the command.
        this.awaitingCommand = true;
      }
    } catch (e) {
      console.error("[VoiceEngine] segment failed:", e);
      opts.onError?.(e instanceof Error ? e : new Error(String(e)));
    } finally {
      this.busy = false;
      if (this.running) setStatus("listening");
    }
  }
}
