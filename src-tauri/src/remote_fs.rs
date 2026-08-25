use crate::connection::{connect_sftp, TransferTimeoutGuard};
use crate::identity_cache::RemoteIdentityCache;
use crate::models::{
    CopyRemotePathRequest, CopyRemoteToRemoteRequest, CreateRemoteEntryKind,
    CreateRemoteEntryRequest, DeleteProgressTracker, DeleteRemotePathRequest,
    DownloadProgressTracker, DownloadRemotePathsRequest, DownloadScanStats, OpenRemoteFileRequest,
    ReadRemoteFileRequest, ReadRemoteFileResponse, RemoteConnectionRequest,
    RemoteCopyProgressTracker, RemoteCopyScanStats, RemoteDirectoryListing, RemoteDirectoryRequest,
    RemoteEntryOwners, RemoteEntryOwnersRequest, RemoteFileEntry, RemoteFileKind, RemoteFsError,
    RenameRemotePathRequest, TransferBatchResult, TransferEventEmitter, TransferItemResult,
    TransferItemStatus, UpdateRemotePermissionsRequest, UploadConflictPolicy,
    UploadLocalPathsRequest, UploadProgressTracker, UploadScanStats,
};
use crate::portable_local_path;
use crate::posix_join;
use crate::sftp_pool::SftpPool;
use base64::Engine;
use log::{info, warn};
use ssh2::{FileStat, OpenFlags, OpenType, RenameFlags, Session, Sftp};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs,
    io::{copy, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};
use tauri::AppHandle;
use uuid::Uuid;

#[cfg(test)]
static TEST_TRANSFER_METRIC_RECORDS: std::sync::Mutex<Vec<String>> =
    std::sync::Mutex::new(Vec::new());

const OPEN_TEMP_RETENTION: Duration = Duration::from_secs(60 * 60 * 24);
const MAX_REMOTE_RECURSION_DEPTH: u32 = 512;
const OPEN_FILE_SIZE_LIMIT: u64 = 200 * 1024 * 1024;
/// Suffix of the temp file remote-to-remote file copies are staged through.
const REMOTE_COPY_TEMP_SUFFIX: &str = ".tb-part";
/// Attempts per file before a remote copy gives up; retries resume from the
/// temp file, so they only re-send what never reached the destination.
const REMOTE_COPY_MAX_ATTEMPTS: u32 = 3;
const REMOTE_COPY_RETRY_BACKOFF_BASE_MS: u64 = 500;

#[derive(Clone, Copy)]
enum TransferPhase {
    Connect,
    Scan,
    Transfer,
    Finalize,
}

struct TransferBatchMetrics {
    operation: &'static str,
    operation_id: String,
    started_at: Instant,
    phase_started_at: Instant,
    current_phase: Option<TransferPhase>,
    connect: Duration,
    scan: Duration,
    transfer: Duration,
    finalize: Duration,
    total_bytes: u64,
    total_files: u64,
    logged: bool,
}

impl TransferBatchMetrics {
    fn new(operation: &'static str, operation_id: String) -> Self {
        let now = Instant::now();
        Self {
            operation,
            operation_id,
            started_at: now,
            phase_started_at: now,
            current_phase: Some(TransferPhase::Connect),
            connect: Duration::ZERO,
            scan: Duration::ZERO,
            transfer: Duration::ZERO,
            finalize: Duration::ZERO,
            total_bytes: 0,
            total_files: 0,
            logged: false,
        }
    }

    fn start_phase(&mut self, phase: TransferPhase) {
        self.finish_current_phase();
        self.current_phase = Some(phase);
        self.phase_started_at = Instant::now();
    }

    fn set_inventory(&mut self, total_bytes: u64, total_files: u64) {
        self.total_bytes = total_bytes;
        self.total_files = total_files;
    }

    fn finish(&mut self, status: &'static str) {
        self.finish_current_phase();
        self.log(status);
        self.logged = true;
    }

    fn finish_current_phase(&mut self) {
        let Some(phase) = self.current_phase.take() else {
            return;
        };
        let elapsed = self.phase_started_at.elapsed();
        match phase {
            TransferPhase::Connect => self.connect += elapsed,
            TransferPhase::Scan => self.scan += elapsed,
            TransferPhase::Transfer => self.transfer += elapsed,
            TransferPhase::Finalize => self.finalize += elapsed,
        }
    }

    fn log(&self, status: &'static str) {
        let record = self.record(status);
        info!("{record}");
        #[cfg(test)]
        TEST_TRANSFER_METRIC_RECORDS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(record);
    }

    fn record(&self, status: &'static str) -> String {
        let total = self.started_at.elapsed();
        let throughput_bytes_per_second = throughput_bytes_per_second(self.total_bytes, total);
        format!(
            "sftp_transfer_metrics operation={} operation_id={:?} status={} connect_us={} scan_us={} transfer_us={} finalize_us={} total_us={} total_bytes={} file_count={} throughput_bytes_per_second={}",
            self.operation,
            self.operation_id,
            status,
            self.connect.as_micros(),
            self.scan.as_micros(),
            self.transfer.as_micros(),
            self.finalize.as_micros(),
            total.as_micros(),
            self.total_bytes,
            self.total_files,
            throughput_bytes_per_second,
        )
    }
}

impl Drop for TransferBatchMetrics {
    fn drop(&mut self) {
        if !self.logged {
            self.finish_current_phase();
            self.log("failed");
        }
    }
}

fn throughput_bytes_per_second(total_bytes: u64, elapsed: Duration) -> u64 {
    let elapsed_nanos = elapsed.as_nanos();
    if total_bytes == 0 || elapsed_nanos == 0 {
        return 0;
    }
    ((u128::from(total_bytes) * 1_000_000_000) / elapsed_nanos).min(u128::from(u64::MAX)) as u64
}

fn transfer_batch_status(batch: &TransferBatchResult) -> &'static str {
    let failed = batch
        .items
        .iter()
        .filter(|item| item.status == TransferItemStatus::Failed)
        .count();
    if failed == 0 {
        "completed"
    } else if failed == batch.items.len() {
        "failed"
    } else {
        "partial"
    }
}

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

pub(crate) fn transfer_batch_has_connection_error(batch: &TransferBatchResult) -> bool {
    batch.items.iter().any(|item| {
        item.status == TransferItemStatus::Failed
            && item.error.as_ref().is_some_and(|message| {
                is_connection_error(&RemoteFsError::Other {
                    message: message.clone(),
                })
            })
    })
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
    let scope = remote_identity_scope(&request.connection);
    // Listing stays on the SFTP fast path: owner/group names are applied only
    // from the identity cache (no remote exec here). The frontend lazily calls
    // resolve_remote_entry_owners for the ids that miss.
    let mut listing = {
        let connected = connect_sftp(&request.connection, pool, known_hosts)?;
        let connected = connected
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        list_remote_directory_from_sftp(&connected.sftp, request.path.as_deref())?
    };
    apply_cached_entry_owner_names(&scope, cache, &mut listing.entries);

    Ok(listing)
}

// Applies cached uid/gid names to listing entries without any remote exec;
// entries whose ids are not cached keep `None` and the UI falls back to the
// numeric id until resolve_remote_entry_owners fills them in.
fn apply_cached_entry_owner_names(
    scope: &str,
    cache: Option<&RemoteIdentityCache>,
    entries: &mut [RemoteFileEntry],
) {
    let Some(cache) = cache else {
        return;
    };
    let owner_ids = entries
        .iter()
        .filter_map(|entry| entry.owner_uid)
        .collect::<HashSet<_>>();
    let group_ids = entries
        .iter()
        .filter_map(|entry| entry.group_gid)
        .collect::<HashSet<_>>();
    let (owner_names, _) =
        lookup_cached_identity_names(scope, Some(cache), &owner_ids, RemoteIdentityKind::User);
    let (group_names, _) =
        lookup_cached_identity_names(scope, Some(cache), &group_ids, RemoteIdentityKind::Group);
    for entry in entries.iter_mut() {
        entry.owner_name = entry
            .owner_uid
            .and_then(|uid| owner_names.get(&uid).cloned());
        entry.group_name = entry
            .group_gid
            .and_then(|gid| group_names.get(&gid).cloned());
    }
}

// Lazy owner/group name resolution: the frontend calls this after rendering a
// listing so the readdir result is never delayed by the remote lookup exec.
pub(crate) fn resolve_remote_entry_owners_blocking(
    request: RemoteEntryOwnersRequest,
    pool: Option<&SftpPool>,
    cache: Option<&RemoteIdentityCache>,
    known_hosts: Option<&Path>,
) -> Result<RemoteEntryOwners, RemoteFsError> {
    let scope = remote_identity_scope(&request.connection);
    let owner_ids = request.owner_ids.iter().copied().collect::<HashSet<_>>();
    let group_ids = request.group_ids.iter().copied().collect::<HashSet<_>>();

    let (mut owner_names, missing_owner_ids) =
        lookup_cached_identity_names(scope.as_str(), cache, &owner_ids, RemoteIdentityKind::User);
    let (mut group_names, missing_group_ids) =
        lookup_cached_identity_names(scope.as_str(), cache, &group_ids, RemoteIdentityKind::Group);

    if !missing_owner_ids.is_empty() || !missing_group_ids.is_empty() {
        let connection = request.connection.clone();
        let result = connect_sftp(&request.connection, pool, known_hosts);
        match result {
            Ok(connected) => {
                let connected = connected
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                resolve_missing_identity_names(
                    &scope,
                    &connected.session,
                    cache,
                    &missing_owner_ids,
                    &missing_group_ids,
                    &mut owner_names,
                    &mut group_names,
                );
            }
            Err(error) => {
                if let Some(pool) = pool {
                    if is_connection_error(&error) {
                        pool.invalidate(&connection);
                    }
                }
                // Keep the numeric ids when the lookup connection fails, the
                // same fallback as a failed lookup exec.
                warn!("failed to reconnect for remote identity lookup: {error:?}");
            }
        }
    }

    Ok(RemoteEntryOwners {
        owner_names,
        group_names,
    })
}

fn remote_identity_scope(connection: &RemoteConnectionRequest) -> String {
    let mut scope = format!(
        "{}:{}:{}",
        connection.host, connection.port, connection.username
    );
    if let Some(jump) = &connection.jump_host {
        scope.push_str(&format!(
            "|jump={}:{}:{}",
            jump.host, jump.port, jump.username
        ));
    }
    scope
}

// Establishes (or health-checks) the pooled SFTP connection so the first
// directory listing does not pay the full connect cost.
pub(crate) fn warm_remote_connection_blocking(
    connection: RemoteConnectionRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), RemoteFsError> {
    connect_sftp(&connection, pool, known_hosts)?;
    Ok(())
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
    let connected = connected
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let parent_path = Path::new(&request.parent_path);
    ensure_remote_directory(&connected.sftp, parent_path)?;

    let target_path = remote_join(parent_path, request.name.trim());
    if remote_path_exists(&connected.sftp, &target_path) {
        return Err(RemoteFsError::Other {
            message: format!(
                "remote path already exists: {}",
                path_to_string(&target_path)
            ),
        });
    }

    match request.kind {
        CreateRemoteEntryKind::Directory => {
            connected
                .sftp
                .mkdir(&target_path, 0o755)
                .map_err(|error| RemoteFsError::Other {
                    message: format!("failed to create remote directory: {error}"),
                })?
        }
        CreateRemoteEntryKind::File => {
            let mut file = connected
                .sftp
                .open_mode(
                    &target_path,
                    OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUSIVE,
                    0o644,
                    OpenType::File,
                )
                .map_err(|error| RemoteFsError::Other {
                    message: format!("failed to create remote file: {error}"),
                })?;
            file.flush().map_err(|error| RemoteFsError::Other {
                message: format!("failed to finalize remote file creation: {error}"),
            })?;
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
    let connected = connected
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let source_path = Path::new(&request.path);
    let parent_path = source_path.parent().ok_or_else(|| RemoteFsError::Other {
        message: "unable to resolve parent path for rename".to_string(),
    })?;
    let target_path = remote_join(parent_path, request.new_name.trim());

    if source_path == target_path {
        return Ok(());
    }

    if remote_path_exists(&connected.sftp, &target_path) {
        return Err(RemoteFsError::Other {
            message: format!(
                "rename target already exists: {}",
                path_to_string(&target_path)
            ),
        });
    }

    connected
        .sftp
        .rename(
            source_path,
            &target_path,
            Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
        )
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to rename remote path: {error}"),
        })
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
    let connected = connected
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = std::path::Path::new(&request.path);
    // Only send the permission bits: a full FileStat would make the server
    // apply size/uid/gid/atime/mtime as well (truncate fails on directories
    // and chown/utimes fail for non-owners).
    connected
        .sftp
        .setstat(
            path,
            FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: Some(request.permissions),
                atime: None,
                mtime: None,
            },
        )
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to update remote permissions: {error}"),
        })
}

