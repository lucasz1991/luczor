use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;

const SETTINGS_KEYS: &[&str] = &[
    "voice_mode",
    "voice_wake_word",
    "voice_trigger_phrase",
    "voice_end_phrase",
    "voice_end_mode",
    "voice_local_stt_language",
    "voice_continuous_silence_ms",
    "voice_auto_submit",
    "hands_free_strategy",
    "voice_stt_engine",
];

fn ensure_voice_window(window: &crate::commands::CallerWebview) -> Result<(), String> {
    match window.label() {
        "main" | "luczor-mini" => Ok(()),
        _ => Err("Spracheingabe ist nur im Haupt- und Mini-Chat verfügbar.".into()),
    }
}

fn allowed(resource: &str, values: &Map<String, Value>) -> bool {
    values.iter().all(|(key, value)| {
        if resource == "audio" {
            key == "triggers" && value.to_string().len() <= 2_000_000
        } else {
            SETTINGS_KEYS.contains(&key.as_str()) && value.to_string().len() <= 200
        }
    })
}

#[tauri::command]
pub fn voice_input_store(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    resource: String,
    values: Option<Map<String, Value>>,
) -> Result<Value, String> {
    ensure_voice_window(&window)?;
    let (file, keys): (&str, &[&str]) = match resource.as_str() {
        "settings" => ("luczor.settings.json", SETTINGS_KEYS),
        "audio" => ("luczor.audio-triggers.json", &["triggers"]),
        _ => return Err("Unbekannte Spracheinstellung.".into()),
    };
    if let Some(ref values) = values {
        if !allowed(&resource, values) {
            return Err("Unzulässige Spracheinstellung.".into());
        }
    }
    let store = app.store(file).map_err(|error| error.to_string())?;
    if let Some(values) = values {
        for (key, value) in values {
            store.set(key, value);
        }
        store.save().map_err(|error| error.to_string())?;
    }
    Ok(Value::Object(
        keys.iter()
            .filter_map(|key| store.get(key).map(|value| (key.to_string(), value)))
            .collect(),
    ))
}

#[tauri::command]
pub fn voice_input_claim(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    owner: String,
) -> Result<(), String> {
    ensure_voice_window(&window)?;
    if owner.len() > 80 {
        return Err("Ungültige Mikrofonkennung.".into());
    }
    app.emit("luczor:voice-input-claim", owner)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn voice_input_status(
    window: crate::commands::CallerWebview,
    app: AppHandle,
) -> Result<super::voice::VoiceRuntimeStatus, String> {
    ensure_voice_window(&window)?;
    Ok(super::voice::status(&app))
}

#[tauri::command]
pub async fn voice_input_stt(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    payload: super::voice::LocalSttPayload,
) -> Result<super::voice::LocalSttResponse, String> {
    ensure_voice_window(&window)?;
    if payload.base64.len() > 2_000_000
        || payload.language.as_ref().is_some_and(|language| {
            language.len() > 16
                || !language
                    .chars()
                    .all(|c| c.is_ascii_alphabetic() || c == '-')
        })
    {
        return Err("Ungültige oder zu lange Sprachaufnahme.".into());
    }
    let (operation, cancellation) = super::owned_processes::Operation::begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        cancellation.check()?;
        super::voice::local_stt_sync(&app, payload)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mini_store_rejects_credentials_paths_and_unbounded_payloads() {
        let map = |value: Value| value.as_object().unwrap().clone();
        assert!(!allowed(
            "settings",
            &map(serde_json::json!({"device_key": "secret"}))
        ));
        assert!(!allowed(
            "settings",
            &map(serde_json::json!({"local_model_path": "elsewhere"}))
        ));
        assert!(allowed(
            "settings",
            &map(serde_json::json!({"voice_end_mode": "either"}))
        ));
        assert!(!allowed(
            "audio",
            &map(serde_json::json!({"triggers": "x".repeat(2_000_001)}))
        ));
    }
}
