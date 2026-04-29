use super::*;
use crate::models::{
    AuthMethod, ClosedReasonKind, CopyRemotePathRequest, CreateRemoteEntryRequest,
    DeleteRemotePathRequest, DownloadRemotePathsRequest, HostKeyCheckRequest, HostKeyCheckResult,
    JumpHostConfig, ManagedSession, OpenRemoteFileRequest, PortForwardConfig,
    RemoteDirectoryListing, RemoteDirectoryRequest, RenameRemotePathRequest, SessionCommand,
    SessionCreateRequest, SessionStatus, SessionSummary, TrustHostRequest,
    UpdateRemotePermissionsRequest, UploadLocalPathsRequest,
};
use log::{debug, error, info, warn};
use std::sync::{
    atomic::AtomicBool,
    Arc, mpsc,
};
use std::thread;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub(crate) fn create_session(
    app: AppHandle,
    state: State<'_, SessionManager>,
    request: SessionCreateRequest,
) -> Result<SessionSummary, String> {
    validate_connection_fields(&request.host, &request.username)?;
    info!(
        "Creating SSH session {}",
        summarize_session_request(&request)
    );

    let session_id = Uuid::new_v4().to_string();
    let summary = SessionSummary {
        session_id: session_id.clone(),
        title: request.name.clone(),
        host: request.host.clone(),
        port: request.port,
        username: request.username.clone(),
    };

    let (tx, rx) = mpsc::channel::<SessionCommand>();
    state.insert(session_id.clone(), ManagedSession { sender: tx })?;

    info!(
        "Created SSH session session_id={} title={} host={} port={} username={}",
        session_id, summary.title, summary.host, summary.port, summary.username
    );
    spawn_ssh_thread(app, session_id, request, rx);
    Ok(summary)
}

#[tauri::command]
pub(crate) fn write_session(
    state: State<'_, SessionManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let result = state.send(&session_id, SessionCommand::Write(data));
    if let Err(error) = &result {
        warn!("Failed to write SSH session input session_id={session_id}: {error}");
    }
    result
}

#[tauri::command]
pub(crate) fn resize_session(
    state: State<'_, SessionManager>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let result = state.send(&session_id, SessionCommand::Resize { cols, rows });
    if let Err(error) = &result {
        warn!(
            "Failed to resize SSH session session_id={} cols={} rows={}: {}",
            session_id, cols, rows, error
        );
    }
    result
}

#[tauri::command]
pub(crate) fn close_session(
    state: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    info!("Closing SSH session session_id={session_id}");
    let result = state.send(&session_id, SessionCommand::Close);
    let _ = state.remove(&session_id);
    if let Err(error) = &result {
        warn!("Failed to close SSH session session_id={session_id}: {error}");
    }
    result
}

#[tauri::command]
pub(crate) fn request_app_restart(app: AppHandle) {
    info!("Requesting application restart");
    app.request_restart();
}

#[tauri::command]
pub(crate) fn request_app_exit(app: AppHandle) {
    info!("Requesting application exit");
    app.exit(0);
}

#[tauri::command]
pub(crate) async fn list_remote_directory(
    request: RemoteDirectoryRequest,
) -> Result<RemoteDirectoryListing, String> {
    let requested_path = request.path.clone().unwrap_or_else(|| ".".to_string());
    debug!(
        "Listing remote directory path={} {}",
        requested_path,
        summarize_remote_connection_request(&request.connection)
    );
    let result =
        tauri::async_runtime::spawn_blocking(move || list_remote_directory_blocking(request))
            .await
            .map_err(|error| format!("failed to join directory listing task: {error}"))?;
    if let Ok(listing) = &result {
        debug!(
            "Listed remote directory path={} entries={}",
            listing.path,
            listing.entries.len()
        );
    }
    result
}

#[tauri::command]
pub(crate) async fn create_remote_entry(request: CreateRemoteEntryRequest) -> Result<(), String> {
    info!(
        "Creating remote entry parent_path={} name={} kind={:?} {}",
        request.parent_path,
        request.name,
        request.kind,
        summarize_remote_connection_request(&request.connection)
    );
    let result =
        tauri::async_runtime::spawn_blocking(move || create_remote_entry_blocking(request))
            .await
            .map_err(|error| format!("failed to join create entry task: {error}"))?;
    if result.is_ok() {
        info!("Created remote entry successfully");
    }
    result
}

#[tauri::command]
pub(crate) async fn rename_remote_path(request: RenameRemotePathRequest) -> Result<(), String> {
    info!(
        "Renaming remote path path={} new_name={} {}",
        request.path,
        request.new_name,
        summarize_remote_connection_request(&request.connection)
    );
    let result = tauri::async_runtime::spawn_blocking(move || rename_remote_path_blocking(request))
        .await
        .map_err(|error| format!("failed to join rename task: {error}"))?;
    if result.is_ok() {
        info!("Renamed remote path successfully");
    }
    result
}

