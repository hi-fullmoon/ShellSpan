//! Cross-platform OS-level desktop notification delivery, permission status
//! checks, system settings deep-opening, and click-to-focus / click-to-navigate
//! routing.

use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const DESKTOP_NOTIFICATION_CLICKED_EVENT: &str = "shellspan-notification-clicked";

const MAX_TITLE_BYTES: usize = 512;
const MAX_BODY_BYTES: usize = 4096;
const MAX_ID_BYTES: usize = 128;
const MAX_ACTIVE_RESPONSE_WAITERS: usize = 16;

static ACTIVE_RESPONSE_WAITERS: AtomicUsize = AtomicUsize::new(0);

struct ResponseWaiterGuard<'a> {
    counter: &'a AtomicUsize,
}

impl<'a> ResponseWaiterGuard<'a> {
    fn try_acquire(counter: &'a AtomicUsize, max: usize) -> Option<Self> {
        let mut current = counter.load(Ordering::Relaxed);
        loop {
            if current >= max {
                return None;
            }
            match counter.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => return Some(Self { counter }),
                Err(actual) => current = actual,
            }
        }
    }
}

impl Drop for ResponseWaiterGuard<'_> {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

const ALLOWED_APP_SECTIONS: &[&str] = &["workbench", "terminal", "sftp"];

const ALLOWED_SETTINGS_SECTIONS: &[&str] = &[
    "appearance",
    "general",
    "notifications",
    "terminal",
    "sftp",
    "ai",
    "shortcuts",
    "experimental",
    "feedback",
];

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DesktopNotificationTarget {
    AgentSession {
        agent_session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        terminal_session_id: Option<String>,
    },
    TerminalSession {
        terminal_session_id: String,
    },
    Section {
        section: String,
    },
    Settings {
        settings_section: String,
    },
    None,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopNotificationRequest {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub target: Option<DesktopNotificationTarget>,
    #[serde(default)]
    pub urgency: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopNotificationClickedEvent {
    pub target: DesktopNotificationTarget,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DesktopNotificationPermission {
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Granted,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Denied,
    #[allow(dead_code)]
    Prompt,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopNotificationStatus {
    pub supported: bool,
    pub permission: DesktopNotificationPermission,
    pub can_request_permission: bool,
    pub can_open_system_settings: bool,
    pub platform: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedNotification {
    title: String,
    body: String,
    target: DesktopNotificationTarget,
    critical: bool,
}

fn validate_identifier(value: &str, field: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_ID_BYTES
        || !trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!("notification {field} is invalid"));
    }
    Ok(trimmed.to_string())
}

fn validate_text(value: &str, max_bytes: usize, require_non_empty: bool) -> Result<String, String> {
    if value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err("notification text is invalid".into());
    }
    let trimmed = value.trim();
    if require_non_empty && trimmed.is_empty() {
        return Err("notification text is invalid".into());
    }
    Ok(crate::redaction::redact_sensitive_text(trimmed))
}

fn validate_target(
    target: Option<DesktopNotificationTarget>,
) -> Result<DesktopNotificationTarget, String> {
    match target {
        None | Some(DesktopNotificationTarget::None) => Ok(DesktopNotificationTarget::None),
        Some(DesktopNotificationTarget::AgentSession {
            agent_session_id,
            terminal_session_id,
        }) => {
            let agent_session_id = validate_identifier(&agent_session_id, "agentSessionId")?;
            let terminal_session_id = match terminal_session_id {
                Some(id) => Some(validate_identifier(&id, "terminalSessionId")?),
                None => None,
            };
            Ok(DesktopNotificationTarget::AgentSession {
                agent_session_id,
                terminal_session_id,
            })
        }
        Some(DesktopNotificationTarget::TerminalSession {
            terminal_session_id,
        }) => Ok(DesktopNotificationTarget::TerminalSession {
            terminal_session_id: validate_identifier(&terminal_session_id, "terminalSessionId")?,
        }),
        Some(DesktopNotificationTarget::Section { section }) => {
            if !ALLOWED_APP_SECTIONS.contains(&section.as_str()) {
                return Err("notification section is invalid".into());
            }
            Ok(DesktopNotificationTarget::Section { section })
        }
        Some(DesktopNotificationTarget::Settings { settings_section }) => {
            if !ALLOWED_SETTINGS_SECTIONS.contains(&settings_section.as_str()) {
                return Err("notification settingsSection is invalid".into());
            }
            Ok(DesktopNotificationTarget::Settings { settings_section })
        }
    }
}

fn validate_request(request: DesktopNotificationRequest) -> Result<ValidatedNotification, String> {
    let title = validate_text(&request.title, MAX_TITLE_BYTES, true)?;
    let body = validate_text(&request.body, MAX_BODY_BYTES, false)?;
    let target = validate_target(request.target)?;
    let critical = match request.urgency.as_deref() {
        None | Some("normal") => false,
        Some("critical") => true,
        Some(_) => return Err("notification urgency is invalid".into()),
    };
    Ok(ValidatedNotification {
        title,
        body,
        target,
        critical,
    })
}

fn current_platform() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "linux"
    }
}

