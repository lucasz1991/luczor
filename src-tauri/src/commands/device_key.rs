use keyring::{Entry, Error as KeyringError};
use serde::Deserialize;
use tauri::{Manager};
use uuid::Uuid;

use super::ensure_main_webview;

const KEYRING_ACCOUNT: &str = "luczor_device_key";
const MEMORY_KEYRING_ACCOUNT: &str = "luczor_memory_encryption_key_v1";
const MAX_DEVICE_KEY_BYTES: usize = 4_096;

#[derive(Debug, Eq, PartialEq)]
struct KeyringTarget<'a> {
    service: &'a str,
    account: &'static str,
}

#[derive(Deserialize)]
pub struct DeviceKeyPayload {
    pub value: String,
}

/// Read the Luczor device credential from the current user's OS credential
/// store (Windows Credential Manager, macOS Keychain, Linux Secret Service).
#[tauri::command]
pub async fn device_key_get(window: crate::commands::CallerWebview) -> Result<Option<String>, String> {
    ensure_main_webview(&window)?;
    let app_identifier = active_app_identifier(&window);
    tauri::async_runtime::spawn_blocking(move || read_device_key(&app_identifier))
        .await
        .map_err(|error| format!("OS credential task failed: {error}"))?
}

/// Store only the device credential. No generic secret-name parameter is
/// accepted, so a compromised frontend cannot turn this into a keychain API.
#[tauri::command]
pub async fn device_key_set(
    window: crate::commands::CallerWebview,
    payload: DeviceKeyPayload,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    validate_device_key(&payload.value)?;
    let app_identifier = active_app_identifier(&window);
    tauri::async_runtime::spawn_blocking(move || {
        entry(&app_identifier)?
            .set_password(&payload.value)
            .map_err(map_keyring_error)
    })
    .await
    .map_err(|error| format!("OS credential task failed: {error}"))?
}

#[tauri::command]
pub async fn device_key_delete(window: crate::commands::CallerWebview) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let app_identifier = active_app_identifier(&window);
    tauri::async_runtime::spawn_blocking(move || {
        match entry(&app_identifier)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    })
    .await
    .map_err(|error| format!("OS credential task failed: {error}"))?
}

/// Return a stable random key seed kept only in the operating-system
/// credential store. The renderer derives an AES-256 key from this seed and
/// never persists it alongside the encrypted memory file.
#[tauri::command]
pub async fn memory_key_get_or_create(window: crate::commands::CallerWebview) -> Result<String, String> {
    ensure_main_webview(&window)?;
    let app_identifier = active_app_identifier(&window);
    tauri::async_runtime::spawn_blocking(move || {
        let entry = memory_entry(&app_identifier)?;
        match entry.get_password() {
            Ok(value) => validate_memory_key(&value).map(|_| value),
            Err(KeyringError::NoEntry) => {
                let value = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
                entry.set_password(&value).map_err(map_keyring_error)?;
                Ok(value)
            }
            Err(error) => Err(map_keyring_error(error)),
        }
    })
    .await
    .map_err(|error| format!("OS credential task failed: {error}"))?
}

fn active_app_identifier(window: &crate::commands::CallerWebview) -> String {
    window.app_handle().config().identifier.clone()
}

pub(super) fn read_device_key(app_identifier: &str) -> Result<Option<String>, String> {
    match entry(app_identifier)?.get_password() {
        Ok(value) => {
            validate_device_key(&value)?;
            Ok(Some(value))
        }
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(map_keyring_error(error)),
    }
}

fn entry(app_identifier: &str) -> Result<Entry, String> {
    let target = keyring_target(app_identifier, KEYRING_ACCOUNT);
    Entry::new(target.service, target.account).map_err(map_keyring_error)
}

fn memory_entry(app_identifier: &str) -> Result<Entry, String> {
    let target = keyring_target(app_identifier, MEMORY_KEYRING_ACCOUNT);
    Entry::new(target.service, target.account).map_err(map_keyring_error)
}

fn keyring_target<'a>(app_identifier: &'a str, account: &'static str) -> KeyringTarget<'a> {
    KeyringTarget {
        service: app_identifier,
        account,
    }
}

fn validate_device_key(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("Device key is empty.".into());
    }
    if value.len() > MAX_DEVICE_KEY_BYTES {
        return Err("Device key exceeds the 4096-byte limit.".into());
    }
    if value.chars().any(char::is_control) {
        return Err("Device key contains control characters.".into());
    }
    Ok(())
}

fn validate_memory_key(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The stored memory encryption key is invalid.".into());
    }
    Ok(())
}

fn map_keyring_error(error: KeyringError) -> String {
    match error {
        KeyringError::NoStorageAccess(_) => {
            "The operating-system credential store is locked or unavailable.".into()
        }
        KeyringError::NoDefaultStore | KeyringError::NotSupportedByStore(_) => {
            "No supported operating-system credential store is available.".into()
        }
        KeyringError::TooLong(_, _) => {
            "The device key exceeds the operating-system credential limit.".into()
        }
        _ => "The operating-system credential store operation failed.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        keyring_target, validate_device_key, validate_memory_key, KEYRING_ACCOUNT,
        MAX_DEVICE_KEY_BYTES, MEMORY_KEYRING_ACCOUNT,
    };

    const PRODUCTION_IDENTIFIER: &str = "de.luczor.desktop";
    const LOCAL_TEST_IDENTIFIER: &str = "de.luczor.desktop.local-test";

    #[test]
    fn app_identifier_is_the_keyring_service_boundary() {
        let production = keyring_target(PRODUCTION_IDENTIFIER, KEYRING_ACCOUNT);
        let local_test = keyring_target(LOCAL_TEST_IDENTIFIER, KEYRING_ACCOUNT);

        assert_eq!(production.service, PRODUCTION_IDENTIFIER);
        assert_eq!(local_test.service, LOCAL_TEST_IDENTIFIER);
        assert_ne!(production, local_test);
    }

    #[test]
    fn device_and_memory_keys_keep_distinct_accounts_per_app_identifier() {
        for identifier in [PRODUCTION_IDENTIFIER, LOCAL_TEST_IDENTIFIER] {
            let device = keyring_target(identifier, KEYRING_ACCOUNT);
            let memory = keyring_target(identifier, MEMORY_KEYRING_ACCOUNT);

            assert_eq!(device.service, memory.service);
            assert_ne!(device.account, memory.account);
            assert_ne!(device, memory);
        }
    }

    #[test]
    fn device_key_validation_has_explicit_empty_control_and_size_boundaries() {
        assert!(validate_device_key("valid-device-token").is_ok());
        assert!(validate_device_key("").is_err());
        assert!(validate_device_key("line\nbreak").is_err());
        assert!(validate_device_key(&"x".repeat(MAX_DEVICE_KEY_BYTES)).is_ok());
        assert!(validate_device_key(&"x".repeat(MAX_DEVICE_KEY_BYTES + 1)).is_err());
    }

    #[test]
    fn memory_key_requires_exactly_256_bits_of_hex_key_material() {
        assert!(validate_memory_key(&"a".repeat(64)).is_ok());
        assert!(validate_memory_key(&"a".repeat(63)).is_err());
        assert!(validate_memory_key(&"z".repeat(64)).is_err());
    }
}
