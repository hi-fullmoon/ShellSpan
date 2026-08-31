use crate::known_hosts::check_host_key_against_file;
use crate::models::{
    AuthMethod, ConnectedSftp, ConnectionError, ConnectionPreflightResult,
    ConnectionPreflightStatus, ConnectionPreflightStep, ConnectionPreflightStepId,
    ConnectionPreflightStepStatus, HostKeyCheckResult, HostKeyCheckStatus, JumpHostConfig,
    RemoteConnectionRequest, RemoteFsError, SessionCreateRequest,
};
use crate::sftp_pool::{connection_key, ConnectClaim, SftpPool, SFTP_POOL_GET_ABORTED_MESSAGE};
use log::{debug, error, warn};
use socket2::{SockRef, TcpKeepalive};
use ssh2::Session;
use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv6Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

const SSH_TCP_KEEPALIVE_TIME_SECS: u64 = 30;
const SSH_TCP_KEEPALIVE_INTERVAL_SECS: u64 = 15;
const SSH_SESSION_IO_TIMEOUT_MS: u32 = 15_000;
const SSH_TRANSFER_IO_TIMEOUT_MS: u32 = 120_000;
const JUMP_BRIDGE_RETRY_INTERVAL: Duration = Duration::from_millis(10);
pub(crate) const SSH_SESSION_KEEPALIVE_INTERVAL_SECS: u32 = 30;

pub(crate) struct TransferTimeoutGuard<'a> {
    session: &'a Session,
    previous_timeout_ms: u32,
}

impl<'a> TransferTimeoutGuard<'a> {
    pub(crate) fn new(session: &'a Session) -> Self {
        let previous_timeout_ms = session.timeout();
        session.set_timeout(SSH_TRANSFER_IO_TIMEOUT_MS);
        Self {
            session,
            previous_timeout_ms,
        }
    }
}

impl Drop for TransferTimeoutGuard<'_> {
    fn drop(&mut self) {
        self.session.set_timeout(self.previous_timeout_ms);
    }
}

pub(crate) fn connect_sftp(
    request: &RemoteConnectionRequest,
    pool: Option<&SftpPool>,
    known_hosts_path: Option<&Path>,
) -> Result<Arc<Mutex<ConnectedSftp>>, RemoteFsError> {
    connect_sftp_with_abort(request, pool, known_hosts_path, None)
}

pub(crate) fn connect_sftp_with_abort(
    request: &RemoteConnectionRequest,
    pool: Option<&SftpPool>,
    known_hosts_path: Option<&Path>,
    abort_flag: Option<&AtomicBool>,
) -> Result<Arc<Mutex<ConnectedSftp>>, RemoteFsError> {
    connect_sftp_inner(request, pool, known_hosts_path, abort_flag)
        .map_err(RemoteFsError::from_connection_error)
}

fn connect_sftp_inner(
    request: &RemoteConnectionRequest,
    pool: Option<&SftpPool>,
    known_hosts_path: Option<&Path>,
    abort_flag: Option<&AtomicBool>,
) -> Result<Arc<Mutex<ConnectedSftp>>, ConnectionError> {
    validate_connection_fields(&request.host, &request.username)
        .map_err(|message| ConnectionError::Other { message })?;
    if let Some(ref jump) = request.jump_host {
        // The jump host is a network endpoint too: apply the same field and
        // blocked-host validation as the target host.
        validate_connection_fields(&jump.host, &jump.username)
            .map_err(|message| ConnectionError::Other { message })?;
    }
    debug!(
        "Connecting SFTP {}",
        summarize_remote_connection_request(request)
    );

    if let Some(pool) = pool {
        let lookup_cached = || match abort_flag {
            Some(_) => pool.get_with_abort(request, abort_flag),
            None => Ok(pool.get(request)),
        };
        if let Some(cached) = lookup_cached()? {
            return Ok(cached);
        };
        ensure_sftp_connect_not_aborted(abort_flag)?;
        // Deduplicate concurrent handshakes: one caller leads, the rest wait.
        let key = connection_key(request);
        return match pool.begin_connect(&key) {
            // The guard must stay bound across the handshake: if
            // create_sftp_connection panics, dropping it fails the slot so
            // followers do not wait forever.
            ConnectClaim::Leader(guard) => {
                // Close the get-miss/begin-connect race: another leader can
                // finish after our first lookup but before this claim. Recheck
                // while our slot prevents any new leader from starting, then
                // publish that cached connection to followers instead of
                // performing a redundant handshake. Once leadership is
                // claimed, complete a genuinely needed handshake even if this
                // caller becomes stale: a current follower may already depend
                // on the same reusable result and must not inherit the stale
                // caller's cancellation.
                let result = reuse_raced_pool_entry_or_connect(pool.get(request), || {
                    create_sftp_connection(request, known_hosts_path)
                });
                pool.finish_connect(&guard, result)
            }
            ConnectClaim::Follower(slot) => pool.wait_connect(&key, slot, abort_flag),
        };
    }

    ensure_sftp_connect_not_aborted(abort_flag)?;
    create_sftp_connection(request, known_hosts_path)
}

fn reuse_raced_pool_entry_or_connect<T, E>(
    cached: Option<T>,
    connect: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    match cached {
        Some(cached) => Ok(cached),
        None => connect(),
    }
}

fn ensure_sftp_connect_not_aborted(abort_flag: Option<&AtomicBool>) -> Result<(), ConnectionError> {
    if abort_flag.is_some_and(|flag| flag.load(AtomicOrdering::SeqCst)) {
        return Err(ConnectionError::Other {
            message: SFTP_POOL_GET_ABORTED_MESSAGE.to_string(),
        });
    }
    Ok(())
}

fn create_sftp_connection(
    request: &RemoteConnectionRequest,
    known_hosts_path: Option<&Path>,
) -> Result<Arc<Mutex<ConnectedSftp>>, ConnectionError> {
    let (session, jump_session) = if let Some(ref jump) = request.jump_host {
        let (jump_session, target_session) = connect_through_jump_host(
            jump,
            &request.host,
            request.port,
            &request.username,
            request.auth_method,
            request.password.as_deref(),
            request.private_key_data.as_deref(),
            request.passphrase.as_deref(),
            known_hosts_path,
        )?;
        (target_session, Some(jump_session))
    } else {
        let tcp = connect_tcp_stream(&request.host, request.port)
            .map_err(|message| ConnectionError::Other { message })?;
        let session = open_authenticated_session(
            tcp,
            &request.username,
            request.auth_method,
            request.password.as_deref(),
            request.private_key_data.as_deref(),
            request.passphrase.as_deref(),
            &request.host,
            request.port,
            known_hosts_path,
        )?;
        (session, None)
    };

    let sftp = session.sftp().map_err(|error| ConnectionError::Other {
        message: format!("failed to open sftp subsystem: {error}"),
    })?;

    let connected = Arc::new(Mutex::new(ConnectedSftp {
        session,
        sftp,
        _jump_session: jump_session,
    }));

    debug!(
        "Connected SFTP host={} port={} username={}",
        request.host, request.port, request.username
    );

    Ok(connected)
}

