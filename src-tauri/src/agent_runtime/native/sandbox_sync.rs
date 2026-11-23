//! Host-side project import, baseline tracking, diffing, and safe syncback
//! for managed local Agent sandbox workspaces.
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxApplyReport {
    pub(crate) applied: Vec<String>,
    pub(crate) skipped_conflicts: Vec<String>,
    pub(crate) errors: Vec<String>,
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
    let mut file = File::open(path)?;
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
) -> Result<(BTreeMap<String, BaselineEntry>, usize), String> {
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
            if meta.is_dir() {
                stack.push((path, rel));
            } else if meta.is_file() {
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
    let (files, skipped_count) = collect_tree(&source_canon, true)?;
    for rel in files.keys() {
        let clean = validate_relative_path(rel)?;
        let src = source_canon.join(&clean);
        let dst = workspace.join(&clean);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&src, &dst)
            .map_err(|error| format!("Failed to import {} into sandbox workspace: {error}", rel))?;
    }
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
    let (current_files, _) = collect_tree(workspace, false)?;
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
                    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
                    let mut reader = File::open(&src)?;
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
                    temp.flush()?;
                    temp.as_file().sync_all()?;
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
                if dest.exists() {
                    if let Err(error) = trash::TrashContext::new().delete(&dest) {
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

fn read_preview_text(path: &Path) -> Result<Option<(String, bool, bool)>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(format!("Path {} is not a regular file", path.display()));
    }
    let truncated = meta.len() > MAX_PREVIEW_FILE_BYTES;
    let mut file = File::open(path).map_err(|error| error.to_string())?;
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
}
