use super::*;
use crate::db::Database;
use crate::models::{
    ClosedReasonKind, ConnectionPreflightRequest, ConnectionPreflightResult, CopyLocalPathsRequest,
    CopyRemotePathRequest, CopyRemoteToRemoteRequest, CreateRemoteEntryRequest, CreateSessionError,
    DeleteRemotePathRequest, DownloadRemotePathsRequest, HostKeyCheckRequest, HostKeyCheckResult,
    KeyCredentialSummary, KnownHostEntry, LocalDirectoryListing, LocalFileEntry, LogFileInfo,
    ManagedSession, OpenRemoteFileRequest, PortForwardStartRequest, PreflightCancellationRegistry,
    ProfileRow, ReadRemoteFileRequest, ReadRemoteFileResponse, RemoteConnectionRequest,
    RemoteDirectoryListing, RemoteDirectoryRequest, RemoteEntryOwners, RemoteEntryOwnersRequest,
    RemoteFileKind, RemoteFsError, RenameRemotePathRequest, SessionCommand, SessionCreateRequest,
    SessionIdentity, SessionStatus, SessionSummary, SftpBookmarkRow, TransferBatchResult,
    TrustHostRequest, UpdateRemotePermissionsRequest, UploadLocalPathsRequest,
};
use crate::sftp_pool::SftpPool;
use base64::Engine;
use log::{debug, error, info, warn};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering as AtomicOrdering},
    mpsc, Arc,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeyCredentialRequest {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) kind: crate::models::KeyCredentialKind,
    pub(crate) private_key: Option<String>,
    pub(crate) public_key: Option<String>,
    #[serde(default)]
    pub(crate) key_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeyCredentialResponse {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) kind: crate::models::KeyCredentialKind,
    pub(crate) private_key: Option<String>,
    pub(crate) public_key: Option<String>,
    pub(crate) key_type: String,
    pub(crate) updated_at: i64,
}

#[tauri::command]
pub(crate) async fn create_session(
    app: AppHandle,
    state: State<'_, SessionManager>,
    pool: State<'_, SftpPool>,
    credentials: State<'_, crate::keychain::CredentialManager>,
    mut request: SessionCreateRequest,
) -> Result<SessionSummary, CreateSessionError> {
    validate_connection_fields(&request.host, &request.username).map_err(|message| {
        error!("SSH session validation failed: {message}");
        CreateSessionError::Other { message }
    })?;

    if let Err(message) = resolve_keychain_key_for_session(&credentials, &mut request) {
        error!("Failed to resolve keychain key: {message}");
        return Err(CreateSessionError::Other { message });
    }

    info!(
        "Creating SSH session {}",
        summarize_session_request(&request)
    );

    let session_id = Uuid::new_v4().to_string();

    // The host key is verified once, inside the session's own SSH handshake
    // (open_authenticated_session), so there is no separate pre-check
    // connection here: an extra handshake per session would double the
    // connect cost. Host-key failures still come back as typed
    // CreateSessionError variants via the connection result channel below.
    let summary = SessionSummary {
        session_id: session_id.clone(),
        title: request.name.clone(),
        host: request.host.clone(),
        port: request.port,
        username: request.username.clone(),
    };

    let (tx, rx) = mpsc::channel::<SessionCommand>();
    let (connection_result_tx, connection_result_rx) =
        mpsc::channel::<Result<(), CreateSessionError>>();
    let (waker, wake_source) = session_wake_pair().map_err(|error| {
        error!("Failed to create session wake channel session_id={session_id}: {error}");
        CreateSessionError::Other {
            message: format!("failed to create session wake channel: {error}"),
        }
    })?;
    let output_ready = Arc::new(AtomicBool::new(false));
    let output_paused = Arc::new(AtomicBool::new(false));
    state
        .insert(
            session_id.clone(),
            ManagedSession {
                sender: tx,
                waker: Some(waker),
                status: StatusEvent {
                    session_id: session_id.clone(),
                    status: SessionStatus::Connecting,
                    message: Some("connecting".to_string()),
                },
                // The shell can emit its first prompt immediately after the
                // handshake. Hold it until the replacement controller has
                // attached all event listeners, otherwise early carriage
                // returns / cursor-control sequences can be lost while later
                // text survives and leaves a garbled duplicate prompt.
                output_ready: output_ready.clone(),
                output_paused: output_paused.clone(),
            },
        )
        .map_err(|message| {
            error!("Failed to register SSH session session_id={session_id}: {message}");
            CreateSessionError::Other { message }
        })?;

    info!(
        "Created SSH session session_id={} title={} host={} port={} username={}",
        session_id, summary.title, summary.host, summary.port, summary.username
    );
    let connection_request = remote_connection_request_from_session(&request);
    spawn_ssh_thread(
        app,
        session_id.clone(),
        request,
        rx,
        wake_source,
        output_ready,
        output_paused,
        pool.inner().clone(),
        connection_request,
        Some(connection_result_tx),
    );

    let connection_result = match tauri::async_runtime::spawn_blocking(move || {
        connection_result_rx.recv_timeout(Duration::from_secs(10))
    })
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(_timeout)) => {
            warn!("Timeout waiting for connection result session_id={session_id}; falling back to async status updates");
            return Ok(summary);
        }
        Err(_) => {
            warn!("Connection result task cancelled session_id={session_id}; falling back to async status updates");
            return Ok(summary);
        }
    };

    match connection_result {
        Ok(()) => Ok(summary),
        Err(create_error) => {
            error!("SSH session connection failed session_id={session_id}: {create_error:?}");
            // The frontend never receives this session id and will not call
            // close_session, so drop the registry entry here to avoid leaking
            // it. The worker thread has already sent its result; its later
            // emit_status calls tolerate the missing entry (set_status error
            // is ignored in emit_status).
            let _ = state.remove(&session_id);
            Err(create_error)
        }
    }
}

