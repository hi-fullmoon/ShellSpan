//! Local-only source bindings and isolated, content-addressed source captures.
use super::canonicalization::canonical_sha256;
use super::workflow_schema::FrozenSourceSnapshot;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceBinding {
    pub id: String,
    pub revision: u64,
    pub local_path: PathBuf,
    pub repository_identity: String,
    #[serde(default)]
    pub included_untracked: Vec<String>,
    #[serde(default)]
    pub excluded_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceBindingInspection {
    pub binding: SourceBinding,
    pub head_revision: String,
    pub untracked_files: Vec<String>,
    pub branch: String,
    pub changed_files: Vec<String>,
}

pub(crate) fn inspect(path: &Path) -> Result<SourceBindingInspection, String> {
    let (local_path, repository_identity) = inspect_repository(path)?;
    let head_revision = git_text(&local_path, &["rev-parse", "HEAD"])?;
    let branch = git_text(&local_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let changed_files = members(git(
        &local_path,
        &["diff", "--no-ext-diff", "--name-only", "-z", "HEAD"],
    )?)?
    .into_iter()
    .collect();
    let untracked_files = members(git(
        &local_path,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?)?
    .into_iter()
    .collect();
    Ok(SourceBindingInspection {
        binding: SourceBinding {
            id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            local_path,
            repository_identity,
            included_untracked: Vec::new(),
            excluded_paths: Vec::new(),
        },
        head_revision,
        untracked_files,
        branch,
        changed_files,
    })
}

pub(crate) struct CapturedSource {
    pub snapshot: FrozenSourceSnapshot,
    pub directory: tempfile::TempDir,
}

fn read_source_file(path: &Path) -> Result<Vec<u8>, String> {
    const LIMIT: u64 = 512 * 1024 * 1024;
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("DEPLOYMENT_SOURCE_NON_FILE_UNSUPPORTED".into());
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("DEPLOYMENT_SOURCE_SIZE_LIMIT".into());
    }
    Ok(bytes)
}

pub(crate) fn materialize(root: &Path) -> Result<tempfile::TempDir, String> {
    fn copy(source: &Path, destination: &Path) -> Result<(), String> {
        for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let target = destination.join(entry.file_name());
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_dir() {
                fs::create_dir(&target).map_err(|e| e.to_string())?;
                copy(&entry.path(), &target)?;
            } else if kind.is_file() {
                fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
            } else {
                return Err("DEPLOYMENT_SOURCE_NON_FILE_UNSUPPORTED".into());
            }
        }
        Ok(())
    }
    let result = tempfile::tempdir().map_err(|e| e.to_string())?;
    copy(root, result.path())?;
    Ok(result)
}

fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let result = super::docker_compose_executor::safe_local_command("git")
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| error.to_string())?;
    if !result.status.success() || result.stdout.len() > 64 * 1024 * 1024 {
        return Err("DEPLOYMENT_SOURCE_GIT_UNAVAILABLE".into());
    }
    Ok(result.stdout)
}

fn git_text(root: &Path, args: &[&str]) -> Result<String, String> {
    String::from_utf8(git(root, args)?)
        .map(|value| value.trim().to_owned())
        .map_err(|_| "DEPLOYMENT_SOURCE_NON_UTF8".into())
}

