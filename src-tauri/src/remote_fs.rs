use crate::connection::connect_sftp;
use crate::models::{
    CopyRemotePathRequest, CreateRemoteEntryKind, CreateRemoteEntryRequest, DeleteProgressTracker,
    DeleteRemotePathRequest, DownloadProgressTracker, DownloadRemotePathsRequest, DownloadScanStats,
    OpenRemoteFileRequest, RemoteDirectoryListing, RemoteDirectoryRequest, RemoteFileEntry,
    RemoteFileKind, RenameRemotePathRequest, UploadConflictPolicy, UploadLocalPathsRequest,
    UploadProgressTracker, UploadScanStats,
};
use log::warn;
use ssh2::{FileStat, OpenFlags, OpenType, RenameFlags, Session, Sftp};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs,
    io::{copy, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::{AtomicBool, Ordering as AtomicOrdering}, Arc},
    time::{Duration, SystemTime},
};
use tauri::AppHandle;
use uuid::Uuid;

const OPEN_TEMP_RETENTION: Duration = Duration::from_secs(60 * 60 * 24);

pub(crate) fn list_remote_directory_blocking(
    request: RemoteDirectoryRequest,
) -> Result<RemoteDirectoryListing, String> {
    let connected = connect_sftp(&request.connection)?;
    list_remote_directory_from_sftp(&connected.session, &connected.sftp, request.path.as_deref())
}

pub(crate) fn create_remote_entry_blocking(
    request: CreateRemoteEntryRequest,
) -> Result<(), String> {
    validate_remote_name(&request.name)?;

    let connected = connect_sftp(&request.connection)?;
    let parent_path = Path::new(&request.parent_path);
    ensure_remote_directory(&connected.sftp, parent_path)?;

    let target_path = parent_path.join(request.name.trim());
    if remote_path_exists(&connected.sftp, &target_path) {
        return Err(format!(
            "remote path already exists: {}",
            path_to_string(&target_path)
        ));
    }

    match request.kind {
        CreateRemoteEntryKind::Directory => connected
            .sftp
            .mkdir(&target_path, 0o755)
            .map_err(|error| format!("failed to create remote directory: {error}"))?,
        CreateRemoteEntryKind::File => {
            let mut file = connected
                .sftp
                .open_mode(
                    &target_path,
                    OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUSIVE,
                    0o644,
                    OpenType::File,
                )
                .map_err(|error| format!("failed to create remote file: {error}"))?;
            file.flush()
                .map_err(|error| format!("failed to finalize remote file creation: {error}"))?;
        }
    }

    Ok(())
}

pub(crate) fn rename_remote_path_blocking(request: RenameRemotePathRequest) -> Result<(), String> {
    validate_remote_name(&request.new_name)?;

    let connected = connect_sftp(&request.connection)?;
    let source_path = Path::new(&request.path);
    let parent_path = source_path
        .parent()
        .ok_or_else(|| "unable to resolve parent path for rename".to_string())?;
    let target_path = parent_path.join(request.new_name.trim());

    if source_path == target_path {
        return Ok(());
    }

    if remote_path_exists(&connected.sftp, &target_path) {
        return Err(format!(
            "rename target already exists: {}",
            path_to_string(&target_path)
        ));
    }

    connected
        .sftp
        .rename(
            source_path,
            &target_path,
            Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
        )
        .map_err(|error| format!("failed to rename remote path: {error}"))
}

pub(crate) fn delete_remote_path_blocking(
    app: AppHandle,
    request: DeleteRemotePathRequest,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let connected = connect_sftp(&request.connection)?;
    let target_path = Path::new(&request.path);
    let total_steps = count_remote_delete_steps(&connected.sftp, target_path)?;
    let mut progress =
        DeleteProgressTracker::new(app, request.operation_id.clone(), cancel_flag, total_steps);
    progress.emit()?;
    progress.ensure_not_cancelled()?;
    delete_remote_path_recursive(&connected.sftp, target_path, &mut progress)?;
    progress.set_current_path(None)?;
    Ok(())
}

