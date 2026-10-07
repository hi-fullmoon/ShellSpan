//! Cleanup custody is separate from execution authorization. No command or grant
//! is stored here. Only authenticated intents and receipts can select resources.
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bollard::errors::Error;
use bollard::query_parameters::{KillContainerOptions, RemoveContainerOptions};
use bollard::Docker;
use hmac::{Hmac, KeyInit, Mac};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::agent_runtime::AgentSessionHeader;
use crate::keychain::CredentialManager;

const SERVICE: &str = "ShellSpan.AgentSandboxOwnership.v1";
const LABEL: &str = "io.shellspan.cleanup.intent.v1";

fn open_journals() -> &'static Mutex<HashMap<std::path::PathBuf, Weak<ContainerJournal>>> {
    static OPEN: OnceLock<Mutex<HashMap<std::path::PathBuf, Weak<ContainerJournal>>>> =
        OnceLock::new();
    OPEN.get_or_init(Mutex::default)
}

#[derive(Clone, Default)]
pub(crate) struct ContainerResourceSupervisor {
    configuration: Arc<Mutex<Option<(std::path::PathBuf, CredentialManager)>>>,
    exit_state: Arc<AtomicU8>,
}

impl ContainerResourceSupervisor {
    pub(crate) fn configure(
        &self,
        root: std::path::PathBuf,
        credentials: CredentialManager,
    ) -> Result<(), String> {
        self.attach(root, credentials)?;
        let supervisor = self.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = supervisor.reconcile().await {
                log::warn!("Agent container recovery remains unconfirmed: {error}");
            }
        });
        Ok(())
    }

    fn attach(
        &self,
        root: std::path::PathBuf,
        credentials: CredentialManager,
    ) -> Result<(), String> {
        *self
            .configuration
            .lock()
            .map_err(|_| "containerSupervisorUnavailable")? = Some((root, credentials));
        Ok(())
    }

    #[cfg(debug_assertions)]
    pub(crate) async fn prepare_gui_check(&self, root: std::path::PathBuf) -> Result<(), String> {
        self.attach(root, CredentialManager::isolated_native_for_checks())?;
        self.reconcile().await?;
        Ok(())
    }

    async fn journal(&self) -> Result<Option<Arc<ContainerJournal>>, String> {
        let configuration = self
            .configuration
            .lock()
            .map_err(|_| "containerSupervisorUnavailable")?
            .clone();
        let Some((root, credentials)) = configuration else {
            return Ok(None);
        };
        let journal =
            tokio::task::spawn_blocking(move || ContainerJournal::open(&root, &credentials, false))
                .await
                .map_err(|_| "containerSupervisorUnavailable")??;
        Ok(journal)
    }

    pub(crate) async fn reconcile(&self) -> Result<usize, String> {
        let Some(journal) = self.journal().await? else {
            return Ok(0);
        };
        let socket = if cfg!(windows) {
            "//./pipe/docker_engine"
        } else {
            "/var/run/docker.sock"
        };
        let docker = Docker::connect_with_local(socket, 3, bollard::API_DEFAULT_VERSION)
            .map_err(|_| "containerDaemonUnavailable")?;
        journal.recover(&docker).await
    }

    pub(crate) fn begin_shutdown(&self) -> bool {
        let first = self
            .exit_state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();
        // Only in-memory, nonblocking notification on the event-loop thread.
        // If an opener holds the cache lock, the async shutdown closes it next.
        if first {
            if let (Ok(configuration), Ok(open)) =
                (self.configuration.try_lock(), open_journals().try_lock())
            {
                if let Some((root, _)) = configuration.as_ref() {
                    if let Some(journal) = open.get(root).and_then(Weak::upgrade) {
                        journal.closing.cancel();
                    }
                }
            }
        }
        first
    }

    pub(crate) fn shutdown_complete(&self) -> bool {
        self.exit_state.load(Ordering::Acquire) == 2
    }

    pub(crate) fn finish_shutdown(&self) {
        self.exit_state.store(2, Ordering::Release);
    }

    pub(crate) async fn shutdown(&self) -> Result<usize, String> {
        let Some(journal) = self.journal().await? else {
            return Ok(0);
        };
        journal.closing.cancel();
        let socket = if cfg!(windows) {
            "//./pipe/docker_engine"
        } else {
            "/var/run/docker.sock"
        };
        let docker = Docker::connect_with_local(socket, 3, bollard::API_DEFAULT_VERSION)
            .map_err(|_| "containerDaemonUnavailable")?;
        journal.recover(&docker).await
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ContainerIntent {
    pub(super) job_id: String,
    pub(super) name: String,
    owner: String,
    daemon: String,
    session: String,
    session_created_at: u64,
    binding_revision: u64,
    target_digest: String,
    image: String,
    command_digest: String,
    created_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    intent: ContainerIntent,
    container_id: Option<String>,
    create_sent: bool,
}

pub(super) struct ContainerJournal {
    connection: Mutex<Connection>,
    owner: String,
    key: Vec<u8>,
    blocked: AtomicBool,
    pub(super) closing: tokio_util::sync::CancellationToken,
    cleanup: tokio::sync::Mutex<()>,
    confirmed: Mutex<HashSet<String>>,
}

impl ContainerJournal {
    pub(super) fn open(
        root: &Path,
        credentials: &CredentialManager,
        create: bool,
    ) -> Result<Option<Arc<Self>>, String> {
        let path = root.join("agent-container-custody.sqlite3");
        if !create {
            match std::fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err("containerJournalUnavailable".into()),
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                    return Err("containerJournalUnavailable".into())
                }
                _ => {}
            }
        }
        std::fs::create_dir_all(root).map_err(|_| "containerJournalUnavailable")?;
        let canonical = std::fs::canonicalize(root).map_err(|_| "containerJournalUnavailable")?;
        let mut open = open_journals()
            .lock()
            .map_err(|_| "containerJournalUnavailable")?;
        if let Some(journal) = open.get(&canonical).and_then(Weak::upgrade) {
            open.insert(root.to_owned(), Arc::downgrade(&journal));
            return Ok(Some(journal));
        }
        let mut connection = Connection::open(path).map_err(|_| "containerJournalUnavailable")?;
        connection
            .busy_timeout(Duration::from_secs(2))
            .map_err(|_| "containerJournalUnavailable")?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS custody (job_id TEXT PRIMARY KEY, payload TEXT NOT NULL, signature TEXT NOT NULL); CREATE TABLE IF NOT EXISTS custody_audit (seq INTEGER PRIMARY KEY, job_id TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, signature TEXT NOT NULL);").map_err(|_| "containerJournalUnavailable")?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "containerJournalUnavailable")?;
        let owner: Option<String> = transaction
            .query_row("SELECT id FROM owner WHERE singleton=1", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|_| "containerJournalUnavailable")?;
        let (owner, key) = match owner {
            Some(owner) => {
                let secret = credentials
                    .get_credential(SERVICE, &owner)
                    .map_err(|_| "containerOwnershipKeyUnavailable")?
                    .ok_or("containerOwnershipKeyUnavailable")?;
                (
                    owner,
                    hex::decode(secret).map_err(|_| "containerOwnershipKeyUnavailable")?,
                )
            }
            None if create => {
                let owner = Uuid::new_v4().to_string();
                let mut key = Vec::from(Uuid::new_v4().as_bytes());
                key.extend_from_slice(Uuid::new_v4().as_bytes());
                credentials
                    .set_credential(SERVICE, &owner, &hex::encode(&key))
                    .map_err(|_| "containerOwnershipKeyUnavailable")?;
                transaction
                    .execute("INSERT INTO owner(singleton,id) VALUES (1,?1)", [&owner])
                    .map_err(|_| "containerJournalUnavailable")?;
                (owner, key)
            }
            None => return Err("containerOwnershipKeyUnavailable".into()),
        };
        transaction
            .commit()
            .map_err(|_| "containerJournalUnavailable")?;
        if key.len() != 32 {
            return Err("containerOwnershipKeyUnavailable".into());
        }
        let journal = Arc::new(Self {
            connection: Mutex::new(connection),
            owner,
            key,
            blocked: AtomicBool::new(true),
            closing: tokio_util::sync::CancellationToken::new(),
            cleanup: tokio::sync::Mutex::new(()),
            confirmed: Mutex::new(HashSet::new()),
        });
        journal
            .blocked
            .store(!journal.records()?.is_empty(), Ordering::Release);
        open.insert(canonical, Arc::downgrade(&journal));
        open.insert(root.to_owned(), Arc::downgrade(&journal));
        Ok(Some(journal))
    }

    fn sign(&self, domain: &[u8], payload: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).expect("fixed HMAC key");
        mac.update(domain);
        mac.update(payload);
        hex::encode(mac.finalize().into_bytes())
    }

    fn valid(&self, domain: &[u8], payload: &[u8], signature: &str) -> bool {
        let Ok(signature) = hex::decode(signature) else {
            return false;
        };
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).expect("fixed HMAC key");
        mac.update(domain);
        mac.update(payload);
        mac.verify_slice(&signature).is_ok()
    }

    fn save(&self, record: &Record) -> Result<(), String> {
        let payload = serde_json::to_string(record).map_err(|_| "containerJournalUnavailable")?;
        let signature = self.sign(b"record\0", payload.as_bytes());
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "containerJournalUnavailable")?;
        let transaction = connection
            .transaction()
            .map_err(|_| "containerJournalUnavailable")?;
        transaction.execute(
            "INSERT INTO custody(job_id,payload,signature) VALUES (?1,?2,?3) ON CONFLICT(job_id) DO UPDATE SET payload=excluded.payload,signature=excluded.signature",
            params![record.intent.job_id, payload, signature],
        ).map_err(|_| "containerJournalUnavailable")?;
        transaction.execute("INSERT INTO custody_audit(job_id,action,payload,signature) VALUES (?1,'sealed',?2,?3)", params![record.intent.job_id,payload,signature]).map_err(|_| "containerJournalUnavailable")?;
        transaction
            .commit()
            .map_err(|_| "containerJournalUnavailable")?;
        Ok(())
    }

    fn records(&self) -> Result<Vec<Record>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "containerJournalUnavailable")?;
        let mut statement = connection
            .prepare("SELECT job_id,payload,signature FROM custody")
            .map_err(|_| "containerJournalUnavailable")?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|_| "containerJournalUnavailable")?;
        let mut records = Vec::new();
        for row in rows {
            let (id, payload, signature) = row.map_err(|_| "containerJournalUnavailable")?;
            if !self.valid(b"record\0", payload.as_bytes(), &signature) {
                return Err("containerOwnershipProofInvalid".into());
            }
            let record: Record =
                serde_json::from_str(&payload).map_err(|_| "containerOwnershipProofInvalid")?;
            if record.intent.owner != self.owner || record.intent.job_id != id {
                return Err("containerOwnershipProofInvalid".into());
            }
            records.push(record);
        }
        Ok(records)
    }

    pub(super) async fn reserve(
        self: &Arc<Self>,
        docker: &Docker,
        header: &AgentSessionHeader,
        image: &str,
        command: &str,
    ) -> Result<ContainerIntent, String> {
        if self.blocked.load(Ordering::Acquire) || self.closing.is_cancelled() {
            return Err("containerCleanupPending".into());
        }
        let daemon = docker
            .info()
            .await
            .map_err(|_| "containerDaemonUnavailable")?
            .id
            .ok_or("containerDaemonIdentityMissing")?;
        let job_id = Uuid::new_v4().to_string();
        let target = serde_json::to_vec(&(
            &header.target,
            header.execution_surface,
            header.sandbox_policy,
        ))
        .map_err(|_| "containerBindingInvalid")?;
        let intent = ContainerIntent {
            name: format!("shellspan-sandbox-{job_id}"),
            job_id,
            owner: self.owner.clone(),
            daemon,
            session: header.session_id.clone(),
            session_created_at: header.created_at_unix_ms,
            binding_revision: header.sandbox_binding_revision,
            target_digest: hex::encode(Sha256::digest(target)),
            image: image.into(),
            command_digest: hex::encode(Sha256::digest(command.as_bytes())),
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        };
        let record = Record {
            intent: intent.clone(),
            container_id: None,
            create_sent: false,
        };
        let journal = Arc::clone(self);
        tokio::task::spawn_blocking(move || journal.save(&record))
            .await
            .map_err(|_| "containerJournalUnavailable")??;
        Ok(intent)
    }

    pub(super) fn labels(&self, intent: &ContainerIntent) -> HashMap<String, String> {
        let payload = serde_json::to_vec(intent).expect("serializable custody intent");
        HashMap::from([(LABEL.into(), self.sign(b"intent\0", &payload))])
    }

    pub(super) async fn receipt(
        self: &Arc<Self>,
        intent: &ContainerIntent,
        id: &str,
    ) -> Result<(), String> {
        let record = Record {
            intent: intent.clone(),
            container_id: Some(id.into()),
            create_sent: true,
        };
        let journal = Arc::clone(self);
        tokio::task::spawn_blocking(move || journal.save(&record))
            .await
            .map_err(|_| "containerJournalUnavailable")?
    }

    pub(super) async fn clean(
        self: &Arc<Self>,
        docker: &Docker,
        intent: &ContainerIntent,
    ) -> Result<bool, String> {
        let _cleanup = self.cleanup.lock().await;
        let result = self.clean_inner(docker, intent).await;
        if result.is_err() {
            self.blocked.store(true, Ordering::Release);
        }
        result
    }

    pub(super) async fn sent(self: &Arc<Self>, intent: &ContainerIntent) -> Result<(), String> {
        let record = Record {
            intent: intent.clone(),
            container_id: None,
            create_sent: true,
        };
        let journal = Arc::clone(self);
        tokio::task::spawn_blocking(move || journal.save(&record))
            .await
            .map_err(|_| "containerJournalUnavailable")?
    }

    async fn clean_inner(
        self: &Arc<Self>,
        docker: &Docker,
        intent: &ContainerIntent,
    ) -> Result<bool, String> {
        let journal = Arc::clone(self);
        let records = tokio::task::spawn_blocking(move || journal.records())
            .await
            .map_err(|_| "containerJournalUnavailable")??;
        let Some(record) = records
            .into_iter()
            .find(|record| record.intent.job_id == intent.job_id)
        else {
            return if self
                .confirmed
                .lock()
                .map_err(|_| "containerJournalUnavailable")?
                .contains(&intent.job_id)
            {
                Ok(true)
            } else {
                Err("containerOwnershipReceiptMissing".into())
            };
        };
        let daemon = docker
            .info()
            .await
            .map_err(|_| "containerDaemonUnavailable")?
            .id
            .ok_or("containerDaemonIdentityMissing")?;
        if daemon != record.intent.daemon {
            return Err("containerDaemonIdentityChanged".into());
        }
        let selected = record
            .container_id
            .as_deref()
            .unwrap_or(&record.intent.name);
        let info = match docker.inspect_container(selected, None).await {
            Ok(info) => info,
            Err(Error::DockerResponseServerError {
                status_code: 404, ..
            }) => {
                if record.create_sent && record.container_id.is_none() {
                    return Err("containerCreateOutcomeUncertain".into());
                }
                return self.forget(&record.intent.job_id).await.map(|_| true);
            }
            Err(_) => return Err("containerCleanupUncertain".into()),
        };
        // Labels are replayable public metadata. Without our sealed exact-ID
        // receipt, discovery by name is not authority to adopt or remove it.
        if record.container_id.is_none() {
            return Err("containerOwnershipReceiptMissing".into());
        }
        let config = info
            .config
            .as_ref()
            .ok_or("containerOwnershipProofInvalid")?;
        let expected = self.labels(&record.intent);
        let signature = config
            .labels
            .as_ref()
            .and_then(|labels| labels.get(LABEL))
            .ok_or("containerOwnershipProofInvalid")?;
        let payload =
            serde_json::to_vec(&record.intent).map_err(|_| "containerOwnershipProofInvalid")?;
        let id = info.id.as_deref().ok_or("containerOwnershipProofInvalid")?;
        if !self.valid(b"intent\0", &payload, signature)
            || expected.get(LABEL) != Some(signature)
            || info.name.as_deref() != Some(&format!("/{}", record.intent.name))
            || config.image.as_deref() != Some(&record.intent.image)
            || config
                .cmd
                .as_ref()
                .and_then(|cmd| cmd.last())
                .map(|command| hex::encode(Sha256::digest(command.as_bytes())))
                != Some(record.intent.command_digest.clone())
            || record
                .container_id
                .as_deref()
                .is_some_and(|expected| expected != id)
        {
            return Err("containerOwnershipProofInvalid".into());
        }
        // Revalidate our already sealed exact receipt before any mutation.
        self.receipt(&record.intent, id).await?;
        if info.state.as_ref().and_then(|state| state.running) == Some(true) {
            let _ = docker
                .kill_container(
                    id,
                    Some(KillContainerOptions {
                        signal: "KILL".into(),
                    }),
                )
                .await;
        }
        let settled = tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                let info = docker
                    .inspect_container(id, None)
                    .await
                    .map_err(|_| "containerCleanupUncertain")?;
                if info
                    .state
                    .is_some_and(|state| state.running == Some(false) && state.pid == Some(0))
                {
                    return Ok::<(), String>(());
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| "containerCleanupUncertain")?;
        settled?;
        docker
            .remove_container(
                id,
                Some(RemoveContainerOptions {
                    v: true,
                    ..Default::default()
                }),
            )
            .await
            .map_err(|_| "containerCleanupUncertain")?;
        match docker.inspect_container(id, None).await {
            Err(Error::DockerResponseServerError {
                status_code: 404, ..
            }) => self.forget(&record.intent.job_id).await.map(|_| true),
            _ => Err("containerCleanupUncertain".into()),
        }
    }

    async fn forget(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let journal = Arc::clone(self);
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || {
            let mut connection = journal.connection.lock().map_err(|_| "containerJournalUnavailable")?;
            let transaction = connection.transaction().map_err(|_| "containerJournalUnavailable")?;
            let signature = journal.sign(b"removed\0", id.as_bytes());
            transaction.execute("DELETE FROM custody WHERE job_id=?1", [&id]).map_err(|_| "containerJournalUnavailable")?;
            transaction.execute("INSERT INTO custody_audit(job_id,action,payload,signature) VALUES (?1,'removed',?1,?2)", params![id,signature]).map_err(|_| "containerJournalUnavailable")?;
            transaction.commit().map_err(|_| "containerJournalUnavailable")?;
            journal.confirmed.lock().map_err(|_| "containerJournalUnavailable")?.insert(id);
            Ok(())
        })
        .await
        .map_err(|_| "containerJournalUnavailable")?
    }

    pub(super) async fn recover(self: &Arc<Self>, docker: &Docker) -> Result<usize, String> {
        let journal = Arc::clone(self);
        let records = tokio::task::spawn_blocking(move || journal.records())
            .await
            .map_err(|_| "containerJournalUnavailable")??;
        let mut cleaned = 0;
        let mut uncertain = false;
        for record in records {
            match self.clean(docker, &record.intent).await {
                Ok(true) => cleaned += 1,
                _ => uncertain = true,
            }
        }
        if uncertain {
            return Err("containerCleanupUncertain".into());
        }
        self.blocked.store(false, Ordering::Release);
        Ok(cleaned)
    }

    #[cfg(any(test, debug_assertions))]
    pub(super) fn destroy_test_key(&self, credentials: &CredentialManager) {
        credentials.delete_credential(SERVICE, &self.owner).unwrap();
    }

    #[cfg(any(test, debug_assertions))]
    pub(super) fn pending_count(&self) -> usize {
        self.records().unwrap().len()
    }

    #[cfg(test)]
    pub(super) fn owner_reference(&self) -> &str {
        &self.owner
    }
}
