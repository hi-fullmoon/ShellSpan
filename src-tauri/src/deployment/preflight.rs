//! Fixed-purpose, read-only deployment preflight.
//!
//! The frontend supplies workflow identity and the Phase 3 artifact identity;
//! it never supplies Git arguments or remote command text. Local source
//! inspection and the SSH probe below are closed, bounded command sets.

use super::planner::target_identity;
use super::{
    DeploymentFrozenSourceRevision, DeploymentOperationKind, DeploymentPlanCreateInput,
    DeploymentPreflightCheckSummary, DeploymentPreflightOutcome, DeploymentPreflightSummary,
    DeploymentReleaseIdentity, DeploymentTargetIdentitySnapshot, DeploymentTriggerKind,
    DeploymentWorkflowRecord,
};
use crate::db::{current_timestamp_ms, Database};
use crate::execution::{
    execute_reviewed_ssh_command_with_handle, CancellationHandle, ExecutionErrorCategory,
    ExecutionOutputPolicy, ExecutionStatus, FrozenTargetIdentity, ReviewedSshCommand,
    ReviewedSshExecutionRequest,
};
use crate::keychain::{CredentialManager, ProfileSecretKind};
use crate::models::{
    AuthMethod, JumpHostConfig, ProfileAuthMethod, ProfileRow, RemoteConnectionRequest,
};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const OPERATION_PREFIX: &str = "deployment-preflight:";
const COMMAND_SET_VERSION: &str = "shellspan-deployment-preflight-v1";
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const LOCAL_OUTPUT_LIMIT: usize = 64 * 1024;
const REMOTE_STDOUT_LIMIT: usize = 64 * 1024;
const REMOTE_STDERR_LIMIT: usize = 8 * 1024;
const REMOTE_TOTAL_LIMIT: usize = 80 * 1024;
const LOW_DISK_WARNING_BYTES: u64 = 512 * 1024 * 1024;
const RELEASE_DIGEST_FILE: &str = ".shellspan-artifact-sha256";

// `root` is supplied as positional parameter $1 after strict POSIX quoting.
// No workflow value is interpolated into the script body and every operation
// only reads metadata. This constant must never grow mutation commands.
const REMOTE_PROBE_SCRIPT: &str = r#"root=$1
LC_ALL=C
export LC_ALL
printf 'SSP_OS=%s\n' "$(uname -s 2>/dev/null || printf unknown)"
printf 'SSP_ARCH=%s\n' "$(uname -m 2>/dev/null || printf unknown)"
if [ -d "$root" ] && [ -r "$root" ] && [ -x "$root" ]; then
  printf 'SSP_ROOT=1\n'
  available=$(df -Pk "$root" 2>/dev/null | awk 'NR==2 {print $4}')
  printf 'SSP_DISK_KIB=%s\n' "${available:-0}"
else
  printf 'SSP_ROOT=0\n'
  printf 'SSP_DISK_KIB=0\n'
fi
if command -v docker >/dev/null 2>&1; then printf 'SSP_DOCKER=1\n'; else printf 'SSP_DOCKER=0\n'; fi
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then printf 'SSP_COMPOSE=1\n'; else printf 'SSP_COMPOSE=0\n'; fi
if command -v flock >/dev/null 2>&1; then printf 'SSP_FLOCK=1\n'; else printf 'SSP_FLOCK=0\n'; fi
if command -v curl >/dev/null 2>&1; then printf 'SSP_CURL=1\n'; else printf 'SSP_CURL=0\n'; fi
if command -v nginx >/dev/null 2>&1; then printf 'SSP_NGINX=1\n'; else printf 'SSP_NGINX=0\n'; fi
if command -v sudo >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then printf 'SSP_NGINX_RELOAD=1\n'; else printf 'SSP_NGINX_RELOAD=0\n'; fi
if command -v sha256sum >/dev/null 2>&1; then printf 'SSP_SHA256=sha256sum\n'; elif command -v shasum >/dev/null 2>&1; then printf 'SSP_SHA256=shasum\n'; else printf 'SSP_SHA256=none\n'; fi
if command -v tar >/dev/null 2>&1 && command -v gzip >/dev/null 2>&1; then printf 'SSP_COMPRESSION=tar+gzip\n'; elif command -v tar >/dev/null 2>&1 && command -v zstd >/dev/null 2>&1; then printf 'SSP_COMPRESSION=tar+zstd\n'; else printf 'SSP_COMPRESSION=none\n'; fi
current_target=$(readlink "$root/current" 2>/dev/null || true)
current_id=${current_target##*/}
printf 'SSP_CURRENT=%s\n' "$current_id"
for digest_file in "$root"/releases/*/.shellspan-artifact-sha256; do
  [ -f "$digest_file" ] || continue
  release_dir=${digest_file%/*}
  release_id=${release_dir##*/}
  IFS= read -r digest < "$digest_file" || true
  printf 'SSP_RELEASE=%s\t%s\n' "$release_id" "$digest"
