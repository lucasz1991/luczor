//! Native-owned, click-through feedback. This webview has no IPC capability.
use super::system::MonitorInfo;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "desktop-control-feedback";
static GENERATION: AtomicU64 = AtomicU64::new(0);
static READY: AtomicBool = AtomicBool::new(false);
static LATEST: Mutex<Option<serde_json::Value>> = Mutex::new(None);
const PAGE: &str = r##"<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;pointer-events:none}
body:before{content:'';position:fixed;inset:0;border:4px solid #398cff;box-sizing:border-box}
#label{position:fixed;top:4px;left:50%;transform:translateX(-50%);background:#1764c5;color:white;font:12px system-ui;padding:4px 12px;border-radius:0 0 6px 6px}
#pointer{position:fixed;left:0;top:0;color:white;font:12px system-ui;display:none;filter:drop-shadow(0 1px 2px #000)}
#pointer span{background:#1764c5;border-radius:4px;padding:2px 5px;position:absolute;left:19px;top:23px}
</style></head><body><div id="label">Luczor · Bildschirmsteuerung</div><div id="pointer"><svg width="25" height="32" viewBox="0 0 25 32"><path d="M2 2L2 25L8 20L13 30L18 27L13 18L23 18Z" fill="#398cff" stroke="white" stroke-width="2"/></svg><span>Luczor</span></div></body></html>"##;

pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    // A constant, non-network resource avoids data-URL re-encoding/CSP truncation.
    // It cannot read files, accepts no input and has no IPC capability.
    tauri::plugin::Builder::new("desktop-control-feedback")
        .register_uri_scheme_protocol("luczor-feedback", |context, request| {
            let allowed = context.webview_label() == LABEL
                && request.method() == tauri::http::Method::GET
                && request.uri().path() == "/";
            tauri::http::Response::builder()
                .status(if allowed { 200 } else { 404 })
                .header("Content-Type", "text/html; charset=utf-8")
                .header(
                    "Content-Security-Policy",
                    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
                )
                .body(if allowed { PAGE.as_bytes() } else { b"" })
                .expect("constant overlay response")
        })
        .build()
}

fn paint(payload: &serde_json::Value) -> String {
    // Evaluated by the native owner after load; no inline script/CSP exemption in PAGE.
    format!("(()=>{{const p={payload},e=document.getElementById('pointer');if(!e||document.readyState!=='complete')return false;e.style.display=p.point?'block':'none';if(p.point){{e.style.left=(p.point[0]/devicePixelRatio)+'px';e.style.top=(p.point[1]/devicePixelRatio)+'px'}}return true}})()")
}

pub fn show(
    app: &AppHandle,
    monitor: &MonitorInfo,
    _target: u64,
    point: Option<(i32, i32)>,
    execution: Option<super::execution::ExecutionPermit>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if super::desktop_linux::is_wayland() {
        return Err("desktop_control_wayland_overlay_unavailable_use_internal_browser".into());
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let payload = serde_json::json!({"point": point.map(|(x,y)| [x-monitor.x,y-monitor.y])});
    *LATEST
        .lock()
        .map_err(|_| "desktop_control_overlay_unavailable")? = Some(payload.clone());
    let position = PhysicalPosition::new(monitor.x, monitor.y);
    let size = PhysicalSize::new(monitor.width, monitor.height);
    let handle = app.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let show_permit = execution.clone();
    app.run_on_main_thread(move || {
        if GENERATION.load(Ordering::SeqCst) != generation {
            let _ = sender.send(Err("desktop_control_overlay_superseded".to_string()));
            return;
        }
        if show_permit
            .as_ref()
            .is_some_and(|permit| super::execution::admit(permit, false).is_err())
        {
            let _ = sender.send(Err("desktop_control_execution_stopped".to_string()));
            return;
        }
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let overlay = if let Some(view) = handle.get_webview_window(LABEL) {
                view
            } else {
                READY.store(false, Ordering::SeqCst);
                WebviewWindowBuilder::new(
                    &handle,
                    LABEL,
                    WebviewUrl::CustomProtocol("luczor-feedback://localhost/".parse()?),
                )
                .title("Luczor Bildschirmsteuerung")
                .visible(false)
                .focused(false)
                .focusable(false)
                .decorations(false)
                .resizable(false)
                .shadow(false)
                .transparent(true)
                .on_page_load(|view, event| {
                    #[cfg(all(test, feature = "native-browser-smoke"))]
                    eprintln!(
                        "NATIVE_OVERLAY_LOAD: {:?} {}",
                        event.event(),
                        event.url().scheme()
                    );
                    if matches!(event.event(), tauri::webview::PageLoadEvent::Finished) {
                        if let Ok(latest) = LATEST.lock() {
                            if let Some(payload) = latest.as_ref() {
                                let _ = view.eval_with_callback(paint(payload), |result| {
                                    READY.store(result == "true", Ordering::SeqCst);
                                });
                            }
                        }
                    }
                })
                .always_on_top(true)
                .skip_taskbar(true)
                .on_navigation(|url| {
                    #[cfg(all(test, feature = "native-browser-smoke"))]
                    eprintln!("NATIVE_OVERLAY_NAV: {}", url.scheme());
                    matches!(
                        url.as_str(),
                        "luczor-feedback://localhost/" | "http://luczor-feedback.localhost/"
                    )
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?
            };
            overlay.set_ignore_cursor_events(true)?;
            overlay.set_position(position)?;
            overlay.set_size(size)?;
            if READY.load(Ordering::SeqCst) {
                overlay.eval(paint(&payload))?;
            }
            overlay.show()?;
            Ok(())
        })();
        let _ = sender.send(result.map_err(|error| {
            eprintln!("[luczor] desktop control overlay: {error}");
            "desktop_control_overlay_unavailable".to_string()
        }));
    })
    .map_err(|_| "desktop_control_overlay_unavailable")?;
    match receiver.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(result) => result?,
        Err(_) => {
            if GENERATION
                .compare_exchange(
                    generation,
                    generation + 1,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .is_ok()
            {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if GENERATION.load(Ordering::SeqCst) == generation + 1 {
                        if let Some(view) = handle.get_webview_window(LABEL) {
                            let _ = view.hide();
                        }
                    }
                });
            }
            return Err("desktop_control_overlay_timeout".into());
        }
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !READY.load(Ordering::SeqCst) {
        if GENERATION.load(Ordering::SeqCst) != generation {
            return Err("desktop_control_overlay_superseded".into());
        }
        if std::time::Instant::now() >= deadline {
            hide(app);
            return Err("desktop_control_overlay_load_timeout".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let start = std::time::Instant::now();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            if GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            if start.elapsed() >= std::time::Duration::from_secs(30)
                || execution
                    .as_ref()
                    .is_some_and(|permit| super::execution::admit(permit, false).is_err())
            {
                break;
            }
        }
        let other = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if GENERATION.load(Ordering::SeqCst) == generation {
                if let Some(view) = other.get_webview_window(LABEL) {
                    let _ = view.hide();
                }
            }
        });
    });
    Ok(())
}

pub fn hide(app: &AppHandle) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if GENERATION.load(Ordering::SeqCst) == generation {
            if let Some(view) = handle.get_webview_window(LABEL) {
                let _ = view.hide();
            }
        }
    });
}
