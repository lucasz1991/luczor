import { invoke } from "@tauri-apps/api/core";
import { LuczorApi } from "@/services/api/luczorApi";

export type VoiceMode = "push_to_talk" | "continuous" | "wakeword";
export type VoiceConfig = { mode: VoiceMode; wakeWord: string; localSttLanguage: string };
export type VoiceRuntimeStatus = {
  state: "ready" | "missing" | "incomplete" | "error";
  version: string | null;
  stt_ready: boolean;
  tts_ready: boolean;
  error: string | null;
};

let installPromise: Promise<VoiceRuntimeStatus> | null = null;

export async function getVoiceConfig(): Promise<VoiceConfig> {
  // Runtime and language are release-managed and do not use user settings.
  return { mode: "push_to_talk", wakeWord: "luczor", localSttLanguage: "de" };
}

function parseVoiceError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { code?: string; message?: string };
    if (parsed?.message) return Object.assign(new Error(parsed.message), { code: parsed.code });
  } catch {
    // Tauri can wrap command errors; keep its original message when not structured.
  }
  return new Error(raw);
}

export async function voiceRuntimeStatus(): Promise<VoiceRuntimeStatus> {
  try {
    return await invoke<VoiceRuntimeStatus>("voice_runtime_status");
  } catch (error) {
    throw parseVoiceError(error);
  }
}

/** Downloads and verifies Whisper.cpp/Piper once per manifest version. No local paths are stored in settings. */
export async function ensureVoiceRuntime(): Promise<VoiceRuntimeStatus> {
  const existing = await voiceRuntimeStatus();
  if (existing.stt_ready && existing.tts_ready) return existing;
  installPromise ??= (async () => {
    const manifest = await LuczorApi.voiceManifest();
    try {
      return await invoke<VoiceRuntimeStatus>("install_voice_runtime", { payload: manifest });
    } catch (error) {
      throw parseVoiceError(error);
    } finally {
      installPromise = null;
    }
  })();
  return installPromise;
}

export async function localStt(base64: string, language?: string): Promise<string> {
  await ensureVoiceRuntime();
  try {
    const response = await invoke<{ text: string }>("local_stt", { payload: { base64, language: language ?? "de" } });
    return (response?.text ?? "").trim();
  } catch (error) {
    throw parseVoiceError(error);
  }
}

export async function localTts(text: string): Promise<{ base64: string; mime: string }> {
  await ensureVoiceRuntime();
  try {
    return await invoke<{ base64: string; mime: string }>("local_tts", { payload: { text } });
  } catch (error) {
    throw parseVoiceError(error);
  }
}
