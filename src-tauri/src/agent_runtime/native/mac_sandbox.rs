//! Managed macOS local sandbox backed by the bundled `nono` launcher.
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::mac_sandbox_workspace::{
    recover_on_startup_in, recover_once_in, validate_anchor_path, Lease,
};

pub(crate) const EXECUTOR: &str = "macNono";
pub(crate) const WORKSPACE_PREFIX: &str = ".shellspan-agent-ws-";
const START_FAILED: &str = "MAC_SANDBOX_START_FAILED";
const LAUNCHER_REL_PATH: &str = "native-input/generated/sandbox/shellspan-sandbox-launcher";
const LAUNCHER_SHA256: Option<&str> = option_env!("SHELLSPAN_MAC_SANDBOX_LAUNCHER_RELEASE_SHA256");

fn is_valid_anchor_name(name: &str) -> bool {
    let Some(hex_part) = name.strip_prefix(WORKSPACE_PREFIX) else {
        return false;
    };
    hex_part.len() == 32
        && hex_part
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn entry_identity(path: &Path, directory: bool) -> io::Result<(u64, u64)> {
    let stat = fs::symlink_metadata(path)?;
    let owner = unsafe { libc::geteuid() };
    if directory {
        if !stat.is_dir() || stat.uid() != owner {
            return Err(io::Error::other(
                "Expected an owned managed sandbox directory",
            ));
        }
    } else if !stat.is_file() {
        return Err(io::Error::other("Expected a bundled sandbox launcher file"));
    }
    Ok((stat.dev(), stat.ino()))
}

fn verify_launcher(path: &Path, expected_sha256: &str) -> Result<(), String> {
    let mut launcher = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| format!("LOCAL_SANDBOX_LAUNCHER_UNAVAILABLE: {error}"))?;
    let metadata = launcher
        .metadata()
        .map_err(|error| format!("LOCAL_SANDBOX_LAUNCHER_UNAVAILABLE: {error}"))?;
    if !metadata.is_file() {
        return Err(
            "LOCAL_SANDBOX_LAUNCHER_UNAVAILABLE: expected a regular launcher binary".into(),
        );
    }
    if metadata.permissions().mode() & 0o022 != 0 {
        return Err(
            "LOCAL_SANDBOX_LAUNCHER_UNAVAILABLE: launcher permissions must not be group/world writable"
                .into(),
        );
    }
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = launcher
            .read(&mut buffer)
            .map_err(|error| format!("LOCAL_SANDBOX_LAUNCHER_UNAVAILABLE: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    if hex::encode(digest.finalize()) != expected_sha256 {
        return Err(
            "LOCAL_SANDBOX_LAUNCHER_CHANGED: bundled launcher failed its integrity check".into(),
        );
    }
    Ok(())
}

fn candidate_launcher_paths(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = resource_dir {
        candidates.push(dir.join(LAUNCHER_REL_PATH));
    }
    if cfg!(debug_assertions) {
        candidates.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/native-input/generated/sandbox/shellspan-sandbox-launcher"),
        );
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(contents) = exe.parent().and_then(Path::parent) {
            candidates.push(contents.join("Resources").join(LAUNCHER_REL_PATH));
        }
    }
    candidates
}

pub(crate) fn resolve_verified_launcher(
    resource_dir: Option<&Path>,
) -> Result<(PathBuf, String), String> {
    let expected = LAUNCHER_SHA256.ok_or_else(|| {
        "LOCAL_SANDBOX_LAUNCHER_UNAVAILABLE: bundled macOS sandbox launcher was not built into this package"
            .to_string()
    })?;
    let mut last_error = None;
    for candidate in candidate_launcher_paths(resource_dir) {
        if !candidate.exists() {
            continue;
        }
        match verify_launcher(&candidate, expected) {
            Ok(()) => return Ok((candidate, expected.to_string())),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        "LOCAL_SANDBOX_LAUNCHER_UNAVAILABLE: bundled macOS sandbox launcher is missing".to_string()
    }))
}

fn workspace_identity_digest(
    workspace: &Path,
    anchor_id: (u64, u64),
    workspace_id: (u64, u64),
) -> String {
    hex::encode(Sha256::digest(format!(
        "{EXECUTOR}\0v1\0{}\0{}:{}\0{}:{}",
        workspace.display(),
        anchor_id.0,
        anchor_id.1,
        workspace_id.0,
        workspace_id.1
    )))
}

fn identity_file(anchor: &Path) -> PathBuf {
    anchor.join("data").join("identity")
}

