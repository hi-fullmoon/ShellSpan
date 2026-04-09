use serde::{Deserialize, Serialize};
use ssh2::{Channel, FileStat, OpenFlags, OpenType, RenameFlags, Session, Sftp};
use std::{
    cmp::Ordering,
    collections::HashMap,
    fs,
    io::{copy, ErrorKind, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        mpsc::{self, Receiver, Sender, TryRecvError},
        Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

const SSH_DATA_EVENT: &str = "ssh-data";
const SSH_STATUS_EVENT: &str = "ssh-status";
const SSH_CLOSED_EVENT: &str = "ssh-closed";

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
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum AuthMethod {
    Password,
    Key,
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
    _session: Session,
    sftp: Sftp,
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

#[tauri::command]
fn create_session(
    app: AppHandle,
    state: State<'_, SessionManager>,
    request: SessionCreateRequest,
) -> Result<SessionSummary, String> {
    validate_connection_fields(&request.host, &request.username)?;

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

    spawn_ssh_thread(app, session_id, request, rx);
    Ok(summary)
}

#[tauri::command]
fn write_session(
    state: State<'_, SessionManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state.send(&session_id, SessionCommand::Write(data))
}

#[tauri::command]
fn resize_session(
    state: State<'_, SessionManager>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    state.send(&session_id, SessionCommand::Resize { cols, rows })
}

#[tauri::command]
fn close_session(state: State<'_, SessionManager>, session_id: String) -> Result<(), String> {
    let result = state.send(&session_id, SessionCommand::Close);
    let _ = state.remove(&session_id);
    result
}

#[tauri::command]
async fn list_remote_directory(request: RemoteDirectoryRequest) -> Result<RemoteDirectoryListing, String> {
    tauri::async_runtime::spawn_blocking(move || list_remote_directory_blocking(request))
        .await
        .map_err(|error| format!("failed to join directory listing task: {error}"))?
}

#[tauri::command]
async fn create_remote_entry(request: CreateRemoteEntryRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || create_remote_entry_blocking(request))
        .await
        .map_err(|error| format!("failed to join create entry task: {error}"))?
}

#[tauri::command]
async fn rename_remote_path(request: RenameRemotePathRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rename_remote_path_blocking(request))
        .await
        .map_err(|error| format!("failed to join rename task: {error}"))?
}

#[tauri::command]
async fn delete_remote_path(request: DeleteRemotePathRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_remote_path_blocking(request))
        .await
        .map_err(|error| format!("failed to join delete task: {error}"))?
}

#[tauri::command]
async fn copy_remote_path(request: CopyRemotePathRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || copy_remote_path_blocking(request))
        .await
        .map_err(|error| format!("failed to join copy task: {error}"))?
}

#[tauri::command]
async fn upload_local_paths(request: UploadLocalPathsRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || upload_local_paths_blocking(request))
        .await
        .map_err(|error| format!("failed to join upload task: {error}"))?
}

#[tauri::command]
async fn open_remote_file(request: OpenRemoteFileRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_remote_file_blocking(request))
        .await
        .map_err(|error| format!("failed to join open file task: {error}"))?
}

