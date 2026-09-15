    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    #[derive(Default)]
    struct MockBackend {
        credentials: Mutex<HashMap<String, HashMap<String, String>>>,
        get_calls: AtomicUsize,
        set_calls: AtomicUsize,
        delete_calls: AtomicUsize,
    }

    impl CredentialBackend for MockBackend {
        fn set_credential(&self, service: &str, key: &str, value: &str) -> Result<(), String> {
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
    fn credential_service_selection_preserves_the_production_namespace() {
        assert_eq!(
            credential_service_for_mode("production", "development", false),
            "production"
        );
        assert_eq!(
            credential_service_for_mode("production", "development", true),
            "development"
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_build_uses_development_credential_namespaces() {
        assert_eq!(KEY_CREDENTIAL_SERVICE, "com.shellspan.dev.key");
        assert_eq!(
            PROFILE_PASSWORD_CREDENTIAL_SERVICE,
            "com.shellspan.dev.profile-password"
        );
        assert_eq!(
            PROFILE_SECRET_CREDENTIAL_SERVICE,
            "com.shellspan.dev.profile-secret"
        );
        assert_eq!(AI_KEY_SERVICE, "com.shellspan.dev.ai-provider");
        assert_eq!(MCP_CREDENTIAL_SERVICE, "com.shellspan.dev.mcp");
        assert_eq!(
            CREDENTIAL_VAULT_SERVICE,
            "com.shellspan.dev.credential-vault"
        );
        assert_eq!(CREDENTIAL_VAULT_ACCOUNT, "shellspan-dev-v2");
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn release_build_uses_production_credential_namespaces() {
        assert_eq!(KEY_CREDENTIAL_SERVICE, KEY_SERVICE);
        assert_eq!(
            PROFILE_PASSWORD_CREDENTIAL_SERVICE,
            PROFILE_PASSWORD_SERVICE
        );
        assert_eq!(PROFILE_SECRET_CREDENTIAL_SERVICE, PROFILE_SECRET_SERVICE);
        assert_eq!(AI_KEY_SERVICE, "com.shellspan.ai-provider");
        assert_eq!(MCP_CREDENTIAL_SERVICE, "com.shellspan.mcp");
        assert_eq!(CREDENTIAL_VAULT_SERVICE, "com.shellspan.credential-vault");
        assert_eq!(CREDENTIAL_VAULT_ACCOUNT, "shellspan-v2");
    }

    #[test]
    fn vault_backend_stores_all_logical_credentials_in_one_native_item() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_vault_backend(backend.clone());

        manager
            .set_credential("com.shellspan.ai-provider", "openai", "sk-openai")
            .unwrap();
        manager
            .set_credential(PROFILE_PASSWORD_SERVICE, "profile-1", "ssh-password")
            .unwrap();

        assert_eq!(
            manager
                .get_credential("com.shellspan.ai-provider", "openai")
                .unwrap()
                .as_deref(),
            Some("sk-openai")
        );
        assert_eq!(
            manager
                .get_credential(PROFILE_PASSWORD_SERVICE, "profile-1")
                .unwrap()
                .as_deref(),
            Some("ssh-password")
        );

        let credentials = backend.credentials.lock().unwrap();
        assert_eq!(credentials.len(), 1);
        let vault_items = credentials.get(CREDENTIAL_VAULT_SERVICE).unwrap();
        assert_eq!(vault_items.len(), 1);
        let payload = vault_items.get(CREDENTIAL_VAULT_ACCOUNT).unwrap();
        let vault: CredentialVault = serde_json::from_str(payload).unwrap();
        assert_eq!(
            vault.get("com.shellspan.ai-provider", "openai"),
            Some("sk-openai")
        );
        assert_eq!(
            vault.get(PROFILE_PASSWORD_SERVICE, "profile-1"),
            Some("ssh-password")
        );
    }

    #[test]
    fn vault_backend_does_not_read_per_item_credentials() {
        let backend = Arc::new(MockBackend::default());
        backend
            .set_credential(PROFILE_PASSWORD_SERVICE, "profile-1", "obsolete-password")
            .unwrap();
        let manager = CredentialManager::with_vault_backend(backend.clone());

        assert_eq!(
            manager
                .get_credential(PROFILE_PASSWORD_SERVICE, "profile-1")
                .unwrap(),
            None
        );
        assert_eq!(
            backend
                .get_credential(PROFILE_PASSWORD_SERVICE, "profile-1")
                .unwrap()
                .as_deref(),
            Some("obsolete-password")
        );
    }

    #[test]
    fn vault_delete_preserves_other_credentials() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_vault_backend(backend.clone());
        manager.set_credential("service-a", "key-a", "a").unwrap();
        manager.set_credential("service-b", "key-b", "b").unwrap();
        manager.delete_credential("service-a", "key-a").unwrap();

        assert_eq!(manager.get_credential("service-a", "key-a").unwrap(), None);
        assert_eq!(
            manager
                .get_credential("service-b", "key-b")
                .unwrap()
                .as_deref(),
            Some("b")
        );
    }

    #[test]
    fn vault_backend_fails_closed_for_corrupted_payload() {
        let backend = Arc::new(MockBackend::default());
        backend
            .set_credential(
                CREDENTIAL_VAULT_SERVICE,
                CREDENTIAL_VAULT_ACCOUNT,
                "not-json",
            )
            .unwrap();
        let manager = CredentialManager::with_vault_backend(backend);

        let error = manager
            .get_credential(PROFILE_PASSWORD_SERVICE, "profile-1")
            .unwrap_err();
        assert!(error.contains("credential vault is invalid"));
    }

    #[test]
    fn vault_backend_serializes_concurrent_updates_without_losing_entries() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_vault_backend(backend);
        let handles = (0..12)
            .map(|index| {
                let manager = manager.clone();
                std::thread::spawn(move || {
                    manager
                        .set_credential("concurrent-service", &format!("key-{index}"), "value")
                        .unwrap();
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }

        for index in 0..12 {
            assert_eq!(
                manager
                    .get_credential("concurrent-service", &format!("key-{index}"))
                    .unwrap()
                    .as_deref(),
                Some("value")
            );
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
        assert!(backend
            .credentials
            .lock()
            .unwrap()
            .get(KEY_CREDENTIAL_SERVICE)
            .is_some_and(|entries| entries.contains_key("key-1")));
        assert_eq!(backend.set_calls.load(Ordering::SeqCst), 1);
        assert_eq!(backend.get_calls.load(Ordering::SeqCst), 1);

        manager.delete_key_credential("key-1").unwrap();
        assert_eq!(manager.retrieve_key_credential("key-1").unwrap(), None);
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
        // After delete, the backend is cleared.
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
    fn set_then_get_reads_backend_without_retaining_a_secret_cache() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_backend(backend.clone());

        manager.set_credential("svc", "k", "v").unwrap();
        let val = manager.get_credential("svc", "k").unwrap();
        assert_eq!(val.as_deref(), Some("v"));
        assert_eq!(backend.get_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn delete_removes_from_backend() {
        let backend = Arc::new(MockBackend::default());
        let manager = CredentialManager::with_backend(backend.clone());

        manager.set_credential("svc", "k", "v").unwrap();
        manager.delete_credential("svc", "k").unwrap();

        let val = manager.get_credential("svc", "k").unwrap();
        assert_eq!(val, None);
    }
