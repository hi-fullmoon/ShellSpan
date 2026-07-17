use crate::models::{CopyLocalPathsRequest, UploadConflictPolicy};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

pub(crate) fn copy_local_paths_blocking(request: CopyLocalPathsRequest) -> Result<(), String> {
    if request.source_paths.is_empty() {
        return Err("no source paths were provided for copy".to_string());
    }

    let destination_directory = Path::new(&request.destination_directory);
    fs::create_dir_all(destination_directory)
        .map_err(|error| format!("failed to create destination directory: {error}"))?;

    let mut existing_names = local_entry_names(destination_directory)?;

    if !request.conflict_policies.is_empty()
        && request.conflict_policies.len() != request.source_paths.len()
    {
        return Err("copy conflict policy count does not match source paths".to_string());
    }

    for (index, source_path) in request.source_paths.iter().enumerate() {
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
        copy_local_entry_to_path(source_path, &destination_path)?;
        existing_names.insert(destination_name);
    }

    Ok(())
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
}
