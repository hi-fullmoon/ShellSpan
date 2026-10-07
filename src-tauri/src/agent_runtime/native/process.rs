use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use libssh2_sys::LIBSSH2_ERROR_EAGAIN;
use serde::Serialize;
use ssh2::ErrorCode;
use uuid::Uuid;

use crate::agent_runtime::{
    AgentExecutionAdmission, AgentExecutionChannelNative, AgentExecutionFailure,
    AgentExecutionFailureKind, ProcessSignalNative,
};
use crate::execution::{
    known_connection_secret_values, open_ssh_execution_session, redact_known_secrets,
};
use crate::models::RemoteConnectionRequest;

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(20);
const STDOUT_CAPTURE_BYTES: usize = 768 * 1024;
const STDERR_CAPTURE_BYTES: usize = 256 * 1024;
const MAX_TRACKED_PROCESSES: usize = 256;
const REMOTE_READS_PER_POLL: usize = 8;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProcessLifecycleNative {
    Running,
    Exited,
    Cancelled,
    TimedOut,
    Failed,
}

impl ProcessLifecycleNative {
    pub(crate) fn is_terminal(self) -> bool {
        self != Self::Running
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessSnapshotNative {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) network_proxy: Option<crate::agent_runtime::NetworkProxyAuditNative>,
    pub(crate) process_handle: String,
    pub(crate) target_id: String,
    pub(crate) owner_target_id: String,
    pub(crate) task_id: String,
    pub(crate) request_id: String,
    pub(crate) channel: AgentExecutionChannelNative,
    pub(crate) state: ProcessLifecycleNative,
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) stdout_bytes_read: u64,
    pub(crate) stderr_bytes_read: u64,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
    pub(crate) termination_confirmed: bool,
    pub(crate) started_at_unix_ms: u64,
    pub(crate) completed_at_unix_ms: Option<u64>,
    pub(crate) error: Option<String>,
    pub(crate) failure: Option<AgentExecutionFailure>,
}

fn process_failure(state: &ProcessStateNative) -> Option<AgentExecutionFailure> {
    use AgentExecutionFailureKind as Kind;
    let (kind, code) = match state.lifecycle {
        ProcessLifecycleNative::Running => return None,
        ProcessLifecycleNative::Exited if state.exit_code == Some(0) => return None,
        ProcessLifecycleNative::Exited => (Kind::CommandFailed, "commandExitedUnsuccessfully"),
        ProcessLifecycleNative::Failed if state.error.as_deref().is_some_and(|error| error.starts_with("sandboxAuthorizationInvalid:")) => (Kind::PolicyRejected, "sandboxAuthorizationInvalid"),
        ProcessLifecycleNative::Failed if !state.termination_confirmed && state.error.as_deref().is_some_and(|error| error.starts_with("sandboxRemote")) => (Kind::TerminationUnconfirmed, "processTerminationUnconfirmed"),
        ProcessLifecycleNative::Failed => (Kind::InfrastructureFailure, "processControllerFailed"),
        ProcessLifecycleNative::Cancelled | ProcessLifecycleNative::TimedOut
            if !state.termination_confirmed =>
        {
            (
                Kind::TerminationUnconfirmed,
                "processTerminationUnconfirmed",
            )
        }
        ProcessLifecycleNative::Cancelled => (Kind::Cancelled, "processCancelled"),
        ProcessLifecycleNative::TimedOut => (Kind::TimedOut, "processDeadlineExceeded"),
    };
    Some(AgentExecutionFailure::new(kind, code, state.admission))
}

#[derive(Debug)]
pub(super) struct CaptureBufferNative {
    limit: usize,
    head_limit: usize,
    tail_limit: usize,
    head: Vec<u8>,
    tail: Vec<u8>,
    bytes_read: u64,
}

impl CaptureBufferNative {
    pub(super) fn new(limit: usize) -> Self {
        let head_limit = limit.saturating_mul(3) / 4;
        Self {
            limit,
            head_limit,
            tail_limit: limit - head_limit,
            head: Vec::with_capacity(head_limit),
            tail: Vec::with_capacity(limit - head_limit),
            bytes_read: 0,
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) {
        self.bytes_read = self.bytes_read.saturating_add(bytes.len() as u64);
        let head_count = (self.head_limit - self.head.len()).min(bytes.len());
        self.head.extend_from_slice(&bytes[..head_count]);
        let tail_bytes = &bytes[head_count..];
        if self.tail_limit == 0 || tail_bytes.is_empty() {
            return;
        }
        if tail_bytes.len() >= self.tail_limit {
            self.tail.clear();
            self.tail
                .extend_from_slice(&tail_bytes[tail_bytes.len() - self.tail_limit..]);
            return;
        }
        let excess = self
            .tail
            .len()
            .saturating_add(tail_bytes.len())
            .saturating_sub(self.tail_limit);
        if excess > 0 {
            self.tail.drain(..excess);
        }
        self.tail.extend_from_slice(tail_bytes);
    }

    pub(super) fn text(&self, secrets: &[String]) -> String {
        let mut bytes = self.head.clone();
        bytes.extend_from_slice(&self.tail);
        redact_known_secrets(&String::from_utf8_lossy(&bytes), secrets)
    }

    fn json_text(&self, secrets: &[String]) -> String {
        if self.truncated() {
            return String::new();
        }
        let mut bytes = self.head.clone();
        bytes.extend_from_slice(&self.tail);
        // Incomplete/invalid JSON never falls back to unsanitized text. The
        // diagnostic caller reports invalid output once the process completes.
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            return String::new();
        };
        let value = crate::execution::redact_known_json_values(&value, secrets);
        serde_json::to_string(&crate::redaction::redact_json_value(&value)).unwrap_or_default()
    }

    pub(super) fn truncated(&self) -> bool {
        self.bytes_read > self.limit as u64
    }
}

#[derive(Debug)]
struct ProcessStateNative {
    admission: AgentExecutionAdmission,
    lifecycle: ProcessLifecycleNative,
    exit_code: Option<i32>,
    stdout: CaptureBufferNative,
    stderr: CaptureBufferNative,
    termination_confirmed: bool,
    completed_at_unix_ms: Option<u64>,
    error: Option<String>,
}

enum ProcessControlNative {
    Write {
        input: String,
        close: bool,
        response: mpsc::SyncSender<Result<usize, String>>,
    },
    Kill {
        signal: ProcessSignalNative,
    },
}

enum ProcessOutputNative {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    StdoutClosed,
    StderrClosed,
}

pub(crate) struct ManagedProcessNative {
    #[cfg(target_os = "macos")]
    service_routes: OnceLock<Vec<super::network_proxy::ServiceRoute>>,
    #[cfg(target_os = "macos")]
    network_audit: OnceLock<Arc<super::network_proxy::NetworkAudit>>,
    sandbox_contract: OnceLock<crate::agent_runtime::AgentSandboxContract>,
    remote_sandbox: OnceLock<crate::agent_runtime::remote_seatbelt::RemoteSeatbeltJob>,
    process_handle: String,
    target_id: String,
    owner_target_id: String,
    task_id: String,
    request_id: String,
    channel: AgentExecutionChannelNative,
    started_at_unix_ms: u64,
    secrets: Vec<String>,
    json_stdout: bool,
    io_cancellation: Option<tokio_util::sync::CancellationToken>,
    state: Mutex<ProcessStateNative>,
    changed: Condvar,
    controls: mpsc::Sender<ProcessControlNative>,
}

