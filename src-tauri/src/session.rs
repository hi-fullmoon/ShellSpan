#[cfg(unix)]
use libc::{poll, pollfd, POLLIN, POLLOUT};
use log::{error, info, warn};
use ssh2::{BlockDirections, Channel, ExtendedData, Session};
use std::{
    io::{ErrorKind, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        mpsc::{Receiver, TryRecvError},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(windows)]
use std::os::windows::io::AsRawSocket;

use crate::{
    connection::{
        connect_tcp_stream, connect_through_jump_host, open_authenticated_session,
        summarize_session_request, SSH_SESSION_KEEPALIVE_INTERVAL_SECS,
    },
    drain_decoded_output, emit_data, emit_session_error, emit_status, flush_pending_output,
    known_hosts::known_hosts_path,
    models::{
        ClosedReasonKind, ConnectionError, SessionCommand, SessionCreateRequest, SessionErrorEvent,
        SessionStatus,
    },
    observe_terminal_raw_output,
    petdex::{self, PetdexEvent},
    terminal_integration::{
        quote_remote_posix, remote_posix_bootstrap, TerminalIntegrationStreamDecoder,
        TerminalShellKind,
    },
};

const SSH_IDLE_WAIT_SLICE_MS: u64 = 20;
const SSH_OUTPUT_FLUSH_THRESHOLD_BYTES: usize = 64 * 1024;
const SSH_OUTPUT_READY_TIMEOUT: Duration = Duration::from_secs(5);
const SSH_STARTUP_OUTPUT_BUFFER_LIMIT_BYTES: usize = 1_000_000;

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

impl RemoteSshShellIntegration {
    fn prepare(session: &Session, username: &str) -> Result<Self, String> {
        let (shell, shell_executable) = detect_remote_login_shell_identity(session, username)?;
        if !matches!(shell, TerminalShellKind::Bash | TerminalShellKind::Zsh) {
            return Err("TERMINAL_INTEGRATION_UNSUPPORTED_REMOTE_SHELL".into());
        }
        let suffix = Uuid::new_v4().simple().to_string();
        let remote_root = format!("/tmp/.shellspan-agent-terminal-{suffix}");
        let bootstrap_path = if shell == TerminalShellKind::Zsh {
            format!("{remote_root}/.zshrc")
        } else {
            format!("{remote_root}/integration")
        };
        let fifo_path = format!("{remote_root}/control");
        let sftp = session
            .sftp()
            .map_err(|error| format!("failed to open remote integration SFTP: {error}"))?;
        sftp.mkdir(Path::new(&remote_root), 0o700)
            .map_err(|error| format!("failed to create remote integration root: {error}"))?;
        let setup = (|| {
            let source = remote_posix_bootstrap(shell, &fifo_path)?;
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
                    remote
                        .write_all(
                            format!("[[ -r {user_path} ]] && source {user_path}\n").as_bytes(),
                        )
                        .map_err(|error| {
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
                .exec(&format!(
                    "exec 3<> {}; cat <&3",
                    quote_remote_posix(&fifo_path)
                ))
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
            shell_executable,
            remote_root,
            bootstrap_path,
            fifo_path,
            control,
            decoder: TerminalIntegrationStreamDecoder::default(),
            active: true,
            accept_events: true,
        })
    }

    fn start_shell(&self, shell_channel: &mut Channel) -> Result<(), String> {
        let command = match self.shell {
            TerminalShellKind::Bash => format!(
                "exec {} --noprofile --rcfile {} -i",
                quote_remote_posix(&self.shell_executable),
                quote_remote_posix(&self.bootstrap_path)
            ),
            TerminalShellKind::Zsh => format!(
                "exec env ZDOTDIR={} {} -il",
                quote_remote_posix(&self.remote_root),
                quote_remote_posix(&self.shell_executable)
            ),
            _ => return Err("TERMINAL_INTEGRATION_UNSUPPORTED_REMOTE_SHELL".into()),
        };
        shell_channel
            .exec(&command)
            .map_err(|error| format!("failed to start integrated remote shell: {error}"))
    }

    fn close(mut self, session: &Session) {
        self.active = false;
        let _ = self.control.send_eof();
        let _ = self.control.close();
        session.set_blocking(true);
        let sftp = session.sftp();
        if let Ok(sftp) = sftp {
            cleanup_remote_integration_files(
                &sftp,
                &self.remote_root,
                &self.bootstrap_path,
                &self.fifo_path,
            );
        }
    }
}

fn cleanup_remote_integration_files(
    sftp: &ssh2::Sftp,
    remote_root: &str,
    bootstrap_path: &str,
    fifo_path: &str,
) {
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
    detect_remote_login_shell_identity(session, username).map(|(shell, _)| shell)
}

fn detect_remote_login_shell_identity(
    session: &Session,
    username: &str,
) -> Result<(TerminalShellKind, String), String> {
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
    let prefix = format!("{username}:");
    let shell = contents
        .lines()
        .find(|line| line.starts_with(&prefix))
        .and_then(|line| line.rsplit(':').next())
        .ok_or_else(|| "remote login shell identity is unavailable".to_string())?;
    Ok((TerminalShellKind::detect(shell), shell.to_string()))
}

fn run_ssh_setup_command(session: &Session, command: &str) -> Result<(), String> {
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
        Ok(())
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
    stream: TcpStream,
}

/// Read half of the session self-pipe, polled by the session loop alongside
/// the SSH socket.
pub(crate) struct SessionWakeSource {
    stream: TcpStream,
}

pub(crate) fn session_wake_pair() -> std::io::Result<(SessionWaker, SessionWakeSource)> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let address = listener.local_addr()?;
    let writer = TcpStream::connect(address)?;
    let (reader, _) = listener.accept()?;
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

pub(crate) fn run_ssh_session<F: FnOnce() -> Result<(), String> + Send>(
    app: &AppHandle,
    session_id: &str,
    request: &SessionCreateRequest,
    rx: Receiver<SessionCommand>,
    wake: SessionWakeSource,
    output_ready: Arc<AtomicBool>,
    output_paused: Arc<AtomicBool>,
    bootstrap_agent_integration: bool,
    on_connected: F,
) -> Result<Option<String>, ConnectionError> {
    petdex::notify(app, PetdexEvent::SshConnecting(session_id.to_string()));
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
    let session_result = if let Some(ref jump) = request.jump_host {
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
    };

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

    let (mut remote_integration, remote_integration_error) = if bootstrap_agent_integration {
        match RemoteSshShellIntegration::prepare(&session, &request.username) {
            Ok(integration) => (Some(integration), None),
            Err(error) => (None, Some(error)),
        }
    } else {
        (None, None)
    };

    let mut channel = session.channel_session().map_err(|error| {
        error!("Failed to open SSH channel session_id={session_id}: {error}");
        ConnectionError::Other {
            message: format!("failed to open ssh channel: {error}"),
        }
    })?;
    channel
        .request_pty(
            "xterm-256color",
            None,
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
    let shell_start = match remote_integration.as_ref() {
        Some(integration) => integration.start_shell(&mut channel),
        None => channel
            .shell()
            .map_err(|error| format!("failed to start remote shell: {error}")),
    };
    if let Err(message) = shell_start {
        error!("Failed to start remote shell session_id={session_id}: {message}");
        if let Some(integration) = remote_integration.take() {
            integration.close(&session);
        }
        graceful_shutdown(&mut channel);
        return Err(ConnectionError::Other { message });
    }
    // Attach the broker generation only after the interactive PTY and shell
    // exist, but before any output can be read or input can be accepted.
    if let Err(error) =
        require_ssh_broker_attachment(on_connected(), || graceful_shutdown(&mut channel))
    {
        if let Some(integration) = remote_integration.take() {
            integration.close(&session);
        }
        return Err(error);
    }
    let runtime = app
        .try_state::<crate::agent_runtime::AgentRuntime>()
        .ok_or_else(|| ConnectionError::Other {
            message: "terminal integration runtime is unavailable".into(),
        })?;
    if let Some(integration) = remote_integration.as_ref() {
        if let Err(message) = runtime.register_terminal_integration_channel(
            session_id,
            &integration.integration_id,
            integration.shell,
        ) {
            if let Some(integration) = remote_integration.take() {
                integration.close(&session);
            }
            graceful_shutdown(&mut channel);
            return Err(ConnectionError::Other { message });
        }
        crate::commands::emit_terminal_integration_state(app, session_id);
    } else if let Some(message) = remote_integration_error {
        let shell = detect_remote_login_shell(&session, &request.username)
            .unwrap_or(TerminalShellKind::Unsupported);
        let reason = if message == "TERMINAL_INTEGRATION_UNSUPPORTED_REMOTE_SHELL" {
            "unsupportedRemoteShell"
        } else {
            "remoteBootstrapFailed"
        };
        if reason == "unsupportedRemoteShell" {
            let _ = runtime.mark_terminal_integration_unavailable(session_id, shell, reason);
        } else {
            let _ = runtime.mark_terminal_integration_degraded(session_id, shell, reason);
        }
        crate::commands::emit_terminal_integration_state(app, session_id);
    }
    session.set_blocking(false);

    info!("SSH session connected session_id={session_id}");
    emit_status(
        app,
        session_id,
        SessionStatus::Connected,
        Some("shell ready".to_string()),
    )
    .map_err(|message| ConnectionError::Other { message })?;
    petdex::notify(app, PetdexEvent::SshConnected(session_id.to_string()));

    let result = session_loop(
        app,
        session_id,
        &session,
        &mut channel,
        rx,
        &wake,
        &output_ready,
        &output_paused,
        remote_integration.as_mut(),
        Vec::new(),
    )
    .map_err(|message| ConnectionError::Other { message });
    if let Some(integration) = remote_integration {
        integration.close(&session);
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
            SessionCommand::Resize { cols, rows } => {
                if !pending_write.is_empty() {
                    merged.push(SessionCommand::Write(std::mem::take(&mut pending_write)));
                }
                // Only the latest size matters: adjacent resizes collapse into
                // the most recent one instead of replaying every step.
                pending_resize = Some((cols, rows));
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
                integration.active = false;
                if let Some(runtime) = app.try_state::<crate::agent_runtime::AgentRuntime>() {
                    let _ = runtime.terminal_integration_channel_closed(
                        session_id,
                        &integration.integration_id,
                        "remoteControlChannelClosed",
                    );
                    crate::commands::emit_terminal_integration_state(app, session_id);
                }
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
                        return Ok(true);
                    }
                    crate::commands::emit_terminal_integration_state(app, session_id);
                }
            }
            Err(error) if is_retryable_channel_error_kind(error.kind()) => {
                return Ok(made_progress)
            }
            Err(error) => {
                integration.active = false;
                if let Some(runtime) = app.try_state::<crate::agent_runtime::AgentRuntime>() {
                    let _ = runtime.terminal_integration_channel_closed(
                        session_id,
                        &integration.integration_id,
                        "remoteControlChannelFailed",
                    );
                    crate::commands::emit_terminal_integration_state(app, session_id);
                }
                log::warn!("Remote integration control failed session_id={session_id}: {error}");
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
    rx: Receiver<SessionCommand>,
    wake: &SessionWakeSource,
    output_ready: &AtomicBool,
    output_paused: &AtomicBool,
    remote_integration: Option<&mut RemoteSshShellIntegration>,
    initial_pty_output: Vec<u8>,
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
    );
    // Emit whatever decoded output remains so the final screen state is not
    // lost when the session ends.
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

fn session_loop_inner(
    app: &AppHandle,
    session_id: &str,
    session: &Session,
    channel: &mut Channel,
    rx: Receiver<SessionCommand>,
    wake: &SessionWakeSource,
    output_ready: &AtomicBool,
    output_paused: &AtomicBool,
    pending_bytes: &mut Vec<u8>,
    pending_output: &mut String,
    output_wait_started: Instant,
    output_live: &mut bool,
    mut remote_integration: Option<&mut RemoteSshShellIntegration>,
) -> Result<Option<String>, String> {
    let mut buffer = [0u8; 8192];
    let mut next_keepalive_at =
        Instant::now() + normalize_keepalive_delay(SSH_SESSION_KEEPALIVE_INTERVAL_SECS);

    loop {
        let mut made_progress = false;
        let mut pending_commands = Vec::new();

        if let Some(integration) = remote_integration.as_deref_mut() {
            if integration.active {
                made_progress |= drain_remote_integration_control(app, session_id, integration)?;
            }
        }

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
                    graceful_shutdown(channel);
                    return Ok(Some("session controller dropped".to_string()));
                }
            }
        }

        for command in coalesce_session_commands(pending_commands) {
            match command {
                SessionCommand::Write(data) => {
                    write_all_nonblocking(session, channel, data.as_bytes())?;
                    made_progress = true;
                }
                SessionCommand::Resize { cols, rows } => {
                    resize_pty_nonblocking(session, channel, cols, rows)?;
                    made_progress = true;
                }
                SessionCommand::Close => {
                    info!("SSH session closed locally session_id={session_id}");
                    graceful_shutdown(channel);
                    return Ok(Some("session closed locally".to_string()));
                }
            }
        }

        if !output_paused.load(AtomicOrdering::Relaxed) {
            match channel.read(&mut buffer) {
                Ok(0) => {
                    if channel.eof() {
                        info!("Remote shell exited session_id={session_id}");
                        return Ok(Some("remote shell exited".to_string()));
                    }
                }
                Ok(read) => {
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
        }

        if made_progress {
            next_keepalive_at =
                Instant::now() + normalize_keepalive_delay(SSH_SESSION_KEEPALIVE_INTERVAL_SECS);
            continue;
        }

        let now = Instant::now();
        if now >= next_keepalive_at {
            let keepalive_delay = send_session_keepalive_nonblocking(session)?;
            next_keepalive_at = Instant::now() + keepalive_delay;
            continue;
        }

        let keepalive_due_in = next_keepalive_at.saturating_duration_since(now);
        if output_paused.load(AtomicOrdering::Relaxed) {
            thread::sleep(keepalive_due_in.min(Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS)));
            continue;
        }

        // Idle: sleep until the SSH socket becomes ready, a command wakes us
        // through the self-pipe, or the keepalive deadline expires — whichever
        // comes first.
        wait_for_session_events(session, wake, keepalive_due_in)?;
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

fn send_session_keepalive_nonblocking(session: &Session) -> Result<Duration, String> {
    let wait_timeout = Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS);

    loop {
        match session.keepalive_send() {
            Ok(next_seconds) => return Ok(normalize_keepalive_delay(next_seconds)),
            Err(error) => {
                let io_error: std::io::Error = error.into();
                if is_retryable_channel_error_kind(io_error.kind()) {
                    if io_error.kind() == ErrorKind::Interrupted {
                        continue;
                    }
                    wait_for_session_socket(session, wait_timeout)?;
                    continue;
                }

                warn!(
                    "SSH keepalive failed kind={:?} block_directions={:?} error={}",
                    io_error.kind(),
                    session.block_directions(),
                    io_error
                );
                return Err(format_transport_error(
                    "failed to send ssh keepalive",
                    &io_error.to_string(),
                ));
            }
        }
    }
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

fn write_all_nonblocking(
    session: &Session,
    channel: &mut Channel,
    bytes: &[u8],
) -> Result<(), String> {
    let mut offset = 0usize;
    let wait_timeout = Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS);

    while offset < bytes.len() {
        match channel.write(&bytes[offset..]) {
            Ok(0) => return Err("remote channel accepted zero bytes".to_string()),
            Ok(written) => offset += written,
            Err(error) if is_retryable_channel_error_kind(error.kind()) => {
                if error.kind() == ErrorKind::Interrupted {
                    continue;
                }
                wait_for_session_socket(session, wait_timeout)?;
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

fn resize_pty_nonblocking(
    session: &Session,
    channel: &mut Channel,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let wait_timeout = Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS);
    loop {
        match channel.request_pty_size(cols, rows, None, None) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let io_error: std::io::Error = error.into();
                if is_retryable_channel_error_kind(io_error.kind()) {
                    if io_error.kind() == ErrorKind::Interrupted {
                        continue;
                    }
                    wait_for_session_socket(session, wait_timeout)?;
                    continue;
                }
                warn!(
                    "SSH resize failed cols={} rows={} kind={:?} block_directions={:?} error={}",
                    cols,
                    rows,
                    io_error.kind(),
                    session.block_directions(),
                    io_error
                );
                return Err(format_transport_error(
                    "failed to resize PTY",
                    &io_error.to_string(),
                ));
            }
        }
    }
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

/// Waits until the SSH socket is ready, the self-pipe signals a pending
/// command, or `timeout` elapses. Falls back to polling inbound readiness
/// when the last blocked direction is unknown, so incoming data can never
/// stall until the keepalive deadline.
#[cfg(unix)]
fn wait_for_session_events(
    session: &Session,
    wake: &SessionWakeSource,
    timeout: Duration,
) -> Result<(), String> {
    let events = match session_poll_events(session.block_directions()) {
        0 => POLLIN,
        events => events,
    };
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
            wake.drain();
            return Ok(());
        }

        let error = std::io::Error::last_os_error();
        if error.kind() == ErrorKind::Interrupted {
            continue;
        }

        return Err(format!("failed to wait for ssh socket readiness: {error}"));
    }
}

#[cfg(windows)]
fn wait_for_session_events(
    session: &Session,
    wake: &SessionWakeSource,
    timeout: Duration,
) -> Result<(), String> {
    use windows_sys::Win32::Networking::WinSock::{
        WSAGetLastError, WSAPoll, POLLIN, WSAEINTR, WSAPOLLFD,
    };

    let events = match session_poll_events(session.block_directions()) {
        0 => POLLIN,
        events => events,
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
            wake.drain();
            return Ok(());
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
fn wait_for_session_events(
    session: &Session,
    wake: &SessionWakeSource,
    timeout: Duration,
) -> Result<(), String> {
    let _ = (session, wake);
    thread::sleep(timeout.min(Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS)));
    Ok(())
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

fn require_ssh_broker_attachment(
    attachment: Result<(), String>,
    close_channel: impl FnOnce(),
) -> Result<(), ConnectionError> {
    match attachment {
        Ok(()) => Ok(()),
        Err(message) => {
            close_channel();
            Err(ConnectionError::Other { message })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_wake_pair_passes_wakeups_and_drains_without_blocking() {
        let (waker, source) = session_wake_pair().expect("wake pair should be creatable");

        source.drain();

        waker.wake();
        waker.wake();
        // Give the loopback byte a moment to arrive, then drain must consume
        // it and return immediately instead of blocking.
        thread::sleep(Duration::from_millis(50));
        source.drain();
    }

    #[test]
    fn ssh_broker_attachment_failure_closes_channel_and_is_visible() {
        let closed = AtomicBool::new(false);
        let result = require_ssh_broker_attachment(
            Err("TERMINAL_BROKER_PREDECESSOR_NOT_FOUND".into()),
            || closed.store(true, AtomicOrdering::Relaxed),
        );

        assert!(closed.load(AtomicOrdering::Relaxed));
        assert!(matches!(
            result,
            Err(ConnectionError::Other { message })
                if message == "TERMINAL_BROKER_PREDECESSOR_NOT_FOUND"
        ));
    }

    #[test]
    fn normalize_keepalive_delay_clamps_zero_to_one_second() {
        assert_eq!(normalize_keepalive_delay(0), Duration::from_secs(1));
        assert_eq!(normalize_keepalive_delay(7), Duration::from_secs(7));
    }

    #[test]
    fn startup_output_waits_for_the_frontend_before_release() {
        assert!(!should_release_startup_output(
            false,
            Duration::from_secs(1),
            SSH_OUTPUT_FLUSH_THRESHOLD_BYTES,
        ));
        assert!(should_release_startup_output(
            true,
            Duration::from_secs(1),
            SSH_OUTPUT_FLUSH_THRESHOLD_BYTES,
        ));
    }

    #[test]
    fn startup_output_gate_has_timeout_and_memory_safety_valves() {
        assert!(should_release_startup_output(
            false,
            SSH_OUTPUT_READY_TIMEOUT + Duration::from_millis(1),
            0,
        ));
        assert!(should_release_startup_output(
            false,
            Duration::ZERO,
            SSH_STARTUP_OUTPUT_BUFFER_LIMIT_BYTES + 1,
        ));
    }

    #[test]
    fn transport_error_classifies_drain_incoming_flow_as_disconnect() {
        let message = format_transport_error(
            "failed to write remote input",
            "Failure while draining incoming flow",
        );

        assert!(message.contains("ssh transport disconnected"));
    }

    #[test]
    fn closed_reason_marks_transport_disconnect_as_retryable() {
        let (reason_kind, retryable) = classify_closed_reason(
            Some("failed to read remote output: ssh transport disconnected"),
            SessionStatus::Error,
        );

        assert_eq!(reason_kind, ClosedReasonKind::TransportDisconnect);
        assert!(retryable);
    }

    #[test]
    fn closed_reason_keeps_remote_exit_non_retryable() {
        let (reason_kind, retryable) =
            classify_closed_reason(Some("remote shell exited"), SessionStatus::Disconnected);

        assert_eq!(reason_kind, ClosedReasonKind::RemoteExit);
        assert!(!retryable);
    }

    #[test]
    fn coalesce_session_commands_merges_adjacent_write_chunks() {
        let commands = vec![
            SessionCommand::Write("a".to_string()),
            SessionCommand::Write("bc".to_string()),
            SessionCommand::Write("123".to_string()),
        ];

        let merged = coalesce_session_commands(commands);

        assert_eq!(merged.len(), 1);
        match &merged[0] {
            SessionCommand::Write(data) => assert_eq!(data, "abc123"),
            _ => panic!("expected a single merged write command"),
        }
    }

    #[test]
    fn coalesce_session_commands_keeps_only_the_last_adjacent_resize() {
        let commands = vec![
            SessionCommand::Resize { cols: 80, rows: 24 },
            SessionCommand::Resize {
                cols: 100,
                rows: 30,
            },
            SessionCommand::Resize {
                cols: 120,
                rows: 40,
            },
        ];

        let merged = coalesce_session_commands(commands);

        assert_eq!(merged.len(), 1);
        match &merged[0] {
            SessionCommand::Resize { cols, rows } => {
                assert_eq!((cols, rows), (&120, &40));
            }
            _ => panic!("expected a single merged resize command"),
        }
    }

    #[test]
    fn coalesce_session_commands_preserves_resize_write_resize_boundaries() {
        let commands = vec![
            SessionCommand::Write("ab".to_string()),
            SessionCommand::Resize { cols: 80, rows: 24 },
            SessionCommand::Resize {
                cols: 120,
                rows: 40,
            },
            SessionCommand::Write("cd".to_string()),
            SessionCommand::Close,
            SessionCommand::Write("ef".to_string()),
        ];

        let merged = coalesce_session_commands(commands);

        assert_eq!(merged.len(), 5);
        match &merged[0] {
            SessionCommand::Write(data) => assert_eq!(data, "ab"),
            _ => panic!("first command should stay write"),
        }
        match &merged[1] {
            SessionCommand::Resize { cols, rows } => {
                assert_eq!((cols, rows), (&120, &40));
            }
            _ => panic!("adjacent resizes should merge into the latest size"),
        }
        match &merged[2] {
            SessionCommand::Write(data) => assert_eq!(data, "cd"),
            _ => panic!("third command should stay write"),
        }
        match &merged[3] {
            SessionCommand::Close => {}
            _ => panic!("fourth command should stay close"),
        }
        match &merged[4] {
            SessionCommand::Write(data) => assert_eq!(data, "ef"),
            _ => panic!("fifth command should stay write"),
        }
    }

    #[test]
    fn retryable_channel_error_kind_includes_wouldblock_and_interrupted() {
        assert!(is_retryable_channel_error_kind(ErrorKind::WouldBlock));
        assert!(is_retryable_channel_error_kind(ErrorKind::Interrupted));
    }

    #[test]
    fn retryable_channel_error_kind_rejects_fatal_kinds() {
        assert!(!is_retryable_channel_error_kind(ErrorKind::ConnectionReset));
        assert!(!is_retryable_channel_error_kind(ErrorKind::BrokenPipe));
    }

    struct RemoteFixtureTerminal {
        _known_hosts: tempfile::TempDir,
        session: Session,
        shell_channel: Channel,
        integration: Option<RemoteSshShellIntegration>,
        broker: crate::terminal_broker::TerminalSessionBroker,
        transport_id: String,
        integration_id: String,
        owner: crate::terminal_broker::TerminalAgentPtyOwner,
        display: Vec<u8>,
    }

    impl RemoteFixtureTerminal {
        fn connect(
            username: &str,
            transport_id: &str,
            predecessor: Option<&str>,
            broker: crate::terminal_broker::TerminalSessionBroker,
        ) -> Self {
            use crate::terminal_broker::TerminalGeometry;

            let mut connection = crate::execution::fixture::isolated_ssh_connection();
            connection.username = username.to_string();
            let (known_hosts, known_hosts_path) =
                crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
            let session = crate::connection::open_authenticated_session(
                crate::connection::connect_tcp_stream(&connection.host, connection.port)
                    .expect("connect to isolated SSH fixture"),
                &connection.username,
                connection.auth_method,
                connection.password.as_deref(),
                connection.private_key_data.as_deref(),
                connection.passphrase.as_deref(),
                &connection.host,
                connection.port,
                Some(&known_hosts_path),
            )
            .expect("authenticate to isolated SSH fixture");
            let integration = RemoteSshShellIntegration::prepare(&session, username)
                .expect("prepare remote integration before interactive-shell startup");
            let integration_id = integration.integration_id.clone();
            let mut shell_channel = session.channel_session().expect("open SSH PTY channel");
            shell_channel
                .request_pty("xterm-256color", None, Some((100, 30, 0, 0)))
                .expect("request SSH PTY");
            shell_channel
                .handle_extended_data(ExtendedData::Merge)
                .expect("merge SSH PTY stderr");
            integration
                .start_shell(&mut shell_channel)
                .expect("start integrated interactive SSH shell");
            let owner = crate::terminal_broker::TerminalAgentPtyOwner {
                agent_session_id: "fixture-agent-session".into(),
                target_id: "fixture-target".into(),
                source_transport_session_id: "fixture-user-owned".into(),
            };
            broker
                .attach_agent_ssh_transport(
                    transport_id,
                    predecessor,
                    TerminalGeometry::new(100, 30),
                    owner.clone(),
                )
                .expect("attach dedicated Agent SSH PTY");
            broker
                .mark_output_ready(transport_id)
                .expect("mark fixture display ready");
            broker
                .register_integration_channel(transport_id, &integration_id, integration.shell)
                .expect("register isolated remote control channel");
            session.set_blocking(false);
            let mut fixture = Self {
                _known_hosts: known_hosts,
                session,
                shell_channel,
                integration: Some(integration),
                broker,
                transport_id: transport_id.into(),
                integration_id,
                owner,
                display: Vec::new(),
            };
            fixture.pump_until(Duration::from_secs(8), |snapshot| {
                snapshot.integration_state
                    == crate::terminal_broker::TerminalIntegrationState::Ready
                    && snapshot.prompt_ready
            });
            fixture
        }

        fn pump_once(&mut self) -> bool {
            let mut progress = false;
            let mut output = [0_u8; 8192];
            loop {
                match self.shell_channel.read(&mut output) {
                    Ok(0) => break,
                    Ok(read) => {
                        progress = true;
                        self.display.extend_from_slice(&output[..read]);
                        self.broker
                            .observe_raw_output(&self.transport_id, &output[..read])
                            .expect("broker accepts exact SSH PTY bytes");
                    }
                    Err(error) if is_retryable_channel_error_kind(error.kind()) => break,
                    Err(error) => panic!("SSH PTY output failed: {error}"),
                }
            }
            if let Some(integration) = self.integration.as_mut() {
                let mut control = [0_u8; 8192];
                loop {
                    match integration.control.read(&mut control) {
                        Ok(0) => break,
                        Ok(read) => {
                            progress = true;
                            for event in integration
                                .decoder
                                .push(&control[..read])
                                .expect("decode isolated SSH control bytes")
                            {
                                if let Err(error) = self.broker.accept_integration_event(
                                    &self.transport_id,
                                    &self.integration_id,
                                    event.clone(),
                                ) {
                                    panic!(
                                        "accept generation-bound remote lifecycle event {event:?}: {error}; snapshot={:?}",
                                        self.broker.snapshot(Some(&self.transport_id)).unwrap().session
                                    );
                                }
                            }
                        }
                        Err(error) if is_retryable_channel_error_kind(error.kind()) => break,
                        Err(error) => panic!("SSH control channel failed: {error}"),
                    }
                }
            }
            progress
        }

        fn pump_until(
            &mut self,
            timeout: Duration,
            ready: impl Fn(&crate::terminal_broker::TerminalBrokerSessionSnapshot) -> bool,
        ) {
            let deadline = Instant::now() + timeout;
            loop {
                self.pump_once();
                let snapshot = self
                    .broker
                    .snapshot(Some(&self.transport_id))
                    .expect("snapshot remote fixture")
                    .session
                    .expect("remote fixture stays attached");
                if ready(&snapshot) {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "remote fixture condition timed out: {snapshot:?}"
                );
                thread::sleep(Duration::from_millis(5));
            }
        }

        fn begin(
            &mut self,
            operation_id: &str,
            command: &str,
        ) -> Arc<crate::terminal_broker::TerminalCommandOperation> {
            use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};

            self.broker
                .acquire_agent_lease(
                    &self.transport_id,
                    &self.owner.agent_session_id,
                    "fixture-task",
                    operation_id,
                )
                .expect("acquire remote Agent lease")
                .expect("broker enabled");
            let operation =
                self.broker
                    .begin_command(&self.transport_id, operation_id, command)
                    .unwrap_or_else(|error| {
                        panic!(
                        "register remote command {command:?} before input: {error}; snapshot={:?}",
                        self.broker.snapshot(Some(&self.transport_id)).unwrap().session
                    )
                    });
            let input = format!("{command}\n");
            let broker = self.broker.clone();
            let transport_id = self.transport_id.clone();
            let shell_channel = &mut self.shell_channel;
            broker
                .admit_compatibility_input(
                    &transport_id,
                    TerminalBrokerInputSource::Agent {
                        agent_session_id: self.owner.agent_session_id.clone(),
                        task_id: "fixture-task".into(),
                        operation_id: operation_id.into(),
                    },
                    TerminalInputKind::Text,
                    input.as_bytes(),
                    || write_all_nonblocking(&self.session, shell_channel, input.as_bytes()),
                )
                .expect("write exact remote command through broker input admission");
            operation
        }

        fn execute(
            &mut self,
            operation_id: &str,
            command: &str,
        ) -> crate::terminal_broker::TerminalCommandSnapshot {
            let operation = self.begin(operation_id, command);
            self.pump_until(Duration::from_secs(8), |_| {
                operation
                    .snapshot()
                    .expect("snapshot operation")
                    .state
                    .is_terminal()
            });
            let drain_deadline = Instant::now() + Duration::from_millis(50);
            while Instant::now() < drain_deadline {
                self.pump_once();
                thread::sleep(Duration::from_millis(2));
            }
            let snapshot = operation.snapshot().expect("snapshot completed command");
            self.broker
                .retire_command(&self.transport_id, &snapshot.command_id)
                .expect("retire remote command");
            self.broker
                .release_agent_lease(
                    &self.transport_id,
                    &self.owner.agent_session_id,
                    "fixture-task",
                    operation_id,
                )
                .expect("release remote Agent lease");
            snapshot
        }

        fn interrupt(
            &mut self,
            operation: &Arc<crate::terminal_broker::TerminalCommandOperation>,
            requested: crate::terminal_broker::TerminalCommandRequestedSettlement,
        ) -> crate::terminal_broker::TerminalCommandSnapshot {
            use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};

            let operation_id = operation.snapshot().unwrap().operation_id;
            self.pump_until(Duration::from_secs(5), |_| {
                operation.snapshot().unwrap().state
                    == crate::terminal_broker::TerminalCommandState::Running
            });
            operation.request_settlement(requested).unwrap();
            let broker = self.broker.clone();
            let transport_id = self.transport_id.clone();
            let shell_channel = &mut self.shell_channel;
            broker
                .admit_compatibility_input(
                    &transport_id,
                    TerminalBrokerInputSource::System {
                        operation_id: operation_id.clone(),
                    },
                    TerminalInputKind::Interrupt,
                    b"\x03",
                    || write_all_nonblocking(&self.session, shell_channel, b"\x03"),
                )
                .unwrap();
            self.pump_until(Duration::from_secs(5), |_| {
                operation.snapshot().unwrap().state.is_terminal()
            });
            operation.snapshot().unwrap()
        }

        fn close_transport(&mut self) {
            self.session.set_blocking(true);
            self.session
                .disconnect(None, "forced Phase 4 fixture disconnect", None)
                .expect("force the isolated SSH transport to disconnect");
            self.broker
                .close_transport(
                    &self.transport_id,
                    crate::terminal_broker::TerminalGenerationCloseReason::TransportDisconnected,
                )
                .unwrap();
        }
    }

    impl Drop for RemoteFixtureTerminal {
        fn drop(&mut self) {
            if let Some(integration) = self.integration.take() {
                integration.close(&self.session);
            }
            let _ = self.shell_channel.send_eof();
            let _ = self.shell_channel.close();
        }
    }

    fn open_user_owned_fixture_shell() -> (tempfile::TempDir, Session, Channel) {
        let connection = crate::execution::fixture::isolated_ssh_connection();
        let (known_hosts, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let session = crate::connection::open_authenticated_session(
            crate::connection::connect_tcp_stream(&connection.host, connection.port)
                .expect("connect user-owned SSH fixture"),
            &connection.username,
            connection.auth_method,
            connection.password.as_deref(),
            connection.private_key_data.as_deref(),
            connection.passphrase.as_deref(),
            &connection.host,
            connection.port,
            Some(&known_hosts_path),
        )
        .expect("authenticate user-owned SSH fixture");
        let mut channel = session
            .channel_session()
            .expect("open user-owned SSH channel");
        channel
            .request_pty("xterm-256color", None, Some((80, 24, 0, 0)))
            .expect("request user-owned SSH PTY");
        channel.shell().expect("start user-owned interactive shell");
        (known_hosts, session, channel)
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn remote_agent_ssh_pty_bash_phase4_acceptance() {
        use crate::terminal_broker::{
            TerminalCommandRequestedSettlement, TerminalCommandState, TerminalGeometry,
            TerminalTransportKind, TerminalVisibleCommandRoute,
        };

        let broker = crate::terminal_broker::TerminalSessionBroker::phase4_enabled_for_test(4096);
        let (_user_known_hosts, user_session, mut user_channel) = open_user_owned_fixture_shell();
        user_channel
            .write_all(b"export SHELLSPAN_USER_ONLY=user-shell-preserved\n")
            .unwrap();
        user_channel.flush().unwrap();
        broker
            .attach_transport(
                "fixture-user-owned",
                None,
                TerminalTransportKind::SshPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap();
        assert_eq!(
            broker.visible_command_route("fixture-user-owned").unwrap(),
            TerminalVisibleCommandRoute::LegacyFallback
        );
        let mut terminal = RemoteFixtureTerminal::connect(
            "shellspan",
            "fixture-agent-ssh-1",
            None,
            broker.clone(),
        );
        assert_eq!(
            broker.visible_command_route("fixture-agent-ssh-1").unwrap(),
            TerminalVisibleCommandRoute::TerminalExecute
        );
        user_session.set_blocking(false);

        let interactive = terminal.execute(
            "phase4-interactive-shell",
            "case $- in *i*) printf interactive-bash;; *) false;; esac",
        );
        assert_eq!(interactive.exit_code, Some(0));
        assert!(interactive.combined_output.contains("interactive-bash"));

        let cd = terminal.execute("phase4-cd", "cd /tmp");
        assert_eq!(cd.state, TerminalCommandState::Completed);
        assert_eq!(cd.cwd.as_deref(), Some("/tmp"));
        let export = terminal.execute("phase4-export", "export SHELLSPAN_PHASE4=preserved");
        assert_eq!(export.exit_code, Some(0));
        let value = terminal.execute("phase4-value", "printf 'env=%s' \"$SHELLSPAN_PHASE4\"");
        assert!(value.combined_output.contains("env=preserved"));
        terminal.execute(
            "phase4-alias-set",
            "alias ss_phase4_alias='printf alias-preserved'",
        );
        let alias = terminal.execute("phase4-alias-use", "ss_phase4_alias");
        assert!(alias.combined_output.contains("alias-preserved"));
        terminal.execute(
            "phase4-function-set",
            "ss_phase4_fn() { printf function-preserved; }",
        );
        let function = terminal.execute("phase4-function-use", "ss_phase4_fn");
        assert!(function.combined_output.contains("function-preserved"));
        terminal.execute("phase4-option-set", "set -o noclobber");
        let option = terminal.execute("phase4-option-use", "set -o | grep '^noclobber' ");
        assert!(option.combined_output.contains("on"));

        let remote_root = terminal
            .integration
            .as_ref()
            .expect("remote integration stays active")
            .remote_root
            .clone();
        let child = terminal.execute("phase4-child-boundary", "env; ls -l /proc/$$/fd");
        assert!(!child.combined_output.contains(&remote_root));
        assert!(!String::from_utf8_lossy(&terminal.display).contains(&remote_root));

        let forged = terminal.execute(
            "phase4-raw-forge",
            "python3 -c 'import os; os.write(1, bytes([69,0,55,55,0,47,116,109,112,0]))'",
        );
        assert_eq!(forged.exit_code, Some(0));
        assert_ne!(forged.exit_code, Some(77));

        let display_before_large = terminal.display.len();
        let large = terminal.execute("phase4-large-output", "python3 -c 'print(chr(88)*20000)'");
        assert!(large.capture_truncated);
        assert!(terminal.display.len().saturating_sub(display_before_large) > 20_000);

        let exact = terminal.execute(
            "phase4-exact",
            "tput setaf 2; printf 'remote-终端'; tput sgr0; false",
        );
        assert_eq!(
            exact.command_line,
            "tput setaf 2; printf 'remote-终端'; tput sgr0; false"
        );
        assert_eq!(exact.exit_code, Some(1));
        assert_eq!(exact.cwd.as_deref(), Some("/tmp"));
        assert!(String::from_utf8_lossy(&terminal.display).contains("remote-终端"));

        resize_pty_nonblocking(&terminal.session, &mut terminal.shell_channel, 132, 41)
            .expect("propagate SSH PTY resize through the production helper");
        broker
            .resize("fixture-agent-ssh-1", TerminalGeometry::new(132, 41))
            .unwrap();
        let resize = terminal.execute("phase4-resize", "stty size");
        assert!(resize.combined_output.contains("41 132"));
        assert_eq!(
            broker
                .snapshot(Some("fixture-agent-ssh-1"))
                .unwrap()
                .session
                .unwrap()
                .geometry,
            TerminalGeometry::new(132, 41)
        );

        for (id, requested, expected) in [
            (
                "phase4-cancel",
                TerminalCommandRequestedSettlement::Cancelled,
                TerminalCommandState::Cancelled,
            ),
            (
                "phase4-timeout",
                TerminalCommandRequestedSettlement::TimedOut,
                TerminalCommandState::TimedOut,
            ),
            (
                "phase4-takeover",
                TerminalCommandRequestedSettlement::TakenOver,
                TerminalCommandState::TakenOver,
            ),
        ] {
            let operation = terminal.begin(id, "sleep 30");
            thread::sleep(Duration::from_millis(100));
            let settled = terminal.interrupt(&operation, requested);
            assert_eq!(settled.state, expected);
            terminal
                .broker
                .retire_command(&terminal.transport_id, &settled.command_id)
                .unwrap();
            terminal
                .broker
                .release_agent_lease(
                    &terminal.transport_id,
                    &terminal.owner.agent_session_id,
                    "fixture-task",
                    id,
                )
                .unwrap();
            if expected == TerminalCommandState::TakenOver {
                let wrote = Arc::new(AtomicBool::new(false));
                let wrote_in_closure = Arc::clone(&wrote);
                assert!(terminal
                    .broker
                    .admit_compatibility_input(
                        &terminal.transport_id,
                        crate::terminal_broker::TerminalBrokerInputSource::Agent {
                            agent_session_id: terminal.owner.agent_session_id.clone(),
                            task_id: "fixture-task".into(),
                            operation_id: id.into(),
                        },
                        crate::terminal_broker::TerminalInputKind::Text,
                        b"forbidden-after-takeover\n",
                        move || {
                            wrote_in_closure.store(true, AtomicOrdering::Relaxed);
                            Ok(())
                        },
                    )
                    .is_err());
                assert!(!wrote.load(AtomicOrdering::Relaxed));
            }
        }

        write_all_nonblocking(
            &user_session,
            &mut user_channel,
            b"printf '%s' \"$SHELLSPAN_USER_ONLY\"\n",
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut user_output = Vec::new();
        let mut buffer = [0_u8; 1024];
        while Instant::now() < deadline
            && !String::from_utf8_lossy(&user_output).contains("user-shell-preserved")
        {
            match user_channel.read(&mut buffer) {
                Ok(read) if read > 0 => user_output.extend_from_slice(&buffer[..read]),
                Ok(_) => thread::sleep(Duration::from_millis(5)),
                Err(error) if is_retryable_channel_error_kind(error.kind()) => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("user-owned SSH output failed: {error}"),
            }
        }
        assert!(String::from_utf8_lossy(&user_output).contains("user-shell-preserved"));
        assert!(!String::from_utf8_lossy(&terminal.display).contains("user-shell-preserved"));

        let side_effect = terminal.begin(
            "phase4-disconnect",
            "printf 'once\\n' >> /tmp/shellspan-phase4-side-effect; sleep 30",
        );
        terminal.pump_until(Duration::from_secs(5), |_| {
            side_effect.snapshot().unwrap().state == TerminalCommandState::Running
        });
        thread::sleep(Duration::from_millis(100));
        terminal.close_transport();
        assert_eq!(
            side_effect.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
        drop(terminal);

        let mut reconnected = RemoteFixtureTerminal::connect(
            "shellspan",
            "fixture-agent-ssh-2",
            Some("fixture-agent-ssh-1"),
            broker.clone(),
        );
        let generation = broker
            .snapshot(Some("fixture-agent-ssh-2"))
            .unwrap()
            .session
            .unwrap()
            .terminal_generation;
        assert_eq!(generation, 2);
        assert!(broker
            .observe_raw_output("fixture-agent-ssh-1", b"stale")
            .is_err());
        let count = reconnected.execute(
            "phase4-reconcile",
            "wc -l < /tmp/shellspan-phase4-side-effect; rm -f /tmp/shellspan-phase4-side-effect",
        );
        assert!(count.combined_output.contains('1'));
        assert!(count.no_auto_replay);
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn remote_agent_ssh_pty_zsh_phase4_state_smoke() {
        let broker = crate::terminal_broker::TerminalSessionBroker::phase4_enabled_for_test(4096);
        let mut terminal =
            RemoteFixtureTerminal::connect("shellspan-zsh", "fixture-agent-zsh", None, broker);
        let interactive = terminal.execute(
            "zsh-interactive-shell",
            "[[ -o interactive ]] && printf interactive-zsh",
        );
        assert_eq!(interactive.exit_code, Some(0));
        assert!(interactive.combined_output.contains("interactive-zsh"));
        terminal.execute("zsh-export", "export SHELLSPAN_ZSH_PHASE4=kept");
        terminal.execute("zsh-alias-set", "alias ss_zsh_phase4='printf zsh-alias'");
        let value = terminal.execute(
            "zsh-state",
            "printf '%s:' \"$SHELLSPAN_ZSH_PHASE4\"; ss_zsh_phase4",
        );
        assert_eq!(value.exit_code, Some(0));
        assert!(value.combined_output.contains("kept:zsh-alias"));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn remote_agent_ssh_pty_unsupported_shell_is_unavailable() {
        let mut connection = crate::execution::fixture::isolated_ssh_connection();
        connection.username = "shellspan-sh".into();
        let (_known_hosts, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let session = crate::connection::open_authenticated_session(
            crate::connection::connect_tcp_stream(&connection.host, connection.port).unwrap(),
            &connection.username,
            connection.auth_method,
            connection.password.as_deref(),
            None,
            None,
            &connection.host,
            connection.port,
            Some(&known_hosts_path),
        )
        .unwrap();
        assert_eq!(
            detect_remote_login_shell(&session, &connection.username).unwrap(),
            TerminalShellKind::Unsupported
        );
        assert_eq!(
            RemoteSshShellIntegration::prepare(&session, &connection.username)
                .err()
                .as_deref(),
            Some("TERMINAL_INTEGRATION_UNSUPPORTED_REMOTE_SHELL")
        );

        let broker = crate::terminal_broker::TerminalSessionBroker::phase4_enabled_for_test(64);
        broker
            .attach_agent_ssh_transport(
                "fixture-agent-unsupported",
                None,
                crate::terminal_broker::TerminalGeometry::new(80, 24),
                crate::terminal_broker::TerminalAgentPtyOwner {
                    agent_session_id: "fixture-agent-session".into(),
                    target_id: "fixture-target".into(),
                    source_transport_session_id: "fixture-user-owned".into(),
                },
            )
            .unwrap();
        broker
            .mark_integration_unavailable(
                "fixture-agent-unsupported",
                TerminalShellKind::Unsupported,
                "unsupportedRemoteShell",
            )
            .unwrap();
        let snapshot = broker
            .snapshot(Some("fixture-agent-unsupported"))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(
            snapshot.integration_state,
            crate::terminal_broker::TerminalIntegrationState::Unavailable
        );
        assert!(snapshot.integration_capabilities.is_empty());
    }
}