done"#;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentPreflightRequest {
    pub operation_id: String,
    pub workflow_id: String,
    pub expected_revision: u32,
    pub artifact_reference: String,
    pub ttl_seconds: u32,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentPreflightStatus {
    Passed,
    Blocked,
    Cancelled,
    TimedOut,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentPreflightFailureCategory {
    InvalidRequest,
    WorkflowNotFound,
    RevisionConflict,
    WorkflowDisabled,
    ProfileNotFound,
    TargetChanged,
    ArtifactInvalid,
    SourceChanged,
    SourceUnavailable,
    SourceOutputLimit,
    CredentialUnavailable,
    HostKeyRejected,
    ConnectionFailed,
    RemoteCommandFailed,
    RemoteOutputLimit,
    InvalidRemoteOutput,
    Cancelled,
    TimedOut,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentPreflightFailure {
    pub category: DeploymentPreflightFailureCategory,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentPreflightServer {
    pub os: String,
    pub architecture: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentPreflightRemoteRoot {
    pub path: String,
    pub reachable: bool,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentPreflightTools {
    pub docker: bool,
    pub compose: bool,
    pub flock: bool,
    pub curl: bool,
    pub nginx: bool,
    pub nginx_reload: bool,
    pub sha256: Option<String>,
    pub compression: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentPreflightSource {
    pub kind: &'static str,
    pub command_set_version: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentPreflightResult {
    pub operation_id: String,
    pub workflow_id: String,
    pub workflow_revision: Option<u32>,
    pub artifact_reference: String,
    pub status: DeploymentPreflightStatus,
    pub checked_at: i64,
    pub source: DeploymentPreflightSource,
    pub source_revision: Option<DeploymentFrozenSourceRevision>,
    pub target: Option<DeploymentTargetIdentitySnapshot>,
    pub server: Option<DeploymentPreflightServer>,
    pub remote_root: Option<DeploymentPreflightRemoteRoot>,
    pub tools: Option<DeploymentPreflightTools>,
    pub current_release: Option<DeploymentReleaseIdentity>,
    pub rollback_releases: Vec<DeploymentReleaseIdentity>,
    pub checks: Vec<DeploymentPreflightCheckSummary>,
    pub plan_input: Option<DeploymentPlanCreateInput>,
    pub failure: Option<DeploymentPreflightFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteProbeSnapshot {
    server: DeploymentPreflightServer,
    root_reachable: bool,
    available_bytes: u64,
    tools: DeploymentPreflightTools,
    current_release_id: Option<String>,
    releases: Vec<DeploymentReleaseIdentity>,
}

struct BoundedProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_exceeded: bool,
    stderr_exceeded: bool,
}

#[derive(Debug)]
enum LocalCommandFailure {
    Cancelled,
    TimedOut,
    OutputLimit,
    Failed(String),
}

struct BoundedRead {
    bytes: Vec<u8>,
    exceeded: bool,
}

fn read_bounded(mut reader: impl Read, limit: usize) -> std::io::Result<BoundedRead> {
    let mut bytes = Vec::with_capacity(limit.min(8 * 1024));
    let mut buffer = [0_u8; 4_096];
    let mut total = 0_usize;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total.saturating_add(count);
        if bytes.len() < limit {
            let keep = (limit - bytes.len()).min(count);
            bytes.extend_from_slice(&buffer[..keep]);
        }
    }
    Ok(BoundedRead {
        bytes,
        exceeded: total > limit,
    })
}

fn terminal_failure(
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> Option<LocalCommandFailure> {
    match cancellation.terminal_state() {
        crate::execution::ExecutionTerminalState::Cancelled => Some(LocalCommandFailure::Cancelled),
        crate::execution::ExecutionTerminalState::TimedOut => Some(LocalCommandFailure::TimedOut),
        crate::execution::ExecutionTerminalState::Finished => Some(LocalCommandFailure::Failed(
            "deployment preflight cancellation state ended unexpectedly".to_string(),
        )),
        crate::execution::ExecutionTerminalState::Running if Instant::now() >= deadline => {
            cancellation.try_timeout();
            terminal_failure(cancellation, deadline)
        }
        crate::execution::ExecutionTerminalState::Running => None,
    }
}

fn run_git_bounded(
    project_root: &Path,
    args: &[&str],
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> Result<BoundedProcessOutput, LocalCommandFailure> {
    if let Some(failure) = terminal_failure(cancellation, deadline) {
        return Err(failure);
    }
    let mut child = Command::new("git")
        .args(args)
        .current_dir(project_root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            LocalCommandFailure::Failed(format!("failed to start Git query: {error}"))
        })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        LocalCommandFailure::Failed("failed to capture Git query output".to_string())
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        LocalCommandFailure::Failed("failed to capture Git query diagnostics".to_string())
    })?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout, LOCAL_OUTPUT_LIMIT));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, 4 * 1024));

    let status = loop {
        if let Some(failure) = terminal_failure(cancellation, deadline) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(failure);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(LocalCommandFailure::Failed(format!(
                    "failed to wait for Git query: {error}"
                )));
            }
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| LocalCommandFailure::Failed("Git output reader stopped".to_string()))?
        .map_err(|error| {
            LocalCommandFailure::Failed(format!("failed to read Git output: {error}"))
        })?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| LocalCommandFailure::Failed("Git diagnostics reader stopped".to_string()))?
        .map_err(|error| {
            LocalCommandFailure::Failed(format!("failed to read Git diagnostics: {error}"))
        })?;
    Ok(BoundedProcessOutput {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        stdout_exceeded: stdout.exceeded,
        stderr_exceeded: stderr.exceeded,
    })
}

fn trimmed_output(bytes: &[u8]) -> Result<&str, LocalCommandFailure> {
    std::str::from_utf8(bytes)
        .map(str::trim)
        .map_err(|_| LocalCommandFailure::Failed("Git query returned invalid UTF-8".to_string()))
}