impl ManagedProcessNative {
    fn new(
        task_id: String,
        request_id: String,
        owner_target_id: String,
        channel: AgentExecutionChannelNative,
        secrets: Vec<String>,
        controls: mpsc::Sender<ProcessControlNative>,
    ) -> Arc<Self> {
        let process_handle = format!("proc-{}", Uuid::new_v4().simple());
        let target_id = format!("process-{process_handle}");
        Arc::new(Self {
            #[cfg(target_os = "macos")]
            service_routes: OnceLock::new(),
            #[cfg(target_os = "macos")]
            network_audit: OnceLock::new(),
            sandbox_contract: OnceLock::new(),
            remote_sandbox: OnceLock::new(),
            process_handle,
            target_id,
            owner_target_id,
            task_id,
            request_id,
            channel,
            started_at_unix_ms: current_unix_ms(),
            secrets,
            json_stdout: false,
            io_cancellation: None,
            state: Mutex::new(ProcessStateNative {
                admission: AgentExecutionAdmission::NotStarted,
                lifecycle: ProcessLifecycleNative::Running,
                exit_code: None,
                stdout: CaptureBufferNative::new(STDOUT_CAPTURE_BYTES),
                stderr: CaptureBufferNative::new(STDERR_CAPTURE_BYTES),
                termination_confirmed: false,
                completed_at_unix_ms: None,
                error: None,
            }),
            changed: Condvar::new(),
            controls,
        })
    }

    pub(crate) fn validate_sandbox_input(
        &self,
        current: Option<&crate::agent_runtime::AgentSandboxContract>,
        session_id: &str,
    ) -> Result<(), String> {
        if self.remote_sandbox.get().is_some_and(|job| !job.valid()) {
            return Err("sandboxAuthorizationInvalid: remote process input binding changed".into());
        }
        match (self.sandbox_contract.get(), current) {
            (None, None) => Ok(()),
            (None, Some(contract))
                if contract.policy == crate::agent_runtime::AgentSandboxPolicy::Host =>
            {
                Ok(())
            }
            (Some(saved), Some(current))
                if saved.binding_revision == current.binding_revision
                    && saved.session_created_at_unix_ms == current.session_created_at_unix_ms
                    && saved.target == current.target
                    && saved.policy == current.policy
                    && saved.execution_surface == current.execution_surface
                    && saved.root == current.root
                    && saved.read_allow == current.read_allow
                    && saved.write_allow == current.write_allow
                    && saved.deny == current.deny
                    && saved.network == current.network
                    && (saved.resource_grants == current.resource_grants
                        || current.resource_grants.is_empty()) =>
            {
                if saved
                    .resource_grants
                    .iter()
                    .any(|grant| grant.session_id != session_id)
                {
                    return Err("sandboxAuthorizationInvalid: background resource belongs to another session".into());
                }
                saved.authorize_dispatch(&saved.target, current_unix_ms())?;
                Ok(())
            }
            _ => Err("sandboxAuthorizationInvalid: background input binding changed".into()),
        }
    }

