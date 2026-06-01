//! Native macOS menu bar + tray/status item.
//!
//! Custom items emit a `menu` event to the frontend (e.g. "settings", "new-topic",
//! "check-update"); standard items use predefined system actions. The tray is kept
//! in app state so an "update available" badge can be shown in the status bar.

use std::sync::Mutex;

use tauri::{
    menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Emitter, Manager,
};

#[derive(Default)]
pub struct TrayState(pub Mutex<Option<TrayIcon>>);

pub fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let settings = MenuItemBuilder::new("Einstellungen…")
        .id("settings")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let new_topic = MenuItemBuilder::new("Neuer Themenbereich")
        .id("new-topic")
        .accelerator("CmdOrCtrl+N")
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

    let file_menu = SubmenuBuilder::new(app, "Datei").item(&new_topic).build()?;

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
            let _ = app.emit("menu", "settings");
        }
        "new-topic" => {
            let _ = app.emit("menu", "new-topic");
        }
        "check-update" => {
            let _ = app.emit("menu", "check-update");
        }
        _ => {}
    });
    Ok(())
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::new("Tarscribe öffnen").id("show").build(app)?;
    let check = MenuItemBuilder::new("Nach Updates suchen…").id("check-update").build(app)?;
    let quit = MenuItemBuilder::new("Beenden").id("quit").build(app)?;
    let tray_menu = MenuBuilder::new(app).items(&[&show, &check, &quit]).build()?;

    let tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Tarscribe")
        .menu(&tray_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "check-update" => {
                let _ = app.emit("menu", "check-update");
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    app.state::<TrayState>().0.lock().unwrap().replace(tray);
    Ok(())
}

/// Show/clear an "update available" indicator in the status bar.
#[tauri::command]
pub fn set_update_badge(
    state: tauri::State<TrayState>,
    available: bool,
    version: Option<String>,
) {
    if let Some(tray) = state.0.lock().unwrap().as_ref() {
        if available {
            let _ = tray.set_title(Some("●"));
            let label = match version {
                Some(v) => format!("Tarscribe — Update verfügbar ({v})"),
                None => "Tarscribe — Update verfügbar".to_string(),
            };
            let _ = tray.set_tooltip(Some(&label));
        } else {
            let _ = tray.set_title(None::<&str>);
            let _ = tray.set_tooltip(Some("Tarscribe"));
        }
    }
}
