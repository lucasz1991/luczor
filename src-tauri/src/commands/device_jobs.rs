use base64::Engine;
use rsa::pkcs1v15::{Signature, VerifyingKey};
use rsa::pkcs8::DecodePublicKey;
use rsa::signature::Verifier;
use rsa::traits::PublicKeyParts;
use rsa::RsaPublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use super::ensure_main_webview;

const DEVICE_JOB_PUBLIC_KEY_B64: Option<&str> = option_env!("LUCZOR_DEVICE_JOB_PUBLIC_KEY_B64");
static TRUST_APP: OnceLock<String> = OnceLock::new();
static TRUST_KEY: OnceLock<Mutex<Option<(RsaPublicKey, std::time::Instant)>>> = OnceLock::new();
pub(crate) fn initialize_trust(app: &tauri::AppHandle) {
    let _ = TRUST_APP.set(app.config().identifier.clone());
}
fn parse_trust_key(pem: &str) -> Result<RsaPublicKey, String> {
    let key = RsaPublicKey::from_public_key_pem(pem).map_err(|_| "device_job_trust_key_invalid")?;
    if key.n().bits() < 2048 || key.n().bits() > 8192 {
        return Err("device_job_trust_key_invalid".into());
    }
    Ok(key)
}
pub(super) fn trusted_device_job_key() -> Result<RsaPublicKey, String> {
    if let Some(encoded) = DEVICE_JOB_PUBLIC_KEY_B64 {
        let pem = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "device_job_trust_key_invalid")?;
        return parse_trust_key(
            std::str::from_utf8(&pem).map_err(|_| "device_job_trust_key_invalid")?,
        );
    }
    let mut cached = TRUST_KEY
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "device_job_trust_key_unavailable")?;
    if let Some((key, time)) = &*cached {
        if time.elapsed() < std::time::Duration::from_secs(3600) {
            return Ok(key.clone());
        }
    }
    let app_id = TRUST_APP.get().ok_or("device_job_trust_not_initialized")?;
    let entry = keyring::Entry::new(app_id, "luczor_device_job_trust_key_v1")
        .map_err(|_| "device_job_trust_key_unavailable")?;
    // Public authority is bootstrapped only from this fixed HTTPS origin, using OS-stored device credentials.
    // A renderer cannot supply a PEM, host override, redirect target or proxy.
    let fetched = (|| -> Result<String, String> {
        let token = super::device_key::read_device_key(app_id)?
            .ok_or("device_job_authentication_unavailable")?;
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|_| "device_job_trust_transport_unavailable")?;
        let response = client
            .get("https://luczor.follow-flow.de/api/v1/devices/signing-key")
            .bearer_auth(token)
            .send()
            .map_err(|_| "device_job_trust_transport_unavailable")?;
        if !response.status().is_success() {
            return Err("device_job_trust_endpoint_unavailable".into());
        }
        let mut bytes = Vec::new();
        response
            .take(16385)
            .read_to_end(&mut bytes)
            .map_err(|_| "device_job_trust_transport_unavailable")?;
        if bytes.len() > 16384 {
            return Err("device_job_trust_key_invalid".into());
        }
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "device_job_trust_key_invalid")?;
        if value["algorithm"] != "RSA-SHA256" {
            return Err("device_job_trust_key_invalid".into());
        }
        let pem = value["public_key"]
            .as_str()
            .ok_or("device_job_trust_key_invalid")?
            .to_string();
        parse_trust_key(&pem)?;
        Ok(pem)
    })();
    let pem = match fetched {
        Ok(pem) => {
            entry
                .set_password(&pem)
                .map_err(|_| "device_job_trust_cache_unavailable")?;
            pem
        }
        Err(_) => entry
            .get_password()
            .map_err(|_| "device_job_trust_key_unavailable")?,
    };
    let key = parse_trust_key(&pem)?;
    *cached = Some((key.clone(), std::time::Instant::now()));
    Ok(key)
}

