use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct SpeechTranscribePayload {
    pub base64: String,          // base64 audio (prefer WAV PCM16 for best compatibility)
    pub mime: String,            // e.g. "audio/wav" | "audio/ogg;codecs=opus" | "audio/webm;codecs=opus"
    pub api_key: String,         // OpenRouter API key
    pub model: Option<String>,   // e.g. "openai/gpt-4o-audio-preview"
}

#[derive(Debug, Serialize)]
pub struct SpeechTranscribeResponse {
    pub text: String,
}

/* -----------------------------
 * OpenRouter request/response
 * ----------------------------- */

#[derive(Debug, Serialize)]
struct OrRequest {
    model: String,
    stream: bool,
    modalities: Vec<String>,
    messages: Vec<OrMessage>,
}

#[derive(Debug, Serialize)]
struct OrMessage {
    role: String,
    content: Vec<OrContentPart>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum OrContentPart {
    #[serde(rename = "text")]
    Text { text: String },

    // IMPORTANT: The nested field must be named "input_audio" (snake_case),
    // otherwise providers may not detect audio and will error.
    #[serde(rename = "input_audio")]
    InputAudio {
        #[serde(rename = "input_audio")]
        input_audio: OrInputAudio,
    },
}

#[derive(Debug, Serialize)]
struct OrInputAudio {
    data: String,   // base64 without data: prefix
    format: String, // "wav" | "ogg" | "mp3" | ...
}

#[derive(Debug, Deserialize)]
struct OrResponse {
    choices: Vec<OrChoice>,
}

#[derive(Debug, Deserialize)]
struct OrChoice {
    message: OrChoiceMessage,
}

#[derive(Debug, Deserialize)]
struct OrChoiceMessage {
    content: String,
}

/* -----------------------------
 * Helpers
 * ----------------------------- */

fn audio_format_from_mime(mime: &str) -> &'static str {
    // Strongly prefer WAV (PCM16) if you can (best provider compatibility).
    // If you still send webm/opus, some providers may reject it.
    if mime.contains("wav") {
        "wav"
    } else if mime.contains("ogg") {
        "ogg"
    } else if mime.contains("mp3") {
        "mp3"
    } else if mime.contains("m4a") {
        "m4a"
    } else if mime.contains("flac") {
        "flac"
    } else if mime.contains("webm") {
        "webm"
    } else {
        "wav"
    }
}

fn normalize_base64_audio(b64: &str) -> &str {
    // If a data URL sneaks in, strip it:
    // "data:audio/wav;base64,AAAA..." -> "AAAA..."
    match b64.split_once(',') {
        Some((_, rest)) => rest,
        None => b64,
    }
}

fn stt_prompt() -> &'static str {
    "Transkribiere das folgende Audio wörtlich. Gib nur den Text zurück."
}

/* -----------------------------
 * Command
 * ----------------------------- */

#[tauri::command]
pub async fn speech_transcribe(payload: SpeechTranscribePayload) -> Result<SpeechTranscribeResponse, String> {
    let api_key = payload.api_key.trim();
    if api_key.is_empty() {
        return Err("Missing OpenRouter api_key".into());
    }

    // Must be an audio-capable model for audio inputs.
    let model = payload
        .model
        .unwrap_or_else(|| "openai/gpt-4o-audio-preview".to_string());

    let format = audio_format_from_mime(&payload.mime).to_string();
    let b64 = normalize_base64_audio(&payload.base64).to_string();

    let req = OrRequest {
        model,
        stream: false,
        modalities: vec!["text".to_string()],
        messages: vec![OrMessage {
            role: "user".to_string(),
            content: vec![
                OrContentPart::Text {
                    text: stt_prompt().to_string(),
                },
                OrContentPart::InputAudio {
                    input_audio: OrInputAudio { data: b64, format },
                },
            ],
        }],
    };

    let client = reqwest::Client::new();
    let resp = client
        .post("https://openrouter.ai/api/v1/chat/completions")
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("OpenRouter HTTP failed: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("Read body failed: {e}"))?;

    if !status.is_success() {
        return Err(format!("OpenRouter STT error ({status}): {body}"));
    }

    let parsed: OrResponse =
        serde_json::from_str(&body).map_err(|e| format!("JSON parse failed: {e}. Body: {body}"))?;

    let text = parsed
        .choices
        .get(0)
        .map(|c| c.message.content.trim().to_string())
        .unwrap_or_default();

    Ok(SpeechTranscribeResponse { text })
}