    fn push_output(&self, output: ProcessOutputNative) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.lifecycle.is_terminal() {
            return;
        }
        match output {
            ProcessOutputNative::Stdout(bytes) => state.stdout.push(&bytes),
            ProcessOutputNative::Stderr(bytes) => state.stderr.push(&bytes),
            ProcessOutputNative::StdoutClosed | ProcessOutputNative::StderrClosed => {}
        }
        self.changed.notify_all();
    }

    fn finish(
        &self,
        lifecycle: ProcessLifecycleNative,
        exit_code: Option<i32>,
        termination_confirmed: bool,
        error: Option<String>,
    ) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.lifecycle.is_terminal() {
            return;
        }
        state.lifecycle = lifecycle;
        state.exit_code = exit_code;
        state.termination_confirmed = (termination_confirmed
            || state.admission == AgentExecutionAdmission::NotStarted)
            && self
                .network_audit_snapshot()
                .is_none_or(|audit| audit.closed);
        state.completed_at_unix_ms = Some(current_unix_ms());
        state.error = error.map(|value| redact_known_secrets(&value, &self.secrets));
        self.changed.notify_all();
    }

    fn mark_admission(&self, admission: AgentExecutionAdmission) {
        if let Ok(mut state) = self.state.lock() {
            state.admission = admission;
            self.changed.notify_all();
        }
    }

    pub(crate) fn snapshot(&self) -> Result<ProcessSnapshotNative, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Process state is unavailable".to_string())?;
        Ok(ProcessSnapshotNative {
            network_proxy: self.network_audit_snapshot(),
            process_handle: self.process_handle.clone(),
            target_id: self.target_id.clone(),
            owner_target_id: self.owner_target_id.clone(),
            task_id: self.task_id.clone(),
            request_id: self.request_id.clone(),
            channel: self.channel,
            state: state.lifecycle,
            exit_code: state.exit_code,
            stdout: self.stdout_text(&state),
            stderr: state.stderr.text(&self.secrets),
            stdout_bytes_read: state.stdout.bytes_read,
            stderr_bytes_read: state.stderr.bytes_read,
            stdout_truncated: state.stdout.truncated(),
            stderr_truncated: state.stderr.truncated(),
            termination_confirmed: state.termination_confirmed,
            started_at_unix_ms: self.started_at_unix_ms,
            completed_at_unix_ms: state.completed_at_unix_ms,
            error: state.error.clone(),
            failure: process_failure(&state),
        })
    }

    pub(crate) fn wait(&self, timeout: Duration) -> Result<ProcessSnapshotNative, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Process state is unavailable".to_string())?;
        let (state, _) = self
            .changed
            .wait_timeout_while(state, timeout, |state| !state.lifecycle.is_terminal())
            .map_err(|_| "Process state is unavailable".to_string())?;
        Ok(ProcessSnapshotNative {
            network_proxy: self.network_audit_snapshot(),
            process_handle: self.process_handle.clone(),
            target_id: self.target_id.clone(),
            owner_target_id: self.owner_target_id.clone(),
            task_id: self.task_id.clone(),
            request_id: self.request_id.clone(),
            channel: self.channel,
            state: state.lifecycle,
            exit_code: state.exit_code,
            stdout: self.stdout_text(&state),
            stderr: state.stderr.text(&self.secrets),
            stdout_bytes_read: state.stdout.bytes_read,
            stderr_bytes_read: state.stderr.bytes_read,
            stdout_truncated: state.stdout.truncated(),
            stderr_truncated: state.stderr.truncated(),
            termination_confirmed: state.termination_confirmed,
            started_at_unix_ms: self.started_at_unix_ms,
            completed_at_unix_ms: state.completed_at_unix_ms,
            error: state.error.clone(),
            failure: process_failure(&state),
        })
    }

    fn stdout_text(&self, state: &ProcessStateNative) -> String {
        if self.json_stdout {
            state.stdout.json_text(&self.secrets)
        } else {
            state.stdout.text(&self.secrets)
        }
    }

    fn network_audit_snapshot(&self) -> Option<crate::agent_runtime::NetworkProxyAuditNative> {
        #[cfg(target_os = "macos")]
        {
            self.network_audit.get().map(|audit| audit.snapshot())
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }

    pub(crate) fn write_stdin(&self, input: String, close: bool) -> Result<usize, String> {
        if self.snapshot()?.state.is_terminal() {
            return Err("Process is no longer running".into());
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        self.controls
            .send(ProcessControlNative::Write {
                input,
                close,
                response: sender,
            })
            .map_err(|_| "Process input channel is unavailable".to_string())?;
        match receiver.recv_timeout(Duration::from_secs(5)) {
            Ok(result) => result,
            Err(_) => {
                // Partial input may already have reached the child. Stop rather
                // than allowing a queued write to execute after its caller fails.
                let _ = self.controls.send(ProcessControlNative::Kill {
                    signal: ProcessSignalNative::Kill,
                });
                Err(
                    "Process input acknowledgement timed out; stop requested, do not replay input"
                        .into(),
                )
            }
        }
    }

    pub(crate) fn kill(
        &self,
        signal: ProcessSignalNative,
        timeout: Duration,
    ) -> Result<ProcessSnapshotNative, String> {
        if self.snapshot()?.state.is_terminal() {
            if !self.snapshot()?.termination_confirmed {
                if let Some(job) = self.remote_sandbox.get() {
                    if job.cleanup(true) {
                        let mut state = self.state.lock().map_err(|_| "Process state unavailable")?;
                        state.termination_confirmed = true;
                        self.changed.notify_all();
                    }
                }
            }
            return self.snapshot();
        }
        self.controls
            .send(ProcessControlNative::Kill { signal })
            .map_err(|_| "Process control channel is unavailable".to_string())?;
        if let Some(cancellation) = &self.io_cancellation {
            cancellation.cancel();
        }
        self.wait(timeout)
    }
}

#[derive(Clone, Default)]
pub(crate) struct ProcessRegistryNative {
    processes: Arc<Mutex<HashMap<String, Arc<ManagedProcessNative>>>>,
}

impl ProcessRegistryNative {
    pub(crate) fn service_socket(
        &self,
        context: &super::NativeExecutionContext,
        port: u16,
    ) -> Result<PathBuf, String> {
        #[cfg(target_os = "macos")]
        {
            let processes = self
                .processes
                .lock()
                .map_err(|_| "Process registry is unavailable")?;
            for process in processes.values() {
                if process.task_id != context.request.task_id
                    || process.snapshot()?.state != ProcessLifecycleNative::Running
                    || process
                        .network_audit_snapshot()
                        .is_none_or(|audit| audit.closed)
                    || process
                        .validate_sandbox_input(
                            context.sandbox_contract.as_ref(),
                            &context.request.user_session_id,
                        )
                        .is_err()
                {
                    continue;
                }
                if let Some(route) = process
                    .service_routes
                    .get()
                    .and_then(|routes| routes.iter().find(|route| route.port == port))
                {
                    return Ok(route.socket.clone());
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (context, port);
        }
        Err("sandboxResourceRequestInvalid: no active owned service on this port".into())
    }
    pub(crate) fn ensure_capacity(&self) -> Result<(), String> {
        let processes = self
            .processes
            .lock()
            .map_err(|_| "Process registry is unavailable".to_string())?;
        if processes.len() >= MAX_TRACKED_PROCESSES {
            return Err("Native process registry reached its bounded capacity".into());
        }
        for process in processes.values() {
            let snapshot = process.snapshot()?;
            if snapshot.state.is_terminal() && !snapshot.termination_confirmed {
                return Err(
                    "Native process cleanup remains unconfirmed; new dispatch is paused".into(),
                );
            }
        }
        Ok(())
    }

    pub(crate) fn insert(&self, process: Arc<ManagedProcessNative>) -> Result<(), String> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| "Process registry is unavailable".to_string())?;
        if processes.len() >= MAX_TRACKED_PROCESSES {
            return Err("Native process registry reached its bounded capacity".into());
        }
        if processes
            .insert(process.process_handle.clone(), process)
            .is_some()
        {
            return Err("Duplicate process handle".into());
        }
        Ok(())
    }

    pub(crate) fn get(&self, handle: &str) -> Result<Arc<ManagedProcessNative>, String> {
        self.processes
            .lock()
            .map_err(|_| "Process registry is unavailable".to_string())?
            .get(handle)
            .cloned()
            .ok_or_else(|| "Process handle was not found".to_string())
    }

    pub(crate) fn running_count(&self) -> Result<usize, String> {
        let processes = self
            .processes
            .lock()
            .map_err(|_| "Process registry is unavailable".to_string())?;
        let mut running = 0;
        for process in processes.values() {
            let snapshot = process.snapshot()?;
            if snapshot.state == ProcessLifecycleNative::Running || !snapshot.termination_confirmed
            {
                running += 1;
            }
        }
        Ok(running)
    }

    pub(crate) fn running_task_count(&self, task_id: &str) -> Result<usize, String> {
        let processes = self
            .processes
            .lock()
            .map_err(|_| "Process registry is unavailable")?;
        let mut running = 0;
        for process in processes
            .values()
            .filter(|process| process.task_id == task_id)
        {
            let snapshot = process.snapshot()?;
            if snapshot.state == ProcessLifecycleNative::Running || !snapshot.termination_confirmed
            {
                running += 1;
            }
        }
        Ok(running)
    }

    pub(crate) fn remove_terminal(
        &self,
        process_handle: &str,
        state: ProcessLifecycleNative,
    ) -> Result<(), String> {
        if state.is_terminal() {
            let mut processes = self
                .processes
                .lock()
                .map_err(|_| "Process registry is unavailable".to_string())?;
            if processes.get(process_handle).is_some_and(|process| {
                process
                    .snapshot()
                    .is_ok_and(|snapshot| snapshot.termination_confirmed)
            }) {
                processes.remove(process_handle);
            }
        }
        Ok(())
    }

    pub(crate) fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        let processes = self
            .processes
            .lock()
            .map_err(|_| "Process registry is unavailable".to_string())?
            .values()
            .filter(|process| process.task_id == task_id)
            .cloned()
            .collect::<Vec<_>>();
        let mut confirmed = Vec::new();
        let mut errors = Vec::new();
        for process in &processes {
            match process.kill(ProcessSignalNative::Kill, Duration::from_secs(2)) {
                Ok(snapshot) if snapshot.termination_confirmed => {
                    confirmed.push(process.process_handle.clone())
                }
                Ok(_) => errors.push("Native process cancellation remains unconfirmed".to_string()),
                Err(error) => errors.push(error),
            }
        }
        let mut registry = self
            .processes
            .lock()
            .map_err(|_| "Process registry is unavailable".to_string())?;
        for handle in confirmed {
            registry.remove(&handle);
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    pub(crate) fn owner_task_ids(&self) -> Result<Vec<String>, String> {
        let processes = self
            .processes
            .lock()
            .map_err(|_| "Process registry is unavailable".to_string())?;
        let mut task_ids = processes
            .values()
            .map(|process| process.task_id.clone())
            .collect::<Vec<_>>();
        task_ids.sort();
        task_ids.dedup();
        Ok(task_ids)
    }
}

pub(crate) fn spawn_local_process_native(
    task_id: String,
    request_id: String,
    owner_target_id: String,
    command: &str,
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<Arc<ManagedProcessNative>, String> {
    spawn_local_process_with_scope_native(
        task_id,
        request_id,
        owner_target_id,
        command,
        cwd,
        timeout,
        LocalFilesystemScopeNative::Unrestricted,
    )
}

// The scoped launcher currently serves the sandbox contract tests only.
#[cfg(test)]
fn spawn_workspace_scoped_local_process_native(
    task_id: String,
    request_id: String,
    owner_target_id: String,
    command: &str,
    workspace_root: &Path,
    timeout: Duration,
) -> Result<Arc<ManagedProcessNative>, String> {
    spawn_local_process_with_scope_native(
        task_id,
        request_id,
        owner_target_id,
        command,
        Some(workspace_root),
        timeout,
        LocalFilesystemScopeNative::WorkspaceOnly,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalFilesystemScopeNative {
    Unrestricted,
    #[cfg(test)]
    WorkspaceOnly,
}

fn spawn_local_process_with_scope_native(
    task_id: String,
    request_id: String,
    owner_target_id: String,
    command: &str,
    cwd: Option<&Path>,
    timeout: Duration,
    filesystem_scope: LocalFilesystemScopeNative,
) -> Result<Arc<ManagedProcessNative>, String> {
    let (mut child, sandbox_temp): (Command, Option<tempfile::TempDir>) = match filesystem_scope {
        LocalFilesystemScopeNative::Unrestricted => (local_shell_command(command), None),
        #[cfg(test)]
        LocalFilesystemScopeNative::WorkspaceOnly => {
            let root = cwd.ok_or_else(|| {
                "Operator execution requires a frozen local workspace root".to_string()
            })?;
            let (command, temp) = workspace_scoped_local_shell_command(command, root)?;
            (command, Some(temp))
        }
    };
    if let Some(cwd) = cwd {
        child.current_dir(cwd);
    }
    child.stdin(Stdio::piped());
    spawn_local_child_native(
        task_id,
        request_id,
        owner_target_id,
        child,
        sandbox_temp,
        timeout,
    )
}

/// Application-owned collectors use argv directly and never source a login shell.
pub(super) fn spawn_fixed_local_process_native(
    task_id: String,
    request_id: String,
    owner_target_id: String,
    mut command: Command,
    timeout: Duration,
) -> Result<Arc<ManagedProcessNative>, String> {
    command.stdin(Stdio::null());
    spawn_local_child_native(task_id, request_id, owner_target_id, command, None, timeout)
}

pub(crate) fn spawn_reviewed_local_process_native(
    task_id: String,
    request_id: String,
    owner_target_id: String,
    plan: &super::ReviewedReadCommand,
    timeout: Duration,
) -> Result<Arc<ManagedProcessNative>, String> {
    // No shell, caller PATH, startup scripts or fallback to unrestricted execution.
    let child = plan.command()?;
    spawn_local_child_native(task_id, request_id, owner_target_id, child, None, timeout)
}

pub(super) fn spawn_local_child_native(
    task_id: String,
    request_id: String,
    owner_target_id: String,
    child: Command,
    sandbox_temp: Option<tempfile::TempDir>,
    timeout: Duration,
) -> Result<Arc<ManagedProcessNative>, String> {
    spawn_local_child_tracked(
        task_id,
        request_id,
        owner_target_id,
        child,
        sandbox_temp,
        timeout,
        None,
    )
}

fn spawn_local_child_tracked(
    task_id: String,
    request_id: String,
    owner_target_id: String,
    mut child: Command,
    sandbox_temp: Option<tempfile::TempDir>,
    timeout: Duration,
    auxiliary: Option<Box<dyn Send>>,
) -> Result<Arc<ManagedProcessNative>, String> {
    child.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        child.process_group(0);
    }
    let mut child = child
        .spawn()
        .map_err(|error| format!("Failed to start local direct command: {error}"))?;
    let containment = LocalProcessContainmentNative::attach(&mut child)?;
    let stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Local command stdout was not captured".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Local command stderr was not captured".to_string())?;
    let (control_tx, control_rx) = mpsc::channel();
    let process = ManagedProcessNative::new(
        task_id,
        request_id,
        owner_target_id,
        AgentExecutionChannelNative::Direct,
        Vec::new(),
        control_tx,
    );
    process.mark_admission(AgentExecutionAdmission::Started);
    let worker = Arc::clone(&process);
    thread::spawn(move || {
        run_local_worker(
            Arc::clone(&worker),
            child,
            stdin,
            stdout,
            stderr,
            control_rx,
            timeout,
            containment,
            auxiliary,
        );
        if let Some(temp) = sandbox_temp {
            if !worker
                .snapshot()
                .is_ok_and(|snapshot| snapshot.termination_confirmed)
            {
                let retained = temp.keep();
                log::warn!(
                    "Native sandbox termination remains unconfirmed; temporary data retained at {}",
                    retained.display()
                );
            }
        }
    });
    Ok(process)
}

pub(crate) fn spawn_sandboxed_local_process_native(
    task_id: String,
    request_id: String,
    owner_target_id: String,
    command: &str,
    contract: &crate::agent_runtime::AgentSandboxContract,
    timeout: Duration,
) -> Result<Arc<ManagedProcessNative>, String> {
    #[cfg(target_os = "macos")]
    {
        let (mut child, temp, proxy) = super::macos_sandbox::command_tracked(command, contract)?;
        let audit = proxy.as_ref().map(|proxy| proxy.audit.clone());
        let services = proxy.as_ref().map(|proxy| proxy.services.clone());
        child.stdin(Stdio::piped());
        let process = spawn_local_child_tracked(
            task_id,
            request_id,
            owner_target_id,
            child,
            Some(temp),
            timeout,
            proxy.map(|proxy| Box::new(proxy) as Box<dyn Send>),
        )?;
        if let Some(audit) = audit {
            process
                .network_audit
                .set(audit)
                .map_err(|_| "sandboxNetworkProxyUnavailable: duplicate audit binding")?;
        }
        if let Some(services) = services {
            process
                .service_routes
                .set(services)
                .map_err(|_| "sandboxLocalServiceUnavailable: duplicate service binding")?;
        }
        process
            .sandbox_contract
            .set(contract.clone())
            .map_err(|_| "sandboxAuthorizationInvalid: duplicate process binding")?;
        Ok(process)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            task_id,
            request_id,
            owner_target_id,
            command,
            contract,
            timeout,
        );
        Err("sandboxBackendUnavailable: no verified native launcher on this platform".into())
    }
}

#[cfg(test)]
fn canonical_workspace_root_native(root: &Path) -> Result<PathBuf, String> {
    let metadata = std::fs::symlink_metadata(root)
        .map_err(|error| format!("Failed to inspect operator workspace root: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Operator workspace root must be a real directory".into());
    }
    let canonical = std::fs::canonicalize(root)
        .map_err(|error| format!("Failed to canonicalize operator workspace root: {error}"))?;
    if canonical.parent().is_none() {
        return Err("Filesystem roots cannot be operator workspaces".into());
    }
    Ok(canonical)
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
fn sandbox_temp_native() -> Result<tempfile::TempDir, String> {
    tempfile::Builder::new()
        .prefix("shellspan-agent-")
        .tempdir()
        .map_err(|error| format!("Failed to create Agent sandbox temp directory: {error}"))
}

#[cfg(target_os = "macos")]
#[cfg(test)]
fn workspace_scoped_local_shell_command(
    command: &str,
    root: &Path,
) -> Result<(Command, tempfile::TempDir), String> {
    let root = canonical_workspace_root_native(root)?;
    let temp = sandbox_temp_native()?;
    let temp_root = std::fs::canonicalize(temp.path())
        .map_err(|error| format!("Failed to canonicalize Agent sandbox temp directory: {error}"))?;
    let root = seatbelt_string_native(&root)?;
    let temp_path = seatbelt_string_native(&temp_root)?;
    let profile = format!(
        "(version 1)\n(deny default)\n(import \"system.sb\")\n(deny network*)\n(deny file-write* (subpath \"/cores\"))\n(allow process*)\n(allow file-read*)\n(allow file-write* (subpath \"{root}\") (subpath \"{temp_path}\"))"
    );
    let mut process = Command::new("/usr/bin/sandbox-exec");
    process.args(["-p", &profile, "/bin/sh", "-lc", command]);
    process.env("TMPDIR", &temp_root);
    process.env("TMP", &temp_root);
    process.env("TEMP", &temp_root);
    Ok((process, temp))
}

#[cfg(target_os = "macos")]
#[cfg(test)]
fn seatbelt_string_native(path: &Path) -> Result<String, String> {
    let value = path
        .to_str()
        .ok_or_else(|| "Operator workspace path is not valid UTF-8".to_string())?;
    if value.chars().any(char::is_control) {
        return Err("Operator workspace path contains control characters".into());
    }
    Ok(value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(target_os = "linux")]
#[cfg(test)]
fn workspace_scoped_local_shell_command(
    command: &str,
    root: &Path,
) -> Result<(Command, tempfile::TempDir), String> {
    let root = canonical_workspace_root_native(root)?;
    let temp = sandbox_temp_native()?;
    let temp_root = std::fs::canonicalize(temp.path())
        .map_err(|error| format!("Failed to canonicalize Agent sandbox temp directory: {error}"))?;
    let mut process = Command::new("bwrap");
    process.args([
        "--die-with-parent",
        "--new-session",
        "--unshare-net",
        "--ro-bind",
        "/",
        "/",
        "--bind",
    ]);
    process.arg(&root).arg(&root);
    process.arg("--bind").arg(&temp_root).arg(&temp_root);
    process.arg("--chdir").arg(&root);
    process.args(["/bin/sh", "-lc", command]);
    process.env("TMPDIR", &temp_root);
    process.env("TMP", &temp_root);
    process.env("TEMP", &temp_root);
    Ok((process, temp))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[cfg(test)]
fn workspace_scoped_local_shell_command(
    _command: &str,
    _root: &Path,
) -> Result<(Command, tempfile::TempDir), String> {
    Err("Operator workspace sandbox is unavailable on this platform".into())
}

pub(crate) struct RemoteProcessStartNative {
    pub(crate) remote_sandbox: Option<crate::agent_runtime::remote_seatbelt::RemoteSeatbeltJob>,
    pub(crate) admission: Option<crate::agent_runtime::shutdown_admission::ShutdownAdmission>,
    pub(crate) task_id: String,
    pub(crate) request_id: String,
    pub(crate) owner_target_id: String,
    pub(crate) command: String,
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) known_hosts_path: PathBuf,
    pub(crate) timeout: Duration,
}

pub(crate) fn spawn_remote_process_native(
    start: RemoteProcessStartNative,
) -> Result<Arc<ManagedProcessNative>, String> {
    spawn_remote_process_with_io(start, None)
}

struct DiagnosticProcessIo {
    cancellation: tokio_util::sync::CancellationToken,
    deadline: Instant,
    runtime: tokio::runtime::Handle,
}

pub(super) fn spawn_remote_diagnostic_process_native(
    start: RemoteProcessStartNative,
    cancellation: &tokio_util::sync::CancellationToken,
    deadline: Instant,
) -> Result<Arc<ManagedProcessNative>, String> {
    let io = DiagnosticProcessIo {
        cancellation: cancellation.child_token(),
        deadline,
        runtime: tokio::runtime::Handle::try_current()
            .map_err(|_| "Remote diagnostics require the native async runtime")?,
    };
    spawn_remote_process_with_io(start, Some(io))
}

fn spawn_remote_process_with_io(
    start: RemoteProcessStartNative,
    io: Option<DiagnosticProcessIo>,
) -> Result<Arc<ManagedProcessNative>, String> {
    let mut secrets = known_connection_secret_values(&start.connection);
    if let Some(job) = &start.remote_sandbox { secrets.push(job.secret()); }
    let (control_tx, control_rx) = mpsc::channel();
    let mut process = ManagedProcessNative::new(
        start.task_id.clone(),
        start.request_id.clone(),
        start.owner_target_id.clone(),
        AgentExecutionChannelNative::Direct,
        secrets,
        control_tx,
    );
    if let Some(job) = &start.remote_sandbox {
        let _ = process.sandbox_contract.set(job.contract().clone());
        let _ = process.remote_sandbox.set(job.clone());
    }
    if let Some(io) = &io {
        let process = Arc::get_mut(&mut process).expect("new unshared diagnostic process");
        process.json_stdout = true;
        process.io_cancellation = Some(io.cancellation.clone());
    }
    let worker = Arc::clone(&process);
    thread::spawn(move || {
        if let Some(io) = io {
            let _entered = io.runtime.enter();
            crate::connection::with_scoped_connection_io(
                io.cancellation.clone(),
                io.deadline,
                || run_remote_worker(worker, start, control_rx, Some(&io)),
            );
        } else {
            run_remote_worker(worker, start, control_rx, None);
        }
    });
    Ok(process)
}

fn local_shell_command(command: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut process = Command::new("powershell.exe");
        process.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
        ]);
        process
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut process = Command::new("/bin/sh");
        process.args(["-lc", command]);
        process
    }
}

fn spawn_reader(
    mut reader: impl Read + Send + 'static,
    output: mpsc::SyncSender<ProcessOutputNative>,
    stdout: bool,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let message = if stdout {
                        ProcessOutputNative::Stdout(buffer[..count].to_vec())
                    } else {
                        ProcessOutputNative::Stderr(buffer[..count].to_vec())
                    };
                    if output.send(message).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = output.send(if stdout {
            ProcessOutputNative::StdoutClosed
        } else {
            ProcessOutputNative::StderrClosed
        });
    });
}