pub(crate) fn copy_remote_path_blocking(request: CopyRemotePathRequest) -> Result<(), String> {
    let connected = connect_sftp(&request.connection)?;
    let source_path = Path::new(&request.source_path);
    let destination_directory = Path::new(&request.destination_directory);
    ensure_remote_directory(&connected.sftp, destination_directory)?;

    let source_name = source_path
        .file_name()
        .ok_or_else(|| "source path has no file name".to_string())?
        .to_string_lossy()
        .to_string();
    let destination_path =
        unique_remote_destination(&connected.sftp, destination_directory, &source_name)?;

    if destination_path.starts_with(source_path) {
        return Err("cannot paste a directory into itself".to_string());
    }

    let source_stat = connected
        .sftp
        .lstat(source_path)
        .map_err(|error| format!("failed to stat remote source: {error}"))?;
    copy_remote_entry_to_path(&connected.sftp, source_path, &destination_path, source_stat)
}

pub(crate) fn upload_local_paths_blocking(
    app: AppHandle,
    request: UploadLocalPathsRequest,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    if request.local_paths.is_empty() {
        return Err("no local files were provided for upload".to_string());
    }

    let connected = connect_sftp(&request.connection)?;
    let destination_directory = Path::new(&request.destination_directory);
    ensure_remote_directory(&connected.sftp, destination_directory)?;
    if !request.conflict_policies.is_empty()
        && request.conflict_policies.len() != request.local_paths.len()
    {
        return Err("upload conflict policy count does not match local paths".to_string());
    }

    let mut scan_stats = UploadScanStats::default();
    for local_path in &request.local_paths {
        scan_stats.combine(scan_local_upload_path(Path::new(local_path))?);
    }

    let mut progress =
        UploadProgressTracker::new(app, request.operation_id.clone(), cancel_flag, scan_stats);
    progress.emit()?;
    let mut existing_names = remote_entry_names(&connected.sftp, destination_directory)?;

    for (index, local_path) in request.local_paths.iter().enumerate() {
        progress.ensure_not_cancelled()?;
        let local_path = Path::new(local_path);
        let file_name = local_path
            .file_name()
            .ok_or_else(|| format!("invalid local path: {}", local_path.display()))?
            .to_string_lossy()
            .to_string();
        let conflict_policy = request
            .conflict_policies
            .get(index)
            .copied()
            .unwrap_or(UploadConflictPolicy::Fail);
        let destination_name =
            match resolve_upload_target_name(&existing_names, &file_name, conflict_policy)? {
                Some(name) => name,
                None => continue,
            };
        let destination_path = destination_directory.join(&destination_name);
        upload_local_entry_to_path(
            &connected.sftp,
            local_path,
            &destination_path,
            &mut progress,
        )?;
        existing_names.insert(destination_name);
    }

    progress.set_current_path(None)?;

    Ok(())
}

pub(crate) fn download_remote_paths_blocking(
    app: AppHandle,
    request: DownloadRemotePathsRequest,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    if request.remote_paths.is_empty() {
        return Err("no remote paths were provided for download".to_string());
    }

    let connected = connect_sftp(&request.connection)?;
    let destination_directory = Path::new(&request.destination_directory);
    fs::create_dir_all(destination_directory)
        .map_err(|error| format!("failed to create destination directory: {error}"))?;

    // Emit an initial event so the UI shows activity during the scan phase.
    let mut scanning_progress = DownloadProgressTracker::new(
        app.clone(),
        request.operation_id.clone(),
        cancel_flag.clone(),
        DownloadScanStats::default(),
    );
    scanning_progress.set_current_path(Some("scanning...".to_string()))?;
    scanning_progress.emit()?;

    let mut scan_stats = DownloadScanStats::default();
    for remote_path in &request.remote_paths {
        if cancel_flag.load(AtomicOrdering::SeqCst) {
            return Err("download cancelled".to_string());
        }
        scan_stats.combine(scan_remote_download_path(
            &connected.sftp,
            Path::new(remote_path),
            &cancel_flag,
        )?);
    }

    let mut progress =
        DownloadProgressTracker::new(app, request.operation_id.clone(), cancel_flag, scan_stats);
    progress.emit()?;

    for remote_path in &request.remote_paths {
        progress.ensure_not_cancelled()?;
        let remote_path = Path::new(remote_path);
        let file_name = remote_path
            .file_name()
            .ok_or_else(|| format!("invalid remote path: {}", remote_path.display()))?
            .to_string_lossy()
            .to_string();
        let destination_path = destination_directory.join(&file_name);
        download_remote_entry_to_path(
            &connected.sftp,
            remote_path,
            &destination_path,
            &mut progress,
        )?;
    }

    progress.set_current_path(None)?;

    Ok(())
}

