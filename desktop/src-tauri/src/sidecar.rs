//! Manages the Python FastAPI backend as a child process ("sidecar"), and on a
//! packaged macOS build, bootstraps its Python environment on first run via a
//! bundled `uv` (the env lives in the app data dir, built from bundled sources).

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{
    header::SEC_WEBSOCKET_PROTOCOL, HeaderValue as WsHeaderValue,
};
use tokio_tungstenite::tungstenite::Message;

#[derive(Default)]
pub struct BackendState {
    pub child: Mutex<Option<Child>>,
    pub config: Mutex<Option<BackendConfig>>,
    pub ws_connections: Mutex<HashMap<String, watch::Sender<bool>>>,
}

#[derive(Clone)]
pub struct BackendConfig {
    pub base_url: String,
    pub token: String,
}

#[derive(Clone, Serialize)]
pub struct PublicBackendConfig {
    pub base_url: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ProxyHeader {
    pub name: String,
    pub value: String,
}

#[derive(Serialize)]
pub struct ProxyResponse {
    pub status: u16,
    pub headers: Vec<ProxyHeader>,
    pub body: Vec<u8>,
}

const WS_SUBPROTOCOL: &str = "tarscribe";
const WS_AUTH_SUBPROTOCOL_PREFIX: &str = "tarscribe-auth-";

fn find_free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind free port");
    listener.local_addr().unwrap().port()
}

// --- locations -------------------------------------------------------------

fn app_data(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn runtime_venv_python(app: &AppHandle) -> PathBuf {
    app_data(app).join("runtime/.venv/bin/python")
}

fn tool_path() -> OsString {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    for path in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        let path = PathBuf::from(path);
        if !paths.iter().any(|existing| existing == &path) {
            paths.push(path);
        }
    }
    std::env::join_paths(paths).unwrap_or_else(|_| OsString::from("/usr/bin:/bin"))
}

fn python_path(backend: &Path) -> OsString {
    let mut paths = vec![backend.to_path_buf()];
    if let Some(existing) = std::env::var_os("PYTHONPATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(paths).unwrap_or_else(|_| backend.as_os_str().to_os_string())
}

/// Backend sources: bundled in the .app under resources, or the dev tree.
pub fn backend_source(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        for cand in [res.join("backend"), res.join("resources/backend")] {
            if cand.join("pyproject.toml").exists() {
                return Some(cand);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../backend");
    if dev.join("pyproject.toml").exists() {
        return Some(dev);
    }
    None
}

/// The bundled `uv` binary, or whatever is on PATH.
fn uv_binary(app: &AppHandle) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        for cand in [res.join("uv"), res.join("resources/uv")] {
            if cand.exists() {
                return cand;
            }
        }
    }
    PathBuf::from("uv")
}

/// Pick the Python interpreter to run the backend with.
pub fn resolve_python(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("TARSCRIBE_BACKEND_PYTHON") {
        return Some(PathBuf::from(p));
    }
    let runtime = runtime_venv_python(app);
    if runtime.exists() {
        return Some(runtime);
    }
    // Dev tree venv (absolute path baked at build time; valid on the dev machine).
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../backend/.venv/bin/python");
    if dev.exists() {
        return Some(dev);
    }
    None
}

/// Whether a usable Python environment exists (so the sidecar can start).
#[tauri::command]
pub fn is_env_ready(app: AppHandle) -> bool {
    resolve_python(&app).is_some()
}

#[tauri::command]
pub fn is_backend_ready(state: tauri::State<BackendState>) -> bool {
    state.config.lock().unwrap().is_some()
}

// --- lifecycle -------------------------------------------------------------

fn spawn_backend(app: &AppHandle, python: &Path) -> Result<(), String> {
    let port = find_free_port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let data_dir = app_data(app);
    let backend =
        backend_source(app).ok_or_else(|| "Backend-Quellen nicht gefunden".to_string())?;
    std::fs::create_dir_all(&data_dir).ok();
    println!("[backend] Quellen: {}", backend.display());

    let mut child = Command::new(python)
        .args([
            "-m",
            "tarscribe_backend",
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--token",
            &token,
            "--data-dir",
            &data_dir.to_string_lossy(),
        ])
        .env("PATH", tool_path())
        .env("PYTHONPATH", python_path(&backend))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Backend konnte nicht gestartet werden ({python:?}): {e}"))?;

    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                println!("[backend] {line}");
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                eprintln!("[backend] {line}");
            }
        });
    }

    let config = BackendConfig {
        base_url: format!("http://127.0.0.1:{port}"),
        token,
    };
    let state = app.state::<BackendState>();
    *state.child.lock().unwrap() = Some(child);
    *state.config.lock().unwrap() = Some(config);
    Ok(())
}

fn deps_stamp_path(app: &AppHandle) -> PathBuf {
    app_data(app).join("runtime/.deps-version")
}

