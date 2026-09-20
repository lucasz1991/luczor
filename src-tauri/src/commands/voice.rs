use base64::Engine;
use rsa::pkcs1v15::{Signature, VerifyingKey};
use rsa::pkcs8::DecodePublicKey;
use rsa::signature::Verifier;
use rsa::RsaPublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

use super::ensure_main_webview;

const MANIFEST_PUBLIC_KEY_B64: Option<&str> = option_env!("LUCZOR_VOICE_MANIFEST_PUBLIC_KEY_B64");

#[derive(Debug, Deserialize)]
pub struct VoiceManifestInstallPayload {
    pub payload_json: String,
    pub signature: String,
}

#[derive(Debug, Deserialize)]
struct VoiceManifest {
    version: String,
    assets: Vec<VoiceAsset>,
}

#[derive(Debug, Deserialize)]
struct VoiceAsset {
    id: String,
    kind: String,
    platform: String,
    url: String,
    sha256: String,
    file_name: String,
    #[serde(default)]
    executable: bool,
    #[serde(default)]
    archive: bool,
    #[serde(default)]
    runtime_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VoiceRuntimeStatus {
    pub state: String,
    pub version: Option<String>,
    pub stt_ready: bool,
    pub tts_ready: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct RuntimeState {
    version: String,
    paths: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct LocalSttPayload {
    pub base64: String,
    pub language: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LocalSttResponse {
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct LocalTtsPayload {
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct LocalTtsResponse {
    pub base64: String,
    pub mime: String,
}

#[tauri::command]
pub async fn voice_runtime_status(
    window: crate::commands::CallerWebview,
    app: AppHandle,
) -> Result<VoiceRuntimeStatus, String> {
    ensure_main_webview(&window)?;
    Ok(status(&app))
}

#[tauri::command]
pub async fn install_voice_runtime(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    payload: VoiceManifestInstallPayload,
) -> Result<VoiceRuntimeStatus, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || install_voice_runtime_sync(&app, payload))
        .await
        .map_err(|error| structured_error("task_join", &error.to_string()))?
}

fn install_voice_runtime_sync(
    app: &AppHandle,
    payload: VoiceManifestInstallPayload,
) -> Result<VoiceRuntimeStatus, String> {
    verify_manifest(&payload.payload_json, &payload.signature)?;
    let manifest: VoiceManifest = serde_json::from_str(&payload.payload_json)
        .map_err(|error| structured_error("invalid_manifest", &error.to_string()))?;
    if manifest.version.trim().is_empty() || manifest.assets.is_empty() {
        return Err(structured_error(
            "invalid_manifest",
            "Version oder Assets fehlen.",
        ));
    }

    let platform = current_platform();
    let required = ["stt_binary", "stt_model", "tts_binary", "tts_model"];
    let mut selected = Vec::new();
    for kind in required {
        let asset = manifest
            .assets
            .iter()
            .find(|asset| {
                asset.kind == kind && (asset.platform == platform || asset.platform == "any")
            })
            .ok_or_else(|| {
                structured_error(
                    "asset_missing",
                    &format!("Release enthält kein Asset für {kind} auf {platform}."),
                )
            })?;
        validate_asset(asset)?;
        selected.push(asset);
    }

    let root = runtime_root(app)?;
    let target = root.join(&manifest.version);
    std::fs::create_dir_all(&target)
        .map_err(|error| structured_error("install_directory", &error.to_string()))?;
    let mut paths = BTreeMap::new();

    if let Some(config) = manifest.assets.iter().find(|asset| {
        asset.kind == "tts_config" && (asset.platform == platform || asset.platform == "any")
    }) {
        validate_asset(config)?;
        selected.push(config);
    }

    for asset in selected {
        let path = target.join(&asset.file_name);
        if !valid_file_hash(&path, &asset.sha256)? {
            download(asset, &path)?;
        }
        let runtime_path = if asset.archive {
            let relative = asset.runtime_path.as_deref().ok_or_else(|| {
                structured_error(
                    "archive_runtime_path",
                    &format!("Runtime-Pfad für {} fehlt.", asset.id),
                )
            })?;
            let extracted = target.join(relative);
            if !extracted.is_file() {
                extract_zip(&path, &target)?;
            }
            if !extracted.is_file() {
                return Err(structured_error(
                    "archive_runtime_missing",
                    &format!("{} wurde nicht im Runtime-Archiv gefunden.", relative),
                ));
            }
            extracted
        } else {
            path
        };
        if asset.executable {
            make_executable(&runtime_path)?;
        }
        paths.insert(
            asset.kind.clone(),
            runtime_path.to_string_lossy().to_string(),
        );
    }

    let state = RuntimeState {
        version: manifest.version,
        paths,
    };
    write_state(app, &state)?;
    Ok(status(app))
}

#[tauri::command]
pub async fn local_stt(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    payload: LocalSttPayload,
) -> Result<LocalSttResponse, String> {
    ensure_main_webview(&window)?;
    let (operation, cancellation) = super::owned_processes::Operation::begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        cancellation.check()?;
        local_stt_sync(&app, payload)
    })
    .await
    .map_err(|error| structured_error("task_join", &error.to_string()))?
}

pub(super) fn local_stt_sync(
    app: &AppHandle,
    payload: LocalSttPayload,
) -> Result<LocalSttResponse, String> {
    let runtime = ready_runtime(app, "stt_binary", "stt_model")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(normalize_base64(&payload.base64))
        .map_err(|error| structured_error("audio_decode", &error.to_string()))?;
    let wav = write_temp(&bytes, "wav")?;
    let mut args = vec![
        "-m".to_string(),
        runtime.paths["stt_model"].clone(),
        "-f".to_string(),
        wav.to_string_lossy().to_string(),
        "-nt".to_string(),
    ];
    if let Some(language) = payload.language.filter(|value| !value.trim().is_empty()) {
        args.push("-l".to_string());
        args.push(language.trim().to_string());
    }
    let mut command = Command::new(&runtime.paths["stt_binary"]);
    command.args(args);
    let output = super::process::run_bounded_command(
        command,
        None,
        std::time::Duration::from_secs(120),
        1024 * 1024,
    );
    let _ = std::fs::remove_file(wav);
    let output = output.map_err(|error| structured_error("stt_start", &error.to_string()))?;
    if !output.success {
        return Err(structured_error("stt_runtime", &output.stderr));
    }
    Ok(LocalSttResponse {
        text: filter_recognizer_output(&output.stdout),
    })
}

/// SOLL §14 P5 — native whisper-rs STT with a long-lived context (selectable in
/// the admin as engine `whisper_rs`). Only functional when the app is built with
/// `--features whisper_rs` (needs CMake); otherwise it returns a clear error so
/// the client can fall back to the `whisper_local` (whisper.cpp) engine.
#[tauri::command]
pub async fn local_stt_rs(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    payload: LocalSttPayload,
) -> Result<LocalSttResponse, String> {
    ensure_main_webview(&window)?;
    #[cfg(feature = "whisper_rs")]
    {
        let (operation, cancellation) = super::owned_processes::Operation::begin()?;
        return tauri::async_runtime::spawn_blocking(move || {
            let _operation = operation;
            cancellation.check()?;
            let result = whisper_rs_stt(&app, payload);
            cancellation.check()?;
            result
        })
        .await
        .map_err(|error| structured_error("task_join", &error.to_string()))?;
    }
    #[cfg(not(feature = "whisper_rs"))]
    {
        let _ = (&app, &payload);
        Err(structured_error(
            "whisper_rs_not_built",
            "Diese App-Version wurde ohne whisper-rs gebaut. Im Admin die Engine 'whisper_local' wählen oder mit `--features whisper_rs` (benötigt CMake) neu bauen.",
        ))
    }
}

/// Native whisper-rs transcription. The context is loaded once per model path and
/// reused across segments (raw f32 PCM in). Feature-gated: unbuilt in CMake-less
/// environments; validate the exact whisper-rs 0.12 API on the first native build.
#[cfg(feature = "whisper_rs")]
fn whisper_rs_stt(app: &AppHandle, payload: LocalSttPayload) -> Result<LocalSttResponse, String> {
    use std::sync::{Arc, Mutex, OnceLock};
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    static CTX: OnceLock<Mutex<Option<(String, Arc<WhisperContext>)>>> = OnceLock::new();

    let runtime = ready_runtime(app, "stt_binary", "stt_model")?;
    let model_path = runtime.paths["stt_model"].clone();

    // Decode the incoming 16 kHz mono PCM16 WAV to f32 samples.
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(normalize_base64(&payload.base64))
        .map_err(|error| structured_error("audio_decode", &error.to_string()))?;
    let wav_path = write_temp(&bytes, "wav")?;
    let opened = hound::WavReader::open(&wav_path);
    let _ = std::fs::remove_file(&wav_path);
    let mut reader = opened.map_err(|error| structured_error("wav_open", &error.to_string()))?;
    let samples: Vec<f32> = reader
        .samples::<i16>()
        .map(|sample| sample.map(|value| value as f32 / 32768.0).unwrap_or(0.0))
        .collect();

    // Long-lived context, reused unless the model path changes.
    let cell = CTX.get_or_init(|| Mutex::new(None));
    let context = {
        let mut guard = cell
            .lock()
            .map_err(|_| structured_error("ctx_lock", "Kontext-Mutex vergiftet."))?;
        let needs_new = match guard.as_ref() {
            Some((path, _)) => path != &model_path,
            None => true,
        };
        if needs_new {
            let loaded =
                WhisperContext::new_with_params(&model_path, WhisperContextParameters::default())
                    .map_err(|error| structured_error("whisper_load", &error.to_string()))?;
            *guard = Some((model_path.clone(), Arc::new(loaded)));
        }
        guard.as_ref().map(|(_, ctx)| Arc::clone(ctx)).unwrap()
    };

    let mut state = context
        .create_state()
        .map_err(|error| structured_error("whisper_state", &error.to_string()))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_print_progress(false);
    params.set_print_special(false);
    params.set_print_realtime(false);
    params.set_no_timestamps(true);
    if let Some(language) = payload
        .language
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        params.set_language(Some(language.trim()));
    }
    state
        .full(params, &samples)
        .map_err(|error| structured_error("whisper_infer", &error.to_string()))?;

    let segments = state
        .full_n_segments()
        .map_err(|error| structured_error("whisper_segments", &error.to_string()))?;
    let mut text = String::new();
    for index in 0..segments {
        if let Ok(segment) = state.full_get_segment_text(index) {
            text.push_str(&segment);
            text.push(' ');
        }
    }

    Ok(LocalSttResponse {
        text: filter_recognizer_output(text.trim()),
    })
}

#[tauri::command]
pub async fn local_tts(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    payload: LocalTtsPayload,
) -> Result<LocalTtsResponse, String> {
    ensure_main_webview(&window)?;
    let (operation, cancellation) = super::owned_processes::Operation::begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        cancellation.check()?;
        local_tts_sync(&app, payload)
    })
    .await
    .map_err(|error| structured_error("task_join", &error.to_string()))?
}

