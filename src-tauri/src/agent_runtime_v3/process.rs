use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use uuid::Uuid;

use crate::agent_contract_v3::{AgentExecutionChannelV3, AgentToolTargetV3, ProcessSignalV3};
use crate::execution::{
    known_connection_secret_values, open_ssh_execution_session, redact_known_secrets,
};
use crate::models::RemoteConnectionRequest;

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(20);
const STDOUT_CAPTURE_BYTES: usize = 768 * 1024;
const STDERR_CAPTURE_BYTES: usize = 256 * 1024;
const MAX_TRACKED_PROCESSES: usize = 256;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProcessLifecycleV3 {
    Running,
    Exited,
    Cancelled,
    TimedOut,
    Failed,
}

impl ProcessLifecycleV3 {
    pub(crate) fn is_terminal(self) -> bool {
        self != Self::Running
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessSnapshotV3 {
    pub(crate) process_handle: String,
    pub(crate) target_id: String,
    pub(crate) owner_target_id: String,
    pub(crate) task_id: String,
    pub(crate) request_id: String,
    pub(crate) channel: AgentExecutionChannelV3,
    pub(crate) state: ProcessLifecycleV3,
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
}

#[derive(Debug)]
struct CaptureBufferV3 {
    limit: usize,
    head_limit: usize,
    tail_limit: usize,
    head: Vec<u8>,
    tail: Vec<u8>,
    bytes_read: u64,
}

impl CaptureBufferV3 {
    fn new(limit: usize) -> Self {
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

    fn push(&mut self, bytes: &[u8]) {
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

    fn text(&self, secrets: &[String]) -> String {
        let mut bytes = self.head.clone();
        bytes.extend_from_slice(&self.tail);
        redact_known_secrets(&String::from_utf8_lossy(&bytes), secrets)
    }

    fn truncated(&self) -> bool {
        self.bytes_read > self.limit as u64
    }
}

#[derive(Debug)]
struct ProcessStateV3 {
    lifecycle: ProcessLifecycleV3,
    exit_code: Option<i32>,
    stdout: CaptureBufferV3,
    stderr: CaptureBufferV3,
    termination_confirmed: bool,
    completed_at_unix_ms: Option<u64>,
    error: Option<String>,
}

enum ProcessControlV3 {
    Write {
        input: String,
        close: bool,
        response: mpsc::SyncSender<Result<usize, String>>,
    },
    Kill {
        signal: ProcessSignalV3,
    },
}

enum ProcessOutputV3 {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    StdoutClosed,
    StderrClosed,
}

pub(crate) struct ManagedProcessV3 {
    process_handle: String,
    target_id: String,
    owner_target_id: String,
    task_id: String,
    request_id: String,
    channel: AgentExecutionChannelV3,
    started_at_unix_ms: u64,
    secrets: Vec<String>,
    state: Mutex<ProcessStateV3>,
    changed: Condvar,
    controls: mpsc::Sender<ProcessControlV3>,
}

impl ManagedProcessV3 {
    fn new(
        task_id: String,
        request_id: String,
        owner_target_id: String,
        channel: AgentExecutionChannelV3,
        secrets: Vec<String>,
        controls: mpsc::Sender<ProcessControlV3>,
    ) -> Arc<Self> {
        let process_handle = format!("proc-{}", Uuid::new_v4().simple());
        let target_id = format!("process-{process_handle}");
        Arc::new(Self {
            process_handle,
            target_id,
            owner_target_id,
            task_id,
            request_id,
            channel,
            started_at_unix_ms: current_unix_ms(),
            secrets,
            state: Mutex::new(ProcessStateV3 {
                lifecycle: ProcessLifecycleV3::Running,
                exit_code: None,
                stdout: CaptureBufferV3::new(STDOUT_CAPTURE_BYTES),
                stderr: CaptureBufferV3::new(STDERR_CAPTURE_BYTES),
                termination_confirmed: false,
                completed_at_unix_ms: None,
                error: None,
            }),
            changed: Condvar::new(),
            controls,
        })
    }

    pub(crate) fn process_target(&self) -> AgentToolTargetV3 {
        AgentToolTargetV3::Process {
            target_id: self.target_id.clone(),
            owner_target_id: self.owner_target_id.clone(),
            process_handle: self.process_handle.clone(),
        }
    }

    fn push_output(&self, output: ProcessOutputV3) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.lifecycle.is_terminal() {
            return;
        }
        match output {
            ProcessOutputV3::Stdout(bytes) => state.stdout.push(&bytes),
            ProcessOutputV3::Stderr(bytes) => state.stderr.push(&bytes),
            ProcessOutputV3::StdoutClosed | ProcessOutputV3::StderrClosed => {}
        }
        self.changed.notify_all();
    }

    fn finish(
        &self,
        lifecycle: ProcessLifecycleV3,
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
        state.termination_confirmed = termination_confirmed;
        state.completed_at_unix_ms = Some(current_unix_ms());
        state.error = error.map(|value| redact_known_secrets(&value, &self.secrets));
        self.changed.notify_all();
    }

    pub(crate) fn snapshot(&self) -> Result<ProcessSnapshotV3, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "process state is unavailable".to_string())?;
        Ok(ProcessSnapshotV3 {
            process_handle: self.process_handle.clone(),
            target_id: self.target_id.clone(),
            owner_target_id: self.owner_target_id.clone(),
            task_id: self.task_id.clone(),
            request_id: self.request_id.clone(),
            channel: self.channel,
            state: state.lifecycle,
            exit_code: state.exit_code,
            stdout: state.stdout.text(&self.secrets),
            stderr: state.stderr.text(&self.secrets),
            stdout_bytes_read: state.stdout.bytes_read,
            stderr_bytes_read: state.stderr.bytes_read,
            stdout_truncated: state.stdout.truncated(),
            stderr_truncated: state.stderr.truncated(),
            termination_confirmed: state.termination_confirmed,
            started_at_unix_ms: self.started_at_unix_ms,
            completed_at_unix_ms: state.completed_at_unix_ms,
            error: state.error.clone(),
        })
    }

    pub(crate) fn wait(&self, timeout: Duration) -> Result<ProcessSnapshotV3, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "process state is unavailable".to_string())?;
        let (state, _) = self
            .changed
            .wait_timeout_while(state, timeout, |state| !state.lifecycle.is_terminal())
            .map_err(|_| "process state is unavailable".to_string())?;
        Ok(ProcessSnapshotV3 {
            process_handle: self.process_handle.clone(),
            target_id: self.target_id.clone(),
            owner_target_id: self.owner_target_id.clone(),
            task_id: self.task_id.clone(),
            request_id: self.request_id.clone(),
            channel: self.channel,
            state: state.lifecycle,
            exit_code: state.exit_code,
            stdout: state.stdout.text(&self.secrets),
            stderr: state.stderr.text(&self.secrets),
            stdout_bytes_read: state.stdout.bytes_read,
            stderr_bytes_read: state.stderr.bytes_read,
            stdout_truncated: state.stdout.truncated(),
            stderr_truncated: state.stderr.truncated(),
            termination_confirmed: state.termination_confirmed,
            started_at_unix_ms: self.started_at_unix_ms,
            completed_at_unix_ms: state.completed_at_unix_ms,
            error: state.error.clone(),
        })
    }

    pub(crate) fn write_stdin(&self, input: String, close: bool) -> Result<usize, String> {
        if self.snapshot()?.state.is_terminal() {
            return Err("process is no longer running".into());
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        self.controls
            .send(ProcessControlV3::Write {
                input,
                close,
                response: sender,
            })
            .map_err(|_| "process input channel is unavailable".to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "process input acknowledgement timed out".to_string())?
    }

    pub(crate) fn kill(
        &self,
        signal: ProcessSignalV3,
        timeout: Duration,
    ) -> Result<ProcessSnapshotV3, String> {
        if self.snapshot()?.state.is_terminal() {
            return self.snapshot();
        }
        self.controls
            .send(ProcessControlV3::Kill { signal })
            .map_err(|_| "process control channel is unavailable".to_string())?;
        self.wait(timeout)
    }
}