pub(crate) fn validate_connection_fields(host: &str, username: &str) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("host is required".to_string());
    }
    if username.trim().is_empty() {
        return Err("username is required".to_string());
    }
    if is_blocked_host(host) {
        return Err(format!("connections to {host} are blocked"));
    }
    Ok(())
}

pub(crate) fn validate_host(host: &str) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("host is required".to_string());
    }
    if is_blocked_host(host) {
        return Err(format!("connections to {host} are blocked"));
    }
    Ok(())
}

fn is_blocked_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    if lower == "metadata.google.internal" {
        return true;
    }
    let candidate = lower
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let candidate = candidate.split('/').next().unwrap_or(candidate);
    let candidate = strip_port(candidate);
    // AWS metadata endpoint: an IPv6 unique-local address that falls outside
    // the standard blocked ranges below.
    if candidate == "fd00:ec2::254" {
        return true;
    }
    match candidate.parse::<IpAddr>() {
        Ok(ip) => is_blocked_ip(normalize_ip(ip)),
        Err(_) => false,
    }
}

/// Collapse IPv4-mapped IPv6 addresses (e.g. ::ffff:169.254.169.254) so the
/// range checks cannot be bypassed with a mapped spelling.
fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    }
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    // Link-local covers the cloud metadata endpoints (169.254.0.0/16,
    // fe80::/10). Loopback is intentionally allowed: this is a user-driven
    // desktop SSH/SFTP client, and connecting to 127.0.0.1 / ::1 is a
    // legitimate use case (local VMs, tunnels, dev servers).
    match ip {
        IpAddr::V4(v4) => v4.is_link_local() || v4.is_unspecified(),
        IpAddr::V6(v6) => v6.is_unspecified() || is_ipv6_link_local(&v6),
    }
}

/// fe80::/10 — `Ipv6Addr::is_unicast_link_local` is not stable yet.
fn is_ipv6_link_local(addr: &Ipv6Addr) -> bool {
    (addr.segments()[0] & 0xffc0) == 0xfe80
}

fn strip_port(host: &str) -> &str {
    if host.starts_with('[') {
        if let Some(end) = host.find(']') {
            return &host[1..end];
        }
        return host;
    }
    if host.matches(':').count() == 1 {
        if let Some(idx) = host.find(':') {
            return &host[..idx];
        }
    }
    host
}

fn has_secret_value(value: Option<&str>) -> bool {
    value.is_some_and(|item| !item.trim().is_empty())
}

fn summarize_connection_fields(
    host: &str,
    port: u16,
    username: &str,
    auth_method: AuthMethod,
    password: Option<&str>,
    private_key_data: Option<&str>,
    passphrase: Option<&str>,
) -> String {
    format!(
        "host={} port={} username={} auth_method={} has_password={} has_private_key_data={} has_passphrase={}",
        host.trim(),
        port,
        username.trim(),
        auth_method.as_str(),
        has_secret_value(password),
        has_secret_value(private_key_data),
        has_secret_value(passphrase),
    )
}

pub(crate) fn summarize_session_request(request: &SessionCreateRequest) -> String {
    let connection = summarize_connection_fields(
        &request.host,
        request.port,
        &request.username,
        request.auth_method,
        request.password.as_deref(),
        request.private_key_data.as_deref(),
        request.passphrase.as_deref(),
    );
    let operation_id = request
        .operation_id
        .as_deref()
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        })
        .unwrap_or("untracked");
    format!("operation_id={operation_id} {connection}")
}

pub(crate) fn summarize_remote_connection_request(request: &RemoteConnectionRequest) -> String {
    summarize_connection_fields(
        &request.host,
        request.port,
        &request.username,
        request.auth_method,
        request.password.as_deref(),
        request.private_key_data.as_deref(),
        request.passphrase.as_deref(),
    )
}

pub(crate) fn connect_tcp_stream(host: &str, port: u16) -> Result<TcpStream, String> {
    let socket_addrs = resolve_socket_addresses(host, port)?;
    let address = format!("{}:{port}", format_host_for_socket_address(host));
    debug!("Opening TCP connection address={address}");

    // Try every resolved address (e.g. IPv6 then IPv4) instead of giving up
    // on the first one.
    let mut last_error = None;
    for socket_addr in socket_addrs {
        match TcpStream::connect_timeout(&socket_addr, Duration::from_secs(12)) {
            Ok(tcp) => {
                configure_tcp_stream(&tcp).map_err(|error| {
                    format!("failed to configure TCP socket for {address}: {error}")
                })?;
                return Ok(tcp);
            }
            Err(error) => {
                debug!("TCP connect to {socket_addr} failed: {error}");
                last_error = Some(error);
            }
        }
    }

    Err(format!(
        "failed to connect to {address}: {}",
        last_error.expect("at least one address was attempted")
    ))
}

pub(crate) fn resolve_socket_addresses(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    validate_host(host)?;
    let address = format!("{}:{port}", format_host_for_socket_address(host));
    let socket_addrs: Vec<_> = address
        .as_str()
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve {address}: {error}"))?
        .collect();
    if socket_addrs.is_empty() {
        return Err(format!("no socket address found for {address}"));
    }

    for socket_addr in &socket_addrs {
        if is_blocked_ip(normalize_ip(socket_addr.ip())) {
            return Err(format!("connections to {} are blocked", socket_addr.ip()));
        }
    }
    Ok(socket_addrs)
}

