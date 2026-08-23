// src/commands/browser.rs
//
// SOLL §24 / §14 P15b — in-app browser window (Tauri WebviewWindow) that the
// workflow client tasks browser.open/open_url/click/read drive. A single
// dedicated window (label "luczor-browser") is opened, navigated, scripted and
// read back; automation runs through it instead of steering the OS browser.
//
// Read-back uses an IPC bridge: browser_read evals a snippet in the page that
// invokes `browser_report` with the requested text; a pending-map delivers it
// back with a timeout. External origins may only use IPC when the browser
// window's capability grants a `remote` context (see capabilities/browser.json)
// — without it, browser_read degrades to an honest timeout error rather than
// silently succeeding.

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAX_READ_CHARS: usize = 200_000;
const MAX_READ_BYTES: usize = MAX_READ_CHARS * 4;
const MAX_SELECTOR_CHARS: usize = 4_096;

use super::{ensure_browser_webview, ensure_main_webview, BROWSER_WEBVIEW_LABEL};

/// Bridge the page uses to hand text back to browser_read.
const BRIDGE_SCRIPT: &str = r#"
window.__luczorReport = function (id, text, truncated) {
  try {
    var api = (window.__TAURI__ && window.__TAURI__.core) || window.__TAURI_INTERNALS__;
    if (api && api.invoke) api.invoke('browser_report', { payload: { id: id, text: String(text == null ? '' : text), truncated: Boolean(truncated) } });
  } catch (e) { /* IPC not permitted for this origin */ }
};
"#;

#[derive(Debug)]
struct ReportedText {
    text: String,
    truncated: bool,
}

fn pending() -> &'static Mutex<HashMap<String, mpsc::Sender<ReportedText>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, mpsc::Sender<ReportedText>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn valid_http_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if !(url.starts_with("https://") || url.starts_with("http://"))
        || url.chars().any(char::is_control)
    {
        return Err("Only valid http(s) URLs may be opened.".into());
    }
    Ok(url.to_string())
}

/// A short id without Date/rand (uuid v4 is available and deterministic-safe).
fn request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Deserialize)]
pub struct BrowserOpenPayload {
    pub url: Option<String>,
}

#[derive(Serialize)]
pub struct BrowserOkResult {
    pub ok: bool,
    pub url: Option<String>,
}

/// Open (or focus + navigate) the in-app browser window at a URL.
#[tauri::command]
pub async fn browser_open(
    window: WebviewWindow,
    app: AppHandle,
    payload: BrowserOpenPayload,
) -> Result<BrowserOkResult, String> {
    ensure_main_webview(&window)?;
    let target = match payload.url.as_deref() {
        Some(u) if !u.trim().is_empty() => valid_http_url(u)?,
        _ => "about:blank".to_string(),
    };

    if let Some(window) = app.get_webview_window(BROWSER_WEBVIEW_LABEL) {
        if target != "about:blank" {
            let url = tauri::Url::parse(&target).map_err(|e| format!("bad url: {e}"))?;
            window
                .navigate(url)
                .map_err(|e| format!("navigate failed: {e}"))?;
        }
        window.set_focus().ok();
        return Ok(BrowserOkResult {
            ok: true,
            url: Some(target),
        });
    }

    let webview_url = if target == "about:blank" {
        WebviewUrl::External(tauri::Url::parse("about:blank").map_err(|e| e.to_string())?)
    } else {
        WebviewUrl::External(tauri::Url::parse(&target).map_err(|e| format!("bad url: {e}"))?)
    };

    WebviewWindowBuilder::new(&app, BROWSER_WEBVIEW_LABEL, webview_url)
        .title("Luczor Browser")
        .inner_size(1024.0, 768.0)
        .initialization_script(BRIDGE_SCRIPT)
        .build()
        .map_err(|e| format!("could not open browser window: {e}"))?;

    Ok(BrowserOkResult {
        ok: true,
        url: Some(target),
    })
}

#[derive(Deserialize)]
pub struct BrowserNavigatePayload {
    pub url: String,
}

