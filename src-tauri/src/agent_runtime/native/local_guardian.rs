//! Headless, application-owned controller. Cleanup authority never comes from a PID.
use super::process::{ManagedProcessNative, ProcessSnapshotNative};
use crate::agent_runtime::{AgentSandboxContract, ProcessSignalNative};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use uuid::Uuid;

const MAX_FRAME: u64 = 8 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalCleanupCapsule {
    directory: PathBuf,
    job: String,
    digest: String,
    token: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Launch {
    pub task: String,
    pub request: String,
    pub target: String,
    pub command: String,
    pub contract: Option<AgentSandboxContract>,
    pub timeout_ms: u64,
    pub custody: LocalCleanupCapsule,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", deny_unknown_fields)]
pub(super) enum Control {
    Write {
        id: String,
        input: String,
        close: bool,
    },
    Stop {
        signal: ProcessSignalNative,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub(super) enum Message {
    NotStarted,
    Failure {
        code: String,
    },
    Snapshot {
        snapshot: ProcessSnapshotNative,
        routes: Vec<super::network_proxy::ServiceRoute>,
        temp: Option<PathBuf>,
    },
    Written {
        id: String,
        accepted: Option<usize>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    job: String,
    digest: String,
    termination_confirmed: bool,
    cleanup_confirmed: bool,
    exit_code: Option<i32>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedReceipt {
    encoded: String,
    proof: String,
}

impl LocalCleanupCapsule {
    pub(crate) fn bound_to(&self, root: &Path) -> bool {
        self.directory.parent() == Some(root)
            && self
                .directory
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("local-cleanup-"))
    }
    pub(super) fn create(
        root: &Path,
        contract: Option<&AgentSandboxContract>,
    ) -> Result<Self, String> {
        let directory = tempfile::Builder::new()
            .prefix("local-cleanup-")
            .tempdir_in(root)
            .map_err(|_| "directOwnershipUnavailable")?;
        let directory =
            std::fs::canonicalize(directory.keep()).map_err(|_| "directOwnershipUnavailable")?;
        let digest = hex::encode(Sha256::digest(
            serde_json::to_vec(&contract).map_err(|_| "directOwnershipInvalid")?,
        ));
        Ok(Self {
            directory,
            digest,
            job: Uuid::new_v4().to_string(),
            token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        })
    }

    fn validate(&self) -> Result<(), String> {
        Uuid::parse_str(&self.job).map_err(|_| "directOwnershipInvalid")?;
        if !self.directory.is_absolute()
            || self.digest.len() != 64
            || hex::decode(&self.token)
                .map_err(|_| "directOwnershipInvalid")?
                .len()
                != 32
        {
            return Err("directOwnershipInvalid".into());
        }
        let metadata =
            std::fs::symlink_metadata(&self.directory).map_err(|_| "directCleanupUnconfirmed")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("directOwnershipInvalid".into());
        }
        Ok(())
    }

    fn mac(&self) -> Result<Hmac<Sha256>, String> {
        Hmac::<Sha256>::new_from_slice(
            &hex::decode(&self.token).map_err(|_| "directOwnershipInvalid")?,
        )
        .map_err(|_| "directOwnershipInvalid".into())
    }

    fn write_receipt(&self, snapshot: &ProcessSnapshotNative) -> Result<(), String> {
        let receipt = Receipt {
            job: self.job.clone(),
            digest: self.digest.clone(),
            termination_confirmed: snapshot.termination_confirmed,
            cleanup_confirmed: snapshot.termination_confirmed
                && snapshot
                    .network_proxy
                    .as_ref()
                    .is_none_or(|audit| audit.closed),
            exit_code: snapshot.exit_code,
        };
        self.write_terminal_receipt(receipt)
    }

    fn write_terminal_receipt(&self, receipt: Receipt) -> Result<(), String> {
        self.validate()?;
        let encoded = serde_json::to_vec(&receipt).map_err(|_| "directOwnershipInvalid")?;
        let mut mac = self.mac()?;
        mac.update(&encoded);
        let signed = SignedReceipt {
            encoded: hex::encode(encoded),
            proof: hex::encode(mac.finalize().into_bytes()),
        };
        use std::os::unix::fs::OpenOptionsExt;
        let pending = self.directory.join("receipt.pending");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&pending)
            .map_err(|_| "directCleanupUnconfirmed")?;
        serde_json::to_writer(&mut file, &signed).map_err(|_| "directCleanupUnconfirmed")?;
        file.sync_all().map_err(|_| "directCleanupUnconfirmed")?;
        std::fs::rename(pending, self.directory.join("receipt.json"))
            .map_err(|_| "directCleanupUnconfirmed")?;
        std::fs::File::open(&self.directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| "directCleanupUnconfirmed".to_string())
    }

    pub(crate) fn reconcile(&self) -> Result<(), String> {
        self.validate()?;
        use std::os::unix::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.directory.join("receipt.json"))
            .map_err(|_| "directCleanupUnconfirmed")?;
        if !file
            .metadata()
            .map_err(|_| "directCleanupUnconfirmed")?
            .is_file()
        {
            return Err("directCleanupUnconfirmed".into());
        }
        let signed: SignedReceipt =
            serde_json::from_reader(file.take(16385)).map_err(|_| "directCleanupUnconfirmed")?;
        let bytes = hex::decode(signed.encoded).map_err(|_| "directCleanupUnconfirmed")?;
        let mut mac = self.mac()?;
        mac.update(&bytes);
        mac.verify_slice(&hex::decode(signed.proof).map_err(|_| "directCleanupUnconfirmed")?)
            .map_err(|_| "directCleanupUnconfirmed")?;
        let receipt: Receipt =
            serde_json::from_slice(&bytes).map_err(|_| "directCleanupUnconfirmed")?;
        if receipt.job != self.job
            || receipt.digest != self.digest
            || !receipt.termination_confirmed
            || !receipt.cleanup_confirmed
        {
            return Err("directCleanupUnconfirmed".into());
        }
        Ok(())
    }

    pub(crate) fn retire(&self) -> Result<(), String> {
        if !self
            .directory
            .try_exists()
            .map_err(|_| "directCleanupUnconfirmed")?
        {
            return Ok(());
        }
        self.validate()?;
        match std::fs::remove_file(self.directory.join("receipt.json")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("directCleanupUnconfirmed".into()),
        }
        std::fs::remove_dir(&self.directory).map_err(|_| "directCleanupUnconfirmed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn real_terminal_receipt() -> (
        tempfile::TempDir,
        LocalCleanupCapsule,
        ProcessSnapshotNative,
    ) {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let target = serde_json::from_value(serde_json::json!({"kind":"local","targetId":"receipt-test","sessionId":"receipt-test","cwd":project})).unwrap();
        let contract = AgentSandboxContract::freeze(
            Some(crate::agent_runtime::AgentSandboxPolicy::Workspace),
            &target,
            crate::agent_runtime::AgentExecutionSurface::Direct,
            0,
        )
        .unwrap();
        let capsule = LocalCleanupCapsule::create(root.path(), Some(&contract)).unwrap();
        let mut command = std::process::Command::new("/bin/sh");
        command
            .args(["-c", "printf real-cleanup"])
            .stdin(std::process::Stdio::null());
        let process = super::super::process::spawn_local_child_native(
            "receipt-test".into(),
            "receipt-test".into(),
            "receipt-test".into(),
            command,
            Some(tempfile::tempdir().unwrap()),
            Duration::from_secs(2),
        )
        .unwrap();
        let snapshot = process.wait(Duration::from_secs(5)).unwrap();
        assert!(snapshot.termination_confirmed);
        assert_eq!(snapshot.stdout, "real-cleanup");
        capsule.write_receipt(&snapshot).unwrap();
        (root, capsule, snapshot)
    }

    #[test]
    fn actual_terminal_cleanup_requires_exact_signed_custody() {
        let (_root, capsule, _) = real_terminal_receipt();
        capsule.reconcile().unwrap();
        let mut other = capsule.clone();
        other.job = Uuid::new_v4().to_string();
        assert!(other.reconcile().is_err());
        other = capsule.clone();
        other.token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        assert!(other.reconcile().is_err());
        let receipt = capsule.directory.join("receipt.json");
        let mut value: SignedReceipt =
            serde_json::from_slice(&std::fs::read(&receipt).unwrap()).unwrap();
        value.proof = "00".repeat(32);
        std::fs::write(receipt, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(capsule.reconcile().is_err());
    }

    #[test]
    fn receipt_missing_or_symlink_never_authorizes_recovery() {
        let (_root, capsule, _) = real_terminal_receipt();
        let receipt = capsule.directory.join("receipt.json");
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::copy(&receipt, outside.path()).unwrap();
        std::fs::remove_file(&receipt).unwrap();
        assert!(capsule.reconcile().is_err());
        std::os::unix::fs::symlink(outside.path(), &receipt).unwrap();
        assert!(capsule.reconcile().is_err());
    }

    #[test]
    fn owned_receipt_artifacts_retire_idempotently_after_confirmation() {
        let (root, capsule, _) = real_terminal_receipt();
        assert!(capsule.bound_to(&std::fs::canonicalize(root.path()).unwrap()));
        assert!(!capsule.bound_to(root.path().join("project").as_path()));
        capsule.reconcile().unwrap();
        capsule.retire().unwrap();
        capsule.retire().unwrap();
        assert!(!capsule.directory.exists());
    }
}

pub(super) fn read_frame<T: for<'de> Deserialize<'de>>(
    reader: &mut impl BufRead,
) -> Result<T, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_FRAME + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| "localControllerUnavailable")?;
    if bytes.len() as u64 > MAX_FRAME || bytes.last() != Some(&b'\n') {
        return Err("localControllerUnavailable".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "localControllerUnavailable".into())
}

pub(super) fn write_frame(value: &impl Serialize, writer: &mut impl Write) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "localControllerUnavailable")?;
    if bytes.len() as u64 + 1 > MAX_FRAME {
        return Err("localControllerUnavailable".into());
    }
    writer
        .write_all(&bytes)
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|_| "localControllerUnavailable".into())
}