pub(crate) fn delete_remote_path_blocking(
    app: AppHandle,
    request: DeleteRemotePathRequest,
    cancel_flag: Arc<AtomicBool>,
    pool: Option<&SftpPool>,
) -> Result<(), RemoteFsError> {
    let connection = request.connection.clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app)
        .map_err(|message| RemoteFsError::Other { message })?;
    let result = delete_remote_path_inner(app, request, cancel_flag, Some(&known_hosts));
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
    known_hosts: Option<&Path>,
) -> Result<(), RemoteFsError> {
    // Deletes hold the connection for the whole (potentially long) recursive
    // walk, so they must not share the pooled connection: passing `pool: None`
    // opens a dedicated connection that is closed on drop, keeping the pooled
    // connection free for other operations on this host while the delete runs.
    // All paths in the batch are deleted over this one connection.
    let connected = connect_sftp(&request.connection, None, known_hosts)?;
    let connected = connected
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // A recursive delete can stall on a slow or large directory for much
    // longer than the 15s session timeout, so the transfer timeout guard
    // (120s per socket read) applies here just as it does to uploads/copies.
    let _transfer_timeout = TransferTimeoutGuard::new(&connected.session);
    // The tree is deleted in a single pass without a pre-count walk; the total
    // grows rsync-style as entries are discovered, so progress reports
    // "removed N of M discovered so far".
    let mut progress =
        DeleteProgressTracker::new(app, request.operation_id.clone(), cancel_flag, 0);
    progress
        .emit()
        .map_err(|message| RemoteFsError::Other { message })?;
    for path in &request.paths {
        progress
            .ensure_not_cancelled()
            .map_err(|message| RemoteFsError::Other { message })?;
        delete_remote_path_recursive(&connected.sftp, Path::new(path), &mut progress, 0)?;
    }
    progress
        .set_current_path(None)
        .map_err(|message| RemoteFsError::Other { message })?;
    Ok(())
}

pub(crate) fn copy_remote_path_blocking(
    request: CopyRemotePathRequest,
    cancel_flag: Arc<AtomicBool>,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), RemoteFsError> {
    let connection = request.connection.clone();
    let result = copy_remote_path_inner(request, cancel_flag, known_hosts);
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
    known_hosts: Option<&Path>,
) -> Result<(), RemoteFsError> {
    let mut metrics = TransferBatchMetrics::new("remote_copy", request.operation_id.clone());
    // Same-host copies hold the connection for the whole (potentially long)
    // recursive walk, so they must not share the pooled connection: passing
    // `pool: None` opens a dedicated connection that is closed on drop, keeping
    // the pooled connection free for other operations on this host while the
    // copy runs.
    let connected = connect_sftp(&request.connection, None, known_hosts)?;
    let connected = connected
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    metrics.start_phase(TransferPhase::Scan);
    let source_path = Path::new(&request.source_path);
    let destination_directory = Path::new(&request.destination_directory);
    ensure_remote_directory(&connected.sftp, destination_directory)?;

    let source_name = source_path
        .file_name()
        .ok_or_else(|| RemoteFsError::Other {
            message: "source path has no file name".to_string(),
        })?
        .to_string_lossy()
        .to_string();
    let destination_path =
        unique_remote_destination(&connected.sftp, destination_directory, &source_name)?;

    if destination_path.starts_with(source_path) {
        return Err(RemoteFsError::Other {
            message: "cannot paste a directory into itself".to_string(),
        });
    }

    let source_stat = connected
        .sftp
        .lstat(source_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to stat remote source: {error}"),
        })?;
    let mut scan_stats = RemoteCopyScanStats::default();
    metrics.start_phase(TransferPhase::Transfer);
    let result = copy_remote_entry_to_path(
        &connected.sftp,
        source_path,
        &destination_path,
        source_stat,
        0,
        &cancel_flag,
        &mut scan_stats,
    );
    metrics.set_inventory(scan_stats.total_bytes, scan_stats.total_files);
    result?;
    metrics.start_phase(TransferPhase::Finalize);
    metrics.finish("completed");
    Ok(())
}

pub(crate) fn upload_local_paths_blocking(
    app: AppHandle,
    request: UploadLocalPathsRequest,
    cancel_flag: Arc<AtomicBool>,
    pool: Option<&SftpPool>,
) -> Result<TransferBatchResult, RemoteFsError> {
    let connection = request.connection.clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app)
        .map_err(|message| RemoteFsError::Other { message })?;
    let result = upload_local_paths_inner(app, request, cancel_flag, Some(&known_hosts));
    if let Some(pool) = pool {
        match &result {
            Err(error) if is_connection_error(error) => pool.invalidate(&connection),
            Ok(batch) if transfer_batch_has_connection_error(batch) => pool.invalidate(&connection),
            _ => {}
        }
    }
    result
}

fn upload_local_paths_inner<E: TransferEventEmitter>(
    emitter: E,
    request: UploadLocalPathsRequest,
    cancel_flag: Arc<AtomicBool>,
    known_hosts: Option<&Path>,
) -> Result<TransferBatchResult, RemoteFsError> {
    if request.local_paths.is_empty() {
        return Err(RemoteFsError::Other {
            message: "no local files were provided for upload".to_string(),
        });
    }

    let mut metrics = TransferBatchMetrics::new("upload", request.operation_id.clone());

    // Uploads hold the connection for the whole transfer, so they must not
    // share the pooled connection: passing `pool: None` opens a dedicated
    // connection that is closed on drop, keeping the pooled connection free
    // for other operations on this host while the transfer runs.
    let connected = connect_sftp(&request.connection, None, known_hosts)?;
    let connected = connected
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _transfer_timeout = TransferTimeoutGuard::new(&connected.session);
    metrics.start_phase(TransferPhase::Scan);
    let destination_directory = Path::new(&request.destination_directory);
    ensure_remote_directory(&connected.sftp, destination_directory)?;
    if !request.conflict_policies.is_empty()
        && request.conflict_policies.len() != request.local_paths.len()
    {
        return Err(RemoteFsError::Other {
            message: "upload conflict policy count does not match local paths".to_string(),
        });
    }

    let mut scan_stats = UploadScanStats::default();
    for local_path in &request.local_paths {
        scan_stats.combine(scan_local_upload_path(Path::new(local_path), &cancel_flag)?);
    }

    let mut progress = UploadProgressTracker::new(
        emitter,
        request.operation_id.clone(),
        cancel_flag,
        scan_stats,
    );
    progress
        .emit()
        .map_err(|message| RemoteFsError::Other { message })?;
    let mut existing_names = remote_entry_names(&connected.sftp, destination_directory)?;
    metrics.set_inventory(scan_stats.total_bytes, scan_stats.total_files);
    metrics.start_phase(TransferPhase::Transfer);

    // A failing entry must not abort the rest of the batch: every entry is
    // attempted and the failures are reported together at the end. Explicit
    // cancellation still stops the batch right away.
    let mut items: Vec<TransferItemResult> = Vec::new();
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
        let source_path = path_to_string(local_path);
        match upload_single_local_path(
            &connected.sftp,
            local_path,
            destination_directory,
            conflict_policy,
            &mut existing_names,
            &mut progress,
        ) {
            Ok(Some(destination_path)) => items.push(TransferItemResult {
                source_path,
                destination_path: Some(path_to_string(&destination_path)),
                status: TransferItemStatus::Completed,
                error: None,
            }),
            Ok(None) => items.push(TransferItemResult {
                source_path,
                destination_path: None,
                status: TransferItemStatus::Skipped,
                error: None,
            }),
            Err(error) => items.push(TransferItemResult {
                source_path,
                destination_path: None,
                status: TransferItemStatus::Failed,
                error: Some(format!("{error:?}")),
            }),
        }
    }

    metrics.start_phase(TransferPhase::Finalize);
    progress
        .set_current_path(None)
        .map_err(|message| RemoteFsError::Other { message })?;

    if let Some(message) = cancel_message {
        return Err(RemoteFsError::Other { message });
    }

    let batch = TransferBatchResult { items };
    metrics.finish(transfer_batch_status(&batch));
    Ok(batch)
}

fn upload_single_local_path<E: TransferEventEmitter>(
    sftp: &Sftp,
    local_path: &Path,
    destination_directory: &Path,
    conflict_policy: UploadConflictPolicy,
    existing_names: &mut HashSet<String>,
    progress: &mut UploadProgressTracker<E>,
) -> Result<Option<PathBuf>, RemoteFsError> {
    let file_name = local_path
        .file_name()
        .ok_or_else(|| RemoteFsError::Other {
            message: format!("invalid local path: {}", local_path.display()),
        })?
        .to_string_lossy()
        .to_string();
    let destination_name =
        match resolve_upload_target_name(existing_names, &file_name, conflict_policy)? {
            Some(name) => name,
            None => return Ok(None),
        };
    let destination_path = remote_join(destination_directory, &destination_name);

    // Replacing a directory still needs to clear the previous tree before
    // recursively creating the new one. File uploads keep the old target in
    // place until the staged file has been written and verified.
    if conflict_policy == UploadConflictPolicy::Replace
        && remote_path_exists(sftp, &destination_path)
        && fs::symlink_metadata(local_path)
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false)
    {
        remove_remote_entry_simple(sftp, &destination_path)?;
    }

    upload_local_entry_to_path(
        sftp,
        local_path,
        &destination_path,
        conflict_policy,
        progress,
    )?;
    existing_names.insert(destination_name);
    Ok(Some(destination_path))
}

pub(crate) fn download_remote_paths_blocking(
    app: AppHandle,
    request: DownloadRemotePathsRequest,
    cancel_flag: Arc<AtomicBool>,
    pool: Option<&SftpPool>,
) -> Result<TransferBatchResult, RemoteFsError> {
    let connection = request.connection.clone();
    let known_hosts = crate::known_hosts::known_hosts_path(&app)
        .map_err(|message| RemoteFsError::Other { message })?;
    let result = download_remote_paths_inner(app, request, cancel_flag, Some(&known_hosts));
    if let Some(pool) = pool {
        match &result {
            Err(error) if is_connection_error(error) => pool.invalidate(&connection),
            Ok(batch) if transfer_batch_has_connection_error(batch) => pool.invalidate(&connection),
            _ => {}
        }
    }
    result
}

