use crate::models::{
    AuthMethod, ConnectedSftp, ConnectionError, JumpHostConfig, RemoteConnectionRequest,
};
use log::{debug, info, warn};
use sha2::{Digest, Sha256};
use std::collections::hash_map::{Entry, HashMap};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex, MutexGuard,
};
use std::time::{Duration, Instant};

const SFTP_POOL_IDLE_TTL: Duration = Duration::from_secs(300);
const SFTP_POOL_HEALTH_CHECK_IDLE: Duration = Duration::from_secs(30);
pub(crate) const SFTP_POOL_GET_ABORTED_MESSAGE: &str = "sftp pool lookup aborted";
const SFTP_CONNECT_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// Backstop for followers waiting on a leader's handshake; the leader guard
/// normally resolves the slot much earlier, this only catches stuck slots.
const SFTP_CONNECT_WAIT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Eq, PartialEq, Hash, Clone)]
pub(crate) struct ConnectionKey {
    host: String,
    port: u16,
    username: String,
    auth_method: AuthMethod,
    password_hash: String,
    private_key_data_hash: String,
    passphrase_hash: String,
    jump_host: Option<JumpHostKey>,
}

#[derive(Debug, Eq, PartialEq, Hash, Clone)]
pub(crate) struct JumpHostKey {
    host: String,
    port: u16,
    username: String,
    auth_method: AuthMethod,
    password_hash: String,
    private_key_data_hash: String,
    passphrase_hash: String,
}

#[derive(Default, Clone)]
pub(crate) struct SftpPool {
    sessions: Arc<Mutex<HashMap<ConnectionKey, PooledEntry>>>,
    in_flight: Arc<Mutex<HashMap<ConnectionKey, Arc<ConnectSlot>>>>,
}

struct PooledEntry {
    connection: Arc<Mutex<ConnectedSftp>>,
    last_used: Instant,
    last_verified: Instant,
}

impl PooledEntry {
    /// Gracefully close the SSH session before the entry is dropped; failures
    /// are ignored because the connection is being discarded anyway.
    fn disconnect(self) {
        let connected = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = connected.session.disconnect(None, "", None);
    }
}

fn disconnect_entries(entries: Vec<PooledEntry>) {
    for entry in entries {
        entry.disconnect();
    }
}

/// Outcome of claiming the right to establish a pooled connection: exactly one
/// caller becomes the leader and handshakes; concurrent callers become
/// followers waiting on the shared slot instead of handshaking themselves.
#[allow(clippy::large_enum_variant)]
pub(crate) enum ConnectClaim {
    Leader(ConnectLeaderGuard),
    Follower(Arc<ConnectSlot>),
}

/// Leader-side RAII guard. If the leader panics (or otherwise exits early)
/// between `begin_connect` and `finish_connect`, dropping the guard resolves
/// the slot as failed so followers never wait on it forever. After a normal
/// `finish_connect` the slot is already gone from `in_flight`, so the drop is
/// a no-op.
pub(crate) struct ConnectLeaderGuard {
    in_flight: Arc<Mutex<HashMap<ConnectionKey, Arc<ConnectSlot>>>>,
    key: ConnectionKey,
    slot: Arc<ConnectSlot>,
}

impl Drop for ConnectLeaderGuard {
    fn drop(&mut self) {
        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut state = self
            .slot
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let notify = if matches!(*state, ConnectState::Pending) {
            warn!(
                "SFTP connect leader for {} dropped before finishing; failing slot",
                self.key.label()
            );
            *state = ConnectState::Failed(ConnectionError::Other {
                message: "connection attempt aborted".to_string(),
            });
            true
        } else {
            false
        };

        // Publish this generation's failure before making the key vacant. This
        // prevents begin_connect from installing a replacement in the gap while
        // existing followers can still observe Pending.
        if in_flight
            .get(&self.key)
            .is_some_and(|current| Arc::ptr_eq(current, &self.slot))
        {
            in_flight.remove(&self.key);
        }
        drop(in_flight);
        drop(state);
        if notify {
            self.slot.ready.notify_all();
        }
    }
}

pub(crate) struct ConnectSlot {
    state: Mutex<ConnectState>,
    ready: Condvar,
}

