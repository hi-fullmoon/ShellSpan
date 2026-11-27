#[cfg(unix)]
use libc::{poll, pollfd, POLLIN, POLLOUT};
use log::{error, info, warn};
use ssh2::{BlockDirections, Channel, ExtendedData, Session};
#[cfg(any(not(unix), test))]
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::{
    cell::Cell,
    collections::VecDeque,
    io::{ErrorKind, Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        mpsc::{Receiver, TryRecvError},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(windows)]
use std::os::windows::io::AsRawSocket;

use crate::{
    connection::{
        connect_tcp_stream, connect_through_jump_host, open_authenticated_session,
        summarize_session_request,
        terminal_deadline::{self, PlainSshRetryReason, TerminalStartupMode},
        SSH_SESSION_KEEPALIVE_INTERVAL_SECS,
    },
    db::Database,
    drain_decoded_output, emit_data, emit_session_error, emit_status, flush_pending_output,
    known_hosts::known_hosts_path,
    models::{
        ClosedReasonKind, ConnectionError, NativeControlFrame, SessionCommand,
        SessionCreateRequest, SessionErrorEvent, SessionManager, SessionStatus, StatusEvent,
    },
    observe_terminal_raw_output,
    petdex::{ActivityGuard, ActivityPhase},
    terminal_broker::{PendingSshTerminal, TerminalGeometry, TerminalSessionBroker},
    terminal_command::protocol as native_protocol,
    terminal_integration::{
        quote_remote_posix, remote_posix_bootstrap, TerminalIntegrationStreamDecoder,
        TerminalShellKind,
    },
    terminal_vim_bridge::{EditorWrite, RemoteVimBridge, VimBridgeShellConfig},
};

const SSH_IDLE_WAIT_SLICE_MS: u64 = 20;
const SSH_OUTPUT_FLUSH_THRESHOLD_BYTES: usize = 64 * 1024;
const SSH_OUTPUT_READY_TIMEOUT: Duration = Duration::from_secs(5);
const SSH_STARTUP_OUTPUT_BUFFER_LIMIT_BYTES: usize = 1_000_000;
const SSH_PLAIN_STARTUP_GRACE: Duration = Duration::from_millis(400);
#[path = "terminal_command/remote.rs"]
mod remote_native;
use remote_native::RemoteNativeBash;

struct RemoteSshShellIntegration {
    integration_id: String,
    shell: TerminalShellKind,
    shell_executable: String,
    remote_root: String,
    bootstrap_path: String,
    fifo_path: String,
    control: Channel,
    decoder: TerminalIntegrationStreamDecoder,
    active: bool,
    accept_events: bool,
}

struct RemoteLoginShellIdentity {
    shell: TerminalShellKind,
    executable: String,
    home_directory: String,
}

impl RemoteSshShellIntegration {
    fn prepare(session: &Session, username: &str) -> Result<Self, String> {
        let identity = detect_remote_login_shell_identity(session, username)?;
        let shell = identity.shell;
        if !matches!(shell, TerminalShellKind::Bash | TerminalShellKind::Zsh) {
            return Err("TERMINAL_INTEGRATION_UNSUPPORTED_REMOTE_SHELL".into());
        }
        let suffix = Uuid::new_v4().simple().to_string();
        let remote_root = format!("/tmp/.shellspan-terminal-integration-{suffix}");
        let bootstrap_path = match shell {
            TerminalShellKind::Bash => format!("{remote_root}/.bash_profile"),
            TerminalShellKind::Zsh => format!("{remote_root}/.zshrc"),
            _ => unreachable!("unsupported shells return before integration setup"),
        };
        let fifo_path = format!("{remote_root}/control");
        let sftp = session
            .sftp()
            .map_err(|error| format!("failed to open remote integration SFTP: {error}"))?;
        sftp.mkdir(Path::new(&remote_root), 0o700)
            .map_err(|error| format!("failed to create remote integration root: {error}"))?;
        let setup = (|| {
            let source = format!(
                "{}\n{}",
                remote_posix_bootstrap(
                    shell,
                    &fifo_path,
                    &identity.home_directory,
                    &identity.executable,
                )?,
                crate::terminal_vim_bridge::SHELL_AUTO_ATTACH_SNIPPET,
            );
            let mut remote = sftp
                .create(Path::new(&bootstrap_path))
                .map_err(|error| format!("failed to create remote integration script: {error}"))?;
            remote
                .write_all(source.as_bytes())
                .map_err(|error| format!("failed to upload remote integration script: {error}"))?;
            drop(remote);
            sftp.setstat(
                Path::new(&bootstrap_path),
                ssh2::FileStat {
                    size: None,
                    uid: None,
                    gid: None,
                    perm: Some(0o600),
                    atime: None,
                    mtime: None,
                },
            )
            .map_err(|error| format!("failed to protect remote integration script: {error}"))?;
            if shell == TerminalShellKind::Zsh {
                for (name, user_path) in [
                    (".zshenv", "$HOME/.zshenv"),
                    (".zprofile", "$HOME/.zprofile"),
                    (".zlogin", "$HOME/.zlogin"),
                ] {
                    let path = format!("{remote_root}/{name}");
                    let mut remote = sftp.create(Path::new(&path)).map_err(|error| {
                        format!("failed to create remote zsh integration startup file: {error}")
                    })?;
                    // OpenSSH runs an exec request through the account's Zsh
                    // as `zsh -c`, and Zsh always reads the user's .zshenv for
                    // that parent process. Exported environment changes are
                    // inherited by the integrated login shell. Sourcing it
                    // again from the temporary ZDOTDIR would duplicate side
                    // effects, unlike a normal SSH shell request.
                    let startup = if name == ".zshenv" {
                        ": # user .zshenv already loaded by the OpenSSH exec parent\n".to_string()
                    } else {
                        format!("[[ -r {user_path} ]] && source {user_path}\n")
                    };
                    remote.write_all(startup.as_bytes()).map_err(|error| {
                        format!("failed to upload remote zsh integration startup file: {error}")
                    })?;
                    drop(remote);
                    sftp.setstat(
                        Path::new(&path),
                        ssh2::FileStat {
                            size: None,
                            uid: None,
                            gid: None,
                            perm: Some(0o600),
                            atime: None,
                            mtime: None,
                        },
                    )
                    .map_err(|error| {
                        format!("failed to protect remote zsh integration startup file: {error}")
                    })?;
                }
            }
            run_ssh_setup_command(
                session,
                &format!(
                    "umask 077; mkfifo -- {}; chmod 600 -- {}",
                    quote_remote_posix(&fifo_path),
                    quote_remote_posix(&fifo_path)
                ),
            )?;
            let mut control = session
                .channel_session()
                .map_err(|error| format!("failed to open remote integration channel: {error}"))?;
            control
                .handle_extended_data(ExtendedData::Ignore)
                .map_err(|error| {
                    format!("failed to configure remote integration channel: {error}")
                })?;
            let command = format!(
                "exec /bin/sh -c {} shellspan-control {}",
                quote_remote_posix(include_str!("terminal-ssh-control.sh")),
                quote_remote_posix(&fifo_path),
            );
            control
                .exec(&command)
                .map_err(|error| format!("failed to start remote integration reader: {error}"))?;
            Ok(control)
        })();
        let control = match setup {
            Ok(control) => control,
            Err(error) => {
                cleanup_remote_integration_files(&sftp, &remote_root, &bootstrap_path, &fifo_path);
                return Err(error);
            }
        };
        Ok(Self {
            integration_id: format!("integration-{}", Uuid::new_v4()),
            shell,
            shell_executable: identity.executable,
            remote_root,
            bootstrap_path,
            fifo_path,
            control,
            decoder: TerminalIntegrationStreamDecoder::default(),
            active: true,
            accept_events: true,
        })
    }

    fn start_shell(
        &self,
        shell_channel: &mut Channel,
        bridge: Option<VimBridgeShellConfig<'_>>,
    ) -> Result<(), String> {
        let command =
            remote_integrated_shell_command(self.shell, &self.shell_executable, &self.remote_root)?;
        shell_channel
            .exec(&with_vim_bridge(bridge, command))
            .map_err(|error| format!("failed to start integrated remote shell: {error}"))
    }

    fn cleanup_files(&mut self, session: &Session) {
        let previous_timeout = session.timeout();
        session.set_timeout(if previous_timeout == 0 {
            1500
        } else {
            previous_timeout.min(1500)
        });
        session.set_blocking(true);
        if let Ok(sftp) = session.sftp() {
            cleanup_remote_integration_files(
                &sftp,
                &self.remote_root,
                &self.bootstrap_path,
                &self.fifo_path,
            );
        }
        session.set_timeout(previous_timeout);
    }

    fn disable_after_control_failure(&mut self, _session: &Session) {
        self.active = false;
        self.accept_events = false;
        // Defer remote SFTP file cleanup until session teardown (`close`) so we
        // never switch a live nonblocking SSH session into blocking mode or
        // stall PTY I/O across SFTP RTTs.
        let _ = self.control.send_eof();
        let _ = self.control.close();
    }

    fn close(mut self, session: &Session) {
        if self.active {
            self.active = false;
            let _ = self.control.send_eof();
            let _ = self.control.close();
        }
        self.cleanup_files(session);
    }
}

fn with_vim_bridge(bridge: Option<VimBridgeShellConfig<'_>>, command: String) -> String {
    match bridge {
        Some(config) if config.auto_attach => format!(
            "export SHELLSPAN_VIM_BRIDGE={} SHELLSPAN_VIM_BRIDGE_AUTO=1\n{command}",
            quote_remote_posix(config.source_path)
        ),
        Some(config) => format!(
            "export SHELLSPAN_VIM_BRIDGE={}\n{command}",
            quote_remote_posix(config.source_path)
        ),
        None => command,
    }
}

fn cleanup_remote_integration_files(
    sftp: &ssh2::Sftp,
    remote_root: &str,
    bootstrap_path: &str,
    fifo_path: &str,
) {
    if let Ok(entries) = sftp.readdir(Path::new(remote_root)) {
        let prefix = Path::new(fifo_path)
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| format!("{name}.job."));
        if let Some(prefix) = prefix {
            for (path, _) in entries {
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if crate::terminal_display_recovery::TtyRecoveryReply::is_reply_file(name) {
                    let _ = sftp.unlink(Path::new(&format!("{remote_root}/{name}")));
                    continue;
                }
                let Some(suffix) = name.strip_prefix(&prefix) else {
                    continue;
                };
                let handle = suffix.split('.').next().unwrap_or("");
                let tail = suffix.strip_prefix(handle).unwrap_or("");
                if crate::terminal_jobs::validate_handle(handle).is_ok()
                    && matches!(
                        tail,
                        "" | ".pending" | ".identity" | ".running" | ".stopped"
                    )
                {
                    let _ = sftp.unlink(Path::new(&format!("{remote_root}/{name}")));
                }
            }
        }
    }
    let _ = sftp.unlink(Path::new(bootstrap_path));
    let _ = sftp.unlink(Path::new(fifo_path));
    for name in [".zshenv", ".zprofile", ".zlogin"] {
        let _ = sftp.unlink(Path::new(&format!("{remote_root}/{name}")));
    }
    let _ = sftp.rmdir(Path::new(remote_root));
}