fn download_remote_paths_inner<E: TransferEventEmitter>(
    emitter: E,
    request: DownloadRemotePathsRequest,
    cancel_flag: Arc<AtomicBool>,
    known_hosts: Option<&Path>,
) -> Result<TransferBatchResult, RemoteFsError> {
    if request.remote_paths.is_empty() {
        return Err(RemoteFsError::Other {
            message: "no remote paths were provided for download".to_string(),
        });
    }
    if !request.conflict_policies.is_empty()
        && request.conflict_policies.len() != request.remote_paths.len()
    {
        return Err(RemoteFsError::Other {
            message: "download conflict policy count does not match remote paths".to_string(),
        });
    }

    let mut metrics = TransferBatchMetrics::new("download", request.operation_id.clone());

    // Downloads hold the connection for the whole transfer, so they must not
    // share the pooled connection: passing `pool: None` opens a dedicated
    // connection that is closed on drop, keeping the pooled connection free
    // for other operations on this host while the transfer runs.
    let connected = connect_sftp(&request.connection, None, known_hosts)?;
    let connected = connected
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _transfer_timeout = TransferTimeoutGuard::new(&connected.session);
    metrics.start_phase(TransferPhase::Scan);
    let destination_directory = Path::new(&request.destination_directory);
    fs::create_dir_all(destination_directory).map_err(|error| RemoteFsError::Other {
        message: format!("failed to create destination directory: {error}"),
    })?;

    // Emit an initial event so the UI shows activity during the scan phase.
    let mut scanning_progress = DownloadProgressTracker::new(
        emitter.clone(),
        request.operation_id.clone(),
        cancel_flag.clone(),
        DownloadScanStats::default(),
    );
    scanning_progress
        .set_current_path(Some("scanning...".to_string()))
        .map_err(|message| RemoteFsError::Other { message })?;
    scanning_progress
        .emit()
        .map_err(|message| RemoteFsError::Other { message })?;

    let mut scan_stats = DownloadScanStats::default();
    for remote_path in &request.remote_paths {
        if cancel_flag.load(AtomicOrdering::SeqCst) {
            return Err(RemoteFsError::Other {
                message: "download cancelled".to_string(),
            });
        }
        scan_stats.combine(scan_remote_download_path(
            &connected.sftp,
            Path::new(remote_path),
            &cancel_flag,
            0,
        )?);
    }

    let mut progress = DownloadProgressTracker::new(
        emitter,
        request.operation_id.clone(),
        cancel_flag,
        scan_stats,
    );
    progress
        .emit()
        .map_err(|message| RemoteFsError::Other { message })?;

    // Reserve names up front so two remote entries sharing a file name (from
    // different parent directories) never overwrite each other's download.
    // Like the upload loop, a failing entry does not abort the rest of the
    // batch; failures are aggregated and reported at the end.
    let mut reserved_names = local_entry_names(destination_directory);
    metrics.set_inventory(scan_stats.total_bytes, scan_stats.total_files);
    metrics.start_phase(TransferPhase::Transfer);
    let mut items: Vec<TransferItemResult> = Vec::new();
    let mut cancel_message: Option<String> = None;
    for (index, remote_path) in request.remote_paths.iter().enumerate() {
        if let Err(message) = progress.ensure_not_cancelled() {
            cancel_message = Some(message);
            break;
        }
        let remote_path = Path::new(remote_path);
        let source_path = path_to_string(remote_path);
        let download_result = (|| {
            let file_name = remote_path
                .file_name()
                .ok_or_else(|| RemoteFsError::Other {
                    message: format!("invalid remote path: {}", remote_path.display()),
                })?
                .to_string_lossy()
                .to_string();
            let destination_name = match resolve_local_download_name(
                &reserved_names,
                &file_name,
                request.conflict_policies.get(index).copied(),
            )? {
                Some(name) => name,
                // Skip policy: leave the existing local entry untouched.
                None => return Ok(None),
            };
            reserved_names.insert(destination_name.clone());
            let destination_path = destination_directory.join(&destination_name);
            // Replace policy: remove the existing local entry first, then
            // download fresh. Overwrite truncates files in place instead.
            if request.conflict_policies.get(index).copied() == Some(UploadConflictPolicy::Replace)
                && destination_path.exists()
            {
                if destination_path.is_dir() {
                    fs::remove_dir_all(&destination_path).map_err(|error| {
                        RemoteFsError::Other {
                            message: format!("failed to replace local directory: {error}"),
                        }
                    })?;
                } else {
                    fs::remove_file(&destination_path).map_err(|error| RemoteFsError::Other {
                        message: format!("failed to replace local file: {error}"),
                    })?;
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
            Ok::<Option<PathBuf>, RemoteFsError>(Some(destination_path))
        })();
        match download_result {
            Ok(Some(destination_path)) => items.push(TransferItemResult {
                source_path,
                destination_path: Some(path_to_string(&destination_path)),
                status: TransferItemStatus::Completed,
                error: None,
            }),
            Ok(None) => items.push(TransferItemResult {
                source_path,
                destination_path: None,
                status: TransferItemStatus::Skipped,
                error: None,
            }),
            Err(error) => items.push(TransferItemResult {
                source_path,
                destination_path: None,
                status: TransferItemStatus::Failed,
                error: Some(format!("{error:?}")),
            }),
        }
    }

    metrics.start_phase(TransferPhase::Finalize);
    progress
        .set_current_path(None)
        .map_err(|message| RemoteFsError::Other { message })?;

    if let Some(message) = cancel_message {
        return Err(RemoteFsError::Other { message });
    }

    let batch = TransferBatchResult { items };
    metrics.finish(transfer_batch_status(&batch));
    Ok(batch)
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

    Err(RemoteFsError::Other {
        message: format!("failed to find an available download name for {base_name}"),
    })
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
                Err(RemoteFsError::Other {
                    message: format!("local path already exists: {base_name}"),
                })
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
        return Err(RemoteFsError::Other {
            message: "download cancelled".to_string(),
        });
    }
    ensure_remote_recursion_depth(depth)?;

    let stat = sftp
        .lstat(remote_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to inspect remote path: {error}"),
        })?;

    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            let mut stats = DownloadScanStats {
                total_bytes: 0,
                total_steps: 1,
                total_files: 0,
            };
            let entries = sftp
                .readdir(remote_path)
                .map_err(|error| RemoteFsError::Other {
                    message: format!("failed to list remote directory for download: {error}"),
                })?;
            for (child_path, _) in entries {
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                stats.combine(scan_remote_download_path(
                    sftp,
                    &child_path,
                    cancel_flag,
                    depth + 1,
                )?);
            }
            Ok(stats)
        }
        RemoteFileKind::Symlink => {
            // Do not recursively follow symlinks to avoid infinite loops.
            // Treat a symlink as a single file step; sftp.open follows it during download.
            Ok(DownloadScanStats {
                total_bytes: 0,
                total_steps: 1,
                total_files: 1,
            })
        }
        _ => Ok(DownloadScanStats {
            total_bytes: stat.size.unwrap_or(0),
            total_steps: 1,
            total_files: 1,
        }),
    }
}

fn download_remote_entry_to_path<E: TransferEventEmitter>(
    sftp: &Sftp,
    remote_path: &Path,
    local_path: &Path,
    progress: &mut DownloadProgressTracker<E>,
) -> Result<(), RemoteFsError> {
    progress
        .ensure_not_cancelled()
        .map_err(|message| RemoteFsError::Other { message })?;
    let stat = sftp
        .lstat(remote_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to inspect remote path: {error}"),
        })?;

    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            progress
                .set_current_path(Some(path_to_string(remote_path)))
                .map_err(|message| RemoteFsError::Other { message })?;
            fs::create_dir_all(local_path).map_err(|error| RemoteFsError::Other {
                message: format!("failed to create local directory: {error}"),
            })?;
            progress
                .finish_step()
                .map_err(|message| RemoteFsError::Other { message })?;
            let entries = sftp
                .readdir(remote_path)
                .map_err(|error| RemoteFsError::Other {
                    message: format!("failed to list remote directory for download: {error}"),
                })?;
            for (child_path, _) in entries {
                progress
                    .ensure_not_cancelled()
                    .map_err(|message| RemoteFsError::Other { message })?;
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                let child_name = child_path.file_name().ok_or_else(|| RemoteFsError::Other {
                    message: "invalid child path while downloading directory".to_string(),
                })?;
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
                    progress
                        .set_current_path(Some(path_to_string(remote_path)))
                        .map_err(|message| RemoteFsError::Other { message })?;
                    if let Some(parent) = local_path.parent() {
                        fs::create_dir_all(parent).map_err(|e| RemoteFsError::Other {
                            message: format!("failed to create parent directory: {e}"),
                        })?;
                    }
                    fs::File::create(local_path).map_err(|e| RemoteFsError::Other {
                        message: format!("failed to create local file for symlink: {e}"),
                    })?;
                    progress
                        .finish_step()
                        .map_err(|message| RemoteFsError::Other { message })?;
                    Ok(())
                }
            }
        }
        _ => download_remote_file(sftp, remote_path, local_path, progress),
    }
}

fn download_remote_file<E: TransferEventEmitter>(
    sftp: &Sftp,
    remote_path: &Path,
    local_path: &Path,
    progress: &mut DownloadProgressTracker<E>,
) -> Result<(), RemoteFsError> {
    progress
        .set_current_path(Some(path_to_string(remote_path)))
        .map_err(|message| RemoteFsError::Other { message })?;
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent).map_err(|error| RemoteFsError::Other {
            message: format!("failed to create local parent directory: {error}"),
        })?;
    }

    // Downloads write the destination directly: Replace removed any existing
    // entry up front and Overwrite truncates in place. An interrupted or
    // cancelled download leaves a partial file behind, which is expected.
    let mut remote_file = sftp
        .open(remote_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to open remote file: {error}"),
        })?;
    let mut local_file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(local_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to create local file: {error}"),
        })?;

    let mut buffer = [0u8; 64 * 1024];
    loop {
        progress
            .ensure_not_cancelled()
            .map_err(|message| RemoteFsError::Other { message })?;
        let read = remote_file
            .read(&mut buffer)
            .map_err(|error| RemoteFsError::Other {
                message: format!("failed to read remote file: {error}"),
            })?;
        if read == 0 {
            break;
        }
        local_file
            .write_all(&buffer[..read])
            .map_err(|error| RemoteFsError::Other {
                message: format!("failed to write local file: {error}"),
            })?;
        progress
            .advance_bytes(read as u64)
            .map_err(|message| RemoteFsError::Other { message })?;
    }
    local_file.flush().map_err(|error| RemoteFsError::Other {
        message: format!("failed to flush local file: {error}"),
    })?;
    progress
        .finish_step()
        .map_err(|message| RemoteFsError::Other { message })?;
    Ok(())
}

pub(crate) fn copy_remote_to_remote_blocking<E: TransferEventEmitter>(
    emitter: E,
    request: CopyRemoteToRemoteRequest,
    cancel_flag: Arc<AtomicBool>,
    // Copies run on dedicated connections (pool: None), so the pool is never
    // used here; the parameter is kept for a uniform *_blocking signature.
    _pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
) -> Result<(), RemoteFsError> {
    if request.source_paths.is_empty() {
        return Err(RemoteFsError::Other {
            message: "no remote paths were provided".to_string(),
        });
    }
    if !request.conflict_policies.is_empty()
        && request.conflict_policies.len() != request.source_paths.len()
    {
        return Err(RemoteFsError::Other {
            message: "conflict policy count does not match remote paths".to_string(),
        });
    }

    let mut metrics = TransferBatchMetrics::new("remote_copy", request.operation_id.clone());

    // Pool keys differ when the same account is expressed with different
    // credentials, so Arc::ptr_eq misses those cases and would skip the
    // copy-into-itself validation. Compare the logical connection target
    // (host, port, username) instead.
    let result =
        if is_same_connection_target(&request.source_connection, &request.destination_connection) {
            // Same-host copies hold the connection for the whole transfer, so they
            // must not share the pooled connection: passing `pool: None` opens a
            // dedicated connection that is closed on drop, keeping the pooled
            // connection free for other operations while the copy runs. The single
            // connection serves as both source and destination.
            let connected = connect_sftp(&request.source_connection, None, known_hosts)?;
            let connected = connected
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _transfer_timeout = TransferTimeoutGuard::new(&connected.session);
            metrics.start_phase(TransferPhase::Scan);
            copy_remote_to_remote_with_sftp(
                emitter,
                request,
                cancel_flag,
                &connected.sftp,
                &connected.sftp,
                true,
                &mut metrics,
            )
        } else {
            // Cross-host copies hold both connections for the whole transfer, so each
            // side gets a dedicated connection (see above) instead of a pooled one.
            let source = connect_sftp(&request.source_connection, None, known_hosts)?;
            let destination = connect_sftp(&request.destination_connection, None, known_hosts)?;
            // These dedicated connections are created above and never shared, so no
            // other code can hold their locks: no stable ordering is needed to avoid
            // the ABBA deadlock that pooled connections required. Lock source, then
            // destination.
            let source = source
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let destination = destination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _source_transfer_timeout = TransferTimeoutGuard::new(&source.session);
            let _destination_transfer_timeout = TransferTimeoutGuard::new(&destination.session);
            metrics.start_phase(TransferPhase::Scan);
            copy_remote_to_remote_with_sftp(
                emitter,
                request,
                cancel_flag,
                &source.sftp,
                &destination.sftp,
                false,
                &mut metrics,
            )
        };
    metrics.finish(if result.is_ok() {
        "completed"
    } else {
        "failed"
    });
    result
}

struct RemoteCopyTask {
    source_path: PathBuf,
    destination_path: PathBuf,
    allow_overwrite: bool,
}

