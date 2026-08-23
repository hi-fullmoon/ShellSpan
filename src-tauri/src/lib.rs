#![allow(clippy::too_many_arguments)]

mod ai;
mod ai_sessions;
mod commands;
mod connection;
mod db;
mod health;
mod identity_cache;
mod keychain;
mod known_hosts;
mod local_fs;
mod menu;
mod models;
mod operation_history;
mod path_utils;
mod port_forward;
mod remote_fs;
mod remote_health;
mod runbook;
mod session;
mod sftp_pool;

use log::LevelFilter;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind, WEBVIEW_TARGET};

use crate::sftp_pool::SftpPool;
use models::{
    ClosedEvent, ClosedReasonKind, DeleteCancellationRegistry, PreflightCancellationRegistry,
};
use models::{
    DownloadCancellationRegistry, RemoteCopyCancellationRegistry, RemoteHealthCancellationRegistry,
    RunbookCancellationRegistry, SessionErrorEvent, SessionIdentity, SessionManager, SessionStatus,
    StatusEvent, UploadCancellationRegistry,
};

pub(crate) use connection::{
    summarize_remote_connection_request, summarize_session_request, validate_connection_fields,
};
pub(crate) use identity_cache::RemoteIdentityCache;
pub(crate) use local_fs::{
    copy_local_paths_blocking, paste_local_paths_blocking, read_local_file_blocking,
    rename_local_path_blocking, trash_local_paths_blocking,
};
pub(crate) use path_utils::{portable_local_path, posix_join};
pub(crate) use remote_fs::{
    copy_remote_path_blocking, copy_remote_to_remote_blocking, create_remote_entry_blocking,
    delete_remote_path_blocking, download_remote_paths_blocking, list_remote_directory_blocking,
    open_remote_file_blocking, read_remote_file_blocking, rename_remote_path_blocking,
    resolve_remote_entry_owners_blocking, update_remote_permissions_blocking,
    upload_local_paths_blocking, warm_remote_connection_blocking,
};
pub(crate) use session::{
    classify_closed_reason, is_transport_disconnect_message, run_ssh_session, session_wake_pair,
    SessionWakeSource,
};

pub(crate) const SSH_DATA_EVENT_PREFIX: &str = "ssh-data:";
pub(crate) const SSH_STATUS_EVENT: &str = "ssh-status";
pub(crate) const SSH_CLOSED_EVENT: &str = "ssh-closed";
pub(crate) const SSH_SESSION_ERROR_EVENT: &str = "ssh-session-error";
pub(crate) const UPLOAD_PROGRESS_EVENT: &str = "upload-progress";
pub(crate) const DELETE_PROGRESS_EVENT: &str = "delete-progress";
pub(crate) const DOWNLOAD_PROGRESS_EVENT: &str = "download-progress";
pub(crate) const REMOTE_COPY_PROGRESS_EVENT: &str = "remote-copy-progress";

pub(crate) fn emit_status(
    app: &AppHandle,
    session_id: &str,
    status: SessionStatus,
    message: Option<String>,
) -> Result<(), String> {
    let event = StatusEvent {
        session_id: session_id.to_string(),
        status,
        message,
    };
    if let Some(sessions) = app.try_state::<SessionManager>() {
        let _ = sessions.set_status(session_id, event.clone());
    }
    app.emit(SSH_STATUS_EVENT, event)
        .map_err(|error| format!("failed to emit status event: {error}"))
}

pub(crate) fn emit_data(app: &AppHandle, session_id: &str, chunk: String) -> Result<(), String> {
    app.emit(&format!("{SSH_DATA_EVENT_PREFIX}{session_id}"), chunk)
        .map_err(|error| format!("failed to emit data event: {error}"))
}

/// Incrementally decodes UTF-8 from `pending_bytes` into `output`. An
/// incomplete multi-byte sequence at the tail stays in `pending_bytes` for
/// the next call; invalid bytes are replaced with U+FFFD.
pub(crate) fn drain_decoded_output(pending_bytes: &mut Vec<u8>, output: &mut String) {
    loop {
        match std::str::from_utf8(pending_bytes) {
            Ok(text) => {
                output.push_str(text);
                pending_bytes.clear();
                return;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                output.push_str(
                    std::str::from_utf8(&pending_bytes[..valid_up_to])
                        .expect("valid_up_to marks a valid UTF-8 prefix"),
                );
                match error.error_len() {
                    Some(invalid_len) => {
                        output.push('\u{FFFD}');
                        pending_bytes.drain(..valid_up_to + invalid_len);
                    }
                    None => {
                        pending_bytes.drain(..valid_up_to);
                        return;
                    }
                }
            }
        }
    }
}

