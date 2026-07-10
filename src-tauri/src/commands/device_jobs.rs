use base64::Engine;
use rsa::pkcs1v15::{Signature, VerifyingKey};
use rsa::pkcs8::DecodePublicKey;
use rsa::signature::Verifier;
use rsa::RsaPublicKey;
use serde::Deserialize;
use sha2::{Digest, Sha256};

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
pub async fn verify_device_job(payload: VerifyDeviceJobPayload) -> Result<(), String> {
    let computed_hash = sha256(&serde_json::to_vec(&payload.payload).map_err(|error| error.to_string())?);
    if !computed_hash.eq_ignore_ascii_case(&payload.payload_hash) {
        return Err("Device job payload hash does not match.".into());
    }
    let key_b64 = DEVICE_JOB_PUBLIC_KEY_B64.ok_or("This app build has no device-job signing key.")?;
    let pem = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(key_b64).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let key = RsaPublicKey::from_public_key_pem(&pem).map_err(|error| error.to_string())?;
    let canonical = serde_json::json!({
        "id": payload.id,
        "tool_profile": payload.tool_profile,
        "payload_hash": payload.payload_hash,
        "expires_at": payload.expires_at,
    });
    let signature = Signature::try_from(base64::engine::general_purpose::STANDARD.decode(payload.signature).map_err(|error| error.to_string())?.as_slice())
        .map_err(|error| error.to_string())?;
    VerifyingKey::<Sha256>::new(key).verify(canonical.to_string().as_bytes(), &signature)
        .map_err(|_| "Device job signature is invalid.".into())
}

fn sha256(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
