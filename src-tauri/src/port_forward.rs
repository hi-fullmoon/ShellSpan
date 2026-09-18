use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use log::{info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::connection::{
    connect_tcp_stream, connect_through_jump_host, open_authenticated_session, validate_host,
};
use crate::models::{
    AuthMethod, JumpHostConfig, PortForwardConfig, PortForwardKind, PortForwardStartMode,
    PortForwardStartRequest, RemoteConnectionRequest,
};

pub(crate) const PORT_FORWARD_EVENT: &str = "port-forward-event";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PortForwardStatus {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

impl PortForwardStatus {
    fn is_active(self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::Stopping)
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PortForwardErrorCategory {
    PortInUse,
    HostKey,
    Authentication,
    Connection,
    InvalidConfiguration,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortForwardRuntime {
    pub(crate) operation_id: String,
    pub(crate) profile_id: String,
    pub(crate) config_id: String,
    pub(crate) name: String,
    pub(crate) kind: PortForwardKind,
    pub(crate) mode: PortForwardStartMode,
    pub(crate) status: PortForwardStatus,
    pub(crate) started_at: Option<u64>,
    pub(crate) stopped_at: Option<u64>,
    pub(crate) bytes_sent: u64,
    pub(crate) bytes_received: u64,
    pub(crate) last_error: Option<String>,
    pub(crate) error_category: Option<PortForwardErrorCategory>,
}

struct PortForwardOperation {
    cancel: Arc<AtomicBool>,
    runtime: PortForwardRuntime,
}

#[derive(Default, Clone)]
pub(crate) struct PortForwardManager {
    operations: Arc<Mutex<HashMap<String, PortForwardOperation>>>,
}

impl PortForwardManager {
    pub(crate) fn register(
        &self,
        request: &PortForwardStartRequest,
    ) -> Result<Arc<AtomicBool>, String> {
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "port forward manager poisoned")?;
        if guard.contains_key(&request.operation_id) {
            return Err(format!(
                "port forward operation {} already exists",
                request.operation_id
            ));
        }
        if guard.values().any(|operation| {
            operation.runtime.status.is_active()
                && operation.runtime.profile_id == request.profile_id
                && operation.runtime.config_id == request.forward.id
        }) {
            return Err(format!(
                "port forward {} is already active for this connection",
                request.forward.name
            ));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        guard.insert(
            request.operation_id.clone(),
            PortForwardOperation {
                cancel: cancel.clone(),
                runtime: PortForwardRuntime {
                    operation_id: request.operation_id.clone(),
                    profile_id: request.profile_id.clone(),
                    config_id: request.forward.id.clone(),
                    name: request.forward.name.clone(),
                    kind: request.forward.kind,
                    mode: request.mode,
                    status: PortForwardStatus::Starting,
                    started_at: None,
                    stopped_at: None,
                    bytes_sent: 0,
                    bytes_received: 0,
                    last_error: None,
                    error_category: None,
                },
            },
        );
        Ok(cancel)
    }

    pub(crate) fn cancel(&self, id: &str) -> Result<PortForwardRuntime, String> {
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "port forward manager poisoned")?;
        let operation = guard
            .get_mut(id)
            .ok_or_else(|| format!("port forward operation {id} not found"))?;
        operation.cancel.store(true, Ordering::SeqCst);
        if operation.runtime.status.is_active() {
            operation.runtime.status = PortForwardStatus::Stopping;
        }
        Ok(operation.runtime.clone())
    }

    pub(crate) fn cancel_all(&self) -> Result<Vec<PortForwardRuntime>, String> {
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "port forward manager poisoned")?;
        let mut changed = Vec::new();
        for operation in guard.values_mut() {
            if operation.runtime.status.is_active() {
                operation.cancel.store(true, Ordering::SeqCst);
                operation.runtime.status = PortForwardStatus::Stopping;
                changed.push(operation.runtime.clone());
            }
        }
        Ok(changed)
    }

    pub(crate) fn list(&self) -> Result<Vec<PortForwardRuntime>, String> {
        let guard = self
            .operations
            .lock()
            .map_err(|_| "port forward manager poisoned")?;
        let mut runtimes = guard
            .values()
            .map(|operation| operation.runtime.clone())
            .collect::<Vec<_>>();
        runtimes.sort_by(|left, right| {
            right
                .started_at
                .unwrap_or(0)
                .cmp(&left.started_at.unwrap_or(0))
                .then_with(|| right.operation_id.cmp(&left.operation_id))
        });
        Ok(runtimes)
    }

    fn update(
        &self,
        id: &str,
        update: impl FnOnce(&mut PortForwardRuntime),
    ) -> Result<PortForwardRuntime, String> {
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "port forward manager poisoned")?;
        let operation = guard
            .get(id)
            .ok_or_else(|| format!("port forward operation {id} not found"))?;
        let mut runtime = operation.runtime.clone();
        update(&mut runtime);
        guard
            .get_mut(id)
            .expect("operation exists while manager lock is held")
            .runtime = runtime.clone();
        Ok(runtime)
    }

    #[cfg(test)]
    fn active_count(&self) -> usize {
        self.operations
            .lock()
            .expect("manager lock")
            .values()
            .filter(|operation| operation.runtime.status.is_active())
            .count()
    }

    fn prune_finished(&self) -> Result<(), String> {
        let mut guard = self
            .operations
            .lock()
            .map_err(|_| "port forward manager poisoned")?;
        if guard.len() <= 200 {
            return Ok(());
        }
        let mut finished = guard
            .iter()
            .filter(|(_, operation)| !operation.runtime.status.is_active())
            .map(|(id, operation)| (id.clone(), operation.runtime.stopped_at.unwrap_or(0)))
            .collect::<Vec<_>>();
        finished.sort_by_key(|(_, stopped_at)| *stopped_at);
        for (id, _) in finished.into_iter().take(guard.len().saturating_sub(200)) {
            guard.remove(&id);
        }
        Ok(())
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn emit_runtime(app: &AppHandle, runtime: &PortForwardRuntime) {
    if let Err(error) = app.emit(PORT_FORWARD_EVENT, runtime) {
        warn!("Failed to emit port forward state: {error}");
    }
}

fn update_and_emit(
    app: &AppHandle,
    manager: &PortForwardManager,
    operation_id: &str,
    update: impl FnOnce(&mut PortForwardRuntime),
) {
    match manager.update(operation_id, update) {
        Ok(runtime) => emit_runtime(app, &runtime),
        Err(error) => warn!("Failed to update port forward {operation_id}: {error}"),
    }
}

pub(crate) fn start_port_forward(
    app: AppHandle,
    manager: PortForwardManager,
    request: PortForwardStartRequest,
    cancel_flag: Arc<AtomicBool>,
    local_listener: Option<TcpListener>,
    known_hosts_path: String,
) {
    let operation_id = request.operation_id.clone();
    let profile_id = request.profile_id.clone();
    let connection = request.connection;
    let config = request.forward;
    let sent = Arc::new(AtomicU64::new(0));
    let received = Arc::new(AtomicU64::new(0));
    let known_hosts = Path::new(&known_hosts_path);

    info!(
        "Starting port forward operation_id={} profile_id={} config_id={} kind={:?}",
        operation_id, profile_id, config.id, config.kind
    );

    let ticks = AtomicU64::new(0);
    let report = || {
        if ticks.fetch_add(1, Ordering::Relaxed).is_multiple_of(5) {
            update_and_emit(&app, &manager, &operation_id, |runtime| {
                runtime.bytes_sent = sent.load(Ordering::Relaxed);
                runtime.bytes_received = received.load(Ordering::Relaxed);
            });
        }
    };

    let result = match config.kind {
        PortForwardKind::Local => local_forward_loop(
            &connection,
            local_listener.expect("local forward listener was pre-bound"),
            &config.remote_host,
            config.remote_port,
            cancel_flag.clone(),
            sent.clone(),
            received.clone(),
            known_hosts,
            || {
                update_and_emit(&app, &manager, &operation_id, |runtime| {
                    runtime.status = PortForwardStatus::Running;
                    runtime.started_at = Some(now_millis());
                });
            },
            report,
            |error| {
                let category = classify_error(&error);
                update_and_emit(&app, &manager, &operation_id, |runtime| {
                    runtime.last_error = Some(error);
                    runtime.error_category = Some(category);
                });
            },
        ),
        PortForwardKind::Remote => remote_forward_loop(
            &connection,
            config.local_port,
            &config.remote_host,
            config.remote_port,
            cancel_flag.clone(),
            sent.clone(),
            received.clone(),
            known_hosts,
            || {
                update_and_emit(&app, &manager, &operation_id, |runtime| {
                    runtime.status = PortForwardStatus::Running;
                    runtime.started_at = Some(now_millis());
                });
            },
            report,
            |error| {
                let category = classify_error(&error);
                update_and_emit(&app, &manager, &operation_id, |runtime| {
                    runtime.last_error = Some(error);
                    runtime.error_category = Some(category);
                });
            },
        ),
    };

    let bytes_sent = sent.load(Ordering::Relaxed);
    let bytes_received = received.load(Ordering::Relaxed);
    if let Err(error) = result {
        let category = classify_error(&error);
        warn!("Port forward operation {operation_id} failed: {error}");
        update_and_emit(&app, &manager, &operation_id, |runtime| {
            runtime.status = PortForwardStatus::Failed;
            runtime.stopped_at = Some(now_millis());
            runtime.bytes_sent = bytes_sent;
            runtime.bytes_received = bytes_received;
            runtime.last_error = Some(error);
            runtime.error_category = Some(category);
        });
    } else {
        update_and_emit(&app, &manager, &operation_id, |runtime| {
            runtime.status = PortForwardStatus::Stopped;
            runtime.stopped_at = Some(now_millis());
            runtime.bytes_sent = bytes_sent;
            runtime.bytes_received = bytes_received;
        });
    }
    if let Err(error) = manager.prune_finished() {
        warn!("Failed to prune port forward history: {error}");
    }
}

pub(crate) fn validate_start_request(request: &PortForwardStartRequest) -> Result<(), String> {
    for (label, value) in [
        ("operation", request.operation_id.as_str()),
        ("profile", request.profile_id.as_str()),
        ("configuration", request.forward.id.as_str()),
    ] {
        let mut chars = value.chars();
        if value.len() > 128
            || !chars
                .next()
                .is_some_and(|character| character.is_ascii_alphanumeric())
            || !chars.all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
            })
        {
            return Err(format!("port forward {label} identifier is invalid"));
        }
    }
    let name = request.forward.name.trim();
    if name.is_empty() || name.len() > 100 || name.chars().any(char::is_control) {
        return Err("port forward name is invalid".to_string());
    }
    if request.forward.local_port == 0 || request.forward.remote_port == 0 {
        return Err("port forward ports must be between 1 and 65535".to_string());
    }
    let remote_host = request.forward.remote_host.trim();
    if remote_host.is_empty() || remote_host.len() > 255 {
        return Err("port forward host is invalid".to_string());
    }
    if request.forward.kind == PortForwardKind::Remote
        && !matches!(remote_host, "127.0.0.1" | "localhost" | "::1")
    {
        return Err("remote forwarding is restricted to the remote loopback interface".to_string());
    }
    validate_host(remote_host)?;
    Ok(())
}

pub(crate) fn bind_local_listener(config: &PortForwardConfig) -> Result<TcpListener, String> {
    let listener = TcpListener::bind(("127.0.0.1", config.local_port)).map_err(|error| {
        format!(
            "local port 127.0.0.1:{} is already in use or unavailable: {error}",
            config.local_port
        )
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("failed to configure local listener: {error}"))?;
    Ok(listener)
}

fn classify_error(error: &str) -> PortForwardErrorCategory {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("already in use")
        || normalized.contains("address in use")
        || normalized.contains("failed to listen")
    {
        PortForwardErrorCategory::PortInUse
    } else if normalized.contains("host key") || normalized.contains("known host") {
        PortForwardErrorCategory::HostKey
    } else if normalized.contains("auth") || normalized.contains("credential") {
        PortForwardErrorCategory::Authentication
    } else if normalized.contains("invalid") || normalized.contains("must be") {
        PortForwardErrorCategory::InvalidConfiguration
    } else if normalized.contains("connect")
        || normalized.contains("resolve")
        || normalized.contains("handshake")
    {
        PortForwardErrorCategory::Connection
    } else {
        PortForwardErrorCategory::Other
    }
}

struct ForwardSession {
    target: ssh2::Session,
    _jump: Option<ssh2::Session>,
}

pub(crate) struct ScopedLoopbackConnection {
    stream: Option<TcpStream>,
    cancel: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<Result<(), String>>>,
    outcome: std::sync::mpsc::Receiver<Result<(), String>>,
}

struct ScopedForwardCancelGuard {
    cancel: Arc<AtomicBool>,
    armed: bool,
}

impl ScopedForwardCancelGuard {
    fn new(cancel: Arc<AtomicBool>) -> Self {
        Self {
            cancel,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ScopedForwardCancelGuard {
    fn drop(&mut self) {
        if self.armed {
            self.cancel.store(true, Ordering::SeqCst);
        }
    }
}

impl ScopedLoopbackConnection {
    pub(crate) fn take_stream(&mut self) -> Result<TcpStream, String> {
        self.stream
            .take()
            .ok_or_else(|| "scoped loopback connection was already consumed".into())
    }

    pub(crate) fn finish(mut self, deadline: std::time::Instant) -> Result<(), String> {
        drop(self.stream.take());
        let remaining = remaining_scoped_forward_time(deadline)?;
        let outcome = self
            .outcome
            .recv_timeout(remaining)
            .map_err(|error| match error {
                std::sync::mpsc::RecvTimeoutError::Timeout => {
                    "target loopback SSH transport exceeded its total deadline".to_string()
                }
                std::sync::mpsc::RecvTimeoutError::Disconnected => {
                    "target loopback SSH transport stopped without an outcome".to_string()
                }
            })?;
        let worker = self
            .worker
            .take()
            .ok_or_else(|| "target loopback SSH transport lost its worker handle".to_string())?;
        worker
            .join()
            .map_err(|_| "target loopback SSH transport worker panicked".to_string())??;
        outcome
    }
}

impl Drop for ScopedLoopbackConnection {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        drop(self.stream.take());
        // A blocking SSH handshake cannot be interrupted portably. Detach the
        // bounded worker rather than allowing Drop to exceed the tool deadline.
        drop(self.worker.take());
    }
}

pub(crate) fn open_scoped_loopback_connection(
    connection: &RemoteConnectionRequest,
    remote_port: u16,
    known_hosts_path: &Path,
    deadline: std::time::Instant,
) -> Result<ScopedLoopbackConnection, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = Arc::clone(&cancel);
    let worker_connection = connection.clone();
    let worker_known_hosts_path = known_hosts_path.to_path_buf();
    let (stream_tx, stream_rx) = std::sync::mpsc::sync_channel(1);
    let (outcome_tx, outcome_rx) = std::sync::mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        let mut stream_tx = Some(stream_tx);
        let result = (|| {
            let session = open_forward_session(
                &worker_connection.host,
                worker_connection.port,
                &worker_connection.username,
                worker_connection.auth_method,
                worker_connection.password.as_deref(),
                worker_connection.private_key_data.as_deref(),
                worker_connection.passphrase.as_deref(),
                worker_connection.jump_host.as_ref(),
                &worker_known_hosts_path,
            )?;
            if worker_cancel.load(Ordering::SeqCst) {
                return Err("scoped loopback connection was cancelled before SSH setup".into());
            }
            let channel = session
                .target
                .channel_direct_tcpip("127.0.0.1", remote_port, None)
                .map_err(|error| {
                    format!(
                        "failed to open SSH channel to target loopback 127.0.0.1:{remote_port}: {error}"
                    )
                })?;
            if worker_cancel.load(Ordering::SeqCst) {
                return Err("scoped loopback connection was cancelled before bridging".into());
            }
            let (client, bridge) = connected_loopback_pair(deadline)?;
            let remaining = remaining_scoped_forward_time(deadline)?;
            bridge
                .set_read_timeout(Some(remaining))
                .map_err(|error| format!("failed to bound scoped transport reads: {error}"))?;
            bridge
                .set_write_timeout(Some(remaining))
                .map_err(|error| format!("failed to bound scoped transport writes: {error}"))?;
            if stream_tx
                .take()
                .expect("scoped stream sender exists")
                .send(Ok(client))
                .is_err()
            {
                return Err("scoped HTTP client stopped before receiving its transport".into());
            }
            bridge_single_connection(
                channel,
                bridge,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            )
        })();
        if let Err(error) = &result {
            if let Some(sender) = stream_tx.take() {
                let _ = sender.send(Err(error.clone()));
            }
        }
        let _ = outcome_tx.send(result.clone());
        result
    });
    let mut cancel_guard = ScopedForwardCancelGuard::new(Arc::clone(&cancel));
    let remaining = remaining_scoped_forward_time(deadline)?;
    let stream = match stream_rx.recv_timeout(remaining) {
        Ok(Ok(stream)) => stream,
        Ok(Err(error)) => {
            return Err(format!(
                "failed to establish target loopback SSH transport: {error}"
            ))
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            drop(worker);
            return Err("target loopback SSH setup exceeded its total deadline".into());
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            return Err("target loopback SSH setup stopped before returning a transport".into());
        }
    };
    let connection = ScopedLoopbackConnection {
        stream: Some(stream),
        cancel,
        worker: Some(worker),
        outcome: outcome_rx,
    };
    cancel_guard.disarm();
    Ok(connection)
}

fn connected_loopback_pair(deadline: std::time::Instant) -> Result<(TcpStream, TcpStream), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("failed to bind internal loopback transport: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("failed to configure internal loopback transport: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("failed to inspect internal loopback transport: {error}"))?;
    let client = TcpStream::connect_timeout(&address, remaining_scoped_forward_time(deadline)?)
        .map_err(|error| format!("failed to create internal loopback transport: {error}"))?;
    let expected_peer = client
        .local_addr()
        .map_err(|error| format!("failed to identify internal loopback client: {error}"))?;
    loop {
        match listener.accept() {
            Ok((bridge, peer)) if peer == expected_peer => {
                bridge.set_nonblocking(false).map_err(|error| {
                    format!("failed to configure internal loopback bridge: {error}")
                })?;
                return Ok((client, bridge));
            }
            Ok((_unexpected, _)) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                remaining_scoped_forward_time(deadline)?;
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => {
                return Err(format!(
                    "internal loopback transport accept failed: {error}"
                ));
            }
        }
    }
}

