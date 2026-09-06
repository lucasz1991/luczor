use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::mpsc;
use std::time::Duration;

use reqwest::blocking::{Client, ClientBuilder};
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, CONNECTION, CONTENT_LENGTH, HOST, TRANSFER_ENCODING,
};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

use super::ensure_main_webview;
use super::execution::{admit, Guarded};

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 120;
const DNS_TIMEOUT_SECS: u64 = 5;
const MAX_REQUEST_BODY_BYTES: usize = 1_000_000;
const MAX_RESPONSE_BODY_BYTES: usize = 1_000_000;
const MAX_HEADERS: usize = 64;
const MAX_HEADER_NAME_BYTES: usize = 128;
const MAX_HEADER_VALUE_BYTES: usize = 8_192;

#[derive(Deserialize)]
pub struct WorkflowHttpPayload {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub timeout_seconds: Option<u64>,
}

#[derive(Serialize)]
pub struct WorkflowHttpResult {
    pub status: u16,
    pub ok: bool,
    pub body: String,
    pub truncated: bool,
}

#[tauri::command]
pub async fn wf_http_request(
    window: WebviewWindow,
    payload: Guarded<WorkflowHttpPayload>,
) -> Result<WorkflowHttpResult, String> {
    ensure_main_webview(&window)?;
    // Even GET requests can disclose information or trigger poorly designed
    // endpoints; workflow networking always needs mutation admission.
    let gate = admit(&payload.execution, true)?;
    let payload = payload.request;
    tauri::async_runtime::spawn_blocking(move || {
        gate.check()?;
        let result = perform_request(payload, &gate)?;
        gate.check()?;
        Ok(result)
    })
    .await
    .map_err(|error| format!("HTTP task join failed: {error}"))?
}

fn perform_request(
    payload: WorkflowHttpPayload,
    gate: &super::execution::ExecutionLease,
) -> Result<WorkflowHttpResult, String> {
    let method = validate_method(&payload.method)?;
    let url = validate_url(&payload.url)?;
    let timeout = Duration::from_secs(
        payload
            .timeout_seconds
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );
    let headers = validate_headers(payload.headers)?;
    if payload
        .body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_REQUEST_BODY_BYTES)
    {
        return Err("Workflow HTTP request body exceeds the 1 MB limit.".into());
    }

    let mut client_builder = ClientBuilder::new()
        .connect_timeout(timeout.min(Duration::from_secs(20)))
        .timeout(timeout)
        // A system proxy would resolve/reach the original host independently
        // and could bypass the address pinning performed below.
        .no_proxy()
        // Redirect targets require a fresh SSRF check. Until that is an
        // explicit loop, keep redirects disabled instead of trusting them.
        .redirect(reqwest::redirect::Policy::none());

    if let Some((host, pinned_address)) = resolve_and_validate_target(&url)? {
        client_builder = client_builder.resolve(&host, pinned_address);
    }
    let client = client_builder
        .build()
        .map_err(|_| "Workflow HTTP client could not be created.".to_string())?;
    gate.check()?;
    send_request(client, method, url, headers, payload.body, gate)
}

fn send_request(
    client: Client,
    method: Method,
    url: Url,
    headers: HeaderMap,
    body: Option<String>,
    gate: &super::execution::ExecutionLease,
) -> Result<WorkflowHttpResult, String> {
    let mut request = client.request(method, url).headers(headers);
    if let Some(body) = body {
        request = request.body(body);
    }
    gate.check()?;
    let mut response = request.send().map_err(map_request_error)?;
    let status = response.status();
    let mut bytes = Vec::with_capacity(16 * 1024);
    let mut buffer = [0_u8; 8192];
    while bytes.len() <= MAX_RESPONSE_BODY_BYTES {
        gate.check()?;
        let remaining = (MAX_RESPONSE_BODY_BYTES + 1 - bytes.len()).min(buffer.len());
        let read = response
            .read(&mut buffer[..remaining])
            .map_err(|_| "Workflow HTTP response read failed.")?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    gate.check()?;
    let truncated = bytes.len() > MAX_RESPONSE_BODY_BYTES;
    if truncated {
        bytes.truncate(MAX_RESPONSE_BODY_BYTES);
    }
    Ok(WorkflowHttpResult {
        status: status.as_u16(),
        ok: status.is_success(),
        body: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}

fn map_request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Workflow HTTP request timed out.".into()
    } else if error.is_connect() {
        "Workflow HTTP target could not be reached.".into()
    } else if error.is_request() {
        "Workflow HTTP request could not be sent.".into()
    } else {
        "Workflow HTTP request failed.".into()
    }
}

fn validate_method(raw: &str) -> Result<Method, String> {
    let method = Method::from_bytes(raw.trim().to_ascii_uppercase().as_bytes())
        .map_err(|_| "Workflow HTTP method is invalid.".to_string())?;
    match method {
        Method::GET
        | Method::POST
        | Method::PUT
        | Method::PATCH
        | Method::DELETE
        | Method::HEAD => Ok(method),
        _ => Err("Workflow HTTP method is not allowed.".into()),
    }
}

fn validate_url(raw: &str) -> Result<Url, String> {
    if raw.chars().any(char::is_control) {
        return Err("Workflow HTTP URL contains control characters.".into());
    }
    let url = Url::parse(raw.trim()).map_err(|_| "Workflow HTTP URL is invalid.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Workflow HTTP supports only http(s) URLs.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Workflow HTTP URLs must not contain credentials.".into());
    }
    if url.host_str().is_none() {
        return Err("Workflow HTTP URL has no host.".into());
    }
    Ok(url)
}

