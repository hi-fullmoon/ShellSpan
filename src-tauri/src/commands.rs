use super::*;
use crate::sftp_pool::SftpPool;
use crate::models::{
    AuthMethod, ClosedReasonKind, CopyRemotePathRequest, CreateRemoteEntryRequest,
    CreateSessionError, DeleteRemotePathRequest, DownloadRemotePathsRequest, HostKeyCheckRequest,
    HostKeyCheckResult, HostKeyCheckStatus, JumpHostConfig, KnownHostEntry, LocalDirectoryListing,
    LocalFileEntry, LogFileInfo, ManagedSession, OpenRemoteFileRequest, PortForwardConfig,
    ReadRemoteFileRequest, ReadRemoteFileResponse, RemoteConnectionRequest, RemoteDirectoryListing,
    RemoteDirectoryRequest, RemoteFileKind, RenameRemotePathRequest, SessionCommand,
    SessionCreateRequest, SessionStatus, SessionSummary, TrustHostRequest,
    UpdateRemotePermissionsRequest, UploadLocalPathsRequest,
};
use log::{debug, error, info, warn};
use base64::Engine;
use std::sync::{
    atomic::AtomicBool,
    Arc, mpsc,
};
use std::thread;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub(crate) async fn create_session(
    app: AppHandle,
    state: State<'_, SessionManager>,
    pool: State<'_, SftpPool>,
    request: SessionCreateRequest,
) -> Result<SessionSummary, CreateSessionError> {
    validate_connection_fields(&request.host, &request.username).map_err(|message| {
        CreateSessionError::Other { message }
    })?;
    info!(
        "Creating SSH session {}",
        summarize_session_request(&request)
    );

    let session_id = Uuid::new_v4().to_string();

    if request.jump_host.is_none() {
        let host_key_check = {
            let app = app.clone();
            let host = request.host.clone();
            let port = request.port;
            tauri::async_runtime::spawn_blocking(move || {
                crate::known_hosts::check_host_key_blocking(
                    &app,
                    &HostKeyCheckRequest { host, port },
                )
            })
            .await
            .map_err(|error| CreateSessionError::Other {
                message: format!("failed to join host key check task: {error}"),
            })?
            .map_err(|message| {
                if let Some(kind) = crate::known_hosts::classify_host_key_error(&message) {
                    match kind {
                        crate::known_hosts::HostKeyErrorKind::Unknown => {
                            CreateSessionError::HostKeyUnknown {
                                host: request.host.clone(),
                                port: request.port,
                                fingerprint: None,
                            }
                        }
                        crate::known_hosts::HostKeyErrorKind::Mismatch => {
                            CreateSessionError::HostKeyMismatch {
                                host: request.host.clone(),
                                port: request.port,
                            }
                        }
                    }
                } else {
                    CreateSessionError::Other { message }
                }
            })?
        };

        match host_key_check.status {
            HostKeyCheckStatus::Match => {}
            HostKeyCheckStatus::NotFound => {
                return Err(CreateSessionError::HostKeyUnknown {
                    host: request.host.clone(),
                    port: request.port,
                    fingerprint: host_key_check.fingerprint,
                });
            }
            HostKeyCheckStatus::Mismatch => {
                return Err(CreateSessionError::HostKeyMismatch {
                    host: request.host.clone(),
                    port: request.port,
                });
            }
            HostKeyCheckStatus::Failure => {
                return Err(CreateSessionError::Other {
                    message: host_key_check
                        .message
                        .unwrap_or_else(|| "host key check failed".to_string()),
                });
            }
        }
    }

    let summary = SessionSummary {
        session_id: session_id.clone(),
        title: request.name.clone(),
        host: request.host.clone(),
        port: request.port,
        username: request.username.clone(),
    };

    let (tx, rx) = mpsc::channel::<SessionCommand>();
    state.insert(session_id.clone(), ManagedSession { sender: tx }).map_err(|message| CreateSessionError::Other { message })?;

    info!(
        "Created SSH session session_id={} title={} host={} port={} username={}",
        session_id, summary.title, summary.host, summary.port, summary.username
    );
    let connection_request = remote_connection_request_from_session(&request);
    spawn_ssh_thread(app, session_id, request, rx, pool.inner().clone(), connection_request);
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
    match &result {
        Ok(()) => {
            let _ = state.remove(&session_id);
        }
        Err(error) => {
            let remove_result = state.remove(&session_id);
            warn!(
                "Failed to close SSH session session_id={session_id}: {error} (remove result: {remove_result:?})"
            );
        }
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
    app: AppHandle,
    request: RemoteDirectoryRequest,
    pool: State<'_, SftpPool>,
    cache: State<'_, RemoteIdentityCache>,
) -> Result<RemoteDirectoryListing, String> {
    let requested_path = request.path.clone().unwrap_or_else(|| ".".to_string());
    debug!(
        "Listing remote directory path={} {}",
        requested_path,
        summarize_remote_connection_request(&request.connection)
    );
    let pool = pool.inner().clone();
    let cache = cache.inner().clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let result = tauri::async_runtime::spawn_blocking(move || {
        list_remote_directory_blocking(request, Some(&pool), Some(&cache), known_hosts.as_deref())
    })
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
pub(crate) async fn create_remote_entry(
    app: AppHandle,
    request: CreateRemoteEntryRequest,
    pool: State<'_, SftpPool>,
) -> Result<(), String> {
    info!(
        "Creating remote entry parent_path={} name={} kind={:?} {}",
        request.parent_path,
        request.name,
        request.kind,
        summarize_remote_connection_request(&request.connection)
    );
    let pool = pool.inner().clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let result = tauri::async_runtime::spawn_blocking(move || {
        create_remote_entry_blocking(request, Some(&pool), known_hosts.as_deref())
    })
    .await
    .map_err(|error| format!("failed to join create entry task: {error}"))?;
    if result.is_ok() {
        info!("Created remote entry successfully");
    }
    result
}

#[tauri::command]
pub(crate) async fn rename_remote_path(
    app: AppHandle,
    request: RenameRemotePathRequest,
    pool: State<'_, SftpPool>,
) -> Result<(), String> {
    info!(
        "Renaming remote path path={} new_name={} {}",
        request.path,
        request.new_name,
        summarize_remote_connection_request(&request.connection)
    );
    let pool = pool.inner().clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let result = tauri::async_runtime::spawn_blocking(move || {
        rename_remote_path_blocking(request, Some(&pool), known_hosts.as_deref())
    })
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
    pool: State<'_, SftpPool>,
) -> Result<(), String> {
    info!(
        "Deleting remote path operation_id={} path={} {}",
        request.operation_id,
        request.path,
        summarize_remote_connection_request(&request.connection)
    );
    let cancel_flag = deletes.register(request.operation_id.clone())?;
    let operation_id = request.operation_id.clone();
    let pool = pool.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        delete_remote_path_blocking(app, request, cancel_flag, Some(&pool))
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
pub(crate) async fn copy_remote_path(
    app: AppHandle,
    request: CopyRemotePathRequest,
    pool: State<'_, SftpPool>,
) -> Result<(), String> {
    info!(
        "Copying remote path source_path={} destination_directory={} {}",
        request.source_path,
        request.destination_directory,
        summarize_remote_connection_request(&request.connection)
    );
    let pool = pool.inner().clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let result = tauri::async_runtime::spawn_blocking(move || {
        copy_remote_path_blocking(request, Some(&pool), known_hosts.as_deref())
    })
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
    pool: State<'_, SftpPool>,
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
    let pool = pool.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        upload_local_paths_blocking(app, request, cancel_flag, Some(&pool))
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
    pool: State<'_, SftpPool>,
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
    let pool = pool.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        download_remote_paths_blocking(app, request, cancel_flag, Some(&pool))
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
pub(crate) fn open_path(path: String) -> Result<(), String> {
    let path = std::path::Path::new(&path);
    if !path.exists() {
        return Err(format!("path does not exist: {}", path.display()));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize path: {error}"))?;

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&canonical)
            .spawn()
            .map_err(|error| format!("failed to open path: {error}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        let explorer_path = std::path::PathBuf::from(portable_local_path(&canonical));
        std::process::Command::new("explorer")
            .arg(explorer_path)
            .spawn()
            .map_err(|error| format!("failed to open path: {error}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&canonical)
            .spawn()
            .map_err(|error| format!("failed to open path: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn pick_local_files() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let paths = rfd::FileDialog::new()
            .set_title("选择要上传的文件")
            .pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|path| portable_local_path(&path))
            .collect::<Vec<_>>();
        Ok(paths)
    })
    .await
    .map_err(|error| format!("failed to run file dialog: {error}"))?
}

#[tauri::command]
pub(crate) async fn pick_local_folder(title: Option<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = rfd::FileDialog::new()
            .set_title(&title.unwrap_or_else(|| "选择文件夹".to_string()))
            .pick_folder()
            .map(|path| portable_local_path(&path));
        Ok(path.into_iter().collect())
    })
    .await
    .map_err(|error| format!("failed to run folder dialog: {error}"))?
}

#[tauri::command]
pub(crate) async fn pick_private_key_file() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = rfd::FileDialog::new()
            .set_title("选择私钥文件")
            .pick_file()
            .map(|path| portable_local_path(&path));
        Ok(path)
    })
    .await
    .map_err(|error| format!("failed to run key file dialog: {error}"))?
}

#[tauri::command]
pub(crate) async fn open_remote_file(
    app: AppHandle,
    request: OpenRemoteFileRequest,
    pool: State<'_, SftpPool>,
) -> Result<(), String> {
    info!(
        "Opening remote file path={} {}",
        request.path,
        summarize_remote_connection_request(&request.connection)
    );
    let pool = pool.inner().clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let result = tauri::async_runtime::spawn_blocking(move || {
        open_remote_file_blocking(request, Some(&pool), known_hosts.as_deref())
    })
    .await
    .map_err(|error| format!("failed to join open file task: {error}"))?;
    if result.is_ok() {
        info!("Opened remote file successfully");
    }
    result
}

#[tauri::command]
pub(crate) async fn preview_remote_file(
    app: AppHandle,
    request: ReadRemoteFileRequest,
    pool: State<'_, SftpPool>,
) -> Result<ReadRemoteFileResponse, String> {
    info!(
        "Previewing remote file path={} {}",
        request.path,
        summarize_remote_connection_request(&request.connection)
    );
    let pool = pool.inner().clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let result = tauri::async_runtime::spawn_blocking(move || {
        read_remote_file_blocking(request, Some(&pool), known_hosts.as_deref())
    })
    .await
    .map_err(|error| format!("failed to join file preview task: {error}"))?;
    if let Ok(ref response) = result {
        info!(
            "Previewed remote file path={} size={} is_text={}",
            response.path, response.size, response.is_text
        );
    }
    result
}

#[tauri::command]
pub(crate) async fn update_remote_permissions(
    app: AppHandle,
    request: UpdateRemotePermissionsRequest,
    pool: State<'_, SftpPool>,
) -> Result<(), String> {
    info!(
        "Updating remote permissions path={} permissions={:04o} {}",
        request.path,
        request.permissions,
        summarize_remote_connection_request(&request.connection)
    );
    let pool = pool.inner().clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let result = tauri::async_runtime::spawn_blocking(move || {
        update_remote_permissions_blocking(request, Some(&pool), known_hosts.as_deref())
    })
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
    app: AppHandle,
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
    validate_connection_fields(&host, &username)?;

    let cancel_flag = Arc::new(AtomicBool::new(false));
    forwards_state.register(operation_id.clone(), cancel_flag.clone())?;

    let manager = (&*forwards_state).clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app)
        .ok()
        .map(|p| p.to_string_lossy().to_string());
    thread::spawn(move || {
        crate::port_forward::start_port_forwards(
            manager, operation_id,
            host, port, username, auth_method,
            password, private_key_path, passphrase,
            jump_host, forwards, cancel_flag,
            known_hosts,
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

#[tauri::command]
pub(crate) fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    let allowed = lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:");
    if !allowed {
        return Err(format!("refused to open URL with disallowed scheme: {url}"));
    }
    if url.contains('\n') || url.contains('\r') {
        return Err("refused to open URL containing newline characters".to_string());
    }
    if contains_shell_metacharacters(&url) {
        return Err(format!("refused to open URL containing shell metacharacters: {url}"));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|error| format!("failed to open URL: {error}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|error| format!("failed to open URL: {error}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|error| format!("failed to open URL: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn list_known_hosts(app: AppHandle) -> Result<Vec<KnownHostEntry>, String> {
    use crate::known_hosts::known_hosts_path;
    use ssh2::{KnownHostFileKind, Session};
    use std::fs;

    let path = known_hosts_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path).map_err(|error| format!("failed to read known hosts file: {error}"))?;
    let session = Session::new().map_err(|error| format!("failed to create ssh session: {error}"))?;
    let mut known_hosts = session.known_hosts().map_err(|error| format!("failed to initialize known hosts: {error}"))?;

    if let Err(error) = known_hosts.read_file(&path, KnownHostFileKind::OpenSSH) {
        log::warn!("Failed to parse known hosts file: {error}");
    }

    let mut entries = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }

        let host_port = parts[0];
        let key_type_name = parts[1];
        let key_b64 = parts[2];

        let (host, port) = if let Some(stripped) = host_port.strip_prefix('[') {
            if let Some((host, port)) = stripped.split_once("]:") {
                let port = port.parse::<u16>().unwrap_or(22);
                (host.to_string(), port)
            } else {
                continue;
            }
        } else {
            (host_port.to_string(), 22)
        };

        let key = match base64::engine::general_purpose::STANDARD.decode(key_b64) {
            Ok(key) => key,
            Err(_) => continue,
        };

        let key_type = match key_type_name {
            "ssh-rsa" => ssh2::HostKeyType::Rsa,
            "ssh-dss" => ssh2::HostKeyType::Dss,
            "ecdsa-sha2-nistp256" => ssh2::HostKeyType::Ecdsa256,
            "ecdsa-sha2-nistp384" => ssh2::HostKeyType::Ecdsa384,
            "ecdsa-sha2-nistp521" => ssh2::HostKeyType::Ecdsa521,
            "ssh-ed25519" => ssh2::HostKeyType::Ed25519,
            _ => ssh2::HostKeyType::Unknown,
        };

        let fingerprint = crate::known_hosts::compute_fingerprint(&key, key_type);
        let type_prefix = match key_type {
            ssh2::HostKeyType::Rsa => "RSA",
            ssh2::HostKeyType::Dss => "DSA",
            ssh2::HostKeyType::Ecdsa256 | ssh2::HostKeyType::Ecdsa384 | ssh2::HostKeyType::Ecdsa521 => "ECDSA",
            ssh2::HostKeyType::Ed25519 => "ED25519",
            ssh2::HostKeyType::Unknown => "UNKNOWN",
        };

        entries.push(KnownHostEntry {
            host,
            port,
            fingerprint,
            key_type: type_prefix.to_string(),
        });
    }

    Ok(entries)
}

#[tauri::command]
pub(crate) fn remove_known_host(app: AppHandle, host: String, port: u16) -> Result<(), String> {
    use crate::known_hosts::known_hosts_path;
    use std::fs;

    let path = known_hosts_path(&app)?;
    if !path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&path).map_err(|error| format!("failed to read known hosts file: {error}"))?;
    let target_prefix = if port == 22 {
        format!("{host} ")
    } else {
        format!("[{host}]:{port} ")
    };

    let filtered: Vec<String> = content
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return true;
            }
            !trimmed.starts_with(&target_prefix)
        })
        .map(|line| line.to_string())
        .collect();

    fs::write(&path, filtered.join("\n")).map_err(|error| format!("failed to write known hosts file: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn list_log_files(app: AppHandle) -> Result<Vec<LogFileInfo>, String> {
    use std::fs;

    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("failed to resolve log dir: {error}"))?;

    if !log_dir.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    for entry in fs::read_dir(&log_dir).map_err(|error| format!("failed to read log dir: {error}"))? {
        let entry = entry.map_err(|error| format!("failed to read log dir entry: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("termbridge") {
            continue;
        }

        let metadata = entry.metadata().map_err(|error| format!("failed to read log file metadata: {error}"))?;
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);

        files.push(LogFileInfo {
            name,
            size: metadata.len(),
            modified_at,
        });
    }

    files.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    Ok(files)
}

#[tauri::command]
pub(crate) fn read_log_file(app: AppHandle, name: String) -> Result<String, String> {
    use std::fs;

    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("failed to resolve log dir: {error}"))?;
    let path = log_dir.join(&name);

    if !path.exists() {
        return Err(format!("log file not found: {name}"));
    }

    let metadata = fs::metadata(&path).map_err(|error| format!("failed to read log file metadata: {error}"))?;
    const MAX_SIZE: u64 = 2 * 1024 * 1024;
    let size = metadata.len().min(MAX_SIZE);

    let content = if size == metadata.len() {
        fs::read_to_string(&path).map_err(|error| format!("failed to read log file: {error}"))?
    } else {
        let mut file = fs::File::open(&path).map_err(|error| format!("failed to open log file: {error}"))?;
        use std::io::Read;
        let mut buffer = vec![0u8; size as usize];
        file.read_exact(&mut buffer)
            .map_err(|error| format!("failed to read log file: {error}"))?;
        String::from_utf8_lossy(&buffer).to_string()
    };

    Ok(content)
}

