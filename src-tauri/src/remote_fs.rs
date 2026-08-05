use crate::connection::{connect_sftp, TransferTimeoutGuard};
use crate::identity_cache::RemoteIdentityCache;
use crate::sftp_pool::SftpPool;
use crate::portable_local_path;
use crate::posix_join;
use crate::models::{
    CopyRemotePathRequest, CopyRemoteToRemoteRequest, CreateRemoteEntryKind, CreateRemoteEntryRequest, DeleteProgressTracker,
    DeleteRemotePathRequest, DownloadProgressTracker, DownloadRemotePathsRequest, DownloadScanStats,
    OpenRemoteFileRequest, ReadRemoteFileRequest, ReadRemoteFileResponse, RemoteConnectionRequest,
    RemoteCopyProgressTracker,
    RemoteCopyScanStats, RemoteDirectoryListing, RemoteDirectoryRequest, RemoteFileEntry,
    RemoteFileKind, RemoteFsError, RenameRemotePathRequest,
    UpdateRemotePermissionsRequest, UploadConflictPolicy, UploadLocalPathsRequest,
    UploadProgressTracker, UploadScanStats,
};
use log::{info, warn};
use ssh2::{FileStat, OpenFlags, OpenType, RenameFlags, Session, Sftp};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs,
    io::{copy, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::{AtomicBool, Ordering as AtomicOrdering}, Arc},
    thread,
    time::{Duration, SystemTime},
};
use tauri::AppHandle;
use uuid::Uuid;

const OPEN_TEMP_RETENTION: Duration = Duration::from_secs(60 * 60 * 24);
const MAX_REMOTE_RECURSION_DEPTH: u32 = 512;
const OPEN_FILE_SIZE_LIMIT: u64 = 200 * 1024 * 1024;
/// Suffix of the temp file remote-to-remote file copies are staged through.
const REMOTE_COPY_TEMP_SUFFIX: &str = ".tb-part";
/// Attempts per file before a remote copy gives up; retries resume from the
/// temp file, so they only re-send what never reached the destination.
const REMOTE_COPY_MAX_ATTEMPTS: u32 = 3;
const REMOTE_COPY_RETRY_BACKOFF_BASE_MS: u64 = 500;

pub(crate) fn is_connection_error(error: &RemoteFsError) -> bool {
    let message = match error {
        RemoteFsError::Other { message } => message.as_str(),
        _ => return false,
    };
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
) -> Result<RemoteDirectoryListing, RemoteFsError> {
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
) -> Result<RemoteDirectoryListing, RemoteFsError> {
    let scope = format!(
        "{}:{}:{}",
        request.connection.host, request.connection.port, request.connection.username
    );
    // Two-phase listing: phase 1 holds the connection lock only for the SFTP
    // walk (readdir + sort); phase 2 resolves uid/gid names and re-locks the
    // connection only when the identity cache misses, so a slow remote exec
    // round-trip does not block transfers sharing this connection.
    let mut listing = {
        let connected = connect_sftp(&request.connection, pool, known_hosts)?;
        let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        list_remote_directory_from_sftp(&connected.sftp, request.path.as_deref())?
    };

    enrich_remote_entry_owners(
        &scope,
        &request.connection,
        pool,
        known_hosts,
        &mut listing.entries,
        cache,
    );

    Ok(listing)
}

pub(crate) fn create_remote_entry_blocking(
    request: CreateRemoteEntryRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), RemoteFsError> {
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
) -> Result<(), RemoteFsError> {
    validate_remote_name(&request.name)?;

    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let parent_path = Path::new(&request.parent_path);
    ensure_remote_directory(&connected.sftp, parent_path)?;

    let target_path = remote_join(parent_path, request.name.trim());
    if remote_path_exists(&connected.sftp, &target_path) {
        return Err(RemoteFsError::Other { message: format!(
            "remote path already exists: {}",
            path_to_string(&target_path)
        ) });
    }

    match request.kind {
        CreateRemoteEntryKind::Directory => connected
            .sftp
            .mkdir(&target_path, 0o755)
            .map_err(|error| RemoteFsError::Other { message: format!("failed to create remote directory: {error}") })?,
        CreateRemoteEntryKind::File => {
            let mut file = connected
                .sftp
                .open_mode(
                    &target_path,
                    OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUSIVE,
                    0o644,
                    OpenType::File,
                )
                .map_err(|error| RemoteFsError::Other { message: format!("failed to create remote file: {error}") })?;
            file.flush()
                .map_err(|error| RemoteFsError::Other { message: format!("failed to finalize remote file creation: {error}") })?;
        }
    }

    Ok(())
}

pub(crate) fn rename_remote_path_blocking(
    request: RenameRemotePathRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), RemoteFsError> {
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
) -> Result<(), RemoteFsError> {
    validate_remote_name(&request.new_name)?;

    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let source_path = Path::new(&request.path);
    let parent_path = source_path
        .parent()
        .ok_or_else(|| RemoteFsError::Other { message: "unable to resolve parent path for rename".to_string() })?;
    let target_path = remote_join(parent_path, request.new_name.trim());

    if source_path == target_path {
        return Ok(());
    }

    if remote_path_exists(&connected.sftp, &target_path) {
        return Err(RemoteFsError::Other { message: format!(
            "rename target already exists: {}",
            path_to_string(&target_path)
        ) });
    }

    connected
        .sftp
        .rename(
            source_path,
            &target_path,
            Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
        )
        .map_err(|error| RemoteFsError::Other { message: format!("failed to rename remote path: {error}") })
}

pub(crate) fn update_remote_permissions_blocking(
    request: UpdateRemotePermissionsRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), RemoteFsError> {
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
) -> Result<(), RemoteFsError> {
    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = std::path::Path::new(&request.path);
    // Only send the permission bits: a full FileStat would make the server
    // apply size/uid/gid/atime/mtime as well (truncate fails on directories
    // and chown/utimes fail for non-owners).
    connected
        .sftp
        .setstat(path, FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(request.permissions),
            atime: None,
            mtime: None,
        })
        .map_err(|error| RemoteFsError::Other { message: format!("failed to update remote permissions: {error}") })
}

pub(crate) fn delete_remote_path_blocking(
    app: AppHandle,
    request: DeleteRemotePathRequest,
    cancel_flag: Arc<AtomicBool>,
    pool: Option<&SftpPool>,
) -> Result<(), RemoteFsError> {
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
) -> Result<(), RemoteFsError> {
    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let target_path = Path::new(&request.path);
    let total_steps = count_remote_delete_steps(&connected.sftp, target_path, &cancel_flag, 0)?;
    let mut progress =
        DeleteProgressTracker::new(app, request.operation_id.clone(), cancel_flag, total_steps);
    progress.emit().map_err(|message| RemoteFsError::Other { message })?;
    progress.ensure_not_cancelled().map_err(|message| RemoteFsError::Other { message })?;
    delete_remote_path_recursive(&connected.sftp, target_path, &mut progress)?;
    progress.set_current_path(None).map_err(|message| RemoteFsError::Other { message })?;
    Ok(())
}