#[derive(Debug, Deserialize)]
pub struct VerifyDeviceJobPayload {
    pub id: String,
    pub tool_profile: String,
    pub payload: serde_json::Value,
    pub payload_hash: String,
    pub signature: String,
    pub expires_at: Option<String>,
    pub protocol_version: Option<u8>,
    pub user_id: Option<u64>,
    pub source_device_id: Option<String>,
    pub target_device_id: Option<String>,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub master_epoch: Option<u64>,
    pub attempt_id: Option<String>,
    pub expected_user_id: Option<u64>,
    pub expected_target_device_id: Option<String>,
    pub expected_master_epoch: Option<u64>,
    #[serde(default)]
    pub require_claimed: bool,
}

/// Struct declaration order is the signed PHP JSON order, unlike serde_json::Map.
#[derive(Serialize)]
struct EnvelopeV2<'a> {
    protocol_version: u8,
    id: &'a str,
    user_id: u64,
    source_device_id: &'a str,
    target_device_id: &'a str,
    project_id: &'a Option<String>,
    conversation_id: &'a Option<String>,
    master_epoch: u64,
    attempt_id: &'a Option<String>,
    tool_profile: &'a str,
    payload_hash: &'a str,
    expires_at: &'a Option<String>,
}
fn signed_envelope(payload: &VerifyDeviceJobPayload) -> Result<Vec<u8>, String> {
    match payload.protocol_version.unwrap_or(1) {
        1 => {
            if payload.require_claimed
                || payload.expected_user_id.is_some()
                || payload.expected_master_epoch.is_some()
                || payload.expected_target_device_id.is_some()
            {
                return Err("A coordinated worker requires a version 2 device job.".into());
            }
            serde_json::to_vec(&serde_json::json!({"id":payload.id,"tool_profile":payload.tool_profile,"payload_hash":payload.payload_hash,"expires_at":payload.expires_at})).map_err(|_|"Device job envelope is invalid.".into())
        }
        2 => {
            let user_id = payload
                .user_id
                .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
                .ok_or("Device job owner is invalid.")?;
            let master_epoch = payload
                .master_epoch
                .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
                .ok_or("Device job master epoch is invalid.")?;
            let source = payload
                .source_device_id
                .as_deref()
                .filter(|id| !id.is_empty() && id.len() <= 300)
                .ok_or("Device job source is invalid.")?;
            let target = payload
                .target_device_id
                .as_deref()
                .filter(|id| !id.is_empty() && id.len() <= 300)
                .ok_or("Device job target is invalid.")?;
            if payload.expected_user_id != Some(user_id)
                || payload.expected_target_device_id.as_deref() != Some(target)
                || payload.expected_master_epoch != Some(master_epoch)
            {
                return Err("Device job belongs to another owner, target, or master epoch.".into());
            }
            uuid::Uuid::parse_str(&payload.id).map_err(|_| "Device job identity is invalid.")?;
            if let Some(attempt) = &payload.attempt_id {
                uuid::Uuid::parse_str(attempt).map_err(|_| "Device job attempt is invalid.")?;
            }
            if payload.require_claimed && payload.attempt_id.is_none() {
                return Err("Device job must be claimed before execution.".into());
            }
            serde_json::to_vec(&EnvelopeV2 {
                protocol_version: 2,
                id: &payload.id,
                user_id,
                source_device_id: source,
                target_device_id: target,
                project_id: &payload.project_id,
                conversation_id: &payload.conversation_id,
                master_epoch,
                attempt_id: &payload.attempt_id,
                tool_profile: &payload.tool_profile,
                payload_hash: &payload.payload_hash,
                expires_at: &payload.expires_at,
            })
            .map_err(|_| "Device job envelope is invalid.".into())
        }
        _ => Err("Unsupported device job protocol version.".into()),
    }
}

