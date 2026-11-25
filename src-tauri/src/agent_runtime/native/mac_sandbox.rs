//! Managed macOS local sandbox backed by the bundled `nono` launcher.
use std::collections::{HashSet, VecDeque};
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use sha2::{Digest, Sha256};

use super::mac_sandbox_workspace::{
    recover_managed_on_startup, recover_managed_once, validate_managed_anchor_path,
    validate_managed_sandbox_parent, Lease,
};

pub(crate) const EXECUTOR: &str = "macNono";
pub(crate) const SANDBOXES_DIR: &str = "sandboxes";
const START_FAILED: &str = "MAC_SANDBOX_START_FAILED";
const LAUNCHER_REL_PATH: &str = "native-input/generated/sandbox/shellspan-sandbox-launcher";
const LAUNCHER_SHA256: Option<&str> = option_env!("SHELLSPAN_MAC_SANDBOX_LAUNCHER_RELEASE_SHA256");

fn is_valid_anchor_name(name: &str) -> bool {
    name.len() == 32
        && name
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

pub(crate) fn is_launcher_bundled() -> bool {
    LAUNCHER_SHA256.is_some()
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

fn verified_probe_cache() -> &'static Mutex<VecDeque<(PathBuf, String)>> {
    static CACHE: OnceLock<Mutex<VecDeque<(PathBuf, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(VecDeque::new()))
}

pub(crate) fn probe_local_sandbox(
    data_dir: &Path,
    resource_dir: Option<&Path>,
) -> Result<(), String> {
    let (launcher, expected_sha256) = resolve_verified_launcher(resource_dir)?;
    let sandboxes_dir = data_dir.join(SANDBOXES_DIR);
    let probe_target = if sandboxes_dir.exists() {
        sandboxes_dir
    } else {
        data_dir.to_path_buf()
    };
    let parent = probe_target.canonicalize().map_err(|error| {
        format!("LOCAL_SANDBOX_UNAVAILABLE: invalid ShellSpan data directory: {error}")
    })?;
    validate_managed_sandbox_parent(&parent).map_err(|error| {
        format!("LOCAL_SANDBOX_UNAVAILABLE: managed workspace root cannot be protected: {error}")
    })?;
    let cache_key = (parent, expected_sha256);
    if let Ok(cache) = verified_probe_cache().lock() {
        if cache.contains(&cache_key) {
            return Ok(());
        }
    }
    let output = Command::new(&launcher)
        .arg("--probe")
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            format!("LOCAL_SANDBOX_LAUNCHER_UNAVAILABLE: failed to run sandbox probe: {error}")
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            "LOCAL_SANDBOX_UNAVAILABLE: macOS Seatbelt sandbox probe failed".into()
        } else {
            format!("LOCAL_SANDBOX_UNAVAILABLE: macOS Seatbelt sandbox probe failed: {detail}")
        });
    }
    if let Ok(mut cache) = verified_probe_cache().lock() {
        if cache.len() >= 16 {
            cache.pop_front();
        }
        cache.push_back(cache_key);
    }
    Ok(())
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

fn parse_managed_workspace(data_dir: &Path, cwd: &Path) -> io::Result<(PathBuf, PathBuf, PathBuf)> {
    let parent = data_dir.join(SANDBOXES_DIR).canonicalize()?;
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
    validate_managed_anchor_path(&expected_anchor, &parent)?;
    let workspace = expected_anchor.join("workspace");
    Ok((parent, expected_anchor, workspace))
}