/// Re-sync the Python deps when the app version changed since the runtime env was
/// last provisioned. The env lives in app data and survives updates, so without
/// this an update that adds a dependency (e.g. sqlite-vec for RAG) would never
/// install it. Runs only on a packaged install (the dev tree uses its own venv);
/// a no-op once the stamp matches the current version.
pub fn sync_dependencies_if_stale(app: &AppHandle) {
    let venv_python = runtime_venv_python(app);
    if !venv_python.exists() {
        return; // No runtime env: dev machine, or first run handled by setup_environment.
    }
    let current = app.package_info().version.to_string();
    let stamp = deps_stamp_path(app);
    if std::fs::read_to_string(&stamp).unwrap_or_default().trim() == current {
        return;
    }
    let Some(backend) = backend_source(app) else {
        return;
    };
    let uv = uv_binary(app);
    let target = format!("{}[asr-common,diarization,mac]", backend.to_string_lossy());
    let _ = app.emit("setup-progress", "Aktualisiere Abhängigkeiten…".to_string());
    let mut cmd = Command::new(&uv);
    cmd.args([
        "pip",
        "install",
        "--python",
        &venv_python.to_string_lossy(),
        &target,
    ]);
    match run_streaming(app, cmd, "Aktualisierung") {
        Ok(()) => {
            let _ = std::fs::write(&stamp, &current);
        }
        Err(e) => eprintln!("Abhängigkeiten-Sync fehlgeschlagen: {e}"),
    }
}

/// Start the sidecar if an environment already exists. Returns Ok(false) if the
/// environment still needs to be set up (first run on a packaged build).
pub fn start_if_ready(app: &AppHandle) -> Result<bool, String> {
    match resolve_python(app) {
        Some(python) => {
            spawn_backend(app, &python)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

fn run_streaming(app: &AppHandle, mut cmd: Command, phase: &str) -> Result<(), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("{phase}: {e}"))?;
    if let Some(out) = child.stderr.take() {
        let app = app.clone();
        let phase = phase.to_string();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = app.emit("setup-progress", format!("{phase}: {line}"));
            }
        });
    }
    let status = child.wait().map_err(|e| format!("{phase}: {e}"))?;
    if !status.success() {
        return Err(format!("{phase} fehlgeschlagen (Code {:?})", status.code()));
    }
    Ok(())
}

/// First-run: build the Python env in the app data dir via bundled `uv`, then
/// start the sidecar. Emits `setup-progress` events throughout.
#[tauri::command]
pub async fn setup_environment(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app = handle;
        if resolve_python(&app).is_some() {
            return start_if_ready(&app).map(|_| ());
        }

        let uv = uv_binary(&app);
        let backend =
            backend_source(&app).ok_or_else(|| "Backend-Quellen nicht gefunden".to_string())?;
        let venv = app_data(&app).join("runtime/.venv");
        std::fs::create_dir_all(venv.parent().unwrap()).ok();

        let _ = app.emit("setup-progress", "Erstelle Python-Umgebung…".to_string());
        let mut venv_cmd = Command::new(&uv);
        venv_cmd.args(["venv", &venv.to_string_lossy(), "--python", "3.12"]);
        run_streaming(&app, venv_cmd, "Umgebung")?;

        let _ = app.emit(
            "setup-progress",
            "Installiere Modelle & Abhängigkeiten (kann einige Minuten dauern)…".to_string(),
        );
        let venv_python = venv.join("bin/python");
        let target = format!("{}[asr-common,diarization,mac]", backend.to_string_lossy());
        let mut pip_cmd = Command::new(&uv);
        pip_cmd.args([
            "pip",
            "install",
            "--python",
            &venv_python.to_string_lossy(),
            &target,
        ]);
        run_streaming(&app, pip_cmd, "Installation")?;
        // Stamp the version so later updates can detect when deps need re-syncing.
        let _ = std::fs::write(
            deps_stamp_path(&app),
            app.package_info().version.to_string(),
        );

        let _ = app.emit("setup-progress", "Starte Backend…".to_string());
        start_if_ready(&app).map(|_| ())
    })
    .await
    .map_err(|e| format!("Setup-Task abgebrochen: {e}"))?
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<BackendState>();
    for (_, stop) in state.ws_connections.lock().unwrap().drain() {
        let _ = stop.send(true);
    }
    let child = state.child.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn current_config(state: &BackendState) -> Result<BackendConfig, String> {
    state
        .config
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Backend noch nicht bereit".to_string())
}

fn backend_api_url(config: &BackendConfig, path: &str) -> Result<String, String> {
    if !path.starts_with("/api/") || path.starts_with("//") || path.contains("://") {
        return Err("Nur relative /api/-Pfade dürfen über den Backend-Proxy laufen".to_string());
    }
    if path.contains('\n') || path.contains('\r') {
        return Err("Ungültiger Backend-Pfad".to_string());
    }
    Ok(format!("{}{}", config.base_url, path))
}

fn should_forward_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept" | "content-type" | "x-sequence-number" | "x-sample-rate" | "x-channels"
    )
}

