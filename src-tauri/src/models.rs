use log::warn;
use serde::{Deserialize, Serialize};
use ssh2::{Session, Sftp};
use std::{
    cell::Cell,
    collections::HashMap,
    fmt,
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        mpsc::Sender,
        Arc, Mutex,
    },
    time::{Duration, Instant},
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

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PortForwardKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortForwardConfig {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: PortForwardKind,
    pub(crate) local_port: u16,
    pub(crate) remote_host: String,
    pub(crate) remote_port: u16,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PortForwardStartMode {
    Manual,
    Auto,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortForwardStartRequest {
    pub(crate) operation_id: String,
    pub(crate) profile_id: String,
    pub(crate) mode: PortForwardStartMode,
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) forward: PortForwardConfig,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JumpHostConfig {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: AuthMethod,
    pub(crate) password: Option<String>,
    pub(crate) keychain_key_id: Option<String>,
    #[serde(default)]
    pub(crate) private_key_data: Option<String>,
    pub(crate) passphrase: Option<String>,
}

// Hand-written Debug that redacts secrets, mirroring the redaction used by
// summarize_remote_connection_request (secrets reported as "***" when set).
impl fmt::Debug for JumpHostConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JumpHostConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("auth_method", &self.auth_method)
            .field("password", &redact_secret(&self.password))
            .field("keychain_key_id", &self.keychain_key_id)
            .field("private_key_data", &redact_secret(&self.private_key_data))
            .field("passphrase", &redact_secret(&self.passphrase))
            .finish()
    }
}