pub(crate) fn create_workspace(data_dir: &Path, session_id: &str) -> Result<String, String> {
    let create = || -> io::Result<String> {
        let data_root = data_dir.canonicalize()?;
        validate_managed_sandbox_parent(&data_root)?;
        let parent = data_root.join(SANDBOXES_DIR);
        match fs::create_dir(&parent) {
            Ok(()) => {
                fs::set_permissions(&parent, fs::Permissions::from_mode(0o700))?;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        validate_managed_sandbox_parent(&parent)?;
        let digest = Sha256::digest(format!("{}\0{session_id}", parent.display()));
        let anchor_name = hex::encode(&digest[..16]);
        let anchor = parent.join(anchor_name);
        let workspace = anchor.join("workspace");
        let temporary = anchor.join("temporary");
        let data = anchor.join("data");
        match fs::create_dir(&anchor) {
            Ok(()) => {
                fs::set_permissions(&anchor, fs::Permissions::from_mode(0o700))?;
                validate_managed_anchor_path(&anchor, &parent)?;
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
    validate_managed_anchor_path(anchor, parent)?;
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

pub(crate) fn remove_workspace(data_dir: &Path, cwd: &Path) -> Result<(), String> {
    let (parent, anchor, workspace) = parse_managed_workspace(data_dir, cwd)
        .map_err(|error| format!("{START_FAILED}: {error}"))?;
    if !anchor.exists() {
        return Ok(());
    }
    verify_managed_workspace_files(&parent, &anchor, &workspace)
        .map_err(|error| format!("{START_FAILED}: {error}"))?;
    let recovered = recover_managed_once(&anchor, &parent).map_err(|error| {
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

pub(crate) fn recover_all_on_startup(data_dir: &Path) {
    let Ok(parent) = data_dir.join(SANDBOXES_DIR).canonicalize() else {
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
        recover_managed_on_startup(&anchor, &parent);
    }
}

pub(crate) fn reclaim_orphaned_workspaces(data_dir: &Path, known_cwds: &HashSet<String>) {
    let Ok(parent) = data_dir.join(SANDBOXES_DIR).canonicalize() else {
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
        let workspace = entry.path().join("workspace");
        let portable = crate::path_utils::portable_local_path(&workspace);
        if known_cwds.contains(&portable) {
            continue;
        }
        if let Err(error) = remove_workspace(data_dir, &workspace) {
            log::warn!(
                "Failed to reclaim orphaned macOS sandbox workspace: {}",
                crate::redaction::redact_sensitive_text(&error)
            );
        }
    }
}

pub(crate) fn storage_stats(
    data_dir: &Path,
    active_cwds: &HashSet<String>,
) -> super::sandbox_sync::SandboxStorageStats {
    let mut stats = super::sandbox_sync::SandboxStorageStats::default();
    let Ok(parent) = data_dir.join(SANDBOXES_DIR).canonicalize() else {
        return stats;
    };
    let Ok(entries) = fs::read_dir(&parent) else {
        return stats;
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
        if fs::symlink_metadata(&anchor).map_or(true, |m| m.file_type().is_symlink() || !m.is_dir())
        {
            continue;
        }
        let workspace = anchor.join("workspace");
        let portable = crate::path_utils::portable_local_path(&workspace);
        let bytes = super::sandbox_sync::directory_size_bytes(&anchor);
        stats.total_count += 1;
        stats.total_bytes = stats.total_bytes.saturating_add(bytes);
        if active_cwds.contains(&portable) {
            stats.active_count += 1;
            stats.active_bytes = stats.active_bytes.saturating_add(bytes);
        } else {
            stats.reclaimable_count += 1;
            stats.reclaimable_bytes = stats.reclaimable_bytes.saturating_add(bytes);
        }
    }
    stats
}

pub(crate) fn cleanup_reclaimable_workspaces(
    data_dir: &Path,
    active_cwds: &HashSet<String>,
) -> super::sandbox_sync::SandboxCleanupReport {
    let mut report = super::sandbox_sync::SandboxCleanupReport::default();
    let Ok(parent) = data_dir.join(SANDBOXES_DIR).canonicalize() else {
        return report;
    };
    let Ok(entries) = fs::read_dir(&parent) else {
        return report;
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
        if fs::symlink_metadata(&anchor).map_or(true, |m| m.file_type().is_symlink() || !m.is_dir())
        {
            continue;
        }
        let workspace = anchor.join("workspace");
        let portable = crate::path_utils::portable_local_path(&workspace);
        if active_cwds.contains(&portable) {
            continue;
        }
        let bytes = super::sandbox_sync::directory_size_bytes(&anchor);
        match remove_workspace(data_dir, &workspace) {
            Ok(()) => {
                report.removed_count += 1;
                report.freed_bytes = report.freed_bytes.saturating_add(bytes);
            }
            Err(error) => {
                report.failed_count += 1;
                log::warn!(
                    "Failed to clean up macOS sandbox workspace: {}",
                    crate::redaction::redact_sensitive_text(&error)
                );
            }
        }
    }
    report
}

#[derive(Debug, Clone)]
pub(crate) struct Workspace {
    pub(super) parent: PathBuf,
    pub(super) anchor: PathBuf,
    pub(super) workspace: PathBuf,
    pub(super) launcher: PathBuf,
    expected_launcher_sha256: String,
    pub(crate) network_policy: super::sandbox_proxy::SandboxNetworkPolicy,
    pub(crate) digest: String,
}

impl Workspace {
    pub(crate) fn open(
        data_dir: &Path,
        cwd: &Path,
        resource_dir: Option<&Path>,
        network_policy: super::sandbox_proxy::SandboxNetworkPolicy,
    ) -> Result<Self, String> {
        let (launcher, expected_sha256) = resolve_verified_launcher(resource_dir)?;
        Self::open_with_launcher(data_dir, cwd, launcher, expected_sha256, network_policy)
    }

    fn open_with_launcher(
        data_dir: &Path,
        cwd: &Path,
        launcher: PathBuf,
        expected_launcher_sha256: String,
        network_policy: super::sandbox_proxy::SandboxNetworkPolicy,
    ) -> Result<Self, String> {
        let (parent, anchor, workspace) = parse_managed_workspace(data_dir, cwd)
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
            network_policy,
            digest: String::new(),
        };
        binding.digest = binding.current_digest()?;
        Ok(binding)
    }

    pub(crate) fn sandbox_policy(&self) -> crate::agent_runtime::SandboxPolicy {
        crate::agent_runtime::SandboxPolicy::for_mac_nono(
            self.workspace.to_string_lossy(),
            &self.network_policy,
        )
    }

    fn current_digest(&self) -> Result<String, String> {
        let (anchor_id, workspace_id) =
            verify_managed_workspace_files(&self.parent, &self.anchor, &self.workspace)
                .map_err(|error| format!("{START_FAILED}: {error}"))?;
        let launcher_id = entry_identity(&self.launcher, false)
            .map_err(|error| format!("LOCAL_SANDBOX_LAUNCHER_UNAVAILABLE: {error}"))?;
        let policy_digest = self.sandbox_policy().digest();
        let bytes = serde_json::to_vec(&(
            EXECUTOR,
            &self.workspace,
            workspace_id,
            &self.anchor,
            anchor_id,
            &self.launcher,
            launcher_id,
            &self.expected_launcher_sha256,
            policy_digest,
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
        Lease::acquire_managed(&self.anchor, &self.parent)
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

pub(crate) struct PreparedMacSandboxPty {
    workspace_root: String,
    policy_digest: String,
    network_mode: super::sandbox_proxy::SandboxNetworkMode,
    allowed_domains: Vec<String>,
    lease: Option<Lease>,
    proxy: Option<super::sandbox_proxy::SandboxProxy>,
    temp_dir: Option<tempfile::TempDir>,
    gate_listener: Option<std::os::unix::net::UnixListener>,
    gate_socket: PathBuf,
}

impl PreparedMacSandboxPty {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn prepare(
        data_dir: &Path,
        workspace_cwd: &Path,
        resource_dir: Option<&Path>,
        network_policy: super::sandbox_proxy::SandboxNetworkPolicy,
        nip_root: &Path,
        control_socket: &Path,
        shell_executable: &Path,
    ) -> Result<(Self, portable_pty::CommandBuilder), String> {
        let binding = Workspace::open(data_dir, workspace_cwd, resource_dir, network_policy)?;
        let policy = binding.sandbox_policy();
        let policy_digest = policy.digest();
        let network_mode = binding.network_policy.mode;
        let allowed_domains = binding.network_policy.effective_rules();
        let temporary_root = binding.anchor.join("temporary");
        if !fs::symlink_metadata(&temporary_root)
            .map_err(|error| format!("{START_FAILED}: {error}"))?
            .is_dir()
        {
            return Err(format!(
                "{START_FAILED}: expected a real sandbox temporary directory"
            ));
        }
        let temp_dir = tempfile::tempdir_in(&temporary_root)
            .map_err(|error| format!("{START_FAILED}: {error}"))?;
        let sandbox_home = temp_dir.path().join("home");
        fs::create_dir(&sandbox_home).map_err(|error| format!("{START_FAILED}: {error}"))?;

        let proxy = if binding.network_policy.uses_proxy() {
            Some(
                super::sandbox_proxy::SandboxProxy::start(binding.network_policy.clone())
                    .map_err(|error| format!("{START_FAILED}: failed to start proxy: {error}"))?,
            )
        } else {
            None
        };

        let lease = binding.acquire_lease()?;
        let gate_socket = nip_root.join("gate");
        let _ = fs::remove_file(&gate_socket);
        let gate_listener = std::os::unix::net::UnixListener::bind(&gate_socket)
            .map_err(|error| format!("{START_FAILED}: failed to bind launch gate: {error}"))?;
        fs::set_permissions(&gate_socket, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("{START_FAILED}: {error}"))?;
        gate_listener
            .set_nonblocking(true)
            .map_err(|error| format!("{START_FAILED}: {error}"))?;

        let (readonly_paths, sandbox_path_env) = super::process::mac_sandbox_readonly_toolchains();
        let mut command = portable_pty::CommandBuilder::new(&binding.launcher);
        command.env_clear();
        command.cwd(&binding.workspace);
        command.arg("--gate-socket");
        command.arg(&gate_socket);
        command.arg("--allow-tty");
        command.arg("--unix-socket");
        command.arg(control_socket);
        command.arg("--read-path");
        command.arg(nip_root);
        for path in &readonly_paths {
            command.arg("--read-path");
            command.arg(path);
        }
        if let Some(proxy) = &proxy {
            command.arg("--proxy-port");
            command.arg(proxy.port().to_string());
        }
        command.arg(&binding.workspace);
        command.arg(temp_dir.path());
        command.arg("--");
        command.arg(shell_executable);
        command.arg("-i");

        command.env("PATH", &sandbox_path_env);
        command.env("HOME", &sandbox_home);
        command.env("TMPDIR", temp_dir.path());
        command.env("HISTFILE", sandbox_home.join(".zsh_history"));
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("LANG", "en_US.UTF-8");
        command.env("LC_ALL", "en_US.UTF-8");
        if let Some(proxy) = &proxy {
            let proxy_url = proxy.proxy_url();
            command.env("HTTP_PROXY", &proxy_url);
            command.env("HTTPS_PROXY", &proxy_url);
            command.env("ALL_PROXY", &proxy_url);
            command.env("http_proxy", &proxy_url);
            command.env("https_proxy", &proxy_url);
            command.env("all_proxy", &proxy_url);
            command.env("NO_PROXY", "localhost,127.0.0.1");
            command.env("no_proxy", "localhost,127.0.0.1");
        }

        let workspace_root = binding.workspace.to_string_lossy().into_owned();
        Ok((
            Self {
                workspace_root,
                policy_digest,
                network_mode,
                allowed_domains,
                lease: Some(lease),
                proxy,
                temp_dir: Some(temp_dir),
                gate_listener: Some(gate_listener),
                gate_socket,
            },
            command,
        ))
    }

    pub(crate) fn binding(&self, agent_session_id: &str) -> crate::models::LocalSandboxPtyBinding {
        crate::models::LocalSandboxPtyBinding {
            agent_session_id: agent_session_id.to_string(),
            kind: crate::agent_runtime::LocalSandboxKind::MacNono,
            workspace_root: self.workspace_root.clone(),
            policy_digest: self.policy_digest.clone(),
            network_mode: self.network_mode,
            allowed_domains: self.allowed_domains.clone(),
        }
    }

    pub(crate) fn blocked_domains_handle(&self) -> Option<std::sync::Arc<Mutex<Vec<String>>>> {
        self.proxy
            .as_ref()
            .map(super::sandbox_proxy::SandboxProxy::blocked_domains_handle)
    }

    pub(crate) fn activate(mut self, child_pid: u32) -> Result<ActiveMacSandboxPtyGuard, String> {
        let mut lease = self
            .lease
            .take()
            .ok_or_else(|| format!("{START_FAILED}: missing sandbox directory lease"))?;
        let listener = self
            .gate_listener
            .take()
            .ok_or_else(|| format!("{START_FAILED}: missing sandbox launch gate"))?;
        let pgid = i32::try_from(child_pid)
            .map_err(|_| format!("{START_FAILED}: invalid sandbox process group"))?;

        let activate_result = (|| -> Result<(), String> {
            lease
                .record_group(child_pid)
                .map_err(|error| format!("{START_FAILED}: {error}"))?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() >= deadline {
                            return Err(format!(
                                "{START_FAILED}: timed out waiting for sandbox launcher gate"
                            ));
                        }
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(error) => {
                        return Err(format!(
                            "{START_FAILED}: failed to accept sandbox launcher gate: {error}"
                        ));
                    }
                }
            };
            stream
                .set_nonblocking(false)
                .map_err(|error| format!("{START_FAILED}: {error}"))?;
            stream
                .set_write_timeout(Some(std::time::Duration::from_secs(1)))
                .map_err(|error| format!("{START_FAILED}: {error}"))?;
            stream.write_all(b"G").map_err(|error| {
                format!("{START_FAILED}: failed to release launch gate: {error}")
            })?;
            Ok(())
        })();

        drop(listener);
        let _ = fs::remove_file(&self.gate_socket);

        if let Err(error) = activate_result {
            terminate_sandbox_group(pgid);
            let _ = lease.record_ended();
            let _ = lease.release();
            return Err(error);
        }

        Ok(ActiveMacSandboxPtyGuard {
            lease: Some(lease),
            _proxy: self.proxy.take(),
            _temp_dir: self.temp_dir.take(),
            pgid,
        })
    }
}

impl Drop for PreparedMacSandboxPty {
    fn drop(&mut self) {
        drop(self.gate_listener.take());
        let _ = fs::remove_file(&self.gate_socket);
        if let Some(lease) = self.lease.take() {
            let _ = lease.release();
        }
    }
}

fn terminate_sandbox_group(pgid: i32) {
    if pgid <= 1 {
        return;
    }
    if super::process::local_process_group_gone(pgid).unwrap_or(true) {
        return;
    }
    unsafe {
        libc::kill(-pgid, libc::SIGTERM);
    }
    let term_deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
    while std::time::Instant::now() < term_deadline {
        if super::process::local_process_group_gone(pgid).unwrap_or(true) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
    let kill_deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while std::time::Instant::now() < kill_deadline {
        if super::process::local_process_group_gone(pgid).unwrap_or(true) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
}

pub(crate) struct ActiveMacSandboxPtyGuard {
    lease: Option<Lease>,
    _proxy: Option<super::sandbox_proxy::SandboxProxy>,
    _temp_dir: Option<tempfile::TempDir>,
    pgid: i32,
}

impl ActiveMacSandboxPtyGuard {
    pub(crate) fn finish(mut self) {
        self.finish_inner();
    }

    fn finish_inner(&mut self) {
        terminate_sandbox_group(self.pgid);
        if let Some(mut lease) = self.lease.take() {
            let _ = lease.record_ended();
            let _ = lease.release();
        }
        self._proxy.take();
        self._temp_dir.take();
    }
}

impl Drop for ActiveMacSandboxPtyGuard {
    fn drop(&mut self) {
        self.finish_inner();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_open_and_revalidate_managed_workspace() {
        let data_dir = tempfile::tempdir().unwrap();
        let session = format!("mac-sandbox-test-{}", uuid::Uuid::new_v4());
        let workspace_path = create_workspace(data_dir.path(), &session).unwrap();
        let canonical_data = data_dir.path().canonicalize().unwrap();
        assert!(
            Path::new(&workspace_path).starts_with(canonical_data.join(SANDBOXES_DIR)),
            "expected workspace under <data_dir>/sandboxes, got {workspace_path}"
        );
        let launcher_dir = tempfile::tempdir().unwrap();
        let launcher = launcher_dir.path().join("shellspan-sandbox-launcher");
        fs::copy("/bin/sh", &launcher).unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
        let checksum = hex::encode(Sha256::digest(fs::read(&launcher).unwrap()));

        let binding = Workspace::open_with_launcher(
            data_dir.path(),
            Path::new(&workspace_path),
            launcher.clone(),
            checksum.clone(),
            crate::agent_runtime::SandboxNetworkPolicy::blocked(),
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
        let data_dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let error = remove_workspace(data_dir.path(), outside.path()).unwrap_err();
        assert!(error.contains(START_FAILED));
    }

    #[test]
    fn tampered_identity_is_rejected() {
        let data_dir = tempfile::tempdir().unwrap();
        let session = format!("mac-sandbox-tamper-{}", uuid::Uuid::new_v4());
        let workspace_path = create_workspace(data_dir.path(), &session).unwrap();
        let anchor = Path::new(&workspace_path).parent().unwrap().to_path_buf();
        fs::write(identity_file(&anchor), b"tampered").unwrap();

        let launcher_dir = tempfile::tempdir().unwrap();
        let launcher = launcher_dir.path().join("shellspan-sandbox-launcher");
        fs::copy("/bin/sh", &launcher).unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
        let checksum = hex::encode(Sha256::digest(fs::read(&launcher).unwrap()));

        let error = Workspace::open_with_launcher(
            data_dir.path(),
            Path::new(&workspace_path),
            launcher,
            checksum,
            crate::agent_runtime::SandboxNetworkPolicy::blocked(),
        )
        .unwrap_err();
        assert!(error.contains("identity changed"));
        fs::remove_dir_all(&anchor).unwrap();
    }

    #[test]
    fn create_workspace_rejects_group_writable_data_root() {
        let data_dir = tempfile::tempdir().unwrap();
        fs::set_permissions(data_dir.path(), fs::Permissions::from_mode(0o775)).unwrap();
        let error = create_workspace(data_dir.path(), "group-writable-session").unwrap_err();
        assert!(error.contains("group or world writable"), "got {error}");
    }

    #[test]
    fn storage_stats_distinguishes_active_and_reclaimable_workspaces() {
        let data_dir = tempfile::tempdir().unwrap();
        let active_ws = create_workspace(data_dir.path(), "active-session").unwrap();
        let idle_ws = create_workspace(data_dir.path(), "idle-session").unwrap();
        fs::write(Path::new(&active_ws).join("active.bin"), vec![1u8; 1024]).unwrap();
        fs::write(Path::new(&idle_ws).join("idle.bin"), vec![2u8; 2048]).unwrap();

        let mut active = HashSet::new();
        active.insert(crate::path_utils::portable_local_path(Path::new(
            &active_ws,
        )));

        let stats = storage_stats(data_dir.path(), &active);
        assert_eq!(stats.total_count, 2);
        assert_eq!(stats.active_count, 1);
        assert_eq!(stats.reclaimable_count, 1);
        assert!(stats.active_bytes >= 1024);
        assert!(stats.reclaimable_bytes >= 2048);
        assert_eq!(
            stats.total_bytes,
            stats.active_bytes + stats.reclaimable_bytes
        );
    }

    #[test]
    fn prepared_mac_sandbox_pty_enforces_seatbelt_and_nip_handshake() {
        use portable_pty::{native_pty_system, PtySize};
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        use std::time::{Duration, Instant};

        let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/native-input/generated");
        if resolve_verified_launcher(Some(&resources)).is_err() {
            return;
        }
        let Ok(mut prepared_native) = crate::terminal_command::local::PreparedNativeBash::prepare(
            Path::new("/bin/zsh"),
            &resources,
        ) else {
            return;
        };
        let data_dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let session = format!("mac-sandbox-pty-{}", uuid::Uuid::new_v4());
        let workspace_path = create_workspace(data_dir.path(), &session).unwrap();
        let executable = prepared_native
            .shell_override()
            .unwrap_or(Path::new("/bin/zsh"))
            .to_path_buf();
        let control_socket = prepared_native.control_socket_path();

        let (prepared_pty, mut command) = PreparedMacSandboxPty::prepare(
            data_dir.path(),
            Path::new(&workspace_path),
            Some(&resources),
            crate::agent_runtime::SandboxNetworkPolicy::blocked(),
            prepared_native.nip_root_path(),
            &control_socket,
            &executable,
        )
        .unwrap();
        prepared_native.configure_sandbox_zle(&mut command).unwrap();
        let binding = prepared_pty.binding(&session);
        assert_eq!(binding.agent_session_id, session);
        assert_eq!(binding.workspace_root, workspace_path);

        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut writer = pty.master.take_writer().unwrap();
        let mut reader = pty.master.try_clone_reader().unwrap();
        let mut child = pty.slave.spawn_command(command).unwrap();
        drop(pty.slave);
        let pid = child.process_id().expect("sandbox PTY child pid");
        let guard = prepared_pty.activate(pid).unwrap();

        let handshake_seen = Arc::new(AtomicBool::new(false));
        let handshake_flag = Arc::clone(&handshake_seen);
        let probe = crate::terminal_command::protocol::ConnectionEnvelope {
            protocol: crate::terminal_command::protocol::PROTOCOL.into(),
            request_id: "probe-1".into(),
            connection: crate::terminal_command::protocol::ConnectionIdentity {
                terminal_session_id: "sandbox-pty-test".into(),
                terminal_generation: 1,
                control_id: "sandbox-pty-control".into(),
            },
            payload: crate::terminal_command::protocol::ConnectionPayload::Probe,
        };
        let control_handle = prepared_native.start(
            probe,
            move |_message| {
                handshake_flag.store(true, Ordering::Release);
                Ok(())
            },
            || {},
        );

        let reader_thread = std::thread::spawn(move || {
            let mut buf = [0_u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
            }
        });

        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && !handshake_seen.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            handshake_seen.load(Ordering::Acquire),
            "expected NIP handshake from sandboxed zsh PTY"
        );
        // Control socket is unlinked immediately after single sandbox accept.
        assert!(
            !control_socket.exists(),
            "sandbox NIP control socket must be unlinked after initial handshake"
        );

        let inside_file = Path::new(&workspace_path).join("allowed.txt");
        let outside_file = outside.path().join("blocked.txt");
        let cmd = format!(
            "printf ok > '{}'; printf nope > '{}' 2>/dev/null; printf done > '{}'\n",
            inside_file.display(),
            outside_file.display(),
            Path::new(&workspace_path).join("done.txt").display()
        );
        writer.write_all(cmd.as_bytes()).unwrap();
        writer.flush().unwrap();

        let done_file = Path::new(&workspace_path).join("done.txt");
        let cmd_deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < cmd_deadline && !done_file.exists() {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(fs::read_to_string(&inside_file).unwrap(), "ok");
        assert!(
            !outside_file.exists(),
            "Seatbelt must block writes outside the managed sandbox workspace"
        );

        drop(control_handle);
        drop(writer);
        drop(pty.master);
        guard.finish();
        let _ = child.wait();
        let _ = reader_thread.join();

        let anchor = Path::new(&workspace_path).parent().unwrap();
        fs::remove_dir_all(anchor).unwrap();
    }
}
