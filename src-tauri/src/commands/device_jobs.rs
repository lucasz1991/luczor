use base64::Engine;
use rsa::pkcs1v15::{Signature, VerifyingKey};
use rsa::pkcs8::DecodePublicKey;
use rsa::signature::Verifier;
use rsa::RsaPublicKey;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::WebviewWindow;

use super::ensure_main_webview;

const DEVICE_JOB_PUBLIC_KEY_B64: Option<&str> = option_env!("LUCZOR_DEVICE_JOB_PUBLIC_KEY_B64");

#[derive(Debug, Deserialize)]
pub struct VerifyDeviceJobPayload {
    pub id: String,
    pub tool_profile: String,
    pub payload: serde_json::Value,
    pub payload_hash: String,
    pub signature: String,
    pub expires_at: Option<String>,
}

#[tauri::command]
pub async fn verify_device_job(
    window: WebviewWindow,
    payload: VerifyDeviceJobPayload,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    ensure_allowed_tool_profile(&payload.tool_profile)?;
    let computed_hash =
        sha256(&serde_json::to_vec(&payload.payload).map_err(|error| error.to_string())?);
    if !computed_hash.eq_ignore_ascii_case(&payload.payload_hash) {
        return Err("Device job payload hash does not match.".into());
    }
    let key_b64 =
        DEVICE_JOB_PUBLIC_KEY_B64.ok_or("This app build has no device-job signing key.")?;
    let pem = String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(key_b64)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let key = RsaPublicKey::from_public_key_pem(&pem).map_err(|error| error.to_string())?;
    let canonical = serde_json::json!({
        "id": payload.id,
        "tool_profile": payload.tool_profile,
        "payload_hash": payload.payload_hash,
        "expires_at": payload.expires_at,
    });
    let signature = Signature::try_from(
        base64::engine::general_purpose::STANDARD
            .decode(payload.signature)
            .map_err(|error| error.to_string())?
            .as_slice(),
    )
    .map_err(|error| error.to_string())?;
    VerifyingKey::<Sha256>::new(key)
        .verify(canonical.to_string().as_bytes(), &signature)
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
        | "desktop.clipboard.read"
        | "desktop.windows.list"
        | "desktop.input.move_mouse"
        | "desktop.input.click"
        | "desktop.input.type_text"
        | "desktop.input.press_key"
        | "desktop.open_url"
        | "workflow.task" => Ok(()),
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

fn parse_rfc3339_millis(raw: &str) -> Result<i128, String> {
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
        assert!(ensure_allowed_tool_profile("agent_cli_run").is_err());
        assert!(ensure_allowed_tool_profile("").is_err());
    }
}