fn copy_remote_to_remote_with_sftp<E: TransferEventEmitter>(
    emitter: E,
    request: CopyRemoteToRemoteRequest,
    cancel_flag: Arc<AtomicBool>,
    source: &Sftp,
    destination: &Sftp,
    same_connection: bool,
    metrics: &mut TransferBatchMetrics,
) -> Result<(), RemoteFsError> {
    let destination_directory = Path::new(&request.destination_directory);
    ensure_remote_directory(destination, destination_directory)?;

    let mut tasks = Vec::new();
    let mut scan_stats = RemoteCopyScanStats::default();
    for (index, source_path) in request.source_paths.iter().enumerate() {
        if cancel_flag.load(AtomicOrdering::SeqCst) {
            return Err(RemoteFsError::Other {
                message: "remote copy cancelled".to_string(),
            });
        }
        let source_path = Path::new(source_path);
        let name = source_path
            .file_name()
            .ok_or_else(|| RemoteFsError::Other {
                message: "remote source path has no file name".to_string(),
            })?;
        let destination_path = remote_join(destination_directory, &name.to_string_lossy());
        let stat = source
            .lstat(source_path)
            .map_err(|error| RemoteFsError::Other {
                message: format!("failed to inspect remote source: {error}"),
            })?;
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
                    return Err(RemoteFsError::Other {
                        message: format!(
                            "remote destination already exists: {}",
                            destination_path.display()
                        ),
                    });
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

    metrics.set_inventory(scan_stats.total_bytes, scan_stats.total_files);
    metrics.start_phase(TransferPhase::Transfer);

    let mut progress =
        RemoteCopyProgressTracker::new(emitter, request.operation_id, cancel_flag, scan_stats);
    progress
        .emit()
        .map_err(|message| RemoteFsError::Other { message })?;

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

    metrics.start_phase(TransferPhase::Finalize);
    progress
        .set_current_path(None)
        .map_err(|message| RemoteFsError::Other { message })?;
    Ok(())
}

fn scan_remote_copy_path(
    source: &Sftp,
    source_path: &Path,
    cancel_flag: &Arc<AtomicBool>,
    depth: u32,
) -> Result<RemoteCopyScanStats, RemoteFsError> {
    if cancel_flag.load(AtomicOrdering::SeqCst) {
        return Err(RemoteFsError::Other {
            message: "remote copy cancelled".to_string(),
        });
    }
    ensure_remote_recursion_depth(depth)?;
    let stat = source
        .lstat(source_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to inspect remote source: {error}"),
        })?;
    let kind = kind_from_permissions(stat.perm);
    let mut stats = RemoteCopyScanStats {
        total_bytes: if kind == RemoteFileKind::File {
            stat.size.unwrap_or(0)
        } else {
            0
        },
        total_steps: 1,
        total_files: u64::from(kind != RemoteFileKind::Directory),
    };
    if kind == RemoteFileKind::Directory {
        for (child_path, _) in
            source
                .readdir(source_path)
                .map_err(|error| RemoteFsError::Other {
                    message: format!("failed to list remote source directory: {error}"),
                })?
        {
            if should_skip_remote_child(&child_path) {
                continue;
            }
            stats.combine(scan_remote_copy_path(
                source,
                &child_path,
                cancel_flag,
                depth + 1,
            )?);
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
        && ConnectionRouteKey::from(source) == ConnectionRouteKey::from(destination)
}

#[derive(Debug, PartialEq, Eq)]
struct ConnectionRouteKey<'a> {
    jump_host: Option<JumpRouteKey<'a>>,
}

#[derive(Debug, PartialEq, Eq)]
struct JumpRouteKey<'a> {
    host: &'a str,
    port: u16,
    username: &'a str,
}

impl<'a> From<&'a RemoteConnectionRequest> for ConnectionRouteKey<'a> {
    fn from(request: &'a RemoteConnectionRequest) -> Self {
        Self {
            jump_host: request.jump_host.as_ref().map(|jump| JumpRouteKey {
                host: jump.host.as_str(),
                port: jump.port,
                username: jump.username.as_str(),
            }),
        }
    }
}

fn validate_same_connection_copy_destination(
    source_path: &Path,
    destination_path: &Path,
    source_is_directory: bool,
) -> Result<(), RemoteFsError> {
    if destination_path == source_path {
        return Err(RemoteFsError::Other {
            message: "cannot copy a remote entry onto itself".to_string(),
        });
    }
    if source_is_directory && destination_path.starts_with(source_path) {
        return Err(RemoteFsError::Other {
            message: "cannot copy a directory into itself".to_string(),
        });
    }
    Ok(())
}

fn copy_remote_entry_between<E: TransferEventEmitter>(
    source: &Sftp,
    destination: &Sftp,
    source_path: &Path,
    destination_path: &Path,
    allow_overwrite: bool,
    progress: &mut RemoteCopyProgressTracker<E>,
) -> Result<(), RemoteFsError> {
    progress
        .ensure_not_cancelled()
        .map_err(|message| RemoteFsError::Other { message })?;
    progress
        .set_current_path(Some(path_to_string(source_path)))
        .map_err(|message| RemoteFsError::Other { message })?;
    let stat = source
        .lstat(source_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to inspect remote source: {error}"),
        })?;
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
                    .map_err(|error| RemoteFsError::Other {
                        message: format!("failed to create remote copy directory: {error}"),
                    })?;
            }
            for (child_path, _) in
                source
                    .readdir(source_path)
                    .map_err(|error| RemoteFsError::Other {
                        message: format!("failed to list remote source directory: {error}"),
                    })?
            {
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                let child_name = child_path.file_name().ok_or_else(|| RemoteFsError::Other {
                    message: "remote child path has no file name".to_string(),
                })?;
                copy_remote_entry_between(
                    source,
                    destination,
                    &child_path,
                    &remote_join(destination_path, &child_name.to_string_lossy()),
                    allow_overwrite,
                    progress,
                )?;
            }
            let _ = destination.setstat(
                destination_path,
                FileStat {
                    size: None,
                    uid: None,
                    gid: None,
                    perm: stat.perm,
                    atime: stat.atime,
                    mtime: stat.mtime,
                },
            );
        }
        RemoteFileKind::Symlink => {
            let target = source
                .readlink(source_path)
                .map_err(|error| RemoteFsError::Other {
                    message: format!("failed to read remote source symlink: {error}"),
                })?;
            if allow_overwrite {
                // symlink() fails when the destination exists; remove any
                // existing entry first. A missing destination makes unlink
                // fail, which is fine to ignore.
                let _ = destination.unlink(destination_path);
            }
            destination
                .symlink(&target, destination_path)
                .map_err(|error| RemoteFsError::Other {
                    message: format!("failed to create remote destination symlink: {error}"),
                })?;
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
    progress
        .set_current_path(Some(path_to_string(source_path)))
        .map_err(|message| RemoteFsError::Other { message })?;
    progress
        .finish_step()
        .map_err(|message| RemoteFsError::Other { message })
}

/// Stages a single file copy through a `.<name>.tb-part` temp file that is
/// renamed into place only after every byte is written: an interrupted copy
/// never leaves a partial file under the real name, and a leftover temp file
/// doubles as the resume point for retries and later copies of the same name.
fn copy_remote_file_between<E: TransferEventEmitter>(
    source: &Sftp,
    destination: &Sftp,
    source_path: &Path,
    destination_path: &Path,
    source_stat: &FileStat,
    allow_overwrite: bool,
    progress: &mut RemoteCopyProgressTracker<E>,
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
    if let Err(error) = destination.setstat(
        &temp_path,
        FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: source_stat.perm,
            atime: source_stat.atime,
            mtime: source_stat.mtime,
        },
    ) {
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
        Err(error) => Err(RemoteFsError::Other {
            message: format!(
                "failed to finalize remote copy {}: {error}",
                destination_path.display()
            ),
        }),
    }
}

#[allow(clippy::too_many_arguments)]
fn copy_remote_file_attempt<E: TransferEventEmitter>(
    source: &Sftp,
    destination: &Sftp,
    source_path: &Path,
    destination_path: &Path,
    temp_path: &Path,
    source_size: u64,
    source_perm: Option<u32>,
    progress: &mut RemoteCopyProgressTracker<E>,
    credited: &mut u64,
) -> Result<(), RemoteFsError> {
    let temp_size = destination.stat(temp_path).ok().and_then(|stat| stat.size);
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
        progress
            .advance_bytes(resume_offset - *credited)
            .map_err(|message| RemoteFsError::Other { message })?;
        *credited = resume_offset;
    }
    if source_size > 0 && resume_offset == source_size {
        return Ok(());
    }
    let mut reader = source
        .open(source_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to open remote source: {error}"),
        })?;
    let mut flags = OpenFlags::CREATE | OpenFlags::WRITE;
    if resume_offset == 0 {
        // Fresh attempts truncate the temp file; resumed attempts keep what
        // is already written and continue at the offset.
        flags |= OpenFlags::TRUNCATE;
    }
    let mut writer = destination
        .open_mode(
            temp_path,
            flags,
            source_perm.unwrap_or(0o644) as i32,
            OpenType::File,
        )
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to create remote destination: {error}"),
        })?;
    if resume_offset > 0 {
        reader
            .seek(SeekFrom::Start(resume_offset))
            .map_err(|error| RemoteFsError::Other {
                message: format!("failed to seek remote source: {error}"),
            })?;
        writer
            .seek(SeekFrom::Start(resume_offset))
            .map_err(|error| RemoteFsError::Other {
                message: format!("failed to resume remote destination: {error}"),
            })?;
    }
    let mut buffer = [0u8; 64 * 1024];
    loop {
        progress
            .ensure_not_cancelled()
            .map_err(|message| RemoteFsError::Other { message })?;
        let read = reader
            .read(&mut buffer)
            .map_err(|error| RemoteFsError::Other {
                message: format!("failed to read remote source: {error}"),
            })?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| RemoteFsError::Other {
                message: format!(
                    "failed to copy between remote hosts ({} at byte {credited}): {error}",
                    destination_path.display(),
                    credited = *credited
                ),
            })?;
        progress
            .advance_bytes(read as u64)
            .map_err(|message| RemoteFsError::Other { message })?;
        *credited += read as u64;
    }
    writer.flush().map_err(|error| RemoteFsError::Other {
        message: format!("failed to flush remote destination: {error}"),
    })
}

/// Backoff between copy attempts, sliced so cancellation stays responsive.
fn sleep_remote_copy_retry_backoff<E: TransferEventEmitter>(
    attempt: u32,
    progress: &RemoteCopyProgressTracker<E>,
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
    let Some(file_name) = destination_path.file_name() else {
        // No file name component (e.g. a filesystem root); fall back to
        // appending the suffix to the whole path.
        let mut temp_name = destination_path.as_os_str().to_owned();
        temp_name.push(REMOTE_COPY_TEMP_SUFFIX);
        return PathBuf::from(temp_name);
    };
    // Dot-prefix the temp file so it stays hidden from `ls`, shell globs,
    // and file browsers; skip the prefix when the name is already hidden.
    let mut temp_name = std::ffi::OsString::new();
    if !file_name.as_encoded_bytes().starts_with(b".") {
        temp_name.push(".");
    }
    temp_name.push(file_name);
    temp_name.push(REMOTE_COPY_TEMP_SUFFIX);
    destination_path.with_file_name(temp_name)
}

fn upload_temp_path(destination_path: &Path) -> PathBuf {
    let mut temp_path = remote_copy_temp_path(destination_path);
    temp_path.set_extension(format!(
        "{}upload-{}",
        temp_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!("{value}."))
            .unwrap_or_default(),
        Uuid::new_v4()
    ));
    temp_path
}

fn upload_backup_path(destination_path: &Path) -> PathBuf {
    let mut backup_path = remote_copy_temp_path(destination_path);
    backup_path.set_extension(format!(
        "{}backup-{}",
        backup_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!("{value}."))
            .unwrap_or_default(),
        Uuid::new_v4()
    ));
    backup_path
}

fn remove_remote_entry_simple(sftp: &Sftp, path: &Path) -> Result<(), RemoteFsError> {
    let stat = sftp.lstat(path).map_err(|error| RemoteFsError::Other {
        message: format!("failed to inspect remote destination: {error}"),
    })?;
    if kind_from_permissions(stat.perm) == RemoteFileKind::Directory {
        for (child_path, _) in sftp.readdir(path).map_err(|error| RemoteFsError::Other {
            message: format!("failed to list remote destination: {error}"),
        })? {
            if !should_skip_remote_child(&child_path) {
                remove_remote_entry_simple(sftp, &child_path)?;
            }
        }
        sftp.rmdir(path).map_err(|error| RemoteFsError::Other {
            message: format!("failed to replace remote directory: {error}"),
        })
    } else {
        sftp.unlink(path).map_err(|error| RemoteFsError::Other {
            message: format!("failed to replace remote file: {error}"),
        })
    }
}

pub(crate) fn open_remote_file_blocking(
    request: OpenRemoteFileRequest,
    pool: Option<&SftpPool>,
    known_hosts: Option<&Path>,
    open_root: Option<&Path>,
) -> Result<(), RemoteFsError> {
    let connection = request.connection.clone();
    let result = open_remote_file_inner(request, pool, known_hosts, open_root);
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
    open_root: Option<&Path>,
) -> Result<(), RemoteFsError> {
    let connected = connect_sftp(&request.connection, pool, known_hosts)?;
    let connected = connected
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let remote_path = Path::new(&request.path);
    let stat = connected
        .sftp
        .lstat(remote_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to inspect remote file: {error}"),
        })?;

    if kind_from_permissions(stat.perm) == RemoteFileKind::Directory {
        return Err(RemoteFsError::Other {
            message: "目录不支持使用默认编辑器打开".to_string(),
        });
    }

    // `sftp.open` follows symlinks, so size-limit the link target rather than
    // the link itself before pulling the whole file into a local temp copy.
    let target_size = connected
        .sftp
        .stat(remote_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to inspect remote file target: {error}"),
        })?
        .size
        .unwrap_or(0);
    if target_size > OPEN_FILE_SIZE_LIMIT {
        return Err(RemoteFsError::Other {
            message: format!(
                "file too large to open: {} bytes (limit: {} bytes)",
                target_size, OPEN_FILE_SIZE_LIMIT
            ),
        });
    }

    let file_name = remote_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "remote-file".to_string());

    // Local copies of remotely-opened files live under ~/.termbridge so they
    // survive reboots (the retention cleanup bounds their lifetime); fall
    // back to the system temp dir if the home dir is unavailable.
    let open_root = open_root
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("termbridge-open"));
    fs::create_dir_all(&open_root).map_err(|error| RemoteFsError::Other {
        message: format!("failed to create temp directory: {error}"),
    })?;
    cleanup_stale_open_temp_files(&open_root);

    let local_path = open_root.join(format!("{}-{}", Uuid::new_v4(), file_name));
    let mut remote_file =
        connected
            .sftp
            .open(remote_path)
            .map_err(|error| RemoteFsError::Other {
                message: format!("failed to open remote file: {error}"),
            })?;
    let mut local_file = fs::File::create(&local_path).map_err(|error| RemoteFsError::Other {
        message: format!("failed to prepare local temp file: {error}"),
    })?;
    copy(&mut remote_file, &mut local_file).map_err(|error| RemoteFsError::Other {
        message: format!("failed to download remote file: {error}"),
    })?;
    local_file.flush().map_err(|error| RemoteFsError::Other {
        message: format!("failed to finalize temp file: {error}"),
    })?;

    open_path_with_default_app(&local_path)
}

