use keyring::Entry;
use log::{debug, info, warn};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const SERVICE_NAME: &str = "com.termbridge";

fn entry_key(profile_id: &str) -> String {
    format!("com.termbridge.password.{profile_id}")
}

trait CredentialBackend: Send + Sync {
    fn set_password(&self, profile_id: &str, password: &str) -> Result<(), String>;
    fn get_password(&self, profile_id: &str) -> Result<Option<String>, String>;
    fn delete_password(&self, profile_id: &str) -> Result<(), String>;
}

struct SystemKeychainBackend;

impl CredentialBackend for SystemKeychainBackend {
    fn set_password(&self, profile_id: &str, password: &str) -> Result<(), String> {
        let entry = Entry::new(SERVICE_NAME, &entry_key(profile_id))
            .map_err(|e| format!("failed to create keyring entry: {e}"))?;
        entry
            .set_password(password)
            .map_err(|e| format!("failed to store password in keychain: {e}"))
    }

    fn get_password(&self, profile_id: &str) -> Result<Option<String>, String> {
        let entry = Entry::new(SERVICE_NAME, &entry_key(profile_id))
            .map_err(|e| format!("failed to create keyring entry: {e}"))?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("failed to retrieve password from keychain: {e}")),
        }
    }

    fn delete_password(&self, profile_id: &str) -> Result<(), String> {
        let entry = Entry::new(SERVICE_NAME, &entry_key(profile_id))
            .map_err(|e| format!("failed to create keyring entry: {e}"))?;
        match entry.delete_password() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("failed to delete password from keychain: {e}")),
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

    pub(crate) fn set_password(&self, profile_id: &str, password: &str) -> Result<(), String> {
        self.backend.set_password(profile_id, password)?;
        self.cache
            .lock()
            .map_err(|_| "credential cache lock poisoned".to_string())?
            .insert(profile_id.to_string(), password.to_string());
        debug!("Stored password in keychain for profile {profile_id}");
        Ok(())
    }

    pub(crate) fn get_password(&self, profile_id: &str) -> Result<Option<String>, String> {
        // Keep the cache lock while consulting the system keychain so concurrent
        // SSH/SFTP opens for the same profile cannot trigger duplicate prompts.
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "credential cache lock poisoned".to_string())?;
        if let Some(password) = cache.get(profile_id).cloned() {
            return Ok(Some(password));
        }

        let password = self.backend.get_password(profile_id)?;
        if let Some(ref password) = password {
            cache.insert(profile_id.to_string(), password.clone());
            debug!("Loaded password from keychain for profile {profile_id}");
        }
        Ok(password)
    }

    pub(crate) fn delete_password(&self, profile_id: &str) -> Result<(), String> {
        self.backend.delete_password(profile_id)?;
        self.cache
            .lock()
            .map_err(|_| "credential cache lock poisoned".to_string())?
            .remove(profile_id);
        debug!("Deleted password from keychain for profile {profile_id}");
        Ok(())
    }

    pub(crate) fn cached_profile_ids(&self) -> Result<Vec<String>, String> {
        let mut profile_ids = self
            .cache
            .lock()
            .map_err(|_| "credential cache lock poisoned".to_string())?
            .keys()
            .cloned()
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct MockBackend {
        passwords: Mutex<HashMap<String, String>>,
        get_calls: AtomicUsize,
        set_calls: AtomicUsize,
        delete_calls: AtomicUsize,
    }

    impl CredentialBackend for MockBackend {
        fn set_password(&self, profile_id: &str, password: &str) -> Result<(), String> {
            self.set_calls.fetch_add(1, Ordering::SeqCst);
            self.passwords
                .lock()
                .unwrap()
                .insert(profile_id.to_string(), password.to_string());
            Ok(())
        }

        fn get_password(&self, profile_id: &str) -> Result<Option<String>, String> {
            self.get_calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.passwords.lock().unwrap().get(profile_id).cloned())
        }

        fn delete_password(&self, profile_id: &str) -> Result<(), String> {
            self.delete_calls.fetch_add(1, Ordering::SeqCst);
            self.passwords.lock().unwrap().remove(profile_id);
            Ok(())
        }
    }

    #[test]
    fn repeated_reads_use_the_in_memory_cache() {
        let backend = Arc::new(MockBackend::default());
        backend
            .passwords
            .lock()
            .unwrap()
            .insert("profile-1".to_string(), "secret".to_string());
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