fn git_error(output: &BoundedProcessOutput, label: &str) -> LocalCommandFailure {
    if output.stdout_exceeded || output.stderr_exceeded {
        return LocalCommandFailure::OutputLimit;
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    LocalCommandFailure::Failed(if detail.is_empty() {
        format!("{label} failed")
    } else {
        format!("{label} failed: {detail}")
    })
}

fn inspect_source(
    source_directory: &str,
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> Result<DeploymentFrozenSourceRevision, LocalCommandFailure> {
    let frozen_root = PathBuf::from(source_directory);
    let canonical_root = std::fs::canonicalize(&frozen_root).map_err(|error| {
        LocalCommandFailure::Failed(format!(
            "deployment source directory is unavailable: {error}"
        ))
    })?;
    if canonical_root != frozen_root {
        return Err(LocalCommandFailure::Failed(
            "deployment source directory must already be canonical".to_string(),
        ));
    }

    let top = run_git_bounded(
        &canonical_root,
        &["rev-parse", "--show-toplevel"],
        cancellation,
        deadline,
    )?;
    if !top.status.success() {
        return Err(git_error(&top, "Git project-root query"));
    }
    if top.stdout_exceeded || top.stderr_exceeded {
        return Err(LocalCommandFailure::OutputLimit);
    }
    let discovered_root = std::fs::canonicalize(trimmed_output(&top.stdout)?).map_err(|_| {
        LocalCommandFailure::Failed("Git returned an invalid project root".to_string())
    })?;
    if discovered_root != canonical_root {
        return Err(LocalCommandFailure::Failed(
            "deployment source must be the frozen Git project root".to_string(),
        ));
    }

    let revision = run_git_bounded(
        &canonical_root,
        &["rev-parse", "--verify", "HEAD^{commit}"],
        cancellation,
        deadline,
    )?;
    if !revision.status.success() {
        return Err(git_error(&revision, "Git revision query"));
    }
    if revision.stdout_exceeded || revision.stderr_exceeded {
        return Err(LocalCommandFailure::OutputLimit);
    }
    let revision = trimmed_output(&revision.stdout)?.to_string();
    if !matches!(revision.len(), 40 | 64)
        || !revision
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
    {
        return Err(LocalCommandFailure::Failed(
            "Git revision is not a lowercase object digest".to_string(),
        ));
    }

    let status = run_git_bounded(
        &canonical_root,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
            "--no-renames",
        ],
        cancellation,
        deadline,
    )?;
    if !status.status.success() {
        return Err(git_error(&status, "Git dirty-state query"));
    }
    // A large status is still safely classified as dirty. The bounded reader
    // drains the child pipe without retaining unbounded repository data.
    let dirty = status.stdout_exceeded || !status.stdout.is_empty();
    Ok(DeploymentFrozenSourceRevision { revision, dirty })
}

fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn remote_probe_command(remote_root: &str) -> String {
    format!(
        "sh -c {} shellspan-deployment-preflight {}",
        posix_quote(REMOTE_PROBE_SCRIPT),
        posix_quote(remote_root)
    )
}

pub(crate) fn connection_for_profile(
    credentials: &CredentialManager,
    profile: &ProfileRow,
) -> Result<RemoteConnectionRequest, String> {
    let auth_method = match profile.auth_method {
        ProfileAuthMethod::Password => AuthMethod::Password,
        ProfileAuthMethod::Key => AuthMethod::Key,
    };
    let password = if auth_method == AuthMethod::Password {
        Some(
            credentials
                .retrieve_profile_password(&profile.id)?
                .ok_or_else(|| "profile password is unavailable".to_string())?,
        )
    } else {
        None
    };
    let passphrase = if auth_method == AuthMethod::Key {
        credentials.retrieve_profile_secret(&profile.id, ProfileSecretKind::Passphrase)?
    } else {
        None
    };
    let mut jump_host = profile
        .jump_host_config
        .as_deref()
        .map(serde_json::from_str::<JumpHostConfig>)
        .transpose()
        .map_err(|error| format!("stored jump-host configuration is invalid: {error}"))?;
    if let Some(jump) = &mut jump_host {
        match jump.auth_method {
            AuthMethod::Password => {
                jump.password = Some(
                    credentials
                        .retrieve_profile_secret(&profile.id, ProfileSecretKind::JumpPassword)?
                        .ok_or_else(|| "jump-host password is unavailable".to_string())?,
                );
            }
            AuthMethod::Key => {
                jump.passphrase = credentials
                    .retrieve_profile_secret(&profile.id, ProfileSecretKind::JumpPassphrase)?;
            }
        }
    }
    Ok(RemoteConnectionRequest {
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        auth_method,
        password,
        keychain_key_id: profile.keychain_key_id.clone(),
        private_key_data: None,
        passphrase,
        jump_host,
    })
}

fn value<'a>(output: &'a str, key: &str) -> Result<&'a str, String> {
    output
        .lines()
        .find_map(|line| line.strip_prefix(key))
        .map(str::trim)
        .ok_or_else(|| format!("remote preflight output is missing {key}"))
}

fn parse_flag(output: &str, key: &str) -> Result<bool, String> {
    match value(output, key)? {
        "1" => Ok(true),
        "0" => Ok(false),
        _ => Err(format!("remote preflight output has invalid {key}")),
    }
}

fn parse_remote_probe(output: &str) -> Result<RemoteProbeSnapshot, String> {
    if output.len() > REMOTE_STDOUT_LIMIT {
        return Err("remote preflight output exceeded the safety limit".to_string());
    }
    let os = value(output, "SSP_OS=")?.to_string();
    let architecture = value(output, "SSP_ARCH=")?.to_string();
    if os.is_empty() || os.len() > 128 || architecture.is_empty() || architecture.len() > 128 {
        return Err("remote platform identity is invalid".to_string());
    }
    let root_reachable = parse_flag(output, "SSP_ROOT=")?;
    let available_kib = value(output, "SSP_DISK_KIB=")?
        .parse::<u64>()
        .map_err(|_| "remote disk capacity is invalid".to_string())?;
    let sha256 = match value(output, "SSP_SHA256=")? {
        "none" => None,
        "sha256sum" => Some("sha256sum".to_string()),
        "shasum" => Some("shasum".to_string()),
        _ => return Err("remote checksum tool identity is invalid".to_string()),
    };
    let compression = match value(output, "SSP_COMPRESSION=")? {
        "none" => None,
        "tar+gzip" => Some("tar+gzip".to_string()),
        "tar+zstd" => Some("tar+zstd".to_string()),
        _ => return Err("remote compression tool identity is invalid".to_string()),
    };
    let current_release_id = match value(output, "SSP_CURRENT=")? {
        "" => None,
        release_id => {
            super::validate_identifier("current release id", release_id, 128)
                .map_err(|error| error.to_string())?;
            Some(release_id.to_string())
        }
    };
    let mut releases = Vec::new();
    for line in output
        .lines()
        .filter_map(|line| line.strip_prefix("SSP_RELEASE="))
    {
        if releases.len() >= 20 {
            return Err("remote release list exceeded the safety limit".to_string());
        }
        let (release_id, digest) = line
            .split_once('\t')
            .ok_or_else(|| "remote release metadata is malformed".to_string())?;
        super::validate_identifier("release id", release_id, 128)
            .map_err(|error| error.to_string())?;
        super::validate_sha256(digest).map_err(|error| error.to_string())?;
        if releases
            .iter()
            .any(|release: &DeploymentReleaseIdentity| release.release_id == release_id)
        {
            return Err("remote release metadata contains duplicates".to_string());
        }
        releases.push(DeploymentReleaseIdentity {
            release_id: release_id.to_string(),
            artifact_digest_sha256: digest.to_string(),
        });
    }
    releases.sort_by(|left, right| right.release_id.cmp(&left.release_id));
    Ok(RemoteProbeSnapshot {
        server: DeploymentPreflightServer { os, architecture },
        root_reachable,
        available_bytes: available_kib.saturating_mul(1024),
        tools: DeploymentPreflightTools {
            docker: parse_flag(output, "SSP_DOCKER=")?,
            compose: parse_flag(output, "SSP_COMPOSE=")?,
            flock: parse_flag(output, "SSP_FLOCK=")?,
            curl: parse_flag(output, "SSP_CURL=")?,
            nginx: parse_flag(output, "SSP_NGINX=")?,
            nginx_reload: parse_flag(output, "SSP_NGINX_RELOAD=")?,
            sha256,
            compression,
        },
        current_release_id,
        releases,
    })
}