fn detect_remote_login_shell(
    session: &Session,
    username: &str,
) -> Result<TerminalShellKind, String> {
    detect_remote_login_shell_identity(session, username).map(|identity| identity.shell)
}

pub(crate) fn initial_directory_input(directory: Option<&str>) -> Result<Option<String>, String> {
    match directory {
        None => Ok(None),
        Some(path) if path.is_empty() || path.chars().any(char::is_control) => {
            Err("invalid initial terminal directory".into())
        }
        // Restore ordinary terminal echo before changing directory, including
        // when cd fails. The interactive shell consumes this line after its
        // startup scripts; it is not evaluated by an SSH exec parent.
        Some(path) => Ok(Some(format!(
            "stty echo; cd -- {}\r",
            quote_remote_posix(path)
        ))),
    }
}

fn initial_directory_pty_modes(directory: Option<&str>) -> Option<ssh2::PtyModes> {
    directory.map(|_| {
        let mut modes = ssh2::PtyModes::new();
        // Prevent the PTY line discipline echoing queued setup before the
        // shell's line editor reads and displays it.
        modes.set_boolean(ssh2::PtyModeOpcode::ECHO, false);
        modes
    })
}

fn remote_integrated_shell_command(
    shell: TerminalShellKind,
    shell_executable: &str,
    remote_root: &str,
) -> Result<String, String> {
    match shell {
        TerminalShellKind::Bash => Ok(format!(
            "exec env HOME={} {} -il",
            quote_remote_posix(remote_root),
            quote_remote_posix(shell_executable)
        )),
        TerminalShellKind::Zsh => Ok(format!(
            "exec env ZDOTDIR={} {} -il",
            quote_remote_posix(remote_root),
            quote_remote_posix(shell_executable)
        )),
        _ => Err("TERMINAL_INTEGRATION_UNSUPPORTED_REMOTE_SHELL".into()),
    }
}

fn detect_remote_login_shell_identity(
    session: &Session,
    username: &str,
) -> Result<RemoteLoginShellIdentity, String> {
    let sftp = session
        .sftp()
        .map_err(|error| format!("failed to inspect remote login shell: {error}"))?;
    let file = sftp
        .open(Path::new("/etc/passwd"))
        .map_err(|error| format!("failed to open remote account database: {error}"))?;
    let mut contents = String::new();
    file.take(1_048_577)
        .read_to_string(&mut contents)
        .map_err(|error| format!("failed to read remote account database: {error}"))?;
    if contents.len() > 1_048_576 {
        return Err("remote account database exceeds the integration inspection limit".into());
    }
    parse_remote_login_shell_identity(&contents, username)
}

fn parse_remote_login_shell_identity(
    contents: &str,
    username: &str,
) -> Result<RemoteLoginShellIdentity, String> {
    let prefix = format!("{username}:");
    let fields = contents
        .lines()
        .find(|line| line.starts_with(&prefix))
        .map(|line| line.split(':').collect::<Vec<_>>())
        .ok_or_else(|| "remote login shell identity is unavailable".to_string())?;
    if fields.len() != 7 || fields[5].is_empty() || fields[6].is_empty() {
        return Err("remote login shell identity is invalid".into());
    }
    Ok(RemoteLoginShellIdentity {
        shell: TerminalShellKind::detect(fields[6]),
        executable: fields[6].to_string(),
        home_directory: fields[5].to_string(),
    })
}

fn run_ssh_setup_command(session: &Session, command: &str) -> Result<(), String> {
    read_ssh_setup_command(session, command).map(drop)
}

fn read_ssh_setup_command(session: &Session, command: &str) -> Result<Vec<u8>, String> {
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("failed to open remote integration setup channel: {error}"))?;
    channel
        .exec(command)
        .map_err(|error| format!("failed to run remote integration setup: {error}"))?;
    let mut output = Vec::new();
    (&mut channel)
        .take(8_193)
        .read_to_end(&mut output)
        .map_err(|error| format!("failed to drain remote integration setup: {error}"))?;
    if output.len() > 8_192 {
        return Err("remote integration setup output exceeded the limit".into());
    }
    channel
        .wait_close()
        .map_err(|error| format!("failed to close remote integration setup: {error}"))?;
    let status = channel
        .exit_status()
        .map_err(|error| format!("failed to read remote integration setup status: {error}"))?;
    if status == 0 {
        Ok(output)
    } else {
        Err(format!(
            "remote integration setup exited with status {status}"
        ))
    }
}

/// Write half of the session self-pipe. Command senders poke it after
/// enqueueing a command so the session loop wakes from its idle poll
/// immediately instead of discovering the command on the next 20ms slice.
pub(crate) struct SessionWaker {
    #[cfg(unix)]
    stream: std::os::unix::net::UnixStream,
    #[cfg(not(unix))]
    stream: TcpStream,
}

/// Read half of the session self-pipe, polled by the session loop alongside
/// the SSH socket.
pub(crate) struct SessionWakeSource {
    #[cfg(unix)]
    stream: std::os::unix::net::UnixStream,
    #[cfg(not(unix))]
    stream: TcpStream,
}

#[cfg(unix)]
pub(crate) fn session_wake_pair() -> std::io::Result<(SessionWaker, SessionWakeSource)> {
    let (writer, reader) = std::os::unix::net::UnixStream::pair()?;
    writer.set_nonblocking(true)?;
    reader.set_nonblocking(true)?;
    Ok((
        SessionWaker { stream: writer },
        SessionWakeSource { stream: reader },
    ))
}

#[cfg(not(unix))]
pub(crate) fn session_wake_pair() -> std::io::Result<(SessionWaker, SessionWakeSource)> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let address = listener.local_addr()?;
    let writer = TcpStream::connect(address)?;
    let expected_peer = writer.local_addr()?;
    let reader = loop {
        let (candidate, peer) = listener.accept()?;
        if peer == expected_peer {
            break candidate;
        }
    };
    writer.set_nodelay(true)?;
    writer.set_nonblocking(true)?;
    reader.set_nonblocking(true)?;
    Ok((
        SessionWaker { stream: writer },
        SessionWakeSource { stream: reader },
    ))
}

impl SessionWaker {
    pub(crate) fn wake(&self) {
        // The stream is nonblocking: a full send buffer means wakeups are
        // already queued, so dropping this one loses nothing.
        let _ = (&self.stream).write_all(&[1_u8]);
    }
}

impl SessionWakeSource {
    #[cfg(unix)]
    fn fd(&self) -> std::os::fd::RawFd {
        self.stream.as_raw_fd()
    }

    #[cfg(windows)]
    fn socket(&self) -> std::os::windows::io::RawSocket {
        self.stream.as_raw_socket()
    }

    fn drain(&self) {
        let mut buffer = [0_u8; 256];
        loop {
            match (&self.stream).read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    }
}

fn open_remote_pty_channel(
    session: &Session,
    request: &SessionCreateRequest,
    session_id: &str,
) -> Result<Channel, ConnectionError> {
    let mut channel = session.channel_session().map_err(|error| {
        error!("Failed to open SSH channel session_id={session_id}: {error}");
        ConnectionError::Other {
            message: format!("failed to open ssh channel: {error}"),
        }
    })?;
    let setup = (|| {
        channel
            .request_pty(
                "xterm-256color",
                initial_directory_pty_modes(request.initial_directory.as_deref()),
                Some((request.terminal_cols, request.terminal_rows, 0, 0)),
            )
            .map_err(|error| {
                error!("Failed to allocate PTY session_id={session_id}: {error}");
                ConnectionError::Other {
                    message: format!("failed to allocate PTY: {error}"),
                }
            })?;
        channel
            .handle_extended_data(ExtendedData::Merge)
            .map_err(|error| {
                error!("Failed to configure extended-data mode session_id={session_id}: {error}");
                ConnectionError::Other {
                    message: format!("failed to configure extended-data mode: {error}"),
                }
            })?;
        Ok(())
    })();
    if setup.is_err() {
        graceful_shutdown(&mut channel);
    }
    setup.map(|()| channel)
}

fn read_startup_pty(channel: &mut Channel, output: &mut Vec<u8>) -> Result<bool, String> {
    let mut bytes = [0; 8192];
    match channel.read(&mut bytes) {
        Ok(0) if channel.eof() => Err("remote shell closed during initialization".into()),
        Ok(0) => Ok(false),
        Ok(count) => {
            output.extend_from_slice(&bytes[..count]);
            Ok(true)
        }
        Err(error) if is_retryable_channel_error_kind(error.kind()) => Ok(false),
        Err(error) => Err(format_transport_error(
            "startup PTY failed",
            &error.to_string(),
        )),
    }
}

fn confirm_plain_ssh_startup(
    session: &Session,
    channel: &mut Channel,
    output: &mut Vec<u8>,
) -> Result<(), String> {
    // An SSH shell request only acknowledges the fork. Give immediate login
    // failures time to arrive without requiring a prompt from arbitrary shells.
    let deadline = Instant::now() + SSH_PLAIN_STARTUP_GRACE;
    loop {
        let progress = read_startup_pty(channel, output)?;
        if channel.eof() {
            return Err("remote shell closed during initialization".into());
        }
        if Instant::now() >= deadline || output.len() >= SSH_STARTUP_OUTPUT_BUFFER_LIMIT_BYTES {
            return Ok(());
        }
        if !progress {
            wait_for_session_socket(session, Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS))?;
        }
    }
}

fn queue_initial_ssh_directory(
    session: &Session,
    channel: &mut Channel,
    input: Option<&str>,
) -> Result<(), String> {
    if let Some(input) = input {
        write_all_nonblocking(session, channel, input.as_bytes())
            .map_err(|error| format!("failed to queue initial terminal directory: {error}"))?;
    }
    Ok(())
}

enum NativeSshStartupOutcome {
    Ready(Vec<native_protocol::Message>),
    Unavailable(String),
}

