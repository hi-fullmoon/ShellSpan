use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use ssh2::{OpenFlags, OpenType, RenameFlags, Sftp};
use tempfile::NamedTempFile;
use uuid::Uuid;

use crate::agent_runtime::{
    AgentToolCallNative, AgentToolTargetNative, ApplyPatchArgumentsNative, FileEncodingNative,
    ListDirectoryArgumentsNative, ReadFileArgumentsNative, SearchModeNative,
    SearchTextArgumentsNative, TransferDirectionNative, TransferFileArgumentsNative,
};
use crate::connection::connect_sftp;
use crate::db::Database;
use crate::keychain::CredentialManager;

use super::{
    connection_for_remote_target, sha256_hex, AgentFileCheckpointNative,
    CheckpointOriginalMetadataNative, CheckpointStoreNative, CheckpointTargetKindNative,
};

const DEFAULT_READ_BYTES: u64 = 256 * 1024;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const DEFAULT_PAGE_SIZE: usize = 100;
const MAX_SEARCH_FILES: usize = 10_000;
const MAX_SEARCH_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SEARCH_LINE_BYTES: usize = 4_096;
const DEFAULT_TRANSFER_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TRANSFER_BYTES: u64 = 256 * 1024 * 1024;

type ActiveFileOperationsNative = Arc<Mutex<HashMap<(String, String), Arc<AtomicBool>>>>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentCallPreviewNative {
    pub(crate) tool_name: String,
    pub(crate) target_id: String,
    pub(crate) summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) diff: Option<String>,
}

pub(super) struct FileToolOutputNative {
    pub(super) summary: String,
    pub(super) data: Value,
    pub(super) truncated: bool,
    pub(super) paths: Vec<String>,
}

#[derive(Clone, Default)]
pub(crate) struct FileOperationRegistryNative {
    operations: ActiveFileOperationsNative,
}

struct FileOperationGuardNative {
    registry: FileOperationRegistryNative,
    task_id: String,
    call_id: String,
    flag: Arc<AtomicBool>,
}

impl FileOperationRegistryNative {
    fn begin(&self, task_id: &str, call_id: &str) -> Result<FileOperationGuardNative, String> {
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| "file operation registry is unavailable".to_string())?;
        let key = (task_id.to_string(), call_id.to_string());
        if operations.contains_key(&key) {
            return Err("file operation id is already active".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        operations.insert(key.clone(), Arc::clone(&flag));
        Ok(FileOperationGuardNative {
            registry: self.clone(),
            task_id: key.0,
            call_id: key.1,
            flag,
        })
    }

    pub(super) fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| "file operation registry is unavailable".to_string())?;
        for ((owner_task_id, _), flag) in operations.iter() {
            if owner_task_id == task_id {
                flag.store(true, Ordering::SeqCst);
            }
        }
        Ok(())
    }
}

impl FileOperationGuardNative {
    fn ensure_active(&self) -> Result<(), String> {
        if self.flag.load(Ordering::SeqCst) {
            Err("file operation was cancelled".into())
        } else {
            Ok(())
        }
    }
}

impl Drop for FileOperationGuardNative {
    fn drop(&mut self) {
        if let Ok(mut operations) = self.registry.operations.lock() {
            operations.remove(&(self.task_id.clone(), self.call_id.clone()));
        }
    }
}

pub(super) struct FileExecutionContextNative<'a> {
    pub(super) task_id: &'a str,
    pub(super) call: &'a AgentToolCallNative,
    pub(super) database: &'a Database,
    pub(super) credentials: &'a CredentialManager,
    pub(super) known_hosts_path: &'a Path,
    pub(super) checkpoint_root: &'a Path,
    pub(super) checkpoints: &'a CheckpointStoreNative,
    pub(super) operations: &'a FileOperationRegistryNative,
}

pub(super) fn preview_file_call_native(
    call: &AgentToolCallNative,
    database: &Database,
    credentials: &CredentialManager,
    known_hosts_path: &Path,
) -> Result<AgentCallPreviewNative, String> {
    match call.tool_name.as_str() {
        "apply_patch" => {
            let arguments: ApplyPatchArgumentsNative =
                serde_json::from_value(call.arguments.clone())
                    .map_err(|error| format!("invalid apply_patch arguments: {error}"))?;
            let preview = compute_patch_preview(
                &call.target,
                &arguments,
                database,
                credentials,
                known_hosts_path,
            )?;
            Ok(AgentCallPreviewNative {
                tool_name: call.tool_name.clone(),
                target_id: call.target.target_id().to_string(),
                summary: format!("Apply the exact reviewed diff to {}.", preview.path),
                path: Some(preview.path),
                diff: Some(preview.diff),
            })
        }
        "transfer_file" => {
            let arguments: TransferFileArgumentsNative =
                serde_json::from_value(call.arguments.clone())
                    .map_err(|error| format!("invalid transfer_file arguments: {error}"))?;
            Ok(AgentCallPreviewNative {
                tool_name: call.tool_name.clone(),
                target_id: call.target.target_id().to_string(),
                summary: format!(
                    "Native SFTP {:?}: {} -> {} (overwrite: {}).",
                    arguments.direction,
                    arguments.source_path,
                    arguments.destination_path,
                    arguments.overwrite
                ),
                path: Some(arguments.destination_path),
                diff: None,
            })
        }
        _ => Ok(AgentCallPreviewNative {
            tool_name: call.tool_name.clone(),
            target_id: call.target.target_id().to_string(),
            summary: format!("Execute native {}.", call.tool_name),
            path: call
                .arguments
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_string),
            diff: None,
        }),
    }
}

pub(super) fn execute_file_tool_native(
    context: FileExecutionContextNative<'_>,
) -> Result<FileToolOutputNative, String> {
    let operation = context
        .operations
        .begin(context.task_id, &context.call.call_id)?;
    match context.call.tool_name.as_str() {
        "read_file" => execute_read_file(&context, &operation),
        "list_directory" => execute_list_directory(&context, &operation),
        "search_text" => execute_search_text(&context, &operation),
        "apply_patch" => execute_apply_patch(&context, &operation),
        "transfer_file" => execute_transfer_file(&context, &operation),
        _ => Err("tool has no native M2 file driver".into()),
    }
}