#[tauri::command]
pub(crate) async fn export_log_file(name: String, content: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = rfd::FileDialog::new()
            .set_title("导出日志")
            .set_file_name(&name)
            .save_file();
        match path {
            Some(path) => {
                std::fs::write(&path, content)
                    .map_err(|error| format!("failed to write log file: {error}"))?;
                Ok(Some(portable_local_path(&path)))
            }
            None => Ok(None),
        }
    })
    .await
    .map_err(|error| format!("failed to run save dialog: {error}"))?
}

#[tauri::command]
pub(crate) fn list_local_directory(app: AppHandle, path: String) -> Result<LocalDirectoryListing, String> {
    use std::fs;
    use std::path::PathBuf;

    let target = if path.is_empty() {
        app.path().home_dir().map_err(|error| format!("failed to resolve home directory: {error}"))?
    } else {
        PathBuf::from(&path)
    };

    let canonical = fs::canonicalize(&target).map_err(|error| format!("failed to resolve path: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("path is not a directory: {}", canonical.display()));
    }

    let parent_path = canonical
        .parent()
        .map(portable_local_path);

    let mut entries = Vec::new();
    for entry in fs::read_dir(&canonical).map_err(|error| format!("failed to read directory: {error}"))? {
        let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
        let metadata = entry.metadata().map_err(|error| format!("failed to read entry metadata: {error}"))?;
        let path = portable_local_path(&entry.path());
        let name = entry.file_name().to_string_lossy().to_string();

        let kind = if metadata.is_dir() {
            RemoteFileKind::Directory
        } else if metadata.is_symlink() {
            RemoteFileKind::Symlink
        } else if metadata.is_file() {
            RemoteFileKind::File
        } else {
            RemoteFileKind::Other
        };

        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs());

        entries.push(LocalFileEntry {
            path,
            name,
            kind,
            size: if metadata.is_dir() { None } else { Some(metadata.len()) },
            modified_at,
        });
    }

    entries.sort_by(|left, right| match (&left.kind, &right.kind) {
        (RemoteFileKind::Directory, RemoteFileKind::Directory) => left.name.cmp(&right.name),
        (RemoteFileKind::Directory, _) => std::cmp::Ordering::Less,
        (_, RemoteFileKind::Directory) => std::cmp::Ordering::Greater,
        _ => left.name.cmp(&right.name),
    });

    Ok(LocalDirectoryListing {
        path: portable_local_path(&canonical),
        parent_path,
        entries,
    })
}