fn validate_headers(raw: HashMap<String, String>) -> Result<HeaderMap, String> {
    if raw.len() > MAX_HEADERS {
        return Err("Workflow HTTP request has too many headers.".into());
    }
    let mut headers = HeaderMap::with_capacity(raw.len());
    for (name, value) in raw {
        if name.len() > MAX_HEADER_NAME_BYTES || value.len() > MAX_HEADER_VALUE_BYTES {
            return Err("Workflow HTTP header exceeds its size limit.".into());
        }
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "Workflow HTTP header name is invalid.".to_string())?;
        if matches!(name, HOST | CONTENT_LENGTH | TRANSFER_ENCODING | CONNECTION) {
            return Err("Workflow HTTP header is controlled by the native client.".into());
        }
        let value = HeaderValue::from_str(&value)
            .map_err(|_| "Workflow HTTP header value is invalid.".to_string())?;
        headers.append(name, value);
    }
    Ok(headers)
}

/// Resolve once, reject every non-public result, then pin one validated address
/// into reqwest. This closes the usual check/use DNS-rebinding gap.
fn resolve_and_validate_target(url: &Url) -> Result<Option<(String, SocketAddr)>, String> {
    let host = url.host_str().ok_or("Workflow HTTP URL has no host.")?;
    let port = url
        .port_or_known_default()
        .ok_or("Workflow HTTP URL has no usable port.")?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        ensure_public_ip(ip)?;
        return Ok(None);
    }

    let lookup_host = host.to_string();
    let lookup_for_thread = lookup_host.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = (lookup_for_thread.as_str(), port)
            .to_socket_addrs()
            .map(|addresses| addresses.collect::<Vec<_>>());
        let _ = sender.send(result);
    });
    let addresses = receiver
        .recv_timeout(Duration::from_secs(DNS_TIMEOUT_SECS))
        .map_err(|_| "Workflow HTTP DNS resolution timed out.".to_string())?
        .map_err(|_| "Workflow HTTP host could not be resolved.".to_string())?;
    if addresses.is_empty() {
        return Err("Workflow HTTP host resolved to no addresses.".into());
    }
    for address in &addresses {
        ensure_public_ip(address.ip())?;
    }
    Ok(Some((lookup_host, addresses[0])))
}

fn ensure_public_ip(ip: IpAddr) -> Result<(), String> {
    let public = match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    };
    if public {
        Ok(())
    } else {
        Err(
            "Workflow HTTP blocks loopback, private, link-local and reserved network targets."
                .into(),
        )
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    if ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
    {
        return false;
    }
    !matches!(
        (a, b, c),
        (0, _, _)
            | (100, 64..=127, _)
            | (192, 0, 0)
            | (192, 0, 2)
            | (192, 88, 99)
            | (198, 18..=19, _)
            | (198, 51, 100)
            | (203, 0, 113)
            | (240..=255, _, _)
    )
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    let segments = ip.segments();
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() {
        return false;
    }
    // Only globally routed unicast space (2000::/3), minus documentation.
    (segments[0] & 0xe000) == 0x2000 && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_public_ip, resolve_and_validate_target, validate_headers, validate_method,
        validate_url, MAX_HEADER_VALUE_BYTES,
    };
    use std::collections::HashMap;
    use std::net::IpAddr;

    #[test]
    fn workflow_http_rejects_dangerous_methods_credentials_and_control_headers() {
        assert!(validate_method("GET").is_ok());
        assert!(validate_method("CONNECT").is_err());
        assert!(validate_url("https://example.org/path").is_ok());
        assert!(validate_url("https://user:pass@example.org").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());

        let mut headers = HashMap::new();
        headers.insert("Host".to_string(), "internal".to_string());
        assert!(validate_headers(headers).is_err());
        let mut headers = HashMap::new();
        headers.insert("X-Test".to_string(), "x".repeat(MAX_HEADER_VALUE_BYTES + 1));
        assert!(validate_headers(headers).is_err());
    }

    #[test]
    fn workflow_http_ssrf_boundary_denies_local_and_reserved_addresses() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "192.168.1.2",
            "100.64.0.1",
            "::1",
            "fe80::1",
            "fc00::1",
            "2001:db8::1",
        ] {
            assert!(
                ensure_public_ip(address.parse::<IpAddr>().unwrap()).is_err(),
                "{address} must be blocked"
            );
        }
        assert!(ensure_public_ip("93.184.216.34".parse().unwrap()).is_ok());
        assert!(ensure_public_ip("2606:2800:220:1:248:1893:25c8:1946".parse().unwrap()).is_ok());

        let loopback = validate_url("http://127.0.0.1:8080/private").unwrap();
        assert!(resolve_and_validate_target(&loopback).is_err());
        let public = validate_url("https://93.184.216.34/").unwrap();
        assert!(resolve_and_validate_target(&public).is_ok());
    }
}