fn execute_read_file(
    context: &FileExecutionContextNative<'_>,
    operation: &FileOperationGuardNative,
) -> Result<FileToolOutputNative, String> {
    let arguments: ReadFileArgumentsNative = serde_json::from_value(context.call.arguments.clone())
        .map_err(|error| format!("invalid read_file arguments: {error}"))?;
    let requested_limit = arguments
        .max_bytes
        .unwrap_or(DEFAULT_READ_BYTES)
        .min(1_048_576);
    let limit = if arguments.encoding == FileEncodingNative::Base64 {
        requested_limit.min(786_432)
    } else {
        requested_limit
    };
    let (path, bytes, metadata) = read_target_file(
        &context.call.target,
        &arguments.path,
        context.database,
        context.credentials,
        context.known_hosts_path,
        operation,
        MAX_FILE_BYTES,
    )?;
    let digest = sha256_hex(&bytes);
    if arguments
        .expected_sha256
        .as_deref()
        .is_some_and(|expected| expected != digest)
    {
        return Err("read_file digest precondition failed".into());
    }
    let offset = arguments.offset.unwrap_or(0);
    if offset > bytes.len() as u64 {
        return Err("read_file offset is beyond the file".into());
    }
    let end = offset.saturating_add(limit).min(bytes.len() as u64);
    let slice = &bytes[offset as usize..end as usize];
    let truncated = end < bytes.len() as u64;
    let is_binary = detect_binary(&bytes);
    let content = match arguments.encoding {
        FileEncodingNative::Utf8 => {
            if is_binary {
                return Err("read_file refuses to decode binary content as UTF-8".into());
            }
            Some(
                std::str::from_utf8(slice)
                    .map_err(|_| "read_file content is not valid UTF-8".to_string())?
                    .to_string(),
            )
        }
        FileEncodingNative::Base64 => Some(STANDARD.encode(slice)),
        FileEncodingNative::MetadataOnly => None,
    };
    let sensitive = path_is_sensitive(&path);
    Ok(FileToolOutputNative {
        summary: "Read a bounded file through the native filesystem driver.".into(),
        data: json!({
            "path": path,
            "encoding": arguments.encoding,
            "byteLength": bytes.len(),
            "sha256": digest,
            "content": content,
            "offset": offset,
            "truncated": truncated,
            "isBinary": is_binary,
            "sensitive": sensitive,
            "untrusted": true,
            "permissions": metadata.permissions,
            "modifiedAtUnixMs": metadata.modified_unix_ms
        }),
        truncated,
        paths: vec![path],
    })
}

fn execute_list_directory(
    context: &FileExecutionContextNative<'_>,
    operation: &FileOperationGuardNative,
) -> Result<FileToolOutputNative, String> {
    let arguments: ListDirectoryArgumentsNative =
        serde_json::from_value(context.call.arguments.clone())
            .map_err(|error| format!("invalid list_directory arguments: {error}"))?;
    let (path, mut entries) = list_target_directory(
        &context.call.target,
        &arguments.path,
        arguments.include_hidden.unwrap_or(false),
        context.database,
        context.credentials,
        context.known_hosts_path,
        operation,
    )?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let digest = listing_digest(&entries)?;
    let offset = decode_cursor(arguments.cursor.as_deref(), &digest)?;
    let page_size = arguments.page_size.map_or(DEFAULT_PAGE_SIZE, usize::from);
    if offset > entries.len() {
        return Err("directory cursor is outside the current listing".into());
    }
    let mut end = offset.saturating_add(page_size).min(entries.len());
    while end > offset
        && serde_json::to_vec(&entries[offset..end])
            .map_err(|error| format!("failed to bound directory output: {error}"))?
            .len()
            > 240 * 1024
    {
        end -= 1;
    }
    if end == offset && offset < entries.len() {
        return Err("one directory entry exceeds the native output limit".into());
    }
    let next_cursor = (end < entries.len()).then(|| encode_cursor(end, &digest));
    let page = entries[offset..end].to_vec();
    Ok(FileToolOutputNative {
        summary: "Listed one bounded native directory page.".into(),
        data: json!({
            "path": path,
            "entries": page,
            "nextCursor": next_cursor,
            "sensitive": page.iter().any(|entry| entry.sensitive),
            "untrusted": true
        }),
        truncated: next_cursor.is_some(),
        paths: vec![path],
    })
}

fn execute_search_text(
    context: &FileExecutionContextNative<'_>,
    operation: &FileOperationGuardNative,
) -> Result<FileToolOutputNative, String> {
    let arguments: SearchTextArgumentsNative =
        serde_json::from_value(context.call.arguments.clone())
            .map_err(|error| format!("invalid search_text arguments: {error}"))?;
    let (root, mut matches, bounds_hit) = search_target(
        &context.call.target,
        &arguments,
        context.database,
        context.credentials,
        context.known_hosts_path,
        operation,
    )?;
    matches.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then(left.line.cmp(&right.line))
            .then(left.column.cmp(&right.column))
    });
    let digest = listing_digest(&matches)?;
    let offset = decode_cursor(arguments.cursor.as_deref(), &digest)?;
    if offset > matches.len() {
        return Err("search cursor is outside the current result set".into());
    }
    let page_size = usize::from(arguments.max_results.unwrap_or(100));
    let mut end = offset.saturating_add(page_size).min(matches.len());
    while end > offset
        && serde_json::to_vec(&matches[offset..end])
            .map_err(|error| format!("failed to bound search output: {error}"))?
            .len()
            > 1_000_000
    {
        end -= 1;
    }
    if end == offset && offset < matches.len() {
        return Err("one search result exceeds the native output limit".into());
    }
    let next_cursor = (end < matches.len()).then(|| encode_cursor(end, &digest));
    let page = matches[offset..end].to_vec();
    let truncated = bounds_hit || next_cursor.is_some();
    Ok(FileToolOutputNative {
        summary: "Completed a bounded native text search.".into(),
        data: json!({
            "rootPath": root,
            "matches": page,
            "nextCursor": next_cursor,
            "truncated": truncated,
            "sensitive": page.iter().any(|entry| entry.sensitive),
            "untrusted": true
        }),
        truncated,
        paths: vec![root],
    })
}

fn execute_apply_patch(
    context: &FileExecutionContextNative<'_>,
    operation: &FileOperationGuardNative,
) -> Result<FileToolOutputNative, String> {
    operation.ensure_active()?;
    let arguments: ApplyPatchArgumentsNative =
        serde_json::from_value(context.call.arguments.clone())
            .map_err(|error| format!("invalid apply_patch arguments: {error}"))?;
    let preview = compute_patch_preview(
        &context.call.target,
        &arguments,
        context.database,
        context.credentials,
        context.known_hosts_path,
    )?;
    if arguments.dry_run.unwrap_or(false) {
        return Ok(FileToolOutputNative {
            summary: "Validated the exact patch without writing.".into(),
            data: json!({
                "applied": false,
                "diff": preview.diff,
                "files": [{
                    "path": preview.path,
                    "beforeSha256": preview.before_sha256,
                    "afterSha256": preview.after_sha256
                }]
            }),
            truncated: false,
            paths: vec![preview.path],
        });
    }
    let checkpoint = checkpoint_target_file(
        context,
        &preview.path,
        Some(&preview.before),
        preview.metadata.clone(),
    )?;
    operation.ensure_active()?;
    write_target_file(
        &context.call.target,
        &preview.path,
        &preview.after,
        Some(&preview.before_sha256),
        context.database,
        context.credentials,
        context.known_hosts_path,
        operation,
    )?;
    let (_, verified, _) = read_target_file(
        &context.call.target,
        &preview.path,
        context.database,
        context.credentials,
        context.known_hosts_path,
        operation,
        MAX_FILE_BYTES,
    )?;
    if sha256_hex(&verified) != preview.after_sha256 || verified != preview.after {
        return Err("apply_patch write verification failed".into());
    }
    Ok(FileToolOutputNative {
        summary: "Applied, re-read, and verified the exact native patch.".into(),
        data: json!({
            "applied": true,
            "diff": preview.diff,
            "checkpointId": checkpoint.checkpoint_id,
            "verified": true,
            "files": [{
                "path": preview.path,
                "beforeSha256": preview.before_sha256,
                "afterSha256": preview.after_sha256
            }]
        }),
        truncated: false,
        paths: vec![preview.path],
    })
}

