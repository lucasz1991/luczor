use serde::{Deserialize, Serialize};
use base64::Engine;

#[derive(Debug, Deserialize)]
pub struct ElevenSttPayload {
    pub api_key: String,
    pub base64: String,
    pub mime: String,

    pub model_id: Option<String>,        // default: scribe_v2
    pub language_code: Option<String>,   // e.g. "deu" / "eng" (ISO-639-3)
    pub diarize: Option<bool>,
    pub tag_audio_events: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ElevenSttResponse {
    pub text: String,
    pub language_code: Option<String>,
}

// ElevenLabs STT response shape (minimal)
#[derive(Debug, Deserialize)]
struct ElevenSttApiResponse {
    text: String,
    language_code: Option<String>,
}

fn normalize_base64(b64: &str) -> &str {
    match b64.split_once(',') {
        Some((_, rest)) => rest,
        None => b64,
    }
}

fn mime_to_filename(mime: &str) -> &'static str {
    if mime.contains("wav") { "audio.wav" }
    else if mime.contains("ogg") { "audio.ogg" }
    else if mime.contains("mp3") { "audio.mp3" }
    else if mime.contains("webm") { "audio.webm" }
    else { "audio.bin" }
}

#[tauri::command]
pub async fn eleven_stt(payload: ElevenSttPayload) -> Result<ElevenSttResponse, String> {
    let api_key = payload.api_key.trim();
    if api_key.is_empty() {
        return Err("Missing ElevenLabs api_key".into());
    }

    let model_id = payload.model_id.unwrap_or_else(|| "scribe_v2".to_string()); // Scribe v2 :contentReference[oaicite:3]{index=3}

    let b64 = normalize_base64(&payload.base64);
    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("Base64 decode failed: {e}"))?;

    // IMPORTANT: STT ist ein File-Upload (multipart). Quickstart zeigt file + model_id usw. :contentReference[oaicite:4]{index=4}
    let file_part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(mime_to_filename(&payload.mime))
        .mime_str(payload.mime.split(';').next().unwrap_or("application/octet-stream"))
        .map_err(|e| format!("Invalid mime: {e}"))?;

    let mut form = reqwest::multipart::Form::new()
        .part("file", file_part)
        .text("model_id", model_id);

    if let Some(lang) = payload.language_code {
        if !lang.trim().is_empty() {
            form = form.text("language_code", lang);
        }
    }
    if let Some(diarize) = payload.diarize {
        form = form.text("diarize", diarize.to_string());
    }
    if let Some(tag) = payload.tag_audio_events {
        form = form.text("tag_audio_events", tag.to_string());
    }

    let client = reqwest::Client::new();

    // Endpoint ist in der API-Reference "Speech to Text convert" verankert; Multipart entspricht dem Quickstart (file=..., model_id=...). :contentReference[oaicite:5]{index=5}
    let resp = client
        .post("https://api.elevenlabs.io/v1/speech-to-text")
        .header("xi-api-key", api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("ElevenLabs STT HTTP failed: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("Read body failed: {e}"))?;

    if !status.is_success() {
        return Err(format!("ElevenLabs STT error ({status}): {body}"));
    }

    let parsed: ElevenSttApiResponse =
        serde_json::from_str(&body).map_err(|e| format!("JSON parse failed: {e}. Body: {body}"))?;

    Ok(ElevenSttResponse {
        text: parsed.text,
        language_code: parsed.language_code,
    })
}
