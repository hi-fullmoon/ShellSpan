use serde::{Deserialize, Serialize};
use ssh2::{Session, Sftp};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        mpsc::Sender,
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSummary {
    pub(crate) session_id: String,
    pub(crate) title: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionCreateRequest {
    pub(crate) name: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: AuthMethod,
    pub(crate) password: Option<String>,
    pub(crate) private_key_path: Option<String>,
    pub(crate) passphrase: Option<String>,
    pub(crate) terminal_cols: u32,
    pub(crate) terminal_rows: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteConnectionRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: AuthMethod,
    pub(crate) password: Option<String>,
    pub(crate) private_key_path: Option<String>,
    pub(crate) passphrase: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteDirectoryRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateRemoteEntryRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) parent_path: String,
    pub(crate) name: String,
    pub(crate) kind: CreateRemoteEntryKind,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CreateRemoteEntryKind {
    File,
    Directory,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameRemotePathRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) path: String,
    pub(crate) new_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteRemotePathRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) path: String,
    pub(crate) operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyRemotePathRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) source_path: String,
    pub(crate) destination_directory: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenRemoteFileRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadRemotePathsRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) remote_paths: Vec<String>,
    pub(crate) destination_directory: String,
    pub(crate) operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadLocalPathsRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) destination_directory: String,
    pub(crate) local_paths: Vec<String>,
    #[serde(default)]
    pub(crate) conflict_policies: Vec<UploadConflictPolicy>,
    pub(crate) operation_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AuthMethod {
    Password,
    Key,
}

