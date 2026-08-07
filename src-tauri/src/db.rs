use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Arc, Mutex};

const CURRENT_SCHEMA_VERSION: i32 = 1;

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
    value TEXT,
    service TEXT NOT NULL DEFAULT 'com.termbridge.key'
);
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

        Ok(())
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
                 keychain_key_id, jump_host_config, created_at, updated_at \
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
                            "key" | "keychainKey" | "keyPath" => crate::models::ProfileAuthMethod::Key,
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
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
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
                 keychain_key_id, jump_host_config, created_at, updated_at \
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
                                "key" | "keychainKey" | "keyPath" => {
                                    crate::models::ProfileAuthMethod::Key
                                }
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
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
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
             keychain_key_id, jump_host_config, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                profile.id,
                profile.name,
                profile.host,
                profile.port,
                profile.username,
                profile.auth_method.as_str(),
                profile.keychain_key_id,
                profile.jump_host_config,
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
                 created_at=?9, updated_at=?10 WHERE id=?1",
                params![
                    id,
                    profile.name,
                    profile.host,
                    profile.port,
                    profile.username,
                    profile.auth_method.as_str(),
                    profile.keychain_key_id,
                    profile.jump_host_config,
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
            .prepare("SELECT id, label, COALESCE(key_type, 'unknown'), kind FROM key_credentials ORDER BY label")
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

    pub(crate) fn key_credential_exists(&self, id: &str) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM key_credentials WHERE id=?1)",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| format!("failed to check key credential existence: {e}"))
    }

    pub(crate) fn store_key_credential_value(
        &self,
        id: &str,
        value: &str,
        service: &str,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "INSERT INTO key_credentials (id, label, value, service, updated_at) VALUES (?1, ?1, ?2, ?3, ?4) \
             ON CONFLICT(id) DO UPDATE SET value=excluded.value, service=excluded.service, updated_at=excluded.updated_at",
            params![id, value, service, current_timestamp_ms()],
        )
        .map_err(|e| format!("failed to store key credential value: {e}"))?;
        Ok(())
    }

    pub(crate) fn retrieve_key_credential_value(
        &self,
        id: &str,
    ) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.query_row(
            "SELECT value FROM key_credentials WHERE id=?1",
            params![id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|value| value.flatten())
        .map_err(|e| format!("failed to retrieve key credential value: {e}"))
    }

    /// Clears the fallback secret value for a key credential without removing
    /// its metadata row. Used to purge a stale database-fallback copy after a
    /// successful native keychain write while keeping the key listed.
    pub(crate) fn clear_key_credential_value(&self, id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "UPDATE key_credentials SET value = NULL WHERE id=?1",
            params![id],
        )
        .map_err(|e| format!("failed to clear key credential value: {e}"))?;
        Ok(())
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
            .prepare("SELECT id FROM profiles WHERE keychain_key_id = ?1")
            .map_err(|e| format!("failed to prepare list_profiles_referencing_key: {e}"))?;
        let rows = stmt
            .query_map(params![key_id], |row| row.get(0))
            .map_err(|e| format!("failed to query profiles referencing key: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect profiles referencing key: {e}"))
    }

    pub(crate) fn clear_keychain_key_id_references(
        &self,
        key_id: &str,
    ) -> Result<usize, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let updated = conn
            .execute(
                "UPDATE profiles SET keychain_key_id = NULL, updated_at = ?2 WHERE keychain_key_id = ?1",
                params![key_id, current_timestamp_ms()],
            )
            .map_err(|e| format!("failed to clear keychain key references: {e}"))?;
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
        conn.execute("SELECT 1 FROM key_credentials LIMIT 0", [])
            .unwrap();
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
            format!("database schema version 99 is newer than this build ({CURRENT_SCHEMA_VERSION})")
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
            created_at: 1000,
            updated_at: 2000,
        };
        db.insert_profile(&profile).unwrap();

        let list = db.list_profiles().unwrap();
        assert!(list[0].jump_host_config.is_some());
        let config = list[0].jump_host_config.as_deref().unwrap();
        assert!(config.contains("jump.example.com"));
    }

    #[test]
    fn terminal_workspace_roundtrip_and_clear() {
        let db = test_db();
        assert_eq!(db.load_terminal_workspace().unwrap(), None);

        let sessions = r#"[{"profileId":"p1","title":"Server"}]"#;
        db.save_terminal_workspace(sessions).unwrap();
        assert_eq!(
            db.load_terminal_workspace().unwrap().as_deref(),
            Some(sessions)
        );

        db.save_terminal_workspace("[]").unwrap();
        assert_eq!(db.load_terminal_workspace().unwrap().as_deref(), Some("[]"));

        db.clear_terminal_workspace().unwrap();
        assert_eq!(db.load_terminal_workspace().unwrap(), None);
    }

    #[test]
    fn key_credential_value_storage_roundtrip() {
        let db = test_db();
        db.upsert_key_credential("key-1", "Test Key", "rsa", "keyFile", "com.termbridge.key", None, None, 1000)
            .unwrap();
        db.store_key_credential_value("key-1", "private-key-data", "com.termbridge.key")
            .unwrap();

        let value = db.retrieve_key_credential_value("key-1").unwrap();
        assert_eq!(value.as_deref(), Some("private-key-data"));

        let summaries = db.list_key_credentials().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "key-1");
        assert_eq!(summaries[0].key_type, "rsa");
        assert_eq!(summaries[0].kind, crate::models::KeyCredentialKind::KeyFile);

        db.delete_key_credential("key-1").unwrap();
        assert!(db.retrieve_key_credential_value("key-1").unwrap().is_none());
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
        db.store_key_credential_value("profile-1", "secret-password", "com.termbridge.profile-password")
            .unwrap();

        let summaries = db.list_key_credentials().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "profile-1");
        assert_eq!(summaries[0].label, "Server");
        assert_eq!(summaries[0].key_type, "profile");
        assert_eq!(summaries[0].kind, crate::models::KeyCredentialKind::Password);
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
            created_at: 1,
            updated_at: 1,
        };
        db.insert_profile(&profile).unwrap();

        let affected = db.clear_keychain_key_id_references("key-1").unwrap();
        assert_eq!(affected, 1);

        let loaded = db.list_profiles().unwrap().into_iter().find(|p| p.id == "profile-1").unwrap();
        assert_eq!(loaded.keychain_key_id, None);
        assert!(loaded.updated_at > profile.updated_at);

        profile.keychain_key_id = None;
        db.update_profile("profile-1", &profile).unwrap();
        assert_eq!(db.clear_keychain_key_id_references("key-1").unwrap(), 0);
    }

    #[test]
    fn store_key_credential_value_insert_uses_real_timestamp() {
        let db = test_db();
        db.store_key_credential_value("key-1", "private-key-data", "com.termbridge.key")
            .unwrap();

        let conn = db.conn.lock().unwrap();
        let updated_at: i64 = conn
            .query_row(
                "SELECT updated_at FROM key_credentials WHERE id='key-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(updated_at > 0);
    }

    #[test]
    fn store_key_credential_value_conflict_updates_timestamp_and_keeps_metadata() {
        let db = test_db();
        db.upsert_key_credential(
            "key-1",
            "My Key",
            "rsa",
            "keyFile",
            "com.termbridge.key",
            None,
            None,
            1000,
        )
        .unwrap();
        db.store_key_credential_value("key-1", "new-value", "com.termbridge.key")
            .unwrap();

        let conn = db.conn.lock().unwrap();
        let (label, updated_at): (String, i64) = conn
            .query_row(
                "SELECT label, updated_at FROM key_credentials WHERE id='key-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        // Conflict branch must refresh updated_at without clobbering metadata.
        assert_eq!(label, "My Key");
        assert!(updated_at > 1000);
    }

    #[test]
    fn clear_key_credential_value_preserves_metadata_row() {
        let db = test_db();
        db.upsert_key_credential("key-1", "My Key", "rsa", "keyFile", "com.termbridge.key", None, None, 1000)
            .unwrap();
        db.store_key_credential_value("key-1", "stale-fallback-secret", "com.termbridge.key")
            .unwrap();

        db.clear_key_credential_value("key-1").unwrap();

        // The fallback secret is gone…
        assert!(db.retrieve_key_credential_value("key-1").unwrap().is_none());
        // …but the metadata row survives so the key still shows in listings.
        let summaries = db.list_key_credentials().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "key-1");
        assert_eq!(summaries[0].label, "My Key");
        assert_eq!(summaries[0].key_type, "rsa");
        assert_eq!(summaries[0].kind, crate::models::KeyCredentialKind::KeyFile);
    }

    #[test]
    fn key_credential_exists_reports_presence() {
        let db = test_db();
        assert!(!db.key_credential_exists("key-1").unwrap());
        db.upsert_key_credential(
            "key-1",
            "My Key",
            "rsa",
            "keyFile",
            "com.termbridge.key",
            None,
            None,
            1000,
        )
        .unwrap();
        assert!(db.key_credential_exists("key-1").unwrap());
    }
}