pub(crate) const PREVIEW_COMPLETE_FILE_SIZE_LIMIT: u64 = 16 * 1024 * 1024;
pub(crate) const PREVIEW_TEXT_PREFIX_SIZE_LIMIT: u64 = 256 * 1024;

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
    let connected = connected
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let remote_path = Path::new(&request.path);

    let stat = connected
        .sftp
        .lstat(remote_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to inspect remote file: {error}"),
        })?;

    if kind_from_permissions(stat.perm) == RemoteFileKind::Directory {
        return Err(RemoteFsError::Other {
            message: "cannot preview a directory".to_string(),
        });
    }

    let file_name = remote_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "remote-file".to_string());

    // `sftp.open` follows symlinks, so use the target size rather than the
    // link entry size. Oversized files still return metadata, allowing the UI
    // to offer opening them with the system application instead of a toast.
    let size = connected
        .sftp
        .stat(remote_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to inspect remote file target: {error}"),
        })?
        .size
        .unwrap_or(stat.size.unwrap_or(0));
    let requires_complete_file = preview_extension_requires_complete_file(&file_name);
    let read_limit = if requires_complete_file {
        PREVIEW_COMPLETE_FILE_SIZE_LIMIT
    } else {
        PREVIEW_TEXT_PREFIX_SIZE_LIMIT
    };
    if requires_complete_file && size > read_limit {
        return Ok(ReadRemoteFileResponse {
            path: request.path,
            name: file_name,
            content: String::new(),
            size,
            is_text: false,
            content_encoding: "none".to_string(),
            truncated: true,
        });
    }

    let remote_file = connected
        .sftp
        .open(remote_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to open remote file: {error}"),
        })?;

    // Read one byte beyond the relevant limit so growth after `stat` is still
    // detected. Complete-file formats are rejected; text and inspection
    // formats keep a bounded prefix and report `truncated`.
    let mut buffer = Vec::with_capacity((size.min(read_limit) + 1) as usize);
    remote_file
        .take(read_limit + 1)
        .read_to_end(&mut buffer)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to read remote file: {error}"),
        })?;
    let mut truncated = size > read_limit;
    if buffer.len() as u64 > read_limit && requires_complete_file {
        return Ok(ReadRemoteFileResponse {
            path: request.path,
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

    let decoded_text = if preview_extension_requires_binary(&file_name) {
        None
    } else {
        decode_preview_text(&buffer, truncated)
    };
    let (content, is_text, content_encoding) = match decoded_text {
        Some(text) => (text, true, "utf8".to_string()),
        None => (
            base64::engine::general_purpose::STANDARD.encode(&buffer),
            false,
            "base64".to_string(),
        ),
    };

    Ok(ReadRemoteFileResponse {
        path: request.path,
        name: file_name,
        content,
        size,
        is_text,
        content_encoding,
        truncated,
    })
}

pub(crate) fn decode_preview_text(buffer: &[u8], allow_incomplete_tail: bool) -> Option<String> {
    if buffer.starts_with(&[0xff, 0xfe]) || buffer.starts_with(&[0xfe, 0xff]) {
        if !allow_incomplete_tail && !(buffer.len() - 2).is_multiple_of(2) {
            return None;
        }
        let little_endian = buffer.starts_with(&[0xff, 0xfe]);
        let mut units = buffer[2..]
            .chunks_exact(2)
            .map(|chunk| {
                if little_endian {
                    u16::from_le_bytes([chunk[0], chunk[1]])
                } else {
                    u16::from_be_bytes([chunk[0], chunk[1]])
                }
            })
            .collect::<Vec<_>>();
        if allow_incomplete_tail
            && units
                .last()
                .is_some_and(|unit| matches!(unit, 0xd800..=0xdbff))
        {
            units.pop();
        }
        return String::from_utf16(&units).ok();
    }

    if buffer.contains(&0) {
        return None;
    }

    let text = match std::str::from_utf8(buffer) {
        Ok(text) => text,
        Err(error) if allow_incomplete_tail && error.error_len().is_none() => {
            std::str::from_utf8(&buffer[..error.valid_up_to()]).ok()?
        }
        Err(_) => return None,
    };
    let suspicious_controls = text
        .chars()
        .filter(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        .count();
    if suspicious_controls > (text.chars().count() / 50).max(1) {
        return None;
    }
    Some(text.to_string())
}

pub(crate) fn preview_extension_requires_complete_file(file_name: &str) -> bool {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    matches!(
        extension.as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "ico"
            | "avif"
            | "svg"
            | "mp3"
            | "wav"
            | "ogg"
            | "oga"
            | "flac"
            | "m4a"
            | "aac"
            | "opus"
            | "mp4"
            | "webm"
            | "ogv"
            | "mov"
            | "m4v"
            | "pdf"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
    )
}

pub(crate) fn preview_extension_requires_binary(file_name: &str) -> bool {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    matches!(
        extension.as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "ico"
            | "avif"
            | "svg"
            | "mp3"
            | "wav"
            | "ogg"
            | "oga"
            | "flac"
            | "m4a"
            | "aac"
            | "opus"
            | "mp4"
            | "webm"
            | "ogv"
            | "mov"
            | "m4v"
            | "pdf"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "zip"
            | "gz"
            | "tgz"
            | "tar"
            | "bz2"
            | "xz"
            | "7z"
            | "rar"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
    )
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
    let resolved_path =
        sftp.realpath(Path::new(requested_path))
            .map_err(|error| RemoteFsError::Other {
                message: format!("failed to resolve remote path {requested_path}: {error}"),
            })?;

    let mut entries = sftp
        .readdir(&resolved_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to list remote directory: {error}"),
        })?
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

// Resolves user and group names in a single remote exec (one channel, one
// remote shell) instead of one exec per kind. Ids that come back without a
// name — and all requested ids when the exec fails — are cached as unresolved
// so the next listing does not pay for the lookup again.
fn resolve_missing_identity_names(
    scope: &str,
    session: &Session,
    cache: Option<&RemoteIdentityCache>,
    missing_owner_ids: &[u32],
    missing_group_ids: &[u32],
    owner_names: &mut HashMap<u32, String>,
    group_names: &mut HashMap<u32, String>,
) {
    if missing_owner_ids.is_empty() && missing_group_ids.is_empty() {
        return;
    }

    let mut sorted_owner_ids = missing_owner_ids.to_vec();
    sorted_owner_ids.sort_unstable();
    let mut sorted_group_ids = missing_group_ids.to_vec();
    sorted_group_ids.sort_unstable();

    let command = build_remote_identity_lookup_command(&sorted_owner_ids, &sorted_group_ids);
    match run_remote_exec(session, &command) {
        Ok(output) => {
            let (resolved_owners, resolved_groups) = parse_identity_lookup_output(&output);
            if let Some(cache) = cache {
                for (id, name) in &resolved_owners {
                    cache.insert(scope, *id, RemoteIdentityKind::User, name.clone());
                }
                for (id, name) in &resolved_groups {
                    cache.insert(scope, *id, RemoteIdentityKind::Group, name.clone());
                }
                for id in &sorted_owner_ids {
                    if !resolved_owners.contains_key(id) {
                        cache.insert_unresolved(scope, *id, RemoteIdentityKind::User);
                    }
                }
                for id in &sorted_group_ids {
                    if !resolved_groups.contains_key(id) {
                        cache.insert_unresolved(scope, *id, RemoteIdentityKind::Group);
                    }
                }
            }
            owner_names.extend(resolved_owners);
            group_names.extend(resolved_groups);
        }
        Err(error) => {
            if let Some(cache) = cache {
                for id in &sorted_owner_ids {
                    cache.insert_unresolved(scope, *id, RemoteIdentityKind::User);
                }
                for id in &sorted_group_ids {
                    cache.insert_unresolved(scope, *id, RemoteIdentityKind::Group);
                }
            }
            warn!("failed to resolve remote identity names: {error:?}");
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum RemoteIdentityKind {
    User,
    Group,
}

// Parses lines of `u\tid\tname` / `g\tid\tname` emitted by the lookup command.
fn parse_identity_lookup_output(output: &str) -> (HashMap<u32, String>, HashMap<u32, String>) {
    let mut owners = HashMap::new();
    let mut groups = HashMap::new();
    for line in output.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(kind_tag), Some(id_text), Some(name)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Ok(id) = id_text.trim().parse::<u32>() else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        match kind_tag {
            "u" => {
                owners.insert(id, name.to_string());
            }
            "g" => {
                groups.insert(id, name.to_string());
            }
            _ => {}
        }
    }
    (owners, groups)
}

fn build_remote_identity_lookup_command(owner_ids: &[u32], group_ids: &[u32]) -> String {
    // One `sh -lc` for both databases: `lookup_ids <db> <python module>
    // <python lookup> <python field> <output tag> <id...>` prints
    // `tag\tid\tname` per resolved id.
    let mut script = String::from(
        "lookup_ids() {\n\
         db=\"$1\"; py_module=\"$2\"; py_lookup=\"$3\"; py_field=\"$4\"; tag=\"$5\"; shift 5;\n\
         if command -v getent >/dev/null 2>&1; then\n\
         for id in \"$@\"; do\n\
         entry=$(getent \"$db\" \"$id\" 2>/dev/null | cut -d: -f1);\n\
         if [ -n \"$entry\" ]; then printf \"%s\\t%s\\t%s\\n\" \"$tag\" \"$id\" \"$entry\"; fi;\n\
         done;\n\
         else\n\
         for id in \"$@\"; do\n\
         entry=\"\";\n\
         if command -v python3 >/dev/null 2>&1; then\n\
         entry=$(python3 -c \"import $py_module,sys; print(getattr($py_module.$py_lookup(int(sys.argv[1])), \\\"$py_field\\\"))\" \"$id\" 2>/dev/null);\n\
         elif command -v python >/dev/null 2>&1; then\n\
         entry=$(python -c \"import $py_module,sys; print(getattr($py_module.$py_lookup(int(sys.argv[1])), \\\"$py_field\\\"))\" \"$id\" 2>/dev/null);\n\
         fi;\n\
         if [ -n \"$entry\" ]; then printf \"%s\\t%s\\t%s\\n\" \"$tag\" \"$id\" \"$entry\"; fi;\n\
         done;\n\
         fi;\n\
         }",
    );

    // Space-separated: POSIX `for id in ...` splits on IFS (spaces), not commas.
    let owner_ids_text = owner_ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(" ");
    let group_ids_text = group_ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(" ");

    if !owner_ids.is_empty() {
        script.push_str(&format!(
            "\nlookup_ids passwd pwd getpwuid pw_name u {owner_ids_text};"
        ));
    }
    if !group_ids.is_empty() {
        script.push_str(&format!(
            "\nlookup_ids group grp getgrgid gr_name g {group_ids_text};"
        ));
    }

    format!("sh -lc '{script}'")
}

fn run_remote_exec(session: &Session, command: &str) -> Result<String, RemoteFsError> {
    let mut channel = session
        .channel_session()
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to open remote exec channel: {error}"),
        })?;
    channel
        .exec(command)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to execute remote lookup command: {error}"),
        })?;

    let mut output = String::new();
    channel
        .read_to_string(&mut output)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to read remote lookup output: {error}"),
        })?;

    let mut stderr = String::new();
    let _ = channel.stderr().read_to_string(&mut stderr);
    channel.wait_close().map_err(|error| RemoteFsError::Other {
        message: format!("failed to close remote lookup channel: {error}"),
    })?;
    let exit_status = channel
        .exit_status()
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to read remote lookup exit status: {error}"),
        })?;

    if exit_status != 0 {
        let stderr = stderr.trim();
        let details = if stderr.is_empty() {
            "no stderr output".to_string()
        } else {
            stderr.to_string()
        };
        return Err(RemoteFsError::Other {
            message: format!(
                "remote lookup command failed with exit status {exit_status}: {details}"
            ),
        });
    }

    Ok(output)
}