/// Runs before Tauri initialization; stdout is only framed IPC, never diagnostics.
pub(crate) fn run() -> Result<(), String> {
    let result = std::panic::catch_unwind(run_inner)
        .unwrap_or_else(|_| Err("localControllerPanicked".into()));
    if let Err(error) = &result {
        let _ = write_frame(
            &Message::Failure {
                code: crate::redaction::redact_sensitive_text(error),
            },
            &mut std::io::stdout(),
        );
    }
    result
}

fn run_inner() -> Result<(), String> {
    let mut input = BufReader::new(std::io::stdin());
    let launch: Launch = read_frame(&mut input)?;
    launch.custody.validate()?;
    if launch.timeout_ms == 0
        || launch.timeout_ms > 86_400_000
        || launch
            .contract
            .as_ref()
            .is_some_and(|contract| contract.target.kind != "local")
        || (launch.contract.is_none() && !launch.command.is_empty())
    {
        return Err("localControllerUnavailable".into());
    }
    let digest = hex::encode(Sha256::digest(
        serde_json::to_vec(&launch.contract).map_err(|_| "localControllerUnavailable")?,
    ));
    if digest != launch.custody.digest {
        return Err("localControllerUnavailable".into());
    }
    let (tx, rx) = mpsc::sync_channel(4);
    std::thread::spawn(move || {
        while let Ok(control) = read_frame::<Control>(&mut input) {
            if tx.send(control).is_err() {
                return;
            }
        }
        // EOF, malformed framing and parent death all close execution.
        let _ = tx.send(Control::Stop {
            signal: ProcessSignalNative::Kill,
        });
    });
    if launch.contract.is_none() {
        let workspace = tempfile::tempdir().map_err(|_| "sandboxTempUnavailable")?;
        let target = serde_json::from_value(serde_json::json!({"kind":"local","targetId":"sandbox-preflight","sessionId":"sandbox-preflight","cwd":workspace.path()})).map_err(|_| "sandboxPreflightInvalid")?;
        let contract = AgentSandboxContract::freeze(
            Some(crate::agent_runtime::AgentSandboxPolicy::ReadOnly),
            &target,
            crate::agent_runtime::AgentExecutionSurface::Direct,
            0,
        )?;
        let command = "printf native-ready";
        #[cfg(debug_assertions)]
        let command = if running_preflight_check() {
            "printf native-ready; kill -STOP $$"
        } else {
            command
        };
        let (mut child, temp) = super::macos_sandbox::command(command, &contract)?;
        #[cfg(debug_assertions)]
        let temp_path = temp.path().to_path_buf();
        #[cfg(debug_assertions)]
        preflight_checkpoint(&launch.custody, workspace.path(), &temp_path, None)?;
        child.stdin(std::process::Stdio::null());
        let timeout = Duration::from_millis(launch.timeout_ms);
        #[cfg(debug_assertions)]
        let timeout = if running_preflight_check() {
            Duration::from_secs(15)
        } else {
            timeout
        };
        let process = super::process::spawn_local_child_native(
            launch.task,
            launch.request,
            launch.target,
            child,
            Some(temp),
            timeout,
        )?;
        #[cfg(debug_assertions)]
        preflight_checkpoint(
            &launch.custody,
            workspace.path(),
            &temp_path,
            process.acceptance_child_pid.get().copied(),
        )?;
        let snapshot = match wait_preflight(&process, &rx) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let _ = workspace.keep();
                return Err(error);
            }
        };
        if !snapshot.termination_confirmed {
            let _ = workspace.keep();
            return Err("directCleanupUnconfirmed".into());
        }
        workspace.close().map_err(|_| "directCleanupUnconfirmed")?;
        launch.custody.write_receipt(&snapshot)?;
        let _ = write_frame(
            &Message::Snapshot {
                snapshot,
                routes: Vec::new(),
                temp: process.guardian_temp(),
            },
            &mut std::io::stdout(),
        );
        return Ok(());
    }
    if !super::macos_sandbox::verify_backend_for_controller() {
        return Err("sandboxBackendUnavailable: independent controller preflight failed".into());
    }
    let mut queued = Vec::new();
    loop {
        match rx.try_recv() {
            Ok(Control::Write { id, input, close }) => {
                queued.push(Control::Write { id, input, close })
            }
            Ok(Control::Stop { .. }) | Err(mpsc::TryRecvError::Disconnected) => {
                // Our fixed preflight has fully settled, and no user command
                // or proxy has been created. This is definite not-started.
                launch.custody.write_terminal_receipt(Receipt {
                    job: launch.custody.job.clone(),
                    digest: launch.custody.digest.clone(),
                    termination_confirmed: true,
                    cleanup_confirmed: true,
                    exit_code: None,
                })?;
                let _ = write_frame(&Message::NotStarted, &mut std::io::stdout());
                return Ok(());
            }
            Err(mpsc::TryRecvError::Empty) => break,
        }
    }
    let process = super::process::spawn_sandboxed_local_process_native(
        launch.task,
        launch.request,
        launch.target,
        &launch.command,
        launch
            .contract
            .as_ref()
            .ok_or("localControllerUnavailable")?,
        Duration::from_millis(launch.timeout_ms),
    )?;
    for control in queued {
        if let Control::Write { id, input, close } = control {
            let accepted = process.write_stdin(input, close).ok();
            let _ = write_frame(&Message::Written { id, accepted }, &mut std::io::stdout());
        }
    }
    supervise(process, launch.custody, rx)
}

