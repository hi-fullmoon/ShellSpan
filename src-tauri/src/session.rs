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
    include!("tests/session.rs");
}
