use log::{debug, error, info, warn, LevelFilter};
#[cfg(unix)]
use libc::{poll, pollfd, POLLIN, POLLOUT};
use serde::{Deserialize, Serialize};
use socket2::{SockRef, TcpKeepalive};
use ssh2::{
    BlockDirections, Channel, ExtendedData, FileStat, OpenFlags, OpenType, RenameFlags, Session,
    Sftp,
};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs,
    io::{copy, ErrorKind, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        mpsc::{self, Receiver, Sender, TryRecvError},
        Arc,
        Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[cfg(unix)]
use std::os::fd::AsRawFd;

const SSH_DATA_EVENT: &str = "ssh-data";
const SSH_STATUS_EVENT: &str = "ssh-status";
const SSH_CLOSED_EVENT: &str = "ssh-closed";
const UPLOAD_PROGRESS_EVENT: &str = "upload-progress";
const DELETE_PROGRESS_EVENT: &str = "delete-progress";
const MENU_CHECK_UPDATE_ID: &str = "menu.check_update";
const TRAY_CHECK_UPDATE_ID: &str = "tray.check_update";
const SYSTEM_CHECK_UPDATE_EVENT: &str = "system-check-update";
#[cfg(target_os = "windows")]
const TRAY_SHOW_MAIN_WINDOW_ID: &str = "tray.show_main_window";
#[cfg(target_os = "windows")]
const TRAY_QUIT_ID: &str = "tray.quit";
const SSH_TCP_KEEPALIVE_TIME_SECS: u64 = 30;
const SSH_TCP_KEEPALIVE_INTERVAL_SECS: u64 = 15;
const SSH_IDLE_WAIT_SLICE_MS: u64 = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    session_id: String,
    title: String,
    host: String,
    port: u16,
    username: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCreateRequest {
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_method: AuthMethod,
    password: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
    terminal_cols: u32,
    terminal_rows: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteConnectionRequest {
    host: String,
    port: u16,
    username: String,
    auth_method: AuthMethod,
    password: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteDirectoryRequest {
    #[serde(flatten)]
    connection: RemoteConnectionRequest,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRemoteEntryRequest {
    #[serde(flatten)]
    connection: RemoteConnectionRequest,
    parent_path: String,
    name: String,
    kind: CreateRemoteEntryKind,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum CreateRemoteEntryKind {
    File,
    Directory,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameRemotePathRequest {
    #[serde(flatten)]
    connection: RemoteConnectionRequest,
    path: String,
    new_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteRemotePathRequest {
    #[serde(flatten)]
    connection: RemoteConnectionRequest,
    path: String,
    operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyRemotePathRequest {
    #[serde(flatten)]
    connection: RemoteConnectionRequest,
    source_path: String,
    destination_directory: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenRemoteFileRequest {
    #[serde(flatten)]
    connection: RemoteConnectionRequest,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadLocalPathsRequest {
    #[serde(flatten)]
    connection: RemoteConnectionRequest,
    destination_directory: String,
    local_paths: Vec<String>,
    #[serde(default)]
    conflict_policies: Vec<UploadConflictPolicy>,
    operation_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum AuthMethod {
    Password,
    Key,
}

impl AuthMethod {
    fn as_str(self) -> &'static str {
        match self {
            AuthMethod::Password => "password",
            AuthMethod::Key => "key",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum UploadConflictPolicy {
    Overwrite,
    Skip,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    session_id: String,
    status: SessionStatus,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataEvent {
    session_id: String,
    chunk: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosedEvent {
    session_id: String,
    reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadProgressEvent {
    operation_id: String,
    current_path: Option<String>,
    total_bytes: u64,
    uploaded_bytes: u64,
    total_steps: u64,
    completed_steps: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteProgressEvent {
    operation_id: String,
    current_path: Option<String>,
    total_steps: u64,
    completed_steps: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteDirectoryListing {
    path: String,
    parent_path: Option<String>,
    entries: Vec<RemoteFileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFileEntry {
    path: String,
    name: String,
    kind: RemoteFileKind,
    size: Option<u64>,
    modified_at: Option<u64>,
    permissions: Option<u32>,
    owner_uid: Option<u32>,
    group_gid: Option<u32>,
    owner_name: Option<String>,
    group_name: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum SessionStatus {
    Connecting,
    Connected,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum RemoteFileKind {
    Directory,
    File,
    Symlink,
    Other,
}

enum SessionCommand {
    Write(String),
    Resize { cols: u32, rows: u32 },
    Close,
}

struct ManagedSession {
    sender: Sender<SessionCommand>,
}

#[derive(Default)]
struct SessionManager {
    sessions: Mutex<HashMap<String, ManagedSession>>,
}

struct ConnectedSftp {
    session: Session,
    sftp: Sftp,
}

#[derive(Default)]
struct UploadCancellationRegistry {
    operations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Default)]
struct DeleteCancellationRegistry {
    operations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Default, Clone, Copy)]
struct UploadScanStats {
    total_bytes: u64,
    total_steps: u64,
}

impl UploadScanStats {
    fn combine(&mut self, other: UploadScanStats) {
        self.total_bytes += other.total_bytes;
        self.total_steps += other.total_steps;
    }
}

struct UploadProgressTracker {
    app: AppHandle,
    operation_id: String,
    cancel_flag: Arc<AtomicBool>,
    current_path: Option<String>,
    total_bytes: u64,
    uploaded_bytes: u64,
    total_steps: u64,
    completed_steps: u64,
}

struct DeleteProgressTracker {
    app: AppHandle,
    operation_id: String,
    cancel_flag: Arc<AtomicBool>,
    current_path: Option<String>,
    total_steps: u64,
    completed_steps: u64,
}

impl UploadProgressTracker {
    fn new(
        app: AppHandle,
        operation_id: String,
        cancel_flag: Arc<AtomicBool>,
        stats: UploadScanStats,
    ) -> Self {
        Self {
            app,
            operation_id,
            cancel_flag,
            current_path: None,
            total_bytes: stats.total_bytes,
            uploaded_bytes: 0,
            total_steps: stats.total_steps,
            completed_steps: 0,
        }
    }

    fn set_current_path(&mut self, path: Option<String>) -> Result<(), String> {
        self.current_path = path;
        self.emit()
    }

    fn advance_bytes(&mut self, count: u64) -> Result<(), String> {
        self.uploaded_bytes += count;
        self.emit()
    }

    fn finish_step(&mut self) -> Result<(), String> {
        self.completed_steps = (self.completed_steps + 1).min(self.total_steps);
        self.emit()
    }

    fn ensure_not_cancelled(&self) -> Result<(), String> {
        if self.cancel_flag.load(AtomicOrdering::SeqCst) {
            return Err("upload cancelled".to_string());
        }
        Ok(())
    }

    fn emit(&self) -> Result<(), String> {
        self.app
            .emit(
                UPLOAD_PROGRESS_EVENT,
                UploadProgressEvent {
                    operation_id: self.operation_id.clone(),
                    current_path: self.current_path.clone(),
                    total_bytes: self.total_bytes,
                    uploaded_bytes: self.uploaded_bytes,
                    total_steps: self.total_steps,
                    completed_steps: self.completed_steps,
                },
            )
            .map_err(|error| format!("failed to emit upload progress event: {error}"))
    }
}

impl DeleteProgressTracker {
    fn new(
        app: AppHandle,
        operation_id: String,
        cancel_flag: Arc<AtomicBool>,
        total_steps: u64,
    ) -> Self {
        Self {
            app,
            operation_id,
            cancel_flag,
            current_path: None,
            total_steps,
            completed_steps: 0,
        }
    }

    fn set_current_path(&mut self, path: Option<String>) -> Result<(), String> {
        self.current_path = path;
        self.emit()
    }

    fn finish_step(&mut self) -> Result<(), String> {
        self.completed_steps = (self.completed_steps + 1).min(self.total_steps);
        self.emit()
    }

    fn ensure_not_cancelled(&self) -> Result<(), String> {
        if self.cancel_flag.load(AtomicOrdering::SeqCst) {
            return Err("delete cancelled".to_string());
        }
        Ok(())
    }

    fn emit(&self) -> Result<(), String> {
        self.app
            .emit(
                DELETE_PROGRESS_EVENT,
                DeleteProgressEvent {
                    operation_id: self.operation_id.clone(),
                    current_path: self.current_path.clone(),
                    total_steps: self.total_steps,
                    completed_steps: self.completed_steps,
                },
            )
            .map_err(|error| format!("failed to emit delete progress event: {error}"))
    }
}

impl SessionManager {
    fn insert(&self, session_id: String, managed: ManagedSession) -> Result<(), String> {
        let mut guard = self
            .sessions
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        guard.insert(session_id, managed);
        Ok(())
    }

    fn send(&self, session_id: &str, command: SessionCommand) -> Result<(), String> {
        let guard = self
            .sessions
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        let managed = guard
            .get(session_id)
            .ok_or_else(|| format!("session {session_id} not found"))?;
        managed
            .sender
            .send(command)
            .map_err(|_| format!("session {session_id} is not available"))
    }

    fn remove(&self, session_id: &str) -> Result<(), String> {
        let mut guard = self
            .sessions
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        guard.remove(session_id);
        Ok(())
    }
}

impl UploadCancellationRegistry {
    fn register(&self, operation_id: String) -> Result<Arc<AtomicBool>, String> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "upload cancellation registry poisoned".to_string())?;
        guard.insert(operation_id, flag.clone());
        Ok(flag)
    }

    fn cancel(&self, operation_id: &str) -> Result<(), String> {
        let guard = self
            .operations
            .lock()
            .map_err(|_| "upload cancellation registry poisoned".to_string())?;
        let flag = guard
            .get(operation_id)
            .ok_or_else(|| format!("upload operation {operation_id} not found"))?;
        flag.store(true, AtomicOrdering::SeqCst);
        Ok(())
    }

    fn remove(&self, operation_id: &str) -> Result<(), String> {
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "upload cancellation registry poisoned".to_string())?;
        guard.remove(operation_id);
        Ok(())
    }
}

impl DeleteCancellationRegistry {
    fn register(&self, operation_id: String) -> Result<Arc<AtomicBool>, String> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "delete cancellation registry poisoned".to_string())?;
        guard.insert(operation_id, flag.clone());
        Ok(flag)
    }

    fn cancel(&self, operation_id: &str) -> Result<(), String> {
        let guard = self
            .operations
            .lock()
            .map_err(|_| "delete cancellation registry poisoned".to_string())?;
        let flag = guard
            .get(operation_id)
            .ok_or_else(|| format!("delete operation {operation_id} not found"))?;
        flag.store(true, AtomicOrdering::SeqCst);
        Ok(())
    }

    fn remove(&self, operation_id: &str) -> Result<(), String> {
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "delete cancellation registry poisoned".to_string())?;
        guard.remove(operation_id);
        Ok(())
    }
}

#[tauri::command]
fn create_session(
    app: AppHandle,
    state: State<'_, SessionManager>,
    request: SessionCreateRequest,
) -> Result<SessionSummary, String> {
    validate_connection_fields(&request.host, &request.username)?;
    info!("Creating SSH session {}", summarize_session_request(&request));

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
fn write_session(
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
fn resize_session(
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
fn close_session(state: State<'_, SessionManager>, session_id: String) -> Result<(), String> {
    info!("Closing SSH session session_id={session_id}");
    let result = state.send(&session_id, SessionCommand::Close);
    let _ = state.remove(&session_id);
    if let Err(error) = &result {
        warn!("Failed to close SSH session session_id={session_id}: {error}");
    }
    result
}

#[tauri::command]
fn request_app_restart(app: AppHandle) {
    info!("Requesting application restart");
    app.request_restart();
}

#[tauri::command]
async fn list_remote_directory(request: RemoteDirectoryRequest) -> Result<RemoteDirectoryListing, String> {
    let requested_path = request.path.clone().unwrap_or_else(|| ".".to_string());
    debug!(
        "Listing remote directory path={} {}",
        requested_path,
        summarize_remote_connection_request(&request.connection)
    );
    let result = tauri::async_runtime::spawn_blocking(move || list_remote_directory_blocking(request))
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
async fn create_remote_entry(request: CreateRemoteEntryRequest) -> Result<(), String> {
    info!(
        "Creating remote entry parent_path={} name={} kind={:?} {}",
        request.parent_path,
        request.name,
        request.kind,
        summarize_remote_connection_request(&request.connection)
    );
    let result = tauri::async_runtime::spawn_blocking(move || create_remote_entry_blocking(request))
        .await
        .map_err(|error| format!("failed to join create entry task: {error}"))?;
    if result.is_ok() {
        info!("Created remote entry successfully");
    }
    result
}

#[tauri::command]
async fn rename_remote_path(request: RenameRemotePathRequest) -> Result<(), String> {
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
async fn delete_remote_path(
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
async fn copy_remote_path(request: CopyRemotePathRequest) -> Result<(), String> {
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
async fn upload_local_paths(
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
fn cancel_upload(
    uploads: State<'_, UploadCancellationRegistry>,
    operation_id: String,
) -> Result<(), String> {
    info!("Cancelling upload operation_id={operation_id}");
    uploads.cancel(&operation_id)
}

#[tauri::command]
fn cancel_delete(
    deletes: State<'_, DeleteCancellationRegistry>,
    operation_id: String,
) -> Result<(), String> {
    info!("Cancelling delete operation_id={operation_id}");
    deletes.cancel(&operation_id)
}

#[tauri::command]
fn pick_local_files() -> Result<Vec<String>, String> {
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
fn pick_local_folder() -> Result<Vec<String>, String> {
    let path = rfd::FileDialog::new()
        .set_title("选择要上传的文件夹")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string());
    Ok(path.into_iter().collect())
}

#[tauri::command]
async fn open_remote_file(request: OpenRemoteFileRequest) -> Result<(), String> {
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

fn spawn_ssh_thread(
    app: AppHandle,
    session_id: String,
    request: SessionCreateRequest,
    rx: Receiver<SessionCommand>,
) {
    thread::spawn(move || {
        debug!("Spawned SSH worker session_id={session_id}");
        let run_result = run_ssh_session(&app, &session_id, &request, rx);

        match run_result {
            Ok(message) => {
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
                let _ = emit_closed(&app, &session_id, message);
            }
            Err(error) => {
                error!("SSH session failed session_id={session_id}: {error}");
                let _ = emit_status(
                    &app,
                    &session_id,
                    SessionStatus::Error,
                    Some(error.clone()),
                );
                let _ = emit_closed(&app, &session_id, Some(error));
            }
        }

        let manager = app.state::<SessionManager>();
        let _ = manager.remove(&session_id);
    });
}

fn run_ssh_session(
    app: &AppHandle,
    session_id: &str,
    request: &SessionCreateRequest,
    rx: Receiver<SessionCommand>,
) -> Result<Option<String>, String> {
    info!(
        "SSH session connecting session_id={} {}",
        session_id,
        summarize_session_request(request)
    );
    emit_status(
        app,
        session_id,
        SessionStatus::Connecting,
        Some(format!("dialing {}:{}...", request.host, request.port)),
    )?;

    let tcp = connect_tcp_stream(&request.host, request.port)?;
    let session = open_authenticated_session(
        tcp,
        &request.username,
        request.auth_method,
        request.password.as_deref(),
        request.private_key_path.as_deref(),
        request.passphrase.as_deref(),
    )?;

    let mut channel = session
        .channel_session()
        .map_err(|error| format!("failed to open ssh channel: {error}"))?;
    channel
        .request_pty(
            "xterm-256color",
            None,
            Some((request.terminal_cols, request.terminal_rows, 0, 0)),
        )
        .map_err(|error| format!("failed to allocate PTY: {error}"))?;
    channel
        .handle_extended_data(ExtendedData::Merge)
        .map_err(|error| format!("failed to configure extended-data mode: {error}"))?;
    channel
        .shell()
        .map_err(|error| format!("failed to start remote shell: {error}"))?;
    session.set_blocking(false);

    info!("SSH session connected session_id={session_id}");
    emit_status(
        app,
        session_id,
        SessionStatus::Connected,
        Some("shell ready".to_string()),
    )?;

    session_loop(app, session_id, &session, &mut channel, rx)
}

fn list_remote_directory_blocking(
    request: RemoteDirectoryRequest,
) -> Result<RemoteDirectoryListing, String> {
    let connected = connect_sftp(&request.connection)?;
    list_remote_directory_from_sftp(&connected.session, &connected.sftp, request.path.as_deref())
}

fn create_remote_entry_blocking(request: CreateRemoteEntryRequest) -> Result<(), String> {
    validate_remote_name(&request.name)?;

    let connected = connect_sftp(&request.connection)?;
    let parent_path = Path::new(&request.parent_path);
    ensure_remote_directory(&connected.sftp, parent_path)?;

    let target_path = parent_path.join(request.name.trim());
    if remote_path_exists(&connected.sftp, &target_path) {
        return Err(format!(
            "remote path already exists: {}",
            path_to_string(&target_path)
        ));
    }

    match request.kind {
        CreateRemoteEntryKind::Directory => connected
            .sftp
            .mkdir(&target_path, 0o755)
            .map_err(|error| format!("failed to create remote directory: {error}"))?,
        CreateRemoteEntryKind::File => {
            let mut file = connected
                .sftp
                .open_mode(
                    &target_path,
                    OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUSIVE,
                    0o644,
                    OpenType::File,
                )
                .map_err(|error| format!("failed to create remote file: {error}"))?;
            file.flush()
                .map_err(|error| format!("failed to finalize remote file creation: {error}"))?;
        }
    }

    Ok(())
}

fn rename_remote_path_blocking(request: RenameRemotePathRequest) -> Result<(), String> {
    validate_remote_name(&request.new_name)?;

    let connected = connect_sftp(&request.connection)?;
    let source_path = Path::new(&request.path);
    let parent_path = source_path
        .parent()
        .ok_or_else(|| "unable to resolve parent path for rename".to_string())?;
    let target_path = parent_path.join(request.new_name.trim());

    if source_path == target_path {
        return Ok(());
    }

    if remote_path_exists(&connected.sftp, &target_path) {
        return Err(format!(
            "rename target already exists: {}",
            path_to_string(&target_path)
        ));
    }

    connected
        .sftp
        .rename(
            source_path,
            &target_path,
            Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
        )
        .map_err(|error| format!("failed to rename remote path: {error}"))
}

fn delete_remote_path_blocking(
    app: AppHandle,
    request: DeleteRemotePathRequest,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let connected = connect_sftp(&request.connection)?;
    let target_path = Path::new(&request.path);
    let total_steps = count_remote_delete_steps(&connected.sftp, target_path)?;
    let mut progress =
        DeleteProgressTracker::new(app, request.operation_id.clone(), cancel_flag, total_steps);
    progress.emit()?;
    progress.ensure_not_cancelled()?;
    delete_remote_path_recursive(&connected.sftp, target_path, &mut progress)?;
    progress.set_current_path(None)?;
    Ok(())
}

fn copy_remote_path_blocking(request: CopyRemotePathRequest) -> Result<(), String> {
    let connected = connect_sftp(&request.connection)?;
    let source_path = Path::new(&request.source_path);
    let destination_directory = Path::new(&request.destination_directory);
    ensure_remote_directory(&connected.sftp, destination_directory)?;

    let source_name = source_path
        .file_name()
        .ok_or_else(|| "source path has no file name".to_string())?
        .to_string_lossy()
        .to_string();
    let destination_path =
        unique_remote_destination(&connected.sftp, destination_directory, &source_name)?;

    if destination_path.starts_with(source_path) {
        return Err("cannot paste a directory into itself".to_string());
    }

    let source_stat = connected
        .sftp
        .lstat(source_path)
        .map_err(|error| format!("failed to stat remote source: {error}"))?;
    copy_remote_entry_to_path(&connected.sftp, source_path, &destination_path, source_stat)
}

fn upload_local_paths_blocking(
    app: AppHandle,
    request: UploadLocalPathsRequest,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    if request.local_paths.is_empty() {
        return Err("no local files were provided for upload".to_string());
    }

    let connected = connect_sftp(&request.connection)?;
    let destination_directory = Path::new(&request.destination_directory);
    ensure_remote_directory(&connected.sftp, destination_directory)?;
    if !request.conflict_policies.is_empty()
        && request.conflict_policies.len() != request.local_paths.len()
    {
        return Err("upload conflict policy count does not match local paths".to_string());
    }

    let mut scan_stats = UploadScanStats::default();
    for local_path in &request.local_paths {
        scan_stats.combine(scan_local_upload_path(Path::new(local_path))?);
    }

    let mut progress =
        UploadProgressTracker::new(app, request.operation_id.clone(), cancel_flag, scan_stats);
    progress.emit()?;
    let mut existing_names = remote_entry_names(&connected.sftp, destination_directory)?;

    for (index, local_path) in request.local_paths.iter().enumerate() {
        progress.ensure_not_cancelled()?;
        let local_path = Path::new(local_path);
        let file_name = local_path
            .file_name()
            .ok_or_else(|| format!("invalid local path: {}", local_path.display()))?
            .to_string_lossy()
            .to_string();
        let conflict_policy = request
            .conflict_policies
            .get(index)
            .copied()
            .unwrap_or(UploadConflictPolicy::Fail);
        let destination_name =
            match resolve_upload_target_name(&existing_names, &file_name, conflict_policy)? {
                Some(name) => name,
                None => continue,
            };
        let destination_path = destination_directory.join(&destination_name);
        upload_local_entry_to_path(&connected.sftp, local_path, &destination_path, &mut progress)?;
        existing_names.insert(destination_name);
    }

    progress.set_current_path(None)?;

    Ok(())
}

fn open_remote_file_blocking(request: OpenRemoteFileRequest) -> Result<(), String> {
    let connected = connect_sftp(&request.connection)?;
    let remote_path = Path::new(&request.path);
    let stat = connected
        .sftp
        .lstat(remote_path)
        .map_err(|error| format!("failed to inspect remote file: {error}"))?;

    if kind_from_permissions(stat.perm) == RemoteFileKind::Directory {
        return Err("目录不支持使用默认编辑器打开".to_string());
    }

    let file_name = remote_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "remote-file".to_string());

    let open_root = std::env::temp_dir().join("termbridge-open");
    fs::create_dir_all(&open_root)
        .map_err(|error| format!("failed to create temp directory: {error}"))?;

    let local_path = open_root.join(format!("{}-{}", Uuid::new_v4(), file_name));
    let mut remote_file = connected
        .sftp
        .open(remote_path)
        .map_err(|error| format!("failed to open remote file: {error}"))?;
    let mut local_file = fs::File::create(&local_path)
        .map_err(|error| format!("failed to prepare local temp file: {error}"))?;
    copy(&mut remote_file, &mut local_file)
        .map_err(|error| format!("failed to download remote file: {error}"))?;
    local_file
        .flush()
        .map_err(|error| format!("failed to finalize temp file: {error}"))?;

    open_path_with_default_app(&local_path)
}

fn list_remote_directory_from_sftp(
    session: &Session,
    sftp: &Sftp,
    requested_path: Option<&str>,
) -> Result<RemoteDirectoryListing, String> {
    let requested_path = requested_path.unwrap_or(".");
    let resolved_path = sftp
        .realpath(Path::new(requested_path))
        .map_err(|error| format!("failed to resolve remote path {requested_path}: {error}"))?;

    let mut entries = sftp
        .readdir(&resolved_path)
        .map_err(|error| format!("failed to list remote directory: {error}"))?
        .into_iter()
        .map(|(path, stat)| map_remote_file(path, stat))
        .collect::<Vec<_>>();

    enrich_remote_entry_owners(session, &mut entries);
    entries.sort_by(sort_remote_entries);

    let current_path = path_to_string(&resolved_path);
    let parent_path = resolved_path.parent().and_then(|parent| {
        let next_parent = path_to_string(parent);
        if next_parent == current_path {
            None
        } else {
            Some(next_parent)
        }
    });

    Ok(RemoteDirectoryListing {
        path: current_path,
        parent_path,
        entries,
    })
}

fn enrich_remote_entry_owners(session: &Session, entries: &mut [RemoteFileEntry]) {
    let owner_ids = entries
        .iter()
        .filter_map(|entry| entry.owner_uid)
        .collect::<HashSet<_>>();
    let group_ids = entries
        .iter()
        .filter_map(|entry| entry.group_gid)
        .collect::<HashSet<_>>();

    let owner_names = resolve_remote_identity_names(session, &owner_ids, RemoteIdentityKind::User)
        .unwrap_or_default();
    let group_names = resolve_remote_identity_names(session, &group_ids, RemoteIdentityKind::Group)
        .unwrap_or_default();

    for entry in entries {
        entry.owner_name = entry.owner_uid.and_then(|uid| owner_names.get(&uid).cloned());
        entry.group_name = entry.group_gid.and_then(|gid| group_names.get(&gid).cloned());
    }
}

#[derive(Clone, Copy)]
enum RemoteIdentityKind {
    User,
    Group,
}

fn resolve_remote_identity_names(
    session: &Session,
    ids: &HashSet<u32>,
    kind: RemoteIdentityKind,
) -> Result<HashMap<u32, String>, String> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }

    let mut sorted_ids = ids.iter().copied().collect::<Vec<_>>();
    sorted_ids.sort_unstable();

    let command = build_remote_identity_lookup_command(&sorted_ids, kind);
    let output = run_remote_exec(session, &command)?;

    let mut names = HashMap::new();
    for line in output.lines() {
        let Some((id, name)) = line.split_once('\t') else {
            continue;
        };
        let Ok(parsed_id) = id.trim().parse::<u32>() else {
            continue;
        };
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            continue;
        }
        names.insert(parsed_id, trimmed_name.to_string());
    }

    Ok(names)
}

fn build_remote_identity_lookup_command(ids: &[u32], kind: RemoteIdentityKind) -> String {
    let ids_text = ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");

    let (python_module, python_lookup, python_field, getent_database) = match kind {
        RemoteIdentityKind::User => ("pwd", "getpwuid", "pw_name", "passwd"),
        RemoteIdentityKind::Group => ("grp", "getgrgid", "gr_name", "group"),
    };

    format!(
        "sh -lc 'if command -v getent >/dev/null 2>&1; then \
for id in {ids_text}; do \
entry=$(getent {getent_database} \"$id\" 2>/dev/null | cut -d: -f1); \
if [ -n \"$entry\" ]; then printf \"%s\\t%s\\n\" \"$id\" \"$entry\"; fi; \
done; \
else \
for id in {ids_text}; do \
entry=\"\"; \
if command -v python3 >/dev/null 2>&1; then \
entry=$(python3 -c \"import {python_module},sys; print(getattr({python_module}.{python_lookup}(int(sys.argv[1])), '{python_field}'))\" \"$id\" 2>/dev/null); \
elif command -v python >/dev/null 2>&1; then \
entry=$(python -c \"import {python_module},sys; print(getattr({python_module}.{python_lookup}(int(sys.argv[1])), '{python_field}'))\" \"$id\" 2>/dev/null); \
fi; \
if [ -n \"$entry\" ]; then printf \"%s\\t%s\\n\" \"$id\" \"$entry\"; fi; \
done; \
fi'"
    )
}

fn run_remote_exec(session: &Session, command: &str) -> Result<String, String> {
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("failed to open remote exec channel: {error}"))?;
    channel
        .exec(command)
        .map_err(|error| format!("failed to execute remote lookup command: {error}"))?;

    let mut output = String::new();
    channel
        .read_to_string(&mut output)
        .map_err(|error| format!("failed to read remote lookup output: {error}"))?;

    let mut stderr = String::new();
    let _ = channel.stderr().read_to_string(&mut stderr);
    let _ = channel.wait_close();

    Ok(output)
}

fn connect_sftp(request: &RemoteConnectionRequest) -> Result<ConnectedSftp, String> {
    validate_connection_fields(&request.host, &request.username)?;
    debug!("Connecting SFTP {}", summarize_remote_connection_request(request));

    let tcp = connect_tcp_stream(&request.host, request.port)?;
    let session = open_authenticated_session(
        tcp,
        &request.username,
        request.auth_method,
        request.password.as_deref(),
        request.private_key_path.as_deref(),
        request.passphrase.as_deref(),
    )?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("failed to open sftp subsystem: {error}"))?;

    debug!(
        "Connected SFTP host={} port={} username={}",
        request.host, request.port, request.username
    );
    Ok(ConnectedSftp {
        session,
        sftp,
    })
}

fn validate_connection_fields(host: &str, username: &str) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err("host is required".to_string());
    }
    if username.trim().is_empty() {
        return Err("username is required".to_string());
    }
    Ok(())
}

fn has_secret_value(value: Option<&str>) -> bool {
    value.is_some_and(|item| !item.trim().is_empty())
}

fn summarize_connection_fields(
    host: &str,
    port: u16,
    username: &str,
    auth_method: AuthMethod,
    password: Option<&str>,
    private_key_path: Option<&str>,
    passphrase: Option<&str>,
) -> String {
    format!(
        "host={} port={} username={} auth_method={} has_password={} has_private_key_path={} has_passphrase={}",
        host.trim(),
        port,
        username.trim(),
        auth_method.as_str(),
        has_secret_value(password),
        has_secret_value(private_key_path),
        has_secret_value(passphrase),
    )
}

fn summarize_session_request(request: &SessionCreateRequest) -> String {
    summarize_connection_fields(
        &request.host,
        request.port,
        &request.username,
        request.auth_method,
        request.password.as_deref(),
        request.private_key_path.as_deref(),
        request.passphrase.as_deref(),
    )
}

fn summarize_remote_connection_request(request: &RemoteConnectionRequest) -> String {
    summarize_connection_fields(
        &request.host,
        request.port,
        &request.username,
        request.auth_method,
        request.password.as_deref(),
        request.private_key_path.as_deref(),
        request.passphrase.as_deref(),
    )
}

fn connect_tcp_stream(host: &str, port: u16) -> Result<TcpStream, String> {
    let address = format!("{host}:{port}");
    debug!("Opening TCP connection address={address}");
    let socket_addr = address
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve {address}: {error}"))?
        .next()
        .ok_or_else(|| format!("no socket address found for {address}"))?;

    let tcp = TcpStream::connect_timeout(&socket_addr, Duration::from_secs(12))
        .map_err(|error| format!("failed to connect to {address}: {error}"))?;

    configure_tcp_stream(&tcp)
        .map_err(|error| format!("failed to configure TCP socket for {address}: {error}"))?;

    Ok(tcp)
}

fn configure_tcp_stream(tcp: &TcpStream) -> std::io::Result<()> {
    tcp.set_nodelay(true)?;

    let keepalive = TcpKeepalive::new()
        .with_time(Duration::from_secs(SSH_TCP_KEEPALIVE_TIME_SECS))
        .with_interval(Duration::from_secs(SSH_TCP_KEEPALIVE_INTERVAL_SECS));

    SockRef::from(tcp).set_tcp_keepalive(&keepalive)?;
    Ok(())
}

fn open_authenticated_session(
    tcp: TcpStream,
    username: &str,
    auth_method: AuthMethod,
    password: Option<&str>,
    private_key_path: Option<&str>,
    passphrase: Option<&str>,
) -> Result<Session, String> {
    debug!(
        "Opening authenticated SSH session username={} auth_method={}",
        username,
        auth_method.as_str()
    );
    let mut session = Session::new().map_err(|error| format!("session init failed: {error}"))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|error| format!("ssh handshake failed: {error}"))?;

    authenticate(
        &mut session,
        username,
        auth_method,
        password,
        private_key_path,
        passphrase,
    )?;

    debug!(
        "SSH authentication succeeded username={} auth_method={}",
        username,
        auth_method.as_str()
    );
    Ok(session)
}

fn authenticate(
    session: &mut Session,
    username: &str,
    auth_method: AuthMethod,
    password: Option<&str>,
    private_key_path: Option<&str>,
    passphrase: Option<&str>,
) -> Result<(), String> {
    match auth_method {
        AuthMethod::Password => {
            let password =
                password.ok_or_else(|| "password auth selected, but no password provided".to_string())?;
            session
                .userauth_password(username, password)
                .map_err(|error| format!("password auth failed: {error}"))?;
        }
        AuthMethod::Key => {
            let private_key_path = private_key_path
                .ok_or_else(|| "private key auth selected, but no key path provided".to_string())?;
            session
                .userauth_pubkey_file(username, None, Path::new(private_key_path), passphrase)
                .map_err(|error| format!("private key auth failed: {error}"))?;
        }
    }

    if session.authenticated() {
        Ok(())
    } else {
        Err("ssh authentication failed".to_string())
    }
}

fn validate_remote_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("name is required".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("'.' and '..' are not valid file names".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("file name must not include path separators".to_string());
    }
    Ok(())
}

fn remote_path_exists(sftp: &Sftp, path: &Path) -> bool {
    sftp.lstat(path).is_ok()
}

fn ensure_remote_directory(sftp: &Sftp, path: &Path) -> Result<(), String> {
    let path_string = path_to_string(path);
    if path_string.is_empty() || path == Path::new(".") || path == Path::new("/") {
        return Ok(());
    }

    match sftp.stat(path) {
        Ok(stat) => match kind_from_permissions(stat.perm) {
            RemoteFileKind::Directory => return Ok(()),
            _ => {
                return Err(format!(
                    "remote path exists but is not a directory: {}",
                    path_to_string(path)
                ))
            }
        },
        Err(_) => {}
    }

    if let Some(parent) = path.parent() {
        let parent_string = path_to_string(parent);
        if parent_string != path_string {
            ensure_remote_directory(sftp, parent)?;
        }
    }

    match sftp.mkdir(path, 0o755) {
        Ok(()) => Ok(()),
        Err(error) if remote_path_exists(sftp, path) => match sftp.stat(path) {
            Ok(stat) if kind_from_permissions(stat.perm) == RemoteFileKind::Directory => Ok(()),
            Ok(_) => Err(format!(
                "remote path exists but is not a directory: {}",
                path_to_string(path)
            )),
            Err(_) => Err(format!("failed to create remote directory: {error}")),
        },
        Err(error) => Err(format!("failed to create remote directory: {error}")),
    }
}

fn count_remote_delete_steps(sftp: &Sftp, path: &Path) -> Result<u64, String> {
    let stat = sftp
        .lstat(path)
        .map_err(|error| format!("failed to inspect remote path: {error}"))?;

    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            let entries = sftp
                .readdir(path)
                .map_err(|error| format!("failed to list remote directory for delete: {error}"))?;
            let mut total_steps = 1;
            for (child_path, _) in entries {
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                total_steps += count_remote_delete_steps(sftp, &child_path)?;
            }
            Ok(total_steps)
        }
        _ => Ok(1),
    }
}

fn delete_remote_path_recursive(
    sftp: &Sftp,
    path: &Path,
    progress: &mut DeleteProgressTracker,
) -> Result<(), String> {
    progress.ensure_not_cancelled()?;
    let stat = sftp
        .lstat(path)
        .map_err(|error| format!("failed to inspect remote path: {error}"))?;

    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            let entries = sftp
                .readdir(path)
                .map_err(|error| format!("failed to list remote directory for delete: {error}"))?;
            for (child_path, _) in entries {
                progress.ensure_not_cancelled()?;
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                delete_remote_path_recursive(sftp, &child_path, progress)?;
            }
            progress.ensure_not_cancelled()?;
            progress.set_current_path(Some(path_to_string(path)))?;
            sftp.rmdir(path)
                .map_err(|error| format!("failed to remove remote directory: {error}"))?;
            progress.finish_step()
        }
        _ => {
            progress.ensure_not_cancelled()?;
            progress.set_current_path(Some(path_to_string(path)))?;
            sftp.unlink(path)
                .map_err(|error| format!("failed to remove remote file: {error}"))?;
            progress.finish_step()
        }
    }
}

fn should_skip_remote_child(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|value| value.to_str()),
        Some(".") | Some("..")
    )
}

fn copy_remote_entry_to_path(
    sftp: &Sftp,
    source_path: &Path,
    destination_path: &Path,
    source_stat: FileStat,
) -> Result<(), String> {
    match kind_from_permissions(source_stat.perm) {
        RemoteFileKind::Directory => {
            if destination_path.starts_with(source_path) {
                return Err("cannot copy a directory into itself".to_string());
            }

            ensure_remote_directory(sftp, destination_path)?;
            let entries = sftp
                .readdir(source_path)
                .map_err(|error| format!("failed to read remote directory for copy: {error}"))?;
            for (child_path, child_stat) in entries {
                let child_name = child_path
                    .file_name()
                    .ok_or_else(|| "invalid child path while copying directory".to_string())?;
                copy_remote_entry_to_path(
                    sftp,
                    &child_path,
                    &destination_path.join(child_name),
                    child_stat,
                )?;
            }
            Ok(())
        }
        RemoteFileKind::Symlink => {
            let target = sftp
                .readlink(source_path)
                .map_err(|error| format!("failed to read remote symlink: {error}"))?;
            sftp.symlink(&target, destination_path)
                .map_err(|error| format!("failed to copy remote symlink: {error}"))
        }
        _ => copy_remote_file(sftp, source_path, destination_path),
    }
}

fn copy_remote_file(
    sftp: &Sftp,
    source_path: &Path,
    destination_path: &Path,
) -> Result<(), String> {
    if let Some(parent) = destination_path.parent() {
        ensure_remote_directory(sftp, parent)?;
    }

    let mut source = sftp
        .open(source_path)
        .map_err(|error| format!("failed to open remote source file: {error}"))?;
    let mut destination = sftp
        .open_mode(
            destination_path,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
            0o644,
            OpenType::File,
        )
        .map_err(|error| format!("failed to create remote copy: {error}"))?;
    copy(&mut source, &mut destination)
        .map_err(|error| format!("failed to copy remote file data: {error}"))?;
    destination
        .flush()
        .map_err(|error| format!("failed to flush remote copy: {error}"))
}

fn remote_entry_names(
    sftp: &Sftp,
    destination_directory: &Path,
) -> Result<HashSet<String>, String> {
    let entries = sftp
        .readdir(destination_directory)
        .map_err(|error| format!("failed to inspect remote upload destination: {error}"))?;
    let mut existing_names = HashSet::new();

    for (entry_path, _) in entries {
        if let Some(name) = entry_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .filter(|value| value != "." && value != "..")
        {
            existing_names.insert(name);
        }
    }

    Ok(existing_names)
}

fn resolve_upload_target_name(
    existing_names: &HashSet<String>,
    base_name: &str,
    policy: UploadConflictPolicy,
) -> Result<Option<String>, String> {
    if !existing_names.contains(base_name) {
        return Ok(Some(base_name.to_string()));
    }

    match policy {
        UploadConflictPolicy::Overwrite => Ok(Some(base_name.to_string())),
        UploadConflictPolicy::Skip => Ok(None),
        UploadConflictPolicy::Fail => Err(format!("remote path already exists: {base_name}")),
    }
}

fn unique_remote_destination(
    sftp: &Sftp,
    destination_directory: &Path,
    base_name: &str,
) -> Result<PathBuf, String> {
    let candidate = destination_directory.join(base_name);
    if !remote_path_exists(sftp, &candidate) {
        return Ok(candidate);
    }

    let (stem, extension) = split_name(base_name);
    for index in 1..1000 {
        let suffix = if index == 1 {
            " copy".to_string()
        } else {
            format!(" copy {index}")
        };
        let candidate_name = match extension.as_deref() {
            Some(extension) => format!("{stem}{suffix}.{extension}"),
            None => format!("{stem}{suffix}"),
        };
        let candidate = destination_directory.join(candidate_name);
        if !remote_path_exists(sftp, &candidate) {
            return Ok(candidate);
        }
    }

    Err(format!(
        "failed to find an available destination name for {base_name}"
    ))
}

fn split_name(name: &str) -> (String, Option<String>) {
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => {
            (stem.to_string(), Some(extension.to_string()))
        }
        _ => (name.to_string(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn upload_target_name_overwrites_existing_entry_when_requested() {
        let existing_names = HashSet::from([String::from("report.txt")]);

        let resolved = resolve_upload_target_name(
            &existing_names,
            "report.txt",
            UploadConflictPolicy::Overwrite,
        )
        .expect("overwrite policy should allow replacing the existing target");

        assert_eq!(resolved, Some(String::from("report.txt")));
    }

    #[test]
    fn upload_target_name_skips_existing_entry_when_requested() {
        let existing_names = HashSet::from([String::from("report.txt")]);

        let resolved = resolve_upload_target_name(
            &existing_names,
            "report.txt",
            UploadConflictPolicy::Skip,
        )
        .expect("skip policy should be treated as a valid decision");

        assert_eq!(resolved, None);
    }

    #[test]
    fn upload_target_name_rejects_existing_entry_without_explicit_resolution() {
        let existing_names = HashSet::from([String::from("report.txt")]);

        let error = resolve_upload_target_name(
            &existing_names,
            "report.txt",
            UploadConflictPolicy::Fail,
        )
        .expect_err("missing overwrite confirmation should fail the upload");

        assert!(error.contains("report.txt"));
    }

    #[test]
    fn upload_target_name_allows_new_entry_without_conflict() {
        let existing_names = HashSet::<String>::new();

        let resolved = resolve_upload_target_name(
            &existing_names,
            "report.txt",
            UploadConflictPolicy::Fail,
        )
        .expect("new names should upload without additional confirmation");

        assert_eq!(resolved, Some(String::from("report.txt")));
    }

    #[test]
    fn session_request_summary_redacts_secret_values() {
        let request = SessionCreateRequest {
            name: "demo".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("super-secret".to_string()),
            private_key_path: Some("/Users/alice/.ssh/id_ed25519".to_string()),
            passphrase: Some("keep-me-out-of-logs".to_string()),
            terminal_cols: 120,
            terminal_rows: 32,
        };

        let summary = summarize_session_request(&request);

        assert!(summary.contains("host=example.com"));
        assert!(summary.contains("username=alice"));
        assert!(summary.contains("auth_method=password"));
        assert!(summary.contains("has_password=true"));
        assert!(summary.contains("has_private_key_path=true"));
        assert!(summary.contains("has_passphrase=true"));
        assert!(!summary.contains("super-secret"));
        assert!(!summary.contains("keep-me-out-of-logs"));
        assert!(!summary.contains("/Users/alice/.ssh/id_ed25519"));
    }

    #[test]
    fn connect_tcp_stream_enables_nodelay() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .expect("should bind a loopback listener for the test");
        let address = listener
            .local_addr()
            .expect("listener should expose a loopback address");

        let accept_thread = thread::spawn(move || {
            let _ = listener.accept();
        });

        let stream = connect_tcp_stream("127.0.0.1", address.port())
            .expect("connect_tcp_stream should connect to the local listener");

        assert!(
            stream.nodelay().expect("querying nodelay should succeed"),
            "interactive SSH sockets should disable Nagle's algorithm",
        );

        accept_thread
            .join()
            .expect("accept thread should finish cleanly");
    }

    #[test]
    fn session_idle_wait_timeout_uses_short_slice_when_socket_is_blocked() {
        let wait = session_idle_wait_timeout(true)
            .expect("blocked sockets should use a short wait slice instead of busy spinning");

        assert_eq!(wait, Duration::from_millis(20));
    }

    #[test]
    fn session_idle_wait_timeout_skips_wait_when_no_signal_is_pending() {
        let wait = session_idle_wait_timeout(false);

        assert_eq!(wait, None);
    }

    #[test]
    fn transport_error_classifies_drain_incoming_flow_as_disconnect() {
        let message = format_transport_error(
            "failed to write remote input",
            "Failure while draining incoming flow",
        );

        assert!(message.contains("ssh transport disconnected"));
    }

    #[test]
    fn coalesce_write_commands_merges_adjacent_write_chunks() {
        let commands = vec![
            SessionCommand::Write("a".to_string()),
            SessionCommand::Write("bc".to_string()),
            SessionCommand::Write("123".to_string()),
        ];

        let merged = coalesce_write_commands(commands);

        assert_eq!(merged.len(), 1);
        match &merged[0] {
            SessionCommand::Write(data) => assert_eq!(data, "abc123"),
            _ => panic!("expected a single merged write command"),
        }
    }

    #[test]
    fn coalesce_write_commands_preserves_non_write_boundaries() {
        let commands = vec![
            SessionCommand::Write("ab".to_string()),
            SessionCommand::Resize { cols: 120, rows: 40 },
            SessionCommand::Write("cd".to_string()),
            SessionCommand::Close,
            SessionCommand::Write("ef".to_string()),
        ];

        let merged = coalesce_write_commands(commands);

        assert_eq!(merged.len(), 5);
        match &merged[0] {
            SessionCommand::Write(data) => assert_eq!(data, "ab"),
            _ => panic!("first command should stay write"),
        }
        match &merged[1] {
            SessionCommand::Resize { cols, rows } => {
                assert_eq!((cols, rows), (&120, &40));
            }
            _ => panic!("second command should stay resize"),
        }
        match &merged[2] {
            SessionCommand::Write(data) => assert_eq!(data, "cd"),
            _ => panic!("third command should stay write"),
        }
        match &merged[3] {
            SessionCommand::Close => {}
            _ => panic!("fourth command should stay close"),
        }
        match &merged[4] {
            SessionCommand::Write(data) => assert_eq!(data, "ef"),
            _ => panic!("fifth command should stay write"),
        }
    }

    #[test]
    fn retryable_channel_error_kind_includes_wouldblock_and_interrupted() {
        assert!(is_retryable_channel_error_kind(ErrorKind::WouldBlock));
        assert!(is_retryable_channel_error_kind(ErrorKind::Interrupted));
    }

    #[test]
    fn retryable_channel_error_kind_rejects_fatal_kinds() {
        assert!(!is_retryable_channel_error_kind(ErrorKind::ConnectionReset));
        assert!(!is_retryable_channel_error_kind(ErrorKind::BrokenPipe));
    }

    #[test]
    fn check_update_menu_ids_are_recognized() {
        assert!(is_check_update_menu_id("menu.check_update"));
        assert!(is_check_update_menu_id("tray.check_update"));
        assert!(!is_check_update_menu_id("tray.quit"));
    }
}

fn scan_local_upload_path(local_path: &Path) -> Result<UploadScanStats, String> {
    let metadata = fs::symlink_metadata(local_path)
        .map_err(|error| format!("failed to read local path metadata: {error}"))?;

    if metadata.file_type().is_symlink() {
        return Err(format!(
            "symlink upload is not supported: {}",
            local_path.display()
        ));
    }

    if metadata.is_dir() {
        let mut stats = UploadScanStats {
            total_bytes: 0,
            total_steps: 1,
        };
        let entries = fs::read_dir(local_path)
            .map_err(|error| format!("failed to read local directory: {error}"))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("failed to read local directory entry: {error}"))?;
            stats.combine(scan_local_upload_path(&entry.path())?);
        }
        return Ok(stats);
    }

    if metadata.is_file() {
        return Ok(UploadScanStats {
            total_bytes: metadata.len(),
            total_steps: 1,
        });
    }

    Err(format!(
        "unsupported local path type for upload: {}",
        local_path.display()
    ))
}

fn upload_local_entry_to_path(
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &Path,
    progress: &mut UploadProgressTracker,
) -> Result<(), String> {
    progress.ensure_not_cancelled()?;
    let metadata = fs::symlink_metadata(local_path)
        .map_err(|error| format!("failed to read local path metadata: {error}"))?;

    if metadata.file_type().is_symlink() {
        return Err(format!(
            "symlink upload is not supported: {}",
            local_path.display()
        ));
    }

    if metadata.is_dir() {
        progress.set_current_path(Some(path_to_string(local_path)))?;
        ensure_remote_directory(sftp, remote_path)?;
        progress.finish_step()?;
        let entries = fs::read_dir(local_path)
            .map_err(|error| format!("failed to read local directory: {error}"))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("failed to read local directory entry: {error}"))?;
            upload_local_entry_to_path(
                sftp,
                &entry.path(),
                &remote_path.join(entry.file_name()),
                progress,
            )?;
        }
        return Ok(());
    }

    if metadata.is_file() {
        progress.set_current_path(Some(path_to_string(local_path)))?;
        if let Some(parent) = remote_path.parent() {
            ensure_remote_directory(sftp, parent)?;
        }

        let mut local_file =
            fs::File::open(local_path).map_err(|error| format!("failed to open local file: {error}"))?;
        let mut remote_file = sftp
            .open_mode(
                remote_path,
                OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
                0o644,
                OpenType::File,
            )
            .map_err(|error| format!("failed to create remote upload target: {error}"))?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            progress.ensure_not_cancelled().inspect_err(|_| {
                let _ = sftp.unlink(remote_path);
            })?;
            let read = local_file
                .read(&mut buffer)
                .map_err(|error| format!("failed to read local file for upload: {error}"))?;
            if read == 0 {
                break;
            }
            remote_file
                .write_all(&buffer[..read])
                .map_err(|error| format!("failed to upload local file: {error}"))?;
            progress.advance_bytes(read as u64)?;
        }
        remote_file
            .flush()
            .map_err(|error| format!("failed to flush remote upload: {error}"))?;
        progress.finish_step()?;
        return Ok(());
    }

    Err(format!(
        "unsupported local path type for upload: {}",
        local_path.display()
    ))
}

fn map_remote_file(path: PathBuf, stat: FileStat) -> RemoteFileEntry {
    let path_string = path_to_string(&path);
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| path_string.clone());

    RemoteFileEntry {
        path: path_string,
        name,
        kind: kind_from_permissions(stat.perm),
        size: stat.size,
        modified_at: stat.mtime,
        permissions: stat.perm,
        owner_uid: stat.uid,
        group_gid: stat.gid,
        owner_name: None,
        group_name: None,
    }
}

fn sort_remote_entries(left: &RemoteFileEntry, right: &RemoteFileEntry) -> Ordering {
    match (left.kind, right.kind) {
        (RemoteFileKind::Directory, RemoteFileKind::Directory)
        | (RemoteFileKind::File, RemoteFileKind::File)
        | (RemoteFileKind::Symlink, RemoteFileKind::Symlink)
        | (RemoteFileKind::Other, RemoteFileKind::Other) => {
            left.name.to_lowercase().cmp(&right.name.to_lowercase())
        }
        (RemoteFileKind::Directory, _) => Ordering::Less,
        (_, RemoteFileKind::Directory) => Ordering::Greater,
        _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
    }
}

fn kind_from_permissions(permissions: Option<u32>) -> RemoteFileKind {
    const FILE_TYPE_MASK: u32 = 0o170000;
    const DIRECTORY_MASK: u32 = 0o040000;
    const FILE_MASK: u32 = 0o100000;
    const SYMLINK_MASK: u32 = 0o120000;

    match permissions.map(|value| value & FILE_TYPE_MASK) {
        Some(DIRECTORY_MASK) => RemoteFileKind::Directory,
        Some(FILE_MASK) => RemoteFileKind::File,
        Some(SYMLINK_MASK) => RemoteFileKind::Symlink,
        _ => RemoteFileKind::Other,
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn open_path_with_default_app(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(path);
        cmd
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg("start").arg("").arg(path);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(path);
        cmd
    };

    command
        .spawn()
        .map_err(|error| format!("failed to open file with default app: {error}"))?;
    Ok(())
}

fn coalesce_write_commands(commands: Vec<SessionCommand>) -> Vec<SessionCommand> {
    let mut merged = Vec::with_capacity(commands.len());
    let mut pending_write = String::new();

    for command in commands {
        match command {
            SessionCommand::Write(data) => {
                pending_write.push_str(&data);
            }
            SessionCommand::Resize { cols, rows } => {
                if !pending_write.is_empty() {
                    merged.push(SessionCommand::Write(std::mem::take(&mut pending_write)));
                }
                merged.push(SessionCommand::Resize { cols, rows });
            }
            SessionCommand::Close => {
                if !pending_write.is_empty() {
                    merged.push(SessionCommand::Write(std::mem::take(&mut pending_write)));
                }
                merged.push(SessionCommand::Close);
            }
        }
    }

    if !pending_write.is_empty() {
        merged.push(SessionCommand::Write(pending_write));
    }

    merged
}

fn session_loop(
    app: &AppHandle,
    session_id: &str,
    session: &Session,
    channel: &mut Channel,
    rx: Receiver<SessionCommand>,
) -> Result<Option<String>, String> {
    let mut buffer = [0u8; 8192];

    loop {
        let mut made_progress = false;
        let mut blocked_on_socket = false;
        let mut pending_commands = Vec::new();

        loop {
            match rx.try_recv() {
                Ok(command) => pending_commands.push(command),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    graceful_shutdown(channel);
                    return Ok(Some("session controller dropped".to_string()));
                }
            }
        }

        for command in coalesce_write_commands(pending_commands) {
            match command {
                SessionCommand::Write(data) => {
                    write_all_nonblocking(session, channel, data.as_bytes())?;
                    made_progress = true;
                }
                SessionCommand::Resize { cols, rows } => {
                    resize_pty_nonblocking(session, channel, cols, rows)?;
                    made_progress = true;
                }
                SessionCommand::Close => {
                    graceful_shutdown(channel);
                    return Ok(Some("session closed locally".to_string()));
                }
            }
        }

        match channel.read(&mut buffer) {
            Ok(0) => {
                if channel.eof() {
                    return Ok(Some("remote shell exited".to_string()));
                }
            }
            Ok(read) => {
                let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
                emit_data(app, session_id, chunk)?;
                made_progress = true;
            }
            Err(error) if is_retryable_channel_error_kind(error.kind()) => {
                blocked_on_socket = true;
            }
            Err(error) => {
                warn!(
                    "SSH read failed session_id={} kind={:?} block_directions={:?} error={}",
                    session_id,
                    error.kind(),
                    session.block_directions(),
                    error
                );
                return Err(format_transport_error(
                    "failed to read remote output",
                    &error.to_string(),
                ))
            }
        }

        if made_progress {
            continue;
        }

        if let Some(wait_timeout) = session_idle_wait_timeout(blocked_on_socket) {
            wait_for_session_socket(session, wait_timeout)?;
        } else {
            thread::yield_now();
        }
    }
}

fn session_idle_wait_timeout(blocked_on_socket: bool) -> Option<Duration> {
    if !blocked_on_socket {
        return None;
    }

    Some(Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS))
}

fn is_retryable_channel_error_kind(kind: ErrorKind) -> bool {
    kind == ErrorKind::WouldBlock || kind == ErrorKind::Interrupted
}

fn format_transport_error(context: &str, raw_error: &str) -> String {
    let error_lower = raw_error.to_ascii_lowercase();
    if error_lower.contains("transport read")
        || error_lower.contains("connection reset")
        || error_lower.contains("connection aborted")
        || error_lower.contains("broken pipe")
        || error_lower.contains("draining incoming flow")
    {
        format!(
            "{context}: ssh transport disconnected (possible network jitter, idle timeout, or remote-side close): {raw_error}"
        )
    } else {
        format!("{context}: {raw_error}")
    }
}

fn write_all_nonblocking(session: &Session, channel: &mut Channel, bytes: &[u8]) -> Result<(), String> {
    let mut offset = 0usize;
    let wait_timeout = Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS);

    while offset < bytes.len() {
        match channel.write(&bytes[offset..]) {
            Ok(0) => return Err("remote channel accepted zero bytes".to_string()),
            Ok(written) => offset += written,
            Err(error) if is_retryable_channel_error_kind(error.kind()) => {
                if error.kind() == ErrorKind::Interrupted {
                    continue;
                }
                wait_for_session_socket(session, wait_timeout)?;
            }
            Err(error) => {
                warn!(
                    "SSH write failed kind={:?} block_directions={:?} offset={} total={} error={}",
                    error.kind(),
                    session.block_directions(),
                    offset,
                    bytes.len(),
                    error
                );
                return Err(format_transport_error(
                    "failed to write remote input",
                    &error.to_string(),
                ))
            }
        }
    }
    Ok(())
}

