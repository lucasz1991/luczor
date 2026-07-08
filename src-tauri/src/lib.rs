mod commands;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_prevent_default::init())
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
            commands::speech::eleven_stt,
            commands::tts::eleven_tts,
            commands::system::capture_screen,
            commands::system::read_clipboard,
            commands::system::list_windows,
            commands::system::move_mouse,
            commands::system::mouse_click,
            commands::system::type_text,
            commands::system::press_key,
            commands::system::open_path,
            commands::system::run_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
            "quit" => app.exit(0),
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