fn profile_matches(left: &ProfileRow, right: &ProfileRow) -> bool {
    left.id == right.id
        && left.host == right.host
        && left.port == right.port
        && left.username == right.username
        && left.auth_method == right.auth_method
        && left.keychain_key_id == right.keychain_key_id
        && left.jump_host_config == right.jump_host_config
        && left.updated_at == right.updated_at
}

fn failure_result(
    request: &DeploymentPreflightRequest,
    status: DeploymentPreflightStatus,
    category: DeploymentPreflightFailureCategory,
    message: impl Into<String>,
) -> DeploymentPreflightResult {
    DeploymentPreflightResult {
        operation_id: request.operation_id.clone(),
        workflow_id: request.workflow_id.clone(),
        workflow_revision: None,
        artifact_reference: request.artifact_reference.clone(),
        status,
        checked_at: current_timestamp_ms(),
        source: DeploymentPreflightSource {
            kind: "gitAndSshReadOnly",
            command_set_version: COMMAND_SET_VERSION,
        },
        source_revision: None,
        target: None,
        server: None,
        remote_root: None,
        tools: None,
        current_release: None,
        rollback_releases: Vec::new(),
        checks: Vec::new(),
        plan_input: None,
        failure: Some(DeploymentPreflightFailure {
            category,
            message: message.into(),
        }),
    }
}

fn map_local_failure(
    request: &DeploymentPreflightRequest,
    failure: LocalCommandFailure,
) -> DeploymentPreflightResult {
    match failure {
        LocalCommandFailure::Cancelled => failure_result(
            request,
            DeploymentPreflightStatus::Cancelled,
            DeploymentPreflightFailureCategory::Cancelled,
            "Deployment preflight was cancelled",
        ),
        LocalCommandFailure::TimedOut => failure_result(
            request,
            DeploymentPreflightStatus::TimedOut,
            DeploymentPreflightFailureCategory::TimedOut,
            "Deployment preflight timed out",
        ),
        LocalCommandFailure::OutputLimit => failure_result(
            request,
            DeploymentPreflightStatus::Failed,
            DeploymentPreflightFailureCategory::SourceOutputLimit,
            "Local Git query exceeded the output safety limit",
        ),
        LocalCommandFailure::Failed(message) => failure_result(
            request,
            DeploymentPreflightStatus::Failed,
            DeploymentPreflightFailureCategory::SourceUnavailable,
            message,
        ),
    }
}

fn map_execution_failure(
    request: &DeploymentPreflightRequest,
    status: ExecutionStatus,
    category: Option<ExecutionErrorCategory>,
    message: Option<String>,
) -> DeploymentPreflightResult {
    if status == ExecutionStatus::Cancelled {
        return failure_result(
            request,
            DeploymentPreflightStatus::Cancelled,
            DeploymentPreflightFailureCategory::Cancelled,
            "Deployment preflight was cancelled",
        );
    }
    if status == ExecutionStatus::TimedOut {
        return failure_result(
            request,
            DeploymentPreflightStatus::TimedOut,
            DeploymentPreflightFailureCategory::TimedOut,
            "Deployment preflight timed out",
        );
    }
    let mapped = match category {
        Some(ExecutionErrorCategory::CredentialUnavailable) => {
            DeploymentPreflightFailureCategory::CredentialUnavailable
        }
        Some(ExecutionErrorCategory::HostKeyRejected) => {
            DeploymentPreflightFailureCategory::HostKeyRejected
        }
        Some(ExecutionErrorCategory::TargetMismatch | ExecutionErrorCategory::TargetNotFound) => {
            DeploymentPreflightFailureCategory::TargetChanged
        }
        Some(
            ExecutionErrorCategory::ConnectionFailed | ExecutionErrorCategory::TransportFailed,
        ) => DeploymentPreflightFailureCategory::ConnectionFailed,
        Some(ExecutionErrorCategory::OutputLimitExceeded) => {
            DeploymentPreflightFailureCategory::RemoteOutputLimit
        }
        Some(ExecutionErrorCategory::Cancelled) => DeploymentPreflightFailureCategory::Cancelled,
        Some(ExecutionErrorCategory::TimedOut) => DeploymentPreflightFailureCategory::TimedOut,
        Some(
            ExecutionErrorCategory::InvalidRequest
            | ExecutionErrorCategory::ChannelOpenFailed
            | ExecutionErrorCategory::CommandStartFailed,
        ) => DeploymentPreflightFailureCategory::RemoteCommandFailed,
        Some(ExecutionErrorCategory::WorkerStopped) | None => {
            DeploymentPreflightFailureCategory::Internal
        }
    };
    failure_result(
        request,
        DeploymentPreflightStatus::Failed,
        mapped,
        message.unwrap_or_else(|| "Deployment preflight failed".to_string()),
    )
}