pub(crate) fn copy_remote_path_blocking(
    request: CopyRemotePathRequest,
    cancel_flag: Arc<AtomicBool>,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), RemoteFsError> {
    let connection = request.connection.clone();
    let result = copy_remote_path_inner(request, cancel_flag, pool, known_hosts);
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
    cancel_flag: Arc<AtomicBool>,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), RemoteFsError> {
    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let source_path = Path::new(&request.source_path);
    let destination_directory = Path::new(&request.destination_directory);
    ensure_remote_directory(&connected.sftp, destination_directory)?;

    let source_name = source_path
        .file_name()
        .ok_or_else(|| RemoteFsError::Other { message: "source path has no file name".to_string() })?
        .to_string_lossy()
        .to_string();
    let destination_path =
        unique_remote_destination(&connected.sftp, destination_directory, &source_name)?;

    if destination_path.starts_with(source_path) {
        return Err(RemoteFsError::Other { message: "cannot paste a directory into itself".to_string() });
    }

    let source_stat = connected
        .sftp
        .lstat(source_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to stat remote source: {error}") })?;
    copy_remote_entry_to_path(&connected.sftp, source_path, &destination_path, source_stat, 0, &cancel_flag)
}

pub(crate) fn upload_local_paths_blocking(
    app: AppHandle,
    request: UploadLocalPathsRequest,
    cancel_flag: Arc<AtomicBool>,
    pool: Option<&SftpPool>,
) -> Result<(), RemoteFsError> {
    let connection = request.connection.clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let result = upload_local_paths_inner(app, request, cancel_flag, known_hosts.as_deref());
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
    known_hosts: Option<&Path>,
) -> Result<(), RemoteFsError> {
    if request.local_paths.is_empty() {
        return Err(RemoteFsError::Other { message: "no local files were provided for upload".to_string() });
    }

    // Uploads hold the connection for the whole transfer, so they must not
    // share the pooled connection: passing `pool: None` opens a dedicated
    // connection that is closed on drop, keeping the pooled connection free
    // for other operations on this host while the transfer runs.
    let connected = connect_sftp(&request.connection, None, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _transfer_timeout = TransferTimeoutGuard::new(&connected.session);
    let destination_directory = Path::new(&request.destination_directory);
    ensure_remote_directory(&connected.sftp, destination_directory)?;
    if !request.conflict_policies.is_empty()
        && request.conflict_policies.len() != request.local_paths.len()
    {
        return Err(RemoteFsError::Other { message: "upload conflict policy count does not match local paths".to_string() });
    }

    let mut scan_stats = UploadScanStats::default();
    for local_path in &request.local_paths {
        scan_stats.combine(scan_local_upload_path(Path::new(local_path), &cancel_flag)?);
    }

    let mut progress =
        UploadProgressTracker::new(app, request.operation_id.clone(), cancel_flag, scan_stats);
    progress.emit().map_err(|message| RemoteFsError::Other { message })?;
    let mut existing_names = remote_entry_names(&connected.sftp, destination_directory)?;

    // A failing entry must not abort the rest of the batch: every entry is
    // attempted and the failures are reported together at the end. Explicit
    // cancellation still stops the batch right away.
    let mut failures: Vec<String> = Vec::new();
    let mut cancel_message: Option<String> = None;
    for (index, local_path) in request.local_paths.iter().enumerate() {
        if let Err(message) = progress.ensure_not_cancelled() {
            cancel_message = Some(message);
            break;
        }
        let local_path = Path::new(local_path);
        let conflict_policy = request
            .conflict_policies
            .get(index)
            .copied()
            .unwrap_or(UploadConflictPolicy::Fail);
        if let Err(error) = upload_single_local_path(
            &connected.sftp,
            local_path,
            destination_directory,
            conflict_policy,
            &mut existing_names,
            &mut progress,
        ) {
            failures.push(format!("{}: {error:?}", local_path.display()));
        }
    }

    progress.set_current_path(None).map_err(|message| RemoteFsError::Other { message })?;

    if !failures.is_empty() {
        return Err(RemoteFsError::Other { message: format!(
            "failed to upload {} of {} entries: {}",
            failures.len(),
            request.local_paths.len(),
            failures.join("; ")
        ) });
    }
    if let Some(message) = cancel_message {
        return Err(RemoteFsError::Other { message });
    }

    Ok(())
}

fn upload_single_local_path(
    sftp: &Sftp,
    local_path: &Path,
    destination_directory: &Path,
    conflict_policy: UploadConflictPolicy,
    existing_names: &mut HashSet<String>,
    progress: &mut UploadProgressTracker,
) -> Result<(), RemoteFsError> {
    let file_name = local_path
        .file_name()
        .ok_or_else(|| RemoteFsError::Other { message: format!("invalid local path: {}", local_path.display()) })?
        .to_string_lossy()
        .to_string();
    let destination_name =
        match resolve_upload_target_name(existing_names, &file_name, conflict_policy)? {
            Some(name) => name,
            None => return Ok(()),
        };
    let destination_path = remote_join(destination_directory, &destination_name);

    // Replace policy: remove the existing remote entry first, then upload
    // fresh. A failed or cancelled upload leaves the destination missing or
    // partially written; there is no rollback.
    if conflict_policy == UploadConflictPolicy::Replace
        && remote_path_exists(sftp, &destination_path)
    {
        remove_remote_entry_simple(sftp, &destination_path)?;
    }

    upload_local_entry_to_path(
        sftp,
        local_path,
        &destination_path,
        matches!(
            conflict_policy,
            UploadConflictPolicy::Overwrite | UploadConflictPolicy::Replace
        ),
        progress,
    )?;
    existing_names.insert(destination_name);
    Ok(())
}

pub(crate) fn download_remote_paths_blocking(
    app: AppHandle,
    request: DownloadRemotePathsRequest,
    cancel_flag: Arc<AtomicBool>,
    pool: Option<&SftpPool>,
) -> Result<(), RemoteFsError> {
    let connection = request.connection.clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app).ok();
    let result = download_remote_paths_inner(app, request, cancel_flag, known_hosts.as_deref());
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
    known_hosts: Option<&Path>,
) -> Result<(), RemoteFsError> {
    if request.remote_paths.is_empty() {
        return Err(RemoteFsError::Other { message: "no remote paths were provided for download".to_string() });
    }
    if !request.conflict_policies.is_empty()
        && request.conflict_policies.len() != request.remote_paths.len()
    {
        return Err(RemoteFsError::Other { message: "download conflict policy count does not match remote paths".to_string() });
    }

    // Downloads hold the connection for the whole transfer, so they must not
    // share the pooled connection: passing `pool: None` opens a dedicated
    // connection that is closed on drop, keeping the pooled connection free
    // for other operations on this host while the transfer runs.
    let connected = connect_sftp(&request.connection, None, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _transfer_timeout = TransferTimeoutGuard::new(&connected.session);
    let destination_directory = Path::new(&request.destination_directory);
    fs::create_dir_all(destination_directory)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to create destination directory: {error}") })?;

    // Emit an initial event so the UI shows activity during the scan phase.
    let mut scanning_progress = DownloadProgressTracker::new(
        app.clone(),
        request.operation_id.clone(),
        cancel_flag.clone(),
        DownloadScanStats::default(),
    );
    scanning_progress.set_current_path(Some("scanning...".to_string())).map_err(|message| RemoteFsError::Other { message })?;
    scanning_progress.emit().map_err(|message| RemoteFsError::Other { message })?;

    let mut scan_stats = DownloadScanStats::default();
    for remote_path in &request.remote_paths {
        if cancel_flag.load(AtomicOrdering::SeqCst) {
            return Err(RemoteFsError::Other { message: "download cancelled".to_string() });
        }
        scan_stats.combine(scan_remote_download_path(
            &connected.sftp,
            Path::new(remote_path),
            &cancel_flag,
            0,
        )?);
    }

    let mut progress =
        DownloadProgressTracker::new(app, request.operation_id.clone(), cancel_flag, scan_stats);
    progress.emit().map_err(|message| RemoteFsError::Other { message })?;

    // Reserve names up front so two remote entries sharing a file name (from
    // different parent directories) never overwrite each other's download.
    // Like the upload loop, a failing entry does not abort the rest of the
    // batch; failures are aggregated and reported at the end.
    let mut reserved_names = local_entry_names(destination_directory);
    let mut failures: Vec<String> = Vec::new();
    let mut cancel_message: Option<String> = None;
    for (index, remote_path) in request.remote_paths.iter().enumerate() {
        if let Err(message) = progress.ensure_not_cancelled() {
            cancel_message = Some(message);
            break;
        }
        let remote_path = Path::new(remote_path);
        let download_result = (|| {
            let file_name = remote_path
                .file_name()
                .ok_or_else(|| RemoteFsError::Other { message: format!("invalid remote path: {}", remote_path.display()) })?
                .to_string_lossy()
                .to_string();
            let destination_name =
                match resolve_local_download_name(&reserved_names, &file_name, request.conflict_policies.get(index).copied())? {
                    Some(name) => name,
                    // Skip policy: leave the existing local entry untouched.
                    None => return Ok(()),
                };
            reserved_names.insert(destination_name.clone());
            let destination_path = destination_directory.join(&destination_name);
            // Replace policy: remove the existing local entry first, then
            // download fresh. Overwrite truncates files in place instead.
            if request.conflict_policies.get(index).copied() == Some(UploadConflictPolicy::Replace)
                && destination_path.exists()
            {
                if destination_path.is_dir() {
                    fs::remove_dir_all(&destination_path)
                        .map_err(|error| RemoteFsError::Other { message: format!("failed to replace local directory: {error}") })?;
                } else {
                    fs::remove_file(&destination_path)
                        .map_err(|error| RemoteFsError::Other { message: format!("failed to replace local file: {error}") })?;
                }
            }
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
            Ok::<(), RemoteFsError>(())
        })();
        if let Err(error) = download_result {
            failures.push(format!("{}: {error:?}", remote_path.display()));
        }
    }

    progress.set_current_path(None).map_err(|message| RemoteFsError::Other { message })?;

    if !failures.is_empty() {
        return Err(RemoteFsError::Other { message: format!(
            "failed to download {} of {} entries: {}",
            failures.len(),
            request.remote_paths.len(),
            failures.join("; ")
        ) });
    }
    if let Some(message) = cancel_message {
        return Err(RemoteFsError::Other { message });
    }

    Ok(())
}

fn local_entry_names(directory: &Path) -> HashSet<String> {
    let mut names = HashSet::new();
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            names.insert(entry.file_name().to_string_lossy().to_string());
        }
    }
    names
}

fn unique_local_download_name(
    reserved_names: &HashSet<String>,
    base_name: &str,
) -> Result<String, RemoteFsError> {
    if !reserved_names.contains(base_name) {
        return Ok(base_name.to_string());
    }

    let (stem, extension) = split_name(base_name);
    for index in 1..1000 {
        let suffix = if index == 1 {
            " copy".to_string()
        } else {
            format!(" copy {index}")
        };
        let candidate = match extension.as_deref() {
            Some(extension) => format!("{stem}{suffix}.{extension}"),
            None => format!("{stem}{suffix}"),
        };
        if !reserved_names.contains(&candidate) {
            return Ok(candidate);
        }
    }

    Err(RemoteFsError::Other { message: format!(
        "failed to find an available download name for {base_name}"
    ) })
}

