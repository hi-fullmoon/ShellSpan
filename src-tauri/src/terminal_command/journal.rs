//! Durable per-operation intentions. SQLite FULL transactions and a unique call
//! key fence survive process death. No source, plan or credentials are stored.
use super::state::CommandIdentity;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubmissionIntent {
    pub version: u8,
    pub identity: CommandIdentity,
    pub no_auto_replay: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct SubmissionJournal {
    configured_root: Arc<Mutex<Option<PathBuf>>>,
    initialization_gate: Arc<Mutex<()>>,
    // Keep this journal's independent connection lifetimes/transactions from
    // racing WAL shared-memory teardown on Windows. This is a journal-local
    // I/O gate, never the Broker/operation state lock.
    io_gate: Arc<Mutex<()>>,
    root: Arc<Mutex<Option<PathBuf>>>,
    startup_unsettled: Arc<Mutex<HashSet<String>>>,
    #[cfg(test)]
    temporary: Arc<Mutex<Option<tempfile::TempDir>>>,
}
impl Default for SubmissionJournal {
    fn default() -> Self {
        Self::unconfigured()
    }
}
impl SubmissionJournal {
    pub fn unconfigured() -> Self {
        Self {
            configured_root: Arc::new(Mutex::new(None)),
            initialization_gate: Arc::new(Mutex::new(())),
            io_gate: Arc::new(Mutex::new(())),
            root: Arc::new(Mutex::new(None)),
            startup_unsettled: Arc::new(Mutex::new(HashSet::new())),
            #[cfg(test)]
            temporary: Arc::new(Mutex::new(None)),
        }
    }
    pub fn configure(&self, app_root: &Path) -> Result<(), String> {
        // Runtime configuration can run from a Tauri command. Register the
        // trusted path only; SQLite/filesystem work belongs to the first native
        // tool worker or the recovery command's spawn_blocking task.
        if !app_root.is_absolute() {
            return Err(invalid());
        }
        let mut configured = self.configured_root.lock().map_err(|_| unavailable())?;
        if configured
            .as_ref()
            .is_some_and(|existing| existing != app_root)
        {
            return Err("TERMINAL_SUBMISSION_JOURNAL_ALREADY_CONFIGURED".into());
        }
        *configured = Some(app_root.to_path_buf());
        Ok(())
    }
    fn ensure_initialized(&self) -> Result<(), String> {
        if self.root.lock().map_err(|_| unavailable())?.is_some() {
            return Ok(());
        }
        let _gate = self.initialization_gate.lock().map_err(|_| unavailable())?;
        if self.root.lock().map_err(|_| unavailable())?.is_some() {
            return Ok(());
        }
        let configured = self
            .configured_root
            .lock()
            .map_err(|_| unavailable())?
            .clone()
            .ok_or_else(unavailable)?;
        self.initialize(&configured)
    }
    fn initialize(&self, app_root: &Path) -> Result<(), String> {
        // Refuse competing journal namespaces instead of creating an empty
        // ledger that could permit replay. No foreign record is migrated.
        match fs::read_dir(app_root) {
            Ok(entries) => {
                for entry in entries {
                    let entry = entry.map_err(io_error)?;
                    if entry.file_name().to_str().is_some_and(|name| {
                        name.starts_with("terminal-submissions-")
                    }) {
                        return Err("TERMINAL_SUBMISSION_JOURNAL_MIGRATION_REQUIRED".into());
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
        let directory = app_root.join("terminal-submissions");
        fs::create_dir_all(&directory).map_err(io_error)?;
        if !fs::symlink_metadata(&directory)
            .map_err(io_error)?
            .file_type()
            .is_dir()
        {
            return Err(invalid());
        }
        // Resolve trusted parent aliases (notably macOS /var -> /private/var)
        // before SQLite's NOFOLLOW protection checks the complete database path.
        let directory = fs::canonicalize(directory).map_err(io_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(io_error)?;
        }
        // No JSON journal was released. A pre-release prototype record must not
        // be silently ignored or converted into permission to replay.
        if fs::read_dir(&directory).map_err(io_error)?.any(|entry| {
            entry.is_ok_and(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".intent.json")
            })
        }) {
            return Err("TERMINAL_SUBMISSION_JOURNAL_MIGRATION_REQUIRED".into());
        }
        let path = directory.join("intentions.sqlite");
        {
            let root = self.root.lock().map_err(|_| unavailable())?;
            if let Some(existing) = root.as_ref() {
                return if existing == &path {
                    Ok(())
                } else {
                    Err("TERMINAL_SUBMISSION_JOURNAL_ALREADY_CONFIGURED".into())
                };
            }
        }
        let connection = open(&path, true)?;
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(db_error)?;
        if version != 0 && version != 1 {
            return Err(invalid());
        }
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS submissions (
              call_key TEXT PRIMARY KEY NOT NULL,
              agent_session_id TEXT NOT NULL,
              record_json TEXT NOT NULL,
              settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1))
            );
            CREATE INDEX IF NOT EXISTS unresolved_agent ON submissions(settled,agent_session_id);
            PRAGMA user_version=1; COMMIT;",
            )
            .map_err(db_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(io_error)?;
        }
        let mut root = self.root.lock().map_err(|_| unavailable())?;
        if let Some(existing) = root.as_ref() {
            return if existing == &path {
                Ok(())
            } else {
                Err("TERMINAL_SUBMISSION_JOURNAL_ALREADY_CONFIGURED".into())
            };
        }
        // Only intentions recovered at startup impose the cross-process gate.
        // In-process foreground/interactive input keeps its existing scoped
        // Broker checks; a live command is not an application-restart record.
        let mut statement = connection
            .prepare("SELECT call_key FROM submissions WHERE settled=0 LIMIT 4097")
            .map_err(db_error)?;
        let keys = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        let mut recovered = HashSet::new();
        for key in keys {
            if recovered.len() >= 4096 {
                return Err(invalid());
            }
            recovered.insert(key.map_err(db_error)?);
        }
        *self.startup_unsettled.lock().map_err(|_| unavailable())? = recovered;
        *root = Some(path);
        Ok(())
    }
    #[cfg(test)]
    pub fn temporary() -> Self {
        let result = Self::unconfigured();
        let directory = tempfile::tempdir().expect("journal tempdir");
        result
            .configure(directory.path())
            .expect("journal configuration");
        *result.temporary.lock().unwrap() = Some(directory);
        result
    }
    fn connection(&self) -> Result<Connection, String> {
        self.ensure_initialized()?;
        let path = self
            .root
            .lock()
            .map_err(|_| unavailable())?
            .clone()
            .ok_or_else(unavailable)?;
        open(&path, false)
    }
    pub fn ensure_new_operation(
        &self,
        agent: &str,
        task: &str,
        operation: &str,
    ) -> Result<(), String> {
        let _io = self.io_gate.lock().map_err(|_| unavailable())?;
        let connection = self.connection()?;
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM submissions WHERE call_key=?1)",
                [key_for_call(agent, task, operation)],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if exists {
            Err("TERMINAL_SUBMISSION_ALREADY_RECORDED".into())
        } else {
            Ok(())
        }
    }
    pub fn record(&self, identity: &CommandIdentity) -> Result<(), String> {
        let _io = self.io_gate.lock().map_err(|_| unavailable())?;
        let connection = self.connection()?;
        let record = SubmissionIntent {
            version: 1,
            identity: identity.clone(),
            no_auto_replay: true,
        };
        let encoded = serde_json::to_string(&record).map_err(|_| invalid())?;
        if encoded.len() > 4096 {
            return Err(invalid());
        }
        connection.execute("INSERT INTO submissions(call_key,agent_session_id,record_json,settled) VALUES(?1,?2,?3,0)",
            params![key(identity),identity.agent_session_id,encoded]).map_err(|error|match error {
                rusqlite::Error::SqliteFailure(code,_) if code.code==rusqlite::ErrorCode::ConstraintViolation=>"TERMINAL_SUBMISSION_ALREADY_RECORDED".into(),
                other=>db_error(other),
            })?;
        Ok(())
    }
    pub fn settle(&self, identity: &CommandIdentity) -> Result<(), String> {
        let _io = self.io_gate.lock().map_err(|_| unavailable())?;
        let connection = self.connection()?;
        let encoded: Option<String> = connection
            .query_row(
                "SELECT record_json FROM submissions WHERE call_key=?1",
                [key(identity)],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let record = decode(&encoded.ok_or_else(invalid)?)?;
        if &record.identity != identity {
            return Err("TERMINAL_SUBMISSION_IDENTITY_MISMATCH".into());
        }
        connection
            .execute(
                "UPDATE submissions SET settled=1 WHERE call_key=?1",
                [key(identity)],
            )
            .map_err(db_error)?;
        Ok(())
    }
    #[cfg(test)]
    pub fn unresolved(&self) -> Result<Vec<SubmissionIntent>, String> {
        self.unresolved_for_agent(None)
    }
    pub fn unresolved_for_agent(
        &self,
        agent: Option<&str>,
    ) -> Result<Vec<SubmissionIntent>, String> {
        let _io = self.io_gate.lock().map_err(|_| unavailable())?;
        let connection = self.connection()?;
        let sql = if agent.is_some() {
            "SELECT call_key,record_json FROM submissions WHERE settled=0 AND agent_session_id=?1 ORDER BY call_key LIMIT 4097"
        } else {
            "SELECT call_key,record_json FROM submissions WHERE settled=0 AND ?1 IS NULL ORDER BY call_key LIMIT 4097"
        };
        let mut statement = connection.prepare(sql).map_err(db_error)?;
        let rows = statement
            .query_map([agent], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?;
        let mut result = Vec::new();
        for row in rows {
            let (stored_key, encoded) = row.map_err(db_error)?;
            let record = decode(&encoded)?;
            if key(&record.identity) != stored_key || result.len() >= 4096 {
                return Err(invalid());
            }
            if agent.is_some_and(|agent| agent != record.identity.agent_session_id) {
                return Err(invalid());
            }
            result.push(record);
        }
        Ok(result)
    }
    pub fn recovered_for_agent(&self, agent: &str) -> Result<Vec<SubmissionIntent>, String> {
        let unresolved = self.unresolved_for_agent(Some(agent))?;
        let recovered = self.startup_unsettled.lock().map_err(|_| unavailable())?;
        Ok(unresolved
            .into_iter()
            .filter(|record| recovered.contains(&key(&record.identity)))
            .collect())
    }
}
fn open(path: &Path, create: bool) -> Result<Connection, String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.file_type().is_file() {
            return Err(invalid());
        }
    }
    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    if create {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    let connection = Connection::open_with_flags(path, flags).map_err(db_error)?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(db_error)?;
    connection
        .execute_batch("PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;")
        .map_err(db_error)?;
    if !create
        && connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .map_err(db_error)?
            != 1
    {
        return Err(invalid());
    }
    Ok(connection)
}
fn decode(encoded: &str) -> Result<SubmissionIntent, String> {
    if encoded.len() > 4096 {
        return Err(invalid());
    }
    let value: SubmissionIntent = serde_json::from_str(encoded).map_err(|_| invalid())?;
    if value.version != 1 || !value.no_auto_replay {
        return Err(invalid());
    }
    value.identity.validate().map_err(|_| invalid())?;
    Ok(value)
}
fn key(identity: &CommandIdentity) -> String {
    key_for_call(
        &identity.agent_session_id,
        &identity.task_id,
        &identity.operation_id,
    )
}
fn key_for_call(agent: &str, task: &str, operation: &str) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(&(agent, task, operation)).expect("identity tuple"),
    ))
}
fn unavailable() -> String {
    "TERMINAL_SUBMISSION_JOURNAL_UNAVAILABLE".into()
}
fn invalid() -> String {
    "TERMINAL_SUBMISSION_JOURNAL_INVALID".into()
}
fn io_error(_: std::io::Error) -> String {
    unavailable()
}
fn db_error(error: rusqlite::Error) -> String {
    if let rusqlite::Error::SqliteFailure(code, _) = error {
        format!("{}: sqlite={}", unavailable(), code.extended_code)
    } else {
        format!("{}: statement failed", unavailable())
    }
}