/// Emits whatever decoded output remains when a session ends, lossy-decoding
/// any bytes still stuck in the incremental decode buffer. Emit failures are
/// logged and swallowed: the session is ending anyway, so a dead frontend
/// listener must not mask the real session result.
pub(crate) fn flush_pending_output(
    app: &AppHandle,
    session_id: &str,
    pending_bytes: &mut Vec<u8>,
    pending_output: &mut String,
) {
    if !pending_bytes.is_empty() {
        pending_output.push_str(&String::from_utf8_lossy(pending_bytes));
        pending_bytes.clear();
    }
    if !pending_output.is_empty() {
        if let Err(error) = emit_data(app, session_id, std::mem::take(pending_output)) {
            log::warn!("Failed to emit final session output session_id={session_id}: {error}");
        }
    }
}

pub(crate) fn emit_closed(
    app: &AppHandle,
    session_id: &str,
    identity: Option<SessionIdentity>,
    reason: Option<String>,
    reason_kind: ClosedReasonKind,
    retryable: bool,
) -> Result<(), String> {
    app.emit(
        SSH_CLOSED_EVENT,
        ClosedEvent {
            session_id: session_id.to_string(),
            identity,
            reason,
            reason_kind,
            retryable,
        },
    )
    .map_err(|error| format!("failed to emit closed event: {error}"))
}

pub(crate) fn emit_session_error(app: &AppHandle, event: SessionErrorEvent) -> Result<(), String> {
    app.emit(SSH_SESSION_ERROR_EVENT, event)
        .map_err(|error| format!("failed to emit session error event: {error}"))
}

