use crate::models::{CopyLocalPathsRequest, UploadConflictPolicy};
use crate::path_utils::portable_local_path;
use std::collections::HashSet;
use std::fs;
use std::path::Path;

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
        let destination_name = match resolve_copy_target_name(&existing_names, &file_name, conflict_policy)? {
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
        if conflict_policy == UploadConflictPolicy::Replace && destination_path.is_dir() {
            fs::remove_dir_all(&destination_path)
                .map_err(|error| format!("failed to replace directory {}: {error}", destination_path.display()))?;
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
    fs::rename(&source, &destination)
        .map_err(|error| format!("failed to rename {} to {trimmed}: {error}", source.display()))
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
        copy_local_entry_to_path(&source_path, &destination_path)?;
        existing_names.insert(destination_name);
        written.push(destination_path.to_string_lossy().to_string());
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

fn local_entry_names(directory: &Path) -> Result<HashSet<String>, String> {
    let mut names = HashSet::new();
    for entry in fs::read_dir(directory).map_err(|error| format!("failed to read directory: {error}"))? {
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
        fs::create_dir_all(destination)
            .map_err(|error| format!("failed to create directory {}: {error}", destination.display()))?;
        for entry in fs::read_dir(source).map_err(|error| format!("failed to read directory {}: {error}", source.display()))? {
            let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
            let entry_destination = destination.join(entry.file_name());
            copy_local_entry_to_path(&entry.path(), &entry_destination)?;
        }
        Ok(())
    } else if metadata.is_symlink() {
        let target = fs::read_link(source)
            .map_err(|error| format!("failed to read symlink {}: {error}", source.display()))?;
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, destination)
                .map_err(|error| format!("failed to create symlink {}: {error}", destination.display()))?;
        }
        #[cfg(windows)]
        {
            if target.is_dir() {
                std::os::windows::fs::symlink_dir(&target, destination)
                    .map_err(|error| format!("failed to create symlink {}: {error}", destination.display()))?;
            } else {
                std::os::windows::fs::symlink_file(&target, destination)
                    .map_err(|error| format!("failed to create symlink {}: {error}", destination.display()))?;
            }
        }
        Ok(())
    } else {
        fs::copy(source, destination)
            .map_err(|error| format!("failed to copy {} to {}: {error}", source.display(), destination.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_request(sources: Vec<&str>, destination: &str, policies: Vec<UploadConflictPolicy>) -> CopyLocalPathsRequest {
        CopyLocalPathsRequest {
            source_paths: sources.into_iter().map(|s| s.to_string()).collect(),
            destination_directory: destination.to_string(),
            conflict_policies: policies,
            operation_id: "test-op".to_string(),
        }
    }

    #[test]
    fn copies_a_single_file_into_destination() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("file.txt");
        let dest_dir = temp.path().join("dest");
        fs::write(&src, "hello").unwrap();

        let request = make_request(vec![src.to_str().unwrap()], dest_dir.to_str().unwrap(), vec![]);
        copy_local_paths_blocking(request).unwrap();

        let copied = dest_dir.join("file.txt");
        assert!(copied.exists());
        assert_eq!(fs::read_to_string(copied).unwrap(), "hello");
    }

    #[test]
    fn copies_a_nested_directory_recursively() {
        let temp = TempDir::new().unwrap();
        let src_dir = temp.path().join("src");
        let nested = src_dir.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("inner.txt"), "inner").unwrap();
        let dest_dir = temp.path().join("dest");

        let request = make_request(vec![src_dir.to_str().unwrap()], dest_dir.to_str().unwrap(), vec![]);
        copy_local_paths_blocking(request).unwrap();

        assert!(dest_dir.join("src").exists());
        assert!(dest_dir.join("src/nested/inner.txt").exists());
    }

    #[test]
    fn overwrite_replaces_existing_file() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("file.txt");
        let dest_dir = temp.path().join("dest");
        fs::create_dir_all(&dest_dir).unwrap();
        fs::write(&src, "new").unwrap();
        fs::write(dest_dir.join("file.txt"), "old").unwrap();

        let request = make_request(vec![src.to_str().unwrap()], dest_dir.to_str().unwrap(), vec![UploadConflictPolicy::Overwrite]);
        copy_local_paths_blocking(request).unwrap();

        assert_eq!(fs::read_to_string(dest_dir.join("file.txt")).unwrap(), "new");
    }

    #[test]
    fn skip_leaves_existing_file_unchanged() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("file.txt");
        let dest_dir = temp.path().join("dest");
        fs::create_dir_all(&dest_dir).unwrap();
        fs::write(&src, "new").unwrap();
        fs::write(dest_dir.join("file.txt"), "old").unwrap();

        let request = make_request(vec![src.to_str().unwrap()], dest_dir.to_str().unwrap(), vec![UploadConflictPolicy::Skip]);
        copy_local_paths_blocking(request).unwrap();

        assert_eq!(fs::read_to_string(dest_dir.join("file.txt")).unwrap(), "old");
    }

    #[test]
    fn fail_errors_on_existing_file() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("file.txt");
        let dest_dir = temp.path().join("dest");
        fs::create_dir_all(&dest_dir).unwrap();
        fs::write(&src, "new").unwrap();
        fs::write(dest_dir.join("file.txt"), "old").unwrap();

        let request = make_request(vec![src.to_str().unwrap()], dest_dir.to_str().unwrap(), vec![UploadConflictPolicy::Fail]);
        let result = copy_local_paths_blocking(request);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("file.txt"));
    }

    #[test]
    fn replace_replaces_existing_directory_contents() {
        let temp = TempDir::new().unwrap();
        let src_dir = temp.path().join("src");
        let src_nested = src_dir.join("nested");
        fs::create_dir_all(&src_nested).unwrap();
        fs::write(src_nested.join("new.txt"), "new").unwrap();

        let dest_dir = temp.path().join("dest");
        let dest_existing = dest_dir.join("src");
        let dest_existing_nested = dest_existing.join("nested");
        fs::create_dir_all(&dest_existing_nested).unwrap();
        fs::write(dest_existing_nested.join("old.txt"), "old").unwrap();

        let request = make_request(
            vec![src_dir.to_str().unwrap()],
            dest_dir.to_str().unwrap(),
            vec![UploadConflictPolicy::Replace],
        );
        copy_local_paths_blocking(request).unwrap();

        assert!(dest_existing.join("nested/new.txt").exists());
        assert!(!dest_existing_nested.join("old.txt").exists());
    }

    #[test]
    fn overwrite_file_onto_itself_is_a_noop() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("file.txt");
        fs::write(&source, "unchanged").unwrap();

        let request = make_request(
            vec![source.to_str().unwrap()],
            temp.path().to_str().unwrap(),
            vec![UploadConflictPolicy::Overwrite],
        );
        copy_local_paths_blocking(request).unwrap();

        assert_eq!(fs::read_to_string(source).unwrap(), "unchanged");
    }

    #[test]
    fn replace_directory_onto_itself_is_a_noop() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("keep.txt"), "unchanged").unwrap();

        let request = make_request(
            vec![source.to_str().unwrap()],
            temp.path().to_str().unwrap(),
            vec![UploadConflictPolicy::Replace],
        );
        copy_local_paths_blocking(request).unwrap();

        assert_eq!(fs::read_to_string(source.join("keep.txt")).unwrap(), "unchanged");
    }

    #[test]
    fn renames_a_file_within_the_same_directory() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("old.txt");
        fs::write(&src, "hello").unwrap();

        rename_local_path_blocking(src.to_str().unwrap().to_string(), "new.txt".to_string()).unwrap();

        assert!(!src.exists());
        assert_eq!(fs::read_to_string(temp.path().join("new.txt")).unwrap(), "hello");
    }

    #[test]
    fn rename_fails_when_target_name_exists() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("old.txt"), "a").unwrap();
        fs::write(temp.path().join("new.txt"), "b").unwrap();

        let result = rename_local_path_blocking(
            temp.path().join("old.txt").to_str().unwrap().to_string(),
            "new.txt".to_string(),
        );
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(temp.path().join("old.txt")).unwrap(), "a");
    }

    #[test]
    fn rename_rejects_empty_and_separator_names() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("old.txt");
        fs::write(&src, "a").unwrap();

        assert!(rename_local_path_blocking(src.to_str().unwrap().to_string(), "  ".to_string()).is_err());
        assert!(rename_local_path_blocking(src.to_str().unwrap().to_string(), "a/b".to_string()).is_err());
        assert!(rename_local_path_blocking(src.to_str().unwrap().to_string(), "a\\b".to_string()).is_err());
        assert!(src.exists());
    }

    #[test]
    fn paste_copies_file_without_conflict() {
        let temp = TempDir::new().unwrap();
        let src_dir = temp.path().join("src");
        fs::create_dir(&src_dir).unwrap();
        let src = src_dir.join("report.txt");
        fs::write(&src, "data").unwrap();
        let dest = temp.path().join("dest");
        fs::create_dir(&dest).unwrap();

        let written = paste_local_paths_blocking(
            vec![src.to_str().unwrap().to_string()],
            dest.to_str().unwrap().to_string(),
            "copy".to_string(),
        ).unwrap();

        assert_eq!(written.len(), 1);
        assert_eq!(fs::read_to_string(dest.join("report.txt")).unwrap(), "data");
    }

    #[test]
    fn paste_auto_renames_on_conflict() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("report.txt");
        fs::write(&src, "new").unwrap();

        let written = paste_local_paths_blocking(
            vec![src.to_str().unwrap().to_string()],
            temp.path().to_str().unwrap().to_string(),
            "copy".to_string(),
        ).unwrap();

        assert_eq!(written, vec![temp.path().join("report copy.txt").to_string_lossy().to_string()]);
        assert_eq!(fs::read_to_string(temp.path().join("report copy.txt")).unwrap(), "new");
    }

    #[test]
    fn paste_increments_suffix_for_repeated_conflicts() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("report.txt"), "0").unwrap();
        fs::write(temp.path().join("report copy.txt"), "1").unwrap();
        let src_dir = temp.path().join("src");
        fs::create_dir(&src_dir).unwrap();
        let src = src_dir.join("report.txt");
        fs::write(&src, "new").unwrap();

        let written = paste_local_paths_blocking(
            vec![src.to_str().unwrap().to_string()],
            temp.path().to_str().unwrap().to_string(),
            "copy".to_string(),
        ).unwrap();

        assert!(written[0].ends_with("report copy 2.txt"));
    }

    #[test]
    fn paste_auto_renames_directories_and_extensionless_files() {
        let temp = TempDir::new().unwrap();
        let src_dir = temp.path().join("src");
        fs::create_dir(&src_dir).unwrap();
        fs::create_dir(src_dir.join("docs")).unwrap();
        fs::write(src_dir.join("docs/a.txt"), "a").unwrap();
        fs::write(src_dir.join("Makefile"), "m").unwrap();
        let dest = temp.path().join("dest");
        fs::create_dir(&dest).unwrap();
        fs::create_dir(dest.join("docs")).unwrap();
        fs::write(dest.join("Makefile"), "old").unwrap();

        let written = paste_local_paths_blocking(
            vec![
                src_dir.join("docs").to_str().unwrap().to_string(),
                src_dir.join("Makefile").to_str().unwrap().to_string(),
            ],
            dest.to_str().unwrap().to_string(),
            "copy".to_string(),
        ).unwrap();

        assert!(dest.join("docs copy/a.txt").exists());
        assert_eq!(fs::read_to_string(dest.join("Makefile copy")).unwrap(), "m");
        assert_eq!(written.len(), 2);
    }

    #[test]
    fn paste_uses_localized_suffix() {
        let temp = TempDir::new().unwrap();
        let src = temp.path().join("报告.txt");
        fs::write(&src, "data").unwrap();

        let written = paste_local_paths_blocking(
            vec![src.to_str().unwrap().to_string()],
            temp.path().to_str().unwrap().to_string(),
            "副本".to_string(),
        ).unwrap();

        assert!(written[0].ends_with("报告 副本.txt"));
    }

    #[test]
    fn trash_rejects_empty_path_list() {
        let result = trash_local_paths_blocking(vec![]);
        assert!(result.is_err());
    }

    #[test]
    fn trash_fails_for_missing_path() {
        let temp = TempDir::new().unwrap();
        let missing = temp.path().join("does-not-exist.txt");
        let result = trash_local_paths_blocking(vec![missing.to_str().unwrap().to_string()]);
        assert!(result.is_err());
    }
}
