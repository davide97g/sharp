// sharp desktop shell — a thin Tauri 2 wrapper around the web app.
//
// The frontend is the built web SPA (`web/dist`). At login the user enters their
// server URL (persisted in localStorage), since `VITE_API_URL` is left unset for
// desktop builds. Plugins are registered so the web frontend can use them via the
// JS API when running inside Tauri:
//   - tauri-plugin-notification: new-message notifications when the window is unfocused
//   - tauri-plugin-shell:        opening external links / browser login in the system browser
//   - tauri-plugin-deep-link:    receiving the `sharp://auth?...` browser-login callback

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // On Windows/Linux the OS launches a fresh process for a `sharp://` deep
    // link; single-instance forwards its argv (the URL) to the running app so
    // the deep-link plugin's `on_open_url` fires there. macOS delivers the URL
    // to the running instance natively, so this isn't needed (or built) there.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}));
    }

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|_app| {
            // Register the `sharp://` scheme at runtime for dev on Linux/Windows
            // (bundled macOS registers it via the generated Info.plist).
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = _app.deep_link().register("sharp");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running sharp desktop application");
}