fn wait_preflight(
    process: &ManagedProcessNative,
    controls: &mpsc::Receiver<Control>,
) -> Result<ProcessSnapshotNative, String> {
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match controls.try_recv() {
            Ok(Control::Stop { .. }) | Err(mpsc::TryRecvError::Disconnected) => {
                return process.kill(ProcessSignalNative::Kill, Duration::from_secs(4));
            }
            Ok(Control::Write { .. }) | Err(mpsc::TryRecvError::Empty) => {}
        }
        let snapshot = process.wait(Duration::from_millis(20))?;
        if snapshot.state.is_terminal() {
            return Ok(snapshot);
        }
        if Instant::now() >= deadline {
            return process.kill(ProcessSignalNative::Kill, Duration::from_secs(4));
        }
    }
}

#[cfg(debug_assertions)]
fn running_preflight_check() -> bool {
    std::env::var("SHELLSPAN_NATIVE_SHUTDOWN_CHECK").as_deref() == Ok("preflight-crash-seed")
        && std::env::var("SHELLSPAN_PREFLIGHT_RUNNING_CHECK").as_deref() == Ok("1")
}

/// Isolated timing barriers; no credential, cleanup or receipt bypass.
#[cfg(debug_assertions)]
fn preflight_checkpoint(
    custody: &LocalCleanupCapsule,
    workspace: &Path,
    temp: &Path,
    shell_pid: Option<u32>,
) -> Result<(), String> {
    if std::env::var("SHELLSPAN_NATIVE_SHUTDOWN_CHECK").as_deref() != Ok("preflight-crash-seed") {
        return Ok(());
    }
    if running_preflight_check() != shell_pid.is_some() {
        return Ok(());
    }
    let root = PathBuf::from(
        std::env::var_os("SHELLSPAN_PREFLIGHT_CHECK_ROOT")
            .ok_or("Preflight checkpoint root missing")?,
    );
    if !root.is_absolute()
        || std::fs::canonicalize(&root).ok().as_ref() != Some(&root)
        || !custody.directory.starts_with(root.join("state"))
    {
        return Err("Preflight checkpoint outside isolated state".into());
    }
    let value = serde_json::json!({"controllerPid":std::process::id(),
        "appPid":unsafe {libc::getppid()},"fixtureRoot":root,
        "directories":[workspace,temp],"receiptPending":!custody.directory.join("receipt.json").exists(),
        "shellPid":shell_pid,
        "window":if shell_pid.is_some() {"real fixed preflight Shell started; printf executed; debug SIGSTOP timing injection before parent SIGKILL"} else {"controller running, real workspace and command temp allocated, before fixed Shell spawn"}});
    std::fs::write(
        root.join("preflight-ready.pending.json"),
        serde_json::to_vec(&value).map_err(|_| "Preflight checkpoint invalid")?,
    )
    .map_err(|_| "Preflight checkpoint unavailable")?;
    std::fs::rename(
        root.join("preflight-ready.pending.json"),
        root.join("preflight-ready.json"),
    )
    .map_err(|_| "Preflight checkpoint unavailable")?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while !root.join("preflight-release").is_file() {
        if Instant::now() >= deadline {
            return Err("Preflight checkpoint timed out".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

fn supervise(
    process: Arc<ManagedProcessNative>,
    custody: LocalCleanupCapsule,
    controls: mpsc::Receiver<Control>,
) -> Result<(), String> {
    let mut output = std::io::stdout();
    let mut parent_present = true;
    let mut last = Instant::now() - Duration::from_secs(1);
    loop {
        match controls.recv_timeout(Duration::from_millis(20)) {
            Ok(Control::Stop { signal }) => {
                let _ = process.kill(signal, Duration::from_secs(4));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = process.kill(ProcessSignalNative::Kill, Duration::from_secs(4));
            }
            Ok(Control::Write { id, input, close }) => {
                let accepted = process.write_stdin(input, close).ok();
                if write_frame(&Message::Written { id, accepted }, &mut output).is_err() {
                    parent_present = false;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        let snapshot = process.snapshot()?;
        if snapshot.state.is_terminal() {
            custody.write_receipt(&snapshot)?;
            if parent_present {
                let _ = write_frame(
                    &Message::Snapshot {
                        snapshot,
                        routes: process.guardian_routes(),
                        temp: process.guardian_temp(),
                    },
                    &mut output,
                );
            }
            return Ok(());
        }
        if parent_present && last.elapsed() >= Duration::from_millis(100) {
            if write_frame(
                &Message::Snapshot {
                    snapshot,
                    routes: process.guardian_routes(),
                    temp: process.guardian_temp(),
                },
                &mut output,
            )
            .is_err()
            {
                parent_present = false;
                let _ = process.kill(ProcessSignalNative::Kill, Duration::from_secs(4));
            }
            last = Instant::now();
        }
    }
}
