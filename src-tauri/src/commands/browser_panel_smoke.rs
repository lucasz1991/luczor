//! Opt-in native regression: isolated profile, hidden main window, loopback-only page.
use super::*;
use crate::commands::{execution, project_workspace, workflow_browser};
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

fn caller(app: &AppHandle) -> CallerWebview {
    let webview = app.get_webview("main").expect("probe main renderer");
    CallerWebview {
        window: webview.window(),
        webview,
    }
}

#[test]
#[ignore = "Creates an isolated hidden native WebView2 session; run explicitly with --test-threads=1"]
fn native_browser_panel_smoke() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let host = listener.local_addr().unwrap().to_string();
    let shutdown = Arc::new(AtomicBool::new(false));
    let server_stop = shutdown.clone();
    let server_host = host.clone();
    let server = std::thread::spawn(move || {
        while !server_stop.load(Ordering::Acquire) {
            if let Ok((mut socket, _)) = listener.accept() {
                let _ = socket.set_read_timeout(Some(Duration::from_secs(1)));
                let mut request = [0u8; 4096];
                let _ = socket.read(&mut request);
                let request = String::from_utf8_lossy(&request);
                let alternate = server_host.replace("127.0.0.1", "localhost");
                let (mime, page) = if request.starts_with("GET /asset.js ") {
                    (
                        "application/javascript",
                        "document.getElementById('cross').textContent='Cross-domain asset loaded';"
                            .to_string(),
                    )
                } else if request.starts_with("GET /frame ") {
                    (
                        "text/html",
                        "<!doctype html><label>Frame field<input></label>".to_string(),
                    )
                } else {
                    ("text/html", format!("<!doctype html><html><body><h1>Browser probe</h1><label>Name<input id='name'></label><button id='apply' onclick=\"document.getElementById('result').textContent=document.getElementById('name').value\">Apply</button><p id='result'>Pending</p><p id='cross'>Waiting</p><div id='shadow'></div><iframe src='/frame'></iframe><iframe src='http://{alternate}/frame'></iframe><canvas></canvas><script>window.__luczorDomV1={{refs:'page-controlled'}};document.getElementById('shadow').attachShadow({{mode:'open'}}).innerHTML='<button onclick=\"this.textContent=String.fromCharCode(68,111,110,101)\">Shadow action</button>';</script><script src='http://{alternate}/asset.js'></script></body></html>"))
                };
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",page.len(),page);
                let _ = socket.write_all(response.as_bytes());
            } else {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    });
    let id = uuid::Uuid::new_v4().to_string();
    let root = std::env::temp_dir().join(format!("luczor-browser-probe-{id}"));
    std::fs::create_dir_all(&root).unwrap();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("de.luczor.browserprobe.{}", id.replace('-', ""));
    context.config_mut().app.windows.clear();
    let (sender, receiver) = mpsc::sync_channel(1);
    let app = tauri::Builder::default()
        .plugin(crate::commands::desktop_control::feedback_plugin())
        .any_thread()
        .setup(move |app| {
            crate::commands::desktop_control::initialize(app.handle());
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External("about:blank".parse().unwrap()),
            )
            .visible(false)
            .inner_size(1100.0, 760.0)
            .build()?;
            let app = app.handle().clone();
            let watchdog = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(45));
                watchdog.exit(2);
            });
            tauri::async_runtime::spawn(async move {
                let result = probe(&app, &root, &host).await;
                let exit_code = if result.is_ok() { 0 } else { 1 };
                match &result {
                    Ok(()) => println!("NATIVE_BROWSER_PROBE_OK: child view, semantic scan/refs, isolated world, open shadow root, frames, cross-domain resources/download, local file, stale-ref refusal, form fill/click/read, navigation, collapse/restore, caller isolation, cleanup"),
                    Err(error) => eprintln!("NATIVE_BROWSER_PROBE_FAILED: {error}"),
                }
                let _ = sender.send(result);
                app.exit(exit_code);
            });
            Ok(())
        })
        .build(context)
        .unwrap();
    app.run(|_, _| {});
    shutdown.store(true, Ordering::Release);
    server.join().unwrap();
    receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("native probe deadline")
        .expect("native browser contract");
}