#[cfg(not(target_os = "windows"))]
struct LocalProcessContainmentNative;

#[cfg(not(target_os = "windows"))]
impl LocalProcessContainmentNative {
    fn attach(_child: &mut Child) -> Result<Self, String> {
        Ok(Self)
    }

    fn terminate(&self, child: &mut Child, signal: ProcessSignalNative) -> bool {
        #[cfg(unix)]
        // SAFETY: the child was created in its own process group above and
        // `-pid` therefore targets only that group.
        unsafe {
            let pid = child.id() as i32;
            let native = match signal {
                ProcessSignalNative::Interrupt => libc::SIGINT,
                ProcessSignalNative::Terminate => libc::SIGTERM,
                ProcessSignalNative::Kill => libc::SIGKILL,
            };
            libc::kill(-pid, native) == 0
        }
        #[cfg(not(unix))]
        {
            let _ = signal;
            child.kill().is_ok()
        }
    }
}

#[cfg(target_os = "windows")]
struct LocalProcessContainmentNative {
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
// SAFETY: a Windows job HANDLE is an owned kernel handle. This wrapper moves
// it to exactly one worker thread and closes it in Drop.
unsafe impl Send for LocalProcessContainmentNative {}

#[cfg(target_os = "windows")]
impl LocalProcessContainmentNative {
    fn attach(child: &mut Child) -> Result<Self, String> {
        use std::mem::{size_of, zeroed};
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        // SAFETY: null security attributes/name create an unnamed job owned by
        // this process. Every failure path closes the returned handle.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Failed to create Windows process containment job: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: the structure is plain Win32 data and zero is the documented
        // base state before selecting KILL_ON_JOB_CLOSE.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` and its byte size match the selected information
        // class, and the process handle remains valid while Child is alive.
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        let assigned = configured != 0
            // SAFETY: both kernel handles are valid for the duration of this call.
            && unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as _) } != 0;
        if !assigned {
            let error = std::io::Error::last_os_error();
            // SAFETY: `job` was created above and has not been closed.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Failed to contain Windows process tree in a job: {error}"
            ));
        }
        Ok(Self { job })
    }

    fn terminate(&self, _child: &mut Child, _signal: ProcessSignalNative) -> bool {
        // Windows does not provide Unix signal parity here. Terminating the job
        // deterministically stops the complete process tree.
        // SAFETY: this wrapper owns a live job handle until Drop.
        unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1) != 0 }
    }
}