#[tauri::command]
pub(crate) fn create_local_session(
    app: AppHandle,
    state: State<'_, SessionManager>,
    cols: u16,
    rows: u16,
) -> Result<SessionSummary, String> {
    let session_id = Uuid::new_v4().to_string();
    let shell = if cfg!(target_os = "windows") {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    };
    let title = std::path::Path::new(&shell)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Local")
        .to_string();
    let summary = SessionSummary {
        session_id: session_id.clone(),
        title,
        host: "local".to_string(),
        port: 0,
        username: std::env::var(if cfg!(target_os = "windows") {
            "USERNAME"
        } else {
            "USER"
        })
        .unwrap_or_else(|_| "local".to_string()),
    };

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| {
            error!("Failed to create local terminal session_id={session_id}: {error}");
            format!("failed to create local terminal: {error}")
        })?;
    let mut command = CommandBuilder::new(&shell);
    configure_local_terminal_environment(&mut command);
    if !cfg!(target_os = "windows") {
        command.arg("-l");
    }
    let mut child = pair.slave.spawn_command(command).map_err(|error| {
        error!("Failed to start local shell session_id={session_id} shell={shell}: {error}");
        format!("failed to start local shell: {error}")
    })?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|error| {
        error!("Failed to clone local terminal reader session_id={session_id}: {error}");
        format!("failed to read local terminal: {error}")
    })?;
    let mut writer = pair.master.take_writer().map_err(|error| {
        error!("Failed to take local terminal writer session_id={session_id}: {error}");
        format!("failed to write local terminal: {error}")
    })?;
    let master = pair.master;
    let (tx, rx) = mpsc::channel::<SessionCommand>();
    let output_ready = Arc::new(AtomicBool::new(false));
    let output_paused = Arc::new(AtomicBool::new(false));
    state
        .insert(
            session_id.clone(),
            ManagedSession {
                sender: tx,
                waker: None,
                status: StatusEvent {
                    session_id: session_id.clone(),
                    status: SessionStatus::Connected,
                    message: Some("local shell ready".to_string()),
                },
                output_ready: output_ready.clone(),
                output_paused: output_paused.clone(),
            },
        )
        .map_err(|message| {
            error!("Failed to register local session session_id={session_id}: {message}");
            message
        })?;

    let worker_id = session_id.clone();
    let worker_output_ready = output_ready;
    let worker_output_paused = output_paused;
    let worker_identity = SessionIdentity {
        title: summary.title.clone(),
        host: summary.host.clone(),
        port: summary.port,
        username: summary.username.clone(),
    };
    thread::spawn(move || {
        let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>();
        let reader_id = worker_id.clone();
        let reader_output_paused = worker_output_paused.clone();
        let reader_handle = thread::spawn(move || {
            let mut buffer = [0_u8; 8192];
            loop {
                while reader_output_paused.load(AtomicOrdering::Relaxed) {
                    thread::sleep(Duration::from_millis(8));
                }
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Err(error) => {
                        warn!("Local shell reader failed session_id={reader_id}: {error}");
                        break;
                    }
                    Ok(count) => {
                        if let Err(error) = output_tx.send(buffer[..count].to_vec()) {
                            warn!(
                                "Local shell output channel closed session_id={reader_id}: {error}"
                            );
                            break;
                        }
                    }
                }
            }
        });
        let _ = emit_status(
            &app,
            &worker_id,
            SessionStatus::Connected,
            Some("local shell ready".to_string()),
        );
        // The frontend attaches its event listeners asynchronously after the
        // session is created. On Windows, ConPTY emits a cursor position
        // query (ESC[6n) almost immediately and stalls the shell until the
        // terminal answers it; output emitted before the frontend is
        // listening would be lost and the shell would deadlock. Buffer
        // output until the frontend signals it is ready; the conservative
        // timeout keeps output flowing if the signal never arrives.
        let mut buffered_output: Vec<String> = Vec::new();
        let mut buffered_bytes = 0_usize;
        let output_wait_started = Instant::now();
        let mut output_live = false;
        let mut closed_by_user = false;
        let mut pending_bytes: Vec<u8> = Vec::new();
        let mut pending_output = String::new();
        loop {
            if !output_live
                && !worker_output_paused.load(AtomicOrdering::Relaxed)
                && (worker_output_ready.load(AtomicOrdering::Relaxed)
                    || output_wait_started.elapsed() > Duration::from_secs(5)
                    || buffered_bytes > 1_000_000)
            {
                output_live = true;
                for chunk in buffered_output.drain(..) {
                    let _ = emit_data(&app, &worker_id, chunk);
                }
            }
            if !worker_output_paused.load(AtomicOrdering::Relaxed) {
                while let Ok(bytes) = output_rx.try_recv() {
                    pending_bytes.extend_from_slice(&bytes);
                }
                drain_decoded_output(&mut pending_bytes, &mut pending_output);
                if !pending_output.is_empty() {
                    if output_live {
                        let _ = emit_data(&app, &worker_id, std::mem::take(&mut pending_output));
                    } else {
                        buffered_bytes += pending_output.len();
                        buffered_output.push(std::mem::take(&mut pending_output));
                    }
                }
            }
            match rx.recv_timeout(Duration::from_millis(16)) {
                Ok(SessionCommand::Write(data)) => {
                    if let Err(error) = writer.write_all(data.as_bytes()) {
                        warn!("Failed to write local shell input session_id={worker_id}: {error}");
                    }
                    if let Err(error) = writer.flush() {
                        warn!("Failed to flush local shell input session_id={worker_id}: {error}");
                    }
                }
                Ok(SessionCommand::Resize { cols, rows }) => {
                    if let Err(error) = master.resize(PtySize {
                        rows: rows.max(1) as u16,
                        cols: cols.max(1) as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    }) {
                        warn!(
                            "Failed to resize local terminal session_id={worker_id} cols={cols} rows={rows}: {error}"
                        );
                    }
                }
                Ok(SessionCommand::Close) => {
                    closed_by_user = true;
                    worker_output_paused.store(false, AtomicOrdering::Relaxed);
                    if let Err(error) = child.kill() {
                        warn!("Failed to kill local shell session_id={worker_id}: {error}");
                    }
                    break;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // The controller went away without a Close command; kill
                    // the shell so it does not outlive the session and the
                    // reader thread below can observe EOF and finish.
                    worker_output_paused.store(false, AtomicOrdering::Relaxed);
                    if let Err(error) = child.kill() {
                        warn!("Failed to kill local shell session_id={worker_id}: {error}");
                    }
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
        }
        // Wait for the reader thread to finish so output still in flight
        // (e.g. the shell's final exit message) is not lost, then flush.
        // Releasing the PTY lets a reader blocked in read observe EOF, and
        // the watchdog bounds the wait: a grandchild process can keep the
        // slave open and block the reader forever, in which case the reader
        // stays detached and its next send fails once the output receiver is
        // dropped at the end of this closure.
        worker_output_paused.store(false, AtomicOrdering::Relaxed);
        drop(writer);
        drop(master);
        let (reader_done_tx, reader_done_rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = reader_handle.join();
            let _ = reader_done_tx.send(());
        });
        if reader_done_rx.recv_timeout(Duration::from_secs(2)).is_err() {
            warn!("Local shell reader did not stop session_id={worker_id}; detaching it");
        }
        for chunk in buffered_output.drain(..) {
            let _ = emit_data(&app, &worker_id, chunk);
        }
        while let Ok(bytes) = output_rx.try_recv() {
            pending_bytes.extend_from_slice(&bytes);
        }
        flush_pending_output(&app, &worker_id, &mut pending_bytes, &mut pending_output);
        let reason = if closed_by_user {
            "local shell closed"
        } else {
            "local shell exited"
        };
        let _ = emit_status(
            &app,
            &worker_id,
            SessionStatus::Disconnected,
            Some(reason.to_string()),
        );
        let _ = emit_closed(
            &app,
            &worker_id,
            Some(worker_identity),
            Some(reason.to_string()),
            if closed_by_user {
                ClosedReasonKind::LocalClose
            } else {
                ClosedReasonKind::RemoteExit
            },
            false,
        );
    });
    info!("Created local session session_id={session_id} shell={shell}");
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
pub(crate) fn get_session_status(
    state: State<'_, SessionManager>,
    session_id: String,
) -> Result<StatusEvent, String> {
    state.status(&session_id)
}

#[tauri::command]
pub(crate) fn mark_session_ready(
    state: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    state.mark_output_ready(&session_id)
}

