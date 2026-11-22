//! Durable per-operation intentions. SQLite FULL transactions and a unique call
//! key fence survive process death. No source, plan or credentials are stored.
use super::state::CommandIdentity;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const SCHEMA_VERSION: i64 = 2;
const INITIALIZED_FILE: &str = "terminal-submissions.initialized";
const INITIALIZED_BYTES: &[u8] = b"shellspan.terminal-submissions.sqlite/2\n";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubmissionIntent {
    pub version: u8,
    pub identity: CommandIdentity,
    pub no_auto_replay: bool,
}

#[derive(Debug)]
struct CachedJournalConnection {
    connection: Connection,
    #[cfg(unix)]
    file_identity: (u64, u64),
}

#[derive(Debug, Clone)]
pub(crate) struct SubmissionJournal {
    configured_root: Arc<Mutex<Option<PathBuf>>>,
    initialization_gate: Arc<Mutex<()>>,
    // Keep this journal's independent connection lifetimes/transactions from
    // racing WAL shared-memory teardown on Windows. This is a journal-local
    // I/O gate, never the Broker/operation state lock.
    io_gate: Arc<Mutex<Option<CachedJournalConnection>>>,
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
            io_gate: Arc::new(Mutex::new(None)),
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
        match fs::symlink_metadata(app_root) {
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err(invalid());
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(io_error(error));
            }
            _ => {}
        }
        // Refuse competing journal namespaces instead of creating an empty
        // ledger that could permit replay. No foreign record is migrated.
        match fs::read_dir(app_root) {
            Ok(entries) => {
                for entry in entries {
                    let entry = entry.map_err(io_error)?;
                    if entry.file_name().to_str().is_some_and(|name| {
                        name.starts_with("terminal-submissions")
                            && name != "terminal-submissions"
                            && name != INITIALIZED_FILE
                    }) {
                        return Err("TERMINAL_SUBMISSION_JOURNAL_MIGRATION_REQUIRED".into());
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
        let initialized = read_initialization_marker(app_root)?;
        let directory = app_root.join("terminal-submissions");
        let new_namespace = match fs::symlink_metadata(&directory) {
            Ok(_) => false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => return Err(io_error(error)),
        };
        if new_namespace {
            if initialized {
                return Err(unavailable());
            }
            fs::create_dir_all(app_root).map_err(io_error)?;
            // Persist outside the ledger directory before creating it. A crash
            // or later loss must leave a refusal, not a fresh empty namespace.
            write_initialization_marker(app_root)?;
            fs::create_dir(&directory).map_err(io_error)?;
        }
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
            if !new_namespace
                && fs::metadata(&directory)
                    .map_err(io_error)?
                    .permissions()
                    .readonly()
            {
                return Err(unavailable());
            }
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
        let connection = connect(&path, new_namespace)?;
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(db_error)?;
        if new_namespace && version != 0
            || !new_namespace && version != 1 && version != SCHEMA_VERSION
        {
            return Err(invalid());
        }
        if !new_namespace && !initialized && version != 1 {
            return Err(unavailable());
        }
        if new_namespace {
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
            PRAGMA user_version=2; COMMIT;",
                )
                .map_err(db_error)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(io_error)?;
        }
        validate_schema(&connection)?;
        // Validate recovered rows before upgrading a recognized v1 database.
        // Never CREATE missing tables in an existing namespace.
        let recovered = {
            let mut statement = connection
                .prepare("SELECT call_key,agent_session_id,record_json FROM submissions WHERE settled=0 LIMIT 4097")
                .map_err(db_error)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(db_error)?;
            let mut recovered = HashSet::new();
            for row in rows {
                let (stored_key, agent, encoded) = row.map_err(db_error)?;
                let record = decode(&encoded)?;
                if recovered.len() >= 4096
                    || key(&record.identity) != stored_key
                    || record.identity.agent_session_id != agent
                {
                    return Err(invalid());
                }
                recovered.insert(stored_key);
            }
            recovered
        };
        if version == 1 {
            if !initialized {
                write_initialization_marker(app_root)?;
            }
            connection
                .pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(db_error)?;
        }
        #[cfg(unix)]
        for parent in [&directory, app_root] {
            fs::File::open(parent)
                .and_then(|file| file.sync_all())
                .map_err(io_error)?;
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
    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut cached = self.io_gate.lock().map_err(|_| unavailable())?;
        self.ensure_initialized()?;
        let path = self
            .root
            .lock()
            .map_err(|_| unavailable())?
            .clone()
            .ok_or_else(unavailable)?;
        let app_root = path.parent().and_then(Path::parent).ok_or_else(invalid)?;
        if !read_initialization_marker(app_root)? {
            *cached = None;
            return Err(unavailable());
        }
        let db_meta = match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => meta,
            _ => {
                *cached = None;
                return Err(unavailable());
            }
        };
        #[cfg(unix)]
        let current_identity = {
            use std::os::unix::fs::MetadataExt;
            (db_meta.dev(), db_meta.ino())
        };
        #[cfg(not(unix))]
        let _ = db_meta;
        #[cfg(unix)]
        if cached
            .as_ref()
            .is_some_and(|entry| entry.file_identity != current_identity)
        {
            *cached = None;
        }
        if cached.is_none() {
            let connection = connect(&path, false)?;
            if connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .map_err(db_error)?
                != SCHEMA_VERSION
            {
                return Err(invalid());
            }
            validate_schema(&connection)?;
            *cached = Some(CachedJournalConnection {
                connection,
                #[cfg(unix)]
                file_identity: current_identity,
            });
        }
        let result = operation(
            &cached
                .as_ref()
                .expect("initialized journal connection")
                .connection,
        );
        if let Err(ref error) = result {
            if error != "TERMINAL_SUBMISSION_ALREADY_RECORDED"
                && error != "TERMINAL_SUBMISSION_IDENTITY_MISMATCH"
            {
                *cached = None;
            }
        }
        result
    }
    pub fn ensure_new_operation(
        &self,
        agent: &str,
        task: &str,
        operation: &str,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let mut stmt = connection
                .prepare_cached("SELECT EXISTS(SELECT 1 FROM submissions WHERE call_key=?1)")
                .map_err(db_error)?;
            let exists: bool = stmt
                .query_row([key_for_call(agent, task, operation)], |row| row.get(0))
                .map_err(db_error)?;
            if exists {
                Err("TERMINAL_SUBMISSION_ALREADY_RECORDED".into())
            } else {
                Ok(())
            }
        })
    }
    pub fn record(&self, identity: &CommandIdentity) -> Result<(), String> {
        let record = SubmissionIntent {
            version: 1,
            identity: identity.clone(),
            no_auto_replay: true,
        };
        let encoded = serde_json::to_string(&record).map_err(|_| invalid())?;
        if encoded.len() > 4096 {
            return Err(invalid());
        }
        self.with_connection(|connection| {
            let mut stmt = connection
                .prepare_cached("INSERT INTO submissions(call_key,agent_session_id,record_json,settled) VALUES(?1,?2,?3,0)")
                .map_err(db_error)?;
            stmt.execute(params![key(identity), identity.agent_session_id, encoded])
                .map_err(|error| match error {
                    rusqlite::Error::SqliteFailure(code, _)
                        if code.code == rusqlite::ErrorCode::ConstraintViolation =>
                    {
                        "TERMINAL_SUBMISSION_ALREADY_RECORDED".into()
                    }
                    other => db_error(other),
                })?;
            Ok(())
        })
    }
    pub fn settle(&self, identity: &CommandIdentity) -> Result<(), String> {
        self.with_connection(|connection| {
            let call_key = key(identity);
            let encoded: Option<String> = {
                let mut stmt = connection
                    .prepare_cached("SELECT record_json FROM submissions WHERE call_key=?1")
                    .map_err(db_error)?;
                stmt.query_row([&call_key], |row| row.get(0))
                    .optional()
                    .map_err(db_error)?
            };
            let record = decode(&encoded.ok_or_else(invalid)?)?;
            if &record.identity != identity {
                return Err("TERMINAL_SUBMISSION_IDENTITY_MISMATCH".into());
            }
            let mut stmt = connection
                .prepare_cached("UPDATE submissions SET settled=1 WHERE call_key=?1")
                .map_err(db_error)?;
            stmt.execute([&call_key]).map_err(db_error)?;
            Ok(())
        })
    }
    #[cfg(test)]
    pub fn unresolved(&self) -> Result<Vec<SubmissionIntent>, String> {
        self.unresolved_for_agent(None)
    }
    pub fn unresolved_for_agent(
        &self,
        agent: Option<&str>,
    ) -> Result<Vec<SubmissionIntent>, String> {
        self.with_connection(|connection| {
            let sql = if agent.is_some() {
                "SELECT call_key,agent_session_id,record_json FROM submissions WHERE settled=0 AND agent_session_id=?1 ORDER BY call_key LIMIT 4097"
            } else {
                "SELECT call_key,agent_session_id,record_json FROM submissions WHERE settled=0 AND ?1 IS NULL ORDER BY call_key LIMIT 4097"
            };
            let mut statement = connection.prepare_cached(sql).map_err(db_error)?;
            let rows = statement
                .query_map([agent], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(db_error)?;
            let mut result = Vec::new();
            for row in rows {
                let (stored_key, stored_agent, encoded) = row.map_err(db_error)?;
                let record = decode(&encoded)?;
                if key(&record.identity) != stored_key
                    || record.identity.agent_session_id != stored_agent
                    || result.len() >= 4096
                {
                    return Err(invalid());
                }
                if agent.is_some_and(|agent| agent != record.identity.agent_session_id) {
                    return Err(invalid());
                }
                result.push(record);
            }
            Ok(result)
        })
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
fn connect(path: &Path, create: bool) -> Result<Connection, String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.file_type().is_file() {
            return Err(invalid());
        }
        if metadata.permissions().readonly() {
            return Err(unavailable());
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
    Ok(connection)
}

fn validate_schema(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(submissions)")
        .map_err(db_error)?;
    let columns = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let expected = [
        ("call_key", "TEXT", 1, None, 1),
        ("agent_session_id", "TEXT", 1, None, 0),
        ("record_json", "TEXT", 1, None, 0),
        ("settled", "INTEGER", 1, Some("0"), 0),
    ];
    if columns.len() != expected.len()
        || !columns.iter().zip(expected).all(|(actual, expected)| {
            actual.0 == expected.0
                && actual.1.eq_ignore_ascii_case(expected.1)
                && actual.2 == expected.2
                && actual.3.as_deref() == expected.3
                && actual.4 == expected.4
        })
    {
        return Err(invalid());
    }
    Ok(())
}

fn read_initialization_marker(app_root: &Path) -> Result<bool, String> {
    let path = app_root.join(INITIALIZED_FILE);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io_error(error)),
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err(invalid());
        }
        _ => {}
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() != INITIALIZED_BYTES.len() as u64
    {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0
            || metadata.uid() != fs::metadata(app_root).map_err(io_error)?.uid()
        {
            return Err(invalid());
        }
    }
    let mut bytes = Vec::new();
    file.take(INITIALIZED_BYTES.len() as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes != INITIALIZED_BYTES {
        return Err(invalid());
    }
    Ok(true)
}

fn write_initialization_marker(app_root: &Path) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(app_root.join(INITIALIZED_FILE))
        .map_err(io_error)?;
    file.write_all(INITIALIZED_BYTES).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    #[cfg(unix)]
    fs::File::open(app_root)
        .and_then(|directory| directory.sync_all())
        .map_err(io_error)?;
    Ok(())
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

#[cfg(test)]
#[path = "journal_storage_tests.rs"]
mod storage_tests;
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