fn scan_remote_download_path(
    sftp: &Sftp,
    remote_path: &Path,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<DownloadScanStats, String> {
    if cancel_flag.load(AtomicOrdering::SeqCst) {
        return Err("download cancelled".to_string());
    }

    let stat = sftp
        .lstat(remote_path)
        .map_err(|error| format!("failed to inspect remote path: {error}"))?;

    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            let mut stats = DownloadScanStats {
                total_bytes: 0,
                total_steps: 1,
            };
            let entries = sftp
                .readdir(remote_path)
                .map_err(|error| format!("failed to list remote directory for download: {error}"))?;
            for (child_path, _) in entries {
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                stats.combine(scan_remote_download_path(sftp, &child_path, cancel_flag)?);
            }
            Ok(stats)
        }
        RemoteFileKind::Symlink => {
            // Do not recursively follow symlinks to avoid infinite loops.
            // Treat a symlink as a single file step; sftp.open follows it during download.
            Ok(DownloadScanStats {
                total_bytes: 0,
                total_steps: 1,
            })
        }
        _ => Ok(DownloadScanStats {
            total_bytes: stat.size.unwrap_or(0),
            total_steps: 1,
        }),
    }
}

fn download_remote_entry_to_path(
    sftp: &Sftp,
    remote_path: &Path,
    local_path: &Path,
    progress: &mut DownloadProgressTracker,
) -> Result<(), String> {
    progress.ensure_not_cancelled()?;
    let stat = sftp
        .lstat(remote_path)
        .map_err(|error| format!("failed to inspect remote path: {error}"))?;

    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            progress.set_current_path(Some(path_to_string(remote_path)))?;
            fs::create_dir_all(local_path)
                .map_err(|error| format!("failed to create local directory: {error}"))?;
            progress.finish_step()?;
            let entries = sftp
                .readdir(remote_path)
                .map_err(|error| format!("failed to list remote directory for download: {error}"))?;
            for (child_path, _) in entries {
                progress.ensure_not_cancelled()?;
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                let child_name = child_path
                    .file_name()
                    .ok_or_else(|| "invalid child path while downloading directory".to_string())?;
                download_remote_entry_to_path(
                    sftp,
                    &child_path,
                    &local_path.join(child_name),
                    progress,
                )?;
            }
            Ok(())
        }
        RemoteFileKind::Symlink => {
            // Do not recursively follow symlinks to avoid infinite loops.
            // sftp.open follows the symlink automatically for file targets.
            match download_remote_file(sftp, remote_path, local_path, progress) {
                Ok(()) => Ok(()),
                Err(_error) => {
                    // Symlink might point to a directory or be broken.
                    // Create an empty local file as a placeholder and finish the step.
                    progress.set_current_path(Some(path_to_string(remote_path)))?;
                    if let Some(parent) = local_path.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| format!("failed to create parent directory: {e}"))?;
                    }
                    fs::File::create(local_path)
                        .map_err(|e| format!("failed to create local file for symlink: {e}"))?;
                    progress.finish_step()?;
                    Ok(())
                }
            }
        }
        _ => download_remote_file(sftp, remote_path, local_path, progress),
    }
}

fn download_remote_file(
    sftp: &Sftp,
    remote_path: &Path,
    local_path: &Path,
    progress: &mut DownloadProgressTracker,
) -> Result<(), String> {
    progress.set_current_path(Some(path_to_string(remote_path)))?;
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create local parent directory: {error}"))?;
    }

    let mut remote_file = sftp
        .open(remote_path)
        .map_err(|error| format!("failed to open remote file: {error}"))?;
    let mut local_file = fs::File::create(local_path)
        .map_err(|error| format!("failed to create local file: {error}"))?;

    let mut buffer = [0u8; 64 * 1024];
    loop {
        progress.ensure_not_cancelled().inspect_err(|_| {
            let _ = fs::remove_file(local_path);
        })?;
        let read = remote_file
            .read(&mut buffer)
            .map_err(|error| format!("failed to read remote file: {error}"))?;
        if read == 0 {
            break;
        }
        local_file
            .write_all(&buffer[..read])
            .map_err(|error| format!("failed to write local file: {error}"))?;
        progress.advance_bytes(read as u64)?;
    }
    local_file
        .flush()
        .map_err(|error| format!("failed to flush local file: {error}"))?;
    progress.finish_step()?;
    Ok(())
}

