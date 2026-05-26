use log::error;
use tauri::{AppHandle, Builder, Emitter, Manager};

const MENU_OPEN_SETTINGS_ID: &str = "menu.open_settings";
const MENU_CHECK_UPDATE_ID: &str = "menu.check_update";
#[cfg(target_os = "macos")]
const APP_QUIT_MENU_ID: &str = "menu.app_quit";
#[cfg(target_os = "macos")]
const MENU_ABOUT_ID: &str = "menu.about";
#[cfg(target_os = "windows")]
const TRAY_OPEN_SETTINGS_ID: &str = "tray.open_settings";
const TRAY_CHECK_UPDATE_ID: &str = "tray.check_update";
const SYSTEM_OPEN_SETTINGS_EVENT: &str = "system-open-settings";
const SYSTEM_CHECK_UPDATE_EVENT: &str = "system-check-update";
const SYSTEM_REQUEST_APP_EXIT_EVENT: &str = "system-request-app-exit";
const SYSTEM_ABOUT_EVENT: &str = "system-about";
#[cfg(target_os = "windows")]
const TRAY_SHOW_MAIN_WINDOW_ID: &str = "tray.show_main_window";
#[cfg(target_os = "windows")]
const TRAY_QUIT_ID: &str = "tray.quit";
#[cfg(target_os = "windows")]
const TRAY_ABOUT_ID: &str = "tray.about";

