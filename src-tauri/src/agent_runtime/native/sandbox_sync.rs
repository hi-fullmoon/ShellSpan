//! Host-side project import, baseline tracking, diffing, and safe syncback
//! for managed local Agent sandbox workspaces.
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const BASELINE_VERSION: u32 = 1;
const MAX_IMPORT_FILES: usize = 5_000;
const MAX_IMPORT_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PREVIEW_FILE_BYTES: u64 = 512 * 1024;
const MAX_PREVIEW_DIFF_BYTES: usize = 128 * 1024;

const IGNORED_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "__pycache__",
    ".venv",
    "venv",
    ".DS_Store",
    "Thumbs.db",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BaselineEntry {
    pub(crate) sha256: String,
    pub(crate) size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceBaseline {
    pub(crate) version: u32,
    pub(crate) source_root: String,
    pub(crate) files: BTreeMap<String, BaselineEntry>,
    pub(crate) skipped_count: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SandboxChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxFileChange {
    pub(crate) path: String,
    pub(crate) kind: SandboxChangeKind,
    pub(crate) conflict: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) sandbox_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxDiffReport {
    pub(crate) source_root: String,
    pub(crate) changes: Vec<SandboxFileChange>,
    pub(crate) total_changes: usize,
    pub(crate) conflict_count: usize,
    #[serde(default)]
    pub(crate) skipped_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxApplyReport {
    pub(crate) applied: Vec<String>,
    pub(crate) skipped_conflicts: Vec<String>,
    pub(crate) errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxDiscardReport {
    pub(crate) discarded: Vec<String>,
    pub(crate) errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxWorkspaceSourceInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source_root: Option<String>,
    pub(crate) skipped_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxStorageStats {
    pub(crate) total_count: usize,
    pub(crate) total_bytes: u64,
    pub(crate) active_count: usize,
    pub(crate) active_bytes: u64,
    pub(crate) reclaimable_count: usize,
    pub(crate) reclaimable_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxCleanupReport {
    pub(crate) removed_count: usize,
    pub(crate) freed_bytes: u64,
    pub(crate) failed_count: usize,
}

#[cfg(any(windows, target_os = "macos", test))]
pub(crate) fn directory_size_bytes(root: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

pub(crate) fn read_workspace_source_info(baseline_path: &Path) -> SandboxWorkspaceSourceInfo {
    if !baseline_path.exists() {
        return SandboxWorkspaceSourceInfo {
            source_root: None,
            skipped_count: 0,
        };
    }
    match load_baseline(baseline_path) {
        Ok(baseline) => SandboxWorkspaceSourceInfo {
            source_root: Some(baseline.source_root),
            skipped_count: baseline.skipped_count,
        },
        Err(_) => SandboxWorkspaceSourceInfo {
            source_root: None,
            skipped_count: 0,
        },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxFileDiffPreview {
    pub(crate) path: String,
    pub(crate) is_binary: bool,
    pub(crate) truncated: bool,
    pub(crate) unified_diff: String,
}

pub(crate) fn baseline_path_for_workspace(workspace: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(anchor) = workspace.parent() {
            let data = anchor.join("data");
            if data.is_dir() {
                return data.join("source-baseline.json");
            }
        }
    }
    workspace.with_extension("baseline.json")
}

/// Returns true if `candidate` is a real project directory suitable for automatic
/// import into a managed sandbox workspace (excluding filesystem roots, the
/// user's home directory itself, and ShellSpan's own application data directory).
pub(crate) fn is_importable_project_root(
    candidate: &Path,
    home: &Path,
    data_dir: &Path,
) -> Option<PathBuf> {
    if !candidate.is_absolute() {
        return None;
    }
    let meta = fs::symlink_metadata(candidate).ok()?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return None;
    }
    let canonical = fs::canonicalize(candidate).ok()?;
    if canonical.parent().is_none() {
        return None;
    }
    if let Ok(home_canon) = fs::canonicalize(home) {
        if canonical == home_canon {
            return None;
        }
    }
    if let Ok(data_canon) = fs::canonicalize(data_dir) {
        if canonical == data_canon || canonical.starts_with(&data_canon) {
            return None;
        }
    }
    Some(canonical)
}

fn is_ignored_name(name: &str) -> bool {
    IGNORED_NAMES.contains(&name)
}

fn is_sensitive_import_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower == ".env" {
        return true;
    }
    if let Some(suffix) = lower.strip_prefix(".env.") {
        return !matches!(suffix, "example" | "sample" | "template" | "dist");
    }
    if matches!(
        lower.as_str(),
        "id_rsa"
            | "id_ed25519"
            | "id_ecdsa"
            | "id_dsa"
            | ".npmrc"
            | ".pypirc"
            | ".netrc"
            | "credentials.json"
            | "service-account.json"
    ) {
        return true;
    }
    matches!(
        Path::new(&lower).extension().and_then(|ext| ext.to_str()),
        Some("pem" | "key" | "p12" | "pfx" | "jks" | "keystore")
    )
}

#[derive(Default)]
struct SimpleGitignore {
    dir_names: BTreeSet<String>,
    exact_names: BTreeSet<String>,
    rel_prefixes: Vec<String>,
    suffixes: Vec<String>,
}

impl SimpleGitignore {
    fn load(root: &Path) -> Self {
        let mut ignore = Self::default();
        let path = root.join(".gitignore");
        let Ok(file) = open_regular_nofollow(&path) else {
            return ignore;
        };
        let mut raw = String::new();
        if file.take(256 * 1024).read_to_string(&mut raw).is_err() {
            return ignore;
        }
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('!') {
                continue;
            }
            let dir_only = trimmed.ends_with('/');
            let pattern = trimmed.trim_start_matches('/').trim_end_matches('/');
            if pattern.is_empty() {
                continue;
            }
            if let Some(ext) = pattern.strip_prefix('*') {
                if !ext.is_empty() && !ext.contains(['*', '?', '/']) {
                    ignore.suffixes.push(ext.to_string());
                }
                continue;
            }
            if pattern.contains(['*', '?', '[']) {
                continue;
            }
            if pattern.contains('/') {
                ignore.rel_prefixes.push(pattern.to_string());
            } else if dir_only {
                ignore.dir_names.insert(pattern.to_string());
            } else {
                ignore.exact_names.insert(pattern.to_string());
            }
        }
        ignore
    }

    fn matches(&self, rel: &str, name: &str, is_dir: bool) -> bool {
        if is_dir && self.dir_names.contains(name) {
            return true;
        }
        if self.exact_names.contains(name) {
            return true;
        }
        if self
            .rel_prefixes
            .iter()
            .any(|prefix| rel == prefix || rel.starts_with(&format!("{prefix}/")))
        {
            return true;
        }
        !is_dir && self.suffixes.iter().any(|suffix| name.ends_with(suffix))
    }
}

fn open_regular_nofollow(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(io::Error::other(format!(
            "Refusing to read non-regular or symbolic link file at {}",
            path.display()
        )));
    }
    Ok(file)
}

#[cfg(unix)]
fn copy_file_mode(src_meta: &fs::Metadata, dst_file: &File) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = src_meta.permissions().mode() & 0o777;
    // Ensure owner read/write bits so host tools can still maintain the file.
    let safe_mode = mode | 0o600;
    dst_file.set_permissions(fs::Permissions::from_mode(safe_mode))
}

#[cfg(not(unix))]
fn copy_file_mode(_src_meta: &fs::Metadata, _dst_file: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn try_clonefile_regular(src: &Path, dst: &Path) -> io::Result<bool> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;

    const CLONE_NOFOLLOW: libc::c_uint = 0x0001;
    extern "C" {
        fn clonefile(
            src: *const libc::c_char,
            dst: *const libc::c_char,
            flags: libc::c_uint,
        ) -> libc::c_int;
    }

    let src_meta = fs::symlink_metadata(src)?;
    if src_meta.file_type().is_symlink() || !src_meta.is_file() {
        return Err(io::Error::other(format!(
            "Refusing to clone non-regular or symbolic link file at {}",
            src.display()
        )));
    }
    let src_c = CString::new(src.as_os_str().as_bytes())
        .map_err(|_| io::Error::other("Invalid NUL byte in source path"))?;
    let dst_c = CString::new(dst.as_os_str().as_bytes())
        .map_err(|_| io::Error::other("Invalid NUL byte in destination path"))?;
    if unsafe { clonefile(src_c.as_ptr(), dst_c.as_ptr(), CLONE_NOFOLLOW) } != 0 {
        return Ok(false);
    }
    let cloned = open_regular_nofollow(dst)?;
    let mode = (src_meta.permissions().mode() & 0o777) | 0o600;
    cloned.set_permissions(fs::Permissions::from_mode(mode))?;
    Ok(true)
}

#[cfg(not(target_os = "macos"))]
fn try_clonefile_regular(_src: &Path, _dst: &Path) -> io::Result<bool> {
    Ok(false)
}

fn import_regular_file(src: &Path, dst: &Path) -> io::Result<()> {
    if try_clonefile_regular(src, dst)? {
        return Ok(());
    }
    let mut reader = open_regular_nofollow(src)?;
    let src_meta = reader.metadata()?;
    let mut writer = OpenOptions::new().write(true).create_new(true).open(dst)?;
    io::copy(&mut reader, &mut writer)?;
    copy_file_mode(&src_meta, &writer)?;
    Ok(())
}

fn resolve_host_git() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        for candidate in [
            "/Library/Developer/CommandLineTools/usr/bin/git",
            "/usr/bin/git",
            "/opt/homebrew/bin/git",
            "/usr/local/bin/git",
        ] {
            let path = Path::new(candidate);
            if path.is_file() {
                return Some(path.to_path_buf());
            }
        }
        None
    }
    #[cfg(windows)]
    {
        if let Some(program_files) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
            let candidate = program_files.join("Git\\cmd\\git.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        for candidate in ["/usr/bin/git", "/bin/git"] {
            let path = Path::new(candidate);
            if path.is_file() {
                return Some(path.to_path_buf());
            }
        }
        None
    }
}

/// Initializes a completely isolated, hook-free Git baseline inside `workspace`
/// when `source_root` is a Git repository, so sandboxed agents can run `git status`
/// and `git diff` safely without ever touching host `.git` objects or executing
/// repository-supplied hooks (`core.fsmonitor`, `core.sshCommand`, `.git/hooks`).
fn init_sanitized_git_snapshot(source_root: &Path, workspace: &Path) {
    if !source_root.join(".git").exists() {
        return;
    }
    let Some(git) = resolve_host_git() else {
        return;
    };
    let run_git = |args: &[&str]| -> bool {
        let mut command = std::process::Command::new(&git);
        command
            .args(args)
            .current_dir(workspace)
            .env_clear()
            .env("HOME", workspace)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_AUTHOR_NAME", "ShellSpan Sandbox")
            .env("GIT_AUTHOR_EMAIL", "sandbox@shellspan.local")
            .env("GIT_COMMITTER_NAME", "ShellSpan Sandbox")
            .env("GIT_COMMITTER_EMAIL", "sandbox@shellspan.local")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        {
            command
                .env("PATH", "/usr/bin:/bin")
                .env("GIT_CONFIG_GLOBAL", "/dev/null");
        }
        #[cfg(windows)]
        {
            if let Some(system_root) = std::env::var_os("SystemRoot") {
                command.env("SystemRoot", system_root);
            }
            command.env("GIT_CONFIG_GLOBAL", "NUL");
        }
        command.status().is_ok_and(|status| status.success())
    };
    let initialized =
        run_git(&["init", "-q", "--initial-branch=sandbox-baseline"]) || run_git(&["init", "-q"]);
    if !initialized {
        let _ = fs::remove_dir_all(workspace.join(".git"));
        return;
    }
    let _ = fs::remove_dir_all(workspace.join(".git/hooks"));
    #[cfg(unix)]
    let _ = run_git(&["config", "--local", "core.hooksPath", "/dev/null"]);
    let ok = run_git(&["config", "--local", "core.fsmonitor", "false"])
        && run_git(&["config", "--local", "core.sshCommand", "false"])
        && run_git(&["config", "--local", "commit.gpgsign", "false"])
        && run_git(&["config", "--local", "tag.gpgsign", "false"])
        && run_git(&["add", "-A"])
        && run_git(&[
            "commit",
            "-q",
            "--no-verify",
            "--allow-empty",
            "-m",
            "Sandbox baseline snapshot",
        ]);
    if !ok {
        let _ = fs::remove_dir_all(workspace.join(".git"));
    }
}

fn validate_relative_path(rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || rel.contains('\0') {
        return Err("Invalid relative path".into());
    }
    let path = Path::new(rel);
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            _ => return Err(format!("Unsafe path component in {rel}")),
        }
    }
    if clean.as_os_str().is_empty() {
        return Err("Empty relative path".into());
    }
    Ok(clean)
}