pub(crate) fn open_remote_file_blocking(request: OpenRemoteFileRequest) -> Result<(), String> {
    let connected = connect_sftp(&request.connection)?;
    let remote_path = Path::new(&request.path);
    let stat = connected
        .sftp
        .lstat(remote_path)
        .map_err(|error| format!("failed to inspect remote file: {error}"))?;

    if kind_from_permissions(stat.perm) == RemoteFileKind::Directory {
        return Err("目录不支持使用默认编辑器打开".to_string());
    }

    let file_name = remote_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "remote-file".to_string());

    let open_root = std::env::temp_dir().join("termbridge-open");
    fs::create_dir_all(&open_root)
        .map_err(|error| format!("failed to create temp directory: {error}"))?;
    cleanup_stale_open_temp_files(&open_root);

    let local_path = open_root.join(format!("{}-{}", Uuid::new_v4(), file_name));
    let mut remote_file = connected
        .sftp
        .open(remote_path)
        .map_err(|error| format!("failed to open remote file: {error}"))?;
    let mut local_file = fs::File::create(&local_path)
        .map_err(|error| format!("failed to prepare local temp file: {error}"))?;
    copy(&mut remote_file, &mut local_file)
        .map_err(|error| format!("failed to download remote file: {error}"))?;
    local_file
        .flush()
        .map_err(|error| format!("failed to finalize temp file: {error}"))?;

    open_path_with_default_app(&local_path)
}

fn cleanup_stale_open_temp_files(open_root: &Path) {
    let cutoff = SystemTime::now()
        .checked_sub(OPEN_TEMP_RETENTION)
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let Ok(entries) = fs::read_dir(open_root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };

        let should_remove = metadata
            .modified()
            .map(|modified| modified <= cutoff)
            .unwrap_or(false);

        if !should_remove {
            continue;
        }

        let removal_result = if metadata.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };

        if let Err(error) = removal_result {
            warn!(
                "failed to clean stale temp open file path={}: {error}",
                path.display()
            );
        }
    }
}

fn list_remote_directory_from_sftp(
    session: &Session,
    sftp: &Sftp,
    requested_path: Option<&str>,
) -> Result<RemoteDirectoryListing, String> {
    let requested_path = requested_path.unwrap_or(".");
    let resolved_path = sftp
        .realpath(Path::new(requested_path))
        .map_err(|error| format!("failed to resolve remote path {requested_path}: {error}"))?;

    let mut entries = sftp
        .readdir(&resolved_path)
        .map_err(|error| format!("failed to list remote directory: {error}"))?
        .into_iter()
        .map(|(path, stat)| map_remote_file(path, stat))
        .collect::<Vec<_>>();

    enrich_remote_entry_owners(session, &mut entries);
    entries.sort_by(sort_remote_entries);

    let current_path = path_to_string(&resolved_path);
    let parent_path = resolved_path.parent().and_then(|parent| {
        let next_parent = path_to_string(parent);
        if next_parent == current_path {
            None
        } else {
            Some(next_parent)
        }
    });

    Ok(RemoteDirectoryListing {
        path: current_path,
        parent_path,
        entries,
    })
}

fn enrich_remote_entry_owners(session: &Session, entries: &mut [RemoteFileEntry]) {
    let owner_ids = entries
        .iter()
        .filter_map(|entry| entry.owner_uid)
        .collect::<HashSet<_>>();
    let group_ids = entries
        .iter()
        .filter_map(|entry| entry.group_gid)
        .collect::<HashSet<_>>();

    let owner_names = resolve_remote_identity_names(session, &owner_ids, RemoteIdentityKind::User)
        .unwrap_or_else(|error| {
            warn!("failed to resolve remote owner names: {error}");
            HashMap::new()
        });
    let group_names = resolve_remote_identity_names(session, &group_ids, RemoteIdentityKind::Group)
        .unwrap_or_else(|error| {
            warn!("failed to resolve remote group names: {error}");
            HashMap::new()
        });

    for entry in entries {
        entry.owner_name = entry
            .owner_uid
            .and_then(|uid| owner_names.get(&uid).cloned());
        entry.group_name = entry
            .group_gid
            .and_then(|gid| group_names.get(&gid).cloned());
    }
}

#[derive(Clone, Copy)]
enum RemoteIdentityKind {
    User,
    Group,
}