fn wait_for_native_ssh_startup(
    session: &Session,
    channel: &mut Channel,
    native: &mut RemoteNativeBash,
    pending: &mut PendingSshTerminal,
    _session_id: &str,
    output: &mut Vec<u8>,
) -> Result<NativeSshStartupOutcome, String> {
    let probe = pending.register_native_channel(native.profile.clone())?;
    let bytes = probe
        .encode()
        .map_err(|_| "TERMINAL_NATIVE_PROTOCOL_INVALID")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut probe_sent = false;
    loop {
        let pty_progress = read_startup_pty(channel, output)?;
        let mut control_progress = false;
        match native.read_control() {
            Ok(Some(messages)) if !messages.is_empty() => {
                let mut messages = messages.into_iter();
                let message = messages.next().expect("nonempty control batch");
                let native_protocol::Message::Connection(capabilities) = &message else {
                    return Ok(NativeSshStartupOutcome::Unavailable(
                        "unexpected_control_message".into(),
                    ));
                };
                #[cfg(all(
                    feature = "native-input-acceptance",
                    debug_assertions,
                    target_os = "macos",
                    target_arch = "aarch64"
                ))]
                crate::terminal_command::acceptance_trace::observe_ssh_receipt(
                    &message,
                    _session_id,
                )?;
                if let Err(error) = pending.accept_native_capabilities(capabilities) {
                    return Ok(NativeSshStartupOutcome::Unavailable(format!(
                        "capabilities_rejected:{error}"
                    )));
                }
                // Reading the relay can also consume a PTY EOF from this socket.
                read_startup_pty(channel, output)?;
                if channel.eof() || native.control_eof() {
                    return Err(
                        "remote shell or native control closed during initialization".into(),
                    );
                }
                return Ok(NativeSshStartupOutcome::Ready(messages.collect()));
            }
            Ok(Some(_)) => {
                control_progress = true;
            }
            Err(error) => {
                return Ok(NativeSshStartupOutcome::Unavailable(format!(
                    "control_read:{error}"
                )));
            }
            Ok(None) => {}
        }
        if !probe_sent && native.relay_started() {
            if let Err(error) = native.send(session, &bytes) {
                return Ok(NativeSshStartupOutcome::Unavailable(format!(
                    "probe_send:{error}"
                )));
            }
            probe_sent = true;
            control_progress = true;
        }
        if Instant::now() >= deadline {
            return Ok(NativeSshStartupOutcome::Unavailable(if probe_sent {
                "capabilities_timeout".into()
            } else {
                "relay_preamble_timeout".into()
            }));
        }
        if output.len() >= SSH_STARTUP_OUTPUT_BUFFER_LIMIT_BYTES {
            return Ok(NativeSshStartupOutcome::Unavailable(
                "startup_output_limit".into(),
            ));
        }
        if !pty_progress && !control_progress {
            wait_for_session_socket(session, Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS))?;
        }
    }
}

struct SshNativeStartup {
    pending: PendingSshTerminal,
    messages: Option<Vec<native_protocol::Message>>,
}

fn start_ssh_native_or_fallback(
    session: &Session,
    channel: &mut Channel,
    native: &mut Option<RemoteNativeBash>,
    broker: &TerminalSessionBroker,
    request: &SessionCreateRequest,
    session_id: &str,
    initial_output: &mut Vec<u8>,
    initial_input: Option<&str>,
    vim_bridge_config: Option<VimBridgeShellConfig<'_>>,
) -> Result<Option<SshNativeStartup>, ConnectionError> {
    let prepared = native.as_mut().expect("native resources prepared");
    let private_bash = prepared.uses_private_bash();
    let mut pending = broker
        .prepare_ssh_native_terminal(
            session_id,
            request.replaces_session_id.as_deref(),
            TerminalGeometry::new(request.terminal_cols, request.terminal_rows),
        )
        .map_err(|message| ConnectionError::Other { message })?;
    let started = Instant::now();
    if let Err(reason) = prepared.start_relay(session) {
        info!(
            "Native SSH shell startup session_id={session_id} outcome=unavailable reason={reason:?} elapsed_ms={}",
            started.elapsed().as_millis()
        );
        if let Some(message) = crate::connection::terminal_deadline::failure_reason() {
            return Err(ConnectionError::Other { message });
        }
        warn!(
            "Native SSH relay startup failed; using ordinary SSH shell session_id={session_id} reason={reason}"
        );
        if let Some(native) = native.take() {
            native.close(session);
        }
        channel.shell().map_err(|error| ConnectionError::Other {
            message: format!(
                "failed to start ordinary remote shell after native relay startup failed: {error}"
            ),
        })?;
        initial_output.clear();
        session.set_blocking(false);
        confirm_plain_ssh_startup(session, channel, initial_output)
            .and_then(|()| queue_initial_ssh_directory(session, channel, initial_input))
            .map_err(|message| ConnectionError::Other { message })?;
        return Ok(None);
    }
    let startup = prepared
        .start_shell(channel, vim_bridge_config)
        .and_then(|()| {
            session.set_blocking(false);
            queue_initial_ssh_directory(session, channel, initial_input)?;
            wait_for_native_ssh_startup(
                session,
                channel,
                prepared,
                &mut pending,
                session_id,
                initial_output,
            )
        });
    let (outcome, reason) = match &startup {
        Ok(NativeSshStartupOutcome::Ready(_)) => ("ready", None),
        Ok(NativeSshStartupOutcome::Unavailable(reason)) => ("unavailable", Some(reason.as_str())),
        Err(error) => ("failed", Some(error.as_str())),
    };
    info!(
        "Native SSH shell startup session_id={session_id} outcome={outcome} reason={reason:?} elapsed_ms={}",
        started.elapsed().as_millis()
    );
    match startup {
        Ok(NativeSshStartupOutcome::Ready(messages)) => {
            return Ok(Some(SshNativeStartup {
                pending,
                messages: Some(messages),
            }))
        }
        Ok(NativeSshStartupOutcome::Unavailable(_)) if !private_bash => {
            confirm_plain_ssh_startup(session, channel, initial_output)
                .map_err(|message| ConnectionError::Other { message })?;
            return Ok(Some(SshNativeStartup {
                pending,
                messages: None,
            }));
        }
        Err(message) if !private_bash => return Err(ConnectionError::Other { message }),
        _ => {}
    }
    if let Some(message) = crate::connection::terminal_deadline::failure_reason() {
        return Err(ConnectionError::Other { message });
    }
    warn!("Private remote Bash startup failed; using ordinary SSH shell session_id={session_id}");
    session.set_blocking(false);
    graceful_shutdown(channel);
    if let Some(native) = native.take() {
        native.close(session);
    }
    *channel = open_remote_pty_channel(session, request, session_id)?;
    channel.shell().map_err(|error| ConnectionError::Other {
        message: format!(
            "failed to start ordinary remote shell after native startup failed: {error}"
        ),
    })?;
    initial_output.clear();
    session.set_blocking(false);
    confirm_plain_ssh_startup(session, channel, initial_output)
        .and_then(|()| queue_initial_ssh_directory(session, channel, initial_input))
        .map_err(|message| ConnectionError::Other { message })?;
    Ok(None)
}

fn attach_started_ssh_terminal(
    broker: &TerminalSessionBroker,
    sessions: &SessionManager,
    request: &SessionCreateRequest,
    session_id: &str,
    startup: Option<SshNativeStartup>,
) -> Result<(StatusEvent, Option<Vec<native_protocol::Message>>), String> {
    let (pending, messages) = startup.map_or((None, None), |startup| {
        (Some(startup.pending), startup.messages)
    });
    let event = broker.commit_started_ssh_terminal(
        sessions,
        session_id,
        request.replaces_session_id.as_deref(),
        TerminalGeometry::new(request.terminal_cols, request.terminal_rows),
        pending,
    )?;
    Ok((event, messages))
}

pub(crate) const SSH_NATIVE_RESOURCES_UNAVAILABLE: &str = "nativeResourcesUnavailable";

fn native_ssh_unavailable_reason(reason: &str) -> &str {
    if reason.starts_with(remote_native::GLIBC_TOO_OLD_REASON) || reason == "nativeStartupTimedOut"
    {
        reason
    } else if matches!(
        reason,
        "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE" | "TERMINAL_NATIVE_STALE_ARTIFACTS"
    ) {
        SSH_NATIVE_RESOURCES_UNAVAILABLE
    } else {
        "nativeProfileMismatch"
    }
}

