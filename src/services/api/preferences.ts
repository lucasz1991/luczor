// src/services/api/preferences.ts
//
// Account-synced client preferences (voice + external agents). Values live in
// the local settings store; each carries a "<key>__updated_at" marker so the
// server can resolve conflicts last-write-wins (SOLL §7.1). Device-local ids
// (input/output device, autostart) are NOT part of this set and stay local.

import { Store } from "@tauri-apps/plugin-store";
import { LuczorApi } from "./luczorApi";

const STORE = "luczor.settings.json";

export const PREFERENCE_KEYS = [
  "voice_backend",
  "voice_auto_prefers_local",
  "hands_free_strategy",
  "voice_trigger_phrase",
  "voice_end_phrase",
  "voice_continuous_silence_ms",
  "voice_ptt_auto_send",
  "voice_hands_free_auto_send",
  "voice_tts_voice_id",
  "voice_tts_rate",
  "voice_tts_volume",
  "voice_auto_speech",
  "voice_auto_speech_mode",
  "voice_interrupt_mode",
  "agents_claude_mode",
  "agents_codex_mode",
  "agents_bridge_file",
] as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

const stampKey = (key: string) => `${key}__updated_at`;

/** Write a preference locally with a fresh timestamp, then push to the server. */
export async function setPreference(key: PreferenceKey, value: unknown): Promise<void> {
  const s = await Store.load(STORE);
  const now = new Date().toISOString();
  await s.set(key, value);
  await s.set(stampKey(key), now);
  await s.save();
  try {
    await LuczorApi.putPreferences([{ key, value, updated_at: now }]);
  } catch {
    /* offline: local wins until next pushAllPreferences() */
  }
}

/** Push every locally-set preference (with its local timestamp) to the server. */
export async function pushAllPreferences(): Promise<void> {
  const s = await Store.load(STORE);
  const batch: Array<{ key: string; value: unknown; updated_at?: string }> = [];
  for (const key of PREFERENCE_KEYS) {
    const value = await s.get(key);
    if (value === undefined || value === null) continue;
    const updated_at = (await s.get<string>(stampKey(key))) ?? undefined;
    batch.push({ key, value, updated_at });
  }
  if (batch.length) await LuczorApi.putPreferences(batch);
}

/** Pull server preferences and apply the ones that are newer than local (LWW). */
export async function pullPreferences(): Promise<number> {
  const { preferences } = await LuczorApi.getPreferences();
  const s = await Store.load(STORE);
  let applied = 0;
  for (const key of PREFERENCE_KEYS) {
    const remote = preferences[key];
    if (!remote) continue;
    const localStamp = (await s.get<string>(stampKey(key))) ?? null;
    const remoteStamp = remote.updated_at;
    // Apply when local has no stamp or the remote one is not older.
    if (!localStamp || (remoteStamp && remoteStamp >= localStamp)) {
      await s.set(key, remote.value);
      if (remoteStamp) await s.set(stampKey(key), remoteStamp);
      applied++;
    }
  }
  await s.save();
  return applied;
}
