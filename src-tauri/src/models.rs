use crossbeam_channel::Sender as EventSender;
use log::warn;
use serde::{Deserialize, Serialize};
use ssh2::{Session, Sftp};
use std::{
    cell::Cell,
    collections::{HashMap, VecDeque},
    fmt,
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        mpsc::Sender as StandardSender,
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Runtime};

use crate::terminal_lease::{
    AgentTerminalBinding, SessionKind, TerminalLease, TerminalLeaseError, TerminalLeaseOwner,
    TerminalLeaseRevocationReason, TerminalLeaseSnapshot, TerminalLeaseState, TerminalLeaseToken,
};

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
    pub(crate) request_key: String,
    pub(crate) request_id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteEntryOwnersRequest {
    #[serde(flatten)]
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) request_key: String,
    pub(crate) request_id: u64,
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
    pub(crate) operation_id: String,
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
    pub(crate) operation_id: String,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        fingerprint: Option<String>,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        fingerprint: Option<String>,
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
        fingerprint: Option<String>,
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
            ConnectionError::HostKeyMismatch { host, port, .. } => {
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
            ConnectionError::HostKeyMismatch {
                host,
                port,
                fingerprint,
            } => CreateSessionError::HostKeyMismatch {
                host: host.clone(),
                port: *port,
                fingerprint: fingerprint.clone(),
            },
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
        #[serde(skip_serializing_if = "Option::is_none")]
        fingerprint: Option<String>,
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
            ConnectionError::HostKeyMismatch {
                host,
                port,
                fingerprint,
            } => RemoteFsError::HostKeyMismatch {
                host,
                port,
                fingerprint,
            },
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
            fingerprint: None,
        };
        assert_eq!(
            serde_json::to_string(&error).unwrap(),
            r#"{"type":"HostKeyMismatch","payload":{"host":"example.com","port":22}}"#
        );
    }

    #[test]
    fn host_key_mismatch_preserves_the_presented_fingerprint() {
        let error = CreateSessionError::HostKeyMismatch {
            host: "example.com".to_string(),
            port: 22,
            fingerprint: Some("ED25519 SHA256:changed".to_string()),
        };
        assert_eq!(
            serde_json::to_string(&error).unwrap(),
            r#"{"type":"HostKeyMismatch","payload":{"host":"example.com","port":22,"fingerprint":"ED25519 SHA256:changed"}}"#
        );
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrustHostRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) expected_fingerprint: String,
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

pub(crate) enum SessionCommandSender {
    Standard(StandardSender<SessionCommand>),
    Event(EventSender<SessionCommand>),
}

impl SessionCommandSender {
    fn send(&self, command: SessionCommand) -> Result<(), ()> {
        match self {
            Self::Standard(sender) => sender.send(command).map_err(|_| ()),
            Self::Event(sender) => sender.send(command).map_err(|_| ()),
        }
    }
}

pub(crate) struct ManagedSession {
    pub(crate) kind: SessionKind,
    pub(crate) sender: SessionCommandSender,
    /// Poked after each enqueued command so an event-driven session worker
    /// wakes from its idle socket wait immediately. Local sessions select on
    /// their command channel directly and leave this empty.
    pub(crate) waker: Option<crate::session::SessionWaker>,
    /// Local workers block in a channel select rather than on the SSH socket.
    /// A capacity-one notification coalesces ready/pause/resume changes while
    /// still waking an idle local worker immediately.
    pub(crate) output_state_sender: Option<EventSender<()>>,
    pub(crate) status: StatusEvent,
    /// Signals that the frontend has attached its event listeners, so the
    /// session worker may emit output live instead of buffering it.
    pub(crate) output_ready: Arc<AtomicBool>,
    /// Set by the frontend when xterm's parser backlog crosses its high
    /// watermark. Remote workers stop reading; local workers stop draining
    /// their bounded reader queue until the backlog drains.
    pub(crate) output_paused: Arc<AtomicBool>,
}

#[derive(Default)]
struct SessionRegistry {
    sessions: HashMap<String, ManagedSession>,
    /// Lease tombstones intentionally outlive closed session transports. This
    /// preserves the authoritative revocation reason and keeps every token
    /// from the closed PTY permanently fenced for the lifetime of the app.
    terminal_leases: HashMap<String, TerminalLease>,
}

#[derive(Clone, Default)]
pub(crate) struct SessionManager {
    registry: Arc<Mutex<SessionRegistry>>,
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

pub(crate) trait TransferEventEmitter: Clone {
    fn emit_transfer_event<S>(&self, event: &str, payload: S) -> Result<(), String>
    where
        S: Serialize + Clone;
}

impl<R: Runtime> TransferEventEmitter for AppHandle<R> {
    fn emit_transfer_event<S>(&self, event: &str, payload: S) -> Result<(), String>
    where
        S: Serialize + Clone,
    {
        self.emit(event, payload).map_err(|error| error.to_string())
    }
}

pub(crate) const REMOTE_FILE_READ_CANCELLED_MESSAGE: &str = "remote file read cancelled";
const REMOTE_FILE_READ_CANCELLATION_TOMBSTONE_LIMIT: usize = 1_024;

#[derive(Clone, Copy, PartialEq, Eq)]
enum RemoteFileReadCancellationTombstoneKind {
    PendingCancel,
    Completed,
}

#[derive(Clone, Copy)]
struct RemoteFileReadCancellationTombstone {
    kind: RemoteFileReadCancellationTombstoneKind,
    generation: u64,
}

#[derive(Default)]
struct RemoteFileReadCancellationState {
    active: HashMap<String, Arc<AtomicBool>>,
    tombstones: HashMap<String, RemoteFileReadCancellationTombstone>,
    tombstone_order: VecDeque<(String, u64)>,
    next_generation: u64,
}

/// Cancellation state for one-shot remote open/preview reads.
///
/// Unlike the transfer registries, cancellation can race ahead of command
/// registration when a preview is closed immediately after it starts. A
/// bounded pending tombstone carries that cancellation into `register`.
/// Completed tombstones make late/repeated cancellation idempotent without
/// turning it into a pending cancellation for an already-finished read.
#[derive(Default)]
pub(crate) struct RemoteFileReadCancellationRegistry {
    state: Mutex<RemoteFileReadCancellationState>,
}

impl RemoteFileReadCancellationRegistry {
    fn remember_tombstone(
        state: &mut RemoteFileReadCancellationState,
        operation_id: String,
        kind: RemoteFileReadCancellationTombstoneKind,
    ) {
        state.next_generation = state.next_generation.wrapping_add(1).max(1);
        let generation = state.next_generation;
        state.tombstones.insert(
            operation_id.clone(),
            RemoteFileReadCancellationTombstone { kind, generation },
        );
        state.tombstone_order.push_back((operation_id, generation));

        while state.tombstone_order.len() > REMOTE_FILE_READ_CANCELLATION_TOMBSTONE_LIMIT {
            let Some((old_operation_id, old_generation)) = state.tombstone_order.pop_front() else {
                break;
            };
            if state
                .tombstones
                .get(&old_operation_id)
                .is_some_and(|entry| entry.generation == old_generation)
            {
                state.tombstones.remove(&old_operation_id);
            }
        }
    }

