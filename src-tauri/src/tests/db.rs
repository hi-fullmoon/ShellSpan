    use super::*;
    use crate::models::{ProfileAuthMethod, ProfileRow, SftpBookmarkRow};

    fn test_db() -> Database {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let db = Database {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.initialize_or_validate_schema().unwrap();
        db
    }

    fn test_profile(id: &str, name: &str) -> ProfileRow {
        ProfileRow {
            id: id.to_string(),
            name: name.to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: ProfileAuthMethod::Password,
            keychain_key_id: None,
            jump_host_config: None,
            organization_json: None,
            created_at: 1000,
            updated_at: 2000,
        }
    }

    #[test]
    fn initializes_only_the_current_schema() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let version: i32 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);

        // Verify the exact current table set.
        conn.execute("SELECT 1 FROM profiles LIMIT 0", []).unwrap();
        conn.execute("SELECT 1 FROM preferences LIMIT 0", [])
            .unwrap();
        conn.execute("SELECT 1 FROM recent_profiles LIMIT 0", [])
            .unwrap();
        conn.execute("SELECT 1 FROM sftp_bookmarks LIMIT 0", [])
            .unwrap();
        conn.execute("SELECT 1 FROM terminal_workspace LIMIT 0", [])
            .unwrap();
        conn.execute("SELECT 1 FROM sftp_workspace LIMIT 0", [])
            .unwrap();
        conn.execute("SELECT 1 FROM key_credentials LIMIT 0", [])
            .unwrap();
        let operation_history_table_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='table' AND name='operation_history_events'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(operation_history_table_count, 0);
        let has_secret_value_column: bool = conn
            .prepare("PRAGMA table_info(key_credentials)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .any(|name| name.as_deref() == Ok("value"));
        assert!(!has_secret_value_column);
        let has_organization_column: bool = conn
            .prepare("PRAGMA table_info(profiles)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .any(|name| name.as_deref() == Ok("organization_json"));
        assert!(has_organization_column);
    }

    #[test]
    fn rejects_every_non_current_database_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE schema_version (version INTEGER PRIMARY KEY); INSERT INTO schema_version (version) VALUES (7);").unwrap();
        let db = Database {
            conn: Arc::new(Mutex::new(conn)),
        };

        let error = db.initialize_or_validate_schema().unwrap_err();

        assert_eq!(
            error,
            format!("unsupported database schema version 7; expected {CURRENT_SCHEMA_VERSION}")
        );
        let conn = db.conn.lock().unwrap();
        let workspace_table_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='terminal_workspace'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(workspace_table_count, 0);
    }

    #[test]
    fn insert_and_list_profiles() {
        let db = test_db();
        let profile = test_profile("p1", "My Server");
        db.insert_profile(&profile).unwrap();

        let list = db.list_profiles().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "p1");
        assert_eq!(list[0].name, "My Server");
        assert_eq!(list[0].host, "example.com");
        assert_eq!(list[0].port, 22);
        assert_eq!(list[0].username, "alice");
        assert_eq!(list[0].auth_method, ProfileAuthMethod::Password);
    }

    #[test]
    fn update_profile() {
        let db = test_db();
        db.insert_profile(&test_profile("p1", "Old Name")).unwrap();

        let mut updated = test_profile("p1", "New Name");
        updated.host = "new.example.com".to_string();
        updated.port = 2222;
        db.update_profile("p1", &updated).unwrap();

        let list = db.list_profiles().unwrap();
        assert_eq!(list[0].name, "New Name");
        assert_eq!(list[0].host, "new.example.com");
        assert_eq!(list[0].port, 2222);
    }

    #[test]
    fn update_nonexistent_profile_returns_error() {
        let db = test_db();
        let result = db.update_profile("nonexistent", &test_profile("x", "X"));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn delete_profile() {
        let db = test_db();
        db.insert_profile(&test_profile("p1", "Server 1")).unwrap();
        db.insert_profile(&test_profile("p2", "Server 2")).unwrap();
        assert_eq!(db.list_profiles().unwrap().len(), 2);

        db.delete_profile("p1").unwrap();
        let list = db.list_profiles().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "p2");
    }

    #[test]
    fn delete_profile_cascades_recent() {
        let db = test_db();
        db.insert_profile(&test_profile("p1", "Server 1")).unwrap();
        db.touch_recent_profile("p1").unwrap();
        assert_eq!(db.list_recent_profiles().unwrap().len(), 1);

        db.delete_profile("p1").unwrap();
        assert_eq!(db.list_recent_profiles().unwrap().len(), 0);
    }

    #[test]
    fn preferences_crud() {
        let db = test_db();
        let entries = vec![
            ("theme".to_string(), "\"dark\"".to_string()),
            ("locale".to_string(), "\"zh-CN\"".to_string()),
        ];
        db.save_preferences(&entries).unwrap();

        let loaded = db.load_preferences().unwrap();
        assert_eq!(loaded.len(), 2);
        assert!(loaded.contains(&("theme".to_string(), "\"dark\"".to_string())));
        assert!(loaded.contains(&("locale".to_string(), "\"zh-CN\"".to_string())));

        // Update existing key
        db.save_preferences(&[("theme".to_string(), "\"light\"".to_string())])
            .unwrap();
        let loaded = db.load_preferences().unwrap();
        assert!(loaded.contains(&("theme".to_string(), "\"light\"".to_string())));
    }

    #[cfg(unix)]
    #[test]
    fn database_open_restricts_directory_and_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let storage = directory.path().join("shellspan");
        let path = storage.join("shellspan.db");
        let database = Database::open(&path).unwrap();
        drop(database);

        assert_eq!(
            std::fs::metadata(&storage).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn recent_profiles_ordering() {
        let db = test_db();
        db.insert_profile(&test_profile("p1", "S1")).unwrap();
        db.insert_profile(&test_profile("p2", "S2")).unwrap();
        db.insert_profile(&test_profile("p3", "S3")).unwrap();

        db.touch_recent_profile("p1").unwrap();
        db.touch_recent_profile("p2").unwrap();
        db.touch_recent_profile("p3").unwrap();

        let ids = db.list_recent_profiles().unwrap();
        assert_eq!(ids, vec!["p3", "p2", "p1"]);

        // Touch p1 again - should move to front
        db.touch_recent_profile("p1").unwrap();
        let ids = db.list_recent_profiles().unwrap();
        assert_eq!(ids, vec!["p1", "p3", "p2"]);
    }

    #[test]
    fn recent_profiles_capped_at_10() {
        let db = test_db();
        for i in 0..12 {
            let id = format!("p{i}");
            db.insert_profile(&test_profile(&id, &format!("Server {i}")))
                .unwrap();
            db.touch_recent_profile(&id).unwrap();
        }

        let ids = db.list_recent_profiles().unwrap();
        assert_eq!(ids.len(), 10);
        // Most recent should be at front
        assert_eq!(ids[0], "p11");
    }

    #[test]
    fn remove_recent_profile() {
        let db = test_db();
        db.insert_profile(&test_profile("p1", "S1")).unwrap();
        db.insert_profile(&test_profile("p2", "S2")).unwrap();
        db.touch_recent_profile("p1").unwrap();
        db.touch_recent_profile("p2").unwrap();

        db.remove_recent_profile("p1").unwrap();
        let ids = db.list_recent_profiles().unwrap();
        assert_eq!(ids, vec!["p2"]);
    }

    #[test]
    fn sftp_bookmarks_crud() {
        let db = test_db();
        let bookmark = SftpBookmarkRow {
            id: "b1".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            path: "/var/log".to_string(),
            side: "remote".to_string(),
            label: Some("Logs".to_string()),
            created_at: 3000,
        };
        db.insert_sftp_bookmark(&bookmark).unwrap();

        let list = db.list_sftp_bookmarks("example.com", 22, "alice").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, "/var/log");
        assert_eq!(list[0].side, "remote");
        assert_eq!(list[0].label.as_deref(), Some("Logs"));

        // Different host should return empty
        let list = db.list_sftp_bookmarks("other.com", 22, "alice").unwrap();
        assert!(list.is_empty());

        db.delete_sftp_bookmark("b1").unwrap();
        let list = db.list_sftp_bookmarks("example.com", 22, "alice").unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn auth_method_serialization_roundtrip() {
        let db = test_db();
        let profile = ProfileRow {
            id: "pk1".to_string(),
            name: "Key Server".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: ProfileAuthMethod::Key,
            keychain_key_id: Some("key-1".to_string()),
            jump_host_config: None,
            organization_json: None,
            created_at: 1000,
            updated_at: 2000,
        };
        db.insert_profile(&profile).unwrap();

        let list = db.list_profiles().unwrap();
        assert_eq!(list[0].auth_method, ProfileAuthMethod::Key);
        assert_eq!(list[0].keychain_key_id.as_deref(), Some("key-1"));
    }

    #[test]
    fn jump_host_config_stored_as_json() {
        let db = test_db();
        let profile = ProfileRow {
            id: "jh1".to_string(),
            name: "Jump Server".to_string(),
            host: "internal.example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: ProfileAuthMethod::Password,
            keychain_key_id: None,
            jump_host_config: Some(
                r#"{"host":"jump.example.com","port":22,"username":"jumpuser","authMethod":"key"}"#
                    .to_string(),
            ),
            organization_json: Some(
                r#"{"group":"Production","tags":["api"],"favorite":true,"notes":"Primary"}"#
                    .to_string(),
            ),
            created_at: 1000,
            updated_at: 2000,
        };
        db.insert_profile(&profile).unwrap();

        let list = db.list_profiles().unwrap();
        assert!(list[0].jump_host_config.is_some());
        let config = list[0].jump_host_config.as_deref().unwrap();
        assert!(config.contains("jump.example.com"));
        assert!(list[0]
            .organization_json
            .as_deref()
            .is_some_and(|metadata| metadata.contains("Production")));
    }

    #[test]
    fn terminal_workspace_roundtrip_and_clear() {
        let db = test_db();
        assert_eq!(db.load_terminal_workspace().unwrap(), None);

        let sessions =
            r#"{"version":1,"sessions":[{"profileId":"p1","title":"Server"}],"layout":null}"#;
        db.save_terminal_workspace(sessions).unwrap();
        assert_eq!(
            db.load_terminal_workspace().unwrap().as_deref(),
            Some(sessions)
        );

        let empty = r#"{"version":1,"sessions":[],"layout":null}"#;
        db.save_terminal_workspace(empty).unwrap();
        assert_eq!(
            db.load_terminal_workspace().unwrap().as_deref(),
            Some(empty)
        );

        db.clear_terminal_workspace().unwrap();
        assert_eq!(db.load_terminal_workspace().unwrap(), None);
    }

    #[test]
    fn terminal_workspace_rejects_unknown_versions_and_unbounded_payloads() {
        let db = test_db();
        let valid = r#"{"version":1,"sessions":[],"layout":null}"#;
        db.save_terminal_workspace(valid).unwrap();

        assert!(db
            .save_terminal_workspace(r#"{"version":2,"sessions":[],"layout":null}"#)
            .unwrap_err()
            .contains("unsupported"));
        let too_many = serde_json::json!({
            "version": 1,
            "sessions": (0..=MAX_TERMINAL_WORKSPACE_SESSIONS)
                .map(|index| serde_json::json!({ "profileId": index }))
                .collect::<Vec<_>>(),
            "layout": null,
        })
        .to_string();
        assert!(db
            .save_terminal_workspace(&too_many)
            .unwrap_err()
            .contains("too many"));
        let oversized = format!(
            "{{\"version\":1,\"sessions\":[],\"padding\":\"{}\"}}",
            "x".repeat(MAX_TERMINAL_WORKSPACE_BYTES)
        );
        assert!(db
            .save_terminal_workspace(&oversized)
            .unwrap_err()
            .contains("storage limit"));
        assert_eq!(
            db.load_terminal_workspace().unwrap().as_deref(),
            Some(valid)
        );
    }

    #[test]
    fn sftp_workspace_roundtrip_and_clear() {
        let db = test_db();
        assert_eq!(db.load_sftp_workspace().unwrap(), None);

        let workspace = r#"{"version":1,"tabs":[]}"#;
        db.save_sftp_workspace(workspace).unwrap();
        assert_eq!(
            db.load_sftp_workspace().unwrap().as_deref(),
            Some(workspace)
        );

        db.clear_sftp_workspace().unwrap();
        assert_eq!(db.load_sftp_workspace().unwrap(), None);
    }

    #[test]
    fn profile_password_is_listed_with_password_kind_and_profile_key_type() {
        let db = test_db();
        let profile = ProfileRow {
            id: "profile-1".to_string(),
            name: "Server".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: ProfileAuthMethod::Password,
            keychain_key_id: None,
            jump_host_config: None,
            organization_json: None,
            created_at: 1,
            updated_at: 1,
        };
        db.insert_profile(&profile).unwrap();
        db.upsert_key_credential(
            "profile-1",
            "Server",
            "profile",
            "password",
            "com.shellspan.profile-password",
            None,
            None,
            1000,
        )
        .unwrap();
        let summaries = db.list_key_credentials().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "profile-1");
        assert_eq!(summaries[0].label, "Server");
        assert_eq!(summaries[0].key_type, "profile");
        assert_eq!(
            summaries[0].kind,
            crate::models::KeyCredentialKind::Password
        );
        assert_eq!(summaries[0].service, "com.shellspan.profile-password");
    }

    #[test]
    fn clear_keychain_key_id_references_updates_matching_profiles() {
        let db = test_db();
        let mut profile = ProfileRow {
            id: "profile-1".to_string(),
            name: "Server".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: ProfileAuthMethod::Key,
            keychain_key_id: Some("key-1".to_string()),
            jump_host_config: None,
            organization_json: None,
            created_at: 1,
            updated_at: 1,
        };
        db.insert_profile(&profile).unwrap();

        let affected = db.clear_keychain_key_id_references("key-1").unwrap();
        assert_eq!(affected, 1);

        let loaded = db
            .list_profiles()
            .unwrap()
            .into_iter()
            .find(|p| p.id == "profile-1")
            .unwrap();
        assert_eq!(loaded.keychain_key_id, None);
        assert!(loaded.updated_at > profile.updated_at);

        profile.keychain_key_id = None;
        db.update_profile("profile-1", &profile).unwrap();
        assert_eq!(db.clear_keychain_key_id_references("key-1").unwrap(), 0);
    }

    #[test]
    fn key_reference_cleanup_includes_jump_hosts() {
        let db = test_db();
        let profile = ProfileRow {
            id: "profile-1".to_string(),
            name: "Server".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: ProfileAuthMethod::Password,
            keychain_key_id: None,
            jump_host_config: Some(
                r#"{"host":"jump.example.com","port":22,"username":"jump","authMethod":"key","keychainKeyId":"jump-key"}"#
                    .to_string(),
            ),
            organization_json: None,
            created_at: 1,
            updated_at: 1,
        };
        db.insert_profile(&profile).unwrap();

        assert_eq!(
            db.list_profiles_referencing_key("jump-key").unwrap(),
            vec!["profile-1"]
        );
        assert_eq!(db.clear_keychain_key_id_references("jump-key").unwrap(), 1);

        let loaded = db.get_profile("profile-1").unwrap().unwrap();
        let jump: serde_json::Value =
            serde_json::from_str(loaded.jump_host_config.as_deref().unwrap()).unwrap();
        assert!(jump.get("keychainKeyId").is_none());
    }
