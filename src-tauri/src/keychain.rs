use log::{debug, warn};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub(crate) const KEY_SERVICE: &str = "com.termbridge.key";
pub(crate) const PROFILE_PASSWORD_SERVICE: &str = "com.termbridge.profile-password";
pub(crate) const PROFILE_SECRET_SERVICE: &str = "com.termbridge.profile-secret";

/// Kinds of per-profile secrets other than the main login password.
///
/// The main password keeps using [`PROFILE_PASSWORD_SERVICE`] keyed by the
/// bare profile id; these secrets live in [`PROFILE_SECRET_SERVICE`] keyed by
/// `{profile_id}:{suffix}` so one profile can hold several secrets without
/// collisions.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProfileSecretKind {
    /// Passphrase of the profile's own private key.
    Passphrase,
    /// Password of the jump host (password auth).
    JumpPassword,
    /// Passphrase of the jump host's private key.
    JumpPassphrase,
}

impl ProfileSecretKind {
    fn suffix(self) -> &'static str {
        match self {
            ProfileSecretKind::Passphrase => "passphrase",
            ProfileSecretKind::JumpPassword => "jump-password",
            ProfileSecretKind::JumpPassphrase => "jump-passphrase",
        }
    }

    fn key_for(self, profile_id: &str) -> String {
        format!("{profile_id}:{}", self.suffix())
    }
}

/// Abstraction over credential storage backends.
trait CredentialBackend: Send + Sync {
    fn set_credential(
        &self,
        service: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String>;
    fn get_credential(&self, service: &str, key: &str) -> Result<Option<String>, String>;
    fn delete_credential(&self, service: &str, key: &str) -> Result<(), String>;
}

// ---------------------------------------------------------------------------
// Native OS-level keychain backend (macOS Keychain / Windows Credential
// Manager / Linux Secret Service) via the `keyring` crate.
// ---------------------------------------------------------------------------

struct NativeKeychainBackend;

impl CredentialBackend for NativeKeychainBackend {
    fn set_credential(
        &self,
        service: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        let entry =
            keyring::Entry::new(service, key).map_err(|e| format!("keyring new: {e}"))?;
        entry
            .set_password(value)
            .map_err(|e| format!("keyring set_password: {e}"))?;
        debug!("Stored credential in OS keychain service={service} key={key}");
        Ok(())
    }

    fn get_credential(&self, service: &str, key: &str) -> Result<Option<String>, String> {
        let entry =
            keyring::Entry::new(service, key).map_err(|e| format!("keyring new: {e}"))?;
        match entry.get_password() {
            Ok(password) => {
                debug!("Loaded credential from OS keychain service={service} key={key}");
                Ok(Some(password))
            }
            Err(keyring::Error::NoEntry) => {
                debug!("No credential in OS keychain for service={service} key={key}");
                Ok(None)
            }
            Err(e) => Err(format!("keyring get_password: {e}")),
        }
    }

    fn delete_credential(&self, service: &str, key: &str) -> Result<(), String> {
        let entry =
            keyring::Entry::new(service, key).map_err(|e| format!("keyring new: {e}"))?;
        match entry.delete_credential() {
            Ok(()) => {
                debug!("Deleted credential from OS keychain service={service} key={key}");
                Ok(())
            }
            Err(keyring::Error::NoEntry) => {
                debug!("No credential to delete in OS keychain for service={service} key={key}");
                Ok(())
            }
            Err(e) => Err(format!("keyring delete_credential: {e}")),
        }
    }
}

// ---------------------------------------------------------------------------
// Database fallback backend (SQLite) — used when the native OS keychain is
// unavailable.
// ---------------------------------------------------------------------------

struct DatabaseBackend {
    database: crate::db::Database,
}

impl DatabaseBackend {
    fn new(database: crate::db::Database) -> Self {
        Self { database }
    }
}

impl CredentialBackend for DatabaseBackend {
    fn set_credential(
        &self,
        service: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        self.database.store_key_credential_value(key, value, service)
    }

    fn get_credential(&self, _service: &str, key: &str) -> Result<Option<String>, String> {
        self.database.retrieve_key_credential_value(key)
    }

