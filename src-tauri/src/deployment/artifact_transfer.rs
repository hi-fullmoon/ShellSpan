//! Fixed-purpose transfer of a verified deployment artifact into remote staging.
//!
//! The caller supplies only frozen identities. Local paths are resolved from the
//! Phase 3 opaque artifact reference, and remote paths are derived below the
//! canonical workflow root. This module never activates a release or invokes a
//! remote shell, Docker, Compose, or Nginx.

use super::artifact::{
    inspect_deployment_artifact_source_with_handle, verify_deployment_artifact,
    VerifiedDeploymentArtifact,
};
use super::planner::{get_deployment_plan, target_identity};
use super::preflight::connection_for_profile;
use super::{
    ApprovedDeploymentAction, DeploymentFrozenSourceRevision, DeploymentRunStatus,
    DeploymentTargetIdentitySnapshot,
};
use crate::db::Database;
use crate::execution::{
    open_ssh_execution_session, CancellationHandle, ExecutionCancellationRegistry,
    ExecutionErrorCategory, ExecutionTerminalState,
};
use crate::keychain::CredentialManager;
use crate::models::RemoteConnectionRequest;
use libssh2_sys::LIBSSH2_FX_NO_SUCH_FILE;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ssh2::{ErrorCode, FileStat, FileType, OpenFlags, OpenType, RenameFlags, Sftp};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub(crate) const ARTIFACT_TRANSFER_PROGRESS_EVENT: &str = "deployment-artifact-transfer-progress";
const OPERATION_PREFIX: &str = "deployment-artifact-transfer:";
const REMOTE_STAGING_REFERENCE_PREFIX: &str = "deployment-staging-v1";
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 2 * 60 * 60 * 1_000;
const TRANSFER_CHUNK_BYTES: usize = 64 * 1024;
const MAX_CONNECT_ATTEMPTS: usize = 3;
const LOCK_FILE_NAME: &str = ".artifact-transfer.lock";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentArtifactTransferRequest {
    pub operation_id: String,
    pub plan_id: String,
    pub plan_digest: String,
    pub workflow_id: String,
    pub workflow_revision: u32,
    pub artifact_reference: String,
    pub source_revision: DeploymentFrozenSourceRevision,
    pub target: DeploymentTargetIdentitySnapshot,
    pub remote_root: String,
    pub release_id: String,
    pub release_digest_sha256: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentArtifactTransferStep {
    Revalidate,
    Lock,
    StageArchive,
    StageCompose,
    VerifyRemote,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentArtifactTransferProgress {
    pub operation_id: String,
    pub sequence: u32,
    pub step: DeploymentArtifactTransferStep,
    pub file_id: Option<String>,
    pub completed_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentArtifactTransferStatus {
    Succeeded,
    Cancelled,
    TimedOut,
    Failed,
    StateUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentArtifactTransferFailureCategory {
    InvalidRequest,
    PlanNotFound,
    PlanDigestMismatch,
    PlanExpired,
    PlanNotApproved,
    WorkflowNotFound,
    RevisionConflict,
    WorkflowDisabled,
    SourceChanged,
    TargetChanged,
    ArtifactInvalid,
    ArtifactChanged,
    ReleaseChanged,
    CredentialUnavailable,
    HostKeyRejected,
    ConnectionFailed,
    RemotePathUnsafe,
    RemoteConflict,
    RemotePartialInvalid,
    RemoteIo,
    RemoteDigestMismatch,
    Cancelled,
    TimedOut,
    StateUnknown,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentArtifactTransferFailure {
    pub category: DeploymentArtifactTransferFailureCategory,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentArtifactTransferResult {
    pub operation_id: String,
    pub plan_id: String,
    pub release_id: String,
    pub remote_staging_identity: Option<String>,
    pub transferred_bytes: u64,
    pub remote_digest_sha256: Option<String>,
    pub status: DeploymentArtifactTransferStatus,
    pub failure: Option<DeploymentArtifactTransferFailure>,
    pub reused: bool,
    pub resumed: bool,
}

#[derive(Debug, Clone)]
struct TransferFailure {
    category: DeploymentArtifactTransferFailureCategory,
    message: String,
    retryable: bool,
    ambiguous: bool,
}

impl TransferFailure {
    fn definite(
        category: DeploymentArtifactTransferFailureCategory,
        message: impl Into<String>,
    ) -> Self {
        Self {
            category,
            message: message.into(),
            retryable: false,
            ambiguous: false,
        }
    }

    fn transport(message: impl Into<String>) -> Self {
        Self {
            category: DeploymentArtifactTransferFailureCategory::RemoteIo,
            message: message.into(),
            retryable: true,
            ambiguous: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RemoteEntry {
    kind: RemoteEntryKind,
    bytes: u64,
}

#[derive(Debug, Clone)]
struct TransferFile {
    id: String,
    local_path: PathBuf,
    bytes: u64,
    sha256: String,
    step: DeploymentArtifactTransferStep,
}

#[derive(Debug, Clone, Copy, Default)]
struct TransferMetrics {
    transferred_bytes: u64,
    reused: bool,
    resumed: bool,
}

trait ArtifactTransferRemote {
    fn canonical_root(&mut self, requested: &str) -> Result<String, TransferFailure>;
    fn ensure_directory(&mut self, path: &str) -> Result<(), TransferFailure>;
    fn stat(&mut self, path: &str) -> Result<Option<RemoteEntry>, TransferFailure>;
    fn acquire_lock(&mut self, path: &str, owner: &str) -> Result<(), TransferFailure>;
    fn remove_file(&mut self, path: &str) -> Result<(), TransferFailure>;
    fn hash_file(&mut self, path: &str) -> Result<(u64, String), TransferFailure>;
    fn hash_prefix(&mut self, path: &str, bytes: u64) -> Result<String, TransferFailure>;
    fn upload(
        &mut self,
        local_path: &Path,
        remote_path: &str,
        offset: u64,
        progress: &mut dyn FnMut(u64) -> Result<(), TransferFailure>,
    ) -> Result<(), TransferFailure>;
    fn rename_exclusive(&mut self, partial: &str, final_path: &str) -> Result<(), TransferFailure>;
}

struct SftpArtifactTransferRemote {
    sftp: Sftp,
    _session: crate::execution::SshExecutionSession,
}

impl SftpArtifactTransferRemote {
    fn connect(
        connection: &RemoteConnectionRequest,
        known_hosts_path: &Path,
    ) -> Result<Self, TransferFailure> {
        let session =
            open_ssh_execution_session(connection, known_hosts_path).map_err(|error| {
                let category = match error.category {
                    ExecutionErrorCategory::HostKeyRejected => {
                        DeploymentArtifactTransferFailureCategory::HostKeyRejected
                    }
                    _ => DeploymentArtifactTransferFailureCategory::ConnectionFailed,
                };
                let mut failure = TransferFailure::definite(category, error.message);
                failure.retryable =
                    category == DeploymentArtifactTransferFailureCategory::ConnectionFailed;
                failure
            })?;
        let sftp = session.target.sftp().map_err(|error| TransferFailure {
            category: DeploymentArtifactTransferFailureCategory::ConnectionFailed,
            message: format!("failed to initialize reviewed SFTP: {error}"),
            retryable: true,
            ambiguous: false,
        })?;
        Ok(Self {
            sftp,
            _session: session,
        })
    }

    fn error(message: impl Into<String>) -> TransferFailure {
        TransferFailure::transport(message)
    }

    fn missing(error: &ssh2::Error) -> bool {
        error.code() == ErrorCode::SFTP(LIBSSH2_FX_NO_SUCH_FILE)
    }

    fn entry(stat: FileStat) -> RemoteEntry {
        let kind = match stat.file_type() {
            FileType::RegularFile => RemoteEntryKind::File,
            FileType::Directory => RemoteEntryKind::Directory,
            FileType::Symlink => RemoteEntryKind::Symlink,
            _ => RemoteEntryKind::Other,
        };
        RemoteEntry {
            kind,
            bytes: stat.size.unwrap_or(0),
        }
    }

    fn read_small(&self, path: &str, max_bytes: usize) -> Result<Vec<u8>, TransferFailure> {
        let file = self
            .sftp
            .open(Path::new(path))
            .map_err(|error| Self::error(format!("failed to open remote lock: {error}")))?;
        let mut bytes = Vec::new();
        file.take((max_bytes + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| Self::error(format!("failed to read remote lock: {error}")))?;
        if bytes.len() > max_bytes {
            return Err(TransferFailure::definite(
                DeploymentArtifactTransferFailureCategory::RemoteConflict,
                "remote transfer lock is invalid",
            ));
        }
        Ok(bytes)
    }

    fn verify_directory_identity(&self, path: &str) -> Result<(), TransferFailure> {
        let canonical = self.sftp.realpath(Path::new(path)).map_err(|error| {
            Self::error(format!(
                "failed to canonicalize remote staging directory: {error}"
            ))
        })?;
        if canonical.to_str() != Some(path) {
            return Err(TransferFailure::definite(
                DeploymentArtifactTransferFailureCategory::RemotePathUnsafe,
                "remote staging directory resolves outside its canonical identity",
            ));
        }
        Ok(())
    }
}

impl ArtifactTransferRemote for SftpArtifactTransferRemote {
    fn canonical_root(&mut self, requested: &str) -> Result<String, TransferFailure> {
        let canonical = self
            .sftp
            .realpath(Path::new(requested))
            .map_err(|error| Self::error(format!("failed to canonicalize remote root: {error}")))?;
        let canonical = canonical.to_str().ok_or_else(|| {
            TransferFailure::definite(
                DeploymentArtifactTransferFailureCategory::RemotePathUnsafe,
                "canonical remote root is not valid UTF-8",
            )
        })?;
        validate_canonical_remote_root(canonical)?;
        let stat = self
            .sftp
            .lstat(Path::new(canonical))
            .map_err(|error| Self::error(format!("failed to inspect remote root: {error}")))?;
        if stat.file_type() != FileType::Directory {
            return Err(TransferFailure::definite(
                DeploymentArtifactTransferFailureCategory::RemotePathUnsafe,
                "canonical remote root is not a directory",
            ));
        }
        Ok(canonical.to_string())
    }

    fn ensure_directory(&mut self, path: &str) -> Result<(), TransferFailure> {
        match self.sftp.lstat(Path::new(path)) {
            Ok(stat) if stat.file_type() == FileType::Directory => {
                self.verify_directory_identity(path)
            }
            Ok(_) => Err(TransferFailure::definite(
                DeploymentArtifactTransferFailureCategory::RemotePathUnsafe,
                "remote staging component is not a directory",
            )),
            Err(error) if Self::missing(&error) => {
                self.sftp.mkdir(Path::new(path), 0o700).map_err(|error| {
                    Self::error(format!(
                        "failed to create remote staging directory: {error}"
                    ))
                })?;
                let stat = self.sftp.lstat(Path::new(path)).map_err(|error| {
                    Self::error(format!(
                        "failed to verify remote staging directory: {error}"
                    ))
                })?;
                if stat.file_type() != FileType::Directory {
                    return Err(TransferFailure::definite(
                        DeploymentArtifactTransferFailureCategory::RemotePathUnsafe,
                        "created remote staging component is not a directory",
                    ));
                }
                self.verify_directory_identity(path)
            }
            Err(error) => Err(Self::error(format!(
                "failed to inspect remote staging directory: {error}"
            ))),
        }
    }

    fn stat(&mut self, path: &str) -> Result<Option<RemoteEntry>, TransferFailure> {
        match self.sftp.lstat(Path::new(path)) {
            Ok(stat) => Ok(Some(Self::entry(stat))),
            Err(error) if Self::missing(&error) => Ok(None),
            Err(error) => Err(Self::error(format!(
                "failed to inspect remote staging file: {error}"
            ))),
        }
    }

    fn acquire_lock(&mut self, path: &str, owner: &str) -> Result<(), TransferFailure> {
        match self.sftp.open_mode(
            Path::new(path),
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUSIVE,
            0o600,
            OpenType::File,
        ) {
            Ok(mut file) => {
                file.write_all(owner.as_bytes()).map_err(|error| {
                    Self::error(format!("failed to write remote transfer lock: {error}"))
                })?;
                file.fsync().map_err(|error| {
                    Self::error(format!("failed to sync remote transfer lock: {error}"))
                })?;
                file.close().map_err(|error| {
                    Self::error(format!("failed to close remote transfer lock: {error}"))
                })
            }
            Err(_) => {
                let stat = self.stat(path)?.ok_or_else(|| {
                    Self::error("remote transfer lock disappeared during acquisition")
                })?;
                if stat.kind == RemoteEntryKind::Symlink {
                    return Err(TransferFailure::definite(
                        DeploymentArtifactTransferFailureCategory::RemotePathUnsafe,
                        "remote transfer lock is a symbolic link",
                    ));
                }
                if stat.kind != RemoteEntryKind::File || stat.bytes > 512 {
                    return Err(TransferFailure::definite(
                        DeploymentArtifactTransferFailureCategory::RemoteConflict,
                        "remote transfer lock is owned by another operation",
                    ));
                }
                if self.read_small(path, 512)? == owner.as_bytes() {
                    Ok(())
                } else {
                    Err(TransferFailure::definite(
                        DeploymentArtifactTransferFailureCategory::RemoteConflict,
                        "remote transfer lock is owned by another operation",
                    ))
                }
            }
        }
    }

    fn remove_file(&mut self, path: &str) -> Result<(), TransferFailure> {
        match self.sftp.unlink(Path::new(path)) {
            Ok(()) => Ok(()),
            Err(error) if Self::missing(&error) => Ok(()),
            Err(error) => Err(Self::error(format!(
                "failed to remove owned remote file: {error}"
            ))),
        }
    }

    fn hash_file(&mut self, path: &str) -> Result<(u64, String), TransferFailure> {
        let mut file = self
            .sftp
            .open(Path::new(path))
            .map_err(|error| Self::error(format!("failed to open remote staging file: {error}")))?;
        let mut digest = Sha256::new();
        let mut total = 0_u64;
        let mut buffer = [0_u8; TRANSFER_CHUNK_BYTES];
        loop {
            let count = file.read(&mut buffer).map_err(|error| {
                Self::error(format!("failed to stream remote staging file: {error}"))
            })?;
            if count == 0 {
                break;
            }
            total = total.checked_add(count as u64).ok_or_else(|| {
                TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::RemoteIo,
                    "remote staging byte count overflow",
                )
            })?;
            digest.update(&buffer[..count]);
        }
        Ok((total, hex_digest(digest.finalize())))
    }

    fn hash_prefix(&mut self, path: &str, bytes: u64) -> Result<String, TransferFailure> {
        let mut file = self
            .sftp
            .open(Path::new(path))
            .map_err(|error| Self::error(format!("failed to open remote partial: {error}")))?;
        hash_reader_prefix(&mut file, bytes).map_err(|error| {
            Self::error(format!("failed to verify remote partial prefix: {error}"))
        })
    }

    fn upload(
        &mut self,
        local_path: &Path,
        remote_path: &str,
        offset: u64,
        progress: &mut dyn FnMut(u64) -> Result<(), TransferFailure>,
    ) -> Result<(), TransferFailure> {
        let mut local = File::open(local_path).map_err(|_| {
            TransferFailure::definite(
                DeploymentArtifactTransferFailureCategory::ArtifactChanged,
                "verified local artifact file is unavailable",
            )
        })?;
        local.seek(SeekFrom::Start(offset)).map_err(|_| {
            TransferFailure::definite(
                DeploymentArtifactTransferFailureCategory::ArtifactChanged,
                "verified local artifact file could not be resumed",
            )
        })?;
        let flags = if offset == 0 {
            OpenFlags::WRITE | OpenFlags::TRUNCATE
        } else {
            OpenFlags::WRITE | OpenFlags::CREATE
        };
        let mut remote = self
            .sftp
            .open_mode(Path::new(remote_path), flags, 0o600, OpenType::File)
            .map_err(|error| Self::error(format!("failed to open remote partial: {error}")))?;
        if offset > 0 {
            remote
                .seek(SeekFrom::Start(offset))
                .map_err(|error| Self::error(format!("failed to seek remote partial: {error}")))?;
        }
        let mut buffer = [0_u8; TRANSFER_CHUNK_BYTES];
        loop {
            let count = local.read(&mut buffer).map_err(|_| {
                TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::ArtifactChanged,
                    "verified local artifact changed during transfer",
                )
            })?;
            if count == 0 {
                break;
            }
            remote
                .write_all(&buffer[..count])
                .map_err(|error| Self::error(format!("failed to write remote partial: {error}")))?;
            progress(count as u64)?;
        }
        remote
            .fsync()
            .map_err(|error| Self::error(format!("failed to sync remote partial: {error}")))?;
        remote
            .close()
            .map_err(|error| Self::error(format!("failed to close remote partial: {error}")))
    }

    fn rename_exclusive(&mut self, partial: &str, final_path: &str) -> Result<(), TransferFailure> {
        if self.stat(final_path)?.is_some() {
            return Err(TransferFailure::definite(
                DeploymentArtifactTransferFailureCategory::RemoteConflict,
                "remote final staging file already exists",
            ));
        }
        self.sftp
            .rename(
                Path::new(partial),
                Path::new(final_path),
                Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
            )
            .map_err(|error| {
                Self::error(format!("failed to atomically publish remote file: {error}"))
            })
    }
}

struct ProgressEmitter<'a> {
    operation_id: &'a str,
    next_sequence: u32,
    emit: &'a mut dyn FnMut(DeploymentArtifactTransferProgress),
}

impl ProgressEmitter<'_> {
    fn send(
        &mut self,
        step: DeploymentArtifactTransferStep,
        file_id: Option<&str>,
        completed_bytes: Option<u64>,
        total_bytes: Option<u64>,
        summary: &'static str,
    ) {
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        (self.emit)(DeploymentArtifactTransferProgress {
            operation_id: self.operation_id.to_string(),
            sequence,
            step,
            file_id: file_id.map(str::to_string),
            completed_bytes,
            total_bytes,
            summary: summary.to_string(),
        });
    }
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn hash_reader_prefix(reader: &mut impl Read, bytes: u64) -> Result<String, std::io::Error> {
    let mut digest = Sha256::new();
    let mut remaining = bytes;
    let mut buffer = [0_u8; TRANSFER_CHUNK_BYTES];
    while remaining > 0 {
        let requested = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let count = reader.read(&mut buffer[..requested])?;
        if count == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "prefix ended early",
            ));
        }
        digest.update(&buffer[..count]);
        remaining -= count as u64;
    }
    Ok(hex_digest(digest.finalize()))
}

fn hash_local_prefix(path: &Path, bytes: u64) -> Result<String, TransferFailure> {
    let mut file = File::open(path).map_err(|_| {
        TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::ArtifactChanged,
            "verified local artifact file is unavailable",
        )
    })?;
    hash_reader_prefix(&mut file, bytes).map_err(|_| {
        TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::ArtifactChanged,
            "verified local artifact prefix is unavailable",
        )
    })
}

fn hash_local_file(path: &Path) -> Result<(u64, String), TransferFailure> {
    let mut file = File::open(path).map_err(|_| {
        TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::ArtifactChanged,
            "verified local artifact file is unavailable",
        )
    })?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; TRANSFER_CHUNK_BYTES];
    loop {
        let count = file.read(&mut buffer).map_err(|_| {
            TransferFailure::definite(
                DeploymentArtifactTransferFailureCategory::ArtifactChanged,
                "verified local artifact file changed during verification",
            )
        })?;
        if count == 0 {
            break;
        }
        total = total.checked_add(count as u64).ok_or_else(|| {
            TransferFailure::definite(
                DeploymentArtifactTransferFailureCategory::ArtifactChanged,
                "local artifact byte count overflow",
            )
        })?;
        digest.update(&buffer[..count]);
    }
    Ok((total, hex_digest(digest.finalize())))
}