fn format_host_for_socket_address(host: &str) -> String {
    if host.parse::<Ipv6Addr>().is_ok() {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn configure_tcp_stream(tcp: &TcpStream) -> std::io::Result<()> {
    tcp.set_nodelay(true)?;

    let keepalive = TcpKeepalive::new()
        .with_time(Duration::from_secs(SSH_TCP_KEEPALIVE_TIME_SECS))
        .with_interval(Duration::from_secs(SSH_TCP_KEEPALIVE_INTERVAL_SECS));

    SockRef::from(tcp).set_tcp_keepalive(&keepalive)?;
    Ok(())
}

pub(crate) fn open_authenticated_session(
    tcp: TcpStream,
    username: &str,
    auth_method: AuthMethod,
    password: Option<&str>,
    private_key_data: Option<&str>,
    passphrase: Option<&str>,
    host: &str,
    port: u16,
    known_hosts_path: Option<&Path>,
) -> Result<Session, ConnectionError> {
    debug!(
        "Opening authenticated SSH session username={} auth_method={}",
        username,
        auth_method.as_str()
    );
    let mut session = open_handshaken_session(tcp, host, port)?;

    if let Some(path) = known_hosts_path {
        verify_session_host_key(&session, host, port, path)?;
    }

    authenticate(
        &mut session,
        username,
        auth_method,
        password,
        private_key_data,
        passphrase,
    )
    .map_err(|message| ConnectionError::Other { message })?;

    debug!(
        "SSH authentication succeeded username={} auth_method={}",
        username,
        auth_method.as_str()
    );
    session.set_keepalive(true, SSH_SESSION_KEEPALIVE_INTERVAL_SECS);
    Ok(session)
}

fn open_handshaken_session(
    tcp: TcpStream,
    host: &str,
    port: u16,
) -> Result<Session, ConnectionError> {
    let mut session = Session::new().map_err(|error| ConnectionError::Other {
        message: format!("session init failed: {error}"),
    })?;
    session.set_tcp_stream(tcp);
    session.set_timeout(SSH_SESSION_IO_TIMEOUT_MS);
    session.handshake().map_err(|error| {
        error!("SSH handshake failed remote={host}:{port}: {error}");
        ConnectionError::Other {
            message: format!("ssh handshake failed: {error}"),
        }
    })?;

    Ok(session)
}

fn verify_session_host_key(
    session: &Session,
    host: &str,
    port: u16,
    known_hosts_path: &Path,
) -> Result<HostKeyCheckResult, ConnectionError> {
    match check_host_key_against_file(session, host, port, known_hosts_path) {
        Ok(result) => Ok(result),
        Err(result) => match result.status {
            HostKeyCheckStatus::NotFound => Err(ConnectionError::HostKeyUnknown {
                host: host.to_string(),
                port,
                fingerprint: result.fingerprint,
            }),
            HostKeyCheckStatus::Mismatch => Err(ConnectionError::HostKeyMismatch {
                host: host.to_string(),
                port,
                fingerprint: result.fingerprint,
            }),
            _ => Err(ConnectionError::Other {
                message: result
                    .message
                    .unwrap_or_else(|| "host key check failed".to_string()),
            }),
        },
    }
}

pub(crate) fn open_session_for_host_key(host: &str, port: u16) -> Result<Session, String> {
    debug!("Opening SSH session for host key check host={host} port={port}");
    let tcp = connect_tcp_stream(host, port)?;
    let mut session = Session::new().map_err(|error| format!("session init failed: {error}"))?;
    session.set_tcp_stream(tcp);
    session.set_timeout(SSH_SESSION_IO_TIMEOUT_MS);
    session
        .handshake()
        .map_err(|error| format!("ssh handshake failed: {error}"))?;
    Ok(session)
}

#[cfg(test)]
pub(crate) fn trusted_known_hosts_fixture(
    host: &str,
    port: u16,
) -> (tempfile::TempDir, std::path::PathBuf) {
    use ssh2::{KnownHostFileKind, KnownHostKeyFormat};

    let temp = tempfile::tempdir().expect("create isolated known-hosts directory");
    let path = temp.path().join("known_hosts");
    let handshake = open_session_for_host_key(host, port).expect("read isolated host key");
    let (key, key_type) = handshake.host_key().expect("server exposes a host key");
    let key_format = match key_type {
        ssh2::HostKeyType::Rsa => KnownHostKeyFormat::SshRsa,
        ssh2::HostKeyType::Dss => KnownHostKeyFormat::SshDss,
        ssh2::HostKeyType::Ecdsa256 => KnownHostKeyFormat::Ecdsa256,
        ssh2::HostKeyType::Ecdsa384 => KnownHostKeyFormat::Ecdsa384,
        ssh2::HostKeyType::Ecdsa521 => KnownHostKeyFormat::Ecdsa521,
        ssh2::HostKeyType::Ed25519 => KnownHostKeyFormat::Ed25519,
        ssh2::HostKeyType::Unknown => KnownHostKeyFormat::Unknown,
    };
    let host_with_port = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    let mut known_hosts = handshake.known_hosts().expect("initialize known hosts");
    known_hosts
        .add(&host_with_port, key, &host_with_port, key_format)
        .expect("trust isolated host key");
    known_hosts
        .write_file(&path, KnownHostFileKind::OpenSSH)
        .expect("persist isolated host key");
    (temp, path)
}

pub(crate) fn connect_through_jump_host(
    jump: &JumpHostConfig,
    target_host: &str,
    target_port: u16,
    target_username: &str,
    target_auth_method: AuthMethod,
    target_password: Option<&str>,
    target_private_key_data: Option<&str>,
    target_passphrase: Option<&str>,
    known_hosts_path: Option<&Path>,
) -> Result<(Session, Session), ConnectionError> {
    debug!(
        "Connecting through jump host {}:{} to target {}:{}",
        jump.host, jump.port, target_host, target_port
    );

    // 1. Connect to jump host
    let jump_tcp = connect_tcp_stream(&jump.host, jump.port)
        .map_err(|message| ConnectionError::Other { message })?;
    let jump_session = open_authenticated_session(
        jump_tcp,
        &jump.username,
        jump.auth_method,
        jump.password.as_deref(),
        jump.private_key_data.as_deref(),
        jump.passphrase.as_deref(),
        &jump.host,
        jump.port,
        known_hosts_path,
    )?;

    let client_stream = open_jump_bridge(&jump_session, target_host, target_port)?;

    // Open authenticated session on the client side of the bridge.
    let target_session = open_authenticated_session(
        client_stream,
        target_username,
        target_auth_method,
        target_password,
        target_private_key_data,
        target_passphrase,
        target_host,
        target_port,
        known_hosts_path,
    )?;

    debug!("Connected to target through jump host successfully");
    Ok((jump_session, target_session))
}

fn open_jump_bridge(
    jump_session: &Session,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream, ConnectionError> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| ConnectionError::Other {
        message: format!("failed to bind local bridge socket: {e}"),
    })?;
    let local_port = listener
        .local_addr()
        .map_err(|e| ConnectionError::Other {
            message: format!("failed to get local bridge address: {e}"),
        })?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|e| ConnectionError::Other {
            message: format!("failed to set bridge listener nonblocking: {e}"),
        })?;

    // Open direct-tcpip through the jump host. The target hostname is resolved
    // by that host, which is why preflight reports local target DNS as delegated.
    let channel = jump_session
        .channel_direct_tcpip(target_host, target_port, Some(("127.0.0.1", local_port)))
        .map_err(|e| ConnectionError::Other {
            message: format!("failed to open direct-tcpip through jump host: {e}"),
        })?;

    // libssh2 serializes operations for a Session. In blocking mode the
    // channel -> TCP reader can hold that session while waiting for the target
    // server, preventing the TCP -> channel writer from forwarding the target
    // client's initial SSH handshake bytes. Keep the bridge channel
    // nonblocking so both directions can make progress on the shared session.
    jump_session.set_blocking(false);

    // Accept and bridge concurrently with the client connect below.
    let bridge_handle = thread::spawn(move || {
        match accept_bridge_with_timeout(&listener, Duration::from_secs(15)) {
            Ok(server_stream) => {
                if let Err(error) = bridge_channel_tcp(channel, server_stream) {
                    warn!("Jump host bridge thread ended with error: {error}");
                }
            }
            Err(error) => {
                warn!("Jump host bridge accept failed: {error}");
            }
        }
    });

    let client_stream =
        TcpStream::connect(("127.0.0.1", local_port)).map_err(|e| ConnectionError::Other {
            message: format!("failed to connect to bridge socket: {e}"),
        })?;
    configure_tcp_stream(&client_stream).map_err(|e| ConnectionError::Other {
        message: format!("failed to configure bridge client socket: {e}"),
    })?;

    // Detach the bridge; it exits when either SSH session drops.
    drop(bridge_handle);
    Ok(client_stream)
}

