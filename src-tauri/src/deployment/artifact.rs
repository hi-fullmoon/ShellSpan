//! Fixed-purpose local Docker Buildx artifact production.
//!
//! Workflow data selects only reviewed arguments. No caller-controlled command,
//! executable, shell, environment variable, or Docker argument tail crosses
//! this boundary.

use super::{
    DeploymentArtifactBuilderKind, DeploymentArtifactCompression, DeploymentFrozenSourceRevision,
    DeploymentReleaseIdentity, DeploymentWorkflowRecord,
};
use crate::db::{current_timestamp_ms, Database};
use crate::execution::{
    redact_known_secrets, CancellationHandle, ExecutionCancellationRegistry, ExecutionTerminalState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

pub(crate) const ARTIFACT_PROGRESS_EVENT: &str = "deployment-artifact-build-progress";
const OPERATION_PREFIX: &str = "deployment-artifact-build:";
const ARTIFACT_REFERENCE_PREFIX: &str = "deployment-artifact-v1";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 2 * 60 * 60 * 1_000;
const MAX_COMMAND_STDOUT_BYTES: usize = 384 * 1024;
const MAX_COMMAND_STDERR_BYTES: usize = 128 * 1024;
const MAX_COMMAND_TOTAL_BYTES: usize = 512 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const MAX_COMPOSE_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_COMPOSE_TOTAL_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 128 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentArtifactSourceSnapshotRequest {
    pub workflow_id: String,
    pub expected_revision: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentArtifactBuildRequest {
    pub operation_id: String,
    pub workflow_id: String,
    pub expected_revision: u32,
    pub source_revision: DeploymentFrozenSourceRevision,
    pub builder_kind: DeploymentArtifactBuilderKind,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentArtifactBuildStep {
    Validating,
    CheckingSource,
    DetectingTools,
    BuildingImage,
    InspectingImage,
    SavingImage,
    CompressingArchive,
    WritingManifest,
    VerifyingArtifact,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentArtifactBuildProgress {
    pub operation_id: String,
    pub sequence: u32,
    pub step: DeploymentArtifactBuildStep,
    pub completed_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentArtifactBuildStatus {
    Succeeded,
    Cancelled,
    TimedOut,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentArtifactBuildFailureCategory {
    InvalidRequest,
    WorkflowNotFound,
    RevisionConflict,
    WorkflowDisabled,
    SourceUnavailable,
    SourceChanged,
    SourceDirty,
    PathBoundary,
    DockerUnavailable,
    BuildxUnavailable,
    CompressorUnavailable,
    BuildFailed,
    InspectFailed,
    SaveFailed,
    CompressionFailed,
    OutputLimit,
    Cancelled,
    TimedOut,
    ArtifactConflict,
    ArtifactIo,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentArtifactBuildFailure {
    pub category: DeploymentArtifactBuildFailureCategory,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentArtifactArchiveManifest {
    pub file_name: String,
    pub compression: DeploymentArtifactCompression,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentArtifactImageManifest {
    pub repository: String,
    pub tag: String,
    pub image_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentArtifactComposeFileManifest {
    pub path: String,
    pub file_name: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentArtifactManifest {
    pub schema_version: u32,
    pub content_identity_sha256: String,
    pub workflow_id: String,
    pub workflow_revision: u32,
    pub source_revision: DeploymentFrozenSourceRevision,
    pub release_id: String,
    pub platform: String,
    pub image: DeploymentArtifactImageManifest,
    pub archive: DeploymentArtifactArchiveManifest,
    pub compose_files: Vec<DeploymentArtifactComposeFileManifest>,
    pub created_at: i64,
    pub manifest_digest_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnsignedDeploymentArtifactManifest<'a> {
    schema_version: u32,
    content_identity_sha256: &'a str,
    workflow_id: &'a str,
    workflow_revision: u32,
    source_revision: &'a DeploymentFrozenSourceRevision,
    release_id: &'a str,
    platform: &'a str,
    image: &'a DeploymentArtifactImageManifest,
    archive: &'a DeploymentArtifactArchiveManifest,
    compose_files: &'a [DeploymentArtifactComposeFileManifest],
    created_at: i64,
}

impl DeploymentArtifactManifest {
    fn unsigned(&self) -> UnsignedDeploymentArtifactManifest<'_> {
        UnsignedDeploymentArtifactManifest {
            schema_version: self.schema_version,
            content_identity_sha256: &self.content_identity_sha256,
            workflow_id: &self.workflow_id,
            workflow_revision: self.workflow_revision,
            source_revision: &self.source_revision,
            release_id: &self.release_id,
            platform: &self.platform,
            image: &self.image,
            archive: &self.archive,
            compose_files: &self.compose_files,
            created_at: self.created_at,
        }
    }

    fn canonical_unsigned_bytes(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&self.unsigned())
            .map_err(|error| format!("failed to canonicalize artifact manifest: {error}"))
    }

    fn expected_digest(&self) -> Result<String, String> {
        Ok(sha256_bytes(&self.canonical_unsigned_bytes()?))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentArtifactBuildResult {
    pub operation_id: String,
    pub workflow_id: String,
    pub workflow_revision: Option<u32>,
    pub builder_kind: DeploymentArtifactBuilderKind,
    pub status: DeploymentArtifactBuildStatus,
    pub source_revision: Option<DeploymentFrozenSourceRevision>,
    pub release_id: Option<String>,
    pub artifact_digest_sha256: Option<String>,
    pub artifact_bytes: Option<u64>,
    pub artifact_reference: Option<String>,
    pub manifest: Option<DeploymentArtifactManifest>,
    pub reused: bool,
    pub failure: Option<DeploymentArtifactBuildFailure>,
}

#[derive(Debug, Clone)]
pub(crate) struct VerifiedDeploymentArtifact {
    pub(crate) artifact_reference: String,
    pub(crate) manifest: DeploymentArtifactManifest,
    directory: PathBuf,
}

impl VerifiedDeploymentArtifact {
    pub(crate) fn target_release(&self) -> DeploymentReleaseIdentity {
        DeploymentReleaseIdentity {
            release_id: self.manifest.release_id.clone(),
            artifact_digest_sha256: self.manifest.archive.sha256.clone(),
        }
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactContentIdentity<'a> {
    version: u32,
    workflow_id: &'a str,
    workflow_revision: u32,
    source_revision: &'a DeploymentFrozenSourceRevision,
    builder_kind: DeploymentArtifactBuilderKind,
    context: &'a str,
    dockerfile: &'a str,
    platform: &'a str,
    image_repository: &'a str,
    compression: DeploymentArtifactCompression,
    compose_files: &'a [String],
}

#[derive(Debug, Clone)]
struct FixedCommand {
    program: &'static str,
    args: Vec<OsString>,
    cwd: PathBuf,
    env: Vec<(&'static str, String)>,
    stdout_file: Option<PathBuf>,
    output_file_limit: Option<(PathBuf, u64)>,
}

impl FixedCommand {
    fn new(program: &'static str, cwd: &Path, args: impl IntoIterator<Item = OsString>) -> Self {
        Self {
            program,
            args: args.into_iter().collect(),
            cwd: cwd.to_path_buf(),
            env: Vec::new(),
            stdout_file: None,
            output_file_limit: None,
        }
    }
}

#[derive(Debug, Clone)]
struct FixedCommandOutput {
    exit_code: Option<i32>,
    stdout: String,
    #[allow(dead_code, reason = "kept bounded and redacted for diagnostics/tests")]
    stderr: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FixedCommandFailureKind {
    Start,
    Cancelled,
    TimedOut,
    OutputLimit,
    Io,
}

#[derive(Debug, Clone)]
struct FixedCommandFailure {
    kind: FixedCommandFailureKind,
    message: String,
}

trait ArtifactCommandExecutor: Send + Sync {
    fn execute(
        &self,
        command: &FixedCommand,
        cancellation: &CancellationHandle,
        deadline: Instant,
    ) -> Result<FixedCommandOutput, FixedCommandFailure>;
}

#[derive(Default)]
struct NativeArtifactCommandExecutor;

enum ProcessStream {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    StdoutClosed,
    StderrClosed,
}

fn spawn_output_reader(
    mut reader: impl Read + Send + 'static,
    sender: mpsc::SyncSender<ProcessStream>,
    stdout: bool,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let item = if stdout {
                        ProcessStream::Stdout(buffer[..count].to_vec())
                    } else {
                        ProcessStream::Stderr(buffer[..count].to_vec())
                    };
                    if sender.send(item).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = sender.send(if stdout {
            ProcessStream::StdoutClosed
        } else {
            ProcessStream::StderrClosed
        });
    });
}

#[cfg(not(target_os = "windows"))]
struct ProcessContainment;

#[cfg(not(target_os = "windows"))]
impl ProcessContainment {
    fn attach(_child: &mut Child) -> Result<Self, String> {
        Ok(Self)
    }

    fn terminate(&self, child: &mut Child) {
        #[cfg(unix)]
        // SAFETY: the child is placed in a dedicated process group before
        // spawn, so the negative PID addresses only this owned process tree.
        unsafe {
            let _ = libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        #[cfg(not(unix))]
        let _ = child.kill();
    }
}

#[cfg(target_os = "windows")]
struct ProcessContainment {
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
// SAFETY: the wrapper uniquely owns the kernel job handle.
unsafe impl Send for ProcessContainment {}

#[cfg(target_os = "windows")]
impl ProcessContainment {
    fn attach(child: &mut Child) -> Result<Self, String> {
        use std::mem::{size_of, zeroed};
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(format!(
                "failed to create artifact process job: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        let assigned = configured != 0
            && unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as _) } != 0;
        if !assigned {
            let error = std::io::Error::last_os_error();
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return Err(format!("failed to contain artifact process tree: {error}"));
        }
        Ok(Self { job })
    }

    fn terminate(&self, _child: &mut Child) {
        unsafe {
            let _ = windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for ProcessContainment {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.job) };
    }
}

fn safe_environment(command: &mut Command) {
    command.env_clear();
    const SAFE_NAMES: &[&str] = &[
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TMPDIR",
        "TMP",
        "TEMP",
        "XDG_RUNTIME_DIR",
        "DOCKER_CONFIG",
    ];
    for name in SAFE_NAMES {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.env("LC_ALL", "C");
    // The artifact builder is local-only. Ignore caller environment overrides
    // that could silently redirect Docker to a remote daemon.
    command.env("DOCKER_CONTEXT", "default");
}

fn known_environment_secrets() -> Vec<String> {
    std::env::vars()
        .filter(|(name, value)| {
            let name = name.to_ascii_uppercase();
            value.len() >= 4
                && (name.contains("PASSWORD")
                    || name.contains("PASSPHRASE")
                    || name.contains("TOKEN")
                    || name.contains("SECRET")
                    || name.ends_with("_KEY"))
        })
        .map(|(_, value)| value)
        .collect()
}

impl ArtifactCommandExecutor for NativeArtifactCommandExecutor {
    fn execute(
        &self,
        specification: &FixedCommand,
        cancellation: &CancellationHandle,
        deadline: Instant,
    ) -> Result<FixedCommandOutput, FixedCommandFailure> {
        match cancellation.terminal_state() {
            ExecutionTerminalState::Cancelled => {
                return Err(command_failure(
                    FixedCommandFailureKind::Cancelled,
                    "operation cancelled",
                ))
            }
            ExecutionTerminalState::TimedOut => {
                return Err(command_failure(
                    FixedCommandFailureKind::TimedOut,
                    "operation timed out",
                ))
            }
            ExecutionTerminalState::Finished => {
                return Err(command_failure(
                    FixedCommandFailureKind::Io,
                    "operation ended unexpectedly",
                ))
            }
            ExecutionTerminalState::Running => {}
        }
        if Instant::now() >= deadline {
            cancellation.try_timeout();
            return Err(command_failure(
                FixedCommandFailureKind::TimedOut,
                "operation timed out",
            ));
        }

        let mut command = Command::new(specification.program);
        command
            .args(&specification.args)
            .current_dir(&specification.cwd)
            .stdin(Stdio::null())
            .stderr(Stdio::piped());
        safe_environment(&mut command);
        for (name, value) in &specification.env {
            command.env(name, value);
        }
        let captures_stdout = specification.stdout_file.is_none();
        if let Some(path) = &specification.stdout_file {
            let file = secure_create_file(path).map_err(|error| {
                command_failure(
                    FixedCommandFailureKind::Io,
                    format!("failed to prepare command output: {error}"),
                )
            })?;
            command.stdout(Stdio::from(file));
        } else {
            command.stdout(Stdio::piped());
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|error| {
            command_failure(
                FixedCommandFailureKind::Start,
                format!("failed to start reviewed local tool: {error}"),
            )
        })?;
        let containment = ProcessContainment::attach(&mut child).map_err(|message| {
            let _ = child.kill();
            let _ = child.wait();
            command_failure(FixedCommandFailureKind::Start, message)
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            command_failure(
                FixedCommandFailureKind::Io,
                "failed to capture tool diagnostics",
            )
        })?;
        let (sender, receiver) = mpsc::sync_channel(32);
        spawn_output_reader(stderr, sender.clone(), false);
        if captures_stdout {
            let stdout = child.stdout.take().ok_or_else(|| {
                command_failure(FixedCommandFailureKind::Io, "failed to capture tool output")
            })?;
            spawn_output_reader(stdout, sender, true);
        }

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut stdout_bytes = 0_usize;
        let mut stderr_bytes = 0_usize;
        let mut closed_streams = 0_u8;
        let expected_closed_streams = if captures_stdout { 2 } else { 1 };
        let exit_status = loop {
            while let Ok(item) = receiver.try_recv() {
                match item {
                    ProcessStream::Stdout(bytes) => {
                        stdout_bytes = stdout_bytes.saturating_add(bytes.len());
                        if stdout.len() < MAX_COMMAND_STDOUT_BYTES {
                            let keep = (MAX_COMMAND_STDOUT_BYTES - stdout.len()).min(bytes.len());
                            stdout.extend_from_slice(&bytes[..keep]);
                        }
                    }
                    ProcessStream::Stderr(bytes) => {
                        stderr_bytes = stderr_bytes.saturating_add(bytes.len());
                        if stderr.len() < MAX_COMMAND_STDERR_BYTES {
                            let keep = (MAX_COMMAND_STDERR_BYTES - stderr.len()).min(bytes.len());
                            stderr.extend_from_slice(&bytes[..keep]);
                        }
                    }
                    ProcessStream::StdoutClosed | ProcessStream::StderrClosed => {
                        closed_streams = closed_streams.saturating_add(1)
                    }
                }
            }
            if stdout_bytes > MAX_COMMAND_STDOUT_BYTES
                || stderr_bytes > MAX_COMMAND_STDERR_BYTES
                || stdout_bytes.saturating_add(stderr_bytes) > MAX_COMMAND_TOTAL_BYTES
            {
                containment.terminate(&mut child);
                let _ = child.wait();
                return Err(command_failure(
                    FixedCommandFailureKind::OutputLimit,
                    "reviewed local tool output exceeded the safety limit",
                ));
            }
            if let Some((path, limit)) = &specification.output_file_limit {
                if fs::metadata(path)
                    .map(|metadata| metadata.len() > *limit)
                    .unwrap_or(false)
                {
                    containment.terminate(&mut child);
                    let _ = child.wait();
                    return Err(command_failure(
                        FixedCommandFailureKind::OutputLimit,
                        "artifact exceeded the safety size limit",
                    ));
                }
            }
            match cancellation.terminal_state() {
                ExecutionTerminalState::Cancelled => {
                    containment.terminate(&mut child);
                    let _ = child.wait();
                    return Err(command_failure(
                        FixedCommandFailureKind::Cancelled,
                        "operation cancelled",
                    ));
                }
                ExecutionTerminalState::TimedOut => {
                    containment.terminate(&mut child);
                    let _ = child.wait();
                    return Err(command_failure(
                        FixedCommandFailureKind::TimedOut,
                        "operation timed out",
                    ));
                }
                ExecutionTerminalState::Finished => {
                    containment.terminate(&mut child);
                    let _ = child.wait();
                    return Err(command_failure(
                        FixedCommandFailureKind::Io,
                        "operation ended unexpectedly",
                    ));
                }
                ExecutionTerminalState::Running => {}
            }
            if Instant::now() >= deadline {
                cancellation.try_timeout();
                containment.terminate(&mut child);
                let _ = child.wait();
                return Err(command_failure(
                    FixedCommandFailureKind::TimedOut,
                    "operation timed out",
                ));
            }
            match child.try_wait() {
                Ok(Some(status)) if closed_streams >= expected_closed_streams => break status,
                Ok(Some(_)) | Ok(None) => thread::sleep(POLL_INTERVAL),
                Err(error) => {
                    containment.terminate(&mut child);
                    let _ = child.wait();
                    return Err(command_failure(
                        FixedCommandFailureKind::Io,
                        format!("failed to wait for reviewed local tool: {error}"),
                    ));
                }
            }
        };
        if let Some(path) = &specification.stdout_file {
            File::open(path)
                .and_then(|file| file.sync_all())
                .map_err(|error| {
                    command_failure(
                        FixedCommandFailureKind::Io,
                        format!("failed to sync command output: {error}"),
                    )
                })?;
            set_file_mode(path)?;
        }
        let secrets = known_environment_secrets();
        Ok(FixedCommandOutput {
            exit_code: exit_status.code(),
            stdout: redact_known_secrets(&String::from_utf8_lossy(&stdout), &secrets),
            stderr: redact_known_secrets(&String::from_utf8_lossy(&stderr), &secrets),
        })
    }
}

fn command_failure(
    kind: FixedCommandFailureKind,
    message: impl Into<String>,
) -> FixedCommandFailure {
    FixedCommandFailure {
        kind,
        message: message.into(),
    }
}

fn validate_source_revision(source: &DeploymentFrozenSourceRevision) -> Result<(), String> {
    if !matches!(source.revision.len(), 40 | 64)
        || !source
            .revision
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
    {
        return Err("source revision must be a lowercase Git object digest".into());
    }
    Ok(())
}

fn run_checked(
    executor: &dyn ArtifactCommandExecutor,
    command: &FixedCommand,
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> Result<FixedCommandOutput, FixedCommandFailure> {
    let output = executor.execute(command, cancellation, deadline)?;
    if output.exit_code == Some(0) {
        Ok(output)
    } else {
        Err(command_failure(
            FixedCommandFailureKind::Io,
            "reviewed local tool returned a non-zero status",
        ))
    }
}

fn inspect_source_with_executor(
    workflow: &DeploymentWorkflowRecord,
    executor: &dyn ArtifactCommandExecutor,
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> Result<DeploymentFrozenSourceRevision, FixedCommandFailure> {
    let requested_root = PathBuf::from(&workflow.definition.source_directory);
    let canonical_root = fs::canonicalize(&requested_root).map_err(|error| {
        command_failure(
            FixedCommandFailureKind::Io,
            format!("deployment source directory is unavailable: {error}"),
        )
    })?;
    if canonical_root != requested_root {
        return Err(command_failure(
            FixedCommandFailureKind::Io,
            "deployment source directory must already be canonical",
        ));
    }
    let git = |args: &[&str]| {
        let mut command = FixedCommand::new(
            "git",
            &canonical_root,
            args.iter().map(|value| OsString::from(*value)),
        );
        command.env.push(("GIT_OPTIONAL_LOCKS", "0".into()));
        run_checked(executor, &command, cancellation, deadline)
    };
    let top = git(&["rev-parse", "--show-toplevel"])?;
    let discovered_root = fs::canonicalize(top.stdout.trim()).map_err(|_| {
        command_failure(
            FixedCommandFailureKind::Io,
            "Git returned an invalid project root",
        )
    })?;
    if discovered_root != canonical_root {
        return Err(command_failure(
            FixedCommandFailureKind::Io,
            "deployment source must be the frozen Git project root",
        ));
    }
    let revision = git(&["rev-parse", "--verify", "HEAD^{commit}"])?
        .stdout
        .trim()
        .to_string();
    let status = git(&[
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
        "--no-renames",
    ])?;
    let source = DeploymentFrozenSourceRevision {
        revision,
        dirty: !status.stdout.is_empty(),
    };
    validate_source_revision(&source)
        .map_err(|message| command_failure(FixedCommandFailureKind::Io, message))?;
    Ok(source)
}

pub(crate) fn snapshot_deployment_artifact_source(
    database: &Database,
    request: DeploymentArtifactSourceSnapshotRequest,
) -> Result<DeploymentFrozenSourceRevision, String> {
    super::validate_identifier("workflow id", &request.workflow_id, 128)
        .map_err(|error| error.to_string())?;
    if request.expected_revision == 0 {
        return Err("deployment workflow expected revision must be positive".into());
    }
    let workflow = database
        .get_deployment_workflow(&request.workflow_id)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_NOT_FOUND".to_string())?;
    if workflow.revision != request.expected_revision {
        return Err("REVISION_CONFLICT".into());
    }
    if !workflow.enabled {
        return Err("DEPLOYMENT_WORKFLOW_DISABLED".into());
    }
    let registry = ExecutionCancellationRegistry::default();
    let cancellation = registry
        .register(format!(
            "{OPERATION_PREFIX}snapshot-{}",
            uuid::Uuid::new_v4()
        ))
        .map_err(|error| error.to_string())?;
    inspect_source_with_executor(
        &workflow,
        &NativeArtifactCommandExecutor,
        &cancellation,
        Instant::now() + Duration::from_secs(15),
    )
    .map_err(|error| error.message)
}

pub(crate) fn inspect_deployment_artifact_source_with_handle(
    database: &Database,
    workflow_id: &str,
    expected_revision: u32,
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> Result<DeploymentFrozenSourceRevision, String> {
    super::validate_identifier("workflow id", workflow_id, 128)
        .map_err(|error| error.to_string())?;
    let workflow = database
        .get_deployment_workflow(workflow_id)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_NOT_FOUND".to_string())?;
    if workflow.revision != expected_revision {
        return Err("REVISION_CONFLICT".into());
    }
    if !workflow.enabled {
        return Err("DEPLOYMENT_WORKFLOW_DISABLED".into());
    }
    inspect_source_with_executor(
        &workflow,
        &NativeArtifactCommandExecutor,
        cancellation,
        deadline,
    )
    .map_err(|error| error.message)
}

fn canonical_member(root: &Path, relative: &str, label: &str) -> Result<PathBuf, String> {
    let joined = if relative == "." {
        root.to_path_buf()
    } else {
        root.join(relative)
    };
    let canonical =
        fs::canonicalize(&joined).map_err(|error| format!("{label} is unavailable: {error}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("{label} escapes the frozen project root"));
    }
    Ok(canonical)
}

fn content_identity(
    workflow: &DeploymentWorkflowRecord,
    request: &DeploymentArtifactBuildRequest,
) -> Result<String, String> {
    let identity = ArtifactContentIdentity {
        version: MANIFEST_SCHEMA_VERSION,
        workflow_id: &workflow.id,
        workflow_revision: workflow.revision,
        source_revision: &request.source_revision,
        builder_kind: request.builder_kind,
        context: &workflow.definition.build.context,
        dockerfile: &workflow.definition.build.dockerfile,
        platform: &workflow.definition.build.platform,
        image_repository: &workflow.definition.build.image_repository,
        compression: workflow.definition.build.compression,
        compose_files: &workflow.definition.compose.files,
    };
    serde_json::to_vec(&identity)
        .map(|bytes| sha256_bytes(&bytes))
        .map_err(|error| format!("failed to compute artifact identity: {error}"))
}

fn release_id(source_revision: &str, identity: &str) -> String {
    format!("release-{}-{}", &source_revision[..12], &identity[..12])
}

fn artifact_reference(identity: &str, manifest_digest: &str) -> String {
    format!("{ARTIFACT_REFERENCE_PREFIX}:{identity}:{manifest_digest}")
}

fn parse_artifact_reference(value: &str) -> Result<(&str, &str), String> {
    let mut parts = value.split(':');
    let prefix = parts.next().unwrap_or_default();
    let identity = parts.next().unwrap_or_default();
    let manifest_digest = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || prefix != ARTIFACT_REFERENCE_PREFIX
        || !valid_sha256(identity)
        || !valid_sha256(manifest_digest)
    {
        return Err("deployment artifact reference is invalid".into());
    }
    Ok((identity, manifest_digest))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("failed to open staged artifact file: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to read staged artifact file: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn ensure_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("failed to create deployment artifact directory: {error}"))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect deployment artifact directory: {error}"))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err("deployment artifact directory cannot be a symbolic link".into());
    }
    set_directory_mode(path)
}

#[cfg(unix)]
fn set_directory_mode(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("failed to secure deployment artifact directory: {error}"))
}

#[cfg(not(unix))]
fn set_directory_mode(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn set_file_mode(path: &Path) -> Result<(), FixedCommandFailure> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
        command_failure(
            FixedCommandFailureKind::Io,
            format!("failed to secure artifact file: {error}"),
        )
    })
}

#[cfg(not(unix))]
fn set_file_mode(_path: &Path) -> Result<(), FixedCommandFailure> {
    Ok(())
}

fn secure_create_file(path: &Path) -> Result<File, std::io::Error> {
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

fn write_atomic_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "artifact file has no parent directory".to_string())?;
    ensure_directory(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("artifact"),
        uuid::Uuid::new_v4()
    ));
    let mut file = secure_create_file(&temporary)
        .map_err(|error| format!("failed to create temporary deployment artifact file: {error}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("failed to persist deployment artifact file: {error}"))?;
    drop(file);
    fs::rename(&temporary, path)
        .map_err(|error| format!("failed to publish deployment artifact file: {error}"))?;
    sync_directory(parent)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync deployment artifact directory: {error}"))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    // Atomic rename and per-file FlushFileBuffers remain the Windows durable
    // boundary; Rust does not expose a portable directory flush handle.
    Ok(())
}

fn copy_compose_files(
    root: &Path,
    staging: &Path,
    paths: &[String],
) -> Result<Vec<DeploymentArtifactComposeFileManifest>, String> {
    let mut total = 0_u64;
    let mut manifests = Vec::with_capacity(paths.len());
    for relative in paths {
        let source = canonical_member(root, relative, "Compose file")?;
        let metadata = fs::symlink_metadata(&source)
            .map_err(|error| format!("failed to inspect Compose file: {error}"))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err("Compose file must be a regular file".into());
        }
        if metadata.len() > MAX_COMPOSE_FILE_BYTES {
            return Err("Compose file exceeds the safety size limit".into());
        }
        total = total.saturating_add(metadata.len());
        if total > MAX_COMPOSE_TOTAL_BYTES {
            return Err("Compose files exceed the combined safety size limit".into());
        }
        let file_name = format!("compose/{relative}");
        let target = staging.join(&file_name);
        let relative_parent = Path::new(&file_name)
            .parent()
            .ok_or_else(|| "staged Compose file has no parent".to_string())?;
        let mut private_parent = staging.to_path_buf();
        for component in relative_parent.components() {
            use std::path::Component;
            let Component::Normal(segment) = component else {
                return Err("staged Compose path is not normalized".into());
            };
            private_parent.push(segment);
            ensure_directory(&private_parent)?;
        }
        let bytes =
            fs::read(&source).map_err(|error| format!("failed to read Compose file: {error}"))?;
        write_atomic_file(&target, &bytes)?;
        manifests.push(DeploymentArtifactComposeFileManifest {
            path: relative.clone(),
            file_name,
            bytes: bytes.len() as u64,
            sha256: sha256_bytes(&bytes),
        });
    }
    Ok(manifests)
}

fn archive_name(compression: DeploymentArtifactCompression) -> &'static str {
    match compression {
        DeploymentArtifactCompression::Zstd => "image.tar.zst",
        DeploymentArtifactCompression::Gzip => "image.tar.gz",
        DeploymentArtifactCompression::None => "image.tar",
    }
}

fn parse_image_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    let digest = value
        .strip_prefix("sha256:")
        .ok_or_else(|| "Docker image inspect returned an invalid image ID".to_string())?;
    if !valid_sha256(digest) {
        return Err("Docker image inspect returned an invalid image ID".into());
    }
    Ok(value.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase", deny_unknown_fields)]
struct DockerSaveManifestEntry {
    config: String,
    repo_tags: Vec<String>,
    layers: Vec<String>,
}

fn docker_config_digest(path: &str) -> Result<&str, String> {
    let components = Path::new(path).components().collect::<Vec<_>>();
    let digest = match components.as_slice() {
        [std::path::Component::Normal(blobs), std::path::Component::Normal(algorithm), std::path::Component::Normal(digest)]
            if blobs.to_str() == Some("blobs") && algorithm.to_str() == Some("sha256") =>
        {
            digest.to_str()
        }
        [std::path::Component::Normal(file)] => file
            .to_str()
            .and_then(|file| file.strip_suffix(".json")),
        _ => None,
    }
    .ok_or_else(|| "Docker save manifest contains an unsafe config path".to_string())?;
    if !valid_sha256(digest) {
        return Err("Docker save manifest contains an invalid config digest".into());
    }
    Ok(digest)
}

pub(super) fn docker_archive_image_id(
    archive_path: &Path,
    image_reference: &str,
) -> Result<String, String> {
    const MAX_DOCKER_MANIFEST_BYTES: u64 = 64 * 1024;
    const MAX_DOCKER_CONFIG_BYTES: u64 = 1024 * 1024;
    let read_entry = |wanted: &str, max_bytes: u64| -> Result<Option<Vec<u8>>, String> {
        let file = File::open(archive_path)
            .map_err(|error| format!("failed to open Docker image archive: {error}"))?;
        let mut archive = tar::Archive::new(file);
        let entries = archive
            .entries()
            .map_err(|error| format!("failed to inspect Docker image archive: {error}"))?;
        let mut found = None;
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("failed to inspect Docker image archive: {error}"))?;
            let path = entry
                .path()
                .map_err(|error| format!("Docker image archive path is invalid: {error}"))?;
            if path != Path::new(wanted) {
                continue;
            }
            if found.is_some() || !entry.header().entry_type().is_file() || entry.size() > max_bytes
            {
                return Err("Docker image archive contains an invalid duplicate entry".into());
            }
            let mut bytes = Vec::new();
            entry
                .take(max_bytes + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| format!("failed to read Docker image archive entry: {error}"))?;
            if bytes.len() as u64 > max_bytes {
                return Err("Docker image archive entry exceeds its safety limit".into());
            }
            found = Some(bytes);
        }
        Ok(found)
    };
    let manifest_bytes = read_entry("manifest.json", MAX_DOCKER_MANIFEST_BYTES)?
        .ok_or_else(|| "Docker image archive has no manifest.json".to_string())?;
    let entries: Vec<DockerSaveManifestEntry> = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("Docker image archive manifest is invalid: {error}"))?;
    if entries.is_empty() || entries.len() > 64 {
        return Err("Docker image archive manifest entry count is invalid".into());
    }
    let mut matches = entries
        .iter()
        .filter(|entry| entry.repo_tags.iter().any(|tag| tag == image_reference));
    let selected = matches.next().ok_or_else(|| {
        "Docker image archive does not contain the approved image reference".to_string()
    })?;
    if matches.next().is_some()
        || selected.repo_tags.is_empty()
        || selected.repo_tags.len() > 64
        || selected.layers.is_empty()
        || selected.layers.len() > 256
    {
        return Err("Docker image archive image identity is ambiguous".into());
    }
    let digest = docker_config_digest(&selected.config)?;
    let config_bytes = read_entry(&selected.config, MAX_DOCKER_CONFIG_BYTES)?
        .ok_or_else(|| "Docker image archive config is missing".to_string())?;
    if sha256_bytes(&config_bytes) != digest {
        return Err("Docker image archive config digest does not match its content".into());
    }
    Ok(format!("sha256:{digest}"))
}

fn map_command_failure(
    failure: FixedCommandFailure,
    fallback: DeploymentArtifactBuildFailureCategory,
) -> (
    DeploymentArtifactBuildStatus,
    DeploymentArtifactBuildFailureCategory,
    String,
) {
    match failure.kind {
        FixedCommandFailureKind::Cancelled => (
            DeploymentArtifactBuildStatus::Cancelled,
            DeploymentArtifactBuildFailureCategory::Cancelled,
            "Artifact build was cancelled".into(),
        ),
        FixedCommandFailureKind::TimedOut => (
            DeploymentArtifactBuildStatus::TimedOut,
            DeploymentArtifactBuildFailureCategory::TimedOut,
            "Artifact build timed out".into(),
        ),
        FixedCommandFailureKind::OutputLimit => (
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::OutputLimit,
            "Artifact build output exceeded a safety limit".into(),
        ),
        FixedCommandFailureKind::Start | FixedCommandFailureKind::Io => (
            DeploymentArtifactBuildStatus::Failed,
            fallback,
            failure.message,
        ),
    }
}

fn claim_artifact_completion(
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> Result<
    (),
    (
        DeploymentArtifactBuildStatus,
        DeploymentArtifactBuildFailureCategory,
        String,
    ),
> {
    if Instant::now() >= deadline {
        cancellation.try_timeout();
    }
    match cancellation.terminal_state() {
        ExecutionTerminalState::Running if cancellation.try_finish() => Ok(()),
        ExecutionTerminalState::Running => claim_artifact_completion(cancellation, deadline),
        ExecutionTerminalState::Cancelled => Err((
            DeploymentArtifactBuildStatus::Cancelled,
            DeploymentArtifactBuildFailureCategory::Cancelled,
            "Artifact build was cancelled before publication".into(),
        )),
        ExecutionTerminalState::TimedOut => Err((
            DeploymentArtifactBuildStatus::TimedOut,
            DeploymentArtifactBuildFailureCategory::TimedOut,
            "Artifact build timed out before publication".into(),
        )),
        ExecutionTerminalState::Finished => Ok(()),
    }
}

fn failure_result(
    request: &DeploymentArtifactBuildRequest,
    workflow_revision: Option<u32>,
    source_revision: Option<DeploymentFrozenSourceRevision>,
    status: DeploymentArtifactBuildStatus,
    category: DeploymentArtifactBuildFailureCategory,
    message: impl Into<String>,
) -> DeploymentArtifactBuildResult {
    DeploymentArtifactBuildResult {
        operation_id: request.operation_id.clone(),
        workflow_id: request.workflow_id.clone(),
        workflow_revision,
        builder_kind: request.builder_kind,
        status,
        source_revision,
        release_id: None,
        artifact_digest_sha256: None,
        artifact_bytes: None,
        artifact_reference: None,
        manifest: None,
        reused: false,
        failure: Some(DeploymentArtifactBuildFailure {
            category,
            message: message.into(),
        }),
    }
}

fn result_from_verified(
    request: &DeploymentArtifactBuildRequest,
    artifact: VerifiedDeploymentArtifact,
    reused: bool,
) -> DeploymentArtifactBuildResult {
    DeploymentArtifactBuildResult {
        operation_id: request.operation_id.clone(),
        workflow_id: request.workflow_id.clone(),
        workflow_revision: Some(artifact.manifest.workflow_revision),
        builder_kind: request.builder_kind,
        status: DeploymentArtifactBuildStatus::Succeeded,
        source_revision: Some(artifact.manifest.source_revision.clone()),
        release_id: Some(artifact.manifest.release_id.clone()),
        artifact_digest_sha256: Some(artifact.manifest.archive.sha256.clone()),
        artifact_bytes: Some(artifact.manifest.archive.bytes),
        artifact_reference: Some(artifact.artifact_reference),
        manifest: Some(artifact.manifest),
        reused,
        failure: None,
    }
}

struct ProgressReporter<'a> {
    operation_id: &'a str,
    sequence: u32,
    emit: &'a mut dyn FnMut(DeploymentArtifactBuildProgress),
}

impl ProgressReporter<'_> {
    fn report(
        &mut self,
        step: DeploymentArtifactBuildStep,
        summary: &'static str,
        completed_bytes: Option<u64>,
        total_bytes: Option<u64>,
    ) {
        self.sequence = self.sequence.saturating_add(1);
        (self.emit)(DeploymentArtifactBuildProgress {
            operation_id: self.operation_id.to_string(),
            sequence: self.sequence,
            step,
            completed_bytes,
            total_bytes,
            summary: summary.to_string(),
        });
    }
}

pub(crate) fn build_deployment_artifact(
    database: &Database,
    cancellations: &ExecutionCancellationRegistry,
    staging_root: &Path,
    request: DeploymentArtifactBuildRequest,
    emit: &mut dyn FnMut(DeploymentArtifactBuildProgress),
) -> DeploymentArtifactBuildResult {
    build_deployment_artifact_with_executor(
        database,
        cancellations,
        staging_root,
        request,
        &NativeArtifactCommandExecutor,
        emit,
    )
}

fn build_deployment_artifact_with_executor(
    database: &Database,
    cancellations: &ExecutionCancellationRegistry,
    staging_root: &Path,
    request: DeploymentArtifactBuildRequest,
    executor: &dyn ArtifactCommandExecutor,
    emit: &mut dyn FnMut(DeploymentArtifactBuildProgress),
) -> DeploymentArtifactBuildResult {
    let mut progress = ProgressReporter {
        operation_id: &request.operation_id,
        sequence: 0,
        emit,
    };
    progress.report(
        DeploymentArtifactBuildStep::Validating,
        "Validating the frozen artifact-build request",
        None,
        None,
    );
    let invalid = || {
        failure_result(
            &request,
            None,
            None,
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::InvalidRequest,
            "Artifact build request is invalid",
        )
    };
    if !request.operation_id.starts_with(OPERATION_PREFIX)
        || !crate::execution::valid_operation_id(&request.operation_id)
        || super::validate_identifier("workflow id", &request.workflow_id, 128).is_err()
        || request.expected_revision == 0
        || !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&request.timeout_ms)
        || validate_source_revision(&request.source_revision).is_err()
    {
        return invalid();
    }
    if request.source_revision.dirty {
        return failure_result(
            &request,
            Some(request.expected_revision),
            Some(request.source_revision.clone()),
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::SourceDirty,
            "Artifact builds require a clean Git working tree",
        );
    }
    let cancellation = match cancellations.register(request.operation_id.clone()) {
        Ok(value) => value,
        Err(_) => return invalid(),
    };
    let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
    let workflow = match database.get_deployment_workflow(&request.workflow_id) {
        Ok(Some(workflow)) => workflow,
        Ok(None) => {
            return failure_result(
                &request,
                None,
                None,
                DeploymentArtifactBuildStatus::Failed,
                DeploymentArtifactBuildFailureCategory::WorkflowNotFound,
                "Deployment workflow was not found",
            )
        }
        Err(_) => {
            return failure_result(
                &request,
                None,
                None,
                DeploymentArtifactBuildStatus::Failed,
                DeploymentArtifactBuildFailureCategory::Internal,
                "Failed to load deployment workflow",
            )
        }
    };
    if workflow.revision != request.expected_revision {
        return failure_result(
            &request,
            Some(workflow.revision),
            None,
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::RevisionConflict,
            "Deployment workflow changed before artifact build",
        );
    }
    if !workflow.enabled {
        return failure_result(
            &request,
            Some(workflow.revision),
            None,
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::WorkflowDisabled,
            "Deployment workflow is disabled",
        );
    }
    progress.report(
        DeploymentArtifactBuildStep::CheckingSource,
        "Revalidating the frozen Git revision",
        None,
        None,
    );
    let observed_source =
        match inspect_source_with_executor(&workflow, executor, &cancellation, deadline) {
            Ok(value) => value,
            Err(error) => {
                let (status, category, message) = map_command_failure(
                    error,
                    DeploymentArtifactBuildFailureCategory::SourceUnavailable,
                );
                return failure_result(
                    &request,
                    Some(workflow.revision),
                    None,
                    status,
                    category,
                    message,
                );
            }
        };
    if observed_source != request.source_revision {
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::SourceChanged,
            "Git revision or dirty state changed before artifact build",
        );
    }
    let project_root = match fs::canonicalize(&workflow.definition.source_directory) {
        Ok(value) if value == PathBuf::from(&workflow.definition.source_directory) => value,
        _ => {
            return failure_result(
                &request,
                Some(workflow.revision),
                Some(observed_source),
                DeploymentArtifactBuildStatus::Failed,
                DeploymentArtifactBuildFailureCategory::PathBoundary,
                "Project root is unavailable or no longer canonical",
            )
        }
    };
    let context = match canonical_member(
        &project_root,
        &workflow.definition.build.context,
        "Docker build context",
    ) {
        Ok(path) if path.is_dir() => path,
        _ => {
            return failure_result(
                &request,
                Some(workflow.revision),
                Some(observed_source),
                DeploymentArtifactBuildStatus::Failed,
                DeploymentArtifactBuildFailureCategory::PathBoundary,
                "Docker build context is not a directory inside the frozen project root",
            )
        }
    };
    let dockerfile = match canonical_member(
        &project_root,
        &workflow.definition.build.dockerfile,
        "Dockerfile",
    ) {
        Ok(path) if path.is_file() => path,
        _ => {
            return failure_result(
                &request,
                Some(workflow.revision),
                Some(observed_source),
                DeploymentArtifactBuildStatus::Failed,
                DeploymentArtifactBuildFailureCategory::PathBoundary,
                "Dockerfile is not a file inside the frozen project root",
            )
        }
    };
    let identity = match content_identity(&workflow, &request) {
        Ok(value) => value,
        Err(message) => {
            return failure_result(
                &request,
                Some(workflow.revision),
                Some(observed_source),
                DeploymentArtifactBuildStatus::Failed,
                DeploymentArtifactBuildFailureCategory::Internal,
                message,
            )
        }
    };
    if let Err(message) = ensure_directory(staging_root) {
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::ArtifactIo,
            message,
        );
    }
    let final_directory = staging_root.join(&identity);
    if final_directory.exists() {
        let manifest_path = final_directory.join("manifest.json");
        let manifest = fs::read(&manifest_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<DeploymentArtifactManifest>(&bytes).ok());
        if let Some(manifest) = manifest {
            let reference = artifact_reference(&identity, &manifest.manifest_digest_sha256);
            if let Ok(verified) = verify_deployment_artifact(staging_root, &reference) {
                if verified.manifest.workflow_id == workflow.id
                    && verified.manifest.workflow_revision == workflow.revision
                    && verified.manifest.source_revision == observed_source
                {
                    if let Err((status, category, message)) =
                        claim_artifact_completion(&cancellation, deadline)
                    {
                        return failure_result(
                            &request,
                            Some(workflow.revision),
                            Some(observed_source),
                            status,
                            category,
                            message,
                        );
                    }
                    progress.report(
                        DeploymentArtifactBuildStep::Completed,
                        "Reused the verified content-addressed artifact",
                        Some(verified.manifest.archive.bytes),
                        Some(verified.manifest.archive.bytes),
                    );
                    return result_from_verified(&request, verified, true);
                }
            }
        }
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::ArtifactConflict,
            "Existing content-addressed artifact failed verification",
        );
    }

    progress.report(
        DeploymentArtifactBuildStep::DetectingTools,
        "Checking Docker, Buildx, and the selected compressor",
        None,
        None,
    );
    let docker_version = FixedCommand::new(
        "docker",
        &project_root,
        [
            OsString::from("version"),
            OsString::from("--format"),
            OsString::from("{{.Client.Version}}"),
        ],
    );
    if let Err(error) = run_checked(executor, &docker_version, &cancellation, deadline) {
        let (status, category, message) = map_command_failure(
            error,
            DeploymentArtifactBuildFailureCategory::DockerUnavailable,
        );
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            status,
            category,
            message,
        );
    }
    let buildx_version = FixedCommand::new(
        "docker",
        &project_root,
        [OsString::from("buildx"), OsString::from("version")],
    );
    if let Err(error) = run_checked(executor, &buildx_version, &cancellation, deadline) {
        let (status, category, message) = map_command_failure(
            error,
            DeploymentArtifactBuildFailureCategory::BuildxUnavailable,
        );
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            status,
            category,
            message,
        );
    }
    let compressor = match workflow.definition.build.compression {
        DeploymentArtifactCompression::Zstd => Some(FixedCommand::new(
            "zstd",
            &project_root,
            [OsString::from("--version")],
        )),
        DeploymentArtifactCompression::Gzip => Some(FixedCommand::new(
            "gzip",
            &project_root,
            [OsString::from("--version")],
        )),
        DeploymentArtifactCompression::None => None,
    };
    if let Some(command) = compressor {
        if let Err(error) = run_checked(executor, &command, &cancellation, deadline) {
            let (status, category, message) = map_command_failure(
                error,
                DeploymentArtifactBuildFailureCategory::CompressorUnavailable,
            );
            return failure_result(
                &request,
                Some(workflow.revision),
                Some(observed_source),
                status,
                category,
                message,
            );
        }
    }

    let release_id = release_id(&observed_source.revision, &identity);
    let image_reference = format!(
        "{}:{release_id}",
        workflow.definition.build.image_repository
    );
    progress.report(
        DeploymentArtifactBuildStep::BuildingImage,
        "Building the fixed Docker Buildx image",
        None,
        None,
    );
    let build = FixedCommand::new(
        "docker",
        &project_root,
        [
            OsString::from("buildx"),
            OsString::from("build"),
            OsString::from("--load"),
            OsString::from("--progress"),
            OsString::from("plain"),
            OsString::from("--platform"),
            OsString::from(&workflow.definition.build.platform),
            OsString::from("--file"),
            dockerfile.as_os_str().to_os_string(),
            OsString::from("--tag"),
            OsString::from(&image_reference),
            context.as_os_str().to_os_string(),
        ],
    );
    if let Err(error) = run_checked(executor, &build, &cancellation, deadline) {
        let (status, category, message) =
            map_command_failure(error, DeploymentArtifactBuildFailureCategory::BuildFailed);
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            status,
            category,
            message,
        );
    }
    progress.report(
        DeploymentArtifactBuildStep::InspectingImage,
        "Reading the built image identity",
        None,
        None,
    );
    let inspect = FixedCommand::new(
        "docker",
        &project_root,
        [
            OsString::from("image"),
            OsString::from("inspect"),
            OsString::from("--format"),
            OsString::from("{{.Id}}"),
            OsString::from(&image_reference),
        ],
    );
    let _local_image_id = match run_checked(executor, &inspect, &cancellation, deadline)
        .map_err(|failure| {
            map_command_failure(
                failure,
                DeploymentArtifactBuildFailureCategory::InspectFailed,
            )
        })
        .and_then(|output| {
            parse_image_id(&output.stdout).map_err(|message| {
                (
                    DeploymentArtifactBuildStatus::Failed,
                    DeploymentArtifactBuildFailureCategory::InspectFailed,
                    message,
                )
            })
        }) {
        Ok(value) => value,
        Err((status, category, message)) => {
            return failure_result(
                &request,
                Some(workflow.revision),
                Some(observed_source),
                status,
                category,
                message,
            )
        }
    };

    let temporary = match tempfile::Builder::new()
        .prefix(".artifact-build-")
        .tempdir_in(staging_root)
    {
        Ok(value) => value,
        Err(error) => {
            return failure_result(
                &request,
                Some(workflow.revision),
                Some(observed_source),
                DeploymentArtifactBuildStatus::Failed,
                DeploymentArtifactBuildFailureCategory::ArtifactIo,
                format!("failed to create artifact staging directory: {error}"),
            )
        }
    };
    if let Err(message) = set_directory_mode(temporary.path()) {
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::ArtifactIo,
            message,
        );
    }
    let raw_archive = temporary.path().join(".image.tar.partial");
    if let Err(error) = secure_create_file(&raw_archive).and_then(|file| file.sync_all()) {
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::ArtifactIo,
            format!("failed to prepare private image archive: {error}"),
        );
    }
    progress.report(
        DeploymentArtifactBuildStep::SavingImage,
        "Saving the built image into runtime-owned staging",
        None,
        None,
    );
    let mut save = FixedCommand::new(
        "docker",
        &project_root,
        [
            OsString::from("image"),
            OsString::from("save"),
            OsString::from("--output"),
            raw_archive.as_os_str().to_os_string(),
            OsString::from(&image_reference),
        ],
    );
    save.output_file_limit = Some((raw_archive.clone(), MAX_ARTIFACT_BYTES));
    if let Err(error) = run_checked(executor, &save, &cancellation, deadline) {
        let (status, category, message) =
            map_command_failure(error, DeploymentArtifactBuildFailureCategory::SaveFailed);
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            status,
            category,
            message,
        );
    }
    if let Err(error) = set_file_mode(&raw_archive) {
        let (status, category, message) =
            map_command_failure(error, DeploymentArtifactBuildFailureCategory::ArtifactIo);
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            status,
            category,
            message,
        );
    }
    let raw_size = fs::metadata(&raw_archive)
        .map(|value| value.len())
        .unwrap_or(0);
    if raw_size == 0 || raw_size > MAX_ARTIFACT_BYTES {
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::SaveFailed,
            "Docker image save produced an empty or oversized archive",
        );
    }
    let image_id = match docker_archive_image_id(&raw_archive, &image_reference) {
        Ok(value) => value,
        Err(message) => {
            return failure_result(
                &request,
                Some(workflow.revision),
                Some(observed_source),
                DeploymentArtifactBuildStatus::Failed,
                DeploymentArtifactBuildFailureCategory::InspectFailed,
                message,
            )
        }
    };
    let archive_path = temporary
        .path()
        .join(archive_name(workflow.definition.build.compression));
    progress.report(
        DeploymentArtifactBuildStep::CompressingArchive,
        "Applying the selected fixed artifact compression",
        Some(raw_size),
        Some(raw_size),
    );
    let compression_result = match workflow.definition.build.compression {
        DeploymentArtifactCompression::None => fs::rename(&raw_archive, &archive_path)
            .map_err(|error| command_failure(FixedCommandFailureKind::Io, error.to_string()))
            .map(|_| FixedCommandOutput {
                exit_code: Some(0),
                stdout: String::new(),
                stderr: String::new(),
            }),
        DeploymentArtifactCompression::Zstd => {
            if let Err(error) = secure_create_file(&archive_path).and_then(|file| file.sync_all()) {
                return failure_result(
                    &request,
                    Some(workflow.revision),
                    Some(observed_source),
                    DeploymentArtifactBuildStatus::Failed,
                    DeploymentArtifactBuildFailureCategory::ArtifactIo,
                    format!("failed to prepare private compressed archive: {error}"),
                );
            }
            let mut command = FixedCommand::new(
                "zstd",
                &project_root,
                [
                    OsString::from("--quiet"),
                    OsString::from("--threads=0"),
                    OsString::from("--force"),
                    OsString::from("--output"),
                    archive_path.as_os_str().to_os_string(),
                    raw_archive.as_os_str().to_os_string(),
                ],
            );
            command.output_file_limit = Some((archive_path.clone(), MAX_ARTIFACT_BYTES));
            run_checked(executor, &command, &cancellation, deadline)
        }
        DeploymentArtifactCompression::Gzip => {
            let mut command = FixedCommand::new(
                "gzip",
                &project_root,
                [
                    OsString::from("--no-name"),
                    OsString::from("--stdout"),
                    raw_archive.as_os_str().to_os_string(),
                ],
            );
            command.stdout_file = Some(archive_path.clone());
            command.output_file_limit = Some((archive_path.clone(), MAX_ARTIFACT_BYTES));
            run_checked(executor, &command, &cancellation, deadline)
        }
    };
    if let Err(error) = compression_result {
        let (status, category, message) = map_command_failure(
            error,
            DeploymentArtifactBuildFailureCategory::CompressionFailed,
        );
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            status,
            category,
            message,
        );
    }
    if workflow.definition.build.compression != DeploymentArtifactCompression::None {
        let _ = fs::remove_file(&raw_archive);
    }
    if let Err(error) = set_file_mode(&archive_path) {
        let (status, category, message) =
            map_command_failure(error, DeploymentArtifactBuildFailureCategory::ArtifactIo);
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            status,
            category,
            message,
        );
    }
    // Windows FlushFileBuffers requires a writable handle even though the
    // archive contents are already complete at this durability boundary.
    if let Err(error) = OpenOptions::new()
        .write(true)
        .open(&archive_path)
        .and_then(|file| file.sync_all())
    {
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::ArtifactIo,
            format!("failed to sync artifact archive: {error}"),
        );
    }
    let archive_bytes = fs::metadata(&archive_path)
        .map(|value| value.len())
        .unwrap_or(0);
    if archive_bytes == 0 || archive_bytes > MAX_ARTIFACT_BYTES {
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(observed_source),
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::CompressionFailed,
            "Compressed artifact is empty or exceeds the safety size limit",
        );
    }
    let archive_digest = match sha256_file(&archive_path) {
        Ok(value) => value,
        Err(message) => {
            return failure_result(
                &request,
                Some(workflow.revision),
                Some(observed_source),
                DeploymentArtifactBuildStatus::Failed,
                DeploymentArtifactBuildFailureCategory::ArtifactIo,
                message,
            )
        }
    };
    let compose_files = match copy_compose_files(
        &project_root,
        temporary.path(),
        &workflow.definition.compose.files,
    ) {
        Ok(value) => value,
        Err(message) => {
            return failure_result(
                &request,
                Some(workflow.revision),
                Some(observed_source),
                DeploymentArtifactBuildStatus::Failed,
                DeploymentArtifactBuildFailureCategory::PathBoundary,
                message,
            )
        }
    };

    let final_source =
        match inspect_source_with_executor(&workflow, executor, &cancellation, deadline) {
            Ok(value) => value,
            Err(error) => {
                let (status, category, message) = map_command_failure(
                    error,
                    DeploymentArtifactBuildFailureCategory::SourceUnavailable,
                );
                return failure_result(
                    &request,
                    Some(workflow.revision),
                    Some(observed_source),
                    status,
                    category,
                    message,
                );
            }
        };
    let current_workflow = database
        .get_deployment_workflow(&request.workflow_id)
        .ok()
        .flatten();
    if final_source != observed_source || current_workflow.as_ref() != Some(&workflow) {
        return failure_result(
            &request,
            current_workflow.as_ref().map(|value| value.revision),
            Some(final_source),
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::SourceChanged,
            "Workflow or Git source changed during artifact build",
        );
    }
    progress.report(
        DeploymentArtifactBuildStep::WritingManifest,
        "Writing the canonical artifact manifest",
        Some(archive_bytes),
        Some(archive_bytes),
    );
    let mut manifest = DeploymentArtifactManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        content_identity_sha256: identity.clone(),
        workflow_id: workflow.id.clone(),
        workflow_revision: workflow.revision,
        source_revision: observed_source,
        release_id: release_id.clone(),
        platform: workflow.definition.build.platform.clone(),
        image: DeploymentArtifactImageManifest {
            repository: workflow.definition.build.image_repository.clone(),
            tag: release_id,
            image_id,
        },
        archive: DeploymentArtifactArchiveManifest {
            file_name: archive_name(workflow.definition.build.compression).to_string(),
            compression: workflow.definition.build.compression,
            bytes: archive_bytes,
            sha256: archive_digest,
        },
        compose_files,
        created_at: current_timestamp_ms(),
        manifest_digest_sha256: String::new(),
    };
    manifest.manifest_digest_sha256 = match manifest.expected_digest() {
        Ok(value) => value,
        Err(message) => {
            return failure_result(
                &request,
                Some(workflow.revision),
                Some(manifest.source_revision.clone()),
                DeploymentArtifactBuildStatus::Failed,
                DeploymentArtifactBuildFailureCategory::Internal,
                message,
            )
        }
    };
    let manifest_bytes = match serde_json::to_vec(&manifest) {
        Ok(bytes) if bytes.len() <= MAX_MANIFEST_BYTES => bytes,
        _ => {
            return failure_result(
                &request,
                Some(workflow.revision),
                Some(manifest.source_revision.clone()),
                DeploymentArtifactBuildStatus::Failed,
                DeploymentArtifactBuildFailureCategory::Internal,
                "Artifact manifest exceeded the safety limit",
            )
        }
    };
    if let Err(message) =
        write_atomic_file(&temporary.path().join("manifest.json"), &manifest_bytes)
            .and_then(|_| sync_directory(temporary.path()))
    {
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(manifest.source_revision.clone()),
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::ArtifactIo,
            message,
        );
    }
    if let Err((status, category, message)) = claim_artifact_completion(&cancellation, deadline) {
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(manifest.source_revision.clone()),
            status,
            category,
            message,
        );
    }
    if let Err(error) = fs::rename(temporary.path(), &final_directory) {
        if final_directory.exists() {
            let reference = artifact_reference(&identity, &manifest.manifest_digest_sha256);
            if let Ok(verified) = verify_deployment_artifact(staging_root, &reference) {
                progress.report(
                    DeploymentArtifactBuildStep::Completed,
                    "Reused a concurrently published verified artifact",
                    Some(verified.manifest.archive.bytes),
                    Some(verified.manifest.archive.bytes),
                );
                return result_from_verified(&request, verified, true);
            }
        }
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(manifest.source_revision.clone()),
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::ArtifactConflict,
            format!("failed to publish content-addressed artifact: {error}"),
        );
    }
    let _ = temporary.keep();
    if let Err(message) = sync_directory(staging_root) {
        return failure_result(
            &request,
            Some(workflow.revision),
            Some(manifest.source_revision.clone()),
            DeploymentArtifactBuildStatus::Failed,
            DeploymentArtifactBuildFailureCategory::ArtifactIo,
            message,
        );
    }
    progress.report(
        DeploymentArtifactBuildStep::VerifyingArtifact,
        "Verifying the published artifact and manifest digests",
        Some(archive_bytes),
        Some(archive_bytes),
    );
    let reference = artifact_reference(&identity, &manifest.manifest_digest_sha256);
    let verified = match verify_deployment_artifact(staging_root, &reference) {
        Ok(value) => value,
        Err(message) => {
            return failure_result(
                &request,
                Some(workflow.revision),
                Some(manifest.source_revision),
                DeploymentArtifactBuildStatus::Failed,
                DeploymentArtifactBuildFailureCategory::ArtifactConflict,
                message,
            )
        }
    };
    progress.report(
        DeploymentArtifactBuildStep::Completed,
        "Artifact build completed and passed integrity verification",
        Some(archive_bytes),
        Some(archive_bytes),
    );
    result_from_verified(&request, verified, false)
}