fn validate_canonical_remote_root(root: &str) -> Result<(), TransferFailure> {
    if !root.starts_with('/')
        || root == "/"
        || root.len() > 4_096
        || root.chars().any(char::is_control)
        || root
            .split('/')
            .any(|component| matches!(component, "." | ".."))
        || root.ends_with('/')
    {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::RemotePathUnsafe,
            "canonical remote root is unsafe",
        ));
    }
    Ok(())
}

fn validate_remote_component(component: &str) -> Result<(), TransferFailure> {
    if component.is_empty()
        || matches!(component, "." | "..")
        || component.contains('/')
        || component.contains('\\')
        || component.chars().any(char::is_control)
    {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::RemotePathUnsafe,
            "remote staging component is unsafe",
        ));
    }
    Ok(())
}

fn join_remote(base: &str, component: &str) -> Result<String, TransferFailure> {
    validate_remote_component(component)?;
    Ok(format!("{base}/{component}"))
}

fn join_remote_relative(base: &str, relative: &str) -> Result<String, TransferFailure> {
    let mut path = base.to_string();
    for component in relative.split('/') {
        path = join_remote(&path, component)?;
    }
    Ok(path)
}

fn ensure_remote_parent_directories(
    remote: &mut dyn ArtifactTransferRemote,
    staging_root: &str,
    relative: &str,
) -> Result<(), TransferFailure> {
    remote.ensure_directory(staging_root)?;
    let components = relative.split('/').collect::<Vec<_>>();
    let mut path = staging_root.to_string();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        path = join_remote(&path, component)?;
        remote.ensure_directory(&path)?;
    }
    Ok(())
}