fn execute_transfer_file(
    context: &FileExecutionContextNative<'_>,
    operation: &FileOperationGuardNative,
) -> Result<FileToolOutputNative, String> {
    let arguments: TransferFileArgumentsNative =
        serde_json::from_value(context.call.arguments.clone())
            .map_err(|error| format!("invalid transfer_file arguments: {error}"))?;
    let expected = arguments
        .expected_sha256
        .as_deref()
        .ok_or_else(|| "transfer_file requires an expected source digest".to_string())?;
    let max_bytes = arguments
        .max_bytes
        .unwrap_or(DEFAULT_TRANSFER_BYTES)
        .min(MAX_TRANSFER_BYTES);
    let AgentToolTargetNative::Remote {
        root_path: Some(remote_root),
        local_root: Some(local_root),
        ..
    } = &context.call.target
    else {
        return Err(
            "native SFTP transfer requires a remote target with remote and local roots".into(),
        );
    };
    let connection =
        connection_for_remote_target(&context.call.target, context.database, context.credentials)?;
    let connected = connect_sftp(&connection, None, Some(context.known_hosts_path))
        .map_err(|error| format!("native SFTP connection failed: {error:?}"))?;
    let connected = connected
        .lock()
        .map_err(|_| "native SFTP connection is unavailable".to_string())?;
    let sftp = &connected.sftp;
    let remote_root = resolve_remote_root(sftp, remote_root)?;
    let local_root = canonical_local_root(Path::new(local_root))?;

    let (source_path, destination_path, bytes, checkpoint) = match arguments.direction {
        TransferDirectionNative::Upload => {
            let local_source = resolve_local_existing(&local_root, &arguments.source_path, false)?;
            let bytes = read_local_bounded(&local_source, max_bytes, operation)?;
            if sha256_hex(&bytes) != expected {
                return Err("transfer_file source digest precondition failed".into());
            }
            let remote_destination =
                resolve_remote_path(sftp, &remote_root, &arguments.destination_path, true)?;
            let existing = read_remote_optional(sftp, &remote_destination, max_bytes, operation)?;
            validate_overwrite_precondition(&arguments, existing.as_deref())?;
            let checkpoint = checkpoint_target_file_with_kind(
                context,
                &remote_destination,
                existing.as_deref(),
                CheckpointOriginalMetadataNative::default(),
                CheckpointTargetKindNative::Remote,
            )?;
            write_remote_atomic(
                sftp,
                &remote_root,
                &remote_destination,
                &bytes,
                existing.as_deref().map(sha256_hex).as_deref(),
                operation,
            )?;
            let verified = read_remote_bounded(sftp, &remote_destination, max_bytes, operation)?;
            if sha256_hex(&verified) != expected {
                return Err("remote upload digest verification failed".into());
            }
            (
                local_source.to_string_lossy().to_string(),
                remote_destination,
                bytes,
                checkpoint,
            )
        }
        TransferDirectionNative::Download => {
            let remote_source =
                resolve_remote_path(sftp, &remote_root, &arguments.source_path, false)?;
            let bytes = read_remote_bounded(sftp, &remote_source, max_bytes, operation)?;
            if sha256_hex(&bytes) != expected {
                return Err("transfer_file source digest precondition failed".into());
            }
            let local_destination =
                resolve_local_destination(&local_root, &arguments.destination_path)?;
            let existing = read_local_optional(&local_destination, max_bytes, operation)?;
            validate_overwrite_precondition(&arguments, existing.as_deref())?;
            let checkpoint = checkpoint_target_file_with_kind(
                context,
                &local_destination.to_string_lossy(),
                existing.as_deref(),
                local_metadata(&local_destination).unwrap_or_default(),
                CheckpointTargetKindNative::Local,
            )?;
            write_local_atomic(
                &local_root,
                &local_destination,
                &bytes,
                existing.as_deref().map(sha256_hex).as_deref(),
                operation,
            )?;
            let verified = read_local_bounded(&local_destination, max_bytes, operation)?;
            if sha256_hex(&verified) != expected {
                return Err("local download digest verification failed".into());
            }
            (
                remote_source,
                local_destination.to_string_lossy().to_string(),
                bytes,
                checkpoint,
            )
        }
    };
    Ok(FileToolOutputNative {
        summary: "Transferred the file with native SFTP and verified its digest.".into(),
        data: json!({
            "direction": arguments.direction,
            "sourcePath": source_path,
            "destinationPath": destination_path,
            "bytesTransferred": bytes.len(),
            "sha256": expected,
            "checkpointId": checkpoint.checkpoint_id,
            "verified": true
        }),
        truncated: false,
        paths: vec![destination_path],
    })
}

fn validate_overwrite_precondition(
    arguments: &TransferFileArgumentsNative,
    existing: Option<&[u8]>,
) -> Result<(), String> {
    match existing {
        None => {
            if arguments.destination_sha256.is_some() {
                Err("transfer destination disappeared before write".into())
            } else {
                Ok(())
            }
        }
        Some(_) if !arguments.overwrite => Err("transfer destination already exists".into()),
        Some(content) => {
            let expected = arguments.destination_sha256.as_deref().ok_or_else(|| {
                "overwrite requires the destination digest precondition".to_string()
            })?;
            if sha256_hex(content) != expected {
                Err("transfer destination digest precondition failed".into())
            } else {
                Ok(())
            }
        }
    }
}

#[derive(Clone)]
struct PatchPreviewNative {
    path: String,
    before: Vec<u8>,
    after: Vec<u8>,
    before_sha256: String,
    after_sha256: String,
    diff: String,
    metadata: CheckpointOriginalMetadataNative,
}

fn compute_patch_preview(
    target: &AgentToolTargetNative,
    arguments: &ApplyPatchArgumentsNative,
    database: &Database,
    credentials: &CredentialManager,
    known_hosts_path: &Path,
) -> Result<PatchPreviewNative, String> {
    if arguments.preconditions.len() != 1 {
        return Err("M2 apply_patch accepts exactly one digest-bound file per call".into());
    }
    let precondition = &arguments.preconditions[0];
    let operation_registry = FileOperationRegistryNative::default();
    let operation = operation_registry.begin("preview", "preview")?;
    let (path, before, metadata) = read_target_file(
        target,
        &precondition.path,
        database,
        credentials,
        known_hosts_path,
        &operation,
        MAX_FILE_BYTES,
    )?;
    let before_sha256 = sha256_hex(&before);
    if before_sha256 != precondition.sha256 {
        return Err("apply_patch digest precondition failed".into());
    }
    let before_text = std::str::from_utf8(&before)
        .map_err(|_| "apply_patch only supports UTF-8 text files".to_string())?;
    let patch = diffy::Patch::from_str(&arguments.patch)
        .map_err(|error| format!("apply_patch diff is invalid: {error}"))?;
    let after_text = diffy::apply(before_text, &patch)
        .map_err(|error| format!("apply_patch diff does not match the file: {error}"))?;
    let after = after_text.into_bytes();
    if after.len() as u64 > MAX_FILE_BYTES {
        return Err("patched file exceeds the native size limit".into());
    }
    let diff = diffy::create_patch(before_text, std::str::from_utf8(&after).unwrap()).to_string();
    if diff.trim().is_empty() {
        return Err("apply_patch produces no change".into());
    }
    if diff.len() > 240 * 1024 {
        return Err("apply_patch exact diff exceeds the native output limit".into());
    }
    Ok(PatchPreviewNative {
        path,
        before,
        after_sha256: sha256_hex(&after),
        after,
        before_sha256,
        diff,
        metadata,
    })
}

