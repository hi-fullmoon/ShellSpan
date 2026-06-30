#[cfg(unix)]
use libc::{poll, pollfd, POLLIN, POLLOUT};
use log::{info, warn};
use ssh2::{Channel, ExtendedData, Session};
use std::{
    io::{ErrorKind, Read, Write},
    sync::mpsc::{Receiver, TryRecvError},
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;

#[cfg(unix)]
use ssh2::BlockDirections;
#[cfg(unix)]
use std::os::fd::AsRawFd;

use crate::{
    connection::{connect_tcp_stream, connect_through_jump_host, open_authenticated_session, summarize_session_request, SSH_SESSION_KEEPALIVE_INTERVAL_SECS},
    emit_data, emit_status,
    known_hosts::known_hosts_path,
    models::{ClosedReasonKind, SessionCommand, SessionCreateRequest, SessionStatus},
};

const SSH_IDLE_WAIT_SLICE_MS: u64 = 20;

pub(crate) fn run_ssh_session(
    app: &AppHandle,
    session_id: &str,
    request: &SessionCreateRequest,
    rx: Receiver<SessionCommand>,
) -> Result<Option<String>, String> {
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
    )?;

    let mut _jump_session_holder: Option<Box<ssh2::Session>> = None;
    let known_hosts = known_hosts_path(app).ok();
    let known_hosts_ref = known_hosts.as_deref();
    let session = if let Some(ref jump) = request.jump_host {
        let (jump_session, target_session) = connect_through_jump_host(
            jump,
            &request.host,
            request.port,
            &request.username,
            request.auth_method,
            request.password.as_deref(),
            request.private_key_path.as_deref(),
            request.passphrase.as_deref(),
            known_hosts_ref,
        )?;
        _jump_session_holder = Some(Box::new(jump_session));
        target_session
    } else {
        let tcp = connect_tcp_stream(&request.host, request.port)?;
        open_authenticated_session(
            tcp,
            &request.username,
            request.auth_method,
            request.password.as_deref(),
            request.private_key_path.as_deref(),
            request.passphrase.as_deref(),
            &request.host,
            request.port,
            known_hosts_ref,
        )?
    };

    let mut channel = session
        .channel_session()
        .map_err(|error| format!("failed to open ssh channel: {error}"))?;
    channel
        .request_pty(
            "xterm-256color",
            None,
            Some((request.terminal_cols, request.terminal_rows, 0, 0)),
        )
        .map_err(|error| format!("failed to allocate PTY: {error}"))?;
    channel
        .handle_extended_data(ExtendedData::Merge)
        .map_err(|error| format!("failed to configure extended-data mode: {error}"))?;
    channel
        .shell()
        .map_err(|error| format!("failed to start remote shell: {error}"))?;
    session.set_blocking(false);

    info!("SSH session connected session_id={session_id}");
    emit_status(
        app,
        session_id,
        SessionStatus::Connected,
        Some("shell ready".to_string()),
    )?;

    session_loop(app, session_id, &session, &mut channel, rx)
}

fn coalesce_write_commands(commands: Vec<SessionCommand>) -> Vec<SessionCommand> {
    let mut merged = Vec::with_capacity(commands.len());
    let mut pending_write = String::new();

    for command in commands {
        match command {
            SessionCommand::Write(data) => {
                pending_write.push_str(&data);
            }
            SessionCommand::Resize { cols, rows } => {
                if !pending_write.is_empty() {
                    merged.push(SessionCommand::Write(std::mem::take(&mut pending_write)));
                }
                merged.push(SessionCommand::Resize { cols, rows });
            }
            SessionCommand::Close => {
                if !pending_write.is_empty() {
                    merged.push(SessionCommand::Write(std::mem::take(&mut pending_write)));
                }
                merged.push(SessionCommand::Close);
            }
        }
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
) -> Result<Option<String>, String> {
    let mut buffer = [0u8; 8192];
    let mut next_keepalive_at =
        Instant::now() + normalize_keepalive_delay(SSH_SESSION_KEEPALIVE_INTERVAL_SECS);

    loop {
        let mut made_progress = false;
        let mut blocked_on_socket = false;
        let mut pending_commands = Vec::new();

        loop {
            match rx.try_recv() {
                Ok(command) => pending_commands.push(command),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    graceful_shutdown(channel);
                    return Ok(Some("session controller dropped".to_string()));
                }
            }
        }

        for command in coalesce_write_commands(pending_commands) {
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
                    graceful_shutdown(channel);
                    return Ok(Some("session closed locally".to_string()));
                }
            }
        }

        match channel.read(&mut buffer) {
            Ok(0) => {
                if channel.eof() {
                    return Ok(Some("remote shell exited".to_string()));
                }
            }
            Ok(read) => {
                let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
                emit_data(app, session_id, chunk)?;
                made_progress = true;
            }
            Err(error) if is_retryable_channel_error_kind(error.kind()) => {
                blocked_on_socket = true;
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

        let keepalive_due_in = Some(next_keepalive_at.saturating_duration_since(now));
        if let Some(wait_timeout) = session_idle_wait_timeout(blocked_on_socket, keepalive_due_in) {
            wait_for_session_socket(session, wait_timeout)?;
        } else {
            thread::yield_now();
        }
    }
}