fn remaining_scoped_forward_time(deadline: std::time::Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(std::time::Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| "target loopback SSH transport exceeded its total deadline".into())
}

fn open_forward_session(
    host: &str,
    port: u16,
    username: &str,
    auth_method: AuthMethod,
    password: Option<&str>,
    private_key_data: Option<&str>,
    passphrase: Option<&str>,
    jump_host: Option<&JumpHostConfig>,
    known_hosts_path: &Path,
) -> Result<ForwardSession, String> {
    if let Some(jump) = jump_host {
        let (jump_session, target) = connect_through_jump_host(
            jump,
            host,
            port,
            username,
            auth_method,
            password,
            private_key_data,
            passphrase,
            Some(known_hosts_path),
        )
        .map_err(|error| error.message())?;
        Ok(ForwardSession {
            target,
            _jump: Some(jump_session),
        })
    } else {
        let tcp = connect_tcp_stream(host, port)?;
        let session = open_authenticated_session(
            tcp,
            username,
            auth_method,
            password,
            private_key_data,
            passphrase,
            host,
            port,
            Some(known_hosts_path),
        )
        .map_err(|error| error.message())?;
        session.set_keepalive(true, 30);
        Ok(ForwardSession {
            target: session,
            _jump: None,
        })
    }
}

// ---------- Local forwarding ----------