fn validate_remote_name(name: &str) -> Result<(), RemoteFsError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(RemoteFsError::Other {
            message: "name is required".to_string(),
        });
    }
    if trimmed == "." || trimmed == ".." {
        return Err(RemoteFsError::Other {
            message: "'.' and '..' are not valid file names".to_string(),
        });
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(RemoteFsError::Other {
            message: "file name must not include path separators".to_string(),
        });
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
                return Err(RemoteFsError::Other {
                    message: format!(
                        "remote path exists but is not a directory: {}",
                        path_to_string(path)
                    ),
                })
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
            Ok(_) => Err(RemoteFsError::Other {
                message: format!(
                    "remote path exists but is not a directory: {}",
                    path_to_string(path)
                ),
            }),
            Err(_) => Err(RemoteFsError::Other {
                message: format!("failed to create remote directory: {error}"),
            }),
        },
        Err(error) => Err(RemoteFsError::Other {
            message: format!("failed to create remote directory: {error}"),
        }),
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

fn delete_remote_path_recursive(
    sftp: &Sftp,
    path: &Path,
    progress: &mut DeleteProgressTracker,
    depth: u32,
) -> Result<(), RemoteFsError> {
    progress
        .ensure_not_cancelled()
        .map_err(|message| RemoteFsError::Other { message })?;
    ensure_remote_recursion_depth(depth)?;
    // Count this entry as discovered before inspecting it.
    progress.add_steps(1);
    let stat = sftp.lstat(path).map_err(|error| RemoteFsError::Other {
        message: format!("failed to inspect remote path: {error}"),
    })?;

    match kind_from_permissions(stat.perm) {
        RemoteFileKind::Directory => {
            let entries = sftp.readdir(path).map_err(|error| RemoteFsError::Other {
                message: format!("failed to list remote directory for delete: {error}"),
            })?;
            // Count the listing's children as discovered in one shot.
            progress.add_steps(
                entries
                    .iter()
                    .filter(|(child_path, _)| !should_skip_remote_child(child_path))
                    .count() as u64,
            );
            for (child_path, _) in entries {
                progress
                    .ensure_not_cancelled()
                    .map_err(|message| RemoteFsError::Other { message })?;
                if should_skip_remote_child(&child_path) {
                    continue;
                }
                delete_remote_path_recursive(sftp, &child_path, progress, depth + 1)?;
            }
            progress
                .ensure_not_cancelled()
                .map_err(|message| RemoteFsError::Other { message })?;
            progress
                .set_current_path(Some(path_to_string(path)))
                .map_err(|message| RemoteFsError::Other { message })?;
            sftp.rmdir(path).map_err(|error| RemoteFsError::Other {
                message: format!("failed to remove remote directory: {error}"),
            })?;
            progress
                .finish_step()
                .map_err(|message| RemoteFsError::Other { message })
        }
        _ => {
            progress
                .ensure_not_cancelled()
                .map_err(|message| RemoteFsError::Other { message })?;
            progress
                .set_current_path(Some(path_to_string(path)))
                .map_err(|message| RemoteFsError::Other { message })?;
            sftp.unlink(path).map_err(|error| RemoteFsError::Other {
                message: format!("failed to remove remote file: {error}"),
            })?;
            progress
                .finish_step()
                .map_err(|message| RemoteFsError::Other { message })
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
    scan_stats: &mut RemoteCopyScanStats,
) -> Result<(), RemoteFsError> {
    ensure_remote_recursion_depth(depth)?;
    let kind = kind_from_permissions(source_stat.perm);
    scan_stats.total_steps += 1;
    if kind != RemoteFileKind::Directory {
        scan_stats.total_files += 1;
    }
    if kind == RemoteFileKind::File {
        scan_stats.total_bytes += source_stat.size.unwrap_or(0);
    }
    match kind {
        RemoteFileKind::Directory => {
            if destination_path.starts_with(source_path) {
                return Err(RemoteFsError::Other {
                    message: "cannot copy a directory into itself".to_string(),
                });
            }

            ensure_remote_directory(sftp, destination_path)?;
            let entries = sftp
                .readdir(source_path)
                .map_err(|error| RemoteFsError::Other {
                    message: format!("failed to read remote directory for copy: {error}"),
                })?;
            for (child_path, child_stat) in entries {
                if cancel_flag.load(AtomicOrdering::SeqCst) {
                    return Err(RemoteFsError::Other {
                        message: "remote copy cancelled".to_string(),
                    });
                }
                let child_name = child_path.file_name().ok_or_else(|| RemoteFsError::Other {
                    message: "invalid child path while copying directory".to_string(),
                })?;
                copy_remote_entry_to_path(
                    sftp,
                    &child_path,
                    &remote_join(destination_path, &child_name.to_string_lossy()),
                    child_stat,
                    depth + 1,
                    cancel_flag,
                    scan_stats,
                )?;
            }
            Ok(())
        }
        RemoteFileKind::Symlink => {
            let target = sftp
                .readlink(source_path)
                .map_err(|error| RemoteFsError::Other {
                    message: format!("failed to read remote symlink: {error}"),
                })?;
            sftp.symlink(&target, destination_path)
                .map_err(|error| RemoteFsError::Other {
                    message: format!("failed to copy remote symlink: {error}"),
                })
        }
        _ => copy_remote_file(
            sftp,
            source_path,
            destination_path,
            source_stat.size,
            cancel_flag,
        ),
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
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to open remote source file: {error}"),
        })?;
    let mut destination = sftp
        .open_mode(
            destination_path,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE | OpenFlags::EXCLUSIVE,
            0o644,
            OpenType::File,
        )
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to create remote copy: {error}"),
        })?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancel_flag.load(AtomicOrdering::SeqCst) {
            return Err(RemoteFsError::Other {
                message: "remote copy cancelled".to_string(),
            });
        }
        let read = source
            .read(&mut buffer)
            .map_err(|error| RemoteFsError::Other {
                message: format!("failed to read remote source file: {error}"),
            })?;
        if read == 0 {
            break;
        }
        destination
            .write_all(&buffer[..read])
            .map_err(|error| RemoteFsError::Other {
                message: format!("failed to copy remote file data: {error}"),
            })?;
    }
    destination.flush().map_err(|error| RemoteFsError::Other {
        message: format!("failed to flush remote copy: {error}"),
    })?;
    drop(destination);

    if let Some(expected_size) = expected_size {
        let copied_size = sftp
            .stat(destination_path)
            .map_err(|error| RemoteFsError::Other {
                message: format!("failed to verify remote copy: {error}"),
            })?
            .size
            .ok_or_else(|| RemoteFsError::Other {
                message: "remote server did not report copied file size".to_string(),
            })?;
        if copied_size != expected_size {
            return Err(RemoteFsError::Other {
                message: format!(
                    "remote copy size mismatch: expected {expected_size} bytes, got {copied_size}"
                ),
            });
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
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to inspect remote upload destination: {error}"),
        })?;
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
        UploadConflictPolicy::Fail => Err(RemoteFsError::Other {
            message: format!("remote path already exists: {base_name}"),
        }),
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

    Err(RemoteFsError::Other {
        message: format!("failed to find an available destination name for {base_name}"),
    })
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
        return Err(RemoteFsError::Other {
            message: "upload cancelled".to_string(),
        });
    }

    let metadata = fs::symlink_metadata(local_path).map_err(|error| RemoteFsError::Other {
        message: format!("failed to read local path metadata: {error}"),
    })?;

    if metadata.file_type().is_symlink() {
        return Err(RemoteFsError::Other {
            message: format!("symlink upload is not supported: {}", local_path.display()),
        });
    }

    if metadata.is_dir() {
        let mut stats = UploadScanStats {
            total_bytes: 0,
            total_steps: 1,
            total_files: 0,
        };
        let entries = fs::read_dir(local_path).map_err(|error| RemoteFsError::Other {
            message: format!("failed to read local directory: {error}"),
        })?;
        for entry in entries {
            if cancel_flag.load(AtomicOrdering::SeqCst) {
                return Err(RemoteFsError::Other {
                    message: "upload cancelled".to_string(),
                });
            }
            let entry = entry.map_err(|error| RemoteFsError::Other {
                message: format!("failed to read local directory entry: {error}"),
            })?;
            stats.combine(scan_local_upload_path(&entry.path(), cancel_flag)?);
        }
        return Ok(stats);
    }

    if metadata.is_file() {
        return Ok(UploadScanStats {
            total_bytes: metadata.len(),
            total_steps: 1,
            total_files: 1,
        });
    }

    Err(RemoteFsError::Other {
        message: format!(
            "unsupported local path type for upload: {}",
            local_path.display()
        ),
    })
}

fn is_private_key_file(path: &std::path::Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let lower = name.to_lowercase();
    lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".ppk")
        || name == "id_rsa"
        || name == "id_ed25519"
        || name == "id_ecdsa"
        || name == "id_dsa"
}

fn upload_local_entry_to_path<E: TransferEventEmitter>(
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &Path,
    conflict_policy: UploadConflictPolicy,
    progress: &mut UploadProgressTracker<E>,
) -> Result<(), RemoteFsError> {
    progress
        .ensure_not_cancelled()
        .map_err(|message| RemoteFsError::Other { message })?;
    let metadata = fs::symlink_metadata(local_path).map_err(|error| RemoteFsError::Other {
        message: format!("failed to read local path metadata: {error}"),
    })?;

    if metadata.file_type().is_symlink() {
        return Err(RemoteFsError::Other {
            message: format!("symlink upload is not supported: {}", local_path.display()),
        });
    }

    if metadata.is_dir() {
        progress
            .set_current_path(Some(path_to_string(local_path)))
            .map_err(|message| RemoteFsError::Other { message })?;
        ensure_remote_directory(sftp, remote_path)?;
        progress
            .finish_step()
            .map_err(|message| RemoteFsError::Other { message })?;
        let entries = fs::read_dir(local_path).map_err(|error| RemoteFsError::Other {
            message: format!("failed to read local directory: {error}"),
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| RemoteFsError::Other {
                message: format!("failed to read local directory entry: {error}"),
            })?;
            upload_local_entry_to_path(
                sftp,
                &entry.path(),
                &remote_join(remote_path, &entry.file_name().to_string_lossy()),
                conflict_policy,
                progress,
            )?;
        }
        return Ok(());
    }

    if metadata.is_file() {
        progress
            .set_current_path(Some(path_to_string(local_path)))
            .map_err(|message| RemoteFsError::Other { message })?;
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
            conflict_policy,
            progress,
        )?;
        progress
            .finish_step()
            .map_err(|message| RemoteFsError::Other { message })?;
        return Ok(());
    }

    Err(RemoteFsError::Other {
        message: format!(
            "unsupported local path type for upload: {}",
            local_path.display()
        ),
    })
}

fn upload_regular_file<E: TransferEventEmitter>(
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &Path,
    expected_size: u64,
    upload_mode: i32,
    conflict_policy: UploadConflictPolicy,
    progress: &mut UploadProgressTracker<E>,
) -> Result<(), RemoteFsError> {
    // Stage uploads through a hidden temp file and rename only after every byte
    // is written and verified. A cancelled or failed upload never leaves a
    // partial file under the real destination name.
    let temp_path = upload_temp_path(remote_path);
    let result = upload_regular_file_to_temp(
        sftp,
        local_path,
        &temp_path,
        expected_size,
        upload_mode,
        progress,
    );
    if let Err(error) = result {
        let _ = sftp.unlink(&temp_path);
        return Err(error);
    }

    if let Err(error) = finalize_uploaded_temp_file(sftp, &temp_path, remote_path, conflict_policy)
    {
        let _ = sftp.unlink(&temp_path);
        return Err(error);
    }
    Ok(())
}

fn finalize_uploaded_temp_file(
    sftp: &Sftp,
    temp_path: &Path,
    remote_path: &Path,
    conflict_policy: UploadConflictPolicy,
) -> Result<(), RemoteFsError> {
    let backup_path = prepare_upload_destination_backup(sftp, remote_path, conflict_policy)?;
    match sftp.rename(
        temp_path,
        remote_path,
        Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
    ) {
        Ok(()) => {
            if let Some(backup_path) = backup_path {
                if let Err(error) = remove_remote_entry_simple(sftp, &backup_path) {
                    warn!(
                        "Uploaded {} but failed to remove backup {}: {error:?}",
                        remote_path.display(),
                        backup_path.display()
                    );
                }
            }
            Ok(())
        }
        Err(error) => {
            let _ = sftp.unlink(temp_path);
            let rollback_message =
                rollback_upload_backup(sftp, backup_path.as_deref(), remote_path);
            Err(RemoteFsError::Other {
                message: format!(
                    "failed to finalize remote upload {}: {error}{rollback_message}",
                    remote_path.display()
                ),
            })
        }
    }
}