fn spawn_ssh_thread(
    app: AppHandle,
    session_id: String,
    request: SessionCreateRequest,
    rx: Receiver<SessionCommand>,
) {
    thread::spawn(move || {
        let run_result = run_ssh_session(&app, &session_id, &request, rx);

        match run_result {
            Ok(message) => {
                let _ = emit_status(
                    &app,
                    &session_id,
                    SessionStatus::Disconnected,
                    message.clone(),
                );
                let _ = emit_closed(&app, &session_id, message);
            }
            Err(error) => {
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
        .shell()
        .map_err(|error| format!("failed to start remote shell: {error}"))?;
    session.set_blocking(false);

    emit_status(
        app,
        session_id,
        SessionStatus::Connected,
        Some("shell ready".to_string()),
    )?;

    session_loop(app, session_id, &mut channel, rx)
}

fn list_remote_directory_blocking(
    request: RemoteDirectoryRequest,
) -> Result<RemoteDirectoryListing, String> {
    let connected = connect_sftp(&request.connection)?;
    list_remote_directory_from_sftp(&connected.sftp, request.path.as_deref())
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

fn delete_remote_path_blocking(request: DeleteRemotePathRequest) -> Result<(), String> {
    let connected = connect_sftp(&request.connection)?;
    delete_remote_path_recursive(&connected.sftp, Path::new(&request.path))
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

fn upload_local_paths_blocking(request: UploadLocalPathsRequest) -> Result<(), String> {
    if request.local_paths.is_empty() {
        return Err("no local files were provided for upload".to_string());
    }

    let connected = connect_sftp(&request.connection)?;
    let destination_directory = Path::new(&request.destination_directory);
    ensure_remote_directory(&connected.sftp, destination_directory)?;

    for local_path in &request.local_paths {
        let local_path = Path::new(local_path);
        let file_name = local_path
            .file_name()
            .ok_or_else(|| format!("invalid local path: {}", local_path.display()))?
            .to_string_lossy()
            .to_string();
        let destination_path =
            unique_remote_destination(&connected.sftp, destination_directory, &file_name)?;
        upload_local_entry_to_path(&connected.sftp, local_path, &destination_path)?;
    }

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

fn connect_sftp(request: &RemoteConnectionRequest) -> Result<ConnectedSftp, String> {
    validate_connection_fields(&request.host, &request.username)?;

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

    Ok(ConnectedSftp {
        _session: session,
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

fn connect_tcp_stream(host: &str, port: u16) -> Result<TcpStream, String> {
    let address = format!("{host}:{port}");
    let socket_addr = address
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve {address}: {error}"))?
        .next()
        .ok_or_else(|| format!("no socket address found for {address}"))?;

    TcpStream::connect_timeout(&socket_addr, Duration::from_secs(12))
        .map_err(|error| format!("failed to connect to {address}: {error}"))
}

fn open_authenticated_session(
    tcp: TcpStream,
    username: &str,
    auth_method: AuthMethod,
    password: Option<&str>,
    private_key_path: Option<&str>,
    passphrase: Option<&str>,
) -> Result<Session, String> {
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

fn delete_remote_path_recursive(sftp: &Sftp, path: &Path) -> Result<(), String> {
    let stat = sftp
        .lstat(path)
        .map_err(|error| format!("failed to inspect remote path: {error}"))?;

    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            let entries = sftp
                .readdir(path)
                .map_err(|error| format!("failed to list remote directory for delete: {error}"))?;
            for (child_path, _) in entries {
                delete_remote_path_recursive(sftp, &child_path)?;
            }
            sftp.rmdir(path)
                .map_err(|error| format!("failed to remove remote directory: {error}"))
        }
        _ => sftp
            .unlink(path)
            .map_err(|error| format!("failed to remove remote file: {error}")),
    }
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
        Some((stem, extension)) if !stem.is_empty() => (stem.to_string(), Some(extension.to_string())),
        _ => (name.to_string(), None),
    }
}

fn upload_local_entry_to_path(
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &Path,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(local_path)
        .map_err(|error| format!("failed to read local path metadata: {error}"))?;

    if metadata.file_type().is_symlink() {
        return Err(format!(
            "symlink upload is not supported: {}",
            local_path.display()
        ));
    }

    if metadata.is_dir() {
        ensure_remote_directory(sftp, remote_path)?;
        let entries = fs::read_dir(local_path)
            .map_err(|error| format!("failed to read local directory: {error}"))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("failed to read local directory entry: {error}"))?;
            upload_local_entry_to_path(
                sftp,
                &entry.path(),
                &remote_path.join(entry.file_name()),
            )?;
        }
        return Ok(());
    }

    if metadata.is_file() {
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
        copy(&mut local_file, &mut remote_file)
            .map_err(|error| format!("failed to upload local file: {error}"))?;
        remote_file
            .flush()
            .map_err(|error| format!("failed to flush remote upload: {error}"))?;
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

fn session_loop(
    app: &AppHandle,
    session_id: &str,
    channel: &mut Channel,
    rx: Receiver<SessionCommand>,
) -> Result<Option<String>, String> {
    let mut buffer = [0u8; 8192];

    loop {
        match rx.try_recv() {
            Ok(SessionCommand::Write(data)) => {
                write_all_nonblocking(channel, data.as_bytes())?;
            }
            Ok(SessionCommand::Resize { cols, rows }) => {
                channel
                    .request_pty_size(cols, rows, None, None)
                    .map_err(|error| format!("failed to resize PTY: {error}"))?;
            }
            Ok(SessionCommand::Close) => {
                graceful_shutdown(channel);
                return Ok(Some("session closed locally".to_string()));
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                graceful_shutdown(channel);
                return Ok(Some("session controller dropped".to_string()));
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
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => return Err(format!("failed to read remote output: {error}")),
        }

        let mut stderr = channel.stderr();
        match stderr.read(&mut buffer) {
            Ok(0) => {}
            Ok(read) => {
                let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
                emit_data(app, session_id, chunk)?;
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => return Err(format!("failed to read remote stderr: {error}")),
        }

        thread::sleep(Duration::from_millis(10));
    }
}

fn write_all_nonblocking(channel: &mut Channel, bytes: &[u8]) -> Result<(), String> {
    let mut offset = 0usize;

    while offset < bytes.len() {
        match channel.write(&bytes[offset..]) {
            Ok(0) => return Err("remote channel accepted zero bytes".to_string()),
            Ok(written) => offset += written,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => return Err(format!("failed to write remote input: {error}")),
        }
    }

    channel
        .flush()
        .map_err(|error| format!("failed to flush remote input: {error}"))?;
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

pub fn run() {
    tauri::Builder::default()
        .manage(SessionManager::default())
        .invoke_handler(tauri::generate_handler![
            create_session,
            write_session,
            resize_session,
            close_session,
            list_remote_directory,
            create_remote_entry,
            rename_remote_path,
            delete_remote_path,
            copy_remote_path,
            upload_local_paths,
            open_remote_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
