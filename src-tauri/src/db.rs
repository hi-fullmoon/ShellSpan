use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Arc, Mutex};

const CURRENT_SCHEMA_VERSION: i32 = 1;
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
    if object.get("version").and_then(serde_json::Value::as_u64) != Some(TERMINAL_WORKSPACE_VERSION)
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

const CURRENT_SCHEMA: &str = "
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
    organization_json TEXT,
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

CREATE TABLE IF NOT EXISTS sftp_workspace (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    workspace_json TEXT NOT NULL,
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
    service TEXT NOT NULL DEFAULT 'com.shellspan.key'
);
INSERT INTO schema_version (version) VALUES (1);
";

#[derive(Clone)]
pub(crate) struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    /// Dedicated LLM document commit with compare-and-swap revision control.
    pub(crate) fn commit_llm_routes(
        &self,
        expected: Option<u64>,
        document: &str,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|_| "database lock unavailable")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let current: Option<String> = tx
            .query_row(
                "SELECT value FROM preferences WHERE key='llm.routes.v1'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let revision = current
            .as_ref()
            .map(|raw| serde_json::from_str::<serde_json::Value>(raw).map_err(|e| e.to_string()))
            .transpose()?
            .and_then(|v| v["revision"].as_u64());
        if revision != expected {
            return Err("REVISION_CONFLICT".into());
        }
        tx.execute("INSERT INTO preferences (key,value) VALUES ('llm.routes.v1',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [document]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub(crate) fn open(db_path: &Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create database directory: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
                    .map_err(|e| format!("failed to secure database directory: {e}"))?;
            }
        }
        let conn =
            Connection::open(db_path).map_err(|e| format!("failed to open database: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(db_path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("failed to secure database file: {e}"))?;
        }
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("failed to set pragmas: {e}"))?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.initialize_or_validate_schema()?;
        Ok(db)
    }

    fn initialize_or_validate_schema(&self) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;

        let has_schema_table: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version')",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("failed to inspect database schema: {e}"))?;
        if !has_schema_table {
            let user_table_count: i32 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| format!("failed to inspect database tables: {e}"))?;
            if user_table_count != 0 {
                return Err("unsupported unversioned database schema".into());
            }
            conn.execute_batch(CURRENT_SCHEMA)
                .map_err(|e| format!("failed to initialize database schema: {e}"))?;
            return Ok(());
        }
        let current: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("failed to read database schema version: {e}"))?;
        if current != CURRENT_SCHEMA_VERSION {
            return Err(format!(
                "unsupported database schema version {current}; expected {CURRENT_SCHEMA_VERSION}"
            ));
        }
        Ok(())
    }

    #[expect(
        dead_code,
        reason = "reserved database boundary for later durable Agent task storage"
    )]
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

    pub(crate) fn delete_preferences(&self, keys: &[String]) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        for key in keys {
            conn.execute("DELETE FROM preferences WHERE key=?1", [key])
                .map_err(|e| e.to_string())?;
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
    include!("tests/db.rs");
}