pub(crate) fn run_ssh_session<C: FnOnce() -> Result<(), String> + Send>(
    app: &AppHandle,
    session_id: &str,
    request: &SessionCreateRequest,
    rx: &Receiver<SessionCommand>,
    wake: &SessionWakeSource,
    output_ready: Arc<AtomicBool>,
    output_paused: Arc<AtomicBool>,
    bootstrap_remote_integration: bool,
    startup_mode: TerminalStartupMode,
    on_connected: C,
    activity: &mut ActivityGuard,
) -> Result<Option<String>, ConnectionError> {
    info!(
        "SSH session connecting session_id={} {}",
        session_id,
        summarize_session_request(request)
    );
    emit_status(
        app,
        session_id,
        SessionStatus::Connecting,
        Some(format!("dialing {}:{}...", request.host, request.port)),
    )
    .map_err(|message| ConnectionError::Other { message })?;

    let mut _jump_session_holder: Option<Box<ssh2::Session>> = None;
    let known_hosts =
        known_hosts_path(app).map_err(|message| ConnectionError::Other { message })?;
    let known_hosts_ref = Some(known_hosts.as_path());
    let session_result = crate::connection::interactive_auth::with_prompt_scope(
        app.clone(),
        request
            .operation_id
            .clone()
            .unwrap_or_else(|| session_id.to_string()),
        || false,
        || {
            if let Some(ref jump) = request.jump_host {
                connect_through_jump_host(
                    jump,
                    &request.host,
                    request.port,
                    &request.username,
                    request.auth_method,
                    request.password.as_deref(),
                    request.private_key_data.as_deref(),
                    request.passphrase.as_deref(),
                    known_hosts_ref,
                )
                .map(|(jump_session, target_session)| {
                    _jump_session_holder = Some(Box::new(jump_session));
                    target_session
                })
            } else {
                connect_tcp_stream(&request.host, request.port)
                    .map_err(|message| ConnectionError::Other { message })
                    .and_then(|tcp| {
                        open_authenticated_session(
                            tcp,
                            &request.username,
                            request.auth_method,
                            request.password.as_deref(),
                            request.private_key_data.as_deref(),
                            request.passphrase.as_deref(),
                            &request.host,
                            request.port,
                            known_hosts_ref,
                        )
                    })
            }
        },
    );

    let session = match session_result {
        Ok(session) => session,
        Err(connection_error) => {
            match connection_error {
                ConnectionError::HostKeyUnknown {
                    ref host,
                    ref port,
                    ref fingerprint,
                } => {
                    let _ = emit_session_error(
                        app,
                        SessionErrorEvent::HostKeyUnknown {
                            session_id: session_id.to_string(),
                            host: host.clone(),
                            port: *port,
                            fingerprint: fingerprint.clone(),
                        },
                    );
                }
                ConnectionError::HostKeyMismatch {
                    ref host,
                    ref port,
                    ref fingerprint,
                } => {
                    let _ = emit_session_error(
                        app,
                        SessionErrorEvent::HostKeyMismatch {
                            session_id: session_id.to_string(),
                            host: host.clone(),
                            port: *port,
                            fingerprint: fingerprint.clone(),
                        },
                    );
                }
                ConnectionError::Other { .. } => {}
            }
            return Err(connection_error);
        }
    };

    let predecessor_mode = request
        .replaces_session_id
        .as_deref()
        .and_then(|previous| {
            app.try_state::<crate::agent_runtime::AgentRuntime>()
                .and_then(|runtime| runtime.terminal_broker_snapshot(Some(previous)).ok())
        })
        .and_then(|snapshot| snapshot.session)
        .map(|session| session.input_mode);
    let native_family = predecessor_mode.is_some();
    let plain_retry = matches!(&startup_mode, TerminalStartupMode::PlainRetry(_));
    let native_requested = bootstrap_remote_integration
        && request.native_input_protocol.as_deref()
            == Some(crate::terminal_command::protocol::PROTOCOL);
    let (mut native_integration, mut native_failure) = if let TerminalStartupMode::PlainRetry(
        reason,
    ) = startup_mode
    {
        let reason = match reason {
            PlainSshRetryReason::NativeTimeout => "nativeStartupTimedOut".into(),
            PlainSshRetryReason::NativeUnavailable(reason) => reason,
        };
        (None, Some(reason))
    } else if native_requested {
        terminal_deadline::mark_native_startup_started(
            terminal_deadline::NATIVE_SSH_STARTUP_TIMEOUT,
        )
        .map_err(|message| ConnectionError::Other { message })?;
        let started = Instant::now();
        let mut timings = remote_native::SftpStartupTimings::default();
        let preparation =
            crate::terminal_command::artifacts::resource_root(app).and_then(|resources| {
                RemoteNativeBash::prepare(&session, &request.username, &resources, &mut timings)
            });
        let interruption = terminal_deadline::failure_reason();
        let outcome = match (&preparation, &interruption) {
            (_, Some(_)) => "interrupted",
            (Ok(Some(_)), None) => "ready",
            (Ok(None), None) => "unsupported",
            (Err(_), None) => "failed",
        };
        let failure = interruption.as_ref().or_else(|| preparation.as_ref().err());
        info!(
            "Native SSH preparation session_id={session_id} outcome={outcome} elapsed_ms={} upload_ms={} readback_ms={} failure={failure:?}",
            started.elapsed().as_millis(),
            timings.upload.as_millis(),
            timings.readback.as_millis()
        );
        if let Some(message) = interruption {
            if let Ok(Some(native)) = preparation {
                native.close(&session);
            }
            return Err(ConnectionError::Other { message });
        }
        match preparation {
            Ok(None) if native_family => (None, Some("TERMINAL_NATIVE_PROFILE_UNSUPPORTED".into())),
            Ok(native) => (native, None),
            Err(error) => (None, Some(error)),
        }
    } else if native_family || request.native_input_protocol.is_some() {
        (None, Some("TERMINAL_NATIVE_CLIENT_UNSUPPORTED".into()))
    } else {
        (None, None)
    };
    if native_requested && !plain_retry && native_integration.is_none() {
        terminal_deadline::finish_native_probe_without_startup(
            native_failure
                .as_deref()
                .unwrap_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED"),
        );
    }
    #[cfg(all(
        feature = "native-input-acceptance",
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    if crate::terminal_command::acceptance_trace::ssh_recovery_enabled() {
        if let Some(
            reason @ ("TERMINAL_NATIVE_PROFILE_UNSUPPORTED"
            | "TERMINAL_NATIVE_SFTP_UNAVAILABLE"
            | "TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH"),
        ) = native_failure.as_deref()
        {
            let _ = crate::terminal_command::acceptance_trace::record(
                "ssh-native-admission-refused",
                serde_json::json!({"sessionId": session_id, "reason": reason}),
            );
        }
    }
    let native_selected = native_integration.is_some() || native_failure.is_some();
    let (mut remote_integration, remote_integration_error) =
        if bootstrap_remote_integration && !native_selected {
            match RemoteSshShellIntegration::prepare(&session, &request.username) {
                Ok(integration) => (Some(integration), None),
                Err(error) => (None, Some(error)),
            }
        } else {
            (None, None)
        };
    let mut vim_bridge = if native_integration.is_some() || remote_integration.is_some() {
        let timeout = session.timeout();
        session.set_timeout(if timeout == 0 {
            1500
        } else {
            timeout.min(1500)
        });
        let bridge = RemoteVimBridge::prepare(&session).ok();
        session.set_timeout(timeout);
        bridge
    } else {
        None
    };
    let vim_source = vim_bridge.as_ref().map(RemoteVimBridge::source_path);
    let vim_auto_attach = app
        .try_state::<Database>()
        .and_then(|db| db.vim_bridge_auto_attach().ok())
        .unwrap_or(false);
    let vim_bridge_config = vim_source
        .as_deref()
        .map(|source_path| VimBridgeShellConfig {
            source_path,
            auto_attach: vim_auto_attach,
        });

    let aborted = Cell::new(false);
    let result = with_remote_integration_cleanup(
        &session,
        &mut remote_integration,
        |remote_integration| {
            let mut channel = open_remote_pty_channel(&session, request, session_id)?;
            let result = with_failure_cleanup(
                &mut channel,
                |channel| {
                    let mut integration_failure =
                        remote_integration_error.as_deref().map(|message| {
                            if message == "TERMINAL_INTEGRATION_UNSUPPORTED_REMOTE_SHELL" {
                                (TerminalShellKind::Unsupported, "unsupportedRemoteShell")
                            } else {
                                (
                                    detect_remote_login_shell(&session, &request.username)
                                        .unwrap_or(TerminalShellKind::Unsupported),
                                    "remoteBootstrapFailed",
                                )
                            }
                        });

                    let runtime = app
                        .try_state::<crate::agent_runtime::AgentRuntime>()
                        .ok_or_else(|| ConnectionError::Other {
                            message: "terminal integration runtime is unavailable".into(),
                        })?;
                    let broker = runtime.terminal_broker();
                    let initial_input =
                        initial_directory_input(request.initial_directory.as_deref())
                            .map_err(|message| ConnectionError::Other { message })?;
                    let mut startup = None;
                    let mut initial_output = Vec::new();
                    let native_attempted = native_integration.is_some();
                    if native_attempted {
                        startup = start_ssh_native_or_fallback(
                            &session,
                            channel,
                            &mut native_integration,
                            broker,
                            request,
                            session_id,
                            &mut initial_output,
                            initial_input.as_deref(),
                            vim_bridge_config,
                        )?;
                        if startup.is_none() {
                            native_failure = Some("TERMINAL_NATIVE_SHELL_START_FAILED".into());
                        }
                    } else if let Some(integration) = remote_integration.as_ref() {
                        if let Err(message) = integration.start_shell(channel, vim_bridge_config) {
                            warn!(
                            "Integrated remote shell startup failed; using ordinary SSH shell session_id={session_id}"
                        );
                            let shell = integration.shell;
                            if let Some(integration) = remote_integration.take() {
                                integration.close(&session);
                            }
                            graceful_shutdown(channel);
                            *channel = open_remote_pty_channel(&session, request, session_id)?;
                            integration_failure = Some((shell, "remoteIntegratedShellStartFailed"));
                            channel.shell().map_err(|error| ConnectionError::Other {
                            message: format!(
                                "failed to start ordinary remote shell after integration fallback: {error}; integrated startup: {message}"
                            ),
                        })?;
                        }
                    } else {
                        channel.shell().map_err(|error| ConnectionError::Other {
                            message: format!("failed to start remote shell: {error}"),
                        })?;
                    }

                    session.set_blocking(false);
                    if !native_attempted {
                        if request.replaces_session_id.is_some() || plain_retry {
                            confirm_plain_ssh_startup(&session, channel, &mut initial_output)
                                .map_err(|message| ConnectionError::Other { message })?;
                        }
                        queue_initial_ssh_directory(&session, channel, initial_input.as_deref())
                            .map_err(|message| ConnectionError::Other { message })?;
                    }

                    let sessions = app.try_state::<SessionManager>().ok_or_else(|| {
                        ConnectionError::Other {
                            message: "SSH connection cancelled".into(),
                        }
                    })?;
                    let (ready_event, initial_messages) = attach_started_ssh_terminal(
                        broker, &sessions, request, session_id, startup,
                    )
                    .map_err(|message| ConnectionError::Other {
                        message: crate::commands::attachment_failure_message(&message, Vec::new()),
                    })?;

                    if let Some(native) = native_integration.as_mut() {
                        if let Some(messages) = initial_messages {
                            let _ = broker
                                .arm_display_recovery(session_id, native.display_recovery_token());
                            if messages.is_empty() {
                                crate::commands::emit_terminal_integration_state(app, session_id);
                            }
                            for message in messages {
                                if RemoteNativeBash::accept_message(app, session_id, message)
                                    .is_err()
                                {
                                    native.fail(app, session_id);
                                    break;
                                }
                            }
                        } else {
                            native.fail(app, session_id);
                        }
                    }
                    if let Some(integration) = remote_integration.as_ref() {
                        if runtime
                            .register_terminal_integration_channel(
                                session_id,
                                &integration.integration_id,
                                integration.shell,
                            )
                            .is_err()
                        {
                            integration_failure =
                                Some((integration.shell, "remoteControlRegistrationFailed"));
                            // The login shell is already compatible and running.
                            // Removing the FIFO makes its hooks disable themselves
                            // without sourcing startup files or MOTD a second time.
                            if let Some(integration) = remote_integration.take() {
                                integration.close(&session);
                            }
                        } else {
                            let _ = broker.arm_display_recovery(
                                session_id,
                                crate::terminal_integration::recovery_token(Path::new(
                                    &integration.remote_root,
                                )),
                            );
                            crate::commands::emit_terminal_integration_state(app, session_id);
                        }
                    }

                    if let Some((shell, reason)) = integration_failure {
                        if reason == "unsupportedRemoteShell" {
                            let _ = runtime
                                .mark_terminal_integration_unavailable(session_id, shell, reason);
                        } else {
                            let _ = runtime
                                .mark_terminal_integration_degraded(session_id, shell, reason);
                        }
                        crate::commands::emit_terminal_integration_state(app, session_id);
                    }
                    if let Some(reason) = native_failure.as_deref() {
                        let _ = runtime.mark_terminal_integration_unavailable(
                            session_id,
                            TerminalShellKind::Bash,
                            native_ssh_unavailable_reason(reason),
                        );
                        crate::commands::emit_terminal_integration_state(app, session_id);
                    } else if !bootstrap_remote_integration
                        && runtime
                            .terminal_shell_integration_enabled()
                            .unwrap_or(false)
                    {
                        let _ = runtime.mark_terminal_integration_unavailable(
                            session_id,
                            TerminalShellKind::Unsupported,
                            "remoteBoundTerminalDisabled",
                        );
                        crate::commands::emit_terminal_integration_state(app, session_id);
                    }
                    for bytes in initial_output.chunks(8192) {
                        ssh_recovery_read(session_id, bytes);
                        observe_terminal_raw_output(app, session_id, bytes);
                    }

                    if integration_failure.is_none() && native_failure.is_none() {
                        if let Some(bridge) = vim_bridge.as_ref() {
                            let _ = sessions.register_vim_bridge(session_id, bridge.client());
                        }
                    } else {
                        vim_bridge.take();
                    }
                    publish_ssh_connection_ready(
                        || {
                            app.emit(crate::SSH_STATUS_EVENT, ready_event)
                                .map_err(|error| error.to_string())
                        },
                        || activity.transition(ActivityPhase::Connected),
                        on_connected,
                    )
                    .map_err(|message| ConnectionError::Other { message })?;
                    info!("SSH session connected session_id={session_id}");

                    session.set_blocking(false);
                    session_loop(
                        app,
                        session_id,
                        &session,
                        channel,
                        rx,
                        wake,
                        &output_ready,
                        &output_paused,
                        remote_integration.as_mut(),
                        native_integration.as_mut(),
                        &mut vim_bridge,
                        initial_output,
                        &aborted,
                    )
                    .map_err(|message| ConnectionError::Other { message })
                },
                |channel| {
                    if !aborted.get() {
                        graceful_shutdown(channel);
                    }
                },
            );
            if aborted.get() {
                // On cancellation with a packet in flight, the socket is
                // already shut down. Do not start SFTP or a second SSH write.
                drop(remote_integration.take());
            }
            result
        },
    );
    if !aborted.get() {
        if let Some(native) = native_integration.take() {
            native.close(&session);
        }
    }
    result
}