fn resolve_remote_identity_names(
    session: &Session,
    ids: &HashSet<u32>,
    kind: RemoteIdentityKind,
) -> Result<HashMap<u32, String>, String> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }

    let mut sorted_ids = ids.iter().copied().collect::<Vec<_>>();
    sorted_ids.sort_unstable();

    let command = build_remote_identity_lookup_command(&sorted_ids, kind);
    let output = run_remote_exec(session, &command)?;

    let mut names = HashMap::new();
    for line in output.lines() {
        let Some((id, name)) = line.split_once('\t') else {
            continue;
        };
        let Ok(parsed_id) = id.trim().parse::<u32>() else {
            continue;
        };
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            continue;
        }
        names.insert(parsed_id, trimmed_name.to_string());
    }

    Ok(names)
}

fn build_remote_identity_lookup_command(ids: &[u32], kind: RemoteIdentityKind) -> String {
    let ids_text = ids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");

    let (python_module, python_lookup, python_field, getent_database) = match kind {
        RemoteIdentityKind::User => ("pwd", "getpwuid", "pw_name", "passwd"),
        RemoteIdentityKind::Group => ("grp", "getgrgid", "gr_name", "group"),
    };

    format!(
        "sh -lc 'if command -v getent >/dev/null 2>&1; then \
for id in {ids_text}; do \
entry=$(getent {getent_database} \"$id\" 2>/dev/null | cut -d: -f1); \
if [ -n \"$entry\" ]; then printf \"%s\\t%s\\n\" \"$id\" \"$entry\"; fi; \
done; \
else \
for id in {ids_text}; do \
entry=\"\"; \
if command -v python3 >/dev/null 2>&1; then \
entry=$(python3 -c \"import {python_module},sys; print(getattr({python_module}.{python_lookup}(int(sys.argv[1])), '{python_field}'))\" \"$id\" 2>/dev/null); \
elif command -v python >/dev/null 2>&1; then \
entry=$(python -c \"import {python_module},sys; print(getattr({python_module}.{python_lookup}(int(sys.argv[1])), '{python_field}'))\" \"$id\" 2>/dev/null); \
fi; \
if [ -n \"$entry\" ]; then printf \"%s\\t%s\\n\" \"$id\" \"$entry\"; fi; \
done; \
fi'"
    )
}

fn run_remote_exec(session: &Session, command: &str) -> Result<String, String> {
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("failed to open remote exec channel: {error}"))?;
    channel
        .exec(command)
        .map_err(|error| format!("failed to execute remote lookup command: {error}"))?;

    let mut output = String::new();
    channel
        .read_to_string(&mut output)
        .map_err(|error| format!("failed to read remote lookup output: {error}"))?;

    let mut stderr = String::new();
    let _ = channel.stderr().read_to_string(&mut stderr);
    channel
        .wait_close()
        .map_err(|error| format!("failed to close remote lookup channel: {error}"))?;
    let exit_status = channel
        .exit_status()
        .map_err(|error| format!("failed to read remote lookup exit status: {error}"))?;

    if exit_status != 0 {
        let stderr = stderr.trim();
        let details = if stderr.is_empty() {
            "no stderr output".to_string()
        } else {
            stderr.to_string()
        };
        return Err(format!(
            "remote lookup command failed with exit status {exit_status}: {details}"
        ));
    }

    Ok(output)
}

fn validate_remote_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("name is required".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("'.' and '..' are not valid file names".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("file name must not include path separators".to_string());
    }
    Ok(())
}

fn remote_path_exists(sftp: &Sftp, path: &Path) -> bool {
    sftp.lstat(path).is_ok()
}

fn ensure_remote_directory(sftp: &Sftp, path: &Path) -> Result<(), String> {
    let path_string = path_to_string(path);
    if path_string.is_empty() || path == Path::new(".") || path == Path::new("/") {
        return Ok(());
    }

    if let Ok(stat) = sftp.stat(path) {
        match kind_from_permissions(stat.perm) {
            RemoteFileKind::Directory => return Ok(()),
            _ => {
                return Err(format!(
                    "remote path exists but is not a directory: {}",
                    path_to_string(path)
                ))
            }
        }
    }

    if let Some(parent) = path.parent() {
        let parent_string = path_to_string(parent);
        if parent_string != path_string {
            ensure_remote_directory(sftp, parent)?;
        }
    }

    match sftp.mkdir(path, 0o755) {
        Ok(()) => Ok(()),
        Err(error) if remote_path_exists(sftp, path) => match sftp.stat(path) {
            Ok(stat) if kind_from_permissions(stat.perm) == RemoteFileKind::Directory => Ok(()),
            Ok(_) => Err(format!(
                "remote path exists but is not a directory: {}",
                path_to_string(path)
            )),
            Err(_) => Err(format!("failed to create remote directory: {error}")),
        },
        Err(error) => Err(format!("failed to create remote directory: {error}")),
    }
}