fn can_open_system_notification_settings() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

fn build_status(permission: DesktopNotificationPermission) -> DesktopNotificationStatus {
    DesktopNotificationStatus {
        supported: true,
        permission,
        can_request_permission: matches!(permission, DesktopNotificationPermission::Prompt),
        can_open_system_settings: can_open_system_notification_settings(),
        platform: current_platform(),
    }
}

#[cfg(target_os = "windows")]
mod windows_platform {
    use std::path::PathBuf;
    use std::ptr;
    use std::sync::Once;
    use tauri::{AppHandle, Manager};
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_DWORD,
    };
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    const NOTIFICATION_ICON_PNG: &[u8] = include_bytes!("../icons/128x128.png");
    const NOTIFICATION_ICON_FILENAME: &str = "notification-icon.png";
    static AUMID_REGISTERED: Once = Once::new();

    fn wide_null(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn set_hkcu_string(subkey: &str, name: &str, value: &str) -> Result<(), String> {
        let subkey_w = wide_null(subkey);
        let name_w = wide_null(name);
        let value_w = wide_null(value);
        let mut hkey: HKEY = ptr::null_mut();

        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                subkey_w.as_ptr(),
                0,
                ptr::null_mut(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                ptr::null(),
                &mut hkey,
                ptr::null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!("RegCreateKeyExW failed with code {status}"));
        }

        let byte_len = u32::try_from(value_w.len() * std::mem::size_of::<u16>())
            .map_err(|_| "registry value too large".to_string())?;
        let set_status = unsafe {
            RegSetValueExW(
                hkey,
                name_w.as_ptr(),
                0,
                REG_SZ,
                value_w.as_ptr().cast::<u8>(),
                byte_len,
            )
        };
        unsafe {
            RegCloseKey(hkey);
        }
        if set_status != ERROR_SUCCESS {
            return Err(format!("RegSetValueExW failed with code {set_status}"));
        }
        Ok(())
    }

    fn read_hkcu_dword(subkey: &str, name: &str) -> Option<u32> {
        let subkey_w = wide_null(subkey);
        let name_w = wide_null(name);
        let mut value: u32 = 0;
        let mut size = u32::try_from(std::mem::size_of::<u32>()).ok()?;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey_w.as_ptr(),
                name_w.as_ptr(),
                RRF_RT_REG_DWORD,
                ptr::null_mut(),
                (&mut value as *mut u32).cast::<core::ffi::c_void>(),
                &mut size,
            )
        };
        (status == ERROR_SUCCESS).then_some(value)
    }

    /// Materializes the embedded PNG icon into local app data so Windows 11
    /// toast headers always have a real image file for `IconUri` in both dev
    /// and installed builds.
    fn materialize_icon_file(app: &AppHandle) -> Option<PathBuf> {
        let dir = app.path().app_local_data_dir().ok()?;
        if std::fs::create_dir_all(&dir).is_err() {
            return None;
        }
        let icon_path = dir.join(NOTIFICATION_ICON_FILENAME);
        let needs_write = std::fs::read(&icon_path).ok().as_deref() != Some(NOTIFICATION_ICON_PNG);
        if needs_write && std::fs::write(&icon_path, NOTIFICATION_ICON_PNG).is_err() {
            return None;
        }
        Some(icon_path)
    }

    /// Ensures the unpackaged Win32 process has a registered per-user AUMID so
    /// Windows displays native Toast notifications under ShellSpan's identity
    /// and icon in both development and installed builds.
    pub(super) fn ensure_aumid_registered(app: &AppHandle) {
        AUMID_REGISTERED.call_once(|| {
            let identifier = &app.config().identifier;
            let display_name = app.config().product_name.as_deref().unwrap_or("ShellSpan");

            let app_id_w = wide_null(identifier);
            unsafe {
                let _ = SetCurrentProcessExplicitAppUserModelID(app_id_w.as_ptr());
            }

            let subkey = format!("Software\\Classes\\AppUserModelId\\{identifier}");
            if let Err(error) = set_hkcu_string(&subkey, "DisplayName", display_name) {
                log::debug!("Failed to register Windows AUMID DisplayName: {error}");
                return;
            }
            let _ = set_hkcu_string(&subkey, "IconBackgroundColor", "0");
            if let Some(icon_path) = materialize_icon_file(app) {
                let icon_uri = icon_path.display().to_string();
                if let Err(error) = set_hkcu_string(&subkey, "IconUri", &icon_uri) {
                    log::debug!("Failed to register Windows AUMID IconUri: {error}");
                }
            }
        });
    }

    /// Reads Windows global and per-app notification toggles from HKCU.
    pub(super) fn read_permission(identifier: &str) -> super::DesktopNotificationPermission {
        if read_hkcu_dword(
            "Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications",
            "ToastEnabled",
        ) == Some(0)
        {
            return super::DesktopNotificationPermission::Denied;
        }
        let app_settings_key = format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\{identifier}"
        );
        if read_hkcu_dword(&app_settings_key, "Enabled") == Some(0) {
            return super::DesktopNotificationPermission::Denied;
        }
        super::DesktopNotificationPermission::Granted
    }
}

