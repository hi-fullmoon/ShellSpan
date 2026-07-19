use crate::known_hosts::verify_session_host_key;
use crate::models::{AuthMethod, ConnectedSftp, JumpHostConfig, RemoteConnectionRequest, SessionCreateRequest};
use crate::sftp_pool::{connection_key, SftpPool};
use log::{debug, error, warn};
use socket2::{SockRef, TcpKeepalive};
use ssh2::Session;
use std::{
    io::copy,
    net::{TcpListener, TcpStream, ToSocketAddrs},
    path::Path,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

const SSH_TCP_KEEPALIVE_TIME_SECS: u64 = 30;
const SSH_TCP_KEEPALIVE_INTERVAL_SECS: u64 = 15;
const SSH_SESSION_IO_TIMEOUT_MS: u32 = 15_000;
pub(crate) const SSH_SESSION_KEEPALIVE_INTERVAL_SECS: u32 = 30;

pub(crate) fn connect_sftp(
    request: &RemoteConnectionRequest,
    pool: Option<&SftpPool>,
    known_hosts_path: Option<&Path>,
) -> Result<Arc<Mutex<ConnectedSftp>>, String> {
    validate_connection_fields(&request.host, &request.username)?;
    debug!(
        "Connecting SFTP {}",
        summarize_remote_connection_request(request)
    );

    if let Some(pool) = pool {
        if let Some(cached) = pool.get(request) {
            return Ok(cached);
        }
    }

    let connected = create_sftp_connection(request, known_hosts_path)?;

    if let Some(pool) = pool {
        let key = connection_key(request);
        return Ok(pool.get_or_insert(&key, connected));
    }

    Ok(connected)
}

fn create_sftp_connection(
    request: &RemoteConnectionRequest,
    known_hosts_path: Option<&Path>,
) -> Result<Arc<Mutex<ConnectedSftp>>, String> {
    let (session, jump_session) = if let Some(ref jump) = request.jump_host {
        let (jump_session, target_session) = connect_through_jump_host(
            jump,
            &request.host,
            request.port,
            &request.username,
            request.auth_method,
            request.password.as_deref(),
            request.private_key_path.as_deref(),
            request.passphrase.as_deref(),
            known_hosts_path,
        )?;
        (target_session, Some(jump_session))
    } else {
        let tcp = connect_tcp_stream(&request.host, request.port)?;
        let session = open_authenticated_session(
            tcp,
            &request.username,
            request.auth_method,
            request.password.as_deref(),
            request.private_key_path.as_deref(),
            request.passphrase.as_deref(),
            &request.host,
            request.port,
            known_hosts_path,
        )?;
        (session, None)
    };

    let sftp = session
        .sftp()
        .map_err(|error| format!("failed to open sftp subsystem: {error}"))?;

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
    let candidate = lower.trim_start_matches("http://").trim_start_matches("https://");
    let candidate = candidate.split('/').next().unwrap_or(candidate);
    let candidate = strip_port(candidate);
    let blocked_literals = [
        "169.254.169.254",
        "fd00:ec2::254",
        "0.0.0.0",
        "::",
    ];
    blocked_literals.contains(&candidate)
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
    private_key_path: Option<&str>,
    passphrase: Option<&str>,
) -> String {
    format!(
        "host={} port={} username={} auth_method={} has_password={} has_private_key_path={} has_passphrase={}",
        host.trim(),
        port,
        username.trim(),
        auth_method.as_str(),
        has_secret_value(password),
        has_secret_value(private_key_path),
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
        request.private_key_path.as_deref(),
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
        request.private_key_path.as_deref(),
        request.passphrase.as_deref(),
    )
}

pub(crate) fn connect_tcp_stream(host: &str, port: u16) -> Result<TcpStream, String> {
    let address = format!("{host}:{port}");
    debug!("Opening TCP connection address={address}");
    let socket_addr = address
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve {address}: {error}"))?
        .next()
        .ok_or_else(|| format!("no socket address found for {address}"))?;

    let tcp = TcpStream::connect_timeout(&socket_addr, Duration::from_secs(12))
        .map_err(|error| format!("failed to connect to {address}: {error}"))?;

    configure_tcp_stream(&tcp)
        .map_err(|error| format!("failed to configure TCP socket for {address}: {error}"))?;

    Ok(tcp)
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
    private_key_path: Option<&str>,
    passphrase: Option<&str>,
    host: &str,
    port: u16,
    known_hosts_path: Option<&Path>,
) -> Result<Session, String> {
    debug!(
        "Opening authenticated SSH session username={} auth_method={}",
        username,
        auth_method.as_str()
    );
    let mut session = Session::new().map_err(|error| format!("session init failed: {error}"))?;
    session.set_tcp_stream(tcp);
    session.set_timeout(SSH_SESSION_IO_TIMEOUT_MS);
    session.handshake().map_err(|error| {
        error!("SSH handshake failed remote={host}:{port}: {error}");
        format!("ssh handshake failed: {error}")
    })?;

    if let Some(path) = known_hosts_path {
        verify_session_host_key(&session, host, port, path)?;
    }

    authenticate(
        &mut session,
        username,
        auth_method,
        password,
        private_key_path,
        passphrase,
    )?;

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
    target_private_key_path: Option<&str>,
    target_passphrase: Option<&str>,
    known_hosts_path: Option<&Path>,
) -> Result<(Session, Session), String> {
    debug!(
        "Connecting through jump host {}:{} to target {}:{}",
        jump.host, jump.port, target_host, target_port
    );

    // 1. Connect to jump host
    let jump_tcp = connect_tcp_stream(&jump.host, jump.port)?;
    let jump_session = open_authenticated_session(
        jump_tcp,
        &jump.username,
        jump.auth_method,
        jump.password.as_deref(),
        jump.private_key_path.as_deref(),
        jump.passphrase.as_deref(),
        &jump.host,
        jump.port,
        known_hosts_path,
    )?;

    // 2. Create a local TCP socket pair for bridging
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("failed to bind local bridge socket: {e}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("failed to get local bridge address: {e}"))?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("failed to set bridge listener nonblocking: {e}"))?;

    // 3. Open direct-tcpip channel through jump host to target
    let channel = jump_session
        .channel_direct_tcpip(target_host, target_port, Some(("127.0.0.1", local_port)))
        .map_err(|e| format!("failed to open direct-tcpip through jump host: {e}"))?;

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
    let client_stream = TcpStream::connect(("127.0.0.1", local_port))
        .map_err(|e| format!("failed to connect to bridge socket: {e}"))?;
    configure_tcp_stream(&client_stream)
        .map_err(|e| format!("failed to configure bridge client socket: {e}"))?;

    // 6. Open authenticated session on the client stream
    let target_session = open_authenticated_session(
        client_stream,
        target_username,
        target_auth_method,
        target_password,
        target_private_key_path,
        target_passphrase,
        target_host,
        target_port,
        known_hosts_path,
    )?;

    // Detach the bridge thread — it runs until the channel closes.
    std::mem::forget(bridge_handle);

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

fn bridge_channel_tcp(
    mut channel: ssh2::Channel,
    mut tcp: TcpStream,
) -> Result<(), String> {
    let mut tcp_clone = tcp
        .try_clone()
        .map_err(|e| format!("failed to clone bridge TCP stream: {e}"))?;

    let mut channel_clone = channel.stream(0);

    let t1 = thread::spawn(move || {
        if let Err(error) = copy(&mut tcp_clone, &mut channel_clone) {
            warn!("Jump host bridge copy (tcp -> channel) failed: {error}");
        }
    });

    let t2 = thread::spawn(move || {
        if let Err(error) = copy(&mut channel, &mut tcp) {
            warn!("Jump host bridge copy (channel -> tcp) failed: {error}");
        }
    });

    let _ = t1.join();
    let _ = t2.join();
    Ok(())
}

fn authenticate(
    session: &mut Session,
    username: &str,
    auth_method: AuthMethod,
    password: Option<&str>,
    private_key_path: Option<&str>,
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
            let private_key_path = private_key_path
                .ok_or_else(|| "private key auth selected, but no key path provided".to_string())?;
            session
                .userauth_pubkey_file(username, None, Path::new(private_key_path), passphrase)
                .map_err(|error| {
                    warn!(
                        "SSH authentication failed username={} method={}: {error}",
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
            private_key_path: Some("/Users/alice/.ssh/id_ed25519".to_string()),
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
        assert!(summary.contains("has_private_key_path=true"));
        assert!(summary.contains("has_passphrase=true"));
        assert!(!summary.contains("super-secret"));
        assert!(!summary.contains("keep-me-out-of-logs"));
        assert!(!summary.contains("/Users/alice/.ssh/id_ed25519"));
    }

    #[test]
    fn connect_sftp_returns_shared_connection() {
        use crate::sftp_pool::SftpPool;
        fn expect_shared(_result: Result<std::sync::Arc<std::sync::Mutex<crate::models::ConnectedSftp>>, String>) {}
        fn dummy_call(request: &crate::models::RemoteConnectionRequest, pool: &SftpPool) {
            expect_shared(connect_sftp(request, Some(pool), None));
        }
        let _ = dummy_call;
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