fn local_forward_loop(
    connection: &RemoteConnectionRequest,
    listener: TcpListener,
    remote_host: &str,
    remote_port: u16,
    cancel_flag: Arc<AtomicBool>,
    bytes_sent: Arc<AtomicU64>,
    bytes_received: Arc<AtomicU64>,
    known_hosts_path: &Path,
    on_ready: impl FnOnce(),
    on_tick: impl Fn(),
    on_error: impl Fn(String),
) -> Result<(), String> {
    let session = open_forward_session(
        &connection.host,
        connection.port,
        &connection.username,
        connection.auth_method,
        connection.password.as_deref(),
        connection.private_key_data.as_deref(),
        connection.passphrase.as_deref(),
        connection.jump_host.as_ref(),
        known_hosts_path,
    )?;
    let remote_host = remote_host.to_owned();
    let local_port = listener
        .local_addr()
        .map_err(|error| format!("failed to inspect local listener: {error}"))?
        .port();

    info!("Local forward 127.0.0.1:{local_port} -> {remote_host}:{remote_port}");
    on_ready();

    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            info!("Local forward {local_port} cancelled");
            break;
        }

        match listener.accept() {
            Ok((local, addr)) => {
                info!("Local forward accepted {addr}");
                match session
                    .target
                    .channel_direct_tcpip(&remote_host, remote_port, None)
                {
                    Ok(channel) => {
                        let sent = bytes_sent.clone();
                        let received = bytes_received.clone();
                        thread::spawn(move || {
                            if let Err(error) =
                                bridge_single_connection(channel, local, sent, received)
                            {
                                warn!("Local forward connection ended with error: {error}");
                            }
                        });
                    }
                    Err(error) => {
                        let message =
                            format!("direct-tcpip to {remote_host}:{remote_port} failed: {error}");
                        warn!("{message}");
                        on_error(message);
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                on_tick();
                thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                let message = format!("Local forward accept error: {e}");
                warn!("{message}");
                on_error(message);
                thread::sleep(Duration::from_millis(500));
            }
        }
    }

    Ok(())
}