fn local_tts_sync(app: &AppHandle, payload: LocalTtsPayload) -> Result<LocalTtsResponse, String> {
    let text = payload.text.trim();
    if text.is_empty() {
        return Err(structured_error("tts_input", "Kein Text."));
    }
    let runtime = ready_runtime(app, "tts_binary", "tts_model")?;
    let mut out = std::env::temp_dir();
    out.push(format!("luczor_tts_{}.wav", uuid::Uuid::new_v4()));
    let mut args = vec![
        "--model".to_string(),
        runtime.paths["tts_model"].clone(),
        "--output_file".to_string(),
        out.to_string_lossy().into_owned(),
    ];
    if let Some(config) = runtime.paths.get("tts_config") {
        if !Path::new(config).is_file() {
            return Err(structured_error(
                "runtime_incomplete",
                "Komponente tts_config ist nicht verfuegbar.",
            ));
        }
        args.push("--config".to_string());
        args.push(config.clone());
    }

    let mut command = Command::new(&runtime.paths["tts_binary"]);
    command.args(&args);
    let result = super::process::run_bounded_command(
        command,
        Some(text.as_bytes().to_vec()),
        std::time::Duration::from_secs(120),
        64 * 1024,
    );
    let output = match result {
        Ok(output) => output,
        Err(error) => {
            let _ = std::fs::remove_file(&out);
            return Err(structured_error("tts_runtime", &error));
        }
    };
    if !output.success {
        let _ = std::fs::remove_file(&out);
        return Err(structured_error("tts_runtime", &output.stderr));
    }
    let bytes = std::fs::read(&out);
    let _ = std::fs::remove_file(out);
    let bytes = bytes.map_err(|error| structured_error("tts_output", &error.to_string()))?;
    Ok(LocalTtsResponse {
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime: "audio/wav".to_string(),
    })
}

