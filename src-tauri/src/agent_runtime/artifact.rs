use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::redaction::{redact_json_value, redact_sensitive_text};

const MAX_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ARTIFACT_COUNT: usize = 2_048;
const MAX_REPLAY_ARTIFACT_COUNT: usize = 32_768;
const MAX_TOTAL_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const ARTIFACT_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
pub(crate) const AGENT_REPLAY_ARTIFACT_KIND: &str = "assistant-replay";
pub(crate) const AGENT_REPLAY_ARTIFACT_MEDIA_TYPE: &str =
    "application/vnd.shellspan.agent-replay+zstd";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentArtifactSensitivity {
    Internal,
    SensitiveRedacted,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentArtifactMetadata {
    pub(crate) artifact_id: String,
    pub(crate) kind: String,
    pub(crate) title: String,
    pub(crate) media_type: String,
    pub(crate) sha256: String,
    pub(crate) size_bytes: u64,
    pub(crate) sensitivity: AgentArtifactSensitivity,
    pub(crate) created_at_unix_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentArtifactRequest {
    pub(crate) session_id: String,
    pub(crate) artifact_id: String,
    pub(crate) max_bytes: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentArtifactResponse {
    pub(crate) metadata: AgentArtifactMetadata,
    pub(crate) body_base64: String,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentArtifactIntegrity {
    Verified,
    Missing,
    Tampered,
}

#[derive(Default)]
struct AgentArtifactStoreState {
    root: Option<PathBuf>,
}

#[derive(Clone, Default)]
pub(crate) struct AgentArtifactStore {
    state: Arc<Mutex<AgentArtifactStoreState>>,
}

impl AgentArtifactStore {
    pub(crate) fn configure(&self, app_data_root: &Path) -> Result<(), String> {
        let root = app_data_root.join("agent-runtime").join("artifacts-v2");
        prepare_private_directory(&root)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Agent artifact store is unavailable".to_string())?;
        match state.root.as_ref() {
            Some(existing) if existing != &root => {
                Err("Agent artifact root changed after initialization".into())
            }
            Some(_) => Ok(()),
            None => {
                inspect_artifact_bounds(&root)?;
                state.root = Some(root);
                Ok(())
            }
        }
    }

    pub(crate) fn store_json(
        &self,
        session_id: &str,
        kind: &str,
        title: &str,
        value: &Value,
    ) -> Result<AgentArtifactMetadata, String> {
        let redacted = redact_json_value(value);
        let sensitivity = if &redacted == value {
            AgentArtifactSensitivity::Internal
        } else {
            AgentArtifactSensitivity::SensitiveRedacted
        };
        let bytes = serde_json::to_vec(&redacted)
            .map_err(|error| format!("failed to encode Agent artifact: {error}"))?;
        self.store_bytes(
            session_id,
            kind,
            title,
            "application/json",
            &bytes,
            sensitivity,
        )
    }

    pub(crate) fn store_replay(
        &self,
        session_id: &str,
        replay: &crate::llm::replay::ReplayEnvelopeV5,
    ) -> Result<AgentArtifactMetadata, String> {
        let bytes = serde_json::to_vec(replay)
            .map_err(|error| format!("failed to encode Agent replay artifact: {error}"))?;
        if bytes.len() as u64 > MAX_ARTIFACT_BYTES {
            return Err("Agent replay artifact exceeds its decoded byte boundary".into());
        }
        let compressed = zstd::stream::encode_all(bytes.as_slice(), 3)
            .map_err(|error| format!("failed to compress Agent replay artifact: {error}"))?;
        self.store_bytes(
            session_id,
            AGENT_REPLAY_ARTIFACT_KIND,
            "Private assistant replay metadata",
            AGENT_REPLAY_ARTIFACT_MEDIA_TYPE,
            &compressed,
            AgentArtifactSensitivity::Internal,
        )
    }

    pub(crate) fn retrieve_replay(
        &self,
        session_id: &str,
        metadata: &AgentArtifactMetadata,
    ) -> Result<crate::llm::replay::ReplayEnvelopeV5, String> {
        validate_replay_metadata(metadata)?;
        let limit = usize::try_from(metadata.size_bytes)
            .map_err(|_| "Agent replay artifact size is not addressable".to_string())?;
        let compressed = self.retrieve(session_id, metadata, limit)?;
        if compressed.len() as u64 != metadata.size_bytes {
            return Err("Agent replay artifact was not retrieved in full".into());
        }
        let decoder = zstd::stream::read::Decoder::new(compressed.as_slice())
            .map_err(|error| format!("Agent replay artifact compression is invalid: {error}"))?;
        let mut bytes = Vec::new();
        decoder
            .take(MAX_ARTIFACT_BYTES.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|error| format!("failed to decode Agent replay artifact: {error}"))?;
        if bytes.len() as u64 > MAX_ARTIFACT_BYTES {
            return Err("Agent replay artifact exceeds its decoded byte boundary".into());
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("Agent replay artifact is invalid: {error}"))
    }

    #[cfg(test)]
    pub(crate) fn store_text(
        &self,
        session_id: &str,
        kind: &str,
        title: &str,
        content: &str,
    ) -> Result<AgentArtifactMetadata, String> {
        let redacted = redact_sensitive_text(content);
        let sensitivity = if redacted == content {
            AgentArtifactSensitivity::Internal
        } else {
            AgentArtifactSensitivity::SensitiveRedacted
        };
        self.store_bytes(
            session_id,
            kind,
            title,
            "text/plain; charset=utf-8",
            redacted.as_bytes(),
            sensitivity,
        )
    }

    fn store_bytes(
        &self,
        session_id: &str,
        kind: &str,
        title: &str,
        media_type: &str,
        bytes: &[u8],
        sensitivity: AgentArtifactSensitivity,
    ) -> Result<AgentArtifactMetadata, String> {
        validate_identifier(session_id, "sessionId")?;
        validate_label(kind, "artifact kind")?;
        validate_label(title, "artifact title")?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_ARTIFACT_BYTES {
            return Err("Agent artifact is empty or exceeds its byte boundary".into());
        }
        let root = self.root()?;
        let session_root = root.join(session_id);
        prepare_private_directory(&session_root)?;
        let sha256 = sha256_hex(bytes);
        let prefix = if kind == AGENT_REPLAY_ARTIFACT_KIND {
            "replay"
        } else {
            "artifact"
        };
        let artifact_id = format!("{prefix}-{}", &sha256[..32]);
        let path = session_root.join(format!("{artifact_id}.bin"));
        if path.exists() {
            let existing = read_bounded(&path, MAX_ARTIFACT_BYTES)?;
            if sha256_hex(&existing) != sha256 {
                return Err("existing Agent artifact failed content-address verification".into());
            }
        } else {
            ensure_capacity(&root, bytes.len() as u64, kind)?;
            write_private_exclusive(&path, bytes)?;
            sync_parent(&path)?;
        }
        Ok(AgentArtifactMetadata {
            artifact_id,
            kind: kind.to_string(),
            title: redact_sensitive_text(title),
            media_type: media_type.to_string(),
            sha256,
            size_bytes: bytes.len() as u64,
            sensitivity,
            created_at_unix_ms: current_unix_ms().max(1),
        })
    }

    pub(crate) fn verify(
        &self,
        session_id: &str,
        metadata: &AgentArtifactMetadata,
    ) -> Result<AgentArtifactIntegrity, String> {
        validate_identifier(session_id, "sessionId")?;
        validate_identifier(&metadata.artifact_id, "artifactId")?;
        let path = self
            .root()?
            .join(session_id)
            .join(format!("{}.bin", metadata.artifact_id));
        let file_metadata = match fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(AgentArtifactIntegrity::Missing)
            }
            Err(error) => return Err(format!("failed to inspect Agent artifact: {error}")),
        };
        if file_metadata.file_type().is_symlink()
            || !file_metadata.is_file()
            || file_metadata.len() != metadata.size_bytes
            || file_metadata.len() > MAX_ARTIFACT_BYTES
        {
            return Ok(AgentArtifactIntegrity::Tampered);
        }
        let bytes = read_bounded(&path, MAX_ARTIFACT_BYTES)?;
        if sha256_hex(&bytes) == metadata.sha256 {
            Ok(AgentArtifactIntegrity::Verified)
        } else {
            Ok(AgentArtifactIntegrity::Tampered)
        }
    }

    pub(crate) fn retrieve(
        &self,
        session_id: &str,
        metadata: &AgentArtifactMetadata,
        max_bytes: usize,
    ) -> Result<Vec<u8>, String> {
        if max_bytes == 0 || max_bytes as u64 > MAX_ARTIFACT_BYTES {
            return Err("Agent artifact retrieval limit is invalid".into());
        }
        match self.verify(session_id, metadata)? {
            AgentArtifactIntegrity::Verified => {}
            AgentArtifactIntegrity::Missing => return Err("Agent artifact is missing".into()),
            AgentArtifactIntegrity::Tampered => return Err("Agent artifact was tampered".into()),
        }
        let path = self
            .root()?
            .join(session_id)
            .join(format!("{}.bin", metadata.artifact_id));
        let mut bytes = read_bounded(&path, MAX_ARTIFACT_BYTES)?;
        bytes.truncate(max_bytes);
        Ok(bytes)
    }

    pub(crate) fn cleanup_unreferenced(
        &self,
        referenced: &HashSet<(String, String)>,
    ) -> Result<usize, String> {
        let root = self.root()?;
        let now = current_unix_ms();
        let mut removed = 0_usize;
        for session_entry in fs::read_dir(&root)
            .map_err(|error| format!("failed to inspect Agent artifact root: {error}"))?
        {
            let session_entry = session_entry
                .map_err(|error| format!("failed to inspect Agent artifact session: {error}"))?;
            if !session_entry
                .file_type()
                .map_err(|error| format!("failed to inspect Agent artifact session: {error}"))?
                .is_dir()
            {
                return Err("Agent artifact root contains a non-directory entry".into());
            }
            let session_id = session_entry.file_name().to_string_lossy().to_string();
            for artifact_entry in fs::read_dir(session_entry.path())
                .map_err(|error| format!("failed to inspect Agent artifacts: {error}"))?
            {
                let artifact_entry = artifact_entry
                    .map_err(|error| format!("failed to inspect Agent artifact: {error}"))?;
                let path = artifact_entry.path();
                let Some(artifact_id) = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .map(str::to_string)
                else {
                    continue;
                };
                let metadata = fs::symlink_metadata(&path)
                    .map_err(|error| format!("failed to inspect Agent artifact: {error}"))?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err("Agent artifact storage contains an unsafe entry".into());
                }
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                    .map(|value| value.as_millis() as u64)
                    .unwrap_or(0);
                if !referenced.contains(&(session_id.clone(), artifact_id))
                    && now.saturating_sub(modified) >= ARTIFACT_RETENTION_MS
                {
                    fs::remove_file(&path).map_err(|error| {
                        format!("failed to remove expired Agent artifact: {error}")
                    })?;
                    removed = removed.saturating_add(1);
                }
            }
        }
        Ok(removed)
    }

    #[cfg(test)]
    pub(crate) fn path_for_test(&self, session_id: &str, artifact_id: &str) -> PathBuf {
        self.root()
            .unwrap()
            .join(session_id)
            .join(format!("{artifact_id}.bin"))
    }

    fn root(&self) -> Result<PathBuf, String> {
        self.state
            .lock()
            .map_err(|_| "Agent artifact store is unavailable".to_string())?
            .root
            .clone()
            .ok_or_else(|| "Agent artifact store is not configured".to_string())
    }
}

pub(crate) fn validate_replay_metadata(metadata: &AgentArtifactMetadata) -> Result<(), String> {
    validate_identifier(&metadata.artifact_id, "artifactId")?;
    if metadata.kind != AGENT_REPLAY_ARTIFACT_KIND
        || metadata.title != "Private assistant replay metadata"
        || metadata.media_type != AGENT_REPLAY_ARTIFACT_MEDIA_TYPE
        || metadata.sensitivity != AgentArtifactSensitivity::Internal
        || metadata.size_bytes == 0
        || metadata.size_bytes > MAX_ARTIFACT_BYTES
        || metadata.sha256.len() != 64
        || !metadata
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err("Agent replay artifact metadata is invalid".into());
    }
    Ok(())
}

