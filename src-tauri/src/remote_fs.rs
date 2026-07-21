use crate::connection::connect_sftp;
use crate::identity_cache::RemoteIdentityCache;
use crate::sftp_pool::SftpPool;
use crate::portable_local_path;
use crate::models::{
    CopyRemotePathRequest, CopyRemoteToRemoteRequest, CreateRemoteEntryKind, CreateRemoteEntryRequest, DeleteProgressTracker,
    DeleteRemotePathRequest, DownloadProgressTracker, DownloadRemotePathsRequest, DownloadScanStats,
    OpenRemoteFileRequest, ReadRemoteFileRequest, ReadRemoteFileResponse, RemoteCopyProgressTracker,
    RemoteCopyScanStats, RemoteDirectoryListing, RemoteDirectoryRequest, RemoteFileEntry,
    RemoteFileKind, RenameRemotePathRequest,
    RestoreRemotePathRequest, TrashRemotePathRequest, TrashedRemotePath,
    UpdateRemotePermissionsRequest, UploadConflictPolicy, UploadLocalPathsRequest,
    UploadProgressTracker, UploadScanStats,
};
use log::{info, warn};
use ssh2::{FileStat, OpenFlags, OpenType, RenameFlags, Session, Sftp};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs,
    io::{copy, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::{AtomicBool, Ordering as AtomicOrdering}, Arc},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use uuid::Uuid;

const OPEN_TEMP_RETENTION: Duration = Duration::from_secs(60 * 60 * 24);
const TERM_BRIDGE_DIRECTORY: &str = ".termbridge";
const TERM_BRIDGE_TRASH_DIRECTORY: &str = "trash";
const TERM_BRIDGE_UPLOAD_DIRECTORY: &str = "upload";
const TERM_BRIDGE_DOWNLOAD_DIRECTORY: &str = "download";
const TERM_BRIDGE_REMOTE_COPY_DIRECTORY: &str = "remote-copy";
const TERM_BRIDGE_TRASH_RETENTION: Duration = Duration::from_secs(60 * 60 * 24);
const TERM_BRIDGE_STAGING_RETENTION: Duration = Duration::from_secs(60 * 60 * 24);
const TERM_BRIDGE_UPLOAD_PREFIX: &str = ".termbridge-upload-";
const TERM_BRIDGE_UPLOAD_SUFFIX: &str = ".part";
const TERM_BRIDGE_DOWNLOAD_SUFFIX: &str = ".part";

pub(crate) fn is_connection_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("ssh transport disconnected")
        || lower.contains("transport read")
        || lower.contains("connection reset")
        || lower.contains("connection aborted")
        || lower.contains("broken pipe")
        || lower.contains("draining incoming flow")
        || lower.contains("socket error")
        || lower.contains("failed reading from socket")
        || lower.contains("socket closed")
        || lower.contains("socket disconnect")
        || lower.contains("socket disconnected")
        || lower.contains("socket send failure")
        || lower.contains("error receiving on socket")
        || lower.contains("bad socket")
        || lower.contains("connection lost")
        || lower.contains("no connection")
        || lower.contains("timed out")
}

pub(crate) fn list_remote_directory_blocking(
    request: RemoteDirectoryRequest,
    pool: Option<&SftpPool>,
    cache: Option<&RemoteIdentityCache>,
    known_hosts: Option<&Path>,
) -> Result<RemoteDirectoryListing, String> {
    let connection = request.connection.clone();
    let result = list_remote_directory_inner(request, pool, cache, known_hosts);
    if let Err(ref error) = result {
        if let Some(pool) = pool {
            if is_connection_error(error) {
                pool.invalidate(&connection);
            }
        }
    }
    result
}

fn list_remote_directory_inner(
    request: RemoteDirectoryRequest,
    pool: Option<&SftpPool>,
    cache: Option<&RemoteIdentityCache>,
    known_hosts: Option<&Path>,
) -> Result<RemoteDirectoryListing, String> {
    let scope = format!(
        "{}:{}:{}",
        request.connection.host, request.connection.port, request.connection.username
    );
    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    list_remote_directory_from_sftp(
        &scope,
        &connected.session,
        &connected.sftp,
        request.path.as_deref(),
        cache,
    )
}

pub(crate) fn create_remote_entry_blocking(
    request: CreateRemoteEntryRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    let connection = request.connection.clone();
    let result = create_remote_entry_inner(request, pool, known_hosts);
    if let Err(ref error) = result {
        if let Some(pool) = pool {
            if is_connection_error(error) {
                pool.invalidate(&connection);
            }
        }
    }
    result
}