#[tauri::command]
pub async fn verify_device_job(
    window: crate::commands::CallerWebview,
    payload: VerifyDeviceJobPayload,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    ensure_allowed_tool_profile(&payload.tool_profile)?;
    let computed_hash =
        sha256(&serde_json::to_vec(&payload.payload).map_err(|error| error.to_string())?);
    if !computed_hash.eq_ignore_ascii_case(&payload.payload_hash) {
        return Err("Device job payload hash does not match.".into());
    }
    let key = tauri::async_runtime::spawn_blocking(trusted_device_job_key)
        .await
        .map_err(|_| "Device job trust worker failed.")??;
    let canonical = signed_envelope(&payload)?;
    let signature = Signature::try_from(
        base64::engine::general_purpose::STANDARD
            .decode(payload.signature)
            .map_err(|error| error.to_string())?
            .as_slice(),
    )
    .map_err(|error| error.to_string())?;
    VerifyingKey::<Sha256>::new(key)
        .verify(&canonical, &signature)
        .map_err(|_| "Device job signature is invalid.".to_string())?;

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is before the Unix epoch.".to_string())?
        .as_millis() as i128;
    ensure_not_expired(payload.expires_at.as_deref(), now_ms)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn ensure_allowed_tool_profile(profile: &str) -> Result<(), String> {
    match profile {
        "desktop.capture_screen"
        | "desktop.observe"
        | "desktop.clipboard.read"
        | "desktop.windows.list"
        | "desktop.input.move_mouse"
        | "desktop.input.click"
        | "desktop.input.type_text"
        | "desktop.input.press_key"
        | "desktop.open_url"
        | "workflow.task"
        | "workspace.chat" => Ok(()),
        _ => Err("Device job tool profile is not supported by this app build.".into()),
    }
}

fn ensure_not_expired(expires_at: Option<&str>, now_ms: i128) -> Result<(), String> {
    let Some(expires_at) = expires_at else {
        return Ok(());
    };
    let expires_ms = parse_rfc3339_millis(expires_at)?;
    if expires_ms <= now_ms {
        Err("Device job has expired.".into())
    } else {
        Ok(())
    }
}

pub(super) fn parse_rfc3339_millis(raw: &str) -> Result<i128, String> {
    let value = raw.trim();
    let (date, time_and_zone) = value
        .split_once('T')
        .ok_or("Device job expiry must be an RFC3339 timestamp.")?;
    if date.len() != 10 || date.as_bytes()[4] != b'-' || date.as_bytes()[7] != b'-' {
        return Err("Device job expiry must be an RFC3339 timestamp.".into());
    }

    let year = parse_digits(&date[0..4], "year")? as i64;
    let month = parse_digits(&date[5..7], "month")? as u32;
    let day = parse_digits(&date[8..10], "day")? as u32;
    let max_day = days_in_month(year, month).ok_or("Device job expiry has an invalid month.")?;
    if day == 0 || day > max_day {
        return Err("Device job expiry has an invalid day.".into());
    }

    let (time, offset_seconds) = if let Some(time) = time_and_zone.strip_suffix('Z') {
        (time, 0_i64)
    } else {
        if time_and_zone.len() < 6 {
            return Err("Device job expiry must include a timezone.".into());
        }
        let split = time_and_zone.len() - 6;
        let (time, offset) = time_and_zone.split_at(split);
        let sign = match offset.as_bytes().first() {
            Some(b'+') => 1_i64,
            Some(b'-') => -1_i64,
            _ => return Err("Device job expiry must include a valid timezone.".into()),
        };
        if offset.as_bytes().get(3) != Some(&b':') {
            return Err("Device job expiry must include a valid timezone.".into());
        }
        let hours = parse_digits(&offset[1..3], "timezone hour")? as i64;
        let minutes = parse_digits(&offset[4..6], "timezone minute")? as i64;
        if hours > 23 || minutes > 59 {
            return Err("Device job expiry has an invalid timezone.".into());
        }
        (time, sign * (hours * 3_600 + minutes * 60))
    };

    let (clock, fraction) = time
        .split_once('.')
        .map_or((time, None), |(clock, fraction)| (clock, Some(fraction)));
    if clock.len() != 8 || clock.as_bytes()[2] != b':' || clock.as_bytes()[5] != b':' {
        return Err("Device job expiry must include a valid time.".into());
    }
    let hour = parse_digits(&clock[0..2], "hour")? as i64;
    let minute = parse_digits(&clock[3..5], "minute")? as i64;
    let second = parse_digits(&clock[6..8], "second")? as i64;
    if hour > 23 || minute > 59 || second > 59 {
        return Err("Device job expiry has an invalid time.".into());
    }
    let millis = match fraction {
        None => 0_i64,
        Some(value)
            if value.is_empty()
                || value.len() > 9
                || !value.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            return Err("Device job expiry has an invalid fractional second.".into())
        }
        Some(value) => {
            let mut first_three = value.bytes().take(3).collect::<Vec<_>>();
            while first_three.len() < 3 {
                first_three.push(b'0');
            }
            parse_digits(
                std::str::from_utf8(&first_three).expect("ASCII digits"),
                "millisecond",
            )? as i64
        }
    };

    let days = days_from_civil(year, month, day);
    let local_seconds = days * 86_400 + hour * 3_600 + minute * 60 + second;
    Ok((local_seconds - offset_seconds) as i128 * 1_000 + millis as i128)
}

