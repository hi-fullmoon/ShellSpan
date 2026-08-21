use crate::known_hosts::check_host_key_against_file;
use crate::models::{
    AuthMethod, ConnectedSftp, ConnectionError, HostKeyCheckStatus, JumpHostConfig,
    RemoteConnectionRequest, RemoteFsError, SessionCreateRequest,
};
use crate::sftp_pool::{connection_key, ConnectClaim, SftpPool};
use log::{debug, error, warn};
use socket2::{SockRef, TcpKeepalive};
use ssh2::Session;
use std::{
    net::{IpAddr, Ipv6Addr, TcpListener, TcpStream, ToSocketAddrs},
    path::Path,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

const SSH_TCP_KEEPALIVE_TIME_SECS: u64 = 30;
const SSH_TCP_KEEPALIVE_INTERVAL_SECS: u64 = 15;
const SSH_SESSION_IO_TIMEOUT_MS: u32 = 15_000;
const SSH_TRANSFER_IO_TIMEOUT_MS: u32 = 120_000;
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
    connect_sftp_inner(request, pool, known_hosts_path)
        .map_err(RemoteFsError::from_connection_error)
}

fn connect_sftp_inner(
    request: &RemoteConnectionRequest,
    pool: Option<&SftpPool>,
    known_hosts_path: Option<&Path>,
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
        if let Some(cached) = pool.get(request) {
            return Ok(cached);
        }
        // Deduplicate concurrent handshakes: one caller leads, the rest wait.
        let key = connection_key(request);
        return match pool.begin_connect(&key) {
            // The guard must stay bound across the handshake: if
            // create_sftp_connection panics, dropping it fails the slot so
            // followers do not wait forever.
            ConnectClaim::Leader(_guard) => {
                let result = create_sftp_connection(request, known_hosts_path);
                pool.finish_connect(&key, result)
            }
            ConnectClaim::Follower(slot) => pool
                .wait_connect(&key, slot)
                .map_err(|message| ConnectionError::Other { message }),
        };
    }

    create_sftp_connection(request, known_hosts_path)
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
    let address = format!("{}:{port}", format_host_for_socket_address(host));
    debug!("Opening TCP connection address={address}");
    let socket_addrs: Vec<_> = address
        .as_str()
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve {address}: {error}"))?
        .collect();
    if socket_addrs.is_empty() {
        return Err(format!("no socket address found for {address}"));
    }

    // Try every resolved address (e.g. IPv6 then IPv4) instead of giving up
    // on the first one.
    let mut last_error = None;
    for socket_addr in socket_addrs {
        if is_blocked_ip(normalize_ip(socket_addr.ip())) {
            return Err(format!("connections to {} are blocked", socket_addr.ip()));
        }
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

    if let Some(path) = known_hosts_path {
        match check_host_key_against_file(&session, host, port, path) {
            Ok(_) => {}
            Err(result) => {
                return match result.status {
                    HostKeyCheckStatus::NotFound => Err(ConnectionError::HostKeyUnknown {
                        host: host.to_string(),
                        port,
                        fingerprint: result.fingerprint,
                    }),
                    HostKeyCheckStatus::Mismatch => Err(ConnectionError::HostKeyMismatch {
                        host: host.to_string(),
                        port,
                    }),
                    _ => Err(ConnectionError::Other {
                        message: result
                            .message
                            .unwrap_or_else(|| "host key check failed".to_string()),
                    }),
                };
            }
        }
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

    // 2. Create a local TCP socket pair for bridging
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

    // 3. Open direct-tcpip channel through jump host to target
    let channel = jump_session
        .channel_direct_tcpip(target_host, target_port, Some(("127.0.0.1", local_port)))
        .map_err(|e| ConnectionError::Other {
            message: format!("failed to open direct-tcpip through jump host: {e}"),
        })?;

    // 4. Spawn a thread that accepts the bridge connection and bridges data
    //    between the jump channel and the server side. The accept must run
    //    concurrently with the client connect below, otherwise neither side
    //    would ever complete the TCP handshake.
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

    // 5. Connect client side of the bridge (this will be the target session's TCP stream)
    let client_stream =
        TcpStream::connect(("127.0.0.1", local_port)).map_err(|e| ConnectionError::Other {
            message: format!("failed to connect to bridge socket: {e}"),
        })?;
    configure_tcp_stream(&client_stream).map_err(|e| ConnectionError::Other {
        message: format!("failed to configure bridge client socket: {e}"),
    })?;

    // 6. Open authenticated session on the client stream
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

    // Dropping the JoinHandle detaches the bridge thread: it keeps copying
    // data until the jump channel closes (i.e. when the sessions are dropped)
    // or the bridge copy fails, and then exits on its own.
    drop(bridge_handle);

    debug!("Connected to target through jump host successfully");
    Ok((jump_session, target_session))
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
    let mut tcp_clone = tcp
        .try_clone()
        .map_err(|e| format!("failed to clone bridge TCP stream: {e}"))?;

    let mut channel_clone = channel.stream(0);

    let t1 = thread::spawn(move || {
        if let Err(error) = bridge_copy(&mut tcp_clone, &mut channel_clone) {
            warn!("Jump host bridge copy (tcp -> channel) failed: {error}");
        }
    });

    let t2 = thread::spawn(move || {
        if let Err(error) = bridge_copy(&mut channel, &mut tcp) {
            warn!("Jump host bridge copy (channel -> tcp) failed: {error}");
        }
    });

    let _ = t1.join();
    let _ = t2.join();
    Ok(())
}

// The jump session runs with a blocking I/O timeout (SSH_SESSION_IO_TIMEOUT_MS),
// so a bridged channel read/write that stays idle longer than the timeout
// surfaces as ErrorKind::TimedOut instead of blocking forever. That timeout is
// expected while the target session is idle (e.g. SFTP request/response with no
// traffic), so it must not tear down the bridge — retry it and only stop on a
// real EOF or unrecoverable error.
fn is_bridge_retryable(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    )
}

fn bridge_copy<R, W>(reader: &mut R, writer: &mut W) -> std::io::Result<()>
where
    R: std::io::Read,
    W: std::io::Write,
{
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(read) => read,
            Err(error) if is_bridge_retryable(&error) => continue,
            Err(error) => return Err(error),
        };

        let mut written = 0;
        while written < read {
            match writer.write(&buffer[written..read]) {
                Ok(0) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WriteZero,
                        "bridge write returned zero bytes",
                    ));
                }
                Ok(count) => written += count,
                Err(error) if is_bridge_retryable(&error) => continue,
                Err(error) => return Err(error),
            }
        }
        writer.flush()?;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SessionCreateRequest;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn session_request_summary_redacts_secret_values() {
        let request = SessionCreateRequest {
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
}
