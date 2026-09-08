use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;

// This URL is an application trust anchor, never supplied by a manifest or WebView.
const KEY_URL: &str = "https://luczor.follow-flow.de/api/v1/local-model/signing-key";
const MAX_KEY_RESPONSE_BYTES: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicSigningKey {
    key_id: String,
    algorithm: String,
    public_key_b64: String,
    public_key_sha256: String,
}

pub(super) async fn resolve(
    key_id: Option<&str>,
    public_key: Option<&str>,
) -> Result<(String, String), String> {
    match (key_id, public_key) {
        (Some(id), Some(key)) => return Ok((id.to_owned(), key.to_owned())),
        (None, None) => (),
        _ => return Err("The compiled local-model trust anchor is incomplete.".into()),
    }
    // Ordinary certificate/hostname verification stays enabled. Redirects cannot
    // transfer this authority to another origin, including a custom API server.
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Local-model trust client could not be created.".to_string())?;
    let mut response = client
        .get(KEY_URL)
        .send()
        .await
        .map_err(|_| "Local-model signing key could not be loaded securely.".to_string())?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("The Luczor server has not provided a local-model signing key.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local-model signing key response failed.".to_string())?
    {
        if bytes.len() + chunk.len() > MAX_KEY_RESPONSE_BYTES {
            return Err("Local-model signing key response is too large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_key(&bytes)
}

fn parse_key(bytes: &[u8]) -> Result<(String, String), String> {
    let key: PublicSigningKey = serde_json::from_slice(bytes)
        .map_err(|_| "Local-model signing key response is invalid.".to_string())?;
    if key.algorithm != "RSA-SHA256" || !super::safe_id(&key.key_id) {
        return Err("Local-model signing key algorithm or id is invalid.".into());
    }
    super::decode_manifest_public_key(&key.public_key_b64)?;
    let pem = base64::engine::general_purpose::STANDARD
        .decode(&key.public_key_b64)
        .map_err(|_| "Local-model public key encoding is invalid.".to_string())?;
    let hash = format!("{:x}", Sha256::digest(&pem));
    if hash != key.public_key_sha256 {
        return Err("Local-model signing key fingerprint does not match.".into());
    }
    Ok((key.key_id, key.public_key_b64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_key_takes_precedence_without_network() {
        assert_eq!(
            tauri::async_runtime::block_on(resolve(Some("pinned"), Some("key"))).unwrap(),
            ("pinned".into(), "key".into())
        );
        assert!(tauri::async_runtime::block_on(resolve(Some("pinned"), None)).is_err());
        assert!(tauri::async_runtime::block_on(resolve(None, Some("key"))).is_err());
    }

    #[test]
    fn public_descriptor_rejects_bad_algorithm_and_invalid_key() {
        assert!(parse_key(
            br#"{"key_id":"key","algorithm":"none","public_key_b64":"","public_key_sha256":""}"#
        )
        .is_err());
        assert!(parse_key(br#"{"key_id":"key","algorithm":"RSA-SHA256","public_key_b64":"invalid","public_key_sha256":""}"#).is_err());
    }

    #[test]
    fn public_descriptor_checks_fingerprint_and_verifies_php_signature() {
        let pem = include_str!("../../../tests/fixtures/local-model-manifest-test-public.pem");
        let envelope: super::super::SignedEnvelope = serde_json::from_str(include_str!(
            "../../../tests/fixtures/local-model-manifest-golden-envelope.json"
        ))
        .unwrap();
        let mut descriptor = serde_json::json!({
            "key_id": envelope.key_id,
            "algorithm": "RSA-SHA256",
            "public_key_b64": base64::engine::general_purpose::STANDARD.encode(pem),
            "public_key_sha256": format!("{:x}", Sha256::digest(pem.as_bytes())),
        });
        let (id, key) = parse_key(&serde_json::to_vec(&descriptor).unwrap()).unwrap();
        let now =
            super::super::parse_rfc3339_millis(envelope.payload["generated_at"].as_str().unwrap())
                .unwrap();
        assert!(super::super::verify_envelope_with_trust(&envelope, &id, &key, now).is_ok());
        descriptor["public_key_sha256"] = serde_json::json!("0".repeat(64));
        assert!(parse_key(&serde_json::to_vec(&descriptor).unwrap()).is_err());
    }
}