fn terminal_failure(
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> Option<TransferFailure> {
    if Instant::now() >= deadline {
        cancellation.try_timeout();
    }
    match cancellation.terminal_state() {
        ExecutionTerminalState::Cancelled => Some(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::Cancelled,
            "Deployment artifact transfer was cancelled",
        )),
        ExecutionTerminalState::TimedOut => Some(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::TimedOut,
            "Deployment artifact transfer timed out",
        )),
        ExecutionTerminalState::Finished => Some(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::Internal,
            "Deployment artifact transfer stopped unexpectedly",
        )),
        ExecutionTerminalState::Running => None,
    }
}

fn validate_request(request: &DeploymentArtifactTransferRequest) -> Result<(), TransferFailure> {
    if !request.operation_id.starts_with(OPERATION_PREFIX)
        || !crate::execution::valid_operation_id(&request.operation_id)
    {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::InvalidRequest,
            "deployment artifact transfer operation ID is invalid",
        ));
    }
    super::validate_identifier("workflow id", &request.workflow_id, 128).map_err(|error| {
        TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::InvalidRequest,
            error.to_string(),
        )
    })?;
    super::validate_identifier("release id", &request.release_id, 128).map_err(|error| {
        TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::InvalidRequest,
            error.to_string(),
        )
    })?;
    super::validate_sha256(&request.plan_digest).map_err(|error| {
        TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::InvalidRequest,
            error.to_string(),
        )
    })?;
    super::validate_sha256(&request.release_digest_sha256).map_err(|error| {
        TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::InvalidRequest,
            error.to_string(),
        )
    })?;
    super::validate_remote_root(&request.remote_root).map_err(|error| {
        TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::InvalidRequest,
            error.to_string(),
        )
    })?;
    if request.plan_id != format!("plan-{}", request.plan_digest)
        || request.workflow_revision == 0
        || !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&request.timeout_ms)
    {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::InvalidRequest,
            "deployment artifact transfer request is invalid",
        ));
    }
    Ok(())
}

fn map_plan_error(error: String) -> TransferFailure {
    let category = if error.contains("PLAN_NOT_FOUND") {
        DeploymentArtifactTransferFailureCategory::PlanNotFound
    } else if error.contains("PLAN_EXPIRED") {
        DeploymentArtifactTransferFailureCategory::PlanExpired
    } else if error.contains("PLAN_INTEGRITY") {
        DeploymentArtifactTransferFailureCategory::PlanDigestMismatch
    } else if error.contains("WORKFLOW_NOT_FOUND") {
        DeploymentArtifactTransferFailureCategory::WorkflowNotFound
    } else if error.contains("WORKFLOW_DISABLED") {
        DeploymentArtifactTransferFailureCategory::WorkflowDisabled
    } else if error.contains("REVISION_CONFLICT") {
        DeploymentArtifactTransferFailureCategory::RevisionConflict
    } else if error.contains("PLAN_INPUT_CHANGED") {
        DeploymentArtifactTransferFailureCategory::TargetChanged
    } else {
        DeploymentArtifactTransferFailureCategory::Internal
    };
    TransferFailure::definite(category, "Deployment plan failed runtime revalidation")
}

fn map_plan_error_for_request(
    database: &Database,
    request: &DeploymentArtifactTransferRequest,
    error: String,
) -> TransferFailure {
    if !error.contains("PLAN_INPUT_CHANGED") {
        return map_plan_error(error);
    }
    let workflow = match database.get_deployment_workflow(&request.workflow_id) {
        Ok(Some(workflow)) => workflow,
        Ok(None) => {
            return TransferFailure::definite(
                DeploymentArtifactTransferFailureCategory::WorkflowNotFound,
                "Deployment workflow no longer exists",
            )
        }
        Err(_) => return map_plan_error(error),
    };
    if !workflow.enabled {
        return TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::WorkflowDisabled,
            "Deployment workflow is disabled",
        );
    }
    if workflow.revision != request.workflow_revision {
        return TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::RevisionConflict,
            "Deployment workflow revision changed after planning",
        );
    }
    let profile = match database.get_profile(&workflow.connection_profile_id) {
        Ok(Some(profile)) => profile,
        _ => {
            return TransferFailure::definite(
                DeploymentArtifactTransferFailureCategory::TargetChanged,
                "Deployment target profile is unavailable",
            )
        }
    };
    if target_identity(&profile).ok().as_ref() != Some(&request.target) {
        return TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::TargetChanged,
            "Deployment target profile changed after planning",
        );
    }
    map_plan_error(error)
}

fn revalidate_frozen_inputs(
    database: &Database,
    artifact_staging_root: &Path,
    request: &DeploymentArtifactTransferRequest,
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> Result<VerifiedDeploymentArtifact, TransferFailure> {
    if let Some(failure) = terminal_failure(cancellation, deadline) {
        return Err(failure);
    }
    let plan = get_deployment_plan(database, &request.plan_id)
        .map_err(|error| map_plan_error_for_request(database, request, error))?;
    if plan.plan_digest != request.plan_digest {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::PlanDigestMismatch,
            "Deployment plan digest changed",
        ));
    }
    if plan.status != DeploymentRunStatus::Approved {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::PlanNotApproved,
            "Deployment plan is not approved for artifact transfer",
        ));
    }
    let summary = &plan.approval_summary;
    if summary.schema_version >= 2
        && summary.artifact_reference.as_deref() != Some(&request.artifact_reference)
    {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::ArtifactChanged,
            "Deployment artifact reference changed after approval",
        ));
    }
    if !summary
        .actions
        .contains(&ApprovedDeploymentAction::StageRelease)
    {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::PlanNotApproved,
            "Deployment plan does not approve release staging",
        ));
    }
    if summary.workflow_id != request.workflow_id
        || summary.workflow_revision != request.workflow_revision
    {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::RevisionConflict,
            "Deployment workflow changed after planning",
        ));
    }
    if summary.remote_root != request.remote_root || summary.frozen.target != request.target {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::TargetChanged,
            "Deployment target changed after planning",
        ));
    }
    if summary.frozen.source_revision != request.source_revision {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::SourceChanged,
            "Deployment source changed after planning",
        ));
    }
    if summary.frozen.target_release.release_id != request.release_id
        || summary.frozen.target_release.artifact_digest_sha256 != request.release_digest_sha256
    {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::ReleaseChanged,
            "Deployment release identity changed after planning",
        ));
    }
    let source = inspect_deployment_artifact_source_with_handle(
        database,
        &request.workflow_id,
        request.workflow_revision,
        cancellation,
        deadline,
    )
    .map_err(|error| {
        let category = if error.contains("WORKFLOW_NOT_FOUND") {
            DeploymentArtifactTransferFailureCategory::WorkflowNotFound
        } else if error.contains("WORKFLOW_DISABLED") {
            DeploymentArtifactTransferFailureCategory::WorkflowDisabled
        } else if error.contains("REVISION_CONFLICT") {
            DeploymentArtifactTransferFailureCategory::RevisionConflict
        } else {
            DeploymentArtifactTransferFailureCategory::SourceChanged
        };
        TransferFailure::definite(category, "Deployment source failed runtime revalidation")
    })?;
    if source != request.source_revision {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::SourceChanged,
            "Deployment source changed after planning",
        ));
    }
    let artifact = verify_deployment_artifact(artifact_staging_root, &request.artifact_reference)
        .map_err(|_| {
        TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::ArtifactInvalid,
            "Deployment artifact failed runtime integrity verification",
        )
    })?;
    if artifact.manifest.workflow_id != request.workflow_id
        || artifact.manifest.workflow_revision != request.workflow_revision
        || artifact.manifest.source_revision != request.source_revision
    {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::ArtifactChanged,
            "Deployment artifact no longer matches the frozen workflow and source",
        ));
    }
    if artifact.manifest.release_id != request.release_id
        || artifact.manifest.archive.sha256 != request.release_digest_sha256
    {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::ReleaseChanged,
            "Deployment artifact release identity changed",
        ));
    }
    Ok(artifact)
}

fn transfer_files(
    artifact: &VerifiedDeploymentArtifact,
) -> Result<Vec<TransferFile>, TransferFailure> {
    let mut files = Vec::with_capacity(artifact.manifest.compose_files.len() + 2);
    files.push(TransferFile {
        id: artifact.manifest.archive.file_name.clone(),
        local_path: artifact
            .directory()
            .join(&artifact.manifest.archive.file_name),
        bytes: artifact.manifest.archive.bytes,
        sha256: artifact.manifest.archive.sha256.clone(),
        step: DeploymentArtifactTransferStep::StageArchive,
    });
    let manifest_path = artifact.directory().join("manifest.json");
    let (manifest_bytes, manifest_sha256) = hash_local_file(&manifest_path)?;
    files.push(TransferFile {
        id: "manifest.json".to_string(),
        local_path: manifest_path,
        bytes: manifest_bytes,
        sha256: manifest_sha256,
        step: DeploymentArtifactTransferStep::StageCompose,
    });
    for compose in &artifact.manifest.compose_files {
        files.push(TransferFile {
            id: compose.file_name.clone(),
            local_path: artifact.directory().join(&compose.file_name),
            bytes: compose.bytes,
            sha256: compose.sha256.clone(),
            step: DeploymentArtifactTransferStep::StageCompose,
        });
    }
    Ok(files)
}