fn prepare_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("failed to create Agent artifact directory: {error}"))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect Agent artifact directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Agent artifact directory is not a real directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("failed to restrict Agent artifact directory: {error}"))?;
    }
    Ok(())
}

fn write_private_exclusive(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("failed to create Agent artifact: {error}"))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("failed to persist Agent artifact: {error}"))
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect Agent artifact: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > limit {
        return Err("Agent artifact failed native bounds validation".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|mut file| {
            Read::by_ref(&mut file)
                .take(limit.saturating_add(1))
                .read_to_end(&mut bytes)
        })
        .map_err(|error| format!("failed to read Agent artifact: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err("Agent artifact exceeded native read bounds".into());
    }
    Ok(bytes)
}

fn ensure_capacity(root: &Path, additional: u64, kind: &str) -> Result<(), String> {
    let (artifact_count, replay_count, bytes) = inspect_artifact_bounds(root)?;
    let count_exhausted = if kind == AGENT_REPLAY_ARTIFACT_KIND {
        replay_count >= MAX_REPLAY_ARTIFACT_COUNT
    } else {
        artifact_count >= MAX_ARTIFACT_COUNT
    };
    if count_exhausted || bytes.saturating_add(additional) > MAX_TOTAL_ARTIFACT_BYTES {
        return Err("Agent artifact store reached its lifecycle boundary".into());
    }
    Ok(())
}

fn inspect_artifact_bounds(root: &Path) -> Result<(usize, usize, u64), String> {
    let mut artifact_count = 0_usize;
    let mut replay_count = 0_usize;
    let mut bytes = 0_u64;
    for session in fs::read_dir(root)
        .map_err(|error| format!("failed to inspect Agent artifact root: {error}"))?
    {
        let session = session
            .map_err(|error| format!("failed to inspect Agent artifact session: {error}"))?;
        if !session
            .file_type()
            .map_err(|error| format!("failed to inspect Agent artifact session: {error}"))?
            .is_dir()
        {
            return Err("Agent artifact root contains an unsafe entry".into());
        }
        for entry in fs::read_dir(session.path())
            .map_err(|error| format!("failed to inspect Agent artifacts: {error}"))?
        {
            let entry =
                entry.map_err(|error| format!("failed to inspect Agent artifact: {error}"))?;
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|error| format!("failed to inspect Agent artifact: {error}"))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("Agent artifact storage contains an unsafe entry".into());
            }
            let replay = entry
                .path()
                .file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.starts_with("replay-"));
            if replay {
                replay_count = replay_count.saturating_add(1);
            } else {
                artifact_count = artifact_count.saturating_add(1);
            }
            bytes = bytes.saturating_add(metadata.len());
            if artifact_count > MAX_ARTIFACT_COUNT
                || replay_count > MAX_REPLAY_ARTIFACT_COUNT
                || bytes > MAX_TOTAL_ARTIFACT_BYTES
            {
                return Err("Agent artifact store exceeds its lifecycle boundary".into());
            }
        }
    }
    Ok((artifact_count, replay_count, bytes))
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_label(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 4 * 1024 {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sync_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Agent artifact has no parent directory".to_string())?;
    #[cfg(unix)]
    {
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("failed to flush Agent artifact directory: {error}"))
    }
    #[cfg(not(unix))]
    {
        // Windows cannot open directory handles through std::fs::File without
        // backup-semantics flags. The artifact file itself is already synced.
        let _ = parent;
        Ok(())
    }
}

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifacts_are_content_addressed_redacted_private_and_verified() {
        let root = tempfile::tempdir().unwrap();
        let store = AgentArtifactStore::default();
        store.configure(root.path()).unwrap();
        let first = store
            .store_json(
                "session-1",
                "tool-output",
                "output",
                &serde_json::json!({"token": "plaintext-secret", "value": "ok"}),
            )
            .unwrap();
        let second = store
            .store_json(
                "session-1",
                "tool-output",
                "output",
                &serde_json::json!({"token": "plaintext-secret", "value": "ok"}),
            )
            .unwrap();
        assert_eq!(first.artifact_id, second.artifact_id);
        assert_eq!(first.sha256, second.sha256);
        assert_eq!(
            first.sensitivity,
            AgentArtifactSensitivity::SensitiveRedacted
        );
        let path = store.path_for_test("session-1", &first.artifact_id);
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("plaintext-secret"));
        assert_eq!(
            store.verify("session-1", &first).unwrap(),
            AgentArtifactIntegrity::Verified
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn missing_and_tampered_artifacts_are_distinct_fail_closed_states() {
        let root = tempfile::tempdir().unwrap();
        let store = AgentArtifactStore::default();
        store.configure(root.path()).unwrap();
        let metadata = store
            .store_text("session-1", "summary", "summary", "bounded evidence")
            .unwrap();
        let path = store.path_for_test("session-1", &metadata.artifact_id);
        fs::write(&path, b"tampered evidence").unwrap();
        assert_eq!(
            store.verify("session-1", &metadata).unwrap(),
            AgentArtifactIntegrity::Tampered
        );
        fs::remove_file(path).unwrap();
        assert_eq!(
            store.verify("session-1", &metadata).unwrap(),
            AgentArtifactIntegrity::Missing
        );
    }
}
