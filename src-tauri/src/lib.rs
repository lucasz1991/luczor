mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
tauri::Builder::default()
    .setup(|_app| {
        #[cfg(debug_assertions)]
        {
            let window = tauri::Manager::get_webview_window(_app, "main").unwrap();
            window.open_devtools();
        }
        Ok(())
    })
    .invoke_handler(tauri::generate_handler![
        commands::speech::speech_transcribe,
        commands::speech_tts::speech_tts
    ])
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_prevent_default::init())
    .plugin(tauri_plugin_store::Builder::default().build())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
