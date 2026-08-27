use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Arc, Mutex};

const CURRENT_SCHEMA_VERSION: i32 = 5;
const CURRENT_DEPLOYMENT_SCHEMA_VERSION: i32 = 2;
const TERMINAL_WORKSPACE_VERSION: u64 = 1;
const MAX_TERMINAL_WORKSPACE_BYTES: usize = 1024 * 1024;
const MAX_TERMINAL_WORKSPACE_SESSIONS: usize = 100;

fn validate_terminal_workspace(workspace_json: &str) -> Result<(), String> {
    if workspace_json.len() > MAX_TERMINAL_WORKSPACE_BYTES {
        return Err("terminal workspace exceeds the storage limit".to_string());
    }
    let workspace: serde_json::Value = serde_json::from_str(workspace_json)
        .map_err(|_| "terminal workspace must be valid JSON".to_string())?;
    let object = workspace
        .as_object()
        .ok_or_else(|| "terminal workspace must be an object".to_string())?;
    if object
        .get("version")
        .is_some_and(|version| version.as_u64() != Some(TERMINAL_WORKSPACE_VERSION))
    {
        return Err("terminal workspace version is unsupported".to_string());
    }
    let sessions = object
        .get("sessions")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "terminal workspace sessions must be an array".to_string())?;
    if sessions.len() > MAX_TERMINAL_WORKSPACE_SESSIONS {
        return Err("terminal workspace has too many sessions".to_string());
    }
    Ok(())
}

