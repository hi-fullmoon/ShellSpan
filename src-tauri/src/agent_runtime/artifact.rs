use std::collections::HashSet;
use std::fs::{self, File};
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
const ARTIFACT_STORE_VERSION: u8 = 2;
const ARTIFACT_STORE_FORMAT_FILE: &str = "format.json";
pub(crate) const AGENT_REPLAY_ARTIFACT_KIND: &str = "assistant-replay";
pub(crate) const AGENT_REPLAY_ARTIFACT_MEDIA_TYPE: &str =
    "application/vnd.shellspan.agent-replay+zstd";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ArtifactStoreFormat {
    version: u8,
}

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

#[derive(Debug, Clone, Copy, Default)]
struct ArtifactQuota {
    artifact_count: usize,
    replay_count: usize,
    total_bytes: u64,
}

#[derive(Default)]
struct AgentArtifactStoreState {
    root: Option<PathBuf>,
    quota: Option<ArtifactQuota>,
}

#[derive(Clone, Default)]
pub(crate) struct AgentArtifactStore {
    state: Arc<Mutex<AgentArtifactStoreState>>,
}

impl AgentArtifactStore {
    pub(crate) fn configure(&self, app_data_root: &Path) -> Result<(), String> {
        let root = app_data_root.join("agent-runtime").join("artifacts");
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
                prepare_store_format(&root)?;
                let (artifact_count, replay_count, total_bytes) = inspect_artifact_bounds(&root)?;
                state.root = Some(root);
                state.quota = Some(ArtifactQuota {
                    artifact_count,
                    replay_count,
                    total_bytes,
                });
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
            self.ensure_capacity_cached(&root, bytes.len() as u64, kind)?;
            let stage_dir = root.parent().unwrap_or(&session_root);
            match write_private_exclusive_checked(stage_dir, &path, bytes) {
                Ok(true) => {
                    if let Err(error) = sync_parent(&path) {
                        self.invalidate_quota();
                        return Err(error);
                    }
                    self.record_added_quota(bytes.len() as u64, kind);
                }
                Ok(false) => {
                    // Concurrent writer created the same content-addressed file.
                    let existing = read_bounded(&path, MAX_ARTIFACT_BYTES)?;
                    if sha256_hex(&existing) != sha256 {
                        self.invalidate_quota();
                        return Err(
                            "existing Agent artifact failed content-address verification".into(),
                        );
                    }
                }
                Err(error) => {
                    self.invalidate_quota();
                    return Err(error);
                }
            }
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
        validate_identifier(session_id, "sessionId")?;
        validate_identifier(&metadata.artifact_id, "artifactId")?;
        let path = self
            .root()?
            .join(session_id)
            .join(format!("{}.bin", metadata.artifact_id));
        let file_metadata = match fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err("Agent artifact is missing".into());
            }
            Err(error) => return Err(format!("failed to inspect Agent artifact: {error}")),
        };
        if file_metadata.file_type().is_symlink()
            || !file_metadata.is_file()
            || file_metadata.len() != metadata.size_bytes
            || file_metadata.len() > MAX_ARTIFACT_BYTES
        {
            return Err("Agent artifact was tampered".into());
        }
        let mut file =
            File::open(&path).map_err(|error| format!("failed to read Agent artifact: {error}"))?;
        let mut hasher = Sha256::new();
        let mut output = Vec::with_capacity((file_metadata.len() as usize).min(max_bytes));
        let mut total_read = 0_u64;
        let mut chunk = [0_u8; 64 * 1024];
        loop {
            let n = file
                .read(&mut chunk)
                .map_err(|error| format!("failed to read Agent artifact: {error}"))?;
            if n == 0 {
                break;
            }
            total_read = total_read.saturating_add(n as u64);
            if total_read > MAX_ARTIFACT_BYTES {
                return Err("Agent artifact was tampered".into());
            }
            hasher.update(&chunk[..n]);
            if output.len() < max_bytes {
                let remaining = max_bytes - output.len();
                output.extend_from_slice(&chunk[..n.min(remaining)]);
            }
        }
        if total_read != metadata.size_bytes || hex::encode(hasher.finalize()) != metadata.sha256 {
            return Err("Agent artifact was tampered".into());
        }
        Ok(output)
    }

    pub(crate) fn copy_tool_result(
        &self,
        source_session_id: &str,
        target_session_id: &str,
        metadata: &AgentArtifactMetadata,
    ) -> Result<(AgentArtifactMetadata, Vec<u8>), String> {
        if !matches!(metadata.kind.as_str(), "tool-result" | "model-tool-result") {
            return Err("Only tool-result artifacts can be inherited".into());
        }
        let bytes = self.retrieve(source_session_id, metadata, metadata.size_bytes as usize)?;
        std::str::from_utf8(&bytes).map_err(|_| "Inherited tool result is not UTF-8")?;
        let copied = self.store_bytes(
            target_session_id,
            &metadata.kind,
            &metadata.title,
            &metadata.media_type,
            &bytes,
            metadata.sensitivity,
        )?;
        if copied.artifact_id != metadata.artifact_id || copied.sha256 != metadata.sha256 {
            return Err("Inherited tool-result identity changed".into());
        }
        Ok((copied, bytes))
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
            if session_entry.file_name() == ARTIFACT_STORE_FORMAT_FILE
                || is_ignorable_os_metadata_entry(&session_entry)?
            {
                continue;
            }
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
                if is_ignorable_os_metadata_entry(&artifact_entry)? {
                    continue;
                }
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
                        self.invalidate_quota();
                        format!("failed to remove expired Agent artifact: {error}")
                    })?;
                    removed = removed.saturating_add(1);
                }
            }
        }
        if removed > 0 {
            self.invalidate_quota();
        }
        Ok(removed)
    }

    fn ensure_capacity_cached(
        &self,
        root: &Path,
        additional: u64,
        kind: &str,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Agent artifact store is unavailable".to_string())?;
        let quota = match state.quota {
            Some(quota) => quota,
            None => {
                let (artifact_count, replay_count, total_bytes) = inspect_artifact_bounds(root)?;
                let scanned = ArtifactQuota {
                    artifact_count,
                    replay_count,
                    total_bytes,
                };
                state.quota = Some(scanned);
                scanned
            }
        };
        let count_exhausted = if kind == AGENT_REPLAY_ARTIFACT_KIND {
            quota.replay_count >= MAX_REPLAY_ARTIFACT_COUNT
        } else {
            quota.artifact_count >= MAX_ARTIFACT_COUNT
        };
        if count_exhausted
            || quota.total_bytes.saturating_add(additional) > MAX_TOTAL_ARTIFACT_BYTES
        {
            return Err("Agent artifact store reached its lifecycle boundary".into());
        }
        Ok(())
    }

    fn record_added_quota(&self, size: u64, kind: &str) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(quota) = state.quota.as_mut() {
                if kind == AGENT_REPLAY_ARTIFACT_KIND {
                    quota.replay_count = quota.replay_count.saturating_add(1);
                } else {
                    quota.artifact_count = quota.artifact_count.saturating_add(1);
                }
                quota.total_bytes = quota.total_bytes.saturating_add(size);
            }
        }
    }

    fn invalidate_quota(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.quota = None;
        }
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

