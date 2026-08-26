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
    use super::*;
    use crate::models::{AuthMethod, RemoteConnectionRequest};

    fn sample_request() -> RemoteConnectionRequest {
        RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        }
    }

    fn begin_leader(pool: &SftpPool, key: &ConnectionKey) -> ConnectLeaderGuard {
        match pool.begin_connect(key) {
            ConnectClaim::Leader(guard) => guard,
            ConnectClaim::Follower(_) => panic!("first claim must be the leader"),
        }
    }

    fn follower_failure(error: ConnectionError) -> ConnectionError {
        let pool = SftpPool::default();
        let key = connection_key(&sample_request());
        let leader = begin_leader(&pool, &key);
        let slot = match pool.begin_connect(&key) {
            ConnectClaim::Follower(slot) => slot,
            ConnectClaim::Leader(_) => panic!("second claim must be a follower"),
        };

        let waiter_pool = pool.clone();
        let waiter_key = key.clone();
        let waiter = std::thread::spawn(move || waiter_pool.wait_connect(&waiter_key, slot, None));
        assert!(pool.finish_connect(&leader, Err(error)).is_err());

        let result = waiter.join().expect("follower thread should finish");
        drop(leader);
        match result {
            Err(error) => error,
            Ok(_) => panic!("follower unexpectedly received a connection"),
        }
    }

    #[test]
    fn invalidate_does_not_panic_on_empty_pool() {
        let pool = SftpPool::default();
        let request = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };

        pool.invalidate(&request);
        assert!(pool.get(&request).is_none());
    }

    #[test]
    fn health_check_is_only_required_after_verification_threshold() {
        // Freshly verified entries skip the realpath round-trip; entries last
        // verified at or beyond the window are re-checked.
        assert!(!should_health_check(Duration::from_secs(29)));
        assert!(should_health_check(Duration::from_secs(30)));
    }

    #[test]
    fn pool_lookup_returns_a_distinct_abort_error() {
        let pool = SftpPool::default();
        let aborted = AtomicBool::new(true);

        match pool.get_with_abort(&sample_request(), Some(&aborted)) {
            Err(ConnectionError::Other { message }) => {
                assert_eq!(message, SFTP_POOL_GET_ABORTED_MESSAGE);
            }
            Err(error) => panic!("unexpected pool lookup error: {error:?}"),
            Ok(_) => panic!("aborted pool lookup unexpectedly continued"),
        }
    }

    #[test]
    fn aborted_follower_exits_without_releasing_the_shared_leader() {
        let pool = SftpPool::default();
        let key = connection_key(&sample_request());
        let leader = begin_leader(&pool, &key);
        let slot = match pool.begin_connect(&key) {
            ConnectClaim::Follower(slot) => slot,
            ConnectClaim::Leader(_) => panic!("second claim must be a follower"),
        };
        let aborted = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = std::sync::mpsc::channel();

        let waiter_pool = pool.clone();
        let waiter_key = key.clone();
        let waiter_slot = slot.clone();
        let waiter_abort = aborted.clone();
        let waiter = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            waiter_pool.wait_connect(&waiter_key, waiter_slot, Some(&waiter_abort))
        });

        started_rx.recv().unwrap();
        aborted.store(true, Ordering::SeqCst);
        // Avoid making the test depend on the polling interval when the waiter
        // is already asleep. If this notification races ahead of the wait, the
        // bounded slice still guarantees another cancellation check.
        slot.ready.notify_all();

        match waiter.join().expect("follower thread should finish") {
            Err(ConnectionError::Other { message }) => {
                assert_eq!(message, SFTP_POOL_GET_ABORTED_MESSAGE);
            }
            Err(error) => panic!("unexpected follower error: {error:?}"),
            Ok(_) => panic!("aborted follower unexpectedly received a connection"),
        }
        assert!(pool
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &slot)));
        assert!(matches!(
            *slot
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            ConnectState::Pending
        ));

        assert!(pool
            .finish_connect(
                &leader,
                Err(ConnectionError::Other {
                    message: "test cleanup".to_string(),
                }),
            )
            .is_err());
    }

    #[test]
    fn follower_wait_slices_bound_cancellation_latency_without_shortening_the_deadline() {
        assert_eq!(
            follower_wait_slice(Duration::from_secs(1)),
            SFTP_CONNECT_WAIT_POLL_INTERVAL
        );
        assert_eq!(
            follower_wait_slice(Duration::from_millis(10)),
            Duration::from_millis(10)
        );
    }

    #[test]
    fn health_probe_rechecks_abort_after_lock_before_network_work() {
        let connection = Mutex::new(());
        let connected = connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let aborted = AtomicBool::new(true);
        let probe_called = AtomicBool::new(false);

        let result = run_health_probe_after_lock(connected, Some(&aborted), |_| {
            probe_called.store(true, Ordering::SeqCst);
            true
        });

        match result {
            Err(ConnectionError::Other { message }) => {
                assert_eq!(message, SFTP_POOL_GET_ABORTED_MESSAGE);
            }
            Err(error) => panic!("unexpected health probe error: {error:?}"),
            Ok(_) => panic!("aborted health probe unexpectedly ran"),
        }
        assert!(!probe_called.load(Ordering::SeqCst));
    }

    #[test]
    fn begin_connect_grants_leadership_to_only_one_caller() {
        let pool = SftpPool::default();
        let request = sample_request();
        let key = connection_key(&request);

        // The leader guard must stay bound: dropping it aborts the slot.
        let leader = begin_leader(&pool, &key);
        assert!(matches!(
            pool.begin_connect(&key),
            ConnectClaim::Follower(_)
        ));

        // Once the leader finishes, the slot is released and the next caller
        // becomes the leader again.
        pool.finish_connect(
            &leader,
            Err(crate::models::ConnectionError::Other {
                message: "boom".to_string(),
            }),
        )
        .ok();
        drop(leader);
        assert!(matches!(pool.begin_connect(&key), ConnectClaim::Leader(_)));
    }

    #[test]
    fn leader_guard_drop_fails_pending_slot() {
        // Simulates a leader panicking between begin_connect and
        // finish_connect: dropping the guard must wake followers with a
        // failure instead of letting them wait forever.
        let pool = SftpPool::default();
        let key = connection_key(&sample_request());

        let guard = match pool.begin_connect(&key) {
            ConnectClaim::Leader(guard) => guard,
            ConnectClaim::Follower(_) => panic!("first claim must be the leader"),
        };
        let slot = match pool.begin_connect(&key) {
            ConnectClaim::Follower(slot) => slot,
            ConnectClaim::Leader(_) => panic!("second claim must be a follower"),
        };

        let waiter_pool = pool.clone();
        let waiter_key = key.clone();
        let waiter = std::thread::spawn(move || waiter_pool.wait_connect(&waiter_key, slot, None));
        drop(guard);

        let result = waiter.join().expect("follower thread should finish");
        match result {
            Err(ConnectionError::Other { message }) => {
                assert_eq!(message, "connection attempt aborted");
            }
            Err(error) => panic!("unexpected follower error: {error:?}"),
            Ok(_) => panic!("follower unexpectedly received a connection"),
        }

        // The slot is released, so the next caller becomes the leader again.
        assert!(matches!(pool.begin_connect(&key), ConnectClaim::Leader(_)));
    }

    #[test]
    fn stale_leader_finish_and_drop_leave_replacement_generation_untouched() {
        let pool = SftpPool::default();
        let key = connection_key(&sample_request());
        let old_leader = begin_leader(&pool, &key);
        let old_slot = match pool.begin_connect(&key) {
            ConnectClaim::Follower(slot) => slot,
            ConnectClaim::Leader(_) => panic!("second claim must be a follower"),
        };

        // Deterministically simulate the timeout path releasing the old slot so
        // a retry can install a new generation while the old handshake is still
        // running.
        {
            let mut in_flight = pool
                .in_flight
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(in_flight
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &old_slot)));
            in_flight.remove(&key);
        }

        let replacement_leader = begin_leader(&pool, &key);
        let replacement_slot = match pool.begin_connect(&key) {
            ConnectClaim::Follower(slot) => slot,
            ConnectClaim::Leader(_) => panic!("replacement follower became a leader"),
        };

        assert!(pool
            .finish_connect(
                &old_leader,
                Err(ConnectionError::Other {
                    message: "old generation failed".to_string(),
                }),
            )
            .is_err());

        {
            let state = old_slot
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(matches!(
                &*state,
                ConnectState::Failed(ConnectionError::Other { message })
                    if message == "old generation failed"
            ));
        }
        {
            let state = replacement_slot
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(matches!(*state, ConnectState::Pending));
        }
        assert!(pool
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &replacement_slot)));

        // Dropping the completed old guard must still use slot identity and
        // leave the replacement claimed and pending.
        drop(old_leader);
        {
            let state = replacement_slot
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(matches!(*state, ConnectState::Pending));
        }
        assert!(pool
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &replacement_slot)));

        // Resolve the replacement normally so its guard has no pending work on
        // drop and the test leaves no in-flight generation behind.
        assert!(pool
            .finish_connect(
                &replacement_leader,
                Err(ConnectionError::Other {
                    message: "replacement failed".to_string(),
                }),
            )
            .is_err());
    }

    #[test]
    fn stale_success_skips_reusable_pool_publish_while_replacement_is_active() {
        let pool = SftpPool::default();
        let key = connection_key(&sample_request());
        let old_leader = begin_leader(&pool, &key);
        let old_slot = old_leader.slot.clone();

        {
            let mut in_flight = pool
                .in_flight
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            in_flight.remove(&key);
        }
        let replacement_leader = begin_leader(&pool, &key);

        let owns_generation = {
            let in_flight = pool
                .in_flight
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            connect_generation_is_current(&in_flight, &old_leader)
        };
        let publish_calls = std::cell::Cell::new(0);
        let returned = publish_connection_if_current(owns_generation, "old", |connection| {
            publish_calls.set(publish_calls.get() + 1);
            connection
        });

        assert_eq!(returned, "old");
        assert_eq!(publish_calls.get(), 0, "stale success polluted the pool");
        let replacement_owns_generation = {
            let in_flight = pool
                .in_flight
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            connect_generation_is_current(&in_flight, &replacement_leader)
        };
        let returned = publish_connection_if_current(
            replacement_owns_generation,
            "replacement",
            |connection| {
                publish_calls.set(publish_calls.get() + 1);
                connection
            },
        );
        assert_eq!(returned, "replacement");
        assert_eq!(
            publish_calls.get(),
            1,
            "current success did not publish exactly once"
        );
        assert!(pool
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &replacement_leader.slot)));
        assert!(matches!(
            *old_slot
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            ConnectState::Pending
        ));

        // Complete both synthetic generations through failure paths because a
        // unit ConnectedSftp requires a real SSH server; the success-specific
        // reusable-publish decision above is generic and counted directly.
        assert!(pool
            .finish_connect(
                &old_leader,
                Err(ConnectionError::Other {
                    message: "old cleanup".to_string(),
                }),
            )
            .is_err());
        assert!(pool
            .finish_connect(
                &replacement_leader,
                Err(ConnectionError::Other {
                    message: "replacement cleanup".to_string(),
                }),
            )
            .is_err());
    }

    #[test]
    fn wait_connect_follower_receives_leader_failure() {
        let pool = SftpPool::default();
        let key = connection_key(&sample_request());

        let leader = begin_leader(&pool, &key);
        let slot = match pool.begin_connect(&key) {
            ConnectClaim::Follower(slot) => slot,
            ConnectClaim::Leader(_) => panic!("second claim must be a follower"),
        };

        let waiter_pool = pool.clone();
        let waiter_key = key.clone();
        let waiter = std::thread::spawn(move || waiter_pool.wait_connect(&waiter_key, slot, None));
        pool.finish_connect(
            &leader,
            Err(crate::models::ConnectionError::Other {
                message: "handshake failed".to_string(),
            }),
        )
        .ok();

        let result = waiter.join().expect("follower thread should finish");
        match result {
            Err(ConnectionError::Other { message }) => assert_eq!(message, "handshake failed"),
            Err(error) => panic!("unexpected follower error: {error:?}"),
            Ok(_) => panic!("follower unexpectedly received a connection"),
        }
        drop(leader);
    }

    #[test]
    fn wait_connect_follower_preserves_unknown_host_key_classification() {
        let error = follower_failure(ConnectionError::HostKeyUnknown {
            host: "unknown.example.com".to_string(),
            port: 2222,
            fingerprint: Some("ED25519 SHA256:test".to_string()),
        });

        match error {
            ConnectionError::HostKeyUnknown {
                host,
                port,
                fingerprint,
            } => {
                assert_eq!(host, "unknown.example.com");
                assert_eq!(port, 2222);
                assert_eq!(fingerprint.as_deref(), Some("ED25519 SHA256:test"));
            }
            error => panic!("unexpected follower error: {error:?}"),
        }
    }

    #[test]
    fn wait_connect_follower_preserves_mismatched_host_key_classification() {
        let error = follower_failure(ConnectionError::HostKeyMismatch {
            host: "changed.example.com".to_string(),
            port: 22,
            fingerprint: Some("ED25519 SHA256:changed".to_string()),
        });

        match error {
            ConnectionError::HostKeyMismatch {
                host,
                port,
                fingerprint,
            } => {
                assert_eq!(host, "changed.example.com");
                assert_eq!(port, 22);
                assert_eq!(fingerprint.as_deref(), Some("ED25519 SHA256:changed"));
            }
            error => panic!("unexpected follower error: {error:?}"),
        }
    }

    #[test]
    fn connection_key_is_stable_for_equal_requests() {
        let request = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };

        assert_eq!(connection_key(&request), connection_key(&request));
    }

    #[test]
    fn connection_key_differs_when_credentials_differ() {
        let base = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };
        let mut other = base.clone();
        other.username = "bob".to_string();

        assert_ne!(connection_key(&base), connection_key(&other));
    }

    #[test]
    fn connection_key_distinguishes_none_and_empty_string() {
        let with_empty = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };
        let with_none = RemoteConnectionRequest {
            password: None,
            keychain_key_id: None,
            private_key_data: None,
            ..with_empty.clone()
        };

        assert_ne!(connection_key(&with_empty), connection_key(&with_none));
    }

    #[test]
    fn connection_key_distinguishes_some_value_from_matching_prefix() {
        // Ensure Some("none") does not collide with None and Some("foo") does not
        // collide with any other field.
        let base = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("none".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };
        let with_none_password = RemoteConnectionRequest {
            password: None,
            keychain_key_id: None,
            private_key_data: None,
            ..base.clone()
        };

        assert_ne!(connection_key(&base), connection_key(&with_none_password));
    }

    #[test]
    fn connection_key_does_not_contain_raw_secrets() {
        let host_pass = "super-secret-password";
        let host_phrase = "super-secret-passphrase";
        let host_key_data = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc123";
        let request = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some(host_pass.to_string()),
            keychain_key_id: None,
            private_key_data: Some(host_key_data.to_string()),
            passphrase: Some(host_phrase.to_string()),
            jump_host: None,
        };

        let key = connection_key(&request);

        assert!(
            !key.host.contains(host_pass),
            "key must not contain raw password"
        );
        assert!(
            !key.passphrase_hash.contains(host_phrase),
            "key must not contain raw passphrase"
        );
        assert!(
            !key.private_key_data_hash.contains(host_key_data),
            "key must not contain raw private key data"
        );
    }

    #[test]
    fn connection_key_does_not_contain_jump_host_raw_secrets() {
        let jump_pass = "jump-secret-password";
        let jump_phrase = "jump-secret-passphrase";
        let jump_key_data = "-----BEGIN OPENSSH PRIVATE KEY-----\njump-key-data";
        let request = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("host-password".to_string()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: Some(JumpHostConfig {
                host: "jump.example.com".to_string(),
                port: 22,
                username: "jump".to_string(),
                auth_method: AuthMethod::Key,
                password: Some(jump_pass.to_string()),
                keychain_key_id: None,
                private_key_data: Some(jump_key_data.to_string()),
                passphrase: Some(jump_phrase.to_string()),
            }),
        };

        let key = connection_key(&request);
        let jump_host_key = key.jump_host.as_ref().expect("jump host key present");

        assert!(
            !jump_host_key.password_hash.contains(jump_pass),
            "key must not contain raw jump-host password"
        );
        assert!(
            !jump_host_key.passphrase_hash.contains(jump_phrase),
            "key must not contain raw jump-host passphrase"
        );
        assert!(
            !jump_host_key.private_key_data_hash.contains(jump_key_data),
            "key must not contain raw jump-host private key data"
        );
    }

    #[test]
    fn equal_credentials_produce_equal_keys() {
        let base = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: Some("key-data".to_string()),
            passphrase: Some("phrase".to_string()),
            jump_host: Some(JumpHostConfig {
                host: "jump.example.com".to_string(),
                port: 22,
                username: "jump".to_string(),
                auth_method: AuthMethod::Key,
                password: Some("jump-secret".to_string()),
                keychain_key_id: None,
                private_key_data: Some("jump-key-data".to_string()),
                passphrase: Some("jump-phrase".to_string()),
            }),
        };
        let identical = base.clone();

        assert_eq!(connection_key(&base), connection_key(&identical));
    }

    #[test]
    fn connection_key_distinguishes_colon_in_host_and_username() {
        // A structured key must not collide when user-controlled strings contain
        // delimiters that would have merged fields in the old format-string key.
        let first = RemoteConnectionRequest {
            host: "example.com:2222".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };
        let second = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 2222,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };

        assert_ne!(connection_key(&first), connection_key(&second));

        let third = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice:bob".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };
        let fourth = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("bob:secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: None,
        };

        assert_ne!(connection_key(&third), connection_key(&fourth));
    }

    #[test]
    fn connection_key_distinguishes_jump_host_fields_with_colons() {
        // A structured jump-host key must not collide when user-controlled
        // strings contain delimiters that would have merged fields in the old
        // format-string key.
        let first = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: Some(JumpHostConfig {
                host: "a".to_string(),
                port: 1,
                username: "1:b".to_string(),
                auth_method: AuthMethod::Password,
                password: None,
                keychain_key_id: None,

                private_key_data: None,
                passphrase: None,
            }),
        };
        let second = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,

            passphrase: None,
            jump_host: Some(JumpHostConfig {
                host: "a:1".to_string(),
                port: 1,
                username: "b".to_string(),
                auth_method: AuthMethod::Password,
                password: None,
                keychain_key_id: None,

                private_key_data: None,
                passphrase: None,
            }),
        };

        assert_ne!(connection_key(&first), connection_key(&second));
    }
}
