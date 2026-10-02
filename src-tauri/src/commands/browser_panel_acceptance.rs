//! Test-only native acceptance; all actions stay within the synthetic loopback fixture.
use super::*;
use std::path::Path;
use std::time::Instant;

struct Evidence {
    path: std::path::PathBuf,
    value: Value,
    navigation: Arc<std::sync::Mutex<Vec<Value>>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl Evidence {
    fn persist(&self) -> Result<(), String> {
        let mut value = self.value.clone();
        value["nativeNavigation"] = json!(self
            .navigation
            .lock()
            .map_err(|_| "probe_navigation_log_failed")?
            .clone());
        std::fs::write(&self.path, serde_json::to_vec_pretty(&value).unwrap())
            .map_err(|error| format!("probe_evidence_write_failed: {error}"))
    }

    fn record(
        &mut self,
        stage: &str,
        started: Instant,
        result: &Result<Value, String>,
    ) -> Result<(), String> {
        let sequence = self.value["events"].as_array().unwrap().len() + 1;
        self.value["events"].as_array_mut().unwrap().push(json!({
            "sequence": sequence,
            "stage": stage,
            "timestampUnixMs": now_ms(),
            "elapsedMs": started.elapsed().as_millis() as u64,
            "status": if result.is_ok() { "passed" } else { "failed" },
            "result": result.as_ref().ok(),
            "error": result.as_ref().err(),
        }));
        self.persist()
    }
}

async fn perform(
    app: &AppHandle,
    base: &Value,
    operation: &str,
    fields: Value,
) -> Result<Value, String> {
    let mut input = base.clone();
    input["action"] = json!(operation);
    for (key, value) in fields.as_object().ok_or("probe_fields_invalid")? {
        input[key] = value.clone();
    }
    let output = workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        serde_json::from_value(input).map_err(|_| "probe_request_invalid")?,
    )
    .await?;
    serde_json::to_value(output).map_err(|_| "probe_response_invalid".into())
}

async fn expected_failure(
    app: &AppHandle,
    base: &Value,
    operation: &str,
    fields: Value,
    expected_code: &str,
) -> Result<Value, String> {
    let mut input = base.clone();
    input["action"] = json!(operation);
    for (key, value) in fields.as_object().ok_or("probe_fields_invalid")? {
        input[key] = value.clone();
    }
    let result = workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        serde_json::from_value(input).map_err(|_| "probe_request_invalid")?,
    )
    .await;
    let error = match result {
        Ok(_) => return Err("probe_expected_native_refusal".into()),
        Err(error) => error,
    };
    let value = serde_json::to_value(&error).map_err(|_| "probe_failure_invalid")?;
    if value["version"] != 1
        || value["code"] != expected_code
        || value["operation"] != operation
        || value["backend"] != "webview2"
        || !value["operationId"]
            .as_str()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        || value.get("url").is_some()
        || value.get("message").is_some()
    {
        return Err(format!("probe_failure_contract_mismatch: {value}"));
    }
    Ok(value)
}

pub(super) async fn run(
    app: &AppHandle,
    root: &Path,
    host: &str,
    run_id: &str,
    visible: bool,
    manual_seconds: u64,
) -> Result<(), String> {
    let path = std::env::var_os("LUCZOR_BROWSER_PROBE_REPORT")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| root.join("acceptance.json"));
    let mut evidence = Evidence {
        path,
        navigation: Arc::new(std::sync::Mutex::new(Vec::new())),
        value: json!({"version":1,"runId":run_id,"kind":"native_browser_acceptance","appIdentifier":app.config().identifier,
            "appVersion":app.config().version,"createdAtUnixMs":now_ms(),"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
            "workspace":root,"appData":app.path().app_local_data_dir().ok(),"fixtureOrigin":format!("http://{host}"),
            "visible":visible,"manualStatus":"not_requested","status":"running","events":[]}),
    };
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&evidence.path)
        .map_err(|error| format!("probe_evidence_create_failed: {error}"))?;
    evidence.persist()?;
    println!("NATIVE_BROWSER_EVIDENCE={}", evidence.path.display());
    let result = run_inner(
        app,
        root,
        host,
        run_id,
        visible,
        manual_seconds,
        &mut evidence,
    )
    .await;
    evidence.value["status"] = json!(if result.is_ok() { "passed" } else { "failed" });
    evidence.value["error"] = json!(result.as_ref().err());
    evidence.persist()?;
    result
}