fn accept_bridge_with_timeout(
    listener: &TcpListener,
    timeout: Duration,
) -> Result<TcpStream, std::io::Error> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok((stream, _)) => return Ok(stream),
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "bridge accept timed out",
                    ));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e),
        }
    }
}

fn bridge_channel_tcp(mut channel: ssh2::Channel, mut tcp: TcpStream) -> Result<(), String> {
    tcp.set_nonblocking(true)
        .map_err(|error| format!("failed to set bridge TCP stream nonblocking: {error}"))?;

    // A Session owns one libssh2 transport and serializes every channel call.
    // Pump both directions on one thread so a blocking read can never hold the
    // session lock while the peer's SSH banner is waiting to be written. The
    // fixed buffers also keep backpressure bounded for long-lived sessions.
    let mut tcp_to_channel = [0u8; 64 * 1024];
    let mut tcp_to_channel_start = 0;
    let mut tcp_to_channel_end = 0;
    let mut channel_to_tcp = [0u8; 64 * 1024];
    let mut channel_to_tcp_start = 0;
    let mut channel_to_tcp_end = 0;
    let mut closing = false;

    loop {
        let mut progressed = false;

        if !closing && tcp_to_channel_start == tcp_to_channel_end {
            tcp_to_channel_start = 0;
            tcp_to_channel_end = 0;
            match tcp.read(&mut tcp_to_channel) {
                Ok(0) => closing = true,
                Ok(count) => {
                    tcp_to_channel_end = count;
                    progressed = true;
                }
                Err(error) if is_bridge_retryable(&error) => {}
                Err(error) => return Err(format!("bridge TCP read failed: {error}")),
            }
        }

        if tcp_to_channel_start < tcp_to_channel_end {
            match channel.write(&tcp_to_channel[tcp_to_channel_start..tcp_to_channel_end]) {
                Ok(0) => return Err("bridge channel write returned zero bytes".to_string()),
                Ok(count) => {
                    tcp_to_channel_start += count;
                    progressed = true;
                }
                Err(error) if is_bridge_retryable(&error) => {}
                Err(error) => return Err(format!("bridge channel write failed: {error}")),
            }
        }

        if !closing && channel_to_tcp_start == channel_to_tcp_end {
            channel_to_tcp_start = 0;
            channel_to_tcp_end = 0;
            match channel.read(&mut channel_to_tcp) {
                Ok(0) => closing = true,
                Ok(count) => {
                    channel_to_tcp_end = count;
                    progressed = true;
                }
                Err(error) if is_bridge_retryable(&error) => {}
                Err(error) => return Err(format!("bridge channel read failed: {error}")),
            }
        }

        if channel_to_tcp_start < channel_to_tcp_end {
            match tcp.write(&channel_to_tcp[channel_to_tcp_start..channel_to_tcp_end]) {
                Ok(0) => return Err("bridge TCP write returned zero bytes".to_string()),
                Ok(count) => {
                    channel_to_tcp_start += count;
                    progressed = true;
                }
                Err(error) if is_bridge_retryable(&error) => {}
                Err(error) => return Err(format!("bridge TCP write failed: {error}")),
            }
        }

        if closing
            && tcp_to_channel_start == tcp_to_channel_end
            && channel_to_tcp_start == channel_to_tcp_end
        {
            return Ok(());
        }

        if !progressed {
            thread::sleep(JUMP_BRIDGE_RETRY_INTERVAL);
        }
    }
}

// Both sides of the jump bridge are nonblocking. WouldBlock is expected while
// either side is idle. TimedOut remains retryable for compatibility with any
// stream implementation that retains a socket timeout.
fn is_bridge_retryable(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    )
}

fn authenticate(
    session: &mut Session,
    username: &str,
    auth_method: AuthMethod,
    password: Option<&str>,
    private_key_data: Option<&str>,
    passphrase: Option<&str>,
) -> Result<(), String> {
    match auth_method {
        AuthMethod::Password => {
            let password = password
                .ok_or_else(|| "password auth selected, but no password provided".to_string())?;
            session
                .userauth_password(username, password)
                .map_err(|error| {
                    warn!(
                        "SSH authentication failed username={} method={}: {error}",
                        username,
                        auth_method.as_str()
                    );
                    format!("password auth failed: {error}")
                })?;
        }
        AuthMethod::Key => {
            let key_data = private_key_data
                .ok_or_else(|| "private key auth selected, but no key data provided".to_string())?;
            session
                .userauth_pubkey_memory(username, None, key_data, passphrase)
                .map_err(|error| {
                    warn!(
                        "SSH authentication failed username={} method={} source=keychain: {error}",
                        username,
                        auth_method.as_str()
                    );
                    format!("private key auth failed: {error}")
                })?;
        }
    }

    if session.authenticated() {
        Ok(())
    } else {
        Err("ssh authentication failed".to_string())
    }
}

struct PreflightRecorder {
    operation_id: String,
    expected: Vec<ConnectionPreflightStepId>,
    steps: Vec<ConnectionPreflightStep>,
}

