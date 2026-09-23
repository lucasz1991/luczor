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
    native_probe(false, false);
}

#[test]
#[ignore = "Creates an isolated hidden native research/WebView2 session; run explicitly with --test-threads=1"]
fn native_research_smoke() {
    native_probe(true, false);
}

#[test]
#[ignore = "Reads/downloads the public Python robots.txt with native TLS; run explicitly"]
fn native_research_live_smoke() {
    native_probe(true, true);
}

fn native_probe(research_only: bool, live_public: bool) {
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
                let result = probe(&app, &root, &host, research_only, live_public).await;
                let exit_code = if result.is_ok() { 0 } else { 1 };
                match &result {
                    Ok(()) if research_only => println!("NATIVE_RESEARCH_SESSION_OK: isolated native research acceptance completed"),
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

async fn probe(
    app: &AppHandle,
    root: &std::path::Path,
    host: &str,
    research_only: bool,
    live_public: bool,
) -> Result<(), String> {
    let identity = uuid::Uuid::new_v4().to_string();
    let policy = json!({"sessionId":identity,"generation":1,"mode":"act","killSwitch":false});
    execution::execution_gate_update(caller(app), serde_json::from_value(policy.clone()).unwrap())
        .await?;
    if research_only {
        return research_probe(app, root, host, &identity, live_public).await;
    }
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
    research_probe(app, root, host, &identity, false).await?;
    Ok(())
}

/// A free chat has no project-workspace row. Its approved output owns all research artifacts.
async fn research_probe(
    app: &AppHandle,
    root: &std::path::Path,
    host: &str,
    session: &str,
    live_public: bool,
) -> Result<(), String> {
    use crate::commands::{research, workflow_image};
    let run = uuid::Uuid::new_v4().to_string();
    let scope = json!({"projectId":"free-chat-space","conversationId":"free-chat","runId":run});
    execution::execution_scope_register(
        caller(app),
        serde_json::from_value(json!({
            "sessionId":session,"generation":1,"scope":scope,"scopeGeneration":1,"mode":"act"
        }))
        .unwrap(),
    )?;
    let permit = json!({"sessionId":session,"generation":1,"scope":scope,"scopeGeneration":1});
    let mut prepare = json!({"principalId":"probe","projectId":"free-chat-space","chatId":"free-chat",
        "runId":run,"target":"central","centralRoot":root.join("research-output"),"slug":"native-proof","title":"Native proof","execution":permit});
    let preview = research::research_preview(
        app.clone(),
        caller(app),
        serde_json::from_value(prepare.clone()).unwrap(),
    )
    .await?;
    assert!(
        !std::path::Path::new(&preview.root_path).exists(),
        "preview is read-only"
    );
    prepare["expectedRootPath"] = json!(preview.root_path);
    let binding = research::research_prepare(
        app.clone(),
        caller(app),
        serde_json::from_value(prepare.clone()).unwrap(),
    )
    .await?;
    let write = research::research_write(app.clone(), caller(app), serde_json::from_value(json!({"runId":run,"path":"bericht.md","content":"# Native proof\n","execution":permit})).unwrap()).await?;
    let write = serde_json::to_value(write).unwrap();
    let verified = research::research_verify(app.clone(), caller(app), serde_json::from_value(json!({"runId":run,"files":[{"path":"bericht.md","sha256":write["sha256"]}],"execution":permit})).unwrap()).await?;
    assert_eq!(verified["ok"], true);
    let mut other = permit.clone();
    other["scope"]["conversationId"] = json!("foreign-chat");
    assert!(research::research_read(
        app.clone(),
        caller(app),
        serde_json::from_value(json!({"runId":run,"path":"bericht.md","execution":other})).unwrap()
    )
    .await
    .is_err());
    let mut browser_permit = permit.clone();
    browser_permit["workflowExecutionId"] = json!(run);
    let terminal = crate::commands::local_tasks::wf_run_script(app.clone(), caller(app), serde_json::from_value(json!({
        "scope":binding.workflow_scope,"execution":browser_permit,"runtime":"node",
        "code":"process.stdout.write(JSON.stringify({cwd:process.cwd(),message:'research-native-proof'}))",
        "timeout_seconds":20,"fullAccessAcknowledged":true
    })).unwrap()).await?;
    assert!(terminal.ok);
    let terminal_output: Value =
        serde_json::from_str(&terminal.stdout).map_err(|_| "probe_terminal_invalid")?;
    assert_eq!(
        std::path::Path::new(terminal_output["cwd"].as_str().unwrap()),
        std::path::Path::new(&binding.root_path)
    );
    assert_eq!(terminal_output["message"], "research-native-proof");
    let action = |name: &str, extra: Value| {
        let mut request = json!({"scope":binding.workflow_scope,"execution":browser_permit,"action":name,"automated":true});
        for (key, value) in extra.as_object().unwrap() {
            request[key] = value.clone();
        }
        serde_json::from_value(request).unwrap()
    };
    let source_url = if live_public {
        "https://www.python.org/robots.txt".to_string()
    } else {
        let fixture = root.join("research-fixture.html");
        std::fs::write(&fixture,"<!doctype html><title>Research fixture</title><main>Research source text with enough characters for multiple bounded evidence chunks. Unicode: ä 😀.</main>").map_err(|_|"probe_fixture_write_failed")?;
        tauri::Url::from_file_path(fixture)
            .map_err(|_| "probe_fixture_url_invalid")?
            .to_string()
    };
    eprintln!("NATIVE_RESEARCH_STAGE: browser open");
    workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        action("open", json!({"url":source_url,"timeoutMs":30000})),
    )
    .await?;
    eprintln!("NATIVE_RESEARCH_STAGE: source chunks");
    let first = workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        action("read", json!({"maxChars":10})),
    )
    .await?;
    assert_eq!(first.data["offset"], 0);
    assert!(first.data["nextOffset"].as_u64().unwrap() > 0);
    assert_eq!(first.data["contentSha256"].as_str().unwrap().len(), 64);
    let second = workflow_browser::wf_browser_action(
        app.clone(),
        caller(app),
        action(
            "read",
            json!({"offset":first.data["nextOffset"],"maxChars":10}),
        ),
    )
    .await?;
    assert_eq!(first.data["snapshotId"], second.data["snapshotId"]);
    if live_public {
        let downloaded=workflow_browser::wf_browser_action(app.clone(),caller(app),action("download",json!({"url":"https://www.python.org/robots.txt","name":"python-robots.txt","timeoutMs":30000}))).await?;
        let downloaded_id = downloaded.data["artifactId"]
            .as_str()
            .ok_or("probe_download_missing")?;
        let exported=research::research_export_artifact(app.clone(),caller(app),serde_json::from_value(json!({"runId":run,"artifactId":downloaded_id,"path":"downloads/python-robots.txt","execution":permit})).unwrap()).await?;
        assert_eq!(downloaded.data["sha256"], exported["sha256"]);
        assert!(downloaded.data["sourceUrl"]
            .as_str()
            .unwrap()
            .starts_with("https://www.python.org/"));
        assert!(downloaded.data["retrievedAt"].as_u64().unwrap() > 0);
        let text = research::research_read(
            app.clone(),
            caller(app),
            serde_json::from_value(
                json!({"runId":run,"path":"downloads/python-robots.txt","execution":permit}),
            )
            .unwrap(),
        )
        .await?;
        let text = serde_json::to_value(text).unwrap();
        assert!(text["content"].as_str().unwrap().contains("User-agent"));
        println!("NATIVE_RESEARCH_LIVE_WEB_OK: Python public robots.txt read and native HTTPS download/export/hash verified");
    }
    assert!(
        workflow_browser::wf_browser_action(
            app.clone(),
            caller(app),
            action("download", json!({"url":format!("http://{host}/asset.js")}))
        )
        .await
        .is_err(),
        "automatic research downloads reject loopback"
    );
    eprintln!("NATIVE_RESEARCH_STAGE: shared artifacts");
    // Hidden WebView2 views cannot reliably capture a rendered screenshot. The
    // owned artifact/image handoff is exercised with a native PNG fixture; real
    // visible screenshot capture remains a separate installed-client check.
    use image::ImageEncoder;
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[1, 2, 3, 255], 1, 1, image::ExtendedColorType::Rgba8)
        .map_err(|_| "probe_png_failed")?;
    let artifact = serde_json::to_value(crate::commands::workflow_artifacts::store(
        app,
        &binding.workflow_scope,
        &png,
        "image/png",
        "source.png",
        &|| binding.workflow_scope.check(app),
    )?)
    .map_err(|_| "probe_artifact_invalid")?;
    let id = artifact["artifactId"]
        .as_str()
        .ok_or("probe_screenshot_artifact_missing")?;
    let compared = workflow_image::wf_image_action(app.clone(), caller(app), serde_json::from_value(json!({
        "scope":binding.workflow_scope,"execution":browser_permit,"action":"compare","artifactId":id,"otherArtifactId":id
    })).unwrap()).await?;
    assert!(
        compared.is_object(),
        "browser and image use the same artifact owner"
    );
    let exported = research::research_export_artifact(
        app.clone(),
        caller(app),
        serde_json::from_value(
            json!({"runId":run,"artifactId":id,"path":"downloads/source.png","execution":permit}),
        )
        .unwrap(),
    )
    .await?;
    assert_eq!(exported["sha256"], artifact["sha256"]);
    let foreign = app.get_webview(BROWSER_WEBVIEW_LABEL).unwrap();
    assert!(research::research_write(
        app.clone(),
        CallerWebview {
            window: foreign.window(),
            webview: foreign
        },
        serde_json::from_value(
            json!({"runId":run,"path":"forbidden.md","content":"bad","execution":permit})
        )
        .unwrap()
    )
    .await
    .is_err());
    workflow_browser::wf_browser_cleanup(app.clone(), caller(app), binding.workflow_scope.clone())
        .await?;
    research::research_release(
        caller(app),
        serde_json::from_value(json!({"runId":run,"execution":permit})).unwrap(),
    )
    .await?;
    assert!(research::research_read(
        app.clone(),
        caller(app),
        serde_json::from_value(json!({"runId":run,"path":"bericht.md","execution":permit}))
            .unwrap()
    )
    .await
    .is_err());
    // Simulate a stopped first preparation after its owner marker but before its
    // private registry write; the exact marker can restore this owned binding.
    use sha2::{Digest, Sha256};
    let record = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "probe_store_missing")?
        .join("research-bindings")
        .join(format!(
            "{:x}.json",
            Sha256::digest(format!("probe\0{run}").as_bytes())
        ));
    std::fs::remove_file(record).map_err(|_| "probe_registry_remove_failed")?;
    prepare["resume"] = json!(true);
    let resumed = research::research_prepare(
        app.clone(),
        caller(app),
        serde_json::from_value(prepare).unwrap(),
    )
    .await?;
    assert_eq!(resumed, binding);
    let restored = research::research_read_artifact(
        app.clone(),
        caller(app),
        serde_json::from_value(json!({"runId":run,"artifactId":id,"execution":permit})).unwrap(),
    )
    .await?;
    assert_eq!(restored["artifact"]["sha256"], artifact["sha256"]);
    execution::execution_scope_revoke(
        caller(app),
        serde_json::from_value(
            json!({"sessionId":session,"generation":1,"scope":scope,"scopeGeneration":1}),
        )
        .unwrap(),
    )?;
    assert!(research::research_write(
        app.clone(),
        caller(app),
        serde_json::from_value(
            json!({"runId":run,"path":"late.md","content":"late","execution":permit})
        )
        .unwrap()
    )
    .await
    .is_err());
    research::research_release(
        caller(app),
        serde_json::from_value(json!({"runId":run,"execution":permit})).unwrap(),
    )
    .await?;
    println!("NATIVE_RESEARCH_PROBE_OK: free-chat output, preview, CAS/report/hash, wrong-owner refusal, source chunks, scoped Node cwd/output, shared browser/image scope, binary export, remote-view isolation, release/resume and revoked-write refusal");
    Ok(())
}