fn should_return_response_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "content-disposition" | "content-type" | "etag" | "last-modified"
    )
}

#[tauri::command]
pub fn backend_config(state: tauri::State<BackendState>) -> Result<PublicBackendConfig, String> {
    let config = current_config(&state)?;
    Ok(PublicBackendConfig {
        base_url: config.base_url,
    })
}

#[tauri::command]
pub async fn proxy_request(
    state: tauri::State<'_, BackendState>,
    method: String,
    path: String,
    headers: Vec<ProxyHeader>,
    body: Option<Vec<u8>>,
) -> Result<ProxyResponse, String> {
    let config = current_config(&state)?;
    let url = backend_api_url(&config, &path)?;
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| "Ungültige HTTP-Methode".to_string())?;

    let client = reqwest::Client::new();
    let mut request = client
        .request(method, url)
        .header("X-Tarscribe-Token", config.token);

    for header in headers {
        if !should_forward_request_header(&header.name) {
            continue;
        }
        request = request.header(header.name, header.value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Backend-Request fehlgeschlagen: {e}"))?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            if !should_return_response_header(name.as_str()) {
                return None;
            }
            Some(ProxyHeader {
                name: name.as_str().to_string(),
                value: value.to_str().ok()?.to_string(),
            })
        })
        .collect();
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("Backend-Response konnte nicht gelesen werden: {e}"))?
        .to_vec();

    Ok(ProxyResponse {
        status,
        headers,
        body,
    })
}

fn backend_ws_url(config: &BackendConfig) -> String {
    format!("{}/ws", config.base_url.replacen("http", "ws", 1))
}

async fn run_backend_ws_proxy(
    app: AppHandle,
    config: BackendConfig,
    connection_id: String,
    mut stop: watch::Receiver<bool>,
) {
    let event_name = format!("backend-ws-event-{connection_id}");
    loop {
        if *stop.borrow() {
            break;
        }

        let protocols = format!(
            "{WS_SUBPROTOCOL}, {WS_AUTH_SUBPROTOCOL_PREFIX}{}",
            config.token
        );
        let mut request = match backend_ws_url(&config).into_client_request() {
            Ok(request) => request,
            Err(e) => {
                eprintln!("[backend-ws] Request konnte nicht erstellt werden: {e}");
                break;
            }
        };
        match WsHeaderValue::from_str(&protocols) {
            Ok(value) => {
                request.headers_mut().insert(SEC_WEBSOCKET_PROTOCOL, value);
            }
            Err(e) => {
                eprintln!("[backend-ws] Subprotocol ungültig: {e}");
                break;
            }
        }

        match connect_async(request).await {
            Ok((socket, _)) => {
                let (mut write, mut read) = socket.split();
                let mut ping = tokio::time::interval(Duration::from_secs(20));
                loop {
                    tokio::select! {
                        changed = stop.changed() => {
                            if changed.is_err() || *stop.borrow() {
                                let _ = write.send(Message::Close(None)).await;
                                return;
                            }
                        }
                        _ = ping.tick() => {
                            if write.send(Message::Text("ping".into())).await.is_err() {
                                break;
                            }
                        }
                        message = read.next() => {
                            match message {
                                Some(Ok(Message::Text(text))) => {
                                    let _ = app.emit(&event_name, text.to_string());
                                }
                                Some(Ok(Message::Binary(bytes))) => {
                                    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
                                        let _ = app.emit(&event_name, text);
                                    }
                                }
                                Some(Ok(Message::Close(_))) | None => break,
                                Some(Err(e)) => {
                                    eprintln!("[backend-ws] Verbindung getrennt: {e}");
                                    break;
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!("[backend-ws] Verbindung fehlgeschlagen: {e}");
            }
        }

        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    break;
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }
}

#[tauri::command]
pub fn backend_ws_connect(
    app: AppHandle,
    state: tauri::State<BackendState>,
    connection_id: String,
) -> Result<String, String> {
    let config = current_config(&state)?;
    let (stop_tx, stop_rx) = watch::channel(false);
    state
        .ws_connections
        .lock()
        .unwrap()
        .insert(connection_id.clone(), stop_tx);
    tauri::async_runtime::spawn(run_backend_ws_proxy(
        app,
        config,
        connection_id.clone(),
        stop_rx,
    ));
    Ok(connection_id)
}

#[tauri::command]
pub fn backend_ws_disconnect(
    state: tauri::State<BackendState>,
    connection_id: String,
) -> Result<(), String> {
    if let Some(stop) = state.ws_connections.lock().unwrap().remove(&connection_id) {
        let _ = stop.send(true);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::python_path;
    use std::path::Path;

    #[test]
    fn bundled_backend_is_first_python_path_entry() {
        let backend = Path::new("/tmp/tarscribe-bundled-backend");
        let paths: Vec<_> = std::env::split_paths(&python_path(backend)).collect();
        assert_eq!(paths.first().map(|path| path.as_path()), Some(backend));
    }
}
