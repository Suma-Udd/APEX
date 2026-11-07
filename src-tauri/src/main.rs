#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct Backend {
    port: u16,
    token: String,
    child: Mutex<Option<CommandChild>>,
}

#[tauri::command]
fn backend_info(state: State<Backend>) -> (u16, String) {
    (state.port, state.token.clone())
}

/// Called right before an update installs. On Windows the installer can't
/// replace apex-backend.exe while it is running, so stop it first.
#[tauri::command]
fn stop_backend(state: State<Backend>) {
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
}

fn main() {
    // Free local port and a random per-launch token. Only this app knows the token.
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let token = uuid::Uuid::new_v4().to_string();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![backend_info, stop_backend])
        .setup(move |app| {
            // macOS: ~/Library/Application Support/APEX (same place older builds used).
            // Windows: %APPDATA%\APEX. Linux: ~/.local/share/APEX.
            let data_dir = app.path().data_dir()?.join("APEX");
            std::fs::create_dir_all(&data_dir)?;

            let (_rx, child) = app
                .shell()
                .sidecar("apex-backend")?
                .args(["--port", &port.to_string()])
                .env("APEX_TOKEN", &token)
                .env("APEX_DATA", data_dir.to_string_lossy().to_string())
                .spawn()?;

            app.manage(Backend { port, token: token.clone(), child: Mutex::new(Some(child)) });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building APEX");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(b) = handle.try_state::<Backend>() {
                if let Some(child) = b.child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