fn count_remote_delete_steps(sftp: &Sftp, path: &Path) -> Result<u64, String> {
    let stat = sftp
        .lstat(path)
        .map_err(|error| format!("failed to inspect remote path: {error}"))?;

    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            let entries = sftp
                .readdir(path)
                .map_err(|error| format!("failed to list remote directory for delete: {error}"))?;
            let mut total_steps = 1;
            for (child_path, _) in entries {
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                total_steps += count_remote_delete_steps(sftp, &child_path)?;
            }
            Ok(total_steps)
        }
        _ => Ok(1),
    }
}

fn delete_remote_path_recursive(
    sftp: &Sftp,
    path: &Path,
    progress: &mut DeleteProgressTracker,
) -> Result<(), String> {
    progress.ensure_not_cancelled()?;
    let stat = sftp
        .lstat(path)
        .map_err(|error| format!("failed to inspect remote path: {error}"))?;

    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            let entries = sftp
                .readdir(path)
                .map_err(|error| format!("failed to list remote directory for delete: {error}"))?;
            for (child_path, _) in entries {
                progress.ensure_not_cancelled()?;
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                delete_remote_path_recursive(sftp, &child_path, progress)?;
            }
            progress.ensure_not_cancelled()?;
            progress.set_current_path(Some(path_to_string(path)))?;
            sftp.rmdir(path)
                .map_err(|error| format!("failed to remove remote directory: {error}"))?;
            progress.finish_step()
        }
        _ => {
            progress.ensure_not_cancelled()?;
            progress.set_current_path(Some(path_to_string(path)))?;
            sftp.unlink(path)
                .map_err(|error| format!("failed to remove remote file: {error}"))?;
            progress.finish_step()
        }
    }
}

fn should_skip_remote_child(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|value| value.to_str()),
        Some(".") | Some("..")
    )
}

fn copy_remote_entry_to_path(
    sftp: &Sftp,
    source_path: &Path,
    destination_path: &Path,
    source_stat: FileStat,
) -> Result<(), String> {
    match kind_from_permissions(source_stat.perm) {
        RemoteFileKind::Directory => {
            if destination_path.starts_with(source_path) {
                return Err("cannot copy a directory into itself".to_string());
            }

            ensure_remote_directory(sftp, destination_path)?;
            let entries = sftp
                .readdir(source_path)
                .map_err(|error| format!("failed to read remote directory for copy: {error}"))?;
            for (child_path, child_stat) in entries {
                let child_name = child_path
                    .file_name()
                    .ok_or_else(|| "invalid child path while copying directory".to_string())?;
                copy_remote_entry_to_path(
                    sftp,
                    &child_path,
                    &destination_path.join(child_name),
                    child_stat,
                )?;
            }
            Ok(())
        }
        RemoteFileKind::Symlink => {
            let target = sftp
                .readlink(source_path)
                .map_err(|error| format!("failed to read remote symlink: {error}"))?;
            sftp.symlink(&target, destination_path)
                .map_err(|error| format!("failed to copy remote symlink: {error}"))
        }
        _ => copy_remote_file(sftp, source_path, destination_path),
    }
}

fn copy_remote_file(
    sftp: &Sftp,
    source_path: &Path,
    destination_path: &Path,
) -> Result<(), String> {
    if let Some(parent) = destination_path.parent() {
        ensure_remote_directory(sftp, parent)?;
    }

    let mut source = sftp
        .open(source_path)
        .map_err(|error| format!("failed to open remote source file: {error}"))?;
    let mut destination = sftp
        .open_mode(
            destination_path,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
            0o644,
            OpenType::File,
        )
        .map_err(|error| format!("failed to create remote copy: {error}"))?;
    copy(&mut source, &mut destination)
        .map_err(|error| format!("failed to copy remote file data: {error}"))?;
    destination
        .flush()
        .map_err(|error| format!("failed to flush remote copy: {error}"))
}