pub fn run() {
    let log_level = if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };

    let backend_log_target = Target::new(TargetKind::LogDir {
        file_name: Some("backend".into()),
    })
    .filter(|metadata| !metadata.target().starts_with(WEBVIEW_TARGET));
    let frontend_log_target = Target::new(TargetKind::LogDir {
        file_name: Some("frontend".into()),
    })
    .filter(|metadata| metadata.target().starts_with(WEBVIEW_TARGET));
    let log_targets = if cfg!(debug_assertions) {
        vec![
            Target::new(TargetKind::Stdout),
            backend_log_target,
            frontend_log_target,
        ]
    } else {
        vec![backend_log_target, frontend_log_target]
    };

    let builder = tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_title("").ok();
                }
            }
            let termbridge_dir = app.path().home_dir()?.join(".termbridge");
            let database = db::Database::open(&termbridge_dir.join("termbridge.db"))?;
            let credentials = keychain::CredentialManager::new();
            if let Err(error) = ai::migrate_legacy_api_keys(&credentials, &database) {
                log::warn!("Failed to migrate legacy AI API keys to the system keychain: {error}");
            }
            app.manage(credentials);
            app.manage(database);
            #[cfg(not(target_os = "macos"))]
            menu::initialize_tray(app)?;
            Ok(())
        })
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log_level)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(10))
                .max_file_size(2 * 1024 * 1024)
                .targets(log_targets)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SessionManager::default())
        .manage(ai::AiRequestRegistry::default())
        .manage(UploadCancellationRegistry::default())
        .manage(DeleteCancellationRegistry::default())
        .manage(PreflightCancellationRegistry::default())
        .manage(RemoteHealthCancellationRegistry::default())
        .manage(RunbookCancellationRegistry::default())
        .manage(DownloadCancellationRegistry::default())
        .manage(RemoteCopyCancellationRegistry::default())
        .manage(port_forward::PortForwardManager::default())
        .manage(SftpPool::default())
        .manage(RemoteIdentityCache::default())
        .manage(health::HealthState::default())
        .invoke_handler(tauri::generate_handler![
            ai::ai_store_api_key,
            ai::ai_has_api_key,
            ai::ai_delete_api_key,
            ai::ai_list_models,
            ai::ai_start_request,
            ai::ai_cancel_request,
            ai_sessions::create_ai_session,
            ai_sessions::append_ai_session_message,
            ai_sessions::clear_ai_session_lane,
            ai_sessions::archive_ai_session,
            ai_sessions::list_ai_sessions,
            ai_sessions::load_ai_session,
            commands::create_session,
            commands::create_local_session,
            commands::write_session,
            commands::get_session_status,
            commands::mark_session_ready,
            commands::set_session_output_paused,
            commands::resize_session,
            commands::close_session,
            commands::request_app_restart,
            commands::request_app_exit,
            commands::list_remote_directory,
            commands::resolve_remote_entry_owners,
            commands::warm_remote_connection,
            commands::create_remote_entry,
            commands::rename_remote_path,
            commands::delete_remote_path,
            commands::copy_remote_path,
            commands::copy_remote_to_remote,
            commands::cancel_remote_copy,
            commands::upload_local_paths,
            commands::copy_local_paths,
            commands::rename_local_path,
            commands::paste_local_paths,
            commands::trash_local_paths,
            commands::cancel_upload,
            commands::cancel_delete,
            commands::download_remote_paths,
            commands::cancel_download,
            commands::disconnect_sftp,
            commands::pick_local_files,
            commands::pick_local_folder,
            commands::open_path,
            commands::pick_private_key_file,
            commands::open_remote_file,
            commands::preview_local_file,
            commands::preview_remote_file,
            commands::update_remote_permissions,
            commands::check_host_key,
            commands::preflight_connection,
            commands::cancel_connection_preflight,
            commands::trust_host,
            commands::list_known_hosts,
            commands::remove_known_host,
            commands::list_log_files,
            commands::read_log_file,
            commands::export_log_file,
            commands::list_local_directory,
            commands::store_key_credential,
            commands::list_key_credentials,
            commands::retrieve_key_credential,
            commands::delete_key_credential,
            commands::store_profile_password,
            commands::retrieve_profile_password,
            commands::delete_profile_password,
            commands::store_profile_secret,
            commands::retrieve_profile_secret,
            commands::delete_profile_secrets,
            commands::delete_profile_secret,
            commands::read_text_file,
            commands::start_port_forward,
            commands::stop_port_forward,
            commands::stop_all_port_forwards,
            commands::list_port_forwards,
            commands::open_url,
            commands::list_profiles,
            commands::add_profile,
            commands::update_profile,
            commands::remove_profile,
            commands::load_preferences,
            commands::save_preferences,
            commands::list_recent_profiles,
            commands::touch_recent_profile,
            commands::remove_recent_profile,
            commands::list_sftp_bookmarks,
            commands::add_sftp_bookmark,
            commands::remove_sftp_bookmark,
            commands::load_terminal_workspace,
            commands::save_terminal_workspace,
            commands::clear_terminal_workspace,
            commands::load_sftp_workspace,
            commands::save_sftp_workspace,
            commands::clear_sftp_workspace,
            operation_history::record_operation_event,
            operation_history::list_operation_history,
            operation_history::get_operation_history_settings,
            operation_history::set_operation_history_retention,
            operation_history::clear_operation_history,
            operation_history::export_operation_history,
            health::get_system_health,
            remote_health::collect_remote_health_snapshot,
            remote_health::cancel_remote_health_snapshot,
            runbook::execute_runbook_step,
            runbook::cancel_runbook_step,
            runbook::open_runbook_file,
            runbook::save_runbook_file,
        ]);

    menu::configure_builder(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_decoded_output_holds_split_multibyte_sequence() {
        let mut pending_bytes = Vec::new();
        let mut output = String::new();
        // U+6C49 (汉) is three bytes; feed it split across two drains.
        pending_bytes.extend_from_slice(&[0xE6, 0xB1]);
        drain_decoded_output(&mut pending_bytes, &mut output);
        assert_eq!(output, "");
        assert_eq!(pending_bytes, vec![0xE6, 0xB1]);

        pending_bytes.extend_from_slice(&[0x89, b'!']);
        drain_decoded_output(&mut pending_bytes, &mut output);
        assert_eq!(output, "汉!");
        assert!(pending_bytes.is_empty());
    }

    #[test]
    fn drain_decoded_output_replaces_invalid_bytes() {
        let mut pending_bytes = vec![b'a', 0xFF, b'b'];
        let mut output = String::new();
        drain_decoded_output(&mut pending_bytes, &mut output);
        assert_eq!(output, "a\u{FFFD}b");
        assert!(pending_bytes.is_empty());
    }
}
