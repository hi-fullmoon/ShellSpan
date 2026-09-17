use super::canonicalization::{canonical_json_bytes, canonical_sha256};
use super::compiler::{validate_artifact_handle, validate_artifact_manifest};
use super::node_registry::validate_identifier;
use super::workflow_schema::{ArtifactBundleManifest, ArtifactHandle, MAX_WORKFLOW_JSON_BYTES};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use sysinfo::Disks;

const MANIFEST_REFERENCE_PREFIX: &str = "deployment-artifact:";
const CAS_FREE_SPACE_RESERVE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct ArtifactBlobSource {
    pub digest: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtifactBundleProjection {
    pub handle: ArtifactHandle,
    pub manifest: ArtifactBundleManifest,
    pub component_count: u32,
    pub total_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtifactCleanupResult {
    pub removed_manifests: u32,
    pub removed_blobs: u32,
    pub protected_manifests: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct DeploymentArtifactCas {
    root: PathBuf,
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!(
        "sha256:{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn digest_hex(digest: &str) -> Result<&str, String> {
    let Some(hex) = digest.strip_prefix("sha256:") else {
        return Err("DEPLOYMENT_ARTIFACT_INVALID_DIGEST".into());
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("DEPLOYMENT_ARTIFACT_INVALID_DIGEST".into());
    }
    Ok(hex)
}

fn secure_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("failed to create deployment artifact directory: {error}"))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect deployment artifact directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err("DEPLOYMENT_ARTIFACT_UNSAFE_DIRECTORY".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("failed to secure deployment artifact directory: {error}"))?;
    }
    Ok(())
}

fn secure_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to secure deployment artifact file: {error}"))?;
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("failed to fsync deployment artifact directory: {error}"))?;
    }
    Ok(())
}