fn prepare_store_format(root: &Path) -> Result<(), String> {
    let path = root.join(ARTIFACT_STORE_FORMAT_FILE);
    match fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut occupied = false;
            for entry in fs::read_dir(root)
                .map_err(|error| format!("failed to inspect Agent artifact root: {error}"))?
            {
                let entry = entry
                    .map_err(|error| format!("failed to inspect Agent artifact root: {error}"))?;
                if !is_ignorable_os_metadata_entry(&entry)? {
                    occupied = true;
                    break;
                }
            }
            if occupied {
                // Another initializer may have published the format after our first check.
                // Existing data alone never establishes a format version.
                match fs::symlink_metadata(&path) {
                    Ok(_) => return validate_store_format(&path),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        return Err(
                            "Agent artifact format metadata is missing from a non-empty store"
                                .into(),
                        );
                    }
                    Err(error) => {
                        return Err(format!("failed to inspect Agent artifact format: {error}"));
                    }
                }
            }
            // Publish a complete, synced manifest without replacing an existing one.
            // Stage outside the store so artifact enumeration never sees the temp file.
            let parent = root.parent().ok_or("Agent artifact root has no parent")?;
            let mut temporary = tempfile::NamedTempFile::new_in(parent)
                .map_err(|error| format!("failed to stage Agent artifact format: {error}"))?;
            serde_json::to_writer(
                &mut temporary,
                &ArtifactStoreFormat {
                    version: ARTIFACT_STORE_VERSION,
                },
            )
            .map_err(|error| format!("failed to encode Agent artifact format: {error}"))?;
            temporary
                .as_file()
                .sync_all()
                .map_err(|error| format!("failed to flush Agent artifact format: {error}"))?;
            match temporary.persist_noclobber(&path) {
                Ok(_) => sync_parent(&path)?,
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(format!("failed to persist Agent artifact format: {error}"));
                }
            }
        }
        Err(error) => return Err(format!("failed to inspect Agent artifact format: {error}")),
    }
    validate_store_format(&path)
}

