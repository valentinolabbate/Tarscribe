use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

const INITIALIZED_MARKER: &str = "autostart-initialized-v1";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    supported: bool,
    enabled: bool,
}

fn marker_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join(INITIALIZED_MARKER))
        .map_err(|error| error.to_string())
}

fn mark_initialized(app: &AppHandle) -> Result<(), String> {
    let path = marker_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(path, "1").map_err(|error| error.to_string())
}

pub fn initialize_default(app: &AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) || marker_path(app)?.exists() {
        return Ok(());
    }
    app.autolaunch()
        .enable()
        .map_err(|error| error.to_string())?;
    mark_initialized(app)
}

#[tauri::command]
pub fn get_autostart_status(app: AppHandle) -> Result<AutostartStatus, String> {
    if cfg!(debug_assertions) {
        return Ok(AutostartStatus {
            supported: false,
            enabled: false,
        });
    }
    let enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())?;
    Ok(AutostartStatus {
        supported: true,
        enabled,
    })
}

#[tauri::command]
pub fn set_autostart_enabled(app: AppHandle, enabled: bool) -> Result<AutostartStatus, String> {
    if cfg!(debug_assertions) {
        return Err("Autostart ist nur in der installierten App verfügbar.".to_string());
    }
    let manager = app.autolaunch();
    if enabled {
        manager.enable()
    } else {
        manager.disable()
    }
    .map_err(|error| error.to_string())?;
    mark_initialized(&app)?;
    get_autostart_status(app)
}