#[tauri::command]
pub(crate) fn set_session_output_paused(
    state: State<'_, SessionManager>,
    session_id: String,
    paused: bool,
) -> Result<(), String> {
    state.set_output_paused(&session_id, paused)
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
pub(crate) fn request_app_restart(
    app: AppHandle,
    forwards_state: State<'_, crate::port_forward::PortForwardManager>,
) {
    info!("Requesting application restart");
    if let Err(error) = forwards_state.cancel_all() {
        warn!("Failed to cancel port forwards before restart: {error}");
    }
    app.request_restart();
}

#[tauri::command]
pub(crate) fn request_app_exit(
    app: AppHandle,
    forwards_state: State<'_, crate::port_forward::PortForwardManager>,
) {
    info!("Requesting application exit");
    if let Err(error) = forwards_state.cancel_all() {
        warn!("Failed to cancel port forwards before exit: {error}");
    }
    app.exit(0);
}

#[tauri::command]
pub(crate) async fn list_remote_directory(
    app: AppHandle,
    credentials: State<'_, crate::keychain::CredentialManager>,
    mut request: RemoteDirectoryRequest,
    pool: State<'_, SftpPool>,
    cache: State<'_, RemoteIdentityCache>,
) -> Result<RemoteDirectoryListing, RemoteFsError> {
    resolve_keychain_key_for_remote(&credentials, &mut request.connection)
        .map_err(|message| RemoteFsError::Other { message })?;
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
    .map_err(|error| RemoteFsError::Other {
        message: format!("failed to join directory listing task: {error}"),
    })?;
    match &result {
        Ok(listing) => {
            debug!(
                "Listed remote directory path={} entries={}",
                listing.path,
                listing.entries.len()
            );
        }
        Err(error) => {
            error!("List remote directory failed path={requested_path}: {error:?}");
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn resolve_remote_entry_owners(
    app: AppHandle,
    credentials: State<'_, crate::keychain::CredentialManager>,
    mut request: RemoteEntryOwnersRequest,
    pool: State<'_, SftpPool>,
    cache: State<'_, RemoteIdentityCache>,
) -> Result<RemoteEntryOwners, RemoteFsError> {
    resolve_keychain_key_for_remote(&credentials, &mut request.connection)
        .map_err(|message| RemoteFsError::Other { message })?;
    let pool = pool.inner().clone();
    let cache = cache.inner().clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    tauri::async_runtime::spawn_blocking(move || {
        resolve_remote_entry_owners_blocking(
            request,
            Some(&pool),
            Some(&cache),
            known_hosts.as_deref(),
        )
    })
    .await
    .map_err(|error| RemoteFsError::Other {
        message: format!("failed to join owner lookup task: {error}"),
    })?
}

#[tauri::command]
pub(crate) async fn warm_remote_connection(
    app: AppHandle,
    credentials: State<'_, crate::keychain::CredentialManager>,
    mut request: RemoteConnectionRequest,
    pool: State<'_, SftpPool>,
) -> Result<(), RemoteFsError> {
    resolve_keychain_key_for_remote(&credentials, &mut request)
        .map_err(|message| RemoteFsError::Other { message })?;
    let pool = pool.inner().clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    tauri::async_runtime::spawn_blocking(move || {
        warm_remote_connection_blocking(request, Some(&pool), known_hosts.as_deref())
    })
    .await
    .map_err(|error| RemoteFsError::Other {
        message: format!("failed to join warm-up task: {error}"),
    })?
}

#[tauri::command]
pub(crate) async fn create_remote_entry(
    app: AppHandle,
    credentials: State<'_, crate::keychain::CredentialManager>,
    mut request: CreateRemoteEntryRequest,
    pool: State<'_, SftpPool>,
) -> Result<(), RemoteFsError> {
    resolve_keychain_key_for_remote(&credentials, &mut request.connection)
        .map_err(|message| RemoteFsError::Other { message })?;
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
    .map_err(|error| RemoteFsError::Other {
        message: format!("failed to join create entry task: {error}"),
    })?;
    if let Err(error) = &result {
        error!("Create remote entry failed: {error:?}");
    } else {
        info!("Created remote entry successfully");
    }
    result
}

#[tauri::command]
pub(crate) async fn rename_remote_path(
    app: AppHandle,
    credentials: State<'_, crate::keychain::CredentialManager>,
    mut request: RenameRemotePathRequest,
    pool: State<'_, SftpPool>,
) -> Result<(), RemoteFsError> {
    resolve_keychain_key_for_remote(&credentials, &mut request.connection)
        .map_err(|message| RemoteFsError::Other { message })?;
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
    .map_err(|error| RemoteFsError::Other {
        message: format!("failed to join rename task: {error}"),
    })?;
    if let Err(error) = &result {
        error!("Rename remote path failed: {error:?}");
    } else {
        info!("Renamed remote path successfully");
    }
    result
}

#[tauri::command]
pub(crate) async fn delete_remote_path(
    app: AppHandle,
    credentials: State<'_, crate::keychain::CredentialManager>,
    deletes: State<'_, DeleteCancellationRegistry>,
    mut request: DeleteRemotePathRequest,
    pool: State<'_, SftpPool>,
) -> Result<(), RemoteFsError> {
    resolve_keychain_key_for_remote(&credentials, &mut request.connection)
        .map_err(|message| RemoteFsError::Other { message })?;
    info!(
        "Deleting remote paths operation_id={} paths={:?} {}",
        request.operation_id,
        request.paths,
        summarize_remote_connection_request(&request.connection)
    );
    let cancel_flag = deletes
        .register(request.operation_id.clone())
        .map_err(|message| RemoteFsError::Other { message })?;
    let operation_id = request.operation_id.clone();
    let pool = pool.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        delete_remote_path_blocking(app, request, cancel_flag, Some(&pool))
    })
    .await;
    // Remove the registry entry before propagating a JoinError so the
    // operation id does not leak on task failure.
    let _ = deletes.remove(&operation_id);
    let result = result.map_err(|error| RemoteFsError::Other {
        message: format!("failed to join delete task: {error}"),
    })?;
    if let Err(error) = &result {
        warn!("Delete remote path failed operation_id={operation_id}: {error:?}");
    } else {
        info!("Deleted remote path operation_id={operation_id}");
    }
    result
}

#[tauri::command]
pub(crate) async fn copy_remote_path(
    app: AppHandle,
    credentials: State<'_, crate::keychain::CredentialManager>,
    copies: State<'_, RemoteCopyCancellationRegistry>,
    mut request: CopyRemotePathRequest,
    pool: State<'_, SftpPool>,
) -> Result<(), RemoteFsError> {
    resolve_keychain_key_for_remote(&credentials, &mut request.connection)
        .map_err(|message| RemoteFsError::Other { message })?;
    info!(
        "Copying remote path operation_id={} source_path={} destination_directory={} {}",
        request.operation_id,
        request.source_path,
        request.destination_directory,
        summarize_remote_connection_request(&request.connection)
    );
    let cancel_flag = copies
        .register(request.operation_id.clone())
        .map_err(|message| RemoteFsError::Other { message })?;
    let operation_id = request.operation_id.clone();
    let pool = pool.inner().clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let result = tauri::async_runtime::spawn_blocking(move || {
        copy_remote_path_blocking(request, cancel_flag, Some(&pool), known_hosts.as_deref())
    })
    .await;
    // Remove the registry entry before propagating a JoinError so the
    // operation id does not leak on task failure.
    let _ = copies.remove(&operation_id);
    let result = result.map_err(|error| RemoteFsError::Other {
        message: format!("failed to join copy task: {error}"),
    })?;
    if let Err(error) = &result {
        error!("Copy remote path failed: {error:?}");
    } else {
        info!("Copied remote path successfully");
    }
    result
}

#[tauri::command]
pub(crate) async fn copy_remote_to_remote(
    app: AppHandle,
    credentials: State<'_, crate::keychain::CredentialManager>,
    copies: State<'_, RemoteCopyCancellationRegistry>,
    mut request: CopyRemoteToRemoteRequest,
    pool: State<'_, SftpPool>,
) -> Result<(), RemoteFsError> {
    resolve_keychain_key_for_remote(&credentials, &mut request.source_connection)
        .map_err(|message| RemoteFsError::Other { message })?;
    resolve_keychain_key_for_remote(&credentials, &mut request.destination_connection)
        .map_err(|message| RemoteFsError::Other { message })?;
    let cancel_flag = copies
        .register(request.operation_id.clone())
        .map_err(|message| RemoteFsError::Other { message })?;
    let operation_id = request.operation_id.clone();
    let pool = pool.inner().clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let result = tauri::async_runtime::spawn_blocking(move || {
        copy_remote_to_remote_blocking(
            app,
            request,
            cancel_flag,
            Some(&pool),
            known_hosts.as_deref(),
        )
    })
    .await;
    // Remove the registry entry before propagating a JoinError so the
    // operation id does not leak on task failure.
    let _ = copies.remove(&operation_id);
    let result = result.map_err(|error| RemoteFsError::Other {
        message: format!("failed to join remote transfer task: {error}"),
    })?;
    if let Err(error) = &result {
        error!("Copy remote to remote failed: {error:?}");
    }
    result
}

#[tauri::command]
pub(crate) fn cancel_remote_copy(
    copies: State<'_, RemoteCopyCancellationRegistry>,
    operation_id: String,
) -> Result<(), String> {
    info!("Cancelling remote copy operation_id={operation_id}");
    copies.cancel(&operation_id)
}

#[tauri::command]
pub(crate) async fn upload_local_paths(
    app: AppHandle,
    credentials: State<'_, crate::keychain::CredentialManager>,
    uploads: State<'_, UploadCancellationRegistry>,
    mut request: UploadLocalPathsRequest,
    pool: State<'_, SftpPool>,
) -> Result<TransferBatchResult, RemoteFsError> {
    resolve_keychain_key_for_remote(&credentials, &mut request.connection)
        .map_err(|message| RemoteFsError::Other { message })?;
    info!(
        "Uploading local paths operation_id={} count={} destination_directory={} {}",
        request.operation_id,
        request.local_paths.len(),
        request.destination_directory,
        summarize_remote_connection_request(&request.connection)
    );
    let cancel_flag = uploads
        .register(request.operation_id.clone())
        .map_err(|message| RemoteFsError::Other { message })?;
    let operation_id = request.operation_id.clone();
    let pool = pool.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        upload_local_paths_blocking(app, request, cancel_flag, Some(&pool))
    })
    .await;
    // Remove the registry entry before propagating a JoinError so the
    // operation id does not leak on task failure.
    let _ = uploads.remove(&operation_id);
    let result = result.map_err(|error| RemoteFsError::Other {
        message: format!("failed to join upload task: {error}"),
    })?;
    match &result {
        Err(error) => warn!("Upload failed operation_id={operation_id}: {error:?}"),
        Ok(batch) if batch.items.iter().any(|item| item.error.is_some()) => {
            warn!("Upload partially failed operation_id={operation_id}: {batch:?}");
        }
        Ok(_) => info!("Upload completed operation_id={operation_id}"),
    }
    result
}