async fn run_inner(
    app: &AppHandle,
    root: &Path,
    host: &str,
    run_id: &str,
    visible: bool,
    manual_seconds: u64,
    evidence: &mut Evidence,
) -> Result<(), String> {
    let started = Instant::now();
    let desktop_isolation = match crate::commands::desktop_control::capture_monitor(None) {
        Err(code) if code == "desktop_control_monitor_unavailable" => Ok(json!({
            "desktopCapture": "blocked",
            "code": code,
        })),
        _ => Err("probe_desktop_monitor_isolation_failed".into()),
    };
    evidence.record("unavailable_desktop_monitor", started, &desktop_isolation)?;
    desktop_isolation?;
    let identity = uuid::Uuid::new_v4().to_string();
    execution::execution_gate_update(
        caller(app),
        serde_json::from_value(
            json!({"sessionId":identity,"generation":1,"mode":"act","killSwitch":false}),
        )
        .unwrap(),
    )
    .await?;
    let workspace = project_workspace::project_workspace_bind(
        caller(app),
        app.clone(),
        serde_json::from_value(
            json!({"principalId":"isolated-browser-probe","projectId":"probe","rootPath":root}),
        )
        .unwrap(),
    )
    .await?;
    let workspace = serde_json::to_value(workspace).unwrap();
    let scope = json!({"principalId":"isolated-browser-probe","projectId":"probe","expectedRootPath":workspace["rootPath"],"expectedWorkspaceUpdatedAt":workspace["updatedAt"],"runId":run_id});
    let base = json!({"scope":scope,"execution":{"sessionId":identity,"generation":1,"workflowExecutionId":run_id},"automated":true,"timeoutMs":3000});
    let started = Instant::now();
    let blank = perform(app, &base, "open", json!({})).await;
    evidence.record("implicit_blank_open", started, &blank)?;
    let blank = blank?;
    if blank["url"] != "about:blank" || blank["data"]["readiness"] != "ready" {
        return Err("probe_implicit_blank_not_ready".into());
    }
    evidence.value["sessionId"] = blank["sessionId"].clone();
    let view = app
        .get_webview(BROWSER_WEBVIEW_LABEL)
        .ok_or("probe_browser_missing")?;
    capture_navigation(&view, evidence.navigation.clone()).await?;
    for (stage, operation) in [
        ("explicit_blank_open", "open"),
        ("explicit_blank_navigate", "navigate"),
    ] {
        let started = Instant::now();
        let ready = perform(app, &base, operation, json!({"url":"about:blank"})).await;
        evidence.record(stage, started, &ready)?;
        let ready = ready?;
        if ready["url"] != "about:blank"
            || ready["data"]["readiness"] != "ready"
            || ready["sessionId"] != blank["sessionId"]
        {
            return Err("probe_explicit_blank_not_ready".into());
        }
    }
    let started = Instant::now();
    let empty = perform(app, &base, "scan", json!({})).await;
    evidence.record("blank_dom_scan", started, &empty)?;
    if !empty?["data"]["elements"]
        .as_array()
        .is_some_and(Vec::is_empty)
    {
        return Err("probe_blank_document_not_empty".into());
    }
    let local = root.join("blank navigation % fixture # ä.html");
    std::fs::write(&local, "<!doctype html><html><body><p id=local-proof>Local blank navigation fixture</p></body></html>")
        .map_err(|_| "probe_local_fixture_write_failed")?;
    let started = Instant::now();
    let loaded = perform(app, &base, "navigate", json!({"url":local})).await;
    evidence.record("local_file_after_blank", started, &loaded)?;
    let loaded = loaded?;
    if !loaded["url"]
        .as_str()
        .is_some_and(|url| url.starts_with("file:"))
        || loaded["data"]["readiness"] != "ready"
        || loaded["sessionId"] != blank["sessionId"]
    {
        return Err("probe_local_file_not_ready".into());
    }
    let started = Instant::now();
    let content = perform(app, &base, "read", json!({"selector":"#local-proof"})).await;
    evidence.record("local_file_read", started, &content)?;
    if content?["data"]["text"] != "Local blank navigation fixture" {
        return Err("probe_local_file_content_mismatch".into());
    }
    let started = Instant::now();
    let opened = perform(
        app,
        &base,
        "open",
        json!({"url":format!("http://{host}/first")}),
    )
    .await;
    evidence.record("navigation_open", started, &opened)?;
    let opened = opened?;
    if opened["sessionId"] != blank["sessionId"] {
        return Err("probe_http_changed_session".into());
    }
    if view.window().label() != "main" {
        return Err("probe_browser_wrong_parent".into());
    }
    browser_panel_layout(
        caller(app),
        app.clone(),
        PanelLayout {
            visible: true,
            project_id: "probe".into(),
            left: 15.0,
            top: 15.0,
            width: 1070.0,
            height: 725.0,
            zoom: 1.0,
            ..Default::default()
        },
    )
    .await?;
    if visible && manual_seconds > 0 {
        perform(
            app,
            &base,
            "navigate",
            json!({"url":format!("http://{host}/manual")}),
        )
        .await?;
        println!("NATIVE_BROWSER_MANUAL_READY: runId={run_id} seconds={manual_seconds}; enter Manual Luczor, Apply, select Linux, reveal/click Dynamic action, Confirm manual check");
        evidence.value["manualStatus"] = json!("waiting");
        evidence.persist()?;
        let deadline = Instant::now() + Duration::from_secs(manual_seconds);
        loop {
            let state = perform(app, &base, "read", json!({"selector":"#manual-status"})).await?;
            if state["data"]["text"] == "Confirmed" {
                evidence.value["manualStatus"] = json!("confirmed");
                println!("NATIVE_BROWSER_MANUAL_CONFIRMED: runId={run_id}");
                break;
            }
            if Instant::now() >= deadline {
                evidence.value["manualStatus"] = json!("not_confirmed_before_deadline");
                println!("NATIVE_BROWSER_MANUAL_NOT_CONFIRMED: runId={run_id}");
                break;
            }
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(500)))
                .await
                .map_err(|_| "probe_manual_wait_failed")?;
        }
        evidence.persist()?;
        perform(
            app,
            &base,
            "navigate",
            json!({"url":format!("http://{host}/first")}),
        )
        .await?;
    }
    let started = Instant::now();
    let scan = perform(app, &base, "scan", json!({})).await;
    evidence.record("dom_scan", started, &scan)?;
    let scan = scan?;
    if !scan["data"]["elements"].as_array().is_some_and(|entries| {
        entries.iter().any(|entry| {
            entry["name"] == "Name" && entry["selector"] == "role=textbox[name=\"Name\"]"
        })
    }) {
        return Err("probe_name_not_scanned".into());
    }
    let name_selector = scan["data"]["elements"]
        .as_array()
        .and_then(|entries| entries.iter().find(|entry| entry["name"] == "Name"))
        .and_then(|entry| entry["selector"].as_str())
        .ok_or("probe_name_selector_missing")?;
    for (stage, operation, fields) in [
        (
            "form_fill",
            "fill",
            json!({"selector":name_selector,"value":"Luczor synthetic probe"}),
        ),
        ("form_click", "click", json!({"selector":"#apply"})),
        (
            "select_platform",
            "select",
            json!({"selector":"#platform","value":"linux"}),
        ),
        ("dynamic_reveal", "click", json!({"selector":"#reveal"})),
        (
            "dynamic_click",
            "click",
            json!({"selector":"#dynamic-action"}),
        ),
    ] {
        let started = Instant::now();
        let result = perform(app, &base, operation, fields).await;
        evidence.record(stage, started, &result)?;
        result?;
    }
    for (selector, expected) in [
        ("#result", "Luczor synthetic probe"),
        ("#selection", "linux"),
        ("#dynamic-result", "Done"),
    ] {
        let read = perform(app, &base, "read", json!({"selector":selector})).await?;
        if read["data"]["text"] != expected {
            return Err(format!("probe_result_mismatch: {selector}"));
        }
    }
    let started = Instant::now();
    let refusal = expected_failure(
        app,
        &base,
        "click",
        json!({"selector":"[","timeoutMs":300}),
        "browser_selector_invalid",
    )
    .await
    .map(|failure| json!({"failure":failure,"attempts":1,"noRetry":true}));
    evidence.record("invalid_selector_refusal", started, &refusal)?;
    refusal?;
    let started = Instant::now();
    let downloaded = perform(
        app,
        &base,
        "download",
        json!({"url":format!("http://{host}/probe-download.txt"),"name":"synthetic.txt"}),
    )
    .await;
    evidence.record("synthetic_download", started, &downloaded)?;
    if downloaded?["data"]["bytes"] != 26 {
        return Err("probe_download_size_mismatch".into());
    }
    let started = Instant::now();
    let next = perform(
        app,
        &base,
        "navigate",
        json!({"url":format!("http://{host}/second")}),
    )
    .await;
    evidence.record("navigation_second", started, &next)?;
    if !next?["url"]
        .as_str()
        .is_some_and(|url| url.ends_with("/second"))
    {
        return Err("probe_navigation_mismatch".into());
    }
    if let Some(path) =
        std::env::var_os("LUCZOR_BROWSER_PROBE_ACTIONS").filter(|value| !value.is_empty())
    {
        let bytes = std::fs::read(path).map_err(|_| "probe_actions_read_failed")?;
        if bytes.len() > 8192 {
            return Err("probe_actions_size_exceeded".into());
        }
        let actions: Value =
            serde_json::from_slice(&bytes).map_err(|_| "probe_actions_json_invalid")?;
        let actions = validate_actions(&actions)?;
        perform(
            app,
            &base,
            "navigate",
            json!({"url":format!("http://{host}/first")}),
        )
        .await?;
        for (index, (operation, mut fields)) in actions.into_iter().enumerate() {
            if operation == "navigate" {
                fields["url"] = json!(format!("http://{host}{}", fields["url"].as_str().unwrap()));
            }
            let started = Instant::now();
            let result = perform(app, &base, &operation, fields).await;
            evidence.record(&format!("supplied_actions_{}", index + 1), started, &result)?;
            result?;
        }
        let read = perform(app, &base, "read", json!({"selector":"#result"})).await?;
        evidence.value["suppliedActionsFinalResult"] = read["data"]["text"].clone();
    }
    // Keep a synthetic local document loading long enough to time out after
    // dispatch, then finish it so the retained session can be observed safely.
    let pending_resource = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "probe_delayed_resource_bind_failed")?;
    pending_resource
        .set_nonblocking(true)
        .map_err(|_| "probe_delayed_resource_setup_failed")?;
    let pending_host = pending_resource
        .local_addr()
        .map_err(|_| "probe_delayed_resource_address_failed")?;
    let delayed_document = root.join("delayed-readiness-fixture.html");
    std::fs::write(&delayed_document, format!("<!doctype html><html><body><label>Retained page<input></label><img src=\"http://{pending_host}/slow\"></body></html>"))
        .map_err(|_| "probe_delayed_fixture_write_failed")?;
    let resource = std::thread::spawn(move || -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok((mut socket, _)) = pending_resource.accept() {
                let _ = socket.set_read_timeout(Some(Duration::from_secs(1)));
                let mut request = [0_u8; 1024];
                let _ = socket.read(&mut request);
                std::thread::sleep(Duration::from_millis(1500));
                let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err("probe_delayed_resource_not_requested".into())
    });
    let started = Instant::now();
    let failed_open = expected_failure(
        app,
        &base,
        "open",
        json!({"url":delayed_document,"timeoutMs":300}),
        "workflow_browser_navigation_timeout",
    )
    .await;
    evidence.record("uncertain_open_failure", started, &failed_open)?;
    tauri::async_runtime::spawn_blocking(move || resource.join())
        .await
        .map_err(|_| "probe_delayed_resource_task_failed")?
        .map_err(|_| "probe_delayed_resource_thread_failed")??;
    let failed_open = failed_open?;
    if failed_open["outcome"] != "unknown"
        || failed_open["phase"] != "readiness"
        || failed_open["sessionId"] != blank["sessionId"]
    {
        return Err("probe_failed_open_diagnostics_missing".into());
    }
    // Resolve only by the same native owner scope, without trusting an error's session ID.
    let started = Instant::now();
    let observed = perform(app, &base, "scan", json!({})).await;
    evidence.record("dom_scan_after_failed_open", started, &observed)?;
    let observed = observed?;
    if observed["sessionId"] != blank["sessionId"]
        || !observed["data"]["elements"]
            .as_array()
            .is_some_and(|entries| entries.iter().any(|entry| entry["name"] == "Retained page"))
    {
        return Err("probe_failed_open_session_lost".into());
    }
    let started = Instant::now();
    let refused_open = expected_failure(
        app,
        &base,
        "open",
        json!({"url":"about:blank","expectedUrl":"https://example.test/wrong-source"}),
        "workflow_browser_url_changed",
    )
    .await;
    evidence.record(
        "existing_session_open_precondition_refusal",
        started,
        &refused_open,
    )?;
    let refused_open = refused_open?;
    if refused_open["outcome"] != "not_started" || refused_open["sessionId"] != blank["sessionId"] {
        return Err("probe_open_refusal_diagnostics_missing".into());
    }
    let started = Instant::now();
    let retained = perform(app, &base, "scan", json!({})).await;
    evidence.record("dom_scan_after_refused_existing_open", started, &retained)?;
    let retained = retained?;
    if retained["sessionId"] != blank["sessionId"]
        || retained["url"] != observed["url"]
        || !retained["data"]["elements"]
            .as_array()
            .is_some_and(|entries| entries.iter().any(|entry| entry["name"] == "Retained page"))
    {
        return Err("probe_refused_open_existing_session_lost".into());
    }
    let failed_navigation = expected_failure(
        app,
        &base,
        "navigate",
        json!({"url":format!("http://{host}/navigation-failure")}),
        "workflow_browser_navigation_failed",
    )
    .await
    .and_then(|failure| {
        if failure["phase"] != "navigation"
            || failure["outcome"] != "unknown"
            || !failure["backendCode"].is_i64()
            || !failure["navigationId"].is_u64()
            || failure["backendDomain"] != "webview2"
        {
            return Err(format!("probe_navigation_diagnostics_missing: {failure}"));
        }
        Ok(failure)
    });
    evidence.value["controlledNavigationFailure"] = json!({
        "status": if failed_navigation.is_ok() {"passed"} else {"failed"},
        "failure":failed_navigation.as_ref().ok(),
        "error":failed_navigation.as_ref().err(),
        "attempts":1,
        "noAutomaticRetry":true
    });
    evidence.persist()?;
    failed_navigation?;
    for (stage, operation) in [
        ("failed_navigation_scan", "scan"),
        ("failed_navigation_read", "read"),
    ] {
        let started = Instant::now();
        let observed = perform(app, &base, operation, json!({})).await;
        evidence.record(stage, started, &observed)?;
        let observed = observed?;
        if observed["sessionId"] != blank["sessionId"]
            || observed["data"]["documentUrl"] == observed["url"]
            || observed["data"]["browserUrl"] != observed["url"]
            || observed["data"]["documentUrlMatchesBrowser"] != false
            || observed["data"]["observationOnly"] != true
            || observed["data"]["elements"]
                .as_array()
                .is_some_and(|elements| elements.iter().any(|element| element.get("ref").is_some()))
        {
            return Err("probe_error_document_observation_mismatch".into());
        }
    }
    for (stage, operation, fields) in [
        (
            "error_document_explicit_source_refusal",
            "scan",
            json!({"expectedUrl":format!("http://{host}/navigation-failure")}),
        ),
        (
            "error_document_mutation_refusal",
            "click",
            json!({"selector":"#never-execute"}),
        ),
    ] {
        let started = Instant::now();
        let refusal = expected_failure(app, &base, operation, fields, "browser_url_changed").await;
        evidence.record(stage, started, &refusal)?;
        refusal?;
    }
    let foreign = CallerWebview {
        window: view.window(),
        webview: view,
    };
    if browser_panel_status(foreign, app.clone()).await.is_ok() {
        return Err("probe_host_boundary_failed".into());
    }
    workflow_browser::wf_browser_cleanup(
        app.clone(),
        caller(app),
        serde_json::from_value(scope).unwrap(),
    )
    .await?;
    if app.get_webview(BROWSER_WEBVIEW_LABEL).is_some() {
        return Err("probe_cleanup_failed".into());
    }
    // A new explicit blank open must bind its requested navigation rather than
    // accidentally accepting the webview's initial bootstrap document.
    let started = Instant::now();
    let fresh = perform(app, &base, "open", json!({"url":"about:blank"})).await;
    evidence.record("fresh_explicit_blank_open", started, &fresh)?;
    let fresh = fresh?;
    if fresh["url"] != "about:blank"
        || fresh["data"]["readiness"] != "ready"
        || fresh["sessionId"] == blank["sessionId"]
    {
        return Err("probe_fresh_blank_not_ready".into());
    }
    let started = Instant::now();
    let fresh_scan = perform(app, &base, "scan", json!({})).await;
    evidence.record("fresh_blank_dom_scan", started, &fresh_scan)?;
    let fresh_scan = fresh_scan?;
    if fresh_scan["sessionId"] != fresh["sessionId"]
        || !fresh_scan["data"]["elements"]
            .as_array()
            .is_some_and(Vec::is_empty)
    {
        return Err("probe_fresh_blank_scan_mismatch".into());
    }
    workflow_browser::wf_browser_cleanup(
        app.clone(),
        caller(app),
        serde_json::from_value(base["scope"].clone()).unwrap(),
    )
    .await?;
    if app.get_webview(BROWSER_WEBVIEW_LABEL).is_some() {
        return Err("probe_fresh_cleanup_failed".into());
    }
    evidence.value["isolationAndCleanup"] = json!("passed");
    Ok(())
}

