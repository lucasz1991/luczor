//! Offline STT shipped with the installer. No executable lookup, account or Python install.
use super::{
    filter_recognizer_output, normalize_base64, structured_error, LocalSttPayload, LocalSttResponse,
};
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager};
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

struct AbortCheck {
    cancellation: crate::commands::owned_processes::CancellationToken,
    started: Instant,
}

unsafe extern "C" fn should_abort(data: *mut std::ffi::c_void) -> bool {
    // `transcribe` owns this stack value until synchronous full() has joined its workers.
    let check = unsafe { &*(data.cast::<AbortCheck>()) };
    check.cancellation.check().is_err() || check.started.elapsed() > Duration::from_secs(30)
}

#[derive(Deserialize)]
struct Model {
    file: String,
    bytes: u64,
    sha256: String,
}

fn model() -> Model {
    serde_json::from_str(include_str!("../../../voice-model.json"))
        .expect("pinned voice model metadata")
}

pub(super) fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .resource_dir()
        .map_err(|e| structured_error("voice_resources", &e.to_string()))?;
    let installed = root.join("voice");
    #[cfg(debug_assertions)]
    if !installed.join(model().file).is_file() {
        return verified_model(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.lmzdev/artifacts/runtime/voice"),
        );
    }
    verified_model(&installed)
}

pub(super) fn verified_model(root: &Path) -> Result<PathBuf, String> {
    type Verified = (PathBuf, u64, Option<SystemTime>);
    static VERIFIED: OnceLock<Mutex<Option<Verified>>> = OnceLock::new();
    let expected = model();
    let path = root.join(&expected.file);
    let meta = std::fs::metadata(&path).map_err(|_| structured_error(
        "bundled_stt_missing", "Das mitgelieferte Whisper-Modell fehlt. Bitte die aktuelle vollständige Luczor-App installieren."))?;
    if !meta.is_file() || meta.len() != expected.bytes {
        return Err(structured_error(
            "bundled_stt_invalid",
            "Das mitgelieferte Whisper-Modell ist unvollständig.",
        ));
    }
    let identity = (path.clone(), meta.len(), meta.modified().ok());
    let mut verified = VERIFIED
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| structured_error("stt_lock", "Modellprüfung ist nicht verfügbar."))?;
    if verified.as_ref() != Some(&identity) {
        let mut file = std::fs::File::open(&path)
            .map_err(|e| structured_error("stt_model", &e.to_string()))?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = file
                .read(&mut buffer)
                .map_err(|e| structured_error("stt_model", &e.to_string()))?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        if format!("{:x}", hash.finalize()) != expected.sha256 {
            return Err(structured_error(
                "bundled_stt_invalid",
                "Die Prüfsumme des Whisper-Modells stimmt nicht.",
            ));
        }
        *verified = Some(identity);
    }
    Ok(path)
}