fn contains_shell_metacharacters(input: &str) -> bool {
    input.chars().any(|c| matches!(c, '&' | '|' | '<' | '>' | '(' | ')' | '^' | '"' | '%' | '!'))
}

fn remote_connection_request_from_session(
    request: &SessionCreateRequest,
) -> RemoteConnectionRequest {
    RemoteConnectionRequest {
        host: request.host.clone(),
        port: request.port,
        username: request.username.clone(),
        auth_method: request.auth_method,
        password: request.password.clone(),
        private_key_path: request.private_key_path.clone(),
        passphrase: request.passphrase.clone(),
        jump_host: request.jump_host.clone(),
    }
}

struct PoolInvalidationGuard<'a> {
    pool: &'a SftpPool,
    connection_request: &'a RemoteConnectionRequest,
}

impl<'a> Drop for PoolInvalidationGuard<'a> {
    fn drop(&mut self) {
        self.pool.invalidate(self.connection_request);
    }
}

pub(crate) fn spawn_ssh_thread(
    app: AppHandle,
    session_id: String,
    request: SessionCreateRequest,
    rx: std::sync::mpsc::Receiver<SessionCommand>,
    pool: SftpPool,
    connection_request: RemoteConnectionRequest,
) {
    thread::spawn(move || {
        debug!("Spawned SSH worker session_id={session_id}");
        let _guard = PoolInvalidationGuard {
            pool: &pool,
            connection_request: &connection_request,
        };
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