pub(crate) fn inspect_repository(path: &Path) -> Result<(PathBuf, String), String> {
    if !path.is_absolute() {
        return Err("DEPLOYMENT_SOURCE_ABSOLUTE_PATH_REQUIRED".into());
    }
    let root = fs::canonicalize(path).map_err(|error| error.to_string())?;
    let top = git_text(&root, &["rev-parse", "--show-toplevel"])?;
    if fs::canonicalize(top).map_err(|error| error.to_string())? != root {
        return Err("DEPLOYMENT_SOURCE_GIT_ROOT_REQUIRED".into());
    }
    // History roots identify the repository across relocation without storing
    // remote URLs (which can contain credentials). A shallow boundary cannot
    // provide a stable identity and must be completed before binding.
    if git_text(&root, &["rev-parse", "--is-shallow-repository"])? != "false" {
        return Err("DEPLOYMENT_SOURCE_FULL_HISTORY_REQUIRED".into());
    }
    let roots = git_text(&root, &["rev-list", "--max-parents=0", "HEAD"])?;
    let roots = roots.lines().collect::<BTreeSet<_>>();
    if roots.is_empty() {
        return Err("DEPLOYMENT_SOURCE_HISTORY_REQUIRED".into());
    }
    let object_format = git_text(&root, &["rev-parse", "--show-object-format"])?;
    let identity =
        canonical_sha256(&serde_json::json!({"roots": roots, "objectFormat": object_format}))
            .map_err(|e| e.to_string())?;
    Ok((root, identity))
}

fn members(bytes: Vec<u8>) -> Result<BTreeSet<String>, String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            String::from_utf8(entry.to_vec()).map_err(|_| "DEPLOYMENT_SOURCE_NON_UTF8".into())
        })
        .collect()
}

fn checked_member(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("DEPLOYMENT_SOURCE_PATH_BOUNDARY".into());
    }
    let mut absolute = root.to_owned();
    for part in path.components() {
        absolute.push(part);
        if fs::symlink_metadata(&absolute)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err(format!("DEPLOYMENT_SOURCE_SYMLINK_UNSUPPORTED:{relative}"));
        }
    }
    if !absolute.is_file() {
        return Err("DEPLOYMENT_SOURCE_NON_FILE_UNSUPPORTED".into());
    }
    Ok(absolute)
}

#[cfg(test)]
pub(crate) fn capture(binding: &SourceBinding) -> Result<CapturedSource, String> {
    capture_cancellable(binding, &tokio_util::sync::CancellationToken::new())
}