fn decode_audio(payload: &LocalSttPayload) -> Result<Vec<f32>, String> {
    if payload.base64.len() > 1_500_000 {
        return Err(structured_error(
            "stt_audio_limit",
            "Der Sprachabschnitt ist zu lang.",
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(normalize_base64(&payload.base64))
        .map_err(|e| structured_error("audio_decode", &e.to_string()))?;
    let mut reader = hound::WavReader::new(Cursor::new(bytes))
        .map_err(|e| structured_error("wav_open", &e.to_string()))?;
    let spec = reader.spec();
    if spec.channels != 1
        || spec.sample_rate != 16_000
        || spec.bits_per_sample != 16
        || spec.sample_format != hound::SampleFormat::Int
        || reader.duration() > 16_000 * 30
    {
        return Err(structured_error(
            "stt_audio_format",
            "Spracheingabe benötigt Mono-PCM mit 16 kHz und 16 Bit, maximal 30 Sekunden.",
        ));
    }
    reader
        .samples::<i16>()
        .map(|sample| {
            sample
                .map(|v| v as f32 / 32768.0)
                .map_err(|e| structured_error("wav_samples", &e.to_string()))
        })
        .collect()
}

fn language_code(value: Option<&str>) -> Result<Option<String>, String> {
    let code = value
        .unwrap_or("auto")
        .trim()
        .split(['-', '_'])
        .next()
        .unwrap_or("auto")
        .to_ascii_lowercase();
    if code.is_empty() || code == "auto" {
        return Ok(None);
    }
    if whisper_rs::get_lang_id(&code).is_none() {
        return Err(structured_error(
            "stt_language",
            "Die gewählte Sprache wird von Whisper nicht unterstützt.",
        ));
    }
    Ok(Some(code))
}

/// Cache both model and decoder buffers. Repeated live snapshots allocate neither a model nor a process.
pub(super) fn transcribe(
    path: &Path,
    payload: LocalSttPayload,
) -> Result<LocalSttResponse, String> {
    static DECODER: OnceLock<Mutex<Option<(PathBuf, WhisperState)>>> = OnceLock::new();
    let cancellation = crate::commands::owned_processes::CancellationToken::capture()?;
    let mut samples = decode_audio(&payload)?;
    if samples.is_empty() {
        return Ok(LocalSttResponse {
            text: String::new(),
        });
    }
    // Whisper requires at least one second; preserve short utterances with silent padding.
    samples.resize(samples.len().max(16_000), 0.0);
    let language = language_code(payload.language.as_deref())?;
    let mut cache = DECODER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| structured_error("stt_lock", "Spracherkennung ist nicht verfügbar."))?;
    cancellation.check()?;
    if cache.as_ref().is_none_or(|(loaded, _)| loaded != path) {
        let mut options = WhisperContextParameters::default();
        options.use_gpu(false); // Works on Linux without CUDA/driver installation.
        let context = WhisperContext::new_with_params(path, options)
            .map_err(|e| structured_error("whisper_load", &e.to_string()))?;
        let state = context
            .create_state()
            .map_err(|e| structured_error("whisper_state", &e.to_string()))?;
        *cache = Some((path.to_path_buf(), state));
    }
    cancellation.check()?;
    let state = &mut cache.as_mut().expect("loaded decoder").1;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let threads = std::thread::available_parallelism().map_or(2, |n| n.get().min(4));
    params.set_n_threads(threads as i32);
    params.set_print_progress(false);
    params.set_print_special(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_no_timestamps(true);
    params.set_no_context(true); // Each snapshot replaces a hypothesis; never carry the previous snapshot twice.
                                 // Whisper otherwise encodes 30 seconds even for a 1.25-second live preview.
                                 // Keep the complete captured audio plus padding; bound work by the actual window.
    let audio_context = ((samples.len().div_ceil(320) + 64).div_ceil(64) * 64).clamp(256, 1500);
    params.set_audio_ctx(audio_context as i32);
    params.set_translate(false);
    params.set_language(language.as_deref());
    params.set_temperature_inc(0.0); // Avoid repeated temperature fallback passes during dictation.
    let mut abort = AbortCheck {
        cancellation: cancellation.clone(),
        started: Instant::now(),
    };
    // whisper-rs 0.16's safe adapter boxes a trait object but casts it back to F.
    // Use the C API with an explicit, correctly typed lifetime instead.
    unsafe {
        params.set_abort_callback(Some(should_abort));
        params.set_abort_callback_user_data((&mut abort as *mut AbortCheck).cast());
    }
    let result = state.full(params, &samples);
    cancellation.check()?;
    result.map_err(|e| structured_error("whisper_infer", &e.to_string()))?;
    let mut text = String::new();
    for segment in state.as_iter() {
        text.push_str(
            &segment
                .to_str_lossy()
                .map_err(|e| structured_error("whisper_text", &e.to_string()))?,
        );
        text.push(' ');
    }
    Ok(LocalSttResponse {
        text: filter_recognizer_output(text.trim()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_regional_languages_and_rejects_unknown_codes() {
        assert_eq!(language_code(Some("de-DE")).unwrap(), Some("de".into()));
        assert_eq!(language_code(Some("en_US")).unwrap(), Some("en".into()));
        assert_eq!(language_code(Some("auto")).unwrap(), None);
        assert!(language_code(Some("invalid")).is_err());
    }

    #[test]
    fn rejects_wrong_audio_format_before_loading_the_model() {
        for (channels, sample_rate) in [(2, 16_000), (1, 48_000)] {
            let mut bytes = Cursor::new(Vec::new());
            let writer = hound::WavWriter::new(
                &mut bytes,
                hound::WavSpec {
                    channels,
                    sample_rate,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
            )
            .unwrap();
            writer.finalize().unwrap();
            let payload = LocalSttPayload {
                base64: base64::engine::general_purpose::STANDARD.encode(bytes.into_inner()),
                language: None,
            };
            assert!(decode_audio(&payload)
                .unwrap_err()
                .contains("stt_audio_format"));
        }
    }

    #[test]
    fn missing_or_truncated_model_is_not_ready() {
        let root = std::env::temp_dir().join(format!("luczor-model-test-{}", uuid::Uuid::new_v4()));
        assert!(verified_model(&root)
            .unwrap_err()
            .contains("bundled_stt_missing"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(model().file), b"partial download").unwrap();
        assert!(verified_model(&root)
            .unwrap_err()
            .contains("bundled_stt_invalid"));
        std::fs::remove_file(root.join(model().file)).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    #[ignore = "requires the prepared bundled model; no microphone or network"]
    fn bundled_whisper_recognizes_german_offline() {
        let root =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.lmzdev/artifacts/runtime/voice");
        let path = verified_model(&root).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/audio-triggers/close.wav");
        let mut input = hound::WavReader::open(fixture).unwrap();
        let rate = input.spec().sample_rate as usize;
        let pcm: Vec<i16> = input.samples().map(Result::unwrap).collect();
        let mut bytes = Cursor::new(Vec::new());
        let mut writer = hound::WavWriter::new(
            &mut bytes,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for n in 0..pcm.len() * 16_000 / rate {
            writer.write_sample(pcm[n * rate / 16_000]).unwrap();
        }
        writer.finalize().unwrap();
        let audio = base64::engine::general_purpose::STANDARD.encode(bytes.into_inner());
        for attempt in 0..2 {
            let start = Instant::now();
            let result = transcribe(
                &path,
                LocalSttPayload {
                    base64: audio.clone(),
                    language: Some("de-DE".into()),
                },
            )
            .unwrap();
            println!(
                "offline German STT attempt {attempt}: {:?}: {}",
                start.elapsed(),
                result.text
            );
            assert!(
                result.text.to_lowercase().contains("auftrag"),
                "{}",
                result.text
            );
            assert!(
                result.text.to_lowercase().contains("beenden"),
                "{}",
                result.text
            );
        }
    }
}