fn prepare_upload_destination_backup(
    sftp: &Sftp,
    remote_path: &Path,
    conflict_policy: UploadConflictPolicy,
) -> Result<Option<PathBuf>, RemoteFsError> {
    let allow_overwrite = matches!(
        conflict_policy,
        UploadConflictPolicy::Overwrite | UploadConflictPolicy::Replace
    );
    let replace_any = conflict_policy == UploadConflictPolicy::Replace;
    let Ok(stat) = sftp.lstat(remote_path) else {
        return Ok(None);
    };
    if !allow_overwrite {
        return Err(RemoteFsError::Other {
            message: format!("remote path already exists: {}", remote_path.display()),
        });
    }

    if kind_from_permissions(stat.perm) == RemoteFileKind::Directory && !replace_any {
        return Err(RemoteFsError::Other {
            message: format!("remote path is a directory: {}", remote_path.display()),
        });
    }

    let backup_path = upload_backup_path(remote_path);
    sftp.rename(
        remote_path,
        &backup_path,
        Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
    )
    .map_err(|error| RemoteFsError::Other {
        message: format!(
            "failed to prepare overwrite backup for {}: {error}",
            remote_path.display()
        ),
    })?;
    Ok(Some(backup_path))
}

fn rollback_upload_backup(sftp: &Sftp, backup_path: Option<&Path>, remote_path: &Path) -> String {
    let Some(backup_path) = backup_path else {
        return String::new();
    };
    match sftp.rename(
        backup_path,
        remote_path,
        Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
    ) {
        Ok(()) => " (previous remote entry restored)".to_string(),
        Err(error) => format!(
            " (failed to restore previous remote entry from {}: {error})",
            backup_path.display()
        ),
    }
}