fn publish_ssh_connection_ready(
    publish_status: impl FnOnce() -> Result<(), String>,
    notify_connected: impl FnOnce(),
    signal_waiter: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    publish_status()?;
    notify_connected();
    signal_waiter()
}

fn with_remote_integration_cleanup<T>(
    session: &Session,
    remote_integration: &mut Option<RemoteSshShellIntegration>,
    operation: impl FnOnce(&mut Option<RemoteSshShellIntegration>) -> Result<T, ConnectionError>,
) -> Result<T, ConnectionError> {
    let result = operation(remote_integration);
    if let Some(integration) = remote_integration.take() {
        integration.close(session);
    }
    result
}

fn with_failure_cleanup<R, T, E>(
    resource: &mut R,
    operation: impl FnOnce(&mut R) -> Result<T, E>,
    cleanup: impl FnOnce(&mut R),
) -> Result<T, E> {
    let result = operation(resource);
    if result.is_err() {
        cleanup(resource);
    }
    result
}

fn coalesce_session_commands(commands: Vec<SessionCommand>) -> Vec<SessionCommand> {
    let mut merged = Vec::with_capacity(commands.len());
    let mut pending_write = String::new();
    let mut pending_resize: Option<(u32, u32)> = None;

    for command in commands {
        match command {
            SessionCommand::Write(data) => {
                if let Some((cols, rows)) = pending_resize.take() {
                    merged.push(SessionCommand::Resize { cols, rows });
                }
                pending_write.push_str(&data);
            }
            SessionCommand::WriteBytes(bytes) => {
                if let Some((cols, rows)) = pending_resize.take() {
                    merged.push(SessionCommand::Resize { cols, rows });
                }
                if !pending_write.is_empty() {
                    merged.push(SessionCommand::Write(std::mem::take(&mut pending_write)));
                }
                merged.push(SessionCommand::WriteBytes(bytes));
            }
            SessionCommand::NativeControl(frame) => {
                if let Some((cols, rows)) = pending_resize.take() {
                    merged.push(SessionCommand::Resize { cols, rows });
                }
                if !pending_write.is_empty() {
                    merged.push(SessionCommand::Write(std::mem::take(&mut pending_write)));
                }
                merged.push(SessionCommand::NativeControl(frame));
            }
            SessionCommand::Resize { cols, rows } => {
                if !pending_write.is_empty() {
                    merged.push(SessionCommand::Write(std::mem::take(&mut pending_write)));
                }
                // Only the latest size matters: adjacent resizes collapse into
                // the most recent one instead of replaying every step.
                pending_resize = Some((cols, rows));
            }
            #[cfg(any(windows, test))]
            SessionCommand::StartupReady => {
                if let Some((cols, rows)) = pending_resize.take() {
                    merged.push(SessionCommand::Resize { cols, rows });
                }
                if !pending_write.is_empty() {
                    merged.push(SessionCommand::Write(std::mem::take(&mut pending_write)));
                }
                merged.push(SessionCommand::StartupReady);
            }
            SessionCommand::Close => {
                if let Some((cols, rows)) = pending_resize.take() {
                    merged.push(SessionCommand::Resize { cols, rows });
                }
                if !pending_write.is_empty() {
                    merged.push(SessionCommand::Write(std::mem::take(&mut pending_write)));
                }
                merged.push(SessionCommand::Close);
            }
        }
    }

    if let Some((cols, rows)) = pending_resize.take() {
        merged.push(SessionCommand::Resize { cols, rows });
    }
    if !pending_write.is_empty() {
        merged.push(SessionCommand::Write(pending_write));
    }

    merged
}

fn drain_remote_integration_control(
    app: &AppHandle,
    session_id: &str,
    session: &Session,
    integration: &mut RemoteSshShellIntegration,
) -> Result<bool, String> {
    let mut made_progress = false;
    let mut buffer = [0_u8; 8192];
    loop {
        match integration.control.read(&mut buffer) {
            Ok(0) if integration.control.eof() => {
                if integration.accept_events {
                    if let Err(error) = integration.decoder.finish() {
                        log::warn!(
                            "Remote integration control ended mid-record session_id={session_id}: {error}"
                        );
                    }
                }
                if let Some(runtime) = app.try_state::<crate::agent_runtime::AgentRuntime>() {
                    let _ = runtime.terminal_integration_channel_closed(
                        session_id,
                        &integration.integration_id,
                        "remoteControlChannelClosed",
                    );
                    crate::commands::emit_terminal_integration_state(app, session_id);
                }
                integration.disable_after_control_failure(session);
                return Ok(true);
            }
            Ok(0) => return Ok(made_progress),
            Ok(read) => {
                made_progress = true;
                if !integration.accept_events {
                    continue;
                }
                let events = match integration.decoder.push(&buffer[..read]) {
                    Ok(events) => events,
                    Err(error) => {
                        integration.accept_events = false;
                        if let Some(runtime) = app.try_state::<crate::agent_runtime::AgentRuntime>()
                        {
                            let _ = runtime.terminal_integration_channel_closed(
                                session_id,
                                &integration.integration_id,
                                "remoteControlProtocolViolation",
                            );
                            crate::commands::emit_terminal_integration_state(app, session_id);
                        }
                        log::warn!(
                            "Remote integration control rejected session_id={session_id}: {error}"
                        );
                        integration.disable_after_control_failure(session);
                        return Ok(true);
                    }
                };
                for event in events {
                    let runtime = app
                        .try_state::<crate::agent_runtime::AgentRuntime>()
                        .ok_or_else(|| "terminal integration runtime is unavailable".to_string())?;
                    if let Err(error) = runtime.accept_terminal_integration_event(
                        session_id,
                        &integration.integration_id,
                        event,
                    ) {
                        integration.accept_events = false;
                        let _ = runtime.terminal_integration_channel_closed(
                            session_id,
                            &integration.integration_id,
                            "remoteControlProtocolViolation",
                        );
                        crate::commands::emit_terminal_integration_state(app, session_id);
                        log::warn!(
                            "Remote integration event rejected session_id={session_id}: {error}"
                        );
                        integration.disable_after_control_failure(session);
                        return Ok(true);
                    }
                    crate::commands::emit_terminal_integration_state(app, session_id);
                }
            }
            Err(error) if is_retryable_channel_error_kind(error.kind()) => {
                return Ok(made_progress)
            }
            Err(error) => {
                if let Some(runtime) = app.try_state::<crate::agent_runtime::AgentRuntime>() {
                    let _ = runtime.terminal_integration_channel_closed(
                        session_id,
                        &integration.integration_id,
                        "remoteControlChannelFailed",
                    );
                    crate::commands::emit_terminal_integration_state(app, session_id);
                }
                log::warn!("Remote integration control failed session_id={session_id}: {error}");
                integration.disable_after_control_failure(session);
                return Ok(true);
            }
        }
    }
}