fn parse_managed_workspace(home: &Path, cwd: &Path) -> io::Result<(PathBuf, PathBuf, PathBuf)> {
    let parent = home.canonicalize()?;
    if cwd.file_name() != Some(OsStr::new("workspace")) {
        return Err(io::Error::other("Invalid managed macOS workspace path"));
    }
    let anchor = cwd
        .parent()
        .ok_or_else(|| io::Error::other("Invalid managed macOS workspace anchor"))?;
    let name = anchor
        .file_name()
        .and_then(OsStr::to_str)
        .filter(|name| is_valid_anchor_name(name))
        .ok_or_else(|| io::Error::other("Invalid managed macOS workspace name"))?;
    let expected_anchor = parent.join(name);
    if anchor != expected_anchor {
        return Err(io::Error::other("Workspace is outside managed macOS root"));
    }
    validate_anchor_path(&expected_anchor, &parent, WORKSPACE_PREFIX)?;
    let workspace = expected_anchor.join("workspace");
    Ok((parent, expected_anchor, workspace))
}

pub(crate) fn create_workspace(home: &Path, session_id: &str) -> Result<String, String> {
    let create = || -> io::Result<String> {
        let parent = home.canonicalize()?;
        let digest = Sha256::digest(format!("{}\0{session_id}", parent.display()));
        let anchor_name = format!("{WORKSPACE_PREFIX}{}", hex::encode(&digest[..16]));
        let anchor = parent.join(anchor_name);
        let workspace = anchor.join("workspace");
        let temporary = anchor.join("temporary");
        let data = anchor.join("data");
        match fs::create_dir(&anchor) {
            Ok(()) => {
                fs::set_permissions(&anchor, fs::Permissions::from_mode(0o700))?;
                validate_anchor_path(&anchor, &parent, WORKSPACE_PREFIX)?;
                fs::create_dir(&workspace)?;
                fs::create_dir(&temporary)?;
                fs::create_dir(&data)?;
                let anchor_id = entry_identity(&anchor, true)?;
                let workspace_id = entry_identity(&workspace, true)?;
                let expected = workspace_identity_digest(&workspace, anchor_id, workspace_id);
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(identity_file(&anchor))?;
                file.write_all(expected.as_bytes())?;
                file.sync_all()?;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                verify_managed_workspace_files(&parent, &anchor, &workspace)?;
            }
            Err(error) => return Err(error),
        }
        workspace
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| io::Error::other("Expected a UTF-8 managed macOS workspace path"))
    };
    create().map_err(|error| format!("{START_FAILED}: {error}"))
}

fn verify_managed_workspace_files(
    parent: &Path,
    anchor: &Path,
    workspace: &Path,
) -> io::Result<((u64, u64), (u64, u64))> {
    validate_anchor_path(anchor, parent, WORKSPACE_PREFIX)?;
    let anchor_id = entry_identity(anchor, true)?;
    let workspace_id = entry_identity(workspace, true)?;
    let _ = entry_identity(&anchor.join("temporary"), true)?;
    let _ = entry_identity(&anchor.join("data"), true)?;
    let recorded = fs::read_to_string(identity_file(anchor))?;
    let expected = workspace_identity_digest(workspace, anchor_id, workspace_id);
    if recorded != expected {
        return Err(io::Error::other(
            "Managed macOS sandbox workspace identity changed",
        ));
    }
    Ok((anchor_id, workspace_id))
}

pub(crate) fn remove_workspace(home: &Path, cwd: &Path) -> Result<(), String> {
    let (parent, anchor, workspace) =
        parse_managed_workspace(home, cwd).map_err(|error| format!("{START_FAILED}: {error}"))?;
    if !anchor.exists() {
        return Ok(());
    }
    verify_managed_workspace_files(&parent, &anchor, &workspace)
        .map_err(|error| format!("{START_FAILED}: {error}"))?;
    let recovered = recover_once_in(&anchor, &parent, WORKSPACE_PREFIX).map_err(|error| {
        format!("Failed to recover macOS sandbox workspace before removal: {error}")
    })?;
    if !recovered {
        return Err(
            "Failed to recycle macOS sandbox workspace: sandbox process group is still active"
                .into(),
        );
    }
    trash::TrashContext::new()
        .delete(&anchor)
        .map_err(|error| format!("Failed to recycle macOS sandbox workspace: {error}"))
}

