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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAX_READ_CHARS: usize = 200_000;
const MAX_READ_BYTES: usize = MAX_READ_CHARS * 4;
const MAX_SELECTOR_CHARS: usize = 4_096;

use super::execution::{admit, ExecutionLease, ExecutionOnly, Guarded};
use super::{ensure_browser_webview, ensure_main_webview, BROWSER_WEBVIEW_LABEL};

/// Bridge the page uses to hand text back to browser_read.
const BRIDGE_SCRIPT: &str = r#"
window.__luczorAuthorize = async function(id) {
    var api = (window.__TAURI__ && window.__TAURI__.core) || window.__TAURI_INTERNALS__;
    if (!api || !api.invoke) throw new Error('IPC unavailable');
    return await api.invoke('browser_action_admit', {payload:{id:id}});
};
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

fn action_permits() -> &'static Mutex<HashMap<String, ExecutionLease>> {
    static ACTIONS: OnceLock<Mutex<HashMap<String, ExecutionLease>>> = OnceLock::new();
    ACTIONS.get_or_init(Mutex::default)
}

pub(crate) fn stop_all() -> Result<(), String> {
    pending()
        .try_lock()
        .map_err(|_| "browser_requests_stop_pending")?
        .clear();
    action_permits()
        .try_lock()
        .map_err(|_| "browser_permits_stop_pending")?
        .clear();
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserAdmissionPayload {
    id: String,
}
/// Remote pages can consume only a nonce for an already reviewed action;
/// they cannot change mode, create an action, or access main-window commands.
#[tauri::command]
pub async fn browser_action_admit(
    window: crate::commands::CallerWebview,
    payload: BrowserAdmissionPayload,
) -> Result<u64, String> {
    ensure_browser_webview(&window)?;
    let lease = action_permits()
        .lock()
        .map_err(|_| "Browser admission unavailable.")?
        .remove(&payload.id)
        .ok_or("Browser action is missing, stale or already admitted.")?;
    lease.check()?;
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Browser clock unavailable.")?
        .as_millis() as u64
        + 250)
}

