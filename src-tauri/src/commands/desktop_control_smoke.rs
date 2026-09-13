//! Opt-in integration inside the existing isolated native probe; never drives user windows.
use super::{desktop_control as control, system, CallerWebview};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::{
    Foundation::{HWND, POINT},
    UI::WindowsAndMessaging::*,
};

fn caller(app: &AppHandle) -> CallerWebview {
    let webview = app.get_webview("main").unwrap();
    CallerWebview {
        window: webview.window(),
        webview,
    }
}
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
struct Fixture {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
fn pointer() -> (i32, i32) {
    let mut point = POINT { x: 0, y: 0 };
    assert_ne!(unsafe { GetPhysicalCursorPos(&mut point) }, 0);
    (point.x, point.y)
}

async fn feedback_dom(app: &AppHandle) -> Result<Value, String> {
    let view = app
        .get_webview("desktop-control-feedback")
        .ok_or("feedback missing")?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    view.with_webview(move |view| {
        let complete=sender.clone();
        let handler=webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result,text| {
            let _=complete.try_send(result.map_err(|error|error.to_string()).and_then(|_|serde_json::from_str::<Value>(&text).map_err(|error|error.to_string())));Ok(())
        }));
        let method=webview2_com::CoTaskMemPWSTR::from("Runtime.evaluate");
        let params=webview2_com::CoTaskMemPWSTR::from(r#"{"expression":"({ready:document.readyState,url:location.protocol,html:document.documentElement.outerHTML.slice(0,600),cursor:document.getElementById('pointer')?getComputedStyle(document.getElementById('pointer')).display:null,border:document.body?getComputedStyle(document.body,'::before').borderTopColor:null})","returnByValue":true}"#);
        let result=unsafe {view.controller().CoreWebView2().and_then(|view|view.CallDevToolsProtocolMethod(*method.as_ref().as_pcwstr(),*params.as_ref().as_pcwstr(),&handler))};
        if let Err(error)=result {let _=sender.try_send(Err(error.to_string()));}
    }).map_err(|error|error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "feedback timed out".to_string())?
    })
    .await
    .map_err(|_| "feedback worker failed")?
}
pub(super) async fn run(app: &AppHandle, execution: Value) -> Result<(), String> {
    let monitor = control::monitors()?
        .into_iter()
        .find(|monitor| monitor.primary)
        .ok_or("probe monitor unavailable")?;
    let config = control::DesktopControlConfig {
        monitor: Some(control::MonitorSelection {
            id: monitor.id,
            name: monitor.name.clone(),
        }),
        ..control::config()?
    };
    let stale = config.clone();
    let saved = control::desktop_control_save(caller(app), app.clone(), config)?;
    let stored: control::DesktopControlConfig = serde_json::from_slice(
        &std::fs::read(
            app.path()
                .app_config_dir()
                .unwrap()
                .join("desktop-control.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&stored).unwrap(),
        serde_json::to_value(&saved).unwrap(),
        "native settings must survive a disk read"
    );
    assert!(control::desktop_control_save(caller(app), app.clone(), stale).is_err());
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = stop.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let thread = std::thread::spawn(move || unsafe {
        let root = CreateWindowExW(
            WS_EX_NOACTIVATE,
            wide("STATIC").as_ptr(),
            wide("Luczor isolated input test").as_ptr(),
            WS_OVERLAPPEDWINDOW,
            monitor.x + 40,
            monitor.y + 40,
            440,
            230,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        );
        assert!(!root.is_null());
        let edit = CreateWindowExW(
            0,
            wide("EDIT").as_ptr(),
            wide("").as_ptr(),
            WS_CHILD | WS_VISIBLE | ES_MULTILINE as u32,
            20,
            20,
            350,
            60,
            root,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        );
        let button = CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("Test checkbox").as_ptr(),
            WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX as u32,
            20,
            100,
            200,
            30,
            root,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        );
        ShowWindow(root, SW_SHOWNOACTIVATE);
        let mut rect = std::mem::zeroed();
        GetWindowRect(edit, &mut rect);
        let mut button_rect = std::mem::zeroed();
        GetWindowRect(button, &mut button_rect);
        let _ = sender.send((
            root as usize as u64,
            edit as usize as u64,
            button as usize as u64,
            (rect.left + 10, rect.top + 10),
            (button_rect.left + 10, button_rect.top + 10),
        ));
        while !stopping.load(Ordering::SeqCst) {
            let mut message = std::mem::zeroed();
            while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        DestroyWindow(root);
    });
    let _fixture = Fixture {
        stop,
        thread: Some(thread),
    };
    let (window, edit, button, point, button_point) = receiver
        .recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| "native fixture creation failed")?;
    let observe = || {
        system::desktop_observe(
            caller(app),
            serde_json::from_value(json!({"execution":execution,"windowId":window})).unwrap(),
        )
    };
    let foreground = unsafe { GetForegroundWindow() } as usize;
    let before = pointer();
    let first = match observe().await {
        Ok(first) => first,
        Err(error) => {
            eprintln!("NATIVE_OVERLAY_DIAG: {:?}", feedback_dom(app).await);
            return Err(error);
        }
    };
    system::move_mouse(caller(app),serde_json::from_value(json!({"execution":execution,"observationId":first.observation_id,"x":point.0,"y":point.1})).unwrap()).await?;
    let observed = observe().await?;
    system::type_text(caller(app),serde_json::from_value(json!({"execution":execution,"observationId":observed.observation_id,"text":"Luczor ÄÖü 42"})).unwrap()).await?;
    let mut buffer = [0u16; 128];
    let length = unsafe { GetWindowTextW(edit as usize as HWND, buffer.as_mut_ptr(), 128) };
    assert_eq!(
        String::from_utf16_lossy(&buffer[..length as usize]),
        "Luczor ÄÖü 42"
    );
    let observed = observe().await?;
    system::mouse_click(caller(app),serde_json::from_value(json!({"execution":execution,"observationId":observed.observation_id,"x":button_point.0,"y":button_point.1})).unwrap()).await?;
    assert_eq!(
        unsafe { SendMessageW(button as usize as HWND, BM_GETCHECK, 0, 0) },
        1
    );
    assert_eq!(
        pointer(),
        before,
        "isolated actions must not move the user cursor"
    );
    assert_eq!(
        unsafe { GetForegroundWindow() } as usize,
        foreground,
        "isolated actions must not activate a window"
    );
    let feedback = feedback_dom(app).await?;
    let overlay = app.get_webview_window("desktop-control-feedback").unwrap();
    assert!(overlay.is_visible().unwrap());
    let display = control::selected_monitor()?;
    let origin = overlay.outer_position().unwrap();
    let size = overlay.outer_size().unwrap();
    assert_eq!((origin.x, origin.y), (display.x, display.y));
    assert_eq!((size.width, size.height), (display.width, display.height));
    assert_eq!(feedback["result"]["value"]["ready"], "complete");
    assert_eq!(feedback["result"]["value"]["cursor"], "block");
    assert_eq!(feedback["result"]["value"]["border"], "rgb(57, 140, 255)");
    println!(
        "NATIVE_OVERLAY_OK: loaded document, visible pointer and blue monitor border verified"
    );
    let mut other = execution.clone();
    other["workflowExecutionId"] = json!(uuid::Uuid::new_v4().to_string());
    let observed = system::desktop_observe(
        caller(app),
        serde_json::from_value(json!({"execution":other,"windowId":window})).unwrap(),
    )
    .await?;
    let foreign = system::mouse_click(
        caller(app),
        serde_json::from_value(json!({"execution":other,"observationId":observed.observation_id}))
            .unwrap(),
    )
    .await;
    assert!(foreign.unwrap_err().contains("virtual_pointer_required"));
    let observed = observe().await?;
    let mut saved = control::desktop_control_save(caller(app), app.clone(), saved)?;
    let stale=system::move_mouse(caller(app),serde_json::from_value(json!({"execution":execution,"observationId":observed.observation_id,"x":point.0,"y":point.1})).unwrap()).await;
    assert!(stale.unwrap_err().contains("config_changed"));
    saved.monitor = None;
    control::desktop_control_save(caller(app), app.clone(), saved)?;
    println!("NATIVE_DESKTOP_CONTROL_OK: Unicode input and checkbox verified, foreground/cursor unchanged, cross-run cursor denied, stale revision denied");
    Ok(())
}
