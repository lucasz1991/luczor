// src/services/voice/speak.ts
//
// Unified, streaming text-to-speech. Splits text into sentences and plays them
// back-to-back while synthesizing the next one.
//
// Backends, in preference order:
//   1. local Piper runtime (high quality, but must be installed/ready), and
//   2. the browser/OS speech-synthesis engine (Windows SAPI via WebView2) as a
//      ZERO-SETUP local fallback so speech output ALWAYS works even before the
//      Piper runtime is provisioned.
//
// The OS speech engine is local (no keys, no third-party service, no downloads),
// so it does not violate the "no cloud STT/TTS fallback" rule.

import { setStatus } from "@/state/hud";
import { localTts } from "./localVoice";

let currentAudio: HTMLAudioElement | null = null;
let stopCurrentAudio: (() => void) | null = null;
let cancelled = false;
// Monotonic generation id. Every new streamSpeak()/stopSpeak() bumps it so a
// second speak or a stop deterministically invalidates any in-flight run and
// its pre-synthesized next sentence — no two clips can overlap.
let generation = 0;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function reportPlaybackError(error: unknown): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("luczor:debug", {
    detail: { level: "error", event: "local_tts_playback_failed", detail: { message: error instanceof Error ? error.message : String(error) } },
  }));
}

type Clip = { base64: string; mime: string };

async function synthLocal(text: string): Promise<Clip> {
  return localTts(text);
}

function play(clip: Clip, volume: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(`data:${clip.mime};base64,${clip.base64}`);
    audio.volume = clamp(volume, 0, 1);
    let settled = false;
    let stop: () => void;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      audio.onended = null;
      audio.onerror = null;
      if (currentAudio === audio) currentAudio = null;
      if (stopCurrentAudio === stop) stopCurrentAudio = null;
      if (error) reject(error);
      else resolve();
    };

    stop = () => {
      try {
        audio.pause();
      } finally {
        finish();
      }
    };

    currentAudio = audio;
    stopCurrentAudio = stop;
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error("Audio-Wiedergabe fehlgeschlagen"));
    void audio.play().catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/* ---------------- OS speech-synthesis fallback ---------------- */

function webSpeechAvailable(): boolean {
  return typeof window !== "undefined"
    && "speechSynthesis" in window
    && typeof SpeechSynthesisUtterance !== "undefined";
}

function cancelWebSpeech(): void {
  if (webSpeechAvailable()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}

function webSpeechSentence(text: string, rate: number, volume: number): Promise<void> {
  return new Promise((resolve) => {
    if (!webSpeechAvailable()) {
      resolve();
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = clamp(rate, 0.5, 2);
    utter.volume = clamp(volume, 0, 1);
    utter.lang = "de-DE";
    utter.onend = () => resolve();
    utter.onerror = () => resolve();
    window.speechSynthesis.speak(utter);
  });
}

async function speakWithOs(sentences: string[], myGen: number, rate: number, volume: number): Promise<void> {
  if (!webSpeechAvailable()) {
    throw new Error("Keine lokale Sprachausgabe verfügbar (Piper-Runtime fehlt und Web-Speech wird nicht unterstützt).");
  }
  for (const sentence of sentences) {
    if (cancelled || myGen !== generation) break;
    setStatus("speaking");
    await webSpeechSentence(sentence, rate, volume);
  }
}

function splitSentences(text: string): string[] {
  const raw = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?:])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const part of raw) {
    if (out.length && (out[out.length - 1]!.length < 24 || part.length < 12)) {
      out[out.length - 1] = `${out[out.length - 1]} ${part}`.trim();
    } else {
      out.push(part);
    }
  }
  return out.length ? out : [text.trim()];
}

export type SpeakOptions = { rate?: number; volume?: number };

export async function streamSpeak(text: string, opts: SpeakOptions = {}): Promise<void> {
  const clean = (text ?? "").trim();
  if (!clean) return;

  const myGen = ++generation;
  cancelled = false;
  cancelWebSpeech();
  const rate = opts.rate ?? 1;
  const volume = opts.volume ?? 0.9;
  const sentences = splitSentences(clean);

  try {
    // Probe the local Piper runtime with the first sentence. If it isn't ready,
    // speak the whole message via the OS fallback instead.
    let firstClip: Clip | null = null;
    try {
      firstClip = await synthLocal(sentences[0]!);
    } catch {
      firstClip = null;
    }
    if (cancelled || myGen !== generation) return;

    if (!firstClip) {
      await speakWithOs(sentences, myGen, rate, volume);
      return;
    }

    // Local path: play the first clip, then pipeline synth+play for the rest.
    setStatus("speaking");
    await play(firstClip, volume);
    let next: Promise<Clip> | null = sentences.length > 1 ? synthLocal(sentences[1]!) : null;
    for (let i = 1; i < sentences.length; i++) {
      if (cancelled || myGen !== generation) break;
      let clip: Clip | null = null;
      try {
        clip = await next;
      } catch {
        clip = null; // local runtime failed mid-stream -> finish via OS fallback
      }
      next = i + 1 < sentences.length ? synthLocal(sentences[i + 1]!).catch(() => null) as Promise<Clip> : null;
      if (cancelled || myGen !== generation) break;
      if (!clip) {
        await speakWithOs(sentences.slice(i), myGen, rate, volume);
        break;
      }
      setStatus("speaking");
      await play(clip, volume);
    }
  } catch (error) {
    reportPlaybackError(error);
    throw error;
  } finally {
    if (!cancelled && myGen === generation) setStatus("idle");
  }
}

export function stopSpeak() {
  generation++;
  cancelled = true;
  stopCurrentAudio?.();
  if (currentAudio) currentAudio.pause();
  cancelWebSpeech();
  setStatus("idle");
}