fn create_remote_entry_inner(
    request: CreateRemoteEntryRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    validate_remote_name(&request.name)?;

    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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

pub(crate) fn rename_remote_path_blocking(
    request: RenameRemotePathRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    let connection = request.connection.clone();
    let result = rename_remote_path_inner(request, pool, known_hosts);
    if let Err(ref error) = result {
        if let Some(pool) = pool {
            if is_connection_error(error) {
                pool.invalidate(&connection);
            }
        }
    }
    result
}

fn rename_remote_path_inner(
    request: RenameRemotePathRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    validate_remote_name(&request.new_name)?;

    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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

pub(crate) fn trash_remote_path_blocking(
    request: TrashRemotePathRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<TrashedRemotePath, String> {
    let connection = request.connection.clone();
    let result = trash_remote_path_inner(request, pool, known_hosts);
    if let Err(ref error) = result {
        if let Some(pool) = pool {
            if is_connection_error(error) {
                pool.invalidate(&connection);
            }
        }
    }
    result
}

fn trash_remote_path_inner(
    request: TrashRemotePathRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<TrashedRemotePath, String> {
    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let source_path = Path::new(&request.path);
    let parent_path = source_path
        .parent()
        .ok_or_else(|| "unable to resolve parent path for trash".to_string())?;
    let file_name = source_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "unable to resolve file name for trash".to_string())?;
    validate_not_termbridge_name(&file_name)?;

    connected
        .sftp
        .lstat(source_path)
        .map_err(|error| format!("failed to inspect remote path before trashing: {error}"))?;

    let trash_directory = termbridge_subdirectory(parent_path, TERM_BRIDGE_TRASH_DIRECTORY);
    ensure_remote_directory(&connected.sftp, &trash_directory)?;
    let trashed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let trash_path = trash_directory.join(format!(
        "tb-{trashed_at}-{}-{file_name}",
        Uuid::new_v4()
    ));

    connected
        .sftp
        .rename(
            source_path,
            &trash_path,
            Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
        )
        .map_err(|error| format!("failed to move remote path to trash: {error}"))?;

    Ok(TrashedRemotePath {
        original_path: request.path,
        trash_path: path_to_string(&trash_path),
    })
}

pub(crate) fn restore_remote_path_blocking(
    request: RestoreRemotePathRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    let connection = request.connection.clone();
    let result = restore_remote_path_inner(request, pool, known_hosts);
    if let Err(ref error) = result {
        if let Some(pool) = pool {
            if is_connection_error(error) {
                pool.invalidate(&connection);
            }
        }
    }
    result
}

fn restore_remote_path_inner(
    request: RestoreRemotePathRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let original_path = Path::new(&request.original_path);
    let trash_path = Path::new(&request.trash_path);

    if remote_path_exists(&connected.sftp, original_path) {
        return Err(format!(
            "restore target already exists: {}",
            path_to_string(original_path)
        ));
    }
    connected
        .sftp
        .lstat(trash_path)
        .map_err(|error| format!("trashed remote path is unavailable: {error}"))?;

    connected
        .sftp
        .rename(
            trash_path,
            original_path,
            Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
        )
        .map_err(|error| format!("failed to restore remote path: {error}"))
}

pub(crate) fn update_remote_permissions_blocking(
    request: UpdateRemotePermissionsRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    let connection = request.connection.clone();
    let result = update_remote_permissions_inner(request, pool, known_hosts);
    if let Err(ref error) = result {
        if let Some(pool) = pool {
            if is_connection_error(error) {
                pool.invalidate(&connection);
            }
        }
    }
    result
}

fn update_remote_permissions_inner(
    request: UpdateRemotePermissionsRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = std::path::Path::new(&request.path);
    let mut stat = connected
        .sftp
        .stat(path)
        .map_err(|error| format!("failed to stat remote path: {error}"))?;
    stat.perm = Some(request.permissions);
    connected
        .sftp
        .setstat(path, stat)
        .map_err(|error| format!("failed to update remote permissions: {error}"))
}

pub(crate) fn delete_remote_path_blocking(
    app: AppHandle,
    request: DeleteRemotePathRequest,
    cancel_flag: Arc<AtomicBool>,
    pool: Option<&SftpPool>,
) -> Result<(), String> {
    let connection = request.connection.clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let result = delete_remote_path_inner(app, request, cancel_flag, pool, known_hosts.as_deref());
    if let Err(ref error) = result {
        if let Some(pool) = pool {
            if is_connection_error(error) {
                pool.invalidate(&connection);
            }
        }
    }
    result
}

fn delete_remote_path_inner(
    app: AppHandle,
    request: DeleteRemotePathRequest,
    cancel_flag: Arc<AtomicBool>,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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

pub(crate) fn copy_remote_path_blocking(
    request: CopyRemotePathRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    let connection = request.connection.clone();
    let result = copy_remote_path_inner(request, pool, known_hosts);
    if let Err(ref error) = result {
        if let Some(pool) = pool {
            if is_connection_error(error) {
                pool.invalidate(&connection);
            }
        }
    }
    result
}

fn copy_remote_path_inner(
    request: CopyRemotePathRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let source_path = Path::new(&request.source_path);
    let destination_directory = Path::new(&request.destination_directory);
    ensure_remote_directory(&connected.sftp, destination_directory)?;

    let source_name = source_path
        .file_name()
        .ok_or_else(|| "source path has no file name".to_string())?
        .to_string_lossy()
        .to_string();
    validate_not_termbridge_name(&source_name)?;
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
    pool: Option<&SftpPool>,
) -> Result<(), String> {
    let connection = request.connection.clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let result = upload_local_paths_inner(app, request, cancel_flag, pool, known_hosts.as_deref());
    if let Err(ref error) = result {
        if let Some(pool) = pool {
            if is_connection_error(error) {
                pool.invalidate(&connection);
            }
        }
    }
    result
}

fn upload_local_paths_inner(
    app: AppHandle,
    request: UploadLocalPathsRequest,
    cancel_flag: Arc<AtomicBool>,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    if request.local_paths.is_empty() {
        return Err("no local files were provided for upload".to_string());
    }

    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
        validate_not_termbridge_name(&file_name)?;
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
        if conflict_policy == UploadConflictPolicy::Replace
            && remote_path_exists(&connected.sftp, &destination_path)
            && upload_requires_pre_removal(&connected.sftp, local_path, &destination_path)?
        {
            remove_remote_path_for_upload(&connected.sftp, &destination_path, &progress)?;
        }
        upload_local_entry_to_path(
            &connected.sftp,
            local_path,
            &destination_path,
            matches!(
                conflict_policy,
                UploadConflictPolicy::Overwrite | UploadConflictPolicy::Replace
            ),
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
    pool: Option<&SftpPool>,
) -> Result<(), String> {
    let connection = request.connection.clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let result = download_remote_paths_inner(app, request, cancel_flag, pool, known_hosts.as_deref());
    if let Err(ref error) = result {
        if let Some(pool) = pool {
            if is_connection_error(error) {
                pool.invalidate(&connection);
            }
        }
    }
    result
}

fn download_remote_paths_inner(
    app: AppHandle,
    request: DownloadRemotePathsRequest,
    cancel_flag: Arc<AtomicBool>,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    if request.remote_paths.is_empty() {
        return Err("no remote paths were provided for download".to_string());
    }

    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
        info!(
            "Downloading remote_path={} to destination_path={}",
            remote_path.display(),
            destination_path.display()
        );
        download_remote_entry_to_path(
            &connected.sftp,
            remote_path,
            &destination_path,
            &mut progress,
        )?;
        if !destination_path.exists() {
            warn!(
                "Downloaded file does not exist at destination_path={}",
                destination_path.display()
            );
        }
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

    let temporary_path = temporary_download_path(local_path)?;
    if let Some(parent) = temporary_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create download staging directory: {error}"))?;
    }
    let download_result = (|| {
        let mut remote_file = sftp
            .open(remote_path)
            .map_err(|error| format!("failed to open remote file: {error}"))?;
        let mut local_file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
            .map_err(|error| format!("failed to create download temporary file: {error}"))?;

        let mut buffer = [0u8; 64 * 1024];
        loop {
            progress.ensure_not_cancelled()?;
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
        drop(local_file);
        commit_download_file(&temporary_path, local_path)
    })();

    if download_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    download_result?;
    progress.finish_step()?;
    Ok(())
}

pub(crate) fn copy_remote_to_remote_blocking(
    app: AppHandle,
    request: CopyRemoteToRemoteRequest,
    cancel_flag: Arc<AtomicBool>,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    if request.source_paths.is_empty() {
        return Err("no remote paths were provided".to_string());
    }
    if !request.conflict_policies.is_empty()
        && request.conflict_policies.len() != request.source_paths.len()
    {
        return Err("conflict policy count does not match remote paths".to_string());
    }

    let source = connect_sftp(&request.source_connection, pool, known_hosts)?;
    let destination = connect_sftp(&request.destination_connection, pool, known_hosts)?;
    if Arc::ptr_eq(&source, &destination) {
        let connected = source.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        return copy_remote_to_remote_with_sftp(
            app,
            request,
            cancel_flag,
            &connected.sftp,
            &connected.sftp,
            true,
        );
    }
    // Always acquire pooled connections in a stable order. Without this, concurrent
    // A -> B and B -> A copies can each hold one connection while waiting forever
    // for the other one.
    let source_address = Arc::as_ptr(&source) as usize;
    let destination_address = Arc::as_ptr(&destination) as usize;
    let (source, destination) = if source_address < destination_address {
        let source_guard = source.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let destination_guard = destination.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        (source_guard, destination_guard)
    } else {
        let destination_guard = destination.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let source_guard = source.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        (source_guard, destination_guard)
    };
    copy_remote_to_remote_with_sftp(
        app,
        request,
        cancel_flag,
        &source.sftp,
        &destination.sftp,
        false,
    )
}

struct RemoteCopyTask {
    source_path: PathBuf,
    destination_path: PathBuf,
}

struct RemoteCopyCommit {
    destination_path: PathBuf,
    backup_path: Option<PathBuf>,
}

fn copy_remote_to_remote_with_sftp(
    app: AppHandle,
    request: CopyRemoteToRemoteRequest,
    cancel_flag: Arc<AtomicBool>,
    source: &Sftp,
    destination: &Sftp,
    same_connection: bool,
) -> Result<(), String> {
    let destination_directory = Path::new(&request.destination_directory);
    ensure_remote_directory(destination, destination_directory)?;
    let staging_directory =
        termbridge_subdirectory(destination_directory, TERM_BRIDGE_REMOTE_COPY_DIRECTORY);
    ensure_remote_directory(destination, &staging_directory)?;

    let mut tasks = Vec::new();
    let mut scan_stats = RemoteCopyScanStats::default();
    for (index, source_path) in request.source_paths.iter().enumerate() {
        if cancel_flag.load(AtomicOrdering::SeqCst) {
            return Err("remote copy cancelled".to_string());
        }
        let source_path = Path::new(source_path);
        let name = source_path
            .file_name()
            .ok_or_else(|| "remote source path has no file name".to_string())?;
        validate_not_termbridge_name(&name.to_string_lossy())?;
        let destination_path = destination_directory.join(name);
        let stat = source
            .lstat(source_path)
            .map_err(|error| format!("failed to inspect remote source: {error}"))?;
        if same_connection {
            validate_same_connection_copy_destination(
                source_path,
                &destination_path,
                kind_from_permissions(stat.perm) == RemoteFileKind::Directory,
            )?;
        }
        let policy = request
            .conflict_policies
            .get(index)
            .copied()
            .unwrap_or(UploadConflictPolicy::Fail);
        if remote_path_exists(destination, &destination_path) {
            match policy {
                UploadConflictPolicy::Skip => continue,
                UploadConflictPolicy::Fail => {
                    return Err(format!(
                        "remote destination already exists: {}",
                        destination_path.display()
                    ));
                }
                UploadConflictPolicy::Overwrite | UploadConflictPolicy::Replace => {}
            }
        }
        scan_stats.combine(scan_remote_copy_path(source, source_path, &cancel_flag)?);
        tasks.push(RemoteCopyTask {
            source_path: source_path.to_path_buf(),
            destination_path,
        });
    }

    let mut progress = RemoteCopyProgressTracker::new(
        app,
        request.operation_id,
        cancel_flag,
        scan_stats,
    );
    progress.emit()?;
    let mut commits = Vec::new();

    for task in tasks {
        let stage_path = staging_directory.join(format!("{}.part", Uuid::new_v4()));
        let copy_result = copy_remote_entry_between(
            source,
            destination,
            &task.source_path,
            &stage_path,
            &mut progress,
        );
        if let Err(error) = copy_result {
            let _ = remove_remote_entry_if_exists(destination, &stage_path);
            rollback_remote_copy_commits(destination, &commits);
            return Err(error);
        }
        if let Err(error) = progress.ensure_not_cancelled() {
            let _ = remove_remote_entry_if_exists(destination, &stage_path);
            rollback_remote_copy_commits(destination, &commits);
            return Err(error);
        }

        let backup_path = if remote_path_exists(destination, &task.destination_path) {
            let destination_name = task
                .destination_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("entry");
            let backup = staging_directory.join(format!(
                "backup-{}-{destination_name}",
                Uuid::new_v4()
            ));
            if let Err(error) = destination.rename(
                &task.destination_path,
                &backup,
                Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
            ) {
                let _ = remove_remote_entry_if_exists(destination, &stage_path);
                rollback_remote_copy_commits(destination, &commits);
                return Err(format!("failed to preserve remote copy destination: {error}"));
            }
            Some(backup)
        } else {
            None
        };

        if let Err(error) = destination.rename(
            &stage_path,
            &task.destination_path,
            Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
        ) {
            if let Some(backup) = &backup_path {
                let _ = destination.rename(
                    backup,
                    &task.destination_path,
                    Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
                );
            }
            let _ = remove_remote_entry_if_exists(destination, &stage_path);
            rollback_remote_copy_commits(destination, &commits);
            return Err(format!("failed to commit remote copy: {error}"));
        }
        commits.push(RemoteCopyCommit {
            destination_path: task.destination_path,
            backup_path,
        });
    }

    for commit in commits {
        if let Some(backup_path) = commit.backup_path {
            if let Err(error) = remove_remote_entry_if_exists(destination, &backup_path) {
                warn!(
                    "failed to clean remote copy backup path={}: {error}",
                    backup_path.display()
                );
            }
        }
    }
    progress.set_current_path(None)?;
    Ok(())
}

fn rollback_remote_copy_commits(destination: &Sftp, commits: &[RemoteCopyCommit]) {
    for commit in commits.iter().rev() {
        let _ = remove_remote_entry_if_exists(destination, &commit.destination_path);
        if let Some(backup_path) = &commit.backup_path {
            if let Err(error) = destination.rename(
                backup_path,
                &commit.destination_path,
                Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
            ) {
                warn!(
                    "failed to restore remote copy backup path={}: {error}",
                    backup_path.display()
                );
            }
        }
    }
}

fn remove_remote_entry_if_exists(sftp: &Sftp, path: &Path) -> Result<(), String> {
    if !remote_path_exists(sftp, path) {
        return Ok(());
    }
    remove_remote_entry_simple(sftp, path)
}

fn scan_remote_copy_path(
    source: &Sftp,
    source_path: &Path,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<RemoteCopyScanStats, String> {
    if cancel_flag.load(AtomicOrdering::SeqCst) {
        return Err("remote copy cancelled".to_string());
    }
    let stat = source
        .lstat(source_path)
        .map_err(|error| format!("failed to inspect remote source: {error}"))?;
    let kind = kind_from_permissions(stat.perm);
    let mut stats = RemoteCopyScanStats {
        total_bytes: if kind == RemoteFileKind::File {
            stat.size.unwrap_or(0)
        } else {
            0
        },
        total_steps: 1,
    };
    if kind == RemoteFileKind::Directory {
        for (child_path, _) in source
            .readdir(source_path)
            .map_err(|error| format!("failed to list remote source directory: {error}"))?
        {
            if should_skip_remote_copy_child(&child_path) {
                continue;
            }
            stats.combine(scan_remote_copy_path(source, &child_path, cancel_flag)?);
        }
    }
    Ok(stats)
}

fn validate_same_connection_copy_destination(
    source_path: &Path,
    destination_path: &Path,
    source_is_directory: bool,
) -> Result<(), String> {
    if destination_path == source_path {
        return Err("cannot copy a remote entry onto itself".to_string());
    }
    if source_is_directory && destination_path.starts_with(source_path) {
        return Err("cannot copy a directory into itself".to_string());
    }
    Ok(())
}

fn copy_remote_entry_between(
    source: &Sftp,
    destination: &Sftp,
    source_path: &Path,
    destination_path: &Path,
    progress: &mut RemoteCopyProgressTracker,
) -> Result<(), String> {
    progress.ensure_not_cancelled()?;
    progress.set_current_path(Some(path_to_string(source_path)))?;
    let stat = source
        .lstat(source_path)
        .map_err(|error| format!("failed to inspect remote source: {error}"))?;
    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            destination
                .mkdir(destination_path, stat.perm.unwrap_or(0o755) as i32)
                .map_err(|error| format!("failed to create remote copy directory: {error}"))?;
            for (child_path, _) in source
                .readdir(source_path)
                .map_err(|error| format!("failed to list remote source directory: {error}"))?
            {
                if should_skip_remote_copy_child(&child_path) {
                    continue;
                }
                let child_name = child_path
                    .file_name()
                    .ok_or_else(|| "remote child path has no file name".to_string())?;
                copy_remote_entry_between(
                    source,
                    destination,
                    &child_path,
                    &destination_path.join(child_name),
                    progress,
                )?;
            }
            let _ = destination.setstat(destination_path, FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: stat.perm,
                atime: stat.atime,
                mtime: stat.mtime,
            });
        }
        RemoteFileKind::Symlink => {
            let target = source
                .readlink(source_path)
                .map_err(|error| format!("failed to read remote source symlink: {error}"))?;
            destination
                .symlink(&target, destination_path)
                .map_err(|error| format!("failed to create remote destination symlink: {error}"))?;
        }
        _ => {
            let mut reader = source
                .open(source_path)
                .map_err(|error| format!("failed to open remote source: {error}"))?;
            let mut writer = destination
                .open_mode(
                    destination_path,
                    OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE | OpenFlags::EXCLUSIVE,
                    stat.perm.unwrap_or(0o644) as i32,
                    OpenType::File,
                )
                .map_err(|error| format!("failed to create remote destination: {error}"))?;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                progress.ensure_not_cancelled()?;
                let read = reader
                    .read(&mut buffer)
                    .map_err(|error| format!("failed to read remote source: {error}"))?;
                if read == 0 {
                    break;
                }
                writer
                    .write_all(&buffer[..read])
                    .map_err(|error| format!("failed to copy between remote hosts: {error}"))?;
                progress.advance_bytes(read as u64)?;
            }
            writer
                .flush()
                .map_err(|error| format!("failed to flush remote destination: {error}"))?;
            drop(writer);
            if let Err(error) = destination.setstat(destination_path, FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: stat.perm,
                atime: stat.atime,
                mtime: stat.mtime,
            }) {
                warn!(
                    "failed to preserve remote copy metadata path={}: {error}",
                    destination_path.display()
                );
            }
        }
    }
    progress.set_current_path(Some(path_to_string(source_path)))?;
    progress.finish_step()
}

fn should_skip_remote_copy_child(path: &Path) -> bool {
    should_skip_remote_child(path)
        || matches!(
            path.file_name().and_then(|value| value.to_str()),
            Some(TERM_BRIDGE_DIRECTORY)
        )
        || path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(is_termbridge_partial_upload_name)
}

fn remove_remote_entry_simple(sftp: &Sftp, path: &Path) -> Result<(), String> {
    let stat = sftp
        .lstat(path)
        .map_err(|error| format!("failed to inspect remote destination: {error}"))?;
    if kind_from_permissions(stat.perm) == RemoteFileKind::Directory {
        for (child_path, _) in sftp
            .readdir(path)
            .map_err(|error| format!("failed to list remote destination: {error}"))?
        {
            if !should_skip_remote_child(&child_path) {
                remove_remote_entry_simple(sftp, &child_path)?;
            }
        }
        sftp.rmdir(path)
            .map_err(|error| format!("failed to replace remote directory: {error}"))
    } else {
        sftp.unlink(path)
            .map_err(|error| format!("failed to replace remote file: {error}"))
    }
}

fn temporary_download_path(local_path: &Path) -> Result<PathBuf, String> {
    let parent = local_path
        .parent()
        .ok_or_else(|| "unable to resolve local download parent directory".to_string())?;
    Ok(parent
        .join(TERM_BRIDGE_DIRECTORY)
        .join(TERM_BRIDGE_DOWNLOAD_DIRECTORY)
        .join(format!("{}{TERM_BRIDGE_DOWNLOAD_SUFFIX}", Uuid::new_v4())))
}

fn commit_download_file(temporary_path: &Path, local_path: &Path) -> Result<(), String> {
    if !local_path.exists() {
        return fs::rename(temporary_path, local_path)
            .map_err(|error| format!("failed to finalize download: {error}"));
    }

    if !fs::metadata(local_path)
        .map_err(|error| format!("failed to inspect existing download target: {error}"))?
        .is_file()
    {
        return Err(format!(
            "download target is not a file: {}",
            local_path.display()
        ));
    }

    let staging_directory = temporary_path
        .parent()
        .ok_or_else(|| "unable to resolve local download staging directory".to_string())?;
    let backup_path = staging_directory.join(format!("backup-{}", Uuid::new_v4()));
    fs::rename(local_path, &backup_path)
        .map_err(|error| format!("failed to preserve existing download target: {error}"))?;

    match fs::rename(temporary_path, local_path) {
        Ok(()) => {
            let _ = fs::remove_file(backup_path);
            Ok(())
        }
        Err(error) => {
            let restore_result = fs::rename(&backup_path, local_path);
            match restore_result {
                Ok(()) => Err(format!("failed to finalize download: {error}")),
                Err(restore_error) => Err(format!(
                    "failed to finalize download: {error}; failed to restore existing target: {restore_error}"
                )),
            }
        }
    }
}

pub(crate) fn open_remote_file_blocking(
    request: OpenRemoteFileRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    let connection = request.connection.clone();
    let result = open_remote_file_inner(request, pool, known_hosts);
    if let Err(ref error) = result {
        if let Some(pool) = pool {
            if is_connection_error(error) {
                pool.invalidate(&connection);
            }
        }
    }
    result
}

fn open_remote_file_inner(
    request: OpenRemoteFileRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), String> {
    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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

const PREVIEW_SIZE_LIMIT: u64 = 1024 * 1024;

pub(crate) fn read_remote_file_blocking(
    request: ReadRemoteFileRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<ReadRemoteFileResponse, String> {
    let connection = request.connection.clone();
    let result = read_remote_file_inner(request, pool, known_hosts);
    if let Err(ref error) = result {
        if let Some(pool) = pool {
            if is_connection_error(error) {
                pool.invalidate(&connection);
            }
        }
    }
    result
}

fn read_remote_file_inner(
    request: ReadRemoteFileRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<ReadRemoteFileResponse, String> {
    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let remote_path = Path::new(&request.path);

    let stat = connected
        .sftp
        .lstat(remote_path)
        .map_err(|error| format!("failed to inspect remote file: {error}"))?;

    if kind_from_permissions(stat.perm) == RemoteFileKind::Directory {
        return Err("cannot preview a directory".to_string());
    }

    let size = stat.size.unwrap_or(0);
    if size > PREVIEW_SIZE_LIMIT {
        return Err(format!(
            "file too large to preview: {} bytes (limit: {} bytes)",
            size, PREVIEW_SIZE_LIMIT
        ));
    }

    let file_name = remote_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "remote-file".to_string());

    let mut remote_file = connected
        .sftp
        .open(remote_path)
        .map_err(|error| format!("failed to open remote file: {error}"))?;

    let mut buffer = Vec::with_capacity(size as usize);
    remote_file
        .read_to_end(&mut buffer)
        .map_err(|error| format!("failed to read remote file: {error}"))?;

    let (content, is_text) = match String::from_utf8(buffer) {
        Ok(text) => (text, true),
        Err(error) => {
            let lossy = String::from_utf8_lossy(error.as_bytes()).to_string();
            (lossy, false)
        }
    };

    Ok(ReadRemoteFileResponse {
        path: request.path,
        name: file_name,
        content,
        size,
        is_text,
    })
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
    scope: &str,
    session: &Session,
    sftp: &Sftp,
    requested_path: Option<&str>,
    cache: Option<&RemoteIdentityCache>,
) -> Result<RemoteDirectoryListing, String> {
    let requested_path = requested_path.unwrap_or(".");
    let resolved_path = sftp
        .realpath(Path::new(requested_path))
        .map_err(|error| format!("failed to resolve remote path {requested_path}: {error}"))?;

    if let Err(error) = cleanup_expired_remote_trash(sftp, &resolved_path, SystemTime::now()) {
        warn!(
            "failed to clean expired remote trash path={}: {error}",
            resolved_path.display()
        );
    }
    if let Err(error) = cleanup_expired_termbridge_staging(sftp, &resolved_path, SystemTime::now()) {
        warn!(
            "failed to clean expired TermBridge staging path={}: {error}",
            resolved_path.display()
        );
    }

    let mut entries = sftp
        .readdir(&resolved_path)
        .map_err(|error| format!("failed to list remote directory: {error}"))?
        .into_iter()
        .map(|(path, stat)| map_remote_file(path, stat))
        .filter(|entry| {
            entry.name != TERM_BRIDGE_DIRECTORY
                && !is_termbridge_partial_upload_name(&entry.name)
        })
        .collect::<Vec<_>>();

    enrich_remote_entry_owners(scope, session, &mut entries, cache);
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

fn enrich_remote_entry_owners(
    scope: &str,
    session: &Session,
    entries: &mut [RemoteFileEntry],
    cache: Option<&RemoteIdentityCache>,
) {
    let owner_ids = entries
        .iter()
        .filter_map(|entry| entry.owner_uid)
        .collect::<HashSet<_>>();
    let group_ids = entries
        .iter()
        .filter_map(|entry| entry.group_gid)
        .collect::<HashSet<_>>();

    let owner_names = resolve_identity_names(scope, session, cache, &owner_ids, RemoteIdentityKind::User);
    let group_names = resolve_identity_names(scope, session, cache, &group_ids, RemoteIdentityKind::Group);

    for entry in entries {
        entry.owner_name = entry.owner_uid.and_then(|uid| owner_names.get(&uid).cloned());
        entry.group_name = entry.group_gid.and_then(|gid| group_names.get(&gid).cloned());
    }
}

fn resolve_identity_names(
    scope: &str,
    session: &Session,
    cache: Option<&RemoteIdentityCache>,
    ids: &HashSet<u32>,
    kind: RemoteIdentityKind,
) -> HashMap<u32, String> {
    if ids.is_empty() {
        return HashMap::new();
    }

    let ids_vec: Vec<u32> = ids.iter().copied().collect();

    let (mut names, missing_ids) = if let Some(cache) = cache {
        cache.resolve_names(scope, &ids_vec, kind)
    } else {
        (HashMap::new(), ids_vec)
    };

    if !missing_ids.is_empty() {
        match resolve_remote_identity_names(session, &missing_ids, kind) {
            Ok(resolved) => {
                if let Some(cache) = cache {
                    for (id, name) in &resolved {
                        cache.insert(scope, *id, kind, name.clone());
                    }
                }
                names.extend(resolved);
            }
            Err(error) => {
                warn!("failed to resolve remote {:?} names: {}", kind, error);
            }
        }
    }

    names
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum RemoteIdentityKind {
    User,
    Group,
}

fn resolve_remote_identity_names(
    session: &Session,
    ids: &[u32],
    kind: RemoteIdentityKind,
) -> Result<HashMap<u32, String>, String> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }

    let mut sorted_ids = ids.to_vec();
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
    validate_not_termbridge_name(trimmed)
}

fn validate_not_termbridge_name(name: &str) -> Result<(), String> {
    if name == TERM_BRIDGE_DIRECTORY {
        return Err("'.termbridge' is reserved for application data".to_string());
    }
    Ok(())
}

fn remote_path_exists(sftp: &Sftp, path: &Path) -> bool {
    sftp.lstat(path).is_ok()
}

fn termbridge_subdirectory(parent: &Path, child: &str) -> PathBuf {
    parent.join(TERM_BRIDGE_DIRECTORY).join(child)
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

fn cleanup_expired_remote_trash(
    sftp: &Sftp,
    parent_path: &Path,
    now: SystemTime,
) -> Result<(), String> {
    let trash_directory = termbridge_subdirectory(parent_path, TERM_BRIDGE_TRASH_DIRECTORY);
    let entries = match sftp.readdir(&trash_directory) {
        Ok(entries) => entries,
        Err(_) if !remote_path_exists(sftp, &trash_directory) => return Ok(()),
        Err(error) => return Err(format!("failed to list remote trash: {error}")),
    };
    let cutoff = now
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .saturating_sub(TERM_BRIDGE_TRASH_RETENTION)
        .as_secs();

    for (path, stat) in entries {
        if should_skip_remote_child(&path)
            || remote_trash_created_at(&path, &stat).is_none_or(|created_at| created_at > cutoff)
        {
            continue;
        }
        if let Err(error) = remove_remote_path_without_progress(sftp, &path) {
            warn!(
                "failed to remove expired remote trash path={}: {error}",
                path.display()
            );
        }
    }

    match sftp.readdir(&trash_directory) {
        Ok(entries) if entries.is_empty() => {
            let _ = sftp.rmdir(&trash_directory);
        }
        _ => {}
    }
    Ok(())
}

fn remote_trash_created_at(path: &Path, stat: &FileStat) -> Option<u64> {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("tb-"))
        .and_then(|name| name.split_once('-'))
        .and_then(|(timestamp, _)| timestamp.parse().ok())
        .or(stat.mtime)
}

fn cleanup_expired_termbridge_staging(
    sftp: &Sftp,
    parent_path: &Path,
    now: SystemTime,
) -> Result<(), String> {
    let cutoff = now
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .saturating_sub(TERM_BRIDGE_STAGING_RETENTION)
        .as_secs();
    for child in [TERM_BRIDGE_UPLOAD_DIRECTORY, TERM_BRIDGE_REMOTE_COPY_DIRECTORY] {
        let directory = termbridge_subdirectory(parent_path, child);
        let entries = match sftp.readdir(&directory) {
            Ok(entries) => entries,
            Err(_) if !remote_path_exists(sftp, &directory) => continue,
            Err(error) => {
                return Err(format!("failed to list TermBridge staging directory: {error}"))
            }
        };
        for (path, stat) in entries {
            if should_skip_remote_child(&path) {
                continue;
            }
            let is_partial = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".part"));
            if !is_partial || stat.mtime.is_none_or(|mtime| mtime > cutoff) {
                continue;
            }
            if let Err(error) = remove_remote_path_without_progress(sftp, &path) {
                warn!(
                    "failed to remove expired TermBridge staging path={}: {error}",
                    path.display()
                );
            }
        }
    }
    Ok(())
}

fn remove_remote_path_without_progress(sftp: &Sftp, path: &Path) -> Result<(), String> {
    let stat = sftp
        .lstat(path)
        .map_err(|error| format!("failed to inspect remote trash path: {error}"))?;

    if kind_from_permissions(stat.perm) == RemoteFileKind::Directory {
        let entries = sftp
            .readdir(path)
            .map_err(|error| format!("failed to list remote trash directory: {error}"))?;
        for (child_path, _) in entries {
            if should_skip_remote_child(&child_path) {
                continue;
            }
            remove_remote_path_without_progress(sftp, &child_path)?;
        }
        sftp.rmdir(path)
            .map_err(|error| format!("failed to remove remote trash directory: {error}"))
    } else {
        sftp.unlink(path)
            .map_err(|error| format!("failed to remove remote trash file: {error}"))
    }
}

fn remove_remote_path_for_upload(
    sftp: &Sftp,
    path: &Path,
    progress: &UploadProgressTracker,
) -> Result<(), String> {
    progress.ensure_not_cancelled()?;
    let stat = sftp
        .lstat(path)
        .map_err(|error| format!("failed to inspect remote replacement target: {error}"))?;

    if kind_from_permissions(stat.perm) == RemoteFileKind::Directory {
        let entries = sftp
            .readdir(path)
            .map_err(|error| format!("failed to list remote replacement target: {error}"))?;
        for (child_path, _) in entries {
            if should_skip_remote_child(&child_path) {
                continue;
            }
            remove_remote_path_for_upload(sftp, &child_path, progress)?;
        }
        progress.ensure_not_cancelled()?;
        sftp.rmdir(path)
            .map_err(|error| format!("failed to replace remote directory: {error}"))
    } else {
        sftp.unlink(path)
            .map_err(|error| format!("failed to replace remote file: {error}"))
    }
}

fn upload_requires_pre_removal(
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &Path,
) -> Result<bool, String> {
    let local_metadata = fs::symlink_metadata(local_path)
        .map_err(|error| format!("failed to inspect local replacement source: {error}"))?;
    let remote_stat = sftp
        .lstat(remote_path)
        .map_err(|error| format!("failed to inspect remote replacement target: {error}"))?;

    Ok(!(local_metadata.is_file()
        && kind_from_permissions(remote_stat.perm) == RemoteFileKind::File))
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
        UploadConflictPolicy::Overwrite | UploadConflictPolicy::Replace => {
            Ok(Some(base_name.to_string()))
        }
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
            if entry.file_name() == TERM_BRIDGE_DIRECTORY {
                continue;
            }
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

fn is_private_key_file(path: &std::path::Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let lower = name.to_lowercase();
    lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".ppk")
        || name == "id_rsa"
        || name == "id_ed25519"
        || name == "id_ecdsa"
        || name == "id_dsa"
}

fn upload_local_entry_to_path(
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &Path,
    allow_overwrite: bool,
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
            if entry.file_name() == TERM_BRIDGE_DIRECTORY {
                continue;
            }
            upload_local_entry_to_path(
                sftp,
                &entry.path(),
                &remote_path.join(entry.file_name()),
                allow_overwrite,
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
        let upload_mode = if is_private_key_file(remote_path) {
            0o600
        } else {
            0o644
        };
        upload_regular_file_atomically(
            sftp,
            local_path,
            remote_path,
            metadata.len(),
            upload_mode,
            allow_overwrite,
            progress,
        )?;
        progress.finish_step()?;
        return Ok(());
    }

    Err(format!(
        "unsupported local path type for upload: {}",
        local_path.display()
    ))
}

fn upload_regular_file_atomically(
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &Path,
    expected_size: u64,
    upload_mode: i32,
    allow_overwrite: bool,
    progress: &mut UploadProgressTracker,
) -> Result<(), String> {
    let temporary_path = temporary_upload_path(remote_path)?;
    if let Some(parent) = temporary_path.parent() {
        ensure_remote_directory(sftp, parent)?;
    }
    let upload_result = (|| {
        let mut local_file = fs::File::open(local_path)
            .map_err(|error| format!("failed to open local file: {error}"))?;
        let mut remote_file = sftp
            .open_mode(
                &temporary_path,
                OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE | OpenFlags::EXCLUSIVE,
                upload_mode,
                OpenType::File,
            )
            .map_err(|error| format!("failed to create remote upload temporary file: {error}"))?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            progress.ensure_not_cancelled()?;
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
        drop(remote_file);

        let uploaded_size = sftp
            .stat(&temporary_path)
            .map_err(|error| format!("failed to verify remote upload: {error}"))?
            .size
            .ok_or_else(|| "remote server did not report uploaded file size".to_string())?;
        if uploaded_size != expected_size {
            return Err(format!(
                "remote upload size mismatch: expected {expected_size} bytes, got {uploaded_size}"
            ));
        }

        commit_remote_upload(sftp, &temporary_path, remote_path, allow_overwrite)
    })();

    if upload_result.is_err() {
        let _ = sftp.unlink(&temporary_path);
    }
    upload_result
}

fn commit_remote_upload(
    sftp: &Sftp,
    temporary_path: &Path,
    remote_path: &Path,
    allow_overwrite: bool,
) -> Result<(), String> {
    if !allow_overwrite || !remote_path_exists(sftp, remote_path) {
        return sftp
            .rename(
                temporary_path,
                remote_path,
                Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
            )
            .map_err(|error| format!("failed to finalize remote upload: {error}"));
    }

    // Most SFTP servers negotiate protocol v3. That version has no overwrite
    // flag on SSH_FXP_RENAME, so libssh2 cannot send RenameFlags::OVERWRITE and
    // an attempted rename over an existing file commonly returns SFTP failure.
    // Preserve the old target first, then restore it if committing the upload
    // fails. Both moves stay on the same remote filesystem.
    let backup_path = temporary_upload_backup_path(temporary_path)?;
    sftp.rename(
        remote_path,
        &backup_path,
        Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
    )
    .map_err(|error| format!("failed to preserve remote upload target: {error}"))?;

    if let Err(error) = sftp.rename(
        temporary_path,
        remote_path,
        Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
    ) {
        return match sftp.rename(
            &backup_path,
            remote_path,
            Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
        ) {
            Ok(()) => Err(format!("failed to finalize remote upload: {error}")),
            Err(restore_error) => Err(format!(
                "failed to finalize remote upload: {error}; the previous file remains at {} because it could not be restored: {restore_error}",
                backup_path.display()
            )),
        };
    }

    if let Err(error) = sftp.unlink(&backup_path) {
        warn!(
            "failed to clean remote upload backup path={}: {error}",
            backup_path.display()
        );
    }
    Ok(())
}

fn temporary_upload_backup_path(temporary_path: &Path) -> Result<PathBuf, String> {
    let parent = temporary_path
        .parent()
        .ok_or_else(|| "unable to resolve remote upload staging directory".to_string())?;
    Ok(parent.join(format!("backup-{}.part", Uuid::new_v4())))
}

fn temporary_upload_path(remote_path: &Path) -> Result<PathBuf, String> {
    let parent = remote_path
        .parent()
        .ok_or_else(|| "unable to resolve remote upload parent directory".to_string())?;
    Ok(termbridge_subdirectory(parent, TERM_BRIDGE_UPLOAD_DIRECTORY).join(format!(
        "{}{TERM_BRIDGE_UPLOAD_SUFFIX}",
        Uuid::new_v4()
    )))
}

fn is_termbridge_partial_upload_name(name: &str) -> bool {
    name.starts_with(TERM_BRIDGE_UPLOAD_PREFIX) && name.ends_with(TERM_BRIDGE_UPLOAD_SUFFIX)
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
        | (RemoteFileKind::Other, RemoteFileKind::Other) => cmp_ascii_case_insensitive(&left.name, &right.name),
        (RemoteFileKind::Directory, _) => Ordering::Less,
        (_, RemoteFileKind::Directory) => Ordering::Greater,
        _ => cmp_ascii_case_insensitive(&left.name, &right.name),
    }
}

