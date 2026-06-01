mod menu;
mod sidecar;

use menu::TrayState;
use sidecar::BackendState;
use tauri::RunEvent;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(BackendState::default())
        .manage(TrayState::default())
        .invoke_handler(tauri::generate_handler![
            sidecar::backend_config,
            sidecar::is_env_ready,
            sidecar::is_backend_ready,
            sidecar::setup_environment,
            menu::set_update_badge,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            remove_quarantine();

            let handle = app.handle().clone();
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
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                sidecar::stop(app_handle);
            }
        });
}
