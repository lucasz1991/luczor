// src/services/voice/speak.ts
//
// Unified, streaming text-to-speech. Splits text into sentences and plays them
// back-to-back while synthesizing the next one — so audio starts after the
// first sentence instead of the whole reply. Uses the local Piper backend when
// configured, otherwise the cloud (ElevenLabs) backend.

import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import { setStatus } from "@/state/hud";
import { getVoiceConfig, localTts, localTtsReady, type VoiceConfig } from "./localVoice";

const SETTINGS_FILE = "luczor.settings.json";

let currentAudio: HTMLAudioElement | null = null;
let cancelled = false;

type Clip = { base64: string; mime: string };

async function synthCloud(text: string): Promise<Clip> {
  const s = await Store.load(SETTINGS_FILE);
  const apiKey = ((await s.get<string>("elevenlabs_api_key")) ?? "").trim();
  if (!apiKey) throw new Error("ElevenLabs API Key fehlt (Settings).");
  const voiceId = ((await s.get<string>("elevenlabs_voice_id")) ?? "").trim();
  const modelId = ((await s.get<string>("elevenlabs_tts_model")) ?? "").trim() || undefined;
  const outputFormat = ((await s.get<string>("elevenlabs_tts_output_format")) ?? "").trim() || undefined;
  const speed = await s.get<number>("elevenlabs_tts_speed");

  return invoke<Clip>("eleven_tts", {
    payload: {
      api_key: apiKey,
      text,
      voice_id: voiceId,
      model_id: modelId,
      output_format: outputFormat,
      speed: typeof speed === "number" ? speed : undefined,
    },
  });
}

async function synthLocal(text: string, cfg: VoiceConfig): Promise<Clip> {
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

/** Split into speakable chunks; merge very short fragments into neighbours. */
function splitSentences(text: string): string[] {
  const raw = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…:])\s+/)
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

/** Stream-speak text sentence-by-sentence with one-ahead prefetch. */
export async function streamSpeak(text: string): Promise<void> {
  const clean = (text ?? "").trim();
  if (!clean) return;

  cancelled = false;
  const sentences = splitSentences(clean);
  const cfg = await getVoiceConfig();
  const useLocal = localTtsReady(cfg);
  const synth = (t: string) => (useLocal ? synthLocal(t, cfg) : synthCloud(t));

  try {
    let next: Promise<Clip> | null = sentences.length ? synth(sentences[0]!) : null;
    for (let i = 0; i < sentences.length; i++) {
      if (cancelled) break;
      const clip = await next;
      next = i + 1 < sentences.length ? synth(sentences[i + 1]!) : null;
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