pub(crate) fn configure_builder(builder: Builder<tauri::Wry>) -> Builder<tauri::Wry> {
    let mut builder = builder;

    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(build_macos_app_menu);
    }

    builder = builder.on_menu_event(|app, event| {
        handle_menu_event(app, event.id().as_ref());
    });

    #[cfg(target_os = "windows")]
    {
        builder = builder
            .setup(|app| {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_decorations(false).ok();
                }

                let tray_menu = build_windows_tray_menu(app.handle())
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

fn handle_menu_event(app: &AppHandle, menu_id: &str) {
    #[cfg(target_os = "macos")]
    {
        if menu_id == MENU_ABOUT_ID {
            if let Err(error) = emit_system_about(app) {
                error!("failed to handle about menu event: {error}");
            }
            return;
        }
    }

    if is_open_settings_menu_id(menu_id) {
        if let Err(error) = emit_system_open_settings(app) {
            error!("failed to handle open-settings menu event: {error}");
        }
        return;
    }

    if is_check_update_menu_id(menu_id) {
        if let Err(error) = emit_system_check_update(app) {
            error!("failed to handle check-update menu event: {error}");
        }
        return;
    }

    #[cfg(target_os = "windows")]
    {
        if menu_id == TRAY_ABOUT_ID {
            if let Err(error) = emit_system_about(app) {
                error!("failed to handle about menu event: {error}");
            }
            return;
        }
    }

    #[cfg(target_os = "macos")]
    {
        if menu_id == APP_QUIT_MENU_ID {
            if let Err(error) = emit_system_request_app_exit(app) {
                error!("failed to handle app-exit menu event: {error}");
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
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
}

fn is_check_update_menu_id(menu_id: &str) -> bool {
    menu_id == MENU_CHECK_UPDATE_ID || menu_id == TRAY_CHECK_UPDATE_ID
}

fn is_open_settings_menu_id(menu_id: &str) -> bool {
    menu_id == MENU_OPEN_SETTINGS_ID
        || {
            #[cfg(target_os = "windows")]
            {
                menu_id == TRAY_OPEN_SETTINGS_ID
            }
            #[cfg(not(target_os = "windows"))]
            {
                false
            }
        }
}

fn emit_system_open_settings(app: &AppHandle) -> Result<(), String> {
    app.emit(SYSTEM_OPEN_SETTINGS_EVENT, ())
        .map_err(|error| format!("failed to emit {SYSTEM_OPEN_SETTINGS_EVENT} event: {error}"))
}

fn emit_system_check_update(app: &AppHandle) -> Result<(), String> {
    app.emit(SYSTEM_CHECK_UPDATE_EVENT, ())
        .map_err(|error| format!("failed to emit {SYSTEM_CHECK_UPDATE_EVENT} event: {error}"))
}

fn emit_system_request_app_exit(app: &AppHandle) -> Result<(), String> {
    app.emit(SYSTEM_REQUEST_APP_EXIT_EVENT, ())
        .map_err(|error| format!("failed to emit {SYSTEM_REQUEST_APP_EXIT_EVENT} event: {error}"))
}

fn emit_system_about(app: &AppHandle) -> Result<(), String> {
    app.emit(SYSTEM_ABOUT_EVENT, ())
        .map_err(|error| format!("failed to emit {SYSTEM_ABOUT_EVENT} event: {error}"))
}

#[cfg(target_os = "macos")]
fn macos_check_update_insert_position(item_count: usize) -> usize {
    item_count.min(1)
}

#[cfg(target_os = "macos")]
fn build_macos_app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};

    let menu = Menu::default(app)?;
    let app_submenu = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(submenu) => Some(submenu),
        _ => None,
    });

    if let Some(app_submenu) = app_submenu {
        let app_submenu_items = app_submenu.items()?;
        for (index, item) in app_submenu_items.iter().enumerate() {
            let text = match item {
                MenuItemKind::MenuItem(menu_item) => menu_item.text().ok(),
                MenuItemKind::Predefined(predefined) => predefined.text().ok(),
                _ => continue,
            };
            if let Some(text) = text {
                if text.to_lowercase().contains("about") {
                    let _ = app_submenu.remove_at(index);
                    break;
                }
            }
        }

        let about_item = MenuItem::with_id(
            app,
            MENU_ABOUT_ID,
            "About TermBridge",
            true,
            None::<&str>,
        )?;
        let settings_item = MenuItem::with_id(
            app,
            MENU_OPEN_SETTINGS_ID,
            "Settings...",
            true,
            None::<&str>,
        )?;
        let check_update_item = MenuItem::with_id(
            app,
            MENU_CHECK_UPDATE_ID,
            "Check for Updates...",
            true,
            None::<&str>,
        )?;
        let quit_item =
            MenuItem::with_id(app, APP_QUIT_MENU_ID, "Quit TermBridge", true, None::<&str>)?;
        let app_submenu_items = app_submenu.items()?;
        let quit_position = app_submenu_items.len().saturating_sub(1);
        let _ = app_submenu.remove_at(quit_position)?;
        app_submenu.insert_items(&[&about_item], 0)?;
        let insert_position = macos_check_update_insert_position(app_submenu.items()?.len());
        app_submenu.insert_items(&[&settings_item], insert_position)?;
        app_submenu.insert_items(&[&check_update_item], insert_position + 1)?;
        app_submenu.insert_items(&[&quit_item], app_submenu.items()?.len())?;
    }

    Ok(menu)
}

#[cfg(target_os = "windows")]
fn build_windows_tray_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
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

#[cfg(target_os = "windows")]
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
        assert!(is_check_update_menu_id("menu.check_update"));
        assert!(is_check_update_menu_id("tray.check_update"));
        assert!(!is_check_update_menu_id("tray.quit"));
    }

    #[test]
    fn open_settings_menu_id_is_recognized() {
        assert!(is_open_settings_menu_id("menu.open_settings"));
        #[cfg(target_os = "windows")]
        assert!(is_open_settings_menu_id("tray.open_settings"));
        assert!(!is_open_settings_menu_id("menu.check_update"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_check_update_item_is_inserted_directly_after_about() {
        assert_eq!(macos_check_update_insert_position(0), 0);
        assert_eq!(macos_check_update_insert_position(1), 1);
        assert_eq!(macos_check_update_insert_position(4), 1);
    }
}
