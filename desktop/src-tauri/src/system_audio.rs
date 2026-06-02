use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const MINIMUM_MACOS_VERSION: &str = "14.2";

#[derive(Debug, Serialize)]
pub struct SystemAudioCapability {
    supported: bool,
    minimum_macos_version: &'static str,
    current_macos_version: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NativeRecordingOutput {
    path: String,
}

#[tauri::command]
pub fn system_audio_capability() -> SystemAudioCapability {
    #[cfg(target_os = "macos")]
    {
        let current_macos_version = macos_product_version();
        let supported = current_macos_version
            .as_deref()
            .and_then(parse_version)
            .is_some_and(|version| version >= (14, 2));
        let reason = (!supported).then(|| {
            "Systemaudio-Aufnahmen benötigen macOS 14.2 oder neuer.".to_string()
        });
        SystemAudioCapability {
            supported,
            minimum_macos_version: MINIMUM_MACOS_VERSION,
            current_macos_version,
            reason,
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        SystemAudioCapability {
            supported: false,
            minimum_macos_version: MINIMUM_MACOS_VERSION,
            current_macos_version: None,
            reason: Some("Systemaudio-Aufnahmen werden derzeit nur unter macOS unterstützt.".to_string()),
        }
    }
}

#[tauri::command]
pub fn start_system_audio_recording(app: AppHandle) -> Result<(), String> {
    if !system_audio_capability().supported {
        return Err("Systemaudio-Aufnahmen benötigen macOS 14.2 oder neuer.".to_string());
    }

    let mut active_path = active_path().lock().unwrap();
    if active_path.is_some() {
        return Err("Es läuft bereits eine Systemaudio-Aufnahme.".to_string());
    }
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("App-Datenordner nicht verfügbar: {error}"))?
        .join("native-recordings");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Aufnahmeordner konnte nicht erstellt werden: {error}"))?;
    let path = directory.join(format!("{}.caf", Uuid::new_v4().simple()));

    native_start(&path)?;
    *active_path = Some(path);
    Ok(())
}

#[tauri::command]
pub fn pause_system_audio_recording() {
    native_set_paused(true);
}

#[tauri::command]
pub fn resume_system_audio_recording() {
    native_set_paused(false);
}

#[tauri::command]
pub fn stop_system_audio_recording() -> Result<NativeRecordingOutput, String> {
    let path = stop_inner().ok_or_else(|| "Es läuft keine Systemaudio-Aufnahme.".to_string())?;
    Ok(NativeRecordingOutput {
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn cancel_system_audio_recording() {
    if let Some(path) = stop_inner() {
        let _ = std::fs::remove_file(path);
    }
}

/// Sample rate of the live-preview system-audio stream (0 if not recording).
#[tauri::command]
pub fn system_audio_sample_rate() -> f64 {
    native_sample_rate()
}

/// Drain the buffered system-audio samples accumulated since the last poll.
/// Returns mono float samples at the rate reported by `system_audio_sample_rate`.
#[tauri::command]
pub fn poll_system_audio_pcm() -> Vec<f32> {
    native_poll_pcm()
}

pub fn stop_if_recording() {
    cancel_system_audio_recording();
}

fn active_path() -> &'static Mutex<Option<PathBuf>> {
    static ACTIVE_PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    ACTIVE_PATH.get_or_init(|| Mutex::new(None))
}

fn stop_inner() -> Option<PathBuf> {
    let path = active_path().lock().unwrap().take();
    if path.is_some() {
        native_stop();
    }
    path
}

#[cfg(target_os = "macos")]
fn native_start(path: &std::path::Path) -> Result<(), String> {
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;

    unsafe extern "C" {
        fn tarscribe_system_audio_start(output_path: *const c_char) -> *mut c_char;
        fn tarscribe_system_audio_free_string(value: *mut c_char);
    }

    let path = CString::new(path.to_string_lossy().as_bytes())
        .map_err(|_| "Ungültiger Zielpfad für die Systemaudio-Aufnahme.".to_string())?;
    let error = unsafe { tarscribe_system_audio_start(path.as_ptr()) };
    if error.is_null() {
        return Ok(());
    }
    let message = unsafe { CStr::from_ptr(error).to_string_lossy().into_owned() };
    unsafe { tarscribe_system_audio_free_string(error) };
    Err(message)
}

#[cfg(not(target_os = "macos"))]
fn native_start(_path: &std::path::Path) -> Result<(), String> {
    Err("Systemaudio-Aufnahmen werden derzeit nur unter macOS unterstützt.".to_string())
}

#[cfg(target_os = "macos")]
fn native_set_paused(paused: bool) {
    unsafe extern "C" {
        fn tarscribe_system_audio_set_paused(paused: bool);
    }
    unsafe { tarscribe_system_audio_set_paused(paused) };
}

#[cfg(not(target_os = "macos"))]
fn native_set_paused(_paused: bool) {}

#[cfg(target_os = "macos")]
fn native_stop() {
    unsafe extern "C" {
        fn tarscribe_system_audio_stop();
    }
    unsafe { tarscribe_system_audio_stop() };
}

#[cfg(not(target_os = "macos"))]
fn native_stop() {}

#[cfg(target_os = "macos")]
fn native_sample_rate() -> f64 {
    unsafe extern "C" {
        fn tarscribe_system_audio_sample_rate() -> f64;
    }
    unsafe { tarscribe_system_audio_sample_rate() }
}

#[cfg(not(target_os = "macos"))]
fn native_sample_rate() -> f64 {
    0.0
}

#[cfg(target_os = "macos")]
fn native_poll_pcm() -> Vec<f32> {
    unsafe extern "C" {
        fn tarscribe_system_audio_poll(out: *mut f32, max_samples: i32) -> i32;
    }
    // Drain in fixed-size chunks until the ring buffer is empty.
    let mut samples = Vec::new();
    let mut chunk = [0f32; 8192];
    loop {
        let written =
            unsafe { tarscribe_system_audio_poll(chunk.as_mut_ptr(), chunk.len() as i32) };
        if written <= 0 {
            break;
        }
        let written = written as usize;
        samples.extend_from_slice(&chunk[..written]);
        if written < chunk.len() {
            break;
        }
    }
    samples
}

#[cfg(not(target_os = "macos"))]
fn native_poll_pcm() -> Vec<f32> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn macos_product_version() -> Option<String> {
    let output = std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn parse_version(version: &str) -> Option<(u32, u32)> {
    let mut parts = version.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::parse_version;

    #[test]
    fn parses_macos_versions_for_capability_check() {
        assert_eq!(parse_version("14.2"), Some((14, 2)));
        assert_eq!(parse_version("15.5.1"), Some((15, 5)));
        assert_eq!(parse_version("invalid"), None);
    }
}