fn remote_entry_names(
    sftp: &Sftp,
    destination_directory: &Path,
) -> Result<HashSet<String>, String> {
    let entries = sftp
        .readdir(destination_directory)
        .map_err(|error| format!("failed to inspect remote upload destination: {error}"))?;
    let mut existing_names = HashSet::new();

    for (entry_path, _) in entries {
        if let Some(name) = entry_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .filter(|value| value != "." && value != "..")
        {
            existing_names.insert(name);
        }
    }

    Ok(existing_names)
}

fn resolve_upload_target_name(
    existing_names: &HashSet<String>,
    base_name: &str,
    policy: UploadConflictPolicy,
) -> Result<Option<String>, String> {
    if !existing_names.contains(base_name) {
        return Ok(Some(base_name.to_string()));
    }

    match policy {
        UploadConflictPolicy::Overwrite => Ok(Some(base_name.to_string())),
        UploadConflictPolicy::Skip => Ok(None),
        UploadConflictPolicy::Fail => Err(format!("remote path already exists: {base_name}")),
    }
}

fn unique_remote_destination(
    sftp: &Sftp,
    destination_directory: &Path,
    base_name: &str,
) -> Result<PathBuf, String> {
    let candidate = destination_directory.join(base_name);
    if !remote_path_exists(sftp, &candidate) {
        return Ok(candidate);
    }

    let (stem, extension) = split_name(base_name);
    for index in 1..1000 {
        let suffix = if index == 1 {
            " copy".to_string()
        } else {
            format!(" copy {index}")
        };
        let candidate_name = match extension.as_deref() {
            Some(extension) => format!("{stem}{suffix}.{extension}"),
            None => format!("{stem}{suffix}"),
        };
        let candidate = destination_directory.join(candidate_name);
        if !remote_path_exists(sftp, &candidate) {
            return Ok(candidate);
        }
    }

    Err(format!(
        "failed to find an available destination name for {base_name}"
    ))
}

fn split_name(name: &str) -> (String, Option<String>) {
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => {
            (stem.to_string(), Some(extension.to_string()))
        }
        _ => (name.to_string(), None),
    }
}

fn scan_local_upload_path(local_path: &Path) -> Result<UploadScanStats, String> {
    let metadata = fs::symlink_metadata(local_path)
        .map_err(|error| format!("failed to read local path metadata: {error}"))?;

    if metadata.file_type().is_symlink() {
        return Err(format!(
            "symlink upload is not supported: {}",
            local_path.display()
        ));
    }

    if metadata.is_dir() {
        let mut stats = UploadScanStats {
            total_bytes: 0,
            total_steps: 1,
        };
        let entries = fs::read_dir(local_path)
            .map_err(|error| format!("failed to read local directory: {error}"))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("failed to read local directory entry: {error}"))?;
            stats.combine(scan_local_upload_path(&entry.path())?);
        }
        return Ok(stats);
    }

    if metadata.is_file() {
        return Ok(UploadScanStats {
            total_bytes: metadata.len(),
            total_steps: 1,
        });
    }

    Err(format!(
        "unsupported local path type for upload: {}",
        local_path.display()
    ))
}

fn upload_local_entry_to_path(
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &Path,
    progress: &mut UploadProgressTracker,
) -> Result<(), String> {
    progress.ensure_not_cancelled()?;
    let metadata = fs::symlink_metadata(local_path)
        .map_err(|error| format!("failed to read local path metadata: {error}"))?;

    if metadata.file_type().is_symlink() {
        return Err(format!(
            "symlink upload is not supported: {}",
            local_path.display()
        ));
    }

    if metadata.is_dir() {
        progress.set_current_path(Some(path_to_string(local_path)))?;
        ensure_remote_directory(sftp, remote_path)?;
        progress.finish_step()?;
        let entries = fs::read_dir(local_path)
            .map_err(|error| format!("failed to read local directory: {error}"))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("failed to read local directory entry: {error}"))?;
            upload_local_entry_to_path(
                sftp,
                &entry.path(),
                &remote_path.join(entry.file_name()),
                progress,
            )?;
        }
        return Ok(());
    }

    if metadata.is_file() {
        progress.set_current_path(Some(path_to_string(local_path)))?;
        if let Some(parent) = remote_path.parent() {
            ensure_remote_directory(sftp, parent)?;
        }

        let mut local_file = fs::File::open(local_path)
            .map_err(|error| format!("failed to open local file: {error}"))?;
        let mut remote_file = sftp
            .open_mode(
                remote_path,
                OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
                0o644,
                OpenType::File,
            )
            .map_err(|error| format!("failed to create remote upload target: {error}"))?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            progress.ensure_not_cancelled().inspect_err(|_| {
                let _ = sftp.unlink(remote_path);
            })?;
            let read = local_file
                .read(&mut buffer)
                .map_err(|error| format!("failed to read local file for upload: {error}"))?;
            if read == 0 {
                break;
            }
            remote_file
                .write_all(&buffer[..read])
                .map_err(|error| format!("failed to upload local file: {error}"))?;
            progress.advance_bytes(read as u64)?;
        }
        remote_file
            .flush()
            .map_err(|error| format!("failed to flush remote upload: {error}"))?;
        progress.finish_step()?;
        return Ok(());
    }

    Err(format!(
        "unsupported local path type for upload: {}",
        local_path.display()
    ))
}

