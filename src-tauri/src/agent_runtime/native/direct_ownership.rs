//! Durable dispatch debt, never a process identity or a restorable grant.
//! After restart no PID, path, or historical receipt authorizes cleanup.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::agent_runtime::remote_seatbelt::cleanup::RemoteCleanupCapsule;
use crate::keychain::CredentialManager;
use rusqlite::OptionalExtension;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const CUSTODY_SERVICE: &str = "ShellSpan.AgentDirectCleanup.v1";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProtectedCustody {
    version: u32,
    app_root: PathBuf,
    intent_id: String,
    task_id: String,
    request_id: String,
    target_id: String,
    creator_pid: u32,
    creator_start_time: u64,
    cleanup_confirmed: bool,
    remote: Option<RemoteCleanupCapsule>,
    #[cfg(target_os = "macos")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    local: Option<super::local_guardian::LocalCleanupCapsule>,
}

struct LiveCustody {
    key_id: String,
    credentials: CredentialManager,
    payload: ProtectedCustody,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectResourceRecovery {
    pub(crate) resolved: usize,
    pub(crate) uncertain: usize,
}

const CLEANUP_DEBT: &str = "directCleanupUnconfirmed: restored Direct dispatch debt requires resource evidence; new dispatch is paused";

#[derive(Clone, Default)]
pub(super) struct DirectOwnership {
    inner: Arc<Mutex<Option<Journal>>>,
}

struct Journal {
    path: PathBuf,
    connection: Connection,
    restored_debt: bool,
    restored_ids: HashSet<String>,
    live_ids: HashSet<String>,
}

pub(crate) struct DirectIntent {
    journal: DirectOwnership,
    id: String,
    resolved: std::sync::atomic::AtomicBool,
    remote_keeper: Mutex<Option<LiveCustody>>,
}

impl DirectOwnership {
    pub(super) fn configure(&self, root: &Path) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "directOwnershipUnavailable")?;
        let path = root.join("agent-direct-ownership.sqlite3");
        if let Some(journal) = inner.as_ref() {
            return if journal.path == path {
                Ok(())
            } else {
                Err("directOwnershipRootChanged".into())
            };
        }
        std::fs::create_dir_all(root).map_err(|_| "directOwnershipUnavailable")?;
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err("directOwnershipInvalid".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("directOwnershipUnavailable".into()),
        }
        let connection = Connection::open(&path).map_err(|_| "directOwnershipUnavailable")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "directOwnershipUnavailable")?;
        }
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS dispatch_debt (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, request_id TEXT NOT NULL, target_id TEXT NOT NULL);")
            .map_err(|_| "directOwnershipUnavailable")?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS remote_cleanup_custody (intent_id TEXT PRIMARY KEY, key_id TEXT NOT NULL);")
            .map_err(|_| "directOwnershipUnavailable")?;
        let restored_ids = connection
            .prepare("SELECT id FROM dispatch_debt")
            .map_err(|_| "directOwnershipInvalid")?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| "directOwnershipInvalid")?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(|_| "directOwnershipInvalid")?;
        let restored_debt = connection
            .query_row("SELECT EXISTS(SELECT 1 FROM dispatch_debt)", [], |row| {
                row.get(0)
            })
            .map_err(|_| "directOwnershipInvalid")?;
        *inner = Some(Journal {
            path,
            connection,
            restored_debt,
            restored_ids,
            live_ids: HashSet::new(),
        });
        Ok(())
    }

    pub(super) fn ensure_recovered(&self) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "directOwnershipUnavailable")?;
        if let Some(journal) = inner.as_mut() {
            journal.observe_foreign_debt()?;
            if journal.restored_debt {
                return Err(CLEANUP_DEBT.into());
            }
        }
        Ok(())
    }

    pub(super) fn begin(
        &self,
        task: &str,
        request: &str,
        target: &str,
    ) -> Result<Option<DirectIntent>, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "directOwnershipUnavailable")?;
        let Some(journal) = inner.as_mut() else {
            return Ok(None);
        };
        // Check under the same lock as the write; an abandoned concurrent
        // intent must not close admission between a separate check and insert.
        if journal.restored_debt {
            return Err(CLEANUP_DEBT.into());
        }
        // Serialize admission across application processes, including engines
        // configured before another application creates its first intent.
        let transaction = journal
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "directOwnershipUnavailable")?;
        let foreign = Journal::foreign_ids(&transaction, &journal.live_ids)?;
        if !foreign.is_empty() {
            journal.restored_ids.extend(foreign);
            journal.restored_debt = true;
            return Err(CLEANUP_DEBT.into());
        }
        let id = Uuid::new_v4().to_string();
        transaction.execute("INSERT INTO dispatch_debt (id, task_id, request_id, target_id) VALUES (?1, ?2, ?3, ?4)", params![id, task, request, target])
            .map_err(|_| "directOwnershipWriteFailed")?;
        transaction
            .commit()
            .map_err(|_| "directOwnershipWriteFailed")?;
        journal.live_ids.insert(id.clone());
        Ok(Some(DirectIntent {
            journal: self.clone(),
            id,
            resolved: std::sync::atomic::AtomicBool::new(false),
            remote_keeper: Mutex::new(None),
        }))
    }

    pub(super) fn reconcile(
        &self,
        credentials: &CredentialManager,
        known_hosts: &Path,
    ) -> Result<DirectResourceRecovery, String> {
        let (root, ids) = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| "directOwnershipUnavailable")?;
            let Some(journal) = inner.as_ref() else {
                return Err("directOwnershipUnavailable".into());
            };
            (
                std::fs::canonicalize(journal.path.parent().ok_or("directOwnershipUnavailable")?)
                    .map_err(|_| "directOwnershipUnavailable")?,
                journal.restored_ids.clone(),
            )
        };
        let mut result = DirectResourceRecovery::default();
        for id in ids {
            let recover = || -> Result<(), String> {
                Uuid::parse_str(&id).map_err(|_| "directOwnershipInvalid")?;
                let (task, request, target, key_id) = {
                    let inner = self
                        .inner
                        .lock()
                        .map_err(|_| "directOwnershipUnavailable")?;
                    let journal = inner.as_ref().ok_or("directOwnershipUnavailable")?;
                    journal.connection.query_row("SELECT d.task_id,d.request_id,d.target_id,c.key_id FROM dispatch_debt d JOIN remote_cleanup_custody c ON c.intent_id=d.id WHERE d.id=?1", [&id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, String>(3)?)))
                        .optional().map_err(|_| "directOwnershipUnavailable")?.ok_or("directCleanupUnconfirmed")?
                };
                if key_id != format!("job-{id}") {
                    return Err("directOwnershipInvalid".into());
                }
                let secret = credentials
                    .get_credential(CUSTODY_SERVICE, &key_id)
                    .map_err(|_| "directOwnershipUnavailable")?
                    .ok_or("directCleanupUnconfirmed")?;
                if secret.len() > 65536 {
                    return Err("directOwnershipInvalid".into());
                }
                let mut custody: ProtectedCustody =
                    serde_json::from_str(&secret).map_err(|_| "directOwnershipInvalid")?;
                if custody.version != 1
                    || custody.app_root != root
                    || custody.intent_id != id
                    || custody.task_id != task
                    || custody.request_id != request
                    || custody.target_id != target
                    || custody.creator_pid < 2
                    || custody.creator_start_time == 0
                {
                    return Err("directOwnershipInvalid".into());
                }
                #[cfg(target_os = "macos")]
                if custody
                    .local
                    .as_ref()
                    .is_some_and(|local| !local.bound_to(&root) || custody.remote.is_some())
                {
                    return Err("directOwnershipInvalid".into());
                }
                if !custody.cleanup_confirmed {
                    // PID observation only refuses interference with a live
                    // creator. It never selects or signals a remote resource.
                    let system = sysinfo::System::new_all();
                    if system
                        .process(sysinfo::Pid::from_u32(custody.creator_pid))
                        .is_some_and(|process| process.start_time() == custody.creator_start_time)
                    {
                        return Err("directCleanupUnconfirmed".into());
                    }
                    match &custody.remote {
                        Some(remote) => remote.reconcile(credentials, known_hosts)?,
                        #[cfg(target_os = "macos")]
                        None => custody
                            .local
                            .as_ref()
                            .ok_or("directCleanupUnconfirmed")?
                            .reconcile()?,
                        #[cfg(not(target_os = "macos"))]
                        None => return Err("directCleanupUnconfirmed".into()),
                    }
                    custody.cleanup_confirmed = true;
                    credentials
                        .set_credential(
                            CUSTODY_SERVICE,
                            &key_id,
                            &serde_json::to_string(&custody)
                                .map_err(|_| "directOwnershipUnavailable")?,
                        )
                        .map_err(|_| "directOwnershipUnavailable")?;
                }
                #[cfg(target_os = "macos")]
                if let Some(local) = &custody.local {
                    local.retire()?;
                }
                credentials
                    .delete_credential(CUSTODY_SERVICE, &key_id)
                    .map_err(|_| "directOwnershipUnavailable")?;
                let mut inner = self
                    .inner
                    .lock()
                    .map_err(|_| "directOwnershipUnavailable")?;
                let journal = inner.as_mut().ok_or("directOwnershipUnavailable")?;
                let transaction = journal
                    .connection
                    .transaction()
                    .map_err(|_| "directOwnershipWriteFailed")?;
                transaction
                    .execute(
                        "DELETE FROM remote_cleanup_custody WHERE intent_id=?1",
                        [&id],
                    )
                    .map_err(|_| "directOwnershipWriteFailed")?;
                transaction
                    .execute("DELETE FROM dispatch_debt WHERE id=?1", [&id])
                    .map_err(|_| "directOwnershipWriteFailed")?;
                transaction
                    .commit()
                    .map_err(|_| "directOwnershipWriteFailed")?;
                journal.restored_ids.remove(&id);
                Ok(())
            };
            match recover() {
                Ok(()) => result.resolved += 1,
                Err(error) => {
                    // Report only fixed categories: custody and credential errors
                    // may contain sensitive details and must never be dumped.
                    let category = match error.as_str() {
                        "directOwnershipInvalid" => "invalid custody",
                        "directOwnershipUnavailable" => "custody or peer unavailable",
                        "directOwnershipWriteFailed" => "ledger write failed",
                        "directCleanupUnconfirmed" => "cleanup unconfirmed or creator active",
                        "sandboxRemoteControllerFailed: bounded SSH controller operation did not complete" => "controller transport failed",
                        _ => "protected recovery failed",
                    };
                    #[cfg(debug_assertions)]
                    if std::env::args().any(|arg| arg == "--native-host-check") {
                        eprintln!("Host cleanup remains uncertain: {category}");
                    } else {
                        log::warn!("Direct resource recovery remains uncertain: {category}");
                    }
                    #[cfg(not(debug_assertions))]
                    log::warn!("Direct resource recovery remains uncertain: {category}");
                    result.uncertain += 1;
                }
            }
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "directOwnershipUnavailable")?;
        let journal = inner.as_mut().ok_or("directOwnershipUnavailable")?;
        if journal.restored_ids.is_empty() {
            journal.restored_debt = false;
        }
        Ok(result)
    }
}