fn upload_regular_file_to_temp<E: TransferEventEmitter>(
    sftp: &Sftp,
    local_path: &Path,
    temp_path: &Path,
    expected_size: u64,
    upload_mode: i32,
    progress: &mut UploadProgressTracker<E>,
) -> Result<(), RemoteFsError> {
    let mut local_file = fs::File::open(local_path).map_err(|error| RemoteFsError::Other {
        message: format!("failed to open local file: {error}"),
    })?;
    let mut remote_file = sftp
        .open_mode(
            temp_path,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
            upload_mode,
            OpenType::File,
        )
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to create remote upload temp file: {error}"),
        })?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        progress
            .ensure_not_cancelled()
            .map_err(|message| RemoteFsError::Other { message })?;
        let read = local_file
            .read(&mut buffer)
            .map_err(|error| RemoteFsError::Other {
                message: format!("failed to read local file for upload: {error}"),
            })?;
        if read == 0 {
            break;
        }
        remote_file
            .write_all(&buffer[..read])
            .map_err(|error| RemoteFsError::Other {
                message: format!("failed to upload local file: {error}"),
            })?;
        progress
            .advance_bytes(read as u64)
            .map_err(|message| RemoteFsError::Other { message })?;
    }
    remote_file.flush().map_err(|error| RemoteFsError::Other {
        message: format!("failed to flush remote upload: {error}"),
    })?;
    drop(remote_file);

    let uploaded_size = sftp
        .stat(temp_path)
        .map_err(|error| RemoteFsError::Other {
            message: format!("failed to verify remote upload: {error}"),
        })?
        .size
        .ok_or_else(|| RemoteFsError::Other {
            message: "remote server did not report uploaded file size".to_string(),
        })?;
    if uploaded_size != expected_size {
        return Err(RemoteFsError::Other {
            message: format!(
                "remote upload size mismatch: expected {expected_size} bytes, got {uploaded_size}"
            ),
        });
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
        | (RemoteFileKind::Other, RemoteFileKind::Other) => {
            cmp_ascii_case_insensitive(&left.name, &right.name)
        }
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

    command.spawn().map_err(|error| RemoteFsError::Other {
        message: format!("failed to open file with default app: {error}"),
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy)]
    struct NoopTransferEventEmitter;

    impl TransferEventEmitter for NoopTransferEventEmitter {
        fn emit_transfer_event<S>(&self, _event: &str, _payload: S) -> Result<(), String>
        where
            S: serde::Serialize + Clone,
        {
            Ok(())
        }
    }

    #[test]
    fn transfer_metric_record_contains_every_batch_field_without_connection_secrets() {
        let mut metrics = TransferBatchMetrics::new("upload", "metric-test-operation".to_string());
        metrics.connect = Duration::from_micros(11);
        metrics.scan = Duration::from_micros(22);
        metrics.transfer = Duration::from_micros(33);
        metrics.finalize = Duration::from_micros(44);
        metrics.set_inventory(1_024, 7);

        let record = metrics.record("completed");
        metrics.logged = true;

        for field in [
            "operation=upload",
            "operation_id=\"metric-test-operation\"",
            "status=completed",
            "connect_us=11",
            "scan_us=22",
            "transfer_us=33",
            "finalize_us=44",
            "total_us=",
            "total_bytes=1024",
            "file_count=7",
            "throughput_bytes_per_second=",
        ] {
            assert!(record.contains(field), "missing {field} in {record}");
        }
        for secret_field in ["password", "passphrase", "private_key_data"] {
            assert!(!record.contains(secret_field));
        }
    }

    #[test]
    fn transfer_throughput_uses_end_to_end_elapsed_time() {
        assert_eq!(
            throughput_bytes_per_second(8 * 1024 * 1024, Duration::from_secs(2)),
            4 * 1024 * 1024
        );
        assert_eq!(throughput_bytes_per_second(0, Duration::from_secs(2)), 0);
        assert_eq!(throughput_bytes_per_second(100, Duration::ZERO), 0);
    }

    #[test]
    fn preview_text_decoder_accepts_utf8_and_utf16_bom() {
        assert_eq!(
            decode_preview_text(b"hello\nworld", false),
            Some("hello\nworld".to_string())
        );
        assert_eq!(
            decode_preview_text(&[0xff, 0xfe, b'h', 0, b'i', 0], false),
            Some("hi".to_string()),
        );
        assert_eq!(
            decode_preview_text(&[0xfe, 0xff, 0, b'h', 0, b'i'], false),
            Some("hi".to_string()),
        );
    }

    #[test]
    fn preview_text_decoder_rejects_binary_controls_and_invalid_utf8() {
        assert_eq!(decode_preview_text(&[0, 1, 2, 3], false), None);
        assert_eq!(decode_preview_text(&[0xff, 0x00, 0x80], false), None);
    }

    #[test]
    fn preview_text_decoder_only_accepts_incomplete_utf8_for_truncated_prefixes() {
        let partial = [b'h', b'i', 0xe4, 0xbd];
        assert_eq!(decode_preview_text(&partial, false), None);
        assert_eq!(decode_preview_text(&partial, true), Some("hi".to_string()));

        let partial_utf16 = [0xff, 0xfe, b'h', 0, 0x3d, 0xd8];
        assert_eq!(decode_preview_text(&partial_utf16, false), None);
        assert_eq!(
            decode_preview_text(&partial_utf16, true),
            Some("h".to_string())
        );
    }

    #[test]
    fn preview_binary_hint_keeps_ascii_pdf_and_media_as_bytes() {
        assert!(preview_extension_requires_binary("manual.PDF"));
        assert!(preview_extension_requires_binary("sound.mp3"));
        assert!(preview_extension_requires_binary("diagram.svg"));
        assert!(!preview_extension_requires_binary("settings.toml"));
        assert!(preview_extension_requires_complete_file("diagram.svg"));
        assert!(preview_extension_requires_complete_file("manual.pdf"));
        assert!(!preview_extension_requires_complete_file("server.log"));
        assert!(!preview_extension_requires_complete_file("backup.zip"));
    }

    #[test]
    fn parse_identity_lookup_output_splits_users_and_groups() {
        let output = "u\t1000\talice\ng\t100\twheel\nu\t0\troot\ngarbage line\nu\tnotanumber\tbob\nu\t1001\t\n";

        let (owners, groups) = parse_identity_lookup_output(output);

        assert_eq!(owners.get(&1000), Some(&"alice".to_string()));
        assert_eq!(owners.get(&0), Some(&"root".to_string()));
        assert_eq!(groups.get(&100), Some(&"wheel".to_string()));
        assert_eq!(owners.len(), 2);
        assert_eq!(groups.len(), 1);
    }

    #[test]
    fn build_identity_lookup_command_uses_single_shell_for_both_kinds() {
        let command = build_remote_identity_lookup_command(&[0, 1000], &[100]);

        assert!(command.starts_with("sh -lc '"));
        assert!(command.ends_with('\''));
        assert!(command.contains("lookup_ids passwd pwd getpwuid pw_name u 0 1000;"));
        assert!(command.contains("lookup_ids group grp getgrgid gr_name g 100;"));
        // Single quotes inside the script would break the outer sh -lc quoting.
        let script = &command["sh -lc '".len()..command.len() - 1];
        assert!(
            !script.contains('\''),
            "script must not contain single quotes: {script}"
        );
    }

    #[test]
    fn build_identity_lookup_command_skips_empty_kind() {
        let command = build_remote_identity_lookup_command(&[], &[100]);

        assert!(!command.contains("passwd"));
        assert!(command.contains("lookup_ids group grp getgrgid gr_name g 100;"));
    }

    #[test]
    fn same_connection_copy_rejects_copying_entry_onto_itself() {
        let result = validate_same_connection_copy_destination(
            Path::new("/srv/report.txt"),
            Path::new("/srv/report.txt"),
            false,
        );

        assert_eq!(
            result,
            Err(RemoteFsError::Other {
                message: "cannot copy a remote entry onto itself".to_string()
            })
        );
    }

    #[test]
    fn same_connection_copy_rejects_directory_descendant() {
        let result = validate_same_connection_copy_destination(
            Path::new("/srv/assets"),
            Path::new("/srv/assets/archive/assets"),
            true,
        );

        assert_eq!(
            result,
            Err(RemoteFsError::Other {
                message: "cannot copy a directory into itself".to_string()
            })
        );
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
    fn remote_copy_temp_path_dot_prefixes_name_and_appends_suffix() {
        assert_eq!(
            remote_copy_temp_path(Path::new("/srv/report.txt")),
            PathBuf::from("/srv/.report.txt.tb-part")
        );
        assert_eq!(
            remote_copy_temp_path(Path::new("/srv/archive")),
            PathBuf::from("/srv/.archive.tb-part")
        );
    }

    #[test]
    fn remote_copy_temp_path_keeps_hidden_names_hidden_without_double_dot() {
        assert_eq!(
            remote_copy_temp_path(Path::new("/home/user/.bashrc")),
            PathBuf::from("/home/user/.bashrc.tb-part")
        );
    }

    #[test]
    fn upload_temp_path_is_hidden_unique_and_next_to_destination() {
        let first = upload_temp_path(Path::new("/srv/report.txt"));
        let second = upload_temp_path(Path::new("/srv/report.txt"));

        assert_ne!(first, second);
        assert_eq!(first.parent(), Some(Path::new("/srv")));
        assert!(first
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.starts_with(".report.txt.tb-part.upload-")));
    }

    #[test]
    fn upload_backup_path_is_hidden_unique_and_next_to_destination() {
        let first = upload_backup_path(Path::new("/srv/report.txt"));
        let second = upload_backup_path(Path::new("/srv/report.txt"));

        assert_ne!(first, second);
        assert_eq!(first.parent(), Some(Path::new("/srv")));
        assert!(first
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.starts_with(".report.txt.tb-part.backup-")));
    }

    #[test]
    fn remote_copy_resume_starts_fresh_without_usable_temp_file() {
        assert_eq!(remote_copy_resume(None, 100), RemoteCopyResume::Fresh);
        assert_eq!(remote_copy_resume(Some(0), 100), RemoteCopyResume::Fresh);
        assert_eq!(remote_copy_resume(None, 0), RemoteCopyResume::Fresh);
    }

    #[test]
    fn remote_copy_resume_continues_from_partial_temp_file() {
        assert_eq!(
            remote_copy_resume(Some(40), 100),
            RemoteCopyResume::Resume(40)
        );
    }

    #[test]
    fn remote_copy_resume_skips_transfer_when_temp_file_is_complete() {
        assert_eq!(
            remote_copy_resume(Some(100), 100),
            RemoteCopyResume::AlreadyComplete
        );
    }

    #[test]
    fn remote_copy_resume_restarts_when_temp_file_exceeds_source() {
        assert_eq!(
            remote_copy_resume(Some(140), 100),
            RemoteCopyResume::Restart
        );
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
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "SSH transport disconnected".to_string()
        }));
    }

    #[test]
    fn detects_transport_read_as_connection_error() {
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "transport read error".to_string()
        }));
    }

    #[test]
    fn detects_connection_reset_as_connection_error() {
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "connection reset by peer".to_string()
        }));
    }

    #[test]
    fn detects_broken_pipe_as_connection_error() {
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "broken pipe".to_string()
        }));
    }

    #[test]
    fn ignores_unrelated_errors() {
        assert!(!is_connection_error(&RemoteFsError::Other {
            message: "file not found".to_string()
        }));
        assert!(!is_connection_error(&RemoteFsError::Other {
            message: "permission denied".to_string()
        }));
    }

    #[test]
    fn detects_specific_socket_phrases_as_connection_error() {
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "socket error".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "failed reading from socket".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "socket closed".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "socket disconnect".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "socket disconnected".to_string()
        }));
    }

    #[test]
    fn detects_libssh2_transport_messages_as_connection_errors() {
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "[Session(-7)] socket send failure".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "[Session(-43)] error receiving on socket".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "[SFTP(7)] no connection".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "[SFTP(8)] connection lost".to_string()
        }));
        assert!(is_connection_error(&RemoteFsError::Other {
            message: "[Session(-9)] timed out".to_string()
        }));
    }

    #[test]
    fn detects_connection_error_inside_transfer_batch() {
        let batch = TransferBatchResult {
            items: vec![
                TransferItemResult {
                    source_path: "/remote/a.txt".to_string(),
                    destination_path: Some("/local/a.txt".to_string()),
                    status: TransferItemStatus::Completed,
                    error: None,
                },
                TransferItemResult {
                    source_path: "/remote/b.txt".to_string(),
                    destination_path: None,
                    status: TransferItemStatus::Failed,
                    error: Some("[Session(-7)] socket send failure".to_string()),
                },
            ],
        };

        assert!(transfer_batch_has_connection_error(&batch));
    }

    #[test]
    fn does_not_treat_generic_socket_substring_as_connection_error() {
        assert!(!is_connection_error(&RemoteFsError::Other {
            message: "invalid socket path".to_string()
        }));
        assert!(!is_connection_error(&RemoteFsError::Other {
            message: "socket".to_string()
        }));
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
        let reserved = HashSet::from([String::from("report.txt"), String::from("report copy.txt")]);

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

    fn jump_host(host: &str) -> crate::models::JumpHostConfig {
        crate::models::JumpHostConfig {
            host: host.to_string(),
            port: 22,
            username: "jump-user".to_string(),
            auth_method: crate::models::AuthMethod::Password,
            password: None,
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
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

        assert!(!is_same_connection_target(
            &source,
            &connection_request("example.com", 22, "bob")
        ));
        assert!(!is_same_connection_target(
            &source,
            &connection_request("example.com", 2222, "alice")
        ));
        assert!(!is_same_connection_target(
            &source,
            &connection_request("other.example.com", 22, "alice")
        ));
    }

    #[test]
    fn same_connection_target_matches_same_jump_route() {
        let mut source = connection_request("10.0.0.5", 22, "alice");
        let mut destination = connection_request("10.0.0.5", 22, "alice");
        source.jump_host = Some(jump_host("jump.example.com"));
        destination.jump_host = Some(jump_host("jump.example.com"));

        assert!(is_same_connection_target(&source, &destination));
    }

    #[test]
    fn same_connection_target_rejects_different_jump_route() {
        let mut source = connection_request("10.0.0.5", 22, "alice");
        let mut destination = connection_request("10.0.0.5", 22, "alice");
        source.jump_host = Some(jump_host("jump-a.example.com"));
        destination.jump_host = Some(jump_host("jump-b.example.com"));

        assert!(!is_same_connection_target(&source, &destination));
    }

    #[test]
    fn remote_identity_scope_includes_jump_route() {
        let mut request = connection_request("10.0.0.5", 22, "alice");
        request.jump_host = Some(jump_host("jump.example.com"));

        assert_eq!(
            remote_identity_scope(&request),
            "10.0.0.5:22:alice|jump=jump.example.com:22:jump-user"
        );
    }

    #[test]
    fn local_upload_scan_honours_cancellation() {
        let directory =
            std::env::temp_dir().join(format!("termbridge-scan-test-{}", Uuid::new_v4()));
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

    #[test]
    fn local_upload_scan_reports_file_count_and_bytes() {
        let directory = tempfile::tempdir().expect("create scan fixture");
        fs::create_dir(directory.path().join("nested")).expect("create nested fixture directory");
        fs::write(directory.path().join("first.bin"), [1_u8; 3]).expect("write first fixture");
        fs::write(directory.path().join("nested/second.bin"), [2_u8; 5])
            .expect("write second fixture");

        let stats = scan_local_upload_path(directory.path(), &Arc::new(AtomicBool::new(false)))
            .expect("scan fixture");

        assert_eq!(stats.total_bytes, 8);
        assert_eq!(stats.total_files, 2);
        assert_eq!(stats.total_steps, 4);
    }

    fn benchmark_env_u64(name: &str, default: u64) -> u64 {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(default)
    }

    fn write_benchmark_file(path: &Path, size: u64) {
        let mut file = fs::File::create(path).expect("create benchmark file");
        let chunk = (0..64 * 1024)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let mut remaining = size;
        while remaining > 0 {
            let count = remaining.min(chunk.len() as u64) as usize;
            file.write_all(&chunk[..count])
                .expect("write benchmark file");
            remaining -= count as u64;
        }
        file.flush().expect("flush benchmark file");
    }

    fn local_benchmark_inventory(path: &Path) -> (u64, u64) {
        let metadata = fs::metadata(path).expect("read downloaded benchmark metadata");
        if metadata.is_file() {
            return (metadata.len(), 1);
        }
        let mut total_bytes = 0;
        let mut total_files = 0;
        for entry in fs::read_dir(path).expect("read downloaded benchmark directory") {
            let (bytes, files) =
                local_benchmark_inventory(&entry.expect("read benchmark entry").path());
            total_bytes += bytes;
            total_files += files;
        }
        (total_bytes, total_files)
    }

    fn take_transfer_metric(operation_id: &str) -> String {
        let mut records = TEST_TRANSFER_METRIC_RECORDS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let index = records
            .iter()
            .position(|record| record.contains(operation_id))
            .unwrap_or_else(|| panic!("missing transfer metrics for {operation_id}"));
        records.remove(index)
    }

    fn assert_benchmark_metric(
        record: &str,
        operation: &str,
        password: &str,
        total_bytes: u64,
        total_files: u64,
    ) {
        for field in [
            format!("operation={operation}"),
            "status=completed".to_string(),
            "connect_us=".to_string(),
            "scan_us=".to_string(),
            "transfer_us=".to_string(),
            "finalize_us=".to_string(),
            "total_us=".to_string(),
            format!("total_bytes={total_bytes}"),
            format!("file_count={total_files}"),
            "throughput_bytes_per_second=".to_string(),
        ] {
            assert!(record.contains(&field), "missing {field} in {record}");
        }
        assert!(
            !record.contains(password),
            "transfer metrics must not contain credentials"
        );
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service and is run by scripts/run-sftp-benchmark.ps1"]
    fn isolated_sftp_transfer_benchmark() {
        let host =
            std::env::var("TERMBRIDGE_E2E_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = std::env::var("TERMBRIDGE_E2E_SSH_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(22222);
        let username = std::env::var("TERMBRIDGE_E2E_SSH_USERNAME")
            .unwrap_or_else(|_| "termbridge".to_string());
        let password = std::env::var("TERMBRIDGE_E2E_SSH_PASSWORD")
            .unwrap_or_else(|_| "termbridge-e2e".to_string());
        let iterations = benchmark_env_u64("TERMBRIDGE_SFTP_BENCH_ITERATIONS", 3);
        let large_bytes = benchmark_env_u64("TERMBRIDGE_SFTP_BENCH_LARGE_BYTES", 16 * 1024 * 1024);
        let small_file_count = benchmark_env_u64("TERMBRIDGE_SFTP_BENCH_SMALL_FILE_COUNT", 128);
        let small_file_bytes =
            benchmark_env_u64("TERMBRIDGE_SFTP_BENCH_SMALL_FILE_BYTES", 4 * 1024);
        let connection = RemoteConnectionRequest {
            host: host.clone(),
            port,
            username,
            auth_method: crate::models::AuthMethod::Password,
            password: Some(password.clone()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        };
        let (_known_hosts_temp, known_hosts) =
            crate::connection::trusted_known_hosts_fixture(&host, port);
        let local_root = tempfile::tempdir().expect("create benchmark workspace");
        let remote_root = format!(
            "/home/termbridge/upload/termbridge-benchmark-{}",
            Uuid::new_v4()
        );
        let emitter = NoopTransferEventEmitter;
        TEST_TRANSFER_METRIC_RECORDS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();

        let large_path = local_root.path().join("large.bin");
        write_benchmark_file(&large_path, large_bytes);
        let small_directory = local_root.path().join("small-files");
        fs::create_dir(&small_directory).expect("create small-file benchmark directory");
        for index in 0..small_file_count {
            write_benchmark_file(
                &small_directory.join(format!("file-{index:04}.bin")),
                small_file_bytes,
            );
        }

        for (scenario, local_path, source_name, total_bytes, total_files) in [
            (
                "large-file",
                large_path.as_path(),
                "large.bin",
                large_bytes,
                1,
            ),
            (
                "many-small-files",
                small_directory.as_path(),
                "small-files",
                small_file_count * small_file_bytes,
                small_file_count,
            ),
        ] {
            for iteration in 1..=iterations {
                let case_root = format!("{remote_root}/{scenario}/{iteration}");
                let upload_directory = format!("{case_root}/upload");
                let copy_directory = format!("{case_root}/copy");
                let uploaded_path = format!("{upload_directory}/{source_name}");
                let copied_path = format!("{copy_directory}/{source_name}");
                let download_directory = local_root
                    .path()
                    .join(format!("download-{scenario}-{iteration}"));
                let id_prefix = format!("sftp-benchmark-{scenario}-{iteration}");
                let upload_id = format!("{id_prefix}-upload");
                let copy_id = format!("{id_prefix}-copy");
                let download_id = format!("{id_prefix}-download");

                let upload = upload_local_paths_inner(
                    emitter,
                    UploadLocalPathsRequest {
                        connection: connection.clone(),
                        destination_directory: upload_directory,
                        local_paths: vec![path_to_string(local_path)],
                        conflict_policies: Vec::new(),
                        operation_id: upload_id.clone(),
                    },
                    Arc::new(AtomicBool::new(false)),
                    Some(&known_hosts),
                )
                .expect("benchmark upload should succeed");
                assert!(
                    upload
                        .items
                        .iter()
                        .all(|item| item.status == TransferItemStatus::Completed),
                    "every benchmark upload item should complete"
                );

                copy_remote_to_remote_blocking(
                    emitter,
                    CopyRemoteToRemoteRequest {
                        source_connection: connection.clone(),
                        destination_connection: connection.clone(),
                        source_paths: vec![uploaded_path],
                        destination_directory: copy_directory,
                        conflict_policies: Vec::new(),
                        operation_id: copy_id.clone(),
                    },
                    Arc::new(AtomicBool::new(false)),
                    None,
                    Some(&known_hosts),
                )
                .expect("benchmark remote copy should succeed");

                let download = download_remote_paths_inner(
                    emitter,
                    DownloadRemotePathsRequest {
                        connection: connection.clone(),
                        remote_paths: vec![copied_path],
                        destination_directory: path_to_string(&download_directory),
                        conflict_policies: Vec::new(),
                        operation_id: download_id.clone(),
                    },
                    Arc::new(AtomicBool::new(false)),
                    Some(&known_hosts),
                )
                .expect("benchmark download should succeed");
                assert!(
                    download
                        .items
                        .iter()
                        .all(|item| item.status == TransferItemStatus::Completed),
                    "every benchmark download item should complete"
                );
                assert_eq!(
                    local_benchmark_inventory(&download_directory.join(source_name)),
                    (total_bytes, total_files),
                    "downloaded benchmark inventory should match the source"
                );

                for (operation_id, operation) in [
                    (&upload_id, "upload"),
                    (&copy_id, "remote_copy"),
                    (&download_id, "download"),
                ] {
                    let record = take_transfer_metric(operation_id);
                    assert_benchmark_metric(
                        &record,
                        operation,
                        &password,
                        total_bytes,
                        total_files,
                    );
                    println!("SFTP_BENCHMARK scenario={scenario} iteration={iteration} {record}");
                }
            }
        }

        let connected = connect_sftp(&connection, None, Some(&known_hosts))
            .expect("connect for benchmark cleanup");
        let connected = connected
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        remove_remote_entry_simple(&connected.sftp, Path::new(&remote_root))
            .expect("remove remote benchmark fixtures");
    }
}
