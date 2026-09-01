use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use uuid::Uuid;

const CHECKPOINT_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
const MAX_CHECKPOINTS: usize = 128;
const MAX_CHECKPOINT_BYTES: u64 = 128 * 1024 * 1024;
pub(super) const MAX_CHECKPOINT_FILE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CheckpointTargetKindV3 {
    Local,
    Remote,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFileCheckpointV3 {
    pub(crate) checkpoint_id: String,
    pub(crate) task_id: String,
    pub(crate) target_id: String,
    pub(crate) target_kind: CheckpointTargetKindV3,
    pub(crate) target_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) original_sha256: Option<String>,
    pub(crate) original_byte_length: u64,
    pub(crate) created_at_unix_ms: u64,
    pub(crate) expires_at_unix_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) restored_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub(super) struct CheckpointOriginalMetadataV3 {
    pub(super) permissions: Option<u32>,
    pub(super) modified_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedCheckpointV3 {
    #[serde(flatten)]
    snapshot: AgentFileCheckpointV3,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    backup_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    permissions: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    modified_unix_ms: Option<u64>,
}

#[derive(Clone, Default)]
pub(crate) struct CheckpointStoreV3 {
    lock: Arc<Mutex<()>>,
}

impl CheckpointStoreV3 {
    pub(super) fn create(
        &self,
        root: &Path,
        task_id: &str,
        target_id: &str,
        target_kind: CheckpointTargetKindV3,
        target_path: &str,
        original: Option<&[u8]>,
        metadata: CheckpointOriginalMetadataV3,
    ) -> Result<AgentFileCheckpointV3, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "checkpoint store is unavailable".to_string())?;
        let directory = checkpoint_directory(root);
        prepare_checkpoint_directory(&directory)?;
        cleanup_locked(&directory, current_unix_ms())?;
        if original.is_some_and(|content| content.len() as u64 > MAX_CHECKPOINT_FILE_BYTES) {
            return Err("file exceeds the native checkpoint size limit".into());
        }

        let checkpoint_id = format!("checkpoint-{}", Uuid::new_v4().simple());
        let created_at_unix_ms = current_unix_ms();
        let backup_file = original.map(|_| format!("{checkpoint_id}.bin"));
        if let (Some(content), Some(file_name)) = (original, backup_file.as_deref()) {
            write_private_atomic(&directory, file_name, content)?;
        }
        let snapshot = AgentFileCheckpointV3 {
            checkpoint_id: checkpoint_id.clone(),
            task_id: task_id.to_string(),
            target_id: target_id.to_string(),
            target_kind,
            target_path: target_path.to_string(),
            original_sha256: original.map(sha256_hex),
            original_byte_length: original.map_or(0, |content| content.len() as u64),
            created_at_unix_ms,
            expires_at_unix_ms: created_at_unix_ms.saturating_add(CHECKPOINT_TTL_MS),
            restored_at_unix_ms: None,
        };
        let record = PersistedCheckpointV3 {
            snapshot: snapshot.clone(),
            backup_file,
            permissions: metadata.permissions,
            modified_unix_ms: metadata.modified_unix_ms,
        };
        write_record(&directory, &record)?;
        enforce_capacity_locked(&directory)?;
        Ok(snapshot)
    }

    pub(crate) fn list(
        &self,
        root: &Path,
        task_id: &str,
    ) -> Result<Vec<AgentFileCheckpointV3>, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "checkpoint store is unavailable".to_string())?;
        let directory = checkpoint_directory(root);
        prepare_checkpoint_directory(&directory)?;
        cleanup_locked(&directory, current_unix_ms())?;
        let mut records = load_records(&directory)?
            .into_iter()
            .filter(|record| record.snapshot.task_id == task_id)
            .map(|record| record.snapshot)
            .collect::<Vec<_>>();
        records.sort_by_key(|record| record.created_at_unix_ms);
        Ok(records)
    }

    pub(super) fn load_for_restore(
        &self,
        root: &Path,
        task_id: &str,
        checkpoint_id: &str,
    ) -> Result<
        (
            AgentFileCheckpointV3,
            Option<Vec<u8>>,
            CheckpointOriginalMetadataV3,
        ),
        String,
    > {
        validate_checkpoint_id(checkpoint_id)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "checkpoint store is unavailable".to_string())?;
        let directory = checkpoint_directory(root);
        let record = read_record(&directory, checkpoint_id)?;
        if record.snapshot.task_id != task_id {
            return Err("checkpoint belongs to another task".into());
        }
        if record.snapshot.expires_at_unix_ms <= current_unix_ms() {
            return Err("checkpoint has expired".into());
        }
        let content = match record.backup_file.as_deref() {
            Some(file_name) => {
                validate_backup_file(file_name, checkpoint_id)?;
                let bytes = read_bounded(&directory.join(file_name), MAX_CHECKPOINT_FILE_BYTES)?;
                if record.snapshot.original_sha256.as_deref() != Some(sha256_hex(&bytes).as_str()) {
                    return Err("checkpoint backup digest verification failed".into());
                }
                Some(bytes)
            }
            None => None,
        };
        Ok((
            record.snapshot,
            content,
            CheckpointOriginalMetadataV3 {
                permissions: record.permissions,
                modified_unix_ms: record.modified_unix_ms,
            },
        ))
    }

    pub(super) fn mark_restored(
        &self,
        root: &Path,
        checkpoint_id: &str,
    ) -> Result<AgentFileCheckpointV3, String> {
        validate_checkpoint_id(checkpoint_id)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "checkpoint store is unavailable".to_string())?;
        let directory = checkpoint_directory(root);
        let mut record = read_record(&directory, checkpoint_id)?;
        record.snapshot.restored_at_unix_ms = Some(current_unix_ms());
        write_record(&directory, &record)?;
        Ok(record.snapshot)
    }
}