fn check(
    code: &str,
    outcome: DeploymentPreflightOutcome,
    summary: impl Into<String>,
) -> DeploymentPreflightCheckSummary {
    DeploymentPreflightCheckSummary {
        code: code.to_string(),
        outcome,
        summary: summary.into(),
    }
}

fn build_checks(
    source_revision: &DeploymentFrozenSourceRevision,
    remote: &RemoteProbeSnapshot,
    current_release: Option<&DeploymentReleaseIdentity>,
    requires_http_health: bool,
    requires_nginx_reload: bool,
) -> Vec<DeploymentPreflightCheckSummary> {
    let mut checks = vec![
        check(
            "source_revision",
            if source_revision.dirty {
                DeploymentPreflightOutcome::Warning
            } else {
                DeploymentPreflightOutcome::Passed
            },
            if source_revision.dirty {
                "Source revision is valid but the working tree has local changes"
            } else {
                "Source revision is valid and the working tree is clean"
            },
        ),
        check(
            "target_identity",
            DeploymentPreflightOutcome::Passed,
            "Connection profile identity was revalidated",
        ),
        check(
            "server_platform",
            if remote.server.os == "Linux" {
                DeploymentPreflightOutcome::Passed
            } else {
                DeploymentPreflightOutcome::Blocked
            },
            format!(
                "Server platform is {} {}",
                remote.server.os, remote.server.architecture
            ),
        ),
        check(
            "remote_root",
            if remote.root_reachable {
                DeploymentPreflightOutcome::Passed
            } else {
                DeploymentPreflightOutcome::Blocked
            },
            if remote.root_reachable {
                "Remote release root is readable and searchable"
            } else {
                "Remote release root is not readable and searchable"
            },
        ),
        check(
            "disk_capacity",
            if !remote.root_reachable || remote.available_bytes == 0 {
                DeploymentPreflightOutcome::Blocked
            } else if remote.available_bytes < LOW_DISK_WARNING_BYTES {
                DeploymentPreflightOutcome::Warning
            } else {
                DeploymentPreflightOutcome::Passed
            },
            format!("Remote root has {} bytes available", remote.available_bytes),
        ),
    ];
    for (code, available, available_summary, missing_summary) in [
        (
            "docker",
            remote.tools.docker,
            "Docker is available",
            "Docker is unavailable",
        ),
        (
            "compose",
            remote.tools.compose,
            "Docker Compose is available",
            "Docker Compose is unavailable",
        ),
        (
            "flock",
            remote.tools.flock,
            "flock is available",
            "flock is unavailable",
        ),
        (
            "sha256",
            remote.tools.sha256.is_some(),
            "A SHA-256 tool is available",
            "No supported SHA-256 tool is available",
        ),
        (
            "compression",
            remote.tools.compression.is_some(),
            "A supported compression toolchain is available",
            "No supported compression toolchain is available",
        ),
    ] {
        checks.push(check(
            code,
            if available {
                DeploymentPreflightOutcome::Passed
            } else {
                DeploymentPreflightOutcome::Blocked
            },
            if available {
                available_summary
            } else {
                missing_summary
            },
        ));
    }
    if requires_http_health {
        checks.push(check(
            "curl",
            if remote.tools.curl {
                DeploymentPreflightOutcome::Passed
            } else {
                DeploymentPreflightOutcome::Blocked
            },
            if remote.tools.curl {
                "curl is available for the fixed HTTP health check"
            } else {
                "curl is unavailable for the fixed HTTP health check"
            },
        ));
    }
    if requires_nginx_reload {
        checks.push(check(
            "nginx",
            if remote.tools.nginx && remote.tools.nginx_reload {
                DeploymentPreflightOutcome::Passed
            } else {
                DeploymentPreflightOutcome::Blocked
            },
            if remote.tools.nginx && remote.tools.nginx_reload {
                "Nginx and the fixed non-interactive reload toolchain are available"
            } else {
                "Nginx or the fixed non-interactive reload toolchain is unavailable"
            },
        ));
    }
    checks.push(check(
        "release_state",
        if current_release.is_some() {
            DeploymentPreflightOutcome::Passed
        } else {
            DeploymentPreflightOutcome::Warning
        },
        if current_release.is_some() {
            "Current release metadata is valid"
        } else {
            "No current release metadata was found"
        },
    ));
    checks
}

fn validate_request(request: &DeploymentPreflightRequest) -> Result<(), String> {
    if !request.operation_id.starts_with(OPERATION_PREFIX)
        || !crate::execution::valid_operation_id(&request.operation_id)
    {
        return Err("deployment preflight operation ID is invalid".to_string());
    }
    super::validate_identifier("workflow id", &request.workflow_id, 128)
        .map_err(|error| error.to_string())?;
    if request.expected_revision == 0 {
        return Err("deployment workflow revision must be positive".to_string());
    }
    if request.artifact_reference.is_empty() || request.artifact_reference.len() > 256 {
        return Err("deployment artifact reference is invalid".to_string());
    }
    if !(super::approval::MIN_PLAN_TTL_SECONDS..=super::approval::MAX_PLAN_TTL_SECONDS)
        .contains(&request.ttl_seconds)
    {
        return Err("deployment plan lifetime is invalid".to_string());
    }
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&request.timeout_ms) {
        return Err(format!(
            "deployment preflight timeout must be between {MIN_TIMEOUT_MS} and {MAX_TIMEOUT_MS} ms"
        ));
    }
    Ok(())
}