const SCHEMA_V1: &str = "
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    auth_method TEXT NOT NULL CHECK(auth_method IN ('password', 'key')),
    keychain_key_id TEXT,
    jump_host_config TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recent_profiles (
    profile_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (profile_id),
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sftp_bookmarks (
    id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    path TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('local', 'remote')),
    label TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS terminal_workspace (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    sessions_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS key_credentials (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    key_type TEXT DEFAULT 'unknown',
    kind TEXT NOT NULL DEFAULT 'keyFile',
    public_key TEXT,
    certificate TEXT,
    service TEXT NOT NULL DEFAULT 'com.termbridge.key'
);
";

const SCHEMA_V2: &str = "
PRAGMA secure_delete=ON;
BEGIN IMMEDIATE;
DROP TABLE IF EXISTS key_credentials_v2;
CREATE TABLE key_credentials_v2 (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    key_type TEXT DEFAULT 'unknown',
    kind TEXT NOT NULL DEFAULT 'keyFile',
    public_key TEXT,
    certificate TEXT,
    service TEXT NOT NULL DEFAULT 'com.termbridge.key'
);
INSERT INTO key_credentials_v2 (
    id, label, updated_at, key_type, kind, public_key, certificate, service
)
SELECT id, label, updated_at, key_type, kind, public_key, certificate, service
FROM key_credentials;
DROP TABLE key_credentials;
ALTER TABLE key_credentials_v2 RENAME TO key_credentials;
UPDATE profiles
SET jump_host_config = CASE
    WHEN json_valid(jump_host_config)
        THEN json_remove(
            jump_host_config,
            '$.password',
            '$.passphrase',
            '$.privateKeyData'
        )
    ELSE NULL
END
WHERE jump_host_config IS NOT NULL;
INSERT INTO schema_version (version) VALUES (2);
COMMIT;
PRAGMA wal_checkpoint(TRUNCATE);
VACUUM;
";

const SCHEMA_V3: &str = "
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS sftp_workspace (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    workspace_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
INSERT INTO schema_version (version) VALUES (3);
COMMIT;
";

const SCHEMA_V4: &str = "
BEGIN IMMEDIATE;
ALTER TABLE profiles ADD COLUMN organization_json TEXT;
INSERT INTO schema_version (version) VALUES (4);
COMMIT;
";

const SCHEMA_V5: &str = "
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS operation_history_events (
    event_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    parent_operation_id TEXT,
    occurred_at INTEGER NOT NULL,
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    status TEXT NOT NULL,
    risk TEXT,
    subject_id TEXT,
    primary_profile_id TEXT,
    targets_json TEXT NOT NULL,
    command_preview TEXT,
    evidence_json TEXT NOT NULL,
    error_category TEXT,
    retry_of_operation_id TEXT,
    item_count INTEGER,
    byte_count INTEGER,
    exit_code INTEGER,
    batch_index INTEGER,
    batch_total INTEGER,
    concurrency_limit INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operation_history_task_time
    ON operation_history_events(task_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_operation_history_time
    ON operation_history_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_history_category_status
    ON operation_history_events(category, status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_history_profile_time
    ON operation_history_events(primary_profile_id, occurred_at DESC);
INSERT INTO schema_version (version) VALUES (5);
COMMIT;
";

// Deployment persistence intentionally uses a separate, additive schema
// namespace.  The primary schema remains at v5 so a phase-2 binary can open a
// database after a phase-3 binary has used it; the older binary simply ignores
// these tables.  No existing table or column is changed by this migration.
const DEPLOYMENT_SCHEMA_V1: &str = "
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS deployment_schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deployment_reviews (
    review_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE,
    operation_kind TEXT NOT NULL CHECK(operation_kind IN ('deployment', 'rollback', 'cleanup')),
    source_operation_id TEXT,
    document_digest TEXT NOT NULL,
    plan_digest TEXT NOT NULL,
    target_digest TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    application_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    version TEXT NOT NULL,
    review_json TEXT NOT NULL CHECK(json_valid(review_json)),
    state TEXT NOT NULL CHECK(state IN ('pending', 'consumed', 'expired')),
    reviewed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deployment_reviews_operation
    ON deployment_reviews(operation_id);
CREATE INDEX IF NOT EXISTS idx_deployment_reviews_source
    ON deployment_reviews(source_operation_id, state);
CREATE TABLE IF NOT EXISTS deployment_operations (
    operation_id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL UNIQUE,
    operation_kind TEXT NOT NULL CHECK(operation_kind IN ('deployment', 'rollback', 'cleanup')),
    source_operation_id TEXT,
    execution_token TEXT NOT NULL,
    document_digest TEXT NOT NULL,
    plan_digest TEXT NOT NULL,
    target_digest TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    application_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    version TEXT NOT NULL,
    phase TEXT NOT NULL,
    terminal INTEGER NOT NULL CHECK(terminal IN (0, 1)),
    recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(recovery_required IN (0, 1)),
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error_category TEXT,
    error TEXT,
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (review_id) REFERENCES deployment_reviews(review_id)
);
CREATE INDEX IF NOT EXISTS idx_deployment_operations_time
    ON deployment_operations(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployment_operations_target
    ON deployment_operations(target_digest, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployment_operations_recovery
    ON deployment_operations(recovery_required, terminal, started_at DESC);
CREATE TABLE IF NOT EXISTS deployment_action_results (
    operation_id TEXT NOT NULL,
    action_index INTEGER NOT NULL,
    action_id TEXT NOT NULL,
    status TEXT NOT NULL,
    action_json TEXT NOT NULL CHECK(json_valid(action_json)),
    started_at INTEGER,
    completed_at INTEGER,
    PRIMARY KEY (operation_id, action_index),
    FOREIGN KEY (operation_id) REFERENCES deployment_operations(operation_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS deployment_health_evidence (
    operation_id TEXT NOT NULL,
    check_index INTEGER NOT NULL,
    check_id TEXT NOT NULL,
    status TEXT NOT NULL,
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (operation_id, check_index),
    FOREIGN KEY (operation_id) REFERENCES deployment_operations(operation_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS deployment_rollback_snapshots (
    operation_id TEXT PRIMARY KEY,
    strategy TEXT NOT NULL CHECK(strategy = 'reactivatePreviousRelease'),
    previous_release TEXT,
    new_release TEXT NOT NULL,
    releases_directory TEXT NOT NULL,
    active_symlink TEXT NOT NULL,
    activation_changed INTEGER NOT NULL CHECK(activation_changed IN (0, 1)),
    captured_at INTEGER,
    rollback_consumed_at INTEGER,
    FOREIGN KEY (operation_id) REFERENCES deployment_operations(operation_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS deployment_approval_consumptions (
    review_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE,
    operation_kind TEXT NOT NULL,
    approval_digest TEXT NOT NULL,
    consumed_at INTEGER NOT NULL,
    FOREIGN KEY (review_id) REFERENCES deployment_reviews(review_id),
    FOREIGN KEY (operation_id) REFERENCES deployment_operations(operation_id)
);
CREATE TABLE IF NOT EXISTS deployment_release_records (
    target_digest TEXT NOT NULL,
    release_path TEXT NOT NULL,
    releases_directory TEXT NOT NULL,
    active_symlink TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    application_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    version TEXT NOT NULL,
    source_operation_id TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0, 1)),
    is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN (0, 1)),
    last_verified_at INTEGER,
    deleted_at INTEGER,
    PRIMARY KEY (target_digest, release_path)
);
CREATE INDEX IF NOT EXISTS idx_deployment_releases_candidate
    ON deployment_release_records(target_digest, verified, is_current, deleted_at);
CREATE TABLE IF NOT EXISTS deployment_review_release_refs (
    review_id TEXT NOT NULL,
    release_path TEXT NOT NULL,
    reference_kind TEXT NOT NULL CHECK(reference_kind IN ('current', 'newRelease', 'rollbackTarget', 'cleanupTarget')),
    PRIMARY KEY (review_id, release_path, reference_kind),
    FOREIGN KEY (review_id) REFERENCES deployment_reviews(review_id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO deployment_schema_version (version) VALUES (1);
COMMIT;
";

const DEPLOYMENT_SCHEMA_V2: &str = "
BEGIN IMMEDIATE;
ALTER TABLE deployment_rollback_snapshots ADD COLUMN rollback_reserved_by TEXT;
CREATE INDEX IF NOT EXISTS idx_deployment_rollback_reservation
    ON deployment_rollback_snapshots(rollback_reserved_by, rollback_consumed_at);
INSERT INTO deployment_schema_version (version) VALUES (2);
COMMIT;
";

#[derive(Clone)]
pub(crate) struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub(crate) fn open(db_path: &Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create database directory: {e}"))?;
        }
        let conn =
            Connection::open(db_path).map_err(|e| format!("failed to open database: {e}"))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("failed to set pragmas: {e}"))?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;

        let current: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if current > CURRENT_SCHEMA_VERSION {
            return Err(format!(
                "database schema version {current} is newer than this build ({CURRENT_SCHEMA_VERSION})"
            ));
        }

        if current < 1 {
            conn.execute_batch(SCHEMA_V1)
                .map_err(|e| format!("migration v1 failed: {e}"))?;
            conn.execute("INSERT INTO schema_version (version) VALUES (1)", [])
                .map_err(|e| format!("migration v1 version insert failed: {e}"))?;
        }

        if current < 2 {
            conn.execute_batch(SCHEMA_V2)
                .map_err(|e| format!("migration v2 failed: {e}"))?;
        }

        if current < 3 {
            conn.execute_batch(SCHEMA_V3)
                .map_err(|e| format!("migration v3 failed: {e}"))?;
        }

        if current < 4 {
            conn.execute_batch(SCHEMA_V4)
                .map_err(|e| format!("migration v4 failed: {e}"))?;
        }

        if current < 5 {
            conn.execute_batch(SCHEMA_V5)
                .map_err(|e| format!("migration v5 failed: {e}"))?;
        }

        let deployment_current: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM deployment_schema_version",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if deployment_current > CURRENT_DEPLOYMENT_SCHEMA_VERSION {
            return Err(format!(
                "deployment schema version {deployment_current} is newer than this build ({CURRENT_DEPLOYMENT_SCHEMA_VERSION})"
            ));
        }
        if deployment_current < 1 {
            conn.execute_batch(DEPLOYMENT_SCHEMA_V1)
                .map_err(|e| format!("deployment migration v1 failed: {e}"))?;
        }
        if deployment_current < 2 {
            conn.execute_batch(DEPLOYMENT_SCHEMA_V2)
                .map_err(|e| format!("deployment migration v2 failed: {e}"))?;
        }

        Ok(())
    }

    pub(crate) fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        operation(&conn)
    }

    pub(crate) fn with_transaction<T>(
        &self,
        operation: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let transaction = conn
            .transaction()
            .map_err(|e| format!("failed to start database transaction: {e}"))?;
        let value = operation(&transaction)?;
        transaction
            .commit()
            .map_err(|e| format!("failed to commit database transaction: {e}"))?;
        Ok(value)
    }

    // --- Profiles ---

    pub(crate) fn list_profiles(&self) -> Result<Vec<crate::models::ProfileRow>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, host, port, username, auth_method, \
                 keychain_key_id, jump_host_config, organization_json, created_at, updated_at \
                 FROM profiles ORDER BY name",
            )
            .map_err(|e| format!("failed to prepare list_profiles: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(crate::models::ProfileRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get(3)?,
                    username: row.get(4)?,
                    auth_method: {
                        let s: String = row.get(5)?;
                        match s.as_str() {
                            "password" => crate::models::ProfileAuthMethod::Password,
                            "key" => crate::models::ProfileAuthMethod::Key,
                            other => {
                                return Err(rusqlite::Error::FromSqlConversionFailure(
                                    5,
                                    rusqlite::types::Type::Text,
                                    Box::new(std::io::Error::new(
                                        std::io::ErrorKind::InvalidData,
                                        format!("unknown auth_method: {other}"),
                                    )),
                                ))
                            }
                        }
                    },
                    keychain_key_id: row.get(6)?,
                    jump_host_config: row.get(7)?,
                    organization_json: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .map_err(|e| format!("failed to query profiles: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect profiles: {e}"))
    }

    pub(crate) fn get_profile(
        &self,
        id: &str,
    ) -> Result<Option<crate::models::ProfileRow>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let row = conn
            .query_row(
                "SELECT id, name, host, port, username, auth_method, \
                 keychain_key_id, jump_host_config, organization_json, created_at, updated_at \
                 FROM profiles WHERE id = ?1",
                params![id],
                |row| {
                    Ok(crate::models::ProfileRow {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        host: row.get(2)?,
                        port: row.get(3)?,
                        username: row.get(4)?,
                        auth_method: {
                            let s: String = row.get(5)?;
                            match s.as_str() {
                                "password" => crate::models::ProfileAuthMethod::Password,
                                "key" => crate::models::ProfileAuthMethod::Key,
                                other => Err(rusqlite::Error::FromSqlConversionFailure(
                                    5,
                                    rusqlite::types::Type::Text,
                                    Box::new(std::io::Error::new(
                                        std::io::ErrorKind::InvalidData,
                                        format!("unknown auth_method: {other}"),
                                    )),
                                ))?,
                            }
                        },
                        keychain_key_id: row.get(6)?,
                        jump_host_config: row.get(7)?,
                        organization_json: row.get(8)?,
                        created_at: row.get(9)?,
                        updated_at: row.get(10)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("failed to get profile: {e}"))?;
        Ok(row)
    }

    pub(crate) fn insert_profile(&self, profile: &crate::models::ProfileRow) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "INSERT INTO profiles (id, name, host, port, username, auth_method, \
             keychain_key_id, jump_host_config, organization_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                profile.id,
                profile.name,
                profile.host,
                profile.port,
                profile.username,
                profile.auth_method.as_str(),
                profile.keychain_key_id,
                profile.jump_host_config,
                profile.organization_json,
                profile.created_at,
                profile.updated_at,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("failed to insert profile: {e}"))
    }

    pub(crate) fn update_profile(
        &self,
        id: &str,
        profile: &crate::models::ProfileRow,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let rows = conn
            .execute(
                "UPDATE profiles SET name=?2, host=?3, port=?4, username=?5, auth_method=?6, \
                 keychain_key_id=?7, jump_host_config=?8, \
                 organization_json=?9, created_at=?10, updated_at=?11 WHERE id=?1",
                params![
                    id,
                    profile.name,
                    profile.host,
                    profile.port,
                    profile.username,
                    profile.auth_method.as_str(),
                    profile.keychain_key_id,
                    profile.jump_host_config,
                    profile.organization_json,
                    profile.created_at,
                    profile.updated_at,
                ],
            )
            .map_err(|e| format!("failed to update profile: {e}"))?;
        if rows == 0 {
            return Err(format!("profile {id} not found"));
        }
        Ok(())
    }

    pub(crate) fn delete_profile(&self, id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute("DELETE FROM profiles WHERE id=?1", params![id])
            .map_err(|e| format!("failed to delete profile: {e}"))?;
        Ok(())
    }

    // --- Key credentials ---

    pub(crate) fn list_key_credentials(
        &self,
    ) -> Result<Vec<crate::models::KeyCredentialSummary>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, label, COALESCE(key_type, 'unknown'), kind, service FROM key_credentials ORDER BY label",
            )
            .map_err(|e| format!("failed to prepare list_key_credentials: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let kind: String = row.get(3)?;
                Ok(crate::models::KeyCredentialSummary {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    key_type: row.get(2)?,
                    kind: match kind.as_str() {
                        "password" => crate::models::KeyCredentialKind::Password,
                        _ => crate::models::KeyCredentialKind::KeyFile,
                    },
                    service: row.get(4)?,
                })
            })
            .map_err(|e| format!("failed to query key_credentials: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect key_credentials: {e}"))
    }

    pub(crate) fn upsert_key_credential(
        &self,
        id: &str,
        label: &str,
        key_type: &str,
        kind: &str,
        service: &str,
        public_key: Option<&str>,
        certificate: Option<&str>,
        updated_at: i64,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "INSERT INTO key_credentials (id, label, key_type, kind, service, public_key, certificate, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(id) DO UPDATE SET label=excluded.label, key_type=excluded.key_type, kind=excluded.kind, service=excluded.service, public_key=excluded.public_key, certificate=excluded.certificate, updated_at=excluded.updated_at",
            params![id, label, key_type, kind, service, public_key, certificate, updated_at],
        )
        .map_err(|e| format!("failed to upsert key credential: {e}"))?;
        Ok(())
    }

    pub(crate) fn delete_key_credential(&self, id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute("DELETE FROM key_credentials WHERE id=?1", params![id])
            .map_err(|e| format!("failed to delete key credential: {e}"))?;
        Ok(())
    }

    pub(crate) fn delete_key_credential_metadata(
        &self,
        id: &str,
        service: &str,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "DELETE FROM key_credentials WHERE id=?1 AND service=?2",
            params![id, service],
        )
        .map_err(|e| format!("failed to delete key credential metadata: {e}"))?;
        Ok(())
    }

    pub(crate) fn key_credential_service(&self, id: &str) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.query_row(
            "SELECT service FROM key_credentials WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("failed to retrieve key credential service: {e}"))
    }

    pub(crate) fn list_profiles_referencing_key(
        &self,
        key_id: &str,
    ) -> Result<Vec<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT id, keychain_key_id, jump_host_config FROM profiles")
            .map_err(|e| format!("failed to prepare list_profiles_referencing_key: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| format!("failed to query profiles referencing key: {e}"))?;
        let rows = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect profiles referencing key: {e}"))?;
        Ok(rows
            .into_iter()
            .filter_map(|(id, main_key_id, jump_host_config)| {
                let jump_matches = jump_host_config
                    .as_deref()
                    .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
                    .and_then(|jump| {
                        jump.get("keychainKeyId")
                            .and_then(|value| value.as_str())
                            .map(str::to_owned)
                    })
                    .is_some_and(|jump_key_id| jump_key_id == key_id);
                (main_key_id.as_deref() == Some(key_id) || jump_matches).then_some(id)
            })
            .collect())
    }

    pub(crate) fn clear_keychain_key_id_references(&self, key_id: &str) -> Result<usize, String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("failed to start key reference cleanup transaction: {e}"))?;
        let mut updated = tx
            .execute(
                "UPDATE profiles SET keychain_key_id = NULL, updated_at = ?2 WHERE keychain_key_id = ?1",
                params![key_id, current_timestamp_ms()],
            )
            .map_err(|e| format!("failed to clear keychain key references: {e}"))?;
        let mut stmt = tx
            .prepare("SELECT id, jump_host_config FROM profiles WHERE jump_host_config IS NOT NULL")
            .map_err(|e| format!("failed to prepare jump-host key cleanup: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("failed to query jump-host key references: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect jump-host key references: {e}"))?;
        drop(stmt);
        for (profile_id, json) in rows {
            let Ok(mut jump) = serde_json::from_str::<serde_json::Value>(&json) else {
                continue;
            };
            if jump.get("keychainKeyId").and_then(|value| value.as_str()) != Some(key_id) {
                continue;
            }
            if let Some(object) = jump.as_object_mut() {
                object.remove("keychainKeyId");
            }
            tx.execute(
                "UPDATE profiles SET jump_host_config=?2, updated_at=?3 WHERE id=?1",
                params![profile_id, jump.to_string(), current_timestamp_ms()],
            )
            .map_err(|e| format!("failed to clear jump-host key reference: {e}"))?;
            updated += 1;
        }
        tx.commit()
            .map_err(|e| format!("failed to commit key reference cleanup: {e}"))?;
        Ok(updated)
    }

    // --- Preferences ---

    pub(crate) fn load_preferences(&self) -> Result<Vec<(String, String)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT key, value FROM preferences")
            .map_err(|e| format!("failed to prepare load_preferences: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("failed to query preferences: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect preferences: {e}"))
    }

    pub(crate) fn save_preferences(&self, entries: &[(String, String)]) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        for (key, value) in entries {
            conn.execute(
                "INSERT INTO preferences (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )
            .map_err(|e| format!("failed to save preference {key}: {e}"))?;
        }
        Ok(())
    }

    // --- Recent Profiles ---

    pub(crate) fn list_recent_profiles(&self) -> Result<Vec<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT profile_id FROM recent_profiles ORDER BY sort_order ASC")
            .map_err(|e| format!("failed to prepare list_recent_profiles: {e}"))?;
        let rows = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| format!("failed to query recent_profiles: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect recent_profiles: {e}"))
    }

    pub(crate) fn touch_recent_profile(&self, profile_id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;

        // Shift all existing entries down to make room at position 0
        conn.execute("UPDATE recent_profiles SET sort_order = sort_order + 1", [])
            .map_err(|e| format!("failed to shift recent_profiles: {e}"))?;

        // Upsert at position 0
        conn.execute(
            "INSERT INTO recent_profiles (profile_id, sort_order) VALUES (?1, 0) \
             ON CONFLICT(profile_id) DO UPDATE SET sort_order=0",
            params![profile_id],
        )
        .map_err(|e| format!("failed to touch recent_profile: {e}"))?;

        // Prune to max 10
        conn.execute("DELETE FROM recent_profiles WHERE sort_order >= 10", [])
            .map_err(|e| format!("failed to prune recent_profiles: {e}"))?;

        Ok(())
    }

    pub(crate) fn remove_recent_profile(&self, profile_id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "DELETE FROM recent_profiles WHERE profile_id=?1",
            params![profile_id],
        )
        .map_err(|e| format!("failed to remove recent_profile: {e}"))?;
        Ok(())
    }

    // --- SFTP Bookmarks ---

    pub(crate) fn list_sftp_bookmarks(
        &self,
        host: &str,
        port: u16,
        username: &str,
    ) -> Result<Vec<crate::models::SftpBookmarkRow>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, host, port, username, path, side, label, created_at \
                 FROM sftp_bookmarks WHERE host=?1 AND port=?2 AND username=?3 \
                 ORDER BY created_at ASC",
            )
            .map_err(|e| format!("failed to prepare list_sftp_bookmarks: {e}"))?;
        let rows = stmt
            .query_map(params![host, port, username], |row| {
                Ok(crate::models::SftpBookmarkRow {
                    id: row.get(0)?,
                    host: row.get(1)?,
                    port: row.get(2)?,
                    username: row.get(3)?,
                    path: row.get(4)?,
                    side: row.get(5)?,
                    label: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })
            .map_err(|e| format!("failed to query sftp_bookmarks: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect sftp_bookmarks: {e}"))
    }

    pub(crate) fn insert_sftp_bookmark(
        &self,
        bookmark: &crate::models::SftpBookmarkRow,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "INSERT INTO sftp_bookmarks (id, host, port, username, path, side, label, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                bookmark.id,
                bookmark.host,
                bookmark.port,
                bookmark.username,
                bookmark.path,
                bookmark.side,
                bookmark.label,
                bookmark.created_at,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("failed to insert sftp_bookmark: {e}"))
    }

    pub(crate) fn delete_sftp_bookmark(&self, id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute("DELETE FROM sftp_bookmarks WHERE id=?1", params![id])
            .map_err(|e| format!("failed to delete sftp_bookmark: {e}"))?;
        Ok(())
    }

    // --- Terminal Workspace ---

    pub(crate) fn load_terminal_workspace(&self) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.query_row(
            "SELECT sessions_json FROM terminal_workspace WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("failed to load terminal workspace: {e}"))
    }

    pub(crate) fn save_terminal_workspace(&self, sessions_json: &str) -> Result<(), String> {
        validate_terminal_workspace(sessions_json)?;
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "INSERT INTO terminal_workspace (id, sessions_json, updated_at) \
             VALUES (1, ?1, ?2) \
             ON CONFLICT(id) DO UPDATE SET \
             sessions_json=excluded.sessions_json, updated_at=excluded.updated_at",
            params![sessions_json, current_timestamp_ms()],
        )
        .map(|_| ())
        .map_err(|e| format!("failed to save terminal workspace: {e}"))
    }

    pub(crate) fn clear_terminal_workspace(&self) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute("DELETE FROM terminal_workspace WHERE id=1", [])
            .map(|_| ())
            .map_err(|e| format!("failed to clear terminal workspace: {e}"))
    }

    // --- SFTP Workspace ---

    pub(crate) fn load_sftp_workspace(&self) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.query_row(
            "SELECT workspace_json FROM sftp_workspace WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("failed to load SFTP workspace: {e}"))
    }

    pub(crate) fn save_sftp_workspace(&self, workspace_json: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "INSERT INTO sftp_workspace (id, workspace_json, updated_at) \
             VALUES (1, ?1, ?2) \
             ON CONFLICT(id) DO UPDATE SET \
             workspace_json=excluded.workspace_json, updated_at=excluded.updated_at",
            params![workspace_json, current_timestamp_ms()],
        )
        .map(|_| ())
        .map_err(|e| format!("failed to save SFTP workspace: {e}"))
    }

    pub(crate) fn clear_sftp_workspace(&self) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute("DELETE FROM sftp_workspace WHERE id=1", [])
            .map(|_| ())
            .map_err(|e| format!("failed to clear SFTP workspace: {e}"))
    }
}

