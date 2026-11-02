//! Session-owned execution files. Metadata lives outside the writable file root.
//! Pending approval, executing and uncertain uses are persisted before dispatch.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{AgentSessionTarget, AgentToolResultStatus, NativeToolResult};

#[path = "scratch_remote.rs"]
mod remote;

#[path = "scratch_storage.rs"]
mod storage;
use storage::{inspect_directory, private_directory, read_json, write_json, write_json_staged};

const SUCCESS_TTL_MS: u64 = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS: u64 = 7 * SUCCESS_TTL_MS;
const SESSION_BYTES: u64 = 64 * 1024 * 1024;
const LOCAL_BYTES: u64 = 512 * 1024 * 1024;
const REMOTE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
const MAX_TREE_ENTRIES: usize = 8192;
const LOCAL_DIRECTORY_KEY_LEN: usize = 16;

pub(super) fn is_file_tool(name: &str) -> bool {
    matches!(
        name,
        "read_file" | "list_directory" | "search_text" | "write_file" | "edit_file" | "apply_patch"
    )
}

pub(super) fn take_scope(name: &str, arguments: &mut Value) -> Result<bool, String> {
    let Some(value) = arguments.get("fileScope") else {
        return Ok(false);
    };
    if !is_file_tool(name) {
        return Err("fileScope is only available on structured file tools".into());
    }
    let scratch = match value.as_str() {
        Some("workspace") => false,
        Some("scratch") => true,
        _ => return Err("fileScope must be workspace or scratch".into()),
    };
    arguments
        .as_object_mut()
        .ok_or("invalid file arguments")?
        .remove("fileScope");
    Ok(scratch)
}

pub(super) fn key(session: &str, target: &AgentSessionTarget) -> Result<String, String> {
    let bytes = serde_json::to_vec(&(session, target)).map_err(|e| e.to_string())?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn local_workspace_path(temporary_root: &Path, key: &str) -> PathBuf {
    // Keys are validated SHA-256 hex digests. Ownership keeps the full digest.
    temporary_root.join(&key[..LOCAL_DIRECTORY_KEY_LEN])
}

/// A narrow storage-policy exception for a runtime-owned root, never the data
/// directory or another session's files. The on-disk record is outside that root.
pub(super) fn owns_target(
    data_root: &Path,
    session: &str,
    target: &super::AgentToolTargetNative,
) -> Result<bool, String> {
    let Some(key) = target.target_id().strip_prefix("scratch-") else {
        return Ok(false);
    };
    if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(false);
    }
    let data_root = fs::canonicalize(data_root).map_err(|e| e.to_string())?;
    let root = data_root.join("agent-runtime").join("scratch");
    inspect_directory(&root.join("records"))?;
    let record: Record = read_json(&root.join("records").join(format!("{key}.json")))?;
    if record.session_id != session
        || record.key != key
        || self::key(session, &record.target)? != key
    {
        return Ok(false);
    }
    let mut expected = super::native_adapter::target_native(&record.target)?;
    match &mut expected {
        super::AgentToolTargetNative::Local { target_id, cwd, .. } => {
            *target_id = target.target_id().into();
            let files = local_workspace_path(&data_root.join("tmp"), key);
            inspect_directory(&files)?;
            *cwd = Some(crate::portable_local_path(&files));
        }
        super::AgentToolTargetNative::Remote {
            target_id,
            root_path,
            ..
        } => {
            *target_id = target.target_id().into();
            *root_path = record.remote_root;
        }
        _ => return Ok(false),
    }
    Ok(&expected == target)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u8,
    key: String,
    session_id: String,
    target: AgentSessionTarget,
    remote_root: Option<String>,
    touched_at: u64,
    failed: bool,
    uses: BTreeMap<String, Usage>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
enum Usage {
    Pending { expires_at: u64 },
    Executing,
    Process { handle: String, task_id: String },
    Uncertain,
}

struct State {
    root: PathBuf,
    temporary_root: PathBuf,
    instance: String,
    records: BTreeMap<String, Record>,
    // A live approval cannot be evicted solely because wall time changed.
    live: BTreeMap<String, usize>,
}

#[derive(Clone)]
pub(crate) struct ScratchStore {
    state: Arc<Mutex<State>>,
}

pub(super) struct ScratchServices<'a> {
    pub database: &'a crate::db::Database,
    pub credentials: &'a crate::keychain::CredentialManager,
    pub known_hosts: &'a Path,
    pub engine: Option<&'a super::NativeToolEngine>,
}

