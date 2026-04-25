use crate::models::{AuthMethod, ConnectedSftp, RemoteConnectionRequest, SessionCreateRequest};
use log::debug;
use socket2::{SockRef, TcpKeepalive};
use ssh2::Session;
use std::{
    net::{TcpStream, ToSocketAddrs},
    path::Path,
    time::Duration,
};

const SSH_TCP_KEEPALIVE_TIME_SECS: u64 = 30;
const SSH_TCP_KEEPALIVE_INTERVAL_SECS: u64 = 15;
const SSH_SESSION_KEEPALIVE_INTERVAL_SECS: u32 = 30;

pub(crate) fn connect_sftp(request: &RemoteConnectionRequest) -> Result<ConnectedSftp, String> {
    validate_connection_fields(&request.host, &request.username)?;
    debug!(
        "Connecting SFTP {}",
        summarize_remote_connection_request(request)
    );

    let tcp = connect_tcp_stream(&request.host, request.port)?;
    let session = open_authenticated_session(
        tcp,
        &request.username,
        request.auth_method,
        request.password.as_deref(),
        request.private_key_path.as_deref(),
        request.passphrase.as_deref(),
    )?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("failed to open sftp subsystem: {error}"))?;

    debug!(
        "Connected SFTP host={} port={} username={}",
        request.host, request.port, request.username
    );
    Ok(ConnectedSftp { session, sftp })
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