fn checkpoint_target_file(
    context: &FileExecutionContextNative<'_>,
    path: &str,
    original: Option<&[u8]>,
    metadata: CheckpointOriginalMetadataNative,
) -> Result<AgentFileCheckpointNative, String> {
    let kind = match context.call.target {
        AgentToolTargetNative::Local { .. } => CheckpointTargetKindNative::Local,
        AgentToolTargetNative::Remote { .. } => CheckpointTargetKindNative::Remote,
        _ => return Err("file checkpoint requires a host target".into()),
    };
    checkpoint_target_file_with_kind(context, path, original, metadata, kind)
}

fn checkpoint_target_file_with_kind(
    context: &FileExecutionContextNative<'_>,
    path: &str,
    original: Option<&[u8]>,
    metadata: CheckpointOriginalMetadataNative,
    kind: CheckpointTargetKindNative,
) -> Result<AgentFileCheckpointNative, String> {
    context.checkpoints.create(
        context.checkpoint_root,
        context.task_id,
        context.call.target.target_id(),
        kind,
        path,
        original,
        metadata,
    )
}

fn read_target_file(
    target: &AgentToolTargetNative,
    requested_path: &str,
    database: &Database,
    credentials: &CredentialManager,
    known_hosts_path: &Path,
    operation: &FileOperationGuardNative,
    limit: u64,
) -> Result<(String, Vec<u8>, CheckpointOriginalMetadataNative), String> {
    match target {
        AgentToolTargetNative::Local {
            cwd: Some(root), ..
        } => {
            let root = canonical_local_root(Path::new(root))?;
            let path = resolve_local_existing(&root, requested_path, false)?;
            let bytes = read_local_bounded(&path, limit, operation)?;
            Ok((
                path.to_string_lossy().to_string(),
                bytes,
                local_metadata(&path).unwrap_or_default(),
            ))
        }
        AgentToolTargetNative::Remote {
            root_path: Some(root),
            ..
        } => {
            let connection = connection_for_remote_target(target, database, credentials)?;
            let connected = connect_sftp(&connection, None, Some(known_hosts_path))
                .map_err(|error| format!("native SFTP connection failed: {error:?}"))?;
            let connected = connected
                .lock()
                .map_err(|_| "native SFTP connection is unavailable".to_string())?;
            let root = resolve_remote_root(&connected.sftp, root)?;
            let path = resolve_remote_path(&connected.sftp, &root, requested_path, false)?;
            let stat = connected
                .sftp
                .stat(Path::new(&path))
                .map_err(|error| format!("failed to inspect remote file: {error}"))?;
            let bytes = read_remote_bounded(&connected.sftp, &path, limit, operation)?;
            Ok((
                path,
                bytes,
                CheckpointOriginalMetadataNative {
                    permissions: stat.perm,
                    modified_unix_ms: stat.mtime.map(|value| value.saturating_mul(1_000)),
                },
            ))
        }
        AgentToolTargetNative::Local { cwd: None, .. } => {
            Err("local file tools require a frozen cwd root".into())
        }
        AgentToolTargetNative::Remote {
            root_path: None, ..
        } => Err("remote file tools require a frozen rootPath".into()),
        _ => Err("file tool requires a local or remote target".into()),
    }
}

