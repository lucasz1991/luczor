import { invoke } from "@tauri-apps/api/core";

let currentAudio: HTMLAudioElement | null = null;

export async function speak(text: string, opts?: { rate?: number; volume?: number; voice?: string }) {
  const res = await invoke<{ base64: string; mime: string }>("speech_tts", {
    payload: {
      text,
      rate: opts?.rate ?? 2,
      volume: opts?.volume ?? 100,
      voice: opts?.voice ?? undefined,
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
