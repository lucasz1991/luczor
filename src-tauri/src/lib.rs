mod commands;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
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
            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            #[cfg(desktop)]
            setup_tray(app)?;

            #[cfg(desktop)]
            setup_global_shortcut(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::system::capture_screen,
            commands::system::read_clipboard,
            commands::system::list_windows,
            commands::system::system_metrics,
            commands::system::move_mouse,
            commands::system::mouse_click,
            commands::system::type_text,
            commands::system::press_key,
            commands::system::scroll,
            commands::system::hotkey,
            commands::system::open_url,
            commands::voice::local_stt,
            commands::voice::local_stt_rs,
            commands::voice::local_tts,
            commands::voice::voice_runtime_status,
            commands::voice::install_voice_runtime,
            commands::device_jobs::verify_device_job,
            commands::agent::agent_cli_detect,
            commands::agent::agent_cli_run,
            commands::agent::agent_write_bridge,
            commands::local_tasks::wf_file_read,
            commands::local_tasks::wf_file_write,
            commands::local_tasks::wf_run_script,
            commands::workflow_http::wf_http_request,
            commands::notifications::show_native_notification,
            commands::browser::browser_open,
            commands::browser::browser_navigate,
            commands::browser::browser_close,
            commands::browser::browser_click,
            commands::browser::browser_read,
            commands::browser::browser_report,
            commands::device_key::device_key_get,
            commands::device_key::device_key_set,
            commands::device_key::device_key_delete,
            commands::device_key::memory_key_get_or_create,
            commands::repository_graph::local_graph_bind,
            commands::repository_graph::local_graph_index,
            commands::repository_graph::local_graph_status,
            commands::repository_graph::local_graph_search,
            commands::repository_graph::local_graph_read_snippets,
            commands::repository_graph::local_graph_unbind,
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
            commands::local_model::local_model_prepare,
            commands::local_model::local_model_infer,
            commands::local_model::local_model_cancel,
            commands::local_model::local_model_stop,
        ])
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if window.label() == "main" {
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
            commands::local_model::shutdown_all();
        }
    });
}

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "Luczor anzeigen", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Luczor")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => {
                commands::local_model::shutdown_all();
                app.exit(0);
            }
            "show" => {
                if let Some(win) = app.get_webview_window("main") {
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
        if let Some(win) = handle.get_webview_window("main") {
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