// Mirrors resolve_upload_target_name on the local side. `None` policy keeps
// the historical rename-to-unique behavior used by downloads that never show
// a conflict dialog; an explicit policy honors the user's choice instead.
fn resolve_local_download_name(
    reserved_names: &HashSet<String>,
    base_name: &str,
    policy: Option<UploadConflictPolicy>,
) -> Result<Option<String>, RemoteFsError> {
    match policy {
        None => unique_local_download_name(reserved_names, base_name).map(Some),
        Some(UploadConflictPolicy::Overwrite) | Some(UploadConflictPolicy::Replace) => {
            Ok(Some(base_name.to_string()))
        }
        Some(UploadConflictPolicy::Skip) => {
            if reserved_names.contains(base_name) {
                Ok(None)
            } else {
                Ok(Some(base_name.to_string()))
            }
        }
        Some(UploadConflictPolicy::Fail) => {
            if reserved_names.contains(base_name) {
                Err(RemoteFsError::Other { message: format!("local path already exists: {base_name}") })
            } else {
                Ok(Some(base_name.to_string()))
            }
        }
    }
}

fn scan_remote_download_path(
    sftp: &Sftp,
    remote_path: &Path,
    cancel_flag: &Arc<AtomicBool>,
    depth: u32,
) -> Result<DownloadScanStats, RemoteFsError> {
    if cancel_flag.load(AtomicOrdering::SeqCst) {
        return Err(RemoteFsError::Other { message: "download cancelled".to_string() });
    }
    ensure_remote_recursion_depth(depth)?;

    let stat = sftp
        .lstat(remote_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to inspect remote path: {error}") })?;

    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            let mut stats = DownloadScanStats {
                total_bytes: 0,
                total_steps: 1,
            };
            let entries = sftp
                .readdir(remote_path)
                .map_err(|error| RemoteFsError::Other { message: format!("failed to list remote directory for download: {error}") })?;
            for (child_path, _) in entries {
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                stats.combine(scan_remote_download_path(sftp, &child_path, cancel_flag, depth + 1)?);
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
) -> Result<(), RemoteFsError> {
    progress.ensure_not_cancelled().map_err(|message| RemoteFsError::Other { message })?;
    let stat = sftp
        .lstat(remote_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to inspect remote path: {error}") })?;

    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            progress.set_current_path(Some(path_to_string(remote_path))).map_err(|message| RemoteFsError::Other { message })?;
            fs::create_dir_all(local_path)
                .map_err(|error| RemoteFsError::Other { message: format!("failed to create local directory: {error}") })?;
            progress.finish_step().map_err(|message| RemoteFsError::Other { message })?;
            let entries = sftp
                .readdir(remote_path)
                .map_err(|error| RemoteFsError::Other { message: format!("failed to list remote directory for download: {error}") })?;
            for (child_path, _) in entries {
                progress.ensure_not_cancelled().map_err(|message| RemoteFsError::Other { message })?;
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                let child_name = child_path
                    .file_name()
                    .ok_or_else(|| RemoteFsError::Other { message: "invalid child path while downloading directory".to_string() })?;
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
                Err(error) => {
                    // Symlink might point to a directory or be broken, so it cannot
                    // be downloaded as a file. Keep an empty placeholder so the rest
                    // of the batch can finish, but log the real error instead of
                    // silently pretending the download succeeded.
                    warn!(
                        "failed to download symlink remote_path={}, creating empty placeholder: {error:?}",
                        remote_path.display()
                    );
                    progress.set_current_path(Some(path_to_string(remote_path))).map_err(|message| RemoteFsError::Other { message })?;
                    if let Some(parent) = local_path.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| RemoteFsError::Other { message: format!("failed to create parent directory: {e}") })?;
                    }
                    fs::File::create(local_path)
                        .map_err(|e| RemoteFsError::Other { message: format!("failed to create local file for symlink: {e}") })?;
                    progress.finish_step().map_err(|message| RemoteFsError::Other { message })?;
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
) -> Result<(), RemoteFsError> {
    progress.set_current_path(Some(path_to_string(remote_path))).map_err(|message| RemoteFsError::Other { message })?;
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| RemoteFsError::Other { message: format!("failed to create local parent directory: {error}") })?;
    }

    // Downloads write the destination directly: Replace removed any existing
    // entry up front and Overwrite truncates in place. An interrupted or
    // cancelled download leaves a partial file behind, which is expected.
    let mut remote_file = sftp
        .open(remote_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to open remote file: {error}") })?;
    let mut local_file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(local_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to create local file: {error}") })?;

    let mut buffer = [0u8; 64 * 1024];
    loop {
        progress.ensure_not_cancelled().map_err(|message| RemoteFsError::Other { message })?;
        let read = remote_file
            .read(&mut buffer)
            .map_err(|error| RemoteFsError::Other { message: format!("failed to read remote file: {error}") })?;
        if read == 0 {
            break;
        }
        local_file
            .write_all(&buffer[..read])
            .map_err(|error| RemoteFsError::Other { message: format!("failed to write local file: {error}") })?;
        progress.advance_bytes(read as u64).map_err(|message| RemoteFsError::Other { message })?;
    }
    local_file
        .flush()
        .map_err(|error| RemoteFsError::Other { message: format!("failed to flush local file: {error}") })?;
    progress.finish_step().map_err(|message| RemoteFsError::Other { message })?;
    Ok(())
}

pub(crate) fn copy_remote_to_remote_blocking(
    app: AppHandle,
    request: CopyRemoteToRemoteRequest,
    cancel_flag: Arc<AtomicBool>,
    // Copies run on dedicated connections (pool: None), so the pool is never
    // used here; the parameter is kept for a uniform *_blocking signature.
    _pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), RemoteFsError> {
    if request.source_paths.is_empty() {
        return Err(RemoteFsError::Other { message: "no remote paths were provided".to_string() });
    }
    if !request.conflict_policies.is_empty()
        && request.conflict_policies.len() != request.source_paths.len()
    {
        return Err(RemoteFsError::Other { message: "conflict policy count does not match remote paths".to_string() });
    }

    // Pool keys differ when the same account is expressed with different
    // credentials, so Arc::ptr_eq misses those cases and would skip the
    // copy-into-itself validation. Compare the logical connection target
    // (host, port, username) instead.
    if is_same_connection_target(&request.source_connection, &request.destination_connection) {
        // Same-host copies hold the connection for the whole transfer, so they
        // must not share the pooled connection: passing `pool: None` opens a
        // dedicated connection that is closed on drop, keeping the pooled
        // connection free for other operations while the copy runs. The single
        // connection serves as both source and destination.
        let connected = connect_sftp(&request.source_connection, None, known_hosts)?;
        let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let _transfer_timeout = TransferTimeoutGuard::new(&connected.session);
        return copy_remote_to_remote_with_sftp(
            app,
            request,
            cancel_flag,
            &connected.sftp,
            &connected.sftp,
            true,
        );
    }
    // Cross-host copies hold both connections for the whole transfer, so each
    // side gets a dedicated connection (see above) instead of a pooled one.
    let source = connect_sftp(&request.source_connection, None, known_hosts)?;
    let destination = connect_sftp(&request.destination_connection, None, known_hosts)?;
    // These dedicated connections are created above and never shared, so no
    // other code can hold their locks: no stable ordering is needed to avoid
    // the ABBA deadlock that pooled connections required. Lock source, then
    // destination.
    let source = source.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let destination = destination.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _source_transfer_timeout = TransferTimeoutGuard::new(&source.session);
    let _destination_transfer_timeout = TransferTimeoutGuard::new(&destination.session);
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
    allow_overwrite: bool,
}

fn copy_remote_to_remote_with_sftp(
    app: AppHandle,
    request: CopyRemoteToRemoteRequest,
    cancel_flag: Arc<AtomicBool>,
    source: &Sftp,
    destination: &Sftp,
    same_connection: bool,
) -> Result<(), RemoteFsError> {
    let destination_directory = Path::new(&request.destination_directory);
    ensure_remote_directory(destination, destination_directory)?;

    let mut tasks = Vec::new();
    let mut scan_stats = RemoteCopyScanStats::default();
    for (index, source_path) in request.source_paths.iter().enumerate() {
        if cancel_flag.load(AtomicOrdering::SeqCst) {
            return Err(RemoteFsError::Other { message: "remote copy cancelled".to_string() });
        }
        let source_path = Path::new(source_path);
        let name = source_path
            .file_name()
            .ok_or_else(|| RemoteFsError::Other { message: "remote source path has no file name".to_string() })?;
        let destination_path = remote_join(destination_directory, &name.to_string_lossy());
        let stat = source
            .lstat(source_path)
            .map_err(|error| RemoteFsError::Other { message: format!("failed to inspect remote source: {error}") })?;
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
        let mut allow_overwrite = false;
        if remote_path_exists(destination, &destination_path) {
            match policy {
                UploadConflictPolicy::Skip => continue,
                UploadConflictPolicy::Fail => {
                    return Err(RemoteFsError::Other { message: format!(
                        "remote destination already exists: {}",
                        destination_path.display()
                    ) });
                }
                UploadConflictPolicy::Overwrite => {
                    // Overwrite renames the staged temp file over existing
                    // files and merges into existing directories.
                    allow_overwrite = true;
                }
                UploadConflictPolicy::Replace => {
                    // Replace policy: remove the existing remote entry first,
                    // then copy fresh. A failed or cancelled copy leaves the
                    // destination missing; there is no rollback.
                    remove_remote_entry_simple(destination, &destination_path)?;
                }
            }
        }
        scan_stats.combine(scan_remote_copy_path(source, source_path, &cancel_flag, 0)?);
        tasks.push(RemoteCopyTask {
            source_path: source_path.to_path_buf(),
            destination_path,
            allow_overwrite,
        });
    }

    let mut progress = RemoteCopyProgressTracker::new(
        app,
        request.operation_id,
        cancel_flag,
        scan_stats,
    );
    progress.emit().map_err(|message| RemoteFsError::Other { message })?;

    // Each file task is staged through a temp file and renamed into place on
    // completion (see copy_remote_file_between), so an interrupted copy never
    // leaves a partial file under the real name.
    for task in tasks {
        copy_remote_entry_between(
            source,
            destination,
            &task.source_path,
            &task.destination_path,
            task.allow_overwrite,
            &mut progress,
        )?;
    }

    progress.set_current_path(None).map_err(|message| RemoteFsError::Other { message })?;
    Ok(())
}

fn scan_remote_copy_path(
    source: &Sftp,
    source_path: &Path,
    cancel_flag: &Arc<AtomicBool>,
    depth: u32,
) -> Result<RemoteCopyScanStats, RemoteFsError> {
    if cancel_flag.load(AtomicOrdering::SeqCst) {
        return Err(RemoteFsError::Other { message: "remote copy cancelled".to_string() });
    }
    ensure_remote_recursion_depth(depth)?;
    let stat = source
        .lstat(source_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to inspect remote source: {error}") })?;
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
            .map_err(|error| RemoteFsError::Other { message: format!("failed to list remote source directory: {error}") })?
        {
            if should_skip_remote_child(&child_path) {
                continue;
            }
            stats.combine(scan_remote_copy_path(source, &child_path, cancel_flag, depth + 1)?);
        }
    }
    Ok(stats)
}

fn is_same_connection_target(
    source: &RemoteConnectionRequest,
    destination: &RemoteConnectionRequest,
) -> bool {
    source.host == destination.host
        && source.port == destination.port
        && source.username == destination.username
}

fn validate_same_connection_copy_destination(
    source_path: &Path,
    destination_path: &Path,
    source_is_directory: bool,
) -> Result<(), RemoteFsError> {
    if destination_path == source_path {
        return Err(RemoteFsError::Other { message: "cannot copy a remote entry onto itself".to_string() });
    }
    if source_is_directory && destination_path.starts_with(source_path) {
        return Err(RemoteFsError::Other { message: "cannot copy a directory into itself".to_string() });
    }
    Ok(())
}

fn copy_remote_entry_between(
    source: &Sftp,
    destination: &Sftp,
    source_path: &Path,
    destination_path: &Path,
    allow_overwrite: bool,
    progress: &mut RemoteCopyProgressTracker,
) -> Result<(), RemoteFsError> {
    progress.ensure_not_cancelled().map_err(|message| RemoteFsError::Other { message })?;
    progress.set_current_path(Some(path_to_string(source_path))).map_err(|message| RemoteFsError::Other { message })?;
    let stat = source
        .lstat(source_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to inspect remote source: {error}") })?;
    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            // Overwrite merges into an existing destination directory; only
            // create it when it is missing.
            let destination_is_directory = destination
                .stat(destination_path)
                .map(|destination_stat| {
                    kind_from_permissions(destination_stat.perm) == RemoteFileKind::Directory
                })
                .unwrap_or(false);
            if !(allow_overwrite && destination_is_directory) {
                destination
                    .mkdir(destination_path, stat.perm.unwrap_or(0o755) as i32)
                    .map_err(|error| RemoteFsError::Other { message: format!("failed to create remote copy directory: {error}") })?;
            }
            for (child_path, _) in source
                .readdir(source_path)
                .map_err(|error| RemoteFsError::Other { message: format!("failed to list remote source directory: {error}") })?
            {
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                let child_name = child_path
                    .file_name()
                    .ok_or_else(|| RemoteFsError::Other { message: "remote child path has no file name".to_string() })?;
                copy_remote_entry_between(
                    source,
                    destination,
                    &child_path,
                    &remote_join(destination_path, &child_name.to_string_lossy()),
                    allow_overwrite,
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
                .map_err(|error| RemoteFsError::Other { message: format!("failed to read remote source symlink: {error}") })?;
            if allow_overwrite {
                // symlink() fails when the destination exists; remove any
                // existing entry first. A missing destination makes unlink
                // fail, which is fine to ignore.
                let _ = destination.unlink(destination_path);
            }
            destination
                .symlink(&target, destination_path)
                .map_err(|error| RemoteFsError::Other { message: format!("failed to create remote destination symlink: {error}") })?;
        }
        _ => {
            copy_remote_file_between(
                source,
                destination,
                source_path,
                destination_path,
                &stat,
                allow_overwrite,
                progress,
            )?;
        }
    }
    progress.set_current_path(Some(path_to_string(source_path))).map_err(|message| RemoteFsError::Other { message })?;
    progress.finish_step().map_err(|message| RemoteFsError::Other { message })
}

/// Stages a single file copy through a `<name>.tb-part` temp file that is
/// renamed into place only after every byte is written: an interrupted copy
/// never leaves a partial file under the real name, and a leftover temp file
/// doubles as the resume point for retries and later copies of the same name.
fn copy_remote_file_between(
    source: &Sftp,
    destination: &Sftp,
    source_path: &Path,
    destination_path: &Path,
    source_stat: &FileStat,
    allow_overwrite: bool,
    progress: &mut RemoteCopyProgressTracker,
) -> Result<(), RemoteFsError> {
    let temp_path = remote_copy_temp_path(destination_path);
    let source_size = source_stat.size.unwrap_or(0);
    // Bytes already credited in the progress total for this file, so a resume
    // offset is credited exactly once no matter how many attempts run.
    let mut credited = 0u64;
    let mut attempt = 0u32;
    let result = loop {
        attempt += 1;
        match copy_remote_file_attempt(
            source,
            destination,
            source_path,
            destination_path,
            &temp_path,
            source_size,
            source_stat.perm,
            progress,
            &mut credited,
        ) {
            Ok(()) => break Ok(()),
            Err(error) => {
                if attempt >= REMOTE_COPY_MAX_ATTEMPTS || progress.ensure_not_cancelled().is_err() {
                    break Err(error);
                }
                warn!(
                    "remote copy attempt {attempt}/{REMOTE_COPY_MAX_ATTEMPTS} failed path={}: {error:?}; resuming from temp file",
                    destination_path.display()
                );
                if let Err(message) = sleep_remote_copy_retry_backoff(attempt, progress) {
                    break Err(RemoteFsError::Other { message });
                }
            }
        }
    };
    if let Err(error) = result {
        // Graceful failures and cancellations remove the temp file; only a
        // crash or kill leaves one behind, where its suffix keeps it
        // recognizable and resumable by the next copy of the same name.
        let _ = destination.unlink(&temp_path);
        return Err(error);
    }
    if let Err(error) = destination.setstat(&temp_path, FileStat {
        size: None,
        uid: None,
        gid: None,
        perm: source_stat.perm,
        atime: source_stat.atime,
        mtime: source_stat.mtime,
    }) {
        warn!(
            "failed to preserve remote copy metadata path={}: {error}",
            temp_path.display()
        );
    }
    // rename() without flags asks libssh2 for an atomic overwrite; servers
    // without the posix-rename extension still refuse to clobber an existing
    // destination, so fall back to unlink + rename when overwriting. A failed
    // finalize keeps the temp file so the next copy can resume from it.
    match destination.rename(&temp_path, destination_path, None) {
        Ok(()) => Ok(()),
        Err(first_error) if allow_overwrite => {
            let _ = destination.unlink(destination_path);
            destination
                .rename(&temp_path, destination_path, None)
                .map_err(|error| RemoteFsError::Other { message: format!(
                    "failed to finalize remote copy {}: {error} (after rename error: {first_error})",
                    destination_path.display()
                ) })
        }
        Err(error) => Err(RemoteFsError::Other { message: format!(
            "failed to finalize remote copy {}: {error}",
            destination_path.display()
        ) }),
    }
}

#[allow(clippy::too_many_arguments)]
fn copy_remote_file_attempt(
    source: &Sftp,
    destination: &Sftp,
    source_path: &Path,
    destination_path: &Path,
    temp_path: &Path,
    source_size: u64,
    source_perm: Option<u32>,
    progress: &mut RemoteCopyProgressTracker,
    credited: &mut u64,
) -> Result<(), RemoteFsError> {
    let temp_size = destination
        .stat(temp_path)
        .ok()
        .and_then(|stat| stat.size);
    let resume_offset = match remote_copy_resume(temp_size, source_size) {
        // Larger than the source can never belong to it: discard and restart.
        RemoteCopyResume::Restart => {
            let _ = destination.unlink(temp_path);
            0
        }
        RemoteCopyResume::Fresh => 0,
        RemoteCopyResume::Resume(offset) => offset,
        // A previous attempt wrote every byte but stopped before the rename;
        // skip the transfer and go straight to the finalize step.
        RemoteCopyResume::AlreadyComplete => source_size,
    };
    if resume_offset > *credited {
        progress.advance_bytes(resume_offset - *credited).map_err(|message| RemoteFsError::Other { message })?;
        *credited = resume_offset;
    }
    if source_size > 0 && resume_offset == source_size {
        return Ok(());
    }
    let mut reader = source
        .open(source_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to open remote source: {error}") })?;
    let mut flags = OpenFlags::CREATE | OpenFlags::WRITE;
    if resume_offset == 0 {
        // Fresh attempts truncate the temp file; resumed attempts keep what
        // is already written and continue at the offset.
        flags |= OpenFlags::TRUNCATE;
    }
    let mut writer = destination
        .open_mode(temp_path, flags, source_perm.unwrap_or(0o644) as i32, OpenType::File)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to create remote destination: {error}") })?;
    if resume_offset > 0 {
        reader
            .seek(SeekFrom::Start(resume_offset))
            .map_err(|error| RemoteFsError::Other { message: format!("failed to seek remote source: {error}") })?;
        writer
            .seek(SeekFrom::Start(resume_offset))
            .map_err(|error| RemoteFsError::Other { message: format!("failed to resume remote destination: {error}") })?;
    }
    let mut buffer = [0u8; 64 * 1024];
    loop {
        progress.ensure_not_cancelled().map_err(|message| RemoteFsError::Other { message })?;
        let read = reader
            .read(&mut buffer)
            .map_err(|error| RemoteFsError::Other { message: format!("failed to read remote source: {error}") })?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| RemoteFsError::Other { message: format!(
                "failed to copy between remote hosts ({} at byte {credited}): {error}",
                destination_path.display(),
                credited = *credited
            ) })?;
        progress.advance_bytes(read as u64).map_err(|message| RemoteFsError::Other { message })?;
        *credited += read as u64;
    }
    writer
        .flush()
        .map_err(|error| RemoteFsError::Other { message: format!("failed to flush remote destination: {error}") })
}

/// Backoff between copy attempts, sliced so cancellation stays responsive.
fn sleep_remote_copy_retry_backoff(
    attempt: u32,
    progress: &RemoteCopyProgressTracker,
) -> Result<(), String> {
    let mut remaining = Duration::from_millis(REMOTE_COPY_RETRY_BACKOFF_BASE_MS << (attempt - 1));
    while !remaining.is_zero() {
        progress.ensure_not_cancelled()?;
        let slice = remaining.min(Duration::from_millis(100));
        thread::sleep(slice);
        remaining -= slice;
    }
    Ok(())
}

/// How a copy attempt should treat a temp file left by an earlier run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteCopyResume {
    /// No usable temp file: copy from the start.
    Fresh,
    /// Continue writing at this byte offset.
    Resume(u64),
    /// The temp file already holds the whole source: only the rename is left.
    AlreadyComplete,
    /// The temp file is larger than the source and cannot belong to it.
    Restart,
}

fn remote_copy_resume(temp_size: Option<u64>, source_size: u64) -> RemoteCopyResume {
    match temp_size {
        None | Some(0) => RemoteCopyResume::Fresh,
        Some(size) if size < source_size => RemoteCopyResume::Resume(size),
        Some(size) if size == source_size => RemoteCopyResume::AlreadyComplete,
        Some(_) => RemoteCopyResume::Restart,
    }
}

fn remote_copy_temp_path(destination_path: &Path) -> PathBuf {
    let mut temp_name = destination_path.as_os_str().to_owned();
    temp_name.push(REMOTE_COPY_TEMP_SUFFIX);
    PathBuf::from(temp_name)
}

fn remove_remote_entry_simple(sftp: &Sftp, path: &Path) -> Result<(), RemoteFsError> {
    let stat = sftp
        .lstat(path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to inspect remote destination: {error}") })?;
    if kind_from_permissions(stat.perm) == RemoteFileKind::Directory {
        for (child_path, _) in sftp
            .readdir(path)
            .map_err(|error| RemoteFsError::Other { message: format!("failed to list remote destination: {error}") })?
        {
            if !should_skip_remote_child(&child_path) {
                remove_remote_entry_simple(sftp, &child_path)?;
            }
        }
        sftp.rmdir(path)
            .map_err(|error| RemoteFsError::Other { message: format!("failed to replace remote directory: {error}") })
    } else {
        sftp.unlink(path)
            .map_err(|error| RemoteFsError::Other { message: format!("failed to replace remote file: {error}") })
    }
}

pub(crate) fn open_remote_file_blocking(
    request: OpenRemoteFileRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), RemoteFsError> {
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
) -> Result<(), RemoteFsError> {
    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let remote_path = Path::new(&request.path);
    let stat = connected
        .sftp
        .lstat(remote_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to inspect remote file: {error}") })?;

    if kind_from_permissions(stat.perm) == RemoteFileKind::Directory {
        return Err(RemoteFsError::Other { message: "目录不支持使用默认编辑器打开".to_string() });
    }

    // `sftp.open` follows symlinks, so size-limit the link target rather than
    // the link itself before pulling the whole file into a local temp copy.
    let target_size = connected
        .sftp
        .stat(remote_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to inspect remote file target: {error}") })?
        .size
        .unwrap_or(0);
    if target_size > OPEN_FILE_SIZE_LIMIT {
        return Err(RemoteFsError::Other { message: format!(
            "file too large to open: {} bytes (limit: {} bytes)",
            target_size, OPEN_FILE_SIZE_LIMIT
        ) });
    }

    let file_name = remote_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "remote-file".to_string());

    let open_root = std::env::temp_dir().join("termbridge-open");
    fs::create_dir_all(&open_root)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to create temp directory: {error}") })?;
    cleanup_stale_open_temp_files(&open_root);

    let local_path = open_root.join(format!("{}-{}", Uuid::new_v4(), file_name));
    let mut remote_file = connected
        .sftp
        .open(remote_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to open remote file: {error}") })?;
    let mut local_file = fs::File::create(&local_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to prepare local temp file: {error}") })?;
    copy(&mut remote_file, &mut local_file)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to download remote file: {error}") })?;
    local_file
        .flush()
        .map_err(|error| RemoteFsError::Other { message: format!("failed to finalize temp file: {error}") })?;

    open_path_with_default_app(&local_path)
}

const PREVIEW_SIZE_LIMIT: u64 = 1024 * 1024;

pub(crate) fn read_remote_file_blocking(
    request: ReadRemoteFileRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<ReadRemoteFileResponse, RemoteFsError> {
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
) -> Result<ReadRemoteFileResponse, RemoteFsError> {
    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let remote_path = Path::new(&request.path);

    let stat = connected
        .sftp
        .lstat(remote_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to inspect remote file: {error}") })?;

    if kind_from_permissions(stat.perm) == RemoteFileKind::Directory {
        return Err(RemoteFsError::Other { message: "cannot preview a directory".to_string() });
    }

    let size = stat.size.unwrap_or(0);
    if size > PREVIEW_SIZE_LIMIT {
        return Err(RemoteFsError::Other { message: format!(
            "file too large to preview: {} bytes (limit: {} bytes)",
            size, PREVIEW_SIZE_LIMIT
        ) });
    }

    let file_name = remote_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "remote-file".to_string());

    let remote_file = connected
        .sftp
        .open(remote_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to open remote file: {error}") })?;

    // `sftp.open` follows symlinks while `lstat` above reports the link's own
    // size, so the size check can be bypassed through a link to a large file.
    // Read at most LIMIT + 1 bytes and reject anything beyond the limit.
    let mut buffer = Vec::with_capacity((size.min(PREVIEW_SIZE_LIMIT) + 1) as usize);
    remote_file
        .take(PREVIEW_SIZE_LIMIT + 1)
        .read_to_end(&mut buffer)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to read remote file: {error}") })?;
    if buffer.len() as u64 > PREVIEW_SIZE_LIMIT {
        return Err(RemoteFsError::Other { message: format!(
            "file too large to preview: exceeds limit of {} bytes",
            PREVIEW_SIZE_LIMIT
        ) });
    }

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

// Phase 1 of directory listing: runs entirely under the caller-held
// connection lock and performs only SFTP work (readdir, filter, sort). Owner
// and group names are left unresolved here; see list_remote_directory_inner.
fn list_remote_directory_from_sftp(
    sftp: &Sftp,
    requested_path: Option<&str>,
) -> Result<RemoteDirectoryListing, RemoteFsError> {
    let requested_path = requested_path.unwrap_or(".");
    let resolved_path = sftp
        .realpath(Path::new(requested_path))
        .map_err(|error| RemoteFsError::Other { message: format!("failed to resolve remote path {requested_path}: {error}") })?;

    let mut entries = sftp
        .readdir(&resolved_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to list remote directory: {error}") })?
        .into_iter()
        .map(|(path, stat)| map_remote_file(path, stat))
        .collect::<Vec<_>>();

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

// Phase 2 of directory listing: runs after the phase-1 lock was released.
// Cached names are applied without any locking; only cache misses trigger a
// fresh connect + lock to run the remote identity lookup exec.
fn enrich_remote_entry_owners(
    scope: &str,
    connection: &RemoteConnectionRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
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

    let (mut owner_names, missing_owner_ids) =
        lookup_cached_identity_names(scope, cache, &owner_ids, RemoteIdentityKind::User);
    let (mut group_names, missing_group_ids) =
        lookup_cached_identity_names(scope, cache, &group_ids, RemoteIdentityKind::Group);

    if !missing_owner_ids.is_empty() || !missing_group_ids.is_empty() {
        match connect_sftp(connection, pool, known_hosts) {
            Ok(connected) => {
                let connected = connected.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                resolve_missing_identity_names(
                    scope,
                    &connected.session,
                    cache,
                    &missing_owner_ids,
                    RemoteIdentityKind::User,
                    &mut owner_names,
                );
                resolve_missing_identity_names(
                    scope,
                    &connected.session,
                    cache,
                    &missing_group_ids,
                    RemoteIdentityKind::Group,
                    &mut group_names,
                );
            }
            Err(error) => {
                // Keep the numeric ids when the lookup connection fails, the
                // same fallback as a failed lookup exec.
                warn!("failed to reconnect for remote identity lookup: {error:?}");
            }
        }
    }

    for entry in entries {
        entry.owner_name = entry.owner_uid.and_then(|uid| owner_names.get(&uid).cloned());
        entry.group_name = entry.group_gid.and_then(|gid| group_names.get(&gid).cloned());
    }
}

fn lookup_cached_identity_names(
    scope: &str,
    cache: Option<&RemoteIdentityCache>,
    ids: &HashSet<u32>,
    kind: RemoteIdentityKind,
) -> (HashMap<u32, String>, Vec<u32>) {
    if ids.is_empty() {
        return (HashMap::new(), Vec::new());
    }

    let ids_vec: Vec<u32> = ids.iter().copied().collect();

    if let Some(cache) = cache {
        cache.resolve_names(scope, &ids_vec, kind)
    } else {
        (HashMap::new(), ids_vec)
    }
}

fn resolve_missing_identity_names(
    scope: &str,
    session: &Session,
    cache: Option<&RemoteIdentityCache>,
    missing_ids: &[u32],
    kind: RemoteIdentityKind,
    names: &mut HashMap<u32, String>,
) {
    if missing_ids.is_empty() {
        return;
    }

    match resolve_remote_identity_names(session, missing_ids, kind) {
        Ok(resolved) => {
            if let Some(cache) = cache {
                for (id, name) in &resolved {
                    cache.insert(scope, *id, kind, name.clone());
                }
            }
            names.extend(resolved);
        }
        Err(error) => {
            warn!("failed to resolve remote {:?} names: {:?}", kind, error);
        }
    }
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
) -> Result<HashMap<u32, String>, RemoteFsError> {
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
    // Space-separated: POSIX `for id in ...` splits on IFS (spaces), not commas.
    let ids_text = ids.iter().map(u32::to_string).collect::<Vec<_>>().join(" ");

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

fn run_remote_exec(session: &Session, command: &str) -> Result<String, RemoteFsError> {
    let mut channel = session
        .channel_session()
        .map_err(|error| RemoteFsError::Other { message: format!("failed to open remote exec channel: {error}") })?;
    channel
        .exec(command)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to execute remote lookup command: {error}") })?;

    let mut output = String::new();
    channel
        .read_to_string(&mut output)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to read remote lookup output: {error}") })?;

    let mut stderr = String::new();
    let _ = channel.stderr().read_to_string(&mut stderr);
    channel
        .wait_close()
        .map_err(|error| RemoteFsError::Other { message: format!("failed to close remote lookup channel: {error}") })?;
    let exit_status = channel
        .exit_status()
        .map_err(|error| RemoteFsError::Other { message: format!("failed to read remote lookup exit status: {error}") })?;

    if exit_status != 0 {
        let stderr = stderr.trim();
        let details = if stderr.is_empty() {
            "no stderr output".to_string()
        } else {
            stderr.to_string()
        };
        return Err(RemoteFsError::Other { message: format!(
            "remote lookup command failed with exit status {exit_status}: {details}"
        ) });
    }

    Ok(output)
}

fn validate_remote_name(name: &str) -> Result<(), RemoteFsError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(RemoteFsError::Other { message: "name is required".to_string() });
    }
    if trimmed == "." || trimmed == ".." {
        return Err(RemoteFsError::Other { message: "'.' and '..' are not valid file names".to_string() });
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(RemoteFsError::Other { message: "file name must not include path separators".to_string() });
    }
    Ok(())
}

fn remote_path_exists(sftp: &Sftp, path: &Path) -> bool {
    sftp.lstat(path).is_ok()
}

fn ensure_remote_directory(sftp: &Sftp, path: &Path) -> Result<(), RemoteFsError> {
    let path_string = path_to_string(path);
    if path_string.is_empty() || path == Path::new(".") || path == Path::new("/") {
        return Ok(());
    }

    if let Ok(stat) = sftp.stat(path) {
        match kind_from_permissions(stat.perm) {
            RemoteFileKind::Directory => return Ok(()),
            _ => {
                return Err(RemoteFsError::Other { message: format!(
                    "remote path exists but is not a directory: {}",
                    path_to_string(path)
                ) })
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
            Ok(_) => Err(RemoteFsError::Other { message: format!(
                "remote path exists but is not a directory: {}",
                path_to_string(path)
            ) }),
            Err(_) => Err(RemoteFsError::Other { message: format!("failed to create remote directory: {error}") }),
        },
        Err(error) => Err(RemoteFsError::Other { message: format!("failed to create remote directory: {error}") }),
    }
}

fn ensure_remote_recursion_depth(depth: u32) -> Result<(), RemoteFsError> {
    if depth > MAX_REMOTE_RECURSION_DEPTH {
        return Err(RemoteFsError::Other { message: format!(
            "remote directory nesting exceeds the supported depth of {MAX_REMOTE_RECURSION_DEPTH} levels"
        ) });
    }
    Ok(())
}

fn count_remote_delete_steps(
    sftp: &Sftp,
    path: &Path,
    cancel_flag: &Arc<AtomicBool>,
    depth: u32,
) -> Result<u64, RemoteFsError> {
    if cancel_flag.load(AtomicOrdering::SeqCst) {
        return Err(RemoteFsError::Other { message: "delete cancelled".to_string() });
    }
    ensure_remote_recursion_depth(depth)?;
    let stat = sftp
        .lstat(path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to inspect remote path: {error}") })?;

    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            let entries = sftp
                .readdir(path)
                .map_err(|error| RemoteFsError::Other { message: format!("failed to list remote directory for delete: {error}") })?;
            let mut total_steps = 1;
            for (child_path, _) in entries {
                if cancel_flag.load(AtomicOrdering::SeqCst) {
                    return Err(RemoteFsError::Other { message: "delete cancelled".to_string() });
                }
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                total_steps += count_remote_delete_steps(sftp, &child_path, cancel_flag, depth + 1)?;
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
) -> Result<(), RemoteFsError> {
    progress.ensure_not_cancelled().map_err(|message| RemoteFsError::Other { message })?;
    let stat = sftp
        .lstat(path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to inspect remote path: {error}") })?;

    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            let entries = sftp
                .readdir(path)
                .map_err(|error| RemoteFsError::Other { message: format!("failed to list remote directory for delete: {error}") })?;
            for (child_path, _) in entries {
                progress.ensure_not_cancelled().map_err(|message| RemoteFsError::Other { message })?;
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                delete_remote_path_recursive(sftp, &child_path, progress)?;
            }
            progress.ensure_not_cancelled().map_err(|message| RemoteFsError::Other { message })?;
            progress.set_current_path(Some(path_to_string(path))).map_err(|message| RemoteFsError::Other { message })?;
            sftp.rmdir(path)
                .map_err(|error| RemoteFsError::Other { message: format!("failed to remove remote directory: {error}") })?;
            progress.finish_step().map_err(|message| RemoteFsError::Other { message })
        }
        _ => {
            progress.ensure_not_cancelled().map_err(|message| RemoteFsError::Other { message })?;
            progress.set_current_path(Some(path_to_string(path))).map_err(|message| RemoteFsError::Other { message })?;
            sftp.unlink(path)
                .map_err(|error| RemoteFsError::Other { message: format!("failed to remove remote file: {error}") })?;
            progress.finish_step().map_err(|message| RemoteFsError::Other { message })
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
    depth: u32,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<(), RemoteFsError> {
    ensure_remote_recursion_depth(depth)?;
    match kind_from_permissions(source_stat.perm) {
        RemoteFileKind::Directory => {
            if destination_path.starts_with(source_path) {
                return Err(RemoteFsError::Other { message: "cannot copy a directory into itself".to_string() });
            }

            ensure_remote_directory(sftp, destination_path)?;
            let entries = sftp
                .readdir(source_path)
                .map_err(|error| RemoteFsError::Other { message: format!("failed to read remote directory for copy: {error}") })?;
            for (child_path, child_stat) in entries {
                if cancel_flag.load(AtomicOrdering::SeqCst) {
                    return Err(RemoteFsError::Other { message: "remote copy cancelled".to_string() });
                }
                let child_name = child_path
                    .file_name()
                    .ok_or_else(|| RemoteFsError::Other { message: "invalid child path while copying directory".to_string() })?;
                copy_remote_entry_to_path(
                    sftp,
                    &child_path,
                    &remote_join(destination_path, &child_name.to_string_lossy()),
                    child_stat,
                    depth + 1,
                    cancel_flag,
                )?;
            }
            Ok(())
        }
        RemoteFileKind::Symlink => {
            let target = sftp
                .readlink(source_path)
                .map_err(|error| RemoteFsError::Other { message: format!("failed to read remote symlink: {error}") })?;
            sftp.symlink(&target, destination_path)
                .map_err(|error| RemoteFsError::Other { message: format!("failed to copy remote symlink: {error}") })
        }
        _ => copy_remote_file(sftp, source_path, destination_path, source_stat.size, cancel_flag),
    }
}

fn copy_remote_file(
    sftp: &Sftp,
    source_path: &Path,
    destination_path: &Path,
    expected_size: Option<u64>,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<(), RemoteFsError> {
    if let Some(parent) = destination_path.parent() {
        ensure_remote_directory(sftp, parent)?;
    }

    // The destination name was reserved by unique_remote_destination, so the
    // exclusive create never overwrites an existing entry. An interrupted copy
    // leaves a partial file behind, which is expected.
    let mut source = sftp
        .open(source_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to open remote source file: {error}") })?;
    let mut destination = sftp
        .open_mode(
            destination_path,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE | OpenFlags::EXCLUSIVE,
            0o644,
            OpenType::File,
        )
        .map_err(|error| RemoteFsError::Other { message: format!("failed to create remote copy: {error}") })?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancel_flag.load(AtomicOrdering::SeqCst) {
            return Err(RemoteFsError::Other { message: "remote copy cancelled".to_string() });
        }
        let read = source
            .read(&mut buffer)
            .map_err(|error| RemoteFsError::Other { message: format!("failed to read remote source file: {error}") })?;
        if read == 0 {
            break;
        }
        destination
            .write_all(&buffer[..read])
            .map_err(|error| RemoteFsError::Other { message: format!("failed to copy remote file data: {error}") })?;
    }
    destination
        .flush()
        .map_err(|error| RemoteFsError::Other { message: format!("failed to flush remote copy: {error}") })?;
    drop(destination);

    if let Some(expected_size) = expected_size {
        let copied_size = sftp
            .stat(destination_path)
            .map_err(|error| RemoteFsError::Other { message: format!("failed to verify remote copy: {error}") })?
            .size
            .ok_or_else(|| RemoteFsError::Other { message: "remote server did not report copied file size".to_string() })?;
        if copied_size != expected_size {
            return Err(RemoteFsError::Other { message: format!(
                "remote copy size mismatch: expected {expected_size} bytes, got {copied_size}"
            ) });
        }
    }

    Ok(())
}

fn remote_entry_names(
    sftp: &Sftp,
    destination_directory: &Path,
) -> Result<HashSet<String>, RemoteFsError> {
    let entries = sftp
        .readdir(destination_directory)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to inspect remote upload destination: {error}") })?;
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
) -> Result<Option<String>, RemoteFsError> {
    if !existing_names.contains(base_name) {
        return Ok(Some(base_name.to_string()));
    }

    match policy {
        UploadConflictPolicy::Overwrite | UploadConflictPolicy::Replace => {
            Ok(Some(base_name.to_string()))
        }
        UploadConflictPolicy::Skip => Ok(None),
        UploadConflictPolicy::Fail => Err(RemoteFsError::Other { message: format!("remote path already exists: {base_name}") }),
    }
}

fn unique_remote_destination(
    sftp: &Sftp,
    destination_directory: &Path,
    base_name: &str,
) -> Result<PathBuf, RemoteFsError> {
    let candidate = remote_join(destination_directory, base_name);
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
        let candidate = remote_join(destination_directory, &candidate_name);
        if !remote_path_exists(sftp, &candidate) {
            return Ok(candidate);
        }
    }

    Err(RemoteFsError::Other { message: format!(
        "failed to find an available destination name for {base_name}"
    ) })
}

fn split_name(name: &str) -> (String, Option<String>) {
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => {
            (stem.to_string(), Some(extension.to_string()))
        }
        _ => (name.to_string(), None),
    }
}

fn scan_local_upload_path(
    local_path: &Path,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<UploadScanStats, RemoteFsError> {
    if cancel_flag.load(AtomicOrdering::SeqCst) {
        return Err(RemoteFsError::Other { message: "upload cancelled".to_string() });
    }

    let metadata = fs::symlink_metadata(local_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to read local path metadata: {error}") })?;

    if metadata.file_type().is_symlink() {
        return Err(RemoteFsError::Other { message: format!(
            "symlink upload is not supported: {}",
            local_path.display()
        ) });
    }

    if metadata.is_dir() {
        let mut stats = UploadScanStats {
            total_bytes: 0,
            total_steps: 1,
        };
        let entries = fs::read_dir(local_path)
            .map_err(|error| RemoteFsError::Other { message: format!("failed to read local directory: {error}") })?;
        for entry in entries {
            if cancel_flag.load(AtomicOrdering::SeqCst) {
                return Err(RemoteFsError::Other { message: "upload cancelled".to_string() });
            }
            let entry =
                entry.map_err(|error| RemoteFsError::Other { message: format!("failed to read local directory entry: {error}") })?;
            stats.combine(scan_local_upload_path(&entry.path(), cancel_flag)?);
        }
        return Ok(stats);
    }

    if metadata.is_file() {
        return Ok(UploadScanStats {
            total_bytes: metadata.len(),
            total_steps: 1,
        });
    }

    Err(RemoteFsError::Other { message: format!(
        "unsupported local path type for upload: {}",
        local_path.display()
    ) })
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
) -> Result<(), RemoteFsError> {
    progress.ensure_not_cancelled().map_err(|message| RemoteFsError::Other { message })?;
    let metadata = fs::symlink_metadata(local_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to read local path metadata: {error}") })?;

    if metadata.file_type().is_symlink() {
        return Err(RemoteFsError::Other { message: format!(
            "symlink upload is not supported: {}",
            local_path.display()
        ) });
    }

    if metadata.is_dir() {
        progress.set_current_path(Some(path_to_string(local_path))).map_err(|message| RemoteFsError::Other { message })?;
        ensure_remote_directory(sftp, remote_path)?;
        progress.finish_step().map_err(|message| RemoteFsError::Other { message })?;
        let entries = fs::read_dir(local_path)
            .map_err(|error| RemoteFsError::Other { message: format!("failed to read local directory: {error}") })?;
        for entry in entries {
            let entry =
                entry.map_err(|error| RemoteFsError::Other { message: format!("failed to read local directory entry: {error}") })?;
            upload_local_entry_to_path(
                sftp,
                &entry.path(),
                &remote_join(remote_path, &entry.file_name().to_string_lossy()),
                allow_overwrite,
                progress,
            )?;
        }
        return Ok(());
    }

    if metadata.is_file() {
        progress.set_current_path(Some(path_to_string(local_path))).map_err(|message| RemoteFsError::Other { message })?;
        if let Some(parent) = remote_path.parent() {
            ensure_remote_directory(sftp, parent)?;
        }
        let upload_mode = if is_private_key_file(remote_path) {
            0o600
        } else {
            0o644
        };
        upload_regular_file(
            sftp,
            local_path,
            remote_path,
            metadata.len(),
            upload_mode,
            allow_overwrite,
            progress,
        )?;
        progress.finish_step().map_err(|message| RemoteFsError::Other { message })?;
        return Ok(());
    }

    Err(RemoteFsError::Other { message: format!(
        "unsupported local path type for upload: {}",
        local_path.display()
    ) })
}

fn upload_regular_file(
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &Path,
    expected_size: u64,
    upload_mode: i32,
    allow_overwrite: bool,
    progress: &mut UploadProgressTracker,
) -> Result<(), RemoteFsError> {
    // Uploads write the destination directly: Overwrite truncates in place and
    // Replace removed any existing entry up front. An interrupted or cancelled
    // upload leaves a partial file behind, which is expected. Without an
    // overwrite policy the exclusive create keeps a racing entry safe.
    let mut flags = OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE;
    if !allow_overwrite {
        flags |= OpenFlags::EXCLUSIVE;
    }
    let mut local_file = fs::File::open(local_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to open local file: {error}") })?;
    let mut remote_file = sftp
        .open_mode(remote_path, flags, upload_mode, OpenType::File)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to create remote upload file: {error}") })?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        progress.ensure_not_cancelled().map_err(|message| RemoteFsError::Other { message })?;
        let read = local_file
            .read(&mut buffer)
            .map_err(|error| RemoteFsError::Other { message: format!("failed to read local file for upload: {error}") })?;
        if read == 0 {
            break;
        }
        remote_file
            .write_all(&buffer[..read])
            .map_err(|error| RemoteFsError::Other { message: format!("failed to upload local file: {error}") })?;
        progress.advance_bytes(read as u64).map_err(|message| RemoteFsError::Other { message })?;
    }
    remote_file
        .flush()
        .map_err(|error| RemoteFsError::Other { message: format!("failed to flush remote upload: {error}") })?;
    drop(remote_file);

    let uploaded_size = sftp
        .stat(remote_path)
        .map_err(|error| RemoteFsError::Other { message: format!("failed to verify remote upload: {error}") })?
        .size
        .ok_or_else(|| RemoteFsError::Other { message: "remote server did not report uploaded file size".to_string() })?;
    if uploaded_size != expected_size {
        return Err(RemoteFsError::Other { message: format!(
            "remote upload size mismatch: expected {expected_size} bytes, got {uploaded_size}"
        ) });
    }

    Ok(())
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

// Remote paths are POSIX regardless of the host platform: `Path::join` would
// use `\` on Windows and corrupt paths sent to the SFTP server, so remote path
// segments are always joined through posix_join instead.
fn remote_join(parent: &Path, child: &str) -> PathBuf {
    PathBuf::from(posix_join(&path_to_string(parent), child))
}

fn open_path_with_default_app(path: &Path) -> Result<(), RemoteFsError> {
    // The path is passed as a plain argument (no shell involved), so file names
    // containing characters like `(`, `)`, `%`, `&` are safe to open.
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
        .map_err(|error| RemoteFsError::Other { message: format!("failed to open file with default app: {error}") })?;
    Ok(())
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
            Err(RemoteFsError::Other { message: "cannot copy a remote entry onto itself".to_string() })
        );
    }

    #[test]
    fn same_connection_copy_rejects_directory_descendant() {
        let result = validate_same_connection_copy_destination(
            Path::new("/srv/assets"),
            Path::new("/srv/assets/archive/assets"),
            true,
        );

        assert_eq!(result, Err(RemoteFsError::Other { message: "cannot copy a directory into itself".to_string() }));
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
    fn remote_copy_temp_path_appends_suffix_to_full_name() {
        assert_eq!(
            remote_copy_temp_path(Path::new("/srv/report.txt")),
            PathBuf::from("/srv/report.txt.tb-part")
        );
        assert_eq!(
            remote_copy_temp_path(Path::new("/srv/archive")),
            PathBuf::from("/srv/archive.tb-part")
        );
    }

    #[test]
    fn remote_copy_resume_starts_fresh_without_usable_temp_file() {
        assert_eq!(remote_copy_resume(None, 100), RemoteCopyResume::Fresh);
        assert_eq!(remote_copy_resume(Some(0), 100), RemoteCopyResume::Fresh);
        assert_eq!(remote_copy_resume(None, 0), RemoteCopyResume::Fresh);
    }

    #[test]
    fn remote_copy_resume_continues_from_partial_temp_file() {
        assert_eq!(remote_copy_resume(Some(40), 100), RemoteCopyResume::Resume(40));
    }

    #[test]
    fn remote_copy_resume_skips_transfer_when_temp_file_is_complete() {
        assert_eq!(remote_copy_resume(Some(100), 100), RemoteCopyResume::AlreadyComplete);
    }

    #[test]
    fn remote_copy_resume_restarts_when_temp_file_exceeds_source() {
        assert_eq!(remote_copy_resume(Some(140), 100), RemoteCopyResume::Restart);
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

        assert!(
            matches!(error, RemoteFsError::Other { ref message } if message.contains("report.txt")),
            "expected error to mention the conflicting file name, got {error:?}"
        );
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
    fn termbridge_directory_name_is_not_reserved() {
        // `.termbridge` used to be reserved for application data; it is an
        // ordinary name now that nothing is staged on the server.
        assert!(validate_remote_name(".termbridge").is_ok());
        assert!(validate_remote_name("reports").is_ok());
    }

    #[test]
    fn download_name_overwrites_existing_entry_when_requested() {
        let reserved_names = HashSet::from([String::from("report.txt")]);

        let resolved = resolve_local_download_name(
            &reserved_names,
            "report.txt",
            Some(UploadConflictPolicy::Overwrite),
        )
        .expect("overwrite policy should allow replacing the existing target");

        assert_eq!(resolved, Some(String::from("report.txt")));
    }

    #[test]
    fn download_name_skips_existing_entry_when_requested() {
        let reserved_names = HashSet::from([String::from("report.txt")]);

        let resolved = resolve_local_download_name(
            &reserved_names,
            "report.txt",
            Some(UploadConflictPolicy::Skip),
        )
        .expect("skip policy should be treated as a valid decision");

        assert_eq!(resolved, None);
    }

    #[test]
    fn download_name_rejects_existing_entry_without_explicit_resolution() {
        let reserved_names = HashSet::from([String::from("report.txt")]);

        let error = resolve_local_download_name(
            &reserved_names,
            "report.txt",
            Some(UploadConflictPolicy::Fail),
        )
        .expect_err("fail policy should reject the conflicting download target");

        assert!(
            matches!(error, RemoteFsError::Other { ref message } if message.contains("report.txt")),
            "expected error to mention the conflicting file name, got {error:?}"
        );
    }

    #[test]
    fn download_name_renames_to_unique_without_policy() {
        let reserved_names = HashSet::from([String::from("report.txt")]);

        let resolved = resolve_local_download_name(&reserved_names, "report.txt", None)
            .expect("downloads without a policy should keep the rename-to-unique behavior");

        assert_eq!(resolved, Some(String::from("report copy.txt")));
    }

    #[test]
    fn download_name_allows_new_entry_without_conflict() {
        let reserved_names = HashSet::<String>::new();

        let resolved = resolve_local_download_name(
            &reserved_names,
            "report.txt",
            Some(UploadConflictPolicy::Fail),
        )
        .expect("new names should download without additional confirmation");

        assert_eq!(resolved, Some(String::from("report.txt")));
    }

    #[test]
    fn detects_transport_disconnected_as_connection_error() {
        assert!(is_connection_error(&RemoteFsError::Other { message: "SSH transport disconnected".to_string() }));
    }

    #[test]
    fn detects_transport_read_as_connection_error() {
        assert!(is_connection_error(&RemoteFsError::Other { message: "transport read error".to_string() }));
    }

    #[test]
    fn detects_connection_reset_as_connection_error() {
        assert!(is_connection_error(&RemoteFsError::Other { message: "connection reset by peer".to_string() }));
    }

    #[test]
    fn detects_broken_pipe_as_connection_error() {
        assert!(is_connection_error(&RemoteFsError::Other { message: "broken pipe".to_string() }));
    }

    #[test]
    fn ignores_unrelated_errors() {
        assert!(!is_connection_error(&RemoteFsError::Other { message: "file not found".to_string() }));
        assert!(!is_connection_error(&RemoteFsError::Other { message: "permission denied".to_string() }));
    }

    #[test]
    fn detects_specific_socket_phrases_as_connection_error() {
        assert!(is_connection_error(&RemoteFsError::Other { message: "socket error".to_string() }));
        assert!(is_connection_error(&RemoteFsError::Other { message: "failed reading from socket".to_string() }));
        assert!(is_connection_error(&RemoteFsError::Other { message: "socket closed".to_string() }));
        assert!(is_connection_error(&RemoteFsError::Other { message: "socket disconnect".to_string() }));
        assert!(is_connection_error(&RemoteFsError::Other { message: "socket disconnected".to_string() }));
    }

    #[test]
    fn detects_libssh2_transport_messages_as_connection_errors() {
        assert!(is_connection_error(&RemoteFsError::Other { message: "[Session(-7)] socket send failure".to_string() }));
        assert!(is_connection_error(&RemoteFsError::Other { message: "[Session(-43)] error receiving on socket".to_string() }));
        assert!(is_connection_error(&RemoteFsError::Other { message: "[SFTP(7)] no connection".to_string() }));
        assert!(is_connection_error(&RemoteFsError::Other { message: "[SFTP(8)] connection lost".to_string() }));
        assert!(is_connection_error(&RemoteFsError::Other { message: "[Session(-9)] timed out".to_string() }));
    }

    #[test]
    fn does_not_treat_generic_socket_substring_as_connection_error() {
        assert!(!is_connection_error(&RemoteFsError::Other { message: "invalid socket path".to_string() }));
        assert!(!is_connection_error(&RemoteFsError::Other { message: "socket".to_string() }));
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

    #[test]
    fn unique_local_download_name_keeps_free_base_name() {
        let reserved = HashSet::from([String::from("other.txt")]);

        let resolved = unique_local_download_name(&reserved, "report.txt")
            .expect("free name should be usable as-is");

        assert_eq!(resolved, "report.txt");
    }

    #[test]
    fn unique_local_download_name_suffixes_conflicting_names() {
        let reserved = HashSet::from([
            String::from("report.txt"),
            String::from("report copy.txt"),
        ]);

        let resolved = unique_local_download_name(&reserved, "report.txt")
            .expect("a unique variant should be found");

        assert_eq!(resolved, "report copy 2.txt");
    }

    #[test]
    fn unique_local_download_name_handles_dotfiles_without_extension_split() {
        let reserved = HashSet::from([String::from(".gitignore")]);

        let resolved = unique_local_download_name(&reserved, ".gitignore")
            .expect("a unique variant should be found");

        assert_eq!(resolved, ".gitignore copy");
    }

    #[test]
    fn recursion_depth_within_limit_is_accepted() {
        assert!(ensure_remote_recursion_depth(0).is_ok());
        assert!(ensure_remote_recursion_depth(MAX_REMOTE_RECURSION_DEPTH).is_ok());
    }

    #[test]
    fn recursion_depth_beyond_limit_is_rejected() {
        let error = ensure_remote_recursion_depth(MAX_REMOTE_RECURSION_DEPTH + 1)
            .expect_err("nesting past the limit should fail");

        assert!(
            matches!(error, RemoteFsError::Other { ref message } if message.contains("depth")),
            "expected error to mention the depth limit, got {error:?}"
        );
    }

    fn connection_request(host: &str, port: u16, username: &str) -> RemoteConnectionRequest {
        RemoteConnectionRequest {
            host: host.to_string(),
            port,
            username: username.to_string(),
            auth_method: crate::models::AuthMethod::Password,
            password: None,
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        }
    }

    #[test]
    fn same_connection_target_matches_host_port_username() {
        let source = connection_request("example.com", 22, "alice");
        let destination = connection_request("example.com", 22, "alice");

        assert!(is_same_connection_target(&source, &destination));
    }

    #[test]
    fn same_connection_target_rejects_different_account() {
        let source = connection_request("example.com", 22, "alice");

        assert!(!is_same_connection_target(&source, &connection_request("example.com", 22, "bob")));
        assert!(!is_same_connection_target(&source, &connection_request("example.com", 2222, "alice")));
        assert!(!is_same_connection_target(&source, &connection_request("other.example.com", 22, "alice")));
    }

    #[test]
    fn local_upload_scan_honours_cancellation() {
        let directory = std::env::temp_dir().join(format!(
            "termbridge-scan-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).expect("create test directory");
        let cancel_flag = Arc::new(AtomicBool::new(true));

        let error = scan_local_upload_path(&directory, &cancel_flag)
            .expect_err("cancelled scan should fail");

        assert!(
            matches!(error, RemoteFsError::Other { ref message } if message.contains("cancelled")),
            "expected a cancellation error, got {error:?}"
        );
        fs::remove_dir_all(directory).expect("clean test directory");
    }
}