fn staging_paths(
    remote: &mut dyn ArtifactTransferRemote,
    requested_root: &str,
    content_identity: &str,
) -> Result<(String, String), TransferFailure> {
    validate_remote_component(content_identity)?;
    let canonical_root = remote.canonical_root(requested_root)?;
    let shellspan = join_remote(&canonical_root, ".shellspan")?;
    remote.ensure_directory(&shellspan)?;
    let staging = join_remote(&shellspan, "staging")?;
    remote.ensure_directory(&staging)?;
    let content = join_remote(&staging, content_identity)?;
    remote.ensure_directory(&content)?;
    let lock = join_remote(&content, LOCK_FILE_NAME)?;
    Ok((content, lock))
}

fn verify_existing_final(
    remote: &mut dyn ArtifactTransferRemote,
    path: &str,
    file: &TransferFile,
) -> Result<bool, TransferFailure> {
    let Some(entry) = remote.stat(path)? else {
        return Ok(false);
    };
    if entry.kind == RemoteEntryKind::Symlink {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::RemotePathUnsafe,
            "remote final staging path is a symbolic link",
        ));
    }
    if entry.kind != RemoteEntryKind::File {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::RemoteConflict,
            "remote final staging path is not a regular file",
        ));
    }
    let (bytes, digest) = remote.hash_file(path)?;
    if bytes == file.bytes && digest == file.sha256 {
        Ok(true)
    } else {
        Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::RemoteConflict,
            "remote final staging file conflicts with the verified artifact",
        ))
    }
}

fn prepare_partial(
    remote: &mut dyn ArtifactTransferRemote,
    partial: &str,
    file: &TransferFile,
) -> Result<u64, TransferFailure> {
    let Some(entry) = remote.stat(partial)? else {
        return Ok(0);
    };
    if entry.kind == RemoteEntryKind::Symlink {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::RemotePathUnsafe,
            "remote partial staging path is a symbolic link",
        ));
    }
    if entry.kind != RemoteEntryKind::File {
        return Err(TransferFailure::definite(
            DeploymentArtifactTransferFailureCategory::RemotePartialInvalid,
            "remote partial staging path is not a regular file",
        ));
    }
    if entry.bytes > file.bytes {
        remote.remove_file(partial)?;
        return Ok(0);
    }
    let local_digest = hash_local_prefix(&file.local_path, entry.bytes)?;
    let remote_digest = remote.hash_prefix(partial, entry.bytes)?;
    if local_digest != remote_digest {
        remote.remove_file(partial)?;
        return Ok(0);
    }
    Ok(entry.bytes)
}

fn transfer_once(
    remote: &mut dyn ArtifactTransferRemote,
    request: &DeploymentArtifactTransferRequest,
    content_identity: &str,
    files: &[TransferFile],
    cancellation: &CancellationHandle,
    deadline: Instant,
    progress: &mut ProgressEmitter<'_>,
    metrics: &mut TransferMetrics,
) -> Result<String, TransferFailure> {
    let (staging_root, lock_path) = staging_paths(remote, &request.remote_root, content_identity)?;
    let lock_owner = format!(
        "{}\n{}\n{}\n",
        request.operation_id, content_identity, request.plan_digest
    );
    remote.acquire_lock(&lock_path, &lock_owner)?;
    progress.send(
        DeploymentArtifactTransferStep::Lock,
        None,
        None,
        None,
        "Acquired the content-addressed remote staging lock",
    );

    let attempt = (|| {
        let mut all_reused = true;
        for file in files {
            if let Some(failure) = terminal_failure(cancellation, deadline) {
                return Err(failure);
            }
            ensure_remote_parent_directories(remote, &staging_root, &file.id)?;
            let final_path = join_remote_relative(&staging_root, &file.id)?;
            if verify_existing_final(remote, &final_path, file)? {
                progress.send(
                    file.step,
                    Some(&file.id),
                    Some(file.bytes),
                    Some(file.bytes),
                    "Reused an identical verified remote staging file",
                );
                continue;
            }
            all_reused = false;
            let partial_path = format!("{final_path}.part");
            let offset = prepare_partial(remote, &partial_path, file)?;
            metrics.resumed |= offset > 0;
            progress.send(
                file.step,
                Some(&file.id),
                Some(offset),
                Some(file.bytes),
                if offset > 0 {
                    "Resuming a verified remote partial file"
                } else {
                    "Uploading a verified artifact file into remote staging"
                },
            );
            let mut completed = offset;
            remote.upload(&file.local_path, &partial_path, offset, &mut |written| {
                if let Some(failure) = terminal_failure(cancellation, deadline) {
                    return Err(failure);
                }
                completed = completed.saturating_add(written);
                metrics.transferred_bytes = metrics.transferred_bytes.saturating_add(written);
                progress.send(
                    file.step,
                    Some(&file.id),
                    Some(completed),
                    Some(file.bytes),
                    "Streaming a verified artifact file into remote staging",
                );
                Ok(())
            })?;
            let (partial_bytes, partial_digest) = remote.hash_file(&partial_path)?;
            if partial_bytes != file.bytes || partial_digest != file.sha256 {
                remote.remove_file(&partial_path)?;
                return Err(TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::RemoteDigestMismatch,
                    "remote partial file failed SHA-256 verification",
                ));
            }
            remote.rename_exclusive(&partial_path, &final_path)?;
            let (final_bytes, final_digest) = remote.hash_file(&final_path)?;
            if final_bytes != file.bytes || final_digest != file.sha256 {
                return Err(TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::RemoteDigestMismatch,
                    "published remote staging file failed SHA-256 verification",
                ));
            }
        }
        metrics.reused = all_reused;
        progress.send(
            DeploymentArtifactTransferStep::VerifyRemote,
            None,
            Some(files.iter().map(|file| file.bytes).sum()),
            Some(files.iter().map(|file| file.bytes).sum()),
            "Verified remote staging bytes and SHA-256 digests",
        );
        Ok(())
    })();

    match attempt {
        Ok(()) => {
            remote.remove_file(&lock_path)?;
            Ok(staging_root)
        }
        Err(error) => {
            if !error.retryable {
                let _ = remote.remove_file(&lock_path);
            }
            Err(error)
        }
    }
}

fn failed_result(
    request: &DeploymentArtifactTransferRequest,
    metrics: TransferMetrics,
    failure: TransferFailure,
) -> DeploymentArtifactTransferResult {
    let status = match failure.category {
        DeploymentArtifactTransferFailureCategory::Cancelled => {
            DeploymentArtifactTransferStatus::Cancelled
        }
        DeploymentArtifactTransferFailureCategory::TimedOut => {
            DeploymentArtifactTransferStatus::TimedOut
        }
        DeploymentArtifactTransferFailureCategory::StateUnknown => {
            DeploymentArtifactTransferStatus::StateUnknown
        }
        _ if failure.ambiguous => DeploymentArtifactTransferStatus::StateUnknown,
        _ => DeploymentArtifactTransferStatus::Failed,
    };
    let category = if status == DeploymentArtifactTransferStatus::StateUnknown {
        DeploymentArtifactTransferFailureCategory::StateUnknown
    } else {
        failure.category
    };
    DeploymentArtifactTransferResult {
        operation_id: request.operation_id.clone(),
        plan_id: request.plan_id.clone(),
        release_id: request.release_id.clone(),
        remote_staging_identity: None,
        transferred_bytes: metrics.transferred_bytes,
        remote_digest_sha256: None,
        status,
        failure: Some(DeploymentArtifactTransferFailure {
            category,
            message: failure.message,
        }),
        reused: false,
        resumed: metrics.resumed,
    }
}

pub(crate) fn valid_artifact_transfer_operation_id(value: &str) -> bool {
    value.starts_with(OPERATION_PREFIX) && crate::execution::valid_operation_id(value)
}