enum ConnectState {
    Pending,
    Ready(Arc<Mutex<ConnectedSftp>>),
    Failed(ConnectionError),
}

impl ConnectSlot {
    fn new() -> Self {
        Self {
            state: Mutex::new(ConnectState::Pending),
            ready: Condvar::new(),
        }
    }
}

impl SftpPool {
    pub(crate) fn get(
        &self,
        request: &RemoteConnectionRequest,
    ) -> Option<Arc<Mutex<ConnectedSftp>>> {
        match self.get_with_abort(request, None) {
            Ok(connection) => connection,
            Err(_) => unreachable!("a pool lookup without an abort flag cannot be aborted"),
        }
    }

    pub(crate) fn get_with_abort(
        &self,
        request: &RemoteConnectionRequest,
        abort_flag: Option<&AtomicBool>,
    ) -> Result<Option<Arc<Mutex<ConnectedSftp>>>, ConnectionError> {
        ensure_pool_lookup_not_aborted(abort_flag)?;
        let key = connection_key(request);
        let mut evicted = Vec::new();
        let found = {
            let mut sessions = self.lock_sessions();
            // Opportunistic full-table sweep: evict every entry past the idle
            // TTL so stale connections do not linger until their own key is
            // requested again.
            let expired_keys: Vec<ConnectionKey> = sessions
                .iter()
                .filter(|(_, entry)| entry.last_used.elapsed() > SFTP_POOL_IDLE_TTL)
                .map(|(key, _)| key.clone())
                .collect();
            for expired_key in expired_keys {
                if let Some(entry) = sessions.remove(&expired_key) {
                    debug!(
                        "SFTP pool entry evicted after idle TTL {}",
                        expired_key.label()
                    );
                    evicted.push(entry);
                }
            }
            sessions.get_mut(&key).map(|entry| {
                entry.last_used = Instant::now();
                (entry.connection.clone(), entry.last_verified.elapsed())
            })
        };
        // Evicted entries are disconnected and dropped outside the pool lock
        // so their teardown never blocks other pool users.
        disconnect_entries(evicted);
        ensure_pool_lookup_not_aborted(abort_flag)?;

        let (connection, verified_idle) = match found {
            Some(found) => found,
            None => {
                debug!("SFTP pool miss {}", key.label());
                return Ok(None);
            }
        };

        // Throttle health checks: an entry verified inside the recent window
        // is trusted without a realpath round-trip on the get() hot path.
        if should_health_check(verified_idle) {
            if !connection_is_healthy(&connection, abort_flag)? {
                warn!("SFTP pool health check failed {}", key.label());
                self.remove_if_same(&key, &connection);
                return Ok(None);
            }
            self.mark_verified(&key, &connection);
        }

        debug!("SFTP pool hit {}", key.label());
        Ok(Some(connection))
    }