/// Navigate the existing in-app browser window.
#[tauri::command]
pub async fn browser_navigate(
    window: WebviewWindow,
    app: AppHandle,
    payload: BrowserNavigatePayload,
) -> Result<BrowserOkResult, String> {
    ensure_main_webview(&window)?;
    let target = valid_http_url(&payload.url)?;
    let window = app
        .get_webview_window(BROWSER_WEBVIEW_LABEL)
        .ok_or("The in-app browser is not open.")?;
    let url = tauri::Url::parse(&target).map_err(|e| format!("bad url: {e}"))?;
    window
        .navigate(url)
        .map_err(|e| format!("navigate failed: {e}"))?;
    Ok(BrowserOkResult {
        ok: true,
        url: Some(target),
    })
}

/// Close the in-app browser window.
#[tauri::command]
pub async fn browser_close(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<BrowserOkResult, String> {
    ensure_main_webview(&window)?;
    if let Some(window) = app.get_webview_window(BROWSER_WEBVIEW_LABEL) {
        window.close().map_err(|e| format!("close failed: {e}"))?;
    }
    Ok(BrowserOkResult {
        ok: true,
        url: None,
    })
}

fn js_string(value: &str) -> String {
    // Escape for embedding inside a single-quoted JS string literal.
    let mut out = String::with_capacity(value.len() + 2);
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            _ => out.push(ch),
        }
    }
    out
}

#[derive(Deserialize)]
pub struct BrowserClickPayload {
    pub selector: String,
}

/// Click an element in the in-app browser (best-effort, fire-and-forget).
#[tauri::command]
pub async fn browser_click(
    window: WebviewWindow,
    app: AppHandle,
    payload: BrowserClickPayload,
) -> Result<BrowserOkResult, String> {
    ensure_main_webview(&window)?;
    let selector = payload.selector.trim();
    if selector.is_empty() {
        return Err("selector is empty".into());
    }
    if selector.chars().count() > MAX_SELECTOR_CHARS || selector.chars().any(char::is_control) {
        return Err("selector is invalid or too long".into());
    }
    let window = app
        .get_webview_window(BROWSER_WEBVIEW_LABEL)
        .ok_or("The in-app browser is not open.")?;
    let js = format!(
        "(function(){{var el=document.querySelector('{}'); if(el){{el.click();}}}})();",
        js_string(selector)
    );
    window.eval(&js).map_err(|e| format!("click failed: {e}"))?;
    Ok(BrowserOkResult {
        ok: true,
        url: None,
    })
}

#[derive(Deserialize)]
pub struct BrowserReadPayload {
    pub selector: Option<String>,
    pub timeout_seconds: Option<u64>,
}

#[derive(Serialize)]
pub struct BrowserReadResult {
    pub ok: bool,
    pub text: String,
    pub truncated: bool,
}

/// Read the text of an element (or the page body) from the in-app browser.
#[tauri::command]
pub async fn browser_read(
    window: WebviewWindow,
    app: AppHandle,
    payload: BrowserReadPayload,
) -> Result<BrowserReadResult, String> {
    ensure_main_webview(&window)?;
    let window = app
        .get_webview_window(BROWSER_WEBVIEW_LABEL)
        .ok_or("The in-app browser is not open.")?;
    let selector = payload.selector.unwrap_or_else(|| "body".into());
    let selector = if selector.trim().is_empty() {
        "body".to_string()
    } else {
        selector
    };
    if selector.chars().count() > MAX_SELECTOR_CHARS || selector.chars().any(char::is_control) {
        return Err("selector is invalid or too long".into());
    }
    let timeout = Duration::from_secs(payload.timeout_seconds.unwrap_or(10).clamp(1, 60));

    let id = request_id();
    let (tx, rx) = mpsc::channel::<ReportedText>();
    pending()
        .lock()
        .map_err(|_| "lock poisoned")?
        .insert(id.clone(), tx);

    let js = format!(
        "(function(){{var el=document.querySelector('{sel}')||document.body; var t=String(el?(el.innerText||el.textContent||''):''); if(window.__luczorReport) window.__luczorReport('{id}', t.slice(0,{max}), t.length>{max});}})();",
        sel = js_string(&selector),
        id = js_string(&id),
        max = MAX_READ_CHARS,
    );
    if let Err(e) = window.eval(&js) {
        pending().lock().ok().and_then(|mut m| m.remove(&id));
        return Err(format!("read eval failed: {e}"));
    }

    let id_for_wait = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(timeout))
        .await
        .map_err(|e| format!("join failed: {e}"))?;
    pending()
        .lock()
        .ok()
        .and_then(|mut m| m.remove(&id_for_wait));

    match result {
        Ok(report) => Ok(BrowserReadResult {
            ok: true,
            text: report.text,
            truncated: report.truncated,
        }),
        Err(_) => Err(
            "The page did not report content in time (IPC may be disabled for this origin).".into(),
        ),
    }
}

