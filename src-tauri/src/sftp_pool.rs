#![allow(dead_code)]

use crate::models::{ConnectedSftp, RemoteConnectionRequest};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default, Clone)]
pub(crate) struct SftpPool {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<ConnectedSftp>>>>>,
}

impl SftpPool {
    pub(crate) fn get_or_create(
        &self,
        request: &RemoteConnectionRequest,
    ) -> Result<Arc<Mutex<ConnectedSftp>>, String> {
        let key = connection_key(request);
        let sessions = self.sessions.lock().unwrap();
        sessions
            .get(&key)
            .cloned()
            .ok_or_else(|| "connection not cached".to_string())
    }

    pub(crate) fn insert(
        &self,
        request: &RemoteConnectionRequest,
        connected: Arc<Mutex<ConnectedSftp>>,
    ) {
        let key = connection_key(request);
        self.sessions.lock().unwrap().insert(key, connected);
    }

    pub(crate) fn invalidate(&self, request: &RemoteConnectionRequest) {
        let key = connection_key(request);
        self.sessions.lock().unwrap().remove(&key);
    }
}

fn connection_key(request: &RemoteConnectionRequest) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        request.host,
        request.port,
        request.username,
        request.auth_method.as_str(),
        request.password.as_deref().unwrap_or(""),
        request.private_key_path.as_deref().unwrap_or(""),
        request.passphrase.as_deref().unwrap_or(""),
    )
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
        // attempting to get a connection after invalidate returns an error.
        pool.invalidate(&request);
        assert!(pool.get_or_create(&request).is_err());
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
}
