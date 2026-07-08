use serde::{Deserialize, Serialize};
use base64::Engine;

#[derive(Debug, Deserialize)]
pub struct ElevenTtsPayload {
    pub api_key: String,
    pub text: String,
    pub voice_id: String,

    pub model_id: Option<String>,       // e.g. "eleven_multilingual_v2" :contentReference[oaicite:8]{index=8}
    pub output_format: Option<String>,  // e.g. "mp3_44100_128" :contentReference[oaicite:9]{index=9}

    // voice_settings (optional)
    pub speed: Option<f32>,             // 1.0 default; >1 faster :contentReference[oaicite:10]{index=10}
    pub stability: Option<f32>,
    pub similarity_boost: Option<f32>,
    pub style: Option<f32>,
    pub use_speaker_boost: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ElevenTtsResponse {
    pub base64: String,
    pub mime: String,
}

fn mime_from_output_format(fmt: &str) -> &'static str {
    // mp3_* => audio/mpeg, opus_* => audio/opus, pcm_* => audio/wav (vereinfachte Zuordnung)
    if fmt.starts_with("opus_") { "audio/ogg" }
    else if fmt.starts_with("pcm_") { "audio/wav" }
    else { "audio/mpeg" }
}

#[tauri::command]
pub async fn eleven_tts(payload: ElevenTtsPayload) -> Result<ElevenTtsResponse, String> {
    let api_key = payload.api_key.trim();
    if api_key.is_empty() {
        return Err("Missing ElevenLabs api_key".into());
    }
    let text = payload.text.trim();
    if text.is_empty() {
        return Err("Missing text".into());
    }
    let voice_id = payload.voice_id.trim();
    if voice_id.is_empty() {
        return Err("Missing voice_id".into());
    }

    let model_id = payload.model_id.unwrap_or_else(|| "eleven_multilingual_v2".to_string());
    let output_format = payload.output_format.unwrap_or_else(|| "mp3_44100_128".to_string()); // default aus Spec :contentReference[oaicite:11]{index=11}

    let voice_settings = serde_json::json!({
        "speed": payload.speed.unwrap_or(1.0), // Speed param exists :contentReference[oaicite:12]{index=12}
        "stability": payload.stability,
        "similarity_boost": payload.similarity_boost,
        "style": payload.style,
        "use_speaker_boost": payload.use_speaker_boost,
    });

    let req_json = serde_json::json!({
        "text": text,
        "model_id": model_id,
        "voice_settings": voice_settings,
    });

    // TTS endpoint spec: /v1/text-to-speech/{voice_id}?output_format=... :contentReference[oaicite:13]{index=13}
    let url = format!(
        "https://api.elevenlabs.io/v1/text-to-speech/{}?output_format={}",
        voice_id, output_format
    );

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("xi-api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&req_json)
        .send()
        .await
        .map_err(|e| format!("ElevenLabs TTS HTTP failed: {e}"))?;

    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| format!("Read audio bytes failed: {e}"))?;

    if !status.is_success() {
        let body = String::from_utf8_lossy(&bytes).to_string();
        return Err(format!("ElevenLabs TTS error ({status}): {body}"));
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mime = mime_from_output_format(&output_format).to_string();

    Ok(ElevenTtsResponse { base64: b64, mime })
}
