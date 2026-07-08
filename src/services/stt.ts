import { invoke } from "@tauri-apps/api/core";

export type ElevenSttPayload = {
  api_key: string;
  base64: string;
  mime: string;
  model_id?: string;        // default: "scribe_v2"
  language_code?: string;   // e.g. "deu" / "eng" (ISO-639-3 wie in ElevenLabs)
  diarize?: boolean;
  tag_audio_events?: boolean;
};

export async function transcribeWithElevenLabs(payload: ElevenSttPayload) {
  return invoke<{ text: string; language_code?: string }>("eleven_stt", { payload });
}