fn hash_file(path: &Path) -> io::Result<(String, u64)> {
    let mut file = open_regular_nofollow(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        total += count as u64;
    }
    Ok((hex::encode(hasher.finalize()), total))
}

fn collect_tree(
    root: &Path,
    enforce_limits: bool,
    filter_import_policy: bool,
) -> Result<(BTreeMap<String, BaselineEntry>, usize), String> {
    let gitignore = if filter_import_policy {
        Some(SimpleGitignore::load(root))
    } else {
        None
    };
    let mut files = BTreeMap::new();
    let mut skipped = 0usize;
    let mut total_bytes = 0u64;
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let entries = fs::read_dir(&dir)
            .map_err(|error| format!("Failed to read directory {}: {error}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let name_os = entry.file_name();
            let Some(name) = name_os.to_str() else {
                skipped += 1;
                continue;
            };
            if is_ignored_name(name) {
                skipped += 1;
                continue;
            }
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if meta.file_type().is_symlink() {
                skipped += 1;
                continue;
            }
            let rel = if prefix.is_empty() {
                name.to_string()
            } else {
                format!("{prefix}/{name}")
            };
            if let Some(ignore) = &gitignore {
                if ignore.matches(&rel, name, meta.is_dir()) {
                    skipped += 1;
                    continue;
                }
            }
            if meta.is_dir() {
                stack.push((path, rel));
            } else if meta.is_file() {
                if filter_import_policy && is_sensitive_import_name(name) {
                    skipped += 1;
                    continue;
                }
                if enforce_limits && meta.len() > MAX_SINGLE_FILE_BYTES {
                    skipped += 1;
                    continue;
                }
                if enforce_limits && files.len() >= MAX_IMPORT_FILES {
                    return Err(format!(
                        "SANDBOX_IMPORT_LIMIT: project exceeds {MAX_IMPORT_FILES} file limit"
                    ));
                }
                let (sha256, size) = hash_file(&path).map_err(|error| error.to_string())?;
                total_bytes = total_bytes.saturating_add(size);
                if enforce_limits && total_bytes > MAX_IMPORT_TOTAL_BYTES {
                    return Err(format!(
                        "SANDBOX_IMPORT_LIMIT: project exceeds {} MiB import limit",
                        MAX_IMPORT_TOTAL_BYTES / (1024 * 1024)
                    ));
                }
                files.insert(rel, BaselineEntry { sha256, size });
            }
        }
    }
    Ok((files, skipped))
}

