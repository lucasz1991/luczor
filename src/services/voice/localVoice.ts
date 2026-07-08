// src/services/voice/localVoice.ts
//
// Voice configuration + local (offline) STT/TTS backends.
// Local backends call the Rust commands (whisper.cpp / Piper) that shell out
// to user-installed binaries. When not configured, callers fall back to the
// existing cloud (ElevenLabs) backend.

import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";

const SETTINGS_FILE = "luczor.settings.json";

export type VoiceBackend = "cloud" | "local";
export type VoiceMode = "push_to_talk" | "continuous" | "wakeword";

export type VoiceConfig = {
  mode: VoiceMode;
  wakeWord: string;
  sttBackend: VoiceBackend;
  ttsBackend: VoiceBackend;
  localSttBinary: string;
  localSttModel: string;
  localSttLanguage: string;
  localTtsBinary: string;
  localTtsModel: string;
};

export async function getVoiceConfig(): Promise<VoiceConfig> {
  const s = await Store.load(SETTINGS_FILE);
  const str = async (k: string, d = "") => ((await s.get<string>(k)) ?? d).trim();
  const mode = (await s.get<VoiceMode>("voice_mode")) ?? "push_to_talk";
  return {
    mode: mode === "continuous" || mode === "wakeword" ? mode : "push_to_talk",
    wakeWord: (await str("voice_wake_word", "luczor")) || "luczor",
    sttBackend: ((await s.get<VoiceBackend>("voice_stt_backend")) ?? "cloud") === "local" ? "local" : "cloud",
    ttsBackend: ((await s.get<VoiceBackend>("voice_tts_backend")) ?? "cloud") === "local" ? "local" : "cloud",
    localSttBinary: await str("voice_local_stt_binary"),
    localSttModel: await str("voice_local_stt_model"),
    localSttLanguage: (await str("voice_local_stt_language", "de")) || "de",
    localTtsBinary: await str("voice_local_tts_binary"),
    localTtsModel: await str("voice_local_tts_model"),
  };
}

export function localSttReady(cfg: VoiceConfig): boolean {
  return cfg.sttBackend === "local" && !!cfg.localSttBinary && !!cfg.localSttModel;
}
export function localTtsReady(cfg: VoiceConfig): boolean {
  return cfg.ttsBackend === "local" && !!cfg.localTtsBinary && !!cfg.localTtsModel;
}

export async function localStt(
  base64: string,
  opts: { binary: string; model: string; language?: string }
): Promise<string> {
  const r = await invoke<{ text: string }>("local_stt", {
    payload: {
      binary_path: opts.binary,
      model_path: opts.model,
      base64,
      language: opts.language ?? null,
    },
  });
  return (r?.text ?? "").trim();
}

export async function localTts(
  text: string,
  opts: { binary: string; model: string }
): Promise<{ base64: string; mime: string }> {
  return invoke<{ base64: string; mime: string }>("local_tts", {
    payload: { binary_path: opts.binary, model_path: opts.model, text },
  });
}
