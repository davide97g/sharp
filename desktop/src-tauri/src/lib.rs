// sharp desktop shell — a thin Tauri 2 wrapper around the web app.
//
// The frontend is the built web SPA (`web/dist`). At login the user enters their
// server URL (persisted in localStorage), since `VITE_API_URL` is left unset for
// desktop builds. Two plugins are registered so the web frontend can use them via
// the JS API when running inside Tauri:
//   - tauri-plugin-notification: new-message notifications when the window is unfocused
//   - tauri-plugin-shell:        opening external links in the system browser

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running sharp desktop application");
}