    pub(crate) fn register(&self, operation_id: String) -> Result<Arc<AtomicBool>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "remote file read cancellation registry poisoned".to_string())?;
        let cancelled_before_registration =
            state.tombstones.remove(&operation_id).is_some_and(|entry| {
                entry.kind == RemoteFileReadCancellationTombstoneKind::PendingCancel
            });
        let flag = Arc::new(AtomicBool::new(cancelled_before_registration));
        if let Some(previous) = state.active.insert(operation_id.clone(), flag.clone()) {
            warn!(
                "remote file read cancellation registry: duplicate operation_id {operation_id}, cancelling previous registration"
            );
            previous.store(true, AtomicOrdering::SeqCst);
        }
        Ok(flag)
    }

    pub(crate) fn cancel(&self, operation_id: &str) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "remote file read cancellation registry poisoned".to_string())?;
        if let Some(flag) = state.active.get(operation_id) {
            flag.store(true, AtomicOrdering::SeqCst);
            return Ok(());
        }
        if state.tombstones.contains_key(operation_id) {
            return Ok(());
        }
        Self::remember_tombstone(
            &mut state,
            operation_id.to_string(),
            RemoteFileReadCancellationTombstoneKind::PendingCancel,
        );
        Ok(())
    }

    pub(crate) fn remove(
        &self,
        operation_id: &str,
        registered_flag: &Arc<AtomicBool>,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "remote file read cancellation registry poisoned".to_string())?;
        let is_current_registration = state
            .active
            .get(operation_id)
            .is_some_and(|active_flag| Arc::ptr_eq(active_flag, registered_flag));
        if !is_current_registration {
            return Ok(());
        }
        state.active.remove(operation_id);
        if !state
            .tombstones
            .get(operation_id)
            .is_some_and(|entry| entry.kind == RemoteFileReadCancellationTombstoneKind::Completed)
        {
            Self::remember_tombstone(
                &mut state,
                operation_id.to_string(),
                RemoteFileReadCancellationTombstoneKind::Completed,
            );
        }
        Ok(())
    }
}

#[derive(Default, Clone, Copy)]
pub(crate) struct DownloadScanStats {
    pub(crate) total_bytes: u64,
    pub(crate) total_steps: u64,
    pub(crate) total_files: u64,
}

impl DownloadScanStats {
    pub(crate) fn combine(&mut self, other: DownloadScanStats) {
        self.total_bytes = self.total_bytes.saturating_add(other.total_bytes);
        self.total_steps = self.total_steps.saturating_add(other.total_steps);
        self.total_files = self.total_files.saturating_add(other.total_files);
    }
}

pub(crate) struct DownloadProgressTracker<E: TransferEventEmitter> {
    emitter: E,
    operation_id: String,
    cancel_flag: Arc<AtomicBool>,
    current_path: Option<String>,
    total_bytes: u64,
    downloaded_bytes: u64,
    total_steps: u64,
    completed_steps: u64,
    emit_state: ProgressEmitState,
}

/// Minimum interval between coalesced progress snapshots. The trackers retain
/// their latest counters/path while the interval is closed, then emit that
/// latest state on the next eligible update or a forced final/cancel flush.
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);

fn should_emit_progress(last_emitted_at: Option<Instant>, now: Instant, force: bool) -> bool {
    force
        || last_emitted_at
            .is_none_or(|instant| now.saturating_duration_since(instant) >= PROGRESS_EMIT_INTERVAL)
}

fn crossed_progress_total(previous: u64, current: u64, total: u64) -> bool {
    total > 0 && previous < total && current >= total
}

#[derive(Default)]
struct ProgressEmitState {
    last_emitted_at: Cell<Option<Instant>>,
    dirty: Cell<bool>,
}

impl ProgressEmitState {
    fn mark_dirty(&self) {
        self.dirty.set(true);
    }

    fn should_emit(&self, force: bool) -> bool {
        self.should_emit_at(Instant::now(), force)
    }

    fn should_emit_at(&self, now: Instant, force: bool) -> bool {
        self.dirty.get() && should_emit_progress(self.last_emitted_at.get(), now, force)
    }

    fn mark_emitted(&self) {
        self.mark_emitted_at(Instant::now());
    }

    fn mark_emitted_at(&self, now: Instant) {
        self.last_emitted_at.set(Some(now));
        self.dirty.set(false);
    }

    fn needs_flush(&self) -> bool {
        self.dirty.get()
    }
}

impl<E: TransferEventEmitter> DownloadProgressTracker<E> {
    pub(crate) fn new(
        emitter: E,
        operation_id: String,
        cancel_flag: Arc<AtomicBool>,
        stats: DownloadScanStats,
    ) -> Self {
        Self {
            emitter,
            operation_id,
            cancel_flag,
            current_path: None,
            total_bytes: stats.total_bytes,
            downloaded_bytes: 0,
            total_steps: stats.total_steps,
            completed_steps: 0,
            emit_state: ProgressEmitState::default(),
        }
    }

    pub(crate) fn set_current_path(&mut self, path: Option<String>) -> Result<(), String> {
        let flush = path.is_none();
        self.current_path = path;
        self.emit_state.mark_dirty();
        self.emit_if_due(flush)
    }

    pub(crate) fn advance_bytes(&mut self, count: u64) -> Result<(), String> {
        let previous = self.downloaded_bytes;
        self.downloaded_bytes = self.downloaded_bytes.saturating_add(count);
        self.emit_state.mark_dirty();
        // Throttled: byte progress emits at most once per
        // PROGRESS_EMIT_INTERVAL, except when the transfer just completed.
        let completed = crossed_progress_total(previous, self.downloaded_bytes, self.total_bytes);
        self.emit_if_due(completed)
    }

    pub(crate) fn finish_step(&mut self) -> Result<(), String> {
        let previous = self.completed_steps;
        self.completed_steps = self.completed_steps.saturating_add(1).min(self.total_steps);
        self.emit_state.mark_dirty();
        let completed = crossed_progress_total(previous, self.completed_steps, self.total_steps);
        self.emit_if_due(completed)
    }

    pub(crate) fn ensure_not_cancelled(&self) -> Result<(), String> {
        if self.cancel_flag.load(AtomicOrdering::SeqCst) {
            if let Err(error) = self.emit() {
                warn!("failed to flush download progress on cancellation: {error}");
            }
            return Err("download cancelled".to_string());
        }
        Ok(())
    }

    fn emit_if_due(&self, force: bool) -> Result<(), String> {
        if self.emit_state.should_emit(force) {
            self.emit()?;
        }
        Ok(())
    }

