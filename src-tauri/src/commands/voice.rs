// src-tauri/src/commands/voice.rs
//
// Local (offline) speech backends, invoked as external binaries the user
// installs and points at via settings:
//   - STT: whisper.cpp CLI (e.g. `whisper-cli`)
//   - TTS: Piper (`piper`)
//
// These are optional: the app also has cloud STT/TTS (ElevenLabs). When the
// binaries/models are not configured, the frontend simply uses the cloud
// backend. Nothing here downloads or bundles models — paths come from the user.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::{Command, Stdio};

fn write_temp(bytes: &[u8], ext: &str) -> Result<std::path::PathBuf, String> {
    let mut p = std::env::temp_dir();
    p.push(format!("luczor_voice_{}.{ext}", uuid::Uuid::new_v4()));
    std::fs::write(&p, bytes).map_err(|e| format!("temp write failed: {e}"))?;
    Ok(p)
}

fn normalize_base64(b64: &str) -> &str {
    match b64.split_once(',') {
        Some((_, rest)) => rest,
        None => b64,
    }
}

/* =========================================================
 * Local STT (whisper.cpp CLI)
 * ========================================================= */
#[derive(Debug, Deserialize)]
pub struct LocalSttPayload {
    /// Path to the whisper.cpp CLI binary (e.g. whisper-cli / main).
    pub binary_path: String,
    /// Path to the GGML/GGUF model file.
    pub model_path: String,
    /// Input audio as base64 (wav recommended).
    pub base64: String,
    /// e.g. "de", "en". Optional.
    pub language: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LocalSttResponse {
    pub text: String,
}

/// Transcribe audio with a local whisper.cpp binary. Captures stdout as text.
#[tauri::command]
pub async fn local_stt(payload: LocalSttPayload) -> Result<LocalSttResponse, String> {
    if payload.binary_path.trim().is_empty() {
        return Err("Kein STT-Binary konfiguriert.".into());
    }
    if payload.model_path.trim().is_empty() {
        return Err("Kein STT-Modell konfiguriert.".into());
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(normalize_base64(&payload.base64))
        .map_err(|e| format!("Base64 decode failed: {e}"))?;
    let wav = write_temp(&bytes, "wav")?;

    let mut args: Vec<String> = vec![
        "-m".into(),
        payload.model_path.clone(),
        "-f".into(),
        wav.to_string_lossy().to_string(),
        "-nt".into(), // no timestamps -> clean text on stdout
    ];
    if let Some(lang) = payload.language.as_ref() {
        if !lang.trim().is_empty() {
            args.push("-l".into());
            args.push(lang.trim().to_string());
        }
    }

    let output = Command::new(&payload.binary_path)
        .args(&args)
        .output()
        .map_err(|e| format!("whisper start failed: {e}"))?;

    let _ = std::fs::remove_file(&wav);

    if !output.status.success() {
        return Err(format!(
            "whisper error ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(LocalSttResponse { text })
}

/* =========================================================
 * Local TTS (Piper)
 * ========================================================= */
#[derive(Debug, Deserialize)]
pub struct LocalTtsPayload {
    /// Path to the Piper binary.
    pub binary_path: String,
    /// Path to the Piper voice model (.onnx).
    pub model_path: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct LocalTtsResponse {
    pub base64: String,
    pub mime: String,
}

/// Synthesize speech with a local Piper binary. Returns a WAV (base64).
#[tauri::command]
pub async fn local_tts(payload: LocalTtsPayload) -> Result<LocalTtsResponse, String> {
    if payload.binary_path.trim().is_empty() {
        return Err("Kein TTS-Binary konfiguriert.".into());
    }
    if payload.model_path.trim().is_empty() {
        return Err("Kein TTS-Modell konfiguriert.".into());
    }
    let text = payload.text.trim();
    if text.is_empty() {
        return Err("Kein Text.".into());
    }

    let mut out = std::env::temp_dir();
    out.push(format!("luczor_tts_{}.wav", uuid::Uuid::new_v4()));

    let mut child = Command::new(&payload.binary_path)
        .args([
            "--model",
            &payload.model_path,
            "--output_file",
            &out.to_string_lossy(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("piper start failed: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| format!("piper stdin failed: {e}"))?;
    }

    let status = child.wait().map_err(|e| format!("piper wait failed: {e}"))?;
    if !status.success() {
        return Err(format!("piper error ({status})"));
    }

    let bytes = std::fs::read(&out).map_err(|e| format!("read wav failed: {e}"))?;
    let _ = std::fs::remove_file(&out);

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(LocalTtsResponse {
        base64: b64,
        mime: "audio/wav".to_string(),
    })
}