fn write_target_file(
    target: &AgentToolTargetNative,
    requested_path: &str,
    content: &[u8],
    expected_before: Option<&str>,
    database: &Database,
    credentials: &CredentialManager,
    known_hosts_path: &Path,
    operation: &FileOperationGuardNative,
) -> Result<(), String> {
    match target {
        AgentToolTargetNative::Local {
            cwd: Some(root), ..
        } => {
            let root = canonical_local_root(Path::new(root))?;
            let path = resolve_local_destination(&root, requested_path)?;
            write_local_atomic(&root, &path, content, expected_before, operation)
        }
        AgentToolTargetNative::Remote {
            root_path: Some(root),
            ..
        } => {
            let connection = connection_for_remote_target(target, database, credentials)?;
            let connected = connect_sftp(&connection, None, Some(known_hosts_path))
                .map_err(|error| format!("native SFTP connection failed: {error:?}"))?;
            let connected = connected
                .lock()
                .map_err(|_| "native SFTP connection is unavailable".to_string())?;
            let root = resolve_remote_root(&connected.sftp, root)?;
            let path = resolve_remote_path(&connected.sftp, &root, requested_path, true)?;
            write_remote_atomic(
                &connected.sftp,
                &root,
                &path,
                content,
                expected_before,
                operation,
            )
        }
        _ => Err("file write requires a path-scoped host target".into()),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectoryEntryNative {
    name: String,
    path: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    byte_length: Option<u64>,
    sensitive: bool,
}

fn list_target_directory(
    target: &AgentToolTargetNative,
    requested_path: &str,
    include_hidden: bool,
    database: &Database,
    credentials: &CredentialManager,
    known_hosts_path: &Path,
    operation: &FileOperationGuardNative,
) -> Result<(String, Vec<DirectoryEntryNative>), String> {
    operation.ensure_active()?;
    match target {
        AgentToolTargetNative::Local {
            cwd: Some(root), ..
        } => {
            let root = canonical_local_root(Path::new(root))?;
            let path = resolve_local_existing(&root, requested_path, true)?;
            let mut entries = Vec::new();
            for entry in fs::read_dir(&path)
                .map_err(|error| format!("failed to list local directory: {error}"))?
            {
                operation.ensure_active()?;
                let entry =
                    entry.map_err(|error| format!("failed to inspect local entry: {error}"))?;
                let name = entry.file_name().to_string_lossy().to_string();
                if !include_hidden && name.starts_with('.') {
                    continue;
                }
                let entry_path = entry.path();
                let metadata = fs::symlink_metadata(&entry_path)
                    .map_err(|error| format!("failed to inspect local entry: {error}"))?;
                entries.push(DirectoryEntryNative {
                    name,
                    path: entry_path.to_string_lossy().to_string(),
                    kind: file_kind(metadata.file_type()),
                    byte_length: metadata.is_file().then_some(metadata.len()),
                    sensitive: path_is_sensitive(&entry_path.to_string_lossy()),
                });
            }
            Ok((path.to_string_lossy().to_string(), entries))
        }
        AgentToolTargetNative::Remote {
            root_path: Some(root),
            ..
        } => {
            let connection = connection_for_remote_target(target, database, credentials)?;
            let connected = connect_sftp(&connection, None, Some(known_hosts_path))
                .map_err(|error| format!("native SFTP connection failed: {error:?}"))?;
            let connected = connected
                .lock()
                .map_err(|_| "native SFTP connection is unavailable".to_string())?;
            let root = resolve_remote_root(&connected.sftp, root)?;
            let path = resolve_remote_path(&connected.sftp, &root, requested_path, false)?;
            let stat = connected
                .sftp
                .lstat(Path::new(&path))
                .map_err(|error| format!("failed to inspect remote directory: {error}"))?;
            if remote_kind(stat.perm) != "directory" {
                return Err("remote list path is not a directory".into());
            }
            let mut entries = Vec::new();
            for (entry_path, stat) in connected
                .sftp
                .readdir(Path::new(&path))
                .map_err(|error| format!("failed to list remote directory: {error}"))?
            {
                operation.ensure_active()?;
                let name = entry_path
                    .file_name()
                    .map(|value| value.to_string_lossy().to_string())
                    .unwrap_or_default();
                if name.is_empty()
                    || name == "."
                    || name == ".."
                    || (!include_hidden && name.starts_with('.'))
                {
                    continue;
                }
                let path = slash_path(&entry_path);
                let kind = remote_kind(stat.perm);
                entries.push(DirectoryEntryNative {
                    name,
                    path: path.clone(),
                    kind,
                    byte_length: (kind == "file").then_some(stat.size.unwrap_or(0)),
                    sensitive: path_is_sensitive(&path),
                });
            }
            Ok((path, entries))
        }
        _ => Err("list_directory requires a path-scoped host target".into()),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchMatchNative {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    column: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
    sensitive: bool,
}

fn search_target(
    target: &AgentToolTargetNative,
    arguments: &SearchTextArgumentsNative,
    database: &Database,
    credentials: &CredentialManager,
    known_hosts_path: &Path,
    operation: &FileOperationGuardNative,
) -> Result<(String, Vec<SearchMatchNative>, bool), String> {
    match target {
        AgentToolTargetNative::Local {
            cwd: Some(root), ..
        } => {
            let root = canonical_local_root(Path::new(root))?;
            let search_root = resolve_local_existing(&root, &arguments.path, true)?;
            let mut files = Vec::new();
            collect_local_files(&search_root, &mut files, operation)?;
            let mut matches = Vec::new();
            let mut bytes_read = 0_u64;
            let mut bounds_hit = files.len() >= MAX_SEARCH_FILES;
            for file in files.into_iter().take(MAX_SEARCH_FILES) {
                operation.ensure_active()?;
                if !matches_globs(&file.to_string_lossy(), &arguments.globs) {
                    continue;
                }
                let display = file.to_string_lossy().to_string();
                if matches!(
                    arguments.mode,
                    SearchModeNative::FileName | SearchModeNative::Both
                ) && contains_query(
                    file.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default(),
                    &arguments.query,
                    arguments.case_sensitive.unwrap_or(false),
                ) {
                    matches.push(SearchMatchNative {
                        path: display.clone(),
                        line: None,
                        column: None,
                        preview: None,
                        sensitive: path_is_sensitive(&display),
                    });
                }
                if matches!(
                    arguments.mode,
                    SearchModeNative::Content | SearchModeNative::Both
                ) {
                    let metadata = fs::metadata(&file)
                        .map_err(|error| format!("failed to inspect search file: {error}"))?;
                    if bytes_read.saturating_add(metadata.len()) > MAX_SEARCH_BYTES {
                        bounds_hit = true;
                        break;
                    }
                    bytes_read = bytes_read.saturating_add(metadata.len());
                    let bytes =
                        read_local_bounded(&file, metadata.len().min(MAX_FILE_BYTES), operation)?;
                    append_content_matches(&display, &bytes, arguments, &mut matches);
                }
            }
            Ok((
                search_root.to_string_lossy().to_string(),
                matches,
                bounds_hit,
            ))
        }
        AgentToolTargetNative::Remote {
            root_path: Some(root),
            ..
        } => {
            let connection = connection_for_remote_target(target, database, credentials)?;
            let connected = connect_sftp(&connection, None, Some(known_hosts_path))
                .map_err(|error| format!("native SFTP connection failed: {error:?}"))?;
            let connected = connected
                .lock()
                .map_err(|_| "native SFTP connection is unavailable".to_string())?;
            let root = resolve_remote_root(&connected.sftp, root)?;
            let search_root = resolve_remote_path(&connected.sftp, &root, &arguments.path, false)?;
            let mut files = Vec::new();
            collect_remote_files(&connected.sftp, &search_root, &mut files, operation)?;
            let mut matches = Vec::new();
            let mut bytes_read = 0_u64;
            let mut bounds_hit = files.len() >= MAX_SEARCH_FILES;
            for (file, size) in files.into_iter().take(MAX_SEARCH_FILES) {
                operation.ensure_active()?;
                if !matches_globs(&file, &arguments.globs) {
                    continue;
                }
                if matches!(
                    arguments.mode,
                    SearchModeNative::FileName | SearchModeNative::Both
                ) && contains_query(
                    file.rsplit('/').next().unwrap_or_default(),
                    &arguments.query,
                    arguments.case_sensitive.unwrap_or(false),
                ) {
                    matches.push(SearchMatchNative {
                        path: file.clone(),
                        line: None,
                        column: None,
                        preview: None,
                        sensitive: path_is_sensitive(&file),
                    });
                }
                if matches!(
                    arguments.mode,
                    SearchModeNative::Content | SearchModeNative::Both
                ) {
                    if bytes_read.saturating_add(size) > MAX_SEARCH_BYTES || size > MAX_FILE_BYTES {
                        bounds_hit = true;
                        break;
                    }
                    bytes_read = bytes_read.saturating_add(size);
                    let bytes = read_remote_bounded(&connected.sftp, &file, size, operation)?;
                    append_content_matches(&file, &bytes, arguments, &mut matches);
                }
            }
            Ok((search_root, matches, bounds_hit))
        }
        _ => Err("search_text requires a path-scoped host target".into()),
    }
}

fn append_content_matches(
    path: &str,
    bytes: &[u8],
    arguments: &SearchTextArgumentsNative,
    matches: &mut Vec<SearchMatchNative>,
) {
    if detect_binary(bytes) {
        return;
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return;
    };
    let case_sensitive = arguments.case_sensitive.unwrap_or(false);
    for (index, line) in text.lines().enumerate() {
        let Some(column) = find_query(line, &arguments.query, case_sensitive) else {
            continue;
        };
        let preview = truncate_utf8(line, MAX_SEARCH_LINE_BYTES);
        matches.push(SearchMatchNative {
            path: path.to_string(),
            line: Some(index as u64 + 1),
            column: Some(column as u64 + 1),
            preview: Some(preview),
            sensitive: path_is_sensitive(path),
        });
    }
}

fn collect_local_files(
    root: &Path,
    files: &mut Vec<PathBuf>,
    operation: &FileOperationGuardNative,
) -> Result<(), String> {
    if files.len() >= MAX_SEARCH_FILES {
        return Ok(());
    }
    for entry in fs::read_dir(root)
        .map_err(|error| format!("failed to traverse local search root: {error}"))?
    {
        operation.ensure_active()?;
        let entry = entry.map_err(|error| format!("failed to inspect search entry: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("failed to inspect search entry: {error}"))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_local_files(&path, files, operation)?;
        } else if metadata.is_file() {
            files.push(path);
        }
        if files.len() >= MAX_SEARCH_FILES {
            break;
        }
    }
    Ok(())
}

fn collect_remote_files(
    sftp: &Sftp,
    root: &str,
    files: &mut Vec<(String, u64)>,
    operation: &FileOperationGuardNative,
) -> Result<(), String> {
    if files.len() >= MAX_SEARCH_FILES {
        return Ok(());
    }
    for (path, stat) in sftp
        .readdir(Path::new(root))
        .map_err(|error| format!("failed to traverse remote search root: {error}"))?
    {
        operation.ensure_active()?;
        let display = slash_path(&path);
        let kind = remote_kind(stat.perm);
        if kind == "symlink" {
            continue;
        }
        if kind == "directory" {
            collect_remote_files(sftp, &display, files, operation)?;
        } else if kind == "file" {
            files.push((display, stat.size.unwrap_or(0)));
        }
        if files.len() >= MAX_SEARCH_FILES {
            break;
        }
    }
    Ok(())
}

fn canonical_local_root(root: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("failed to inspect local root: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("local file root must be a real directory".into());
    }
    fs::canonicalize(root).map_err(|error| format!("failed to canonicalize local root: {error}"))
}

fn resolve_local_existing(
    root: &Path,
    requested: &str,
    directory: bool,
) -> Result<PathBuf, String> {
    let candidate = local_candidate(root, requested)?;
    if Path::new(requested).is_absolute() {
        ensure_absolute_no_symlink(&candidate)?;
    } else {
        ensure_no_local_symlink(root, &candidate, false)?;
    }
    let canonical = fs::canonicalize(&candidate)
        .map_err(|error| format!("failed to canonicalize scoped path: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("local path escapes the frozen root".into());
    }
    let metadata = fs::symlink_metadata(&canonical)
        .map_err(|error| format!("failed to inspect scoped path: {error}"))?;
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err("local path has the wrong kind or is a symlink".into());
    }
    Ok(canonical)
}

fn resolve_local_destination(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let candidate = local_candidate(root, requested)?;
    let parent = candidate
        .parent()
        .ok_or_else(|| "local destination has no parent".to_string())?;
    if Path::new(requested).is_absolute() {
        ensure_absolute_no_symlink(parent)?;
    } else {
        ensure_no_local_symlink(root, parent, false)?;
    }
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("failed to canonicalize destination parent: {error}"))?;
    if !canonical_parent.starts_with(root) {
        return Err("local destination escapes the frozen root".into());
    }
    let name = candidate
        .file_name()
        .ok_or_else(|| "local destination has no file name".to_string())?;
    let destination = canonical_parent.join(name);
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("local destination is not a regular file".into());
        }
    }
    Ok(destination)
}

fn local_candidate(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let requested = Path::new(requested);
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    if candidate
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("local path traversal is denied".into());
    }
    Ok(candidate)
}

fn ensure_no_local_symlink(
    root: &Path,
    path: &Path,
    allow_missing_leaf: bool,
) -> Result<(), String> {
    if !path.starts_with(root) {
        return Err("local path escapes the frozen root".into());
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "local path escapes the frozen root".to_string())?;
    let mut current = root.to_path_buf();
    let component_count = relative.components().count();
    for (index, component) in relative.components().enumerate() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("local symlink traversal is denied".into())
            }
            Ok(_) => {}
            Err(error)
                if allow_missing_leaf
                    && index + 1 == component_count
                    && error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to revalidate local path: {error}")),
        }
    }
    Ok(())
}

