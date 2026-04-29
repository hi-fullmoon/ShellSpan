mod commands;
mod connection;
mod keychain;
mod known_hosts;
mod menu;
mod models;
mod port_forward;
mod remote_fs;
mod session;

use log::LevelFilter;
use tauri::{AppHandle, Emitter, Manager};

use models::{ClosedEvent, ClosedReasonKind, DataEvent, DeleteCancellationRegistry};
use models::{DownloadCancellationRegistry, SessionManager, SessionStatus, StatusEvent, UploadCancellationRegistry};

pub(crate) use connection::{
    summarize_remote_connection_request, summarize_session_request, validate_connection_fields,
};
pub(crate) use remote_fs::{
    copy_remote_path_blocking, create_remote_entry_blocking, delete_remote_path_blocking,
    download_remote_paths_blocking, list_remote_directory_blocking, open_remote_file_blocking,
    rename_remote_path_blocking, update_remote_permissions_blocking, upload_local_paths_blocking,
};
pub(crate) use session::{
    classify_closed_reason, is_transport_disconnect_message, run_ssh_session,
};

pub(crate) const SSH_DATA_EVENT: &str = "ssh-data";
pub(crate) const SSH_STATUS_EVENT: &str = "ssh-status";
pub(crate) const SSH_CLOSED_EVENT: &str = "ssh-closed";
pub(crate) const UPLOAD_PROGRESS_EVENT: &str = "upload-progress";
pub(crate) const DELETE_PROGRESS_EVENT: &str = "delete-progress";
pub(crate) const DOWNLOAD_PROGRESS_EVENT: &str = "download-progress";

pub(crate) fn emit_status(
    app: &AppHandle,
    session_id: &str,
    status: SessionStatus,
    message: Option<String>,
) -> Result<(), String> {
    app.emit(
        SSH_STATUS_EVENT,
        StatusEvent {
            session_id: session_id.to_string(),
            status,
            message,
        },
    )
    .map_err(|error| format!("failed to emit status event: {error}"))
}

pub(crate) fn emit_data(app: &AppHandle, session_id: &str, chunk: String) -> Result<(), String> {
    app.emit(
        SSH_DATA_EVENT,
        DataEvent {
            session_id: session_id.to_string(),
            chunk,
        },
    )
    .map_err(|error| format!("failed to emit data event: {error}"))
}

pub(crate) fn emit_closed(
    app: &AppHandle,
    session_id: &str,
    reason: Option<String>,
    reason_kind: ClosedReasonKind,
    retryable: bool,
) -> Result<(), String> {
    app.emit(
        SSH_CLOSED_EVENT,
        ClosedEvent {
            session_id: session_id.to_string(),
            reason,
            reason_kind,
            retryable,
        },
    )
    .map_err(|error| format!("failed to emit closed event: {error}"))
}

pub fn run() {
    let log_level = if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };
    let log_targets = if cfg!(debug_assertions) {
        vec![
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("termbridge".to_string()),
            }),
        ]
    } else {
        vec![tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("termbridge".to_string()),
            },
        )]
    };

    let builder = tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_title("").ok();
                }
            }
            Ok(())
        })
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log_level)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(10))
                .max_file_size(1_048_576)
                .targets(log_targets)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SessionManager::default())
        .manage(UploadCancellationRegistry::default())
        .manage(DeleteCancellationRegistry::default())
        .manage(DownloadCancellationRegistry::default())
        .manage(port_forward::PortForwardManager::default())
        .invoke_handler(tauri::generate_handler![
            commands::create_session,
            commands::write_session,
            commands::resize_session,
            commands::close_session,
            commands::request_app_restart,
            commands::request_app_exit,
            commands::list_remote_directory,
            commands::create_remote_entry,
            commands::rename_remote_path,
            commands::delete_remote_path,
            commands::copy_remote_path,
            commands::upload_local_paths,
            commands::cancel_upload,
            commands::cancel_delete,
            commands::download_remote_paths,
            commands::cancel_download,
            commands::pick_local_files,
            commands::pick_local_folder,
            commands::pick_private_key_file,
            commands::open_remote_file,
            commands::update_remote_permissions,
            commands::check_host_key,
            commands::trust_host,
            commands::store_password,
            commands::retrieve_password,
            commands::remove_password,
            commands::migrate_passwords,
            commands::start_port_forwards,
            commands::stop_port_forwards,
        ]);

    menu::configure_builder(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
