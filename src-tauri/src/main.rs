#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! APEX desktop shell.
//!
//! Owns the Python backend (a PyInstaller sidecar) from start to finish:
//! - starts it on a free local port with a per-launch token,
//! - waits until it answers, and tells the UI exactly what went wrong if it doesn't,
//! - forwards every API call from the UI to it (the webview never talks HTTP itself,
//!   which avoids macOS WebKit blocking http://127.0.0.1 from the tauri:// page),
//! - kills the whole process tree on quit and before an update installs.
//!
//! PyInstaller's one-file build runs as TWO processes (a small launcher plus the real
//! Python process). Killing only the launcher used to leave the real one running, which
//! locked apex-backend.exe and broke the Windows updater. The sidecar now lives in its
//! own job object (Windows) / process group (macOS, Linux), so a kill takes both.

use std::collections::VecDeque;
use std::io::Write;
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::{Update, UpdaterExt};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
const LOG_LINES: usize = 40;

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Starting,
    Ready,
    Failed,
}

struct Inner {
    phase: Phase,
    message: String,
    child: Option<CommandChild>,
    /// Bumped on every (re)start so events from an old process are ignored.
    generation: u64,
    tail: VecDeque<String>,
}

struct Backend {
    port: u16,
    token: String,
    data_dir: std::path::PathBuf,
    http: reqwest::Client,
    inner: Arc<Mutex<Inner>>,
}

#[derive(Serialize)]
struct Status {
    phase: Phase,
    message: String,
    log: Vec<String>,
    data_dir: String,
}

#[derive(Serialize)]
struct ApiReply {
    status: u16,
    body: String,
}

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    notes: String,
}

#[derive(Default)]
struct PendingUpdate(Mutex<Option<Update>>);

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(8799)
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

fn spawn_backend(app: &AppHandle) {
    let backend = app.state::<Backend>();
    let generation = {
        let mut inner = backend.inner.lock().unwrap();
        if let Some(old) = inner.child.take() {
            let _ = old.kill();
        }
        inner.generation += 1;
        inner.phase = Phase::Starting;
        inner.message = "Starting the trading engine".into();
        inner.tail.clear();
        inner.generation
    };

    let logs = backend.data_dir.join("logs");
    let _ = std::fs::create_dir_all(&logs);
    let log_path = logs.join("backend-output.log");

    let command = match app.shell().sidecar("apex-backend") {
        Ok(c) => c,
        Err(e) => return fail(&backend.inner, generation, format!("The backend is missing from this install ({e}). Reinstall APEX.")),
    };
    let spawned = command
        .args(["--port", &backend.port.to_string(), "--parent-pid", &std::process::id().to_string()])
        .env("APEX_TOKEN", &backend.token)
        .env("APEX_DATA", backend.data_dir.to_string_lossy().to_string())
        .env("PYTHONUNBUFFERED", "1")
        .set_process_group(true)
        .spawn();
    let (mut rx, child) = match spawned {
        Ok(x) => x,
        Err(e) => return fail(&backend.inner, generation, format!("Couldn't start the backend: {e}")),
    };
    backend.inner.lock().unwrap().child = Some(child);

    // Keep what the backend prints, in a file and in memory for the error screen.
    let inner = backend.inner.clone();
    tauri::async_runtime::spawn(async move {
        let mut file = std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(&log_path).ok();
        while let Some(event) = rx.recv().await {
            let (line, ended) = match event {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => (String::from_utf8_lossy(&b).trim_end().to_string(), false),
                CommandEvent::Error(e) => (format!("[apex] backend error: {e}"), false),
                CommandEvent::Terminated(t) => (format!("[apex] backend exited (code {:?}, signal {:?})", t.code, t.signal), true),
                _ => continue,
            };
            if let Some(f) = file.as_mut() {
                let _ = writeln!(f, "{line}");
            }
            let mut g = inner.lock().unwrap();
            if g.generation != generation {
                return;
            }
            if !line.is_empty() {
                g.tail.push_back(line);
                while g.tail.len() > LOG_LINES {
                    g.tail.pop_front();
                }
            }
            if ended {
                g.child = None;
                g.phase = Phase::Failed;
                g.message = "The trading engine stopped unexpectedly.".into();
                return;
            }
        }
    });

    // Wait for /api/health. First launch can be slow: the one-file backend unpacks
    // itself and Defender / Gatekeeper scan it.
    let http = backend.http.clone();
    let url = format!("http://127.0.0.1:{}/api/health", backend.port);
    let token = backend.token.clone();
    let inner = backend.inner.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        loop {
            {
                let g = inner.lock().unwrap();
                if g.generation != generation || g.phase != Phase::Starting {
                    return;
                }
            }
            let ok = http
                .get(&url)
                .header("X-APEX-Token", &token)
                .timeout(Duration::from_secs(2))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            if ok {
                let mut g = inner.lock().unwrap();
                if g.generation == generation {
                    g.phase = Phase::Ready;
                    g.message.clear();
                }
                return;
            }
            if started.elapsed() > STARTUP_TIMEOUT {
                fail(&inner, generation, "The trading engine didn't answer within 90 seconds.".into());
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });
}