#[tauri::command]
pub(crate) async fn copy_local_paths(request: CopyLocalPathsRequest) -> Result<(), String> {
    info!(
        "Copying local paths operation_id={} count={} destination_directory={}",
        request.operation_id,
        request.source_paths.len(),
        request.destination_directory,
    );
    let operation_id = request.operation_id.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || crate::copy_local_paths_blocking(request))
            .await
            .map_err(|error| format!("failed to join copy local paths task: {error}"))?;
    if let Err(error) = &result {
        warn!("Copy local paths failed operation_id={operation_id}: {error}");
    } else {
        info!("Copy local paths completed operation_id={operation_id}");
    }
    result
}

#[tauri::command]
pub(crate) async fn rename_local_path(path: String, new_name: String) -> Result<(), String> {
    info!("Renaming local path path={path} new_name={new_name}");
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::rename_local_path_blocking(path, new_name)
    })
    .await
    .map_err(|error| format!("failed to join rename local path task: {error}"))?;
    if let Err(error) = &result {
        warn!("Rename local path failed: {error}");
    }
    result
}

#[tauri::command]
pub(crate) async fn paste_local_paths(
    source_paths: Vec<String>,
    destination_directory: String,
    copy_suffix: String,
) -> Result<Vec<String>, String> {
    info!(
        "Pasting local paths count={} destination_directory={destination_directory}",
        source_paths.len()
    );
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::paste_local_paths_blocking(source_paths, destination_directory, copy_suffix)
    })
    .await
    .map_err(|error| format!("failed to join paste local paths task: {error}"))?;
    if let Err(error) = &result {
        warn!("Paste local paths failed: {error}");
    }
    result
}

#[tauri::command]
pub(crate) async fn trash_local_paths(paths: Vec<String>) -> Result<(), String> {
    info!("Trashing local paths count={}", paths.len());
    let result =
        tauri::async_runtime::spawn_blocking(move || crate::trash_local_paths_blocking(paths))
            .await
            .map_err(|error| format!("failed to join trash local paths task: {error}"))?;
    if let Err(error) = &result {
        warn!("Trash local paths failed: {error}");
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
    credentials: State<'_, crate::keychain::CredentialManager>,
    downloads: State<'_, DownloadCancellationRegistry>,
    mut request: DownloadRemotePathsRequest,
    pool: State<'_, SftpPool>,
) -> Result<TransferBatchResult, RemoteFsError> {
    resolve_keychain_key_for_remote(&credentials, &mut request.connection)
        .map_err(|message| RemoteFsError::Other { message })?;
    info!(
        "Downloading remote paths operation_id={} count={} destination_directory={} {}",
        request.operation_id,
        request.remote_paths.len(),
        request.destination_directory,
        summarize_remote_connection_request(&request.connection)
    );
    let cancel_flag = downloads
        .register(request.operation_id.clone())
        .map_err(|message| RemoteFsError::Other { message })?;
    let operation_id = request.operation_id.clone();
    let pool = pool.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        download_remote_paths_blocking(app, request, cancel_flag, Some(&pool))
    })
    .await;
    // Remove the registry entry before propagating a JoinError so the
    // operation id does not leak on task failure.
    let _ = downloads.remove(&operation_id);
    let result = result.map_err(|error| RemoteFsError::Other {
        message: format!("failed to join download task: {error}"),
    })?;
    match &result {
        Err(error) => warn!("Download failed operation_id={operation_id}: {error:?}"),
        Ok(batch) if batch.items.iter().any(|item| item.error.is_some()) => {
            warn!("Download partially failed operation_id={operation_id}: {batch:?}");
        }
        Ok(_) => info!("Download completed operation_id={operation_id}"),
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
pub(crate) async fn disconnect_sftp(
    credentials: State<'_, crate::keychain::CredentialManager>,
    mut request: RemoteConnectionRequest,
    pool: State<'_, SftpPool>,
) -> Result<(), RemoteFsError> {
    // The pool key hashes the resolved credentials, so keychain references
    // must be resolved here exactly as the connecting commands do.
    resolve_keychain_key_for_remote(&credentials, &mut request)
        .map_err(|message| RemoteFsError::Other { message })?;
    info!(
        "Disconnecting pooled SFTP connection {}",
        summarize_remote_connection_request(&request)
    );
    let pool = pool.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        pool.invalidate(&request);
    })
    .await
    .map_err(|error| RemoteFsError::Other {
        message: format!("failed to join disconnect task: {error}"),
    })?;
    Ok(())
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
            .set_title(title.unwrap_or_else(|| "选择文件夹".to_string()))
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
    credentials: State<'_, crate::keychain::CredentialManager>,
    mut request: OpenRemoteFileRequest,
    pool: State<'_, SftpPool>,
) -> Result<(), RemoteFsError> {
    resolve_keychain_key_for_remote(&credentials, &mut request.connection)
        .map_err(|message| RemoteFsError::Other { message })?;
    info!(
        "Opening remote file path={} {}",
        request.path,
        summarize_remote_connection_request(&request.connection)
    );
    let pool = pool.inner().clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let open_root = app
        .path()
        .home_dir()
        .ok()
        .map(|home| home.join(".termbridge").join("open-cache"));
    let result = tauri::async_runtime::spawn_blocking(move || {
        open_remote_file_blocking(
            request,
            Some(&pool),
            known_hosts.as_deref(),
            open_root.as_deref(),
        )
    })
    .await
    .map_err(|error| RemoteFsError::Other {
        message: format!("failed to join open file task: {error}"),
    })?;
    if let Err(error) = &result {
        error!("Open remote file failed: {error:?}");
    } else {
        info!("Opened remote file successfully");
    }
    result
}