async fn probe(app: &AppHandle, root: &std::path::Path, host: &str) -> Result<(), String> {
    let identity = uuid::Uuid::new_v4().to_string();
    let policy = json!({"sessionId":identity,"generation":1,"mode":"act","killSwitch":false});
    execution::execution_gate_update(caller(app), serde_json::from_value(policy.clone()).unwrap())
        .await?;
    let workspace = project_workspace::project_workspace_bind(
        caller(app),
        app.clone(),
        serde_json::from_value(json!({"principalId":"probe","projectId":"probe","rootPath":root}))
            .unwrap(),
    )
    .await?;
    let workspace = serde_json::to_value(workspace).unwrap();
    let run = uuid::Uuid::new_v4().to_string();
    let scope = json!({"principalId":"probe","projectId":"probe","expectedRootPath":workspace["rootPath"],"expectedWorkspaceUpdatedAt":workspace["updatedAt"],"runId":run});
    let execution = json!({"sessionId":identity,"generation":1,"workflowExecutionId":run});
    crate::commands::desktop_control_smoke::run(app, execution.clone()).await?;
    let base = json!({"scope":scope,"execution":execution,"automated":true});
    let action = |name: &str, fields: Value| {
        let mut value = base.clone();
        value["action"] = json!(name);
        for (key, item) in fields.as_object().unwrap() {
            value[key] = item.clone();
        }
        serde_json::from_value(value).unwrap()
    };
    let opened = serde_json::to_value(
        workflow_browser::wf_browser_action(
            app.clone(),
            caller(app),
            action("open", json!({"url":format!("http://{host}/first")})),
        )
        .await?,
    )
    .unwrap();
    let browser = app
        .get_webview(BROWSER_WEBVIEW_LABEL)
        .ok_or("probe browser missing")?;
    assert_eq!(
        browser.window().label(),
        "main",
        "browser must be a child of main"
    );
    // The main renderer must remain callable with a second webview attached.
    assert!(browser_panel_status(caller(app), app.clone()).await?["open"] == true);
    let placement = |visible| PanelLayout {
        visible,
        project_id: "probe".into(),
        left: 550.0,
        top: 110.0,
        width: 520.0,
        height: 570.0,
        zoom: 0.5,
    };
    browser_panel_layout(caller(app), app.clone(), placement(true)).await?;
    assert_eq!(
        browser
            .bounds()
            .map_err(|e| e.to_string())?
            .size
            .to_logical::<f64>(1.0)
            .width,
        520.0
    );
    let started = std::time::Instant::now();
    let scan =
        workflow_browser::wf_browser_action(app.clone(), caller(app), action("scan", json!({})))
            .await?;
    assert!(scan.data["elements"]
        .as_array()
        .unwrap()
        .iter()
        .any(|el| el["name"] == "Name"));
    assert!(scan.data["frames"]
        .as_array()
        .unwrap()
        .iter()
        .any(|frame| frame["status"] == "dom_unavailable"));
    let apply_ref = scan.data["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|el| el["name"] == "Apply")
        .unwrap()["ref"]
        .clone();
    let shadow_ref = scan.data["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|el| el["name"] == "Shadow action")
        .unwrap()["ref"]
        .clone();
    workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        action("click", json!({"selector":shadow_ref})),
    )
    .await?;
    let shadow = workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        action("scan", json!({"query":"Done"})),
    )
    .await?;
    assert_eq!(shadow.data["elements"].as_array().unwrap().len(), 1);
    let cross = workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        action("read", json!({"selector":"#cross"})),
    )
    .await?;
    assert_eq!(cross.data["text"], "Cross-domain asset loaded");
    println!(
        "DOM_PROBE_SCAN_AND_SHADOW_MS={}",
        started.elapsed().as_millis()
    );
    workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        action(
            "fill",
            json!({"sessionId":opened["sessionId"],"selector":"label=Name","value":"Luczor probe"}),
        ),
    )
    .await?;
    workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        action(
            "click",
            json!({"sessionId":opened["sessionId"],"selector":apply_ref}),
        ),
    )
    .await?;
    let read = workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        action(
            "read",
            json!({"sessionId":opened["sessionId"],"selector":"#result"}),
        ),
    )
    .await?;
    assert_eq!(
        serde_json::to_value(read).unwrap()["data"]["text"],
        "Luczor probe"
    );
    browser_panel_layout(caller(app), app.clone(), placement(false)).await?;
    assert!(
        app.get_webview(BROWSER_WEBVIEW_LABEL).is_some(),
        "collapse must preserve session"
    );
    browser_panel_layout(caller(app), app.clone(), placement(true)).await?;
    let navigated = workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        action(
            "navigate",
            json!({"sessionId":opened["sessionId"],"url":format!("http://{host}/second")}),
        ),
    )
    .await?;
    assert!(serde_json::to_value(navigated).unwrap()["url"]
        .as_str()
        .unwrap()
        .ends_with("/second"));
    let stale = workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        action("click", json!({"selector":apply_ref})),
    )
    .await;
    assert!(matches!(stale,Err(ref code) if code == "browser_ref_stale"));
    let downloaded = workflow_browser::wf_browser_action(app.clone(),caller(app),action("download",json!({"url":format!("http://{}/asset.js",host.replace("127.0.0.1","localhost")),"name":"cross-domain.js"}))).await?;
    assert!(downloaded.data["bytes"].as_u64().unwrap() > 0);
    let local = root.join("Local ä #1.html");
    std::fs::write(
        &local,
        "<!doctype html><h1>Local file loaded</h1><button>Local action</button>",
    )
    .map_err(|e| e.to_string())?;
    workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        action("navigate", json!({"url":local})),
    )
    .await?;
    let local_scan =
        workflow_browser::wf_browser_action(app.clone(), caller(app), action("scan", json!({})))
            .await?;
    assert!(local_scan.data["elements"]
        .as_array()
        .unwrap()
        .iter()
        .any(|el| el["name"] == "Local action"));
    let file_download = workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        action("download", json!({"url":local,"name":"local.html"})),
    )
    .await?;
    assert!(file_download.data["bytes"].as_u64().unwrap() > 0);
    let foreign = CallerWebview {
        window: browser.window(),
        webview: browser,
    };
    assert!(
        browser_panel_status(foreign, app.clone()).await.is_err(),
        "page cannot use host commands"
    );
    workflow_browser::wf_browser_cleanup(
        app.clone(),
        caller(app),
        serde_json::from_value(scope).unwrap(),
    )
    .await?;
    assert!(app.get_webview(BROWSER_WEBVIEW_LABEL).is_none());
    Ok(())
}