fn session_loop(
    app: &AppHandle,
    session_id: &str,
    session: &Session,
    channel: &mut Channel,
    rx: &Receiver<SessionCommand>,
    wake: &SessionWakeSource,
    output_ready: &AtomicBool,
    output_paused: &AtomicBool,
    remote_integration: Option<&mut RemoteSshShellIntegration>,
    native_integration: Option<&mut RemoteNativeBash>,
    vim_bridge: &mut Option<RemoteVimBridge>,
    initial_pty_output: Vec<u8>,
    aborted: &Cell<bool>,
) -> Result<Option<String>, String> {
    let mut pending_bytes = initial_pty_output;
    let mut pending_output = String::new();
    drain_decoded_output(&mut pending_bytes, &mut pending_output);
    let output_wait_started = Instant::now();
    let mut output_live = false;
    let result = session_loop_inner(
        app,
        session_id,
        session,
        channel,
        rx,
        wake,
        output_ready,
        output_paused,
        &mut pending_bytes,
        &mut pending_output,
        output_wait_started,
        &mut output_live,
        remote_integration,
        native_integration,
        vim_bridge,
        aborted,
    );
    // Emit whatever decoded output remains so the final screen state is not
    // lost when the session ends.
    #[cfg(all(
        feature = "native-input-acceptance",
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    if crate::terminal_command::acceptance_trace::ssh_recovery_enabled() {
        let _ = crate::terminal_command::acceptance_trace::record(
            "ssh-decoder-drain",
            serde_json::json!({"sessionId":session_id,"incompleteHex":hex::encode(&pending_bytes),
                "decodedBeforeFlush":pending_output,"endedWithError":result.is_err()}),
        );
    }
    flush_pending_output(app, session_id, &mut pending_bytes, &mut pending_output);
    result
}

/// Emits a decoded output chunk to the frontend. A failed emit (e.g. the
/// window is gone) must not tear down an otherwise healthy SSH session, so
/// the error is logged and the chunk is dropped.
fn emit_data_tolerant(app: &AppHandle, session_id: &str, chunk: String) {
    if let Err(error) = emit_data(app, session_id, chunk) {
        warn!("Failed to emit SSH output session_id={session_id}: {error}");
    }
}

enum SshPayload {
    Pty(Vec<u8>),
    Native(NativeControlFrame),
    TtyReply { bytes: Vec<u8>, native: bool },
    Vim(EditorWrite),
}

enum SshWrite {
    Data { payload: SshPayload, offset: usize },
    Resize { cols: u32, rows: u32 },
}

impl SshWrite {
    fn pty(bytes: Vec<u8>) -> Self {
        Self::Data {
            payload: SshPayload::Pty(bytes),
            offset: 0,
        }
    }

    fn advance(
        &mut self,
        pty: &mut Channel,
        native: Option<&mut Channel>,
        legacy: Option<&mut Channel>,
        vim: Option<&mut Channel>,
    ) -> std::io::Result<bool> {
        match self {
            Self::Resize { cols, rows } => pty
                .request_pty_size(*cols, *rows, None, None)
                .map(|()| true)
                .map_err(std::io::Error::from),
            Self::Data { payload, offset } => {
                let target = match payload {
                    SshPayload::Pty(_) => Some(pty),
                    SshPayload::Native(_) | SshPayload::TtyReply { native: true, .. } => native,
                    SshPayload::TtyReply { native: false, .. } => legacy,
                    SshPayload::Vim(frame) => {
                        if vim.is_none() || !frame.begin() {
                            return Ok(true);
                        }
                        vim
                    }
                };
                let Some(target) = target else {
                    return Ok(true);
                };
                let count = target.write(&payload.bytes()[*offset..])?;
                if count == 0 {
                    return Err(ErrorKind::WriteZero.into());
                }
                *offset += count;
                Ok(*offset == payload.bytes().len())
            }
        }
    }