fn ensure_absolute_no_symlink(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    let mut root_seen = false;
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::RootDir) {
            root_seen = true;
        }
        if !root_seen {
            continue;
        }
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("failed to revalidate absolute local path: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("local symlink traversal is denied".into());
        }
    }
    Ok(())
}

fn read_local_optional(
    path: &Path,
    limit: u64,
    operation: &FileOperationGuardNative,
) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("local destination is not a regular file".into())
        }
        Ok(_) => read_local_bounded(path, limit, operation).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to inspect local file: {error}")),
    }
}

fn read_local_bounded(
    path: &Path,
    limit: u64,
    operation: &FileOperationGuardNative,
) -> Result<Vec<u8>, String> {
    operation.ensure_active()?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect local file: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > limit {
        return Err("local file failed native type or size bounds".into());
    }
    let mut file =
        File::open(path).map_err(|error| format!("failed to open local file: {error}"))?;
    read_stream_bounded(&mut file, limit, operation)
}

fn write_local_atomic(
    root: &Path,
    destination: &Path,
    content: &[u8],
    expected_before: Option<&str>,
    operation: &FileOperationGuardNative,
) -> Result<(), String> {
    operation.ensure_active()?;
    let parent = destination
        .parent()
        .ok_or_else(|| "local destination has no parent".to_string())?;
    ensure_no_local_symlink(root, parent, false)?;
    let current = read_local_optional(destination, MAX_TRANSFER_BYTES, operation)?;
    match (expected_before, current.as_deref()) {
        (Some(expected), Some(bytes)) if sha256_hex(bytes) == expected => {}
        (Some(_), _) => return Err("local file changed before atomic replacement".into()),
        (None, None) => {}
        (None, Some(_)) => {
            return Err("local destination appeared before atomic replacement".into())
        }
    }
    let mut temp = NamedTempFile::new_in(parent)
        .map_err(|error| format!("failed to create local write temp file: {error}"))?;
    let permissions = fs::metadata(destination)
        .ok()
        .map(|metadata| metadata.permissions());
    temp.write_all(content)
        .and_then(|()| temp.as_file().sync_all())
        .map_err(|error| format!("failed to write local temp file: {error}"))?;
    if let Some(permissions) = permissions {
        temp.as_file()
            .set_permissions(permissions)
            .map_err(|error| format!("failed to preserve local permissions: {error}"))?;
    }
    operation.ensure_active()?;
    ensure_no_local_symlink(root, parent, false)?;
    let current = read_local_optional(destination, MAX_TRANSFER_BYTES, operation)?;
    match (expected_before, current.as_deref()) {
        (Some(expected), Some(bytes)) if sha256_hex(bytes) == expected => {}
        (Some(_), _) => return Err("local file drifted during atomic replacement".into()),
        (None, None) => {}
        (None, Some(_)) => {
            return Err("local destination appeared during atomic replacement".into())
        }
    }
    temp.persist(destination)
        .map_err(|error| format!("failed to atomically replace local file: {}", error.error))?;
    Ok(())
}

fn local_metadata(path: &Path) -> Result<CheckpointOriginalMetadataNative, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(error) => return Err(format!("failed to inspect local metadata: {error}")),
    };
    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;
        Some(metadata.permissions().mode())
    };
    #[cfg(not(unix))]
    let permissions = None;
    let modified_unix_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|value| value.as_millis().try_into().ok());
    Ok(CheckpointOriginalMetadataNative {
        permissions,
        modified_unix_ms,
    })
}

fn resolve_remote_root(sftp: &Sftp, root: &str) -> Result<String, String> {
    let normalized = normalize_remote_absolute(root)?;
    let stat = sftp
        .lstat(Path::new(&normalized))
        .map_err(|error| format!("failed to inspect remote root: {error}"))?;
    if remote_kind(stat.perm) != "directory" {
        return Err("remote root is not a directory".into());
    }
    let canonical = slash_path(
        &sftp
            .realpath(Path::new(&normalized))
            .map_err(|error| format!("failed to canonicalize remote root: {error}"))?,
    );
    if canonical != normalized {
        return Err("remote root contains a symlink or identity drift".into());
    }
    Ok(canonical)
}