fn cmp_ascii_case_insensitive(a: &str, b: &str) -> Ordering {
    let mut a_iter = a.as_bytes().iter().map(|c| c.to_ascii_lowercase());
    let mut b_iter = b.as_bytes().iter().map(|c| c.to_ascii_lowercase());
    loop {
        match (a_iter.next(), b_iter.next()) {
            (Some(l), Some(r)) => match l.cmp(&r) {
                Ordering::Equal => continue,
                other => return other,
            },
            (Some(_), None) => return Ordering::Greater,
            (None, Some(_)) => return Ordering::Less,
            (None, None) => return Ordering::Equal,
        }
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
    portable_local_path(path)
}

fn open_path_with_default_app(path: &Path) -> Result<(), String> {
    let path_str = path.to_string_lossy();
    if contains_shell_metacharacters(&path_str) {
        return Err(format!("refused to open path containing shell metacharacters: {path_str}"));
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(path);
        cmd
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("explorer");
        cmd.arg(path);
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

fn contains_shell_metacharacters(input: &str) -> bool {
    input.chars().any(|c| matches!(c, '&' | '|' | '<' | '>' | '(' | ')' | '^' | '"' | '%' | '!'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_connection_copy_rejects_copying_entry_onto_itself() {
        let result = validate_same_connection_copy_destination(
            Path::new("/srv/report.txt"),
            Path::new("/srv/report.txt"),
            false,
        );

        assert_eq!(
            result,
            Err("cannot copy a remote entry onto itself".to_string())
        );
    }

    #[test]
    fn same_connection_copy_rejects_directory_descendant() {
        let result = validate_same_connection_copy_destination(
            Path::new("/srv/assets"),
            Path::new("/srv/assets/archive/assets"),
            true,
        );

        assert_eq!(result, Err("cannot copy a directory into itself".to_string()));
    }

    #[test]
    fn same_connection_copy_allows_sibling_destination() {
        assert!(validate_same_connection_copy_destination(
            Path::new("/srv/assets"),
            Path::new("/backup/assets"),
            true,
        )
        .is_ok());
    }

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
    fn upload_target_name_replaces_existing_entry_when_requested() {
        let existing_names = HashSet::from([String::from("assets")]);

        let resolved =
            resolve_upload_target_name(&existing_names, "assets", UploadConflictPolicy::Replace)
                .expect("replace policy should allow replacing the existing target");

        assert_eq!(resolved, Some(String::from("assets")));
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

    #[test]
    fn detects_transport_disconnected_as_connection_error() {
        assert!(is_connection_error("SSH transport disconnected"));
    }

    #[test]
    fn detects_transport_read_as_connection_error() {
        assert!(is_connection_error("transport read error"));
    }

    #[test]
    fn detects_connection_reset_as_connection_error() {
        assert!(is_connection_error("connection reset by peer"));
    }

    #[test]
    fn detects_broken_pipe_as_connection_error() {
        assert!(is_connection_error("broken pipe"));
    }

    #[test]
    fn ignores_unrelated_errors() {
        assert!(!is_connection_error("file not found"));
        assert!(!is_connection_error("permission denied"));
    }

    #[test]
    fn detects_specific_socket_phrases_as_connection_error() {
        assert!(is_connection_error("socket error"));
        assert!(is_connection_error("failed reading from socket"));
        assert!(is_connection_error("socket closed"));
        assert!(is_connection_error("socket disconnect"));
        assert!(is_connection_error("socket disconnected"));
    }

    #[test]
    fn detects_libssh2_transport_messages_as_connection_errors() {
        assert!(is_connection_error("[Session(-7)] socket send failure"));
        assert!(is_connection_error(
            "[Session(-43)] error receiving on socket"
        ));
        assert!(is_connection_error("[SFTP(7)] no connection"));
        assert!(is_connection_error("[SFTP(8)] connection lost"));
        assert!(is_connection_error("[Session(-9)] timed out"));
    }

    #[test]
    fn termbridge_partial_upload_names_are_detected_precisely() {
        assert!(is_termbridge_partial_upload_name(
            ".termbridge-upload-id.part"
        ));
        assert!(!is_termbridge_partial_upload_name("report.part"));
        assert!(!is_termbridge_partial_upload_name(
            ".termbridge-upload-id.txt"
        ));
    }

    #[test]
    fn temporary_upload_path_uses_termbridge_upload_directory() {
        let temporary = temporary_upload_path(Path::new("/srv/files/report.txt"))
            .expect("temporary upload path");

        assert_eq!(
            path_to_string(temporary.parent().unwrap()),
            "/srv/files/.termbridge/upload"
        );
        assert!(temporary
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .ends_with(TERM_BRIDGE_UPLOAD_SUFFIX));
        assert_ne!(temporary, Path::new("/srv/files/report.txt"));
    }

    #[test]
    fn temporary_upload_backup_stays_in_upload_directory() {
        let temporary = Path::new("/srv/files/.termbridge/upload/upload-id.part");
        let backup = temporary_upload_backup_path(temporary).expect("temporary upload backup");

        assert_eq!(backup.parent(), temporary.parent());
        let name = backup.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("backup-"));
        assert!(name.ends_with(TERM_BRIDGE_UPLOAD_SUFFIX));
        assert_ne!(backup, temporary);
    }

    #[test]
    fn termbridge_layout_groups_application_data() {
        let parent = Path::new("/srv/files");

        assert_eq!(
            path_to_string(&termbridge_subdirectory(parent, TERM_BRIDGE_TRASH_DIRECTORY)),
            "/srv/files/.termbridge/trash"
        );
        assert_eq!(
            path_to_string(&termbridge_subdirectory(parent, TERM_BRIDGE_REMOTE_COPY_DIRECTORY)),
            "/srv/files/.termbridge/remote-copy"
        );
    }

    #[test]
    fn remote_copy_excludes_termbridge_application_data() {
        assert!(should_skip_remote_copy_child(Path::new(
            "/srv/files/.termbridge"
        )));
        assert!(!should_skip_remote_copy_child(Path::new(
            "/srv/files/report.txt"
        )));
    }

    #[test]
    fn termbridge_directory_name_is_reserved() {
        assert!(validate_remote_name(TERM_BRIDGE_DIRECTORY).is_err());
        assert!(validate_remote_name("reports").is_ok());
    }

    #[test]
    fn temporary_download_path_uses_termbridge_download_directory() {
        let temporary = temporary_download_path(Path::new("/downloads/report.txt"))
            .expect("temporary download path");

        assert_eq!(
            path_to_string(temporary.parent().unwrap()),
            "/downloads/.termbridge/download"
        );
        let name = temporary.file_name().unwrap().to_str().unwrap();
        assert!(name.ends_with(TERM_BRIDGE_DOWNLOAD_SUFFIX));
        assert_ne!(temporary, Path::new("/downloads/report.txt"));
    }

    #[test]
    fn committing_download_replaces_existing_file_after_success() {
        let directory = std::env::temp_dir().join(format!(
            "termbridge-download-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).expect("create test directory");
        let target = directory.join("report.txt");
        let temporary = directory.join("download.part");
        fs::write(&target, b"old").expect("write old target");
        fs::write(&temporary, b"new").expect("write temporary download");

        commit_download_file(&temporary, &target).expect("commit download");

        assert_eq!(fs::read(&target).expect("read target"), b"new");
        assert!(!temporary.exists());
        fs::remove_dir_all(directory).expect("clean test directory");
    }

    #[test]
    fn does_not_treat_generic_socket_substring_as_connection_error() {
        assert!(!is_connection_error("invalid socket path"));
        assert!(!is_connection_error("socket"));
    }

    #[test]
    fn remote_trash_timestamp_prefers_termbridge_name_metadata() {
        let stat = FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: None,
            atime: None,
            mtime: Some(10),
        };

        assert_eq!(
            remote_trash_created_at(
                Path::new("/tmp/.termbridge/trash/tb-1234-id-report.txt"),
                &stat,
            ),
            Some(1234),
        );
    }

    #[test]
    fn remote_trash_timestamp_uses_mtime_for_legacy_entries() {
        let stat = FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: None,
            atime: None,
            mtime: Some(5678),
        };

        assert_eq!(
            remote_trash_created_at(
                Path::new("/tmp/.termbridge/trash/uuid-report.txt"),
                &stat,
            ),
            Some(5678),
        );
    }

    #[test]
    fn cmp_ascii_case_insensitive_orders_case_insensitively() {
        assert_eq!(cmp_ascii_case_insensitive("abc", "abc"), Ordering::Equal);
        assert_eq!(cmp_ascii_case_insensitive("ABC", "abc"), Ordering::Equal);
        assert_eq!(cmp_ascii_case_insensitive("abc", "abd"), Ordering::Less);
        assert_eq!(cmp_ascii_case_insensitive("abd", "abc"), Ordering::Greater);
        assert_eq!(cmp_ascii_case_insensitive("abc", "abcd"), Ordering::Less);
        assert_eq!(cmp_ascii_case_insensitive("abcd", "abc"), Ordering::Greater);
        assert_eq!(cmp_ascii_case_insensitive("", ""), Ordering::Equal);
        assert_eq!(cmp_ascii_case_insensitive("a", ""), Ordering::Greater);
    }

    #[test]
    fn sort_remote_entries_directories_first_then_case_insensitive() {
        let dir = RemoteFileEntry {
            path: "/d".to_string(),
            name: "Zeta".to_string(),
            kind: RemoteFileKind::Directory,
            size: None,
            modified_at: None,
            permissions: None,
            owner_uid: None,
            group_gid: None,
            owner_name: None,
            group_name: None,
        };
        let file = RemoteFileEntry {
            kind: RemoteFileKind::File,
            name: "alpha".to_string(),
            ..dir.clone()
        };
        assert_eq!(sort_remote_entries(&dir, &file), Ordering::Less);
        assert_eq!(sort_remote_entries(&file, &dir), Ordering::Greater);
        assert_eq!(sort_remote_entries(&file, &file), Ordering::Equal);
    }
}