pub(crate) fn recover_all_on_startup(home: &Path) {
    let Ok(parent) = home.canonicalize() else {
        return;
    };
    let Ok(entries) = fs::read_dir(&parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !is_valid_anchor_name(name) {
            continue;
        }
        let anchor = entry.path();
        if !anchor.join("data/managed-directory-guard.json").exists() {
            continue;
        }
        recover_on_startup_in(&anchor, &parent, WORKSPACE_PREFIX);
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Workspace {
    pub(super) parent: PathBuf,
    pub(super) anchor: PathBuf,
    pub(super) workspace: PathBuf,
    pub(super) launcher: PathBuf,
    expected_launcher_sha256: String,
    pub(crate) digest: String,
}

impl Workspace {
    pub(crate) fn open(
        home: &Path,
        cwd: &Path,
        resource_dir: Option<&Path>,
    ) -> Result<Self, String> {
        let (launcher, expected_sha256) = resolve_verified_launcher(resource_dir)?;
        Self::open_with_launcher(home, cwd, launcher, expected_sha256)
    }

    fn open_with_launcher(
        home: &Path,
        cwd: &Path,
        launcher: PathBuf,
        expected_launcher_sha256: String,
    ) -> Result<Self, String> {
        let (parent, anchor, workspace) = parse_managed_workspace(home, cwd)
            .map_err(|error| format!("{START_FAILED}: {error}"))?;
        verify_managed_workspace_files(&parent, &anchor, &workspace)
            .map_err(|error| format!("{START_FAILED}: {error}"))?;
        verify_launcher(&launcher, &expected_launcher_sha256)?;
        let mut binding = Self {
            parent,
            anchor,
            workspace,
            launcher,
            expected_launcher_sha256,
            digest: String::new(),
        };
        binding.digest = binding.current_digest()?;
        Ok(binding)
    }

    fn current_digest(&self) -> Result<String, String> {
        let (anchor_id, workspace_id) =
            verify_managed_workspace_files(&self.parent, &self.anchor, &self.workspace)
                .map_err(|error| format!("{START_FAILED}: {error}"))?;
        let launcher_id = entry_identity(&self.launcher, false)
            .map_err(|error| format!("LOCAL_SANDBOX_LAUNCHER_UNAVAILABLE: {error}"))?;
        let bytes = serde_json::to_vec(&(
            EXECUTOR,
            &self.workspace,
            workspace_id,
            &self.anchor,
            anchor_id,
            &self.launcher,
            launcher_id,
            &self.expected_launcher_sha256,
        ))
        .map_err(|error| error.to_string())?;
        Ok(hex::encode(Sha256::digest(bytes)))
    }

    pub(super) fn revalidate(&self) -> Result<(), String> {
        if self.current_digest()? != self.digest {
            return Err(format!(
                "{START_FAILED}: managed macOS sandbox workspace or launcher changed before dispatch"
            ));
        }
        verify_launcher(&self.launcher, &self.expected_launcher_sha256)
    }

    pub(super) fn acquire_lease(&self) -> Result<Lease, String> {
        Lease::acquire_in(&self.anchor, &self.parent, WORKSPACE_PREFIX)
            .map_err(|error| format!("{START_FAILED}: {error}"))
    }
}

impl super::LocalSandboxBackend for Workspace {
    fn kind(&self) -> crate::agent_runtime::LocalSandboxKind {
        crate::agent_runtime::LocalSandboxKind::MacNono
    }

    fn digest(&self) -> &str {
        &self.digest
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_open_and_revalidate_managed_workspace() {
        let parent = Path::new("/private/tmp");
        let session = format!("mac-sandbox-test-{}", uuid::Uuid::new_v4());
        let workspace_path = create_workspace(parent, &session).unwrap();
        let launcher_dir = tempfile::tempdir().unwrap();
        let launcher = launcher_dir.path().join("shellspan-sandbox-launcher");
        fs::copy("/bin/sh", &launcher).unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
        let checksum = hex::encode(Sha256::digest(fs::read(&launcher).unwrap()));

        let binding = Workspace::open_with_launcher(
            parent,
            Path::new(&workspace_path),
            launcher.clone(),
            checksum.clone(),
        )
        .unwrap();
        binding.revalidate().unwrap();

        let lease = binding.acquire_lease().unwrap();
        assert!(lease.release().unwrap());

        // Tampering with launcher bytes must fail revalidation.
        fs::OpenOptions::new()
            .append(true)
            .open(&launcher)
            .unwrap()
            .write_all(&[0])
            .unwrap();
        assert!(binding
            .revalidate()
            .unwrap_err()
            .contains("LOCAL_SANDBOX_LAUNCHER_CHANGED"));

        // Clean up test anchor without touching user Trash.
        fs::remove_dir_all(&binding.anchor).unwrap();
    }

    #[test]
    fn remove_workspace_rejects_unmanaged_paths() {
        let outside = tempfile::tempdir_in("/private/tmp").unwrap();
        let error = remove_workspace(Path::new("/private/tmp"), outside.path()).unwrap_err();
        assert!(error.contains(START_FAILED));
    }

    #[test]
    fn tampered_identity_is_rejected() {
        let parent = Path::new("/private/tmp");
        let session = format!("mac-sandbox-tamper-{}", uuid::Uuid::new_v4());
        let workspace_path = create_workspace(parent, &session).unwrap();
        let anchor = Path::new(&workspace_path).parent().unwrap().to_path_buf();
        fs::write(identity_file(&anchor), b"tampered").unwrap();

        let launcher_dir = tempfile::tempdir().unwrap();
        let launcher = launcher_dir.path().join("shellspan-sandbox-launcher");
        fs::copy("/bin/sh", &launcher).unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
        let checksum = hex::encode(Sha256::digest(fs::read(&launcher).unwrap()));

        let error =
            Workspace::open_with_launcher(parent, Path::new(&workspace_path), launcher, checksum)
                .unwrap_err();
        assert!(error.contains("identity changed"));
        fs::remove_dir_all(&anchor).unwrap();
    }
}
