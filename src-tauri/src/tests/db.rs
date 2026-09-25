use super::*;
use crate::models::{ProfileAuthMethod, ProfileRow, SftpBookmarkRow};

pub(crate) fn test_db() -> Database {
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
fn initializes_empty_database_to_current_schema() {
    let db = test_db();
    let conn = db.conn.lock().unwrap();
    let version: i32 = conn
        .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(version, CURRENT_SCHEMA_VERSION);
    let migrations: Vec<(i32, String)> = conn
        .prepare("SELECT version, migration_name FROM schema_version ORDER BY version")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        migrations,
        vec![
            (1, "initial_schema".to_string()),
            (2, "deployment_foundation".to_string()),
            (3, "deployment_plan_guards".to_string()),
            (4, "deployment_phase5_runtime".to_string()),
            (5, "deployment_phase6_reconciliation".to_string()),
            (6, "deployment_phase7_history_notifications".to_string()),
            (7, "deployment_workflow_foundation".to_string()),
            (8, "deployment_workflow_integrity_guards".to_string()),
            (9, "deployment_workflow_profile_guard".to_string()),
            (10, "deployment_workflow_canonical_names".to_string()),
            (11, "deployment_applications".to_string()),
        ]
    );

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
    conn.execute("SELECT 1 FROM deployment_workflows LIMIT 0", [])
        .unwrap();
    conn.execute("SELECT 1 FROM deployment_runs LIMIT 0", [])
        .unwrap();
    conn.execute("SELECT 1 FROM deployment_run_events LIMIT 0", [])
        .unwrap();
    conn.execute("SELECT 1 FROM deployment_legacy_workflows LIMIT 0", [])
        .unwrap();
    conn.execute("SELECT 1 FROM deployment_legacy_runs LIMIT 0", [])
        .unwrap();
    conn.execute("SELECT 1 FROM deployment_legacy_run_events LIMIT 0", [])
        .unwrap();
    conn.execute(
        "SELECT 1 FROM deployment_legacy_transfer_receipts LIMIT 0",
        [],
    )
    .unwrap();
    conn.execute(
        "SELECT 1 FROM deployment_legacy_notification_receipts LIMIT 0",
        [],
    )
    .unwrap();
    conn.execute("SELECT 1 FROM deployment_workflow_revisions LIMIT 0", [])
        .unwrap();
    conn.execute("SELECT 1 FROM deployment_workflow_layouts LIMIT 0", [])
        .unwrap();
    conn.execute("SELECT 1 FROM deployment_run_nodes LIMIT 0", [])
        .unwrap();
    conn.execute("SELECT 1 FROM deployment_node_attempts LIMIT 0", [])
        .unwrap();
    conn.execute("SELECT 1 FROM deployment_run_outputs LIMIT 0", [])
        .unwrap();
    conn.execute("SELECT 1 FROM deployment_artifacts LIMIT 0", [])
        .unwrap();
    conn.execute("SELECT 1 FROM deployment_artifact_refs LIMIT 0", [])
        .unwrap();
    conn.execute("SELECT 1 FROM deployment_effect_receipts LIMIT 0", [])
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
fn upgrades_existing_database_to_current_schema_without_losing_data() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    conn.execute_batch(
        "CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );",
    )
    .unwrap();
    conn.execute_batch(SCHEMA_INITIAL).unwrap();
    conn.execute("INSERT INTO schema_version (version) VALUES (1)", [])
        .unwrap();
    conn.execute(
        "INSERT INTO profiles (
                id, name, host, port, username, auth_method, created_at, updated_at
             ) VALUES ('existing', 'Existing', 'example.com', 22, 'alice', 'password', 1, 1)",
        [],
    )
    .unwrap();
    let db = Database {
        conn: Arc::new(Mutex::new(conn)),
    };

    db.initialize_or_validate_schema().unwrap();

    let conn = db.conn.lock().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT name FROM profiles WHERE id = 'existing'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "Existing"
    );
    assert_eq!(
        conn.query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get::<_, i32>(0)
        })
        .unwrap(),
        CURRENT_SCHEMA_VERSION
    );
    assert_eq!(
        conn.query_row(
            "SELECT migration_name FROM schema_version WHERE version = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "initial_schema"
    );
    conn.execute("SELECT 1 FROM deployment_workflows LIMIT 0", [])
        .unwrap();
    conn.execute("SELECT 1 FROM deployment_legacy_workflows LIMIT 0", [])
        .unwrap();
}

