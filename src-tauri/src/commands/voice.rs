use base64::Engine;
use rsa::pkcs1v15::{Signature, VerifyingKey};
use rsa::pkcs8::DecodePublicKey;
use rsa::signature::Verifier;
use rsa::RsaPublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

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
pub async fn voice_runtime_status(app: AppHandle) -> Result<VoiceRuntimeStatus, String> {
    Ok(status(&app))
}

#[tauri::command]
pub async fn install_voice_runtime(
    app: AppHandle,
    payload: VoiceManifestInstallPayload,
) -> Result<VoiceRuntimeStatus, String> {
    verify_manifest(&payload.payload_json, &payload.signature)?;
    let manifest: VoiceManifest = serde_json::from_str(&payload.payload_json)
        .map_err(|error| structured_error("invalid_manifest", &error.to_string()))?;
    if manifest.version.trim().is_empty() || manifest.assets.is_empty() {
        return Err(structured_error("invalid_manifest", "Version oder Assets fehlen."));
    }

    let platform = current_platform();
    let required = ["stt_binary", "stt_model", "tts_binary", "tts_model"];
    let mut selected = Vec::new();
    for kind in required {
        let asset = manifest
            .assets
            .iter()
            .find(|asset| asset.kind == kind && (asset.platform == platform || asset.platform == "any"))
            .ok_or_else(|| structured_error("asset_missing", &format!("Release enthält kein Asset für {kind} auf {platform}.")))?;
        validate_asset(asset)?;
        selected.push(asset);
    }

    let root = runtime_root(&app)?;
    let target = root.join(&manifest.version);
    std::fs::create_dir_all(&target).map_err(|error| structured_error("install_directory", &error.to_string()))?;
    let mut paths = BTreeMap::new();

    if let Some(config) = manifest.assets.iter().find(|asset| asset.kind == "tts_config" && (asset.platform == platform || asset.platform == "any")) {
        validate_asset(config)?;
        selected.push(config);
    }

    for asset in selected {
        let path = target.join(&asset.file_name);
        if ! valid_file_hash(&path, &asset.sha256)? {
            download(asset, &path)?;
        }
        let runtime_path = if asset.archive {
            let relative = asset.runtime_path.as_deref().ok_or_else(|| structured_error("archive_runtime_path", &format!("Runtime-Pfad für {} fehlt.", asset.id)))?;
            let extracted = target.join(relative);
            if ! extracted.is_file() { extract_zip(&path, &target)?; }
            if ! extracted.is_file() { return Err(structured_error("archive_runtime_missing", &format!("{} wurde nicht im Runtime-Archiv gefunden.", relative))); }
            extracted
        } else { path };
        if asset.executable { make_executable(&runtime_path)?; }
        paths.insert(asset.kind.clone(), runtime_path.to_string_lossy().to_string());
    }

    let state = RuntimeState { version: manifest.version, paths };
    write_state(&app, &state)?;
    Ok(status(&app))
}

#[tauri::command]
pub async fn local_stt(app: AppHandle, payload: LocalSttPayload) -> Result<LocalSttResponse, String> {
    let runtime = ready_runtime(&app, "stt_binary", "stt_model")?;
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
    let output = Command::new(&runtime.paths["stt_binary"])
        .args(args)
        .output()
        .map_err(|error| structured_error("stt_start", &error.to_string()))?;
    let _ = std::fs::remove_file(wav);
    if !output.status.success() {
        return Err(structured_error("stt_runtime", &String::from_utf8_lossy(&output.stderr)));
    }
    Ok(LocalSttResponse { text: String::from_utf8_lossy(&output.stdout).trim().to_string() })
}

#[tauri::command]
pub async fn local_tts(app: AppHandle, payload: LocalTtsPayload) -> Result<LocalTtsResponse, String> {
    let text = payload.text.trim();
    if text.is_empty() {
        return Err(structured_error("tts_input", "Kein Text."));
    }
    let runtime = ready_runtime(&app, "tts_binary", "tts_model")?;
    let mut out = std::env::temp_dir();
    out.push(format!("luczor_tts_{}.wav", uuid::Uuid::new_v4()));
    let mut child = Command::new(&runtime.paths["tts_binary"])
        .args(["--model", &runtime.paths["tts_model"], "--output_file", &out.to_string_lossy()])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| structured_error("tts_start", &error.to_string()))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes()).map_err(|error| structured_error("tts_input", &error.to_string()))?;
    }
    let output = child.wait_with_output().map_err(|error| structured_error("tts_runtime", &error.to_string()))?;
    if !output.status.success() {
        return Err(structured_error("tts_runtime", &String::from_utf8_lossy(&output.stderr)));
    }
    let bytes = std::fs::read(&out).map_err(|error| structured_error("tts_output", &error.to_string()))?;
    let _ = std::fs::remove_file(out);
    Ok(LocalTtsResponse { base64: base64::engine::general_purpose::STANDARD.encode(bytes), mime: "audio/wav".to_string() })
}

