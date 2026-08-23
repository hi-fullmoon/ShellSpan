use crate::models::{
    AuthMethod, ConnectedSftp, ConnectionError, JumpHostConfig, RemoteConnectionRequest,
};
use log::{debug, info, warn};
use sha2::{Digest, Sha256};
use std::collections::hash_map::{Entry, HashMap};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

const SFTP_POOL_IDLE_TTL: Duration = Duration::from_secs(300);
const SFTP_POOL_HEALTH_CHECK_IDLE: Duration = Duration::from_secs(30);
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
}

impl Drop for ConnectLeaderGuard {
    fn drop(&mut self) {
        let slot = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.key);
        if let Some(slot) = slot {
            let mut state = slot
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if matches!(*state, ConnectState::Pending) {
                warn!(
                    "SFTP connect leader for {} dropped before finishing; failing slot",
                    self.key.label()
                );
                *state = ConnectState::Failed("connection attempt aborted".to_string());
                drop(state);
                slot.ready.notify_all();
            }
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
    Failed(String),
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

        let (connection, verified_idle) = match found {
            Some(found) => found,
            None => {
                debug!("SFTP pool miss {}", key.label());
                return None;
            }
        };

        // Throttle health checks: an entry verified inside the recent window
        // is trusted without a realpath round-trip on the get() hot path.
        if should_health_check(verified_idle) {
            if !connection_is_healthy(&connection) {
                warn!("SFTP pool health check failed {}", key.label());
                self.remove_if_same(&key, &connection);
                return None;
            }
            self.mark_verified(&key, &connection);
        }

        debug!("SFTP pool hit {}", key.label());
        Some(connection)
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
                entry.insert(Arc::new(ConnectSlot::new()));
                ConnectClaim::Leader(ConnectLeaderGuard {
                    in_flight: self.in_flight.clone(),
                    key: key.clone(),
                })
            }
        }
    }

    /// Leader-side completion: publish the outcome to waiting followers and
    /// release the in-flight slot. On success the connection is also inserted
    /// into the pool.
    pub(crate) fn finish_connect(
        &self,
        key: &ConnectionKey,
        result: Result<Arc<Mutex<ConnectedSftp>>, ConnectionError>,
    ) -> Result<Arc<Mutex<ConnectedSftp>>, ConnectionError> {
        let slot = self
            .in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(key);
        if let Some(slot) = slot {
            {
                let mut state = slot
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                *state = match &result {
                    Ok(connection) => ConnectState::Ready(connection.clone()),
                    Err(error) => ConnectState::Failed(error.message()),
                };
            }
            slot.ready.notify_all();
        }
        result.map(|connection| self.get_or_insert(key, connection))
    }

    /// Follower-side wait: block until the leader publishes the outcome. Times
    /// out after [`SFTP_CONNECT_WAIT_TIMEOUT`] as a backstop: the stuck slot is
    /// released so the next caller can become the leader and retry.
    pub(crate) fn wait_connect(
        &self,
        key: &ConnectionKey,
        slot: Arc<ConnectSlot>,
    ) -> Result<Arc<Mutex<ConnectedSftp>>, String> {
        let deadline = Instant::now() + SFTP_CONNECT_WAIT_TIMEOUT;
        let mut state = slot
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            match &*state {
                ConnectState::Pending => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    let (new_state, timeout) = slot
                        .ready
                        .wait_timeout(state, remaining)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    state = new_state;
                    if timeout.timed_out() && matches!(*state, ConnectState::Pending) {
                        break;
                    }
                }
                ConnectState::Ready(connection) => return Ok(connection.clone()),
                ConnectState::Failed(message) => return Err(message.clone()),
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
        Err("timed out waiting for the concurrent connection attempt".to_string())
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

/// A pooled connection is re-verified only once it has not been successfully
/// verified within this window; recently used entries skip the round-trip.
fn should_health_check(since_last_verified: Duration) -> bool {
    since_last_verified >= SFTP_POOL_HEALTH_CHECK_IDLE
}

fn connection_is_healthy(connection: &Arc<Mutex<ConnectedSftp>>) -> bool {
    let connected = connection
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Probe the root directory: realpath(".") fails on restricted servers
    // whose SFTP subsystem cannot resolve the user's home-relative cwd.
    connected.session.authenticated() && connected.sftp.realpath(Path::new("/")).is_ok()
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
    fn begin_connect_grants_leadership_to_only_one_caller() {
        let pool = SftpPool::default();
        let request = sample_request();
        let key = connection_key(&request);

        // The leader guard must stay bound: dropping it aborts the slot.
        let leader = pool.begin_connect(&key);
        assert!(matches!(leader, ConnectClaim::Leader(_)));
        assert!(matches!(
            pool.begin_connect(&key),
            ConnectClaim::Follower(_)
        ));

        // Once the leader finishes, the slot is released and the next caller
        // becomes the leader again.
        pool.finish_connect(
            &key,
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
        let waiter = std::thread::spawn(move || waiter_pool.wait_connect(&waiter_key, slot));
        drop(guard);

        let result = waiter.join().expect("follower thread should finish");
        assert_eq!(result.err().as_deref(), Some("connection attempt aborted"));

        // The slot is released, so the next caller becomes the leader again.
        assert!(matches!(pool.begin_connect(&key), ConnectClaim::Leader(_)));
    }

    #[test]
    fn wait_connect_follower_receives_leader_failure() {
        let pool = SftpPool::default();
        let key = connection_key(&sample_request());

        let leader = pool.begin_connect(&key);
        assert!(matches!(leader, ConnectClaim::Leader(_)));
        let slot = match pool.begin_connect(&key) {
            ConnectClaim::Follower(slot) => slot,
            ConnectClaim::Leader(_) => panic!("second claim must be a follower"),
        };

        let waiter_pool = pool.clone();
        let waiter_key = key.clone();
        let waiter = std::thread::spawn(move || waiter_pool.wait_connect(&waiter_key, slot));
        pool.finish_connect(
            &key,
            Err(crate::models::ConnectionError::Other {
                message: "handshake failed".to_string(),
            }),
        )
        .ok();

        let result = waiter.join().expect("follower thread should finish");
        assert_eq!(result.err().as_deref(), Some("handshake failed"));
        drop(leader);
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