pub(crate) fn current_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ProfileAuthMethod, ProfileRow, SftpBookmarkRow};

    fn test_db() -> Database {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let db = Database {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.migrate().unwrap();
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
    fn migration_creates_tables() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let version: i32 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);

        // Verify tables exist by querying them
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
        conn.execute("SELECT 1 FROM operation_history_events LIMIT 0", [])
            .unwrap();
        conn.execute("SELECT 1 FROM deployment_reviews LIMIT 0", [])
            .unwrap();
        conn.execute("SELECT 1 FROM deployment_operations LIMIT 0", [])
            .unwrap();
        conn.execute("SELECT 1 FROM deployment_action_results LIMIT 0", [])
            .unwrap();
        conn.execute("SELECT 1 FROM deployment_health_evidence LIMIT 0", [])
            .unwrap();
        conn.execute("SELECT 1 FROM deployment_rollback_snapshots LIMIT 0", [])
            .unwrap();
        let has_rollback_reservation: bool = conn
            .prepare("PRAGMA table_info(deployment_rollback_snapshots)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .any(|name| name.as_deref() == Ok("rollback_reserved_by"));
        assert!(has_rollback_reservation);
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
    fn deployment_migration_is_additive_and_phase_two_rollback_compatible() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let primary_version: i32 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
                row.get(0)
            })
            .unwrap();
        let deployment_version: i32 = conn
            .query_row(
                "SELECT MAX(version) FROM deployment_schema_version",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            primary_version, 5,
            "phase-2 builds reject primary versions above v5"
        );
        assert_eq!(deployment_version, CURRENT_DEPLOYMENT_SCHEMA_VERSION);
        let changed_existing_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='table' AND name IN ('profiles', 'operation_history_events')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(changed_existing_tables, 2);
    }

    #[test]
    fn migration_v2_purges_database_secret_values_and_preserves_metadata() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        conn.execute("ALTER TABLE key_credentials ADD COLUMN value TEXT", [])
            .unwrap();
        conn.execute("INSERT INTO schema_version (version) VALUES (1)", [])
            .unwrap();
        conn.execute(
            "INSERT INTO key_credentials \
             (id, label, updated_at, key_type, kind, public_key, certificate, service, value) \
             VALUES ('key-1', 'Server key', 42, 'rsa', 'keyFile', 'ssh-rsa AAA', NULL, \
                     'com.termbridge.key', 'plaintext-private-key')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO profiles \
             (id, name, host, port, username, auth_method, jump_host_config, created_at, updated_at) \
             VALUES ('profile-1', 'Jump profile', 'internal.example.com', 22, 'alice', 'password', \
                     ?1, 1, 1)",
            params![serde_json::json!({
                "host": "jump.example.com",
                "port": 22,
                "username": "jump-user",
                "authMethod": "password",
                "password": "plaintext-password",
                "passphrase": "plaintext-passphrase",
                "privateKeyData": "plaintext-private-key"
            })
            .to_string()],
        )
        .unwrap();
        let db = Database {
            conn: Arc::new(Mutex::new(conn)),
        };

        db.migrate().unwrap();

        let conn = db.conn.lock().unwrap();
        let columns = conn
            .prepare("PRAGMA table_info(key_credentials)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(!columns.iter().any(|column| column == "value"));
        let jump_host_config: String = conn
            .query_row(
                "SELECT jump_host_config FROM profiles WHERE id='profile-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let jump_host: serde_json::Value = serde_json::from_str(&jump_host_config).unwrap();
        assert_eq!(jump_host["host"], "jump.example.com");
        assert!(jump_host.get("password").is_none());
        assert!(jump_host.get("passphrase").is_none());
        assert!(jump_host.get("privateKeyData").is_none());
        let metadata: (String, String, i64) = conn
            .query_row(
                "SELECT label, key_type, updated_at FROM key_credentials WHERE id='key-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(metadata, ("Server key".to_string(), "rsa".to_string(), 42));
        let organization_json: Option<String> = conn
            .query_row(
                "SELECT organization_json FROM profiles WHERE id='profile-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(organization_json, None);
    }

    #[test]
    fn migration_rejects_newer_database_without_modifying_it() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        conn.execute("INSERT INTO schema_version (version) VALUES (99)", [])
            .unwrap();
        let db = Database {
            conn: Arc::new(Mutex::new(conn)),
        };

        let error = db.migrate().unwrap_err();

        assert_eq!(
            error,
            format!(
                "database schema version 99 is newer than this build ({CURRENT_SCHEMA_VERSION})"
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
        assert_eq!(workspace_table_count, 1);
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

    #[test]
    fn ai_provider_preferences_store_inline_api_keys() {
        let db = test_db();
        let secret = "stored-with-provider";
        let providers = serde_json::json!([{
            "id": "openai",
            "apiKey": secret,
        }])
        .to_string();
        db.save_preferences(&[("ai.providers".to_string(), providers.clone())])
            .unwrap();

        assert!(db
            .load_preferences()
            .unwrap()
            .iter()
            .any(|(key, value)| key == "ai.providers" && value == &providers));
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
            "com.termbridge.profile-password",
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
        assert_eq!(summaries[0].service, "com.termbridge.profile-password");
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
}