fn ready_runtime(app: &AppHandle, first: &str, second: &str) -> Result<RuntimeState, String> {
    let state = read_state(app)?.ok_or_else(|| structured_error("runtime_missing", "Lokale Sprachkomponenten werden automatisch vorbereitet. Bitte erneut versuchen."))?;
    for key in [first, second] {
        let path = state.paths.get(key).ok_or_else(|| structured_error("runtime_incomplete", &format!("Komponente {key} fehlt.")))?;
        if !Path::new(path).is_file() {
            return Err(structured_error("runtime_incomplete", &format!("Komponente {key} ist nicht verfügbar.")));
        }
    }
    Ok(state)
}

fn status(app: &AppHandle) -> VoiceRuntimeStatus {
    match read_state(app) {
        Ok(Some(state)) => {
            let stt_ready = state.paths.get("stt_binary").is_some_and(|path| Path::new(path).is_file())
                && state.paths.get("stt_model").is_some_and(|path| Path::new(path).is_file());
            let tts_ready = state.paths.get("tts_binary").is_some_and(|path| Path::new(path).is_file())
                && state.paths.get("tts_model").is_some_and(|path| Path::new(path).is_file());
            let error = if !(stt_ready && tts_ready) && MANIFEST_PUBLIC_KEY_B64.is_none() {
                Some(structured_error("manifest_key_missing", "Die Tauri-App wurde ohne Voice-Manifest-Public-Key gebaut."))
            } else { None };
            VoiceRuntimeStatus { state: if stt_ready && tts_ready { "ready".into() } else { "incomplete".into() }, version: Some(state.version), stt_ready, tts_ready, error }
        }
        Ok(None) => VoiceRuntimeStatus { state: "missing".into(), version: None, stt_ready: false, tts_ready: false, error: MANIFEST_PUBLIC_KEY_B64.is_none().then(|| structured_error("manifest_key_missing", "Die Tauri-App wurde ohne Voice-Manifest-Public-Key gebaut.")) },
        Err(error) => VoiceRuntimeStatus { state: "error".into(), version: None, stt_ready: false, tts_ready: false, error: Some(error) },
    }
}

fn verify_manifest(payload: &str, signature: &str) -> Result<(), String> {
    let key_b64 = MANIFEST_PUBLIC_KEY_B64.ok_or_else(|| structured_error("manifest_key_missing", "Diese App-Version enthält keinen Voice-Release-Schlüssel."))?;
    let pem = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(key_b64).map_err(|error| structured_error("manifest_key", &error.to_string()))?)
        .map_err(|error| structured_error("manifest_key", &error.to_string()))?;
    let key = RsaPublicKey::from_public_key_pem(&pem).map_err(|error| structured_error("manifest_key", &error.to_string()))?;
    let signature = Signature::try_from(base64::engine::general_purpose::STANDARD.decode(signature).map_err(|error| structured_error("manifest_signature", &error.to_string()))?.as_slice())
        .map_err(|error| structured_error("manifest_signature", &error.to_string()))?;
    VerifyingKey::<Sha256>::new(key).verify(payload.as_bytes(), &signature)
        .map_err(|_| structured_error("manifest_signature", "Die Voice-Manifest-Signatur ist ungültig."))
}

fn validate_asset(asset: &VoiceAsset) -> Result<(), String> {
    if !safe_asset_url(&asset.url) || asset.file_name.is_empty() || asset.file_name.contains('/') || asset.file_name.contains('\\') || asset.sha256.len() != 64 {
        return Err(structured_error("asset_invalid", &format!("Ungültiges Asset {}.", asset.id)));
    }
    if asset.archive {
        let runtime = asset.runtime_path.as_deref().unwrap_or("");
        if !asset.file_name.to_ascii_lowercase().ends_with(".zip") || runtime.is_empty() || runtime.starts_with('/') || runtime.contains("..") || runtime.contains('\\') {
            return Err(structured_error("asset_invalid", &format!("Ungültiges Runtime-Archiv {}.", asset.id)));
        }
    }
    Ok(())
}