#[cfg(target_os = "windows")]
impl Drop for LocalProcessContainmentNative {
    fn drop(&mut self) {
        // KILL_ON_JOB_CLOSE makes worker teardown a final containment boundary.
        // SAFETY: this wrapper uniquely owns the handle and closes it once.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.job) };
    }
}

fn run_local_worker(
    process: Arc<ManagedProcessNative>,
    mut child: Child,
    stdin: Option<ChildStdin>,
    stdout: impl Read + Send + 'static,
    stderr: impl Read + Send + 'static,
    controls: mpsc::Receiver<ProcessControlNative>,
    timeout: Duration,
    containment: LocalProcessContainmentNative,
    mut auxiliary: Option<Box<dyn Send>>,
) {
    let (output_tx, output_rx) = mpsc::sync_channel(32);
    spawn_reader(stdout, output_tx.clone(), true);
    spawn_reader(stderr, output_tx, false);
    // A full stdin pipe must not block the controller that owns cancellation
    // and the command deadline. The writer is released when the child stops.
    let (input_tx, input_rx) = mpsc::sync_channel::<ProcessControlNative>(1);
    let input_worker = thread::spawn(move || {
        let mut stdin = stdin;
        while let Ok(control) = input_rx.recv() {
            if let ProcessControlNative::Write {
                input,
                close,
                response,
            } = control
            {
                let result = match stdin.as_mut() {
                    Some(writer) => writer
                        .write_all(input.as_bytes())
                        .and_then(|_| writer.flush())
                        .map(|_| input.len())
                        .map_err(|error| format!("Failed to write process stdin: {error}")),
                    None => Err("Process stdin is closed".into()),
                };
                if close {
                    stdin.take();
                }
                let _ = response.send(result);
            }
        }
    });
    // Do not join a potentially blocked writer here: process-group control is
    // not a complete descendant boundary. Dropping the channel closes idle IO.
    let _input_worker = input_worker;
    let deadline = Instant::now() + timeout;
    loop {
        while let Ok(control) = controls.try_recv() {
            match control {
                ProcessControlNative::Write {
                    input,
                    close,
                    response,
                } => {
                    match input_tx.try_send(ProcessControlNative::Write {
                        input,
                        close,
                        response,
                    }) {
                        Ok(()) => {}
                        Err(mpsc::TrySendError::Full(ProcessControlNative::Write {
                            response,
                            ..
                        })) => {
                            let _ = response.send(Err("Process stdin is busy".into()));
                        }
                        Err(mpsc::TrySendError::Disconnected(ProcessControlNative::Write {
                            response,
                            ..
                        })) => {
                            let _ = response.send(Err("Process stdin is closed".into()));
                        }
                        Err(_) => unreachable!("only stdin writes use the input queue"),
                    }
                }
                ProcessControlNative::Kill { signal } => {
                    drop(auxiliary.take());
                    let requested = containment.terminate(&mut child, signal);
                    let settle_deadline = Instant::now() + Duration::from_secs(2);
                    let mut status = None;
                    while Instant::now() < settle_deadline {
                        match child.try_wait() {
                            Ok(Some(observed)) => {
                                status = Some(observed);
                                break;
                            }
                            Ok(None) => thread::sleep(PROCESS_POLL_INTERVAL),
                            Err(_) => break,
                        }
                    }
                    if status.is_none() {
                        let _ = containment.terminate(&mut child, ProcessSignalNative::Kill);
                        status = child.wait().ok();
                    }
                    drain_process_output(&process, &output_rx);
                    drop(auxiliary.take());
                    process.finish(
                        ProcessLifecycleNative::Cancelled,
                        status.and_then(|status| status.code()),
                        requested,
                        None,
                    );
                    return;
                }
            }
        }
        while let Ok(output) = output_rx.try_recv() {
            process.push_output(output);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                drain_process_output(&process, &output_rx);
                drop(auxiliary.take());
                process.finish(ProcessLifecycleNative::Exited, status.code(), true, None);
                return;
            }
            Ok(None) => {}
            Err(error) => {
                drop(auxiliary.take());
                process.finish(
                    ProcessLifecycleNative::Failed,
                    None,
                    false,
                    Some(format!("Failed to observe local command: {error}")),
                );
                return;
            }
        }
        if Instant::now() >= deadline {
            drop(auxiliary.take());
            let confirmed = containment.terminate(&mut child, ProcessSignalNative::Kill);
            let _ = child.wait();
            drain_process_output(&process, &output_rx);
            drop(auxiliary.take());
            process.finish(ProcessLifecycleNative::TimedOut, None, confirmed, None);
            return;
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

fn drain_process_output(
    process: &ManagedProcessNative,
    output: &mpsc::Receiver<ProcessOutputNative>,
) {
    let until = Instant::now() + Duration::from_millis(100);
    while Instant::now() < until {
        match output.recv_timeout(Duration::from_millis(5)) {
            Ok(message) => process.push_output(message),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn read_remote_stream(
    reader: &mut impl Read,
    process: &ManagedProcessNative,
    stdout: bool,
) -> Result<(), String> {
    let mut buffer = [0_u8; 8192];
    // A busy remote stream must yield to cancellation and the task deadline.
    for _ in 0..REMOTE_READS_PER_POLL {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => process.push_output(if stdout {
                ProcessOutputNative::Stdout(buffer[..count].to_vec())
            } else {
                ProcessOutputNative::Stderr(buffer[..count].to_vec())
            }),
            Err(error) if error.kind() == ErrorKind::WouldBlock => return Ok(()),
            Err(error) => return Err(format!("Failed to read remote process output: {error}")),
        }
    }
    Ok(())
}

struct RemoteBlockingModeGuard<'a> {
    session: &'a ssh2::Session,
    was_blocking: bool,
}

impl<'a> RemoteBlockingModeGuard<'a> {
    fn nonblocking(session: &'a ssh2::Session) -> Self {
        let was_blocking = session.is_blocking();
        session.set_blocking(false);
        Self {
            session,
            was_blocking,
        }
    }
}

impl Drop for RemoteBlockingModeGuard<'_> {
    fn drop(&mut self) {
        self.session.set_blocking(self.was_blocking);
    }
}

fn run_remote_worker(
    process: Arc<ManagedProcessNative>,
    start: RemoteProcessStartNative,
    controls: mpsc::Receiver<ProcessControlNative>,
    io: Option<&DiagnosticProcessIo>,
) {
    if start.remote_sandbox.is_some() {
        return restricted_remote::run(process, start, controls);
    }
    let _admission = match start.admission.as_ref().map(|admission| admission.enter()).transpose() {
        Ok(lease) => lease,
        Err(error) => {process.finish(ProcessLifecycleNative::Failed, None, true, Some(error)); return;}
    };
    let deadline = io.map_or_else(|| Instant::now() + start.timeout, |io| io.deadline);
    if remote_diagnostic_interrupted(&process, io)
        || remote_start_interrupted(&process, &controls, deadline)
    {
        return;
    }
    let session = match open_ssh_execution_session(&start.connection, &start.known_hosts_path) {
        Ok(session) => session,
        Err(error) => {
            if remote_diagnostic_interrupted(&process, io) {
                return;
            }
            process.finish(
                ProcessLifecycleNative::Failed,
                None,
                false,
                Some(error.message),
            );
            return;
        }
    };
    if remote_diagnostic_interrupted(&process, io)
        || remote_start_interrupted(&process, &controls, deadline)
    {
        return;
    }
    let mut channel = match session.target.channel_session() {
        Ok(channel) => channel,
        Err(error) => {
            if remote_diagnostic_interrupted(&process, io) {
                return;
            }
            process.finish(
                ProcessLifecycleNative::Failed,
                None,
                false,
                Some(format!("Failed to open remote process channel: {error}")),
            );
            return;
        }
    };
    if remote_diagnostic_interrupted(&process, io)
        || remote_start_interrupted(&process, &controls, deadline)
    {
        return;
    }
    if let Some(admission) = &start.admission {
        if let Err(error) = admission.ensure_open() {process.finish(ProcessLifecycleNative::Failed, None, true, Some(error)); return;}
    }
    process.mark_admission(AgentExecutionAdmission::Unknown);
    if let Err(error) = crate::execution::start_ssh_exec_channel(&mut channel, &start.command) {
        if remote_diagnostic_interrupted(&process, io) {
            return;
        }
        process.finish(
            ProcessLifecycleNative::Failed,
            None,
            false,
            Some(format!("Failed to start remote process: {error}")),
        );
        return;
    }
    process.mark_admission(AgentExecutionAdmission::Started);
    drop(_admission);
    // Restore blocking mode before the channel is freed on every exit path.
    let _blocking_mode = RemoteBlockingModeGuard::nonblocking(&session.target);
    loop {
        if remote_diagnostic_interrupted(&process, io) {
            let _ = channel.close();
            return;
        }
        while let Ok(control) = controls.try_recv() {
            match control {
                ProcessControlNative::Write {
                    input,
                    close,
                    response,
                } => {
                    let result = write_remote_input(&mut channel, input.as_bytes(), close);
                    let _ = response.send(result);
                }
                ProcessControlNative::Kill { signal } => {
                    let _ = signal;
                    let _ = channel.close();
                    process.finish(ProcessLifecycleNative::Cancelled, None, false, None);
                    return;
                }
            }
        }
        if Instant::now() >= deadline {
            let _ = channel.close();
            process.finish(ProcessLifecycleNative::TimedOut, None, false, None);
            return;
        }
        if let Err(error) = read_remote_stream(&mut channel, &process, true) {
            if remote_diagnostic_interrupted(&process, io) {
                return;
            }
            process.finish(ProcessLifecycleNative::Failed, None, false, Some(error));
            return;
        }
        if let Err(error) = read_remote_stream(&mut channel.stderr(), &process, false) {
            if remote_diagnostic_interrupted(&process, io) {
                return;
            }
            process.finish(ProcessLifecycleNative::Failed, None, false, Some(error));
            return;
        }
        if channel.eof() {
            finish_remote_channel(&process, &mut channel, &controls, deadline, io);
            return;
        }
        if Instant::now() >= deadline {
            let _ = channel.close();
            process.finish(ProcessLifecycleNative::TimedOut, None, false, None);
            return;
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

#[path = "remote_seatbelt_process.rs"]
mod restricted_remote;

fn remote_diagnostic_interrupted(
    process: &ManagedProcessNative,
    io: Option<&DiagnosticProcessIo>,
) -> bool {
    let Some(io) = io else {
        return false;
    };
    let lifecycle = if io.cancellation.is_cancelled() {
        ProcessLifecycleNative::Cancelled
    } else if Instant::now() >= io.deadline {
        ProcessLifecycleNative::TimedOut
    } else {
        return false;
    };
    process.finish(lifecycle, None, false, None);
    true
}

fn remote_start_interrupted(
    process: &ManagedProcessNative,
    controls: &mpsc::Receiver<ProcessControlNative>,
    deadline: Instant,
) -> bool {
    while let Ok(control) = controls.try_recv() {
        match control {
            ProcessControlNative::Kill { .. } => {
                process.finish(ProcessLifecycleNative::Cancelled, None, false, None);
                return true;
            }
            ProcessControlNative::Write { response, .. } => {
                let _ = response.send(Err("Remote process has not started".into()));
            }
        }
    }
    if Instant::now() >= deadline {
        process.finish(ProcessLifecycleNative::TimedOut, None, false, None);
        return true;
    }
    false
}

fn finish_remote_channel(
    process: &ManagedProcessNative,
    channel: &mut ssh2::Channel,
    controls: &mpsc::Receiver<ProcessControlNative>,
    deadline: Instant,
    io: Option<&DiagnosticProcessIo>,
) {
    loop {
        if remote_diagnostic_interrupted(process, io)
            || remote_finalization_interrupted(process, channel, controls, deadline)
        {
            return;
        }
        match channel.wait_close() {
            Ok(()) => break,
            Err(error) if error.code() == ErrorCode::Session(LIBSSH2_ERROR_EAGAIN) => {
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
            Err(error) => {
                if remote_diagnostic_interrupted(process, io) {
                    return;
                }
                process.finish(
                    ProcessLifecycleNative::Failed,
                    None,
                    false,
                    Some(format!("Failed to close remote process channel: {error}")),
                );
                return;
            }
        }
    }
    loop {
        if remote_diagnostic_interrupted(process, io)
            || remote_finalization_interrupted(process, channel, controls, deadline)
        {
            return;
        }
        match channel.exit_status() {
            Ok(code) => {
                process.finish(ProcessLifecycleNative::Exited, Some(code), true, None);
                return;
            }
            Err(error) if error.code() == ErrorCode::Session(LIBSSH2_ERROR_EAGAIN) => {
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
            Err(error) => {
                if remote_diagnostic_interrupted(process, io) {
                    return;
                }
                process.finish(
                    ProcessLifecycleNative::Failed,
                    None,
                    false,
                    Some(format!(
                        "Failed to read remote process exit status: {error}"
                    )),
                );
                return;
            }
        }
    }
}

fn remote_finalization_interrupted(
    process: &ManagedProcessNative,
    channel: &mut ssh2::Channel,
    controls: &mpsc::Receiver<ProcessControlNative>,
    deadline: Instant,
) -> bool {
    while let Ok(control) = controls.try_recv() {
        match control {
            ProcessControlNative::Kill { .. } => {
                let _ = channel.close();
                process.finish(ProcessLifecycleNative::Cancelled, None, false, None);
                return true;
            }
            ProcessControlNative::Write { response, .. } => {
                let _ = response.send(Err("Remote process stdin is closed".into()));
            }
        }
    }
    if Instant::now() >= deadline {
        let _ = channel.close();
        process.finish(ProcessLifecycleNative::TimedOut, None, false, None);
        return true;
    }
    false
}

fn write_remote_input(
    channel: &mut ssh2::Channel,
    input: &[u8],
    close: bool,
) -> Result<usize, String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut written = 0;
    while written < input.len() {
        match channel.write(&input[written..]) {
            Ok(0) => return Err("Remote process stdin closed before accepting input".into()),
            Ok(count) => written += count,
            Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
            Err(error) => return Err(format!("Failed to write remote process stdin: {error}")),
        }
    }
    loop {
        match channel.flush() {
            Ok(()) => break,
            Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
            Err(error) => return Err(format!("Failed to flush remote process stdin: {error}")),
        }
    }
    if close {
        channel
            .send_eof()
            .map_err(|error| format!("Failed to close remote process stdin: {error}"))?;
    }
    Ok(written)
}

fn current_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
#[path = "__tests__/diagnostic_transport.rs"]
mod diagnostic_transport_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn task_process_count_tracks_real_background_process_until_confirmed_stop() {
        let registry = ProcessRegistryNative::default();
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        let process = spawn_fixed_local_process_native(
            "background-count".into(),
            "request".into(),
            "local".into(),
            command,
            Duration::from_secs(40),
        )
        .unwrap();
        registry.insert(process.clone()).unwrap();
        assert_eq!(registry.running_task_count("background-count").unwrap(), 1);
        assert_eq!(registry.running_task_count("other-task").unwrap(), 0);
        registry.cancel_task("background-count").unwrap();
        assert!(process.snapshot().unwrap().termination_confirmed);
        assert_eq!(registry.running_task_count("background-count").unwrap(), 0);
    }

    #[test]
    fn remote_stream_read_yields_after_a_bounded_batch() {
        let (controls, _) = mpsc::channel();
        let process = ManagedProcessNative::new(
            "task-stream".into(),
            "req-stream".into(),
            "remote-1".into(),
            AgentExecutionChannelNative::Direct,
            Vec::new(),
            controls,
        );
        let mut reader = std::io::repeat(b'x');
        read_remote_stream(&mut reader, &process, true).unwrap();
        let snapshot = process.snapshot().unwrap();
        assert_eq!(
            snapshot.stdout_bytes_read,
            (REMOTE_READS_PER_POLL * 8192) as u64
        );
        assert_eq!(snapshot.state, ProcessLifecycleNative::Running);
    }

    #[test]
    fn remote_start_does_not_dispatch_after_cancel_or_deadline() {
        let (controls, receiver) = mpsc::channel();
        let process = ManagedProcessNative::new(
            "task-cancel".into(),
            "req-cancel".into(),
            "remote-1".into(),
            AgentExecutionChannelNative::Direct,
            Vec::new(),
            controls.clone(),
        );
        controls
            .send(ProcessControlNative::Kill {
                signal: ProcessSignalNative::Kill,
            })
            .unwrap();
        assert!(remote_start_interrupted(
            &process,
            &receiver,
            Instant::now() + Duration::from_secs(1)
        ));
        assert_eq!(
            process.snapshot().unwrap().state,
            ProcessLifecycleNative::Cancelled
        );

        let (controls, receiver) = mpsc::channel();
        let process = ManagedProcessNative::new(
            "task-deadline".into(),
            "req-deadline".into(),
            "remote-1".into(),
            AgentExecutionChannelNative::Direct,
            Vec::new(),
            controls,
        );
        assert!(remote_start_interrupted(
            &process,
            &receiver,
            Instant::now() - Duration::from_millis(1)
        ));
        assert_eq!(
            process.snapshot().unwrap().state,
            ProcessLifecycleNative::TimedOut
        );
    }

    fn local_command(stdout: &str, stderr: &str, exit_code: i32) -> String {
        if cfg!(target_os = "windows") {
            format!(
                "[Console]::Out.Write('{}'); [Console]::Error.Write('{}'); exit {exit_code}",
                stdout.replace('`', "``").replace('\'', "''"),
                stderr.replace('`', "``").replace('\'', "''")
            )
        } else {
            format!(
                "printf '%s' '{}'; printf '%s' '{}' >&2; exit {exit_code}",
                stdout.replace('\'', "'\"'\"'"),
                stderr.replace('\'', "'\"'\"'")
            )
        }
    }

    #[test]
    fn local_direct_process_preserves_streams_exit_code_and_handle() {
        let process = spawn_local_process_native(
            "task-1".into(),
            "req-1".into(),
            "local-1".into(),
            &local_command("out", "err", 7),
            None,
            Duration::from_secs(10),
        )
        .unwrap();
        let snapshot = process.wait(Duration::from_secs(10)).unwrap();
        assert_eq!(snapshot.state, ProcessLifecycleNative::Exited);
        assert_eq!(snapshot.exit_code, Some(7));
        assert_eq!(snapshot.stdout, "out");
        assert_eq!(snapshot.stderr, "err");
        assert_eq!(
            snapshot.failure.as_ref().unwrap().kind,
            AgentExecutionFailureKind::CommandFailed
        );
        assert!(snapshot.process_handle.starts_with("proc-"));
        assert_eq!(
            process.write_stdin(String::new(), false).unwrap_err(),
            "Process is no longer running"
        );
    }

    #[cfg(unix)]
    #[test]
    fn direct_multiline_script_preserves_heredoc_cwd_and_exit_status() {
        let workspace = tempfile::tempdir().unwrap();
        let command = "cat <<'EOF' > result.txt\n界面\nliteral $HOME and $(pwd)\nEOF\ncat result.txt\nprintf diagnostic >&2\nexit 7";
        crate::agent_runtime::validate_tool_arguments_native("exec_command", &serde_json::json!({"command":command, "explanation":"check complete script", "channel":"direct"})).unwrap();
        let process = spawn_local_process_native(
            "script-task".into(),
            "script-request".into(),
            "script-target".into(),
            command,
            Some(workspace.path()),
            Duration::from_secs(10),
        )
        .unwrap();
        let snapshot = process.wait(Duration::from_secs(10)).unwrap();
        assert_eq!(snapshot.state, ProcessLifecycleNative::Exited);
        assert_eq!(snapshot.exit_code, Some(7));
        assert_eq!(snapshot.stdout, "界面\nliteral $HOME and $(pwd)\n");
        assert_eq!(snapshot.stderr, "diagnostic");
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("result.txt")).unwrap(),
            snapshot.stdout
        );
    }

    #[test]
    fn local_background_process_accepts_stdin_and_has_one_terminal_state() {
        let command = if cfg!(target_os = "windows") {
            "$line=[Console]::In.ReadLine(); [Console]::Out.Write($line)"
        } else {
            "IFS= read -r line; printf '%s' \"$line\""
        };
        let process = spawn_local_process_native(
            "task-2".into(),
            "req-2".into(),
            "local-1".into(),
            command,
            None,
            Duration::from_secs(10),
        )
        .unwrap();
        process.write_stdin("hello\n".into(), true).unwrap();
        let snapshot = process.wait(Duration::from_secs(10)).unwrap();
        assert_eq!(snapshot.state, ProcessLifecycleNative::Exited);
        assert_eq!(snapshot.stdout.trim(), "hello");
    }

    #[test]
    fn local_deadline_and_stop_remain_responsive_during_pending_stdin() {
        for cancel in [false, true] {
            let process = spawn_local_process_native(
                "stdin-control".into(),
                "stdin-request".into(),
                "local".into(),
                if cfg!(windows) {
                    "Start-Sleep -Seconds 10"
                } else {
                    "sleep 10"
                },
                None,
                if cancel {
                    Duration::from_secs(10)
                } else {
                    Duration::from_millis(100)
                },
            )
            .unwrap();
            let writer = Arc::clone(&process);
            let input = thread::spawn(move || writer.write_stdin("input".repeat(100_000), true));
            thread::sleep(Duration::from_millis(50));
            let snapshot = if cancel {
                process
                    .kill(ProcessSignalNative::Kill, Duration::from_secs(3))
                    .unwrap()
            } else {
                process.wait(Duration::from_secs(3)).unwrap()
            };
            assert_eq!(
                snapshot.state,
                if cancel {
                    ProcessLifecycleNative::Cancelled
                } else {
                    ProcessLifecycleNative::TimedOut
                }
            );
            assert!(snapshot.termination_confirmed);
            assert!(input.join().unwrap().is_err());
            assert_eq!(
                snapshot.failure.unwrap().kind,
                if cancel {
                    AgentExecutionFailureKind::Cancelled
                } else {
                    AgentExecutionFailureKind::TimedOut
                }
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn multiline_scripts_keep_timeout_and_cancellation_boundaries() {
        for cancel in [false, true] {
            let workspace = tempfile::tempdir().unwrap();
            let process = spawn_local_process_native(
                "bounded-script".into(),
                "bounded-request".into(),
                "local-script".into(),
                "printf started\nsleep 10\nprintf late > should-not-exist",
                Some(workspace.path()),
                if cancel {
                    Duration::from_secs(20)
                } else {
                    Duration::from_millis(100)
                },
            )
            .unwrap();
            let snapshot = if cancel {
                process
                    .kill(ProcessSignalNative::Kill, Duration::from_secs(5))
                    .unwrap()
            } else {
                process.wait(Duration::from_secs(5)).unwrap()
            };
            assert_eq!(
                snapshot.state,
                if cancel {
                    ProcessLifecycleNative::Cancelled
                } else {
                    ProcessLifecycleNative::TimedOut
                }
            );
            assert!(snapshot.termination_confirmed);
            assert!(!workspace.path().join("should-not-exist").exists());
        }
    }

    #[test]
    fn timeout_wins_over_late_process_completion() {
        let command = if cfg!(target_os = "windows") {
            "Start-Sleep -Seconds 5"
        } else {
            "sleep 5"
        };
        let process = spawn_local_process_native(
            "task-timeout".into(),
            "req-timeout".into(),
            "local-1".into(),
            command,
            None,
            Duration::from_millis(100),
        )
        .unwrap();
        let first = process.wait(Duration::from_secs(5)).unwrap();
        assert_eq!(first.state, ProcessLifecycleNative::TimedOut);
        thread::sleep(Duration::from_millis(100));
        assert_eq!(
            process.snapshot().unwrap().state,
            ProcessLifecycleNative::TimedOut
        );
    }

    #[test]
    fn operator_workspace_rejects_a_filesystem_root() {
        let root = if cfg!(target_os = "windows") {
            Path::new("C:\\")
        } else {
            Path::new("/")
        };
        assert!(canonical_workspace_root_native(root)
            .unwrap_err()
            .contains("Filesystem roots"));
        let result = spawn_workspace_scoped_local_process_native(
            "invalid-workspace-task".into(),
            "invalid-workspace-request".into(),
            "local".into(),
            "exit 0",
            root,
            Duration::from_secs(1),
        );
        let error = result
            .err()
            .expect("invalid workspace must not start a process");
        if cfg!(any(target_os = "macos", target_os = "linux")) {
            assert!(error.contains("Filesystem roots"), "{error}");
        } else {
            assert!(error.contains("sandbox is unavailable"), "{error}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn operator_workspace_sandbox_allows_inside_delete_and_blocks_parent_escape() {
        let base = tempfile::tempdir().unwrap();
        let workspace = base.path().join("workspace");
        let outside = base.path().join("outside");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(workspace.join("inside.txt"), b"inside").unwrap();
        std::fs::write(outside.join("keep.txt"), b"outside").unwrap();
        std::fs::write(outside.join("symlink-keep.txt"), b"outside").unwrap();
        std::os::unix::fs::symlink(&outside, workspace.join("outside-link")).unwrap();

        let process = spawn_workspace_scoped_local_process_native(
            "task-scoped".into(),
            "request-scoped".into(),
            "local-scoped".into(),
            "rm inside.txt; rm ../outside/keep.txt; python3 -c 'import os; os.remove(\"outside-link/symlink-keep.txt\")'",
            &workspace,
            Duration::from_secs(10),
        )
        .unwrap();
        let snapshot = process.wait(Duration::from_secs(10)).unwrap();

        assert_eq!(snapshot.state, ProcessLifecycleNative::Exited);
        assert_ne!(snapshot.exit_code, Some(0));
        assert!(!workspace.join("inside.txt").exists());
        assert!(outside.join("keep.txt").exists());
        assert!(outside.join("symlink-keep.txt").exists());
        assert!(snapshot.stderr.contains("Operation not permitted"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn operator_workspace_sandbox_blocks_arbitrary_network_connections() {
        let workspace = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let command = format!(
            "python3 -c 'import socket; socket.create_connection((\"127.0.0.1\", {port}), 1)'"
        );

        let process = spawn_workspace_scoped_local_process_native(
            "task-network".into(),
            "request-network".into(),
            "local-network".into(),
            &command,
            workspace.path(),
            Duration::from_secs(10),
        )
        .unwrap();
        let snapshot = process.wait(Duration::from_secs(10)).unwrap();

        assert_eq!(snapshot.state, ProcessLifecycleNative::Exited);
        assert_ne!(snapshot.exit_code, Some(0));
        assert!(snapshot.stderr.contains("Operation not permitted"));
    }
}
