//! Native macOS menu bar + tray/status item.
//!
//! Custom items emit a `menu` event to the frontend (e.g. "settings", "new-topic",
//! "check-update"); standard items use predefined system actions. The tray is kept
//! in app state so update and live-recording status can be shown in the status bar.

use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde::Deserialize;
use tauri::{
    menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Emitter, Manager, WebviewWindow,
};

const FULLSCREEN_CLOSE_HIDE_DELAY: Duration = Duration::from_millis(650);

#[derive(Default)]
pub struct WindowLifecycleState {
    hide_request: AtomicU64,
}

#[derive(Default)]
pub struct TrayState {
    tray: Mutex<Option<TrayIcon>>,
    meta: Mutex<TrayMeta>,
}

#[derive(Clone)]
struct TrayMeta {
    update_available: bool,
    update_version: Option<String>,
    recording: TrayRecordingMeta,
}

impl Default for TrayMeta {
    fn default() -> Self {
        Self {
            update_available: false,
            update_version: None,
            recording: TrayRecordingMeta::default(),
        }
    }
}

#[derive(Clone)]
struct TrayRecordingMeta {
    state: String,
    elapsed: u64,
    topic_name: Option<String>,
    can_start: bool,
}

impl Default for TrayRecordingMeta {
    fn default() -> Self {
        Self {
            state: "idle".to_string(),
            elapsed: 0,
            topic_name: None,
            can_start: false,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayRecordingPayload {
    state: String,
    elapsed: u64,
    topic_name: Option<String>,
    can_start: bool,
}

pub fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let settings = MenuItemBuilder::new("Einstellungen…")
        .id("settings")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let new_topic = MenuItemBuilder::new("Neuer Themenbereich")
        .id("new-topic")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let dictation_toggle = MenuItemBuilder::new("Diktat starten/stoppen")
        .id("dictation-toggle")
        .build(app)?;
    let check_update = MenuItemBuilder::new("Nach Updates suchen…")
        .id("check-update")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "Tarscribe")
        .about(Some(AboutMetadata {
            name: Some("Tarscribe".into()),
            ..Default::default()
        }))
        .separator()
        .item(&check_update)
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "Datei")
        .item(&new_topic)
        .item(&dictation_toggle)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Bearbeiten")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Fenster")
        .minimize()
        .fullscreen()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;

    app.on_menu_event(move |app, event| match event.id().as_ref() {
        "settings" => {
            show_main_window(app);
            let _ = app.emit("menu", "settings");
        }
        "new-topic" => {
            show_main_window(app);
            let _ = app.emit("menu", "new-topic");
        }
        "dictation-toggle" => {
            show_main_window(app);
            let _ = app.emit("menu", "dictation-toggle");
        }
        "check-update" => {
            show_main_window(app);
            let _ = app.emit("menu", "check-update");
        }
        _ => {}
    });
    Ok(())
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let meta = {
        let state = app.state::<TrayState>();
        let meta = state.meta.lock().unwrap().clone();
        meta
    };
    let tray_menu = tray_menu(app, &meta)?;

    let tray = TrayIconBuilder::new()
        // Monochrome menu-bar glyph; `icon_as_template` lets macOS auto-invert it
        // for light/dark menu bars (the full-colour app icon would look wrong here).
        .icon(tauri::include_image!("icons/tray.png"))
        .icon_as_template(true)
        .tooltip("Tarscribe")
        .menu(&tray_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                show_main_window(app);
            }
            "check-update" => {
                show_main_window(app);
                let _ = app.emit("menu", "check-update");
            }
            "record-start" => {
                show_main_window(app);
                let _ = app.emit("menu", "record-start");
            }
            "record-pause" => {
                let _ = app.emit("menu", "record-pause");
            }
            "record-resume" => {
                let _ = app.emit("menu", "record-resume");
            }
            "record-stop" => {
                let _ = app.emit("menu", "record-stop");
            }
            "dictation-toggle" => {
                show_main_window(app);
                let _ = app.emit("menu", "dictation-toggle");
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    let state = app.state::<TrayState>();
    state.tray.lock().unwrap().replace(tray);
    apply_tray(app, &state, true);
    Ok(())
}

