use super::*;

fn identity() -> CommandIdentity {
    CommandIdentity {
        terminal_session_id: "storage-terminal".into(),
        terminal_generation: 1,
        lease_id: "storage-lease".into(),
        lease_generation: 1,
        agent_session_id: "storage-agent".into(),
        task_id: "storage-task".into(),
        operation_id: "storage-operation".into(),
        command_id: "storage-command".into(),
        source_revision: 1,
    }
}

fn configured(root: &Path) -> SubmissionJournal {
    let journal = SubmissionJournal::unconfigured();
    journal.configure(root).unwrap();
    journal
}

fn database(root: &Path) -> PathBuf {
    root.join("terminal-submissions/intentions.sqlite")
}

#[test]
fn first_initialization_is_lazy_and_records_the_storage_namespace() {
    let root = tempfile::tempdir().unwrap();
    let journal = configured(root.path());
    assert!(!root.path().join(INITIALIZED_FILE).exists());
    assert!(!database(root.path()).exists());
    journal.record(&identity()).unwrap();
    assert!(read_initialization_marker(root.path()).unwrap());
    let connection = Connection::open(database(root.path())).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
    let encoded: String = connection
        .query_row("SELECT record_json FROM submissions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&encoded).unwrap()["version"],
        1
    );
}

#[test]
fn database_loss_refuses_live_and_restarted_operations_without_recreation() {
    let root = tempfile::tempdir().unwrap();
    let journal = configured(root.path());
    journal.record(&identity()).unwrap();
    let backup = root.path().join("saved-database");
    fs::rename(database(root.path()), &backup).unwrap();
    let original = fs::read(&backup).unwrap();
    assert!(journal
        .ensure_new_operation("agent", "task", "new")
        .is_err());
    assert!(configured(root.path())
        .ensure_new_operation("agent", "task", "new")
        .is_err());
    assert!(!database(root.path()).exists());
    assert_eq!(fs::read(backup).unwrap(), original);
}

#[test]
fn directory_loss_does_not_create_a_new_namespace_after_restart() {
    let root = tempfile::tempdir().unwrap();
    configured(root.path()).record(&identity()).unwrap();
    fs::rename(
        root.path().join("terminal-submissions"),
        root.path().join("saved-directory"),
    )
    .unwrap();
    assert!(configured(root.path())
        .ensure_new_operation("agent", "task", "new")
        .is_err());
    assert!(!root.path().join("terminal-submissions").exists());
    assert!(root.path().join(INITIALIZED_FILE).is_file());
}

#[test]
fn marker_loss_is_not_mistaken_for_a_legacy_database() {
    let root = tempfile::tempdir().unwrap();
    let journal = configured(root.path());
    journal.record(&identity()).unwrap();
    fs::rename(
        root.path().join(INITIALIZED_FILE),
        root.path().join("saved-marker"),
    )
    .unwrap();
    assert!(journal
        .ensure_new_operation("agent", "task", "new")
        .is_err());
    assert!(configured(root.path())
        .ensure_new_operation("agent", "task", "new")
        .is_err());
    assert!(!root.path().join(INITIALIZED_FILE).exists());
}

#[test]
fn corrupt_or_non_file_markers_are_not_rewritten() {
    for directory_marker in [false, true] {
        let root = tempfile::tempdir().unwrap();
        configured(root.path()).record(&identity()).unwrap();
        let marker = root.path().join(INITIALIZED_FILE);
        fs::rename(&marker, root.path().join("saved-marker")).unwrap();
        if directory_marker {
            fs::create_dir(&marker).unwrap();
        } else {
            fs::write(&marker, b"unknown marker").unwrap();
        }
        assert!(configured(root.path())
            .ensure_new_operation("agent", "task", "new")
            .is_err());
        if directory_marker {
            assert!(marker.is_dir());
        } else {
            assert_eq!(fs::read(marker).unwrap(), b"unknown marker");
        }
    }
}

#[test]
fn an_existing_empty_directory_is_not_a_first_initialization() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("terminal-submissions")).unwrap();
    assert!(configured(root.path())
        .ensure_new_operation("agent", "task", "new")
        .is_err());
    assert!(!database(root.path()).exists());
    assert!(!root.path().join(INITIALIZED_FILE).exists());
}