async fn capture_navigation(
    view: &tauri::Webview,
    events: Arc<std::sync::Mutex<Vec<Value>>>,
) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    view.with_webview(move |view| {
        let result = unsafe {
            view.controller().CoreWebView2().and_then(|webview| {
                let handler = webview2_com::NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut id = 0;
                        let mut success = windows_webview::core::BOOL::default();
                        let mut status = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS(0);
                        args.NavigationId(&mut id)?;
                        args.IsSuccess(&mut success)?;
                        args.WebErrorStatus(&mut status)?;
                        if let Ok(mut events) = events.lock() {
                            events.push(json!({"id":id,"success":success.as_bool(),"webErrorStatus":status.0,"timestampUnixMs":now_ms()}));
                        }
                    }
                    Ok(())
                }));
                let mut token = 0;
                webview.add_NavigationCompleted(&handler, &mut token)
            })
        };
        let _ = sender.send(result.map_err(|error|error.to_string()));
    }).map_err(|error|error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| "probe_navigation_observer_timeout".to_string())?
    })
    .await
    .map_err(|_| "probe_navigation_observer_failed".to_string())?
}

fn validate_actions(value: &Value) -> Result<Vec<(String, Value)>, String> {
    let rows = value
        .as_array()
        .filter(|rows| !rows.is_empty() && rows.len() <= 8)
        .ok_or("probe_actions_count_invalid")?;
    rows.iter()
        .map(|row| {
            let object = row.as_object().ok_or("probe_action_invalid")?;
            if object
                .keys()
                .any(|key| !["action", "target", "value"].contains(&key.as_str()))
            {
                return Err("probe_action_field_invalid".into());
            }
            let action = row["action"].as_str().ok_or("probe_action_missing")?;
            let target = row["target"]
                .as_str()
                .ok_or("probe_action_target_missing")?;
            let fields = match (action, target) {
                ("fill", "name") => {
                    let text = row["value"]
                        .as_str()
                        .filter(|text| text.len() <= 120 && !text.chars().any(char::is_control))
                        .ok_or("probe_action_value_invalid")?;
                    json!({"selector":"#name","value":text})
                }
                ("select", "platform") => {
                    let value = row["value"]
                        .as_str()
                        .filter(|value| ["linux", "windows"].contains(value))
                        .ok_or("probe_action_value_invalid")?;
                    json!({"selector":"#platform","value":value})
                }
                ("click", "apply" | "reveal" | "dynamic-action") if row.get("value").is_none() => {
                    json!({"selector":format!("#{target}")})
                }
                ("navigate", "/first" | "/second") if row.get("value").is_none() => {
                    json!({"url":target})
                }
                _ => return Err("probe_action_not_allowed".into()),
            };
            Ok((action.to_string(), fields))
        })
        .collect()
}

#[test]
fn rejects_non_fixture_actions_before_execution() {
    for value in [
        json!([]),
        json!([{"action":"navigate","target":"https://example.com"}]),
        json!([{"action":"click","target":"apply","script":"anything"}]),
        json!([{"action":"fill","target":"name","value":"line\nbreak"}]),
        json!([{"action":"select","target":"platform","value":"other"}]),
    ] {
        assert!(validate_actions(&value).is_err());
    }
    assert!(validate_actions(&json!([{"action":"fill","target":"name","value":"Synthetic"},{"action":"click","target":"apply"},{"action":"select","target":"platform","value":"linux"}])).is_ok());
}
