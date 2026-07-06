use log::error;
use tauri::{AppHandle, Builder, Emitter, Manager};

#[cfg(not(target_os = "macos"))]
const TRAY_CHECK_UPDATE_ID: &str = "tray.check_update";
#[cfg(not(target_os = "macos"))]
const SYSTEM_OPEN_SETTINGS_EVENT: &str = "system-open-settings";
#[cfg(not(target_os = "macos"))]
const SYSTEM_CHECK_UPDATE_EVENT: &str = "system-check-update";
const SYSTEM_REQUEST_APP_EXIT_EVENT: &str = "system-request-app-exit";
#[cfg(not(target_os = "macos"))]
const SYSTEM_ABOUT_EVENT: &str = "system-about";
#[cfg(not(target_os = "macos"))]
const TRAY_OPEN_SETTINGS_ID: &str = "tray.open_settings";
#[cfg(not(target_os = "macos"))]
const TRAY_SHOW_MAIN_WINDOW_ID: &str = "tray.show_main_window";
#[cfg(not(target_os = "macos"))]
const TRAY_QUIT_ID: &str = "tray.quit";
#[cfg(not(target_os = "macos"))]
const TRAY_ABOUT_ID: &str = "tray.about";

pub(crate) fn configure_builder(builder: Builder<tauri::Wry>) -> Builder<tauri::Wry> {
    let mut builder = builder;

    #[cfg(not(target_os = "macos"))]
    {
        builder = builder
            .setup(|app| {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_decorations(false).ok();
                }

                let tray_menu = build_tray_menu(app.handle())
                    .map_err(|error| format!("failed to create tray menu: {error}"))?;
                let mut tray_builder = tauri::tray::TrayIconBuilder::with_id("main")
                    .menu(&tray_menu)
                    .on_menu_event(|app, event| {
                        handle_menu_event(app, event.id.as_ref());
                    });

                if let Some(icon) = app.default_window_icon().cloned() {
                    tray_builder = tray_builder.icon(icon);
                }

                tray_builder
                    .build(app)
                    .map_err(|error| format!("failed to initialize tray icon: {error}"))?;

                Ok(())
            })
            .on_window_event(|window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if window.label() == "main" {
                        api.prevent_close();
                        if let Err(error) = window.hide() {
                            error!("failed to hide window while keeping tray active: {error}");
                        }
                    }
                }
            });
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder.on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    if let Err(error) = emit_system_request_app_exit(window.app_handle()) {
                        error!("failed to handle macOS close request: {error}");
                    }
                }
            }
        });
    }

    builder
}

#[cfg(not(target_os = "macos"))]
fn handle_menu_event(app: &AppHandle, menu_id: &str) {
    if menu_id == TRAY_OPEN_SETTINGS_ID {
        if let Err(error) = emit_system_open_settings(app) {
            error!("failed to handle open-settings menu event: {error}");
        }
        return;
    }

    if menu_id == TRAY_CHECK_UPDATE_ID {
        if let Err(error) = emit_system_check_update(app) {
            error!("failed to handle check-update menu event: {error}");
        }
        return;
    }

    if menu_id == TRAY_ABOUT_ID {
        if let Err(error) = emit_system_about(app) {
            error!("failed to handle about menu event: {error}");
        }
        return;
    }

    if menu_id == TRAY_SHOW_MAIN_WINDOW_ID {
        if let Err(error) = show_main_window(app) {
            error!("failed to show main window from tray: {error}");
        }
        return;
    }

    if menu_id == TRAY_QUIT_ID {
        if let Err(error) = emit_system_request_app_exit(app) {
            error!("failed to handle app-exit menu event: {error}");
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn emit_system_open_settings(app: &AppHandle) -> Result<(), String> {
    app.emit(SYSTEM_OPEN_SETTINGS_EVENT, ())
        .map_err(|error| format!("failed to emit {SYSTEM_OPEN_SETTINGS_EVENT} event: {error}"))
}

#[cfg(not(target_os = "macos"))]
fn emit_system_check_update(app: &AppHandle) -> Result<(), String> {
    app.emit(SYSTEM_CHECK_UPDATE_EVENT, ())
        .map_err(|error| format!("failed to emit {SYSTEM_CHECK_UPDATE_EVENT} event: {error}"))
}

fn emit_system_request_app_exit(app: &AppHandle) -> Result<(), String> {
    app.emit(SYSTEM_REQUEST_APP_EXIT_EVENT, ())
        .map_err(|error| format!("failed to emit {SYSTEM_REQUEST_APP_EXIT_EVENT} event: {error}"))
}

#[cfg(not(target_os = "macos"))]
fn emit_system_about(app: &AppHandle) -> Result<(), String> {
    app.emit(SYSTEM_ABOUT_EVENT, ())
        .map_err(|error| format!("failed to emit {SYSTEM_ABOUT_EVENT} event: {error}"))
}

#[cfg(not(target_os = "macos"))]
fn build_tray_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem};

    let show_main_window_item = MenuItem::with_id(
        app,
        TRAY_SHOW_MAIN_WINDOW_ID,
        "Show Main Window",
        true,
        None::<&str>,
    )?;
    let open_settings_item = MenuItem::with_id(
        app,
        TRAY_OPEN_SETTINGS_ID,
        "Settings",
        true,
        None::<&str>,
    )?;
    let check_update_item = MenuItem::with_id(
        app,
        TRAY_CHECK_UPDATE_ID,
        "Check for Updates",
        true,
        None::<&str>,
    )?;
    let about_item = MenuItem::with_id(app, TRAY_ABOUT_ID, "About", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &show_main_window_item,
            &open_settings_item,
            &check_update_item,
            &about_item,
            &quit_item,
        ],
    )
}

#[cfg(not(target_os = "macos"))]
fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window
        .unminimize()
        .map_err(|error| format!("failed to unminimize main window: {error}"))?;
    window
        .show()
        .map_err(|error| format!("failed to show main window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("failed to focus main window: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_update_menu_ids_are_recognized() {
        assert!(is_check_update_menu_id("tray.check_update"));
        assert!(!is_check_update_menu_id("tray.quit"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn open_settings_menu_id_is_recognized() {
        assert!(is_open_settings_menu_id("tray.open_settings"));
        assert!(!is_open_settings_menu_id("tray.check_update"));
    }
}

#[cfg(not(target_os = "macos"))]
fn is_check_update_menu_id(menu_id: &str) -> bool {
    menu_id == TRAY_CHECK_UPDATE_ID
}

#[cfg(not(target_os = "macos"))]
fn is_open_settings_menu_id(menu_id: &str) -> bool {
    menu_id == TRAY_OPEN_SETTINGS_ID
}