// ---------- Remote forwarding ----------

fn remote_forward_loop(
    connection: &RemoteConnectionRequest,
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
    cancel_flag: Arc<AtomicBool>,
    bytes_sent: Arc<AtomicU64>,
    bytes_received: Arc<AtomicU64>,
    known_hosts_path: &Path,
    on_ready: impl FnOnce(),
    on_tick: impl Fn(),
    on_error: impl Fn(String),
) -> Result<(), String> {
    let session = open_forward_session(
        &connection.host,
        connection.port,
        &connection.username,
        connection.auth_method,
        connection.password.as_deref(),
        connection.private_key_data.as_deref(),
        connection.passphrase.as_deref(),
        connection.jump_host.as_ref(),
        known_hosts_path,
    )?;
    let remote_host = remote_host.to_owned();

    let (mut listener, _) = session
        .target
        .channel_forward_listen(remote_port, Some(&remote_host), None)
        .map_err(|e| format!("failed to listen on {remote_host}:{remote_port}: {e}"))?;
    // Listener setup is a request/response exchange and must complete in
    // blocking mode. Only the accept loop is non-blocking so cancellation and
    // live statistics remain responsive.
    session.target.set_blocking(false);

    info!("Remote forward {remote_host}:{remote_port} -> 127.0.0.1:{local_port}");
    on_ready();

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
                        let sent = bytes_sent.clone();
                        let received = bytes_received.clone();
                        thread::spawn(move || {
                            if let Err(error) =
                                bridge_single_connection(channel, local, sent, received)
                            {
                                warn!("Remote forward connection ended with error: {error}");
                            }
                        });
                    }
                    Err(error) => {
                        let message = format!("connect to 127.0.0.1:{local_port} failed: {error}");
                        warn!("{message}");
                        on_error(message);
                    }
                }
            }
            Err(e) => {
                let io_error: std::io::Error = e.into();
                if io_error.kind() == std::io::ErrorKind::WouldBlock {
                    on_tick();
                    thread::sleep(Duration::from_millis(100));
                } else {
                    let message = format!("Remote forward accept error: {io_error}");
                    warn!("{message}");
                    on_error(message);
                    thread::sleep(Duration::from_millis(500));
                }
            }
        }
    }

    Ok(())
}