fn redact_secret(value: &Option<String>) -> Option<&'static str> {
    value.as_ref().map(|_| "***")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionCreateRequest {
    #[serde(default)]
    pub(crate) operation_id: Option<String>,
    pub(crate) name: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: AuthMethod,
    pub(crate) password: Option<String>,
    pub(crate) keychain_key_id: Option<String>,
    #[serde(default)]
    pub(crate) private_key_data: Option<String>,
    pub(crate) passphrase: Option<String>,
    pub(crate) terminal_cols: u32,
    pub(crate) terminal_rows: u32,
    pub(crate) jump_host: Option<JumpHostConfig>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteConnectionRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: AuthMethod,
    pub(crate) password: Option<String>,
    pub(crate) keychain_key_id: Option<String>,
    #[serde(default)]
    pub(crate) private_key_data: Option<String>,
    pub(crate) passphrase: Option<String>,
    pub(crate) jump_host: Option<JumpHostConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionPreflightRequest {
    pub(crate) operation_id: String,
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionPreflightStepId {
    Dns,
    Tcp,
    JumpHostKey,
    JumpAuthentication,
    JumpTunnel,
    HostKey,
    Authentication,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionPreflightStepStatus {
    Passed,
    Warning,
    Failed,
    Blocked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionPreflightStep {
    pub(crate) id: ConnectionPreflightStepId,
    pub(crate) status: ConnectionPreflightStepStatus,
    pub(crate) detail: String,
    pub(crate) host: Option<String>,
    pub(crate) port: Option<u16>,
    pub(crate) fingerprint: Option<String>,
    pub(crate) trustable: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionPreflightStatus {
    Passed,
    Attention,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionPreflightResult {
    pub(crate) operation_id: String,
    pub(crate) status: ConnectionPreflightStatus,
    pub(crate) checked_at: i64,
    pub(crate) steps: Vec<ConnectionPreflightStep>,
}

// Hand-written Debug that redacts secrets, mirroring the redaction used by
// summarize_remote_connection_request (secrets reported as "***" when set).
impl fmt::Debug for RemoteConnectionRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteConnectionRequest")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("auth_method", &self.auth_method)
            .field("password", &redact_secret(&self.password))
            .field("keychain_key_id", &self.keychain_key_id)
            .field("private_key_data", &redact_secret(&self.private_key_data))
            .field("passphrase", &redact_secret(&self.passphrase))
            .field("jump_host", &self.jump_host)
            .finish()
    }
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
pub(crate) struct RemoteEntryOwnersRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    #[serde(default)]
    pub(crate) owner_ids: Vec<u32>,
    #[serde(default)]
    pub(crate) group_ids: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteEntryOwners {
    pub(crate) owner_names: HashMap<u32, String>,
    pub(crate) group_names: HashMap<u32, String>,
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
    // Batch: all paths are deleted over a single dedicated connection.
    pub(crate) paths: Vec<String>,
    pub(crate) operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyRemotePathRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) source_path: String,
    pub(crate) destination_directory: String,
    pub(crate) operation_id: String,
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
pub(crate) struct UpdateRemotePermissionsRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) path: String,
    pub(crate) permissions: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadRemoteFileRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadRemoteFileResponse {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) content: String,
    pub(crate) size: u64,
    pub(crate) is_text: bool,
    pub(crate) content_encoding: String,
    pub(crate) truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadRemotePathsRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) remote_paths: Vec<String>,
    pub(crate) destination_directory: String,
    #[serde(default)]
    pub(crate) conflict_policies: Vec<UploadConflictPolicy>,
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

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TransferItemStatus {
    Completed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferItemResult {
    pub(crate) source_path: String,
    pub(crate) destination_path: Option<String>,
    pub(crate) status: TransferItemStatus,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferBatchResult {
    pub(crate) items: Vec<TransferItemResult>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyLocalPathsRequest {
    pub(crate) source_paths: Vec<String>,
    pub(crate) destination_directory: String,
    #[serde(default)]
    pub(crate) conflict_policies: Vec<UploadConflictPolicy>,
    pub(crate) operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyRemoteToRemoteRequest {
    pub(crate) source_connection: RemoteConnectionRequest,
    pub(crate) destination_connection: RemoteConnectionRequest,
    pub(crate) source_paths: Vec<String>,
    pub(crate) destination_directory: String,
    #[serde(default)]
    pub(crate) conflict_policies: Vec<UploadConflictPolicy>,
    pub(crate) operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostKeyCheckRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostKeyCheckResult {
    pub(crate) status: HostKeyCheckStatus,
    pub(crate) fingerprint: Option<String>,
    pub(crate) message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostKeyCheckStatus {
    Match,
    Mismatch,
    NotFound,
    Failure,
}

#[cfg(test)]
mod host_key_check_status_tests {
    use super::HostKeyCheckStatus;

    #[test]
    fn not_found_serializes_as_frontend_camel_case_status() {
        assert_eq!(
            serde_json::to_string(&HostKeyCheckStatus::NotFound).unwrap(),
            "\"notFound\""
        );
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "payload")]
pub(crate) enum CreateSessionError {
    HostKeyUnknown {
        host: String,
        port: u16,
        fingerprint: Option<String>,
    },
    HostKeyMismatch {
        host: String,
        port: u16,
    },
    Other {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "payload")]
pub(crate) enum SessionErrorEvent {
    HostKeyUnknown {
        session_id: String,
        host: String,
        port: u16,
        fingerprint: Option<String>,
    },
    HostKeyMismatch {
        session_id: String,
        host: String,
        port: u16,
    },
}

/// Structured connection failure that preserves host-key metadata so callers
/// can emit trust dialogs instead of plain error strings.
#[derive(Debug, Clone)]
pub(crate) enum ConnectionError {
    HostKeyUnknown {
        host: String,
        port: u16,
        fingerprint: Option<String>,
    },
    HostKeyMismatch {
        host: String,
        port: u16,
    },
    Other {
        message: String,
    },
}

impl ConnectionError {
    pub(crate) fn message(&self) -> String {
        match self {
            ConnectionError::HostKeyUnknown { host, port, .. } => {
                format!(
                    "host key for {host}:{port} is not known — trust this host before connecting"
                )
            }
            ConnectionError::HostKeyMismatch { host, port } => {
                format!("host key for {host}:{port} does not match the known key — possible man-in-the-middle attack")
            }
            ConnectionError::Other { message } => message.clone(),
        }
    }

    /// Lossless conversion into the command-facing error so `create_session`
    /// rejects with the same host-key classification the connection produced.
    pub(crate) fn to_create_session_error(&self) -> CreateSessionError {
        match self {
            ConnectionError::HostKeyUnknown {
                host,
                port,
                fingerprint,
            } => CreateSessionError::HostKeyUnknown {
                host: host.clone(),
                port: *port,
                fingerprint: fingerprint.clone(),
            },
            ConnectionError::HostKeyMismatch { host, port } => {
                CreateSessionError::HostKeyMismatch {
                    host: host.clone(),
                    port: *port,
                }
            }
            ConnectionError::Other { message } => CreateSessionError::Other {
                message: message.clone(),
            },
        }
    }
}

/// Structured remote filesystem error. Serialization matches `CreateSessionError`
/// so the frontend can reuse the same host-key dialog handling.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", content = "payload")]
pub(crate) enum RemoteFsError {
    HostKeyUnknown {
        host: String,
        port: u16,
        fingerprint: Option<String>,
    },
    HostKeyMismatch {
        host: String,
        port: u16,
    },
    Other {
        message: String,
    },
}

impl RemoteFsError {
    pub(crate) fn from_connection_error(error: ConnectionError) -> Self {
        match error {
            ConnectionError::HostKeyUnknown {
                host,
                port,
                fingerprint,
            } => RemoteFsError::HostKeyUnknown {
                host,
                port,
                fingerprint,
            },
            ConnectionError::HostKeyMismatch { host, port } => {
                RemoteFsError::HostKeyMismatch { host, port }
            }
            ConnectionError::Other { message } => RemoteFsError::Other { message },
        }
    }
}

#[cfg(test)]
mod create_session_error_tests {
    use super::CreateSessionError;

    #[test]
    fn host_key_unknown_serializes_with_pascal_case_type_tag() {
        let error = CreateSessionError::HostKeyUnknown {
            host: "example.com".to_string(),
            port: 22,
            fingerprint: Some("SHA256:abc".to_string()),
        };
        assert_eq!(
            serde_json::to_string(&error).unwrap(),
            r#"{"type":"HostKeyUnknown","payload":{"host":"example.com","port":22,"fingerprint":"SHA256:abc"}}"#
        );
    }

    #[test]
    fn host_key_mismatch_serializes_with_pascal_case_type_tag() {
        let error = CreateSessionError::HostKeyMismatch {
            host: "example.com".to_string(),
            port: 22,
        };
        assert_eq!(
            serde_json::to_string(&error).unwrap(),
            r#"{"type":"HostKeyMismatch","payload":{"host":"example.com","port":22}}"#
        );
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrustHostRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
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

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProfileAuthMethod {
    Password,
    Key,
}

impl ProfileAuthMethod {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ProfileAuthMethod::Password => "password",
            ProfileAuthMethod::Key => "key",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UploadConflictPolicy {
    Overwrite,
    Replace,
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

/// Host identity attached to a closed event so the frontend can render the
/// disconnecting session even after its store record is gone.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionIdentity {
    pub(crate) title: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClosedEvent {
    pub(crate) session_id: String,
    pub(crate) identity: Option<SessionIdentity>,
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
pub(crate) struct RemoteCopyProgressEvent {
    pub(crate) operation_id: String,
    pub(crate) current_path: Option<String>,
    pub(crate) total_bytes: u64,
    pub(crate) copied_bytes: u64,
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

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum KeyCredentialKind {
    Password,
    KeyFile,
}

impl std::fmt::Display for KeyCredentialKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyCredentialKind::Password => write!(f, "password"),
            KeyCredentialKind::KeyFile => write!(f, "keyFile"),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeyCredentialSummary {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) key_type: String,
    pub(crate) kind: KeyCredentialKind,
    pub(crate) service: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnownHostEntry {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) fingerprint: String,
    pub(crate) key_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogFileInfo {
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) modified_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDirectoryListing {
    pub(crate) path: String,
    pub(crate) parent_path: Option<String>,
    pub(crate) entries: Vec<LocalFileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalFileEntry {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) kind: RemoteFileKind,
    pub(crate) size: Option<u64>,
    pub(crate) modified_at: Option<u64>,
}
pub(crate) enum SessionCommand {
    Write(String),
    Resize { cols: u32, rows: u32 },
    Close,
}

pub(crate) struct ManagedSession {
    pub(crate) sender: Sender<SessionCommand>,
    /// Poked after each enqueued command so an event-driven session worker
    /// wakes from its idle poll immediately. Local sessions poll their command
    /// channel on a timer instead and leave this empty.
    pub(crate) waker: Option<crate::session::SessionWaker>,
    pub(crate) status: StatusEvent,
    /// Signals that the frontend has attached its event listeners, so the
    /// session worker may emit output live instead of buffering it.
    pub(crate) output_ready: Arc<AtomicBool>,
    /// Set by the frontend when xterm's parser backlog crosses its high
    /// watermark. Workers stop reading their PTY until the backlog drains.
    pub(crate) output_paused: Arc<AtomicBool>,
}

#[derive(Default)]
pub(crate) struct SessionManager {
    sessions: Mutex<HashMap<String, ManagedSession>>,
}

pub(crate) struct ConnectedSftp {
    pub(crate) session: Session,
    pub(crate) sftp: Sftp,
    pub(crate) _jump_session: Option<Session>,
}

pub(crate) struct CancellationRegistry {
    kind: &'static str,
    operations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl CancellationRegistry {
    pub(crate) fn new(kind: &'static str) -> Self {
        Self {
            kind,
            operations: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn register(&self, operation_id: String) -> Result<Arc<AtomicBool>, String> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| format!("{} cancellation registry poisoned", self.kind))?;
        if guard.contains_key(&operation_id) {
            warn!(
                "{} cancellation registry: duplicate operation_id {operation_id}, replacing previous registration",
                self.kind
            );
        }
        guard.insert(operation_id, flag.clone());
        Ok(flag)
    }

    pub(crate) fn cancel(&self, operation_id: &str) -> Result<(), String> {
        let guard = self
            .operations
            .lock()
            .map_err(|_| format!("{} cancellation registry poisoned", self.kind))?;
        let flag = guard
            .get(operation_id)
            .ok_or_else(|| format!("{} operation {operation_id} not found", self.kind))?;
        flag.store(true, AtomicOrdering::SeqCst);
        Ok(())
    }

    pub(crate) fn remove(&self, operation_id: &str) -> Result<(), String> {
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| format!("{} cancellation registry poisoned", self.kind))?;
        guard.remove(operation_id);
        Ok(())
    }
}

macro_rules! cancellation_registry {
    ($name:ident, $kind:literal) => {
        pub(crate) struct $name(CancellationRegistry);

        impl $name {
            pub(crate) fn register(&self, operation_id: String) -> Result<Arc<AtomicBool>, String> {
                self.0.register(operation_id)
            }

            pub(crate) fn cancel(&self, operation_id: &str) -> Result<(), String> {
                self.0.cancel(operation_id)
            }

            pub(crate) fn remove(&self, operation_id: &str) -> Result<(), String> {
                self.0.remove(operation_id)
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self(CancellationRegistry::new($kind))
            }
        }
    };
}

cancellation_registry!(UploadCancellationRegistry, "upload");
cancellation_registry!(DeleteCancellationRegistry, "delete");
cancellation_registry!(PreflightCancellationRegistry, "connection preflight");
cancellation_registry!(RemoteHealthCancellationRegistry, "remote health snapshot");
cancellation_registry!(RunbookCancellationRegistry, "runbook step");

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
    last_emitted_at: Cell<Option<Instant>>,
}

/// Minimum interval between byte-progress events. Step boundaries, path
/// changes, and completion still emit immediately.
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);

fn should_emit_progress(last_emitted_at: Option<Instant>) -> bool {
    last_emitted_at.is_none_or(|instant| instant.elapsed() >= PROGRESS_EMIT_INTERVAL)
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
            last_emitted_at: Cell::new(None),
        }
    }

    pub(crate) fn set_current_path(&mut self, path: Option<String>) -> Result<(), String> {
        self.current_path = path;
        self.emit()
    }

    pub(crate) fn advance_bytes(&mut self, count: u64) -> Result<(), String> {
        self.downloaded_bytes += count;
        // Throttled: byte progress emits at most once per
        // PROGRESS_EMIT_INTERVAL, except when the transfer just completed.
        let completed = self.total_bytes > 0 && self.downloaded_bytes >= self.total_bytes;
        if completed || should_emit_progress(self.last_emitted_at.get()) {
            self.emit()?;
        }
        Ok(())
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
        self.last_emitted_at.set(Some(Instant::now()));
        // A failed progress emit must not abort the transfer; log and continue.
        if let Err(error) = self.app.emit(
            super::DOWNLOAD_PROGRESS_EVENT,
            DownloadProgressEvent {
                operation_id: self.operation_id.clone(),
                current_path: self.current_path.clone(),
                total_bytes: self.total_bytes,
                downloaded_bytes: self.downloaded_bytes,
                total_steps: self.total_steps,
                completed_steps: self.completed_steps,
            },
        ) {
            warn!("failed to emit download progress event: {error}");
        }
        Ok(())
    }
}

cancellation_registry!(DownloadCancellationRegistry, "download");
cancellation_registry!(RemoteCopyCancellationRegistry, "remote copy");

#[derive(Default, Clone, Copy)]
pub(crate) struct RemoteCopyScanStats {
    pub(crate) total_bytes: u64,
    pub(crate) total_steps: u64,
}

impl RemoteCopyScanStats {
    pub(crate) fn combine(&mut self, other: RemoteCopyScanStats) {
        self.total_bytes += other.total_bytes;
        self.total_steps += other.total_steps;
    }
}

pub(crate) struct RemoteCopyProgressTracker {
    app: AppHandle,
    operation_id: String,
    cancel_flag: Arc<AtomicBool>,
    current_path: Option<String>,
    total_bytes: u64,
    copied_bytes: u64,
    total_steps: u64,
    completed_steps: u64,
    last_emitted_at: Cell<Option<Instant>>,
}

impl RemoteCopyProgressTracker {
    pub(crate) fn new(
        app: AppHandle,
        operation_id: String,
        cancel_flag: Arc<AtomicBool>,
        stats: RemoteCopyScanStats,
    ) -> Self {
        Self {
            app,
            operation_id,
            cancel_flag,
            current_path: None,
            total_bytes: stats.total_bytes,
            copied_bytes: 0,
            total_steps: stats.total_steps,
            completed_steps: 0,
            last_emitted_at: Cell::new(None),
        }
    }

    pub(crate) fn set_current_path(&mut self, path: Option<String>) -> Result<(), String> {
        self.current_path = path;
        self.emit()
    }

    pub(crate) fn advance_bytes(&mut self, count: u64) -> Result<(), String> {
        self.copied_bytes += count;
        // Throttled: byte progress emits at most once per
        // PROGRESS_EMIT_INTERVAL, except when the transfer just completed.
        let completed = self.total_bytes > 0 && self.copied_bytes >= self.total_bytes;
        if completed || should_emit_progress(self.last_emitted_at.get()) {
            self.emit()?;
        }
        Ok(())
    }

    pub(crate) fn finish_step(&mut self) -> Result<(), String> {
        self.completed_steps = (self.completed_steps + 1).min(self.total_steps);
        self.emit()
    }

    pub(crate) fn ensure_not_cancelled(&self) -> Result<(), String> {
        if self.cancel_flag.load(AtomicOrdering::SeqCst) {
            return Err("remote copy cancelled".to_string());
        }
        Ok(())
    }

    pub(crate) fn emit(&self) -> Result<(), String> {
        self.last_emitted_at.set(Some(Instant::now()));
        // A failed progress emit must not abort the transfer; log and continue.
        if let Err(error) = self.app.emit(
            super::REMOTE_COPY_PROGRESS_EVENT,
            RemoteCopyProgressEvent {
                operation_id: self.operation_id.clone(),
                current_path: self.current_path.clone(),
                total_bytes: self.total_bytes,
                copied_bytes: self.copied_bytes,
                total_steps: self.total_steps,
                completed_steps: self.completed_steps,
            },
        ) {
            warn!("failed to emit remote copy progress event: {error}");
        }
        Ok(())
    }
}

#[derive(Debug, Default, Clone, Copy)]
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
    last_emitted_at: Cell<Option<Instant>>,
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
            last_emitted_at: Cell::new(None),
        }
    }

    pub(crate) fn set_current_path(&mut self, path: Option<String>) -> Result<(), String> {
        self.current_path = path;
        self.emit()
    }

    pub(crate) fn advance_bytes(&mut self, count: u64) -> Result<(), String> {
        self.uploaded_bytes += count;
        // Throttled: byte progress emits at most once per
        // PROGRESS_EMIT_INTERVAL, except when the transfer just completed.
        let completed = self.total_bytes > 0 && self.uploaded_bytes >= self.total_bytes;
        if completed || should_emit_progress(self.last_emitted_at.get()) {
            self.emit()?;
        }
        Ok(())
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
        self.last_emitted_at.set(Some(Instant::now()));
        // A failed progress emit must not abort the transfer; log and continue.
        if let Err(error) = self.app.emit(
            super::UPLOAD_PROGRESS_EVENT,
            UploadProgressEvent {
                operation_id: self.operation_id.clone(),
                current_path: self.current_path.clone(),
                total_bytes: self.total_bytes,
                uploaded_bytes: self.uploaded_bytes,
                total_steps: self.total_steps,
                completed_steps: self.completed_steps,
            },
        ) {
            warn!("failed to emit upload progress event: {error}");
        }
        Ok(())
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
        // total_steps is 0 until entries are discovered, so only cap when a
        // real total is known.
        self.completed_steps += 1;
        if self.total_steps > 0 {
            self.completed_steps = self.completed_steps.min(self.total_steps);
        }
        self.emit()
    }

    // rsync-style growing total: entries are counted as they are discovered
    // during the single-pass walk. No emit here — the next set_current_path /
    // finish_step carries the updated total.
    pub(crate) fn add_steps(&mut self, count: u64) {
        self.total_steps += count;
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
            .map_err(|_| format!("session {session_id} is not available"))?;
        if let Some(waker) = managed.waker.as_ref() {
            waker.wake();
        }
        Ok(())
    }

    pub(crate) fn status(&self, session_id: &str) -> Result<StatusEvent, String> {
        let guard = self
            .sessions
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        guard
            .get(session_id)
            .map(|managed| managed.status.clone())
            .ok_or_else(|| format!("session {session_id} not found"))
    }

    pub(crate) fn set_status(&self, session_id: &str, status: StatusEvent) -> Result<(), String> {
        let mut guard = self
            .sessions
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        let managed = guard
            .get_mut(session_id)
            .ok_or_else(|| format!("session {session_id} not found"))?;
        managed.status = status;
        Ok(())
    }

    pub(crate) fn mark_output_ready(&self, session_id: &str) -> Result<(), String> {
        let guard = self
            .sessions
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        let managed = guard
            .get(session_id)
            .ok_or_else(|| format!("session {session_id} not found"))?;
        managed.output_ready.store(true, AtomicOrdering::Relaxed);
        if let Some(waker) = managed.waker.as_ref() {
            waker.wake();
        }
        Ok(())
    }

    pub(crate) fn set_output_paused(&self, session_id: &str, paused: bool) -> Result<(), String> {
        let guard = self
            .sessions
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        let managed = guard
            .get(session_id)
            .ok_or_else(|| format!("session {session_id} not found"))?;
        managed.output_paused.store(paused, AtomicOrdering::Relaxed);
        if let Some(waker) = managed.waker.as_ref() {
            waker.wake();
        }
        Ok(())
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

#[cfg(test)]
mod session_manager_tests {
    use super::{ManagedSession, SessionCommand, SessionManager, SessionStatus, StatusEvent};
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
    use std::sync::{mpsc, Arc};

    fn managed_session(sender: mpsc::Sender<SessionCommand>) -> ManagedSession {
        ManagedSession {
            sender,
            waker: None,
            status: StatusEvent {
                session_id: "local-1".to_string(),
                status: SessionStatus::Connecting,
                message: None,
            },
            output_ready: Arc::new(AtomicBool::new(false)),
            output_paused: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn stores_and_updates_latest_session_status() {
        let manager = SessionManager::default();
        let (sender, _receiver) = mpsc::channel::<SessionCommand>();
        manager
            .insert("local-1".to_string(), managed_session(sender))
            .unwrap();

        manager
            .set_status(
                "local-1",
                StatusEvent {
                    session_id: "local-1".to_string(),
                    status: SessionStatus::Connected,
                    message: Some("ready".to_string()),
                },
            )
            .unwrap();

        let status = manager.status("local-1").unwrap();
        assert_eq!(status.status, SessionStatus::Connected);
        assert_eq!(status.message.as_deref(), Some("ready"));
    }

    #[test]
    fn mark_output_ready_flips_the_session_flag() {
        let manager = SessionManager::default();
        let (sender, _receiver) = mpsc::channel::<SessionCommand>();
        let managed = managed_session(sender);
        let flag = managed.output_ready.clone();
        manager.insert("local-1".to_string(), managed).unwrap();

        assert!(!flag.load(AtomicOrdering::Relaxed));
        manager.mark_output_ready("local-1").unwrap();
        assert!(flag.load(AtomicOrdering::Relaxed));
        assert!(manager.mark_output_ready("missing").is_err());
    }

    #[test]
    fn set_output_paused_updates_the_session_flag() {
        let manager = SessionManager::default();
        let (sender, _receiver) = mpsc::channel::<SessionCommand>();
        let managed = managed_session(sender);
        let flag = managed.output_paused.clone();
        manager.insert("local-1".to_string(), managed).unwrap();

        manager.set_output_paused("local-1", true).unwrap();
        assert!(flag.load(AtomicOrdering::Relaxed));
        manager.set_output_paused("local-1", false).unwrap();
        assert!(!flag.load(AtomicOrdering::Relaxed));
        assert!(manager.set_output_paused("missing", true).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::{
        should_emit_progress, AuthMethod, CancellationRegistry, JumpHostConfig,
        RemoteConnectionRequest, PROGRESS_EMIT_INTERVAL,
    };
    use std::sync::atomic::Ordering as AtomicOrdering;
    use std::time::{Duration, Instant};

    #[test]
    fn remote_connection_request_debug_redacts_secrets() {
        let request = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("super-secret-password".to_string()),
            keychain_key_id: None,
            private_key_data: Some("private-key-body".to_string()),
            passphrase: Some("secret-passphrase".to_string()),
            jump_host: Some(JumpHostConfig {
                host: "jump.example.com".to_string(),
                port: 22,
                username: "jump".to_string(),
                auth_method: AuthMethod::Key,
                password: Some("jump-secret-password".to_string()),
                keychain_key_id: None,
                private_key_data: Some("jump-key-body".to_string()),
                passphrase: Some("jump-secret-passphrase".to_string()),
            }),
        };

        let debug = format!("{request:?}");

        for secret in [
            "super-secret-password",
            "private-key-body",
            "secret-passphrase",
            "jump-secret-password",
            "jump-key-body",
            "jump-secret-passphrase",
        ] {
            assert!(!debug.contains(secret), "debug output leaks {secret}");
        }
        assert!(debug.contains("***"));
        assert!(debug.contains("example.com"));
    }

    #[test]
    fn register_duplicate_operation_id_replaces_without_failing() {
        let registry = CancellationRegistry::new("test");
        let first = registry.register("op-1".to_string()).unwrap();
        let second = registry.register("op-1".to_string()).unwrap();

        // The duplicate registration wins; the stale flag stays untouched.
        registry.cancel("op-1").unwrap();
        assert!(second.load(AtomicOrdering::SeqCst));
        assert!(!first.load(AtomicOrdering::SeqCst));
    }

    #[test]
    fn progress_emit_is_throttled_by_interval() {
        assert!(should_emit_progress(None));
        assert!(!should_emit_progress(Some(Instant::now())));
        assert!(!should_emit_progress(Some(
            Instant::now() - (PROGRESS_EMIT_INTERVAL - Duration::from_millis(10))
        )));
        assert!(should_emit_progress(Some(
            Instant::now() - (PROGRESS_EMIT_INTERVAL + Duration::from_millis(10))
        )));
    }
}

// --- Database row types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileRow {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: ProfileAuthMethod,
    pub(crate) keychain_key_id: Option<String>,
    pub(crate) jump_host_config: Option<String>,
    #[serde(default)]
    pub(crate) organization_json: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpBookmarkRow {
    pub(crate) id: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) path: String,
    pub(crate) side: String,
    pub(crate) label: Option<String>,
    pub(crate) created_at: i64,
}