#[tauri::command]
pub(crate) async fn delete_remote_path(
    app: AppHandle,
    deletes: State<'_, DeleteCancellationRegistry>,
    request: DeleteRemotePathRequest,
) -> Result<(), String> {
    info!(
        "Deleting remote path operation_id={} path={} {}",
        request.operation_id,
        request.path,
        summarize_remote_connection_request(&request.connection)
    );
    let cancel_flag = deletes.register(request.operation_id.clone())?;
    let operation_id = request.operation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        delete_remote_path_blocking(app, request, cancel_flag)
    })
    .await
    .map_err(|error| format!("failed to join delete task: {error}"))?;
    let _ = deletes.remove(&operation_id);
    if let Err(error) = &result {
        warn!("Delete remote path failed operation_id={operation_id}: {error}");
    } else {
        info!("Deleted remote path operation_id={operation_id}");
    }
    result
}

#[tauri::command]
pub(crate) async fn copy_remote_path(request: CopyRemotePathRequest) -> Result<(), String> {
    info!(
        "Copying remote path source_path={} destination_directory={} {}",
        request.source_path,
        request.destination_directory,
        summarize_remote_connection_request(&request.connection)
    );
    let result = tauri::async_runtime::spawn_blocking(move || copy_remote_path_blocking(request))
        .await
        .map_err(|error| format!("failed to join copy task: {error}"))?;
    if result.is_ok() {
        info!("Copied remote path successfully");
    }
    result
}

#[tauri::command]
pub(crate) async fn upload_local_paths(
    app: AppHandle,
    uploads: State<'_, UploadCancellationRegistry>,
    request: UploadLocalPathsRequest,
) -> Result<(), String> {
    info!(
        "Uploading local paths operation_id={} count={} destination_directory={} {}",
        request.operation_id,
        request.local_paths.len(),
        request.destination_directory,
        summarize_remote_connection_request(&request.connection)
    );
    let cancel_flag = uploads.register(request.operation_id.clone())?;
    let operation_id = request.operation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        upload_local_paths_blocking(app, request, cancel_flag)
    })
    .await
    .map_err(|error| format!("failed to join upload task: {error}"))?;
    let _ = uploads.remove(&operation_id);
    if let Err(error) = &result {
        warn!("Upload failed operation_id={operation_id}: {error}");
    } else {
        info!("Upload completed operation_id={operation_id}");
    }
    result
}

#[tauri::command]
pub(crate) fn cancel_upload(
    uploads: State<'_, UploadCancellationRegistry>,
    operation_id: String,
) -> Result<(), String> {
    info!("Cancelling upload operation_id={operation_id}");
    uploads.cancel(&operation_id)
}

#[tauri::command]
pub(crate) fn cancel_delete(
    deletes: State<'_, DeleteCancellationRegistry>,
    operation_id: String,
) -> Result<(), String> {
    info!("Cancelling delete operation_id={operation_id}");
    deletes.cancel(&operation_id)
}

#[tauri::command]
pub(crate) async fn download_remote_paths(
    app: AppHandle,
    downloads: State<'_, DownloadCancellationRegistry>,
    request: DownloadRemotePathsRequest,
) -> Result<(), String> {
    info!(
        "Downloading remote paths operation_id={} count={} destination_directory={} {}",
        request.operation_id,
        request.remote_paths.len(),
        request.destination_directory,
        summarize_remote_connection_request(&request.connection)
    );
    let cancel_flag = downloads.register(request.operation_id.clone())?;
    let operation_id = request.operation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        download_remote_paths_blocking(app, request, cancel_flag)
    })
    .await
    .map_err(|error| format!("failed to join download task: {error}"))?;
    let _ = downloads.remove(&operation_id);
    if let Err(error) = &result {
        warn!("Download failed operation_id={operation_id}: {error}");
    } else {
        info!("Download completed operation_id={operation_id}");
    }
    result
}

#[tauri::command]
pub(crate) fn cancel_download(
    downloads: State<'_, DownloadCancellationRegistry>,
    operation_id: String,
) -> Result<(), String> {
    info!("Cancelling download operation_id={operation_id}");
    downloads.cancel(&operation_id)
}

#[tauri::command]
pub(crate) fn pick_local_files() -> Result<Vec<String>, String> {
    let paths = rfd::FileDialog::new()
        .set_title("选择要上传的文件")
        .pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    Ok(paths)
}

#[tauri::command]
pub(crate) fn pick_local_folder() -> Result<Vec<String>, String> {
    let path = rfd::FileDialog::new()
        .set_title("选择要上传的文件夹")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string());
    Ok(path.into_iter().collect())
}

#[tauri::command]
pub(crate) async fn open_remote_file(request: OpenRemoteFileRequest) -> Result<(), String> {
    info!(
        "Opening remote file path={} {}",
        request.path,
        summarize_remote_connection_request(&request.connection)
    );
    let result = tauri::async_runtime::spawn_blocking(move || open_remote_file_blocking(request))
        .await
        .map_err(|error| format!("failed to join open file task: {error}"))?;
    if result.is_ok() {
        info!("Opened remote file successfully");
    }
    result
}