fn resize_pty_nonblocking(
    session: &Session,
    channel: &mut Channel,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let wait_timeout = Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS);
    loop {
        match channel.request_pty_size(cols, rows, None, None) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let io_error: std::io::Error = error.into();
                if is_retryable_channel_error_kind(io_error.kind()) {
                    if io_error.kind() == ErrorKind::Interrupted {
                        continue;
                    }
                    wait_for_session_socket(session, wait_timeout)?;
                    continue;
                }
                warn!(
                    "SSH resize failed cols={} rows={} kind={:?} block_directions={:?} error={}",
                    cols,
                    rows,
                    io_error.kind(),
                    session.block_directions(),
                    io_error
                );
                return Err(format_transport_error(
                    "failed to resize PTY",
                    &io_error.to_string(),
                ));
            }
        }
    }
}

#[cfg(unix)]
fn session_poll_events(directions: BlockDirections) -> i16 {
    match directions {
        BlockDirections::None => 0,
        BlockDirections::Inbound => POLLIN,
        BlockDirections::Outbound => POLLOUT,
        BlockDirections::Both => POLLIN | POLLOUT,
    }
}

#[cfg(unix)]
fn wait_for_session_socket(session: &Session, timeout: Duration) -> Result<(), String> {
    let events = session_poll_events(session.block_directions());
    if events == 0 {
        if !timeout.is_zero() {
            thread::sleep(timeout);
        }
        return Ok(());
    }

    let timeout_ms = timeout.as_millis().min(i32::MAX as u128) as i32;
    let mut poll_fd = pollfd {
        fd: session.as_raw_fd(),
        events,
        revents: 0,
    };

    loop {
        let result = unsafe { poll(&mut poll_fd, 1, timeout_ms) };
        if result >= 0 {
            return Ok(());
        }

        let error = std::io::Error::last_os_error();
        if error.kind() == ErrorKind::Interrupted {
            continue;
        }

        return Err(format!("failed to wait for ssh socket readiness: {error}"));
    }
}

