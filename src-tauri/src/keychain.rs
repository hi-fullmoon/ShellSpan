use log::{debug, warn};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub(crate) const KEY_SERVICE: &str = "com.termbridge.key";
pub(crate) const PROFILE_PASSWORD_SERVICE: &str = "com.termbridge.profile-password";

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
    native: NativeKeychainBackend,
    fallback: DatabaseBackend,
}

impl CredentialBackend for CompositeBackend {
    fn set_credential(
        &self,
        service: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        match self.native.set_credential(service, key, value) {
            Ok(()) => Ok(()),
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
            _ => {
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
            native: NativeKeychainBackend,
            fallback: DatabaseBackend::new(database),
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
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "credential cache lock poisoned".to_string())?;
        if let Some(value) = cache.get(&cache_key).cloned() {
            return Ok(Some(value));
        }

        let value = self.backend.get_credential(service, key)?;
        if let Some(ref value) = value {
            cache.insert(cache_key, value.clone());
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct MockBackend {
        credentials: Mutex<HashMap<String, HashMap<String, String>>>,
        get_calls: AtomicUsize,
        set_calls: AtomicUsize,
        delete_calls: AtomicUsize,
    }

    impl CredentialBackend for MockBackend {
        fn set_credential(
            &self,
            service: &str,
            key: &str,
            value: &str,
        ) -> Result<(), String> {
            self.set_calls.fetch_add(1, Ordering::SeqCst);
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
}