pub(super) struct ScratchLease {
    store: ScratchStore,
    key: String,
    id: String,
    dispatched: bool,
    settled: bool,
    task_id: String,
    pub root: String,
}

impl ScratchStore {
    pub(super) fn open(data_root: &Path) -> Result<Self, String> {
        let data_root =
            fs::canonicalize(data_root).map_err(|e| format!("scratch data root: {e}"))?;
        let root = data_root.join("agent-runtime").join("scratch");
        let temporary_root = data_root.join("tmp");
        private_directory(&data_root.join("agent-runtime"))?;
        private_directory(&root)?;
        private_directory(&root.join("records"))?;
        storage::temporary_directory(&temporary_root)?;
        let instance_path = root.join("instance.json");
        let instance: String = if instance_path.exists() {
            read_json(&instance_path)?
        } else {
            let value = Uuid::new_v4().simple().to_string();
            write_json(&instance_path, &value)?;
            value
        };
        if instance.len() != 32 || !instance.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid scratch installation identity".into());
        }
        let mut records = BTreeMap::new();
        let mut local_directories = BTreeSet::new();
        for entry in fs::read_dir(root.join("records")).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            let record: Record = read_json(&path)?;
            if record.version != 1
                || key(&record.session_id, &record.target)? != record.key
                || path.file_name().and_then(|n| n.to_str())
                    != Some(&format!("{}.json", record.key))
            {
                return Err("invalid scratch ownership record".into());
            }
            if record.target.kind == "local"
                && !local_directories.insert(local_workspace_path(&temporary_root, &record.key))
            {
                return Err("scratch directory ownership collision".into());
            }
            records.insert(record.key.clone(), record);
            if records.len() > MAX_ENTRIES {
                return Err("scratch workspace count exceeded".into());
            }
        }
        Ok(Self {
            state: Arc::new(Mutex::new(State {
                root,
                temporary_root,
                instance,
                records,
                live: BTreeMap::new(),
            })),
        })
    }

    pub(super) fn acquire(
        &self,
        session: &str,
        task: &str,
        target: &AgentSessionTarget,
        expires_at: u64,
        provision_remote: bool,
        reservation: Option<u64>,
        services: &ScratchServices<'_>,
    ) -> Result<ScratchLease, String> {
        if reservation.is_some() {
            // Failed collection retains files; quota admission still checks usage.
            let _ = self.cleanup_matching(now(), services, Some(target));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "scratch registry unavailable")?;
        let key = key(session, target)?;
        if !matches!(target.kind.as_str(), "local" | "remote") {
            return Err("scratch requires a host target".into());
        }
        if target.kind == "remote" && target.profile_id.is_none() {
            return Err("remote scratch requires a credential-backed profile".into());
        }
        if target.kind == "local" {
            storage::temporary_directory(&state.temporary_root)?;
        }
        if !state.records.contains_key(&key) {
            if state.records.len() >= MAX_ENTRIES {
                return Err("scratch workspace count exceeded".into());
            }
            if target.kind == "local" {
                let directory = local_workspace_path(&state.temporary_root, &key);
                if state.records.values().any(|record| {
                    record.target.kind == "local"
                        && local_workspace_path(&state.temporary_root, &record.key) == directory
                }) {
                    return Err(
                        "AGENT_SCRATCH_DIRECTORY_OCCUPIED: temporary directory is already reserved"
                            .into(),
                    );
                }
                match fs::symlink_metadata(&directory) {
                    Ok(_) => return Err("AGENT_SCRATCH_DIRECTORY_OCCUPIED: temporary directory has no matching ownership record".into()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
            let record = Record {
                version: 1,
                key: key.clone(),
                session_id: session.into(),
                target: target.clone(),
                remote_root: None,
                touched_at: now(),
                failed: false,
                uses: BTreeMap::new(),
            };
            persist(&state, &record)?;
            state.records.insert(key.clone(), record);
        }
        // Quotas are admission limits, not an OS-enforced filesystem boundary.
        if let Some(reservation) = reservation {
            let mut session_bytes = 0_u64;
            let mut total_bytes = 0_u64;
            for record in state.records.values() {
                if same_storage_group(target, &record.target) {
                    let bytes = workspace_bytes(&state, record, services)?;
                    total_bytes = total_bytes.saturating_add(bytes);
                    if record.session_id == session {
                        session_bytes = session_bytes.saturating_add(bytes)
                    }
                }
            }
            let limit = if target.kind == "local" {
                LOCAL_BYTES
            } else {
                REMOTE_BYTES
            };
            if session_bytes.saturating_add(reservation) > SESSION_BYTES
                || total_bytes.saturating_add(reservation) > limit
            {
                return Err("AGENT_SCRATCH_QUOTA_EXCEEDED: temporary files exceed the session or host limit; active and uncertain files were retained".into());
            }
        }
        let root = if target.kind == "local" {
            let directory = local_workspace_path(&state.temporary_root, &key);
            private_directory(&directory)?;
            crate::portable_local_path(&directory)
        } else if provision_remote {
            let record = &state.records[&key];
            let root = remote::provision(&state.instance, &key, record, services)?;
            let mut record = record.clone();
            record.remote_root = Some(root.clone());
            persist(&state, &record)?;
            state.records.insert(key.clone(), record);
            root
        } else {
            state.records[&key].remote_root.clone().unwrap_or_default()
        };
        let id = Uuid::new_v4().simple().to_string();
        let mut record = state.records[&key].clone();
        record.touched_at = now();
        record
            .uses
            .insert(id.clone(), Usage::Pending { expires_at });
        persist(&state, &record)?;
        state.records.insert(key.clone(), record);
        *state.live.entry(key.clone()).or_default() += 1;
        Ok(ScratchLease {
            store: self.clone(),
            key,
            id,
            dispatched: false,
            settled: false,
            task_id: task.into(),
            root,
        })
    }

    pub(super) fn cleanup(&self, services: &ScratchServices<'_>) -> Result<(), String> {
        self.cleanup_at(now(), services)
    }

    pub(super) fn cleanup_at(
        &self,
        time: u64,
        services: &ScratchServices<'_>,
    ) -> Result<(), String> {
        self.cleanup_matching(time, services, None)
    }

    fn cleanup_matching(
        &self,
        time: u64,
        services: &ScratchServices<'_>,
        group: Option<&AgentSessionTarget>,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "scratch registry unavailable")?;
        let keys: Vec<_> = state.records.keys().cloned().collect();
        let mut failure = None;
        for key in keys {
            if state.live.get(&key).copied().unwrap_or(0) > 0 {
                continue;
            }
            let mut record = state.records[&key].clone();
            if group.is_some_and(|target| !same_storage_group(target, &record.target)) {
                continue;
            }
            let mut settled_process = false;
            record.uses.retain(|_, usage| {
                if let (Some(engine), Usage::Process { handle, task_id }) = (services.engine, usage)
                {
                    if let Some(failed) = engine.scratch_process_outcome(
                        handle,
                        &record.session_id,
                        task_id,
                        &record.target,
                    ) {
                        record.failed |= failed;
                        settled_process = true;
                        return false;
                    }
                }
                true
            });
            if settled_process {
                record.touched_at = now();
                persist(&state, &record)?;
                state.records.insert(key.clone(), record.clone());
            }
            record.uses.retain(
                |_, usage| !matches!(usage, Usage::Pending { expires_at } if *expires_at <= time),
            );
            if !record.uses.is_empty() {
                continue;
            }
            let ttl = if record.failed {
                FAILURE_TTL_MS
            } else {
                SUCCESS_TTL_MS
            };
            if time.saturating_sub(record.touched_at) < ttl {
                continue;
            }
            let result = if record.target.kind == "local" {
                let path = local_workspace_path(&state.temporary_root, &key);
                match fs::symlink_metadata(&path) {
                    Ok(_) => local_tree_bytes(&path).and_then(|_| trash_workspace(&path)),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(e.to_string()),
                }
            } else {
                remote::cleanup(&state.instance, &record, services)
            };
            if let Err(error) = result {
                failure.get_or_insert(error);
                continue;
            }
            // Ownership metadata is application state, not user data.
            let record_path = state.root.join("records").join(format!("{key}.json"));
            if let Err(error) = trash_workspace(&record_path) {
                failure.get_or_insert(error);
                continue;
            }
            state.records.remove(&key);
        }
        failure.map_or(Ok(()), Err)
    }

    pub(super) fn release_process_handles(&self, handles: &[String]) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "scratch registry unavailable")?;
        let keys: Vec<_> = state.records.keys().cloned().collect();
        for key in keys {
            let mut record = state.records[&key].clone();
            let before = record.uses.len();
            record.uses.retain(|_, usage| !matches!(usage, Usage::Process { handle, .. } if handles.contains(handle)));
            if before != record.uses.len() {
                record.failed = true;
                record.touched_at = now();
                persist(&state, &record)?;
                state.records.insert(key, record);
            }
        }
        Ok(())
    }

    pub(super) fn start_maintenance(
        &self,
        database: crate::db::Database,
        credentials: crate::keychain::CredentialManager,
        known_hosts: PathBuf,
        engine: &Arc<super::NativeToolEngine>,
    ) -> Result<(), String> {
        let weak = Arc::downgrade(&self.state);
        let engine = Arc::downgrade(engine);
        std::thread::Builder::new()
            .name("agent-scratch-cleanup".into())
            .spawn(move || loop {
                let Some(state) = weak.upgrade() else { break };
                let Some(engine) = engine.upgrade() else {
                    break;
                };
                let store = Self { state };
                if let Err(error) = store.cleanup(&ScratchServices {
                    database: &database,
                    credentials: &credentials,
                    known_hosts: &known_hosts,
                    engine: Some(&engine),
                }) {
                    log::warn!(
                        "Agent scratch cleanup deferred: {}",
                        crate::redaction::redact_sensitive_text(&error)
                    );
                }
                drop(store);
                drop(engine);
                std::thread::sleep(std::time::Duration::from_secs(3600));
            })
            .map(|_| ())
            .map_err(|error| format!("failed to start scratch cleanup: {error}"))
    }
}