fn safe_asset_url(url: &str) -> bool {
    url.starts_with("https://")
}

fn extract_zip(archive_path: &Path, target: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|error| structured_error("archive_read", &error.to_string()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| structured_error("archive_read", &error.to_string()))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| structured_error("archive_read", &error.to_string()))?;
        let Some(relative) = entry.enclosed_name().map(|path| path.to_owned()) else { continue; };
        let destination = target.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&destination).map_err(|error| structured_error("archive_extract", &error.to_string()))?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|error| structured_error("archive_extract", &error.to_string()))?;
        }
        let mut output = File::create(&destination).map_err(|error| structured_error("archive_extract", &error.to_string()))?;
        std::io::copy(&mut entry, &mut output).map_err(|error| structured_error("archive_extract", &error.to_string()))?;
    }
    Ok(())
}

fn download(asset: &VoiceAsset, target: &Path) -> Result<(), String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build().map_err(|error| structured_error("download_client", &error.to_string()))?
        .get(&asset.url).send().map_err(|error| structured_error("download_failed", &error.to_string()))?;
    if !response.status().is_success() {
        return Err(structured_error("download_failed", &format!("HTTP {} für {}", response.status(), asset.id)));
    }
    let bytes = response.bytes().map_err(|error| structured_error("download_failed", &error.to_string()))?;
    let hash = hex_sha256(&bytes);
    if !hash.eq_ignore_ascii_case(&asset.sha256) {
        return Err(structured_error("checksum_failed", &format!("Prüfsumme für {} stimmt nicht.", asset.id)));
    }
    let partial = target.with_extension("part");
    std::fs::write(&partial, bytes).map_err(|error| structured_error("download_write", &error.to_string()))?;
    std::fs::rename(&partial, target).map_err(|error| structured_error("download_write", &error.to_string()))
}

fn valid_file_hash(path: &Path, expected: &str) -> Result<bool, String> {
    if !path.is_file() { return Ok(false); }
    let bytes = std::fs::read(path).map_err(|error| structured_error("runtime_read", &error.to_string()))?;
    Ok(hex_sha256(&bytes).eq_ignore_ascii_case(expected))
}

fn hex_sha256(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app.path().app_data_dir().map_err(|error| structured_error("runtime_directory", &error.to_string()))?.join("voice");
    std::fs::create_dir_all(&root).map_err(|error| structured_error("runtime_directory", &error.to_string()))?;
    Ok(root)
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(runtime_root(app)?.join("runtime.json")) }
fn read_state(app: &AppHandle) -> Result<Option<RuntimeState>, String> {
    let path = state_path(app)?;
    if !path.is_file() { return Ok(None); }
    let data = std::fs::read_to_string(path).map_err(|error| structured_error("runtime_read", &error.to_string()))?;
    serde_json::from_str(&data).map(Some).map_err(|error| structured_error("runtime_state", &error.to_string()))
}
fn write_state(app: &AppHandle, state: &RuntimeState) -> Result<(), String> {
    let path = state_path(app)?;
    let partial = path.with_extension("part");
    std::fs::write(&partial, serde_json::to_vec(state).map_err(|error| structured_error("runtime_state", &error.to_string()))?)
        .map_err(|error| structured_error("runtime_state", &error.to_string()))?;
    std::fs::rename(partial, path).map_err(|error| structured_error("runtime_state", &error.to_string()))
}

fn write_temp(bytes: &[u8], ext: &str) -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("luczor_voice_{}.{}", uuid::Uuid::new_v4(), ext));
    std::fs::write(&path, bytes).map_err(|error| structured_error("audio_temp", &error.to_string()))?;
    Ok(path)
}
fn normalize_base64(value: &str) -> &str { value.split_once(',').map(|(_, rest)| rest).unwrap_or(value) }
fn current_platform() -> String { format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH) }
fn structured_error(code: &str, message: &str) -> String { serde_json::json!({"code": code, "message": message}).to_string() }

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path).map_err(|error| structured_error("runtime_permissions", &error.to_string()))?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(path, permissions).map_err(|error| structured_error("runtime_permissions", &error.to_string()))
}
#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> { Ok(()) }
