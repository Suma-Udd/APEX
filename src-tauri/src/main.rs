#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};
use std::io::Write;
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};

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

/// The app isn't notarized by Apple (that needs a paid developer account), so a
/// downloaded copy carries macOS's quarantine flag. Once the user has allowed APEX
/// to open, clear the flag on the whole bundle so the backend inside it can start too.
#[cfg(target_os = "macos")]
fn clear_quarantine() {
    if let Ok(exe) = std::env::current_exe() {
        // .../APEX.app/Contents/MacOS/apex -> .../APEX.app
        if let Some(bundle) = exe.ancestors().nth(3) {
            if bundle.extension().map_or(false, |e| e == "app") {
                let _ = std::process::Command::new("/usr/bin/xattr")
                    .args(["-dr", "com.apple.quarantine"])
                    .arg(bundle)
                    .status();
            }
        }
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
            #[cfg(target_os = "macos")]
            clear_quarantine();

            let data_dir = app.path().data_dir()?.join("APEX");
            std::fs::create_dir_all(&data_dir)?;

            let logs = data_dir.join("logs");
            std::fs::create_dir_all(&logs)?;
            let log_path = logs.join("backend-output.log");

            let (mut rx, child) = app
                .shell()
                .sidecar("apex-backend")?
                .args(["--port", &port.to_string()])
                .env("APEX_TOKEN", &token)
                .env("APEX_DATA", data_dir.to_string_lossy().to_string())
                .spawn()?;

            // Keep whatever the backend prints, so a crash on startup is never silent.
            tauri::async_runtime::spawn(async move {
                let mut file = std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(&log_path).ok();
                while let Some(event) = rx.recv().await {
                    let line = match event {
                        CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => String::from_utf8_lossy(&b).trim_end().to_string(),
                        CommandEvent::Error(e) => format!("[apex] backend error: {e}"),
                        CommandEvent::Terminated(t) => format!("[apex] backend exited: code {:?}, signal {:?}", t.code, t.signal),
                        _ => continue,
                    };
                    if let Some(f) = file.as_mut() {
                        let _ = writeln!(f, "{line}");
                    }
                }
            });

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
