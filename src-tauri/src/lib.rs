mod commands;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // Register first: the recovery ledger has one process-wide writer.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    let app = builder
        .plugin(commands::desktop_control::feedback_plugin())
        .on_page_load(|webview, payload| {
            commands::local_model::resource_config::on_main_navigation(
                webview.label(),
                matches!(payload.event(), tauri::webview::PageLoadEvent::Started),
            );
        })
        .manage(commands::mini_chat::MiniChatState::default())
        .manage(commands::codex::CodexJobs::default())
        .manage(commands::claude::ClaudeJobs::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_prevent_default::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            commands::desktop_control::initialize(app.handle());
            commands::device_jobs::initialize_trust(app.handle());
            #[cfg(debug_assertions)]
            {
                if let Some(view) = app.get_webview("main") {
                    view.open_devtools();
                }
            }

            #[cfg(desktop)]
            setup_tray(app)?;

            #[cfg(desktop)]
            setup_global_shortcut(app)?;
            setup_worker_tick(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_quit_commit,
            commands::execution::execution_gate_update,
            commands::execution::execution_scope_register,
            commands::execution::execution_scope_revoke,
            commands::device_run_journal::device_run_journal_read,
            commands::device_run_journal::device_run_journal_list,
            commands::device_run_journal::device_run_journal_transition,
            commands::execution::wf_execution_cancel,
            commands::workflow_watch::wf_watch_start,
            commands::workflow_watch::wf_watch_stop,
            commands::workflow_watch::wf_watch_drain,
            commands::workflow_watch::wf_watch_ack,
            commands::desktop_accessibility::desktop_adapter_status,
            commands::desktop_accessibility::desktop_portal_setup,
            commands::desktop_accessibility::desktop_portal_close,
            commands::desktop_accessibility::desktop_accessibility_observe,
            commands::desktop_accessibility::desktop_accessibility_action,
            commands::system::desktop_observe,
            commands::desktop_control::desktop_control_status,
            commands::desktop_control::desktop_control_save,
            commands::desktop_control::desktop_control_preview,
            commands::codex::codex_job_list,
            commands::codex::codex_session_list,
            commands::mini_chat::mini_chat_open,
            commands::mini_chat::mini_chat_action,
            commands::mini_chat::mini_chat_publish,
            commands::mini_chat::mini_chat_snapshot,
            commands::mini_chat::mini_chat_drag,
            commands::mini_chat::mini_chat_drag_by,
            commands::mini_chat::mini_chat_snap,
            commands::mini_chat::mini_chat_window,
            commands::system_status_window::system_status_window_open,
            commands::system_status_window::system_status_window_set_mode,
            commands::system_status_window::system_status_window_close,
            commands::system_status_window::system_status_open_memory,
            commands::system::capture_screen,
            commands::system::read_clipboard,
            commands::system::list_windows,
            commands::system::list_monitors,
            commands::system_status_controller::system_metrics,
            commands::system::system_diagnostics,
            commands::system::move_mouse,
            commands::system::mouse_click,
            commands::system::type_text,
            commands::system::press_key,
            commands::system::scroll,
            commands::system::hotkey,
            commands::system::open_url,
            commands::system::open_user_link,
            commands::voice::local_stt,
            commands::voice::local_stt_rs,
            commands::voice::local_tts,
            commands::voice::voice_runtime_status,
            commands::voice_input::voice_input_store,
            commands::voice_input::voice_input_claim,
            commands::voice_input::voice_input_status,
            commands::voice_input::voice_input_stt,
            commands::voice::install_voice_runtime,
            commands::lan_peer::lan_peer_identity,
            commands::lan_peer::lan_peer_start,
            commands::lan_peer::lan_peer_stop,
            commands::lan_peer::lan_peer_status,
            commands::lan_peer::lan_peer_send,
            commands::lan_peer::lan_peer_drain,
            commands::lan_peer::lan_peer_ack,
            commands::lan_peer::lan_peer_flush,
            commands::device_jobs::verify_device_job,
            commands::agent::agent_cli_detect,
            commands::codex::codex_runtime_status,
            commands::codex::codex_desktop_open,
            commands::codex::codex_job_start,
            commands::agent_effort::codex_model_capabilities,
            commands::agent_effort::agent_default_model_resolve,
            commands::claude::claude_runtime_status,
            commands::claude::claude_job_start,
            commands::claude::claude_job_status,
            commands::claude::claude_job_cancel,
            commands::codex::codex_job_status,
            commands::codex::codex_job_cancel,
            commands::agent::agent_cli_run,
            commands::agent::agent_write_bridge,
            commands::local_tasks::wf_scoped_file_read,
            commands::local_tasks::wf_scoped_file_write,
            commands::local_tasks::wf_file_read,
            commands::local_tasks::wf_file_write,
            commands::local_tasks::wf_run_script,
            commands::local_tasks::wf_runtime_capabilities,
            commands::workflow_http::wf_http_request,
            commands::notifications::show_native_notification,
            commands::browser_panel::browser_panel_layout,
            commands::browser_panel::browser_panel_status,
            commands::browser::browser_open,
            commands::browser::browser_navigate,
            commands::browser::browser_close,
            commands::browser::browser_click,
            commands::browser::browser_read,
            commands::browser::browser_report,
            commands::browser::browser_action_admit,
            commands::device_key::device_key_get,
            commands::device_key::device_key_set,
            commands::device_key::device_key_delete,
            commands::device_key::memory_key_get_or_create,
            commands::repository_graph::local_graph_bind,
            commands::repository_graph::local_graph_index,
            commands::repository_graph::local_graph_cancel_index,
            commands::repository_graph::local_graph_status,
            commands::repository_graph::local_graph_inspect,
            commands::repository_graph::local_graph_search,
            commands::repository_graph::local_graph_read_snippets,
            commands::repository_graph::local_graph_unbind,
            commands::project_mirror::project_mirror_stage_begin,
            commands::project_mirror::project_mirror_stage_page,
            commands::project_mirror::project_mirror_stage_commit,
            commands::project_mirror::project_mirror_recover,
            commands::project_mirror::project_mirror_test_workspace,
            commands::project_mirror::project_mirror_scan,
            commands::project_mirror::project_mirror_scan_page,
            commands::project_mirror::project_mirror_chunk_read,
            commands::project_mirror::project_mirror_chunk_put,
            commands::project_mirror::project_mirror_materialize,
            commands::project_mirror::project_mirror_watch_start,
            commands::project_mirror::project_mirror_watch_stop,
            commands::project_workspace::project_workspace_bind,
            commands::project_workspace::project_workspace_get,
            commands::project_workspace::project_workspace_unbind,
            commands::project_workspace::project_fs_list,
            commands::project_workspace::project_fs_stat,
            commands::project_workspace::project_fs_read,
            commands::project_workspace::project_fs_search,
            commands::project_workspace::project_fs_write,
            commands::project_workspace::project_fs_create_dir,
            commands::project_workspace::project_fs_move,
            commands::project_workspace::project_fs_delete,
            commands::local_model::local_model_register_manifest_session,
            commands::local_model::local_model_begin_manifest_acceptance,
            commands::local_model::local_model_verify_manifest,
            commands::local_model::local_model_status,
            commands::local_model::local_model_hardware_snapshot,
            commands::local_model::local_model_recover_memory,
            commands::local_model::local_model_prepare,
            commands::local_model::local_model_infer,
            commands::local_model::local_model_reasoning_control,
            commands::workflow_browser::wf_browser_action,
            commands::workflow_browser::wf_browser_cleanup,
            commands::workflow_image::wf_image_action,
            commands::local_model::local_model_cancel,
            commands::local_model::local_model_stop,
            commands::local_model::resource_config::local_model_get_resource_config,
            commands::local_model::resource_config::local_model_resource_system_check,
            commands::local_model::resource_config::local_model_set_resource_config,
            commands::local_model::resource_config::local_model_apply_resource_config,
            commands::local_model::resource_config::local_model_begin_resource_work,
            commands::local_model::resource_config::local_model_end_resource_work,
        ])
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if window.label() == "main" || window.label() == commands::mini_chat::MINI_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|_app, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            WORKER_TICK_STOP.store(true, std::sync::atomic::Ordering::Release);
            commands::local_model::shutdown_all();
            _app.state::<commands::codex::CodexJobs>().cancel_all();
            _app.state::<commands::claude::ClaudeJobs>().cancel_all();
        }
    });
}

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "Luczor anzeigen", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
    let mini = MenuItem::with_id(app, "mini", "Luczor Mini anzeigen", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &mini, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Luczor")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "mini" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = commands::mini_chat::show(handle).await {
                        eprintln!("[luczor] Mini-Fenster konnte nicht geöffnet werden: {error}");
                    }
                });
            }
            "quit" => {
                request_app_quit(app.clone());
            }
            "show" => {
                if let Some(win) = app.get_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

#[cfg(desktop)]
fn setup_global_shortcut(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Emitter;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let handle = app.handle().clone();
    let gs = app.global_shortcut();

    // Clear any stale registration this process may hold, then register.
    let _ = gs.unregister_all();

    // Best-effort: if the combo is already taken by another app, DO NOT crash
    // startup — just log and continue without the hotkey.
    let result = gs.on_shortcut("CmdOrCtrl+Alt+Space", move |_app, _shortcut, event| {
        if event.state() != ShortcutState::Pressed {
            return;
        }
        if let Some(win) = handle.get_window("main") {
            let visible = win.is_visible().unwrap_or(true);
            if !visible {
                let _ = win.show();
            }
            let _ = win.set_focus();
            // Notify the frontend to toggle push-to-talk.
            let _ = win.emit("luczor://hotkey", "ptt");
        }
    });

    if let Err(e) = result {
        eprintln!(
            "[luczor] Global-Hotkey (Strg+Alt+Space) konnte nicht registriert werden: {e}. \
             App startet ohne Hotkey."
        );
    }

    Ok(())
}

// Native timing is independent of background WebView timer throttling.
static WORKER_TICK_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static QUIT_REQUEST: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuitCommit {
    request_id: String,
}
#[tauri::command]
fn app_quit_commit(
    app: tauri::AppHandle,
    window: commands::CallerWebview,
    payload: QuitCommit,
) -> Result<(), String> {
    commands::ensure_main_webview(&window)?;
    finish_app_quit(&app, &payload.request_id)
}
fn finish_app_quit(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let mut pending = QUIT_REQUEST
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "app_quit_unavailable")?;
    if pending.as_deref() != Some(id) {
        return Err("app_quit_request_changed".into());
    }
    *pending = None;
    drop(pending);
    WORKER_TICK_STOP.store(true, std::sync::atomic::Ordering::Release);
    app.state::<commands::codex::CodexJobs>().cancel_all();
    app.state::<commands::claude::ClaudeJobs>().cancel_all();
    commands::local_model::shutdown_all();
    app.exit(0);
    Ok(())
}
fn request_app_quit(app: tauri::AppHandle) {
    use tauri::Emitter;
    let Ok(mut pending) = QUIT_REQUEST.get_or_init(Default::default).lock() else {
        return;
    };
    if pending.is_some() {
        return;
    }
    let id = uuid::Uuid::new_v4().to_string();
    *pending = Some(id.clone());
    drop(pending);
    // Every journal transition is already FULL-synchronous. This bounded grace
    // period lets the renderer release authority and persist public checkpoints.
    let _ = app.emit_to(
        "main",
        "luczor://app-quit-request",
        serde_json::json!({"requestId":id}),
    );
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(10));
        let _ = finish_app_quit(&app, &id);
    });
}
fn setup_worker_tick(app: tauri::AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        let mut ticks = 0_u8;
        while !WORKER_TICK_STOP.load(std::sync::atomic::Ordering::Acquire) {
            std::thread::sleep(std::time::Duration::from_secs(1));
            ticks += 1;
            if ticks == 10 {
                ticks = 0;
                if !WORKER_TICK_STOP.load(std::sync::atomic::Ordering::Acquire) {
                    let _ = app.emit_to("main", "luczor://worker-tick", ());
                }
            }
        }
    });
}