impl Journal {
    fn foreign_ids(
        connection: &Connection,
        live_ids: &HashSet<String>,
    ) -> Result<HashSet<String>, String> {
        let ids = connection
            .prepare("SELECT id FROM dispatch_debt")
            .map_err(|_| "directOwnershipUnavailable")?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| "directOwnershipUnavailable")?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(|_| "directOwnershipUnavailable")?;
        Ok(ids.difference(live_ids).cloned().collect())
    }

    fn observe_foreign_debt(&mut self) -> Result<(), String> {
        let foreign = Self::foreign_ids(&self.connection, &self.live_ids)?;
        if !foreign.is_empty() {
            self.restored_debt = true;
            self.restored_ids.extend(foreign);
        }
        Ok(())
    }
}

impl DirectIntent {
    pub(super) fn mark_uncertain(&self) -> Result<(), String> {
        let mut inner = self
            .journal
            .inner
            .lock()
            .map_err(|_| "directOwnershipUnavailable")?;
        let journal = inner.as_mut().ok_or("directOwnershipUnavailable")?;
        journal.restored_debt = true;
        journal.restored_ids.insert(self.id.clone());
        journal.live_ids.remove(&self.id);
        Ok(())
    }
    pub(crate) fn protect_remote(
        &self,
        job: &crate::agent_runtime::remote_seatbelt::RemoteSeatbeltJob,
        credentials: &CredentialManager,
    ) -> Result<(), String> {
        self.protect(
            Some(job.cleanup_capsule()?),
            #[cfg(target_os = "macos")]
            None,
            credentials,
        )
    }