#[derive(Deserialize)]
pub struct BrowserReportPayload {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub truncated: bool,
}

/// IPC target the injected bridge calls to hand read-back text to browser_read.
#[tauri::command]
pub async fn browser_report(
    window: WebviewWindow,
    payload: BrowserReportPayload,
) -> Result<(), String> {
    ensure_browser_webview(&window)?;
    complete_report(payload)
}

fn complete_report(payload: BrowserReportPayload) -> Result<(), String> {
    let parsed = uuid::Uuid::parse_str(&payload.id)
        .map_err(|_| "Browser report request id is invalid.".to_string())?;
    if parsed.hyphenated().to_string() != payload.id {
        return Err("Browser report request id is invalid.".into());
    }
    if payload.text.len() > MAX_READ_BYTES || payload.text.chars().count() > MAX_READ_CHARS {
        return Err("Browser report exceeds the read-back limit.".into());
    }
    let sender = pending()
        .lock()
        .map_err(|_| "lock poisoned")?
        .remove(&payload.id)
        .ok_or("Browser report does not match a pending request.")?;
    sender
        .send(ReportedText {
            text: payload.text,
            truncated: payload.truncated,
        })
        .map_err(|_| "Browser read request is no longer waiting.".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        complete_report, js_string, pending, valid_http_url, BrowserReportPayload, MAX_READ_CHARS,
    };
    use std::sync::mpsc;

    #[test]
    fn url_validation_rejects_non_http() {
        assert!(valid_http_url("https://example.org").is_ok());
        assert!(valid_http_url("http://localhost:8010").is_ok());
        assert!(valid_http_url("file:///etc/passwd").is_err());
        assert!(valid_http_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn js_string_escapes_quotes_and_newlines() {
        assert_eq!(js_string("a'b"), "a\\'b");
        assert_eq!(js_string("a\nb"), "a\\nb");
        assert_eq!(js_string("a\\b"), "a\\\\b");
    }

    #[test]
    fn browser_report_requires_a_live_correlated_request() {
        let unknown = uuid::Uuid::new_v4().to_string();
        assert!(complete_report(BrowserReportPayload {
            id: unknown,
            text: "untrusted".into(),
            truncated: false,
        })
        .is_err());
        assert!(complete_report(BrowserReportPayload {
            id: "not-a-request-id".into(),
            text: "untrusted".into(),
            truncated: false,
        })
        .is_err());
    }

    #[test]
    fn browser_report_enforces_negative_size_boundary_without_consuming_request() {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel();
        pending().lock().unwrap().insert(id.clone(), sender);

        assert!(complete_report(BrowserReportPayload {
            id: id.clone(),
            text: "x".repeat(MAX_READ_CHARS + 1),
            truncated: true,
        })
        .is_err());
        assert!(pending().lock().unwrap().contains_key(&id));

        complete_report(BrowserReportPayload {
            id,
            text: "bounded result".into(),
            truncated: false,
        })
        .expect("valid correlated report");
        let report = receiver.recv().expect("reported text");
        assert_eq!(report.text, "bounded result");
        assert!(!report.truncated);
    }

    #[test]
    fn browser_report_accepts_the_exact_text_boundary_without_false_truncation() {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel();
        pending().lock().unwrap().insert(id.clone(), sender);

        complete_report(BrowserReportPayload {
            id,
            text: "x".repeat(MAX_READ_CHARS),
            truncated: false,
        })
        .expect("the exact read-back boundary must remain valid");

        let report = receiver.recv().expect("reported text");
        assert_eq!(report.text.chars().count(), MAX_READ_CHARS);
        assert!(!report.truncated);
    }
}
