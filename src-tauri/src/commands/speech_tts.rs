use serde::{Deserialize, Serialize};
use base64::Engine;
use std::{fs, path::PathBuf, process::Command};

#[derive(Debug, Deserialize)]
pub struct SpeechTtsPayload {
    pub text: String,
    pub voice: Option<String>,  // optional: exact Windows voice name
    pub rate: Option<i32>,      // -10..10 (SAPI)
    pub volume: Option<i32>,    // 0..100
}

#[derive(Debug, Serialize)]
pub struct SpeechTtsResponse {
    pub base64: String,
    pub mime: String,
}

#[tauri::command]
pub async fn speech_tts(payload: SpeechTtsPayload) -> Result<SpeechTtsResponse, String> {
    let text = payload.text.trim();
    if text.is_empty() {
        return Err("Missing text".into());
    }

    let voice = payload.voice.unwrap_or_default();
    let rate = payload.rate.unwrap_or(0).clamp(-10, 10);
    let volume = payload.volume.unwrap_or(100).clamp(0, 100);

    let mut out: PathBuf = std::env::temp_dir();
    out.push(format!("luczor_tts_{}.wav", uuid::Uuid::new_v4()));
    let out_str = out.to_string_lossy().to_string();

    // PowerShell + System.Speech Synthesizer -> WAV
    // Voice: optional; wenn leer, nimmt Windows Default.
    let ps = format!(r#"
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = {rate}
$s.Volume = {volume}
if ("{voice}" -ne "Microsoft Stefan Desktop") {{ $s.SelectVoice("{voice}") }}
$s.SetOutputToWaveFile("{out_file}")
$s.Speak(@"
{text}
"@)
$s.Dispose()
"#,
        rate = rate,
        volume = volume,
        voice = escape_ps_string(&voice),
        out_file = escape_ps_string(&out_str),
        text = text.replace("\"", "`\"")
    );

    let status = Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps])
        .status()
        .map_err(|e| format!("Failed to run PowerShell: {e}"))?;

    if !status.success() {
        return Err("PowerShell TTS failed".into());
    }

    let bytes = fs::read(&out).map_err(|e| format!("Read wav failed: {e}"))?;
    let _ = fs::remove_file(&out);

    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);

    Ok(SpeechTtsResponse {
        base64: b64,
        mime: "audio/wav".to_string(),
    })
}

fn escape_ps_string(s: &str) -> String {
    s.replace("`", "``").replace("\"", "`\"")
}
