use log::debug;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub(crate) const KEY_SERVICE: &str = "com.termbridge.key";
pub(crate) const PROFILE_PASSWORD_SERVICE: &str = "com.termbridge.profile-password";

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

struct LocalKeychainBackend {
    database: crate::db::Database,
}

impl LocalKeychainBackend {
    fn new(database: crate::db::Database) -> Self {
        Self { database }
    }
}

impl CredentialBackend for LocalKeychainBackend {
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

pub(crate) struct CredentialManager {
    backend: Arc<dyn CredentialBackend>,
    cache: Mutex<HashMap<String, String>>,
}

impl CredentialManager {
    pub(crate) fn new(database: crate::db::Database) -> Self {
        Self {
            backend: Arc::new(LocalKeychainBackend::new(database)),
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
        debug!("Stored credential in local keychain service={service} key={key}");
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
            debug!("Loaded credential from local keychain service={service} key={key}");
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
        debug!("Deleted credential from local keychain service={service} key={key}");
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
    fn key_credentials_use_local_backend() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_backend(backend.clone());

        manager
            .store_key_credential("key-1", "private-key-data")
            .unwrap();
        let loaded = manager.retrieve_key_credential("key-1").unwrap();

        assert_eq!(loaded.as_deref(), Some("private-key-data"));
        assert_eq!(backend.set_calls.load(Ordering::SeqCst), 1);
        assert_eq!(backend.get_calls.load(Ordering::SeqCst), 0);
    }
}