fn verify_regular_file(directory: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.contains('\\')
        || relative
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err("artifact manifest contains an invalid file name".into());
    }
    let path = directory.join(relative);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("staged artifact file is unavailable: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("staged artifact entry is not a regular file".into());
    }
    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("failed to canonicalize staged artifact file: {error}"))?;
    if !canonical.starts_with(directory) {
        return Err("staged artifact file escapes the runtime staging directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("staged artifact file permissions are too broad".into());
        }
    }
    Ok(canonical)
}

pub(crate) fn verify_deployment_artifact(
    staging_root: &Path,
    reference: &str,
) -> Result<VerifiedDeploymentArtifact, String> {
    let (identity, reference_manifest_digest) = parse_artifact_reference(reference)?;
    let root_metadata = fs::symlink_metadata(staging_root)
        .map_err(|error| format!("deployment artifact staging root is unavailable: {error}"))?;
    if !root_metadata.file_type().is_dir() || root_metadata.file_type().is_symlink() {
        return Err("deployment artifact staging root is invalid".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if root_metadata.permissions().mode() & 0o077 != 0 {
            return Err("deployment artifact staging root permissions are too broad".into());
        }
    }
    let canonical_root = fs::canonicalize(staging_root)
        .map_err(|error| format!("deployment artifact staging root is unavailable: {error}"))?;
    let directory = canonical_root.join(identity);
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|error| format!("deployment artifact is unavailable: {error}"))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err("deployment artifact directory is invalid".into());
    }
    let directory = fs::canonicalize(&directory)
        .map_err(|error| format!("failed to canonicalize deployment artifact: {error}"))?;
    if directory.parent() != Some(canonical_root.as_path()) {
        return Err("deployment artifact directory escapes the staging root".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("deployment artifact directory permissions are too broad".into());
        }
    }
    let manifest_path = verify_regular_file(&directory, "manifest.json")?;
    let bytes = fs::read(&manifest_path)
        .map_err(|error| format!("failed to read deployment artifact manifest: {error}"))?;
    if bytes.is_empty() || bytes.len() > MAX_MANIFEST_BYTES {
        return Err("deployment artifact manifest size is invalid".into());
    }
    let manifest: DeploymentArtifactManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("deployment artifact manifest is invalid: {error}"))?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION
        || manifest.content_identity_sha256 != identity
        || manifest.manifest_digest_sha256 != reference_manifest_digest
        || manifest.expected_digest()? != manifest.manifest_digest_sha256
        || !valid_sha256(&manifest.archive.sha256)
        || !valid_sha256(
            manifest
                .image
                .image_id
                .strip_prefix("sha256:")
                .unwrap_or_default(),
        )
    {
        return Err("deployment artifact manifest integrity check failed".into());
    }
    super::validate_identifier("artifact workflow id", &manifest.workflow_id, 128)
        .map_err(|error| error.to_string())?;
    super::validate_identifier("artifact release id", &manifest.release_id, 128)
        .map_err(|error| error.to_string())?;
    super::validate_image_repository(&manifest.image.repository)
        .map_err(|error| error.to_string())?;
    validate_source_revision(&manifest.source_revision)?;
    if manifest.workflow_revision == 0
        || manifest.source_revision.dirty
        || !matches!(manifest.platform.as_str(), "linux/amd64" | "linux/arm64")
        || manifest.image.tag != manifest.release_id
        || manifest.created_at <= 0
        || manifest.compose_files.is_empty()
        || manifest.compose_files.len() > 8
    {
        return Err("deployment artifact manifest fields are invalid".into());
    }
    let expected_archive_name = archive_name(manifest.archive.compression);
    if manifest.archive.file_name != expected_archive_name {
        return Err("deployment artifact archive name is inconsistent".into());
    }
    let archive = verify_regular_file(&directory, &manifest.archive.file_name)?;
    let archive_size = fs::metadata(&archive)
        .map_err(|error| format!("failed to inspect deployment artifact archive: {error}"))?
        .len();
    if archive_size == 0
        || archive_size > MAX_ARTIFACT_BYTES
        || archive_size != manifest.archive.bytes
        || sha256_file(&archive)? != manifest.archive.sha256
    {
        return Err("deployment artifact archive integrity check failed".into());
    }
    let mut compose_paths = std::collections::BTreeSet::new();
    for compose in &manifest.compose_files {
        super::validate_relative_path(&compose.path).map_err(|error| error.to_string())?;
        if compose.file_name != format!("compose/{}", compose.path)
            || !valid_sha256(&compose.sha256)
            || !compose_paths.insert(&compose.path)
        {
            return Err("staged Compose manifest entry is invalid".into());
        }
        let file = verify_regular_file(&directory, &compose.file_name)?;
        let size = fs::metadata(&file)
            .map_err(|error| format!("failed to inspect staged Compose file: {error}"))?
            .len();
        if size != compose.bytes
            || size > MAX_COMPOSE_FILE_BYTES
            || sha256_file(&file)? != compose.sha256
        {
            return Err("staged Compose file integrity check failed".into());
        }
    }
    Ok(VerifiedDeploymentArtifact {
        artifact_reference: reference.to_string(),
        manifest,
        directory,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::{
        DeploymentArtifactCompression, DeploymentTarget, DeploymentWorkflowCreate,
        DeploymentWorkflowDefinition, DeploymentWorkflowUpdate, DockerBuildxPlan,
        DockerComposePlan,
    };
    use crate::models::{ProfileAuthMethod, ProfileRow};
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct FakeExecutor {
        root: PathBuf,
        commands: Arc<Mutex<Vec<(String, Vec<String>)>>>,
        revisions: Arc<Mutex<Vec<String>>>,
        fail_program: Arc<Mutex<Option<&'static str>>>,
    }

    impl FakeExecutor {
        fn new(root: PathBuf) -> Self {
            Self {
                root,
                commands: Arc::new(Mutex::new(Vec::new())),
                revisions: Arc::new(Mutex::new(vec!["a".repeat(40)])),
                fail_program: Arc::new(Mutex::new(None)),
            }
        }

        fn args(command: &FixedCommand) -> Vec<String> {
            command
                .args
                .iter()
                .map(|value| value.to_string_lossy().into_owned())
                .collect()
        }

        fn output(stdout: impl Into<String>) -> FixedCommandOutput {
            FixedCommandOutput {
                exit_code: Some(0),
                stdout: stdout.into(),
                stderr: String::new(),
            }
        }

        fn write_archive(path: &Path, image_reference: &str) {
            let config = br#"{"architecture":"amd64","os":"linux"}"#;
            let config_digest = sha256_bytes(config);
            let config_path = format!("blobs/sha256/{config_digest}");
            let manifest = serde_json::to_vec(&serde_json::json!([{
                "Config": config_path,
                "RepoTags": [image_reference],
                "Layers": ["blobs/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
            }]))
            .unwrap();
            let file = File::create(path).unwrap();
            let mut archive = tar::Builder::new(file);
            for (entry_path, bytes) in [
                ("manifest.json".to_string(), manifest.as_slice()),
                (config_path, config.as_slice()),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_mode(0o600);
                header.set_size(bytes.len() as u64);
                header.set_cksum();
                archive.append_data(&mut header, entry_path, bytes).unwrap();
            }
            archive.finish().unwrap();
        }
    }

    impl ArtifactCommandExecutor for FakeExecutor {
        fn execute(
            &self,
            command: &FixedCommand,
            cancellation: &CancellationHandle,
            _deadline: Instant,
        ) -> Result<FixedCommandOutput, FixedCommandFailure> {
            if cancellation.is_cancelled() {
                return Err(command_failure(
                    FixedCommandFailureKind::Cancelled,
                    "cancelled",
                ));
            }
            let args = Self::args(command);
            self.commands
                .lock()
                .unwrap()
                .push((command.program.to_string(), args.clone()));
            if self.fail_program.lock().unwrap().as_ref() == Some(&command.program) {
                return Err(command_failure(FixedCommandFailureKind::Io, "fake failure"));
            }
            match (command.program, args.as_slice()) {
                ("git", values) if values == ["rev-parse", "--show-toplevel"] => {
                    Ok(Self::output(self.root.to_string_lossy()))
                }
                ("git", values) if values == ["rev-parse", "--verify", "HEAD^{commit}"] => {
                    let mut revisions = self.revisions.lock().unwrap();
                    let revision = if revisions.len() > 1 {
                        revisions.remove(0)
                    } else {
                        revisions[0].clone()
                    };
                    Ok(Self::output(revision))
                }
                ("git", values) if values.first().map(String::as_str) == Some("status") => {
                    Ok(Self::output(""))
                }
                ("docker", values)
                    if values.get(0).map(String::as_str) == Some("image")
                        && values.get(1).map(String::as_str) == Some("inspect") =>
                {
                    Ok(Self::output(format!("sha256:{}", "d".repeat(64))))
                }
                ("docker", values)
                    if values.get(0).map(String::as_str) == Some("image")
                        && values.get(1).map(String::as_str) == Some("save") =>
                {
                    let output_index = values.iter().position(|value| value == "--output").unwrap();
                    Self::write_archive(
                        Path::new(&values[output_index + 1]),
                        values.last().unwrap(),
                    );
                    Ok(Self::output(""))
                }
                ("zstd", values) if values.first().map(String::as_str) != Some("--version") => {
                    let output_index = values.iter().position(|value| value == "--output").unwrap();
                    let input = PathBuf::from(values.last().unwrap());
                    let mut bytes = b"zstd:".to_vec();
                    bytes.extend(fs::read(input).unwrap());
                    fs::write(&values[output_index + 1], bytes).unwrap();
                    Ok(Self::output(""))
                }
                ("gzip", values) if values.first().map(String::as_str) != Some("--version") => {
                    let mut bytes = b"gzip:".to_vec();
                    bytes.extend(fs::read(values.last().unwrap()).unwrap());
                    fs::write(command.stdout_file.as_ref().unwrap(), bytes).unwrap();
                    Ok(Self::output(""))
                }
                _ => Ok(Self::output("")),
            }
        }
    }

    struct Fixture {
        _directory: tempfile::TempDir,
        _source: tempfile::TempDir,
        source_root: PathBuf,
        artifacts: PathBuf,
        database: Database,
        workflow: DeploymentWorkflowRecord,
    }

    fn fixture(compression: DeploymentArtifactCompression) -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        fs::write(source.path().join("Dockerfile"), b"FROM scratch\n").unwrap();
        fs::write(source.path().join("compose.yaml"), b"services: {}\n").unwrap();
        let source_root = fs::canonicalize(source.path()).unwrap();
        let database = Database::open(&directory.path().join("deployment.db")).unwrap();
        database
            .insert_profile(&ProfileRow {
                id: "profile-1".into(),
                name: "Production".into(),
                host: "example.test".into(),
                port: 22,
                username: "deploy".into(),
                auth_method: ProfileAuthMethod::Password,
                keychain_key_id: None,
                jump_host_config: None,
                organization_json: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        let workflow = database
            .create_deployment_workflow(
                "workflow-1",
                &DeploymentWorkflowCreate {
                    name: "API".into(),
                    definition: DeploymentWorkflowDefinition {
                        schema_version: 1,
                        source_directory: source_root.to_string_lossy().into_owned(),
                        build: DockerBuildxPlan {
                            context: ".".into(),
                            dockerfile: "Dockerfile".into(),
                            platform: "linux/amd64".into(),
                            image_repository: "example.test/shellspan/api".into(),
                            compression,
                        },
                        target: DeploymentTarget {
                            connection_profile_id: "profile-1".into(),
                            remote_root: "/srv/shellspan/api".into(),
                        },
                        compose: DockerComposePlan {
                            project_name: "api".into(),
                            files: vec!["compose.yaml".into()],
                            services: vec!["web".into()],
                            pull_before_up: true,
                        },
                        health_check: None,
                        reload_nginx_after_healthy: false,
                        releases_to_keep: 3,
                    },
                    enabled: true,
                },
            )
            .unwrap();
        Fixture {
            artifacts: directory.path().join("artifacts"),
            _directory: directory,
            _source: source,
            source_root,
            database,
            workflow,
        }
    }

    fn request(operation: &str) -> DeploymentArtifactBuildRequest {
        DeploymentArtifactBuildRequest {
            operation_id: operation.into(),
            workflow_id: "workflow-1".into(),
            expected_revision: 1,
            source_revision: DeploymentFrozenSourceRevision {
                revision: "a".repeat(40),
                dirty: false,
            },
            builder_kind: DeploymentArtifactBuilderKind::DockerBuildx,
            timeout_ms: 60_000,
        }
    }

    #[test]
    fn fixed_build_arguments_publish_an_atomic_verified_manifest() {
        let fixture = fixture(DeploymentArtifactCompression::Zstd);
        let executor = FakeExecutor::new(fixture.source_root.clone());
        let mut progress = Vec::new();
        let result = build_deployment_artifact_with_executor(
            &fixture.database,
            &ExecutionCancellationRegistry::default(),
            &fixture.artifacts,
            request("deployment-artifact-build:first"),
            &executor,
            &mut |item| progress.push(item),
        );
        assert_eq!(result.status, DeploymentArtifactBuildStatus::Succeeded);
        assert!(!result.reused);
        let manifest = result.manifest.as_ref().unwrap();
        assert_eq!(
            manifest.manifest_digest_sha256,
            manifest.expected_digest().unwrap()
        );
        assert_eq!(
            manifest.archive.sha256,
            sha256_file(
                &fixture
                    .artifacts
                    .join(&manifest.content_identity_sha256)
                    .join(&manifest.archive.file_name)
            )
            .unwrap()
        );
        assert_eq!(manifest.image.tag, manifest.release_id);
        assert_eq!(manifest.compose_files[0].path, "compose.yaml");
        assert!(verify_deployment_artifact(
            &fixture.artifacts,
            result.artifact_reference.as_deref().unwrap()
        )
        .is_ok());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let published = fixture.artifacts.join(&manifest.content_identity_sha256);
            assert_eq!(
                fs::metadata(&fixture.artifacts)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&published).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(published.join("compose"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(published.join("manifest.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert_eq!(
            progress.last().unwrap().step,
            DeploymentArtifactBuildStep::Completed
        );

        let commands = executor.commands.lock().unwrap();
        let build = commands
            .iter()
            .find(|(program, args)| {
                program == "docker"
                    && args.get(0).map(String::as_str) == Some("buildx")
                    && args.get(1).map(String::as_str) == Some("build")
            })
            .unwrap();
        assert_eq!(
            build.1[2..6],
            ["--load", "--progress", "plain", "--platform"]
        );
        assert!(build.1.contains(&"--file".to_string()));
        assert!(build.1.contains(&"--tag".to_string()));
        assert!(!build
            .1
            .iter()
            .any(|argument| argument == "sh" || argument == "-c"));
    }

    #[test]
    fn docker_save_config_digest_is_the_cross_daemon_image_identity() {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("image.tar");
        FakeExecutor::write_archive(&archive, "example.test/app:release-1");
        let image_id = docker_archive_image_id(&archive, "example.test/app:release-1").unwrap();
        assert!(image_id.starts_with("sha256:"));
        assert_ne!(image_id, format!("sha256:{}", "d".repeat(64)));
        assert!(docker_archive_image_id(&archive, "example.test/app:other").is_err());
    }

    #[test]
    fn duplicate_identity_reuses_only_a_verified_artifact() {
        let fixture = fixture(DeploymentArtifactCompression::None);
        let executor = FakeExecutor::new(fixture.source_root.clone());
        let registry = ExecutionCancellationRegistry::default();
        let first = build_deployment_artifact_with_executor(
            &fixture.database,
            &registry,
            &fixture.artifacts,
            request("deployment-artifact-build:first"),
            &executor,
            &mut |_| {},
        );
        assert_eq!(first.status, DeploymentArtifactBuildStatus::Succeeded);
        let before = executor.commands.lock().unwrap().len();
        let second = build_deployment_artifact_with_executor(
            &fixture.database,
            &registry,
            &fixture.artifacts,
            request("deployment-artifact-build:second"),
            &executor,
            &mut |_| {},
        );
        assert_eq!(second.status, DeploymentArtifactBuildStatus::Succeeded);
        assert!(second.reused);
        assert_eq!(first.artifact_reference, second.artifact_reference);
        assert_eq!(executor.commands.lock().unwrap().len(), before + 3);

        let archive = fixture
            .artifacts
            .join(
                second
                    .manifest
                    .as_ref()
                    .unwrap()
                    .content_identity_sha256
                    .clone(),
            )
            .join("image.tar");
        fs::write(archive, b"tampered").unwrap();
        let third = build_deployment_artifact_with_executor(
            &fixture.database,
            &registry,
            &fixture.artifacts,
            request("deployment-artifact-build:third"),
            &executor,
            &mut |_| {},
        );
        assert_eq!(third.status, DeploymentArtifactBuildStatus::Failed);
        assert_eq!(
            third.failure.unwrap().category,
            DeploymentArtifactBuildFailureCategory::ArtifactConflict
        );
    }

    #[test]
    fn metacharacters_in_a_valid_context_path_remain_one_non_shell_argument() {
        let fixture = fixture(DeploymentArtifactCompression::None);
        let context_name = "context;touch-not-executed";
        fs::create_dir(fixture.source_root.join(context_name)).unwrap();
        let mut updated = fixture.workflow.clone();
        updated.definition.build.context = context_name.into();
        fixture
            .database
            .update_deployment_workflow(
                &updated.id,
                &DeploymentWorkflowUpdate {
                    expected_revision: 1,
                    name: updated.name,
                    definition: updated.definition,
                    enabled: true,
                },
            )
            .unwrap();
        let executor = FakeExecutor::new(fixture.source_root.clone());
        let mut build_request = request("deployment-artifact-build:metacharacters");
        build_request.expected_revision = 2;
        let result = build_deployment_artifact_with_executor(
            &fixture.database,
            &ExecutionCancellationRegistry::default(),
            &fixture.artifacts,
            build_request,
            &executor,
            &mut |_| {},
        );
        assert_eq!(result.status, DeploymentArtifactBuildStatus::Succeeded);
        let commands = executor.commands.lock().unwrap();
        let build = commands
            .iter()
            .find(|(program, args)| {
                program == "docker"
                    && args.get(0).map(String::as_str) == Some("buildx")
                    && args.get(1).map(String::as_str) == Some("build")
            })
            .unwrap();
        assert_eq!(
            build.1.last().map(String::as_str),
            Some(
                fixture
                    .source_root
                    .join(context_name)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert!(!fixture.source_root.join("touch-not-executed").exists());
    }

    #[test]
    fn source_drift_cleans_temporary_artifacts_without_publishing() {
        let fixture = fixture(DeploymentArtifactCompression::Gzip);
        let executor = FakeExecutor::new(fixture.source_root.clone());
        *executor.revisions.lock().unwrap() = vec!["a".repeat(40), "b".repeat(40)];
        let result = build_deployment_artifact_with_executor(
            &fixture.database,
            &ExecutionCancellationRegistry::default(),
            &fixture.artifacts,
            request("deployment-artifact-build:drift"),
            &executor,
            &mut |_| {},
        );
        assert_eq!(result.status, DeploymentArtifactBuildStatus::Failed);
        assert_eq!(
            result.failure.unwrap().category,
            DeploymentArtifactBuildFailureCategory::SourceChanged
        );
        assert!(fs::read_dir(&fixture.artifacts).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn canonical_path_boundary_rejects_a_symlink_escape() {
        use std::os::unix::fs::symlink;
        let fixture = fixture(DeploymentArtifactCompression::None);
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), fixture.source_root.join("outside-context")).unwrap();
        let mut updated = fixture.workflow.clone();
        updated.definition.build.context = "outside-context".into();
        fixture
            .database
            .update_deployment_workflow(
                &updated.id,
                &DeploymentWorkflowUpdate {
                    expected_revision: 1,
                    name: updated.name,
                    definition: updated.definition,
                    enabled: true,
                },
            )
            .unwrap();
        let executor = FakeExecutor::new(fixture.source_root.clone());
        let mut build_request = request("deployment-artifact-build:escape");
        build_request.expected_revision = 2;
        let result = build_deployment_artifact_with_executor(
            &fixture.database,
            &ExecutionCancellationRegistry::default(),
            &fixture.artifacts,
            build_request,
            &executor,
            &mut |_| {},
        );
        assert_eq!(
            result.failure.unwrap().category,
            DeploymentArtifactBuildFailureCategory::PathBoundary
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_executor_enforces_cancellation_timeout_and_output_limits() {
        let executor = NativeArtifactCommandExecutor;
        let root = std::env::current_dir().unwrap();
        let registry = ExecutionCancellationRegistry::default();

        let cancelled = registry
            .register("deployment-artifact-build:cancelled")
            .unwrap();
        registry
            .cancel("deployment-artifact-build:cancelled")
            .unwrap();
        let command = FixedCommand::new(
            "sh",
            &root,
            [OsString::from("-c"), OsString::from("exit 0")],
        );
        assert_eq!(
            executor
                .execute(
                    &command,
                    &cancelled,
                    Instant::now() + Duration::from_secs(1)
                )
                .unwrap_err()
                .kind,
            FixedCommandFailureKind::Cancelled
        );

        let timed = registry
            .register("deployment-artifact-build:timed")
            .unwrap();
        let command = FixedCommand::new(
            "sh",
            &root,
            [OsString::from("-c"), OsString::from("sleep 10 & wait")],
        );
        let started = Instant::now();
        assert_eq!(
            executor
                .execute(
                    &command,
                    &timed,
                    Instant::now() + Duration::from_millis(100)
                )
                .unwrap_err()
                .kind,
            FixedCommandFailureKind::TimedOut
        );
        assert!(started.elapsed() < Duration::from_secs(3));

        let output = registry
            .register("deployment-artifact-build:output")
            .unwrap();
        let command = FixedCommand::new(
            "sh",
            &root,
            [
                OsString::from("-c"),
                OsString::from("yes x | head -c 600000"),
            ],
        );
        assert_eq!(
            executor
                .execute(&command, &output, Instant::now() + Duration::from_secs(3))
                .unwrap_err()
                .kind,
            FixedCommandFailureKind::OutputLimit
        );

        let secret = registry
            .register("deployment-artifact-build:redaction")
            .unwrap();
        std::env::set_var("SHELLSPAN_ARTIFACT_TEST_TOKEN", "local-super-secret");
        let mut command = FixedCommand::new(
            "sh",
            &root,
            [
                OsString::from("-c"),
                OsString::from("printf '%s' \"$SHELLSPAN_ARTIFACT_TEST_TOKEN\""),
            ],
        );
        command
            .env
            .push(("SHELLSPAN_ARTIFACT_TEST_TOKEN", "local-super-secret".into()));
        let redacted = executor
            .execute(&command, &secret, Instant::now() + Duration::from_secs(1))
            .unwrap();
        std::env::remove_var("SHELLSPAN_ARTIFACT_TEST_TOKEN");
        assert_eq!(redacted.stdout, "[REDACTED]");
    }
}
