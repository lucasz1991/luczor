import { invoke } from "@tauri-apps/api/core";
import { useVoiceProxy, proxyStt } from "@/services/voice/voiceProxy";

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
  // Server proxy (default): the ElevenLabs key stays on the server.
  if (await useVoiceProxy()) {
    return proxyStt(payload.base64, {
      mime: payload.mime,
      modelId: payload.model_id,
      language: payload.language_code,
    });
  }
  // Direct (local key) fallback via the Rust command.
  return invoke<{ text: string; language_code?: string }>("eleven_stt", { payload });
}