fn filter_recognizer_output(output: &str) -> String {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !is_non_speech_recognizer_marker(line))
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_non_speech_recognizer_marker(value: &str) -> bool {
    let value = value.trim();
    let Some(marker) = value
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .or_else(|| {
            value
                .strip_prefix('(')
                .and_then(|value| value.strip_suffix(')'))
        })
    else {
        return false;
    };
    let normalized = marker
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect::<String>();
    matches!(normalized.as_str(), "blankaudio" | "music" | "musik")
}

fn ready_runtime(app: &AppHandle, first: &str, second: &str) -> Result<RuntimeState, String> {
    let state = read_state(app)?.ok_or_else(|| {
        structured_error(
            "runtime_missing",
            "Lokale Sprachkomponenten werden automatisch vorbereitet. Bitte erneut versuchen.",
        )
    })?;
    for key in [first, second] {
        let path = state.paths.get(key).ok_or_else(|| {
            structured_error("runtime_incomplete", &format!("Komponente {key} fehlt."))
        })?;
        if !Path::new(path).is_file() {
            return Err(structured_error(
                "runtime_incomplete",
                &format!("Komponente {key} ist nicht verfügbar."),
            ));
        }
    }
    Ok(state)
}

pub(super) fn status(app: &AppHandle) -> VoiceRuntimeStatus {
    match read_state(app) {
        Ok(Some(state)) => {
            let stt_ready = state
                .paths
                .get("stt_binary")
                .is_some_and(|path| Path::new(path).is_file())
                && state
                    .paths
                    .get("stt_model")
                    .is_some_and(|path| Path::new(path).is_file());
            let tts_ready = state
                .paths
                .get("tts_binary")
                .is_some_and(|path| Path::new(path).is_file())
                && state
                    .paths
                    .get("tts_model")
                    .is_some_and(|path| Path::new(path).is_file())
                && state
                    .paths
                    .get("tts_config")
                    .map(|path| Path::new(path).is_file())
                    .unwrap_or(true);
            let error = if !(stt_ready && tts_ready) && MANIFEST_PUBLIC_KEY_B64.is_none() {
                Some(structured_error(
                    "manifest_key_missing",
                    "Die Tauri-App wurde ohne Voice-Manifest-Public-Key gebaut.",
                ))
            } else {
                None
            };
            VoiceRuntimeStatus {
                state: if stt_ready && tts_ready {
                    "ready".into()
                } else {
                    "incomplete".into()
                },
                version: Some(state.version),
                stt_ready,
                tts_ready,
                error,
            }
        }
        Ok(None) => VoiceRuntimeStatus {
            state: "missing".into(),
            version: None,
            stt_ready: false,
            tts_ready: false,
            error: MANIFEST_PUBLIC_KEY_B64.is_none().then(|| {
                structured_error(
                    "manifest_key_missing",
                    "Die Tauri-App wurde ohne Voice-Manifest-Public-Key gebaut.",
                )
            }),
        },
        Err(error) => VoiceRuntimeStatus {
            state: "error".into(),
            version: None,
            stt_ready: false,
            tts_ready: false,
            error: Some(error),
        },
    }
}