fn load_workflow_and_profile(
    database: &Database,
    request: &DeploymentPreflightRequest,
) -> Result<(DeploymentWorkflowRecord, ProfileRow), DeploymentPreflightResult> {
    let workflow = database
        .get_deployment_workflow(&request.workflow_id)
        .map_err(|_| {
            failure_result(
                request,
                DeploymentPreflightStatus::Failed,
                DeploymentPreflightFailureCategory::Internal,
                "Failed to load deployment workflow",
            )
        })?
        .ok_or_else(|| {
            failure_result(
                request,
                DeploymentPreflightStatus::Failed,
                DeploymentPreflightFailureCategory::WorkflowNotFound,
                "Deployment workflow was not found",
            )
        })?;
    if workflow.revision != request.expected_revision {
        return Err(failure_result(
            request,
            DeploymentPreflightStatus::Failed,
            DeploymentPreflightFailureCategory::RevisionConflict,
            "Deployment workflow changed; refresh before running preflight",
        ));
    }
    if !workflow.enabled {
        return Err(failure_result(
            request,
            DeploymentPreflightStatus::Blocked,
            DeploymentPreflightFailureCategory::WorkflowDisabled,
            "Deployment workflow is disabled",
        ));
    }
    let profile = database
        .get_profile(&workflow.connection_profile_id)
        .map_err(|_| {
            failure_result(
                request,
                DeploymentPreflightStatus::Failed,
                DeploymentPreflightFailureCategory::Internal,
                "Failed to load deployment profile",
            )
        })?
        .ok_or_else(|| {
            failure_result(
                request,
                DeploymentPreflightStatus::Failed,
                DeploymentPreflightFailureCategory::ProfileNotFound,
                "Deployment connection profile was not found",
            )
        })?;
    Ok((workflow, profile))
}