impl ScratchLease {
    pub(super) fn dispatch(&mut self) -> Result<(), String> {
        self.update(Some(Usage::Executing), false)?;
        self.dispatched = true;
        Ok(())
    }

    pub(super) fn finish(
        &mut self,
        tool: &str,
        arguments: &Value,
        result: &NativeToolResult,
    ) -> Result<(), String> {
        let execution = tool == "run_terminal_command";
        let process_tool = matches!(tool, "wait_process" | "kill_process");
        let data = result.data.as_ref();
        let state = data
            .and_then(|d| d.pointer("/job/state").or_else(|| d.get("state")))
            .and_then(Value::as_str)
            .map(str::to_ascii_lowercase);
        let state = state.as_deref();
        let handle = data
            .and_then(|d| d.get("processHandle"))
            .and_then(Value::as_str);
        let terminal = matches!(
            state,
            Some("exited" | "completed" | "cancelled" | "timedout" | "rejected")
        );
        let uncertain = result.status == AgentToolResultStatus::Uncertain
            || (terminal
                && data
                    .and_then(|d| d.get("terminationConfirmed"))
                    .and_then(Value::as_bool)
                    == Some(false));
        let usage = if uncertain {
            Some(Usage::Uncertain)
        } else if execution
            && matches!(
                state,
                Some("running" | "submitted" | "cancelrequested" | "uncertain")
            )
        {
            Some(
                handle
                    .map(|h| Usage::Process {
                        handle: h.into(),
                        task_id: self.task_id.clone(),
                    })
                    .unwrap_or(Usage::Uncertain),
            )
        } else if execution && result.status != AgentToolResultStatus::Rejected && !terminal {
            Some(Usage::Uncertain)
        } else {
            None
        };
        if process_tool && terminal && !uncertain {
            if let Some(handle) = arguments.get("processHandle").and_then(Value::as_str) {
                let mut state = self
                    .store
                    .state
                    .lock()
                    .map_err(|_| "scratch registry unavailable")?;
                let mut record = state.records[&self.key].clone();
                record.uses.retain(|_, usage| !matches!(usage, Usage::Process { handle: owner, .. } if owner == handle));
                persist(&state, &record)?;
                state.records.insert(self.key.clone(), record);
            }
        }
        let failed = result.status != AgentToolResultStatus::Completed
            || data
                .and_then(|d| d.get("exitCode"))
                .and_then(Value::as_i64)
                .is_some_and(|code| code != 0)
            || matches!(state, Some("cancelled" | "timedout" | "failed"));
        self.update(usage, failed)?;
        self.settled = true;
        Ok(())
    }