fn save_baseline(path: &Path, baseline: &WorkspaceBaseline) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid baseline path".to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(&mut temp, baseline).map_err(|error| error.to_string())?;
    temp.flush().map_err(|error| error.to_string())?;
    temp.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temp.persist(path)
        .map_err(|error| error.error.to_string())?;
    Ok(())
}

fn load_baseline(path: &Path) -> Result<WorkspaceBaseline, String> {
    let bytes = fs::read(path).map_err(|error| format!("SANDBOX_BASELINE_UNAVAILABLE: {error}"))?;
    let baseline: WorkspaceBaseline = serde_json::from_slice(&bytes)
        .map_err(|error| format!("SANDBOX_BASELINE_INVALID: {error}"))?;
    if baseline.version != BASELINE_VERSION {
        return Err("SANDBOX_BASELINE_INVALID: unsupported baseline version".into());
    }
    Ok(baseline)
}

pub(crate) fn import_source_into_workspace(
    source_root: &Path,
    workspace: &Path,
    baseline_path: &Path,
) -> Result<WorkspaceBaseline, String> {
    let source_meta = fs::symlink_metadata(source_root)
        .map_err(|error| format!("Invalid sandbox source directory: {error}"))?;
    if source_meta.file_type().is_symlink() || !source_meta.is_dir() {
        return Err("Sandbox source root must be a real directory".into());
    }
    let source_canon = fs::canonicalize(source_root).map_err(|error| error.to_string())?;
    if source_canon.parent().is_none() {
        return Err("Filesystem roots cannot be imported into a sandbox".into());
    }
    let (files, skipped_count) = collect_tree(&source_canon, true, true)?;
    for rel in files.keys() {
        let clean = validate_relative_path(rel)?;
        let src = source_canon.join(&clean);
        let dst = workspace.join(&clean);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        import_regular_file(&src, &dst)
            .map_err(|error| format!("Failed to import {} into sandbox workspace: {error}", rel))?;
    }
    init_sanitized_git_snapshot(&source_canon, workspace);
    let baseline = WorkspaceBaseline {
        version: BASELINE_VERSION,
        source_root: crate::path_utils::portable_local_path(&source_canon),
        files,
        skipped_count,
    };
    save_baseline(baseline_path, &baseline)?;
    Ok(baseline)
}