    pub(crate) fn emit(&self) -> Result<(), String> {
        self.emit_state.mark_emitted();
        // A failed progress emit must not abort the transfer; log and continue.
        if let Err(error) = self.emitter.emit_transfer_event(
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

impl<E: TransferEventEmitter> Drop for DownloadProgressTracker<E> {
    fn drop(&mut self) {
        if self.emit_state.needs_flush() {
            let _ = self.emit();
        }
    }
}

cancellation_registry!(DownloadCancellationRegistry, "download");
cancellation_registry!(RemoteCopyCancellationRegistry, "remote copy");

#[derive(Default, Clone, Copy)]
pub(crate) struct RemoteCopyScanStats {
    pub(crate) total_bytes: u64,
    pub(crate) total_steps: u64,
    pub(crate) total_files: u64,
}

impl RemoteCopyScanStats {
    pub(crate) fn combine(&mut self, other: RemoteCopyScanStats) {
        self.total_bytes = self.total_bytes.saturating_add(other.total_bytes);
        self.total_steps = self.total_steps.saturating_add(other.total_steps);
        self.total_files = self.total_files.saturating_add(other.total_files);
    }
}

pub(crate) struct RemoteCopyProgressTracker<E: TransferEventEmitter> {
    emitter: E,
    operation_id: String,
    cancel_flag: Arc<AtomicBool>,
    current_path: Option<String>,
    total_bytes: u64,
    copied_bytes: u64,
    total_steps: u64,
    completed_steps: u64,
    emit_state: ProgressEmitState,
}

impl<E: TransferEventEmitter> RemoteCopyProgressTracker<E> {
    pub(crate) fn new(
        emitter: E,
        operation_id: String,
        cancel_flag: Arc<AtomicBool>,
        stats: RemoteCopyScanStats,
    ) -> Self {
        Self {
            emitter,
            operation_id,
            cancel_flag,
            current_path: None,
            total_bytes: stats.total_bytes,
            copied_bytes: 0,
            total_steps: stats.total_steps,
            completed_steps: 0,
            emit_state: ProgressEmitState::default(),
        }
    }

    pub(crate) fn set_current_path(&mut self, path: Option<String>) -> Result<(), String> {
        let flush = path.is_none();
        self.current_path = path;
        self.emit_state.mark_dirty();
        self.emit_if_due(flush)
    }

    pub(crate) fn advance_bytes(&mut self, count: u64) -> Result<(), String> {
        let previous = self.copied_bytes;
        self.copied_bytes = self.copied_bytes.saturating_add(count);
        self.emit_state.mark_dirty();
        // Throttled: byte progress emits at most once per
        // PROGRESS_EMIT_INTERVAL, except when the transfer just completed.
        let completed = crossed_progress_total(previous, self.copied_bytes, self.total_bytes);
        self.emit_if_due(completed)
    }

    pub(crate) fn finish_step(&mut self) -> Result<(), String> {
        let previous = self.completed_steps;
        self.completed_steps = self.completed_steps.saturating_add(1).min(self.total_steps);
        self.emit_state.mark_dirty();
        let completed = crossed_progress_total(previous, self.completed_steps, self.total_steps);
        self.emit_if_due(completed)
    }

    pub(crate) fn ensure_not_cancelled(&self) -> Result<(), String> {
        if self.cancel_flag.load(AtomicOrdering::SeqCst) {
            if let Err(error) = self.emit() {
                warn!("failed to flush remote copy progress on cancellation: {error}");
            }
            return Err("remote copy cancelled".to_string());
        }
        Ok(())
    }

    fn emit_if_due(&self, force: bool) -> Result<(), String> {
        if self.emit_state.should_emit(force) {
            self.emit()?;
        }
        Ok(())
    }

    pub(crate) fn emit(&self) -> Result<(), String> {
        self.emit_state.mark_emitted();
        // A failed progress emit must not abort the transfer; log and continue.
        if let Err(error) = self.emitter.emit_transfer_event(
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

impl<E: TransferEventEmitter> Drop for RemoteCopyProgressTracker<E> {
    fn drop(&mut self) {
        if self.emit_state.needs_flush() {
            let _ = self.emit();
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct UploadScanStats {
    pub(crate) total_bytes: u64,
    pub(crate) total_steps: u64,
    pub(crate) total_files: u64,
}

impl UploadScanStats {
    pub(crate) fn combine(&mut self, other: UploadScanStats) {
        self.total_bytes = self.total_bytes.saturating_add(other.total_bytes);
        self.total_steps = self.total_steps.saturating_add(other.total_steps);
        self.total_files = self.total_files.saturating_add(other.total_files);
    }
}

pub(crate) struct UploadProgressTracker<E: TransferEventEmitter> {
    emitter: E,
    operation_id: String,
    cancel_flag: Arc<AtomicBool>,
    current_path: Option<String>,
    total_bytes: u64,
    uploaded_bytes: u64,
    total_steps: u64,
    completed_steps: u64,
    emit_state: ProgressEmitState,
}

pub(crate) struct DeleteProgressTracker {
    app: AppHandle,
    operation_id: String,
    cancel_flag: Arc<AtomicBool>,
    current_path: Option<String>,
    total_steps: u64,
    completed_steps: u64,
    emit_state: ProgressEmitState,
}

impl<E: TransferEventEmitter> UploadProgressTracker<E> {
    pub(crate) fn new(
        emitter: E,
        operation_id: String,
        cancel_flag: Arc<AtomicBool>,
        stats: UploadScanStats,
    ) -> Self {
        Self {
            emitter,
            operation_id,
            cancel_flag,
            current_path: None,
            total_bytes: stats.total_bytes,
            uploaded_bytes: 0,
            total_steps: stats.total_steps,
            completed_steps: 0,
            emit_state: ProgressEmitState::default(),
        }
    }

    pub(crate) fn set_current_path(&mut self, path: Option<String>) -> Result<(), String> {
        let flush = path.is_none();
        self.current_path = path;
        self.emit_state.mark_dirty();
        self.emit_if_due(flush)
    }

    pub(crate) fn advance_bytes(&mut self, count: u64) -> Result<(), String> {
        let previous = self.uploaded_bytes;
        self.uploaded_bytes = self.uploaded_bytes.saturating_add(count);
        self.emit_state.mark_dirty();
        // Throttled: byte progress emits at most once per
        // PROGRESS_EMIT_INTERVAL, except when the transfer just completed.
        let completed = crossed_progress_total(previous, self.uploaded_bytes, self.total_bytes);
        self.emit_if_due(completed)
    }

    pub(crate) fn finish_step(&mut self) -> Result<(), String> {
        let previous = self.completed_steps;
        self.completed_steps = self.completed_steps.saturating_add(1).min(self.total_steps);
        self.emit_state.mark_dirty();
        let completed = crossed_progress_total(previous, self.completed_steps, self.total_steps);
        self.emit_if_due(completed)
    }

    pub(crate) fn ensure_not_cancelled(&self) -> Result<(), String> {
        if self.cancel_flag.load(AtomicOrdering::SeqCst) {
            if let Err(error) = self.emit() {
                warn!("failed to flush upload progress on cancellation: {error}");
            }
            return Err("upload cancelled".to_string());
        }
        Ok(())
    }

    fn emit_if_due(&self, force: bool) -> Result<(), String> {
        if self.emit_state.should_emit(force) {
            self.emit()?;
        }
        Ok(())
    }

    pub(crate) fn emit(&self) -> Result<(), String> {
        self.emit_state.mark_emitted();
        // A failed progress emit must not abort the transfer; log and continue.
        if let Err(error) = self.emitter.emit_transfer_event(
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

impl<E: TransferEventEmitter> Drop for UploadProgressTracker<E> {
    fn drop(&mut self) {
        if self.emit_state.needs_flush() {
            let _ = self.emit();
        }
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
            emit_state: ProgressEmitState::default(),
        }
    }

    pub(crate) fn set_current_path(&mut self, path: Option<String>) -> Result<(), String> {
        let flush = path.is_none();
        self.current_path = path;
        self.emit_state.mark_dirty();
        self.emit_if_due(flush)
    }

    pub(crate) fn finish_step(&mut self) -> Result<(), String> {
        // total_steps is 0 until entries are discovered, so only cap when a
        // real total is known.
        self.completed_steps = self.completed_steps.saturating_add(1);
        if self.total_steps > 0 {
            self.completed_steps = self.completed_steps.min(self.total_steps);
        }
        self.emit_state.mark_dirty();
        self.emit_if_due(false)
    }

    // rsync-style growing total: entries are counted as they are discovered
    // during the single-pass walk. No emit here — the next set_current_path /
    // finish_step carries the updated total.
    pub(crate) fn add_steps(&mut self, count: u64) {
        self.total_steps = self.total_steps.saturating_add(count);
        self.emit_state.mark_dirty();
    }

    pub(crate) fn ensure_not_cancelled(&self) -> Result<(), String> {
        if self.cancel_flag.load(AtomicOrdering::SeqCst) {
            if let Err(error) = self.emit() {
                warn!("failed to flush delete progress on cancellation: {error}");
            }
            return Err("delete cancelled".to_string());
        }
        Ok(())
    }

    fn emit_if_due(&self, force: bool) -> Result<(), String> {
        if self.emit_state.should_emit(force) {
            self.emit()?;
        }
        Ok(())
    }

    pub(crate) fn emit(&self) -> Result<(), String> {
        self.emit_state.mark_emitted();
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

impl Drop for DeleteProgressTracker {
    fn drop(&mut self) {
        if self.emit_state.needs_flush() {
            if let Err(error) = self.emit() {
                warn!("failed to flush delete progress on drop: {error}");
            }
        }
    }
}

impl SessionManager {
    /// Registers an ordinary local or remote terminal. Agent PTYs must use
    /// insert_agent_pty so registration also creates the run/session lease.
    pub(crate) fn insert(&self, session_id: String, managed: ManagedSession) -> Result<(), String> {
        if managed.kind != SessionKind::UserTerminal {
            return Err(format!(
                "dedicated Agent PTY {session_id} must be registered with an Agent binding"
            ));
        }
        let mut guard = self
            .registry
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        if guard.terminal_leases.contains_key(&session_id) {
            return Err(format!(
                "session {session_id} is reserved by an Agent PTY lease tombstone"
            ));
        }
        guard.sessions.insert(session_id, managed);
        Ok(())
    }

    /// Registers a transport that was created only for one Agent run. This is
    /// the sole creation path for AgentPty kind and starts a fresh epoch.
    pub(crate) fn insert_agent_pty(
        &self,
        session_id: String,
        run_id: String,
        mut managed: ManagedSession,
    ) -> Result<TerminalLeaseSnapshot, TerminalLeaseError> {
        let mut guard = self
            .registry
            .lock()
            .map_err(|_| TerminalLeaseError::RegistryPoisoned)?;
        if guard.sessions.contains_key(&session_id)
            || guard.terminal_leases.contains_key(&session_id)
        {
            return Err(TerminalLeaseError::SessionAlreadyRegistered { session_id });
        }
        managed.kind = SessionKind::AgentPty;
        let binding = AgentTerminalBinding {
            run_id,
            session_id: session_id.clone(),
        };
        let lease = TerminalLease::new(binding);
        let snapshot = lease.snapshot();
        guard.sessions.insert(session_id.clone(), managed);
        guard.terminal_leases.insert(session_id, lease);
        Ok(snapshot)
    }

    #[allow(dead_code)]
    pub(crate) fn session_kind(&self, session_id: &str) -> Result<SessionKind, String> {
        let guard = self
            .registry
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        guard
            .sessions
            .get(session_id)
            .map(|managed| managed.kind)
            .ok_or_else(|| format!("session {session_id} not found"))
    }

    /// Ordinary write_session entry. It deliberately has no takeover semantics
    /// and therefore cannot be used as a dedicated Agent PTY bypass.
    pub(crate) fn write_user_session(&self, session_id: &str, data: String) -> Result<(), String> {
        self.write_input(TerminalInput::OrdinaryUser { session_id, data })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// Internal-only Agent input seam. No Tauri command exposes this method.
    #[allow(dead_code)]
    pub(crate) fn write_agent_input(
        &self,
        binding: &AgentTerminalBinding,
        token: TerminalLeaseToken,
        data: String,
    ) -> Result<TerminalLeaseSnapshot, TerminalLeaseError> {
        self.write_input(TerminalInput::Agent {
            binding,
            token,
            data,
        })
        .map(|snapshot| snapshot.expect("Agent input always returns a lease snapshot"))
    }

    /// Internal user takeover seam for a future narrow UI protocol. Ownership
    /// change and the first input enqueue occur while holding one authority
    /// lock, so Agent and user bytes cannot interleave inside that boundary.
    #[allow(dead_code)]
    pub(crate) fn take_over_agent_pty_and_write(
        &self,
        binding: &AgentTerminalBinding,
        data: String,
    ) -> Result<TerminalLeaseSnapshot, TerminalLeaseError> {
        self.write_input(TerminalInput::TakeoverUser { binding, data })
            .map(|snapshot| snapshot.expect("Agent PTY takeover always returns a lease snapshot"))
    }

    /// Explicitly returns a user-owned dedicated PTY to its bound Agent run.
    /// Revocation and re-grant happen under the same registry lock, so no old
    /// user/Agent epoch can write between the two authority changes. Callers
    /// must separately rotate their output-capture epoch before exposing any
    /// later output to a model.
    #[allow(dead_code)]
    pub(crate) fn return_agent_pty_control(
        &self,
        binding: &AgentTerminalBinding,
    ) -> Result<TerminalLeaseSnapshot, TerminalLeaseError> {
        let mut guard = self
            .registry
            .lock()
            .map_err(|_| TerminalLeaseError::RegistryPoisoned)?;
        require_connected_agent_session(&guard.sessions, binding)?;
        let lease = guard
            .terminal_leases
            .get_mut(&binding.session_id)
            .ok_or_else(|| TerminalLeaseError::LeaseNotFound {
                session_id: binding.session_id.clone(),
            })?;
        lease.validate_binding(binding)?;
        let snapshot = lease.snapshot();
        if snapshot.owner != TerminalLeaseOwner::User
            || snapshot.state != TerminalLeaseState::Active
        {
            return Err(TerminalLeaseError::OwnerMismatch {
                owner: snapshot.owner,
            });
        }
        lease.revoke(TerminalLeaseRevocationReason::UserReturnedControl)?;
        lease.grant_agent_control(binding)?;
        Ok(lease.snapshot())
    }

    /// Revokes one exact dedicated PTY before coordinator state changes are
    /// published. This is used for sensitive/unsupported handoff and control
    /// lifecycle fences; it never grants another owner implicitly.
    #[allow(dead_code)]
    pub(crate) fn revoke_agent_terminal(
        &self,
        binding: &AgentTerminalBinding,
        reason: TerminalLeaseRevocationReason,
    ) -> Result<TerminalLeaseSnapshot, TerminalLeaseError> {
        let mut guard = self
            .registry
            .lock()
            .map_err(|_| TerminalLeaseError::RegistryPoisoned)?;
        let lease = guard
            .terminal_leases
            .get_mut(&binding.session_id)
            .ok_or_else(|| TerminalLeaseError::LeaseNotFound {
                session_id: binding.session_id.clone(),
            })?;
        lease.validate_binding(binding)?;
        lease.revoke(reason)?;
        Ok(lease.snapshot())
    }

    fn write_input(
        &self,
        input: TerminalInput<'_>,
    ) -> Result<Option<TerminalLeaseSnapshot>, TerminalLeaseError> {
        let mut guard = self
            .registry
            .lock()
            .map_err(|_| TerminalLeaseError::RegistryPoisoned)?;
        let SessionRegistry {
            sessions,
            terminal_leases,
        } = &mut *guard;

        match input {
            TerminalInput::OrdinaryUser { session_id, data } => {
                let managed = sessions.get(session_id).ok_or_else(|| {
                    TerminalLeaseError::SessionNotFound {
                        session_id: session_id.to_string(),
                    }
                })?;
                if managed.kind == SessionKind::AgentPty {
                    return Err(TerminalLeaseError::DedicatedAgentPtyRequiresTakeover {
                        session_id: session_id.to_string(),
                    });
                }
                enqueue_session_command(managed, SessionCommand::Write(data), session_id)?;
                Ok(None)
            }
            TerminalInput::Agent {
                binding,
                token,
                data,
            } => {
                let managed = require_connected_agent_session(sessions, binding)?;
                let lease = terminal_leases
                    .get_mut(&binding.session_id)
                    .ok_or_else(|| TerminalLeaseError::LeaseNotFound {
                        session_id: binding.session_id.clone(),
                    })?;
                lease.validate_agent_input(binding, token)?;
                let next_revision = lease.next_revision()?;
                if enqueue_session_command(
                    managed,
                    SessionCommand::Write(data),
                    &binding.session_id,
                )
                .is_err()
                {
                    let _ = lease.revoke(TerminalLeaseRevocationReason::TransportUnavailable);
                    return Err(TerminalLeaseError::TransportUnavailable {
                        session_id: binding.session_id.clone(),
                    });
                }
                lease.commit_revision(next_revision);
                Ok(Some(lease.snapshot()))
            }
            TerminalInput::TakeoverUser { binding, data } => {
                let managed = require_connected_agent_session(sessions, binding)?;
                let lease = terminal_leases
                    .get_mut(&binding.session_id)
                    .ok_or_else(|| TerminalLeaseError::LeaseNotFound {
                        session_id: binding.session_id.clone(),
                    })?;
                lease.validate_binding(binding)?;
                let already_user_owned = lease.snapshot().state == TerminalLeaseState::Active
                    && lease.snapshot().owner == TerminalLeaseOwner::User;
                let next_revision = if already_user_owned {
                    Some(lease.next_revision()?)
                } else {
                    lease.take_over_by_user()?;
                    None
                };
                if enqueue_session_command(
                    managed,
                    SessionCommand::Write(data),
                    &binding.session_id,
                )
                .is_err()
                {
                    let _ = lease.revoke(TerminalLeaseRevocationReason::TransportUnavailable);
                    return Err(TerminalLeaseError::TransportUnavailable {
                        session_id: binding.session_id.clone(),
                    });
                }
                if let Some(revision) = next_revision {
                    lease.commit_revision(revision);
                }
                Ok(Some(lease.snapshot()))
            }
        }
    }

    pub(crate) fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), String> {
        let guard = self
            .registry
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        let managed = guard
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("session {session_id} not found"))?;
        enqueue_session_command(managed, SessionCommand::Resize { cols, rows }, session_id)
            .map_err(|error| error.to_string())
    }

    /// Revokes an Agent lease before the close command is enqueued. Keeping
    /// both under one lock prevents a final old-epoch write from racing in
    /// between close and revocation.
    pub(crate) fn close(&self, session_id: &str) -> Result<(), String> {
        let mut guard = self
            .registry
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        if let Some(lease) = guard.terminal_leases.get_mut(session_id) {
            lease
                .revoke(TerminalLeaseRevocationReason::Closed)
                .map_err(|error| error.to_string())?;
        }
        let send_result = guard
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("session {session_id} not found"))
            .and_then(|managed| {
                enqueue_session_command(managed, SessionCommand::Close, session_id)
                    .map_err(|error| error.to_string())
            });
        guard.sessions.remove(session_id);
        send_result
    }

    pub(crate) fn status(&self, session_id: &str) -> Result<StatusEvent, String> {
        let guard = self
            .registry
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        guard
            .sessions
            .get(session_id)
            .map(|managed| managed.status.clone())
            .ok_or_else(|| format!("session {session_id} not found"))
    }

    pub(crate) fn set_status(&self, session_id: &str, status: StatusEvent) -> Result<(), String> {
        let mut guard = self
            .registry
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        let managed = guard
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("session {session_id} not found"))?;
        let kind = managed.kind;
        managed.status = status;
        if kind == SessionKind::AgentPty
            && matches!(
                managed.status.status,
                SessionStatus::Disconnected | SessionStatus::Error
            )
        {
            if let Some(lease) = guard.terminal_leases.get_mut(session_id) {
                lease
                    .revoke(TerminalLeaseRevocationReason::Disconnected)
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    pub(crate) fn mark_output_ready(&self, session_id: &str) -> Result<(), String> {
        let guard = self
            .registry
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        let managed = guard
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("session {session_id} not found"))?;
        managed.output_ready.store(true, AtomicOrdering::Relaxed);
        managed.wake_for_output_state_change();
        Ok(())
    }

    pub(crate) fn set_output_paused(&self, session_id: &str, paused: bool) -> Result<(), String> {
        let guard = self
            .registry
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        let managed = guard
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("session {session_id} not found"))?;
        managed.output_paused.store(paused, AtomicOrdering::Relaxed);
        managed.wake_for_output_state_change();
        Ok(())
    }

    pub(crate) fn remove(&self, session_id: &str) -> Result<(), String> {
        let mut guard = self
            .registry
            .lock()
            .map_err(|_| "session registry poisoned".to_string())?;
        if let Some(lease) = guard.terminal_leases.get_mut(session_id) {
            lease
                .revoke(TerminalLeaseRevocationReason::Closed)
                .map_err(|error| error.to_string())?;
        }
        guard.sessions.remove(session_id);
        Ok(())
    }

    #[allow(dead_code)]
    pub(crate) fn terminal_lease_snapshot(
        &self,
        session_id: &str,
    ) -> Result<TerminalLeaseSnapshot, TerminalLeaseError> {
        let guard = self
            .registry
            .lock()
            .map_err(|_| TerminalLeaseError::RegistryPoisoned)?;
        guard
            .terminal_leases
            .get(session_id)
            .map(TerminalLease::snapshot)
            .ok_or_else(|| TerminalLeaseError::LeaseNotFound {
                session_id: session_id.to_string(),
            })
    }

    #[allow(dead_code)]
    pub(crate) fn grant_agent_terminal_control(
        &self,
        binding: &AgentTerminalBinding,
    ) -> Result<TerminalLeaseToken, TerminalLeaseError> {
        let mut guard = self
            .registry
            .lock()
            .map_err(|_| TerminalLeaseError::RegistryPoisoned)?;
        require_connected_agent_session(&guard.sessions, binding)?;
        guard
            .terminal_leases
            .get_mut(&binding.session_id)
            .ok_or_else(|| TerminalLeaseError::LeaseNotFound {
                session_id: binding.session_id.clone(),
            })?
            .grant_agent_control(binding)
    }

    #[allow(dead_code)]
    pub(crate) fn pause_agent_run(
        &self,
        run_id: &str,
    ) -> Result<Vec<TerminalLeaseSnapshot>, TerminalLeaseError> {
        self.revoke_run_agent_terminals(run_id, TerminalLeaseRevocationReason::Paused)
    }

    #[allow(dead_code)]
    pub(crate) fn stop_agent_run(
        &self,
        run_id: &str,
    ) -> Result<Vec<TerminalLeaseSnapshot>, TerminalLeaseError> {
        self.revoke_run_agent_terminals(run_id, TerminalLeaseRevocationReason::Stopped)
    }

    fn revoke_run_agent_terminals(
        &self,
        run_id: &str,
        reason: TerminalLeaseRevocationReason,
    ) -> Result<Vec<TerminalLeaseSnapshot>, TerminalLeaseError> {
        let mut guard = self
            .registry
            .lock()
            .map_err(|_| TerminalLeaseError::RegistryPoisoned)?;
        let mut snapshots = Vec::new();
        for lease in guard.terminal_leases.values_mut() {
            if lease.snapshot().binding.run_id == run_id {
                lease.revoke(reason)?;
                snapshots.push(lease.snapshot());
            }
        }
        Ok(snapshots)
    }

    /// A reconnect notification never grants control. If the corresponding
    /// disconnect was missed, this method revokes an active lease defensively.
    #[allow(dead_code)]
    pub(crate) fn mark_agent_session_reconnected(
        &self,
        session_id: &str,
    ) -> Result<TerminalLeaseSnapshot, TerminalLeaseError> {
        let mut guard = self
            .registry
            .lock()
            .map_err(|_| TerminalLeaseError::RegistryPoisoned)?;
        let lease = guard.terminal_leases.get_mut(session_id).ok_or_else(|| {
            TerminalLeaseError::LeaseNotFound {
                session_id: session_id.to_string(),
            }
        })?;
        if lease.snapshot().state == TerminalLeaseState::Active {
            lease.revoke(TerminalLeaseRevocationReason::Disconnected)?;
        }
        Ok(lease.snapshot())
    }

    pub(crate) fn revoke_agent_terminals_for_application_exit(
        &self,
    ) -> Result<Vec<TerminalLeaseSnapshot>, TerminalLeaseError> {
        let mut guard = self
            .registry
            .lock()
            .map_err(|_| TerminalLeaseError::RegistryPoisoned)?;
        let mut snapshots = Vec::with_capacity(guard.terminal_leases.len());
        for lease in guard.terminal_leases.values_mut() {
            lease.revoke(TerminalLeaseRevocationReason::ApplicationExit)?;
            snapshots.push(lease.snapshot());
        }
        Ok(snapshots)
    }
}

enum TerminalInput<'a> {
    OrdinaryUser {
        session_id: &'a str,
        data: String,
    },
    Agent {
        binding: &'a AgentTerminalBinding,
        token: TerminalLeaseToken,
        data: String,
    },
    TakeoverUser {
        binding: &'a AgentTerminalBinding,
        data: String,
    },
}

fn require_connected_agent_session<'a>(
    sessions: &'a HashMap<String, ManagedSession>,
    binding: &AgentTerminalBinding,
) -> Result<&'a ManagedSession, TerminalLeaseError> {
    let managed =
        sessions
            .get(&binding.session_id)
            .ok_or_else(|| TerminalLeaseError::SessionNotFound {
                session_id: binding.session_id.clone(),
            })?;
    if managed.kind != SessionKind::AgentPty {
        return Err(TerminalLeaseError::NotAgentPty {
            session_id: binding.session_id.clone(),
        });
    }
    if managed.status.status != SessionStatus::Connected {
        return Err(TerminalLeaseError::SessionNotConnected {
            session_id: binding.session_id.clone(),
        });
    }
    Ok(managed)
}

fn enqueue_session_command(
    managed: &ManagedSession,
    command: SessionCommand,
    session_id: &str,
) -> Result<(), TerminalLeaseError> {
    managed
        .sender
        .send(command)
        .map_err(|_| TerminalLeaseError::TransportUnavailable {
            session_id: session_id.to_string(),
        })?;
    if let Some(waker) = managed.waker.as_ref() {
        waker.wake();
    }
    Ok(())
}

impl ManagedSession {
    fn wake_for_output_state_change(&self) {
        if let Some(sender) = self.output_state_sender.as_ref() {
            // The flag itself is authoritative. A full queue already contains
            // a wakeup, so coalescing this notification cannot lose state.
            let _ = sender.try_send(());
        } else if let Some(waker) = self.waker.as_ref() {
            waker.wake();
        }
    }
}

#[cfg(test)]
mod session_manager_tests {
    use super::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionManager, SessionStatus,
        StatusEvent,
    };
    use crate::terminal_lease::{
        AgentTerminalBinding, SessionKind, TerminalLeaseError, TerminalLeaseOwner,
        TerminalLeaseRevocationReason, TerminalLeaseSnapshot, TerminalLeaseState,
    };
    use crossbeam_channel::{bounded, unbounded, Receiver, Sender as EventSender};
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
    use std::sync::{Arc, Barrier};
    use std::thread;

    fn managed_session(sender: EventSender<SessionCommand>) -> ManagedSession {
        ManagedSession {
            kind: SessionKind::UserTerminal,
            sender: SessionCommandSender::Event(sender),
            waker: None,
            output_state_sender: None,
            status: StatusEvent {
                session_id: "local-1".to_string(),
                status: SessionStatus::Connecting,
                message: None,
            },
            output_ready: Arc::new(AtomicBool::new(false)),
            output_paused: Arc::new(AtomicBool::new(false)),
        }
    }

    fn connected_managed_session(sender: EventSender<SessionCommand>) -> ManagedSession {
        let mut managed = managed_session(sender);
        managed.status = StatusEvent {
            session_id: "agent-session-1".to_string(),
            status: SessionStatus::Connected,
            message: Some("ready".to_string()),
        };
        managed
    }

    fn register_agent_session(
        manager: &SessionManager,
    ) -> (
        AgentTerminalBinding,
        TerminalLeaseSnapshot,
        Receiver<SessionCommand>,
    ) {
        let (sender, receiver) = unbounded();
        let binding = AgentTerminalBinding {
            run_id: "run-1".to_string(),
            session_id: "agent-session-1".to_string(),
        };
        let snapshot = manager
            .insert_agent_pty(
                binding.session_id.clone(),
                binding.run_id.clone(),
                connected_managed_session(sender),
            )
            .unwrap();
        (binding, snapshot, receiver)
    }

    fn written_data(receiver: &Receiver<SessionCommand>) -> Vec<String> {
        receiver
            .try_iter()
            .filter_map(|command| match command {
                SessionCommand::Write(data) => Some(data),
                SessionCommand::Resize { .. } | SessionCommand::Close => None,
            })
            .collect()
    }

    #[test]
    fn stores_and_updates_latest_session_status() {
        let manager = SessionManager::default();
        let (sender, _receiver) = unbounded::<SessionCommand>();
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
        let (sender, _receiver) = unbounded::<SessionCommand>();
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
        let (sender, _receiver) = unbounded::<SessionCommand>();
        let managed = managed_session(sender);
        let flag = managed.output_paused.clone();
        manager.insert("local-1".to_string(), managed).unwrap();

        manager.set_output_paused("local-1", true).unwrap();
        assert!(flag.load(AtomicOrdering::Relaxed));
        manager.set_output_paused("local-1", false).unwrap();
        assert!(!flag.load(AtomicOrdering::Relaxed));
        assert!(manager.set_output_paused("missing", true).is_err());
    }

    #[test]
    fn local_output_state_changes_coalesce_into_a_bounded_wakeup() {
        let manager = SessionManager::default();
        let (sender, _receiver) = unbounded::<SessionCommand>();
        let (state_sender, state_receiver) = bounded(1);
        let mut managed = managed_session(sender);
        managed.output_state_sender = Some(state_sender);
        manager.insert("local-1".to_string(), managed).unwrap();

        manager.mark_output_ready("local-1").unwrap();
        manager.set_output_paused("local-1", true).unwrap();
        manager.set_output_paused("local-1", false).unwrap();

        assert_eq!(state_receiver.len(), 1);
        state_receiver.recv().unwrap();
        assert!(state_receiver.try_recv().is_err());
    }

    #[test]
    fn ordinary_user_terminal_input_behavior_is_unchanged() {
        let manager = SessionManager::default();
        let (sender, receiver) = unbounded();
        manager
            .insert("local-1".to_string(), connected_managed_session(sender))
            .unwrap();

        manager
            .write_user_session("local-1", "echo user\n".to_string())
            .unwrap();

        assert_eq!(written_data(&receiver), vec!["echo user\n"]);
        assert_eq!(
            manager.session_kind("local-1").unwrap(),
            SessionKind::UserTerminal
        );
    }

    #[test]
    fn ordinary_write_session_path_cannot_write_a_dedicated_agent_pty() {
        let manager = SessionManager::default();
        let (binding, _, receiver) = register_agent_session(&manager);

        let error = manager
            .write_user_session(&binding.session_id, "bypass\n".to_string())
            .unwrap_err();

        assert!(error.contains("ordinary write_session input is forbidden"));
        assert!(written_data(&receiver).is_empty());
        assert_eq!(
            manager.session_kind(&binding.session_id).unwrap(),
            SessionKind::AgentPty
        );
    }

    #[test]
    fn agent_epoch_and_revision_reject_duplicate_late_and_post_takeover_writes() {
        let manager = SessionManager::default();
        let (binding, initial, receiver) = register_agent_session(&manager);

        let after_first = manager
            .write_agent_input(&binding, initial.token(), "agent-one\n".to_string())
            .unwrap();
        assert_eq!(after_first.epoch, initial.epoch);
        assert!(after_first.revision > initial.revision);

        let duplicate = manager
            .write_agent_input(&binding, initial.token(), "duplicate\n".to_string())
            .unwrap_err();
        assert!(matches!(
            duplicate,
            TerminalLeaseError::StaleRevision { .. }
        ));

        let after_second = manager
            .write_agent_input(&binding, after_first.token(), "agent-two\n".to_string())
            .unwrap();
        let after_takeover = manager
            .take_over_agent_pty_and_write(&binding, "user-first\n".to_string())
            .unwrap();
        assert_eq!(after_takeover.owner, TerminalLeaseOwner::User);
        assert!(after_takeover.epoch > after_second.epoch);

        let late = manager
            .write_agent_input(&binding, after_second.token(), "late-agent\n".to_string())
            .unwrap_err();
        assert!(matches!(late, TerminalLeaseError::StaleEpoch { .. }));
        assert_eq!(
            written_data(&receiver),
            vec!["agent-one\n", "agent-two\n", "user-first\n"]
        );
    }

    #[test]
    fn run_and_session_binding_is_checked_on_every_agent_input() {
        let manager = SessionManager::default();
        let (binding, initial, receiver) = register_agent_session(&manager);
        let wrong_run = AgentTerminalBinding {
            run_id: "run-other".to_string(),
            session_id: binding.session_id.clone(),
        };

        assert_eq!(
            manager
                .write_agent_input(&wrong_run, initial.token(), "wrong\n".to_string())
                .unwrap_err(),
            TerminalLeaseError::BindingMismatch
        );
        assert!(written_data(&receiver).is_empty());
    }

    #[test]
    fn takeover_race_serializes_whole_inputs_and_fences_the_old_epoch() {
        for _ in 0..64 {
            let manager = Arc::new(SessionManager::default());
            let (binding, initial, receiver) = register_agent_session(&manager);
            let initial_token = initial.token();
            let barrier = Arc::new(Barrier::new(3));

            let agent_manager = Arc::clone(&manager);
            let agent_binding = binding.clone();
            let agent_barrier = Arc::clone(&barrier);
            let agent = thread::spawn(move || {
                agent_barrier.wait();
                agent_manager.write_agent_input(
                    &agent_binding,
                    initial_token,
                    "AGENT-COMPLETE\n".to_string(),
                )
            });

            let user_manager = Arc::clone(&manager);
            let user_binding = binding.clone();
            let user_barrier = Arc::clone(&barrier);
            let user = thread::spawn(move || {
                user_barrier.wait();
                user_manager
                    .take_over_agent_pty_and_write(&user_binding, "USER-COMPLETE\n".to_string())
            });

            barrier.wait();
            let agent_result = agent.join().unwrap();
            let user_result = user.join().unwrap().unwrap();
            assert_eq!(user_result.owner, TerminalLeaseOwner::User);
            let writes = written_data(&receiver);
            if agent_result.is_ok() {
                assert_eq!(writes, vec!["AGENT-COMPLETE\n", "USER-COMPLETE\n"]);
            } else {
                assert!(matches!(
                    agent_result.unwrap_err(),
                    TerminalLeaseError::StaleEpoch { .. }
                        | TerminalLeaseError::OwnerMismatch { .. }
                ));
                assert_eq!(writes, vec!["USER-COMPLETE\n"]);
            }
            assert!(matches!(
                manager
                    .write_agent_input(&binding, initial_token, "AFTER-TAKEOVER\n".to_string())
                    .unwrap_err(),
                TerminalLeaseError::StaleEpoch { .. }
            ));
        }
    }

    #[test]
    fn pause_stop_and_explicit_regrant_have_fail_closed_semantics() {
        let manager = SessionManager::default();
        let (binding, initial, receiver) = register_agent_session(&manager);

        let paused = manager.pause_agent_run(&binding.run_id).unwrap();
        assert_eq!(paused.len(), 1);
        assert_eq!(paused[0].state, TerminalLeaseState::Revoked);
        assert_eq!(
            paused[0].revocation_reason,
            Some(TerminalLeaseRevocationReason::Paused)
        );
        assert!(manager
            .write_agent_input(&binding, initial.token(), "paused\n".to_string())
            .is_err());

        let resumed_token = manager.grant_agent_terminal_control(&binding).unwrap();
        manager
            .write_agent_input(&binding, resumed_token, "explicit-resume\n".to_string())
            .unwrap();
        let stopped = manager.stop_agent_run(&binding.run_id).unwrap();
        assert_eq!(
            stopped[0].revocation_reason,
            Some(TerminalLeaseRevocationReason::Stopped)
        );
        assert_eq!(written_data(&receiver), vec!["explicit-resume\n"]);
    }

    #[test]
    fn disconnect_and_reconnect_do_not_restore_agent_control() {
        let manager = SessionManager::default();
        let (binding, initial, receiver) = register_agent_session(&manager);

        manager
            .set_status(
                &binding.session_id,
                StatusEvent {
                    session_id: binding.session_id.clone(),
                    status: SessionStatus::Disconnected,
                    message: Some("network lost".to_string()),
                },
            )
            .unwrap();
        let disconnected = manager
            .terminal_lease_snapshot(&binding.session_id)
            .unwrap();
        assert_eq!(
            disconnected.revocation_reason,
            Some(TerminalLeaseRevocationReason::Disconnected)
        );

        manager
            .set_status(
                &binding.session_id,
                StatusEvent {
                    session_id: binding.session_id.clone(),
                    status: SessionStatus::Connected,
                    message: Some("transport reconnected".to_string()),
                },
            )
            .unwrap();
        let reconnected = manager
            .mark_agent_session_reconnected(&binding.session_id)
            .unwrap();
        assert_eq!(reconnected, disconnected);
        assert!(manager
            .write_agent_input(&binding, initial.token(), "must-not-resume\n".to_string())
            .is_err());
        assert!(written_data(&receiver).is_empty());
    }

    #[test]
    fn close_and_application_exit_revoke_leases_and_keep_tombstones() {
        let manager = SessionManager::default();
        let (binding, initial, receiver) = register_agent_session(&manager);

        let exit_snapshots = manager
            .revoke_agent_terminals_for_application_exit()
            .unwrap();
        assert_eq!(exit_snapshots.len(), 1);
        assert_eq!(
            exit_snapshots[0].revocation_reason,
            Some(TerminalLeaseRevocationReason::ApplicationExit)
        );
        assert!(manager
            .write_agent_input(&binding, initial.token(), "after-exit\n".to_string())
            .is_err());

        manager.close(&binding.session_id).unwrap();
        assert!(matches!(receiver.recv().unwrap(), SessionCommand::Close));
        let closed = manager
            .terminal_lease_snapshot(&binding.session_id)
            .unwrap();
        assert_eq!(closed.owner, TerminalLeaseOwner::Unowned);
        assert_eq!(
            closed.revocation_reason,
            Some(TerminalLeaseRevocationReason::Closed)
        );
        assert!(manager.status(&binding.session_id).is_err());
    }

    #[test]
    fn unavailable_input_transport_revokes_the_agent_lease() {
        let manager = SessionManager::default();
        let (binding, initial, receiver) = register_agent_session(&manager);
        drop(receiver);

        assert!(matches!(
            manager
                .write_agent_input(&binding, initial.token(), "lost\n".to_string())
                .unwrap_err(),
            TerminalLeaseError::TransportUnavailable { .. }
        ));
        let revoked = manager
            .terminal_lease_snapshot(&binding.session_id)
            .unwrap();
        assert_eq!(revoked.state, TerminalLeaseState::Revoked);
        assert_eq!(
            revoked.revocation_reason,
            Some(TerminalLeaseRevocationReason::TransportUnavailable)
        );
    }

    #[test]
    fn ordinary_terminal_resize_and_close_behavior_is_unchanged() {
        let manager = SessionManager::default();
        let (sender, receiver) = unbounded();
        manager
            .insert("local-1".to_string(), connected_managed_session(sender))
            .unwrap();

        manager.resize("local-1", 120, 40).unwrap();
        manager.close("local-1").unwrap();

        assert!(matches!(
            receiver.recv().unwrap(),
            SessionCommand::Resize {
                cols: 120,
                rows: 40
            }
        ));
        assert!(matches!(receiver.recv().unwrap(), SessionCommand::Close));
        assert!(manager.status("local-1").is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::{
        crossed_progress_total, should_emit_progress, AuthMethod, CancellationRegistry,
        JumpHostConfig, ProgressEmitState, RemoteConnectionRequest,
        RemoteFileReadCancellationRegistry, PROGRESS_EMIT_INTERVAL,
        REMOTE_FILE_READ_CANCELLATION_TOMBSTONE_LIMIT,
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
    fn remote_file_read_cancel_before_register_is_observed() {
        let registry = RemoteFileReadCancellationRegistry::default();

        registry.cancel("preview-1").unwrap();
        registry.cancel("preview-1").unwrap();
        let flag = registry.register("preview-1".to_string()).unwrap();

        assert!(flag.load(AtomicOrdering::SeqCst));
    }

    #[test]
    fn completed_remote_file_read_cancel_is_idempotent_and_does_not_poison_reuse() {
        let registry = RemoteFileReadCancellationRegistry::default();
        let first = registry.register("open-1".to_string()).unwrap();
        registry.remove("open-1", &first).unwrap();

        registry.cancel("open-1").unwrap();
        registry.cancel("open-1").unwrap();
        assert!(!first.load(AtomicOrdering::SeqCst));

        let reused = registry.register("open-1".to_string()).unwrap();
        assert!(!reused.load(AtomicOrdering::SeqCst));
        registry.cancel("open-1").unwrap();
        assert!(reused.load(AtomicOrdering::SeqCst));
    }

    #[test]
    fn stale_remote_file_read_completion_does_not_remove_new_registration() {
        let registry = RemoteFileReadCancellationRegistry::default();
        let first = registry.register("preview-duplicate".to_string()).unwrap();
        let second = registry.register("preview-duplicate".to_string()).unwrap();

        assert!(first.load(AtomicOrdering::SeqCst));
        registry.remove("preview-duplicate", &first).unwrap();
        registry.cancel("preview-duplicate").unwrap();

        assert!(second.load(AtomicOrdering::SeqCst));
    }

    #[test]
    fn remote_file_read_pending_cancellations_are_bounded() {
        let registry = RemoteFileReadCancellationRegistry::default();
        for index in 0..=REMOTE_FILE_READ_CANCELLATION_TOMBSTONE_LIMIT {
            registry.cancel(&format!("preview-{index}")).unwrap();
        }

        let state = registry.state.lock().unwrap();
        assert!(state.tombstones.len() <= REMOTE_FILE_READ_CANCELLATION_TOMBSTONE_LIMIT);
        assert!(state.tombstone_order.len() <= REMOTE_FILE_READ_CANCELLATION_TOMBSTONE_LIMIT);
    }

    #[test]
    fn progress_emit_coalesces_a_burst_until_the_interval_reopens() {
        let state = ProgressEmitState::default();
        let started_at = Instant::now();
        let mut emitted = 0;

        for _ in 0..1_000 {
            state.mark_dirty();
            if state.should_emit_at(started_at, false) {
                state.mark_emitted_at(started_at);
                emitted += 1;
            }
        }
        assert_eq!(emitted, 1, "one interval emitted more than one snapshot");

        state.mark_dirty();
        assert!(!state.should_emit_at(
            started_at + PROGRESS_EMIT_INTERVAL - Duration::from_nanos(1),
            false,
        ));
        let next_interval = started_at + PROGRESS_EMIT_INTERVAL;
        if state.should_emit_at(next_interval, false) {
            state.mark_emitted_at(next_interval);
            emitted += 1;
        }
        assert_eq!(emitted, 2);
    }

    #[test]
    fn progress_completion_forces_only_the_first_total_crossing() {
        let total = 100;
        let mut previous = 0;
        let mut forced = 0;

        for current in [40, 100, 140, u64::MAX] {
            forced += u32::from(crossed_progress_total(previous, current, total));
            previous = current;
        }

        assert_eq!(forced, 1);
        assert!(!crossed_progress_total(0, 0, 0));
    }

    #[test]
    fn progress_emit_force_flushes_inside_interval() {
        let state = ProgressEmitState::default();
        let started_at = Instant::now();
        state.mark_dirty();
        assert!(should_emit_progress(None, started_at, false));
        assert!(state.should_emit_at(started_at, false));
        state.mark_emitted_at(started_at);

        state.mark_dirty();
        let inside_interval = started_at + Duration::from_millis(1);
        assert!(!state.should_emit_at(inside_interval, false));
        assert!(state.needs_flush());
        assert!(state.should_emit_at(inside_interval, true));

        state.mark_emitted_at(inside_interval);
        assert!(!state.needs_flush());
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