    fn update(&self, usage: Option<Usage>, failed: bool) -> Result<(), String> {
        let mut state = self
            .store
            .state
            .lock()
            .map_err(|_| "scratch registry unavailable")?;
        let mut record = state
            .records
            .get(&self.key)
            .ok_or("scratch workspace was collected")?
            .clone();
        record.touched_at = now();
        record.failed |= failed;
        if let Some(usage) = usage {
            record.uses.insert(self.id.clone(), usage);
        } else {
            record.uses.remove(&self.id);
        }
        persist(&state, &record)?;
        state.records.insert(self.key.clone(), record);
        Ok(())
    }
}

impl Drop for ScratchLease {
    fn drop(&mut self) {
        if !self.settled {
            let usage = self.dispatched.then_some(Usage::Uncertain);
            if let Err(error) = self.update(usage, self.dispatched) {
                log::warn!("Failed to settle Agent scratch lease: {error}");
            }
        }
        if let Ok(mut state) = self.store.state.lock() {
            if let Some(count) = state.live.get_mut(&self.key) {
                *count = count.saturating_sub(1);
            }
        }
    }
}

fn same_storage_group(a: &AgentSessionTarget, b: &AgentSessionTarget) -> bool {
    a.kind == b.kind
        && (a.kind == "local" || (a.host == b.host && a.port == b.port && a.username == b.username))
}

