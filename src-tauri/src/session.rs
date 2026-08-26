#[cfg(unix)]
use libc::{poll, pollfd, POLLIN, POLLOUT};
use log::{error, info, warn};
use ssh2::{BlockDirections, Channel, ExtendedData, Session};
use std::{
    io::{ErrorKind, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        mpsc::{Receiver, TryRecvError},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;

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
};

const SSH_IDLE_WAIT_SLICE_MS: u64 = 20;
const SSH_OUTPUT_FLUSH_THRESHOLD_BYTES: usize = 64 * 1024;
const SSH_OUTPUT_READY_TIMEOUT: Duration = Duration::from_secs(5);
const SSH_STARTUP_OUTPUT_BUFFER_LIMIT_BYTES: usize = 1_000_000;

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

pub(crate) fn run_ssh_session<F: FnOnce() + Send>(
    app: &AppHandle,
    session_id: &str,
    request: &SessionCreateRequest,
    rx: Receiver<SessionCommand>,
    wake: SessionWakeSource,
    output_ready: Arc<AtomicBool>,
    output_paused: Arc<AtomicBool>,
    on_connected: F,
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
        Ok(session) => {
            on_connected();
            session
        }
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
    channel.shell().map_err(|error| {
        error!("Failed to start remote shell session_id={session_id}: {error}");
        ConnectionError::Other {
            message: format!("failed to start remote shell: {error}"),
        }
    })?;
    session.set_blocking(false);

    info!("SSH session connected session_id={session_id}");
    emit_status(
        app,
        session_id,
        SessionStatus::Connected,
        Some("shell ready".to_string()),
    )
    .map_err(|message| ConnectionError::Other { message })?;

    session_loop(
        app,
        session_id,
        &session,
        &mut channel,
        rx,
        &wake,
        &output_ready,
        &output_paused,
    )
    .map_err(|message| ConnectionError::Other { message })
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

fn session_loop(
    app: &AppHandle,
    session_id: &str,
    session: &Session,
    channel: &mut Channel,
    rx: Receiver<SessionCommand>,
    wake: &SessionWakeSource,
    output_ready: &AtomicBool,
    output_paused: &AtomicBool,
) -> Result<Option<String>, String> {
    let mut pending_bytes: Vec<u8> = Vec::new();
    let mut pending_output = String::new();
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
) -> Result<Option<String>, String> {
    let mut buffer = [0u8; 8192];
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
}