fn map_remote_file(path: PathBuf, stat: FileStat) -> RemoteFileEntry {
    let path_string = path_to_string(&path);
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| path_string.clone());

    RemoteFileEntry {
        path: path_string,
        name,
        kind: kind_from_permissions(stat.perm),
        size: stat.size,
        modified_at: stat.mtime,
        permissions: stat.perm,
        owner_uid: stat.uid,
        group_gid: stat.gid,
        owner_name: None,
        group_name: None,
    }
}

fn sort_remote_entries(left: &RemoteFileEntry, right: &RemoteFileEntry) -> Ordering {
    match (left.kind, right.kind) {
        (RemoteFileKind::Directory, RemoteFileKind::Directory)
        | (RemoteFileKind::File, RemoteFileKind::File)
        | (RemoteFileKind::Symlink, RemoteFileKind::Symlink)
        | (RemoteFileKind::Other, RemoteFileKind::Other) => {
            left.name.to_lowercase().cmp(&right.name.to_lowercase())
        }
        (RemoteFileKind::Directory, _) => Ordering::Less,
        (_, RemoteFileKind::Directory) => Ordering::Greater,
        _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
    }
}

fn kind_from_permissions(permissions: Option<u32>) -> RemoteFileKind {
    const FILE_TYPE_MASK: u32 = 0o170000;
    const DIRECTORY_MASK: u32 = 0o040000;
    const FILE_MASK: u32 = 0o100000;
    const SYMLINK_MASK: u32 = 0o120000;

    match permissions.map(|value| value & FILE_TYPE_MASK) {
        Some(DIRECTORY_MASK) => RemoteFileKind::Directory,
        Some(FILE_MASK) => RemoteFileKind::File,
        Some(SYMLINK_MASK) => RemoteFileKind::Symlink,
        _ => RemoteFileKind::Other,
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn open_path_with_default_app(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(path);
        cmd
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg("start").arg("").arg(path);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(path);
        cmd
    };

    command
        .spawn()
        .map_err(|error| format!("failed to open file with default app: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_target_name_overwrites_existing_entry_when_requested() {
        let existing_names = HashSet::from([String::from("report.txt")]);

        let resolved = resolve_upload_target_name(
            &existing_names,
            "report.txt",
            UploadConflictPolicy::Overwrite,
        )
        .expect("overwrite policy should allow replacing the existing target");

        assert_eq!(resolved, Some(String::from("report.txt")));
    }

    #[test]
    fn upload_target_name_skips_existing_entry_when_requested() {
        let existing_names = HashSet::from([String::from("report.txt")]);

        let resolved =
            resolve_upload_target_name(&existing_names, "report.txt", UploadConflictPolicy::Skip)
                .expect("skip policy should be treated as a valid decision");

        assert_eq!(resolved, None);
    }

    #[test]
    fn upload_target_name_rejects_existing_entry_without_explicit_resolution() {
        let existing_names = HashSet::from([String::from("report.txt")]);

        let error =
            resolve_upload_target_name(&existing_names, "report.txt", UploadConflictPolicy::Fail)
                .expect_err("missing overwrite confirmation should fail the upload");

        assert!(error.contains("report.txt"));
    }

    #[test]
    fn upload_target_name_allows_new_entry_without_conflict() {
        let existing_names = HashSet::<String>::new();

        let resolved =
            resolve_upload_target_name(&existing_names, "report.txt", UploadConflictPolicy::Fail)
                .expect("new names should upload without additional confirmation");

        assert_eq!(resolved, Some(String::from("report.txt")));
    }
}