fn workspace_bytes(
    state: &State,
    record: &Record,
    services: &ScratchServices<'_>,
) -> Result<u64, String> {
    if record.target.kind == "local" {
        let path = local_workspace_path(&state.temporary_root, &record.key);
        if !path.exists() {
            return Ok(0);
        }
        local_tree_bytes(&path)
    } else {
        remote::bytes(&state.instance, record, services)
    }
}

fn local_tree_bytes(root: &Path) -> Result<u64, String> {
    inspect_directory(root)?;
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut count = 0;
    let mut bytes = 0_u64;
    while let Some((path, depth)) = pending.pop() {
        count += 1;
        if count > MAX_TREE_ENTRIES || depth > 32 {
            return Err("scratch tree exceeds inspection limits".into());
        }
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("scratch symlink traversal denied".into());
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
                pending.push((entry.map_err(|e| e.to_string())?.path(), depth + 1));
                if pending.len() > MAX_TREE_ENTRIES {
                    return Err("scratch tree exceeds inspection limits".into());
                }
            }
        } else if metadata.is_file() {
            bytes = bytes.saturating_add(metadata.len());
        } else {
            return Err("scratch contains an unsupported entry".into());
        }
    }
    Ok(bytes)
}

fn persist(state: &State, record: &Record) -> Result<(), String> {
    // Only published key.json files belong in the ownership index. Reopening
    // another runtime must not mistake an in-flight atomic write for a record.
    write_json_staged(
        &state
            .root
            .join("records")
            .join(format!("{}.json", record.key)),
        record,
        &state.root.join("pending"),
    )
}

fn trash_workspace(path: &Path) -> Result<(), String> {
    let context = trash::TrashContext::new();
    #[cfg(target_os = "macos")]
    let context = {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut context = context;
        context.set_delete_method(DeleteMethod::NsFileManager);
        context
    };
    context
        .delete(path)
        .map_err(|e| format!("scratch trash deferred: {e}"))
}

fn now() -> u64 {
    super::native::current_unix_ms()
}

#[cfg(test)]
#[path = "tests/scratch.rs"]
mod tests;