pub(crate) fn run_deployment_preflight(
    database: &Database,
    credentials: &CredentialManager,
    cancellations: &crate::execution::ExecutionCancellationRegistry,
    known_hosts_path: &Path,
    artifact_staging_root: &Path,
    request: DeploymentPreflightRequest,
) -> DeploymentPreflightResult {
    if let Err(message) = validate_request(&request) {
        return failure_result(
            &request,
            DeploymentPreflightStatus::Failed,
            DeploymentPreflightFailureCategory::InvalidRequest,
            message,
        );
    }
    let started_at = current_timestamp_ms();
    let started = Instant::now();
    let deadline = started + Duration::from_millis(request.timeout_ms);
    let cancellation = match cancellations.register(request.operation_id.clone()) {
        Ok(cancellation) => cancellation,
        Err(error) => {
            return failure_result(
                &request,
                DeploymentPreflightStatus::Failed,
                DeploymentPreflightFailureCategory::InvalidRequest,
                error.to_string(),
            )
        }
    };

    let artifact = match super::artifact::verify_deployment_artifact(
        artifact_staging_root,
        &request.artifact_reference,
    ) {
        Ok(artifact) => artifact,
        Err(_) => {
            return failure_result(
                &request,
                DeploymentPreflightStatus::Failed,
                DeploymentPreflightFailureCategory::ArtifactInvalid,
                "Deployment artifact failed runtime integrity verification",
            )
        }
    };

    let (workflow, profile) = match load_workflow_and_profile(database, &request) {
        Ok(values) => values,
        Err(result) => return result,
    };
    if artifact.manifest.workflow_id != workflow.id
        || artifact.manifest.workflow_revision != workflow.revision
    {
        return failure_result(
            &request,
            DeploymentPreflightStatus::Failed,
            DeploymentPreflightFailureCategory::ArtifactInvalid,
            "Deployment artifact does not match the frozen workflow revision",
        );
    }
    let target_snapshot = match target_identity(&profile) {
        Ok(target) => target,
        Err(message) => {
            return failure_result(
                &request,
                DeploymentPreflightStatus::Failed,
                DeploymentPreflightFailureCategory::TargetChanged,
                message,
            )
        }
    };
    let source_revision = match inspect_source(
        &workflow.definition.source_directory,
        &cancellation,
        deadline,
    ) {
        Ok(source) => source,
        Err(failure) => return map_local_failure(&request, failure),
    };
    if source_revision != artifact.manifest.source_revision {
        return failure_result(
            &request,
            DeploymentPreflightStatus::Failed,
            DeploymentPreflightFailureCategory::SourceChanged,
            "Git revision or dirty state changed after artifact creation",
        );
    }
    let connection = match connection_for_profile(credentials, &profile) {
        Ok(connection) => connection,
        Err(message) => {
            return failure_result(
                &request,
                DeploymentPreflightStatus::Failed,
                DeploymentPreflightFailureCategory::CredentialUnavailable,
                message,
            )
        }
    };
    let frozen_target = match FrozenTargetIdentity::from_connection(profile.id.clone(), &connection)
    {
        Ok(target) => target,
        Err(error) => {
            return failure_result(
                &request,
                DeploymentPreflightStatus::Failed,
                DeploymentPreflightFailureCategory::InvalidRequest,
                error.message,
            )
        }
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining < Duration::from_secs(1) {
        cancellation.try_timeout();
        return map_local_failure(&request, LocalCommandFailure::TimedOut);
    }
    let command = remote_probe_command(&workflow.definition.target.remote_root);
    let reviewed_command = match ReviewedSshCommand::new(
        command,
        format!("{COMMAND_SET_VERSION} read-only remote probe"),
        Vec::new(),
    ) {
        Ok(command) => command,
        Err(error) => {
            return failure_result(
                &request,
                DeploymentPreflightStatus::Failed,
                DeploymentPreflightFailureCategory::Internal,
                error.message,
            )
        }
    };
    let output_policy = match ExecutionOutputPolicy::new(
        REMOTE_STDOUT_LIMIT,
        REMOTE_STDERR_LIMIT,
        REMOTE_TOTAL_LIMIT,
    ) {
        Ok(policy) => policy,
        Err(error) => {
            return failure_result(
                &request,
                DeploymentPreflightStatus::Failed,
                DeploymentPreflightFailureCategory::Internal,
                error.message,
            )
        }
    };
    let execution = execute_reviewed_ssh_command_with_handle(
        database,
        credentials,
        known_hosts_path,
        ReviewedSshExecutionRequest {
            operation_id: request.operation_id.clone(),
            target: frozen_target,
            connection,
            command: reviewed_command,
            timeout: remaining,
            output_policy,
        },
        cancellation,
        started_at,
    );
    if execution.status != ExecutionStatus::Completed {
        return map_execution_failure(
            &request,
            execution.status,
            execution.error_category,
            execution.error,
        );
    }
    if execution.exit_code != Some(0) {
        return failure_result(
            &request,
            DeploymentPreflightStatus::Failed,
            DeploymentPreflightFailureCategory::RemoteCommandFailed,
            format!(
                "Read-only remote preflight exited with status {}",
                execution.exit_code.unwrap_or(-1)
            ),
        );
    }
    if execution.stdout_truncated || execution.stderr_truncated {
        return failure_result(
            &request,
            DeploymentPreflightStatus::Failed,
            DeploymentPreflightFailureCategory::RemoteOutputLimit,
            "Remote preflight output exceeded the capture limit",
        );
    }
    let remote = match parse_remote_probe(&execution.stdout) {
        Ok(remote) => remote,
        Err(message) => {
            return failure_result(
                &request,
                DeploymentPreflightStatus::Failed,
                DeploymentPreflightFailureCategory::InvalidRemoteOutput,
                message,
            )
        }
    };

    let (current_workflow, current_profile) = match load_workflow_and_profile(database, &request) {
        Ok(values) => values,
        Err(mut result) => {
            result.failure = Some(DeploymentPreflightFailure {
                category: DeploymentPreflightFailureCategory::TargetChanged,
                message: "Deployment workflow or profile changed during preflight".to_string(),
            });
            return result;
        }
    };
    if current_workflow != workflow || !profile_matches(&current_profile, &profile) {
        return failure_result(
            &request,
            DeploymentPreflightStatus::Failed,
            DeploymentPreflightFailureCategory::TargetChanged,
            "Deployment workflow or profile changed during preflight",
        );
    }

    let current_release = remote
        .current_release_id
        .as_ref()
        .and_then(|release_id| {
            remote
                .releases
                .iter()
                .find(|release| &release.release_id == release_id)
        })
        .cloned();
    let rollback_releases = remote
        .releases
        .iter()
        .filter(|release| Some(&release.release_id) != remote.current_release_id.as_ref())
        .cloned()
        .collect::<Vec<_>>();
    let checks = build_checks(
        &source_revision,
        &remote,
        current_release.as_ref(),
        workflow.definition.health_check.is_some(),
        workflow.definition.reload_nginx_after_healthy,
    );
    let checked_at = current_timestamp_ms();
    let preflight = DeploymentPreflightSummary {
        checked_at,
        checks: checks.clone(),
    };
    let blocked = checks
        .iter()
        .any(|check| check.outcome == DeploymentPreflightOutcome::Blocked);
    let plan_input = (!blocked).then(|| DeploymentPlanCreateInput {
        workflow_id: workflow.id.clone(),
        expected_revision: workflow.revision,
        source_run_id: None,
        operation_kind: DeploymentOperationKind::Deploy,
        trigger_kind: DeploymentTriggerKind::Manual,
        artifact_reference: request.artifact_reference.clone(),
        source_revision: source_revision.clone(),
        target: target_snapshot.clone(),
        current_release: current_release.clone(),
        target_release: artifact.target_release(),
        // Automatic restore is bound to the exact release that is active at
        // approval time, never to an arbitrary older retained release.
        rollback_release: current_release.clone(),
        preflight,
        ttl_seconds: request.ttl_seconds,
    });

    DeploymentPreflightResult {
        operation_id: request.operation_id.clone(),
        workflow_id: workflow.id,
        workflow_revision: Some(workflow.revision),
        artifact_reference: request.artifact_reference.clone(),
        status: if blocked {
            DeploymentPreflightStatus::Blocked
        } else {
            DeploymentPreflightStatus::Passed
        },
        checked_at,
        source: DeploymentPreflightSource {
            kind: "gitAndSshReadOnly",
            command_set_version: COMMAND_SET_VERSION,
        },
        source_revision: Some(source_revision),
        target: Some(target_snapshot),
        server: Some(remote.server),
        remote_root: Some(DeploymentPreflightRemoteRoot {
            path: workflow.definition.target.remote_root,
            reachable: remote.root_reachable,
            available_bytes: remote.available_bytes,
        }),
        tools: Some(remote.tools),
        current_release,
        rollback_releases,
        checks,
        plan_input,
        failure: None,
    }
}

pub(crate) fn valid_preflight_operation_id(operation_id: &str) -> bool {
    operation_id.starts_with(OPERATION_PREFIX) && crate::execution::valid_operation_id(operation_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ProfileAuthMethod;

    fn request() -> DeploymentPreflightRequest {
        DeploymentPreflightRequest {
            operation_id: "deployment-preflight:test".to_string(),
            workflow_id: "workflow-1".to_string(),
            expected_revision: 1,
            artifact_reference: format!(
                "deployment-artifact-v1:{}:{}",
                "b".repeat(64),
                "c".repeat(64)
            ),
            ttl_seconds: 600,
            timeout_ms: 30_000,
        }
    }

    fn remote_output(root: bool) -> String {
        format!(
            "SSP_OS=Linux\nSSP_ARCH=x86_64\nSSP_ROOT={}\nSSP_DISK_KIB=1024\nSSP_DOCKER=1\nSSP_COMPOSE=1\nSSP_FLOCK=1\nSSP_CURL=1\nSSP_NGINX=1\nSSP_NGINX_RELOAD=1\nSSP_SHA256=sha256sum\nSSP_COMPRESSION=tar+gzip\nSSP_CURRENT=release-2\nSSP_RELEASE=release-1\t{}\nSSP_RELEASE=release-2\t{}\n",
            u8::from(root),
            "a".repeat(64),
            "b".repeat(64),
        )
    }

    #[test]
    fn remote_command_is_fixed_and_quotes_the_only_strict_parameter() {
        let command = remote_probe_command("/srv/app'; printf INJECTED; '");
        assert!(command.starts_with("sh -c '"));
        assert!(command
            .contains("shellspan-deployment-preflight '/srv/app'\\''; printf INJECTED; '\\'''"));
        assert_eq!(command.matches("SSP_DOCKER").count(), 2);
        for forbidden in [
            " mkdir ",
            " rm ",
            " mv ",
            " cp ",
            " tee ",
            "docker load",
            "compose up",
        ] {
            assert!(!REMOTE_PROBE_SCRIPT.contains(forbidden));
        }
        assert!(REMOTE_PROBE_SCRIPT.contains(RELEASE_DIGEST_FILE));
    }

    #[test]
    fn remote_wire_shape_is_bounded_and_rejects_injected_release_metadata() {
        let parsed = parse_remote_probe(&remote_output(true)).unwrap();
        assert_eq!(parsed.server.os, "Linux");
        assert_eq!(parsed.current_release_id.as_deref(), Some("release-2"));
        assert_eq!(parsed.releases.len(), 2);

        let injected = remote_output(true).replace("release-1", "release-1;rm");
        assert!(parse_remote_probe(&injected).is_err());
        assert!(parse_remote_probe(&"x".repeat(REMOTE_STDOUT_LIMIT + 1)).is_err());
    }

    #[test]
    fn missing_required_remote_capabilities_are_explicitly_blocked() {
        let parsed = parse_remote_probe(&remote_output(false)).unwrap();
        let source = DeploymentFrozenSourceRevision {
            revision: "a".repeat(40),
            dirty: false,
        };
        let checks = build_checks(&source, &parsed, None, false, false);
        assert_eq!(
            checks
                .iter()
                .find(|check| check.code == "remote_root")
                .unwrap()
                .outcome,
            DeploymentPreflightOutcome::Blocked
        );
    }

    #[test]
    fn health_and_nginx_capabilities_are_blocking_only_when_selected() {
        let output = remote_output(true)
            .replace("SSP_CURL=1", "SSP_CURL=0")
            .replace("SSP_NGINX_RELOAD=1", "SSP_NGINX_RELOAD=0");
        let parsed = parse_remote_probe(&output).unwrap();
        let source = DeploymentFrozenSourceRevision {
            revision: "a".repeat(40),
            dirty: false,
        };
        let optional = build_checks(&source, &parsed, None, false, false);
        assert!(optional
            .iter()
            .all(|check| check.code != "curl" && check.code != "nginx"));
        let required = build_checks(&source, &parsed, None, true, true);
        assert_eq!(
            required
                .iter()
                .find(|check| check.code == "curl")
                .unwrap()
                .outcome,
            DeploymentPreflightOutcome::Blocked
        );
        assert_eq!(
            required
                .iter()
                .find(|check| check.code == "nginx")
                .unwrap()
                .outcome,
            DeploymentPreflightOutcome::Blocked
        );
    }

    #[test]
    fn operation_ids_are_namespaced_and_wire_values_are_stable() {
        assert!(valid_preflight_operation_id("deployment-preflight:123"));
        assert!(!valid_preflight_operation_id("execution:123"));
        assert_eq!(
            serde_json::to_value(DeploymentPreflightFailureCategory::RemoteOutputLimit).unwrap(),
            "remoteOutputLimit"
        );
        assert_eq!(
            serde_json::to_value(DeploymentPreflightStatus::TimedOut).unwrap(),
            "timedOut"
        );
    }

    #[test]
    fn cancellation_timeout_and_output_limit_remain_distinct() {
        let cancelled = map_local_failure(&request(), LocalCommandFailure::Cancelled);
        assert_eq!(cancelled.status, DeploymentPreflightStatus::Cancelled);
        assert_eq!(
            cancelled.failure.unwrap().category,
            DeploymentPreflightFailureCategory::Cancelled
        );

        let timed_out = map_local_failure(&request(), LocalCommandFailure::TimedOut);
        assert_eq!(timed_out.status, DeploymentPreflightStatus::TimedOut);
        assert_eq!(
            timed_out.failure.unwrap().category,
            DeploymentPreflightFailureCategory::TimedOut
        );

        let limited = map_local_failure(&request(), LocalCommandFailure::OutputLimit);
        assert_eq!(limited.status, DeploymentPreflightStatus::Failed);
        assert_eq!(
            limited.failure.unwrap().category,
            DeploymentPreflightFailureCategory::SourceOutputLimit
        );
    }

    #[test]
    fn bounded_reader_drains_without_retaining_excess_output() {
        let read = read_bounded(std::io::Cursor::new(vec![b'x'; 8_192]), 1_024).unwrap();
        assert_eq!(read.bytes.len(), 1_024);
        assert!(read.exceeded);
    }

    #[test]
    fn profile_revision_or_identity_drift_fails_the_snapshot_comparison() {
        let profile = ProfileRow {
            id: "profile-1".to_string(),
            name: "Production".to_string(),
            host: "example.test".to_string(),
            port: 22,
            username: "deploy".to_string(),
            auth_method: ProfileAuthMethod::Password,
            keychain_key_id: None,
            jump_host_config: None,
            organization_json: None,
            created_at: 1,
            updated_at: 1,
        };
        let mut changed = profile.clone();
        changed.updated_at = 2;
        assert!(!profile_matches(&profile, &changed));
        changed.updated_at = 1;
        changed.host = "other.example.test".to_string();
        assert!(!profile_matches(&profile, &changed));
    }

    #[test]
    fn request_wire_is_closed_and_has_no_command_field() {
        let wire = serde_json::json!({
            "operationId": "deployment-preflight:test",
            "workflowId": "workflow-1",
            "expectedRevision": 1,
            "artifactReference": format!(
                "deployment-artifact-v1:{}:{}",
                "b".repeat(64),
                "c".repeat(64)
            ),
            "ttlSeconds": 600,
            "timeoutMs": 30_000
        });
        let parsed: DeploymentPreflightRequest = serde_json::from_value(wire.clone()).unwrap();
        assert!(validate_request(&parsed).is_ok());
        let mut injected = wire;
        injected["command"] = serde_json::Value::String("docker compose up".to_string());
        assert!(serde_json::from_value::<DeploymentPreflightRequest>(injected).is_err());
    }
}
