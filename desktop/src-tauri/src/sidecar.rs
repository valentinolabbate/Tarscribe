//! Manages the Python FastAPI backend as a child process ("sidecar"), and on a
//! packaged macOS build, bootstraps its Python environment on first run via a
//! bundled `uv` (the env lives in the app data dir, built from bundled sources).

use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct BackendState {
    pub child: Mutex<Option<Child>>,
    pub config: Mutex<Option<BackendConfig>>,
}

#[derive(Clone, Serialize)]
pub struct BackendConfig {
    pub base_url: String,
    pub token: String,
}

fn find_free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind free port");
    listener.local_addr().unwrap().port()
}

// --- locations -------------------------------------------------------------

fn app_data(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."))
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
fn backend_source(app: &AppHandle) -> Option<PathBuf> {
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
fn resolve_python(app: &AppHandle) -> Option<PathBuf> {
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
    let backend = backend_source(app).ok_or_else(|| "Backend-Quellen nicht gefunden".to_string())?;
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
        let backend = backend_source(&app)
            .ok_or_else(|| "Backend-Quellen nicht gefunden".to_string())?;
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
        let _ = std::fs::write(deps_stamp_path(&app), app.package_info().version.to_string());

        let _ = app.emit("setup-progress", "Starte Backend…".to_string());
        start_if_ready(&app).map(|_| ())
    })
    .await
    .map_err(|e| format!("Setup-Task abgebrochen: {e}"))?
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<BackendState>();
    let child = state.child.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tauri::command]
pub fn backend_config(state: tauri::State<BackendState>) -> Result<BackendConfig, String> {
    state
        .config
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Backend noch nicht bereit".to_string())
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