fn fail(inner: &Arc<Mutex<Inner>>, generation: u64, message: String) {
    let mut g = inner.lock().unwrap();
    if g.generation == generation {
        g.phase = Phase::Failed;
        g.message = message;
    }
}

/// Kills the backend and everything it started, and waits for it to be gone.
fn stop_backend_now(app: &AppHandle) {
    if let Some(backend) = app.try_state::<Backend>() {
        let child = {
            let mut g = backend.inner.lock().unwrap();
            g.generation += 1;
            g.child.take()
        };
        if let Some(child) = child {
            let _ = child.kill();
        }
    }
    // The Windows installer also kills any leftover apex-backend.exe (windows/hooks.nsh).
}

#[tauri::command]
fn backend_status(state: State<Backend>) -> Status {
    let g = state.inner.lock().unwrap();
    Status {
        phase: g.phase,
        message: g.message.clone(),
        log: g.tail.iter().cloned().collect(),
        data_dir: state.data_dir.to_string_lossy().to_string(),
    }
}

#[tauri::command]
fn restart_backend(app: AppHandle) {
    spawn_backend(&app);
}

/// Forwards one API call from the UI to the backend.
#[tauri::command]
async fn api(state: State<'_, Backend>, method: String, path: String, body: Option<String>) -> Result<ApiReply, String> {
    if !path.starts_with("/api/") {
        return Err("bad path".into());
    }
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "bad method".to_string())?;
    let mut request = state
        .http
        .request(method, format!("http://127.0.0.1:{}{}", state.port, path))
        .header("X-APEX-Token", &state.token)
        // AI calls can take a while; everything else is fast.
        .timeout(Duration::from_secs(if path.starts_with("/api/ai") || path == "/api/chat" { 120 } else { 30 }));
    if let Some(body) = body {
        request = request.header("Content-Type", "application/json").body(body);
    }
    let response = request.send().await.map_err(|e| {
        if e.is_timeout() { "The engine took too long to answer".to_string() } else { "Can't reach the trading engine".to_string() }
    })?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| e.to_string())?;
    Ok(ApiReply { status, body })
}

#[tauri::command]
async fn update_check(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone().unwrap_or_default() });
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

/// Downloads the update, then stops the backend before the installer touches any file.
/// Windows: the installer takes over and the app exits. macOS: the bundle is swapped
/// in place and APEX restarts.
#[tauri::command]
async fn update_install(app: AppHandle, pending: State<'_, PendingUpdate>, progress: Channel<(u64, u64)>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("No update to install")?;
    let mut got: u64 = 0;
    let bytes = update
        .download(
            |chunk, total| {
                got += chunk as u64;
                let _ = progress.send((got, total.unwrap_or(0)));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    stop_backend_now(&app);
    if let Err(e) = update.install(bytes) {
        spawn_backend(&app);
        return Err(e.to_string());
    }
    app.restart();
}

fn main() {
    // reqwest (shared with the updater) is built without a default TLS provider; pick one
    // up front, the same one the updater uses, so building any HTTP client can't panic.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch just brings the open window forward (one backend, one ledger).
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate::default())
        .invoke_handler(tauri::generate_handler![backend_status, restart_backend, api, update_check, update_install])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            clear_quarantine();

            // macOS: ~/Library/Application Support/APEX. Windows: %APPDATA%\APEX. Linux: ~/.local/share/APEX.
            let data_dir = app.path().data_dir()?.join("APEX");
            std::fs::create_dir_all(&data_dir)?;

            let http = reqwest::Client::builder()
                .no_proxy() // localhost only; a system proxy must never see these calls
                .pool_idle_timeout(Duration::from_secs(30))
                .build()?;

            app.manage(Backend {
                port: free_port(),
                token: uuid::Uuid::new_v4().to_string(),
                data_dir,
                http,
                inner: Arc::new(Mutex::new(Inner {
                    phase: Phase::Starting,
                    message: String::new(),
                    child: None,
                    generation: 0,
                    tail: VecDeque::new(),
                })),
            });
            spawn_backend(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building APEX");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_backend_now(handle);
        }
    });
}