// ---------- Bidirectional bridge ----------

fn bridge_single_connection(
    mut channel: ssh2::Channel,
    mut tcp: TcpStream,
    bytes_sent: Arc<AtomicU64>,
    bytes_received: Arc<AtomicU64>,
) -> Result<(), String> {
    let mut tcp_clone = tcp
        .try_clone()
        .map_err(|e| format!("failed to clone tcp: {e}"))?;
    let mut channel_stream = channel.stream(0);

    let t1 = thread::spawn(move || copy_counted(&mut tcp_clone, &mut channel_stream, &bytes_sent));
    let t2 = thread::spawn(move || copy_counted(&mut channel, &mut tcp, &bytes_received));

    t1.join()
        .map_err(|_| "port forward upload bridge panicked".to_string())??;
    t2.join()
        .map_err(|_| "port forward download bridge panicked".to_string())??;
    Ok(())
}

fn copy_counted(
    reader: &mut impl Read,
    writer: &mut impl Write,
    counter: &AtomicU64,
) -> Result<(), String> {
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            Err(error) => return Err(format!("forward read failed: {error}")),
        };
        if count == 0 {
            writer.flush().ok();
            return Ok(());
        }
        let mut written = 0;
        while written < count {
            match writer.write(&buffer[written..count]) {
                Ok(0) => return Err("forward write returned zero bytes".to_string()),
                Ok(size) => written += size,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(format!("forward write failed: {error}")),
            }
        }
        counter.fetch_add(count as u64, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    include!("tests/port_forward.rs");
}