#[derive(Clone, Default)]
pub(crate) struct ProcessRegistryV3 {
    processes: Arc<Mutex<HashMap<String, Arc<ManagedProcessV3>>>>,
}

impl ProcessRegistryV3 {
    pub(crate) fn ensure_capacity(&self) -> Result<(), String> {
        let processes = self
            .processes
            .lock()
            .map_err(|_| "process registry is unavailable".to_string())?;
        if processes.len() >= MAX_TRACKED_PROCESSES {
            return Err("native process registry reached its bounded capacity".into());
        }
        Ok(())
    }

    pub(crate) fn insert(&self, process: Arc<ManagedProcessV3>) -> Result<(), String> {
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| "process registry is unavailable".to_string())?;
        if processes.len() >= MAX_TRACKED_PROCESSES {
            return Err("native process registry reached its bounded capacity".into());
        }
        if processes
            .insert(process.process_handle.clone(), process)
            .is_some()
        {
            return Err("duplicate process handle".into());
        }
        Ok(())
    }

    pub(crate) fn get(&self, handle: &str) -> Result<Arc<ManagedProcessV3>, String> {
        self.processes
            .lock()
            .map_err(|_| "process registry is unavailable".to_string())?
            .get(handle)
            .cloned()
            .ok_or_else(|| "process handle was not found".to_string())
    }

    pub(crate) fn list_for_task(&self, task_id: &str) -> Result<Vec<ProcessSnapshotV3>, String> {
        self.processes
            .lock()
            .map_err(|_| "process registry is unavailable".to_string())?
            .values()
            .filter(|process| process.task_id == task_id)
            .map(|process| process.snapshot())
            .collect()
    }

    pub(crate) fn running_count(&self) -> Result<usize, String> {
        let processes = self
            .processes
            .lock()
            .map_err(|_| "process registry is unavailable".to_string())?;
        let mut running = 0;
        for process in processes.values() {
            if process.snapshot()?.state == ProcessLifecycleV3::Running {
                running += 1;
            }
        }
        Ok(running)
    }

    pub(crate) fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        let processes = self
            .processes
            .lock()
            .map_err(|_| "process registry is unavailable".to_string())?
            .values()
            .filter(|process| process.task_id == task_id)
            .cloned()
            .collect::<Vec<_>>();
        for process in processes {
            let _ = process.kill(ProcessSignalV3::Kill, Duration::from_secs(2));
        }
        Ok(())
    }
}