    #[cfg(target_os = "macos")]
    pub(super) fn protect_local(
        &self,
        contract: Option<&crate::agent_runtime::AgentSandboxContract>,
        credentials: &CredentialManager,
    ) -> Result<super::local_guardian::LocalCleanupCapsule, String> {
        let root = {
            let inner = self
                .journal
                .inner
                .lock()
                .map_err(|_| "directOwnershipUnavailable")?;
            inner
                .as_ref()
                .ok_or("directOwnershipUnavailable")?
                .path
                .parent()
                .ok_or("directOwnershipUnavailable")?
                .to_path_buf()
        };
        let local = super::local_guardian::LocalCleanupCapsule::create(&root, contract)?;
        self.protect(None, Some(local.clone()), credentials)?;
        Ok(local)
    }

    fn protect(
        &self,
        remote: Option<RemoteCleanupCapsule>,
        #[cfg(target_os = "macos")] local: Option<super::local_guardian::LocalCleanupCapsule>,
        credentials: &CredentialManager,
    ) -> Result<(), String> {
        let inner = self
            .journal
            .inner
            .lock()
            .map_err(|_| "directOwnershipUnavailable")?;
        let journal = inner.as_ref().ok_or("directOwnershipUnavailable")?;
        let mut keeper = self
            .remote_keeper
            .lock()
            .map_err(|_| "directOwnershipUnavailable")?;
        if keeper.is_some() {
            return Err("directOwnershipDuplicate".into());
        }
        let (task_id, request_id, target_id) = journal
            .connection
            .query_row(
                "SELECT task_id,request_id,target_id FROM dispatch_debt WHERE id=?1",
                [&self.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|_| "directOwnershipUnavailable")?;
        let system = sysinfo::System::new_all();
        let pid = std::process::id();
        let start = system
            .process(sysinfo::Pid::from_u32(pid))
            .ok_or("directOwnershipUnavailable")?
            .start_time();
        if start == 0 {
            return Err("directOwnershipUnavailable".into());
        }
        let payload = ProtectedCustody {
            version: 1,
            app_root: std::fs::canonicalize(
                journal.path.parent().ok_or("directOwnershipUnavailable")?,
            )
            .map_err(|_| "directOwnershipUnavailable")?,
            intent_id: self.id.clone(),
            task_id,
            request_id,
            target_id,
            creator_pid: pid,
            creator_start_time: start,
            cleanup_confirmed: false,
            remote,
            #[cfg(target_os = "macos")]
            local,
        };
        let key_id = format!("job-{}", self.id);
        journal
            .connection
            .execute(
                "INSERT INTO remote_cleanup_custody(intent_id,key_id) VALUES (?1,?2)",
                params![self.id, key_id],
            )
            .map_err(|_| "directOwnershipWriteFailed")?;
        credentials
            .set_credential(
                CUSTODY_SERVICE,
                &key_id,
                &serde_json::to_string(&payload).map_err(|_| "directOwnershipUnavailable")?,
            )
            .map_err(|_| "directOwnershipUnavailable")?;
        *keeper = Some(LiveCustody {
            key_id,
            credentials: credentials.clone(),
            payload,
        });
        Ok(())
    }
    // Only the current dispatch's in-memory intent can resolve its own row.
    pub(super) fn resolve(&self) -> Result<(), String> {
        let mut inner = self
            .journal
            .inner
            .lock()
            .map_err(|_| "directOwnershipUnavailable")?;
        let journal = inner.as_mut().ok_or("directOwnershipUnavailable")?;
        journal.restored_debt = true;
        journal.restored_ids.insert(self.id.clone());
        let mut keeper = self
            .remote_keeper
            .lock()
            .map_err(|_| "directOwnershipUnavailable")?;
        if let Some(custody) = keeper.as_mut() {
            #[cfg(target_os = "macos")]
            if let Some(local) = &custody.payload.local {
                if !custody.payload.cleanup_confirmed {
                    local.reconcile()?;
                }
            }
            custody.payload.cleanup_confirmed = true;
            custody
                .credentials
                .set_credential(
                    CUSTODY_SERVICE,
                    &custody.key_id,
                    &serde_json::to_string(&custody.payload)
                        .map_err(|_| "directOwnershipUnavailable")?,
                )
                .map_err(|_| "directOwnershipUnavailable")?;
            #[cfg(target_os = "macos")]
            if let Some(local) = &custody.payload.local {
                local.retire()?;
            }
            custody
                .credentials
                .delete_credential(CUSTODY_SERVICE, &custody.key_id)
                .map_err(|_| "directOwnershipUnavailable")?;
            journal
                .connection
                .execute(
                    "DELETE FROM remote_cleanup_custody WHERE intent_id=?1",
                    [&self.id],
                )
                .map_err(|_| "directOwnershipWriteFailed")?;
        }
        if journal
            .connection
            .execute("DELETE FROM dispatch_debt WHERE id=?1", [&self.id])
            .is_err()
        {
            journal.restored_debt = true;
            return Err("directOwnershipWriteFailed".into());
        }
        self.resolved
            .store(true, std::sync::atomic::Ordering::Release);
        journal.restored_ids.remove(&self.id);
        journal.live_ids.remove(&self.id);
        journal.restored_debt = !journal.restored_ids.is_empty();
        Ok(())
    }
}

impl Drop for DirectIntent {
    fn drop(&mut self) {
        if !self.resolved.load(std::sync::atomic::Ordering::Acquire) {
            if let Ok(mut inner) = self.journal.inner.lock() {
                if let Some(journal) = inner.as_mut() {
                    journal.restored_debt = true;
                    journal.restored_ids.insert(self.id.clone());
                    journal.live_ids.remove(&self.id);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_application_child() {
        let Some(root) = std::env::var_os("SHELLSPAN_DIRECT_CONCURRENT_FIXTURE") else {
            return;
        };
        let root = PathBuf::from(root);
        let journal = DirectOwnership::default();
        journal.configure(&root).unwrap();
        std::fs::write(root.join("configured"), b"ready").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !root.join("dispatch").is_file() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(journal.begin("second-app", "request", "target").is_err());
        assert!(journal.ensure_recovered().is_err());
    }

    #[test]
    fn independently_configured_application_cannot_dispatch_over_live_foreign_debt() {
        let root = tempfile::tempdir().unwrap();
        let journal = DirectOwnership::default();
        journal.configure(root.path()).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "agent_runtime::native::direct_ownership::tests::concurrent_application_child",
            ])
            .env("SHELLSPAN_DIRECT_CONCURRENT_FIXTURE", root.path())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !root.path().join("configured").is_file() {
            assert!(child.try_wait().unwrap().is_none());
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let intent = journal
            .begin("first-app", "request", "target")
            .unwrap()
            .unwrap();
        std::fs::write(root.path().join("dispatch"), b"ready").unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        journal.ensure_recovered().unwrap();
        intent.resolve().unwrap();
        let fresh = DirectOwnership::default();
        fresh.configure(root.path()).unwrap();
        fresh.ensure_recovered().unwrap();
    }

    #[test]
    fn recovery_never_erases_uncredentialed_or_disappeared_debt() {
        let root = tempfile::tempdir().unwrap();
        let journal = DirectOwnership::default();
        journal.configure(root.path()).unwrap();
        let intent = journal.begin("task", "request", "target").unwrap().unwrap();
        drop(intent);
        let credentials = CredentialManager::isolated_native_for_checks();
        let first = journal
            .reconcile(&credentials, &root.path().join("known_hosts"))
            .unwrap();
        assert_eq!(first.resolved, 0);
        assert_eq!(first.uncertain, 1);
        let external =
            Connection::open(root.path().join("agent-direct-ownership.sqlite3")).unwrap();
        external.execute("DELETE FROM dispatch_debt", []).unwrap();
        let second = journal
            .reconcile(&credentials, &root.path().join("known_hosts"))
            .unwrap();
        assert_eq!(second.resolved, 0);
        assert_eq!(second.uncertain, 1);
        assert!(journal.ensure_recovered().is_err());
    }

    #[test]
    fn abandoned_live_intent_closes_admission_before_any_following_dispatch() {
        let root = tempfile::tempdir().unwrap();
        let journal = DirectOwnership::default();
        journal.configure(root.path()).unwrap();
        let intent = journal.begin("task", "request", "target").unwrap().unwrap();
        drop(intent);
        assert!(journal.begin("other-task", "request", "target").is_err());
        assert!(journal.ensure_recovered().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn dangling_journal_symlink_cannot_create_an_external_database() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let destination = external.path().join("not-created.sqlite3");
        std::os::unix::fs::symlink(
            &destination,
            root.path().join("agent-direct-ownership.sqlite3"),
        )
        .unwrap();
        assert!(DirectOwnership::default().configure(root.path()).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn restart_retains_debt_without_restoring_authority_or_rebinding_root() {
        let root = tempfile::tempdir().unwrap();
        let journal = DirectOwnership::default();
        journal.configure(root.path()).unwrap();
        let first = journal
            .begin("first", "request", "target")
            .unwrap()
            .unwrap();
        let second = journal
            .begin("second", "request", "target")
            .unwrap()
            .unwrap();
        first.resolve().unwrap();
        let restored = DirectOwnership::default();
        restored.configure(root.path()).unwrap();
        assert!(restored.begin("third", "request", "target").is_err());
        journal.configure(root.path()).unwrap();
        assert!(journal
            .configure(tempfile::tempdir().unwrap().path())
            .is_err());
        second.resolve().unwrap();
        // A live restored instance stays closed; only a new startup rechecks disk.
        assert!(restored.ensure_recovered().is_err());
        let clean = DirectOwnership::default();
        clean.configure(root.path()).unwrap();
        clean.ensure_recovered().unwrap();
    }
}
