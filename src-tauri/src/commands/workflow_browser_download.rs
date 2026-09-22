//! Native downloads bypass page CORS, not TLS validation or browser cookie scopes.
use super::*;
use std::io::Read;

pub(super) async fn download(
    app: &AppHandle,
    browser: &Webview,
    session: &Arc<Session>,
    gate: &ExecutionLease,
    input: &WorkflowBrowserAction,
    timeout: Duration,
) -> Result<Value, String> {
    let mut target = url(input
        .url
        .as_deref()
        .ok_or("workflow_browser_url_required")?)?;
    let app = app.clone();
    let browser = browser.clone();
    let session = session.clone();
    let gate = gate.clone();
    let name = input.name.clone().unwrap_or_else(|| "download".into());
    tauri::async_runtime::spawn_blocking(move || {
        check(&app, &session, &gate)?;
        let deadline = Instant::now() + timeout;
        let (mut reader, mime): (Box<dyn Read>, String) = if target.scheme() == "file" {
            let path = target
                .to_file_path()
                .map_err(|_| "workflow_browser_file_path_invalid")?;
            let file =
                std::fs::File::open(path).map_err(|_| "workflow_browser_file_unavailable")?;
            let metadata = file
                .metadata()
                .map_err(|_| "workflow_browser_file_unavailable")?;
            if !metadata.is_file() || metadata.len() > MAX_ARTIFACT_BYTES as u64 {
                return Err("workflow_artifact_size_exceeded".into());
            }
            (Box::new(file), "application/octet-stream".into())
        } else {
            let client = reqwest::blocking::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "workflow_browser_download_failed")?;
            let mut redirects = 0;
            let response = loop {
                check(&app, &session, &gate)?;
                if !matches!(target.scheme(), "http" | "https") || Instant::now() >= deadline {
                    return Err("workflow_browser_download_invalid".into());
                }
                // Resolve cookies separately for EVERY redirect; never forward a previous host's cookies.
                let cookies = browser
                    .cookies_for_url(target.clone())
                    .map_err(|_| "workflow_browser_cookies_unavailable")?;
                let cookie = cookies
                    .iter()
                    .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
                    .collect::<Vec<_>>()
                    .join("; ");
                let mut request = client
                    .get(target.clone())
                    .timeout(deadline.saturating_duration_since(Instant::now()));
                if !cookie.is_empty() {
                    request = request.header(reqwest::header::COOKIE, cookie);
                }
                let response = request
                    .send()
                    .map_err(|_| "workflow_browser_download_failed")?;
                if response.status().is_redirection() {
                    redirects += 1;
                    if redirects > 10 {
                        return Err("workflow_browser_redirect_limit".into());
                    }
                    let location = response
                        .headers()
                        .get(reqwest::header::LOCATION)
                        .and_then(|v| v.to_str().ok())
                        .ok_or("workflow_browser_download_invalid")?;
                    target = target
                        .join(location)
                        .map_err(|_| "workflow_browser_download_invalid")?;
                    if !host_allowed(&target, None) {
                        return Err("workflow_browser_download_invalid".into());
                    }
                    continue;
                }
                break response
                    .error_for_status()
                    .map_err(|_| "workflow_browser_download_http_error")?;
            };
            if response
                .content_length()
                .is_some_and(|n| n > MAX_ARTIFACT_BYTES as u64)
            {
                return Err("workflow_artifact_size_exceeded".into());
            }
            let mime = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .split(';')
                .next()
                .unwrap_or("application/octet-stream")
                .trim()
                .to_string();
            (Box::new(response), mime)
        };
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 65536];
        loop {
            check(&app, &session, &gate)?;
            if Instant::now() >= deadline {
                return Err("workflow_browser_download_timeout".into());
            }
            let n = reader
                .read(&mut chunk)
                .map_err(|_| "workflow_browser_download_failed")?;
            if n == 0 {
                break;
            }
            if bytes.len() + n > MAX_ARTIFACT_BYTES {
                return Err("workflow_artifact_size_exceeded".into());
            }
            bytes.extend_from_slice(&chunk[..n]);
        }
        serde_json::to_value(workflow_artifacts::store(
            &app,
            &session.scope,
            &bytes,
            &mime,
            &name,
            &|| check(&app, &session, &gate),
        )?)
        .map_err(|_| "workflow_artifact_invalid".into())
    })
    .await
    .map_err(|_| "workflow_browser_task_failed".to_string())?
}