pub(crate) fn spawn_local_process_v3(
    task_id: String,
    request_id: String,
    owner_target_id: String,
    command: &str,
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<Arc<ManagedProcessV3>, String> {
    let mut child = local_shell_command(command);
    if let Some(cwd) = cwd {
        child.current_dir(cwd);
    }
    child
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        child.process_group(0);
    }
    let mut child = child
        .spawn()
        .map_err(|error| format!("failed to start local direct command: {error}"))?;
    let containment = LocalProcessContainmentV3::attach(&mut child)?;
    let stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "local command stdout was not captured".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "local command stderr was not captured".to_string())?;
    let (control_tx, control_rx) = mpsc::channel();
    let process = ManagedProcessV3::new(
        task_id,
        request_id,
        owner_target_id,
        AgentExecutionChannelV3::Direct,
        Vec::new(),
        control_tx,
    );
    let worker = Arc::clone(&process);
    thread::spawn(move || {
        run_local_worker(
            worker,
            child,
            stdin,
            stdout,
            stderr,
            control_rx,
            timeout,
            containment,
        )
    });
    Ok(process)
}

pub(crate) struct RemoteProcessStartV3 {
    pub(crate) task_id: String,
    pub(crate) request_id: String,
    pub(crate) owner_target_id: String,
    pub(crate) command: String,
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) known_hosts_path: PathBuf,
    pub(crate) timeout: Duration,
}

pub(crate) fn spawn_remote_process_v3(
    start: RemoteProcessStartV3,
) -> Result<Arc<ManagedProcessV3>, String> {
    let secrets = known_connection_secret_values(&start.connection);
    let (control_tx, control_rx) = mpsc::channel();
    let process = ManagedProcessV3::new(
        start.task_id.clone(),
        start.request_id.clone(),
        start.owner_target_id.clone(),
        AgentExecutionChannelV3::Direct,
        secrets,
        control_tx,
    );
    let worker = Arc::clone(&process);
    thread::spawn(move || run_remote_worker(worker, start, control_rx));
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
    output: mpsc::SyncSender<ProcessOutputV3>,
    stdout: bool,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let message = if stdout {
                        ProcessOutputV3::Stdout(buffer[..count].to_vec())
                    } else {
                        ProcessOutputV3::Stderr(buffer[..count].to_vec())
                    };
                    if output.send(message).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = output.send(if stdout {
            ProcessOutputV3::StdoutClosed
        } else {
            ProcessOutputV3::StderrClosed
        });
    });
}

#[cfg(not(target_os = "windows"))]
struct LocalProcessContainmentV3;

#[cfg(not(target_os = "windows"))]
impl LocalProcessContainmentV3 {
    fn attach(_child: &mut Child) -> Result<Self, String> {
        Ok(Self)
    }