fn resolve_remote_path(
    sftp: &Sftp,
    root: &str,
    requested: &str,
    allow_missing_leaf: bool,
) -> Result<String, String> {
    if requested.contains('\\') {
        return Err("remote paths must use POSIX separators".into());
    }
    let candidate = if requested.starts_with('/') {
        normalize_remote_absolute(requested)?
    } else {
        normalize_remote_absolute(&format!("{}/{}", root.trim_end_matches('/'), requested))?
    };
    if !remote_path_within(root, &candidate) {
        return Err("remote path escapes the frozen root".into());
    }
    let relative = candidate
        .strip_prefix(root)
        .unwrap_or_default()
        .trim_start_matches('/');
    let components = relative
        .split('/')
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>();
    let mut current = root.trim_end_matches('/').to_string();
    if current.is_empty() {
        current.push('/');
    }
    for (index, component) in components.iter().enumerate() {
        if current == "/" {
            current.push_str(component);
        } else {
            current.push('/');
            current.push_str(component);
        }
        match sftp.lstat(Path::new(&current)) {
            Ok(stat) if remote_kind(stat.perm) == "symlink" => {
                return Err("remote symlink traversal is denied".into())
            }
            Ok(_) => {}
            Err(error)
                if allow_missing_leaf
                    && index + 1 == components.len()
                    && is_sftp_missing(&error) => {}
            Err(error) => return Err(format!("failed to revalidate remote path: {error}")),
        }
    }
    if !allow_missing_leaf || sftp.lstat(Path::new(&candidate)).is_ok() {
        let canonical = slash_path(
            &sftp
                .realpath(Path::new(&candidate))
                .map_err(|error| format!("failed to canonicalize remote path: {error}"))?,
        );
        if canonical != candidate || !remote_path_within(root, &canonical) {
            return Err("remote path identity drifted or escaped its root".into());
        }
    }
    Ok(candidate)
}

fn normalize_remote_absolute(path: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err("remote path must be absolute and contain no NUL".into());
    }
    let mut components = Vec::new();
    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => return Err("remote path traversal is denied".into()),
            value if value.chars().any(char::is_control) => {
                return Err("remote path contains control characters".into())
            }
            value => components.push(value),
        }
    }
    Ok(format!("/{}", components.join("/")))
}

fn remote_path_within(root: &str, path: &str) -> bool {
    root == "/"
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn read_remote_optional(
    sftp: &Sftp,
    path: &str,
    limit: u64,
    operation: &FileOperationGuardNative,
) -> Result<Option<Vec<u8>>, String> {
    match sftp.lstat(Path::new(path)) {
        Ok(stat) if remote_kind(stat.perm) != "file" => {
            Err("remote destination is not a regular file".into())
        }
        Ok(_) => read_remote_bounded(sftp, path, limit, operation).map(Some),
        Err(error) if is_sftp_missing(&error) => Ok(None),
        Err(error) => Err(format!("failed to inspect remote file: {error}")),
    }
}

fn read_remote_bounded(
    sftp: &Sftp,
    path: &str,
    limit: u64,
    operation: &FileOperationGuardNative,
) -> Result<Vec<u8>, String> {
    operation.ensure_active()?;
    let stat = sftp
        .lstat(Path::new(path))
        .map_err(|error| format!("failed to inspect remote file: {error}"))?;
    if remote_kind(stat.perm) != "file" || stat.size.unwrap_or(0) > limit {
        return Err("remote file failed native type or size bounds".into());
    }
    let mut file = sftp
        .open(Path::new(path))
        .map_err(|error| format!("failed to open remote file: {error}"))?;
    read_stream_bounded(&mut file, limit, operation)
}

fn write_remote_atomic(
    sftp: &Sftp,
    root: &str,
    destination: &str,
    content: &[u8],
    expected_before: Option<&str>,
    operation: &FileOperationGuardNative,
) -> Result<(), String> {
    operation.ensure_active()?;
    let parent = destination
        .rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .ok_or_else(|| "remote destination has no parent".to_string())?;
    let parent = resolve_remote_path(sftp, root, parent, false)?;
    let existing_permissions = sftp
        .lstat(Path::new(destination))
        .ok()
        .and_then(|stat| stat.perm);
    let current = read_remote_optional(sftp, destination, MAX_TRANSFER_BYTES, operation)?;
    match (expected_before, current.as_deref()) {
        (Some(expected), Some(bytes)) if sha256_hex(bytes) == expected => {}
        (Some(_), _) => return Err("remote file changed before atomic replacement".into()),
        (None, None) => {}
        (None, Some(_)) => {
            return Err("remote destination appeared before atomic replacement".into())
        }
    }
    let name = destination.rsplit('/').next().unwrap_or("file");
    let temp_path = format!("{parent}/.shellspan-{}-{name}", Uuid::new_v4().simple());
    let mut temp = sftp
        .open_mode(
            Path::new(&temp_path),
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE | OpenFlags::EXCLUSIVE,
            0o600,
            OpenType::File,
        )
        .map_err(|error| format!("failed to create remote temp file: {error}"))?;
    let write_result = write_stream(&mut temp, content, operation);
    if let Err(error) = write_result {
        let _ = sftp.unlink(Path::new(&temp_path));
        return Err(error);
    }
    temp.flush()
        .map_err(|error| format!("failed to flush remote temp file: {error}"))?;
    drop(temp);
    if let Some(permissions) = existing_permissions {
        sftp.setstat(
            Path::new(&temp_path),
            ssh2::FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: Some(permissions),
                atime: None,
                mtime: None,
            },
        )
        .map_err(|error| format!("failed to preserve remote permissions: {error}"))?;
    }
    let staged = read_remote_bounded(sftp, &temp_path, MAX_TRANSFER_BYTES, operation)?;
    if staged != content {
        let _ = sftp.unlink(Path::new(&temp_path));
        return Err("remote temp file digest verification failed".into());
    }
    operation.ensure_active()?;
    let _ = resolve_remote_path(sftp, root, &parent, false)?;
    let current = read_remote_optional(sftp, destination, MAX_TRANSFER_BYTES, operation)?;
    match (expected_before, current.as_deref()) {
        (Some(expected), Some(bytes)) if sha256_hex(bytes) == expected => {}
        (Some(_), _) => {
            let _ = sftp.unlink(Path::new(&temp_path));
            return Err("remote file drifted during atomic replacement".into());
        }
        (None, None) => {}
        (None, Some(_)) => {
            let _ = sftp.unlink(Path::new(&temp_path));
            return Err("remote destination appeared during atomic replacement".into());
        }
    }
    let backup_path = expected_before.map(|_| {
        format!(
            "{parent}/.shellspan-backup-{}-{name}",
            Uuid::new_v4().simple()
        )
    });
    if let Some(backup) = backup_path.as_deref() {
        sftp.rename(
            Path::new(destination),
            Path::new(backup),
            Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
        )
        .map_err(|error| format!("failed to stage remote replacement backup: {error}"))?;
    }
    match sftp.rename(
        Path::new(&temp_path),
        Path::new(destination),
        Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
    ) {
        Ok(()) => {
            if let Some(backup) = backup_path {
                sftp.unlink(Path::new(&backup)).map_err(|error| {
                    format!("remote write succeeded but backup cleanup failed: {error}")
                })?;
            }
            Ok(())
        }
        Err(error) => {
            let _ = sftp.unlink(Path::new(&temp_path));
            if let Some(backup) = backup_path {
                let rollback = sftp.rename(
                    Path::new(&backup),
                    Path::new(destination),
                    Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
                );
                if rollback.is_err() {
                    return Err(format!(
                        "remote atomic replacement failed and rollback was not confirmed: {error}"
                    ));
                }
            }
            Err(format!("failed to atomically replace remote file: {error}"))
        }
    }
}

