mod menu;
mod sidecar;
mod system_audio;

#[cfg(desktop)]
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use menu::{TrayState, WindowLifecycleState};
use sidecar::BackendState;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

const DEFAULT_DICTATION_SHORTCUT: &str = "Alt+Meta+D";

#[cfg(desktop)]
#[derive(Default)]
struct DictationShortcutState {
    current: Mutex<Option<tauri_plugin_global_shortcut::Shortcut>>,
}

#[cfg(desktop)]
#[derive(Default)]
struct MeetingDetectionState {
    enabled: Mutex<bool>,
    apps: Mutex<Vec<String>>,
    last_prompted: Mutex<HashMap<String, Instant>>,
}

#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
struct MeetingDetectedPayload {
    app_name: String,
}

/// macOS adds com.apple.quarantine to downloaded apps; on macOS 26+ this hides
/// the app from Finder/Launchpad even after the user approves it in Security
/// settings. Remove the flag on every launch — xattr is a no-op if absent.
#[cfg(target_os = "macos")]
fn remove_quarantine() {
    if cfg!(debug_assertions) {
        return;
    }
    if let Ok(exe) = std::env::current_exe() {
        // exe: .../Tarscribe.app/Contents/MacOS/desktop
        if let Some(bundle) = exe
            .parent()              // MacOS/
            .and_then(|p| p.parent())  // Contents/
            .and_then(|p| p.parent())  // Tarscribe.app
        {
            if bundle.extension().is_some_and(|e| e == "app") {
                let _ = std::process::Command::new("xattr")
                    .args(["-dr", "com.apple.quarantine"])
                    .arg(bundle)
                    .output();
            }
        }
    }
}

#[cfg(desktop)]
fn parse_dictation_shortcut(
    accelerator: &str,
) -> Result<(tauri_plugin_global_shortcut::Shortcut, String), String> {
    use tauri_plugin_global_shortcut::{
        Code, Modifiers, Shortcut,
    };

    let mut modifiers = Modifiers::empty();
    let mut key: Option<Code> = None;
    for part in accelerator.split('+').map(|p| p.trim()).filter(|p| !p.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "alt" | "option" | "opt" => modifiers |= Modifiers::ALT,
            "meta" | "cmd" | "command" | "super" => modifiers |= Modifiers::META,
            "ctrl" | "control" => modifiers |= Modifiers::CONTROL,
            "shift" => modifiers |= Modifiers::SHIFT,
            value if value.len() == 1 => {
                key = match value.as_bytes()[0].to_ascii_uppercase() {
                    b'A' => Some(Code::KeyA),
                    b'B' => Some(Code::KeyB),
                    b'C' => Some(Code::KeyC),
                    b'D' => Some(Code::KeyD),
                    b'E' => Some(Code::KeyE),
                    b'F' => Some(Code::KeyF),
                    b'G' => Some(Code::KeyG),
                    b'H' => Some(Code::KeyH),
                    b'I' => Some(Code::KeyI),
                    b'J' => Some(Code::KeyJ),
                    b'K' => Some(Code::KeyK),
                    b'L' => Some(Code::KeyL),
                    b'M' => Some(Code::KeyM),
                    b'N' => Some(Code::KeyN),
                    b'O' => Some(Code::KeyO),
                    b'P' => Some(Code::KeyP),
                    b'Q' => Some(Code::KeyQ),
                    b'R' => Some(Code::KeyR),
                    b'S' => Some(Code::KeyS),
                    b'T' => Some(Code::KeyT),
                    b'U' => Some(Code::KeyU),
                    b'V' => Some(Code::KeyV),
                    b'W' => Some(Code::KeyW),
                    b'X' => Some(Code::KeyX),
                    b'Y' => Some(Code::KeyY),
                    b'Z' => Some(Code::KeyZ),
                    _ => None,
                };
            }
            value => return Err(format!("Unbekannter Shortcut-Teil: {value}")),
        }
    }
    let code = key.ok_or_else(|| "Shortcut braucht eine Buchstaben-Taste A-Z.".to_string())?;
    if modifiers.is_empty() {
        return Err("Shortcut braucht mindestens eine Modifikator-Taste.".to_string());
    }
    let normalized = format!("{modifiers:?}+{code:?}");
    Ok((Shortcut::new(Some(modifiers), code), normalized))
}

#[cfg(desktop)]
fn install_global_shortcut_plugin(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::ShortcutState;

    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                let state = app.state::<DictationShortcutState>();
                let matches_current = state
                    .current
                    .lock()
                    .map(|current| current.as_ref().is_some_and(|registered| shortcut == registered))
                    .unwrap_or(false);
                if matches_current && event.state() == ShortcutState::Pressed {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit("menu", "dictation-toggle");
                }
            })
            .build(),
    )
    .map_err(|e| e.to_string())?;
    register_dictation_shortcut(app, DEFAULT_DICTATION_SHORTCUT)?;
    Ok(())
}

#[cfg(desktop)]
fn register_dictation_shortcut(app: &tauri::AppHandle, accelerator: &str) -> Result<String, String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let state = app.state::<DictationShortcutState>();
    let (shortcut, normalized) = parse_dictation_shortcut(accelerator)?;
    if let Some(previous) = state.current.lock().map_err(|e| e.to_string())?.take() {
        let _ = app.global_shortcut().unregister(previous);
    }
    app.global_shortcut()
        .register(shortcut)
        .map_err(|e| e.to_string())?;
    *state.current.lock().map_err(|e| e.to_string())? = Some(shortcut);
    Ok(normalized)
}