    fn delete_credential(&self, _service: &str, key: &str) -> Result<(), String> {
        self.database.delete_key_credential(key)
    }
}

// ---------------------------------------------------------------------------
// Composite backend: tries native OS keychain first, falls back to database.
// ---------------------------------------------------------------------------

struct CompositeBackend {
    native: Arc<dyn CredentialBackend>,
    fallback: Arc<dyn CredentialBackend>,
}

impl CredentialBackend for CompositeBackend {
    fn set_credential(
        &self,
        service: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        match self.native.set_credential(service, key, value) {
            Ok(()) => {
                // Keep both stores in sync: remove any stale copy from the
                // database fallback so a later native outage can't serve an
                // outdated value. Best-effort — failure only logs.
                if let Err(e) = self.fallback.delete_credential(service, key) {
                    warn!(
                        "Failed to remove stale fallback credential service={service} key={key}: {e}"
                    );
                }
                Ok(())
            }
            Err(native_err) => {
                warn!(
                    "Native keychain set failed for service={service} key={key}, falling back to database: {native_err}"
                );
                self.fallback.set_credential(service, key, value)
            }
        }
    }

    fn get_credential(&self, service: &str, key: &str) -> Result<Option<String>, String> {
        match self.native.get_credential(service, key) {
            Ok(Some(value)) => Ok(Some(value)),
            Ok(None) => {
                // Not found in native keychain — try the database fallback
                // in case it was stored there previously (e.g. migration).
                debug!(
                    "Credential not found in native keychain service={service} key={key}, trying database fallback"
                );
                self.fallback.get_credential(service, key)
            }
            Err(native_err) => {
                warn!(
                    "Native keychain get failed for service={service} key={key}, falling back to database: {native_err}"
                );
                self.fallback.get_credential(service, key)
            }
        }
    }

