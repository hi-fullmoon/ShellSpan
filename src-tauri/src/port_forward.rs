use std::collections::HashMap;
use std::io::copy;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use log::{info, warn};

use crate::connection::{connect_tcp_stream, open_authenticated_session};
use crate::models::{AuthMethod, JumpHostConfig, PortForwardConfig, PortForwardKind};

#[derive(Default, Clone)]
pub(crate) struct PortForwardManager {
    operations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl PortForwardManager {
    pub(crate) fn register(&self, id: String, flag: Arc<AtomicBool>) -> Result<(), String> {
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "port forward manager poisoned")?;
        guard.insert(id, flag);
        Ok(())
    }

    pub(crate) fn cancel(&self, id: &str) -> Result<(), String> {
        let guard = self
            .operations
            .lock()
            .map_err(|_| "port forward manager poisoned")?;
        let flag = guard
            .get(id)
            .ok_or_else(|| format!("port forward operation {id} not found"))?;
        flag.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub(crate) fn remove(&self, id: &str) -> Result<(), String> {
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "port forward manager poisoned")?;
        guard.remove(id);
        Ok(())
    }
}

pub(crate) fn start_port_forwards(
    manager: PortForwardManager,
    operation_id: String,
    host: String,
    port: u16,
    username: String,
    auth_method: AuthMethod,
    password: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
    jump_host: Option<JumpHostConfig>,
    forwards: Vec<PortForwardConfig>,
    cancel_flag: Arc<AtomicBool>,
) {
    info!("Starting port forwards count={}", forwards.len());

    let mut handles = Vec::new();

    for config in forwards.into_iter() {
        if cancel_flag.load(Ordering::SeqCst) {
            break;
        }

        let host = host.clone();
        let username = username.clone();
        let pwd = password.clone();
        let key = private_key_path.clone();
        let phrase = passphrase.clone();
        let jh = jump_host.clone();
        let cancel = cancel_flag.clone();

        match config.kind {
            PortForwardKind::Local => {
                let remote_host = config.remote_host.clone();
                handles.push(thread::spawn(move || {
                    local_forward_worker(
                        &host, port, &username, auth_method,
                        pwd.as_deref(), key.as_deref(), phrase.as_deref(),
                        jh.as_ref(),
                        config.local_port, &remote_host, config.remote_port,
                        cancel,
                    )
                }));
            }
            PortForwardKind::Remote => {
                let remote_host = config.remote_host.clone();
                handles.push(thread::spawn(move || {
                    remote_forward_worker(
                        &host, port, &username, auth_method,
                        pwd.as_deref(), key.as_deref(), phrase.as_deref(),
                        jh.as_ref(),
                        config.local_port, &remote_host, config.remote_port,
                        cancel,
                    )
                }));
            }
        }
    }

    while !cancel_flag.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(200));
    }

    info!("Port forward cancelled, joining threads");
    for handle in handles {
        let _ = handle.join();
    }
    if let Err(e) = manager.remove(&operation_id) {
        warn!("Failed to remove port forward operation {operation_id}: {e}");
    }
    info!("Port forward operation complete");
}

fn open_forward_session(
    host: &str,
    port: u16,
    username: &str,
    auth_method: AuthMethod,
    password: Option<&str>,
    private_key_path: Option<&str>,
    passphrase: Option<&str>,
    jump_host: Option<&JumpHostConfig>,
) -> Result<ssh2::Session, String> {
    if let Some(jump) = jump_host {
        let _ = jump;
        Err("jump host for port forwarding is not yet supported".to_string())
    } else {
        let tcp = connect_tcp_stream(host, port)?;
        let session = open_authenticated_session(tcp, username, auth_method, password, private_key_path, passphrase)?;
        session.set_keepalive(true, 30);
        Ok(session)
    }
}

// ---------- Local forwarding ----------

fn local_forward_worker(
    host: &str,
    port: u16,
    username: &str,
    auth_method: AuthMethod,
    password: Option<&str>,
    private_key_path: Option<&str>,
    passphrase: Option<&str>,
    jump_host: Option<&JumpHostConfig>,
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
    cancel_flag: Arc<AtomicBool>,
) {
    let result = local_forward_loop(
        host, port, username, auth_method,
        password, private_key_path, passphrase,
        jump_host, local_port, remote_host, remote_port, cancel_flag,
    );
    if let Err(e) = result {
        warn!("Local forward 127.0.0.1:{local_port} failed: {e}");
    }
}

