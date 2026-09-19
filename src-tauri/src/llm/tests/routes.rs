    use super::*;
    #[test]
    fn missing_route_document_starts_with_an_empty_current_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        db.save_preferences(&[(
            "ai.providers".into(),
            r#"[{"id":"obsolete-provider"}]"#.into(),
        )])
        .unwrap();
        let store = RouteStore::open(db.clone(), CredentialManager::in_memory_for_tests()).unwrap();
        assert_eq!(*store.snapshot().unwrap(), RouteSnapshot::initial());
        let preferences = db.load_preferences().unwrap();
        assert!(preferences.iter().any(|(key, _)| key == ROUTES_KEY));
        assert!(!preferences
            .iter()
            .any(|(key, _)| key == "llm.legacyBackup.v1"));
    }

    #[test]
    fn legacy_minimax_builtin_snapshot_migrates_back_to_inherited_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let mut models =
            catalog::preset_models("minimax", AiProviderKind::OpenAiCompatible).unwrap();
        let old_m3 = models.get_mut("MiniMax-M3").unwrap();
        old_m3.context_window = 204_800;
        old_m3.max_output_tokens = 4_096;
        old_m3.image_input = catalog::Support::Unsupported;
        old_m3.vision = None;
        let snapshot = RouteSnapshot {
            schema_version: 1,
            revision: 3,
            routes: vec![ProviderRoute {
                id: "minimax".into(),
                revision: 2,
                display_name: "MiniMax".into(),
                adapter_id: "chat-completions".into(),
                base_url: "https://api.minimaxi.com".into(),
                auth: RouteAuth::Keychain {
                    reference: "fixture".into(),
                },
                replay_domain_id: "old-domain".into(),
                preset_id: "minimax".into(),
                models: Some(models),
                model_overrides: None,
                defaults: Some(ModelSelection {
                    route_id: "minimax".into(),
                    model_id: "MiniMax-M3".into(),
                    reasoning_effort: None,
                }),
                retry_policy: Default::default(),
                timeouts: Default::default(),
            }],
            default_selection: Some(ModelSelection {
                route_id: "minimax".into(),
                model_id: "MiniMax-M3".into(),
                reasoning_effort: None,
            }),
        };
        db.commit_llm_routes(None, &serde_json::to_string(&snapshot).unwrap())
            .unwrap();

        let store = RouteStore::open(db.clone(), CredentialManager::in_memory_for_tests()).unwrap();
        let migrated = store.snapshot().unwrap();
        let route = migrated.route("minimax").unwrap();
        assert_eq!(migrated.revision, 4);
        assert_eq!(route.revision, 3);
        assert_ne!(route.replay_domain_id, "old-domain");
        assert!(route.models.is_none());
        assert_eq!(
            route
                .provider(route.defaults.as_ref().unwrap())
                .unwrap()
                .model_definition
                .unwrap()
                .max_output_tokens,
            131_072
        );

        let reopened = RouteStore::open(db, CredentialManager::in_memory_for_tests()).unwrap();
        assert_eq!(reopened.snapshot().unwrap().revision, 4);
    }

    #[test]
    fn validates_mutual_exclusion_duplicate_and_unknown_adapter() {
        let mut route = ProviderRoute {
            id: "r".into(),
            revision: 1,
            display_name: "R".into(),
            adapter_id: "bad".into(),
            base_url: "https://example.com".into(),
            auth: RouteAuth::None,
            replay_domain_id: "domain".into(),
            preset_id: "generic".into(),
            models: None,
            model_overrides: None,
            defaults: None,
            retry_policy: Default::default(),
            timeouts: Default::default(),
        };
        assert_eq!(route.validate().unwrap_err(), "UNKNOWN_ADAPTER");
        route.adapter_id = "chat-completions".into();
        let definition = catalog::fixture_definition(AiProviderKind::OpenAiCompatible, 8192);
        route.models = Some(BTreeMap::from([("x".into(), definition.clone())]));
        route.model_overrides = Some(BTreeMap::from([("x".into(), definition)]));
        assert!(route.validate().unwrap_err().contains("mutually exclusive"));
    }

    #[test]
    fn anthropic_routes_require_versioned_keychain_credentials() {
        let definition = catalog::fixture_definition(AiProviderKind::AnthropicMessages, 8192);
        let mut route = ProviderRoute {
            id: "anthropic".into(),
            revision: 1,
            display_name: "Anthropic".into(),
            adapter_id: "anthropic-messages".into(),
            base_url: "https://api.anthropic.com".into(),
            auth: RouteAuth::None,
            replay_domain_id: "domain".into(),
            preset_id: "anthropic".into(),
            models: Some(BTreeMap::from([("fixture-model".into(), definition)])),
            model_overrides: None,
            defaults: None,
            retry_policy: Default::default(),
            timeouts: Default::default(),
        };
        assert_eq!(route.validate().unwrap_err(), "MISSING_CREDENTIAL");
        route.auth = RouteAuth::Keychain {
            reference: "pending".into(),
        };
        route.validate().unwrap();
        assert_eq!(route.kind().unwrap(), AiProviderKind::AnthropicMessages);
    }
    #[test]
    fn database_compare_and_swap_allows_only_one_stale_writer() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let empty = RouteSnapshot {
            schema_version: 1,
            revision: 1,
            routes: vec![],
            default_selection: None,
        };
        let raw = serde_json::to_string(&empty).unwrap();
        db.commit_llm_routes(None, &raw).unwrap();
        let mut next = empty;
        next.revision = 2;
        let next = serde_json::to_string(&next).unwrap();
        db.commit_llm_routes(Some(1), &next).unwrap();
        assert_eq!(
            db.commit_llm_routes(Some(1), &next).unwrap_err(),
            "REVISION_CONFLICT"
        );
    }

    fn keyed_route(id: &str) -> ProviderRoute {
        let definition = catalog::fixture_definition(AiProviderKind::OpenAiCompatible, 8192);
        ProviderRoute {
            id: id.into(),
            revision: 1,
            display_name: "Versioned key route".into(),
            adapter_id: "chat-completions".into(),
            base_url: "https://example.com".into(),
            auth: RouteAuth::Keychain {
                reference: "pending".into(),
            },
            replay_domain_id: "pending".into(),
            preset_id: "generic".into(),
            models: Some(BTreeMap::from([("fixture-model".into(), definition)])),
            model_overrides: None,
            defaults: Some(ModelSelection {
                route_id: id.into(),
                model_id: "fixture-model".into(),
                reasoning_effort: None,
            }),
            retry_policy: Default::default(),
            timeouts: Default::default(),
        }
    }

    #[test]
    fn route_retry_overrides_do_not_escape_into_model_configuration() {
        let mut route = keyed_route("route");
        route.retry_policy = crate::agent_runtime::RetryPolicy {
            max_attempts: 1,
            initial_delay_ms: 0,
            max_delay_ms: 0,
            max_server_delay_ms: 0,
            jitter_ratio: 0.0,
        };

        let provider = route.provider(route.defaults.as_ref().unwrap()).unwrap();
        assert_eq!(provider.retry_policy, None);
    }

    #[test]
    fn route_provider_preserves_openai_compatible_preset_profile() {
        let route = ProviderRoute {
            id: "kimi".into(),
            revision: 1,
            display_name: "Kimi Code".into(),
            adapter_id: "chat-completions".into(),
            base_url: "https://api.kimi.com/coding".into(),
            auth: RouteAuth::Keychain {
                reference: "fixture".into(),
            },
            replay_domain_id: "domain".into(),
            preset_id: "kimi".into(),
            models: None,
            model_overrides: None,
            defaults: Some(ModelSelection {
                route_id: "kimi".into(),
                model_id: "k3".into(),
                reasoning_effort: None,
            }),
            retry_policy: Default::default(),
            timeouts: Default::default(),
        };

        let provider = route.provider(route.defaults.as_ref().unwrap()).unwrap();
        assert_eq!(provider.profile, "kimi");
        assert_eq!(catalog::resolve(&provider).unwrap().profile, "kimi");
    }

    #[test]
    fn inherited_deepseek_route_accepts_a_hidden_callable_alias() {
        let route = ProviderRoute {
            id: "deepseek".into(),
            revision: 1,
            display_name: "DeepSeek".into(),
            adapter_id: "chat-completions".into(),
            base_url: "https://api.deepseek.com".into(),
            auth: RouteAuth::Keychain {
                reference: "fixture".into(),
            },
            replay_domain_id: "domain".into(),
            preset_id: "deepseek".into(),
            models: None,
            model_overrides: None,
            defaults: Some(ModelSelection {
                route_id: "deepseek".into(),
                model_id: "deepseek-v4-flash".into(),
                reasoning_effort: None,
            }),
            retry_policy: Default::default(),
            timeouts: Default::default(),
        };

        assert!(!route
            .model_catalog()
            .unwrap()
            .contains_key("deepseek-v4-flash"));
        route.validate().unwrap();
        assert_eq!(
            route
                .provider(route.defaults.as_ref().unwrap())
                .unwrap()
                .model,
            "deepseek-v4-flash"
        );
    }

    #[test]
    fn secret_rotation_versions_references_and_preserves_the_frozen_route() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let credentials = CredentialManager::in_memory_for_tests();
        let store = RouteStore::open(db, credentials).unwrap();
        let first = store
            .save(
                vec![keyed_route("route")],
                None,
                1,
                BTreeMap::from([("route".into(), "old-secret".into())]),
            )
            .unwrap();
        let frozen = first.route("route").unwrap().clone();
        let old_reference = match &frozen.auth {
            RouteAuth::Keychain { reference } => reference.clone(),
            _ => panic!(),
        };
        let second = store
            .save(
                first.routes.clone(),
                first.default_selection.clone(),
                first.revision,
                BTreeMap::from([("route".into(), "new-secret".into())]),
            )
            .unwrap();
        let current = second.route("route").unwrap();
        let new_reference = match &current.auth {
            RouteAuth::Keychain { reference } => reference,
            _ => panic!(),
        };
        assert_ne!(&old_reference, new_reference);
        assert_eq!(
            store.credential(&frozen).unwrap().as_deref(),
            Some("old-secret")
        );
        assert_eq!(
            store.credential(current).unwrap().as_deref(),
            Some("new-secret")
        );
    }

    #[test]
    fn replay_domain_ignores_display_timeouts_but_rotates_for_protocol_identity() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let credentials = CredentialManager::in_memory_for_tests();
        let store = RouteStore::open(db, credentials).unwrap();
        let first = store
            .save(
                vec![keyed_route("route")],
                None,
                1,
                BTreeMap::from([("route".into(), "secret".into())]),
            )
            .unwrap();
        let first_domain = first.route("route").unwrap().replay_domain_id.clone();
        let mut cosmetic = first.routes.clone();
        cosmetic[0].display_name = "Renamed".into();
        cosmetic[0].timeouts.stream_idle_ms += 1;
        let second = store
            .save(cosmetic, None, first.revision, BTreeMap::new())
            .unwrap();
        assert_eq!(
            second.route("route").unwrap().replay_domain_id,
            first_domain
        );
        let mut protocol_change = second.routes.clone();
        protocol_change[0].preset_id = "qwen".into();
        let third = store
            .save(protocol_change, None, second.revision, BTreeMap::new())
            .unwrap();
        assert_ne!(third.route("route").unwrap().replay_domain_id, first_domain);
    }

    #[test]
    fn missing_versioned_credential_fails_closed_and_recovery_removes_orphans() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let credentials = CredentialManager::in_memory_for_tests();
        let store = RouteStore::open(db.clone(), credentials.clone()).unwrap();
        let snapshot = store
            .save(
                vec![keyed_route("route")],
                None,
                1,
                BTreeMap::from([("route".into(), "secret".into())]),
            )
            .unwrap();
        let route = snapshot.route("route").unwrap();
        let reference = match &route.auth {
            RouteAuth::Keychain { reference } => reference.clone(),
            _ => panic!(),
        };
        credentials
            .delete_credential(AI_KEY_SERVICE, &reference)
            .unwrap();
        assert_eq!(store.credential(route).unwrap_err(), "MISSING_CREDENTIAL");
        credentials
            .set_credential(AI_KEY_SERVICE, "orphan", "orphan-secret")
            .unwrap();
        db.save_preferences(&[("llm.pendingCredential.orphan".into(), "pending".into())])
            .unwrap();
        drop(store);
        let reopened = RouteStore::open(db.clone(), credentials.clone()).unwrap();
        assert!(reopened.snapshot().is_ok());
        assert_eq!(
            credentials
                .get_credential(AI_KEY_SERVICE, "orphan")
                .unwrap(),
            None
        );
        assert!(!db
            .load_preferences()
            .unwrap()
            .iter()
            .any(|(key, _)| key == "llm.pendingCredential.orphan"));
    }

    #[test]
    fn keychain_to_none_is_explicit_and_does_not_change_the_frozen_route() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
        let credentials = CredentialManager::in_memory_for_tests();
        let store = RouteStore::open(db, credentials).unwrap();
        let keyed = store
            .save(
                vec![keyed_route("route")],
                None,
                1,
                BTreeMap::from([("route".into(), "secret".into())]),
            )
            .unwrap();
        let frozen = keyed.route("route").unwrap().clone();
        let mut updated = frozen.clone();
        updated.auth = RouteAuth::None;
        let anonymous = store
            .save(vec![updated], None, keyed.revision, BTreeMap::new())
            .unwrap();
        assert_eq!(
            store.credential(anonymous.route("route").unwrap()).unwrap(),
            None
        );
        assert_eq!(
            store.credential(&frozen).unwrap().as_deref(),
            Some("secret")
        );
    }
