use crate::models::{CopyLocalPathsRequest, ReadRemoteFileResponse, UploadConflictPolicy};
use crate::path_utils::portable_local_path;
use crate::remote_fs::{
    decode_file_preview_text, preview_extension_requires_complete_file,
    PREVIEW_COMPLETE_FILE_SIZE_LIMIT, PREVIEW_TEXT_PREFIX_SIZE_LIMIT,
};
use base64::Engine;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::Path;

pub(crate) fn read_local_file_blocking(path: String) -> Result<ReadRemoteFileResponse, String> {
    let target = Path::new(&path);
    let metadata =
        fs::metadata(target).map_err(|error| format!("failed to inspect local file: {error}"))?;
    if metadata.is_dir() {
        return Err("cannot preview a directory".to_string());
    }

    let file_name = target
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "local-file".to_string());
    let size = metadata.len();
    let requires_complete_file = preview_extension_requires_complete_file(&file_name);
    let read_limit = if requires_complete_file {
        PREVIEW_COMPLETE_FILE_SIZE_LIMIT
    } else {
        PREVIEW_TEXT_PREFIX_SIZE_LIMIT
    };
    let response_path = portable_local_path(target);

    if requires_complete_file && size > read_limit {
        return Ok(ReadRemoteFileResponse {
            path: response_path,
            name: file_name,
            content: String::new(),
            size,
            is_text: false,
            content_encoding: "none".to_string(),
            truncated: true,
        });
    }

    let file =
        fs::File::open(target).map_err(|error| format!("failed to open local file: {error}"))?;
    let mut buffer = Vec::with_capacity((size.min(read_limit) + 1) as usize);
    file.take(read_limit + 1)
        .read_to_end(&mut buffer)
        .map_err(|error| format!("failed to read local file: {error}"))?;

    let mut truncated = size > read_limit;
    if buffer.len() as u64 > read_limit && requires_complete_file {
        return Ok(ReadRemoteFileResponse {
            path: response_path,
            name: file_name,
            content: String::new(),
            size,
            is_text: false,
            content_encoding: "none".to_string(),
            truncated: true,
        });
    }
    if buffer.len() as u64 > read_limit {
        buffer.truncate(read_limit as usize);
        truncated = true;
    }

    let decoded_text = decode_file_preview_text(&file_name, &buffer, truncated);
    let (content, is_text, content_encoding) = match decoded_text {
        Some(text) => (text, true, "utf8".to_string()),
        None => (
            base64::engine::general_purpose::STANDARD.encode(&buffer),
            false,
            "base64".to_string(),
        ),
    };

    Ok(ReadRemoteFileResponse {
        path: response_path,
        name: file_name,
        content,
        size,
        is_text,
        content_encoding,
        truncated,
    })
}

pub(crate) fn copy_local_paths_blocking(request: CopyLocalPathsRequest) -> Result<(), String> {
    if request.source_paths.is_empty() {
        return Err("no source paths were provided for copy".to_string());
    }

    let destination_directory = portable_local_path(Path::new(&request.destination_directory));
    let source_paths: Vec<String> = request
        .source_paths
        .iter()
        .map(|p| portable_local_path(Path::new(p)))
        .collect();

    let destination_directory = Path::new(&destination_directory);
    fs::create_dir_all(destination_directory)
        .map_err(|error| format!("failed to create destination directory: {error}"))?;

    let mut existing_names = local_entry_names(destination_directory)?;

    if !request.conflict_policies.is_empty()
        && request.conflict_policies.len() != request.source_paths.len()
    {
        return Err("copy conflict policy count does not match source paths".to_string());
    }

    for (index, source_path) in source_paths.iter().enumerate() {
        let source_path = Path::new(source_path);
        let file_name = source_path
            .file_name()
            .ok_or_else(|| format!("invalid source path: {}", source_path.display()))?
            .to_string_lossy()
            .to_string();
        let conflict_policy = request
            .conflict_policies
            .get(index)
            .copied()
            .unwrap_or(UploadConflictPolicy::Fail);
        let destination_name =
            match resolve_copy_target_name(&existing_names, &file_name, conflict_policy)? {
                Some(name) => name,
                None => continue,
            };
        let destination_path = destination_directory.join(&destination_name);
        // A system drag can hand us a path that already lives in the target
        // directory. Treat copying an entry onto itself as a no-op. Besides
        // avoiding fs::copy failures, this must happen before Replace removes
        // an existing directory, which would otherwise delete the source.
        if paths_refer_to_same_entry(source_path, &destination_path) {
            continue;
        }
        validate_copy_destination(source_path, &destination_path)?;
        if conflict_policy == UploadConflictPolicy::Replace && destination_path.is_dir() {
            fs::remove_dir_all(&destination_path).map_err(|error| {
                format!(
                    "failed to replace directory {}: {error}",
                    destination_path.display()
                )
            })?;
        }
        copy_local_entry_to_path(source_path, &destination_path)?;
        existing_names.insert(destination_name);
    }

    Ok(())
}