    fn failure_context(&self) -> &'static str {
        match self {
            Self::Resize { .. } => "failed to resize PTY",
            Self::Data {
                payload: SshPayload::Pty(_),
                ..
            } => "failed to write remote input",
            _ => "failed to write SSH private control frame",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SshRetry {
    Write,
    NativeRead,
    LegacyRead,
    VimRead,
    PtyRead,
}

impl SshPayload {
    fn bytes(&self) -> &[u8] {
        match self {
            Self::Pty(bytes) | Self::TtyReply { bytes, .. } => bytes,
            Self::Native(frame) => &frame.bytes,
            Self::Vim(frame) => &frame.bytes,
        }
    }

    #[cfg(all(
        feature = "native-input-acceptance",
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    fn is_traced_accept_key(&self) -> bool {
        matches!(self, Self::Pty(bytes) if
            bytes == crate::terminal_command::editors::ZLE_ACCEPT_KEY
            || bytes == crate::terminal_command::editors::BASH_ACCEPT_KEY)
            && crate::terminal_command::acceptance_trace::ssh_recovery_enabled()
    }
}

fn advance_ssh_write_queue(
    writes: &mut VecDeque<SshWrite>,
    pty: &mut Channel,
    native: Option<&mut Channel>,
    legacy: Option<&mut Channel>,
    vim: Option<&mut Channel>,
) -> std::io::Result<Option<SshWrite>> {
    let Some(write) = writes.front_mut() else {
        return Ok(None);
    };
    if !write.advance(pty, native, legacy, vim)? {
        return Ok(None);
    }
    let completed = writes.pop_front();
    if matches!(
        &completed,
        Some(SshWrite::Data { payload: SshPayload::Native(frame), offset })
            if frame.wake_editor && *offset == frame.bytes.len()
    ) {
        writes.push_front(SshWrite::pty(b"\x18\x1e".to_vec()));
    }
    Ok(completed)
}

fn ssh_wants_write(session: &Session) -> bool {
    matches!(
        session.block_directions(),
        BlockDirections::Outbound | BlockDirections::Both
    )
}

fn abort_ssh_transport(session: &Session, aborted: &Cell<bool>) {
    aborted.set(true);
    #[cfg(unix)]
    unsafe {
        libc::shutdown(session.as_raw_fd(), libc::SHUT_RDWR);
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Networking::WinSock::{shutdown, SD_BOTH};
        shutdown(session.as_raw_socket() as _, SD_BOTH);
    }
    #[cfg(not(any(unix, windows)))]
    let _ = session;
}

fn session_loop_inner(
    app: &AppHandle,
    session_id: &str,
    session: &Session,
    channel: &mut Channel,
    rx: &Receiver<SessionCommand>,
    wake: &SessionWakeSource,
    output_ready: &AtomicBool,
    output_paused: &AtomicBool,
    pending_bytes: &mut Vec<u8>,
    pending_output: &mut String,
    output_wait_started: Instant,
    output_live: &mut bool,
    mut remote_integration: Option<&mut RemoteSshShellIntegration>,
    mut native_integration: Option<&mut RemoteNativeBash>,
    vim_bridge: &mut Option<RemoteVimBridge>,
    aborted: &Cell<bool>,
) -> Result<Option<String>, String> {
    let mut buffer = [0u8; 8192];
    let mut tty_recovery = native_integration
        .as_deref()
        .filter(|native| native.active && native.profile.shell() == TerminalShellKind::Zsh)
        .map(|native| (native.tty_recovery_root(), true))
        .or_else(|| {
            remote_integration
                .as_deref()
                .filter(|integration| {
                    integration.active && integration.shell == TerminalShellKind::Zsh
                })
                .map(|integration| (Path::new(&integration.remote_root), false))
        })
        .map(|(root, native)| {
            (
                crate::terminal_display_recovery::TtyRecoveryWatcher::new(root),
                native,
            )
        });
    let mut writes = VecDeque::new();
    let mut retry = None;
    let mut next_keepalive_at =
        Instant::now() + normalize_keepalive_delay(SSH_SESSION_KEEPALIVE_INTERVAL_SECS);

    loop {
        let mut made_progress = false;
        let mut pending_commands = Vec::new();

        if !*output_live
            && should_release_startup_output(
                output_ready.load(AtomicOrdering::Relaxed),
                output_wait_started.elapsed(),
                pending_output.len(),
            )
        {
            *output_live = true;
            if !pending_output.is_empty() {
                emit_data_tolerant(app, session_id, std::mem::take(pending_output));
            }
        }

        loop {
            match rx.try_recv() {
                Ok(command) => pending_commands.push(command),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    info!("SSH session controller dropped session_id={session_id}");
                    if retry.is_some() {
                        abort_ssh_transport(session, aborted);
                    } else {
                        graceful_shutdown(channel);
                    }
                    return Ok(Some("session controller dropped".to_string()));
                }
            }
        }

        for command in coalesce_session_commands(pending_commands) {
            match command {
                SessionCommand::Write(data) => {
                    if !data.is_empty() {
                        writes.push_back(SshWrite::pty(data.into_bytes()));
                    }
                }
                SessionCommand::WriteBytes(bytes) => {
                    if !bytes.is_empty() {
                        writes.push_back(SshWrite::pty(bytes));
                    }
                }
                SessionCommand::NativeControl(frame) => {
                    if native_integration
                        .as_deref()
                        .is_some_and(|native| native.active)
                        && !frame.bytes.is_empty()
                        && frame.bytes.len() <= native_protocol::MAX_MESSAGE_BYTES
                    {
                        writes.push_back(SshWrite::Data {
                            payload: SshPayload::Native(frame),
                            offset: 0,
                        });
                    }
                }
                SessionCommand::Resize { cols, rows } => {
                    writes.push_back(SshWrite::Resize { cols, rows });
                }
                #[cfg(any(windows, test))]
                SessionCommand::StartupReady => {
                    return Err("local startup notification is invalid for SSH".into());
                }
                SessionCommand::Close => {
                    info!("SSH session closed locally session_id={session_id}");
                    if retry.is_some() {
                        abort_ssh_transport(session, aborted);
                    } else {
                        graceful_shutdown(channel);
                    }
                    return Ok(Some("session closed locally".to_string()));
                }
            }
        }

        if let Some(frame) = vim_bridge.as_mut().and_then(RemoteVimBridge::next_write) {
            writes.push_back(SshWrite::Data {
                payload: SshPayload::Vim(frame),
                offset: 0,
            });
        }

        // libssh2 can retain an encrypted packet for the entire session after
        // EAGAIN. Retry its originating operation before making another one
        // that could send on the socket, even on a different SSH channel.
        if !writes.is_empty() && matches!(retry, None | Some(SshRetry::Write)) {
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            if retry.is_none() {
                if let Some(SshWrite::Data { payload, offset: 0 }) = writes.front() {
                    if payload.is_traced_accept_key() {
                        crate::terminal_command::acceptance_trace::record(
                            "ssh-accept-key-write-attempt",
                            serde_json::json!({"sessionId":session_id,"bytes":payload.bytes().len()}),
                        )?;
                    }
                }
            }
            let result = advance_ssh_write_queue(
                &mut writes,
                channel,
                native_integration
                    .as_deref_mut()
                    .filter(|native| native.active)
                    .and_then(RemoteNativeBash::control_mut),
                remote_integration
                    .as_deref_mut()
                    .filter(|integration| integration.active)
                    .map(|integration| &mut integration.control),
                vim_bridge.as_mut().map(|bridge| &mut bridge.channel),
            );
            match result {
                Ok(_completed) => {
                    retry = None;
                    made_progress = true;
                    #[cfg(all(
                        feature = "native-input-acceptance",
                        debug_assertions,
                        target_os = "macos",
                        target_arch = "aarch64"
                    ))]
                    if let Some(SshWrite::Data { payload, offset }) = _completed {
                        if payload.is_traced_accept_key() {
                            crate::terminal_command::acceptance_trace::actual_accept_key_written(
                                session_id,
                                payload.bytes(),
                                offset,
                            )?;
                        }
                    }
                }
                Err(error)
                    if is_retryable_channel_error_kind(error.kind())
                        && ssh_wants_write(session) =>
                {
                    retry = Some(SshRetry::Write);
                    if let Err(error) = wait_for_session_events(
                        session,
                        wake,
                        Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS),
                    ) {
                        abort_ssh_transport(session, aborted);
                        return Err(error);
                    }
                    continue;
                }
                Err(error) if is_retryable_channel_error_kind(error.kind()) => {
                    // A channel waiting for a window update or request reply
                    // has no outbound packet pinned. Keep draining incoming data.
                    retry = None;
                }
                Err(error) => {
                    let control_eof = match writes.front() {
                        Some(SshWrite::Data {
                            payload:
                                SshPayload::Native(_) | SshPayload::TtyReply { native: true, .. },
                            ..
                        }) => native_integration
                            .as_deref()
                            .is_some_and(RemoteNativeBash::control_eof),
                        Some(SshWrite::Data {
                            payload: SshPayload::TtyReply { native: false, .. },
                            ..
                        }) => remote_integration
                            .as_deref()
                            .is_some_and(|integration| integration.control.eof()),
                        Some(SshWrite::Data {
                            payload: SshPayload::Vim(_),
                            ..
                        }) => vim_bridge
                            .as_ref()
                            .is_some_and(|bridge| bridge.channel.eof()),
                        _ => false,
                    };
                    if control_eof && !ssh_wants_write(session) {
                        // Let the control reader report and retire its EOF.
                        // A closing private channel need not end the PTY.
                        writes.pop_front();
                        retry = None;
                        made_progress = true;
                    } else {
                        let context = writes
                            .front()
                            .map_or("failed to send SSH data", SshWrite::failure_context);
                        // A failed write can leave a partial packet or control
                        // record in flight. Close the transport before dropping it.
                        abort_ssh_transport(session, aborted);
                        return Err(format_transport_error(context, &error.to_string()));
                    }
                }
            }
        }

        if matches!(retry, None | Some(SshRetry::NativeRead)) {
            retry = None;
            if let Some(native) = native_integration
                .as_deref_mut()
                .filter(|native| native.active)
            {
                match native.drain(app, session_id) {
                    Ok(progress) => made_progress |= progress,
                    Err(_) => native.fail(app, session_id),
                }
                if native.active && ssh_wants_write(session) {
                    retry = Some(SshRetry::NativeRead);
                }
            }
        }
        if matches!(retry, None | Some(SshRetry::LegacyRead)) {
            retry = None;
            if let Some(integration) = remote_integration
                .as_deref_mut()
                .filter(|integration| integration.active)
            {
                made_progress |=
                    drain_remote_integration_control(app, session_id, session, integration)?;
                if integration.active && ssh_wants_write(session) {
                    retry = Some(SshRetry::LegacyRead);
                }
            }
        }

        if matches!(retry, None | Some(SshRetry::VimRead)) {
            retry = None;
            if let Some(bridge) = vim_bridge.as_mut() {
                let result = bridge.drain();
                if result != Ok(false) {
                    if let Some(runtime) = app.try_state::<crate::agent_runtime::AgentRuntime>() {
                        if runtime.terminal_broker().set_vim_attached(
                            session_id,
                            if result.is_ok() {
                                bridge.attached_editor()
                            } else {
                                None
                            },
                        ) == Ok(true)
                        {
                            crate::commands::emit_terminal_integration_state(app, session_id);
                        }
                    }
                }
                match result {
                    Ok(progress) => {
                        made_progress |= progress;
                        if ssh_wants_write(session) {
                            retry = Some(SshRetry::VimRead);
                        }
                    }
                    Err(()) if ssh_wants_write(session) => {
                        abort_ssh_transport(session, aborted);
                        return Err("SSH editor relay closed with a packet in flight".into());
                    }
                    Err(()) => {
                        vim_bridge.take();
                    }
                }
            }
        }

        if retry == Some(SshRetry::PtyRead)
            || (retry.is_none() && !output_paused.load(AtomicOrdering::Relaxed))
        {
            retry = None;
            match channel.read(&mut buffer) {
                Ok(0) => {
                    if channel.eof() {
                        info!("Remote shell exited session_id={session_id}");
                        return Ok(Some("remote shell exited".to_string()));
                    }
                }
                Ok(read) => {
                    if let Some((recovery, native)) = tty_recovery.as_mut() {
                        if let Some(reply) = recovery.observe_ssh(&buffer[..read]) {
                            writes.push_back(SshWrite::Data {
                                payload: SshPayload::TtyReply {
                                    bytes: reply,
                                    native: *native,
                                },
                                offset: 0,
                            });
                        }
                    }
                    ssh_recovery_read(session_id, &buffer[..read]);
                    observe_terminal_raw_output(app, session_id, &buffer[..read]);
                    pending_bytes.extend_from_slice(&buffer[..read]);
                    drain_decoded_output(pending_bytes, pending_output);
                    if *output_live && pending_output.len() >= SSH_OUTPUT_FLUSH_THRESHOLD_BYTES {
                        emit_data_tolerant(app, session_id, std::mem::take(pending_output));
                    }
                    made_progress = true;
                }
                Err(error) if is_retryable_channel_error_kind(error.kind()) => {
                    if *output_live && !pending_output.is_empty() {
                        emit_data_tolerant(app, session_id, std::mem::take(pending_output));
                    }
                }
                Err(error) => {
                    warn!(
                        "SSH read failed session_id={} kind={:?} block_directions={:?} error={}",
                        session_id,
                        error.kind(),
                        session.block_directions(),
                        error
                    );
                    return Err(format_transport_error(
                        "failed to read remote output",
                        &error.to_string(),
                    ));
                }
            }
            if ssh_wants_write(session) {
                retry = Some(SshRetry::PtyRead);
            }
        }

        if made_progress {
            next_keepalive_at =
                Instant::now() + normalize_keepalive_delay(SSH_SESSION_KEEPALIVE_INTERVAL_SECS);
            continue;
        }

        if retry.is_some() {
            if let Err(error) = wait_for_session_events(
                session,
                wake,
                Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS),
            ) {
                abort_ssh_transport(session, aborted);
                return Err(error);
            }
            continue;
        }

        let now = Instant::now();
        if now >= next_keepalive_at {
            let writable = session_poll_events(BlockDirections::Outbound);
            if poll_session_events(session, wake, writable, Duration::ZERO)? & writable == 0 {
                next_keepalive_at = now + Duration::from_secs(1);
                continue;
            }
            let result = session.keepalive_send();
            // libssh2's keepalive API hides EAGAIN and does not retain a safe
            // retry buffer. Abort rather than queue writes behind that packet.
            if ssh_wants_write(session) {
                abort_ssh_transport(session, aborted);
                return Err("ssh transport disconnected while sending keepalive".into());
            }
            let seconds = result.map_err(|error| {
                format_transport_error("failed to send ssh keepalive", &error.to_string())
            })?;
            let keepalive_delay = normalize_keepalive_delay(seconds);
            next_keepalive_at = Instant::now() + keepalive_delay;
            continue;
        }

        let mut wait_timeout = next_keepalive_at.saturating_duration_since(now);
        if !*output_live {
            wait_timeout = wait_timeout
                .min(SSH_OUTPUT_READY_TIMEOUT.saturating_sub(output_wait_started.elapsed()));
        }
        if output_paused.load(AtomicOrdering::Relaxed) {
            poll_wake_only(
                wake,
                wait_timeout.min(Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS)),
            );
            continue;
        }

        // Wake for the socket, queued commands, or the next retry deadline.
        if vim_bridge.as_ref().is_some_and(|bridge| {
            bridge.channel.read_window().available > 0 || bridge.channel.eof()
        }) {
            continue;
        }
        wait_for_terminal_session_events(
            session,
            channel,
            native_integration
                .as_deref()
                .filter(|native| native.active)
                .and_then(RemoteNativeBash::control)
                .or_else(|| {
                    remote_integration
                        .as_ref()
                        .filter(|integration| integration.active)
                        .map(|integration| &integration.control)
                }),
            wake,
            !writes.is_empty(),
            wait_timeout,
        )?;
    }
}

fn ssh_recovery_read(_session_id: &str, _bytes: &[u8]) {
    #[cfg(all(
        feature = "native-input-acceptance",
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    if crate::terminal_command::acceptance_trace::ssh_recovery_enabled() {
        let _ = crate::terminal_command::acceptance_trace::record(
            "ssh-pty-read",
            serde_json::json!({"sessionId":_session_id,"hex":hex::encode(_bytes)}),
        );
    }
}

fn normalize_keepalive_delay(seconds: u32) -> Duration {
    Duration::from_secs(u64::from(seconds.max(1)))
}

fn should_release_startup_output(
    output_ready: bool,
    elapsed: Duration,
    buffered_bytes: usize,
) -> bool {
    output_ready
        || elapsed > SSH_OUTPUT_READY_TIMEOUT
        || buffered_bytes > SSH_STARTUP_OUTPUT_BUFFER_LIMIT_BYTES
}

pub(crate) fn is_retryable_channel_error_kind(kind: ErrorKind) -> bool {
    kind == ErrorKind::WouldBlock || kind == ErrorKind::Interrupted
}

pub(crate) fn classify_closed_reason(
    reason: Option<&str>,
    status: SessionStatus,
) -> (ClosedReasonKind, bool) {
    match status {
        SessionStatus::Disconnected => match reason.unwrap_or_default() {
            "session closed locally" => (ClosedReasonKind::LocalClose, false),
            "session controller dropped" => (ClosedReasonKind::ControllerDropped, false),
            _ => (ClosedReasonKind::RemoteExit, false),
        },
        SessionStatus::Error => {
            let retryable = reason.map(is_transport_disconnect_message).unwrap_or(false);

            if retryable {
                (ClosedReasonKind::TransportDisconnect, true)
            } else {
                (ClosedReasonKind::Error, false)
            }
        }
        SessionStatus::Connecting | SessionStatus::Connected => (ClosedReasonKind::Error, false),
    }
}