fn valid_http_url(raw: &str) -> Result<String, String> {
    super::workflow_browser::url(raw).map(|url| url.to_string())
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
    window: crate::commands::CallerWebview,
    app: AppHandle,
    payload: Guarded<BrowserOpenPayload>,
) -> Result<BrowserOkResult, String> {
    ensure_main_webview(&window)?;
    let (_operation, _) = super::owned_processes::Operation::begin()?;
    super::workflow_browser::ensure_unbound()?;
    let gate = admit(&payload.execution, true)?;
    let payload = payload.request;
    let target = match payload.url.as_deref() {
        Some(u) if !u.trim().is_empty() => valid_http_url(u)?,
        _ => "about:blank".to_string(),
    };

    if let Some(window) = app.get_webview_window(BROWSER_WEBVIEW_LABEL) {
        gate.check()?;
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

    gate.check()?;
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
    window: crate::commands::CallerWebview,
    app: AppHandle,
    payload: Guarded<BrowserNavigatePayload>,
) -> Result<BrowserOkResult, String> {
    ensure_main_webview(&window)?;
    super::workflow_browser::ensure_unbound()?;
    let gate = admit(&payload.execution, true)?;
    let payload = payload.request;
    let target = valid_http_url(&payload.url)?;
    let window = app
        .get_webview_window(BROWSER_WEBVIEW_LABEL)
        .ok_or("The in-app browser is not open.")?;
    let url = tauri::Url::parse(&target).map_err(|e| format!("bad url: {e}"))?;
    gate.check()?;
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
    window: crate::commands::CallerWebview,
    app: AppHandle,
    payload: ExecutionOnly,
) -> Result<BrowserOkResult, String> {
    ensure_main_webview(&window)?;
    super::workflow_browser::ensure_unbound()?;
    let gate = admit(&payload.execution, true)?;
    if let Some(window) = app.get_webview_window(BROWSER_WEBVIEW_LABEL) {
        gate.check()?;
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
    #[serde(rename = "expectedUrl")]
    pub expected_url: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct BrowserActionResult {
    pub ok: bool,
    pub matched: bool,
    pub clicked: bool,
    pub url: String,
}

/// A click is successful only after the page reports a matching visible target.
#[tauri::command]
pub async fn browser_click(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    payload: Guarded<BrowserClickPayload>,
) -> Result<BrowserActionResult, String> {
    ensure_main_webview(&window)?;
    super::workflow_browser::ensure_unbound()?;
    let gate = admit(&payload.execution, true)?;
    let payload = payload.request;
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
    let current_url = window
        .url()
        .map_err(|_| "Browser URL unavailable.")?
        .to_string();
    if payload
        .expected_url
        .as_ref()
        .is_some_and(|url| url != &current_url)
    {
        return Err("Browser URL changed before the approved click.".into());
    }
    let id = request_id();
    let js = format!(
        r#"(async function(){{
      var report=function(ok,matched,clicked){{if(window.__luczorReport)window.__luczorReport('{id}',JSON.stringify({{ok:ok,matched:matched,clicked:clicked,url:location.href}}),false);}};
      try{{var until=await window.__luczorAuthorize('{id}');if(Date.now()>until){{report(false,false,false);return;}}if(location.href!=='{url}'||document.readyState==='loading'){{report(false,false,false);return;}}
      var nodes=document.querySelectorAll('{selector}');if(nodes.length!==1){{report(false,false,false);return;}}
      var el=nodes[0],r=el.getBoundingClientRect(),s=getComputedStyle(el);
      if(el.disabled||el.getAttribute('aria-disabled')==='true'||r.width<=0||r.height<=0||s.visibility!=='visible'||s.display==='none'||s.pointerEvents==='none'){{report(false,true,false);return;}}
      var x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
      if(x<0||y<0||x>=innerWidth||y>=innerHeight||!hit||(hit!==el&&!el.contains(hit))){{report(false,true,false);return;}}
      el.click();report(true,true,true);
      }}catch(error){{report(false,false,false);}}
    }})();"#,
        id = js_string(&id),
        url = js_string(&current_url),
        selector = js_string(selector)
    );
    let report = correlated_eval(&window, id, &js, gate, Duration::from_secs(10), true).await?;
    decode_click_report(report)
}
fn decode_click_report(report: ReportedText) -> Result<BrowserActionResult, String> {
    if report.truncated {
        return Err("Truncated browser click acknowledgement.".into());
    }
    let result: BrowserActionResult =
        serde_json::from_str(&report.text).map_err(|_| "Invalid browser click acknowledgement.")?;
    if !result.ok || !result.matched || !result.clicked {
        return Err("Browser click was not performed: page not ready, selector missing/ambiguous, or element not actionable.".into());
    }
    Ok(result)
}

#[derive(Deserialize)]
pub struct BrowserReadPayload {
    pub selector: Option<String>,
    pub timeout_seconds: Option<u64>,
    #[serde(rename = "expectedUrl")]
    pub expected_url: Option<String>,
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
    window: crate::commands::CallerWebview,
    app: AppHandle,
    payload: Guarded<BrowserReadPayload>,
) -> Result<BrowserReadResult, String> {
    ensure_main_webview(&window)?;
    super::workflow_browser::ensure_unbound()?;
    let gate = admit(&payload.execution, false)?;
    let payload = payload.request;
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
    let current_url = window
        .url()
        .map_err(|_| "Browser URL unavailable.")?
        .to_string();
    if payload
        .expected_url
        .as_ref()
        .is_some_and(|url| url != &current_url)
    {
        return Err("Browser URL changed before read.".into());
    }
    let id = request_id();
    let js = format!(
        "(function(){{try{{var el=document.querySelector('{sel}'); var t=String(el?(el.innerText||el.textContent||''):''); if(window.__luczorReport) window.__luczorReport('{id}', JSON.stringify({{found:!!el,url:location.href,text:t.slice(0,{max})}}), t.length>{max});}}catch(e){{if(window.__luczorReport)window.__luczorReport('{id}',JSON.stringify({{found:false,url:location.href,text:''}}),false);}}}})();",
        sel = js_string(&selector), id = js_string(&id), max = MAX_READ_CHARS / 2,
    );
    let report = correlated_eval(&window, id, &js, gate, timeout, false).await?;
    decode_read_report(report, &current_url)
}
fn decode_read_report(
    report: ReportedText,
    current_url: &str,
) -> Result<BrowserReadResult, String> {
    let data: serde_json::Value =
        serde_json::from_str(&report.text).map_err(|_| "Invalid browser read acknowledgement.")?;
    if data.get("found").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(
            "The requested browser selector was not found; no fallback content was returned."
                .into(),
        );
    }
    if data.get("url").and_then(serde_json::Value::as_str) != Some(current_url) {
        return Err("Browser navigated during read; result discarded.".into());
    }
    let text = data
        .get("text")
        .and_then(serde_json::Value::as_str)
        .ok_or("Browser read did not return text.")?
        .to_string();
    Ok(BrowserReadResult {
        ok: true,
        text,
        truncated: report.truncated,
    })
}