fn checkpoint_directory(root: &Path) -> PathBuf {
    root.join("agent-v3-checkpoints")
}

fn prepare_checkpoint_directory(directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("failed to prepare checkpoint directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("failed to restrict checkpoint directory: {error}"))?;
    }
    Ok(())
}

fn write_private_atomic(directory: &Path, file_name: &str, content: &[u8]) -> Result<(), String> {
    let mut temp = NamedTempFile::new_in(directory)
        .map_err(|error| format!("failed to create checkpoint temp file: {error}"))?;
    temp.write_all(content)
        .and_then(|()| temp.as_file().sync_all())
        .map_err(|error| format!("failed to write checkpoint backup: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to restrict checkpoint backup: {error}"))?;
    }
    temp.persist(directory.join(file_name))
        .map_err(|error| format!("failed to persist checkpoint backup: {}", error.error))?;
    Ok(())
}

fn write_record(directory: &Path, record: &PersistedCheckpointV3) -> Result<(), String> {
    let bytes = serde_json::to_vec(record)
        .map_err(|error| format!("failed to encode checkpoint metadata: {error}"))?;
    write_private_atomic(
        directory,
        &format!("{}.json", record.snapshot.checkpoint_id),
        &bytes,
    )
}

fn read_record(directory: &Path, checkpoint_id: &str) -> Result<PersistedCheckpointV3, String> {
    let bytes = read_bounded(&directory.join(format!("{checkpoint_id}.json")), 64 * 1024)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("checkpoint metadata is invalid: {error}"))
}

fn load_records(directory: &Path) -> Result<Vec<PersistedCheckpointV3>, String> {
    let mut records = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("failed to inspect checkpoint directory: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("failed to inspect checkpoint entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let bytes = read_bounded(&path, 64 * 1024)?;
        let record: PersistedCheckpointV3 = serde_json::from_slice(&bytes)
            .map_err(|error| format!("checkpoint metadata is invalid: {error}"))?;
        validate_checkpoint_id(&record.snapshot.checkpoint_id)?;
        records.push(record);
    }
    Ok(records)
}

fn cleanup_locked(directory: &Path, now: u64) -> Result<(), String> {
    for record in load_records(directory)? {
        if record.snapshot.expires_at_unix_ms <= now {
            remove_record_files(directory, &record)?;
        }
    }
    Ok(())
}

fn enforce_capacity_locked(directory: &Path) -> Result<(), String> {
    let mut records = load_records(directory)?;
    records.sort_by_key(|record| record.snapshot.created_at_unix_ms);
    let mut total_bytes = records
        .iter()
        .map(|record| record.snapshot.original_byte_length)
        .sum::<u64>();
    while records.len() > MAX_CHECKPOINTS || total_bytes > MAX_CHECKPOINT_BYTES {
        let record = records.remove(0);
        total_bytes = total_bytes.saturating_sub(record.snapshot.original_byte_length);
        remove_record_files(directory, &record)?;
    }
    Ok(())
}

fn remove_record_files(directory: &Path, record: &PersistedCheckpointV3) -> Result<(), String> {
    if let Some(file_name) = record.backup_file.as_deref() {
        validate_backup_file(file_name, &record.snapshot.checkpoint_id)?;
        match fs::remove_file(directory.join(file_name)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to remove checkpoint backup: {error}")),
        }
    }
    match fs::remove_file(directory.join(format!("{}.json", record.snapshot.checkpoint_id))) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to remove checkpoint metadata: {error}")),
    }
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect checkpoint file: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > limit {
        return Err("checkpoint file failed native bounds validation".into());
    }
    let mut file =
        File::open(path).map_err(|error| format!("failed to open checkpoint file: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::io::Read::by_ref(&mut file)
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read checkpoint file: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err("checkpoint file exceeded the native read limit".into());
    }
    Ok(bytes)
}

fn validate_checkpoint_id(value: &str) -> Result<(), String> {
    if value.starts_with("checkpoint-")
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        Ok(())
    } else {
        Err("invalid checkpoint id".into())
    }
}

fn validate_backup_file(file_name: &str, checkpoint_id: &str) -> Result<(), String> {
    if file_name == format!("{checkpoint_id}.bin") {
        Ok(())
    } else {
        Err("checkpoint backup path is invalid".into())
    }
}

pub(super) fn sha256_hex(content: &[u8]) -> String {
    Sha256::digest(content)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn current_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_round_trip_is_bounded_and_digest_verified() {
        let directory = tempfile::tempdir().unwrap();
        let store = CheckpointStoreV3::default();
        let checkpoint = store
            .create(
                directory.path(),
                "task-1",
                "local-1",
                CheckpointTargetKindV3::Local,
                "config.txt",
                Some(b"before"),
                CheckpointOriginalMetadataV3::default(),
            )
            .unwrap();
        let (loaded, content, _) = store
            .load_for_restore(directory.path(), "task-1", &checkpoint.checkpoint_id)
            .unwrap();
        assert_eq!(loaded, checkpoint);
        assert_eq!(content.as_deref(), Some(b"before".as_slice()));
        assert_eq!(store.list(directory.path(), "task-1").unwrap().len(), 1);
    }

    #[test]
    fn checkpoint_ids_cannot_escape_the_store() {
        let directory = tempfile::tempdir().unwrap();
        let store = CheckpointStoreV3::default();
        assert!(store
            .load_for_restore(directory.path(), "task-1", "../outside")
            .is_err());
    }
}