fn verify_manifest(payload: &str, signature: &str) -> Result<(), String> {
    let key_b64 = MANIFEST_PUBLIC_KEY_B64.ok_or_else(|| {
        structured_error(
            "manifest_key_missing",
            "Diese App-Version enthält keinen Voice-Release-Schlüssel.",
        )
    })?;
    let pem = String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(key_b64)
            .map_err(|error| structured_error("manifest_key", &error.to_string()))?,
    )
    .map_err(|error| structured_error("manifest_key", &error.to_string()))?;
    let key = RsaPublicKey::from_public_key_pem(&pem)
        .map_err(|error| structured_error("manifest_key", &error.to_string()))?;
    let signature = Signature::try_from(
        base64::engine::general_purpose::STANDARD
            .decode(signature)
            .map_err(|error| structured_error("manifest_signature", &error.to_string()))?
            .as_slice(),
    )
    .map_err(|error| structured_error("manifest_signature", &error.to_string()))?;
    VerifyingKey::<Sha256>::new(key)
        .verify(payload.as_bytes(), &signature)
        .map_err(|_| {
            structured_error(
                "manifest_signature",
                "Die Voice-Manifest-Signatur ist ungültig.",
            )
        })
}

fn validate_asset(asset: &VoiceAsset) -> Result<(), String> {
    if !safe_asset_url(&asset.url)
        || asset.file_name.is_empty()
        || asset.file_name.contains('/')
        || asset.file_name.contains('\\')
        || asset.sha256.len() != 64
    {
        return Err(structured_error(
            "asset_invalid",
            &format!("Ungültiges Asset {}.", asset.id),
        ));
    }
    if asset.archive {
        let runtime = asset.runtime_path.as_deref().unwrap_or("");
        if !asset.file_name.to_ascii_lowercase().ends_with(".zip")
            || runtime.is_empty()
            || runtime.starts_with('/')
            || runtime.contains("..")
            || runtime.contains('\\')
        {
            return Err(structured_error(
                "asset_invalid",
                &format!("Ungültiges Runtime-Archiv {}.", asset.id),
            ));
        }
    }
    Ok(())
}