fn ensure_no_symlink_components(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for component in rel.components() {
        let Component::Normal(part) = component else {
            return Err("Unsafe relative path component".into());
        };
        current.push(part);
        if let Ok(meta) = fs::symlink_metadata(&current) {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "Refusing to traverse symbolic link at {}",
                    current.display()
                ));
            }
        }
    }
    Ok(current)
}

fn source_entry_state(source_root: &Path, rel: &Path) -> Result<Option<BaselineEntry>, String> {
    let full = ensure_no_symlink_components(source_root, rel)?;
    match fs::symlink_metadata(&full) {
        Ok(meta) if meta.is_file() => {
            let (sha256, size) = hash_file(&full).map_err(|error| error.to_string())?;
            Ok(Some(BaselineEntry { sha256, size }))
        }
        Ok(_) => Err(format!(
            "Source path {} is not a regular file",
            rel.display()
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn diff_workspace_against_baseline(
    workspace: &Path,
    baseline_path: &Path,
) -> Result<SandboxDiffReport, String> {
    let baseline = load_baseline(baseline_path)?;
    let source_root = PathBuf::from(&baseline.source_root);
    let (current_files, _) = collect_tree(workspace, false, false)?;
    let mut all_paths = BTreeSet::new();
    for path in baseline.files.keys() {
        all_paths.insert(path.clone());
    }
    for path in current_files.keys() {
        all_paths.insert(path.clone());
    }
    let mut changes = Vec::new();
    for rel in all_paths {
        let clean = validate_relative_path(&rel)?;
        let base_entry = baseline.files.get(&rel);
        let cur_entry = current_files.get(&rel);
        match (base_entry, cur_entry) {
            (None, Some(cur)) => {
                let src_state = source_entry_state(&source_root, &clean)?;
                let conflict = src_state.is_some();
                changes.push(SandboxFileChange {
                    path: rel,
                    kind: SandboxChangeKind::Added,
                    conflict,
                    sandbox_size: Some(cur.size),
                    source_size: src_state.map(|entry| entry.size),
                });
            }
            (Some(base), Some(cur)) if base.sha256 != cur.sha256 => {
                let src_state = source_entry_state(&source_root, &clean)?;
                let conflict = src_state
                    .as_ref()
                    .is_none_or(|state| state.sha256 != base.sha256);
                changes.push(SandboxFileChange {
                    path: rel,
                    kind: SandboxChangeKind::Modified,
                    conflict,
                    sandbox_size: Some(cur.size),
                    source_size: src_state.map(|entry| entry.size),
                });
            }
            (Some(base), None) => {
                let src_state = source_entry_state(&source_root, &clean)?;
                let conflict = src_state
                    .as_ref()
                    .is_some_and(|state| state.sha256 != base.sha256);
                changes.push(SandboxFileChange {
                    path: rel,
                    kind: SandboxChangeKind::Deleted,
                    conflict,
                    sandbox_size: None,
                    source_size: src_state.map(|entry| entry.size),
                });
            }
            _ => {}
        }
    }
    let conflict_count = changes.iter().filter(|item| item.conflict).count();
    let total_changes = changes.len();
    Ok(SandboxDiffReport {
        source_root: baseline.source_root,
        changes,
        total_changes,
        conflict_count,
        skipped_count: baseline.skipped_count,
    })
}

pub(crate) fn apply_workspace_changes(
    workspace: &Path,
    baseline_path: &Path,
    selected_paths: Option<&[String]>,
    allow_overwrite_conflicts: bool,
) -> Result<SandboxApplyReport, String> {
    let mut baseline = load_baseline(baseline_path)?;
    let report = diff_workspace_against_baseline(workspace, baseline_path)?;
    let source_root = PathBuf::from(&baseline.source_root);
    let source_meta = fs::symlink_metadata(&source_root)
        .map_err(|error| format!("Invalid sandbox source directory: {error}"))?;
    if source_meta.file_type().is_symlink() || !source_meta.is_dir() {
        return Err("Sandbox source root must be a real directory".into());
    }
    let selected: Option<BTreeSet<&str>> =
        selected_paths.map(|list| list.iter().map(String::as_str).collect());

    let mut applied = Vec::new();
    let mut skipped_conflicts = Vec::new();
    let mut errors = Vec::new();

    for change in report.changes {
        if let Some(filter) = &selected {
            if !filter.contains(change.path.as_str()) {
                continue;
            }
        }
        if change.conflict && !allow_overwrite_conflicts {
            skipped_conflicts.push(change.path);
            continue;
        }
        let clean = match validate_relative_path(&change.path) {
            Ok(path) => path,
            Err(error) => {
                errors.push(format!("{}: {error}", change.path));
                continue;
            }
        };
        let dest = match ensure_no_symlink_components(&source_root, &clean) {
            Ok(path) => path,
            Err(error) => {
                errors.push(format!("{}: {error}", change.path));
                continue;
            }
        };
        match change.kind {
            SandboxChangeKind::Added | SandboxChangeKind::Modified => {
                let src = match ensure_no_symlink_components(workspace, &clean) {
                    Ok(path) => path,
                    Err(error) => {
                        errors.push(format!("{}: {error}", change.path));
                        continue;
                    }
                };
                if !allow_overwrite_conflicts {
                    match source_entry_state(&source_root, &clean) {
                        Ok(Some(state))
                            if baseline
                                .files
                                .get(&change.path)
                                .is_none_or(|base| base.sha256 != state.sha256) =>
                        {
                            skipped_conflicts.push(change.path);
                            continue;
                        }
                        Ok(None) if baseline.files.contains_key(&change.path) => {
                            skipped_conflicts.push(change.path);
                            continue;
                        }
                        Ok(_) => {}
                        Err(error) => {
                            errors.push(format!("{}: {error}", change.path));
                            continue;
                        }
                    }
                }
                if let Some(parent) = dest.parent() {
                    if let Err(error) = fs::create_dir_all(parent) {
                        errors.push(format!("{}: {error}", change.path));
                        continue;
                    }
                }
                let copy_result = (|| -> io::Result<BaselineEntry> {
                    let parent = dest
                        .parent()
                        .ok_or_else(|| io::Error::other("Missing destination parent"))?;
                    let mut reader = open_regular_nofollow(&src)?;
                    let src_meta = reader.metadata()?;
                    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
                    let mut hasher = Sha256::new();
                    let mut buf = [0u8; 64 * 1024];
                    let mut size = 0u64;
                    loop {
                        let n = reader.read(&mut buf)?;
                        if n == 0 {
                            break;
                        }
                        temp.write_all(&buf[..n])?;
                        hasher.update(&buf[..n]);
                        size += n as u64;
                    }
                    copy_file_mode(&src_meta, temp.as_file())?;
                    temp.flush()?;
                    temp.as_file().sync_all()?;
                    if let Ok(dest_meta) = fs::symlink_metadata(&dest) {
                        if dest_meta.file_type().is_symlink() || !dest_meta.is_file() {
                            return Err(io::Error::other(
                                "Refusing to overwrite non-regular or symbolic link destination",
                            ));
                        }
                    }
                    temp.persist(&dest).map_err(|e| e.error)?;
                    Ok(BaselineEntry {
                        sha256: hex::encode(hasher.finalize()),
                        size,
                    })
                })();
                match copy_result {
                    Ok(entry) => {
                        baseline.files.insert(change.path.clone(), entry);
                        applied.push(change.path);
                    }
                    Err(error) => errors.push(format!("{}: {error}", change.path)),
                }
            }
            SandboxChangeKind::Deleted => {
                match fs::symlink_metadata(&dest) {
                    Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
                        errors.push(format!(
                            "{}: refusing to delete non-regular or symbolic link destination",
                            change.path
                        ));
                        continue;
                    }
                    Ok(_) => {
                        if !allow_overwrite_conflicts {
                            match hash_file(&dest) {
                                Ok((sha256, _))
                                    if baseline
                                        .files
                                        .get(&change.path)
                                        .is_none_or(|base| base.sha256 != sha256) =>
                                {
                                    skipped_conflicts.push(change.path);
                                    continue;
                                }
                                Ok(_) => {}
                                Err(error) => {
                                    errors.push(format!("{}: {error}", change.path));
                                    continue;
                                }
                            }
                        }
                        if let Err(error) = trash::TrashContext::new().delete(&dest) {
                            errors.push(format!("{}: {error}", change.path));
                            continue;
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => {
                        errors.push(format!("{}: {error}", change.path));
                        continue;
                    }
                }
                baseline.files.remove(&change.path);
                applied.push(change.path);
            }
        }
    }

    save_baseline(baseline_path, &baseline)?;
    Ok(SandboxApplyReport {
        applied,
        skipped_conflicts,
        errors,
    })
}

pub(crate) fn discard_workspace_changes(
    workspace: &Path,
    baseline_path: &Path,
    selected_paths: Option<&[String]>,
) -> Result<SandboxDiscardReport, String> {
    let mut baseline = load_baseline(baseline_path)?;
    let report = diff_workspace_against_baseline(workspace, baseline_path)?;
    let source_root = PathBuf::from(&baseline.source_root);
    let source_meta = fs::symlink_metadata(&source_root)
        .map_err(|error| format!("Invalid sandbox source directory: {error}"))?;
    if source_meta.file_type().is_symlink() || !source_meta.is_dir() {
        return Err("Sandbox source root must be a real directory".into());
    }
    let selected: Option<BTreeSet<&str>> =
        selected_paths.map(|list| list.iter().map(String::as_str).collect());

    let mut discarded = Vec::new();
    let mut errors = Vec::new();

    for change in report.changes {
        if let Some(filter) = &selected {
            if !filter.contains(change.path.as_str()) {
                continue;
            }
        }
        let clean = match validate_relative_path(&change.path) {
            Ok(path) => path,
            Err(error) => {
                errors.push(format!("{}: {error}", change.path));
                continue;
            }
        };
        let ws_path = match ensure_no_symlink_components(workspace, &clean) {
            Ok(path) => path,
            Err(error) => {
                errors.push(format!("{}: {error}", change.path));
                continue;
            }
        };
        match change.kind {
            SandboxChangeKind::Added => {
                match fs::symlink_metadata(&ws_path) {
                    Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
                        errors.push(format!(
                            "{}: refusing to discard non-regular or symbolic link file",
                            change.path
                        ));
                        continue;
                    }
                    Ok(_) => {
                        if let Err(error) = trash::TrashContext::new().delete(&ws_path) {
                            errors.push(format!("{}: {error}", change.path));
                            continue;
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => {
                        errors.push(format!("{}: {error}", change.path));
                        continue;
                    }
                }
                discarded.push(change.path);
            }
            SandboxChangeKind::Modified | SandboxChangeKind::Deleted => {
                let src_path = match ensure_no_symlink_components(&source_root, &clean) {
                    Ok(path) => path,
                    Err(error) => {
                        errors.push(format!("{}: {error}", change.path));
                        continue;
                    }
                };
                match fs::symlink_metadata(&src_path) {
                    Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
                        errors.push(format!(
                            "{}: source path is not a regular file",
                            change.path
                        ));
                        continue;
                    }
                    Ok(_) => {
                        if let Some(parent) = ws_path.parent() {
                            if let Err(error) = fs::create_dir_all(parent) {
                                errors.push(format!("{}: {error}", change.path));
                                continue;
                            }
                        }
                        let restore_result = (|| -> io::Result<BaselineEntry> {
                            let parent = ws_path
                                .parent()
                                .ok_or_else(|| io::Error::other("Missing workspace parent"))?;
                            let mut reader = open_regular_nofollow(&src_path)?;
                            let src_meta = reader.metadata()?;
                            let mut temp = tempfile::NamedTempFile::new_in(parent)?;
                            let mut hasher = Sha256::new();
                            let mut buf = [0u8; 64 * 1024];
                            let mut size = 0u64;
                            loop {
                                let n = reader.read(&mut buf)?;
                                if n == 0 {
                                    break;
                                }
                                temp.write_all(&buf[..n])?;
                                hasher.update(&buf[..n]);
                                size += n as u64;
                            }
                            copy_file_mode(&src_meta, temp.as_file())?;
                            temp.flush()?;
                            temp.as_file().sync_all()?;
                            if let Ok(ws_meta) = fs::symlink_metadata(&ws_path) {
                                if ws_meta.file_type().is_symlink() || !ws_meta.is_file() {
                                    return Err(io::Error::other(
                                        "Refusing to overwrite non-regular or symbolic link workspace file",
                                    ));
                                }
                            }
                            temp.persist(&ws_path).map_err(|e| e.error)?;
                            Ok(BaselineEntry {
                                sha256: hex::encode(hasher.finalize()),
                                size,
                            })
                        })();
                        match restore_result {
                            Ok(entry) => {
                                baseline.files.insert(change.path.clone(), entry);
                                discarded.push(change.path);
                            }
                            Err(error) => errors.push(format!("{}: {error}", change.path)),
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        match fs::symlink_metadata(&ws_path) {
                            Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
                                errors.push(format!(
                                    "{}: refusing to remove non-regular workspace file",
                                    change.path
                                ));
                                continue;
                            }
                            Ok(_) => {
                                if let Err(error) = trash::TrashContext::new().delete(&ws_path) {
                                    errors.push(format!("{}: {error}", change.path));
                                    continue;
                                }
                            }
                            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                            Err(err) => {
                                errors.push(format!("{}: {err}", change.path));
                                continue;
                            }
                        }
                        baseline.files.remove(&change.path);
                        discarded.push(change.path);
                    }
                    Err(error) => {
                        errors.push(format!("{}: {error}", change.path));
                    }
                }
            }
        }
    }

    save_baseline(baseline_path, &baseline)?;
    Ok(SandboxDiscardReport { discarded, errors })
}

fn read_preview_text(path: &Path) -> Result<Option<(String, bool, bool)>, String> {
    let mut file = match open_regular_nofollow(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let meta = file.metadata().map_err(|error| error.to_string())?;
    let truncated = meta.len() > MAX_PREVIEW_FILE_BYTES;
    let limit = meta.len().min(MAX_PREVIEW_FILE_BYTES) as usize;
    let mut bytes = vec![0u8; limit];
    file.read_exact(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.contains(&0) {
        return Ok(Some((String::new(), true, truncated)));
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(Some((text, false, truncated))),
        Err(_) => Ok(Some((String::new(), true, truncated))),
    }
}

pub(crate) fn diff_file_preview(
    workspace: &Path,
    baseline_path: &Path,
    rel_path: &str,
) -> Result<SandboxFileDiffPreview, String> {
    let baseline = load_baseline(baseline_path)?;
    let source_root = PathBuf::from(&baseline.source_root);
    let clean = validate_relative_path(rel_path)?;
    let src_full = ensure_no_symlink_components(&source_root, &clean)?;
    let ws_full = ensure_no_symlink_components(workspace, &clean)?;

    let src_read = read_preview_text(&src_full)?;
    let ws_read = read_preview_text(&ws_full)?;
    let is_binary = src_read.as_ref().is_some_and(|(_, bin, _)| *bin)
        || ws_read.as_ref().is_some_and(|(_, bin, _)| *bin);
    if is_binary {
        return Ok(SandboxFileDiffPreview {
            path: rel_path.to_string(),
            is_binary: true,
            truncated: false,
            unified_diff: String::new(),
        });
    }
    let mut truncated = src_read.as_ref().is_some_and(|(_, _, trunc)| *trunc)
        || ws_read.as_ref().is_some_and(|(_, _, trunc)| *trunc);
    let src_text = src_read.map(|(text, _, _)| text).unwrap_or_default();
    let ws_text = ws_read.map(|(text, _, _)| text).unwrap_or_default();
    let mut unified = diffy::create_patch(&src_text, &ws_text).to_string();
    if unified.len() > MAX_PREVIEW_DIFF_BYTES {
        let mut end = MAX_PREVIEW_DIFF_BYTES;
        while end > 0 && !unified.is_char_boundary(end) {
            end -= 1;
        }
        unified.truncate(end);
        truncated = true;
    }
    Ok(SandboxFileDiffPreview {
        path: rel_path.to_string(),
        is_binary: false,
        truncated,
        unified_diff: unified,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_diff_conflict_detection_and_safe_apply_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("project");
        let workspace = dir.path().join("sandbox-ws");
        let baseline_path = dir.path().join("source-baseline.json");
        fs::create_dir_all(source.join("src")).unwrap();
        fs::create_dir_all(source.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(source.join("src/app.ts"), "export const v = 1;\n").unwrap();
        fs::write(source.join("README.md"), "# Demo\n").unwrap();
        fs::write(source.join("node_modules/pkg/index.js"), "ignored").unwrap();

        let baseline = import_source_into_workspace(&source, &workspace, &baseline_path).unwrap();
        assert_eq!(baseline.files.len(), 2);
        assert!(!workspace.join("node_modules").exists());

        // Modify one file, add one file, and externally modify README.md to trigger a conflict.
        fs::write(workspace.join("src/app.ts"), "export const v = 2;\n").unwrap();
        fs::write(workspace.join("src/new.ts"), "export const n = 3;\n").unwrap();
        fs::write(workspace.join("README.md"), "# Sandbox edit\n").unwrap();
        fs::write(source.join("README.md"), "# External edit\n").unwrap();

        let diff = diff_workspace_against_baseline(&workspace, &baseline_path).unwrap();
        assert_eq!(diff.total_changes, 3);
        assert_eq!(diff.conflict_count, 1);
        let readme = diff.changes.iter().find(|c| c.path == "README.md").unwrap();
        assert!(readme.conflict);
        assert_eq!(readme.kind, SandboxChangeKind::Modified);

        // Apply without overwrite conflicts: skips README.md, applies app.ts and new.ts.
        let applied = apply_workspace_changes(&workspace, &baseline_path, None, false).unwrap();
        assert_eq!(applied.applied, vec!["src/app.ts", "src/new.ts"]);
        assert_eq!(applied.skipped_conflicts, vec!["README.md"]);
        assert!(applied.errors.is_empty());
        assert_eq!(
            fs::read_to_string(source.join("src/app.ts")).unwrap(),
            "export const v = 2;\n"
        );
        assert_eq!(
            fs::read_to_string(source.join("src/new.ts")).unwrap(),
            "export const n = 3;\n"
        );
        assert_eq!(
            fs::read_to_string(source.join("README.md")).unwrap(),
            "# External edit\n"
        );

        // After apply, only README.md remains in diff.
        let after = diff_workspace_against_baseline(&workspace, &baseline_path).unwrap();
        assert_eq!(after.total_changes, 1);
        assert_eq!(after.changes[0].path, "README.md");

        // Preview unified diff for README.md (source has External edit, sandbox has Sandbox edit).
        let preview = diff_file_preview(&workspace, &baseline_path, "README.md").unwrap();
        assert!(!preview.is_binary);
        assert!(preview.unified_diff.contains("-# External edit"));
        assert!(preview.unified_diff.contains("+# Sandbox edit"));
    }

    #[test]
    fn is_importable_project_root_rejects_home_and_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let data = home.join(".shellspan");
        let project = home.join("repo");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&project).unwrap();

        assert!(is_importable_project_root(&home, &home, &data).is_none());
        assert!(is_importable_project_root(&data, &home, &data).is_none());
        assert!(is_importable_project_root(&project, &home, &data).is_some());
    }

    #[test]
    fn import_skips_sensitive_files_and_gitignore_entries() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("project");
        let workspace = dir.path().join("sandbox-ws");
        let baseline_path = dir.path().join("source-baseline.json");
        fs::create_dir_all(source.join("coverage")).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(source.join(".gitignore"), "coverage/\n*.log\n").unwrap();
        fs::write(source.join(".env"), "API_KEY=secret\n").unwrap();
        fs::write(source.join(".env.local"), "SECRET=1\n").unwrap();
        fs::write(source.join(".env.example"), "API_KEY=\n").unwrap();
        fs::write(source.join("tls.key"), "PRIVATE KEY\n").unwrap();
        fs::write(source.join("debug.log"), "noisy\n").unwrap();
        fs::write(source.join("coverage/report.html"), "ignored\n").unwrap();
        fs::write(source.join("main.rs"), "fn main() {}\n").unwrap();

        let baseline = import_source_into_workspace(&source, &workspace, &baseline_path).unwrap();
        assert!(baseline.files.contains_key("main.rs"));
        assert!(baseline.files.contains_key(".env.example"));
        assert!(!workspace.join(".env").exists());
        assert!(!workspace.join(".env.local").exists());
        assert!(!workspace.join("tls.key").exists());
        assert!(!workspace.join("debug.log").exists());
        assert!(!workspace.join("coverage").exists());
    }

    #[cfg(unix)]
    #[test]
    fn apply_preserves_unix_executable_mode_and_rejects_symlinks() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("project");
        let workspace = dir.path().join("sandbox-ws");
        let baseline_path = dir.path().join("source-baseline.json");
        let outside = dir.path().join("secret.txt");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(&outside, "top-secret").unwrap();
        let script = source.join("run.sh");
        fs::write(&script, "#!/bin/sh\necho v1\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        import_source_into_workspace(&source, &workspace, &baseline_path).unwrap();
        let ws_script = workspace.join("run.sh");
        assert_eq!(
            fs::metadata(&ws_script).unwrap().permissions().mode() & 0o777,
            0o755
        );
        fs::write(&ws_script, "#!/bin/sh\necho v2\n").unwrap();

        let applied = apply_workspace_changes(&workspace, &baseline_path, None, false).unwrap();
        assert_eq!(applied.applied, vec!["run.sh"]);
        assert_eq!(
            fs::metadata(&script).unwrap().permissions().mode() & 0o777,
            0o755
        );

        // open_regular_nofollow must reject symlinks directly.
        let link = workspace.join("leak.txt");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(open_regular_nofollow(&link).is_err());
    }

    #[test]
    fn git_repo_import_creates_sanitized_baseline_snapshot_without_host_hooks() {
        let Some(git) = resolve_host_git() else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("repo");
        let workspace = dir.path().join("sandbox-ws");
        let baseline_path = dir.path().join("source-baseline.json");
        fs::create_dir_all(source.join(".git/hooks")).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(
            source.join(".git/hooks/pre-commit"),
            "#!/bin/sh\necho pwn\n",
        )
        .unwrap();
        fs::write(
            source.join(".git/config"),
            "[core]\n\tfsmonitor = malicious-script\n\tsshCommand = evil\n",
        )
        .unwrap();
        fs::write(source.join("app.txt"), "hello\n").unwrap();

        import_source_into_workspace(&source, &workspace, &baseline_path).unwrap();
        assert!(workspace.join(".git").is_dir());
        assert!(!workspace.join(".git/hooks/pre-commit").exists());
        let sandbox_config = fs::read_to_string(workspace.join(".git/config")).unwrap();
        assert!(!sandbox_config.contains("malicious-script"));
        assert!(!sandbox_config.contains("evil"));

        // Modifying a file in the sandbox shows up in both git diff and baseline diff,
        // without leaking `.git` internals into the baseline diff report.
        fs::write(workspace.join("app.txt"), "hello sandbox\n").unwrap();
        let git_diff = std::process::Command::new(&git)
            .args(["diff", "--name-only"])
            .current_dir(&workspace)
            .output()
            .unwrap();
        assert!(git_diff.status.success());
        assert_eq!(String::from_utf8_lossy(&git_diff.stdout).trim(), "app.txt");

        let report = diff_workspace_against_baseline(&workspace, &baseline_path).unwrap();
        assert_eq!(report.total_changes, 1);
        assert_eq!(report.changes[0].path, "app.txt");
        assert!(report.skipped_count >= 1);
    }

    #[test]
    fn read_workspace_source_info_and_discard_restore_modified_and_deleted_files() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("project");
        let workspace = dir.path().join("sandbox-ws");
        let baseline_path = dir.path().join("source-baseline.json");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(source.join("a.txt"), "original a\n").unwrap();
        fs::write(source.join("b.txt"), "original b\n").unwrap();

        assert_eq!(
            read_workspace_source_info(&baseline_path),
            SandboxWorkspaceSourceInfo {
                source_root: None,
                skipped_count: 0,
            }
        );

        import_source_into_workspace(&source, &workspace, &baseline_path).unwrap();
        let info = read_workspace_source_info(&baseline_path);
        assert!(info.source_root.is_some());

        fs::write(workspace.join("a.txt"), "changed in sandbox\n").unwrap();
        fs::remove_file(workspace.join("b.txt")).unwrap();

        let before = diff_workspace_against_baseline(&workspace, &baseline_path).unwrap();
        assert_eq!(before.total_changes, 2);

        let discard = discard_workspace_changes(
            &workspace,
            &baseline_path,
            Some(&["a.txt".to_string(), "b.txt".to_string()]),
        )
        .unwrap();
        assert!(discard.errors.is_empty());
        assert_eq!(discard.discarded, vec!["a.txt", "b.txt"]);
        assert_eq!(
            fs::read_to_string(workspace.join("a.txt")).unwrap(),
            "original a\n"
        );
        assert_eq!(
            fs::read_to_string(workspace.join("b.txt")).unwrap(),
            "original b\n"
        );

        let after = diff_workspace_against_baseline(&workspace, &baseline_path).unwrap();
        assert_eq!(after.total_changes, 0);
    }
}