impl PreflightRecorder {
    fn new(operation_id: String, uses_jump_host: bool) -> Self {
        let mut expected = vec![
            ConnectionPreflightStepId::Dns,
            ConnectionPreflightStepId::Tcp,
        ];
        if uses_jump_host {
            expected.extend([
                ConnectionPreflightStepId::JumpHostKey,
                ConnectionPreflightStepId::JumpAuthentication,
                ConnectionPreflightStepId::JumpTunnel,
            ]);
        }
        expected.extend([
            ConnectionPreflightStepId::HostKey,
            ConnectionPreflightStepId::Authentication,
        ]);
        Self {
            operation_id,
            expected,
            steps: Vec::new(),
        }
    }

    fn push(
        &mut self,
        id: ConnectionPreflightStepId,
        status: ConnectionPreflightStepStatus,
        detail: impl Into<String>,
        endpoint: Option<(&str, u16)>,
        fingerprint: Option<String>,
        trustable: bool,
    ) {
        self.steps.push(ConnectionPreflightStep {
            id,
            status,
            detail: detail.into(),
            host: endpoint.map(|(host, _)| host.to_string()),
            port: endpoint.map(|(_, port)| port),
            fingerprint,
            trustable,
        });
    }

    fn finish(
        mut self,
        status: ConnectionPreflightStatus,
        blocked_reason: &str,
    ) -> ConnectionPreflightResult {
        let completed: Vec<_> = self.steps.iter().map(|step| step.id).collect();
        for id in self.expected.clone() {
            if !completed.contains(&id) {
                self.push(
                    id,
                    ConnectionPreflightStepStatus::Blocked,
                    blocked_reason,
                    None,
                    None,
                    false,
                );
            }
        }
        ConnectionPreflightResult {
            operation_id: self.operation_id,
            status,
            checked_at: crate::db::current_timestamp_ms(),
            steps: self.steps,
        }
    }
}

fn cancelled_preflight(recorder: PreflightRecorder) -> ConnectionPreflightResult {
    recorder.finish(
        ConnectionPreflightStatus::Cancelled,
        "Not run because the preflight was cancelled by the user.",
    )
}

fn verify_preflight_host_key(
    recorder: &mut PreflightRecorder,
    id: ConnectionPreflightStepId,
    session: &Session,
    host: &str,
    port: u16,
    known_hosts_path: &Path,
) -> Option<ConnectionPreflightStatus> {
    let result = match check_host_key_against_file(session, host, port, known_hosts_path) {
        Ok(result) | Err(result) => result,
    };
    match result.status {
        HostKeyCheckStatus::Match => {
            recorder.push(
                id,
                ConnectionPreflightStepStatus::Passed,
                "The presented host key matches the trusted key.",
                Some((host, port)),
                result.fingerprint,
                false,
            );
            None
        }
        HostKeyCheckStatus::NotFound => {
            recorder.push(
                id,
                ConnectionPreflightStepStatus::Warning,
                result.message.unwrap_or_else(|| {
                    "The host key is not trusted yet; credentials were not sent.".to_string()
                }),
                Some((host, port)),
                result.fingerprint,
                true,
            );
            Some(ConnectionPreflightStatus::Attention)
        }
        HostKeyCheckStatus::Mismatch => {
            recorder.push(
                id,
                ConnectionPreflightStepStatus::Failed,
                result.message.unwrap_or_else(|| {
                    "The presented host key does not match the trusted key.".to_string()
                }),
                Some((host, port)),
                result.fingerprint,
                false,
            );
            Some(ConnectionPreflightStatus::Failed)
        }
        HostKeyCheckStatus::Failure => {
            recorder.push(
                id,
                ConnectionPreflightStepStatus::Failed,
                result
                    .message
                    .unwrap_or_else(|| "The host key could not be verified.".to_string()),
                Some((host, port)),
                result.fingerprint,
                false,
            );
            Some(ConnectionPreflightStatus::Failed)
        }
    }
}