fn session_idle_wait_timeout(
    blocked_on_socket: bool,
    keepalive_due_in: Option<Duration>,
) -> Option<Duration> {
    let socket_wait = blocked_on_socket.then_some(Duration::from_millis(SSH_IDLE_WAIT_SLICE_MS));
    let keepalive_wait = keepalive_due_in.filter(|wait| !wait.is_zero());

    match (socket_wait, keepalive_wait) {
        (Some(socket_wait), Some(keepalive_wait)) => Some(socket_wait.min(keepalive_wait)),
        (Some(socket_wait), None) => Some(socket_wait),
        (None, Some(keepalive_wait)) => Some(keepalive_wait),
        (None, None) => None,
    }
}

fn normalize_keepalive_delay(seconds: u32) -> Duration {
    Duration::from_secs(u64::from(seconds.max(1)))
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
    fn session_idle_wait_timeout_uses_short_slice_when_socket_is_blocked() {
        let wait = session_idle_wait_timeout(true, None)
            .expect("blocked sockets should use a short wait slice instead of busy spinning");

        assert_eq!(wait, Duration::from_millis(20));
    }

    #[test]
    fn session_idle_wait_timeout_skips_wait_when_no_signal_is_pending() {
        let wait = session_idle_wait_timeout(false, None);

        assert_eq!(wait, None);
    }

    #[test]
    fn session_idle_wait_timeout_prefers_earlier_keepalive_deadline() {
        let wait = session_idle_wait_timeout(true, Some(Duration::from_millis(8)))
            .expect("keepalive deadline should cap the socket wait");

        assert_eq!(wait, Duration::from_millis(8));
    }

    #[test]
    fn session_idle_wait_timeout_uses_keepalive_deadline_without_socket_block() {
        let wait = session_idle_wait_timeout(false, Some(Duration::from_secs(5)))
            .expect("keepalive should wake the loop even when the socket is idle");

        assert_eq!(wait, Duration::from_secs(5));
    }

    #[test]
    fn normalize_keepalive_delay_clamps_zero_to_one_second() {
        assert_eq!(normalize_keepalive_delay(0), Duration::from_secs(1));
        assert_eq!(normalize_keepalive_delay(7), Duration::from_secs(7));
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
    fn coalesce_write_commands_merges_adjacent_write_chunks() {
        let commands = vec![
            SessionCommand::Write("a".to_string()),
            SessionCommand::Write("bc".to_string()),
            SessionCommand::Write("123".to_string()),
        ];

        let merged = coalesce_write_commands(commands);

        assert_eq!(merged.len(), 1);
        match &merged[0] {
            SessionCommand::Write(data) => assert_eq!(data, "abc123"),
            _ => panic!("expected a single merged write command"),
        }
    }

    #[test]
    fn coalesce_write_commands_preserves_non_write_boundaries() {
        let commands = vec![
            SessionCommand::Write("ab".to_string()),
            SessionCommand::Resize {
                cols: 120,
                rows: 40,
            },
            SessionCommand::Write("cd".to_string()),
            SessionCommand::Close,
            SessionCommand::Write("ef".to_string()),
        ];

        let merged = coalesce_write_commands(commands);

        assert_eq!(merged.len(), 5);
        match &merged[0] {
            SessionCommand::Write(data) => assert_eq!(data, "ab"),
            _ => panic!("first command should stay write"),
        }
        match &merged[1] {
            SessionCommand::Resize { cols, rows } => {
                assert_eq!((cols, rows), (&120, &40));
            }
            _ => panic!("second command should stay resize"),
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
