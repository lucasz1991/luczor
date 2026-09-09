//! Real image artifacts and local Windows OCR; unsupported multimodal inference stays unavailable.
use super::execution::{admit, Guarded};
use super::workflow_artifacts::{self, WorkflowArtifactScope};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, WebviewWindow};

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImageOperation {
    Capabilities,
    Capture,
    Ocr,
    Compare,
    Vision,
    PrepareVision,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowImageAction {
    scope: WorkflowArtifactScope,
    action: ImageOperation,
    artifact_id: Option<String>,
    other_artifact_id: Option<String>,
    language: Option<String>,
    monitor_id: Option<u32>,
    max_chars: Option<usize>,
}

#[tauri::command]
pub async fn wf_image_action(
    app: AppHandle,
    window: WebviewWindow,
    payload: Guarded<WorkflowImageAction>,
) -> Result<Value, String> {
    super::ensure_main_webview(&window)?;
    if payload.execution.workflow_execution_id.is_none() {
        return Err("workflow_execution_identity_required".into());
    }
    let gate = admit(&payload.execution, false)?;
    let input = payload.request;
    if input
        .max_chars
        .is_some_and(|chars| chars == 0 || chars > 100_000)
        || input.language.as_ref().is_some_and(|language| {
            language.is_empty()
                || language.len() > 40
                || !language
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return Err("workflow_image_options_invalid".into());
    }
    input.scope.check(&app)?;
    if input.action == ImageOperation::Vision {
        return Err("workflow_vision_multimodal_runtime_unavailable".into());
    }
    if input.action == ImageOperation::Capture {
        gate.check()?;
        let capture = super::system::capture_screen(
            window,
            Some(super::system::ScreenCapturePayload {
                monitor_id: input.monitor_id,
            }),
        )
        .await?;
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(capture.base64)
            .map_err(|_| "workflow_image_capture_invalid")?;
        let check = || {
            gate.check()?;
            input.scope.check(&app)
        };
        check()?;
        return serde_json::to_value(workflow_artifacts::store(
            &app,
            &input.scope,
            &bytes,
            "image/png",
            "screen.png",
            &check,
        )?)
        .map_err(|_| "workflow_artifact_invalid".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let check = || {
            gate.check()?;
            input.scope.check(&app)
        };
        check()?;
        if input.action == ImageOperation::Capabilities {
            return ocr_capabilities();
        }
        let id = input
            .artifact_id
            .as_deref()
            .ok_or("workflow_image_artifact_required")?;
        let (artifact, bytes) = workflow_artifacts::load(&app, &input.scope, id, &check)?;
        if artifact.mime != "image/png" {
            return Err("workflow_image_png_required".into());
        }
        if input.action == ImageOperation::PrepareVision {
            return prepare_vision(&artifact, &bytes, &check);
        }
        if input.action == ImageOperation::Compare {
            let other_id = input
                .other_artifact_id
                .as_deref()
                .ok_or("workflow_image_comparison_artifact_required")?;
            let (other, other_bytes) =
                workflow_artifacts::load(&app, &input.scope, other_id, &check)?;
            if other.mime != "image/png" {
                return Err("workflow_image_png_required".into());
            }
            let result = compare(&bytes, &other_bytes, &check)?;
            check()?;
            return Ok(result);
        }
        let result = recognize(
            &bytes,
            input.language.as_deref(),
            input.max_chars.unwrap_or(20000),
            &check,
        )?;
        check()?;
        Ok(result)
    })
    .await
    .map_err(|_| "workflow_image_task_failed")?
}

/// Exports only one already-owned artifact for a separately approved inference request.
/// This is transport preparation, not evidence that the resident model supports images.
fn prepare_vision(
    artifact: &workflow_artifacts::WorkflowArtifact,
    bytes: &[u8],
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    check()?;
    if artifact.mime != "image/png" || bytes.is_empty() || bytes.len() > 2 * 1024 * 1024 {
        return Err("workflow_vision_image_budget_invalid".into());
    }
    if artifact.bytes != bytes.len() as u64
        || artifact.sha256 != format!("{:x}", Sha256::digest(bytes))
    {
        return Err("workflow_vision_artifact_integrity_invalid".into());
    }
    // Decode the bounded PNG to reject truncated images and mismatching metadata.
    let image = decode(bytes)?;
    if artifact.width != Some(image.width()) || artifact.height != Some(image.height()) {
        return Err("workflow_vision_image_dimensions_invalid".into());
    }
    check()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    check()?;
    Ok(json!({
        "artifact": {
            "artifactId": artifact.artifact_id,
            "mime": "image/png", "bytes": artifact.bytes, "sha256": artifact.sha256,
            "width": image.width(), "height": image.height()
        },
        "base64": encoded
    }))
}

fn decode(bytes: &[u8]) -> Result<image::RgbaImage, String> {
    let dimensions =
        image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Png)
            .into_dimensions()
            .map_err(|_| "workflow_image_invalid")?;
    if dimensions.0 == 0
        || dimensions.1 == 0
        || u64::from(dimensions.0) * u64::from(dimensions.1) > 16_000_000
    {
        return Err("workflow_image_pixel_budget_exceeded".into());
    }
    image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map(|image| image.to_rgba8())
        .map_err(|_| "workflow_image_invalid".into())
}
fn compare(
    left: &[u8],
    right: &[u8],
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    check()?;
    let left = decode(left)?;
    check()?;
    let right = decode(right)?;
    if left.dimensions() != right.dimensions() {
        return Ok(json!({"ok":true,"identical":false,"sameDimensions":false}));
    }
    let mut changed = 0u64;
    for (index, (a, b)) in left.pixels().zip(right.pixels()).enumerate() {
        if index % 65536 == 0 {
            check()?;
        }
        if a != b {
            changed += 1;
        }
    }
    let pixels = u64::from(left.width()) * u64::from(left.height());
    Ok(
        json!({"ok":true,"identical":changed==0,"sameDimensions":true,"changedPixels":changed,"totalPixels":pixels,"differentFraction":changed as f64/pixels as f64,"method":"exact-rgba-pixel-comparison"}),
    )
}

#[cfg(windows)]
struct WinRt;
#[cfg(windows)]
impl WinRt {
    fn initialize() -> Result<Self, String> {
        unsafe {
            windows::Win32::System::WinRT::RoInitialize(
                windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
            )
        }
        .map_err(|_| "workflow_ocr_windows_runtime_unavailable")?;
        Ok(Self)
    }
}
#[cfg(windows)]
impl Drop for WinRt {
    fn drop(&mut self) {
        unsafe {
            windows::Win32::System::WinRT::RoUninitialize();
        }
    }
}

#[cfg(windows)]
pub(crate) fn ocr_capabilities() -> Result<Value, String> {
    use windows::Media::Ocr::OcrEngine;
    let _runtime = WinRt::initialize()?;
    let languages = OcrEngine::AvailableRecognizerLanguages()
        .map_err(|_| "workflow_ocr_languages_unavailable")?;
    let mut installed = Vec::new();
    for index in 0..languages
        .Size()
        .map_err(|_| "workflow_ocr_languages_unavailable")?
        .min(100)
    {
        installed.push(
            languages
                .GetAt(index)
                .and_then(|language| language.LanguageTag())
                .map_err(|_| "workflow_ocr_languages_unavailable")?
                .to_string(),
        );
    }
    Ok(
        json!({"ok":true,"ocrAvailable":!installed.is_empty(),"ocrLanguages":installed,"maxImageDimension":OcrEngine::MaxImageDimension().map_err(|_| "workflow_ocr_engine_unavailable")?,"visionAvailable":false,"visionReason":"multimodal_runtime_unavailable","comparison":"exact-rgba-pixels"}),
    )
}
#[cfg(not(windows))]
pub(crate) fn ocr_capabilities() -> Result<Value, String> {
    Ok(
        json!({"ok":true,"ocrAvailable":false,"ocrLanguages":[],"ocrReason":"windows_ocr_required","visionAvailable":false,"visionReason":"multimodal_runtime_unavailable"}),
    )
}

#[cfg(windows)]
fn recognize(
    bytes: &[u8],
    language: Option<&str>,
    maximum: usize,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    use windows::{
        Globalization::Language,
        Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap},
        Media::Ocr::OcrEngine,
        Storage::Streams::DataWriter,
    };
    let _runtime = WinRt::initialize()?;
    let engine = if let Some(tag) = language {
        let selected = Language::CreateLanguage(&windows::core::HSTRING::from(tag))
            .map_err(|_| "workflow_ocr_language_invalid")?;
        if !OcrEngine::IsLanguageSupported(&selected)
            .map_err(|_| "workflow_ocr_language_unavailable")?
        {
            return Err("workflow_ocr_language_not_installed".into());
        }
        OcrEngine::TryCreateFromLanguage(&selected)
    } else {
        OcrEngine::TryCreateFromUserProfileLanguages()
    }
    .map_err(|_| "workflow_ocr_engine_unavailable")?;
    check()?;
    let image = decode(bytes)?;
    let width = image.width();
    let height = image.height();
    let max_dimension =
        OcrEngine::MaxImageDimension().map_err(|_| "workflow_ocr_engine_unavailable")?;
    if width > max_dimension || height > max_dimension {
        return Err("workflow_ocr_image_dimensions_exceeded".into());
    }
    let mut pixels = image.into_raw();
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    let writer = DataWriter::new().map_err(|_| "workflow_ocr_bitmap_unavailable")?;
    writer
        .WriteBytes(&pixels)
        .map_err(|_| "workflow_ocr_bitmap_unavailable")?;
    let buffer = writer
        .DetachBuffer()
        .map_err(|_| "workflow_ocr_bitmap_unavailable")?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        width as i32,
        height as i32,
        BitmapAlphaMode::Ignore,
    )
    .map_err(|_| "workflow_ocr_bitmap_unavailable")?;
    check()?;
    let operation = engine
        .RecognizeAsync(&bitmap)
        .map_err(|_| "workflow_ocr_start_failed")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while operation
        .Status()
        .map_err(|_| "workflow_ocr_status_failed")?
        .0
        == 0
    {
        if let Err(error) = check() {
            let _ = operation.Cancel();
            return Err(error);
        }
        if std::time::Instant::now() >= deadline {
            let _ = operation.Cancel();
            return Err("workflow_ocr_timeout".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
    let result = operation.GetResults().map_err(|_| "workflow_ocr_failed")?;
    let text = result
        .Text()
        .map_err(|_| "workflow_ocr_result_invalid")?
        .to_string();
    let selected = engine
        .RecognizerLanguage()
        .and_then(|language| language.LanguageTag())
        .map_err(|_| "workflow_ocr_language_unavailable")?
        .to_string();
    check()?;
    Ok(
        json!({"ok":true,"text":text.chars().take(maximum).collect::<String>(),"truncated":text.chars().count()>maximum,"language":selected,"method":"windows-ocr"}),
    )
}
#[cfg(not(windows))]
fn recognize(
    _bytes: &[u8],
    _language: Option<&str>,
    _maximum: usize,
    _check: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    Err("workflow_ocr_requires_windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(pixel: [u8; 4]) -> Vec<u8> {
        use image::ImageEncoder;
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&pixel, 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        bytes
    }
    #[test]
    fn comparison_uses_real_pixels_and_obeys_revocation() {
        let left = png([1, 2, 3, 255]);
        let right = png([1, 2, 4, 255]);
        assert_eq!(
            compare(&left, &left, &|| Ok(())).unwrap()["identical"],
            true
        );
        assert_eq!(
            compare(&left, &right, &|| Ok(())).unwrap()["changedPixels"],
            1
        );
        assert!(compare(&left, &right, &|| Err("revoked".into())).is_err());
        assert!(decode(b"invalid").is_err());
    }
    #[test]
    fn vision_export_binds_owned_bytes_and_dimensions_without_claiming_inference() {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let bytes = png([1, 2, 3, 255]);
        let mut artifact = workflow_artifacts::WorkflowArtifact {
            artifact_id: uuid::Uuid::new_v4().to_string(),
            mime: "image/png".into(), bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            name: "private-name.png".into(), width: Some(1), height: Some(1),
        };
        let result = prepare_vision(&artifact, &bytes, &|| Ok(())).unwrap();
        assert_eq!(result["artifact"]["sha256"], artifact.sha256);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(result["base64"].as_str().unwrap()).unwrap(), bytes);
        assert!(result["artifact"].get("name").is_none());
        assert!(prepare_vision(&artifact, &bytes, &|| Err("revoked".into())).is_err());
        artifact.width = Some(2);
        assert!(prepare_vision(&artifact, &bytes, &|| Ok(())).is_err());
        artifact.width = Some(1);
        artifact.bytes += 1;
        assert!(prepare_vision(&artifact, &bytes, &|| Ok(())).is_err());
        artifact.bytes -= 1;
        artifact.sha256 = "0".repeat(64);
        assert!(prepare_vision(&artifact, &bytes, &|| Ok(())).is_err());
        assert!(prepare_vision(&artifact, &vec![0; 2 * 1024 * 1024 + 1], &|| Ok(())).is_err());
    }
}