/// Performs an explicit, read-only connection preflight. Credentials are only
/// sent after the corresponding host key is already trusted.
pub(crate) fn preflight_connection(
    request: RemoteConnectionRequest,
    operation_id: String,
    known_hosts_path: &Path,
    cancel_flag: &AtomicBool,
) -> ConnectionPreflightResult {
    let uses_jump_host = request.jump_host.is_some();
    let mut recorder = PreflightRecorder::new(operation_id, uses_jump_host);
    if let Err(message) = validate_connection_fields(&request.host, &request.username) {
        recorder.push(
            ConnectionPreflightStepId::Dns,
            ConnectionPreflightStepStatus::Failed,
            message,
            Some((&request.host, request.port)),
            None,
            false,
        );
        return recorder.finish(
            ConnectionPreflightStatus::Failed,
            "Not run because validation failed.",
        );
    }
    if let Some(jump) = &request.jump_host {
        if let Err(message) = validate_connection_fields(&jump.host, &jump.username) {
            recorder.push(
                ConnectionPreflightStepId::Dns,
                ConnectionPreflightStepStatus::Failed,
                message,
                Some((&jump.host, jump.port)),
                None,
                false,
            );
            return recorder.finish(
                ConnectionPreflightStatus::Failed,
                "Not run because jump-host validation failed.",
            );
        }
    }
    if cancel_flag.load(AtomicOrdering::SeqCst) {
        return cancelled_preflight(recorder);
    }

    let (network_host, network_port) = request
        .jump_host
        .as_ref()
        .map_or((&request.host, request.port), |jump| {
            (&jump.host, jump.port)
        });
    let addresses = match resolve_socket_addresses(network_host, network_port) {
        Ok(addresses) => addresses,
        Err(message) => {
            recorder.push(
                ConnectionPreflightStepId::Dns,
                ConnectionPreflightStepStatus::Failed,
                message,
                Some((network_host, network_port)),
                None,
                false,
            );
            return recorder.finish(
                ConnectionPreflightStatus::Failed,
                "Not run because name resolution failed.",
            );
        }
    };
    let address_summary = addresses
        .iter()
        .take(4)
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let dns_detail = if uses_jump_host {
        format!(
            "Jump host resolved to {address_summary}. Target DNS resolution is delegated through the jump tunnel."
        )
    } else {
        format!("Resolved to {address_summary}.")
    };
    recorder.push(
        ConnectionPreflightStepId::Dns,
        ConnectionPreflightStepStatus::Passed,
        dns_detail,
        Some((network_host, network_port)),
        None,
        false,
    );
    if cancel_flag.load(AtomicOrdering::SeqCst) {
        return cancelled_preflight(recorder);
    }

    let tcp = match connect_tcp_stream(network_host, network_port) {
        Ok(tcp) => tcp,
        Err(message) => {
            recorder.push(
                ConnectionPreflightStepId::Tcp,
                ConnectionPreflightStepStatus::Failed,
                message,
                Some((network_host, network_port)),
                None,
                false,
            );
            return recorder.finish(
                ConnectionPreflightStatus::Failed,
                "Not run because TCP connectivity failed.",
            );
        }
    };
    recorder.push(
        ConnectionPreflightStepId::Tcp,
        ConnectionPreflightStepStatus::Passed,
        "The SSH TCP port accepted a connection.",
        Some((network_host, network_port)),
        None,
        false,
    );
    if cancel_flag.load(AtomicOrdering::SeqCst) {
        return cancelled_preflight(recorder);
    }

    let endpoint_session = match open_handshaken_session(tcp, network_host, network_port) {
        Ok(session) => session,
        Err(error) => {
            let id = if uses_jump_host {
                ConnectionPreflightStepId::JumpHostKey
            } else {
                ConnectionPreflightStepId::HostKey
            };
            recorder.push(
                id,
                ConnectionPreflightStepStatus::Failed,
                error.message(),
                Some((network_host, network_port)),
                None,
                false,
            );
            return recorder.finish(
                ConnectionPreflightStatus::Failed,
                "Not run because the SSH handshake failed.",
            );
        }
    };

    if let Some(jump) = &request.jump_host {
        if let Some(status) = verify_preflight_host_key(
            &mut recorder,
            ConnectionPreflightStepId::JumpHostKey,
            &endpoint_session,
            &jump.host,
            jump.port,
            known_hosts_path,
        ) {
            return recorder.finish(status, "Not run because the jump-host key is not trusted.");
        }
        if cancel_flag.load(AtomicOrdering::SeqCst) {
            return cancelled_preflight(recorder);
        }
        let mut jump_session = endpoint_session;
        if let Err(message) = authenticate(
            &mut jump_session,
            &jump.username,
            jump.auth_method,
            jump.password.as_deref(),
            jump.private_key_data.as_deref(),
            jump.passphrase.as_deref(),
        ) {
            recorder.push(
                ConnectionPreflightStepId::JumpAuthentication,
                ConnectionPreflightStepStatus::Failed,
                message,
                Some((&jump.host, jump.port)),
                None,
                false,
            );
            return recorder.finish(
                ConnectionPreflightStatus::Failed,
                "Not run because jump-host authentication failed.",
            );
        }
        recorder.push(
            ConnectionPreflightStepId::JumpAuthentication,
            ConnectionPreflightStepStatus::Passed,
            "Jump-host authentication succeeded.",
            Some((&jump.host, jump.port)),
            None,
            false,
        );
        if cancel_flag.load(AtomicOrdering::SeqCst) {
            return cancelled_preflight(recorder);
        }
        let target_tcp = match open_jump_bridge(&jump_session, &request.host, request.port) {
            Ok(tcp) => tcp,
            Err(error) => {
                recorder.push(
                    ConnectionPreflightStepId::JumpTunnel,
                    ConnectionPreflightStepStatus::Failed,
                    error.message(),
                    Some((&request.host, request.port)),
                    None,
                    false,
                );
                return recorder.finish(
                    ConnectionPreflightStatus::Failed,
                    "Not run because the jump tunnel failed.",
                );
            }
        };
        recorder.push(
            ConnectionPreflightStepId::JumpTunnel,
            ConnectionPreflightStepStatus::Passed,
            "The jump host opened a direct TCP tunnel to the target.",
            Some((&request.host, request.port)),
            None,
            false,
        );
        if cancel_flag.load(AtomicOrdering::SeqCst) {
            return cancelled_preflight(recorder);
        }
        let mut target_session =
            match open_handshaken_session(target_tcp, &request.host, request.port) {
                Ok(session) => session,
                Err(error) => {
                    recorder.push(
                        ConnectionPreflightStepId::HostKey,
                        ConnectionPreflightStepStatus::Failed,
                        error.message(),
                        Some((&request.host, request.port)),
                        None,
                        false,
                    );
                    return recorder.finish(
                        ConnectionPreflightStatus::Failed,
                        "Not run because the target SSH handshake failed.",
                    );
                }
            };
        if let Some(status) = verify_preflight_host_key(
            &mut recorder,
            ConnectionPreflightStepId::HostKey,
            &target_session,
            &request.host,
            request.port,
            known_hosts_path,
        ) {
            return recorder.finish(
                status,
                "Authentication was not attempted because the target key is not trusted.",
            );
        }
        if let Err(message) = authenticate(
            &mut target_session,
            &request.username,
            request.auth_method,
            request.password.as_deref(),
            request.private_key_data.as_deref(),
            request.passphrase.as_deref(),
        ) {
            recorder.push(
                ConnectionPreflightStepId::Authentication,
                ConnectionPreflightStepStatus::Failed,
                message,
                Some((&request.host, request.port)),
                None,
                false,
            );
            return recorder.finish(
                ConnectionPreflightStatus::Failed,
                "Connection preflight failed.",
            );
        }
    } else {
        let mut target_session = endpoint_session;
        if let Some(status) = verify_preflight_host_key(
            &mut recorder,
            ConnectionPreflightStepId::HostKey,
            &target_session,
            &request.host,
            request.port,
            known_hosts_path,
        ) {
            return recorder.finish(
                status,
                "Authentication was not attempted because the host key is not trusted.",
            );
        }
        if let Err(message) = authenticate(
            &mut target_session,
            &request.username,
            request.auth_method,
            request.password.as_deref(),
            request.private_key_data.as_deref(),
            request.passphrase.as_deref(),
        ) {
            recorder.push(
                ConnectionPreflightStepId::Authentication,
                ConnectionPreflightStepStatus::Failed,
                message,
                Some((&request.host, request.port)),
                None,
                false,
            );
            return recorder.finish(
                ConnectionPreflightStatus::Failed,
                "Connection preflight failed.",
            );
        }
    }

    recorder.push(
        ConnectionPreflightStepId::Authentication,
        ConnectionPreflightStepStatus::Passed,
        "SSH authentication succeeded. No shell or remote command was started.",
        Some((&request.host, request.port)),
        None,
        false,
    );
    recorder.finish(
        ConnectionPreflightStatus::Passed,
        "Connection preflight completed.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SessionCreateRequest;
    use ssh2::{KnownHostFileKind, KnownHostKeyFormat};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::Path;
    use std::thread;

    #[test]
    fn session_request_summary_redacts_secret_values() {
        let request = SessionCreateRequest {
            operation_id: Some("ssh-connect-test".to_string()),
            name: "demo".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("super-secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: Some("keep-me-out-of-logs".to_string()),
            terminal_cols: 120,
            terminal_rows: 32,
            jump_host: None,
        };

        let summary = summarize_session_request(&request);

        assert!(summary.contains("host=example.com"));
        assert!(summary.contains("operation_id=ssh-connect-test"));
        assert!(summary.contains("username=alice"));
        assert!(summary.contains("auth_method=password"));
        assert!(summary.contains("has_password=true"));
        assert!(summary.contains("has_passphrase=true"));
        assert!(!summary.contains("super-secret"));
        assert!(!summary.contains("keep-me-out-of-logs"));
    }

    #[test]
    fn connect_sftp_returns_shared_connection() {
        use crate::sftp_pool::SftpPool;
        fn expect_shared(
            _result: Result<
                std::sync::Arc<std::sync::Mutex<crate::models::ConnectedSftp>>,
                crate::models::RemoteFsError,
            >,
        ) {
        }
        fn dummy_call(request: &crate::models::RemoteConnectionRequest, pool: &SftpPool) {
            expect_shared(connect_sftp(request, Some(pool), None));
        }
        let _ = dummy_call;
    }

    #[test]
    fn leader_recheck_reuses_a_connection_that_won_the_initial_miss_race() {
        let connect_calls = std::cell::Cell::new(0);

        let result = reuse_raced_pool_entry_or_connect(Some("pooled"), || {
            connect_calls.set(connect_calls.get() + 1);
            Ok::<_, ()>("new")
        });

        assert_eq!(result, Ok("pooled"));
        assert_eq!(
            connect_calls.get(),
            0,
            "race winner triggered another handshake"
        );
    }

    #[test]
    fn leader_recheck_connects_once_when_the_pool_is_still_empty() {
        let connect_calls = std::cell::Cell::new(0);

        let result = reuse_raced_pool_entry_or_connect(None, || {
            connect_calls.set(connect_calls.get() + 1);
            Ok::<_, ()>("new")
        });

        assert_eq!(result, Ok("new"));
        assert_eq!(connect_calls.get(), 1);
    }

    #[test]
    fn transfer_timeout_guard_restores_the_normal_session_timeout() {
        let session = Session::new().expect("session should initialize");
        session.set_timeout(SSH_SESSION_IO_TIMEOUT_MS);

        {
            let _guard = TransferTimeoutGuard::new(&session);
            assert_eq!(session.timeout(), SSH_TRANSFER_IO_TIMEOUT_MS);
        }

        assert_eq!(session.timeout(), SSH_SESSION_IO_TIMEOUT_MS);
    }

    #[test]
    fn validate_connection_fields_blocks_metadata_endpoint() {
        assert!(validate_connection_fields("169.254.169.254", "alice").is_err());
        assert!(validate_connection_fields("metadata.google.internal", "alice").is_err());
        assert!(validate_connection_fields("0.0.0.0", "alice").is_err());
        assert!(validate_connection_fields("::", "alice").is_err());
        assert!(validate_connection_fields("fd00:ec2::254", "alice").is_err());
        assert!(validate_connection_fields("[::]:22", "alice").is_err());
        assert!(validate_connection_fields("169.254.169.254:22", "alice").is_err());
    }

    #[test]
    fn validate_connection_fields_allows_normal_hosts() {
        assert!(validate_connection_fields("example.com", "alice").is_ok());
        assert!(validate_connection_fields("192.168.1.1", "alice").is_ok());
    }

    #[test]
    fn is_blocked_host_covers_blocked_ip_ranges() {
        // Link-local ranges beyond the well-known metadata literal.
        assert!(is_blocked_host("169.254.0.1"));
        assert!(is_blocked_host("fe80::1"));
        // Unspecified addresses.
        assert!(is_blocked_host("0.0.0.0"));
        assert!(is_blocked_host("::"));
        // IPv4-mapped IPv6 spellings must not bypass the range checks.
        assert!(is_blocked_host("::ffff:169.254.169.254"));
        // Blocked ranges still match when a port is attached.
        assert!(is_blocked_host("[fe80::1]:22"));
    }

    #[test]
    fn is_blocked_host_allows_loopback() {
        // SSH to localhost is a legitimate use case (VMs, tunnels, dev).
        assert!(!is_blocked_host("127.0.0.1"));
        assert!(!is_blocked_host("::1"));
        assert!(!is_blocked_host("127.0.0.1:2222"));
        assert!(!is_blocked_host("::ffff:127.0.0.1"));
    }

    #[test]
    fn is_blocked_host_allows_public_and_private_addresses() {
        assert!(!is_blocked_host("8.8.8.8"));
        assert!(!is_blocked_host("192.168.1.1"));
        assert!(!is_blocked_host("10.0.0.5"));
        assert!(!is_blocked_host("2606:4700:4700::1111"));
        assert!(!is_blocked_host("example.com"));
    }

    #[test]
    fn format_host_for_socket_address_brackets_ipv6_literals() {
        assert_eq!(format_host_for_socket_address("::1"), "[::1]");
        assert_eq!(format_host_for_socket_address("127.0.0.1"), "127.0.0.1");
        assert_eq!(format_host_for_socket_address("example.com"), "example.com");
    }

    #[test]
    fn connect_tcp_stream_blocks_resolved_metadata_addresses() {
        let error = connect_tcp_stream("169.254.169.254", 22)
            .expect_err("metadata endpoint should be blocked before connecting");

        assert!(error.contains("blocked"));
    }

    #[test]
    fn connect_tcp_stream_enables_nodelay() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .expect("should bind a loopback listener for the test");
        let address = listener
            .local_addr()
            .expect("listener should expose a loopback address");

        let accept_thread = thread::spawn(move || {
            let _ = listener.accept();
        });

        let stream = connect_tcp_stream("127.0.0.1", address.port())
            .expect("connect_tcp_stream should connect to the local listener");

        assert!(
            stream.nodelay().expect("querying nodelay should succeed"),
            "interactive SSH sockets should disable Nagle's algorithm",
        );

        accept_thread
            .join()
            .expect("accept thread should finish cleanly");
    }

    #[test]
    fn cancelled_preflight_marks_every_unstarted_step_blocked() {
        let request = RemoteConnectionRequest {
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("unused".to_string()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        };
        let cancelled = AtomicBool::new(true);
        let result = preflight_connection(
            request,
            "connection-preflight-cancelled".to_string(),
            Path::new("unused-known-hosts"),
            &cancelled,
        );

        assert_eq!(result.status, ConnectionPreflightStatus::Cancelled);
        assert_eq!(result.steps.len(), 4);
        assert!(result
            .steps
            .iter()
            .all(|step| step.status == ConnectionPreflightStepStatus::Blocked));
    }

    #[test]
    fn preflight_recorder_never_omits_expected_steps() {
        let mut recorder = PreflightRecorder::new("connection-preflight-test".to_string(), true);
        recorder.push(
            ConnectionPreflightStepId::Dns,
            ConnectionPreflightStepStatus::Passed,
            "resolved",
            Some(("jump.example.com", 22)),
            None,
            false,
        );

        let result = recorder.finish(ConnectionPreflightStatus::Failed, "not reached");

        assert_eq!(result.steps.len(), 7);
        assert_eq!(
            result.steps[0].status,
            ConnectionPreflightStepStatus::Passed
        );
        assert!(result.steps[1..]
            .iter()
            .all(|step| step.status == ConnectionPreflightStepStatus::Blocked));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end() {
        let host =
            std::env::var("SHELLSPAN_E2E_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = std::env::var("SHELLSPAN_E2E_SSH_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(22222);
        let username =
            std::env::var("SHELLSPAN_E2E_SSH_USERNAME").unwrap_or_else(|_| "shellspan".to_string());
        let password = std::env::var("SHELLSPAN_E2E_SSH_PASSWORD")
            .unwrap_or_else(|_| "shellspan-e2e".to_string());
        let temp = tempfile::tempdir().expect("create isolated known-hosts directory");
        let known_hosts_path = temp.path().join("known_hosts");
        let request = || RemoteConnectionRequest {
            host: host.clone(),
            port,
            username: username.clone(),
            auth_method: AuthMethod::Password,
            password: Some(password.clone()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        };

        let unknown_preflight = preflight_connection(
            request(),
            "connection-preflight-unknown".to_string(),
            &known_hosts_path,
            &AtomicBool::new(false),
        );
        assert_eq!(
            unknown_preflight.status,
            ConnectionPreflightStatus::Attention
        );
        assert!(unknown_preflight.steps.iter().any(|step| {
            step.id == ConnectionPreflightStepId::HostKey
                && step.status == ConnectionPreflightStepStatus::Warning
                && step.trustable
        }));
        assert!(unknown_preflight.steps.iter().any(|step| {
            step.id == ConnectionPreflightStepId::Authentication
                && step.status == ConnectionPreflightStepStatus::Blocked
        }));

        let unknown = open_authenticated_session(
            connect_tcp_stream(&host, port).expect("connect to isolated SSH service"),
            &username,
            AuthMethod::Password,
            Some(&password),
            None,
            None,
            &host,
            port,
            Some(&known_hosts_path),
        );
        match unknown {
            Err(ConnectionError::HostKeyUnknown { .. }) => {}
            Err(error) => panic!("expected an unknown host key, got {error:?}"),
            Ok(_) => panic!("an untrusted host key was accepted"),
        }

        let handshake = open_session_for_host_key(&host, port).expect("read isolated host key");
        let (key, key_type) = handshake.host_key().expect("server exposes a host key");
        let key_format = match key_type {
            ssh2::HostKeyType::Rsa => KnownHostKeyFormat::SshRsa,
            ssh2::HostKeyType::Dss => KnownHostKeyFormat::SshDss,
            ssh2::HostKeyType::Ecdsa256 => KnownHostKeyFormat::Ecdsa256,
            ssh2::HostKeyType::Ecdsa384 => KnownHostKeyFormat::Ecdsa384,
            ssh2::HostKeyType::Ecdsa521 => KnownHostKeyFormat::Ecdsa521,
            ssh2::HostKeyType::Ed25519 => KnownHostKeyFormat::Ed25519,
            ssh2::HostKeyType::Unknown => KnownHostKeyFormat::Unknown,
        };
        let host_with_port = if port == 22 {
            host.clone()
        } else {
            format!("[{host}]:{port}")
        };
        let mut known_hosts = handshake.known_hosts().expect("initialize known hosts");
        known_hosts
            .add(&host_with_port, key, &host_with_port, key_format)
            .expect("trust isolated host key");
        known_hosts
            .write_file(&known_hosts_path, KnownHostFileKind::OpenSSH)
            .expect("persist isolated known host");

        let trusted_preflight = preflight_connection(
            request(),
            "connection-preflight-trusted".to_string(),
            &known_hosts_path,
            &AtomicBool::new(false),
        );
        assert_eq!(trusted_preflight.status, ConnectionPreflightStatus::Passed);
        assert!(trusted_preflight.steps.iter().all(|step| !step.trustable));

        let session = open_authenticated_session(
            connect_tcp_stream(&host, port).expect("reconnect to isolated SSH service"),
            &username,
            AuthMethod::Password,
            Some(&password),
            None,
            None,
            &host,
            port,
            Some(&known_hosts_path),
        )
        .expect("authenticate after trusting host key");

        let mismatch_path = temp.path().join("mismatched-known-hosts");
        let mut mismatched_key = key.to_vec();
        let last = mismatched_key
            .last_mut()
            .expect("isolated SSH host key is not empty");
        *last ^= 0x01;
        let mut mismatched_hosts = handshake
            .known_hosts()
            .expect("initialize mismatched known hosts");
        mismatched_hosts
            .add(
                &host_with_port,
                &mismatched_key,
                &host_with_port,
                key_format,
            )
            .expect("record a changed host key fixture");
        mismatched_hosts
            .write_file(&mismatch_path, KnownHostFileKind::OpenSSH)
            .expect("persist changed host key fixture");
        let mismatch = open_authenticated_session(
            connect_tcp_stream(&host, port).expect("reconnect for changed host-key check"),
            &username,
            AuthMethod::Password,
            Some(&password),
            None,
            None,
            &host,
            port,
            Some(&mismatch_path),
        );
        match mismatch {
            Err(ConnectionError::HostKeyMismatch { .. }) => {}
            Err(error) => panic!("expected a changed host key, got {error:?}"),
            Ok(_) => panic!("a changed host key was accepted"),
        }

        let mut channel = session.channel_session().expect("open terminal channel");
        channel
            .request_pty("xterm", None, None)
            .expect("request terminal PTY");
        channel.shell().expect("start remote shell");
        channel
            .write_all(b"printf 'shellspan-terminal-ok\\n'\nexit\n")
            .expect("write terminal input");
        let mut terminal_output = String::new();
        channel
            .read_to_string(&mut terminal_output)
            .expect("read terminal output");
        channel.wait_close().expect("close terminal channel");
        assert!(terminal_output.contains("shellspan-terminal-ok"));

        let sftp = session.sftp().expect("open SFTP subsystem");
        let remote_path = Path::new("/home/shellspan/upload/shellspan-e2e.txt");
        let mut remote = sftp.create(remote_path).expect("create remote upload");
        remote
            .write_all(b"shellspan-sftp-ok")
            .expect("upload remote content");
        drop(remote);
        let mut downloaded = String::new();
        sftp.open(remote_path)
            .expect("open uploaded file")
            .read_to_string(&mut downloaded)
            .expect("download uploaded file");
        assert_eq!(downloaded, "shellspan-sftp-ok");
        sftp.unlink(remote_path).expect("clean up remote fixture");
    }
}