/// Show/clear an "update available" indicator in the status bar.
#[tauri::command]
pub fn set_update_badge(
    app: AppHandle,
    state: tauri::State<TrayState>,
    available: bool,
    version: Option<String>,
) {
    {
        let mut meta = state.meta.lock().unwrap();
        meta.update_available = available;
        meta.update_version = version;
    }
    apply_tray(&app, &state, true);
}

#[tauri::command]
pub fn set_tray_recording_state(
    app: AppHandle,
    state: tauri::State<TrayState>,
    payload: TrayRecordingPayload,
) {
    let should_apply = {
        let meta = state.meta.lock().unwrap();
        meta.recording.affects_native_tray(
            &payload.state,
            payload.topic_name.as_deref(),
            payload.can_start,
        )
    };
    {
        let mut meta = state.meta.lock().unwrap();
        meta.recording = TrayRecordingMeta {
            state: payload.state,
            elapsed: payload.elapsed,
            topic_name: payload.topic_name,
            can_start: payload.can_start,
        };
    }
    if should_apply {
        apply_tray(&app, &state, true);
    }
}

fn apply_tray(app: &AppHandle, state: &TrayState, rebuild_menu: bool) {
    let meta = state.meta.lock().unwrap().clone();
    let title = tray_title(&meta);
    let tooltip = tray_tooltip(&meta);
    let menu = rebuild_menu.then(|| tray_menu(app, &meta));
    if let Some(tray) = state.tray.lock().unwrap().as_ref() {
        let _ = tray.set_title(title.as_deref());
        let _ = tray.set_tooltip(Some(&tooltip));
        if let Some(Ok(menu)) = menu {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn tray_menu(app: &AppHandle, meta: &TrayMeta) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let show = MenuItemBuilder::new("Tarscribe öffnen").id("show").build(app)?;
    let check_label = match &meta.update_version {
        Some(version) if meta.update_available => format!("Update {version} anzeigen…"),
        _ => "Nach Updates suchen…".to_string(),
    };
    let check = MenuItemBuilder::new(check_label).id("check-update").build(app)?;
    let dictation = MenuItemBuilder::new("Diktat starten/stoppen (⌥⌘D)")
        .id("dictation-toggle")
        .build(app)?;
    let quit = MenuItemBuilder::new("Beenden").id("quit").build(app)?;

    let recording = &meta.recording;
    let topic = recording
        .topic_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Aufnahme");

    let menu = match recording.state.as_str() {
        "recording" => {
            let status = MenuItemBuilder::new(format!("Aufnahme läuft · {topic}"))
                .id("record-status")
                .enabled(false)
                .build(app)?;
            let pause = MenuItemBuilder::new("Aufnahme pausieren")
                .id("record-pause")
                .build(app)?;
            let stop = MenuItemBuilder::new("Aufnahme stoppen")
                .id("record-stop")
                .build(app)?;
            MenuBuilder::new(app)
                .item(&show)
                .separator()
                .item(&status)
                .item(&pause)
                .item(&stop)
                .separator()
                .item(&check)
                .item(&quit)
                .build()?
        }
        "paused" => {
            let elapsed = format_elapsed(recording.elapsed);
            let status = MenuItemBuilder::new(format!("Aufnahme pausiert · {topic} · {elapsed}"))
                .id("record-status")
                .enabled(false)
                .build(app)?;
            let resume = MenuItemBuilder::new("Aufnahme fortsetzen")
                .id("record-resume")
                .build(app)?;
            let stop = MenuItemBuilder::new("Aufnahme stoppen")
                .id("record-stop")
                .build(app)?;
            MenuBuilder::new(app)
                .item(&show)
                .separator()
                .item(&status)
                .item(&resume)
                .item(&stop)
                .separator()
                .item(&check)
                .item(&quit)
                .build()?
        }
        "starting" | "saving" | "transcribing" => {
            let label = match recording.state.as_str() {
                "starting" => "Aufnahme startet…",
                "transcribing" => "Finale Transkription läuft…",
                _ => "Aufnahme wird gespeichert…",
            }
            .to_string();
            let status = MenuItemBuilder::new(label)
                .id("record-status")
                .enabled(false)
                .build(app)?;
            MenuBuilder::new(app)
                .item(&show)
                .separator()
                .item(&status)
                .separator()
                .item(&check)
                .item(&quit)
                .build()?
        }
        _ => {
            let start_label = recording
                .topic_name
                .as_ref()
                .filter(|name| !name.trim().is_empty())
                .map(|name| format!("Aufnahme starten: {name}"))
                .unwrap_or_else(|| "Aufnahme starten".to_string());
            let start = MenuItemBuilder::new(start_label)
                .id("record-start")
                .enabled(recording.can_start)
                .build(app)?;
            MenuBuilder::new(app)
                .item(&show)
                .separator()
                .item(&start)
                .item(&dictation)
                .separator()
                .item(&check)
                .item(&quit)
                .build()?
        }
    };
    Ok(menu)
}

fn tray_title(meta: &TrayMeta) -> Option<String> {
    let recording = &meta.recording;
    match recording.state.as_str() {
        "recording" => Some("● REC".to_string()),
        "paused" => Some(format!("II {}", format_elapsed(recording.elapsed))),
        "starting" => Some("●".to_string()),
        "saving" => Some("…".to_string()),
        "transcribing" => Some("TXT".to_string()),
        _ if meta.update_available => Some("●".to_string()),
        _ => None,
    }
}

fn tray_tooltip(meta: &TrayMeta) -> String {
    let recording = &meta.recording;
    let topic = recording
        .topic_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Aufnahme");
    match recording.state.as_str() {
        "recording" => format!("Tarscribe — Aufnahme läuft: {topic}"),
        "paused" => format!(
            "Tarscribe — Aufnahme pausiert: {topic} ({})",
            format_elapsed(recording.elapsed)
        ),
        "starting" => "Tarscribe — Aufnahme startet".to_string(),
        "saving" => "Tarscribe — Aufnahme wird gespeichert".to_string(),
        "transcribing" => "Tarscribe — finale Transkription läuft".to_string(),
        _ if meta.update_available => match &meta.update_version {
            Some(v) => format!("Tarscribe — Update verfügbar ({v})"),
            None => "Tarscribe — Update verfügbar".to_string(),
        },
        _ => "Tarscribe".to_string(),
    }
}

pub(crate) fn show_main_window(app: &AppHandle) {
    cancel_pending_hide(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub(crate) fn hide_main_window_on_close(app: &AppHandle, window: WebviewWindow) {
    let request_id = next_hide_request(app);
    let was_fullscreen = window.is_fullscreen().unwrap_or(false);

    if was_fullscreen {
        let _ = window.set_fullscreen(false);
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(FULLSCREEN_CLOSE_HIDE_DELAY);
            if is_current_hide_request(&app, request_id) && window.is_visible().unwrap_or(true) {
                let _ = window.hide();
            }
        });
    } else {
        let _ = window.hide();
    }
}

fn next_hide_request(app: &AppHandle) -> u64 {
    app.state::<WindowLifecycleState>()
        .hide_request
        .fetch_add(1, Ordering::SeqCst)
        + 1
}

fn cancel_pending_hide(app: &AppHandle) {
    let _ = next_hide_request(app);
}

fn is_current_hide_request(app: &AppHandle, request_id: u64) -> bool {
    app.state::<WindowLifecycleState>()
        .hide_request
        .load(Ordering::SeqCst)
        == request_id
}

impl TrayRecordingMeta {
    fn affects_native_tray(&self, state: &str, topic_name: Option<&str>, can_start: bool) -> bool {
        self.state != state
            || self.topic_name.as_deref() != topic_name
            || self.can_start != can_start
    }
}

fn format_elapsed(seconds: u64) -> String {
    let h = seconds / 3600;
    let m = (seconds % 3600) / 60;
    let s = seconds % 60;
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}