pub(crate) fn rename_local_path_blocking(path: String, new_name: String) -> Result<(), String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("new name must not be empty".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("new name must not contain path separators".to_string());
    }
    let source = Path::new(&portable_local_path(Path::new(&path))).to_path_buf();
    if !source.exists() {
        return Err(format!("path does not exist: {}", source.display()));
    }
    let parent = source
        .parent()
        .ok_or_else(|| format!("cannot rename a path without parent: {}", source.display()))?;
    let destination = parent.join(trimmed);
    if destination.exists() {
        return Err(format!("an entry named {trimmed} already exists"));
    }
    fs::rename(&source, &destination).map_err(|error| {
        format!(
            "failed to rename {} to {trimmed}: {error}",
            source.display()
        )
    })
}

pub(crate) fn paste_local_paths_blocking(
    source_paths: Vec<String>,
    destination_directory: String,
    copy_suffix: String,
) -> Result<Vec<String>, String> {
    if source_paths.is_empty() {
        return Err("no source paths were provided for paste".to_string());
    }

    let destination_directory = portable_local_path(Path::new(&destination_directory));
    let destination_directory = Path::new(&destination_directory);
    if !destination_directory.is_dir() {
        return Err(format!(
            "destination is not a directory: {}",
            destination_directory.display()
        ));
    }

    let mut existing_names = local_entry_names(destination_directory)?;
    let mut written = Vec::new();

    for source in &source_paths {
        let source_path = Path::new(&portable_local_path(Path::new(source))).to_path_buf();
        let file_name = source_path
            .file_name()
            .ok_or_else(|| format!("invalid source path: {}", source_path.display()))?
            .to_string_lossy()
            .to_string();
        let destination_name = resolve_paste_target_name(&existing_names, &file_name, &copy_suffix);
        let destination_path = destination_directory.join(&destination_name);
        if paths_refer_to_same_entry(&source_path, &destination_path) {
            continue;
        }
        validate_copy_destination(&source_path, &destination_path)?;
        copy_local_entry_to_path(&source_path, &destination_path)?;
        existing_names.insert(destination_name);
        // IPC path values always use the portable slash form on every OS.
        // Returning PathBuf's native rendering here produced mixed separators
        // on Windows because the destination had already been normalized.
        written.push(portable_local_path(&destination_path));
    }

    Ok(written)
}

pub(crate) fn trash_local_paths_blocking(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("no paths were provided for trash".to_string());
    }
    for path in &paths {
        let portable = portable_local_path(Path::new(path));
        trash::delete(&portable)
            .map_err(|error| format!("failed to move {portable} to trash: {error}"))?;
    }
    Ok(())
}

fn resolve_paste_target_name(
    existing_names: &HashSet<String>,
    base_name: &str,
    copy_suffix: &str,
) -> String {
    if !existing_names.contains(base_name) {
        return base_name.to_string();
    }
    let (stem, extension) = split_file_name(base_name);
    for index in 1u32.. {
        let suffix = if index == 1 {
            format!(" {copy_suffix}")
        } else {
            format!(" {copy_suffix} {index}")
        };
        let candidate = match extension {
            Some(ext) => format!("{stem}{suffix}.{ext}"),
            None => format!("{stem}{suffix}"),
        };
        if !existing_names.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn split_file_name(name: &str) -> (&str, Option<&str>) {
    match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], Some(&name[index + 1..])),
        _ => (name, None),
    }
}