#[cfg(not(unix))]
fn wait_for_session_socket(_session: &Session, timeout: Duration) -> Result<(), String> {
    if !timeout.is_zero() {
        thread::sleep(timeout);
    }
    Ok(())
}

fn graceful_shutdown(channel: &mut Channel) {
    let _ = channel.send_eof();
    let _ = channel.close();
    let _ = channel.wait_close();
}

fn emit_status(
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

fn emit_data(app: &AppHandle, session_id: &str, chunk: String) -> Result<(), String> {
    app.emit(
        SSH_DATA_EVENT,
        DataEvent {
            session_id: session_id.to_string(),
            chunk,
        },
    )
    .map_err(|error| format!("failed to emit data event: {error}"))
}

fn emit_closed(
    app: &AppHandle,
    session_id: &str,
    reason: Option<String>,
) -> Result<(), String> {
    app.emit(
        SSH_CLOSED_EVENT,
        ClosedEvent {
            session_id: session_id.to_string(),
            reason,
        },
    )
    .map_err(|error| format!("failed to emit closed event: {error}"))
}

fn is_check_update_menu_id(menu_id: &str) -> bool {
    menu_id == MENU_CHECK_UPDATE_ID || menu_id == TRAY_CHECK_UPDATE_ID
}

fn emit_system_check_update(app: &AppHandle) -> Result<(), String> {
    app.emit(SYSTEM_CHECK_UPDATE_EVENT, ())
        .map_err(|error| format!("failed to emit {SYSTEM_CHECK_UPDATE_EVENT} event: {error}"))
}

#[cfg(target_os = "macos")]
fn build_macos_app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{IconMenuItem, Menu, MenuItemKind, NativeIcon, PredefinedMenuItem};

    let menu = Menu::default(app)?;
    let app_submenu = menu
        .items()?
        .into_iter()
        .find_map(|item| match item {
            MenuItemKind::Submenu(submenu) => Some(submenu),
            _ => None,
        });

    if let Some(app_submenu) = app_submenu {
        let check_update_item = IconMenuItem::with_id_and_native_icon(
            app,
            MENU_CHECK_UPDATE_ID,
            "Check for Updates...",
            true,
            Some(NativeIcon::Refresh),
            None::<&str>,
        )?;
        let separator = PredefinedMenuItem::separator(app)?;
        let insert_before = app_submenu.items()?.len().saturating_sub(1);
        app_submenu.insert_items(&[&separator, &check_update_item], insert_before)?;
    }

    Ok(menu)
}