    fn terminate(&self, child: &mut Child, signal: ProcessSignalV3) -> bool {
        #[cfg(unix)]
        // SAFETY: the child was created in its own process group above and
        // `-pid` therefore targets only that group.
        unsafe {
            let pid = child.id() as i32;
            let native = match signal {
                ProcessSignalV3::Interrupt => libc::SIGINT,
                ProcessSignalV3::Terminate => libc::SIGTERM,
                ProcessSignalV3::Kill => libc::SIGKILL,
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
struct LocalProcessContainmentV3 {
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
// SAFETY: a Windows job HANDLE is an owned kernel handle. This wrapper moves
// it to exactly one worker thread and closes it in Drop.
unsafe impl Send for LocalProcessContainmentV3 {}

#[cfg(target_os = "windows")]
impl LocalProcessContainmentV3 {
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
                "failed to create Windows process containment job: {}",
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
                "failed to contain Windows process tree in a job: {error}"
            ));
        }
        Ok(Self { job })
    }

    fn terminate(&self, _child: &mut Child, _signal: ProcessSignalV3) -> bool {
        // Windows does not provide Unix signal parity here. Terminating the job
        // deterministically stops the complete process tree.
        // SAFETY: this wrapper owns a live job handle until Drop.
        unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1) != 0 }
    }
}

#[cfg(target_os = "windows")]
impl Drop for LocalProcessContainmentV3 {
    fn drop(&mut self) {
        // KILL_ON_JOB_CLOSE makes worker teardown a final containment boundary.
        // SAFETY: this wrapper uniquely owns the handle and closes it once.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.job) };
    }
}

