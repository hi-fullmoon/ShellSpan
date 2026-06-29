use crate::models::{AuthMethod, ConnectedSftp, JumpHostConfig, RemoteConnectionRequest};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Eq, PartialEq, Hash, Clone)]
pub(crate) struct ConnectionKey {
    host: String,
    port: u16,
    username: String,
    auth_method: AuthMethod,
    password_hash: String,
    private_key_path_hash: String,
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
    private_key_path_hash: String,
    passphrase_hash: String,
}

#[derive(Default, Clone)]
pub(crate) struct SftpPool {
    sessions: Arc<Mutex<HashMap<ConnectionKey, Arc<Mutex<ConnectedSftp>>>>>,
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

    pub(crate) fn get_or_insert(
        &self,
        key: &ConnectionKey,
        new_connection: Arc<Mutex<ConnectedSftp>>,
    ) -> Arc<Mutex<ConnectedSftp>> {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sessions.entry(key.clone()).or_insert(new_connection).clone()
    }

    pub(crate) fn invalidate(&self, request: &RemoteConnectionRequest) {
        let key = connection_key(request);
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&key);
    }
}

impl ConnectionKey {
    pub(crate) fn jump_host_key(jump_host: Option<&JumpHostConfig>) -> Option<JumpHostKey> {
        jump_host.map(|jump_host| JumpHostKey {
            host: jump_host.host.clone(),
            port: jump_host.port,
            username: jump_host.username.clone(),
            auth_method: jump_host.auth_method,
            password_hash: hash_secret(jump_host.password.as_deref()),
            private_key_path_hash: hash_secret(jump_host.private_key_path.as_deref()),
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
        private_key_path_hash: hash_secret(request.private_key_path.as_deref()),
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
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AuthMethod, RemoteConnectionRequest};

    #[test]
    fn invalidate_does_not_panic_on_empty_pool() {
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

    #[test]
    fn connection_key_does_not_contain_raw_secrets() {
        let host_pass = "super-secret-password";
        let host_phrase = "super-secret-passphrase";
        let host_key_path = "/home/alice/.ssh/id_rsa";
        let request = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some(host_pass.to_string()),
            private_key_path: Some(host_key_path.to_string()),
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
            !key.private_key_path_hash.contains(host_key_path),
            "key must not contain raw private key path"
        );
    }

    #[test]
    fn connection_key_does_not_contain_jump_host_raw_secrets() {
        let jump_pass = "jump-secret-password";
        let jump_phrase = "jump-secret-passphrase";
        let jump_key_path = "/home/alice/.ssh/jump_id_rsa";
        let request = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("host-password".to_string()),
            private_key_path: None,
            passphrase: None,
            jump_host: Some(JumpHostConfig {
                host: "jump.example.com".to_string(),
                port: 22,
                username: "jump".to_string(),
                auth_method: AuthMethod::Key,
                password: Some(jump_pass.to_string()),
                private_key_path: Some(jump_key_path.to_string()),
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
            !jump_host_key.private_key_path_hash.contains(jump_key_path),
            "key must not contain raw jump-host private key path"
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
            private_key_path: Some("/path/to/key".to_string()),
            passphrase: Some("phrase".to_string()),
            jump_host: Some(JumpHostConfig {
                host: "jump.example.com".to_string(),
                port: 22,
                username: "jump".to_string(),
                auth_method: AuthMethod::Key,
                password: Some("jump-secret".to_string()),
                private_key_path: Some("/path/to/jump/key".to_string()),
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
            private_key_path: None,
            passphrase: None,
            jump_host: None,
        };
        let second = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 2222,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            private_key_path: None,
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
            private_key_path: None,
            passphrase: None,
            jump_host: None,
        };
        let fourth = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("bob:secret".to_string()),
            private_key_path: None,
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
            private_key_path: None,
            passphrase: None,
            jump_host: Some(JumpHostConfig {
                host: "a".to_string(),
                port: 1,
                username: "1:b".to_string(),
                auth_method: AuthMethod::Password,
                password: None,
                private_key_path: None,
                passphrase: None,
            }),
        };
        let second = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            private_key_path: None,
            passphrase: None,
            jump_host: Some(JumpHostConfig {
                host: "a:1".to_string(),
                port: 1,
                username: "b".to_string(),
                auth_method: AuthMethod::Password,
                password: None,
                private_key_path: None,
                passphrase: None,
            }),
        };

        assert_ne!(connection_key(&first), connection_key(&second));
    }
}
