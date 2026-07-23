use keyring::Entry;
use log::{debug, info, warn};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const PASSWORD_SERVICE: &str = "com.termbridge.password";
const KEY_SERVICE: &str = "com.termbridge.key";

fn password_entry_key(profile_id: &str) -> String {
    format!("com.termbridge.password.{profile_id}")
}

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

struct SystemKeychainBackend;

impl CredentialBackend for SystemKeychainBackend {
    fn set_credential(
        &self,
        service: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        let entry = Entry::new(service, key)
            .map_err(|e| format!("failed to create keyring entry: {e}"))?;
        entry
            .set_password(value)
            .map_err(|e| format!("failed to store credential in keychain: {e}"))
    }

    fn get_credential(&self, service: &str, key: &str) -> Result<Option<String>, String> {
        let entry = Entry::new(service, key)
            .map_err(|e| format!("failed to create keyring entry: {e}"))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("failed to retrieve credential from keychain: {e}")),
        }
    }

    fn delete_credential(&self, service: &str, key: &str) -> Result<(), String> {
        let entry = Entry::new(service, key)
            .map_err(|e| format!("failed to create keyring entry: {e}"))?;
        match entry.delete_password() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("failed to delete credential from keychain: {e}")),
        }
    }
}

pub(crate) struct CredentialManager {
    backend: Arc<dyn CredentialBackend>,
    cache: Mutex<HashMap<String, String>>,
}

impl Default for CredentialManager {
    fn default() -> Self {
        Self {
            backend: Arc::new(SystemKeychainBackend),
            cache: Mutex::new(HashMap::new()),
        }
    }
}

impl CredentialManager {
    #[cfg(test)]
    fn with_backend(backend: Arc<dyn CredentialBackend>) -> Self {
        Self {
            backend,
            cache: Mutex::new(HashMap::new()),
        }
    }

    // --- Password credentials (legacy, per-profile) ---

    pub(crate) fn set_password(&self, profile_id: &str, password: &str) -> Result<(), String> {
        self.set_credential(PASSWORD_SERVICE, &password_entry_key(profile_id), password)
    }

    pub(crate) fn get_password(&self, profile_id: &str) -> Result<Option<String>, String> {
        self.get_credential(PASSWORD_SERVICE, &password_entry_key(profile_id))
    }

    pub(crate) fn delete_password(&self, profile_id: &str) -> Result<(), String> {
        self.delete_credential(PASSWORD_SERVICE, &password_entry_key(profile_id))
    }

    pub(crate) fn cached_profile_ids(&self) -> Result<Vec<String>, String> {
        let prefix = format!("{PASSWORD_SERVICE}:");
        let password_key_prefix = format!("{PASSWORD_SERVICE}.",);
        let mut profile_ids = self
            .cache
            .lock()
            .map_err(|_| "credential cache lock poisoned".to_string())?
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .filter_map(|key| {
                key.strip_prefix(&prefix)
                    .and_then(|entry_key| entry_key.strip_prefix(&password_key_prefix))
                    .map(String::from)
            })
            .collect::<Vec<_>>();
        profile_ids.sort();
        Ok(profile_ids)
    }

    pub(crate) fn clear_cache(&self) -> Result<(), String> {
        self.cache
            .lock()
            .map_err(|_| "credential cache lock poisoned".to_string())?
            .clear();
        debug!("Cleared in-memory credential cache");
        Ok(())
    }

    pub(crate) fn migrate_passwords(&self, profiles: &[(String, String)]) -> Vec<(String, bool)> {
        let mut results = Vec::new();
        for (profile_id, password) in profiles {
            if password.is_empty() {
                continue;
            }
            match self.set_password(profile_id, password) {
                Ok(()) => {
                    info!("Migrated password for profile {profile_id}");
                    results.push((profile_id.clone(), true));
                }
                Err(e) => {
                    warn!("Failed to migrate password for {profile_id}: {e}");
                    results.push((profile_id.clone(), false));
                }
            }
        }
        let success_count = results.iter().filter(|(_, ok)| *ok).count();
        info!(
            "Migrated {success_count}/{} passwords to keychain",
            results.len()
        );
        results
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
        debug!("Stored credential in keychain service={service} key={key}");
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
            debug!("Loaded credential from keychain service={service} key={key}");
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
        debug!("Deleted credential from keychain service={service} key={key}");
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
    fn repeated_reads_use_the_in_memory_cache() {
        let backend = Arc::new(MockBackend::default());
        backend
            .set_credential(PASSWORD_SERVICE, &password_entry_key("profile-1"), "secret")
            .unwrap();
        let manager = CredentialManager::with_backend(backend.clone());

        assert_eq!(
            manager.get_password("profile-1").unwrap().as_deref(),
            Some("secret")
        );
        assert_eq!(
            manager.get_password("profile-1").unwrap().as_deref(),
            Some("secret")
        );
        assert_eq!(backend.get_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn stored_password_is_immediately_available_from_cache() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_backend(backend.clone());

        manager.set_password("profile-1", "secret").unwrap();

        assert_eq!(
            manager.get_password("profile-1").unwrap().as_deref(),
            Some("secret")
        );
        assert_eq!(backend.set_calls.load(Ordering::SeqCst), 1);
        assert_eq!(backend.get_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn deleting_password_invalidates_the_cache() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_backend(backend.clone());
        manager.set_password("profile-1", "secret").unwrap();

        manager.delete_password("profile-1").unwrap();

        assert_eq!(manager.get_password("profile-1").unwrap(), None);
        assert_eq!(backend.delete_calls.load(Ordering::SeqCst), 1);
        assert_eq!(backend.get_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cache_metadata_can_be_listed_and_cleared_without_backend_reads() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_backend(backend.clone());
        manager.set_password("profile-2", "second").unwrap();
        manager.set_password("profile-1", "first").unwrap();

        assert_eq!(
            manager.cached_profile_ids().unwrap(),
            vec!["profile-1".to_string(), "profile-2".to_string()]
        );

        manager.clear_cache().unwrap();

        assert!(manager.cached_profile_ids().unwrap().is_empty());
        assert_eq!(backend.get_calls.load(Ordering::SeqCst), 0);
    }
}