fn safe_asset_url(url: &str) -> bool {
    url.starts_with("https://")
}

fn extract_zip(archive_path: &Path, target: &Path) -> Result<(), String> {
    let file = File::open(archive_path)
        .map_err(|error| structured_error("archive_read", &error.to_string()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| structured_error("archive_read", &error.to_string()))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| structured_error("archive_read", &error.to_string()))?;
        let Some(relative) = entry.enclosed_name().map(|path| path.to_owned()) else {
            continue;
        };
        let destination = target.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&destination)
                .map_err(|error| structured_error("archive_extract", &error.to_string()))?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| structured_error("archive_extract", &error.to_string()))?;
        }
        let mut output = File::create(&destination)
            .map_err(|error| structured_error("archive_extract", &error.to_string()))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| structured_error("archive_extract", &error.to_string()))?;
    }
    Ok(())
}

fn download(asset: &VoiceAsset, target: &Path) -> Result<(), String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|error| structured_error("download_client", &error.to_string()))?
        .get(&asset.url)
        .send()
        .map_err(|error| structured_error("download_failed", &error.to_string()))?;
    if !response.status().is_success() {
        return Err(structured_error(
            "download_failed",
            &format!("HTTP {} für {}", response.status(), asset.id),
        ));
    }
    let bytes = response
        .bytes()
        .map_err(|error| structured_error("download_failed", &error.to_string()))?;
    let hash = hex_sha256(&bytes);
    if !hash.eq_ignore_ascii_case(&asset.sha256) {
        return Err(structured_error(
            "checksum_failed",
            &format!("Prüfsumme für {} stimmt nicht.", asset.id),
        ));
    }
    let partial = target.with_extension("part");
    std::fs::write(&partial, bytes)
        .map_err(|error| structured_error("download_write", &error.to_string()))?;
    std::fs::rename(&partial, target)
        .map_err(|error| structured_error("download_write", &error.to_string()))
}

fn valid_file_hash(path: &Path, expected: &str) -> Result<bool, String> {
    if !path.is_file() {
        return Ok(false);
    }
    let bytes = std::fs::read(path)
        .map_err(|error| structured_error("runtime_read", &error.to_string()))?;
    Ok(hex_sha256(&bytes).eq_ignore_ascii_case(expected))
}

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| structured_error("runtime_directory", &error.to_string()))?
        .join("voice");
    std::fs::create_dir_all(&root)
        .map_err(|error| structured_error("runtime_directory", &error.to_string()))?;
    Ok(root)
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("runtime.json"))
}
fn read_state(app: &AppHandle) -> Result<Option<RuntimeState>, String> {
    let path = state_path(app)?;
    if !path.is_file() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(path)
        .map_err(|error| structured_error("runtime_read", &error.to_string()))?;
    serde_json::from_str(&data)
        .map(Some)
        .map_err(|error| structured_error("runtime_state", &error.to_string()))
}
fn write_state(app: &AppHandle, state: &RuntimeState) -> Result<(), String> {
    let path = state_path(app)?;
    let partial = path.with_extension("part");
    std::fs::write(
        &partial,
        serde_json::to_vec(state)
            .map_err(|error| structured_error("runtime_state", &error.to_string()))?,
    )
    .map_err(|error| structured_error("runtime_state", &error.to_string()))?;
    std::fs::rename(partial, path)
        .map_err(|error| structured_error("runtime_state", &error.to_string()))
}

fn write_temp(bytes: &[u8], ext: &str) -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("luczor_voice_{}.{}", uuid::Uuid::new_v4(), ext));
    std::fs::write(&path, bytes)
        .map_err(|error| structured_error("audio_temp", &error.to_string()))?;
    Ok(path)
}
fn normalize_base64(value: &str) -> &str {
    value.split_once(',').map(|(_, rest)| rest).unwrap_or(value)
}
fn current_platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}
fn structured_error(code: &str, message: &str) -> String {
    serde_json::json!({"code": code, "message": message}).to_string()
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path)
        .map_err(|error| structured_error("runtime_permissions", &error.to_string()))?
        .permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(path, permissions)
        .map_err(|error| structured_error("runtime_permissions", &error.to_string()))
}
#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::filter_recognizer_output;

    #[test]
    fn removes_whisper_non_speech_markers_without_discarding_commands() {
        assert_eq!(filter_recognizer_output("[BLANK_AUDIO]"), "");
        assert_eq!(
            filter_recognizer_output("[Musik]\nStarte einen Timer"),
            "Starte einen Timer"
        );
        assert_eq!(filter_recognizer_output("spiele Musik"), "spiele Musik");
    }
}
