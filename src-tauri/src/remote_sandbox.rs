//! Connection policy and authenticated Bubblewrap subsystem. This module never
//! requests a login shell or the host SFTP subsystem.

use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::AgentToolTargetNative;
use crate::db::Database;
use crate::models::RemoteConnectionRequest;

mod sftp;
pub(crate) use sftp::{AgentSftp, AgentSftpConnection};

const SUBSYSTEM: &str = "shellspan-bwrap-v1";
const POLICY_VERSION: u32 = 1;
const WORKSPACE_PARENT: &str = "/srv/shellspan-workspaces/";
const OUTSIDE: &str = "/var/lib/shellspan-sandbox/outside-probe";
const MAX_FRAME: usize = 512 * 1024;
const POLL: Duration = Duration::from_millis(15);
pub(crate) const SFTP_UNCERTAIN: &str = "SANDBOX_SFTP_UNCERTAIN: the SFTP operation or remote shutdown could not be confirmed; do not retry automatically";
const PROBES: &[&str] = &[
    "executorProtocol",
    "linux",
    "bubblewrap",
    "sandboxStart",
    "workspaceRead",
    "workspaceWrite",
    "outsideWorkspace",
    "processIsolation",
    "networkIsolation",
    "sandboxSftp",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Mode {
    ReadOnly,
    WorkspaceWrite,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Policy {
    pub(crate) mode: Mode,
    pub(crate) workspace: String,
}

impl Policy {
    pub(crate) fn validate(&self) -> Result<(), String> {
        let name = self
            .workspace
            .strip_prefix(WORKSPACE_PARENT)
            .unwrap_or_default();
        if name.len() > 128
            || !name
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        {
            return Err("SANDBOX_WORKSPACE_INVALID: use a workspace directly under /srv/shellspan-workspaces".into());
        }
        Ok(())
    }

    pub(crate) fn contains(&self, root: &str) -> bool {
        let root = root.trim_end_matches('/');
        if root.split('/').skip(1).any(|p| {
            matches!(p, "" | "." | "..") || p.contains('\\') || p.chars().any(char::is_control)
        }) {
            return false;
        }
        root == self.workspace
            || root
                .strip_prefix(&self.workspace)
                .is_some_and(|suffix| suffix.starts_with('/'))
    }

    fn request(&self, kind: &str) -> Value {
        json!({"type":kind,"workspace":self.workspace,"mode":self.mode})
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileSandbox {
    pub(crate) binding: String,
    pub(crate) policy: Option<Policy>,
    #[serde(skip)]
    pub(crate) host: String,
    #[serde(skip)]
    pub(crate) port: u16,
    #[serde(skip)]
    pub(crate) username: String,
}

#[derive(Debug, Clone)]
pub(crate) struct Binding {
    pub(crate) profile_id: String,
    pub(crate) state: ProfileSandbox,
    pub(crate) digest: String,
}

impl Binding {
    pub(crate) fn check(&self, db: &Database, known_hosts: &Path) -> Result<(), String> {
        let live = db.profile_sandbox(&self.profile_id)?;
        if live.binding != self.state.binding || approval_digest(&live, known_hosts)? != self.digest
        {
            return Err("SANDBOX_POLICY_CHANGED: request fresh authorization".into());
        }
        Ok(())
    }

    pub(crate) fn write<T>(
        &self,
        db: &Database,
        known_hosts: &Path,
        send: impl FnOnce() -> T,
    ) -> Result<T, String> {
        let _trust = crate::known_hosts::KNOWN_HOSTS_WRITE_LOCK
            .lock()
            .map_err(|_| "SANDBOX_HOST_KEYS_UNAVAILABLE")?;
        db.with_sandbox_dispatch(&self.profile_id, &self.state.binding, || {
            if approval_digest(&self.state, known_hosts)? != self.digest {
                return Err("SANDBOX_POLICY_CHANGED: trusted SSH host keys changed".into());
            }
            Ok(send())
        })?
    }
}

fn approval_digest(profile: &ProfileSandbox, known_hosts: &Path) -> Result<String, String> {
    let mut digest = Sha256::new();
    digest.update(POLICY_VERSION.to_be_bytes());
    digest.update(profile.binding.as_bytes());
    if profile.policy.is_some() {
        digest.update(trust_snapshot(known_hosts)?);
    }
    Ok(hex::encode(digest.finalize()))
}

pub(crate) fn trust_snapshot(known_hosts: &Path) -> Result<sha2::digest::Output<Sha256>, String> {
    match std::fs::read(known_hosts) {
        Ok(contents) => Ok(Sha256::digest(contents)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Sha256::digest([])),
        Err(_) => Err("SANDBOX_HOST_KEYS_UNAVAILABLE".into()),
    }
}

pub(crate) fn binding_for_target(
    target: &AgentToolTargetNative,
    db: &Database,
    known_hosts: &Path,
) -> Result<Option<Binding>, String> {
    let AgentToolTargetNative::Remote {
        profile_id,
        host,
        port,
        username,
        ..
    } = target
    else {
        return Ok(None);
    };
    let Some(id) = profile_id else {
        return if db.endpoint_has_sandbox(host, *port, username)? {
            Err("SANDBOX_PROFILE_REQUIRED".into())
        } else {
            Ok(None)
        };
    };
    let state = db.profile_sandbox(id)?;
    if state.host != *host || state.port != *port || state.username != *username {
        return Err("SANDBOX_CONNECTION_CHANGED: the saved connection identity changed".into());
    }
    let digest = approval_digest(&state, known_hosts)?;
    Ok(Some(Binding {
        profile_id: id.clone(),
        state,
        digest,
    }))
}

pub(crate) fn guard_tool(
    binding: Option<&Binding>,
    name: &str,
    args: &Value,
) -> Result<(), String> {
    let Some(policy) = binding.and_then(|b| b.state.policy.as_ref()) else {
        return Ok(());
    };
    match name {
        "run_terminal_command" | "exec_command" if args["background"] != true => Ok(()),
        "read_file" | "list_directory" | "search_text" => Ok(()),
        "write_file" | "edit_file" | "apply_patch" if policy.mode == Mode::WorkspaceWrite => Ok(()),
        "transfer_file"
            if args["direction"] == "download" || policy.mode == Mode::WorkspaceWrite =>
        {
            Ok(())
        }
        "write_file" | "edit_file" | "apply_patch" | "transfer_file" => {
            Err("SANDBOX_READ_ONLY: the remote workspace is read-only".into())
        }
        _ => Err("SANDBOX_TOOL_UNAVAILABLE: this tool cannot run inside the remote sandbox".into()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Reply {
    Executor {
        version: u32,
        linux: bool,
        bubblewrap: Bubblewrap,
        package_manager: Option<String>,
        pid_namespace: Option<String>,
        net_namespace: Option<String>,
    },
    Probe {
        passed: Vec<String>,
    },
    Sftp {
        version: u32,
    },
    Ready {
        receipt: String,
    },
    Unstarted {
        receipt: String,
    },
    Completed {
        receipt: String,
        state: CommandState,
        exit_code: i32,
        stdout: String,
        stderr: String,
        truncated: bool,
    },
    Rejected,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Bubblewrap {
    Available,
    Missing,
    Unusable,
}

fn install_command(manager: &str) -> Option<&'static str> {
    match manager {
        "apt-get" => Some("apt-get install bubblewrap"),
        "apk" => Some("apk add bubblewrap"),
        "dnf" => Some("dnf install bubblewrap"),
        "zypper" => Some("zypper install bubblewrap"),
        "pacman" => Some("pacman -S bubblewrap"),
        _ => None,
    }
}

#[derive(Debug, Copy, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CommandState {
    Exited,
    Cancelled,
    TimedOut,
    OutputLimit,
}

pub(crate) enum CommandOutcome {
    Confirmed {
        state: CommandState,
        exit_code: i32,
        stdout: String,
        stderr: String,
        truncated: bool,
    },
    NotStarted(String),
    Uncertain,
}

#[derive(Clone)]
pub(crate) struct Control {
    pub(super) deadline: Instant,
    pub(super) cancelled: CancellationToken,
    flag: Option<Arc<AtomicBool>>,
}

impl Control {
    pub(crate) fn new(deadline: Instant, cancelled: CancellationToken) -> Self {
        Self {
            deadline,
            cancelled,
            flag: None,
        }
    }
    pub(crate) fn with_flag(deadline: Instant, flag: Arc<AtomicBool>) -> Self {
        Self {
            deadline,
            cancelled: CancellationToken::new(),
            flag: Some(flag),
        }
    }
    fn is_cancelled(&self) -> bool {
        self.cancelled.is_cancelled()
            || self
                .flag
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::SeqCst))
    }
    async fn wait_cancel(&self) {
        if self.flag.is_none() {
            return self.cancelled.cancelled().await;
        }
        while !self.is_cancelled() {
            tokio::time::sleep(POLL).await;
        }
    }
    fn check(&self) -> Result<(), String> {
        if self.is_cancelled() || Instant::now() >= self.deadline {
            Err("SANDBOX_INTERRUPTED: operation cancelled or timed out".into())
        } else {
            Ok(())
        }
    }
}

struct SandboxSession {
    ssh: crate::execution::SshExecutionSession,
    _guard: crate::connection::terminal_deadline::TerminalConnectionGuard,
    // The connection guard owns a thread-local slot and any jump bridge.
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}

fn setup(
    connection: &RemoteConnectionRequest,
    known_hosts: &Path,
    control: &Control,
) -> Result<SandboxSession, String> {
    control.check()?;
    let cancelled = control.clone();
    let guard = crate::connection::terminal_deadline::TerminalConnectionGuard::new(
        control.deadline,
        move || cancelled.is_cancelled(),
    );
    let ssh = crate::execution::open_ssh_execution_session(connection, known_hosts)
        .map_err(|_| "SANDBOX_SSH_UNAVAILABLE: check the connection, host keys, and credentials")?;
    crate::connection::terminal_deadline::complete()?;
    Ok(SandboxSession {
        ssh,
        _guard: guard,
        _thread: std::marker::PhantomData,
    })
}

fn open_channel(session: &ssh2::Session, control: &Control) -> Result<ssh2::Channel, String> {
    control.check()?;
    session.set_blocking(true);
    session.set_timeout(
        control
            .deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .clamp(1, 3000) as u32,
    );
    let mut channel = session
        .channel_session()
        .map_err(|_| "SANDBOX_SUBSYSTEM_UNAVAILABLE")?;
    channel
        .subsystem(SUBSYSTEM)
        .map_err(|_| "SANDBOX_SUBSYSTEM_UNAVAILABLE: install the versioned SSH subsystem")?;
    session.set_blocking(false);
    Ok(channel)
}

fn send_frame(
    channel: &mut ssh2::Channel,
    control: &Control,
    value: &Value,
    mut send: impl FnMut(&mut ssh2::Channel, &[u8]) -> Result<std::io::Result<usize>, String>,
) -> Result<(), String> {
    let mut data = serde_json::to_vec(value).map_err(|_| "SANDBOX_INVALID_REQUEST")?;
    data.push(b'\n');
    let mut remaining = data.as_slice();
    while !remaining.is_empty() {
        control.check()?;
        match send(channel, remaining)? {
            Ok(n) if n != 0 => remaining = &remaining[n..],
            Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(POLL),
            _ => return Err("SANDBOX_TRANSPORT_WRITE_FAILED".into()),
        }
    }
    Ok(())
}

fn read_frame(
    channel: &mut ssh2::Channel,
    control: &Control,
    data: &mut Vec<u8>,
) -> Result<Reply, String> {
    let mut buf = [0; 8192];
    loop {
        control.check()?;
        match channel.read(&mut buf) {
            Ok(n) if n > 0 && data.len() + n <= MAX_FRAME => {
                data.extend_from_slice(&buf[..n]);
                if data.contains(&b'\n') {
                    if data.last() != Some(&b'\n') {
                        return Err("SANDBOX_INVALID_RESPONSE".into());
                    }
                    return serde_json::from_slice(data)
                        .map_err(|_| "SANDBOX_INVALID_RESPONSE".into());
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(POLL),
            _ => return Err("SANDBOX_RESPONSE_UNAVAILABLE".into()),
        }
    }
}

fn exchange(session: &ssh2::Session, control: &Control, request: &Value) -> Result<Reply, String> {
    let mut channel = open_channel(session, control)?;
    send_frame(&mut channel, control, request, |c, b| Ok(c.write(b)))?;
    read_frame(&mut channel, control, &mut Vec::new())
}

pub(crate) struct Verification {
    passed: Vec<&'static str>,
    protocol_version: Option<u32>,
    bubblewrap: Option<Bubblewrap>,
    pub(crate) install_command: Option<&'static str>,
}

impl Verification {
    fn verified(&self) -> Result<(), String> {
        if self.bubblewrap == Some(Bubblewrap::Missing) {
            return Err("SANDBOX_BUBBLEWRAP_MISSING: ask the administrator to install Bubblewrap, then test the executor again".into());
        }
        PROBES
            .iter()
            .find(|id| !self.passed.contains(id))
            .map_or(Ok(()), |id| {
                Err(format!(
                    "SANDBOX_UNVERIFIED: {id} did not pass; no operation was started"
                ))
            })
    }

    pub(crate) fn steps(&self) -> impl Iterator<Item = (&'static str, bool)> + '_ {
        PROBES.iter().map(|id| (*id, self.passed.contains(id)))
    }

    pub(crate) fn package_missing(&self) -> bool {
        self.bubblewrap == Some(Bubblewrap::Missing)
    }

    pub(crate) fn empty() -> Self {
        Self {
            passed: Vec::new(),
            protocol_version: None,
            bubblewrap: None,
            install_command: None,
        }
    }
}

fn verify_session(session: &ssh2::Session, policy: &Policy, control: &Control) -> Verification {
    let mut result = Verification::empty();
    if let Ok(Reply::Executor {
        version,
        linux,
        bubblewrap,
        package_manager,
        pid_namespace,
        net_namespace,
    }) = exchange(session, control, &json!({"type":"inspect"}))
    {
        result.protocol_version = Some(version);
        if version != POLICY_VERSION {
            return result;
        }
        result.passed.push("executorProtocol");
        if linux {
            result.passed.push("linux");
        }
        if bubblewrap == Bubblewrap::Available {
            result.passed.push("bubblewrap");
        }
        if linux && bubblewrap == Bubblewrap::Missing {
            result.install_command = package_manager.as_deref().and_then(install_command);
        }
        if linux && bubblewrap == Bubblewrap::Available {
            if let Ok(Reply::Probe { passed }) =
                exchange(session, control, &policy.request("probe"))
            {
                result.passed.extend(
                    PROBES[3..9]
                        .iter()
                        .copied()
                        .filter(|id| passed.iter().any(|s| s == id)),
                );
            }
            if result.passed.len() == 9 {
                if let (Some(pid), Some(net)) = (pid_namespace, net_namespace) {
                    if sftp::probe(session, policy, control, &pid, &net).is_ok() {
                        result.passed.push("sandboxSftp");
                    }
                }
            }
        }
        if linux {
            result.bubblewrap = Some(bubblewrap);
        }
    }
    result
}

#[cfg(test)]
mod tests;

pub(crate) fn verify(
    connection: &RemoteConnectionRequest,
    known_hosts: &Path,
    policy: &Policy,
    control: &Control,
) -> Verification {
    match setup(connection, known_hosts, control) {
        Ok(session) => verify_session(&session.ssh.target, policy, control),
        Err(_) => Verification::empty(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestResult {
    ssh: crate::models::ConnectionPreflightResult,
    steps: Vec<(&'static str, crate::models::ConnectionPreflightStepStatus)>,
    protocol_version: Option<u32>,
    pub(crate) passed: bool,
    cancelled: bool,
    package_missing: bool,
    install_command: Option<&'static str>,
}

pub(crate) fn test_executor(
    connection: RemoteConnectionRequest,
    policy: &Policy,
    operation_id: String,
    known_hosts: &Path,
    flag: Arc<AtomicBool>,
) -> TestResult {
    use crate::models::{ConnectionPreflightStatus, ConnectionPreflightStepStatus as Step};
    let ssh = crate::connection::preflight_connection(
        connection.clone(),
        operation_id,
        known_hosts,
        &flag,
    );
    let control = Control::with_flag(Instant::now() + Duration::from_secs(25), flag);
    let verification = if ssh.status == ConnectionPreflightStatus::Passed {
        verify(&connection, known_hosts, policy, &control)
    } else {
        Verification::empty()
    };
    let cancelled = control.is_cancelled() || ssh.status == ConnectionPreflightStatus::Cancelled;
    let mut blocked = ssh.status != ConnectionPreflightStatus::Passed;
    let steps = verification
        .steps()
        .map(|(id, passed)| {
            let status = if passed {
                Step::Passed
            } else if blocked || cancelled {
                Step::Blocked
            } else {
                blocked = true;
                Step::Failed
            };
            (id, status)
        })
        .collect();
    TestResult {
        passed: !cancelled && verification.verified().is_ok(),
        cancelled,
        ssh,
        steps,
        protocol_version: verification.protocol_version,
        package_missing: verification.package_missing(),
        install_command: verification.install_command,
    }
}

pub(crate) fn execute_command(
    db: &Database,
    binding: &Binding,
    connection: &RemoteConnectionRequest,
    known_hosts: &Path,
    command: &str,
    timeout: Duration,
    cancellation: &CancellationToken,
) -> CommandOutcome {
    let mut attempted = false;
    let result = (|| -> Result<CommandOutcome, String> {
        let control = Control::new(
            Instant::now() + Duration::from_secs(25),
            cancellation.clone(),
        );
        let policy = binding
            .state
            .policy
            .as_ref()
            .ok_or("SANDBOX_POLICY_CHANGED")?;
        binding.check(db, known_hosts)?;
        let session = setup(connection, known_hosts, &control)?;
        verify_session(&session.ssh.target, policy, &control).verified()?;
        let mut channel = open_channel(&session.ssh.target, &control)?;
        send_frame(
            &mut channel,
            &control,
            &policy.request("command"),
            |c, b| Ok(c.write(b)),
        )?;
        let Reply::Ready { receipt } = read_frame(&mut channel, &control, &mut Vec::new())? else {
            return Err("SANDBOX_EXECUTOR_NOT_READY".into());
        };
        if receipt.len() != 32 || !receipt.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("SANDBOX_INVALID_RECEIPT".into());
        }
        send_frame(
            &mut channel,
            &control,
            &json!({"receipt":receipt,"command":command,"timeoutMs":timeout.as_millis()}),
            |c, b| {
                binding.write(db, known_hosts, || {
                    if control.check().is_err() {
                        return Err(ErrorKind::Interrupted.into());
                    }
                    attempted = true;
                    c.write(b)
                })
            },
        )?;
        let control = Control::new(
            Instant::now() + timeout + Duration::from_secs(3),
            cancellation.clone(),
        );
        let mut frame = Vec::new();
        let reply = match read_frame(&mut channel, &control, &mut frame) {
            result @ Ok(_) => result?,
            Err(_) if cancellation.is_cancelled() || Instant::now() >= control.deadline => {
                let grace = Control::new(
                    Instant::now() + Duration::from_secs(3),
                    CancellationToken::new(),
                );
                while grace.check().is_ok() {
                    match channel.send_eof() {
                        Ok(()) => break,
                        Err(e)
                            if e.code()
                                == ssh2::ErrorCode::Session(libssh2_sys::LIBSSH2_ERROR_EAGAIN) =>
                        {
                            std::thread::sleep(POLL)
                        }
                        Err(_) => break,
                    }
                }
                read_frame(&mut channel, &grace, &mut frame)?
            }
            Err(e) => return Err(e),
        };
        if matches!(&reply, Reply::Unstarted { receipt: returned } if returned == &receipt) {
            return Ok(CommandOutcome::NotStarted(
                "SANDBOX_START_FAILED: Bubblewrap could not start the command".into(),
            ));
        }
        let Reply::Completed {
            receipt: returned,
            state,
            exit_code,
            stdout,
            stderr,
            truncated,
        } = reply
        else {
            return Err("SANDBOX_RESULT_UNCONFIRMED".into());
        };
        if returned != receipt || !(0..=255).contains(&exit_code) {
            return Err("SANDBOX_INVALID_RESULT".into());
        }
        let secrets = crate::execution::known_connection_secret_values(connection);
        let decode = |encoded: &str, max: usize| -> Result<String, String> {
            let data = STANDARD
                .decode(encoded)
                .map_err(|_| "SANDBOX_INVALID_OUTPUT")?;
            if data.len() > max {
                return Err("SANDBOX_OUTPUT_LIMIT".into());
            }
            Ok(crate::execution::redact_known_secrets(
                &String::from_utf8_lossy(&data),
                &secrets,
            ))
        };
        Ok(CommandOutcome::Confirmed {
            state,
            exit_code,
            stdout: decode(&stdout, 256 * 1024)?,
            stderr: decode(&stderr, 64 * 1024)?,
            truncated,
        })
    })();
    match result {
        Ok(result) => result,
        Err(_) if attempted => CommandOutcome::Uncertain,
        Err(error) => CommandOutcome::NotStarted(error),
    }
}
