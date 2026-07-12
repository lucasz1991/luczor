// src/services/voice/speak.ts
//
// Unified, streaming text-to-speech. Splits text into sentences and plays them
// back-to-back while synthesizing the next one. The active runtime backend is
// local Piper; no ElevenLabs/cloud fallback is used for speech output.

import { setStatus } from "@/state/hud";
import { localTts } from "./localVoice";

let currentAudio: HTMLAudioElement | null = null;
let stopCurrentAudio: (() => void) | null = null;
let cancelled = false;

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

function play(clip: Clip): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(`data:${clip.mime};base64,${clip.base64}`);
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

export async function streamSpeak(text: string): Promise<void> {
  const clean = (text ?? "").trim();
  if (!clean) return;

  cancelled = false;
  const sentences = splitSentences(clean);
  try {
    let next: Promise<Clip> | null = sentences.length ? synthLocal(sentences[0]!) : null;
    for (let i = 0; i < sentences.length; i++) {
      if (cancelled) break;
      const clip = await next;
      next = i + 1 < sentences.length ? synthLocal(sentences[i + 1]!) : null;
      if (cancelled || !clip) break;
      setStatus("speaking");
      await play(clip);
    }
  } catch (error) {
    reportPlaybackError(error);
    throw error;
  } finally {
    if (!cancelled) setStatus("idle");
  }
}

export function stopSpeak() {
  cancelled = true;
  stopCurrentAudio?.();
  if (currentAudio) currentAudio.pause();
  setStatus("idle");
}