#[cfg(desktop)]
#[tauri::command]
fn set_dictation_shortcut(app: tauri::AppHandle, accelerator: String) -> Result<String, String> {
    register_dictation_shortcut(&app, &accelerator)
}

#[cfg(not(desktop))]
#[tauri::command]
fn set_dictation_shortcut(_accelerator: String) -> Result<String, String> {
    Err("Globale Shortcuts sind auf dieser Plattform nicht verfügbar.".to_string())
}

#[cfg(desktop)]
fn detected_meeting_app(apps: &[String]) -> Option<String> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "comm="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let process_list = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    apps.iter()
        .map(|app| app.trim())
        .filter(|app| !app.is_empty())
        .find(|app| process_list.contains(&app.to_ascii_lowercase()))
        .map(str::to_string)
}

#[cfg(desktop)]
fn start_meeting_detection_loop(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        let state = app.state::<MeetingDetectionState>();
        let enabled = state.enabled.lock().map(|enabled| *enabled).unwrap_or(false);
        if !enabled {
            continue;
        }
        let apps = state.apps.lock().map(|apps| apps.clone()).unwrap_or_default();
        let Some(app_name) = detected_meeting_app(&apps) else {
            continue;
        };

        // Conferencing apps keep helper processes running permanently, so "app is
        // running" alone produces constant false positives. Only prompt when the
        // microphone is actually live (a call is in progress). Where mic state
        // can't be read, fall back to the app-running signal.
        if system_audio::microphone_in_use() == Some(false) {
            continue;
        }

        let now = Instant::now();
        let should_emit = {
            let mut last = match state.last_prompted.lock() {
                Ok(last) => last,
                Err(_) => continue,
            };
            let fresh = last
                .get(&app_name)
                .is_none_or(|prev| now.duration_since(*prev) > Duration::from_secs(20 * 60));
            if fresh {
                last.insert(app_name.clone(), now);
            }
            fresh
        };
        if should_emit {
            let _ = app.emit("meeting-detected", MeetingDetectedPayload { app_name });
        }
    });
}

#[cfg(desktop)]
#[tauri::command]
fn configure_meeting_detection(
    state: tauri::State<MeetingDetectionState>,
    enabled: bool,
    apps: Vec<String>,
) -> Result<(), String> {
    *state.enabled.lock().map_err(|e| e.to_string())? = enabled;
    *state.apps.lock().map_err(|e| e.to_string())? = apps
        .into_iter()
        .map(|app| app.trim().to_string())
        .filter(|app| !app.is_empty())
        .collect();
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
fn configure_meeting_detection(_enabled: bool, _apps: Vec<String>) -> Result<(), String> {
    Err("Meeting-Erkennung ist auf dieser Plattform nicht verfügbar.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(BackendState::default())
        .manage(TrayState::default())
        .manage(WindowLifecycleState::default())
        .manage(DictationShortcutState::default())
        .manage(MeetingDetectionState::default())
        .invoke_handler(tauri::generate_handler![
            sidecar::backend_config,
            sidecar::is_env_ready,
            sidecar::is_backend_ready,
            sidecar::setup_environment,
            set_dictation_shortcut,
            configure_meeting_detection,
            menu::set_update_badge,
            menu::set_tray_recording_state,
            system_audio::system_audio_capability,
            system_audio::start_system_audio_recording,
            system_audio::pause_system_audio_recording,
            system_audio::resume_system_audio_recording,
            system_audio::stop_system_audio_recording,
            system_audio::cancel_system_audio_recording,
            system_audio::system_audio_sample_rate,
            system_audio::poll_system_audio_pcm,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            remove_quarantine();

            let handle = app.handle().clone();
            #[cfg(desktop)]
            if let Err(e) = install_global_shortcut_plugin(&handle) {
                eprintln!("Globaler Diktat-Hotkey konnte nicht registriert werden: {e}");
            }
            #[cfg(desktop)]
            start_meeting_detection_loop(handle.clone());
            // On a packaged install whose env predates an update, install any deps
            // added since (e.g. sqlite-vec for RAG) before starting the backend.
            sidecar::sync_dependencies_if_stale(&handle);
            match sidecar::start_if_ready(&handle) {
                Ok(true) => {}
                Ok(false) => {
                    // First run on a packaged build: the frontend will trigger setup.
                    let _ = tauri::Emitter::emit(&handle, "needs-setup", true);
                }
                Err(e) => eprintln!("Sidecar-Start fehlgeschlagen: {e}"),
            }
            if let Err(e) = menu::build_menu(&handle) {
                eprintln!("Menü-Aufbau fehlgeschlagen: {e}");
            }
            if let Err(e) = menu::build_tray(&handle) {
                eprintln!("Tray-Aufbau fehlgeschlagen: {e}");
            }
            if let Some(window) = app.get_webview_window("main") {
                let handle = handle.clone();
                let close_window = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        menu::hide_main_window_on_close(&handle, close_window.clone());
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            match event {
                RunEvent::Reopen { .. } => menu::show_main_window(app_handle),
                RunEvent::Exit => {
                    system_audio::stop_if_recording();
                    sidecar::stop(app_handle);
                }
                _ => {}
            }
        });
}