    pub(crate) fn get_or_insert(
        &self,
        key: &ConnectionKey,
        new_connection: Arc<Mutex<ConnectedSftp>>,
    ) -> Arc<Mutex<ConnectedSftp>> {
        let mut sessions = self.lock_sessions();
        let entry = match sessions.entry(key.clone()) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                info!("SFTP pool connection inserted {}", key.label());
                let now = Instant::now();
                entry.insert(PooledEntry {
                    connection: new_connection,
                    last_used: now,
                    last_verified: now,
                })
            }
        };
        entry.last_used = Instant::now();
        entry.connection.clone()
    }

    pub(crate) fn invalidate(&self, request: &RemoteConnectionRequest) {
        let key = connection_key(request);
        let removed = self.lock_sessions().remove(&key);
        if removed.is_some() {
            debug!("SFTP pool connection invalidated {}", key.label());
        }
        // Disconnect and drop outside the pool lock.
        disconnect_entries(removed.into_iter().collect());
    }

    /// Claim the right to establish a connection for `key`. Concurrent callers
    /// receive [`ConnectClaim::Follower`] and must wait on the slot instead of
    /// running their own handshake (prevents duplicate handshakes from the
    /// get()-miss/get_or_insert race).
    pub(crate) fn begin_connect(&self, key: &ConnectionKey) -> ConnectClaim {
        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match in_flight.entry(key.clone()) {
            Entry::Occupied(entry) => ConnectClaim::Follower(entry.get().clone()),
            Entry::Vacant(entry) => {
                let slot = Arc::new(ConnectSlot::new());
                entry.insert(slot.clone());
                ConnectClaim::Leader(ConnectLeaderGuard {
                    in_flight: self.in_flight.clone(),
                    key: key.clone(),
                    slot,
                })
            }
        }
    }

    /// Leader-side completion: publish the outcome to waiting followers and
    /// release the in-flight slot. On success the connection is also inserted
    /// into the pool.
    pub(crate) fn finish_connect(
        &self,
        leader: &ConnectLeaderGuard,
        result: Result<Arc<Mutex<ConnectedSftp>>, ConnectionError>,
    ) -> Result<Arc<Mutex<ConnectedSftp>>, ConnectionError> {
        debug_assert!(Arc::ptr_eq(&self.in_flight, &leader.in_flight));
        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let owns_generation = connect_generation_is_current(&in_flight, leader);
        // Only the generation that still owns the in-flight key may publish to
        // the reusable pool. A follower timeout can release an old slot and let
        // a replacement handshake start; if that old leader later succeeds, it
        // may still satisfy followers attached to its own slot, but must not
        // displace or become the reusable result of the replacement generation.
        // For the current generation, insert before releasing the in-flight
        // slot so another caller cannot observe both maps empty and start a
        // redundant handshake.
        let result = result.map(|connection| {
            publish_connection_if_current(owns_generation, connection, |connection| {
                self.get_or_insert(&leader.key, connection)
            })
        });
        let mut state = leader
            .slot
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *state = match &result {
            Ok(connection) => ConnectState::Ready(connection.clone()),
            Err(error) => ConnectState::Failed(error.clone()),
        };
        // Keep this generation claimed until after its outcome is visible to
        // every existing follower. A timed-out generation may already have
        // been replaced; in that case it publishes only to its own Arc and must
        // leave the replacement in the map untouched.
        if owns_generation {
            in_flight.remove(&leader.key);
        }
        drop(in_flight);
        drop(state);
        leader.slot.ready.notify_all();
        result
    }

    /// Follower-side wait: block until the leader publishes the outcome. Times
    /// out after [`SFTP_CONNECT_WAIT_TIMEOUT`] as a backstop: the stuck slot is
    /// released so the next caller can become the leader and retry.
    pub(crate) fn wait_connect(
        &self,
        key: &ConnectionKey,
        slot: Arc<ConnectSlot>,
        abort_flag: Option<&AtomicBool>,
    ) -> Result<Arc<Mutex<ConnectedSftp>>, ConnectionError> {
        let deadline = Instant::now() + SFTP_CONNECT_WAIT_TIMEOUT;
        let mut state = slot
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            // Cancellation belongs only to this follower. The shared leader and
            // its other followers remain untouched and may still reuse the
            // connection when the handshake completes.
            ensure_pool_lookup_not_aborted(abort_flag)?;
            match &*state {
                ConnectState::Pending => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    let (new_state, _) = slot
                        .ready
                        .wait_timeout(state, follower_wait_slice(remaining))
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    state = new_state;
                }
                ConnectState::Ready(connection) => return Ok(connection.clone()),
                ConnectState::Failed(error) => return Err(error.clone()),
            }
        }
        drop(state);
        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if in_flight
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, &slot))
        {
            warn!(
                "SFTP connect wait timed out {}; releasing slot",
                key.label()
            );
            in_flight.remove(key);
        }
        Err(ConnectionError::Other {
            message: "timed out waiting for the concurrent connection attempt".to_string(),
        })
    }

    fn mark_verified(&self, key: &ConnectionKey, expected: &Arc<Mutex<ConnectedSftp>>) {
        let mut sessions = self.lock_sessions();
        if let Some(entry) = sessions
            .get_mut(key)
            .filter(|entry| Arc::ptr_eq(&entry.connection, expected))
        {
            entry.last_verified = Instant::now();
        }
    }

    fn remove_if_same(&self, key: &ConnectionKey, expected: &Arc<Mutex<ConnectedSftp>>) {
        let removed = {
            let mut sessions = self.lock_sessions();
            if sessions
                .get(key)
                .is_some_and(|entry| Arc::ptr_eq(&entry.connection, expected))
            {
                sessions.remove(key)
            } else {
                None
            }
        };
        // Disconnect and drop outside the pool lock.
        disconnect_entries(removed.into_iter().collect());
    }

    fn lock_sessions(&self) -> MutexGuard<'_, HashMap<ConnectionKey, PooledEntry>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn publish_connection_if_current<T>(
    owns_generation: bool,
    connection: T,
    publish: impl FnOnce(T) -> T,
) -> T {
    if owns_generation {
        publish(connection)
    } else {
        connection
    }
}

