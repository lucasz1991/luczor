// src/services/voice/speak.ts
//
// Unified, streaming text-to-speech. Splits text into sentences and plays them
// back-to-back while synthesizing the next one. The active runtime backend is
// local Piper; no ElevenLabs/cloud fallback is used for speech output.

import { setStatus } from "@/state/hud";
import { getVoiceConfig, localTts, localTtsReady, type VoiceConfig } from "./localVoice";

let currentAudio: HTMLAudioElement | null = null;
let cancelled = false;

type Clip = { base64: string; mime: string };

async function synthLocal(text: string, cfg: VoiceConfig): Promise<Clip> {
  if (!localTtsReady(cfg)) {
    throw new Error("Lokale TTS ist nicht konfiguriert: Piper Binary und Piper Voice (.onnx) setzen.");
  }
  return localTts(text, { binary: cfg.localTtsBinary, model: cfg.localTtsModel });
}

function play(clip: Clip): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(`data:${clip.mime};base64,${clip.base64}`);
    currentAudio = audio;
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("Audio-Wiedergabe fehlgeschlagen"));
    audio.play().catch(reject);
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
  const cfg = await getVoiceConfig();

  try {
    let next: Promise<Clip> | null = sentences.length ? synthLocal(sentences[0]!, cfg) : null;
    for (let i = 0; i < sentences.length; i++) {
      if (cancelled) break;
      const clip = await next;
      next = i + 1 < sentences.length ? synthLocal(sentences[i + 1]!, cfg) : null;
      if (cancelled || !clip) break;
      setStatus("speaking");
      await play(clip);
    }
  } finally {
    if (!cancelled) setStatus("idle");
  }
}

export function stopSpeak() {
  cancelled = true;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  setStatus("idle");
}