async fn correlated_eval(
    window: &WebviewWindow,
    id: String,
    js: &str,
    gate: ExecutionLease,
    timeout: Duration,
    authorize: bool,
) -> Result<ReportedText, String> {
    let (tx, rx) = mpsc::channel::<ReportedText>();
    pending()
        .lock()
        .map_err(|_| "lock poisoned")?
        .insert(id.clone(), tx);

    if authorize {
        action_permits()
            .lock()
            .map_err(|_| "Browser admission unavailable.")?
            .insert(id.clone(), gate.clone());
    }
    if let Err(error) = gate.check() {
        action_permits()
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&id));
        pending().lock().ok().and_then(|mut map| map.remove(&id));
        return Err(error);
    }
    if let Err(e) = window.eval(js) {
        action_permits()
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&id));
        pending().lock().ok().and_then(|mut m| m.remove(&id));
        return Err(format!("read eval failed: {e}"));
    }

    let id_for_wait = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + timeout;
        loop {
            gate.check()?;
            match rx.recv_timeout(Duration::from_millis(40)) {
                Ok(report) => {
                    gate.check()?;
                    return Ok(report);
                }
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
                Err(_) => {
                    return Err(
                        "The browser did not acknowledge the action before its deadline."
                            .to_string(),
                    )
                }
            }
        }
    })
    .await
    .map_err(|e| format!("join failed: {e}"));
    pending()
        .lock()
        .ok()
        .and_then(|mut m| m.remove(&id_for_wait));
    action_permits()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&id_for_wait));

    result?
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
    window: crate::commands::CallerWebview,
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
    fn acknowledgements_reject_missing_targets_stale_reads_and_false_clicks() {
        use super::{decode_click_report, decode_read_report, ReportedText};
        let report = |text: &str| ReportedText {
            text: text.into(),
            truncated: false,
        };
        assert!(decode_click_report(report(
            r#"{"ok":true,"matched":false,"clicked":false,"url":"https://example.org/"}"#
        ))
        .is_err());
        assert!(decode_click_report(report(
            r#"{"ok":true,"matched":true,"clicked":true,"url":"https://example.org/"}"#
        ))
        .is_ok());
        assert!(decode_read_report(
            report(r#"{"found":false,"url":"https://example.org/","text":""}"#),
            "https://example.org/"
        )
        .is_err());
        assert!(decode_read_report(
            report(r#"{"found":true,"url":"https://other.org/","text":"wrong page"}"#),
            "https://example.org/"
        )
        .is_err());
        assert_eq!(
            decode_read_report(
                report(r#"{"found":true,"url":"https://example.org/","text":""}"#),
                "https://example.org/"
            )
            .unwrap()
            .text,
            ""
        );
    }

    #[test]
    fn url_validation_rejects_non_http() {
        assert!(valid_http_url("https://example.org").is_ok());
        assert!(valid_http_url("http://localhost:8010").is_ok());
        assert!(valid_http_url("file:///etc/passwd").is_ok());
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