fn connect_generation_is_current(
    in_flight: &HashMap<ConnectionKey, Arc<ConnectSlot>>,
    leader: &ConnectLeaderGuard,
) -> bool {
    in_flight
        .get(&leader.key)
        .is_some_and(|current| Arc::ptr_eq(current, &leader.slot))
}

fn follower_wait_slice(remaining: Duration) -> Duration {
    remaining.min(SFTP_CONNECT_WAIT_POLL_INTERVAL)
}

/// A pooled connection is re-verified only once it has not been successfully
/// verified within this window; recently used entries skip the round-trip.
fn should_health_check(since_last_verified: Duration) -> bool {
    since_last_verified >= SFTP_POOL_HEALTH_CHECK_IDLE
}

fn connection_is_healthy(
    connection: &Arc<Mutex<ConnectedSftp>>,
    abort_flag: Option<&AtomicBool>,
) -> Result<bool, ConnectionError> {
    let connected = connection
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    run_health_probe_after_lock(connected, abort_flag, |connected| {
        // Probe the root directory: realpath(".") fails on restricted servers
        // whose SFTP subsystem cannot resolve the user's home-relative cwd.
        connected.session.authenticated() && connected.sftp.realpath(Path::new("/")).is_ok()
    })
}

fn run_health_probe_after_lock<T>(
    connected: MutexGuard<'_, T>,
    abort_flag: Option<&AtomicBool>,
    probe: impl FnOnce(&T) -> bool,
) -> Result<bool, ConnectionError> {
    // The flag can become set while this caller is blocked on the shared
    // connection mutex. Re-check only after acquiring it and immediately before
    // the network probe so a superseded directory request does no stale I/O.
    ensure_pool_lookup_not_aborted(abort_flag)?;
    Ok(probe(&connected))
}

fn ensure_pool_lookup_not_aborted(abort_flag: Option<&AtomicBool>) -> Result<(), ConnectionError> {
    if abort_flag.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        return Err(ConnectionError::Other {
            message: SFTP_POOL_GET_ABORTED_MESSAGE.to_string(),
        });
    }
    Ok(())
}

impl ConnectionKey {
    fn label(&self) -> String {
        format!("{}@{}:{}", self.username, self.host, self.port)
    }

    pub(crate) fn jump_host_key(jump_host: Option<&JumpHostConfig>) -> Option<JumpHostKey> {
        jump_host.map(|jump_host| JumpHostKey {
            host: jump_host.host.clone(),
            port: jump_host.port,
            username: jump_host.username.clone(),
            auth_method: jump_host.auth_method,
            password_hash: hash_secret(jump_host.password.as_deref()),
            private_key_data_hash: hash_secret(jump_host.private_key_data.as_deref()),
            passphrase_hash: hash_secret(jump_host.passphrase.as_deref()),
        })
    }
}

pub(crate) fn connection_key(request: &RemoteConnectionRequest) -> ConnectionKey {
    ConnectionKey {
        host: request.host.clone(),
        port: request.port,
        username: request.username.clone(),
        auth_method: request.auth_method,
        password_hash: hash_secret(request.password.as_deref()),
        private_key_data_hash: hash_secret(request.private_key_data.as_deref()),
        passphrase_hash: hash_secret(request.passphrase.as_deref()),
        jump_host: ConnectionKey::jump_host_key(request.jump_host.as_ref()),
    }
}

fn hash_secret(value: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    match value {
        None => hasher.update(b"N"),
        Some("") => hasher.update(b"E"),
        Some(v) => {
            hasher.update(b"V:");
            hasher.update(v.as_bytes());
        }
    }
    // digest 0.11 的 Array 不再实现 LowerHex，手动做 hex 编码。
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    include!("tests/sftp_pool.rs");
}