pub(crate) fn transfer_deployment_artifact(
    database: &Database,
    credentials: &CredentialManager,
    cancellations: &ExecutionCancellationRegistry,
    known_hosts_path: &Path,
    artifact_staging_root: &Path,
    request: DeploymentArtifactTransferRequest,
    emit: &mut dyn FnMut(DeploymentArtifactTransferProgress),
) -> DeploymentArtifactTransferResult {
    let mut metrics = TransferMetrics::default();
    if let Err(failure) = validate_request(&request) {
        return failed_result(&request, metrics, failure);
    }
    let cancellation = match cancellations.register(request.operation_id.clone()) {
        Ok(handle) => handle,
        Err(error) => {
            return failed_result(
                &request,
                metrics,
                TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::InvalidRequest,
                    error.to_string(),
                ),
            )
        }
    };
    let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
    let mut progress = ProgressEmitter {
        operation_id: &request.operation_id,
        next_sequence: 1,
        emit,
    };
    progress.send(
        DeploymentArtifactTransferStep::Revalidate,
        None,
        None,
        None,
        "Revalidating the approved plan and runtime-owned artifact",
    );
    let artifact = match revalidate_frozen_inputs(
        database,
        artifact_staging_root,
        &request,
        &cancellation,
        deadline,
    ) {
        Ok(artifact) => artifact,
        Err(failure) => return failed_result(&request, metrics, failure),
    };
    let files = match transfer_files(&artifact) {
        Ok(files) => files,
        Err(failure) => return failed_result(&request, metrics, failure),
    };
    let workflow = match database.get_deployment_workflow(&request.workflow_id) {
        Ok(Some(workflow)) => workflow,
        Ok(None) => {
            return failed_result(
                &request,
                metrics,
                TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::WorkflowNotFound,
                    "Deployment workflow was not found",
                ),
            )
        }
        Err(_) => {
            return failed_result(
                &request,
                metrics,
                TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::Internal,
                    "Failed to load deployment workflow",
                ),
            )
        }
    };
    let profile = match database.get_profile(&workflow.connection_profile_id) {
        Ok(Some(profile)) => profile,
        _ => {
            return failed_result(
                &request,
                metrics,
                TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::TargetChanged,
                    "Deployment target profile is unavailable",
                ),
            )
        }
    };
    if target_identity(&profile).ok().as_ref() != Some(&request.target) {
        return failed_result(
            &request,
            metrics,
            TransferFailure::definite(
                DeploymentArtifactTransferFailureCategory::TargetChanged,
                "Deployment target profile changed after planning",
            ),
        );
    }
    let connection = match connection_for_profile(credentials, &profile) {
        Ok(connection) => connection,
        Err(_) => {
            return failed_result(
                &request,
                metrics,
                TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::CredentialUnavailable,
                    "Deployment target credential reference could not be resolved",
                ),
            )
        }
    };

    let mut last_failure = None;
    let mut staging_root = None;
    for attempt in 0..MAX_CONNECT_ATTEMPTS {
        if let Some(failure) = terminal_failure(&cancellation, deadline) {
            return failed_result(&request, metrics, failure);
        }
        if attempt > 0 {
            if let Err(failure) = revalidate_frozen_inputs(
                database,
                artifact_staging_root,
                &request,
                &cancellation,
                deadline,
            ) {
                return failed_result(&request, metrics, failure);
            }
        }
        let mut remote = match SftpArtifactTransferRemote::connect(&connection, known_hosts_path) {
            Ok(remote) => remote,
            Err(failure) if failure.retryable && attempt + 1 < MAX_CONNECT_ATTEMPTS => {
                last_failure = Some(failure);
                continue;
            }
            Err(failure) => return failed_result(&request, metrics, failure),
        };
        match transfer_once(
            &mut remote,
            &request,
            &artifact.manifest.content_identity_sha256,
            &files,
            &cancellation,
            deadline,
            &mut progress,
            &mut metrics,
        ) {
            Ok(root) => {
                staging_root = Some(root);
                break;
            }
            Err(failure) if failure.retryable && attempt + 1 < MAX_CONNECT_ATTEMPTS => {
                last_failure = Some(failure);
            }
            Err(failure) => return failed_result(&request, metrics, failure),
        }
    }
    if staging_root.is_none() {
        let mut failure = last_failure.unwrap_or_else(|| {
            TransferFailure::transport("Deployment artifact transfer lost the remote connection")
        });
        failure.category = DeploymentArtifactTransferFailureCategory::StateUnknown;
        failure.retryable = false;
        failure.ambiguous = true;
        return failed_result(&request, metrics, failure);
    }

    progress.send(
        DeploymentArtifactTransferStep::Revalidate,
        None,
        None,
        None,
        "Revalidating the approved plan and artifact before completion",
    );
    let completed_artifact = match revalidate_frozen_inputs(
        database,
        artifact_staging_root,
        &request,
        &cancellation,
        deadline,
    ) {
        Ok(artifact) => artifact,
        Err(failure) => return failed_result(&request, metrics, failure),
    };
    if completed_artifact.artifact_reference != artifact.artifact_reference
        || completed_artifact.manifest != artifact.manifest
    {
        return failed_result(
            &request,
            metrics,
            TransferFailure::definite(
                DeploymentArtifactTransferFailureCategory::ArtifactChanged,
                "Deployment artifact changed before transfer completion",
            ),
        );
    }
    cancellation.try_finish();
    progress.send(
        DeploymentArtifactTransferStep::Complete,
        None,
        Some(files.iter().map(|file| file.bytes).sum()),
        Some(files.iter().map(|file| file.bytes).sum()),
        "Deployment artifact is verified and ready in remote staging",
    );
    let result = DeploymentArtifactTransferResult {
        operation_id: request.operation_id.clone(),
        plan_id: request.plan_id.clone(),
        release_id: request.release_id.clone(),
        remote_staging_identity: Some(format!(
            "{REMOTE_STAGING_REFERENCE_PREFIX}:{}:{}",
            artifact.manifest.content_identity_sha256, artifact.manifest.manifest_digest_sha256
        )),
        transferred_bytes: metrics.transferred_bytes,
        remote_digest_sha256: Some(request.release_digest_sha256.clone()),
        status: DeploymentArtifactTransferStatus::Succeeded,
        failure: None,
        reused: metrics.reused,
        resumed: metrics.resumed,
    };
    if database
        .record_deployment_transfer_receipt(&request, &result)
        .is_err()
    {
        return failed_result(
            &request,
            metrics,
            TransferFailure {
                category: DeploymentArtifactTransferFailureCategory::StateUnknown,
                message: "Remote staging completed but its durable receipt could not be recorded"
                    .into(),
                retryable: false,
                ambiguous: true,
            },
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::repository::DeploymentEventWrite;
    use crate::deployment::{
        DeploymentArtifactCompression, DeploymentEventKind, DeploymentOperationKind,
        DeploymentPlanCreateInput, DeploymentPreflightCheckSummary, DeploymentPreflightOutcome,
        DeploymentPreflightSummary, DeploymentReleaseIdentity, DeploymentTriggerKind,
        DeploymentWorkflowCreate, DeploymentWorkflowDefinition, DeploymentWorkflowUpdate,
        DockerBuildxPlan, DockerComposePlan,
    };
    use crate::models::{ProfileAuthMethod, ProfileRow};
    use std::collections::{HashMap, HashSet};
    use std::fs;

    #[derive(Default)]
    struct FakeRemote {
        canonical_root: String,
        directories: HashSet<String>,
        symlinks: HashSet<String>,
        files: HashMap<String, Vec<u8>>,
        rename_count: usize,
        upload_chunks: usize,
        disconnect_once: bool,
        corrupt_hash_suffix: Option<String>,
        injected_capacity_failure: Option<&'static str>,
        injected_toctou_symlink_swap: bool,
    }

    impl FakeRemote {
        fn new() -> Self {
            let canonical_root = "/srv/app".to_string();
            Self {
                directories: HashSet::from([canonical_root.clone()]),
                canonical_root,
                ..Self::default()
            }
        }

        fn digest(bytes: &[u8]) -> String {
            hex_digest(Sha256::digest(bytes))
        }
    }

    impl ArtifactTransferRemote for FakeRemote {
        fn canonical_root(&mut self, _requested: &str) -> Result<String, TransferFailure> {
            validate_canonical_remote_root(&self.canonical_root)?;
            Ok(self.canonical_root.clone())
        }

        fn ensure_directory(&mut self, path: &str) -> Result<(), TransferFailure> {
            if self.symlinks.contains(path) || self.files.contains_key(path) {
                return Err(TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::RemotePathUnsafe,
                    "unsafe fake directory",
                ));
            }
            self.directories.insert(path.to_string());
            Ok(())
        }

        fn stat(&mut self, path: &str) -> Result<Option<RemoteEntry>, TransferFailure> {
            if let Some(bytes) = self.files.get(path) {
                return Ok(Some(RemoteEntry {
                    kind: RemoteEntryKind::File,
                    bytes: bytes.len() as u64,
                }));
            }
            if self.directories.contains(path) {
                return Ok(Some(RemoteEntry {
                    kind: RemoteEntryKind::Directory,
                    bytes: 0,
                }));
            }
            if self.symlinks.contains(path) {
                return Ok(Some(RemoteEntry {
                    kind: RemoteEntryKind::Symlink,
                    bytes: 0,
                }));
            }
            Ok(None)
        }

        fn acquire_lock(&mut self, path: &str, owner: &str) -> Result<(), TransferFailure> {
            match self.files.get(path) {
                None => {
                    self.files
                        .insert(path.to_string(), owner.as_bytes().to_vec());
                    Ok(())
                }
                Some(existing) if existing == owner.as_bytes() => Ok(()),
                Some(_) => Err(TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::RemoteConflict,
                    "fake lock conflict",
                )),
            }
        }

        fn remove_file(&mut self, path: &str) -> Result<(), TransferFailure> {
            self.files.remove(path);
            Ok(())
        }

        fn hash_file(&mut self, path: &str) -> Result<(u64, String), TransferFailure> {
            let bytes = self.files.get(path).ok_or_else(|| {
                TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::RemoteIo,
                    "fake file missing",
                )
            })?;
            let digest = if self
                .corrupt_hash_suffix
                .as_deref()
                .is_some_and(|suffix| path.ends_with(suffix))
            {
                "f".repeat(64)
            } else {
                Self::digest(bytes)
            };
            Ok((bytes.len() as u64, digest))
        }

        fn hash_prefix(&mut self, path: &str, bytes: u64) -> Result<String, TransferFailure> {
            let contents = self.files.get(path).ok_or_else(|| {
                TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::RemoteIo,
                    "fake partial missing",
                )
            })?;
            Ok(Self::digest(&contents[..bytes as usize]))
        }

        fn upload(
            &mut self,
            local_path: &Path,
            remote_path: &str,
            offset: u64,
            progress: &mut dyn FnMut(u64) -> Result<(), TransferFailure>,
        ) -> Result<(), TransferFailure> {
            if self.injected_toctou_symlink_swap {
                self.files.remove(remote_path);
                self.symlinks.insert(remote_path.to_string());
                return Err(TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::RemotePathUnsafe,
                    "injected partial-file symlink swap",
                ));
            }
            if let Some(kind) = self.injected_capacity_failure {
                return Err(TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::RemoteIo,
                    format!("injected remote {kind} exhaustion"),
                ));
            }
            let mut local = File::open(local_path).unwrap();
            local.seek(SeekFrom::Start(offset)).unwrap();
            let destination = self.files.entry(remote_path.to_string()).or_default();
            if offset == 0 {
                destination.clear();
            }
            if destination.len() as u64 != offset {
                return Err(TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::RemotePartialInvalid,
                    "fake partial offset mismatch",
                ));
            }
            let mut buffer = [0_u8; TRANSFER_CHUNK_BYTES];
            loop {
                let count = local.read(&mut buffer).unwrap();
                if count == 0 {
                    return Ok(());
                }
                destination.extend_from_slice(&buffer[..count]);
                self.upload_chunks += 1;
                progress(count as u64)?;
                if self.disconnect_once {
                    self.disconnect_once = false;
                    return Err(TransferFailure::transport("simulated disconnect"));
                }
            }
        }

        fn rename_exclusive(
            &mut self,
            partial: &str,
            final_path: &str,
        ) -> Result<(), TransferFailure> {
            if self.files.contains_key(final_path) {
                return Err(TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::RemoteConflict,
                    "fake final conflict",
                ));
            }
            let bytes = self.files.remove(partial).ok_or_else(|| {
                TransferFailure::definite(
                    DeploymentArtifactTransferFailureCategory::RemoteIo,
                    "fake partial missing before rename",
                )
            })?;
            self.files.insert(final_path.to_string(), bytes);
            self.rename_count += 1;
            Ok(())
        }
    }

    fn request() -> DeploymentArtifactTransferRequest {
        let plan_digest = "b".repeat(64);
        DeploymentArtifactTransferRequest {
            operation_id: "deployment-artifact-transfer:test".into(),
            plan_id: format!("plan-{plan_digest}"),
            plan_digest,
            workflow_id: "workflow-1".into(),
            workflow_revision: 1,
            artifact_reference: format!(
                "deployment-artifact-v1:{}:{}",
                "d".repeat(64),
                "e".repeat(64)
            ),
            source_revision: DeploymentFrozenSourceRevision {
                revision: "a".repeat(40),
                dirty: false,
            },
            target: DeploymentTargetIdentitySnapshot {
                profile_id: "profile-1".into(),
                profile_updated_at: 1,
                host: "example.test".into(),
                port: 22,
                username: "deployer".into(),
                auth_method: "key".into(),
                jump_host: None,
            },
            remote_root: "/srv/app".into(),
            release_id: "release-1".into(),
            release_digest_sha256: "c".repeat(64),
            timeout_ms: 60_000,
        }
    }

    fn revalidation_fixture() -> (
        tempfile::TempDir,
        Database,
        DeploymentArtifactTransferRequest,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("transfer.db")).unwrap();
        let profile = ProfileRow {
            id: "profile-1".into(),
            name: "Production".into(),
            host: "example.test".into(),
            port: 22,
            username: "deployer".into(),
            auth_method: ProfileAuthMethod::Key,
            keychain_key_id: Some("credential-reference".into()),
            jump_host_config: None,
            organization_json: None,
            created_at: 1,
            updated_at: 1,
        };
        database.insert_profile(&profile).unwrap();
        let definition = DeploymentWorkflowDefinition {
            schema_version: 1,
            source_directory: std::env::current_dir()
                .unwrap()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            build: DockerBuildxPlan {
                context: ".".into(),
                dockerfile: "Dockerfile".into(),
                platform: "linux/amd64".into(),
                image_repository: "example.test/shellspan/app".into(),
                compression: DeploymentArtifactCompression::None,
            },
            target: super::super::DeploymentTarget {
                connection_profile_id: profile.id.clone(),
                remote_root: "/srv/app".into(),
            },
            compose: DockerComposePlan {
                project_name: "app".into(),
                files: vec!["compose.yaml".into()],
                services: vec!["web".into()],
                pull_before_up: false,
            },
            health_check: None,
            reload_nginx_after_healthy: false,
            releases_to_keep: 3,
        };
        database
            .create_deployment_workflow(
                "workflow-1",
                &DeploymentWorkflowCreate {
                    name: "API".into(),
                    definition,
                    enabled: true,
                },
            )
            .unwrap();
        let target = target_identity(&profile).unwrap();
        let input = DeploymentPlanCreateInput {
            workflow_id: "workflow-1".into(),
            expected_revision: 1,
            source_run_id: None,
            operation_kind: DeploymentOperationKind::Deploy,
            trigger_kind: DeploymentTriggerKind::Manual,
            artifact_reference: format!(
                "deployment-artifact-v1:{}:{}",
                "d".repeat(64),
                "e".repeat(64)
            ),
            source_revision: DeploymentFrozenSourceRevision {
                revision: "a".repeat(40),
                dirty: false,
            },
            target: target.clone(),
            current_release: None,
            target_release: DeploymentReleaseIdentity {
                release_id: "release-1".into(),
                artifact_digest_sha256: "c".repeat(64),
            },
            rollback_release: None,
            preflight: DeploymentPreflightSummary {
                checked_at: 1,
                checks: vec![DeploymentPreflightCheckSummary {
                    code: "ready".into(),
                    outcome: DeploymentPreflightOutcome::Passed,
                    summary: "ready".into(),
                }],
            },
            ttl_seconds: 60,
        };
        let plan = super::super::planner::create_deployment_plan(&database, input).unwrap();
        let request = DeploymentArtifactTransferRequest {
            operation_id: "deployment-artifact-transfer:revalidate".into(),
            plan_id: plan.plan_id,
            plan_digest: plan.plan_digest,
            workflow_id: "workflow-1".into(),
            workflow_revision: 1,
            artifact_reference: format!(
                "deployment-artifact-v1:{}:{}",
                "d".repeat(64),
                "e".repeat(64)
            ),
            source_revision: plan.approval_summary.frozen.source_revision,
            target,
            remote_root: "/srv/app".into(),
            release_id: "release-1".into(),
            release_digest_sha256: "c".repeat(64),
            timeout_ms: 60_000,
        };
        (directory, database, request)
    }

    fn approve_fixture_plan(database: &Database, plan_id: &str) {
        let run = super::super::planner::get_deployment_plan(database, plan_id).unwrap();
        database
            .transition_deployment_run_atomic(
                &run.run_id,
                1,
                DeploymentRunStatus::Planned,
                DeploymentRunStatus::AwaitingApproval,
                &DeploymentEventWrite {
                    event_kind: DeploymentEventKind::ApprovalRequested,
                    status: Some(DeploymentRunStatus::AwaitingApproval),
                    summary: "approval requested".into(),
                    payload: None,
                },
            )
            .unwrap();
        database
            .transition_deployment_run_atomic(
                &run.run_id,
                2,
                DeploymentRunStatus::AwaitingApproval,
                DeploymentRunStatus::Approved,
                &DeploymentEventWrite {
                    event_kind: DeploymentEventKind::ApprovalGranted,
                    status: Some(DeploymentRunStatus::Approved),
                    summary: "approval granted".into(),
                    payload: None,
                },
            )
            .unwrap();
    }

    fn transfer_file(directory: &tempfile::TempDir, bytes: Vec<u8>) -> TransferFile {
        let path = directory.path().join("image.tar");
        fs::write(&path, &bytes).unwrap();
        TransferFile {
            id: "image.tar".into(),
            local_path: path,
            bytes: bytes.len() as u64,
            sha256: FakeRemote::digest(&bytes),
            step: DeploymentArtifactTransferStep::StageArchive,
        }
    }

    fn run_once(
        remote: &mut FakeRemote,
        file: &TransferFile,
        registry: &ExecutionCancellationRegistry,
        deadline: Instant,
        events: &mut Vec<DeploymentArtifactTransferProgress>,
        metrics: &mut TransferMetrics,
    ) -> Result<String, TransferFailure> {
        let request = request();
        let cancellation = registry.register(request.operation_id.clone()).unwrap();
        let mut callback = |event| events.push(event);
        let mut progress = ProgressEmitter {
            operation_id: &request.operation_id,
            next_sequence: 1,
            emit: &mut callback,
        };
        transfer_once(
            remote,
            &request,
            &"d".repeat(64),
            std::slice::from_ref(file),
            &cancellation,
            deadline,
            &mut progress,
            metrics,
        )
    }

    fn final_path() -> String {
        format!("/srv/app/.shellspan/staging/{}/image.tar", "d".repeat(64))
    }

    #[test]
    fn streams_large_files_in_bounded_chunks_and_atomically_renames() {
        let directory = tempfile::tempdir().unwrap();
        let bytes = vec![7_u8; TRANSFER_CHUNK_BYTES * 4 + 17];
        let file = transfer_file(&directory, bytes.clone());
        let mut remote = FakeRemote::new();
        let mut events = Vec::new();
        let mut metrics = TransferMetrics::default();
        let registry = ExecutionCancellationRegistry::default();

        run_once(
            &mut remote,
            &file,
            &registry,
            Instant::now() + Duration::from_secs(5),
            &mut events,
            &mut metrics,
        )
        .unwrap();

        assert_eq!(remote.files.get(&final_path()), Some(&bytes));
        assert_eq!(remote.rename_count, 1);
        assert!(remote.upload_chunks >= 5);
        assert_eq!(metrics.transferred_bytes, file.bytes);
        assert!(events
            .windows(2)
            .all(|pair| pair[0].sequence < pair[1].sequence));
    }

    #[test]
    fn resumes_only_after_matching_partial_prefix() {
        let directory = tempfile::tempdir().unwrap();
        let bytes = vec![3_u8; TRANSFER_CHUNK_BYTES * 2];
        let file = transfer_file(&directory, bytes.clone());
        let mut remote = FakeRemote::new();
        let partial = format!("{}.part", final_path());
        remote
            .files
            .insert(partial.clone(), bytes[..TRANSFER_CHUNK_BYTES].to_vec());
        let mut events = Vec::new();
        let mut metrics = TransferMetrics::default();
        let registry = ExecutionCancellationRegistry::default();

        run_once(
            &mut remote,
            &file,
            &registry,
            Instant::now() + Duration::from_secs(5),
            &mut events,
            &mut metrics,
        )
        .unwrap();

        assert!(metrics.resumed);
        assert_eq!(metrics.transferred_bytes, TRANSFER_CHUNK_BYTES as u64);
        assert_eq!(remote.files.get(&final_path()), Some(&bytes));
        assert!(!remote.files.contains_key(&partial));
    }

    #[test]
    fn mismatching_partial_is_cleaned_without_touching_unrelated_files() {
        let directory = tempfile::tempdir().unwrap();
        let bytes = vec![5_u8; TRANSFER_CHUNK_BYTES + 3];
        let file = transfer_file(&directory, bytes.clone());
        let mut remote = FakeRemote::new();
        let partial = format!("{}.part", final_path());
        remote.files.insert(partial, vec![9_u8; 100]);
        remote
            .files
            .insert("/srv/app/unrelated".into(), b"keep".to_vec());
        let mut events = Vec::new();
        let mut metrics = TransferMetrics::default();

        run_once(
            &mut remote,
            &file,
            &ExecutionCancellationRegistry::default(),
            Instant::now() + Duration::from_secs(5),
            &mut events,
            &mut metrics,
        )
        .unwrap();

        assert!(!metrics.resumed);
        assert_eq!(remote.files.get(&final_path()), Some(&bytes));
        assert_eq!(
            remote.files.get("/srv/app/unrelated"),
            Some(&b"keep".to_vec())
        );
    }

    #[test]
    fn identical_final_is_idempotent_but_conflicting_final_fails_closed() {
        let directory = tempfile::tempdir().unwrap();
        let bytes = b"verified".to_vec();
        let file = transfer_file(&directory, bytes.clone());
        let mut reused = FakeRemote::new();
        reused.files.insert(final_path(), bytes);
        let mut events = Vec::new();
        let mut metrics = TransferMetrics::default();
        run_once(
            &mut reused,
            &file,
            &ExecutionCancellationRegistry::default(),
            Instant::now() + Duration::from_secs(5),
            &mut events,
            &mut metrics,
        )
        .unwrap();
        assert!(metrics.reused);
        assert_eq!(reused.rename_count, 0);

        let mut conflict = FakeRemote::new();
        conflict.files.insert(final_path(), b"different".to_vec());
        let failure = run_once(
            &mut conflict,
            &file,
            &ExecutionCancellationRegistry::default(),
            Instant::now() + Duration::from_secs(5),
            &mut Vec::new(),
            &mut TransferMetrics::default(),
        )
        .unwrap_err();
        assert_eq!(
            failure.category,
            DeploymentArtifactTransferFailureCategory::RemoteConflict
        );
    }

    #[test]
    fn remote_hash_mismatch_removes_only_the_owned_partial() {
        let directory = tempfile::tempdir().unwrap();
        let file = transfer_file(&directory, b"verified".to_vec());
        let mut remote = FakeRemote::new();
        remote.corrupt_hash_suffix = Some(".part".into());
        remote
            .files
            .insert("/srv/app/unrelated".into(), b"keep".to_vec());
        let failure = run_once(
            &mut remote,
            &file,
            &ExecutionCancellationRegistry::default(),
            Instant::now() + Duration::from_secs(5),
            &mut Vec::new(),
            &mut TransferMetrics::default(),
        )
        .unwrap_err();
        assert_eq!(
            failure.category,
            DeploymentArtifactTransferFailureCategory::RemoteDigestMismatch
        );
        assert!(!remote.files.contains_key(&format!("{}.part", final_path())));
        assert_eq!(
            remote.files.get("/srv/app/unrelated"),
            Some(&b"keep".to_vec())
        );
    }

    #[test]
    fn reconnect_attempt_resumes_the_verified_partial() {
        let directory = tempfile::tempdir().unwrap();
        let bytes = vec![8_u8; TRANSFER_CHUNK_BYTES * 2];
        let file = transfer_file(&directory, bytes.clone());
        let mut remote = FakeRemote::new();
        remote.disconnect_once = true;
        let request = request();
        let registry = ExecutionCancellationRegistry::default();
        let cancellation = registry.register(request.operation_id.clone()).unwrap();
        let mut events = Vec::new();
        let mut callback = |event| events.push(event);
        let mut progress = ProgressEmitter {
            operation_id: &request.operation_id,
            next_sequence: 1,
            emit: &mut callback,
        };
        let mut metrics = TransferMetrics::default();
        let first = transfer_once(
            &mut remote,
            &request,
            &"d".repeat(64),
            std::slice::from_ref(&file),
            &cancellation,
            Instant::now() + Duration::from_secs(5),
            &mut progress,
            &mut metrics,
        )
        .unwrap_err();
        assert!(first.retryable);
        transfer_once(
            &mut remote,
            &request,
            &"d".repeat(64),
            std::slice::from_ref(&file),
            &cancellation,
            Instant::now() + Duration::from_secs(5),
            &mut progress,
            &mut metrics,
        )
        .unwrap();
        assert!(metrics.resumed);
        assert_eq!(remote.files.get(&final_path()), Some(&bytes));
    }

    #[test]
    fn cancellation_and_timeout_preserve_safe_partial_and_release_lock() {
        let directory = tempfile::tempdir().unwrap();
        let file = transfer_file(&directory, b"verified".to_vec());
        let partial = format!("{}.part", final_path());

        let request = request();
        let registry = ExecutionCancellationRegistry::default();
        let cancellation = registry.register(request.operation_id.clone()).unwrap();
        registry.cancel(&request.operation_id).unwrap();
        let mut cancelled_remote = FakeRemote::new();
        cancelled_remote
            .files
            .insert(partial.clone(), b"ver".to_vec());
        let mut callback = |_| {};
        let mut progress = ProgressEmitter {
            operation_id: &request.operation_id,
            next_sequence: 1,
            emit: &mut callback,
        };
        let failure = transfer_once(
            &mut cancelled_remote,
            &request,
            &"d".repeat(64),
            std::slice::from_ref(&file),
            &cancellation,
            Instant::now() + Duration::from_secs(5),
            &mut progress,
            &mut TransferMetrics::default(),
        )
        .unwrap_err();
        assert_eq!(
            failure.category,
            DeploymentArtifactTransferFailureCategory::Cancelled
        );
        assert_eq!(cancelled_remote.files.get(&partial), Some(&b"ver".to_vec()));
        assert!(!cancelled_remote
            .files
            .keys()
            .any(|path| path.ends_with(LOCK_FILE_NAME)));

        let timeout_registry = ExecutionCancellationRegistry::default();
        let timeout_handle = timeout_registry
            .register(request.operation_id.clone())
            .unwrap();
        let mut timed_out_remote = FakeRemote::new();
        timed_out_remote
            .files
            .insert(partial.clone(), b"ver".to_vec());
        let timeout = transfer_once(
            &mut timed_out_remote,
            &request,
            &"d".repeat(64),
            std::slice::from_ref(&file),
            &timeout_handle,
            Instant::now() - Duration::from_millis(1),
            &mut progress,
            &mut TransferMetrics::default(),
        )
        .unwrap_err();
        assert_eq!(
            timeout.category,
            DeploymentArtifactTransferFailureCategory::TimedOut
        );
        assert_eq!(timed_out_remote.files.get(&partial), Some(&b"ver".to_vec()));
    }

    #[test]
    fn injected_disk_and_inode_exhaustion_fail_without_publishing_final_files() {
        let directory = tempfile::tempdir().unwrap();
        let file = transfer_file(&directory, b"verified".to_vec());
        for failure in ["disk", "inode"] {
            let mut remote = FakeRemote::new();
            remote.injected_capacity_failure = Some(failure);
            let result = run_once(
                &mut remote,
                &file,
                &ExecutionCancellationRegistry::default(),
                Instant::now() + Duration::from_secs(5),
                &mut Vec::new(),
                &mut TransferMetrics::default(),
            )
            .unwrap_err();
            assert_eq!(
                result.category,
                DeploymentArtifactTransferFailureCategory::RemoteIo
            );
            assert!(!remote.files.contains_key(&final_path()));
        }
    }

    #[test]
    fn injected_partial_file_toctou_swap_fails_closed_before_publication() {
        let directory = tempfile::tempdir().unwrap();
        let bytes = vec![4_u8; TRANSFER_CHUNK_BYTES * 2];
        let file = transfer_file(&directory, bytes.clone());
        let mut remote = FakeRemote::new();
        remote.files.insert(
            format!("{}.part", final_path()),
            bytes[..TRANSFER_CHUNK_BYTES].to_vec(),
        );
        remote.injected_toctou_symlink_swap = true;

        let failure = run_once(
            &mut remote,
            &file,
            &ExecutionCancellationRegistry::default(),
            Instant::now() + Duration::from_secs(5),
            &mut Vec::new(),
            &mut TransferMetrics::default(),
        )
        .unwrap_err();

        assert_eq!(
            failure.category,
            DeploymentArtifactTransferFailureCategory::RemotePathUnsafe
        );
        assert!(!remote.files.contains_key(&final_path()));
    }

    #[test]
    fn rejects_symlinked_staging_boundary_and_invalid_request_identity() {
        let directory = tempfile::tempdir().unwrap();
        let file = transfer_file(&directory, b"verified".to_vec());
        let mut remote = FakeRemote::new();
        remote.symlinks.insert("/srv/app/.shellspan".into());
        let failure = run_once(
            &mut remote,
            &file,
            &ExecutionCancellationRegistry::default(),
            Instant::now() + Duration::from_secs(5),
            &mut Vec::new(),
            &mut TransferMetrics::default(),
        )
        .unwrap_err();
        assert_eq!(
            failure.category,
            DeploymentArtifactTransferFailureCategory::RemotePathUnsafe
        );

        let mut invalid = request();
        invalid.operation_id = "deployment-artifact-transfer:bad/path".into();
        assert_eq!(
            validate_request(&invalid).unwrap_err().category,
            DeploymentArtifactTransferFailureCategory::InvalidRequest
        );
    }

    #[test]
    fn maps_plan_expiry_and_input_drift_to_closed_categories() {
        assert_eq!(
            map_plan_error("DEPLOYMENT_PLAN_EXPIRED".into()).category,
            DeploymentArtifactTransferFailureCategory::PlanExpired
        );
        assert_eq!(
            map_plan_error("DEPLOYMENT_PLAN_INPUT_CHANGED".into()).category,
            DeploymentArtifactTransferFailureCategory::TargetChanged
        );
        assert_eq!(
            map_plan_error("REVISION_CONFLICT".into()).category,
            DeploymentArtifactTransferFailureCategory::RevisionConflict
        );
    }

    #[test]
    fn plan_approval_source_and_profile_drift_fail_before_network_or_remote_write() {
        let (directory, database, request) = revalidation_fixture();
        let registry = ExecutionCancellationRegistry::default();
        let cancellation = registry.register(request.operation_id.clone()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let failure = revalidate_frozen_inputs(
            &database,
            &directory.path().join("missing-artifacts"),
            &request,
            &cancellation,
            deadline,
        )
        .unwrap_err();
        assert_eq!(
            failure.category,
            DeploymentArtifactTransferFailureCategory::PlanNotApproved
        );

        approve_fixture_plan(&database, &request.plan_id);
        let failure = revalidate_frozen_inputs(
            &database,
            &directory.path().join("missing-artifacts"),
            &request,
            &cancellation,
            deadline,
        )
        .unwrap_err();
        assert_eq!(
            failure.category,
            DeploymentArtifactTransferFailureCategory::SourceChanged
        );

        let (directory, database, request) = revalidation_fixture();
        let mut changed_profile = database.get_profile("profile-1").unwrap().unwrap();
        changed_profile.host = "changed.example.test".into();
        changed_profile.updated_at += 1;
        database
            .update_profile("profile-1", &changed_profile)
            .unwrap();
        let registry = ExecutionCancellationRegistry::default();
        let cancellation = registry.register(request.operation_id.clone()).unwrap();
        let failure = revalidate_frozen_inputs(
            &database,
            &directory.path().join("missing-artifacts"),
            &request,
            &cancellation,
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap_err();
        assert_eq!(
            failure.category,
            DeploymentArtifactTransferFailureCategory::TargetChanged
        );

        let (directory, database, request) = revalidation_fixture();
        let workflow = database
            .get_deployment_workflow("workflow-1")
            .unwrap()
            .unwrap();
        database
            .update_deployment_workflow(
                "workflow-1",
                &DeploymentWorkflowUpdate {
                    expected_revision: 1,
                    name: "API changed".into(),
                    definition: workflow.definition,
                    enabled: true,
                },
            )
            .unwrap();
        let registry = ExecutionCancellationRegistry::default();
        let cancellation = registry.register(request.operation_id.clone()).unwrap();
        let failure = revalidate_frozen_inputs(
            &database,
            &directory.path().join("missing-artifacts"),
            &request,
            &cancellation,
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap_err();
        assert_eq!(
            failure.category,
            DeploymentArtifactTransferFailureCategory::RevisionConflict
        );
    }

    #[test]
    fn wire_enums_and_request_shape_are_closed() {
        assert_eq!(
            serde_json::to_value([
                DeploymentArtifactTransferStep::Revalidate,
                DeploymentArtifactTransferStep::Lock,
                DeploymentArtifactTransferStep::StageArchive,
                DeploymentArtifactTransferStep::StageCompose,
                DeploymentArtifactTransferStep::VerifyRemote,
                DeploymentArtifactTransferStep::Complete,
            ])
            .unwrap(),
            serde_json::json!([
                "revalidate",
                "lock",
                "stageArchive",
                "stageCompose",
                "verifyRemote",
                "complete"
            ])
        );
        let mut value = serde_json::to_value(serde_json::json!({
            "operationId": "deployment-artifact-transfer:closed",
            "planId": format!("plan-{}", "b".repeat(64)),
            "planDigest": "b".repeat(64),
            "workflowId": "workflow-1",
            "workflowRevision": 1,
            "artifactReference": format!("deployment-artifact-v1:{}:{}", "c".repeat(64), "d".repeat(64)),
            "sourceRevision": { "revision": "a".repeat(40), "dirty": false },
            "target": {
                "profileId": "profile-1",
                "profileUpdatedAt": 1,
                "host": "example.test",
                "port": 22,
                "username": "deploy",
                "authMethod": "key",
                "jumpHost": null
            },
            "remoteRoot": "/srv/app",
            "releaseId": "release-1",
            "releaseDigestSha256": "e".repeat(64),
            "timeoutMs": 60_000
        }))
        .unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("remotePath".into(), serde_json::json!("/tmp/escape"));
        assert!(serde_json::from_value::<DeploymentArtifactTransferRequest>(value).is_err());
    }

    #[test]
    fn successful_transfer_receipt_is_durable_exact_and_immutable() {
        let (_directory, database, request) = revalidation_fixture();
        let result = DeploymentArtifactTransferResult {
            operation_id: request.operation_id.clone(),
            plan_id: request.plan_id.clone(),
            release_id: request.release_id.clone(),
            remote_staging_identity: Some(format!(
                "deployment-staging-v1:{}:{}",
                "d".repeat(64),
                "e".repeat(64)
            )),
            transferred_bytes: 128,
            remote_digest_sha256: Some(request.release_digest_sha256.clone()),
            status: DeploymentArtifactTransferStatus::Succeeded,
            failure: None,
            reused: false,
            resumed: false,
        };
        let receipt = database
            .record_deployment_transfer_receipt(&request, &result)
            .unwrap();
        assert_eq!(receipt.request, request);
        assert_eq!(receipt.result, result);
        assert_eq!(
            database
                .get_deployment_transfer_receipt(&receipt.operation_id)
                .unwrap(),
            Some(receipt.clone())
        );

        let mut conflicting = result;
        conflicting.transferred_bytes = 129;
        assert!(database
            .record_deployment_transfer_receipt(&request, &conflicting)
            .unwrap_err()
            .contains("conflicts"));
        assert!(database
            .with_connection(|connection| connection
                .execute(
                    "UPDATE deployment_transfer_receipts SET result_json = '{}' WHERE operation_id = ?1",
                    [&receipt.operation_id],
                )
                .map(|_| ())
                .map_err(|error| error.to_string()))
            .is_err());
    }

    #[test]
    #[ignore = "requires the isolated tests/deployment-e2e DinD SSH fixture"]
    fn isolated_deployment_sftp_transport_acceptance() {
        use base64::{engine::general_purpose::STANDARD, Engine};

        let connection = crate::execution::fixture::isolated_ssh_connection();
        let root = std::env::var("SHELLSPAN_DEPLOYMENT_E2E_ROOT")
            .expect("SHELLSPAN_DEPLOYMENT_E2E_ROOT is required");
        let handshake =
            crate::connection::open_session_for_host_key(&connection.host, connection.port)
                .expect("read fixture host key");
        let empty = tempfile::tempdir().unwrap();
        let first_trust = crate::known_hosts::check_host_key_against_file(
            &handshake,
            &connection.host,
            connection.port,
            &empty.path().join("known_hosts"),
        )
        .expect_err("first connection must require explicit trust");
        assert_eq!(
            first_trust.status,
            crate::models::HostKeyCheckStatus::NotFound
        );

        let (_trusted_directory, trusted_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let matched = crate::known_hosts::check_host_key_against_file(
            &handshake,
            &connection.host,
            connection.port,
            &trusted_path,
        )
        .expect("trusted fixture identity must match");
        assert_eq!(matched.status, crate::models::HostKeyCheckStatus::Match);

        let mismatch_directory = tempfile::tempdir().unwrap();
        let mismatch_path = mismatch_directory.path().join("known_hosts");
        let endpoint = format!("[{}]:{}", connection.host, connection.port);
        let fake_key = vec![7_u8; 32];
        std::fs::write(
            &mismatch_path,
            format!("{endpoint} ssh-ed25519 {}\n", STANDARD.encode(fake_key)),
        )
        .unwrap();
        let mismatch = crate::known_hosts::check_host_key_against_file(
            &handshake,
            &connection.host,
            connection.port,
            &mismatch_path,
        )
        .expect_err("changed fixture identity must fail closed");
        assert_eq!(mismatch.status, crate::models::HostKeyCheckStatus::Mismatch);
        let rejected = match SftpArtifactTransferRemote::connect(&connection, &mismatch_path) {
            Ok(_) => panic!("mismatched host key must not open SFTP"),
            Err(failure) => failure,
        };
        assert_eq!(
            rejected.category,
            DeploymentArtifactTransferFailureCategory::HostKeyRejected
        );

        let directory = tempfile::tempdir().unwrap();
        let bytes = (0..(TRANSFER_CHUNK_BYTES * 8 + 19))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let file = transfer_file(&directory, bytes.clone());
        let content_identity = "9".repeat(64);
        let mut request = request();
        request.operation_id = "deployment-artifact-transfer:isolated-sftp".into();
        request.remote_root = root.clone();
        let partial_path = format!(
            "{root}/.shellspan/staging/{content_identity}/{}.part",
            file.id
        );
        let final_path = format!("{root}/.shellspan/staging/{content_identity}/{}", file.id);

        {
            let mut remote = SftpArtifactTransferRemote::connect(&connection, &trusted_path)
                .expect("connect to isolated SFTP fixture with password auth");
            let (staging, _) = staging_paths(&mut remote, &root, &content_identity).unwrap();
            assert_eq!(
                staging,
                format!("{root}/.shellspan/staging/{content_identity}")
            );
            let mut observed = 0_u64;
            let interrupted = remote.upload(&file.local_path, &partial_path, 0, &mut |written| {
                observed += written;
                if observed >= TRANSFER_CHUNK_BYTES as u64 {
                    Err(TransferFailure::transport("injected fixture disconnect"))
                } else {
                    Ok(())
                }
            });
            assert!(interrupted.is_err());
            assert_eq!(remote.stat(&partial_path).unwrap().unwrap().bytes, observed);
        }

        let registry = ExecutionCancellationRegistry::default();
        let cancellation = registry.register(request.operation_id.clone()).unwrap();
        let mut events = Vec::new();
        let mut emit = |event| events.push(event);
        let mut progress = ProgressEmitter {
            operation_id: &request.operation_id,
            next_sequence: 1,
            emit: &mut emit,
        };
        let mut metrics = TransferMetrics::default();
        let mut remote = SftpArtifactTransferRemote::connect(&connection, &trusted_path).unwrap();
        transfer_once(
            &mut remote,
            &request,
            &content_identity,
            std::slice::from_ref(&file),
            &cancellation,
            Instant::now() + Duration::from_secs(30),
            &mut progress,
            &mut metrics,
        )
        .unwrap();
        assert!(metrics.resumed);
        assert!(metrics.transferred_bytes < file.bytes);
        assert_eq!(remote.stat(&final_path).unwrap().unwrap().bytes, file.bytes);
        assert!(remote.stat(&partial_path).unwrap().is_none());
        assert_eq!(remote.hash_file(&final_path).unwrap().1, file.sha256);

        let lock_identity = "8".repeat(64);
        let (_, lock_path) = staging_paths(&mut remote, &root, &lock_identity).unwrap();
        remote.acquire_lock(&lock_path, "other-operation").unwrap();
        let lock_failure = transfer_once(
            &mut remote,
            &request,
            &lock_identity,
            std::slice::from_ref(&file),
            &cancellation,
            Instant::now() + Duration::from_secs(30),
            &mut progress,
            &mut TransferMetrics::default(),
        )
        .unwrap_err();
        assert_eq!(
            lock_failure.category,
            DeploymentArtifactTransferFailureCategory::RemoteConflict
        );

        let symlink_identity = "7".repeat(64);
        let symlink_path = format!("{root}/.shellspan/staging/{symlink_identity}");
        remote
            .sftp
            .symlink(Path::new("/tmp"), Path::new(&symlink_path))
            .unwrap();
        let unsafe_path = staging_paths(&mut remote, &root, &symlink_identity).unwrap_err();
        assert_eq!(
            unsafe_path.category,
            DeploymentArtifactTransferFailureCategory::RemotePathUnsafe
        );
    }
}
