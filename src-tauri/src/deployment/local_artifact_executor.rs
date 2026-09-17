//! Closed local artifact producers for Deployment Workflow.
//!
//! Package-manager binaries and argument vectors are selected by native code.
//! Workflow data can select only a reviewed manager, script name, and bounded
//! relative paths; no shell or caller-provided argument tail is accepted.

use super::artifact_cas::{ArtifactBlobSource, DeploymentArtifactCas};
use super::canonicalization::canonical_sha256;
use super::file_tree_artifact::{
    create_deterministic_file_tree, digest_file, normalize_archive_path, validate_zip_archive,
    FILE_TREE_COMPONENT_NAME, FILE_TREE_MEDIA_TYPE, MAX_FILE_TREE_TOTAL_BYTES,
};
use super::node_executor::{NodeFailure, PlannedNode};
use super::node_registry::{ARTIFACT_TYPE_BINARY, ARTIFACT_TYPE_FILE_TREE, ARTIFACT_TYPE_ZIP};
use super::workflow_schema::{
    ArtifactBundleManifest, ArtifactDescriptor, ArtifactHandle, ArtifactProducer, ArtifactRole,
    ArtifactSource, FrozenSourceSnapshot,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

const MAX_SOURCE_FILES: usize = 100_000;
const MAX_SOURCE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES: u64 = 1024 * 1024;
const MAX_LOCKFILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PROCESS_STDOUT_BYTES: usize = 384 * 1024;
const MAX_PROCESS_STDERR_BYTES: usize = 128 * 1024;
const MAX_PROCESS_TOTAL_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PackageManager {
    Pnpm,
    Npm,
    Yarn,
    Bun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum InstallMode {
    Frozen,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageScriptConfig {
    pub package_manager: PackageManager,
    pub working_directory: String,
    pub install_mode: InstallMode,
    pub script_name: String,
    pub output_directory: String,
    #[serde(default)]
    pub environment_refs: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ArtifactCollectKind {
    FileTree,
    Binary,
    Zip,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArtifactCollectConfig {
    pub kind: ArtifactCollectKind,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FixedProcessSpec {
    program: &'static str,
    args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FrozenPackageMetadata {
    package_json_digest: String,
    lockfile_name: Option<String>,
    lockfile_digest: Option<String>,
    metadata_digest: String,
}

enum ProcessStream {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    StdoutClosed,
    StderrClosed,
}

#[cfg(not(target_os = "windows"))]
struct ProcessContainment;

#[cfg(not(target_os = "windows"))]
impl ProcessContainment {
    fn attach(_child: &mut Child) -> Result<Self, NodeFailure> {
        Ok(Self)
    }

    fn terminate(&self, child: &mut Child) {
        #[cfg(unix)]
        // SAFETY: the child is placed in its own process group before spawn.
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
    fn attach(child: &mut Child) -> Result<Self, NodeFailure> {
        use std::mem::{size_of, zeroed};
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(NodeFailure::definite(
                "processStart",
                std::io::Error::last_os_error().to_string(),
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
            return Err(NodeFailure::definite("processStart", error.to_string()));
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

fn failure(category: &str, message: impl Into<String>) -> NodeFailure {
    NodeFailure::definite(category, message)
}

fn spawn_reader(
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

fn safe_process(spec: &FixedProcessSpec, directory: &Path) -> Command {
    let mut command = Command::new(spec.program);
    command
        .args(&spec.args)
        .current_dir(directory)
        .env_clear()
        .env("LC_ALL", "C")
        .env("CI", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in [
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
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
}

fn apply_environment_refs(command: &mut Command, references: &[String]) -> Result<(), NodeFailure> {
    for reference in references {
        match reference.as_str() {
            "ci" => {
                command.env("CI", "true");
            }
            "node-env-production" => {
                command.env("NODE_ENV", "production");
            }
            "source-date-epoch-zero" => {
                command.env("SOURCE_DATE_EPOCH", "0");
            }
            _ => {
                return Err(failure(
                    "environmentReference",
                    format!("environment reference '{reference}' is not allowlisted"),
                ))
            }
        }
    }
    Ok(())
}

fn run_bounded_process(
    spec: &FixedProcessSpec,
    directory: &Path,
    environment_refs: &[String],
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<(), NodeFailure> {
    if cancellation.is_cancelled() {
        return Err(NodeFailure::canceled());
    }
    if Instant::now() >= deadline {
        return Err(failure("timedOut", "fixed package action timed out"));
    }
    let mut command = safe_process(spec, directory);
    apply_environment_refs(&mut command, environment_refs)?;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| failure("processStart", error.to_string()))?;
    let containment = ProcessContainment::attach(&mut child)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| failure("processIo", "failed to capture package process output"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| failure("processIo", "failed to capture package process diagnostics"))?;
    let (sender, receiver) = mpsc::sync_channel(32);
    spawn_reader(stdout, sender.clone(), true);
    spawn_reader(stderr, sender, false);
    let mut stdout_bytes = 0_usize;
    let mut stderr_bytes = 0_usize;
    let mut closed = 0_u8;
    let status = loop {
        while let Ok(stream) = receiver.try_recv() {
            match stream {
                ProcessStream::Stdout(bytes) => {
                    stdout_bytes = stdout_bytes.saturating_add(bytes.len())
                }
                ProcessStream::Stderr(bytes) => {
                    stderr_bytes = stderr_bytes.saturating_add(bytes.len())
                }
                ProcessStream::StdoutClosed | ProcessStream::StderrClosed => {
                    closed = closed.saturating_add(1)
                }
            }
        }
        if stdout_bytes > MAX_PROCESS_STDOUT_BYTES
            || stderr_bytes > MAX_PROCESS_STDERR_BYTES
            || stdout_bytes.saturating_add(stderr_bytes) > MAX_PROCESS_TOTAL_BYTES
        {
            containment.terminate(&mut child);
            let _ = child.wait();
            return Err(failure(
                "outputLimit",
                "fixed package action exceeded the output limit",
            ));
        }
        if cancellation.is_cancelled() {
            containment.terminate(&mut child);
            let _ = child.wait();
            return Err(NodeFailure::canceled());
        }
        if Instant::now() >= deadline {
            containment.terminate(&mut child);
            let _ = child.wait();
            return Err(failure("timedOut", "fixed package action timed out"));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                containment.terminate(&mut child);
                let _ = child.wait();
                return Err(failure("processWait", error.to_string()));
            }
        }
    };
    let drain_deadline = Instant::now() + Duration::from_secs(2);
    while closed < 2 && Instant::now() < drain_deadline {
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(ProcessStream::Stdout(bytes)) => {
                stdout_bytes = stdout_bytes.saturating_add(bytes.len())
            }
            Ok(ProcessStream::Stderr(bytes)) => {
                stderr_bytes = stderr_bytes.saturating_add(bytes.len())
            }
            Ok(ProcessStream::StdoutClosed | ProcessStream::StderrClosed) => {
                closed = closed.saturating_add(1)
            }
            Err(_) => break,
        }
    }
    if stdout_bytes > MAX_PROCESS_STDOUT_BYTES
        || stderr_bytes > MAX_PROCESS_STDERR_BYTES
        || stdout_bytes.saturating_add(stderr_bytes) > MAX_PROCESS_TOTAL_BYTES
    {
        return Err(failure(
            "outputLimit",
            "fixed package action exceeded the output limit",
        ));
    }
    if !status.success() {
        return Err(failure(
            "processFailed",
            format!("fixed package action exited with {status}"),
        ));
    }
    Ok(())
}

fn manager_program(manager: PackageManager) -> &'static str {
    match manager {
        PackageManager::Pnpm => "pnpm",
        PackageManager::Npm => "npm",
        PackageManager::Yarn => "yarn",
        PackageManager::Bun => "bun",
    }
}

fn package_commands(config: &PackageScriptConfig) -> Vec<FixedProcessSpec> {
    let mut commands = Vec::new();
    if config.install_mode == InstallMode::Frozen {
        commands.push(FixedProcessSpec {
            program: manager_program(config.package_manager),
            args: match config.package_manager {
                PackageManager::Pnpm => {
                    vec![
                        "install".into(),
                        "--frozen-lockfile".into(),
                        "--ignore-scripts".into(),
                    ]
                }
                PackageManager::Npm => vec!["ci".into(), "--ignore-scripts".into()],
                PackageManager::Yarn => vec![
                    "install".into(),
                    "--frozen-lockfile".into(),
                    "--ignore-scripts".into(),
                ],
                PackageManager::Bun => vec![
                    "install".into(),
                    "--frozen-lockfile".into(),
                    "--ignore-scripts".into(),
                ],
            },
        });
    }
    commands.push(FixedProcessSpec {
        program: manager_program(config.package_manager),
        args: vec!["run".into(), config.script_name.clone()],
    });
    commands
}

fn package_lockfiles(manager: PackageManager) -> &'static [&'static str] {
    match manager {
        PackageManager::Pnpm => &["pnpm-lock.yaml"],
        PackageManager::Npm => &["package-lock.json", "npm-shrinkwrap.json"],
        PackageManager::Yarn => &["yarn.lock"],
        PackageManager::Bun => &["bun.lock", "bun.lockb"],
    }
}

fn bounded_file_digest(path: &Path, maximum: u64) -> Result<String, NodeFailure> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| failure("packageMetadata", error.to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(failure(
            "packageMetadata",
            "package metadata must be a regular file",
        ));
    }
    if metadata.len() > maximum {
        return Err(failure(
            "packageMetadata",
            "package metadata exceeds the size limit",
        ));
    }
    Ok(digest_file(path)?.0)
}

fn freeze_package_metadata(
    workspace_root: &Path,
    working_directory: &Path,
    config: &PackageScriptConfig,
) -> Result<FrozenPackageMetadata, NodeFailure> {
    let package_json = working_directory.join("package.json");
    let package_json_digest = bounded_file_digest(&package_json, MAX_PACKAGE_JSON_BYTES)?;
    let package_bytes =
        fs::read(&package_json).map_err(|error| failure("packageMetadata", error.to_string()))?;
    let package: Value = serde_json::from_slice(&package_bytes)
        .map_err(|error| failure("packageMetadata", error.to_string()))?;
    let script = package
        .get("scripts")
        .and_then(Value::as_object)
        .and_then(|scripts| scripts.get(&config.script_name))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            failure(
                "packageScript",
                "selected script is missing from the frozen package.json",
            )
        })?;
    if script.is_empty() || script.len() > 16 * 1024 {
        return Err(failure(
            "packageScript",
            "frozen package script is empty or exceeds the safety limit",
        ));
    }
    let mut cursor = Some(working_directory);
    let mut lockfile = None;
    while let Some(directory) = cursor {
        for name in package_lockfiles(config.package_manager) {
            let candidate = directory.join(name);
            if candidate.exists() {
                lockfile = Some(((*name).to_string(), candidate));
                break;
            }
        }
        if lockfile.is_some() || directory == workspace_root {
            break;
        }
        cursor = directory
            .parent()
            .filter(|parent| parent.starts_with(workspace_root));
    }
    if config.install_mode == InstallMode::Frozen && lockfile.is_none() {
        return Err(failure(
            "packageLockfile",
            "frozen install requires the selected package manager lockfile",
        ));
    }
    let (lockfile_name, lockfile_digest) = match lockfile {
        Some((name, path)) => (
            Some(name),
            Some(bounded_file_digest(&path, MAX_LOCKFILE_BYTES)?),
        ),
        None => (None, None),
    };
    let metadata_digest = canonical_sha256(&serde_json::json!({
        "packageJsonDigest": package_json_digest,
        "lockfileName": lockfile_name,
        "lockfileDigest": lockfile_digest,
        "packageManager": manager_program(config.package_manager),
        "scriptName": config.script_name,
    }))
    .map_err(|error| failure("packageMetadata", error.to_string()))?;
    Ok(FrozenPackageMetadata {
        package_json_digest,
        lockfile_name,
        lockfile_digest,
        metadata_digest,
    })
}

fn git_files(
    source_root: &Path,
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<Vec<String>, NodeFailure> {
    let output_file =
        tempfile::NamedTempFile::new().map_err(|error| failure("artifactIo", error.to_string()))?;
    let stdout = output_file
        .reopen()
        .map_err(|error| failure("artifactIo", error.to_string()))?;
    let mut child = Command::new("git")
        .args([
            "-c",
            "core.quotepath=false",
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .current_dir(source_root)
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| failure("sourceUnavailable", error.to_string()))?;
    let status = loop {
        if cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(NodeFailure::canceled());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(failure("timedOut", "source snapshot copy timed out"));
        }
        if output_file
            .as_file()
            .metadata()
            .map_err(|error| failure("artifactIo", error.to_string()))?
            .len()
            > 16 * 1024 * 1024
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(failure(
                "artifactLimit",
                "tracked source file list exceeds the safety limit",
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                let _ = child.kill();
                return Err(failure("sourceUnavailable", error.to_string()));
            }
        }
    };
    if !status.success() {
        return Err(failure(
            "sourceUnavailable",
            "tracked source file list is unavailable",
        ));
    }
    let mut stdout = Vec::new();
    output_file
        .reopen()
        .and_then(|mut file| file.read_to_end(&mut stdout))
        .map_err(|error| failure("artifactIo", error.to_string()))?;
    let mut files = Vec::new();
    for value in stdout.split(|byte| *byte == 0) {
        if value.is_empty() {
            continue;
        }
        let value = std::str::from_utf8(value)
            .map_err(|_| failure("pathEncoding", "source path must be valid UTF-8"))?;
        normalize_archive_path(Path::new(value))?;
        files.push(value.to_string());
    }
    files.sort();
    files.dedup();
    if files.is_empty() || files.len() > MAX_SOURCE_FILES {
        return Err(failure(
            "artifactLimit",
            "source file count is outside the allowed range",
        ));
    }
    Ok(files)
}

fn copy_frozen_workspace(
    source_root: &Path,
    destination: &Path,
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<(), NodeFailure> {
    let canonical_root = fs::canonicalize(source_root)
        .map_err(|error| failure("sourceUnavailable", error.to_string()))?;
    let files = git_files(&canonical_root, cancellation, deadline)?;
    let mut total = 0_u64;
    for relative in files {
        if cancellation.is_cancelled() {
            return Err(NodeFailure::canceled());
        }
        if Instant::now() >= deadline {
            return Err(failure("timedOut", "source snapshot copy timed out"));
        }
        let source = canonical_root.join(&relative);
        let metadata = fs::symlink_metadata(&source)
            .map_err(|error| failure("sourceUnavailable", error.to_string()))?;
        if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
            return Err(failure(
                "unsafeFileType",
                "isolated build workspace accepts regular files only",
            ));
        }
        total = total
            .checked_add(metadata.len())
            .ok_or_else(|| failure("artifactLimit", "source size overflow"))?;
        if total > MAX_SOURCE_BYTES {
            return Err(failure(
                "artifactLimit",
                "source snapshot exceeds the isolated-workspace size limit",
            ));
        }
        let destination_path = destination.join(&relative);
        if let Some(parent) = destination_path.parent() {
            fs::create_dir_all(parent).map_err(|error| failure("artifactIo", error.to_string()))?;
        }
        fs::copy(&source, &destination_path)
            .map_err(|error| failure("artifactIo", error.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if metadata.permissions().mode() & 0o111 != 0 {
                0o755
            } else {
                0o644
            };
            fs::set_permissions(&destination_path, fs::Permissions::from_mode(mode))
                .map_err(|error| failure("artifactIo", error.to_string()))?;
        }
    }
    Ok(())
}

fn file_tree_manifest(
    source: &FrozenSourceSnapshot,
    planned: &PlannedNode,
    producer_type: &str,
    summary: &super::file_tree_artifact::FileTreeArchiveSummary,
    annotations: BTreeMap<String, String>,
) -> ArtifactBundleManifest {
    ArtifactBundleManifest {
        schema_version: 2,
        artifact_type: ARTIFACT_TYPE_FILE_TREE.into(),
        source: ArtifactSource {
            revision: source.revision.clone(),
            dirty: source.dirty,
            snapshot_digest: source.snapshot_digest.clone(),
        },
        components: vec![ArtifactDescriptor {
            name: FILE_TREE_COMPONENT_NAME.into(),
            role: ArtifactRole::Application,
            media_type: FILE_TREE_MEDIA_TYPE.into(),
            digest: summary.digest.clone(),
            size: summary.size,
            platform: None,
            annotations: BTreeMap::from([
                ("fileCount".into(), summary.file_count.to_string()),
                ("directoryCount".into(), summary.directory_count.to_string()),
                ("unpackedSize".into(), summary.unpacked_size.to_string()),
            ]),
        }],
        producer: ArtifactProducer {
            node_type: producer_type.into(),
            node_type_version: 1,
            config_digest: planned.config_digest.clone(),
        },
        annotations,
    }
}

fn publish_one(
    artifacts: &DeploymentArtifactCas,
    manifest: &ArtifactBundleManifest,
    path: PathBuf,
    digest: String,
) -> Result<ArtifactHandle, NodeFailure> {
    artifacts
        .publish_bundle(manifest, &[ArtifactBlobSource { digest, path }])
        .map(|projection| projection.handle)
        .map_err(|error| failure("artifactPublish", error))
}

pub(crate) fn execute_package_script_build<F>(
    source_root: &Path,
    source: &FrozenSourceSnapshot,
    config: &PackageScriptConfig,
    planned: &PlannedNode,
    artifacts: &DeploymentArtifactCas,
    cancellation: &CancellationToken,
    timeout: Duration,
    verify_source: F,
) -> Result<ArtifactHandle, NodeFailure>
where
    F: Fn() -> Result<(), NodeFailure>,
{
    let deadline = Instant::now() + timeout;
    if config.environment_refs.len() > 16 {
        return Err(failure(
            "environmentReference",
            "environment reference count exceeds the limit",
        ));
    }
    let mut unique = BTreeSet::new();
    for reference in &config.environment_refs {
        if !unique.insert(reference) {
            return Err(failure(
                "environmentReference",
                "environment references must be unique",
            ));
        }
    }
    let temporary =
        tempfile::tempdir().map_err(|error| failure("artifactIo", error.to_string()))?;
    let workspace = temporary.path().join("workspace");
    fs::create_dir(&workspace).map_err(|error| failure("artifactIo", error.to_string()))?;
    copy_frozen_workspace(source_root, &workspace, cancellation, deadline)?;
    let working_directory = if config.working_directory == "." {
        workspace.clone()
    } else {
        workspace.join(&config.working_directory)
    };
    let canonical_working = fs::canonicalize(&working_directory)
        .map_err(|error| failure("pathBoundary", error.to_string()))?;
    if !canonical_working.starts_with(&workspace) || !canonical_working.is_dir() {
        return Err(failure(
            "pathBoundary",
            "package working directory escapes the isolated workspace",
        ));
    }
    let frozen = freeze_package_metadata(&workspace, &canonical_working, config)?;
    for command in package_commands(config) {
        run_bounded_process(
            &command,
            &canonical_working,
            &config.environment_refs,
            cancellation,
            deadline,
        )?;
    }
    let observed = freeze_package_metadata(&workspace, &canonical_working, config)?;
    if observed != frozen {
        return Err(failure(
            "packageMetadataChanged",
            "package.json or lockfile changed during the isolated build",
        ));
    }
    let output = canonical_working.join(&config.output_directory);
    let output =
        fs::canonicalize(&output).map_err(|error| failure("buildOutput", error.to_string()))?;
    if !output.starts_with(&workspace) || !output.is_dir() {
        return Err(failure(
            "buildOutput",
            "package build output is not a directory inside the isolated workspace",
        ));
    }
    let archive = temporary.path().join(FILE_TREE_COMPONENT_NAME);
    let output_relative = output
        .strip_prefix(&workspace)
        .map_err(|_| failure("pathBoundary", "build output escapes the workspace"))?
        .to_str()
        .ok_or_else(|| failure("pathEncoding", "build output path is not UTF-8"))?
        .replace('\\', "/");
    let summary =
        create_deterministic_file_tree(&workspace, &[output_relative], &archive, cancellation)?;
    if Instant::now() >= deadline {
        return Err(failure("timedOut", "file-tree packaging timed out"));
    }
    let manifest = file_tree_manifest(
        source,
        planned,
        "build.package-script",
        &summary,
        BTreeMap::from([
            (
                "packageManager".into(),
                manager_program(config.package_manager).into(),
            ),
            ("scriptName".into(), config.script_name.clone()),
            ("packageJsonDigest".into(), frozen.package_json_digest),
            ("metadataDigest".into(), frozen.metadata_digest),
            (
                "lockfileName".into(),
                frozen.lockfile_name.unwrap_or_default(),
            ),
            (
                "lockfileDigest".into(),
                frozen.lockfile_digest.unwrap_or_default(),
            ),
        ]),
    );
    verify_source()?;
    publish_one(artifacts, &manifest, archive, summary.digest)
}

pub(crate) fn execute_artifact_collect<F>(
    source_root: &Path,
    source: &FrozenSourceSnapshot,
    config: &ArtifactCollectConfig,
    planned: &PlannedNode,
    artifacts: &DeploymentArtifactCas,
    cancellation: &CancellationToken,
    verify_source: F,
) -> Result<ArtifactHandle, NodeFailure>
where
    F: Fn() -> Result<(), NodeFailure>,
{
    match config.kind {
        ArtifactCollectKind::FileTree => {
            let temporary =
                tempfile::tempdir().map_err(|error| failure("artifactIo", error.to_string()))?;
            let archive = temporary.path().join(FILE_TREE_COMPONENT_NAME);
            let summary =
                create_deterministic_file_tree(source_root, &config.paths, &archive, cancellation)?;
            let manifest = file_tree_manifest(
                source,
                planned,
                "artifact.collect",
                &summary,
                BTreeMap::from([("collectedPaths".into(), config.paths.join(","))]),
            );
            verify_source()?;
            publish_one(artifacts, &manifest, archive, summary.digest)
        }
        ArtifactCollectKind::Binary | ArtifactCollectKind::Zip => {
            if config.paths.len() != 1 {
                return Err(failure(
                    "artifactCollect",
                    "binary and zip collection require exactly one path",
                ));
            }
            let normalized = normalize_archive_path(Path::new(&config.paths[0]))?;
            let canonical_root = fs::canonicalize(source_root)
                .map_err(|error| failure("pathBoundary", error.to_string()))?;
            let member = canonical_root.join(&normalized);
            let metadata = fs::symlink_metadata(&member)
                .map_err(|error| failure("pathBoundary", error.to_string()))?;
            if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
                return Err(failure(
                    "unsafeFileType",
                    "collected artifact must be a regular file",
                ));
            }
            let canonical = fs::canonicalize(&member)
                .map_err(|error| failure("pathBoundary", error.to_string()))?;
            if !canonical.starts_with(&canonical_root) {
                return Err(failure(
                    "pathBoundary",
                    "collected artifact escapes the source workspace",
                ));
            }
            if config.kind == ArtifactCollectKind::Zip {
                validate_zip_archive(&canonical)?;
            }
            let (digest, size) = digest_file(&canonical)?;
            if size > MAX_FILE_TREE_TOTAL_BYTES {
                return Err(failure(
                    "artifactLimit",
                    "collected artifact exceeds the total size limit",
                ));
            }
            let artifact_type = if config.kind == ArtifactCollectKind::Binary {
                ARTIFACT_TYPE_BINARY
            } else {
                ARTIFACT_TYPE_ZIP
            };
            let media_type = if config.kind == ArtifactCollectKind::Binary {
                "application/octet-stream"
            } else {
                "application/zip"
            };
            let manifest = ArtifactBundleManifest {
                schema_version: 2,
                artifact_type: artifact_type.into(),
                source: ArtifactSource {
                    revision: source.revision.clone(),
                    dirty: source.dirty,
                    snapshot_digest: source.snapshot_digest.clone(),
                },
                components: vec![ArtifactDescriptor {
                    name: normalized,
                    role: ArtifactRole::Application,
                    media_type: media_type.into(),
                    digest: digest.clone(),
                    size,
                    platform: None,
                    annotations: BTreeMap::new(),
                }],
                producer: ArtifactProducer {
                    node_type: "artifact.collect".into(),
                    node_type_version: 1,
                    config_digest: planned.config_digest.clone(),
                },
                annotations: BTreeMap::new(),
            };
            verify_source()?;
            publish_one(artifacts, &manifest, canonical, digest)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> FrozenSourceSnapshot {
        FrozenSourceSnapshot {
            source_ref: "workspace".into(),
            revision: "0123456789abcdef0123456789abcdef01234567".into(),
            dirty: false,
            snapshot_digest: format!("sha256:{}", "1".repeat(64)),
            metadata_digest: format!("sha256:{}", "2".repeat(64)),
        }
    }

    fn planned(node_type: &str) -> PlannedNode {
        PlannedNode {
            schema_version: 1,
            node_id: "artifact".into(),
            node_type: node_type.into(),
            node_type_version: 1,
            executor_version: "test".into(),
            config_digest: format!("sha256:{}", "3".repeat(64)),
            input_digest: format!("sha256:{}", "4".repeat(64)),
            fixed_actions: Vec::new(),
        }
    }

    fn config(manager: PackageManager) -> PackageScriptConfig {
        PackageScriptConfig {
            package_manager: manager,
            working_directory: ".".into(),
            install_mode: InstallMode::Frozen,
            script_name: "build:safe".into(),
            output_directory: "dist".into(),
            environment_refs: vec![],
        }
    }

    #[test]
    fn package_manager_programs_and_argv_are_closed_and_never_use_a_shell() {
        for (manager, program, install) in [
            (PackageManager::Pnpm, "pnpm", "install"),
            (PackageManager::Npm, "npm", "ci"),
            (PackageManager::Yarn, "yarn", "install"),
            (PackageManager::Bun, "bun", "install"),
        ] {
            let commands = package_commands(&config(manager));
            assert_eq!(commands[0].program, program);
            assert_eq!(commands[0].args[0], install);
            assert_eq!(commands[1].program, program);
            assert_eq!(commands[1].args, ["run", "build:safe"]);
            assert!(!commands.iter().any(|command| {
                matches!(command.program, "sh" | "bash" | "cmd" | "powershell")
            }));
        }
    }

    #[test]
    fn only_closed_environment_references_are_accepted() {
        let mut command = Command::new("true");
        apply_environment_refs(
            &mut command,
            &[
                "ci".into(),
                "node-env-production".into(),
                "source-date-epoch-zero".into(),
            ],
        )
        .unwrap();
        let error = apply_environment_refs(&mut command, &["PATH".into()]).unwrap_err();
        assert_eq!(error.category, "environmentReference");
    }

    #[cfg(unix)]
    #[test]
    fn bounded_process_enforces_cancel_timeout_and_output_limits() {
        let directory = tempfile::tempdir().unwrap();
        let canceled = CancellationToken::new();
        canceled.cancel();
        let error = run_bounded_process(
            &FixedProcessSpec {
                program: "sh",
                args: vec!["-c".into(), "exit 0".into()],
            },
            directory.path(),
            &[],
            &canceled,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap_err();
        assert_eq!(
            error.disposition,
            super::super::node_executor::NodeFailureDisposition::Canceled
        );

        let error = run_bounded_process(
            &FixedProcessSpec {
                program: "sh",
                args: vec!["-c".into(), "sleep 1".into()],
            },
            directory.path(),
            &[],
            &CancellationToken::new(),
            Instant::now() + Duration::from_millis(20),
        )
        .unwrap_err();
        assert_eq!(error.category, "timedOut");

        let error = run_bounded_process(
            &FixedProcessSpec {
                program: "sh",
                args: vec![
                    "-c".into(),
                    format!("head -c {} /dev/zero", MAX_PROCESS_TOTAL_BYTES + 1),
                ],
            },
            directory.path(),
            &[],
            &CancellationToken::new(),
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap_err();
        assert_eq!(error.category, "outputLimit");
    }

    #[test]
    fn frozen_metadata_rejects_missing_script_and_lockfile() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("package.json"),
            br#"{"scripts":{"build":"true"}}"#,
        )
        .unwrap();
        let error =
            freeze_package_metadata(root.path(), root.path(), &config(PackageManager::Pnpm))
                .unwrap_err();
        assert_eq!(error.category, "packageScript");
        let mut selected = config(PackageManager::Pnpm);
        selected.script_name = "build".into();
        let error = freeze_package_metadata(root.path(), root.path(), &selected).unwrap_err();
        assert_eq!(error.category, "packageLockfile");
    }

    #[test]
    fn snapshot_collection_and_package_build_share_the_file_tree_bundle_contract() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("dist")).unwrap();
        fs::write(root.path().join("dist/index.html"), b"hello").unwrap();
        let cas = DeploymentArtifactCas::new(root.path().join("cas")).unwrap();
        let handle = execute_artifact_collect(
            root.path(),
            &source(),
            &ArtifactCollectConfig {
                kind: ArtifactCollectKind::FileTree,
                paths: vec!["dist".into()],
            },
            &planned("artifact.collect"),
            &cas,
            &CancellationToken::new(),
            || Ok(()),
        )
        .unwrap();
        let collected = cas.inspect(&handle).unwrap().manifest;
        assert_eq!(collected.artifact_type, ARTIFACT_TYPE_FILE_TREE);
        assert_eq!(collected.components.len(), 1);
        assert_eq!(collected.components[0].media_type, FILE_TREE_MEDIA_TYPE);
        let build_contract = file_tree_manifest(
            &source(),
            &planned("build.package-script"),
            "build.package-script",
            &super::super::file_tree_artifact::FileTreeArchiveSummary {
                digest: collected.components[0].digest.clone(),
                size: collected.components[0].size,
                file_count: 1,
                directory_count: 0,
                unpacked_size: 5,
            },
            BTreeMap::new(),
        );
        assert_eq!(build_contract.artifact_type, collected.artifact_type);
        assert_eq!(
            build_contract.components[0].media_type,
            collected.components[0].media_type
        );
        assert_eq!(
            build_contract.components[0].role,
            collected.components[0].role
        );
    }
}
