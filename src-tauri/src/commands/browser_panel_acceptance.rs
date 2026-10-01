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
    let opened = perform(
        app,
        &base,
        "open",
        json!({"url":format!("http://{host}/first")}),
    )
    .await;
    evidence.record("navigation_open", started, &opened)?;
    let opened = opened?;
    evidence.value["sessionId"] = opened["sessionId"].clone();
    let view = app
        .get_webview(BROWSER_WEBVIEW_LABEL)
        .ok_or("probe_browser_missing")?;
    capture_navigation(&view, evidence.navigation.clone()).await?;
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
    if !scan["data"]["elements"]
        .as_array()
        .is_some_and(|entries| entries.iter().any(|entry| entry["name"] == "Name"))
    {
        return Err("probe_name_not_scanned".into());
    }
    for (stage, operation, fields) in [
        (
            "form_fill",
            "fill",
            json!({"selector":"label=Name","value":"Luczor synthetic probe"}),
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