pub(crate) fn initialize_desktop_notifications(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    windows_platform::ensure_aumid_registered(app);

    #[cfg(target_os = "macos")]
    {
        let bundle_id = if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            &app.config().identifier
        };
        if let Err(error) = notify_rust::set_application(bundle_id) {
            log::debug!("Desktop notification application setup skipped: {error}");
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = app;
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn handle_notification_response(
    app: &AppHandle,
    target: &DesktopNotificationTarget,
    response: &notify_rust::NotificationResponse,
) {
    match response {
        notify_rust::NotificationResponse::Default
        | notify_rust::NotificationResponse::Action(_) => {
            focus_main_window(app);
            if *target != DesktopNotificationTarget::None {
                let payload = DesktopNotificationClickedEvent {
                    target: target.clone(),
                };
                if let Err(error) = app.emit(DESKTOP_NOTIFICATION_CLICKED_EVENT, &payload) {
                    log::warn!("Failed to emit desktop notification click event: {error}");
                }
            }
        }
        notify_rust::NotificationResponse::Reply(_)
        | notify_rust::NotificationResponse::Closed(_) => {}
    }
}

fn build_platform_notification(
    app: &AppHandle,
    validated: &ValidatedNotification,
) -> Result<notify_rust::Notification, String> {
    let identifier = &app.config().identifier;
    let mut notification = notify_rust::Notification::new();
    notification.summary(&validated.title);

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = identifier;
        if !validated.body.is_empty() {
            notification.body(&validated.body);
        }
        notification.auto_icon();
        notification.action("default", "Open");
        if validated.critical {
            notification.urgency(notify_rust::Urgency::Critical);
        }
    }

    #[cfg(target_os = "windows")]
    {
        windows_platform::ensure_aumid_registered(app);
        notification.app_id(identifier);
        // notify-rust maps `subtitle` to WinRT `<text id="2">` and `body` to
        // `<text id="3">`. Placing single-block body text in `subtitle` avoids
        // an empty gap line between the bold title and message line.
        if !validated.body.is_empty() {
            notification.subtitle(&validated.body);
        }
        // Without an explicit sound, tauri-winrt-notification emits
        // `<audio silent="true" />`; use the OS default notification chime.
        notification.sound_name("Default");
        if validated.critical {
            notification.urgency(notify_rust::Urgency::Critical);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = (identifier, validated.critical);
        if !validated.body.is_empty() {
            notification.body(&validated.body);
        }
        notification.auto_icon();
    }

    Ok(notification)
}

#[cfg(not(target_os = "macos"))]
fn spawn_response_waiter(wait: impl FnOnce() + Send + 'static) -> bool {
    let Some(guard) =
        ResponseWaiterGuard::try_acquire(&ACTIVE_RESPONSE_WAITERS, MAX_ACTIVE_RESPONSE_WAITERS)
    else {
        log::debug!(
            "Skipping notification click waiter: active waiter limit ({MAX_ACTIVE_RESPONSE_WAITERS}) reached"
        );
        return false;
    };

    if let Err(error) = std::thread::Builder::new()
        .name("shellspan-notif-wait".into())
        .spawn(move || {
            let _guard = guard;
            wait();
        })
    {
        log::warn!("Failed to spawn desktop notification waiter thread: {error}");
        return false;
    }

    true
}

pub(crate) async fn dispatch_desktop_notification(
    app: AppHandle,
    request: DesktopNotificationRequest,
) -> Result<(), String> {
    let validated = validate_request(request)?;
    let notification = build_platform_notification(&app, &validated)?;
    let target = validated.target;

    #[cfg(target_os = "macos")]
    {
        // On macOS NSUserNotificationCenter, `show()` prepares a handle and
        // `wait_for_response` delivers synchronously while observing clicks.
        // Observe clicks on a bounded dedicated thread so we never exhaust
        // Tokio's shared blocking pool or accumulate unbounded main-thread
        // timers; when all waiter slots are busy, deliver asynchronously.
        let handle = notification.show().map_err(|error| error.to_string())?;
        if let Some(guard) =
            ResponseWaiterGuard::try_acquire(&ACTIVE_RESPONSE_WAITERS, MAX_ACTIVE_RESPONSE_WAITERS)
        {
            let spawned = std::thread::Builder::new()
                .name("shellspan-notif-wait".into())
                .spawn(move || {
                    let _guard = guard;
                    if let Err(error) =
                        handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
                            handle_notification_response(&app, &target, response);
                        })
                    {
                        log::warn!("Desktop notification delivery or wait failed: {error}");
                    }
                });
            if let Err(error) = spawned {
                return Err(format!(
                    "Failed to start macOS notification delivery: {error}"
                ));
            }
            Ok(())
        } else {
            log::debug!(
                "Active notification waiter limit ({MAX_ACTIVE_RESPONSE_WAITERS}) reached; delivering macOS notification without click waiter"
            );
            tauri::async_runtime::spawn_blocking(move || {
                // Dropping the handle dispatches via `asynchronous: true` with a
                // bounded delivery timeout and no repeating main-thread timer.
                drop(handle);
            })
            .await
            .map_err(|error| format!("notification delivery task failed: {error}"))?;
            Ok(())
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Deliver the native OS notification first and surface any failure
        // directly to the caller, then observe activation clicks on a bounded
        // dedicated thread so Tokio's blocking pool cannot be exhausted.
        let handle = tauri::async_runtime::spawn_blocking(move || {
            notification.show().map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| format!("notification delivery task failed: {error}"))??;

        let _ = spawn_response_waiter(move || {
            if let Err(error) =
                handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
                    handle_notification_response(&app, &target, response);
                })
            {
                log::debug!("Desktop notification response wait ended: {error}");
            }
        });
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn send_desktop_notification(
    app: AppHandle,
    request: DesktopNotificationRequest,
) -> Result<(), String> {
    dispatch_desktop_notification(app, request).await
}

#[tauri::command]
pub(crate) fn get_desktop_notification_status(
    app: AppHandle,
) -> Result<DesktopNotificationStatus, String> {
    #[cfg(target_os = "windows")]
    {
        windows_platform::ensure_aumid_registered(&app);
        let permission = windows_platform::read_permission(&app.config().identifier);
        Ok(build_status(permission))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        // `tauri-plugin-notification` desktop stubs always return `Granted`
        // without querying OS notification settings; report `Unknown` honestly
        // until a native platform authorization query is wired.
        Ok(build_status(DesktopNotificationPermission::Unknown))
    }
}

#[tauri::command]
pub(crate) fn request_desktop_notification_permission(
    app: AppHandle,
) -> Result<DesktopNotificationStatus, String> {
    #[cfg(target_os = "windows")]
    {
        windows_platform::ensure_aumid_registered(&app);
        let permission = windows_platform::read_permission(&app.config().identifier);
        Ok(build_status(permission))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(build_status(DesktopNotificationPermission::Unknown))
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn reap_child_process(mut child: std::process::Child) {
    let _ = std::thread::Builder::new()
        .name("shellspan-reap-child".into())
        .spawn(move || {
            let _ = child.wait();
        });
}

#[tauri::command]
pub(crate) fn open_system_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let child = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
            .spawn()
            .map_err(|error| format!("Failed to open macOS notification settings: {error}"))?;
        reap_child_process(child);
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let child = std::process::Command::new("explorer.exe")
            .arg("ms-settings:notifications")
            .spawn()
            .map_err(|error| format!("Failed to open Windows notification settings: {error}"))?;
        reap_child_process(child);
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("Opening system notification settings is not supported on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_redacts_notification_text() {
        let validated = validate_request(DesktopNotificationRequest {
            title: "  AI approval required  ".into(),
            body: "Authorization: Bearer sk-1234567890abcdef1234567890".into(),
            target: Some(DesktopNotificationTarget::AgentSession {
                agent_session_id: "agent-123".into(),
                terminal_session_id: Some("term-1".into()),
            }),
            urgency: Some("critical".into()),
        })
        .expect("valid request should succeed");

        assert_eq!(validated.title, "AI approval required");
        assert!(!validated.body.contains("sk-1234567890abcdef1234567890"));
        assert!(validated.critical);
        assert_eq!(
            validated.target,
            DesktopNotificationTarget::AgentSession {
                agent_session_id: "agent-123".into(),
                terminal_session_id: Some("term-1".into()),
            }
        );
    }

    #[test]
    fn rejects_control_characters_empty_title_and_invalid_targets() {
        assert!(validate_request(DesktopNotificationRequest {
            title: "   ".into(),
            body: "hello".into(),
            target: None,
            urgency: None,
        })
        .is_err());

        assert!(validate_request(DesktopNotificationRequest {
            title: "bad\ntitle".into(),
            body: "hello".into(),
            target: None,
            urgency: None,
        })
        .is_err());

        assert!(validate_request(DesktopNotificationRequest {
            title: "ok".into(),
            body: "ok".into(),
            target: Some(DesktopNotificationTarget::AgentSession {
                agent_session_id: "../escape".into(),
                terminal_session_id: None,
            }),
            urgency: None,
        })
        .is_err());

        assert!(validate_request(DesktopNotificationRequest {
            title: "ok".into(),
            body: "ok".into(),
            target: Some(DesktopNotificationTarget::Section {
                section: "unknown".into(),
            }),
            urgency: None,
        })
        .is_err());

        assert!(validate_request(DesktopNotificationRequest {
            title: "ok".into(),
            body: "ok".into(),
            target: Some(DesktopNotificationTarget::Section {
                section: "sftp".into(),
            }),
            urgency: None,
        })
        .is_ok());

        assert!(validate_request(DesktopNotificationRequest {
            title: "ok".into(),
            body: "ok".into(),
            target: Some(DesktopNotificationTarget::Settings {
                settings_section: "unknown".into(),
            }),
            urgency: None,
        })
        .is_err());

        assert!(validate_request(DesktopNotificationRequest {
            title: "ok".into(),
            body: "ok".into(),
            target: Some(DesktopNotificationTarget::Settings {
                settings_section: "notifications".into(),
            }),
            urgency: Some("normal".into()),
        })
        .is_ok());

        assert!(validate_request(DesktopNotificationRequest {
            title: "ok".into(),
            body: "ok".into(),
            target: None,
            urgency: Some("urgent".into()),
        })
        .is_err());
    }

    #[test]
    fn maps_permission_states_to_status_metadata() {
        let granted = build_status(DesktopNotificationPermission::Granted);
        assert_eq!(granted.permission, DesktopNotificationPermission::Granted);
        assert!(!granted.can_request_permission);
        assert!(granted.supported);

        let prompt = build_status(DesktopNotificationPermission::Prompt);
        assert_eq!(prompt.permission, DesktopNotificationPermission::Prompt);
        assert!(prompt.can_request_permission);

        let denied = build_status(DesktopNotificationPermission::Denied);
        assert_eq!(denied.permission, DesktopNotificationPermission::Denied);
        assert!(!denied.can_request_permission);

        let unknown = build_status(DesktopNotificationPermission::Unknown);
        assert_eq!(unknown.permission, DesktopNotificationPermission::Unknown);
        assert!(!unknown.can_request_permission);
    }

    #[test]
    fn response_waiter_guard_bounds_concurrency_and_releases_on_drop() {
        let counter = AtomicUsize::new(0);
        let first = ResponseWaiterGuard::try_acquire(&counter, 2).expect("first slot");
        let second = ResponseWaiterGuard::try_acquire(&counter, 2).expect("second slot");
        assert!(ResponseWaiterGuard::try_acquire(&counter, 2).is_none());
        assert_eq!(counter.load(Ordering::SeqCst), 2);

        drop(first);
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        let third = ResponseWaiterGuard::try_acquire(&counter, 2).expect("slot freed after drop");
        assert_eq!(counter.load(Ordering::SeqCst), 2);

        drop(second);
        drop(third);
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }
}
