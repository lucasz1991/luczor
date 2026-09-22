//! WebKitGTK uses its own isolated world; no Luczor domain/content filters.
use super::*;
use javascriptcore::ValueExt;
use webkit2gtk::{LoadEvent, SnapshotOptions, SnapshotRegion, WebViewExt};

pub(super) async fn install_navigation_tracking(
    window: &Webview,
    app: AppHandle,
    session: Arc<Session>,
) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .with_webview(move |platform| {
            let result = check_session(&app, &session);
            if result.is_ok() {
                let view = platform.inner();
                let navigation = session.clone();
                view.connect_load_changed(move |view, event| {
                    if let Ok(mut tracker) = navigation.navigation.lock() {
                        let id = tracker.generation;
                        match event {
                            LoadEvent::Started => {
                                tracker.started(id, view.uri().as_deref().unwrap_or(""))
                            }
                            LoadEvent::Finished => tracker.finished(id, true),
                            _ => {}
                        }
                    }
                });
                view.connect_load_failed(move |_, _, _, _| {
                    if let Ok(mut tracker) = session.navigation.lock() {
                        let id = tracker.generation;
                        tracker.finished(id, false);
                    }
                    false
                });
            }
            let _ = sender.try_send(result);
        })
        .map_err(|_| "workflow_browser_navigation_tracking_unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| "workflow_browser_navigation_tracking_unavailable".to_string())?
    })
    .await
    .map_err(|_| "workflow_browser_task_failed".to_string())?
}
pub(super) async fn devtools(
    window: &Webview,
    method: &'static str,
    params: Value,
    app: AppHandle,
    session: Arc<Session>,
    gate: ExecutionLease,
    timeout: Duration,
) -> Result<Value, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let cb_app = app.clone();
    let cb_session = session.clone();
    let cb_gate = gate.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    let cb_cancelled = cancelled.clone();
    window.with_webview(move|platform|{
        if let Err(error)=check(&cb_app,&cb_session,&cb_gate){let _=sender.send(Err(error));return;}
        let view=platform.inner();
        match method {
            "Runtime.evaluate"=>{
                let Some(expression)=params["expression"].as_str()else{let _=sender.send(Err("workflow_browser_protocol_invalid".into()));return;};
                // eval receives a serialized native-generated expression, never unescaped page text.
                let body=format!("const value = await eval({}); return JSON.stringify({{result:{{value}}}});",json!(expression));
                view.call_async_javascript_function(&body,None,Some("luczor-native-automation"),None,gio::Cancellable::NONE,move|result|{
                    if cb_cancelled.load(Ordering::Acquire){return;}
                    let result=result.map_err(|_|"workflow_browser_action_failed_outcome_unknown".to_string()).and_then(|value|{
                        let json=value.to_json(0).ok_or("workflow_browser_protocol_invalid")?;
                        let inner:String=serde_json::from_str(&json).map_err(|_|"workflow_browser_protocol_invalid")?;
                        if inner.len()>MAX_ARTIFACT_BYTES*2{return Err("workflow_browser_output_exceeded".into());}
                        serde_json::from_str(&inner).map_err(|_|"workflow_browser_protocol_invalid".into())
                    });let _=sender.try_send(result);
                });
            },
            "Page.captureScreenshot"=>view.snapshot(SnapshotRegion::Visible,SnapshotOptions::NONE,gio::Cancellable::NONE,move|result|{
                if cb_cancelled.load(Ordering::Acquire){return;}
                let result=result.map_err(|_|"workflow_browser_screenshot_failed".to_string()).and_then(|surface|{let mut bytes=Vec::new();surface.write_to_png(&mut bytes).map_err(|_|"workflow_browser_screenshot_failed")?;if bytes.len()>MAX_ARTIFACT_BYTES{return Err("workflow_browser_output_exceeded".into());}Ok(json!({"data":base64::engine::general_purpose::STANDARD.encode(bytes)}))});let _=sender.try_send(result);
            }),
            _=>{let _=sender.try_send(Err("workflow_browser_protocol_unavailable".into()));},
        }
    }).map_err(|_|"workflow_browser_protocol_unavailable")?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + timeout;
        loop {
            check(&app, &session, &gate)?;
            match receiver.recv_timeout(Duration::from_millis(40)) {
                Ok(result) => {
                    check(&app, &session, &gate)?;
                    return result;
                }
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
                _ => return Err("workflow_browser_timeout_outcome_unknown".into()),
            }
        }
    })
    .await
    .map_err(|_| "workflow_browser_task_failed")?;
    cancelled.store(true, Ordering::Release);
    result
}
