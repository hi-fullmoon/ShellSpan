use crate::models::{AuthMethod, ConnectedSftp, JumpHostConfig, RemoteConnectionRequest, SessionCreateRequest};
use crate::sftp_pool::SftpPool;
use log::debug;
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
const SSH_SESSION_KEEPALIVE_INTERVAL_SECS: u32 = 30;

pub(crate) fn connect_sftp(
    request: &RemoteConnectionRequest,
    pool: Option<&SftpPool>,
) -> Result<Arc<Mutex<ConnectedSftp>>, String> {
    validate_connection_fields(&request.host, &request.username)?;
    debug!(
        "Connecting SFTP {}",
        summarize_remote_connection_request(request)
    );

    if let Some(pool) = pool {
        if let Ok(cached) = pool.get_or_create(request) {
            return Ok(cached);
        }
    }

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

    if let Some(pool) = pool {
        pool.insert(request, connected.clone());
    }

    debug!(
        "Connected SFTP host={} port={} username={}",
        request.host, request.port, request.username
    );
    Ok(connected)
}

pub(crate) fn validate_connection_fields(host: &str, username: &str) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err("host is required".to_string());
    }
    if username.trim().is_empty() {
        return Err("username is required".to_string());
    }
    Ok(())
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
) -> Result<Session, String> {
    debug!(
        "Opening authenticated SSH session username={} auth_method={}",
        username,
        auth_method.as_str()
    );
    let mut session = Session::new().map_err(|error| format!("session init failed: {error}"))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|error| format!("ssh handshake failed: {error}"))?;

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
    session.set_keepalive(false, SSH_SESSION_KEEPALIVE_INTERVAL_SECS);
    Ok(session)
}

pub(crate) fn open_session_for_host_key(host: &str, port: u16) -> Result<Session, String> {
    debug!("Opening SSH session for host key check host={host} port={port}");
    let tcp = connect_tcp_stream(host, port)?;
    let mut session = Session::new().map_err(|error| format!("session init failed: {error}"))?;
    session.set_tcp_stream(tcp);
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
    )?;

    // 2. Create a local TCP socket pair for bridging
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("failed to bind local bridge socket: {e}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("failed to get local bridge address: {e}"))?
        .port();

    // 3. Open direct-tcpip channel through jump host to target
    let channel = jump_session
        .channel_direct_tcpip(target_host, target_port, Some(("127.0.0.1", local_port)))
        .map_err(|e| format!("failed to open direct-tcpip through jump host: {e}"))?;

    // 4. Accept connection from the other side of the bridge
    let server_stream = listener
        .accept()
        .map_err(|e| format!("failed to accept bridge connection: {e}"))?
        .0;

    // 5. Connect client side of the bridge (this will be the target session's TCP stream)
    let client_stream = TcpStream::connect(("127.0.0.1", local_port))
        .map_err(|e| format!("failed to connect to bridge socket: {e}"))?;
    configure_tcp_stream(&client_stream)
        .map_err(|e| format!("failed to configure bridge client socket: {e}"))?;

    // 6. Spawn a thread to bridge data between the jump channel and the server side
    thread::spawn(move || {
        let _ = bridge_channel_tcp(channel, server_stream);
    });

    // 7. Open authenticated session on the client stream
    let target_session = open_authenticated_session(
        client_stream,
        target_username,
        target_auth_method,
        target_password,
        target_private_key_path,
        target_passphrase,
    )?;

    debug!("Connected to target through jump host successfully");
    Ok((jump_session, target_session))
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
        let _ = copy(&mut tcp_clone, &mut channel_clone);
    });

    let t2 = thread::spawn(move || {
        let _ = copy(&mut channel, &mut tcp);
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
                .map_err(|error| format!("password auth failed: {error}"))?;
        }
        AuthMethod::Key => {
            let private_key_path = private_key_path
                .ok_or_else(|| "private key auth selected, but no key path provided".to_string())?;
            session
                .userauth_pubkey_file(username, None, Path::new(private_key_path), passphrase)
                .map_err(|error| format!("private key auth failed: {error}"))?;
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
        // We cannot open a real SSH session in a unit test, but this test documents the expected
        // return type and ensures the signature compiles with the pool argument.
        fn expect_shared(_result: Result<std::sync::Arc<std::sync::Mutex<crate::models::ConnectedSftp>>, String>) {}
        fn dummy_call(request: &crate::models::RemoteConnectionRequest, pool: &SftpPool) {
            expect_shared(connect_sftp(request, Some(pool)));
        }
        let _ = dummy_call;
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