#[test]
fn canonical_name_migration_preserves_legacy_and_current_deployment_rows() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    conn.execute_batch(SCHEMA_VERSION_TABLE).unwrap();
    for migration in MIGRATIONS.iter().take(9) {
        apply_schema_migration(&mut conn, migration).unwrap();
    }

    conn.execute(
        "INSERT INTO profiles (
            id, name, host, port, username, auth_method, created_at, updated_at
         ) VALUES ('profile-rename', 'Rename', 'example.com', 22, 'alice', 'password', 1, 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO deployment_workflows (
            id, name, connection_profile_id, revision, definition_version,
            definition_json, created_at, updated_at
         ) VALUES ('legacy-workflow', 'Legacy', 'profile-rename', 1, 1, '{}', 2, 2)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO deployment_current_workflows (
            id, name, enabled, archived, head_revision, head_layout_revision,
            created_at, updated_at
         ) VALUES ('current-workflow', 'Current', 1, 0, 1, 0, 3, 3)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO deployment_current_workflow_revisions (
            workflow_id, revision, schema_version, definition_json,
            definition_digest, created_at
         ) VALUES ('current-workflow', 1, 3, '{}', ?1, 3)",
        [format!("sha256:{}", "a".repeat(64))],
    )
    .unwrap();

    apply_schema_migration(&mut conn, &MIGRATIONS[9]).unwrap();

    assert_eq!(
        conn.query_row(
            "SELECT name FROM deployment_legacy_workflows WHERE id = 'legacy-workflow'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "Legacy"
    );
    assert_eq!(
        conn.query_row(
            "SELECT name FROM deployment_workflows WHERE id = 'current-workflow'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "Current"
    );
    assert_eq!(
        conn.query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get::<_, i32>(0)
        })
        .unwrap(),
        10
    );
}

#[test]
fn repeated_open_is_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("shellspan.db");
    drop(Database::open(&path).unwrap());
    let reopened = Database::open(&path).unwrap();
    let conn = reopened.conn.lock().unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM schema_version", [], |row| {
            row.get::<_, i32>(0)
        })
        .unwrap(),
        CURRENT_SCHEMA_VERSION
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'deployment_%'",
            [],
            |row| row.get::<_, i32>(0),
        )
        .unwrap(),
        20
    );
}

#[test]
fn rejects_higher_database_schema_without_modifying_it() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE schema_version (version INTEGER PRIMARY KEY);")
        .unwrap();
    conn.execute(
        "INSERT INTO schema_version (version) VALUES (?1)",
        [CURRENT_SCHEMA_VERSION + 1],
    )
    .unwrap();
    let db = Database {
        conn: Arc::new(Mutex::new(conn)),
    };

    let error = db.initialize_or_validate_schema().unwrap_err();

    assert_eq!(
            error,
            format!(
                "unsupported database schema version {}; latest supported version is {CURRENT_SCHEMA_VERSION}", CURRENT_SCHEMA_VERSION + 1
            )
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
fn rejects_unknown_or_gapped_migration_history() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY,
                migration_name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
             );
             INSERT INTO schema_version (version, migration_name) VALUES (0, 'unknown');",
    )
    .unwrap();
    let db = Database {
        conn: Arc::new(Mutex::new(conn)),
    };

    let error = db.initialize_or_validate_schema().unwrap_err();

    assert!(error.contains("expected version 1, found 0"));
    let conn = db.conn.lock().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='deployment_workflows'",
            [],
            |row| row.get::<_, i32>(0),
        )
        .unwrap(),
        0
    );
}

fn insert_deployment_fixture(conn: &Connection) {
    conn.execute(
        "INSERT INTO profiles (
                id, name, host, port, username, auth_method, created_at, updated_at
             ) VALUES ('profile-1', 'Production', 'example.com', 22, 'alice', 'password', 1, 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO deployment_legacy_workflows (
                id, name, connection_profile_id, revision, definition_version,
                definition_json, created_at, updated_at
             ) VALUES ('workflow-1', 'API', 'profile-1', 1, 1, '{}', 10, 10)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO deployment_legacy_runs (
                id, workflow_id, workflow_revision, operation_kind, trigger_kind,
                status, approval_summary_json, approval_digest, created_at, updated_at
             ) VALUES (
                'run-1', 'workflow-1', 1, 'deploy', 'manual', 'planned', '{}',
                '0000000000000000000000000000000000000000000000000000000000000000',
                20, 20
             )",
        [],
    )
    .unwrap();
}