pub(crate) fn is_transport_disconnect_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("ssh transport disconnected")
        || message.contains("transport read")
        || message.contains("connection reset")
        || message.contains("connection aborted")
        || message.contains("broken pipe")
        || message.contains("draining incoming flow")
}

fn format_transport_error(context: &str, raw_error: &str) -> String {
    let error_lower = raw_error.to_ascii_lowercase();
    if error_lower.contains("transport read")
        || error_lower.contains("connection reset")
        || error_lower.contains("connection aborted")
        || error_lower.contains("broken pipe")
        || error_lower.contains("draining incoming flow")
    {
        format!(
            "{context}: ssh transport disconnected (possible network jitter, idle timeout, or remote-side close): {raw_error}"
        )
    } else {
        format!("{context}: {raw_error}")
    }
}

const SSH_NONBLOCKING_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

fn write_all_nonblocking(
    session: &Session,
    channel: &mut Channel,
    bytes: &[u8],
) -> Result<(), String> {
    write_all_nonblocking_with_deadline(
        session,
        channel,
        bytes,
        Instant::now() + SSH_NONBLOCKING_WRITE_TIMEOUT,
    )
}

fn write_all_nonblocking_with_deadline(
    session: &Session,
    channel: &mut Channel,
    bytes: &[u8],
    deadline: Instant,
) -> Result<(), String> {
    let mut offset = 0usize;
    let wait_timeout = Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS);

    while offset < bytes.len() {
        if let Some(reason) = crate::connection::terminal_deadline::failure_reason() {
            return Err(reason);
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("remote channel write timed out".to_string());
        }
        match channel.write(&bytes[offset..]) {
            Ok(0) => return Err("remote channel accepted zero bytes".to_string()),
            Ok(written) => offset += written,
            Err(error) if is_retryable_channel_error_kind(error.kind()) => {
                if error.kind() == ErrorKind::Interrupted {
                    continue;
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err("remote channel write timed out".to_string());
                }
                let slice = wait_timeout.min(remaining);
                let poll_started = Instant::now();
                wait_for_session_socket(session, slice)?;
                // Avoid a 100% CPU spin when the socket is readable for another
                // channel while this channel's send window is full.
                if poll_started.elapsed() < Duration::from_millis(2) {
                    let backoff = Duration::from_millis(5)
                        .min(deadline.saturating_duration_since(Instant::now()));
                    if !backoff.is_zero() {
                        thread::sleep(backoff);
                    }
                }
            }
            Err(error) => {
                warn!(
                    "SSH write failed kind={:?} block_directions={:?} offset={} total={} error={}",
                    error.kind(),
                    session.block_directions(),
                    offset,
                    bytes.len(),
                    error
                );
                return Err(format_transport_error(
                    "failed to write remote input",
                    &error.to_string(),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn session_poll_events(directions: BlockDirections) -> i16 {
    match directions {
        BlockDirections::None => 0,
        BlockDirections::Inbound => POLLIN,
        BlockDirections::Outbound => POLLOUT,
        BlockDirections::Both => POLLIN | POLLOUT,
    }
}

#[cfg(windows)]
fn session_poll_events(directions: BlockDirections) -> i16 {
    use windows_sys::Win32::Networking::WinSock::{POLLIN, POLLOUT};
    match directions {
        BlockDirections::None => 0,
        BlockDirections::Inbound => POLLIN,
        BlockDirections::Outbound => POLLOUT,
        BlockDirections::Both => POLLIN | POLLOUT,
    }
}

fn wait_for_terminal_session_events(
    session: &Session,
    terminal: &Channel,
    control: Option<&Channel>,
    wake: &SessionWakeSource,
    writes_pending: bool,
    timeout: Duration,
) -> Result<(), String> {
    // Reading or writing either channel can consume socket packets for the
    // other one. Those bytes (or EOF) are already in libssh2, so socket poll
    // cannot wake us for them. Drain them before waiting for new network I/O.
    if terminal.read_window().available > 0
        || terminal.eof()
        || control.is_some_and(|channel| channel.read_window().available > 0 || channel.eof())
    {
        return Ok(());
    }
    // A read can consume a window adjustment without yielding any output.
    // Retry queued writes promptly even if the socket has gone quiet again.
    let timeout = if writes_pending {
        timeout.min(Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS))
    } else {
        timeout
    };
    wait_for_session_events(session, wake, timeout)
}

/// Waits until the SSH socket is ready, the self-pipe signals a pending
/// command, or `timeout` elapses. Falls back to polling inbound readiness
/// when the last blocked direction is unknown, so incoming data can never
/// stall until the keepalive deadline.
fn wait_for_session_events(
    session: &Session,
    wake: &SessionWakeSource,
    timeout: Duration,
) -> Result<(), String> {
    let events = match session_poll_events(session.block_directions()) {
        0 => session_poll_events(BlockDirections::Inbound),
        events => events,
    };
    poll_session_events(session, wake, events, timeout).map(|_| ())
}

#[cfg(unix)]
fn poll_session_events(
    session: &Session,
    wake: &SessionWakeSource,
    events: i16,
    timeout: Duration,
) -> Result<i16, String> {
    let timeout_ms = timeout.as_millis().min(i32::MAX as u128);
    let timeout_ms = i32::try_from(timeout_ms).unwrap_or(i32::MAX);
    let mut fds = [
        pollfd {
            fd: session.as_raw_fd(),
            events,
            revents: 0,
        },
        pollfd {
            fd: wake.fd(),
            events: POLLIN,
            revents: 0,
        },
    ];

    loop {
        let result = unsafe { poll(fds.as_mut_ptr(), 2, timeout_ms) };
        if result >= 0 {
            if fds[1].revents != 0 {
                wake.drain();
            }
            return Ok(fds[0].revents);
        }

        let error = std::io::Error::last_os_error();
        if error.kind() == ErrorKind::Interrupted {
            continue;
        }

        return Err(format!("failed to wait for ssh socket readiness: {error}"));
    }
}

#[cfg(unix)]
fn poll_wake_only(wake: &SessionWakeSource, timeout: Duration) {
    use libc::{poll, pollfd, POLLIN};

    let timeout_ms = timeout.as_millis().min(i32::MAX as u128);
    let timeout_ms = i32::try_from(timeout_ms).unwrap_or(i32::MAX);
    let mut fd = pollfd {
        fd: wake.fd(),
        events: POLLIN,
        revents: 0,
    };
    let result = unsafe { poll(&mut fd, 1, timeout_ms) };
    if result > 0 && fd.revents != 0 {
        wake.drain();
    }
}

#[cfg(windows)]
fn poll_wake_only(wake: &SessionWakeSource, timeout: Duration) {
    use windows_sys::Win32::Networking::WinSock::{WSAPoll, POLLIN, WSAPOLLFD};

    let timeout_ms = timeout.as_millis().min(i32::MAX as u128);
    let timeout_ms = i32::try_from(timeout_ms).unwrap_or(i32::MAX);
    let mut fd = WSAPOLLFD {
        fd: wake.socket() as _,
        events: POLLIN,
        revents: 0,
    };
    let result = unsafe { WSAPoll(&mut fd, 1, timeout_ms) };
    if result > 0 && fd.revents != 0 {
        wake.drain();
    }
}

#[cfg(windows)]
fn poll_session_events(
    session: &Session,
    wake: &SessionWakeSource,
    events: i16,
    timeout: Duration,
) -> Result<i16, String> {
    use windows_sys::Win32::Networking::WinSock::{
        WSAGetLastError, WSAPoll, POLLIN, WSAEINTR, WSAPOLLFD,
    };

    let timeout_ms = timeout.as_millis().min(i32::MAX as u128);
    let timeout_ms = i32::try_from(timeout_ms).unwrap_or(i32::MAX);
    let mut fds = [
        WSAPOLLFD {
            fd: session.as_raw_socket() as _,
            events,
            revents: 0,
        },
        WSAPOLLFD {
            fd: wake.socket() as _,
            events: POLLIN,
            revents: 0,
        },
    ];

    loop {
        let result = unsafe { WSAPoll(fds.as_mut_ptr(), 2, timeout_ms) };
        if result >= 0 {
            if fds[1].revents != 0 {
                wake.drain();
            }
            return Ok(fds[0].revents);
        }

        // Winsock reports errors through WSAGetLastError, not GetLastError.
        let code = unsafe { WSAGetLastError() };
        if code == WSAEINTR {
            continue;
        }

        let error = std::io::Error::from_raw_os_error(code);
        return Err(format!("failed to wait for ssh socket readiness: {error}"));
    }
}

#[cfg(not(any(unix, windows)))]
fn session_poll_events(_directions: BlockDirections) -> i16 {
    1
}

#[cfg(not(any(unix, windows)))]
fn poll_session_events(
    session: &Session,
    wake: &SessionWakeSource,
    events: i16,
    timeout: Duration,
) -> Result<i16, String> {
    let _ = (session, wake);
    thread::sleep(timeout.min(Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS)));
    Ok(events)
}

#[cfg(unix)]
fn wait_for_session_socket(session: &Session, timeout: Duration) -> Result<(), String> {
    let events = session_poll_events(session.block_directions());
    if events == 0 {
        if !timeout.is_zero() {
            thread::sleep(timeout);
        }
        return Ok(());
    }

    let timeout_ms = timeout.as_millis().min(i32::MAX as u128);
    let timeout_ms = i32::try_from(timeout_ms).unwrap_or(i32::MAX);
    let mut poll_fd = pollfd {
        fd: session.as_raw_fd(),
        events,
        revents: 0,
    };

    loop {
        let result = unsafe { poll(&mut poll_fd, 1, timeout_ms) };
        if result >= 0 {
            return Ok(());
        }

        let error = std::io::Error::last_os_error();
        if error.kind() == ErrorKind::Interrupted {
            continue;
        }

        return Err(format!("failed to wait for ssh socket readiness: {error}"));
    }
}

#[cfg(not(unix))]
fn wait_for_session_socket(_session: &Session, timeout: Duration) -> Result<(), String> {
    if !timeout.is_zero() {
        thread::sleep(timeout);
    }
    Ok(())
}

fn graceful_shutdown(channel: &mut Channel) {
    let _ = channel.send_eof();
    let _ = channel.close();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match channel.wait_close() {
            Ok(()) => return,
            Err(error) => {
                let io_error: std::io::Error = error.into();
                if is_retryable_channel_error_kind(io_error.kind()) {
                    thread::sleep(Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS));
                } else {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    include!("tests/session.rs");
}
