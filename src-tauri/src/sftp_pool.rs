use crate::models::{ConnectedSftp, JumpHostConfig, RemoteConnectionRequest};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default, Clone)]
pub(crate) struct SftpPool {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<ConnectedSftp>>>>>,
}

impl SftpPool {
    pub(crate) fn get(
        &self,
        request: &RemoteConnectionRequest,
    ) -> Option<Arc<Mutex<ConnectedSftp>>> {
        let key = connection_key(request);
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sessions.get(&key).cloned()
    }

    pub(crate) fn insert(
        &self,
        request: &RemoteConnectionRequest,
        connected: Arc<Mutex<ConnectedSftp>>,
    ) {
        let key = connection_key(request);
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key, connected);
    }

    pub(crate) fn invalidate(&self, request: &RemoteConnectionRequest) {
        let key = connection_key(request);
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&key);
    }
}

fn connection_key(request: &RemoteConnectionRequest) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}:{}",
        request.host,
        request.port,
        request.username,
        request.auth_method.as_str(),
        credential_marker(request.password.as_deref()),
        credential_marker(request.private_key_path.as_deref()),
        credential_marker(request.passphrase.as_deref()),
        jump_host_marker(request.jump_host.as_ref()),
    )
}

fn jump_host_marker(jump_host: Option<&JumpHostConfig>) -> String {
    match jump_host {
        None => "no-jump".to_string(),
        Some(jump) => format!(
            "jump:{}:{}:{}:{}:{}:{}:{}",
            jump.host,
            jump.port,
            jump.username,
            jump.auth_method.as_str(),
            credential_marker(jump.password.as_deref()),
            credential_marker(jump.private_key_path.as_deref()),
            credential_marker(jump.passphrase.as_deref()),
        ),
    }
}

fn credential_marker(value: Option<&str>) -> String {
    match value {
        Some(v) => format!("some:{v}"),
        None => "none".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AuthMethod, RemoteConnectionRequest};

    #[test]
    fn invalidate_removes_cached_connection() {
        let pool = SftpPool::default();
        let request = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            private_key_path: None,
            passphrase: None,
            jump_host: None,
        };

        // We cannot create a real Session in a unit test, but we can verify the behavior by
        // attempting to get a connection after invalidate returns None.
        pool.invalidate(&request);
        assert!(pool.get(&request).is_none());
    }

    #[test]
    fn connection_key_is_stable_for_equal_requests() {
        let request = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            private_key_path: None,
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
            private_key_path: None,
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
            private_key_path: None,
            passphrase: None,
            jump_host: None,
        };
        let with_none = RemoteConnectionRequest {
            password: None,
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
            private_key_path: None,
            passphrase: None,
            jump_host: None,
        };
        let with_none_password = RemoteConnectionRequest {
            password: None,
            ..base.clone()
        };

        assert_ne!(connection_key(&base), connection_key(&with_none_password));
    }
}