#[cfg(target_os = "windows")]
fn build_windows_tray_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem};

    let show_main_window_item =
        MenuItem::with_id(app, TRAY_SHOW_MAIN_WINDOW_ID, "Show Main Window", true, None::<&str>)?;
    let check_update_item =
        MenuItem::with_id(app, TRAY_CHECK_UPDATE_ID, "Check for Updates", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit", true, None::<&str>)?;

    Menu::with_items(app, &[&show_main_window_item, &check_update_item, &quit_item])
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

pub fn run() {
    let log_level = if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };

    let mut builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log_level)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(10))
                .max_file_size(1_048_576)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("termbridge".to_string()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SessionManager::default())
        .manage(UploadCancellationRegistry::default())
        .manage(DeleteCancellationRegistry::default())
        .invoke_handler(tauri::generate_handler![
            create_session,
            write_session,
            resize_session,
            close_session,
            request_app_restart,
            list_remote_directory,
            create_remote_entry,
            rename_remote_path,
            delete_remote_path,
            copy_remote_path,
            upload_local_paths,
            cancel_upload,
            cancel_delete,
            pick_local_files,
            pick_local_folder,
            open_remote_file
        ]);

    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(build_macos_app_menu);
    }

    builder = builder.on_menu_event(|app, event| {
        let menu_id = event.id().as_ref();
        if is_check_update_menu_id(menu_id) {
            if let Err(error) = emit_system_check_update(app) {
                error!("failed to handle check-update menu event: {error}");
            }
            return;
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
                app.exit(0);
            }
        }
    });

    #[cfg(target_os = "windows")]
    {
        builder = builder
            .setup(|app| {
                let tray_menu = build_windows_tray_menu(app)
                    .map_err(|error| format!("failed to create tray menu: {error}"))?;
                let mut tray_builder = tauri::tray::TrayIconBuilder::with_id("main").menu(&tray_menu);

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
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        error!("failed to hide window while keeping tray active: {error}");
                    }
                }
            });
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
