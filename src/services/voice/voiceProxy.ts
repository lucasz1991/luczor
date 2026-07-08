// src/services/voice/voiceProxy.ts
//
// Route ElevenLabs STT/TTS through the Laravel proxy so the ElevenLabs key
// stays server-side (encrypted). Enabled together with the OpenRouter proxy
// via the "use_server_proxy" setting (default ON).

import { Store } from "@tauri-apps/plugin-store";
import { getApiConfig } from "@/services/api/luczorApi";

const SETTINGS_FILE = "luczor.settings.json";

export async function useVoiceProxy(): Promise<boolean> {
  try {
    const s = await Store.load(SETTINGS_FILE);
    return (await s.get<boolean>("use_server_proxy")) ?? true;
  } catch {
    return true;
  }
}

async function proxyPost<T>(path: string, body: unknown): Promise<T> {
  const cfg = await getApiConfig();
  if (!cfg.deviceKey) {
    throw new Error("Server-Proxy aktiv, aber Device-Key fehlt (Settings → Server).");
  }
  const res = await fetch(`${cfg.baseUrl}/api/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.deviceKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
  return json as T;
}

export function proxyTts(
  text: string,
  opts: { voiceId: string; modelId?: string; outputFormat?: string }
): Promise<{ base64: string; mime: string }> {
  return proxyPost("/proxy/eleven/tts", {
    text,
    voice_id: opts.voiceId,
    model_id: opts.modelId,
    output_format: opts.outputFormat,
  });
}

export function proxyStt(
  base64: string,
  opts: { mime?: string; modelId?: string; language?: string }
): Promise<{ text: string; language_code?: string }> {
  return proxyPost("/proxy/eleven/stt", {
    base64,
    mime: opts.mime,
    model_id: opts.modelId,
    language_code: opts.language,
  });
}