impl AuthMethod {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            AuthMethod::Password => "password",
            AuthMethod::Key => "key",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UploadConflictPolicy {
    Overwrite,
    Skip,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatusEvent {
    pub(crate) session_id: String,
    pub(crate) status: SessionStatus,
    pub(crate) message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataEvent {
    pub(crate) session_id: String,
    pub(crate) chunk: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClosedEvent {
    pub(crate) session_id: String,
    pub(crate) reason: Option<String>,
    pub(crate) reason_kind: ClosedReasonKind,
    pub(crate) retryable: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ClosedReasonKind {
    LocalClose,
    ControllerDropped,
    RemoteExit,
    TransportDisconnect,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadProgressEvent {
    pub(crate) operation_id: String,
    pub(crate) current_path: Option<String>,
    pub(crate) total_bytes: u64,
    pub(crate) uploaded_bytes: u64,
    pub(crate) total_steps: u64,
    pub(crate) completed_steps: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteProgressEvent {
    pub(crate) operation_id: String,
    pub(crate) current_path: Option<String>,
    pub(crate) total_steps: u64,
    pub(crate) completed_steps: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadProgressEvent {
    pub(crate) operation_id: String,
    pub(crate) current_path: Option<String>,
    pub(crate) total_bytes: u64,
    pub(crate) downloaded_bytes: u64,
    pub(crate) total_steps: u64,
    pub(crate) completed_steps: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteDirectoryListing {
    pub(crate) path: String,
    pub(crate) parent_path: Option<String>,
    pub(crate) entries: Vec<RemoteFileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteFileEntry {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) kind: RemoteFileKind,
    pub(crate) size: Option<u64>,
    pub(crate) modified_at: Option<u64>,
    pub(crate) permissions: Option<u32>,
    pub(crate) owner_uid: Option<u32>,
    pub(crate) group_gid: Option<u32>,
    pub(crate) owner_name: Option<String>,
    pub(crate) group_name: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SessionStatus {
    Connecting,
    Connected,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RemoteFileKind {
    Directory,
    File,
    Symlink,
    Other,
}

pub(crate) enum SessionCommand {
    Write(String),
    Resize { cols: u32, rows: u32 },
    Close,
}

pub(crate) struct ManagedSession {
    pub(crate) sender: Sender<SessionCommand>,
}

#[derive(Default)]
pub(crate) struct SessionManager {
    sessions: Mutex<HashMap<String, ManagedSession>>,
}

pub(crate) struct ConnectedSftp {
    pub(crate) session: Session,
    pub(crate) sftp: Sftp,
}

#[derive(Default)]
pub(crate) struct UploadCancellationRegistry {
    operations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Default)]
pub(crate) struct DeleteCancellationRegistry {
    operations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Default, Clone, Copy)]
pub(crate) struct DownloadScanStats {
    pub(crate) total_bytes: u64,
    pub(crate) total_steps: u64,
}

impl DownloadScanStats {
    pub(crate) fn combine(&mut self, other: DownloadScanStats) {
        self.total_bytes += other.total_bytes;
        self.total_steps += other.total_steps;
    }
}

pub(crate) struct DownloadProgressTracker {
    app: AppHandle,
    operation_id: String,
    cancel_flag: Arc<AtomicBool>,
    current_path: Option<String>,
    total_bytes: u64,
    downloaded_bytes: u64,
    total_steps: u64,
    completed_steps: u64,
}

impl DownloadProgressTracker {
    pub(crate) fn new(
        app: AppHandle,
        operation_id: String,
        cancel_flag: Arc<AtomicBool>,
        stats: DownloadScanStats,
    ) -> Self {
        Self {
            app,
            operation_id,
            cancel_flag,
            current_path: None,
            total_bytes: stats.total_bytes,
            downloaded_bytes: 0,
            total_steps: stats.total_steps,
            completed_steps: 0,
        }
    }

    pub(crate) fn set_current_path(&mut self, path: Option<String>) -> Result<(), String> {
        self.current_path = path;
        self.emit()
    }

    pub(crate) fn advance_bytes(&mut self, count: u64) -> Result<(), String> {
        self.downloaded_bytes += count;
        self.emit()
    }

    pub(crate) fn finish_step(&mut self) -> Result<(), String> {
        self.completed_steps = (self.completed_steps + 1).min(self.total_steps);
        self.emit()
    }

    pub(crate) fn ensure_not_cancelled(&self) -> Result<(), String> {
        if self.cancel_flag.load(AtomicOrdering::SeqCst) {
            return Err("download cancelled".to_string());
        }
        Ok(())
    }

    pub(crate) fn emit(&self) -> Result<(), String> {
        self.app
            .emit(
                super::DOWNLOAD_PROGRESS_EVENT,
                DownloadProgressEvent {
                    operation_id: self.operation_id.clone(),
                    current_path: self.current_path.clone(),
                    total_bytes: self.total_bytes,
                    downloaded_bytes: self.downloaded_bytes,
                    total_steps: self.total_steps,
                    completed_steps: self.completed_steps,
                },
            )
            .map_err(|error| format!("failed to emit download progress event: {error}"))
    }
}

#[derive(Default)]
pub(crate) struct DownloadCancellationRegistry {
    operations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl DownloadCancellationRegistry {
    pub(crate) fn register(&self, operation_id: String) -> Result<Arc<AtomicBool>, String> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "download cancellation registry poisoned".to_string())?;
        guard.insert(operation_id, flag.clone());
        Ok(flag)
    }

    pub(crate) fn cancel(&self, operation_id: &str) -> Result<(), String> {
        let guard = self
            .operations
            .lock()
            .map_err(|_| "download cancellation registry poisoned".to_string())?;
        let flag = guard
            .get(operation_id)
            .ok_or_else(|| format!("download operation {operation_id} not found"))?;
        flag.store(true, AtomicOrdering::SeqCst);
        Ok(())
    }

    pub(crate) fn remove(&self, operation_id: &str) -> Result<(), String> {
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "download cancellation registry poisoned".to_string())?;
        guard.remove(operation_id);
        Ok(())
    }
}

#[derive(Default, Clone, Copy)]
pub(crate) struct UploadScanStats {
    pub(crate) total_bytes: u64,
    pub(crate) total_steps: u64,
}

impl UploadScanStats {
    pub(crate) fn combine(&mut self, other: UploadScanStats) {
        self.total_bytes += other.total_bytes;
        self.total_steps += other.total_steps;
    }
}

pub(crate) struct UploadProgressTracker {
    app: AppHandle,
    operation_id: String,
    cancel_flag: Arc<AtomicBool>,
    current_path: Option<String>,
    total_bytes: u64,
    uploaded_bytes: u64,
    total_steps: u64,
    completed_steps: u64,
}

pub(crate) struct DeleteProgressTracker {
    app: AppHandle,
    operation_id: String,
    cancel_flag: Arc<AtomicBool>,
    current_path: Option<String>,
    total_steps: u64,
    completed_steps: u64,
}

impl UploadProgressTracker {
    pub(crate) fn new(
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

    pub(crate) fn set_current_path(&mut self, path: Option<String>) -> Result<(), String> {
        self.current_path = path;
        self.emit()
    }

    pub(crate) fn advance_bytes(&mut self, count: u64) -> Result<(), String> {
        self.uploaded_bytes += count;
        self.emit()
    }

    pub(crate) fn finish_step(&mut self) -> Result<(), String> {
        self.completed_steps = (self.completed_steps + 1).min(self.total_steps);
        self.emit()
    }

    pub(crate) fn ensure_not_cancelled(&self) -> Result<(), String> {
        if self.cancel_flag.load(AtomicOrdering::SeqCst) {
            return Err("upload cancelled".to_string());
        }
        Ok(())
    }

    pub(crate) fn emit(&self) -> Result<(), String> {
        self.app
            .emit(
                super::UPLOAD_PROGRESS_EVENT,
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
    pub(crate) fn new(
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

    pub(crate) fn set_current_path(&mut self, path: Option<String>) -> Result<(), String> {
        self.current_path = path;
        self.emit()
    }

    pub(crate) fn finish_step(&mut self) -> Result<(), String> {
        self.completed_steps = (self.completed_steps + 1).min(self.total_steps);
        self.emit()
    }

    pub(crate) fn ensure_not_cancelled(&self) -> Result<(), String> {
        if self.cancel_flag.load(AtomicOrdering::SeqCst) {
            return Err("delete cancelled".to_string());
        }
        Ok(())
    }

    pub(crate) fn emit(&self) -> Result<(), String> {
        self.app
            .emit(
                super::DELETE_PROGRESS_EVENT,
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
    pub(crate) fn insert(&self, session_id: String, managed: ManagedSession) -> Result<(), String> {
        let mut guard = self
            .sessions
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        guard.insert(session_id, managed);
        Ok(())
    }

    pub(crate) fn send(&self, session_id: &str, command: SessionCommand) -> Result<(), String> {
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

    pub(crate) fn remove(&self, session_id: &str) -> Result<(), String> {
        let mut guard = self
            .sessions
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        guard.remove(session_id);
        Ok(())
    }
}

impl UploadCancellationRegistry {
    pub(crate) fn register(&self, operation_id: String) -> Result<Arc<AtomicBool>, String> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "upload cancellation registry poisoned".to_string())?;
        guard.insert(operation_id, flag.clone());
        Ok(flag)
    }

    pub(crate) fn cancel(&self, operation_id: &str) -> Result<(), String> {
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

    pub(crate) fn remove(&self, operation_id: &str) -> Result<(), String> {
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "upload cancellation registry poisoned".to_string())?;
        guard.remove(operation_id);
        Ok(())
    }
}

impl DeleteCancellationRegistry {
    pub(crate) fn register(&self, operation_id: String) -> Result<Arc<AtomicBool>, String> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "delete cancellation registry poisoned".to_string())?;
        guard.insert(operation_id, flag.clone());
        Ok(flag)
    }

    pub(crate) fn cancel(&self, operation_id: &str) -> Result<(), String> {
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

    pub(crate) fn remove(&self, operation_id: &str) -> Result<(), String> {
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "delete cancellation registry poisoned".to_string())?;
        guard.remove(operation_id);
        Ok(())
    }
}