fn local_forward_loop(
    host: &str,
    port: u16,
    username: &str,
    auth_method: AuthMethod,
    password: Option<&str>,
    private_key_path: Option<&str>,
    passphrase: Option<&str>,
    jump_host: Option<&JumpHostConfig>,
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let session = open_forward_session(host, port, username, auth_method, password, private_key_path, passphrase, jump_host)?;
    let remote_host = remote_host.to_owned();

    let listener = TcpListener::bind(("127.0.0.1", local_port))
        .map_err(|e| format!("failed to bind 127.0.0.1:{local_port}: {e}"))?;
    listener.set_nonblocking(true)
        .map_err(|e| format!("failed to set nonblocking: {e}"))?;

    info!("Local forward 127.0.0.1:{local_port} -> {remote_host}:{remote_port}");

    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            info!("Local forward {local_port} cancelled");
            break;
        }

        match listener.accept() {
            Ok((local, addr)) => {
                info!("Local forward accepted {addr}");
                match session.channel_direct_tcpip(&remote_host, remote_port, None) {
                    Ok(channel) => {
                        thread::spawn(move || {
                            let _ = bridge_single_connection(channel, local);
                        });
                    }
                    Err(e) => warn!("direct-tcpip to {remote_host}:{remote_port} failed: {e}"),
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                warn!("Local forward accept error: {e}");
                thread::sleep(Duration::from_millis(500));
            }
        }
    }

    Ok(())
}

// ---------- Remote forwarding ----------

fn remote_forward_worker(
    host: &str,
    port: u16,
    username: &str,
    auth_method: AuthMethod,
    password: Option<&str>,
    private_key_path: Option<&str>,
    passphrase: Option<&str>,
    jump_host: Option<&JumpHostConfig>,
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
    cancel_flag: Arc<AtomicBool>,
) {
    let result = remote_forward_loop(
        host, port, username, auth_method,
        password, private_key_path, passphrase,
        jump_host, local_port, remote_host, remote_port, cancel_flag,
    );
    if let Err(e) = result {
        warn!("Remote forward {remote_host}:{remote_port} failed: {e}");
    }
}

fn remote_forward_loop(
    host: &str,
    port: u16,
    username: &str,
    auth_method: AuthMethod,
    password: Option<&str>,
    private_key_path: Option<&str>,
    passphrase: Option<&str>,
    jump_host: Option<&JumpHostConfig>,
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let session = open_forward_session(host, port, username, auth_method, password, private_key_path, passphrase, jump_host)?;
    session.set_blocking(true);
    let remote_host = remote_host.to_owned();

    let (mut listener, _) = session
        .channel_forward_listen(remote_port, Some(&remote_host), None)
        .map_err(|e| format!("failed to listen on {remote_host}:{remote_port}: {e}"))?;

    info!("Remote forward {remote_host}:{remote_port} -> 127.0.0.1:{local_port}");

    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            info!("Remote forward {remote_host}:{remote_port} cancelled");
            break;
        }

        match listener.accept() {
            Ok(channel) => {
                info!("Remote forward accepted");
                match TcpStream::connect(("127.0.0.1", local_port)) {
                    Ok(local) => {
                        thread::spawn(move || {
                            let _ = bridge_single_connection(channel, local);
                        });
                    }
                    Err(e) => warn!("connect to 127.0.0.1:{local_port} failed: {e}"),
                }
            }
            Err(e) => {
                warn!("Remote forward accept error: {e}");
                thread::sleep(Duration::from_millis(500));
            }
        }
    }

    Ok(())
}

// ---------- Bidirectional bridge ----------

fn bridge_single_connection(
    mut channel: ssh2::Channel,
    mut tcp: TcpStream,
) -> Result<(), String> {
    let mut tcp_clone = tcp
        .try_clone()
        .map_err(|e| format!("failed to clone tcp: {e}"))?;
    let mut channel_stream = channel.stream(0);

    let t1 = thread::spawn(move || {
        let _ = copy(&mut tcp_clone, &mut channel_stream);
    });
    let t2 = thread::spawn(move || {
        let _ = copy(&mut channel, &mut tcp);
    });

    let _ = t1.join();
    let _ = t2.join();
    Ok(())
}