fn read_stream_bounded<R: Read>(
    reader: &mut R,
    limit: u64,
    operation: &FileOperationGuardNative,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        operation.ensure_active()?;
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("failed to read file bytes: {error}"))?;
        if read == 0 {
            break;
        }
        if bytes.len() as u64 + read as u64 > limit {
            return Err("file exceeds the native byte limit".into());
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    Ok(bytes)
}

fn write_stream<W: Write>(
    writer: &mut W,
    content: &[u8],
    operation: &FileOperationGuardNative,
) -> Result<(), String> {
    for chunk in content.chunks(64 * 1024) {
        operation.ensure_active()?;
        writer
            .write_all(chunk)
            .map_err(|error| format!("failed to write file bytes: {error}"))?;
    }
    Ok(())
}

fn is_sftp_missing(error: &ssh2::Error) -> bool {
    matches!(error.code(), ssh2::ErrorCode::SFTP(2))
}

fn remote_kind(permissions: Option<u32>) -> &'static str {
    match permissions.unwrap_or(0) & 0o170000 {
        0o040000 => "directory",
        0o100000 => "file",
        0o120000 => "symlink",
        _ => "other",
    }
}

fn file_kind(file_type: fs::FileType) -> &'static str {
    if file_type.is_symlink() {
        "symlink"
    } else if file_type.is_dir() {
        "directory"
    } else if file_type.is_file() {
        "file"
    } else {
        "other"
    }
}

fn slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn detect_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8 * 1024).any(|byte| *byte == 0) || std::str::from_utf8(bytes).is_err()
}

fn path_is_sensitive(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.split(['/', '\\']).any(|component| {
        component == ".env"
            || component.starts_with(".env.")
            || component == ".ssh"
            || component == ".aws"
            || component == ".gnupg"
            || component.contains("secret")
            || component.contains("credential")
            || component.ends_with(".pem")
            || component.ends_with(".key")
            || component.ends_with(".pfx")
    })
}

fn listing_digest<T: Serialize>(value: &T) -> Result<String, String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("failed to bind pagination cursor: {error}"))?;
    Ok(sha256_hex(&bytes))
}

fn encode_cursor(offset: usize, digest: &str) -> String {
    URL_SAFE_NO_PAD.encode(format!("{offset}:{digest}"))
}

fn decode_cursor(cursor: Option<&str>, digest: &str) -> Result<usize, String> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    let decoded = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| "pagination cursor is invalid".to_string())?;
    let decoded =
        std::str::from_utf8(&decoded).map_err(|_| "pagination cursor is invalid".to_string())?;
    let (offset, cursor_digest) = decoded
        .split_once(':')
        .ok_or_else(|| "pagination cursor is invalid".to_string())?;
    if cursor_digest != digest {
        return Err("pagination cursor no longer matches the target snapshot".into());
    }
    offset
        .parse::<usize>()
        .map_err(|_| "pagination cursor is invalid".to_string())
}

fn matches_globs(path: &str, globs: &[String]) -> bool {
    globs.is_empty() || globs.iter().any(|glob| wildcard_match(glob, path))
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let (mut pattern_index, mut value_index, mut star, mut retry) = (0, 0, None, 0);
    while value_index < value.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == b'?' || pattern[pattern_index] == value[value_index])
        {
            pattern_index += 1;
            value_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
            star = Some(pattern_index);
            pattern_index += 1;
            retry = value_index;
        } else if let Some(star_index) = star {
            pattern_index = star_index + 1;
            retry += 1;
            value_index = retry;
        } else {
            return false;
        }
    }
    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

fn contains_query(value: &str, query: &str, case_sensitive: bool) -> bool {
    find_query(value, query, case_sensitive).is_some()
}

fn find_query(value: &str, query: &str, case_sensitive: bool) -> Option<usize> {
    if case_sensitive {
        value.find(query)
    } else {
        value.to_lowercase().find(&query.to_lowercase())
    }
}

fn truncate_utf8(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_scope_rejects_parent_and_symlink_escape() {
        let root = tempfile::tempdir().unwrap();
        assert!(resolve_local_destination(root.path(), "../outside").is_err());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path().parent().unwrap(), root.path().join("link"))
                .unwrap();
            assert!(resolve_local_destination(root.path(), "link/file").is_err());
        }
    }

    #[test]
    fn cursors_are_bound_to_the_exact_listing_digest() {
        let cursor = encode_cursor(10, &"a".repeat(64));
        assert_eq!(decode_cursor(Some(&cursor), &"a".repeat(64)).unwrap(), 10);
        assert!(decode_cursor(Some(&cursor), &"b".repeat(64)).is_err());
    }

    #[test]
    fn wildcard_matching_is_native_and_bounded() {
        assert!(wildcard_match("*.rs", "src/main.rs"));
        assert!(!wildcard_match("*.toml", "src/main.rs"));
    }

    #[test]
    fn file_operation_cancellation_is_observed_by_active_native_work() {
        let registry = FileOperationRegistryNative::default();
        let operation = registry.begin("task-cancel", "call-cancel").unwrap();
        registry.cancel_task("task-cancel").unwrap();

        assert_eq!(
            operation.ensure_active().unwrap_err(),
            "file operation was cancelled"
        );
    }

    #[test]
    fn transfer_overwrite_requires_exact_destination_digest() {
        let content = b"existing";
        let base = TransferFileArgumentsNative {
            direction: TransferDirectionNative::Upload,
            source_path: "source.txt".into(),
            destination_path: "destination.txt".into(),
            overwrite: false,
            expected_sha256: Some(sha256_hex(b"source")),
            destination_sha256: None,
            max_bytes: None,
        };
        assert_eq!(
            validate_overwrite_precondition(&base, Some(content)).unwrap_err(),
            "transfer destination already exists"
        );

        let mut overwrite = base;
        overwrite.overwrite = true;
        assert_eq!(
            validate_overwrite_precondition(&overwrite, Some(content)).unwrap_err(),
            "overwrite requires the destination digest precondition"
        );
        overwrite.destination_sha256 = Some(sha256_hex(b"wrong"));
        assert_eq!(
            validate_overwrite_precondition(&overwrite, Some(content)).unwrap_err(),
            "transfer destination digest precondition failed"
        );
        overwrite.destination_sha256 = Some(sha256_hex(content));
        validate_overwrite_precondition(&overwrite, Some(content)).unwrap();
    }

    #[test]
    fn local_atomic_write_rechecks_digest_and_round_trips() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config.txt");
        fs::write(&path, b"before").unwrap();
        let registry = FileOperationRegistryNative::default();
        let operation = registry.begin("task", "call").unwrap();
        write_local_atomic(
            root.path(),
            &path,
            b"after",
            Some(&sha256_hex(b"before")),
            &operation,
        )
        .unwrap();
        assert_eq!(fs::read(path).unwrap(), b"after");
    }
}