fn run_local_worker(
    process: Arc<ManagedProcessV3>,
    mut child: Child,
    mut stdin: Option<ChildStdin>,
    stdout: impl Read + Send + 'static,
    stderr: impl Read + Send + 'static,
    controls: mpsc::Receiver<ProcessControlV3>,
    timeout: Duration,
    containment: LocalProcessContainmentV3,
) {
    let (output_tx, output_rx) = mpsc::sync_channel(32);
    spawn_reader(stdout, output_tx.clone(), true);
    spawn_reader(stderr, output_tx, false);
    let deadline = Instant::now() + timeout;
    loop {
        while let Ok(control) = controls.try_recv() {
            match control {
                ProcessControlV3::Write {
                    input,
                    close,
                    response,
                } => {
                    let result = match stdin.as_mut() {
                        Some(writer) => writer
                            .write_all(input.as_bytes())
                            .and_then(|_| writer.flush())
                            .map(|_| input.len())
                            .map_err(|error| format!("failed to write process stdin: {error}")),
                        None => Err("process stdin is closed".into()),
                    };
                    if close {
                        stdin.take();
                    }
                    let _ = response.send(result);
                }
                ProcessControlV3::Kill { signal } => {
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
                        let _ = containment.terminate(&mut child, ProcessSignalV3::Kill);
                        status = child.wait().ok();
                    }
                    drain_process_output(&process, &output_rx);
                    process.finish(
                        ProcessLifecycleV3::Cancelled,
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
                process.finish(ProcessLifecycleV3::Exited, status.code(), true, None);
                return;
            }
            Ok(None) => {}
            Err(error) => {
                process.finish(
                    ProcessLifecycleV3::Failed,
                    None,
                    false,
                    Some(format!("failed to observe local command: {error}")),
                );
                return;
            }
        }
        if Instant::now() >= deadline {
            let confirmed = containment.terminate(&mut child, ProcessSignalV3::Kill);
            let _ = child.wait();
            drain_process_output(&process, &output_rx);
            process.finish(ProcessLifecycleV3::TimedOut, None, confirmed, None);
            return;
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

fn drain_process_output(process: &ManagedProcessV3, output: &mpsc::Receiver<ProcessOutputV3>) {
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
    process: &ManagedProcessV3,
    stdout: bool,
) -> Result<(), String> {
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => process.push_output(if stdout {
                ProcessOutputV3::Stdout(buffer[..count].to_vec())
            } else {
                ProcessOutputV3::Stderr(buffer[..count].to_vec())
            }),
            Err(error) if error.kind() == ErrorKind::WouldBlock => return Ok(()),
            Err(error) => return Err(format!("failed to read remote process output: {error}")),
        }
    }
}

fn run_remote_worker(
    process: Arc<ManagedProcessV3>,
    start: RemoteProcessStartV3,
    controls: mpsc::Receiver<ProcessControlV3>,
) {
    let deadline = Instant::now() + start.timeout;
    let session = match open_ssh_execution_session(&start.connection, &start.known_hosts_path) {
        Ok(session) => session,
        Err(error) => {
            process.finish(ProcessLifecycleV3::Failed, None, false, Some(error.message));
            return;
        }
    };
    if Instant::now() >= deadline {
        process.finish(ProcessLifecycleV3::TimedOut, None, false, None);
        return;
    }
    let mut channel = match session.target.channel_session() {
        Ok(channel) => channel,
        Err(error) => {
            process.finish(
                ProcessLifecycleV3::Failed,
                None,
                false,
                Some(format!("failed to open remote process channel: {error}")),
            );
            return;
        }
    };
    if let Err(error) = crate::execution::start_ssh_exec_channel(&mut channel, &start.command) {
        process.finish(
            ProcessLifecycleV3::Failed,
            None,
            false,
            Some(format!("failed to start remote process: {error}")),
        );
        return;
    }
    session.target.set_blocking(false);
    loop {
        while let Ok(control) = controls.try_recv() {
            match control {
                ProcessControlV3::Write {
                    input,
                    close,
                    response,
                } => {
                    let result = write_remote_input(&mut channel, input.as_bytes(), close);
                    let _ = response.send(result);
                }
                ProcessControlV3::Kill { signal } => {
                    let _ = signal;
                    let _ = channel.close();
                    process.finish(ProcessLifecycleV3::Cancelled, None, false, None);
                    return;
                }
            }
        }
        if let Err(error) = read_remote_stream(&mut channel, &process, true) {
            process.finish(ProcessLifecycleV3::Failed, None, false, Some(error));
            return;
        }
        if let Err(error) = read_remote_stream(&mut channel.stderr(), &process, false) {
            process.finish(ProcessLifecycleV3::Failed, None, false, Some(error));
            return;
        }
        if channel.eof() {
            session.target.set_blocking(true);
            let close = channel.wait_close();
            let exit = channel.exit_status();
            match (close, exit) {
                (Ok(()), Ok(code)) => {
                    process.finish(ProcessLifecycleV3::Exited, Some(code), true, None)
                }
                (close, exit) => process.finish(
                    ProcessLifecycleV3::Failed,
                    None,
                    false,
                    Some(format!(
                        "failed to finalize remote process: close={close:?} exit={exit:?}"
                    )),
                ),
            }
            return;
        }
        if Instant::now() >= deadline {
            let _ = channel.close();
            process.finish(ProcessLifecycleV3::TimedOut, None, false, None);
            return;
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
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
            Ok(0) => return Err("remote process stdin closed before accepting input".into()),
            Ok(count) => written += count,
            Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
            Err(error) => return Err(format!("failed to write remote process stdin: {error}")),
        }
    }
    loop {
        match channel.flush() {
            Ok(()) => break,
            Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
            Err(error) => return Err(format!("failed to flush remote process stdin: {error}")),
        }
    }
    if close {
        channel
            .send_eof()
            .map_err(|error| format!("failed to close remote process stdin: {error}"))?;
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
mod tests {
    use super::*;

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
        let process = spawn_local_process_v3(
            "task-1".into(),
            "req-1".into(),
            "local-1".into(),
            &local_command("out", "err", 7),
            None,
            Duration::from_secs(10),
        )
        .unwrap();
        let snapshot = process.wait(Duration::from_secs(10)).unwrap();
        assert_eq!(snapshot.state, ProcessLifecycleV3::Exited);
        assert_eq!(snapshot.exit_code, Some(7));
        assert_eq!(snapshot.stdout, "out");
        assert_eq!(snapshot.stderr, "err");
        assert!(snapshot.process_handle.starts_with("proc-"));
    }

    #[test]
    fn local_background_process_accepts_stdin_and_has_one_terminal_state() {
        let command = if cfg!(target_os = "windows") {
            "$line=[Console]::In.ReadLine(); [Console]::Out.Write($line)"
        } else {
            "IFS= read -r line; printf '%s' \"$line\""
        };
        let process = spawn_local_process_v3(
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
        assert_eq!(snapshot.state, ProcessLifecycleV3::Exited);
        assert_eq!(snapshot.stdout.trim(), "hello");
    }

    #[test]
    fn timeout_wins_over_late_process_completion() {
        let command = if cfg!(target_os = "windows") {
            "Start-Sleep -Seconds 5"
        } else {
            "sleep 5"
        };
        let process = spawn_local_process_v3(
            "task-timeout".into(),
            "req-timeout".into(),
            "local-1".into(),
            command,
            None,
            Duration::from_millis(100),
        )
        .unwrap();
        let first = process.wait(Duration::from_secs(5)).unwrap();
        assert_eq!(first.state, ProcessLifecycleV3::TimedOut);
        thread::sleep(Duration::from_millis(100));
        assert_eq!(
            process.snapshot().unwrap().state,
            ProcessLifecycleV3::TimedOut
        );
    }
}