#[tauri::command]
pub(crate) async fn preview_local_file(path: String) -> Result<ReadRemoteFileResponse, String> {
    info!("Previewing local file path={path}");
    let result = tauri::async_runtime::spawn_blocking(move || read_local_file_blocking(path))
        .await
        .map_err(|error| format!("failed to join local file preview task: {error}"))?;
    match &result {
        Ok(response) => {
            info!(
                "Previewed local file path={} size={} is_text={} truncated={}",
                response.path, response.size, response.is_text, response.truncated
            );
        }
        Err(error) => {
            error!("Preview local file failed: {error}");
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn preview_remote_file(
    app: AppHandle,
    credentials: State<'_, crate::keychain::CredentialManager>,
    mut request: ReadRemoteFileRequest,
    pool: State<'_, SftpPool>,
) -> Result<ReadRemoteFileResponse, RemoteFsError> {
    resolve_keychain_key_for_remote(&credentials, &mut request.connection)
        .map_err(|message| RemoteFsError::Other { message })?;
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
    .map_err(|error| RemoteFsError::Other {
        message: format!("failed to join file preview task: {error}"),
    })?;
    match &result {
        Ok(response) => {
            info!(
                "Previewed remote file path={} size={} is_text={} truncated={}",
                response.path, response.size, response.is_text, response.truncated
            );
        }
        Err(error) => {
            error!("Preview remote file failed: {error:?}");
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn update_remote_permissions(
    app: AppHandle,
    credentials: State<'_, crate::keychain::CredentialManager>,
    mut request: UpdateRemotePermissionsRequest,
    pool: State<'_, SftpPool>,
) -> Result<(), RemoteFsError> {
    resolve_keychain_key_for_remote(&credentials, &mut request.connection)
        .map_err(|message| RemoteFsError::Other { message })?;
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
    .map_err(|error| RemoteFsError::Other {
        message: format!("failed to join permissions update task: {error}"),
    })?;
    if let Err(error) = &result {
        error!("Update remote permissions failed: {error:?}");
    } else {
        info!("Updated remote permissions successfully");
    }
    result
}

fn detect_key_type(private_key: &str) -> &'static str {
    let normalized = private_key.to_lowercase();
    if normalized.contains("-----begin rsa private key-----") || normalized.contains("ssh-rsa") {
        return "rsa";
    }
    if normalized.contains("-----begin ec private key-----") || normalized.contains("ecdsa-sha2") {
        return "ecdsa";
    }
    if normalized.contains("ssh-ed25519") {
        return "ed25519";
    }
    if normalized.contains("-----begin dsa private key-----") || normalized.contains("ssh-dss") {
        return "dsa";
    }
    if normalized.contains("-----begin openssh private key-----") {
        let base64_body: String = private_key
            .lines()
            .map(str::trim)
            .filter(|line| {
                !line.is_empty() && !line.starts_with("-----BEGIN") && !line.starts_with("-----END")
            })
            .collect();
        if let Ok(decoded) =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, base64_body)
        {
            if let Ok(text) = String::from_utf8(decoded) {
                let lower = text.to_lowercase();
                if lower.contains("ssh-ed25519") {
                    return "ed25519";
                }
                if lower.contains("ssh-rsa") {
                    return "rsa";
                }
                if lower.contains("ecdsa-sha2") {
                    return "ecdsa";
                }
                if lower.contains("ssh-dss") {
                    return "dsa";
                }
            }
        }
    }
    "unknown"
}

#[tauri::command]
pub(crate) fn store_key_credential(
    credentials: State<'_, crate::keychain::CredentialManager>,
    database: State<'_, Database>,
    request: KeyCredentialRequest,
) -> Result<(), String> {
    if request.kind != crate::models::KeyCredentialKind::KeyFile {
        return Err("generic key credentials must contain a private key file".to_string());
    }
    if request.id.trim().is_empty() {
        return Err("key credential id cannot be empty".to_string());
    }
    if request.label.trim().is_empty() {
        return Err("key credential label cannot be empty".to_string());
    }
    let private_key = request
        .private_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "key credential private key cannot be empty".to_string())?;
    let updated_at = crate::db::current_timestamp_ms();
    let key_type = request
        .key_type
        .filter(|t| !t.is_empty() && t != "unknown")
        .unwrap_or_else(|| detect_key_type(private_key).to_string());
    let payload = serde_json::json!({
        "kind": request.kind.to_string(),
        "label": request.label,
        "privateKey": request.private_key,
        "publicKey": request.public_key,
        "keyType": key_type,
        "updatedAt": updated_at,
    });
    let previous_payload = credentials.retrieve_key_credential(&request.id)?;
    credentials.store_key_credential(&request.id, &payload.to_string())?;
    if let Err(error) = database.upsert_key_credential(
        &request.id,
        &request.label,
        &key_type,
        &request.kind.to_string(),
        crate::keychain::KEY_SERVICE,
        request.public_key.as_deref(),
        None,
        updated_at,
    ) {
        warn!(
            "Failed to persist key credential metadata for id={}, rolling back native value: {}",
            request.id, error
        );
        let rollback_result = match previous_payload {
            Some(previous) => credentials.store_key_credential(&request.id, &previous),
            None => credentials.delete_credential(crate::keychain::KEY_SERVICE, &request.id),
        };
        if let Err(rollback_error) = rollback_result {
            warn!(
                "Failed to roll back native key credential id={}: {}",
                request.id, rollback_error
            );
        }
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn list_key_credentials(
    database: State<'_, Database>,
) -> Result<Vec<KeyCredentialSummary>, String> {
    database.list_key_credentials()
}

#[tauri::command]
pub(crate) fn retrieve_key_credential(
    credentials: State<'_, crate::keychain::CredentialManager>,
    id: String,
) -> Result<Option<KeyCredentialResponse>, String> {
    let Some(json) = credentials.retrieve_key_credential(&id)? else {
        return Ok(None);
    };
    let value = serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("failed to parse key credential: {e}"))?;
    let kind = value
        .get("kind")
        .and_then(|v| v.as_str())
        .map(|s| match s {
            "password" => crate::models::KeyCredentialKind::Password,
            _ => crate::models::KeyCredentialKind::KeyFile,
        })
        .unwrap_or(crate::models::KeyCredentialKind::KeyFile);
    Ok(Some(KeyCredentialResponse {
        id: id.clone(),
        label: value
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or(&id)
            .to_string(),
        kind,
        private_key: value
            .get("privateKey")
            .and_then(|v| v.as_str())
            .map(String::from),
        public_key: value
            .get("publicKey")
            .and_then(|v| v.as_str())
            .map(String::from),
        key_type: value
            .get("keyType")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        updated_at: value.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0),
    }))
}

#[tauri::command]
pub(crate) fn delete_key_credential(
    credentials: State<'_, crate::keychain::CredentialManager>,
    database: State<'_, Database>,
    id: String,
) -> Result<Vec<String>, String> {
    let service = database
        .key_credential_service(&id)?
        .unwrap_or_else(|| crate::keychain::KEY_SERVICE.to_string());
    let referencing = if service == crate::keychain::KEY_SERVICE {
        database.list_profiles_referencing_key(&id)?
    } else {
        Vec::new()
    };
    credentials.delete_credential(&service, &id)?;
    database.delete_key_credential(&id)?;
    if service == crate::keychain::KEY_SERVICE {
        database.clear_keychain_key_id_references(&id)?;
    }
    if !referencing.is_empty() {
        log::info!(
            "Cleared keychain_key_id for {} profile(s) referencing deleted key {id}",
            referencing.len()
        );
    }
    Ok(referencing)
}

fn expand_home_path(path: &str, home: &std::path::Path) -> std::path::PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    path.strip_prefix("~/")
        .or_else(|| path.strip_prefix("~\\"))
        .map_or_else(
            || std::path::PathBuf::from(path),
            |suffix| home.join(suffix),
        )
}

#[tauri::command]
pub(crate) fn read_text_file(app: AppHandle, path: String) -> Result<String, String> {
    let resolved = if path == "~" || path.starts_with("~/") || path.starts_with("~\\") {
        let home = app
            .path()
            .home_dir()
            .map_err(|error| format!("failed to resolve home directory: {error}"))?;
        expand_home_path(&path, &home)
    } else {
        std::path::PathBuf::from(&path)
    };
    std::fs::read_to_string(&resolved)
        .map_err(|e| format!("failed to read file {}: {e}", resolved.display()))
}

#[tauri::command]
pub(crate) fn store_profile_password(
    credentials: State<'_, crate::keychain::CredentialManager>,
    database: State<'_, Database>,
    profile_id: String,
    password: String,
) -> Result<(), String> {
    let updated_at = crate::db::current_timestamp_ms();
    let profile_name = database
        .get_profile(&profile_id)?
        .map(|p| p.name)
        .unwrap_or_else(|| profile_id.clone());
    let previous_password = credentials.retrieve_profile_password(&profile_id)?;
    credentials.store_profile_password(&profile_id, &password)?;
    if let Err(error) = database.upsert_key_credential(
        &profile_id,
        &profile_name,
        "profile",
        "password",
        crate::keychain::PROFILE_PASSWORD_SERVICE,
        None,
        None,
        updated_at,
    ) {
        let rollback_result = match previous_password {
            Some(previous) => credentials.store_profile_password(&profile_id, &previous),
            None => credentials.delete_profile_password(&profile_id),
        };
        if let Err(rollback_error) = rollback_result {
            warn!(
                "Failed to roll back native profile password id={}: {}",
                profile_id, rollback_error
            );
        }
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn retrieve_profile_password(
    credentials: State<'_, crate::keychain::CredentialManager>,
    profile_id: String,
) -> Result<Option<String>, String> {
    credentials.retrieve_profile_password(&profile_id)
}

#[tauri::command]
pub(crate) fn delete_profile_password(
    credentials: State<'_, crate::keychain::CredentialManager>,
    database: State<'_, Database>,
    profile_id: String,
) -> Result<(), String> {
    credentials.delete_profile_password(&profile_id)?;
    database.delete_key_credential_metadata(&profile_id, crate::keychain::PROFILE_PASSWORD_SERVICE)
}

#[tauri::command]
pub(crate) fn store_profile_secret(
    credentials: State<'_, crate::keychain::CredentialManager>,
    profile_id: String,
    kind: crate::keychain::ProfileSecretKind,
    value: String,
) -> Result<(), String> {
    credentials.store_profile_secret(&profile_id, kind, &value)
}

#[tauri::command]
pub(crate) fn retrieve_profile_secret(
    credentials: State<'_, crate::keychain::CredentialManager>,
    profile_id: String,
    kind: crate::keychain::ProfileSecretKind,
) -> Result<Option<String>, String> {
    credentials.retrieve_profile_secret(&profile_id, kind)
}

#[tauri::command]
pub(crate) fn delete_profile_secrets(
    credentials: State<'_, crate::keychain::CredentialManager>,
    database: State<'_, Database>,
    profile_id: String,
) -> Result<(), String> {
    credentials.delete_all_profile_secrets(&profile_id)?;
    database.delete_key_credential_metadata(&profile_id, crate::keychain::PROFILE_PASSWORD_SERVICE)
}

#[tauri::command]
pub(crate) fn delete_profile_secret(
    credentials: State<'_, crate::keychain::CredentialManager>,
    profile_id: String,
    kind: crate::keychain::ProfileSecretKind,
) -> Result<(), String> {
    credentials.delete_profile_secret(&profile_id, kind)
}

fn load_keychain_private_key(
    credentials: &crate::keychain::CredentialManager,
    key_id: &str,
) -> Result<String, String> {
    let json = credentials
        .retrieve_key_credential(key_id)?
        .ok_or_else(|| format!("keychain key not found: {key_id}"))?;
    let value = serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("failed to parse key credential: {e}"))?;
    value
        .get("privateKey")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| "key credential missing privateKey".to_string())
}

pub(crate) fn resolve_keychain_key_for_remote(
    credentials: &crate::keychain::CredentialManager,
    request: &mut RemoteConnectionRequest,
) -> Result<(), String> {
    if let Some(key_id) = request.keychain_key_id.as_deref() {
        if request.private_key_data.is_none() {
            request.private_key_data = Some(load_keychain_private_key(credentials, key_id)?);
        }
    }
    if let Some(ref mut jump) = request.jump_host {
        if let Some(key_id) = jump.keychain_key_id.as_deref() {
            if jump.private_key_data.is_none() {
                jump.private_key_data = Some(load_keychain_private_key(credentials, key_id)?);
            }
        }
    }
    Ok(())
}

fn resolve_keychain_key_for_session(
    credentials: &crate::keychain::CredentialManager,
    request: &mut SessionCreateRequest,
) -> Result<(), String> {
    if let Some(key_id) = request.keychain_key_id.as_deref() {
        if request.private_key_data.is_none() {
            request.private_key_data = Some(load_keychain_private_key(credentials, key_id)?);
        }
    }
    if let Some(ref mut jump) = request.jump_host {
        if let Some(key_id) = jump.keychain_key_id.as_deref() {
            if jump.private_key_data.is_none() {
                jump.private_key_data = Some(load_keychain_private_key(credentials, key_id)?);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn start_port_forward(
    app: AppHandle,
    credentials: State<'_, crate::keychain::CredentialManager>,
    forwards_state: State<'_, crate::port_forward::PortForwardManager>,
    mut request: PortForwardStartRequest,
) -> Result<crate::port_forward::PortForwardRuntime, String> {
    info!(
        "Starting port forward operation_id={} profile_id={} config_id={}",
        request.operation_id, request.profile_id, request.forward.id
    );
    validate_connection_fields(&request.connection.host, &request.connection.username)?;
    crate::port_forward::validate_start_request(&request)?;
    resolve_keychain_key_for_remote(&credentials, &mut request.connection)?;

    let local_listener = if request.forward.kind == crate::models::PortForwardKind::Local {
        Some(crate::port_forward::bind_local_listener(&request.forward)?)
    } else {
        None
    };
    let cancel_flag = forwards_state.register(&request)?;
    let runtime = forwards_state
        .list()?
        .into_iter()
        .find(|runtime| runtime.operation_id == request.operation_id)
        .ok_or_else(|| "registered port forward disappeared".to_string())?;
    if let Err(error) = app.emit(crate::port_forward::PORT_FORWARD_EVENT, &runtime) {
        warn!("Failed to emit initial port forward state: {error}");
    }

    let manager = (*forwards_state).clone();
    let worker_app = app.clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app)
        .ok()
        .map(|p| p.to_string_lossy().to_string());
    thread::spawn(move || {
        crate::port_forward::start_port_forward(
            worker_app,
            manager,
            request,
            cancel_flag,
            local_listener,
            known_hosts,
        );
    });

    Ok(runtime)
}

#[tauri::command]
pub(crate) fn stop_port_forward(
    app: AppHandle,
    forwards_state: State<'_, crate::port_forward::PortForwardManager>,
    operation_id: String,
) -> Result<crate::port_forward::PortForwardRuntime, String> {
    info!("Stopping port forward operation_id={operation_id}");
    let runtime = forwards_state.cancel(&operation_id)?;
    if let Err(error) = app.emit(crate::port_forward::PORT_FORWARD_EVENT, &runtime) {
        warn!("Failed to emit stopping port forward state: {error}");
    }
    Ok(runtime)
}

#[tauri::command]
pub(crate) fn stop_all_port_forwards(
    app: AppHandle,
    forwards_state: State<'_, crate::port_forward::PortForwardManager>,
) -> Result<Vec<crate::port_forward::PortForwardRuntime>, String> {
    let runtimes = forwards_state.cancel_all()?;
    for runtime in &runtimes {
        if let Err(error) = app.emit(crate::port_forward::PORT_FORWARD_EVENT, runtime) {
            warn!("Failed to emit stopping port forward state: {error}");
        }
    }
    Ok(runtimes)
}

#[tauri::command]
pub(crate) fn list_port_forwards(
    forwards_state: State<'_, crate::port_forward::PortForwardManager>,
) -> Result<Vec<crate::port_forward::PortForwardRuntime>, String> {
    forwards_state.list()
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
pub(crate) async fn preflight_connection(
    app: AppHandle,
    credentials: State<'_, crate::keychain::CredentialManager>,
    preflights: State<'_, PreflightCancellationRegistry>,
    mut request: ConnectionPreflightRequest,
) -> Result<ConnectionPreflightResult, String> {
    if request.operation_id.is_empty()
        || !request.operation_id.is_ascii()
        || !request
            .operation_id
            .chars()
            .enumerate()
            .all(|(index, character)| {
                (index == 0 && character.is_ascii_alphanumeric())
                    || (index > 0
                        && (character.is_ascii_alphanumeric()
                            || matches!(character, '.' | '_' | ':' | '-')))
            })
        || request.operation_id.len() > 128
    {
        return Err("invalid connection preflight operation id".to_string());
    }

    resolve_keychain_key_for_remote(&credentials, &mut request.connection)?;
    let operation_id = request.operation_id.clone();
    let endpoint = summarize_remote_connection_request(&request.connection);
    let known_hosts_path = crate::known_hosts::known_hosts_path(&app)?;
    let cancel_flag = preflights.register(operation_id.clone())?;
    info!("Starting connection preflight operation_id={operation_id} {endpoint}");

    let task_operation_id = operation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::connection::preflight_connection(
            request.connection,
            task_operation_id,
            &known_hosts_path,
            &cancel_flag,
        )
    })
    .await;

    // Always release the operation id, including when the blocking task panics.
    let _ = preflights.remove(&operation_id);
    let result = result.map_err(|error| format!("failed to join preflight task: {error}"))?;
    info!(
        "Finished connection preflight operation_id={} status={:?}",
        operation_id, result.status
    );
    Ok(result)
}

#[tauri::command]
pub(crate) fn cancel_connection_preflight(
    preflights: State<'_, PreflightCancellationRegistry>,
    operation_id: String,
) -> Result<(), String> {
    info!("Cancelling connection preflight operation_id={operation_id}");
    preflights.cancel(&operation_id)
}

#[tauri::command]
pub(crate) async fn trust_host(app: AppHandle, request: TrustHostRequest) -> Result<(), String> {
    info!("Trusting host {}:{}", request.host, request.port);
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::known_hosts::trust_host_blocking(&app, &request)
    })
    .await
    .map_err(|error| format!("failed to join trust host task: {error}"))?;
    if let Err(error) = &result {
        error!("Trust host failed: {error}");
    } else {
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
        return Err(format!(
            "refused to open URL containing shell metacharacters: {url}"
        ));
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

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read known hosts file: {error}"))?;
    let session =
        Session::new().map_err(|error| format!("failed to create ssh session: {error}"))?;
    let mut known_hosts = session
        .known_hosts()
        .map_err(|error| format!("failed to initialize known hosts: {error}"))?;

    if let Err(error) = known_hosts.read_file(&path, KnownHostFileKind::OpenSSH) {
        warn!("Failed to parse known hosts file: {error}");
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
            ssh2::HostKeyType::Ecdsa256
            | ssh2::HostKeyType::Ecdsa384
            | ssh2::HostKeyType::Ecdsa521 => "ECDSA",
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
    use crate::known_hosts::{known_hosts_path, KNOWN_HOSTS_WRITE_LOCK};
    use std::fs;

    let _lock = KNOWN_HOSTS_WRITE_LOCK
        .lock()
        .map_err(|_| "known hosts write lock poisoned".to_string())?;

    let path = known_hosts_path(&app)?;
    if !path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read known hosts file: {error}"))?;
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

    fs::write(&path, filtered.join("\n"))
        .map_err(|error| format!("failed to write known hosts file: {error}"))?;
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
    for entry in
        fs::read_dir(&log_dir).map_err(|error| format!("failed to read log dir: {error}"))?
    {
        let entry = entry.map_err(|error| format!("failed to read log dir entry: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !(name.starts_with("backend") || name.starts_with("frontend")) || !name.ends_with(".log")
        {
            continue;
        }

        let metadata = entry
            .metadata()
            .map_err(|error| format!("failed to read log file metadata: {error}"))?;
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

    files.sort_by_key(|file| std::cmp::Reverse(file.modified_at));
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

    let metadata = fs::metadata(&path)
        .map_err(|error| format!("failed to read log file metadata: {error}"))?;
    const MAX_SIZE: u64 = 2 * 1024 * 1024;
    let size = metadata.len().min(MAX_SIZE);

    let content = if size == metadata.len() {
        fs::read_to_string(&path).map_err(|error| format!("failed to read log file: {error}"))?
    } else {
        let mut file =
            fs::File::open(&path).map_err(|error| format!("failed to open log file: {error}"))?;
        use std::io::Read;
        let mut buffer = vec![0u8; size as usize];
        file.read_exact(&mut buffer)
            .map_err(|error| format!("failed to read log file: {error}"))?;
        String::from_utf8_lossy(&buffer).to_string()
    };

    Ok(content)
}

#[tauri::command]
pub(crate) async fn export_log_file(
    name: String,
    content: String,
) -> Result<Option<String>, String> {
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
pub(crate) fn list_local_directory(
    app: AppHandle,
    path: String,
) -> Result<LocalDirectoryListing, String> {
    use std::fs;
    use std::path::PathBuf;

    let target = if path.is_empty() {
        app.path()
            .home_dir()
            .map_err(|error| format!("failed to resolve home directory: {error}"))?
    } else {
        PathBuf::from(&path)
    };

    let canonical =
        fs::canonicalize(&target).map_err(|error| format!("failed to resolve path: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("path is not a directory: {}", canonical.display()));
    }

    let parent_path = canonical.parent().map(portable_local_path);

    let mut entries = Vec::new();
    for entry in
        fs::read_dir(&canonical).map_err(|error| format!("failed to read directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
        let metadata = entry
            .metadata()
            .map_err(|error| format!("failed to read entry metadata: {error}"))?;
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
            size: if metadata.is_dir() {
                None
            } else {
                Some(metadata.len())
            },
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

fn configure_local_terminal_environment(command: &mut CommandBuilder) {
    // Desktop applications on macOS and Windows commonly start without TERM.
    // Interactive shells and plugins (notably zsh-autosuggestions) then fall
    // back to incomplete terminal capabilities and their ZLE redraw sequences
    // leave stale characters on screen. Keep this aligned with the terminal
    // type requested for SSH sessions in session.rs.
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "TermBridge");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
}

fn contains_shell_metacharacters(input: &str) -> bool {
    input
        .chars()
        .any(|c| matches!(c, '&' | '|' | '<' | '>' | '(' | ')' | '^' | '"' | '%' | '!'))
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
        keychain_key_id: request.keychain_key_id.clone(),
        private_key_data: request.private_key_data.clone(),
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
    wake: SessionWakeSource,
    output_ready: Arc<AtomicBool>,
    output_paused: Arc<AtomicBool>,
    pool: SftpPool,
    connection_request: RemoteConnectionRequest,
    connection_result_tx: Option<std::sync::mpsc::Sender<Result<(), CreateSessionError>>>,
) {
    thread::spawn(move || {
        debug!("Spawned SSH worker session_id={session_id}");
        let _guard = PoolInvalidationGuard {
            pool: &pool,
            connection_request: &connection_request,
        };
        let identity = SessionIdentity {
            title: request.name.clone(),
            host: request.host.clone(),
            port: request.port,
            username: request.username.clone(),
        };

        let tx_for_connected = connection_result_tx.clone();
        let on_connected = move || {
            if let Some(tx) = tx_for_connected.as_ref() {
                let _ = tx.send(Ok(()));
            }
        };
        let run_result = run_ssh_session(
            &app,
            &session_id,
            &request,
            rx,
            wake,
            output_ready,
            output_paused,
            on_connected,
        );

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
                let _ = emit_closed(
                    &app,
                    &session_id,
                    Some(identity),
                    message,
                    reason_kind,
                    retryable,
                );
            }
            Err(connection_error) => {
                if let Some(tx) = connection_result_tx.as_ref() {
                    let _ = tx.send(Err(connection_error.to_create_session_error()));
                }
                let message = connection_error.message();
                error!("SSH session failed session_id={session_id}: {message}");
                let retryable = is_transport_disconnect_message(&message);
                let _ = emit_status(
                    &app,
                    &session_id,
                    SessionStatus::Error,
                    Some(message.clone()),
                );
                let _ = emit_closed(
                    &app,
                    &session_id,
                    Some(identity),
                    Some(message),
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

// --- Database commands ---

#[tauri::command]
pub(crate) fn list_profiles(db: State<'_, Database>) -> Result<Vec<ProfileRow>, String> {
    db.list_profiles()
}

#[tauri::command]
pub(crate) fn add_profile(db: State<'_, Database>, profile: ProfileRow) -> Result<(), String> {
    db.insert_profile(&profile)
}

#[tauri::command]
pub(crate) fn update_profile(
    db: State<'_, Database>,
    id: String,
    profile: ProfileRow,
) -> Result<(), String> {
    db.update_profile(&id, &profile)
}

#[tauri::command]
pub(crate) fn remove_profile(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_profile(&id)
}

#[tauri::command]
pub(crate) fn load_preferences(db: State<'_, Database>) -> Result<Vec<(String, String)>, String> {
    db.load_preferences()
}

#[tauri::command]
pub(crate) fn save_preferences(
    db: State<'_, Database>,
    entries: Vec<(String, String)>,
) -> Result<(), String> {
    db.save_preferences(&entries)
}

#[tauri::command]
pub(crate) fn list_recent_profiles(db: State<'_, Database>) -> Result<Vec<String>, String> {
    db.list_recent_profiles()
}

#[tauri::command]
pub(crate) fn touch_recent_profile(
    db: State<'_, Database>,
    profile_id: String,
) -> Result<(), String> {
    db.touch_recent_profile(&profile_id)
}

#[tauri::command]
pub(crate) fn remove_recent_profile(
    db: State<'_, Database>,
    profile_id: String,
) -> Result<(), String> {
    db.remove_recent_profile(&profile_id)
}

#[tauri::command]
pub(crate) fn list_sftp_bookmarks(
    db: State<'_, Database>,
    host: String,
    port: u16,
    username: String,
) -> Result<Vec<SftpBookmarkRow>, String> {
    db.list_sftp_bookmarks(&host, port, &username)
}

#[tauri::command]
pub(crate) fn add_sftp_bookmark(
    db: State<'_, Database>,
    bookmark: SftpBookmarkRow,
) -> Result<(), String> {
    db.insert_sftp_bookmark(&bookmark)
}

#[tauri::command]
pub(crate) fn remove_sftp_bookmark(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_sftp_bookmark(&id)
}

#[tauri::command]
pub(crate) fn load_terminal_workspace(db: State<'_, Database>) -> Result<Option<String>, String> {
    db.load_terminal_workspace()
}

#[tauri::command]
pub(crate) fn save_terminal_workspace(
    db: State<'_, Database>,
    sessions_json: String,
) -> Result<(), String> {
    db.save_terminal_workspace(&sessions_json)
}

#[tauri::command]
pub(crate) fn clear_terminal_workspace(db: State<'_, Database>) -> Result<(), String> {
    db.clear_terminal_workspace()
}

#[tauri::command]
pub(crate) fn load_sftp_workspace(db: State<'_, Database>) -> Result<Option<String>, String> {
    db.load_sftp_workspace()
}

#[tauri::command]
pub(crate) fn save_sftp_workspace(
    db: State<'_, Database>,
    workspace_json: String,
) -> Result<(), String> {
    db.save_sftp_workspace(&workspace_json)
}

#[tauri::command]
pub(crate) fn clear_sftp_workspace(db: State<'_, Database>) -> Result<(), String> {
    db.clear_sftp_workspace()
}

#[cfg(test)]
mod tests {
    use super::{configure_local_terminal_environment, detect_key_type, expand_home_path};
    use portable_pty::CommandBuilder;
    use std::ffi::OsStr;

    #[test]
    fn local_shell_uses_xterm_terminal_capabilities() {
        let mut command = CommandBuilder::new("shell");

        configure_local_terminal_environment(&mut command);

        assert_eq!(command.get_env("TERM"), Some(OsStr::new("xterm-256color")));
        assert_eq!(command.get_env("COLORTERM"), Some(OsStr::new("truecolor")));
        assert_eq!(
            command.get_env("TERM_PROGRAM"),
            Some(OsStr::new("TermBridge"))
        );
        assert_eq!(
            command.get_env("TERM_PROGRAM_VERSION"),
            Some(OsStr::new(env!("CARGO_PKG_VERSION"))),
        );
    }

    #[test]
    fn detect_key_type_recognizes_openssh_ed25519_private_key() {
        let body = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            b"openssh-key-v1\x00\x00\x00\x00\x00\x00\x00\x00ssh-ed25519",
        );
        let key = format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----",
            body
        );
        assert_eq!(detect_key_type(&key), "ed25519");
    }

    #[test]
    fn detect_key_type_recognizes_openssh_rsa_private_key() {
        let body = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            b"openssh-key-v1\x00\x00\x00\x00\x00\x00\x00\x00ssh-rsa",
        );
        let key = format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----",
            body
        );
        assert_eq!(detect_key_type(&key), "rsa");
    }

    #[test]
    fn expands_openssh_home_relative_identity_paths() {
        let home = std::path::Path::new("/home/tester");
        assert_eq!(
            expand_home_path("~/.ssh/id_ed25519", home),
            home.join(".ssh/id_ed25519")
        );
        assert_eq!(
            expand_home_path("~\\.ssh\\id_ed25519", home),
            home.join(".ssh\\id_ed25519")
        );
        assert_eq!(
            expand_home_path("/tmp/id_ed25519", home),
            std::path::PathBuf::from("/tmp/id_ed25519")
        );
    }
}