#[test]
fn legacy_v1_migration_preserves_settled_and_unsettled_call_fences() {
    let root = tempfile::tempdir().unwrap();
    let original = configured(root.path());
    let pending = identity();
    let mut settled = pending.clone();
    settled.operation_id = "settled-operation".into();
    settled.command_id = "settled-command".into();
    original.record(&pending).unwrap();
    original.record(&settled).unwrap();
    original.settle(&settled).unwrap();
    fs::rename(
        root.path().join(INITIALIZED_FILE),
        root.path().join("saved-marker"),
    )
    .unwrap();
    let connection = Connection::open(database(root.path())).unwrap();
    connection.pragma_update(None, "user_version", 1).unwrap();
    let rows = |connection: &Connection| -> Vec<(String, i64)> {
        connection
            .prepare("SELECT record_json,settled FROM submissions ORDER BY call_key")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    let before = rows(&connection);
    drop(connection);
    let restarted = configured(root.path());
    assert_eq!(
        restarted.unresolved_for_agent(None).unwrap()[0].identity,
        pending
    );
    assert_eq!(
        restarted
            .recovered_for_agent(&pending.agent_session_id)
            .unwrap()
            .len(),
        1
    );
    for id in [&pending, &settled] {
        assert_eq!(
            restarted
                .ensure_new_operation(&id.agent_session_id, &id.task_id, &id.operation_id)
                .unwrap_err(),
            "TERMINAL_SUBMISSION_ALREADY_RECORDED"
        );
    }
    let connection = Connection::open(database(root.path())).unwrap();
    assert_eq!(rows(&connection), before);
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    assert!(read_initialization_marker(root.path()).unwrap());
}

#[test]
fn incomplete_legacy_schema_is_not_repaired_into_an_empty_ledger() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("terminal-submissions")).unwrap();
    let connection = Connection::open(database(root.path())).unwrap();
    connection.pragma_update(None, "user_version", 1).unwrap();
    drop(connection);
    assert!(configured(root.path())
        .ensure_new_operation("agent", "task", "new")
        .is_err());
    assert!(!root.path().join(INITIALIZED_FILE).exists());
    let connection = Connection::open(database(root.path())).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='submissions'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn unknown_database_version_is_not_reset() {
    let root = tempfile::tempdir().unwrap();
    configured(root.path()).record(&identity()).unwrap();
    let connection = Connection::open(database(root.path())).unwrap();
    connection.pragma_update(None, "user_version", 99).unwrap();
    drop(connection);
    assert!(configured(root.path())
        .ensure_new_operation("agent", "task", "new")
        .is_err());
    let connection = Connection::open(database(root.path())).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        99
    );
}

#[test]
fn legacy_schema_without_a_unique_call_key_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("terminal-submissions")).unwrap();
    let connection = Connection::open(database(root.path())).unwrap();
    connection.execute_batch("CREATE TABLE submissions(call_key TEXT NOT NULL, agent_session_id TEXT NOT NULL, record_json TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0); PRAGMA user_version=1;").unwrap();
    drop(connection);
    assert!(configured(root.path())
        .ensure_new_operation("agent", "task", "new")
        .is_err());
    assert!(!root.path().join(INITIALIZED_FILE).exists());
}

#[test]
fn recovery_rejects_an_agent_column_that_disagrees_with_the_identity() {
    let root = tempfile::tempdir().unwrap();
    configured(root.path()).record(&identity()).unwrap();
    let connection = Connection::open(database(root.path())).unwrap();
    connection
        .execute(
            "UPDATE submissions SET agent_session_id='another-agent'",
            [],
        )
        .unwrap();
    drop(connection);
    assert!(configured(root.path()).unresolved_for_agent(None).is_err());
}

#[test]
fn a_read_only_database_is_not_made_writable() {
    let root = tempfile::tempdir().unwrap();
    configured(root.path()).record(&identity()).unwrap();
    let path = database(root.path());
    let original = fs::metadata(&path).unwrap().permissions();
    let mut read_only = original.clone();
    read_only.set_readonly(true);
    fs::set_permissions(&path, read_only).unwrap();
    let outcome = configured(root.path()).ensure_new_operation("agent", "task", "new");
    let still_read_only = fs::metadata(&path).unwrap().permissions().readonly();
    fs::set_permissions(&path, original).unwrap();
    assert!(outcome.is_err());
    assert!(still_read_only);
}

#[cfg(unix)]
#[test]
fn marker_symlinks_are_rejected_and_permissions_remain_private() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let root = tempfile::tempdir().unwrap();
    configured(root.path()).record(&identity()).unwrap();
    assert_eq!(
        fs::metadata(root.path().join("terminal-submissions"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    for path in [root.path().join(INITIALIZED_FILE), database(root.path())] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let marker = root.path().join(INITIALIZED_FILE);
    let saved = root.path().join("saved-marker");
    fs::rename(&marker, &saved).unwrap();
    symlink(saved, marker).unwrap();
    assert!(configured(root.path())
        .ensure_new_operation("agent", "task", "new")
        .is_err());
}
