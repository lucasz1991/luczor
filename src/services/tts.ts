import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";

let currentAudio: HTMLAudioElement | null = null;

type SpeakArgs =
  | string
  | {
      text: string;
      rate?: number;   // optional (wenn dein Backend es unterstützt)
      volume?: number; // optional (wenn dein Backend es unterstützt)
      voiceId?: string; // optional
    };

function normalizeArgs(input: SpeakArgs) {
  if (typeof input === "string") return { text: input };
  return input;
}

export async function speak(input: SpeakArgs) {
  const args = normalizeArgs(input);
  const text = (args.text ?? "").trim();
  if (!text) return;

  const store = await Store.load("luczor.settings.json");
  const apiKey = ((await store.get<string>("elevenlabs_api_key")) ?? "").trim();
  if (!apiKey) throw new Error("ElevenLabs API Key fehlt (Settings).");

  // optional defaults aus Settings (falls vorhanden)
  const voiceId = (args.voiceId ?? (await store.get<string>("elevenlabs_voice_id")) ?? "").trim() || undefined;

  const res = await invoke<{ base64: string; mime: string }>("eleven_tts", {
    payload: {
      api_key: apiKey,
      text,
      // nur mitschicken, wenn du es in Rust auch definierst:
      voice_id: voiceId,
      rate: typeof args.rate === "number" ? args.rate : undefined,
      volume: typeof args.volume === "number" ? args.volume : undefined,
    },
  });

  const url = `data:${res.mime};base64,${res.base64}`;

  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
  }

  currentAudio = new Audio(url);
  await currentAudio.play();
}

export function stopSpeak() {
  if (!currentAudio) return;
  currentAudio.pause();
  currentAudio.currentTime = 0;
  currentAudio = null;
}