fn paths_refer_to_same_entry(source: &Path, destination: &Path) -> bool {
    if source == destination {
        return true;
    }

    match (fs::canonicalize(source), fs::canonicalize(destination)) {
        (Ok(source), Ok(destination)) => source == destination,
        _ => false,
    }
}

fn validate_copy_destination(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("failed to stat source {}: {error}", source.display()))?;
    if !metadata.is_dir() {
        return Ok(());
    }

    let canonical_source = fs::canonicalize(source).map_err(|error| {
        format!(
            "failed to canonicalize source {}: {error}",
            source.display()
        )
    })?;
    let canonical_destination_parent = destination
        .parent()
        .ok_or_else(|| format!("copy destination has no parent: {}", destination.display()))
        .and_then(|parent| {
            fs::canonicalize(parent).map_err(|error| {
                format!(
                    "failed to canonicalize destination parent {}: {error}",
                    parent.display()
                )
            })
        })?;
    let destination_name = destination.file_name().ok_or_else(|| {
        format!(
            "copy destination has no file name: {}",
            destination.display()
        )
    })?;
    let normalized_destination = canonical_destination_parent.join(destination_name);

    if normalized_destination.starts_with(&canonical_source) {
        return Err(format!(
            "cannot copy directory {} into itself",
            source.display()
        ));
    }

    Ok(())
}

fn local_entry_names(directory: &Path) -> Result<HashSet<String>, String> {
    let mut names = HashSet::new();
    for entry in
        fs::read_dir(directory).map_err(|error| format!("failed to read directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        names.insert(name);
    }
    Ok(names)
}

fn resolve_copy_target_name(
    existing_names: &HashSet<String>,
    base_name: &str,
    policy: UploadConflictPolicy,
) -> Result<Option<String>, String> {
    if !existing_names.contains(base_name) {
        return Ok(Some(base_name.to_string()));
    }

    match policy {
        UploadConflictPolicy::Overwrite | UploadConflictPolicy::Replace => {
            Ok(Some(base_name.to_string()))
        }
        UploadConflictPolicy::Skip => Ok(None),
        UploadConflictPolicy::Fail => Err(format!("local path already exists: {base_name}")),
    }
}

fn copy_local_entry_to_path(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("failed to stat source {}: {error}", source.display()))?;

    if metadata.is_dir() {
        fs::create_dir_all(destination).map_err(|error| {
            format!(
                "failed to create directory {}: {error}",
                destination.display()
            )
        })?;
        for entry in fs::read_dir(source)
            .map_err(|error| format!("failed to read directory {}: {error}", source.display()))?
        {
            let entry =
                entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
            let entry_destination = destination.join(entry.file_name());
            copy_local_entry_to_path(&entry.path(), &entry_destination)?;
        }
        Ok(())
    } else if metadata.is_symlink() {
        let target = fs::read_link(source)
            .map_err(|error| format!("failed to read symlink {}: {error}", source.display()))?;
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, destination).map_err(|error| {
                format!(
                    "failed to create symlink {}: {error}",
                    destination.display()
                )
            })?;
        }
        #[cfg(windows)]
        {
            if target.is_dir() {
                std::os::windows::fs::symlink_dir(&target, destination).map_err(|error| {
                    format!(
                        "failed to create symlink {}: {error}",
                        destination.display()
                    )
                })?;
            } else {
                std::os::windows::fs::symlink_file(&target, destination).map_err(|error| {
                    format!(
                        "failed to create symlink {}: {error}",
                        destination.display()
                    )
                })?;
            }
        }
        Ok(())
    } else {
        fs::copy(source, destination).map_err(|error| {
            format!(
                "failed to copy {} to {}: {error}",
                source.display(),
                destination.display()
            )
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    include!("tests/local_fs.rs");
}