fn hash_file(path: &Path, expected_size: u64) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect deployment artifact blob: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("DEPLOYMENT_ARTIFACT_BLOB_NOT_REGULAR_FILE".into());
    }
    if metadata.len() != expected_size {
        return Err("DEPLOYMENT_ARTIFACT_BLOB_SIZE_MISMATCH".into());
    }
    let file = File::open(path)
        .map_err(|error| format!("failed to open deployment artifact blob: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut buffer = [0_u8; 64 * 1024];
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("failed to read deployment artifact blob: {error}"))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "DEPLOYMENT_ARTIFACT_BLOB_SIZE_OVERFLOW".to_string())?;
        if total > expected_size {
            return Err("DEPLOYMENT_ARTIFACT_BLOB_SIZE_MISMATCH".into());
        }
        hasher.update(&buffer[..read]);
    }
    if total != expected_size {
        return Err("DEPLOYMENT_ARTIFACT_BLOB_SIZE_MISMATCH".into());
    }
    let digest = hasher.finalize();
    Ok(format!(
        "sha256:{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn atomic_publish_bytes(directory: &Path, target: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("failed to create deployment artifact staging file: {error}"))?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("failed to fsync deployment artifact staging file: {error}"))?;
    secure_file(temporary.path())?;
    match temporary.persist_noclobber(target) {
        Ok(_) => {
            secure_file(target)?;
            sync_directory(directory)
        }
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(format!(
            "failed to atomically publish deployment artifact file: {}",
            error.error
        )),
    }
}

fn atomic_publish_file(directory: &Path, target: &Path, source: &Path) -> Result<(), String> {
    let mut input = File::open(source)
        .map_err(|error| format!("failed to open deployment artifact source: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("failed to create deployment artifact staging file: {error}"))?;
    std::io::copy(&mut input, &mut temporary)
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("failed to fsync deployment artifact staging file: {error}"))?;
    secure_file(temporary.path())?;
    match temporary.persist_noclobber(target) {
        Ok(_) => {
            secure_file(target)?;
            sync_directory(directory)
        }
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(format!(
            "failed to atomically publish deployment artifact blob: {}",
            error.error
        )),
    }
}

fn content_digest(manifest: &ArtifactBundleManifest) -> Result<String, String> {
    let mut components = manifest.components.clone();
    components.sort_by(|left, right| left.name.cmp(&right.name));
    canonical_sha256(&components).map_err(|error| error.to_string())
}

fn ensure_available_space(path: &Path, required_bytes: u64) -> Result<(), String> {
    let disks = Disks::new_with_refreshed_list();
    let available = disks
        .list()
        .iter()
        .filter(|disk| path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.available_space())
        .ok_or_else(|| "DEPLOYMENT_ARTIFACT_DISK_SPACE_UNKNOWN".to_string())?;
    if required_bytes > available.saturating_sub(CAS_FREE_SPACE_RESERVE_BYTES) {
        return Err("DEPLOYMENT_ARTIFACT_INSUFFICIENT_DISK_SPACE".into());
    }
    Ok(())
}

impl DeploymentArtifactCas {
    pub(crate) fn new(root: PathBuf) -> Result<Self, String> {
        let cas = Self { root };
        cas.initialize()?;
        Ok(cas)
    }

    fn initialize(&self) -> Result<(), String> {
        secure_directory(&self.root)?;
        secure_directory(&self.root.join("manifests"))?;
        secure_directory(&self.manifest_directory())?;
        secure_directory(&self.root.join("blobs"))?;
        secure_directory(&self.blob_directory())?;
        secure_directory(&self.lease_directory())?;
        Ok(())
    }

    fn manifest_directory(&self) -> PathBuf {
        self.root.join("manifests").join("sha256")
    }

    fn blob_directory(&self) -> PathBuf {
        self.root.join("blobs").join("sha256")
    }

    fn lease_directory(&self) -> PathBuf {
        self.root.join("leases")
    }

    fn manifest_path(&self, digest: &str) -> Result<PathBuf, String> {
        Ok(self.manifest_directory().join(digest_hex(digest)?))
    }

    fn blob_path(&self, digest: &str) -> Result<PathBuf, String> {
        Ok(self.blob_directory().join(digest_hex(digest)?))
    }

    pub(crate) fn publish_bundle(
        &self,
        manifest: &ArtifactBundleManifest,
        sources: &[ArtifactBlobSource],
    ) -> Result<ArtifactBundleProjection, String> {
        validate_artifact_manifest(manifest).map_err(|error| error.to_string())?;
        self.initialize()?;
        let manifest_bytes = canonical_json_bytes(manifest).map_err(|error| error.to_string())?;
        if manifest_bytes.len() > MAX_WORKFLOW_JSON_BYTES {
            return Err("DEPLOYMENT_ARTIFACT_MANIFEST_TOO_LARGE".into());
        }
        let manifest_digest = sha256_bytes(&manifest_bytes);
        let content_digest = content_digest(manifest)?;
        let handle = ArtifactHandle {
            artifact_reference: format!("{MANIFEST_REFERENCE_PREFIX}{manifest_digest}"),
            manifest_digest: manifest_digest.clone(),
            content_digest,
        };
        validate_artifact_handle(&handle).map_err(|error| error.to_string())?;

        let source_by_digest = sources
            .iter()
            .map(|source| (source.digest.as_str(), source))
            .collect::<BTreeMap<_, _>>();
        if source_by_digest.len() != sources.len() {
            return Err("DEPLOYMENT_ARTIFACT_DUPLICATE_BLOB_SOURCE".into());
        }
        let required = manifest
            .components
            .iter()
            .map(|component| component.digest.as_str())
            .collect::<BTreeSet<_>>();
        if source_by_digest.keys().copied().collect::<BTreeSet<_>>() != required {
            return Err("DEPLOYMENT_ARTIFACT_BLOB_SET_MISMATCH".into());
        }
        let required_bytes = manifest
            .components
            .iter()
            .filter(|component| {
                self.blob_path(&component.digest)
                    .is_ok_and(|path| !path.exists())
            })
            .try_fold(manifest_bytes.len() as u64, |total, component| {
                total
                    .checked_add(component.size)
                    .ok_or_else(|| "DEPLOYMENT_ARTIFACT_TOTAL_SIZE_OVERFLOW".to_string())
            })?;
        ensure_available_space(&self.root, required_bytes)?;

        for component in &manifest.components {
            let source = source_by_digest
                .get(component.digest.as_str())
                .ok_or_else(|| "DEPLOYMENT_ARTIFACT_BLOB_SET_MISMATCH".to_string())?;
            let actual_digest = hash_file(&source.path, component.size)?;
            if actual_digest != component.digest || source.digest != component.digest {
                return Err("DEPLOYMENT_ARTIFACT_BLOB_DIGEST_MISMATCH".into());
            }
            let target = self.blob_path(&component.digest)?;
            atomic_publish_file(&self.blob_directory(), &target, &source.path)?;
            if hash_file(&target, component.size)? != component.digest {
                return Err("DEPLOYMENT_ARTIFACT_PUBLISHED_BLOB_MISMATCH".into());
            }
        }

        let manifest_path = self.manifest_path(&manifest_digest)?;
        atomic_publish_bytes(&self.manifest_directory(), &manifest_path, &manifest_bytes)?;
        self.inspect(&handle)
    }

    pub(crate) fn inspect(
        &self,
        handle: &ArtifactHandle,
    ) -> Result<ArtifactBundleProjection, String> {
        validate_artifact_handle(handle).map_err(|error| error.to_string())?;
        let expected_reference = format!("{MANIFEST_REFERENCE_PREFIX}{}", handle.manifest_digest);
        if handle.artifact_reference != expected_reference {
            return Err("DEPLOYMENT_ARTIFACT_HANDLE_BINDING_MISMATCH".into());
        }
        let path = self.manifest_path(&handle.manifest_digest)?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "DEPLOYMENT_ARTIFACT_MANIFEST_NOT_FOUND".to_string())?;
        if !metadata.file_type().is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() as usize > MAX_WORKFLOW_JSON_BYTES
        {
            return Err("DEPLOYMENT_ARTIFACT_INVALID_MANIFEST_FILE".into());
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("failed to read deployment artifact manifest: {error}"))?;
        let manifest: ArtifactBundleManifest = serde_json::from_slice(&bytes)
            .map_err(|_| "DEPLOYMENT_ARTIFACT_INVALID_MANIFEST_JSON".to_string())?;
        validate_artifact_manifest(&manifest).map_err(|error| error.to_string())?;
        let canonical = canonical_json_bytes(&manifest).map_err(|error| error.to_string())?;
        if sha256_bytes(&canonical) != handle.manifest_digest {
            return Err("DEPLOYMENT_ARTIFACT_MANIFEST_DIGEST_MISMATCH".into());
        }
        if content_digest(&manifest)? != handle.content_digest {
            return Err("DEPLOYMENT_ARTIFACT_CONTENT_DIGEST_MISMATCH".into());
        }
        let mut total_size = 0_u64;
        for component in &manifest.components {
            let blob_path = self.blob_path(&component.digest)?;
            if hash_file(&blob_path, component.size)? != component.digest {
                return Err("DEPLOYMENT_ARTIFACT_BLOB_DIGEST_MISMATCH".into());
            }
            total_size = total_size
                .checked_add(component.size)
                .ok_or_else(|| "DEPLOYMENT_ARTIFACT_TOTAL_SIZE_OVERFLOW".to_string())?;
        }
        Ok(ArtifactBundleProjection {
            handle: handle.clone(),
            component_count: manifest
                .components
                .len()
                .try_into()
                .map_err(|_| "deployment artifact component count overflow".to_string())?,
            manifest,
            total_size,
        })
    }

    /// Resolves a verified component for a native executor. Filesystem paths stay
    /// inside the Rust runtime and are never serialized through IPC.
    pub(crate) fn verified_component_path(
        &self,
        handle: &ArtifactHandle,
        component_name: &str,
    ) -> Result<PathBuf, String> {
        let projection = self.inspect(handle)?;
        let component = projection
            .manifest
            .components
            .iter()
            .find(|component| component.name == component_name)
            .ok_or_else(|| "DEPLOYMENT_ARTIFACT_COMPONENT_NOT_FOUND".to_string())?;
        let path = self.blob_path(&component.digest)?;
        if hash_file(&path, component.size)? != component.digest {
            return Err("DEPLOYMENT_ARTIFACT_BLOB_DIGEST_MISMATCH".into());
        }
        Ok(path)
    }

    pub(crate) fn acquire_lease(
        &self,
        run_id: &str,
        handle: &ArtifactHandle,
    ) -> Result<(), String> {
        validate_identifier("run id", run_id)?;
        self.inspect(handle)?;
        let run_directory = self.lease_directory().join(run_id);
        secure_directory(&run_directory)?;
        let marker = run_directory.join(digest_hex(&handle.manifest_digest)?);
        atomic_publish_bytes(
            &run_directory,
            &marker,
            handle.artifact_reference.as_bytes(),
        )
    }

    pub(crate) fn release_lease(
        &self,
        run_id: &str,
        handle: &ArtifactHandle,
    ) -> Result<(), String> {
        validate_identifier("run id", run_id)?;
        validate_artifact_handle(handle).map_err(|error| error.to_string())?;
        let run_directory = self.lease_directory().join(run_id);
        let marker = run_directory.join(digest_hex(&handle.manifest_digest)?);
        match fs::remove_file(&marker) {
            Ok(()) => sync_directory(&run_directory)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "failed to release deployment artifact lease: {error}"
                ))
            }
        }
        if run_directory.is_dir()
            && fs::read_dir(&run_directory)
                .map_err(|error| format!("failed to inspect artifact lease directory: {error}"))?
                .next()
                .is_none()
        {
            fs::remove_dir(&run_directory)
                .map_err(|error| format!("failed to remove empty artifact lease: {error}"))?;
            sync_directory(&self.lease_directory())?;
        }
        Ok(())
    }

    fn leased_manifest_digests(&self) -> Result<BTreeSet<String>, String> {
        let mut digests = BTreeSet::new();
        for run_entry in fs::read_dir(self.lease_directory())
            .map_err(|error| format!("failed to read deployment artifact leases: {error}"))?
        {
            let run_entry = run_entry
                .map_err(|error| format!("failed to inspect deployment artifact lease: {error}"))?;
            if !run_entry
                .file_type()
                .map_err(|error| format!("failed to inspect artifact lease type: {error}"))?
                .is_dir()
            {
                return Err("DEPLOYMENT_ARTIFACT_INVALID_LEASE_ENTRY".into());
            }
            for marker in fs::read_dir(run_entry.path())
                .map_err(|error| format!("failed to read artifact lease markers: {error}"))?
            {
                let marker = marker
                    .map_err(|error| format!("failed to inspect artifact lease marker: {error}"))?;
                if !marker
                    .file_type()
                    .map_err(|error| format!("failed to inspect artifact lease marker: {error}"))?
                    .is_file()
                {
                    return Err("DEPLOYMENT_ARTIFACT_INVALID_LEASE_ENTRY".into());
                }
                let hex = marker
                    .file_name()
                    .into_string()
                    .map_err(|_| "DEPLOYMENT_ARTIFACT_INVALID_LEASE_ENTRY".to_string())?;
                digest_hex(&format!("sha256:{hex}"))?;
                digests.insert(format!("sha256:{hex}"));
            }
        }
        Ok(digests)
    }

    pub(crate) fn cleanup(
        &self,
        retained_manifest_digests: &BTreeSet<String>,
    ) -> Result<ArtifactCleanupResult, String> {
        let mut protected = retained_manifest_digests.clone();
        for digest in &protected {
            digest_hex(digest)?;
        }
        protected.extend(self.leased_manifest_digests()?);

        let mut manifests = Vec::new();
        for entry in fs::read_dir(self.manifest_directory())
            .map_err(|error| format!("failed to read deployment artifact manifests: {error}"))?
        {
            let entry = entry.map_err(|error| {
                format!("failed to inspect deployment artifact manifest: {error}")
            })?;
            if !entry
                .file_type()
                .map_err(|error| format!("failed to inspect artifact manifest type: {error}"))?
                .is_file()
            {
                return Err("DEPLOYMENT_ARTIFACT_INVALID_MANIFEST_ENTRY".into());
            }
            let hex = entry
                .file_name()
                .into_string()
                .map_err(|_| "DEPLOYMENT_ARTIFACT_INVALID_MANIFEST_ENTRY".to_string())?;
            let manifest_digest = format!("sha256:{hex}");
            digest_hex(&manifest_digest)?;
            let bytes = fs::read(entry.path())
                .map_err(|error| format!("failed to read deployment artifact manifest: {error}"))?;
            let manifest: ArtifactBundleManifest = serde_json::from_slice(&bytes)
                .map_err(|_| "DEPLOYMENT_ARTIFACT_INVALID_MANIFEST_JSON".to_string())?;
            validate_artifact_manifest(&manifest).map_err(|error| error.to_string())?;
            let canonical = canonical_json_bytes(&manifest).map_err(|error| error.to_string())?;
            if sha256_bytes(&canonical) != manifest_digest {
                return Err("DEPLOYMENT_ARTIFACT_MANIFEST_DIGEST_MISMATCH".into());
            }
            let handle = ArtifactHandle {
                artifact_reference: format!("{MANIFEST_REFERENCE_PREFIX}{manifest_digest}"),
                manifest_digest: manifest_digest.clone(),
                content_digest: content_digest(&manifest)?,
            };
            self.inspect(&handle)?;
            manifests.push((manifest_digest, entry.path(), manifest));
        }

        let mut removed_manifests = 0_u32;
        let mut referenced_blobs = BTreeSet::new();
        for (digest, path, manifest) in manifests {
            if protected.contains(&digest) {
                referenced_blobs.extend(
                    manifest
                        .components
                        .into_iter()
                        .map(|component| component.digest),
                );
            } else {
                fs::remove_file(path).map_err(|error| {
                    format!("failed to remove unreferenced artifact manifest: {error}")
                })?;
                removed_manifests = removed_manifests.saturating_add(1);
            }
        }
        sync_directory(&self.manifest_directory())?;

        let mut removed_blobs = 0_u32;
        for entry in fs::read_dir(self.blob_directory())
            .map_err(|error| format!("failed to read deployment artifact blobs: {error}"))?
        {
            let entry = entry
                .map_err(|error| format!("failed to inspect deployment artifact blob: {error}"))?;
            if !entry
                .file_type()
                .map_err(|error| format!("failed to inspect artifact blob type: {error}"))?
                .is_file()
            {
                return Err("DEPLOYMENT_ARTIFACT_INVALID_BLOB_ENTRY".into());
            }
            let hex = entry
                .file_name()
                .into_string()
                .map_err(|_| "DEPLOYMENT_ARTIFACT_INVALID_BLOB_ENTRY".to_string())?;
            let digest = format!("sha256:{hex}");
            digest_hex(&digest)?;
            if !referenced_blobs.contains(&digest) {
                fs::remove_file(entry.path()).map_err(|error| {
                    format!("failed to remove unreferenced artifact blob: {error}")
                })?;
                removed_blobs = removed_blobs.saturating_add(1);
            }
        }
        sync_directory(&self.blob_directory())?;
        Ok(ArtifactCleanupResult {
            removed_manifests,
            removed_blobs,
            protected_manifests: protected
                .len()
                .try_into()
                .map_err(|_| "deployment artifact protection count overflow".to_string())?,
        })
    }

    #[cfg(test)]
    fn manifest_path_for_test(&self, digest: &str) -> PathBuf {
        self.manifest_path(digest).unwrap()
    }

    #[cfg(test)]
    fn blob_path_for_test(&self, digest: &str) -> PathBuf {
        self.blob_path(digest).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::workflow_schema::{
        ArtifactDescriptor, ArtifactProducer, ArtifactRole, ArtifactSource,
        MAX_ARTIFACT_COMPONENT_BYTES,
    };

    fn digest(bytes: &[u8]) -> String {
        sha256_bytes(bytes)
    }

    fn fixture(
        directory: &Path,
        name: &str,
        bytes: &[u8],
    ) -> (ArtifactBundleManifest, Vec<ArtifactBlobSource>) {
        let source_path = directory.join(name);
        fs::write(&source_path, bytes).unwrap();
        let blob_digest = digest(bytes);
        (
            ArtifactBundleManifest {
                schema_version: 2,
                artifact_type: "application/vnd.shellspan.file-tree".into(),
                source: ArtifactSource {
                    revision: "abc123".into(),
                    dirty: false,
                    snapshot_digest: digest(b"snapshot"),
                },
                components: vec![ArtifactDescriptor {
                    name: name.into(),
                    role: ArtifactRole::Application,
                    media_type: "application/octet-stream".into(),
                    digest: blob_digest.clone(),
                    size: bytes.len() as u64,
                    platform: None,
                    annotations: BTreeMap::new(),
                }],
                producer: ArtifactProducer {
                    node_type: "artifact.collect".into(),
                    node_type_version: 1,
                    config_digest: digest(b"config"),
                },
                annotations: BTreeMap::new(),
            },
            vec![ArtifactBlobSource {
                digest: blob_digest,
                path: source_path,
            }],
        )
    }

    #[test]
    fn atomic_publish_round_trips_by_opaque_handle_without_paths() {
        let directory = tempfile::tempdir().unwrap();
        let cas =
            DeploymentArtifactCas::new(directory.path().join("deployment-artifacts")).unwrap();
        let (manifest, sources) = fixture(directory.path(), "dist.tar", b"hello artifact");
        let projection = cas.publish_bundle(&manifest, &sources).unwrap();
        let reopened = cas.inspect(&projection.handle).unwrap();
        assert_eq!(reopened, projection);
        assert_eq!(
            projection.handle.artifact_reference,
            format!("deployment-artifact:{}", projection.handle.manifest_digest)
        );
        let wire = serde_json::to_string(&projection).unwrap();
        assert!(!wire.contains(directory.path().to_str().unwrap()));
        assert!(!wire.contains("blobs/sha256"));
        let mut rebound = projection.handle.clone();
        rebound.artifact_reference = format!("deployment-artifact:sha256:{}", "f".repeat(64));
        assert!(cas.inspect(&rebound).is_err());
    }

    #[test]
    fn blob_and_manifest_tampering_fail_strict_inspection() {
        let directory = tempfile::tempdir().unwrap();
        let cas =
            DeploymentArtifactCas::new(directory.path().join("deployment-artifacts")).unwrap();
        let (manifest, sources) = fixture(directory.path(), "dist.tar", b"content");
        let projection = cas.publish_bundle(&manifest, &sources).unwrap();
        fs::write(
            cas.blob_path_for_test(&manifest.components[0].digest),
            b"tampered",
        )
        .unwrap();
        assert!(cas.inspect(&projection.handle).is_err());

        let directory = tempfile::tempdir().unwrap();
        let cas =
            DeploymentArtifactCas::new(directory.path().join("deployment-artifacts")).unwrap();
        let (manifest, sources) = fixture(directory.path(), "dist.tar", b"content");
        let projection = cas.publish_bundle(&manifest, &sources).unwrap();
        fs::write(
            cas.manifest_path_for_test(&projection.handle.manifest_digest),
            b"{}",
        )
        .unwrap();
        assert!(cas.inspect(&projection.handle).is_err());
    }

    #[test]
    fn missing_blob_and_oversized_descriptor_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let cas =
            DeploymentArtifactCas::new(directory.path().join("deployment-artifacts")).unwrap();
        let (manifest, sources) = fixture(directory.path(), "dist.tar", b"content");
        let projection = cas.publish_bundle(&manifest, &sources).unwrap();
        fs::remove_file(cas.blob_path_for_test(&manifest.components[0].digest)).unwrap();
        assert!(cas.inspect(&projection.handle).is_err());

        let mut oversized = manifest;
        oversized.components[0].size = MAX_ARTIFACT_COMPONENT_BYTES + 1;
        assert!(cas.publish_bundle(&oversized, &sources).is_err());
    }

    #[test]
    fn concurrent_publication_is_idempotent_and_verified() {
        let directory = tempfile::tempdir().unwrap();
        let cas =
            DeploymentArtifactCas::new(directory.path().join("deployment-artifacts")).unwrap();
        let (manifest, sources) = fixture(directory.path(), "dist.tar", b"same bytes");
        let handles = std::thread::scope(|scope| {
            let threads = (0..8)
                .map(|_| {
                    let cas = cas.clone();
                    let manifest = manifest.clone();
                    let sources = sources.clone();
                    scope.spawn(move || cas.publish_bundle(&manifest, &sources).unwrap().handle)
                })
                .collect::<Vec<_>>();
            threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(handles.iter().all(|handle| handle == &handles[0]));
        cas.inspect(&handles[0]).unwrap();
    }

    #[test]
    fn insufficient_disk_space_fails_before_publication() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            ensure_available_space(directory.path(), u64::MAX).unwrap_err(),
            "DEPLOYMENT_ARTIFACT_INSUFFICIENT_DISK_SPACE"
        );
    }

    #[test]
    fn leases_and_retention_projection_exclude_cleanup() {
        let directory = tempfile::tempdir().unwrap();
        let cas =
            DeploymentArtifactCas::new(directory.path().join("deployment-artifacts")).unwrap();
        let (first_manifest, first_sources) = fixture(directory.path(), "first.tar", b"first");
        let first = cas.publish_bundle(&first_manifest, &first_sources).unwrap();
        let (second_manifest, second_sources) = fixture(directory.path(), "second.tar", b"second");
        let second = cas
            .publish_bundle(&second_manifest, &second_sources)
            .unwrap();
        cas.acquire_lease("run-1", &first.handle).unwrap();
        let mut retained = BTreeSet::new();
        retained.insert(second.handle.manifest_digest.clone());
        let result = cas.cleanup(&retained).unwrap();
        assert_eq!(result.removed_manifests, 0);
        cas.inspect(&first.handle).unwrap();
        cas.inspect(&second.handle).unwrap();

        cas.release_lease("run-1", &first.handle).unwrap();
        let result = cas.cleanup(&retained).unwrap();
        assert_eq!(result.removed_manifests, 1);
        assert!(cas.inspect(&first.handle).is_err());
        cas.inspect(&second.handle).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cas_root_rejects_symlink_redirection() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = directory.path().join("deployment-artifacts");
        symlink(outside.path(), &root).unwrap();
        assert!(DeploymentArtifactCas::new(root).is_err());
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }
}