    fn delete_credential(&self, service: &str, key: &str) -> Result<(), String> {
        // Delete from both backends — best-effort.
        let native_result = self.native.delete_credential(service, key);
        let fallback_result = self.fallback.delete_credential(service, key);

        // Return the first error if both failed; succeed if either succeeded.
        match (&native_result, &fallback_result) {
            (Err(_), Err(fallback_err)) => Err(fallback_err.clone()),
            (Err(native_err), Ok(())) => {
                warn!(
                    "Native keychain delete failed for service={service} key={key}, fallback delete succeeded; OS keychain may retain an orphan credential: {native_err}"
                );
                Ok(())
            }
            (Ok(()), Err(fallback_err)) => {
                warn!(
                    "Fallback delete failed for service={service} key={key}, native keychain delete succeeded; database may retain an orphan credential: {fallback_err}"
                );
                Ok(())
            }
            (Ok(()), Ok(())) => {
                debug!("Deleted credential service={service} key={key} (native+fallback)");
                Ok(())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Public credential manager
// ---------------------------------------------------------------------------

pub(crate) struct CredentialManager {
    backend: Arc<dyn CredentialBackend>,
    cache: Mutex<HashMap<String, String>>,
}

impl CredentialManager {
    /// Creates a credential manager that stores secrets in the OS-level
    /// keychain (macOS Keychain, Windows Credential Manager, or Linux Secret
    /// Service), falling back to the local SQLite database when the native
    /// keychain is unavailable.
    pub(crate) fn new(database: crate::db::Database) -> Self {
        let backend = CompositeBackend {
            native: Arc::new(NativeKeychainBackend),
            fallback: Arc::new(DatabaseBackend::new(database)),
        };
        Self {
            backend: Arc::new(backend),
            cache: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    fn with_backend(backend: Arc<dyn CredentialBackend>) -> Self {
        Self {
            backend,
            cache: Mutex::new(HashMap::new()),
        }
    }

    // --- Generic credentials ---

    pub(crate) fn set_credential(
        &self,
        service: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        self.backend.set_credential(service, key, value)?;
        self.cache
            .lock()
            .map_err(|_| "credential cache lock poisoned".to_string())?
            .insert(format!("{service}:{key}"), value.to_string());
        Ok(())
    }

    pub(crate) fn get_credential(
        &self,
        service: &str,
        key: &str,
    ) -> Result<Option<String>, String> {
        let cache_key = format!("{service}:{key}");
        {
            let cache = self
                .cache
                .lock()
                .map_err(|_| "credential cache lock poisoned".to_string())?;
            if let Some(value) = cache.get(&cache_key).cloned() {
                return Ok(Some(value));
            }
        }

        // Cache miss: do the (potentially blocking) backend I/O without
        // holding the cache lock so other credentials stay accessible.
        let value = self.backend.get_credential(service, key)?;
        if let Some(ref value) = value {
            self.cache
                .lock()
                .map_err(|_| "credential cache lock poisoned".to_string())?
                .insert(cache_key, value.clone());
        }
        Ok(value)
    }

    pub(crate) fn delete_credential(
        &self,
        service: &str,
        key: &str,
    ) -> Result<(), String> {
        self.backend.delete_credential(service, key)?;
        self.cache
            .lock()
            .map_err(|_| "credential cache lock poisoned".to_string())?
            .remove(&format!("{service}:{key}"));
        Ok(())
    }

    // --- Key credentials ---

    pub(crate) fn store_key_credential(
        &self,
        key_id: &str,
        value: &str,
    ) -> Result<(), String> {
        self.set_credential(KEY_SERVICE, key_id, value)
    }

    pub(crate) fn retrieve_key_credential(
        &self,
        key_id: &str,
    ) -> Result<Option<String>, String> {
        self.get_credential(KEY_SERVICE, key_id)
    }

    pub(crate) fn delete_key_credential(&self, key_id: &str) -> Result<(), String> {
        self.delete_credential(KEY_SERVICE, key_id)
    }

    // --- Profile passwords ---

    pub(crate) fn store_profile_password(
        &self,
        profile_id: &str,
        password: &str,
    ) -> Result<(), String> {
        self.set_credential(PROFILE_PASSWORD_SERVICE, profile_id, password)
    }

    pub(crate) fn retrieve_profile_password(
        &self,
        profile_id: &str,
    ) -> Result<Option<String>, String> {
        self.get_credential(PROFILE_PASSWORD_SERVICE, profile_id)
    }

    pub(crate) fn delete_profile_password(&self, profile_id: &str) -> Result<(), String> {
        self.delete_credential(PROFILE_PASSWORD_SERVICE, profile_id)
    }

    // --- Profile secrets (key passphrases, jump-host credentials) ---

    pub(crate) fn store_profile_secret(
        &self,
        profile_id: &str,
        kind: ProfileSecretKind,
        value: &str,
    ) -> Result<(), String> {
        self.set_credential(PROFILE_SECRET_SERVICE, &kind.key_for(profile_id), value)
    }

    pub(crate) fn retrieve_profile_secret(
        &self,
        profile_id: &str,
        kind: ProfileSecretKind,
    ) -> Result<Option<String>, String> {
        self.get_credential(PROFILE_SECRET_SERVICE, &kind.key_for(profile_id))
    }

    /// Deletes every secret belonging to a profile: the main password plus
    /// all [`ProfileSecretKind`] entries. Best-effort per entry — a failure
    /// on one kind does not prevent deleting the others; the first error is
    /// returned after all deletes were attempted.
    pub(crate) fn delete_all_profile_secrets(&self, profile_id: &str) -> Result<(), String> {
        let mut first_error = self
            .delete_profile_password(profile_id)
            .err();
        for kind in [
            ProfileSecretKind::Passphrase,
            ProfileSecretKind::JumpPassword,
            ProfileSecretKind::JumpPassphrase,
        ] {
            if let Err(e) = self.delete_profile_secret(profile_id, kind) {
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
        }
        match first_error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    pub(crate) fn delete_profile_secret(
        &self,
        profile_id: &str,
        kind: ProfileSecretKind,
    ) -> Result<(), String> {
        self.delete_credential(PROFILE_SECRET_SERVICE, &kind.key_for(profile_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Default)]
    struct MockBackend {
        credentials: Mutex<HashMap<String, HashMap<String, String>>>,
        get_calls: AtomicUsize,
        set_calls: AtomicUsize,
        delete_calls: AtomicUsize,
        fail_set: AtomicBool,
        fail_delete: AtomicBool,
    }

    impl CredentialBackend for MockBackend {
        fn set_credential(
            &self,
            service: &str,
            key: &str,
            value: &str,
        ) -> Result<(), String> {
            self.set_calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_set.load(Ordering::SeqCst) {
                return Err("mock set failure".to_string());
            }
            let mut creds = self.credentials.lock().unwrap();
            creds
                .entry(service.to_string())
                .or_default()
                .insert(key.to_string(), value.to_string());
            Ok(())
        }

        fn get_credential(&self, service: &str, key: &str) -> Result<Option<String>, String> {
            self.get_calls.fetch_add(1, Ordering::SeqCst);
            Ok(self
                .credentials
                .lock()
                .unwrap()
                .get(service)
                .and_then(|m| m.get(key))
                .cloned())
        }

        fn delete_credential(&self, service: &str, key: &str) -> Result<(), String> {
            self.delete_calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_delete.load(Ordering::SeqCst) {
                return Err("mock delete failure".to_string());
            }
            self.credentials
                .lock()
                .unwrap()
                .get_mut(service)
                .map(|m| m.remove(key));
            Ok(())
        }
    }

    #[test]
    fn key_credentials_use_backend() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_backend(backend.clone());

        manager
            .store_key_credential("key-1", "private-key-data")
            .unwrap();
        let loaded = manager.retrieve_key_credential("key-1").unwrap();

        assert_eq!(loaded.as_deref(), Some("private-key-data"));
        assert_eq!(backend.set_calls.load(Ordering::SeqCst), 1);
        // Cache hit — no backend call.
        assert_eq!(backend.get_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn profile_password_roundtrip() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_backend(backend);

        manager
            .store_profile_password("profile-1", "secret123")
            .unwrap();
        let loaded = manager.retrieve_profile_password("profile-1").unwrap();
        assert_eq!(loaded.as_deref(), Some("secret123"));

        manager.delete_profile_password("profile-1").unwrap();
        // After delete, both cache and backend are cleared.
        let after_delete = manager.retrieve_profile_password("profile-1").unwrap();
        assert_eq!(after_delete, None);
    }

    #[test]
    fn profile_secret_roundtrip() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_backend(backend);

        manager
            .store_profile_secret("profile-1", ProfileSecretKind::Passphrase, "pp")
            .unwrap();
        manager
            .store_profile_secret("profile-1", ProfileSecretKind::JumpPassword, "jp")
            .unwrap();
        manager
            .store_profile_secret("profile-1", ProfileSecretKind::JumpPassphrase, "jpp")
            .unwrap();

        assert_eq!(
            manager
                .retrieve_profile_secret("profile-1", ProfileSecretKind::Passphrase)
                .unwrap()
                .as_deref(),
            Some("pp")
        );
        assert_eq!(
            manager
                .retrieve_profile_secret("profile-1", ProfileSecretKind::JumpPassword)
                .unwrap()
                .as_deref(),
            Some("jp")
        );
        assert_eq!(
            manager
                .retrieve_profile_secret("profile-1", ProfileSecretKind::JumpPassphrase)
                .unwrap()
                .as_deref(),
            Some("jpp")
        );
        // Different profiles do not collide.
        assert_eq!(
            manager
                .retrieve_profile_secret("profile-2", ProfileSecretKind::Passphrase)
                .unwrap(),
            None
        );
    }

    #[test]
    fn delete_all_profile_secrets_clears_password_and_secrets() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_backend(backend);

        manager
            .store_profile_password("profile-1", "secret123")
            .unwrap();
        manager
            .store_profile_secret("profile-1", ProfileSecretKind::Passphrase, "pp")
            .unwrap();
        manager
            .store_profile_secret("profile-1", ProfileSecretKind::JumpPassword, "jp")
            .unwrap();
        manager
            .store_profile_secret("profile-1", ProfileSecretKind::JumpPassphrase, "jpp")
            .unwrap();

        manager.delete_all_profile_secrets("profile-1").unwrap();

        assert_eq!(
            manager.retrieve_profile_password("profile-1").unwrap(),
            None
        );
        for kind in [
            ProfileSecretKind::Passphrase,
            ProfileSecretKind::JumpPassword,
            ProfileSecretKind::JumpPassphrase,
        ] {
            assert_eq!(
                manager.retrieve_profile_secret("profile-1", kind).unwrap(),
                None
            );
        }
    }

    #[test]
    fn set_then_get_uses_cache() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_backend(backend.clone());

        manager.set_credential("svc", "k", "v").unwrap();
        // Should hit cache, not backend.
        let val = manager.get_credential("svc", "k").unwrap();
        assert_eq!(val.as_deref(), Some("v"));
        assert_eq!(backend.get_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn delete_removes_from_cache() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_backend(backend.clone());

        manager.set_credential("svc", "k", "v").unwrap();
        manager.delete_credential("svc", "k").unwrap();

        // After delete, cache is cleared. Next get hits backend (which is empty).
        let val = manager.get_credential("svc", "k").unwrap();
        assert_eq!(val, None);
    }

    #[test]
    fn composite_set_removes_stale_fallback_copy() {
        let native = Arc::new(MockBackend::default());
        let fallback = Arc::new(MockBackend::default());
        let composite = CompositeBackend {
            native: native.clone(),
            fallback: fallback.clone(),
        };

        // Stale value left in the fallback from an earlier native outage.
        fallback.set_credential("svc", "k", "old").unwrap();

        composite.set_credential("svc", "k", "new").unwrap();

        // Native holds the new value and the stale fallback copy is gone,
        // so a later native outage cannot serve "old".
        assert_eq!(
            native.get_credential("svc", "k").unwrap().as_deref(),
            Some("new")
        );
        assert_eq!(fallback.get_credential("svc", "k").unwrap(), None);
    }

    #[test]
    fn composite_set_fallback_delete_failure_is_best_effort() {
        let native = Arc::new(MockBackend::default());
        let fallback = Arc::new(MockBackend::default());
        fallback.fail_delete.store(true, Ordering::SeqCst);
        let composite = CompositeBackend {
            native: native.clone(),
            fallback: fallback.clone(),
        };

        // The set still succeeds even though the fallback cleanup fails.
        composite.set_credential("svc", "k", "new").unwrap();
        assert_eq!(
            native.get_credential("svc", "k").unwrap().as_deref(),
            Some("new")
        );
    }

    #[test]
    fn composite_set_falls_back_to_database_when_native_fails() {
        let native = Arc::new(MockBackend::default());
        native.fail_set.store(true, Ordering::SeqCst);
        let fallback = Arc::new(MockBackend::default());
        let composite = CompositeBackend {
            native: native.clone(),
            fallback: fallback.clone(),
        };

        composite.set_credential("svc", "k", "v").unwrap();

        assert_eq!(
            fallback.get_credential("svc", "k").unwrap().as_deref(),
            Some("v")
        );
        assert_eq!(native.get_credential("svc", "k").unwrap(), None);
    }

    #[test]
    fn composite_delete_single_side_failure_still_succeeds() {
        let native = Arc::new(MockBackend::default());
        native.fail_delete.store(true, Ordering::SeqCst);
        let fallback = Arc::new(MockBackend::default());
        fallback.set_credential("svc", "k", "v").unwrap();
        let composite = CompositeBackend {
            native: native.clone(),
            fallback: fallback.clone(),
        };

        // Native delete fails but fallback succeeds — overall still Ok
        // (and a warn is logged about the possible orphan).
        composite.delete_credential("svc", "k").unwrap();
        assert_eq!(fallback.get_credential("svc", "k").unwrap(), None);
    }

    #[test]
    fn composite_delete_fails_only_when_both_sides_fail() {
        let native = Arc::new(MockBackend::default());
        native.fail_delete.store(true, Ordering::SeqCst);
        let fallback = Arc::new(MockBackend::default());
        fallback.fail_delete.store(true, Ordering::SeqCst);
        let composite = CompositeBackend {
            native: native.clone(),
            fallback: fallback.clone(),
        };

        assert!(composite.delete_credential("svc", "k").is_err());
    }

    #[test]
    fn get_credential_does_not_hold_cache_lock_during_backend_io() {
        use std::sync::mpsc::channel;
        use std::time::Duration;

        struct BlockingBackend {
            entered: std::sync::mpsc::Sender<()>,
            release: Mutex<std::sync::mpsc::Receiver<()>>,
        }

        impl CredentialBackend for BlockingBackend {
            fn set_credential(
                &self,
                _service: &str,
                _key: &str,
                _value: &str,
            ) -> Result<(), String> {
                Ok(())
            }

            fn get_credential(&self, _service: &str, _key: &str) -> Result<Option<String>, String> {
                self.entered.send(()).map_err(|e| e.to_string())?;
                self.release
                    .lock()
                    .map_err(|_| "release lock poisoned".to_string())?
                    .recv()
                    .map_err(|e| e.to_string())?;
                Ok(Some("slow".to_string()))
            }

            fn delete_credential(&self, _service: &str, _key: &str) -> Result<(), String> {
                Ok(())
            }
        }

        let (entered_tx, entered_rx) = channel();
        let (release_tx, release_rx) = channel();
        let backend = Arc::new(BlockingBackend {
            entered: entered_tx,
            release: Mutex::new(release_rx),
        });
        let manager = Arc::new(CredentialManager::with_backend(backend));

        let worker = {
            let manager = manager.clone();
            std::thread::spawn(move || manager.get_credential("svc", "k"))
        };
        // Wait until the worker is inside the blocking backend I/O.
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("backend I/O never started");
        // The cache lock must be free while the backend I/O is in flight.
        assert!(
            manager.cache.try_lock().is_ok(),
            "cache lock must not be held during backend I/O"
        );
        release_tx.send(()).unwrap();
        assert_eq!(worker.join().unwrap().unwrap().as_deref(), Some("slow"));
    }
}