pub(crate) fn capture_cancellable(
    binding: &SourceBinding,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<CapturedSource, String> {
    if binding.id.is_empty() || binding.revision == 0 {
        return Err("DEPLOYMENT_SOURCE_BINDING_INVALID".into());
    }
    let (root, identity) = inspect_repository(&binding.local_path)?;
    if identity != binding.repository_identity || root != binding.local_path {
        return Err("DEPLOYMENT_SOURCE_REPOSITORY_CHANGED".into());
    }
    let revision = git_text(&root, &["rev-parse", "HEAD"])?;
    let status = git(
        &root,
        &["status", "--porcelain", "-z", "--untracked-files=all"],
    )?;
    let mut files = members(git(&root, &["ls-files", "--cached", "-z"])?)?;
    let deleted = members(git(&root, &["ls-files", "--deleted", "-z"])?)?;
    files.retain(|file| !deleted.contains(file));
    let untracked = members(git(
        &root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?)?;
    for file in &binding.included_untracked {
        if !untracked.contains(file) {
            return Err("DEPLOYMENT_SOURCE_UNTRACKED_SELECTION_CHANGED".into());
        }
        files.insert(file.clone());
    }
    for excluded in &binding.excluded_paths {
        if excluded.is_empty()
            || Path::new(excluded)
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("DEPLOYMENT_SOURCE_EXCLUSION_INVALID".into());
        }
        files.retain(|file| !Path::new(file).starts_with(excluded));
    }
    let mut changed_files = members(git(
        &root,
        &["diff", "--no-ext-diff", "--name-only", "-z", "HEAD"],
    )?)?;
    changed_files.extend(binding.included_untracked.iter().cloned());
    changed_files.retain(|file| {
        !binding
            .excluded_paths
            .iter()
            .any(|excluded| Path::new(file).starts_with(excluded))
    });
    let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    for relative in &files {
        if cancellation.is_cancelled() {
            return Err("DEPLOYMENT_SOURCE_CANCELED".into());
        }
        if relative
            .split('/')
            .any(|part| matches!(part, ".git" | "node_modules" | ".next" | "target"))
            || Path::new(&relative)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name == ".env"
                        || name.starts_with(".env.")
                        || name.ends_with(".pem")
                        || name.ends_with(".key")
                })
        {
            return Err(format!("DEPLOYMENT_SOURCE_FORBIDDEN_MEMBER:{relative}"));
        }
        let source =
            checked_member(&root, &relative).map_err(|error| format!("{error}:{relative}"))?;
        let metadata = fs::metadata(&source).map_err(|e| e.to_string())?;
        total = total.saturating_add(metadata.len());
        if total > 512 * 1024 * 1024 {
            return Err("DEPLOYMENT_SOURCE_SIZE_LIMIT".into());
        }
        let bytes = read_source_file(&source)?;
        if bytes.len() as u64 != metadata.len() {
            return Err("DEPLOYMENT_SOURCE_CHANGED_DURING_CAPTURE".into());
        }
        let destination = directory.path().join(&relative);
        fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&destination, &bytes).map_err(|e| e.to_string())?;
        digest.update((relative.len() as u64).to_be_bytes());
        digest.update(relative.as_bytes());
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(&bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                &destination,
                fs::Permissions::from_mode(0o600 | (metadata.permissions().mode() & 0o111)),
            )
            .map_err(|e| e.to_string())?;
            digest.update((metadata.permissions().mode() & 0o111).to_be_bytes());
        }
        // Detect concurrent writes rather than publishing a mixed capture.
        if read_source_file(&source)? != bytes {
            return Err("DEPLOYMENT_SOURCE_CHANGED_DURING_CAPTURE".into());
        }
    }
    // Recheck all members after capture, including already-dirty files whose
    // porcelain status does not change when their contents change again.
    for relative in &files {
        if cancellation.is_cancelled() {
            return Err("DEPLOYMENT_SOURCE_CANCELED".into());
        }
        let source = checked_member(&root, relative)?;
        if read_source_file(&source)?
            != fs::read(directory.path().join(relative)).map_err(|e| e.to_string())?
        {
            return Err("DEPLOYMENT_SOURCE_CHANGED_DURING_CAPTURE".into());
        }
    }
    if git_text(&root, &["rev-parse", "HEAD"])? != revision
        || git(
            &root,
            &["status", "--porcelain", "-z", "--untracked-files=all"],
        )? != status
    {
        return Err("DEPLOYMENT_SOURCE_CHANGED_DURING_CAPTURE".into());
    }
    Ok(CapturedSource {
        snapshot: FrozenSourceSnapshot {
            changed_files: changed_files.into_iter().collect(),
            binding: Some(binding.clone()),
            source_ref: "workspace".into(),
            revision,
            dirty: !status.is_empty(),
            snapshot_digest: format!("sha256:{}", hex::encode(digest.finalize())),
            metadata_digest: canonical_sha256(binding).map_err(|e| e.to_string())?,
        },
        directory,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "--quiet"]).unwrap();
        fs::write(
            root.path().join("package.json"),
            "{\"name\":\"capture-regression\"}",
        )
        .unwrap();
        fs::write(root.path().join(".gitignore"), "ignored.txt\n").unwrap();
        git(root.path(), &["add", "."]).unwrap();
        git(
            root.path(),
            &[
                "-c",
                "user.name=Regression",
                "-c",
                "user.email=regression@localhost",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "Initialize isolated regression repository",
            ],
        )
        .unwrap();
        root
    }

    #[test]
    fn freezes_actual_files_and_explicit_untracked_selection() {
        let root = repository();
        fs::write(root.path().join("selected.txt"), "selected").unwrap();
        fs::write(root.path().join("omitted.txt"), "omitted").unwrap();
        fs::write(root.path().join("ignored.txt"), "ignored").unwrap();
        let mut binding = inspect(root.path()).unwrap().binding;
        binding.included_untracked.push("selected.txt".into());
        let captured = capture(&binding).unwrap();
        assert_eq!(captured.snapshot.changed_files, vec!["selected.txt"]);
        fs::write(root.path().join("package.json"), "{\"name\":\"changed\"}").unwrap();
        assert_eq!(
            capture(&binding).unwrap().snapshot.changed_files,
            vec!["package.json", "selected.txt"]
        );
        assert_eq!(
            fs::read_to_string(captured.directory.path().join("package.json")).unwrap(),
            "{\"name\":\"capture-regression\"}"
        );
        assert!(captured.directory.path().join("selected.txt").is_file());
        assert!(!captured.directory.path().join("omitted.txt").exists());
        assert!(!captured.directory.path().join("ignored.txt").exists());
        assert_ne!(
            captured.snapshot.snapshot_digest,
            capture(&binding).unwrap().snapshot.snapshot_digest
        );
        let build = materialize(captured.directory.path()).unwrap();
        fs::write(build.path().join("package.json"), "build mutation").unwrap();
        assert_ne!(
            fs::read(build.path().join("package.json")).unwrap(),
            fs::read(captured.directory.path().join("package.json")).unwrap()
        );
    }

    #[test]
    fn rejects_wrong_repository_ignored_selection_and_subdirectories() {
        let first = repository();
        let second = repository();
        git(
            second.path(),
            &[
                "-c",
                "user.name=Regression",
                "-c",
                "user.email=regression@localhost",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--amend",
                "--quiet",
                "-m",
                "Independent repository identity",
            ],
        )
        .unwrap();
        let mut binding = inspect(first.path()).unwrap().binding;
        binding.local_path = fs::canonicalize(second.path()).unwrap();
        assert!(capture(&binding).is_err());
        binding = inspect(first.path()).unwrap().binding;
        binding.included_untracked.push("ignored.txt".into());
        fs::write(first.path().join("ignored.txt"), "ignored").unwrap();
        assert!(capture(&binding).is_err());
        fs::create_dir(first.path().join("nested")).unwrap();
        assert!(inspect(&first.path().join("nested")).is_err());
    }

    #[test]
    fn relocation_preserves_repository_identity_and_historical_binding() {
        let original = repository();
        let binding = inspect(original.path()).unwrap().binding;
        let before = capture(&binding).unwrap();
        let relocated = materialize(original.path()).unwrap();
        let mut updated = binding.clone();
        updated.local_path = fs::canonicalize(relocated.path()).unwrap();
        updated.revision += 1;
        let after = capture(&updated).unwrap();
        assert_eq!(
            before.snapshot.snapshot_digest,
            after.snapshot.snapshot_digest
        );
        assert_ne!(
            before.snapshot.metadata_digest,
            after.snapshot.metadata_digest
        );
        assert_eq!(before.snapshot.binding, Some(binding));
        assert_eq!(after.snapshot.binding, Some(updated));
    }

    #[test]
    fn binding_round_trips_through_node_validation_and_frozen_source() {
        let root = repository();
        let binding = inspect(root.path()).unwrap().binding;
        let registry = super::super::node_registry::DeploymentNodeRegistry::mvp();
        registry
            .validate_config(
                registry.find("source.snapshot", 1).unwrap(),
                "source",
                &serde_json::json!({"sourceRef": "workspace", "binding": binding}),
            )
            .unwrap();
        let captured = capture(&binding).unwrap();
        let serialized = serde_json::to_value(&captured.snapshot).unwrap();
        let decoded: FrozenSourceSnapshot = serde_json::from_value(serialized).unwrap();
        assert_eq!(decoded.binding.as_ref(), Some(&binding));
        let cancellation = tokio_util::sync::CancellationToken::new();
        cancellation.cancel();
        assert!(capture_cancellable(&binding, &cancellation).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let root = repository();
        std::os::unix::fs::symlink("/etc/hosts", root.path().join("escape")).unwrap();
        let mut binding = inspect(root.path()).unwrap().binding;
        binding.included_untracked.push("escape".into());
        assert!(capture(&binding).is_err());
    }
}