fn parse_digits(value: &str, field: &str) -> Result<u32, String> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("Device job expiry has an invalid {field}."));
    }
    value
        .parse::<u32>()
        .map_err(|_| format!("Device job expiry has an invalid {field}."))
}

fn days_in_month(year: i64, month: u32) -> Option<u32> {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => Some(31),
        4 | 6 | 9 | 11 => Some(30),
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => Some(29),
        2 => Some(28),
        _ => None,
    }
}

/// Number of days since 1970-01-01 (proleptic Gregorian calendar).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = month as i64 + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::{ensure_allowed_tool_profile, ensure_not_expired, parse_rfc3339_millis};

    #[test]
    fn rfc3339_expiry_supports_zulu_fraction_and_offsets() {
        assert_eq!(parse_rfc3339_millis("1970-01-01T00:00:00Z").unwrap(), 0);
        assert_eq!(
            parse_rfc3339_millis("1970-01-01T00:00:00.125Z").unwrap(),
            125
        );
        assert_eq!(
            parse_rfc3339_millis("2026-08-22T12:00:00+02:00").unwrap(),
            parse_rfc3339_millis("2026-08-22T10:00:00Z").unwrap()
        );
    }

    #[test]
    fn expired_or_malformed_device_jobs_are_rejected_natively() {
        let now = parse_rfc3339_millis("2026-08-22T10:00:00Z").unwrap();
        assert!(ensure_not_expired(Some("2026-08-22T09:59:59.999Z"), now).is_err());
        assert!(ensure_not_expired(Some("2026-08-22T10:00:00Z"), now).is_err());
        assert!(ensure_not_expired(Some("2026-08-22T10:00:00.001Z"), now).is_ok());
        assert!(ensure_not_expired(Some("not-a-timestamp"), now).is_err());
        assert!(ensure_not_expired(None, now).is_ok());
    }

    #[test]
    fn device_job_tool_profile_allowlist_is_closed_natively() {
        assert!(ensure_allowed_tool_profile("desktop.open_url").is_ok());
        assert!(ensure_allowed_tool_profile("workflow.task").is_ok());
        assert!(ensure_allowed_tool_profile("workspace.chat").is_ok());
        assert!(ensure_allowed_tool_profile("workspace.shell").is_err());
        assert!(ensure_allowed_tool_profile("agent_cli_run").is_err());
        assert!(ensure_allowed_tool_profile("").is_err());
    }
}