#[test]
fn deployment_tables_enforce_references_bounds_and_known_values() {
    let db = test_db();
    let conn = db.conn.lock().unwrap();
    insert_deployment_fixture(&conn);

    assert!(conn
        .execute("DELETE FROM profiles WHERE id = 'profile-1'", [],)
        .is_err());
    assert!(conn
        .execute(
            "UPDATE deployment_legacy_runs SET status = 'invented' WHERE id = 'run-1'",
            [],
        )
        .is_err());
    assert!(conn
        .execute(
            "UPDATE deployment_legacy_runs SET status = 'in_progress' WHERE id = 'run-1'",
            [],
        )
        .is_err());
    assert!(conn
        .execute(
            "UPDATE deployment_legacy_runs SET approval_digest = ?1 WHERE id = 'run-1'",
            ["f".repeat(64)],
        )
        .is_err());
    assert!(conn
        .execute(
            "INSERT INTO deployment_legacy_runs (
                    id, workflow_id, workflow_revision, operation_kind, trigger_kind,
                    status, approval_summary_json, approval_digest, created_at, updated_at
                 ) VALUES (
                    'run-invalid', 'workflow-1', 1, 'deploy', 'manual', 'approved', '{}',
                    '1111111111111111111111111111111111111111111111111111111111111111',
                    20, 20
                 )",
            [],
        )
        .is_err());
    assert!(conn
        .execute(
            "UPDATE deployment_legacy_workflows SET definition_json = 'not-json' WHERE id = 'workflow-1'",
            [],
        )
        .is_err());
    assert!(conn
        .execute(
            "INSERT INTO deployment_legacy_run_events (
                    run_id, sequence, event_kind, summary, recorded_at
                 ) VALUES ('run-1', 1, 'status_changed', ?1, 21)",
            ["x".repeat(4097)],
        )
        .is_err());
}

#[test]
fn deployment_events_are_contiguous_immutable_and_cascade_with_workflow() {
    let db = test_db();
    let conn = db.conn.lock().unwrap();
    insert_deployment_fixture(&conn);
    conn.execute(
        "INSERT INTO deployment_legacy_run_events (
                run_id, sequence, event_kind, status, summary, recorded_at
             ) VALUES ('run-1', 1, 'run_created', 'planned', 'Run created', 21)",
        [],
    )
    .unwrap();
    assert!(conn
        .execute(
            "INSERT INTO deployment_legacy_run_events (
                    run_id, sequence, event_kind, summary, recorded_at
                 ) VALUES ('run-1', 3, 'status_changed', 'Skipped sequence', 22)",
            [],
        )
        .is_err());
    conn.execute(
        "INSERT INTO deployment_legacy_run_events (
                run_id, sequence, event_kind, status, summary, recorded_at
             ) VALUES (
                'run-1', 2, 'approval_requested', 'awaiting_approval',
                'Approval requested', 23
             )",
        [],
    )
    .unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT last_event_sequence FROM deployment_legacy_runs WHERE id = 'run-1'",
            [],
            |row| row.get::<_, i32>(0),
        )
        .unwrap(),
        2
    );
    assert!(conn
            .execute(
                "UPDATE deployment_legacy_run_events SET summary = 'Changed' WHERE run_id = 'run-1' AND sequence = 1",
                [],
            )
            .is_err());
    assert!(conn
        .execute(
            "DELETE FROM deployment_legacy_run_events WHERE run_id = 'run-1' AND sequence = 1",
            [],
        )
        .is_err());
    assert!(conn
        .execute("DELETE FROM deployment_legacy_runs WHERE id = 'run-1'", [],)
        .is_err());
    conn.execute(
        "INSERT INTO deployment_legacy_runs (
                id, workflow_id, workflow_revision, source_run_id, operation_kind, trigger_kind,
                status, approval_summary_json, approval_digest, created_at, updated_at
             ) VALUES (
                'run-2', 'workflow-1', 1, 'run-1', 'resume', 'recovery', 'planned', '{}',
                '2222222222222222222222222222222222222222222222222222222222222222',
                24, 24
             )",
        [],
    )
    .unwrap();

    conn.execute(
        "DELETE FROM deployment_legacy_workflows WHERE id = 'workflow-1'",
        [],
    )
    .unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM deployment_legacy_runs", [], |row| {
            row.get::<_, i32>(0)
        })
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM deployment_legacy_run_events",
            [],
            |row| { row.get::<_, i32>(0) }
        )
        .unwrap(),
        0
    );
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
