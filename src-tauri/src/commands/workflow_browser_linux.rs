//! Linux WebKitGTK adapter. Compiled native content filters protect all requests;
//! fixed automation code runs in an isolated JS world and returns through native callbacks.
use super::*;
use glib::translate::ToGlibPtr;
use javascriptcore::ValueExt;
use webkit2gtk::{LoadEvent, SnapshotOptions, SnapshotRegion, WebViewExt};

fn filters(hosts: Option<&[String]>) -> Value {
    let mut rules = vec![json!({"trigger":{"url-filter":".*"},"action":{"type":"block"}})];
    let patterns = match hosts {
        None => vec!["^https?://[^/@]+/".to_string()],
        Some(hosts) => hosts
            .iter()
            .map(|host| {
                let escaped = regex::escape(host);
                if host.contains(':') {
                    format!("^https?://{escaped}/")
                } else {
                    format!("^(http://{escaped}(:80)?/|https://{escaped}(:443)?/)")
                }
            })
            .collect(),
    };
    for pattern in patterns.into_iter().chain(["^about:blank$".into()]) {
        rules.push(json!({"trigger":{"url-filter":pattern,"url-filter-is-case-sensitive":false},"action":{"type":"ignore-previous-rules"}}));
    }
    Value::Array(rules)
}
struct FilterCallback {
    manager: webkit2gtk::UserContentManager,
    sender: mpsc::SyncSender<Result<(), String>>,
    app: AppHandle,
    session: Arc<Session>,
}
unsafe extern "C" fn filter_ready(
    source: *mut glib::gobject_ffi::GObject,
    result: *mut gio::ffi::GAsyncResult,
    data: glib::ffi::gpointer,
) {
    let callback = Box::from_raw(data.cast::<FilterCallback>());
    let mut error = std::ptr::null_mut();
    let filter = webkit2gtk::ffi::webkit_user_content_filter_store_save_finish(
        source.cast(),
        result,
        &mut error,
    );
    let outcome = if filter.is_null() {
        if !error.is_null() {
            glib::ffi::g_error_free(error);
        }
        Err("workflow_browser_host_boundary_unavailable".into())
    } else {
        let outcome = check_session(&callback.app, &callback.session);
        if outcome.is_ok() {
            webkit2gtk::ffi::webkit_user_content_manager_add_filter(
                callback.manager.to_glib_none().0,
                filter,
            );
        }
        webkit2gtk::ffi::webkit_user_content_filter_unref(filter);
        outcome
    };
    glib::gobject_ffi::g_object_unref(source);
    let _ = callback.sender.try_send(outcome);
}
pub(super) async fn install_request_boundary(
    window: &Webview,
    app: AppHandle,
    session: Arc<Session>,
) -> Result<(), String> {
    let path = app
        .path()
        .app_cache_dir()
        .map_err(|_| "workflow_browser_cache_unavailable")?
        .join("webkit-host-filters");
    std::fs::create_dir_all(&path).map_err(|_| "workflow_browser_cache_unavailable")?;
    let path = std::ffi::CString::new(path.to_string_lossy().as_bytes())
        .map_err(|_| "workflow_browser_cache_unavailable")?;
    let encoded = filters(session.allowed_hosts.as_deref()).to_string();
    let (sender, receiver) = mpsc::sync_channel(1);
    let cb_app = app.clone();
    let cb_session = session.clone();
    window
        .with_webview(move |platform| {
            let view = platform.inner();
            let Some(manager) = view.user_content_manager() else {
                let _ = sender.send(Err("workflow_browser_host_boundary_unavailable".into()));
                return;
            };
            let navigation_session = cb_session.clone();
            view.connect_load_changed(move |view, event| {
                if let Ok(mut tracker) = navigation_session.navigation.lock() {
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
            let failed_session = cb_session.clone();
            view.connect_load_failed(move |_, _, _, _| {
                if let Ok(mut tracker) = failed_session.navigation.lock() {
                    let id = tracker.generation;
                    tracker.finished(id, false);
                }
                false
            });
            let bytes = glib::Bytes::from_owned(encoded.into_bytes());
            let identifier = std::ffi::CString::new(format!("luczor-{}", cb_session.id))
                .expect("UUID identifier");
            unsafe {
                let store = webkit2gtk::ffi::webkit_user_content_filter_store_new(path.as_ptr());
                if store.is_null() {
                    let _ = sender.send(Err("workflow_browser_host_boundary_unavailable".into()));
                    return;
                }
                let callback = Box::new(FilterCallback {
                    manager,
                    sender,
                    app: cb_app,
                    session: cb_session,
                });
                webkit2gtk::ffi::webkit_user_content_filter_store_save(
                    store,
                    identifier.as_ptr(),
                    bytes.to_glib_none().0,
                    std::ptr::null_mut(),
                    Some(filter_ready),
                    Box::into_raw(callback).cast(),
                );
            }
        })
        .map_err(|_| "workflow_browser_host_boundary_unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            check_session(&app, &session)?;
            match receiver.recv_timeout(Duration::from_millis(40)) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
                _ => return Err("workflow_browser_host_boundary_unavailable".into()),
            }
        }
    })
    .await
    .map_err(|_| "workflow_browser_task_failed")?
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compiled_filter_does_not_allow_suffix_hosts_or_arbitrary_ports() {
        let rules = filters(Some(&["example.com".into()]));
        let pattern = rules[1]["trigger"]["url-filter"].as_str().unwrap();
        let pattern = regex::Regex::new(pattern).unwrap();
        assert!(pattern.is_match("https://example.com/path"));
        for url in [
            "https://example.com.evil/path",
            "https://evil@example.com/path",
            "https://example.com:444/path",
        ] {
            assert!(!pattern.is_match(url));
        }
    }
}