fn validate_store_format(path: &Path) -> Result<(), String> {
    let format: ArtifactStoreFormat = serde_json::from_slice(&read_bounded(path, 1024)?)
        .map_err(|error| format!("invalid Agent artifact format: {error}"))?;
    if format.version != ARTIFACT_STORE_VERSION {
        return Err(format!(
            "Agent artifact format version {} is unsupported; expected {ARTIFACT_STORE_VERSION}",
            format.version
        ));
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

fn write_private_exclusive_checked(
    stage_dir: &Path,
    path: &Path,
    bytes: &[u8],
) -> Result<bool, String> {
    // Stage outside the artifact store root so quota scans never see temp files
    // and publish via persist_noclobber so concurrent readers never observe partial writes.
    let mut temporary = tempfile::Builder::new()
        .prefix(".artifact-stage-")
        .tempfile_in(stage_dir)
        .map_err(|error| format!("failed to stage Agent artifact: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to restrict staged Agent artifact: {error}"))?;
    }
    temporary
        .write_all(bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|error| format!("failed to persist Agent artifact: {error}"))?;
    match temporary.persist_noclobber(path) {
        Ok(_) => Ok(true),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(format!("failed to publish Agent artifact: {}", error.error)),
    }
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

fn inspect_artifact_bounds(root: &Path) -> Result<(usize, usize, u64), String> {
    let mut artifact_count = 0_usize;
    let mut replay_count = 0_usize;
    let mut bytes = 0_u64;
    for session in fs::read_dir(root)
        .map_err(|error| format!("failed to inspect Agent artifact root: {error}"))?
    {
        let session = session
            .map_err(|error| format!("failed to inspect Agent artifact session: {error}"))?;
        if session.file_name() == ARTIFACT_STORE_FORMAT_FILE
            || is_ignorable_os_metadata_entry(&session)?
        {
            continue;
        }
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
            if is_ignorable_os_metadata_entry(&entry)? {
                continue;
            }
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

fn is_os_metadata_file_name(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_some_and(|value| {
        value == ".DS_Store"
            || value.eq_ignore_ascii_case("Thumbs.db")
            || value.eq_ignore_ascii_case("desktop.ini")
    })
}

fn is_ignorable_os_metadata_entry(entry: &fs::DirEntry) -> Result<bool, String> {
    if !is_os_metadata_file_name(&entry.file_name()) {
        return Ok(false);
    }
    let file_type = entry
        .file_type()
        .map_err(|error| format!("failed to inspect Agent artifact entry: {error}"))?;
    Ok(file_type.is_file() && !file_type.is_symlink())
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
    fn artifact_format_initializes_an_existing_empty_directory() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("agent-runtime/artifacts");
        fs::create_dir_all(&directory).unwrap();
        let store = AgentArtifactStore::default();
        store.configure(root.path()).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(directory.join("format.json")).unwrap())
                .unwrap(),
            serde_json::json!({"version": 2})
        );
        assert_eq!(inspect_artifact_bounds(&directory).unwrap(), (0, 0, 0));
    }

    #[test]
    fn missing_artifact_format_rejects_populated_storage_without_modifying_data() {
        let root = tempfile::tempdir().unwrap();
        let original = AgentArtifactStore::default();
        original.configure(root.path()).unwrap();
        let metadata = original
            .store_text(
                "session-1",
                "summary",
                "summary",
                include_str!("artifact.rs"),
            )
            .unwrap();
        let artifact = original.path_for_test("session-1", &metadata.artifact_id);
        let bytes = fs::read(&artifact).unwrap();
        let directory = root.path().join("agent-runtime/artifacts");
        let manifest = directory.join("format.json");
        let saved_manifest = root.path().join("saved-format.json");
        fs::rename(&manifest, &saved_manifest).unwrap();
        drop(original);

        let reopened = AgentArtifactStore::default();
        for _ in 0..2 {
            assert_eq!(
                reopened.configure(root.path()).unwrap_err(),
                "Agent artifact format metadata is missing from a non-empty store"
            );
            assert!(!manifest.exists());
            assert_eq!(fs::read(&artifact).unwrap(), bytes);
            assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
            assert!(reopened.root().is_err());
        }

        fs::rename(&saved_manifest, &manifest).unwrap();
        reopened.configure(root.path()).unwrap();
        assert_eq!(
            reopened.verify("session-1", &metadata).unwrap(),
            AgentArtifactIntegrity::Verified
        );
    }

    #[test]
    fn missing_artifact_format_rejects_even_empty_session_directories() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("agent-runtime/artifacts");
        fs::create_dir_all(directory.join("session-1")).unwrap();
        assert_eq!(
            AgentArtifactStore::default()
                .configure(root.path())
                .unwrap_err(),
            "Agent artifact format metadata is missing from a non-empty store"
        );
        assert!(!directory.join("format.json").exists());
        assert!(directory.join("session-1").is_dir());
    }

    #[test]
    fn artifact_format_is_internal_and_survives_reopen_and_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let store = AgentArtifactStore::default();
        store.configure(root.path()).unwrap();
        let directory = root.path().join("agent-runtime/artifacts");
        let manifest = directory.join("format.json");
        let encoded = fs::read(&manifest).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&encoded).unwrap(),
            serde_json::json!({"version": 2})
        );
        let metadata = store
            .store_text(
                "session-1",
                "summary",
                "summary",
                include_str!("artifact.rs"),
            )
            .unwrap();
        assert_eq!(
            inspect_artifact_bounds(&directory).unwrap(),
            (1, 0, metadata.size_bytes)
        );
        let reopened = AgentArtifactStore::default();
        reopened.configure(root.path()).unwrap();
        assert_eq!(
            reopened.verify("session-1", &metadata).unwrap(),
            AgentArtifactIntegrity::Verified
        );
        let referenced = HashSet::from([("session-1".to_string(), metadata.artifact_id)]);
        assert_eq!(reopened.cleanup_unreferenced(&referenced).unwrap(), 0);
        assert_eq!(fs::read(&manifest).unwrap(), encoded);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(manifest).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn artifact_format_rejects_unknown_malformed_and_oversized_metadata_without_rewriting() {
        let root = tempfile::tempdir().unwrap();
        AgentArtifactStore::default()
            .configure(root.path())
            .unwrap();
        let manifest = root.path().join("agent-runtime/artifacts/format.json");
        for encoded in [
            serde_json::to_vec(&serde_json::json!({"version": 255})).unwrap(),
            b"{}".to_vec(),
            b"{\"version\":".to_vec(),
            vec![b' '; 1025],
        ] {
            fs::write(&manifest, &encoded).unwrap();
            assert!(AgentArtifactStore::default()
                .configure(root.path())
                .is_err());
            assert_eq!(fs::read(&manifest).unwrap(), encoded);
        }
    }

    #[cfg(unix)]
    #[test]
    fn artifact_format_rejects_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("agent-runtime/artifacts");
        fs::create_dir_all(&directory).unwrap();
        let outside = root.path().join("outside.json");
        let encoded = serde_json::to_vec(&serde_json::json!({"version": 2})).unwrap();
        fs::write(&outside, &encoded).unwrap();
        std::os::unix::fs::symlink(&outside, directory.join("format.json")).unwrap();
        assert!(AgentArtifactStore::default()
            .configure(root.path())
            .is_err());
        assert_eq!(fs::read(outside).unwrap(), encoded);
    }

    #[test]
    fn concurrent_artifact_configuration_publishes_one_complete_format() {
        let root = tempfile::tempdir().unwrap();
        let barrier = std::sync::Barrier::new(4);
        std::thread::scope(|scope| {
            let handles = (0..4)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        AgentArtifactStore::default()
                            .configure(root.path())
                            .unwrap();
                    })
                })
                .collect::<Vec<_>>();
            for handle in handles {
                handle.join().unwrap();
            }
        });
        let format: ArtifactStoreFormat = serde_json::from_slice(
            &fs::read(root.path().join("agent-runtime/artifacts/format.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(format.version, ARTIFACT_STORE_VERSION);
    }

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

    #[test]
    fn os_metadata_files_are_ignored_in_artifact_root_and_session_directories() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("agent-runtime/artifacts");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(".DS_Store"), b"finder-metadata").unwrap();
        fs::write(directory.join("Thumbs.db"), b"explorer-metadata").unwrap();
        fs::write(directory.join("desktop.ini"), b"[.ShellClassInfo]").unwrap();

        let store = AgentArtifactStore::default();
        store.configure(root.path()).unwrap();
        let metadata = store
            .store_text("session-1", "summary", "summary", "bounded evidence")
            .unwrap();
        fs::write(directory.join("session-1/.DS_Store"), b"session-metadata").unwrap();

        assert_eq!(
            inspect_artifact_bounds(&directory).unwrap(),
            (1, 0, metadata.size_bytes)
        );
        let reopened = AgentArtifactStore::default();
        reopened.configure(root.path()).unwrap();
        let referenced = HashSet::from([("session-1".to_string(), metadata.artifact_id)]);
        assert_eq!(reopened.cleanup_unreferenced(&referenced).unwrap(), 0);
        assert!(directory.join(".DS_Store").is_file());
        assert!(directory.join("session-1/.DS_Store").is_file());
    }

    #[test]
    fn unexpected_non_metadata_files_in_artifact_root_still_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let store = AgentArtifactStore::default();
        store.configure(root.path()).unwrap();
        fs::write(
            root.path().join("agent-runtime/artifacts/stray.txt"),
            b"unexpected",
        )
        .unwrap();

        assert_eq!(
            AgentArtifactStore::default()
                .configure(root.path())
                .unwrap_err(),
            "Agent artifact root contains an unsafe entry"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_os_metadata_name_in_artifact_store_still_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let store = AgentArtifactStore::default();
        store.configure(root.path()).unwrap();
        let outside = root.path().join("outside.bin");
        fs::write(&outside, b"outside").unwrap();
        let directory = root.path().join("agent-runtime/artifacts");
        std::os::unix::fs::symlink(&outside, directory.join(".DS_Store")).unwrap();

        assert_eq!(
            AgentArtifactStore::default()
                .configure(root.path())
                .unwrap_err(),
            "Agent artifact root contains an unsafe entry"
        );
    }

    #[test]
    fn concurrent_writes_of_identical_artifact_never_fail_content_verification() {
        let root = tempfile::tempdir().unwrap();
        let store = AgentArtifactStore::default();
        store.configure(root.path()).unwrap();
        let payload = vec![b'z'; 256 * 1024];
        std::thread::scope(|scope| {
            let mut handles = Vec::new();
            for _ in 0..8 {
                let store = store.clone();
                let payload = payload.as_slice();
                handles.push(scope.spawn(move || {
                    store
                        .store_bytes(
                            "session-concurrent",
                            "summary",
                            "concurrent payload",
                            "application/octet-stream",
                            payload,
                            AgentArtifactSensitivity::Internal,
                        )
                        .unwrap()
                }));
            }
            let first = handles.remove(0).join().unwrap();
            for handle in handles {
                let next = handle.join().unwrap();
                assert_eq!(next.artifact_id, first.artifact_id);
                assert_eq!(next.sha256, first.sha256);
            }
        });
    }
}