#[tauri::command]
pub(crate) async fn update_remote_permissions(
    request: UpdateRemotePermissionsRequest,
) -> Result<(), String> {
    info!(
        "Updating remote permissions path={} permissions={:04o} {}",
        request.path,
        request.permissions,
        summarize_remote_connection_request(&request.connection)
    );
    let result =
        tauri::async_runtime::spawn_blocking(move || update_remote_permissions_blocking(request))
            .await
            .map_err(|error| format!("failed to join permissions update task: {error}"))?;
    if result.is_ok() {
        info!("Updated remote permissions successfully");
    }
    result
}

#[tauri::command]
pub(crate) fn store_password(profile_id: String, password: String) -> Result<(), String> {
    crate::keychain::set_password(&profile_id, &password)
}

#[tauri::command]
pub(crate) fn retrieve_password(profile_id: String) -> Result<Option<String>, String> {
    crate::keychain::get_password(&profile_id)
}

#[tauri::command]
pub(crate) fn remove_password(profile_id: String) -> Result<(), String> {
    crate::keychain::delete_password(&profile_id)
}

#[tauri::command]
pub(crate) fn migrate_passwords(
    profiles: Vec<(String, String)>,
) -> Result<Vec<(String, bool)>, String> {
    Ok(crate::keychain::migrate_passwords(&profiles))
}

#[tauri::command]
pub(crate) fn start_port_forwards(
    forwards_state: State<'_, crate::port_forward::PortForwardManager>,
    operation_id: String,
    host: String,
    port: u16,
    username: String,
    auth_method: AuthMethod,
    password: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
    jump_host: Option<JumpHostConfig>,
    forwards: Vec<PortForwardConfig>,
) -> Result<(), String> {
    info!("Starting port forwards operation_id={operation_id} count={}", forwards.len());

    let cancel_flag = Arc::new(AtomicBool::new(false));
    forwards_state.register(operation_id.clone(), cancel_flag.clone())?;

    let manager = (&*forwards_state).clone();
    thread::spawn(move || {
        crate::port_forward::start_port_forwards(
            manager, operation_id,
            host, port, username, auth_method,
            password, private_key_path, passphrase,
            jump_host, forwards, cancel_flag,
        );
    });

    Ok(())
}

#[tauri::command]
pub(crate) fn stop_port_forwards(
    forwards_state: State<'_, crate::port_forward::PortForwardManager>,
    operation_id: String,
) -> Result<(), String> {
    info!("Stopping port forwards operation_id={operation_id}");
    forwards_state.cancel(&operation_id)
}

#[tauri::command]
pub(crate) async fn check_host_key(
    app: AppHandle,
    request: HostKeyCheckRequest,
) -> Result<HostKeyCheckResult, String> {
    info!("Checking host key for {}:{}", request.host, request.port);
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::known_hosts::check_host_key_blocking(&app, &request)
    })
    .await
    .map_err(|error| format!("failed to join host key check task: {error}"))?;
    match &result {
        Ok(r) => info!("Host key check result: {:?}", r.status),
        Err(e) => warn!("Host key check failed: {e}"),
    }
    result
}

#[tauri::command]
pub(crate) async fn trust_host(
    app: AppHandle,
    request: TrustHostRequest,
) -> Result<(), String> {
    info!("Trusting host {}:{}", request.host, request.port);
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::known_hosts::trust_host_blocking(&app, &request)
    })
    .await
    .map_err(|error| format!("failed to join trust host task: {error}"))?;
    if result.is_ok() {
        info!("Host trusted successfully");
    }
    result
}

pub(crate) fn spawn_ssh_thread(
    app: AppHandle,
    session_id: String,
    request: SessionCreateRequest,
    rx: std::sync::mpsc::Receiver<SessionCommand>,
) {
    thread::spawn(move || {
        debug!("Spawned SSH worker session_id={session_id}");
        let run_result = run_ssh_session(&app, &session_id, &request, rx);

        match run_result {
            Ok(message) => {
                let (reason_kind, retryable) =
                    classify_closed_reason(message.as_deref(), SessionStatus::Disconnected);
                info!(
                    "SSH session ended session_id={} reason={}",
                    session_id,
                    message.as_deref().unwrap_or("remote shell closed")
                );
                let _ = emit_status(
                    &app,
                    &session_id,
                    SessionStatus::Disconnected,
                    message.clone(),
                );
                let _ = emit_closed(&app, &session_id, message, reason_kind, retryable);
            }
            Err(error) => {
                error!("SSH session failed session_id={session_id}: {error}");
                let retryable = is_transport_disconnect_message(&error);
                let _ = emit_status(&app, &session_id, SessionStatus::Error, Some(error.clone()));
                let _ = emit_closed(
                    &app,
                    &session_id,
                    Some(error),
                    if retryable {
                        ClosedReasonKind::TransportDisconnect
                    } else {
                        ClosedReasonKind::Error
                    },
                    retryable,
                );
            }
        }
    });
}
