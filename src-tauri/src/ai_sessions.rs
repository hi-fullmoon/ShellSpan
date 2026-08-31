use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Manager};

use crate::redaction::redact_json_value;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

// This lock serializes every in-process mutation and command-facing read. Appends
// are not atomic for concurrent readers, while rewrites are, so readers also take
// the lock to avoid observing a partial append from this process.
static AI_SESSION_ORDINALS: LazyLock<Mutex<HashMap<PathBuf, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const MAX_AGENT_STATE_BYTES: usize = 1024 * 1024;
const AGENT_STATE_VERSION: u64 = 1;
const RECOVERY_EVENT_TYPE: &str = "session_recovered";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSessionMeta {
    pub id: String,
    pub timestamp: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub session_id: Option<String>,
    pub profile_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiConversationSummary {
    pub id: String,
    pub started_at: String,
    pub updated_at: String,
    pub title: String,
    pub archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub session_id: Option<String>,
    pub profile_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<AiSessionRecovery>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSessionLocator {
    pub id: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSessionFile {
    pub conversation: AiConversationSummary,
    pub messages: Vec<Value>,
    pub agent_states: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<AiSessionRecovery>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSessionRecovery {
    pub valid_records: usize,
    pub skipped_bytes: u64,
    pub first_error: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentCheckpointEnvelope {
    kind: String,
    version: u64,
    state: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentPatchEnvelope {
    kind: String,
    version: u64,
    request_id: String,
    run: Option<AgentRunPatch>,
    messages: Option<Vec<AgentMessagePatch>>,
    removed_message_ids: Option<Vec<String>>,
    tools: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentRunPatch {
    set: Option<Map<String, Value>>,
    append_tool_call_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentMessagePatch {
    id: String,
    upsert: Option<Value>,
    append_content: Option<String>,
    content_offset_bytes: Option<u64>,
    set: Option<Map<String, Value>>,
    append_tool_call_ids: Option<Vec<String>>,
}

#[derive(Debug)]
struct JsonlScan {
    valid_records: usize,
    recovery: Option<AiSessionRecovery>,
}

fn sessions_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve home directory: {error}"))?
        .join(".shellspan")
        .join("sessions"))
}

fn date_parts(timestamp: &str) -> Result<(&str, &str, &str), String> {
    let bytes = timestamp.as_bytes();
    if bytes.len() < 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes[..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        return Err("AI session timestamp must start with YYYY-MM-DD".to_string());
    }
    Ok((&timestamp[..4], &timestamp[5..7], &timestamp[8..10]))
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("invalid AI conversation id".to_string());
    }
    Ok(())
}

fn session_path(root: &Path, id: &str, started_at: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    let timestamp_bytes = started_at.as_bytes();
    if timestamp_bytes.len() < 19
        || timestamp_bytes[10] != b'T'
        || timestamp_bytes[13] != b':'
        || timestamp_bytes[16] != b':'
        || !timestamp_bytes[..19]
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13 | 16) || byte.is_ascii_digit())
    {
        return Err("AI session timestamp must start with YYYY-MM-DDTHH:MM:SS".to_string());
    }
    let (year, month, day) = date_parts(started_at)?;
    let safe_timestamp: String = started_at
        .chars()
        .take(19)
        .map(|ch| if ch == ':' { '-' } else { ch })
        .collect();
    Ok(root
        .join(year)
        .join(month)
        .join(day)
        .join(format!("rollout-{safe_timestamp}-{id}.jsonl")))
}

fn session_file_exists(path: &Path) -> Result<bool, String> {
    path.try_exists()
        .map_err(|error| format!("failed to inspect AI session {}: {error}", path.display()))
}

fn delete_ai_session_files(root: &Path, sessions: &[AiSessionLocator]) -> Result<usize, String> {
    let paths = sessions
        .iter()
        .map(|session| session_path(root, &session.id, &session.started_at))
        .collect::<Result<HashSet<_>, _>>()?;
    let mut ordinals = AI_SESSION_ORDINALS
        .lock()
        .map_err(|error| format!("AI session write lock poisoned: {error}"))?;
    let mut deleted_count = 0;
    for path in paths {
        match fs::remove_file(&path) {
            Ok(()) => {
                ordinals.remove(&path);
                deleted_count += 1;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to delete AI session: {error}")),
        }
    }
    Ok(deleted_count)
}

fn scan_jsonl<F>(path: &Path, mut visit: F) -> Result<JsonlScan, String>
where
    F: FnMut(Value) -> Result<(), String>,
{
    let file = File::open(path)
        .map_err(|error| format!("failed to open AI session {}: {error}", path.display()))?;
    let file_len = file
        .metadata()
        .map_err(|error| format!("failed to inspect AI session {}: {error}", path.display()))?
        .len();
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut offset = 0_u64;
    let mut valid_records = 0_usize;

    loop {
        line.clear();
        let line_number = valid_records + 1;
        let read = match reader.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) => {
                return Ok(JsonlScan {
                    valid_records,
                    recovery: Some(AiSessionRecovery {
                        valid_records,
                        skipped_bytes: file_len.saturating_sub(offset),
                        first_error: format!(
                            "line {line_number} at byte {offset}: failed to read record: {error}"
                        ),
                    }),
                });
            }
        };
        let line_start = offset;
        offset = offset.saturating_add(read as u64);
        let has_newline = line.last() == Some(&b'\n');
        if has_newline {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
        }
        let parsed = match std::str::from_utf8(&line)
            .map_err(|_| "record is not valid UTF-8".to_string())
            .and_then(|line| {
                serde_json::from_str::<Value>(line)
                    .map_err(|error| format!("record is not valid JSON: {error}"))
            }) {
            Ok(Value::Object(record)) => Value::Object(record),
            Ok(_) => {
                return Ok(JsonlScan {
                    valid_records,
                    recovery: Some(AiSessionRecovery {
                        valid_records,
                        skipped_bytes: file_len.saturating_sub(line_start),
                        first_error: format!(
                            "line {line_number} at byte {line_start}: record is not a JSON object"
                        ),
                    }),
                });
            }
            Err(error) => {
                return Ok(JsonlScan {
                    valid_records,
                    recovery: Some(AiSessionRecovery {
                        valid_records,
                        skipped_bytes: file_len.saturating_sub(line_start),
                        first_error: format!("line {line_number} at byte {line_start}: {error}"),
                    }),
                });
            }
        };
        if let Err(error) = visit(parsed) {
            return Ok(JsonlScan {
                valid_records,
                recovery: Some(AiSessionRecovery {
                    valid_records,
                    skipped_bytes: file_len.saturating_sub(line_start),
                    first_error: format!("line {line_number} at byte {line_start}: {error}"),
                }),
            });
        }
        valid_records += 1;
        if !has_newline {
            return Ok(JsonlScan {
                valid_records,
                recovery: Some(AiSessionRecovery {
                    valid_records,
                    skipped_bytes: 0,
                    first_error: format!(
                        "line {line_number} at byte {line_start}: final record is missing a newline"
                    ),
                }),
            });
        }
    }

    Ok(JsonlScan {
        valid_records,
        recovery: None,
    })
}

fn read_jsonl_records(path: &Path) -> Result<(Vec<Value>, JsonlScan), String> {
    let mut records = Vec::new();
    let scan = scan_jsonl(path, |record| {
        records.push(record);
        Ok(())
    })?;
    debug_assert_eq!(records.len(), scan.valid_records);
    Ok((records, scan))
}

fn recovery_from_record(record: &Value) -> Option<AiSessionRecovery> {
    if record.get("type").and_then(Value::as_str) != Some("event_msg")
        || record.pointer("/payload/type").and_then(Value::as_str) != Some(RECOVERY_EVENT_TYPE)
    {
        return None;
    }
    let payload = record.get("payload")?;
    Some(AiSessionRecovery {
        valid_records: usize::try_from(payload.get("validRecords")?.as_u64()?).ok()?,
        skipped_bytes: payload.get("skippedBytes")?.as_u64()?,
        first_error: payload.get("firstError")?.as_str()?.to_string(),
    })
}

fn recovery_record(timestamp: &str, recovery: &AiSessionRecovery) -> Value {
    json!({
        "timestamp": timestamp,
        "type": "event_msg",
        "payload": {
            "type": RECOVERY_EVENT_TYPE,
            "validRecords": recovery.valid_records,
            "skippedBytes": recovery.skipped_bytes,
            "firstError": recovery.first_error,
        },
    })
}

fn is_recovery_record(record: &Value) -> bool {
    recovery_from_record(record).is_some()
}

fn encode_jsonl_records(records: &mut [Value]) -> Result<Vec<u8>, String> {
    let mut encoded = Vec::new();
    for (ordinal, record) in records.iter_mut().enumerate() {
        let object = record
            .as_object_mut()
            .ok_or_else(|| "AI session record is not a JSON object".to_string())?;
        object.insert("ordinal".to_string(), json!(ordinal));
        serde_json::to_writer(&mut encoded, record)
            .map_err(|error| format!("failed to encode AI session record: {error}"))?;
        encoded.push(b'\n');
    }
    Ok(encoded)
}

fn atomic_rewrite_with<F>(path: &Path, records: &mut [Value], replace: F) -> Result<(), String>
where
    F: FnOnce(&Path, &Path) -> io::Result<()>,
{
    let parent = path
        .parent()
        .ok_or_else(|| "AI session path has no parent".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "AI session path has an invalid file name".to_string())?;
    let encoded = encode_jsonl_records(records)?;
    let mut temp = None;
    for attempt in 0..100_u16 {
        let candidate = parent.join(format!(
            ".{file_name}.rewrite-{}-{attempt}",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        match options.open(&candidate) {
            Ok(file) => {
                temp = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("failed to create AI session rewrite file: {error}"));
            }
        }
    }
    let (temp_path, mut temp_file) =
        temp.ok_or_else(|| "failed to allocate AI session rewrite file".to_string())?;
    let write_result = temp_file
        .write_all(&encoded)
        .and_then(|_| temp_file.flush())
        .and_then(|_| temp_file.sync_all());
    if let Err(error) = write_result {
        drop(temp_file);
        let _ = fs::remove_file(&temp_path);
        return Err(format!("failed to sync AI session rewrite: {error}"));
    }
    #[cfg(unix)]
    if let Err(error) = temp_file.set_permissions(fs::Permissions::from_mode(0o600)) {
        drop(temp_file);
        let _ = fs::remove_file(&temp_path);
        return Err(format!("failed to secure AI session rewrite: {error}"));
    }
    drop(temp_file);
    if let Err(error) = replace(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("failed to atomically replace AI session: {error}"));
    }
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            format!("AI session was replaced but its directory could not be synced: {error}")
        })?;
    Ok(())
}

fn atomic_rewrite(path: &Path, records: &mut [Value]) -> Result<(), String> {
    atomic_rewrite_with(path, records, replace_session_file)
}

#[cfg(target_os = "windows")]
fn replace_session_file(temporary: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temporary = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            temporary.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn replace_session_file(temporary: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temporary, destination)
}

fn records_have_meta(records: &[Value]) -> bool {
    records
        .iter()
        .any(|record| record.get("type").and_then(Value::as_str) == Some("session_meta"))
}

fn prepare_existing_file_for_append(path: &Path, timestamp: &str) -> Result<usize, String> {
    let (mut records, scan) = read_validated_jsonl_records(path)?;
    if !records_have_meta(&records) {
        return Err("AI session has no valid metadata record".to_string());
    }
    if let Some(recovery) = scan.recovery {
        records.retain(|record| !is_recovery_record(record));
        records.push(recovery_record(timestamp, &recovery));
        atomic_rewrite(path, &mut records)?;
    }
    Ok(records.len())
}

fn append_record_locked(
    ordinals: &mut HashMap<PathBuf, usize>,
    path: &Path,
    timestamp: &str,
    record_type: &str,
    payload: Value,
) -> Result<(), String> {
    let ordinal = match ordinals.get(path).copied() {
        Some(ordinal) => ordinal,
        None if session_file_exists(path)? => prepare_existing_file_for_append(path, timestamp)?,
        None if record_type == "session_meta" => 0,
        None => return Err("AI session does not exist".to_string()),
    };
    let record = json!({
        "timestamp": timestamp,
        "type": record_type,
        "payload": payload,
        "ordinal": ordinal,
    });
    let mut encoded = serde_json::to_vec(&record)
        .map_err(|error| format!("failed to encode AI session record: {error}"))?;
    encoded.push(b'\n');
    let mut options = OpenOptions::new();
    // Only metadata creation may create a file. If an existing session is
    // concurrently removed, a later append must fail rather than recreate a
    // metadata-free JSONL file that looks like lost history on the next load.
    options.create(record_type == "session_meta").append(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) => {
            ordinals.remove(path);
            return Err(format!("failed to append AI session: {error}"));
        }
    };
    #[cfg(unix)]
    if let Err(error) = file.set_permissions(fs::Permissions::from_mode(0o600)) {
        ordinals.remove(path);
        return Err(format!("failed to secure AI session file: {error}"));
    }
    if let Err(error) = file
        .write_all(&encoded)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_data())
    {
        // A failed write can leave a partial last line. Forget the cached
        // ordinal so the next append scans and atomically repairs the prefix.
        ordinals.remove(path);
        return Err(format!("failed to sync AI session record: {error}"));
    }
    ordinals.insert(path.to_path_buf(), ordinal + 1);
    Ok(())
}

fn append_record(
    path: &Path,
    timestamp: &str,
    record_type: &str,
    payload: Value,
) -> Result<(), String> {
    let mut ordinals = AI_SESSION_ORDINALS
        .lock()
        .map_err(|error| format!("AI session write lock poisoned: {error}"))?;
    append_record_locked(&mut ordinals, path, timestamp, record_type, payload)
}

#[tauri::command]
pub(crate) fn create_ai_session(app: AppHandle, meta: AiSessionMeta) -> Result<(), String> {
    let root = sessions_root(&app)?;
    let path = session_path(&root, &meta.id, &meta.timestamp)?;
    let parent = path
        .parent()
        .ok_or_else(|| "AI session path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create AI session directory: {error}"))?;
    #[cfg(unix)]
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("failed to secure AI sessions directory: {error}"))?;
    let mut ordinals = AI_SESSION_ORDINALS
        .lock()
        .map_err(|error| format!("AI session write lock poisoned: {error}"))?;
    if session_file_exists(&path)? {
        return Ok(());
    }
    append_record_locked(
        &mut ordinals,
        &path,
        &meta.timestamp,
        "session_meta",
        serde_json::to_value(&meta)
            .map_err(|error| format!("failed to encode AI session metadata: {error}"))?,
    )?;
    Ok(())
}

#[tauri::command]
pub(crate) fn append_ai_session_message(
    app: AppHandle,
    conversation_id: String,
    started_at: String,
    timestamp: String,
    message: Value,
) -> Result<(), String> {
    let path = session_path(&sessions_root(&app)?, &conversation_id, &started_at)?;
    append_record(
        &path,
        &timestamp,
        "response_item",
        redact_json_value(&message),
    )
}

#[tauri::command]
pub(crate) fn append_ai_session_agent_state(
    app: AppHandle,
    conversation_id: String,
    started_at: String,
    timestamp: String,
    state: Value,
) -> Result<(), String> {
    let path = session_path(&sessions_root(&app)?, &conversation_id, &started_at)?;
    let encoded_size = serde_json::to_vec(&state)
        .map_err(|error| format!("failed to encode Agent session state: {error}"))?
        .len();
    if encoded_size > MAX_AGENT_STATE_BYTES {
        return Err("Agent session event exceeds the 1 MiB persistence limit".to_string());
    }
    let record_type = validate_agent_payload(&state)?;
    append_record(&path, &timestamp, record_type, redact_json_value(&state))
}

fn record_is_cleared_lane(record: &Value, lane: &str) -> bool {
    match record.get("type").and_then(Value::as_str) {
        Some("response_item") if lane != "agent" => record
            .get("payload")
            .is_some_and(|message| message_lane(message) == lane),
        Some("agent_state" | "agent_state_checkpoint" | "agent_state_patch") => lane == "agent",
        Some("event_msg") => {
            record.pointer("/payload/type").and_then(Value::as_str) == Some("conversation_cleared")
                && record.pointer("/payload/lane").and_then(Value::as_str) == Some(lane)
        }
        _ => false,
    }
}

fn clear_session_lane(path: &Path, timestamp: &str, lane: &str) -> Result<(), String> {
    let mut ordinals = AI_SESSION_ORDINALS
        .lock()
        .map_err(|error| format!("AI session write lock poisoned: {error}"))?;
    if !session_file_exists(path)? {
        return Ok(());
    }
    let (mut records, scan) = read_jsonl_records(path)?;
    if !records_have_meta(&records) {
        return Err("AI session has no valid metadata record; clear was not applied".to_string());
    }
    let persisted_recovery = records.iter().filter_map(recovery_from_record).next_back();
    records.retain(|record| !record_is_cleared_lane(record, lane) && !is_recovery_record(record));
    if let Some(recovery) = scan.recovery.or(persisted_recovery) {
        records.push(recovery_record(timestamp, &recovery));
    }
    records.push(json!({
        "timestamp": timestamp,
        "type": "event_msg",
        "payload": { "type": "conversation_cleared", "lane": lane },
    }));
    // If replacement or the following directory sync fails, force the next
    // operation to discover the actual on-disk state rather than trusting a
    // pre-rewrite cached ordinal.
    ordinals.remove(path);
    atomic_rewrite(path, &mut records)?;
    ordinals.insert(path.to_path_buf(), records.len());
    Ok(())
}

#[tauri::command]
pub(crate) fn clear_ai_session_lane(
    app: AppHandle,
    conversation_id: String,
    started_at: String,
    timestamp: String,
    lane: String,
) -> Result<(), String> {
    if lane != "conversation" && lane != "command" && lane != "agent" {
        return Err("invalid AI conversation lane".to_string());
    }
    let path = session_path(&sessions_root(&app)?, &conversation_id, &started_at)?;
    clear_session_lane(&path, &timestamp, &lane)
}

#[tauri::command]
pub(crate) fn archive_ai_session(
    app: AppHandle,
    conversation_id: String,
    started_at: String,
    timestamp: String,
    reason: Option<String>,
) -> Result<(), String> {
    let reason = match reason.as_deref() {
        None | Some("terminal_closed") => "terminal_closed",
        Some("new_conversation") => "new_conversation",
        Some(_) => return Err("invalid AI session archive reason".to_string()),
    };
    let path = session_path(&sessions_root(&app)?, &conversation_id, &started_at)?;
    if !session_file_exists(&path)? {
        return Ok(());
    }
    append_record(
        &path,
        &timestamp,
        "event_msg",
        json!({ "type": "conversation_archived", "reason": reason }),
    )
}

#[tauri::command]
pub(crate) fn delete_ai_sessions(
    app: AppHandle,
    sessions: Vec<AiSessionLocator>,
) -> Result<usize, String> {
    delete_ai_session_files(&sessions_root(&app)?, &sessions)
}

fn collect_jsonl_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if !directory.try_exists().map_err(|error| {
        format!(
            "failed to inspect AI sessions directory {}: {error}",
            directory.display()
        )
    })? {
        return Ok(());
    }
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("failed to read AI sessions directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("failed to read AI session entry: {error}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, files)?;
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
    Ok(())
}

fn message_lane(message: &Value) -> &'static str {
    match message.get("task").and_then(Value::as_str) {
        Some("generateCommand") => "command",
        Some("agent") => "agent",
        _ => "conversation",
    }
}

fn validate_response_message(message: &Value) -> Result<(), String> {
    let object = message
        .as_object()
        .ok_or_else(|| "response_item payload is not an object".to_string())?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "response_item payload is missing id".to_string())?;
    validate_id(id)?;
    if object.get("content").and_then(Value::as_str).is_none() {
        return Err("response_item payload content is not a string".to_string());
    }
    Ok(())
}

fn agent_state_request_id(state: &Value) -> Result<&str, String> {
    let request_id = state
        .pointer("/run/requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Agent session state is missing run.requestId".to_string())?;
    validate_id(request_id)?;
    Ok(request_id)
}

fn validate_string_array(value: Option<&Value>, field: &str) -> Result<(), String> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Agent state field {field} is not an array"))?;
    for value in values {
        let id = value
            .as_str()
            .ok_or_else(|| format!("Agent state field {field} contains a non-string value"))?;
        validate_id(id)?;
    }
    Ok(())
}

fn validate_agent_message(message: &Value, request_id: &str) -> Result<(), String> {
    let object = message
        .as_object()
        .ok_or_else(|| "Agent session message is not an object".to_string())?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Agent session message is missing id".to_string())?;
    validate_id(id)?;
    if object.get("requestId").and_then(Value::as_str) != Some(request_id) {
        return Err("Agent session message requestId does not match run".to_string());
    }
    if object.get("content").and_then(Value::as_str).is_none() {
        return Err("Agent session message content is not a string".to_string());
    }
    validate_string_array(object.get("toolCallIds"), "message.toolCallIds")
}

fn validate_agent_tool(tool: &Value, request_id: &str) -> Result<(), String> {
    if tool.pointer("/toolCall/requestId").and_then(Value::as_str) != Some(request_id) {
        return Err("Agent session tool requestId does not match run".to_string());
    }
    let call_id = tool
        .pointer("/toolCall/callId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Agent session tool is missing toolCall.callId".to_string())?;
    validate_id(call_id)?;
    if !matches!(
        tool.get("status").and_then(Value::as_str),
        Some(
            "pending"
                | "awaitingApproval"
                | "running"
                | "completed"
                | "rejected"
                | "failed"
                | "timedOut"
                | "cancelled"
        )
    ) {
        return Err("Agent session tool status is not a string".to_string());
    }
    Ok(())
}

fn validate_agent_target(value: &Value) -> Result<(), String> {
    let target = value
        .as_object()
        .ok_or_else(|| "Agent target is not an object".to_string())?;
    if !matches!(
        target.get("kind").and_then(Value::as_str),
        Some("remote" | "local")
    ) || target.get("sessionId").and_then(Value::as_str).is_none()
        || target.get("host").and_then(Value::as_str).is_none()
        || target.get("port").and_then(Value::as_u64).is_none()
        || target.get("username").and_then(Value::as_str).is_none()
    {
        return Err("Agent target has an invalid shape".to_string());
    }
    Ok(())
}

fn validate_agent_run_set(set: &Map<String, Value>) -> Result<(), String> {
    for (field, value) in set {
        match field.as_str() {
            "conversationStartedAt" | "goal" | "providerId" | "targetTitle" | "error" => {
                if !value.is_string() {
                    return Err(format!("Agent run patch field {field} is not a string"));
                }
            }
            "permissionMode"
                if matches!(
                    value.as_str(),
                    Some("requestApproval" | "autoApproveReadOnly" | "fullAccess")
                ) => {}
            "rolloutStage"
                if matches!(
                    value.as_str(),
                    Some("disabled" | "internal" | "preview" | "stable")
                ) => {}
            "phase"
                if matches!(
                    value.as_str(),
                    Some(
                        "analyzing"
                            | "preparingCommand"
                            | "awaitingApproval"
                            | "executing"
                            | "readingResult"
                            | "verifying"
                            | "completed"
                            | "partial"
                            | "incomplete"
                    )
                ) => {}
            "status"
                if matches!(
                    value.as_str(),
                    Some(
                        "running" | "completed" | "partial" | "incomplete" | "cancelled" | "failed"
                    )
                ) => {}
            "stopRequested" | "stepLimitReached" if value.is_boolean() => {}
            "maxToolSteps" | "toolResultTimeoutMs" if value.as_u64().is_some() => {}
            "target" => validate_agent_target(value)?,
            "fallback" if value.is_object() => {}
            _ => {
                return Err(format!(
                    "Agent run patch field {field} has an invalid value"
                ))
            }
        }
    }
    Ok(())
}

fn validate_agent_message_set(set: &Map<String, Value>) -> Result<(), String> {
    for (field, value) in set {
        match field.as_str() {
            "conversationId" | "providerId" if value.is_string() => {}
            "role" if matches!(value.as_str(), Some("user" | "assistant")) => {}
            "status"
                if matches!(
                    value.as_str(),
                    Some("streaming" | "completed" | "cancelled" | "failed")
                ) => {}
            "target" => validate_agent_target(value)?,
            _ => {
                return Err(format!(
                    "Agent message patch field {field} has an invalid value"
                ));
            }
        }
    }
    Ok(())
}

fn validate_agent_message_upsert(message: &Value, request_id: &str) -> Result<(), String> {
    validate_agent_message(message, request_id)?;
    let object = message.as_object().unwrap_or_else(|| unreachable!());
    let mut set = object.clone();
    for field in ["id", "requestId", "content", "toolCallIds"] {
        set.remove(field);
    }
    validate_agent_message_set(&set)
}

fn validate_agent_state(state: &Value) -> Result<(), String> {
    let request_id = agent_state_request_id(state)?;
    let run = state
        .get("run")
        .and_then(Value::as_object)
        .ok_or_else(|| "Agent session run is not an object".to_string())?;
    if run.get("conversationId").and_then(Value::as_str).is_none() {
        return Err("Agent session run is missing conversationId".to_string());
    }
    validate_string_array(run.get("toolCallIds"), "run.toolCallIds")?;

    let messages = state
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Agent session messages is not an array".to_string())?;
    let mut message_ids = HashSet::new();
    for message in messages {
        validate_agent_message(message, request_id)?;
        let id = message
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !message_ids.insert(id) {
            return Err(format!("Agent session contains duplicate message id {id}"));
        }
    }

    let tools = state
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| "Agent session tools is not an array".to_string())?;
    let mut call_ids = HashSet::new();
    for tool in tools {
        validate_agent_tool(tool, request_id)?;
        let call_id = tool
            .pointer("/toolCall/callId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !call_ids.insert(call_id) {
            return Err(format!(
                "Agent session contains duplicate tool call id {call_id}"
            ));
        }
    }
    Ok(())
}

fn validate_agent_patch(patch: &AgentPatchEnvelope) -> Result<(), String> {
    if patch.kind != "patch" || patch.version != AGENT_STATE_VERSION {
        return Err("unsupported Agent session patch version".to_string());
    }
    validate_id(&patch.request_id)?;
    if patch.run.is_none()
        && patch.messages.is_none()
        && patch.removed_message_ids.is_none()
        && patch.tools.is_none()
    {
        return Err("Agent session patch has no changes".to_string());
    }
    if let Some(run) = &patch.run {
        if run.set.as_ref().is_some_and(|set| {
            ["requestId", "conversationId", "toolCallIds"]
                .iter()
                .any(|key| set.contains_key(*key))
        }) {
            return Err("Agent run patch cannot replace identity or toolCallIds".to_string());
        }
        if let Some(set) = &run.set {
            validate_agent_run_set(set)?;
        }
        if let Some(call_ids) = &run.append_tool_call_ids {
            for call_id in call_ids {
                validate_id(call_id)?;
            }
        }
    }
    if let Some(messages) = &patch.messages {
        for message in messages {
            validate_id(&message.id)?;
            if message.upsert.is_some()
                && (message.append_content.is_some()
                    || message.content_offset_bytes.is_some()
                    || message.set.is_some()
                    || message.append_tool_call_ids.is_some())
            {
                return Err(
                    "Agent message upsert cannot be combined with incremental fields".to_string(),
                );
            }
            if let Some(upsert) = &message.upsert {
                if upsert.get("id").and_then(Value::as_str) != Some(message.id.as_str())
                    || upsert.get("requestId").and_then(Value::as_str)
                        != Some(patch.request_id.as_str())
                {
                    return Err("Agent message upsert identity does not match patch".to_string());
                }
                validate_agent_message_upsert(upsert, &patch.request_id)?;
            } else if message.append_content.is_none()
                && message.content_offset_bytes.is_none()
                && message.set.is_none()
                && message.append_tool_call_ids.is_none()
            {
                return Err("Agent message patch has no changes".to_string());
            }
            if message.set.as_ref().is_some_and(|set| {
                ["id", "requestId", "content", "toolCallIds"]
                    .iter()
                    .any(|key| set.contains_key(*key))
            }) {
                return Err(
                    "Agent message patch cannot replace identity, content, or toolCallIds"
                        .to_string(),
                );
            }
            if let Some(set) = &message.set {
                validate_agent_message_set(set)?;
            }
            if message.content_offset_bytes.is_some() && message.append_content.is_none() {
                return Err("Agent message contentOffsetBytes requires appendContent".to_string());
            }
            if message.append_content.is_some() && message.content_offset_bytes.is_none() {
                return Err(
                    "Agent v1 message appendContent requires contentOffsetBytes".to_string()
                );
            }
            if let Some(call_ids) = &message.append_tool_call_ids {
                for call_id in call_ids {
                    validate_id(call_id)?;
                }
            }
        }
    }
    if let Some(removed_ids) = &patch.removed_message_ids {
        for message_id in removed_ids {
            validate_id(message_id)?;
        }
    }
    if let Some(tools) = &patch.tools {
        for tool in tools {
            validate_agent_tool(tool, &patch.request_id)?;
        }
    }
    Ok(())
}

fn parse_agent_checkpoint(payload: &Value) -> Result<AgentCheckpointEnvelope, String> {
    let checkpoint: AgentCheckpointEnvelope = serde_json::from_value(payload.clone())
        .map_err(|error| format!("invalid Agent checkpoint: {error}"))?;
    if checkpoint.kind != "checkpoint" || checkpoint.version != AGENT_STATE_VERSION {
        return Err("unsupported Agent session checkpoint version".to_string());
    }
    validate_agent_state(&checkpoint.state)?;
    Ok(checkpoint)
}

fn parse_agent_patch(payload: &Value) -> Result<AgentPatchEnvelope, String> {
    let patch: AgentPatchEnvelope = serde_json::from_value(payload.clone())
        .map_err(|error| format!("invalid Agent patch: {error}"))?;
    validate_agent_patch(&patch)?;
    Ok(patch)
}

fn validate_agent_payload(payload: &Value) -> Result<&'static str, String> {
    match payload.get("kind") {
        None => {
            validate_agent_state(payload)?;
            Ok("agent_state")
        }
        Some(Value::String(kind)) if kind == "checkpoint" => {
            parse_agent_checkpoint(payload)?;
            Ok("agent_state_checkpoint")
        }
        Some(Value::String(kind)) if kind == "patch" => {
            parse_agent_patch(payload)?;
            Ok("agent_state_patch")
        }
        Some(Value::String(_)) => Err("unsupported Agent session event kind".to_string()),
        Some(_) => Err("Agent session event kind must be a string".to_string()),
    }
}

fn append_unique_strings(
    object: &mut Map<String, Value>,
    field: &str,
    appended: &[String],
) -> Result<(), String> {
    let values = object
        .entry(field.to_string())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| format!("Agent state field {field} is not an array"))?;
    for value in appended {
        if !values
            .iter()
            .any(|existing| existing.as_str() == Some(value))
        {
            values.push(Value::String(value.clone()));
        }
    }
    Ok(())
}

fn apply_object_set(target: &mut Map<String, Value>, set: &Map<String, Value>) {
    for (key, value) in set {
        target.insert(key.clone(), value.clone());
    }
}

enum ProjectedContentBase<'a> {
    Borrowed(&'a str),
    Owned(String),
}

struct ProjectedContent<'a> {
    base: ProjectedContentBase<'a>,
    appended: Vec<u8>,
}

impl<'a> ProjectedContent<'a> {
    fn borrowed(value: &'a str) -> Self {
        Self {
            base: ProjectedContentBase::Borrowed(value),
            appended: Vec::new(),
        }
    }

    fn owned(value: String) -> Self {
        Self {
            base: ProjectedContentBase::Owned(value),
            appended: Vec::new(),
        }
    }

    fn base(&self) -> &str {
        match &self.base {
            ProjectedContentBase::Borrowed(value) => value,
            ProjectedContentBase::Owned(value) => value,
        }
    }

    fn len(&self) -> usize {
        self.base().len() + self.appended.len()
    }

    fn byte(&self, index: usize) -> Option<u8> {
        let base = self.base().as_bytes();
        if index < base.len() {
            base.get(index).copied()
        } else {
            self.appended.get(index - base.len()).copied()
        }
    }

    fn is_char_boundary(&self, index: usize) -> bool {
        let base = self.base();
        if index <= base.len() {
            return base.is_char_boundary(index);
        }
        std::str::from_utf8(&self.appended)
            .is_ok_and(|appended| appended.is_char_boundary(index - base.len()))
    }

    fn apply_delta(&mut self, delta: &str, offset: Option<u64>) -> Result<(), String> {
        let Some(offset) = offset else {
            self.appended.extend_from_slice(delta.as_bytes());
            return Ok(());
        };
        let offset = usize::try_from(offset)
            .map_err(|_| "Agent message contentOffsetBytes is too large".to_string())?;
        if offset > self.len() || !self.is_char_boundary(offset) {
            return Err("Agent message contentOffsetBytes does not match content".to_string());
        }
        let overlap = delta.len().min(self.len() - offset);
        if !delta.is_char_boundary(overlap)
            || delta
                .as_bytes()
                .iter()
                .take(overlap)
                .enumerate()
                .any(|(index, byte)| self.byte(offset + index) != Some(*byte))
        {
            return Err("Agent message content delta conflicts with persisted content".to_string());
        }
        self.appended
            .extend_from_slice(&delta.as_bytes()[overlap..]);
        Ok(())
    }
}

struct ProjectedMessage<'a> {
    content: Option<ProjectedContent<'a>>,
    tool_call_ids_valid: bool,
}

fn projected_message<'a>(message: &'a Value) -> Result<ProjectedMessage<'a>, String> {
    let object = message
        .as_object()
        .ok_or_else(|| "Agent checkpoint message is not an object".to_string())?;
    let content = match object.get("content") {
        Some(Value::String(content)) => Some(ProjectedContent::borrowed(content)),
        Some(_) => None,
        None => None,
    };
    Ok(ProjectedMessage {
        content,
        tool_call_ids_valid: object.get("toolCallIds").is_none_or(Value::is_array),
    })
}

fn projected_upsert_message(message: &Value) -> Result<ProjectedMessage<'static>, String> {
    let object = message
        .as_object()
        .ok_or_else(|| "Agent message upsert is not an object".to_string())?;
    let content = match object.get("content") {
        Some(Value::String(content)) => Some(ProjectedContent::owned(content.clone())),
        Some(_) => None,
        None => None,
    };
    Ok(ProjectedMessage {
        content,
        tool_call_ids_valid: object.get("toolCallIds").is_none_or(Value::is_array),
    })
}

fn preflight_agent_patch(state: &Value, patch: &AgentPatchEnvelope) -> Result<(), String> {
    if agent_state_request_id(state)? != patch.request_id {
        return Err("Agent patch requestId does not match checkpoint".to_string());
    }
    let state_object = state
        .as_object()
        .ok_or_else(|| "Agent checkpoint is not an object".to_string())?;
    if let Some(run_patch) = &patch.run {
        let run = state_object
            .get("run")
            .and_then(Value::as_object)
            .ok_or_else(|| "Agent checkpoint run is not an object".to_string())?;
        if run_patch.append_tool_call_ids.is_some()
            && run
                .get("toolCallIds")
                .is_some_and(|value| !value.is_array())
        {
            return Err("Agent state field toolCallIds is not an array".to_string());
        }
    }

    if patch.messages.is_some() || patch.removed_message_ids.is_some() {
        let messages = match state_object.get("messages") {
            Some(Value::Array(messages)) => messages.as_slice(),
            Some(_) => return Err("Agent checkpoint messages is not an array".to_string()),
            None => &[],
        };
        let mut projected = HashMap::new();
        for message in messages {
            let Some(id) = message.get("id").and_then(Value::as_str) else {
                continue;
            };
            projected.insert(id.to_string(), projected_message(message)?);
        }
        if let Some(removed_ids) = &patch.removed_message_ids {
            for id in removed_ids {
                projected.remove(id);
            }
        }
        if let Some(message_patches) = &patch.messages {
            for message_patch in message_patches {
                if let Some(upsert) = &message_patch.upsert {
                    projected.insert(message_patch.id.clone(), projected_upsert_message(upsert)?);
                    continue;
                }
                let message = projected.get_mut(&message_patch.id).ok_or_else(|| {
                    format!(
                        "Agent message patch references missing message {}",
                        message_patch.id
                    )
                })?;
                if let Some(delta) = &message_patch.append_content {
                    message
                        .content
                        .as_mut()
                        .ok_or_else(|| {
                            "Agent checkpoint message content is not a string".to_string()
                        })?
                        .apply_delta(delta, message_patch.content_offset_bytes)?;
                }
                if message_patch.append_tool_call_ids.is_some() && !message.tool_call_ids_valid {
                    return Err("Agent state field toolCallIds is not an array".to_string());
                }
            }
        }
    }

    if patch.tools.is_some()
        && state_object
            .get("tools")
            .is_some_and(|value| !value.is_array())
    {
        return Err("Agent checkpoint tools is not an array".to_string());
    }
    Ok(())
}

fn append_content_delta(
    content: &mut String,
    delta: &str,
    offset: Option<u64>,
) -> Result<(), String> {
    let Some(offset) = offset else {
        content.push_str(delta);
        return Ok(());
    };
    let offset = usize::try_from(offset)
        .map_err(|_| "Agent message contentOffsetBytes is too large".to_string())?;
    if offset > content.len() || !content.is_char_boundary(offset) {
        return Err("Agent message contentOffsetBytes does not match content".to_string());
    }
    let overlap = delta.len().min(content.len() - offset);
    if !delta.is_char_boundary(overlap)
        || content.as_bytes()[offset..offset + overlap] != delta.as_bytes()[..overlap]
    {
        return Err("Agent message content delta conflicts with persisted content".to_string());
    }
    content.push_str(&delta[overlap..]);
    Ok(())
}

fn apply_agent_patch(state: &mut Value, patch: &AgentPatchEnvelope) -> Result<(), String> {
    // Validate the entire patch against a bounded projection before changing
    // the potentially large accumulated state. This preserves the exact valid
    // prefix if any later operation in the record is malformed.
    preflight_agent_patch(state, patch)?;
    let state_object = state
        .as_object_mut()
        .ok_or_else(|| "Agent checkpoint is not an object".to_string())?;
    if let Some(run_patch) = &patch.run {
        let run = state_object
            .get_mut("run")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "Agent checkpoint run is not an object".to_string())?;
        if let Some(set) = &run_patch.set {
            apply_object_set(run, set);
        }
        if let Some(call_ids) = &run_patch.append_tool_call_ids {
            append_unique_strings(run, "toolCallIds", call_ids)?;
        }
    }

    if patch.messages.is_some() || patch.removed_message_ids.is_some() {
        let messages = state_object
            .entry("messages".to_string())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| "Agent checkpoint messages is not an array".to_string())?;
        if let Some(removed_ids) = &patch.removed_message_ids {
            messages.retain(|message| {
                !removed_ids
                    .iter()
                    .any(|id| message.get("id").and_then(Value::as_str) == Some(id))
            });
        }
        if let Some(message_patches) = &patch.messages {
            for message_patch in message_patches {
                if let Some(upsert) = &message_patch.upsert {
                    if let Some(existing) = messages.iter_mut().find(|message| {
                        message.get("id").and_then(Value::as_str) == Some(message_patch.id.as_str())
                    }) {
                        *existing = upsert.clone();
                    } else {
                        messages.push(upsert.clone());
                    }
                    continue;
                }
                let message = messages
                    .iter_mut()
                    .find(|message| {
                        message.get("id").and_then(Value::as_str) == Some(message_patch.id.as_str())
                    })
                    .ok_or_else(|| {
                        format!(
                            "Agent message patch references missing message {}",
                            message_patch.id
                        )
                    })?
                    .as_object_mut()
                    .ok_or_else(|| "Agent checkpoint message is not an object".to_string())?;
                if let Some(delta) = &message_patch.append_content {
                    match message.get_mut("content") {
                        Some(Value::String(content)) => append_content_delta(
                            content,
                            delta,
                            message_patch.content_offset_bytes,
                        )?,
                        _ => {
                            return Err(
                                "Agent checkpoint message content is not a string".to_string()
                            );
                        }
                    }
                }
                if let Some(set) = &message_patch.set {
                    apply_object_set(message, set);
                }
                if let Some(call_ids) = &message_patch.append_tool_call_ids {
                    append_unique_strings(message, "toolCallIds", call_ids)?;
                }
            }
        }
    }

    if let Some(tool_patches) = &patch.tools {
        let tools = state_object
            .entry("tools".to_string())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| "Agent checkpoint tools is not an array".to_string())?;
        for tool_patch in tool_patches {
            let call_id = tool_patch
                .pointer("/toolCall/callId")
                .and_then(Value::as_str)
                .ok_or_else(|| "Agent tool patch is missing toolCall.callId".to_string())?;
            if let Some(existing) = tools.iter_mut().find(|tool| {
                tool.pointer("/toolCall/callId").and_then(Value::as_str) == Some(call_id)
            }) {
                *existing = tool_patch.clone();
            } else {
                tools.push(tool_patch.clone());
            }
        }
    }
    Ok(())
}

fn upsert_agent_state(agent_states: &mut Vec<Value>, state: Value) -> Result<(), String> {
    validate_agent_state(&state)?;
    let request_id = agent_state_request_id(&state)?.to_string();
    if let Some(existing) = agent_states.iter_mut().find(|item| {
        item.pointer("/run/requestId").and_then(Value::as_str) == Some(request_id.as_str())
    }) {
        *existing = state;
    } else {
        agent_states.push(state);
    }
    Ok(())
}

fn apply_agent_record(
    agent_states: &mut Vec<Value>,
    record_type: &str,
    payload: &Value,
) -> Result<(), String> {
    match record_type {
        "agent_state" => upsert_agent_state(agent_states, payload.clone()),
        "agent_state_checkpoint" => {
            let checkpoint = parse_agent_checkpoint(payload)?;
            upsert_agent_state(agent_states, checkpoint.state)
        }
        "agent_state_patch" => {
            let patch = parse_agent_patch(payload)?;
            let state = agent_states
                .iter_mut()
                .find(|item| {
                    item.pointer("/run/requestId").and_then(Value::as_str)
                        == Some(patch.request_id.as_str())
                })
                .ok_or_else(|| "Agent patch has no preceding checkpoint".to_string())?;
            apply_agent_patch(state, &patch)
        }
        _ => Ok(()),
    }
}

fn recover_agent_state(mut state: Value) -> Option<Value> {
    let request_id = state.pointer("/run/requestId")?.as_str()?.to_string();
    if let Some(run) = state.get_mut("run").and_then(Value::as_object_mut) {
        if run.get("status").and_then(Value::as_str) == Some("running") {
            run.insert("status".to_string(), Value::String("cancelled".to_string()));
            run.insert("phase".to_string(), Value::String("incomplete".to_string()));
            run.insert("stopRequested".to_string(), Value::Bool(true));
            run.insert(
                "error".to_string(),
                Value::String("Agent task was cancelled during application restart.".to_string()),
            );
        }
    }
    if let Some(messages) = state.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            if message.get("requestId").and_then(Value::as_str) != Some(request_id.as_str()) {
                continue;
            }
            if message.get("status").and_then(Value::as_str) == Some("streaming") {
                if let Some(message) = message.as_object_mut() {
                    message.insert("status".to_string(), Value::String("cancelled".to_string()));
                }
            }
        }
    }
    if let Some(tools) = state.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools {
            if matches!(
                tool.get("status").and_then(Value::as_str),
                Some("pending" | "awaitingApproval" | "running")
            ) {
                let Some(tool) = tool.as_object_mut() else {
                    continue;
                };
                let call_id = tool
                    .get("toolCall")
                    .and_then(Value::as_object)
                    .and_then(|call| call.get("callId"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let recovered_from_status = tool
                    .get("status")
                    .cloned()
                    .unwrap_or_else(|| Value::String("pending".to_string()));
                tool.insert("recoveredFromStatus".to_string(), recovered_from_status);
                tool.insert("status".to_string(), Value::String("cancelled".to_string()));
                tool.insert(
                    "result".to_string(),
                    json!({
                        "requestId": request_id,
                        "callId": call_id,
                        "status": "cancelled",
                        "output": ""
                    }),
                );
                tool.remove("approval");
            }
        }
    }
    Some(state)
}

#[derive(Default)]
struct SessionAccumulator {
    meta: Option<AiSessionMeta>,
    updated_at: String,
    archived: bool,
    messages: Vec<Value>,
    agent_states: Vec<Value>,
    persisted_recovery: Option<AiSessionRecovery>,
}

impl SessionAccumulator {
    fn apply(&mut self, record: Value) -> Result<(), String> {
        let timestamp = record
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        match record.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                let payload = record
                    .get("payload")
                    .ok_or_else(|| "session_meta record is missing payload".to_string())?;
                self.meta = Some(
                    serde_json::from_value(payload.clone())
                        .map_err(|error| format!("invalid session metadata: {error}"))?,
                );
            }
            Some("response_item") => {
                let payload = record
                    .get("payload")
                    .ok_or_else(|| "response_item record is missing payload".to_string())?;
                validate_response_message(payload)?;
                let message = payload.clone();
                let id = message
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                self.messages
                    .retain(|item| item.get("id").and_then(Value::as_str) != Some(id.as_str()));
                self.messages.push(message);
            }
            Some(
                record_type @ ("agent_state" | "agent_state_checkpoint" | "agent_state_patch"),
            ) => {
                let payload = record
                    .get("payload")
                    .ok_or_else(|| format!("{record_type} record is missing payload"))?;
                apply_agent_record(&mut self.agent_states, record_type, payload)?;
            }
            Some("event_msg") => match record.pointer("/payload/type").and_then(Value::as_str) {
                Some("conversation_archived") => self.archived = true,
                Some("conversation_cleared") => {
                    if let Some(lane) = record.pointer("/payload/lane").and_then(Value::as_str) {
                        if lane == "agent" {
                            self.agent_states.clear();
                        } else {
                            self.messages
                                .retain(|message| message_lane(message) != lane);
                        }
                    }
                }
                Some(RECOVERY_EVENT_TYPE) => {
                    self.persisted_recovery = recovery_from_record(&record);
                }
                _ => {}
            },
            _ => {}
        }
        if let Some(timestamp) = timestamp {
            self.updated_at = timestamp;
        }
        Ok(())
    }
}

fn read_validated_jsonl_records(path: &Path) -> Result<(Vec<Value>, JsonlScan), String> {
    let mut accumulator = SessionAccumulator::default();
    let mut records = Vec::new();
    let scan = scan_jsonl(path, |record| {
        accumulator.apply(record.clone())?;
        records.push(record);
        Ok(())
    })?;
    debug_assert_eq!(records.len(), scan.valid_records);
    Ok((records, scan))
}

fn load_session_file(path: &Path) -> Result<AiSessionFile, String> {
    let mut accumulator = SessionAccumulator::default();
    let scan = scan_jsonl(path, |record| accumulator.apply(record))?;
    let recovery = scan.recovery.or(accumulator.persisted_recovery);
    let Some(meta) = accumulator.meta else {
        let detail = recovery
            .as_ref()
            .map(|recovery| format!(": {}", recovery.first_error))
            .unwrap_or_default();
        return Err(format!(
            "AI session {} has no valid metadata record{detail}",
            path.display()
        ));
    };
    let agent_states = accumulator
        .agent_states
        .into_iter()
        .filter_map(recover_agent_state)
        .collect();
    let conversation = AiConversationSummary {
        id: meta.id,
        started_at: meta.timestamp.clone(),
        updated_at: if accumulator.updated_at.is_empty() {
            meta.timestamp
        } else {
            accumulator.updated_at
        },
        title: meta.title,
        archived: accumulator.archived,
        scope: meta.scope,
        session_id: meta.session_id,
        profile_id: meta.profile_id,
        host: meta.host,
        port: meta.port,
        username: meta.username,
        recovery: recovery.clone(),
    };
    Ok(AiSessionFile {
        conversation,
        messages: accumulator.messages,
        agent_states,
        recovery,
    })
}

fn load_session_summary(path: &Path) -> Result<AiConversationSummary, String> {
    let mut meta: Option<AiSessionMeta> = None;
    let mut updated_at = String::new();
    let mut archived = false;
    let mut persisted_recovery = None;
    let scan = scan_jsonl(path, |record| {
        let timestamp = record
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        match record.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                let payload = record
                    .get("payload")
                    .ok_or_else(|| "session_meta record is missing payload".to_string())?;
                meta = Some(
                    serde_json::from_value(payload.clone())
                        .map_err(|error| format!("invalid session metadata: {error}"))?,
                );
            }
            Some("event_msg") => match record.pointer("/payload/type").and_then(Value::as_str) {
                Some("conversation_archived") => archived = true,
                Some(RECOVERY_EVENT_TYPE) => persisted_recovery = recovery_from_record(&record),
                _ => {}
            },
            _ => {}
        }
        if let Some(timestamp) = timestamp {
            updated_at = timestamp;
        }
        Ok(())
    })?;
    let recovery = scan.recovery.or(persisted_recovery);
    let Some(meta) = meta else {
        let detail = recovery
            .as_ref()
            .map(|recovery| format!(": {}", recovery.first_error))
            .unwrap_or_default();
        return Err(format!(
            "AI session {} has no valid metadata record{detail}",
            path.display()
        ));
    };
    Ok(AiConversationSummary {
        id: meta.id,
        started_at: meta.timestamp.clone(),
        updated_at: if updated_at.is_empty() {
            meta.timestamp
        } else {
            updated_at
        },
        title: meta.title,
        archived,
        scope: meta.scope,
        session_id: meta.session_id,
        profile_id: meta.profile_id,
        host: meta.host,
        port: meta.port,
        username: meta.username,
        recovery,
    })
}

#[tauri::command]
pub(crate) fn list_ai_sessions(app: AppHandle) -> Result<Vec<AiConversationSummary>, String> {
    let _ordinals = AI_SESSION_ORDINALS
        .lock()
        .map_err(|error| format!("AI session read lock poisoned: {error}"))?;
    let mut paths = Vec::new();
    collect_jsonl_files(&sessions_root(&app)?, &mut paths)?;
    let mut sessions = Vec::new();
    for path in paths {
        match load_session_summary(&path) {
            Ok(summary) => sessions.push(summary),
            Err(error) => log::warn!(
                "Skipping unreadable AI session path={} error={error}",
                path.display()
            ),
        }
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions)
}

#[tauri::command]
pub(crate) fn load_ai_session(
    app: AppHandle,
    conversation_id: String,
    started_at: String,
) -> Result<Option<AiSessionFile>, String> {
    let path = session_path(&sessions_root(&app)?, &conversation_id, &started_at)?;
    let _ordinals = AI_SESSION_ORDINALS
        .lock()
        .map_err(|error| format!("AI session read lock poisoned: {error}"))?;
    if !session_file_exists(&path)? {
        return Ok(None);
    }
    load_session_file(&path).map(Some)
}

#[cfg(test)]
mod tests {
    use super::{
        append_record, atomic_rewrite_with, clear_session_lane, date_parts,
        delete_ai_session_files, load_session_file, load_session_summary, session_file_exists,
        session_path, validate_agent_payload, AiSessionLocator, AiSessionMeta,
    };
    use crate::redaction::redact_json_value;
    use serde_json::{json, to_value};
    use std::fs;
    use tempfile::tempdir;

    fn sample_meta(id: &str) -> AiSessionMeta {
        AiSessionMeta {
            id: id.into(),
            timestamp: "2026-08-22T10:49:08.000Z".into(),
            title: "root@example.com".into(),
            scope: Some("terminal".into()),
            session_id: Some("terminal-1".into()),
            profile_id: None,
            host: "example.com".into(),
            port: 22,
            username: "root".into(),
        }
    }

    fn write_records(path: &std::path::Path, records: &[serde_json::Value]) {
        fs::write(
            path,
            records
                .iter()
                .map(|record| format!("{}\n", record))
                .collect::<String>(),
        )
        .unwrap();
    }

    #[test]
    fn builds_codex_style_date_path() {
        let root = tempdir().unwrap();
        let path = session_path(root.path(), "conversation-1", "2026-08-22T10:49:08.000Z").unwrap();
        assert!(path.ends_with("2026/08/22/rollout-2026-08-22T10-49-08-conversation-1.jsonl"));
        assert!(date_parts("bad").is_err());
        assert!(session_path(root.path(), "conversation-1", "2026-08-22/../../bad").is_err());
    }

    #[test]
    fn deletes_only_explicitly_selected_session_files() {
        let root = tempdir().unwrap();
        let first = AiSessionLocator {
            id: "conversation-1".to_string(),
            started_at: "2026-08-22T10:49:08.000Z".to_string(),
        };
        let second = AiSessionLocator {
            id: "conversation-2".to_string(),
            started_at: "2026-08-23T10:49:08.000Z".to_string(),
        };
        let first_path = session_path(root.path(), &first.id, &first.started_at).unwrap();
        let second_path = session_path(root.path(), &second.id, &second.started_at).unwrap();
        fs::create_dir_all(first_path.parent().unwrap()).unwrap();
        fs::create_dir_all(second_path.parent().unwrap()).unwrap();
        fs::write(&first_path, "first\n").unwrap();
        fs::write(&second_path, "second\n").unwrap();

        assert_eq!(
            delete_ai_session_files(root.path(), std::slice::from_ref(&first)).unwrap(),
            1
        );
        assert!(!first_path.exists());
        assert!(second_path.exists());
        assert_eq!(delete_ai_session_files(root.path(), &[first]).unwrap(), 0);
    }

    #[test]
    fn rebuilds_messages_from_append_only_events() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let meta = AiSessionMeta {
            id: "conversation-1".into(),
            timestamp: "2026-08-22T10:49:08.000Z".into(),
            title: "root@example.com".into(),
            scope: Some("terminal".into()),
            session_id: Some("terminal-1".into()),
            profile_id: None,
            host: "example.com".into(),
            port: 22,
            username: "root".into(),
        };
        let records = [
            json!({"timestamp": meta.timestamp, "type": "session_meta", "payload": to_value(meta).unwrap(), "ordinal": 0}),
            json!({"timestamp": "2026-08-22T10:50:00Z", "type": "response_item", "payload": {"id":"m1","task":"chat","content":"hi"}, "ordinal": 1}),
            json!({"timestamp": "2026-08-22T10:50:30Z", "type": "response_item", "payload": {"id":"m2","task":"generateCommand","content":"pwd"}, "ordinal": 2}),
            json!({"timestamp": "2026-08-22T10:50:45Z", "type": "event_msg", "payload": {"type":"conversation_cleared","lane":"conversation"}, "ordinal": 3}),
            json!({"timestamp": "2026-08-22T10:51:00Z", "type": "event_msg", "payload": {"type":"conversation_archived"}, "ordinal": 4}),
        ];
        fs::write(
            &path,
            records
                .iter()
                .map(|record| format!("{}\n", record))
                .collect::<String>(),
        )
        .unwrap();
        let loaded = load_session_file(&path).unwrap();
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.messages[0]["id"], "m2");
        assert!(loaded.conversation.archived);
        assert!(loaded.agent_states.is_empty());
        let summary = load_session_summary(&path).unwrap();
        assert_eq!(summary.id, "conversation-1");
        assert!(summary.archived);
    }

    #[test]
    fn loads_legacy_terminal_metadata_without_a_scope() {
        let root = tempdir().unwrap();
        let path = root.path().join("legacy-session.jsonl");
        write_records(
            &path,
            &[json!({
                "timestamp": "2026-08-22T10:49:08.000Z",
                "type": "session_meta",
                "payload": {
                    "id": "legacy-conversation",
                    "timestamp": "2026-08-22T10:49:08.000Z",
                    "title": "root@example.com",
                    "sessionId": "terminal-1",
                    "profileId": null,
                    "host": "example.com",
                    "port": 22,
                    "username": "root"
                },
                "ordinal": 0
            })],
        );

        let summary = load_session_summary(&path).unwrap();
        assert_eq!(summary.id, "legacy-conversation");
        assert_eq!(summary.scope, None);
    }

    #[test]
    fn recovers_interrupted_agent_state_as_cancelled_without_actionable_approval() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let meta = AiSessionMeta {
            id: "conversation-agent".into(),
            timestamp: "2026-08-22T10:49:08.000Z".into(),
            title: "root@example.com".into(),
            scope: Some("terminal".into()),
            session_id: Some("terminal-1".into()),
            profile_id: None,
            host: "example.com".into(),
            port: 22,
            username: "root".into(),
        };
        let state = json!({
            "run": {
                "requestId": "request-agent",
                "conversationId": "conversation-agent",
                "conversationStartedAt": meta.timestamp,
                "status": "running",
                "phase": "executing",
                "permissionMode": "fullAccess",
                "toolCallIds": []
            },
            "messages": [{
                "id": "agent-assistant-request-agent",
                "requestId": "request-agent",
                "content": "",
                "status": "streaming",
                "toolCallIds": []
            }],
            "tools": [{
                "toolCall": {
                    "requestId": "request-agent",
                    "callId": "call-1"
                },
                "status": "awaitingApproval",
                "approval": {
                    "requestId": "request-agent",
                    "callId": "call-1",
                    "approvalId": "must-not-recover"
                }
            }]
        });
        let records = [
            json!({"timestamp": meta.timestamp, "type": "session_meta", "payload": to_value(meta).unwrap(), "ordinal": 0}),
            json!({"timestamp": "2026-08-22T10:50:00Z", "type": "agent_state", "payload": state, "ordinal": 1}),
        ];
        fs::write(
            &path,
            records
                .iter()
                .map(|record| format!("{}\n", record))
                .collect::<String>(),
        )
        .unwrap();

        let loaded = load_session_file(&path).unwrap();
        let recovered = &loaded.agent_states[0];
        assert_eq!(recovered.pointer("/run/status").unwrap(), "cancelled");
        assert_eq!(
            recovered.pointer("/run/permissionMode").unwrap(),
            "fullAccess"
        );
        assert_eq!(
            recovered.pointer("/messages/0/status").unwrap(),
            "cancelled"
        );
        assert_eq!(recovered.pointer("/tools/0/status").unwrap(), "cancelled");
        assert_eq!(
            recovered.pointer("/tools/0/recoveredFromStatus").unwrap(),
            "awaitingApproval"
        );
        assert!(recovered.pointer("/tools/0/approval").is_none());
        assert_eq!(
            recovered.pointer("/tools/0/result/status").unwrap(),
            "cancelled"
        );
    }

    #[test]
    fn nested_agent_secrets_are_redacted_before_jsonl_append() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let meta = sample_meta("conversation-redaction");
        append_record(
            &path,
            &meta.timestamp,
            "session_meta",
            to_value(&meta).unwrap(),
        )
        .unwrap();
        let secret = "nested-agent-secret";
        let state = json!({
            "run": { "requestId": "request-redaction" },
            "tools": [{
                "arguments": {
                    "credentials": { "password": secret },
                    "items": [{ "output": format!("Authorization: Bearer {secret}") }]
                }
            }]
        });
        append_record(
            &path,
            "2026-08-22T10:50:00Z",
            "agent_state",
            redact_json_value(&state),
        )
        .unwrap();

        let persisted = fs::read_to_string(path).unwrap();
        assert!(!persisted.contains(secret));
        assert!(persisted.contains("[REDACTED]"));
    }

    #[test]
    fn clear_physically_removes_lane_records_and_corrupt_tail() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let meta = sample_meta("conversation-clear");
        let records = [
            json!({"timestamp": meta.timestamp, "type": "session_meta", "payload": to_value(meta).unwrap(), "ordinal": 0}),
            json!({"timestamp": "2026-08-22T10:50:00Z", "type": "response_item", "payload": {"id":"m-private","task":"chat","content":"private-conversation-payload"}, "ordinal": 1}),
            json!({"timestamp": "2026-08-22T10:50:30Z", "type": "response_item", "payload": {"id":"m-command","task":"generateCommand","content":"pwd"}, "ordinal": 2}),
            json!({"timestamp": "2026-08-22T10:51:00Z", "type": "agent_state", "payload": {"run":{"requestId":"request-clear","status":"completed"},"messages":[],"tools":[],"private":"private-agent-payload"}, "ordinal": 3}),
        ];
        let mut persisted = records
            .iter()
            .map(|record| format!("{}\n", record))
            .collect::<String>();
        persisted.push_str("{\"truncated\":\"private-tail-payload");
        fs::write(&path, persisted).unwrap();

        clear_session_lane(&path, "2026-08-22T10:52:00Z", "conversation").unwrap();
        let persisted = fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains("private-conversation-payload"));
        assert!(!persisted.contains("private-tail-payload"));
        assert!(persisted.contains("private-agent-payload"));
        assert!(persisted.contains("\"content\":\"pwd\""));
        let loaded = load_session_file(&path).unwrap();
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.messages[0]["id"], "m-command");
        assert!(loaded.recovery.is_some());

        clear_session_lane(&path, "2026-08-22T10:53:00Z", "agent").unwrap();
        let persisted = fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains("private-agent-payload"));
        assert!(load_session_file(&path).unwrap().agent_states.is_empty());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn failed_atomic_replace_preserves_original_and_cleans_temp_file() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let original = b"original-private-record\n";
        fs::write(&path, original).unwrap();
        let mut replacement = vec![json!({
            "timestamp": "2026-08-22T10:52:00Z",
            "type": "event_msg",
            "payload": {"type":"conversation_cleared","lane":"conversation"}
        })];

        let error = atomic_rewrite_with(&path, &mut replacement, |_temporary, _destination| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected replace failure",
            ))
        })
        .unwrap_err();

        assert!(error.contains("injected replace failure"));
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn clear_does_not_treat_path_inspection_errors_as_a_missing_session() {
        let root = tempdir().unwrap();
        let non_directory = root.path().join("not-a-directory");
        fs::write(&non_directory, b"private-session-data").unwrap();
        let inaccessible_path = non_directory.join("session.jsonl");

        let inspect_error = session_file_exists(&inaccessible_path).unwrap_err();
        assert!(inspect_error.contains("failed to inspect AI session"));
        let clear_error =
            clear_session_lane(&inaccessible_path, "2026-08-22T10:52:00Z", "conversation")
                .unwrap_err();

        assert!(clear_error.contains("failed to inspect AI session"));
        assert_eq!(fs::read(non_directory).unwrap(), b"private-session-data");
    }

    #[test]
    fn corrupt_tail_returns_auditable_valid_prefix_recovery() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let meta = sample_meta("conversation-corrupt");
        let prefix = [
            json!({"timestamp": meta.timestamp, "type": "session_meta", "payload": to_value(meta).unwrap(), "ordinal": 0}),
            json!({"timestamp": "2026-08-22T10:50:00Z", "type": "response_item", "payload": {"id":"m1","task":"chat","content":"valid prefix"}, "ordinal": 1}),
        ];
        let mut persisted = prefix
            .iter()
            .map(|record| format!("{}\n", record))
            .collect::<String>();
        persisted.push_str("{\"timestamp\":\"truncated");
        fs::write(&path, persisted).unwrap();

        let loaded = load_session_file(&path).unwrap();
        assert_eq!(loaded.messages.len(), 1);
        let recovery = loaded.recovery.unwrap();
        assert_eq!(recovery.valid_records, 2);
        assert!(recovery.skipped_bytes > 0);
        assert!(recovery.first_error.contains("line 3"));
        assert!(load_session_summary(&path).unwrap().recovery.is_some());

        let invalid_path = root.path().join("invalid.jsonl");
        fs::write(&invalid_path, b"not-json\n").unwrap();
        let error = load_session_file(&invalid_path).unwrap_err();
        assert!(error.contains("no valid metadata"));
        assert!(error.contains("line 1"));

        let schema_path = root.path().join("invalid-message-schema.jsonl");
        let schema_meta = sample_meta("conversation-invalid-message");
        write_records(
            &schema_path,
            &[
                json!({"timestamp":schema_meta.timestamp,"type":"session_meta","payload":to_value(schema_meta).unwrap(),"ordinal":0}),
                json!({"timestamp":"2026-08-22T10:50:00Z","type":"response_item","payload":{"id":"m-valid","content":"valid prefix"},"ordinal":1}),
                json!({"timestamp":"2026-08-22T10:51:00Z","type":"response_item","payload":{"id":"m-invalid","content":null},"ordinal":2}),
            ],
        );
        let recovered = load_session_file(&schema_path).unwrap();
        assert_eq!(recovered.messages.len(), 1);
        assert_eq!(recovered.messages[0]["id"], "m-valid");
        let schema_recovery = recovered.recovery.unwrap();
        assert_eq!(schema_recovery.valid_records, 2);
        assert!(schema_recovery
            .first_error
            .contains("content is not a string"));
    }

    #[test]
    fn append_repairs_corrupt_tail_before_writing_new_record() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let meta = sample_meta("conversation-append-recovery");
        let prefix = [
            json!({"timestamp": meta.timestamp, "type": "session_meta", "payload": to_value(meta).unwrap(), "ordinal": 0}),
            json!({"timestamp": "2026-08-22T10:50:00Z", "type": "response_item", "payload": {"id":"m1","task":"chat","content":"before"}, "ordinal": 1}),
        ];
        let mut persisted = prefix
            .iter()
            .map(|record| format!("{}\n", record))
            .collect::<String>();
        persisted.push_str("{\"private\":\"truncated-tail-secret");
        fs::write(&path, persisted).unwrap();

        append_record(
            &path,
            "2026-08-22T10:51:00Z",
            "response_item",
            json!({"id":"m2","task":"chat","content":"after"}),
        )
        .unwrap();

        let persisted = fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains("truncated-tail-secret"));
        for line in persisted.lines() {
            serde_json::from_str::<serde_json::Value>(line).unwrap();
        }
        let loaded = load_session_file(&path).unwrap();
        assert_eq!(loaded.messages.len(), 2);
        assert!(loaded.recovery.is_some());
    }

    #[test]
    fn replays_versioned_agent_checkpoint_and_incremental_patch() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let meta = sample_meta("conversation-patch");
        let checkpoint = json!({
            "kind": "checkpoint",
            "version": 1,
            "state": {
                "run": {
                    "requestId":"request-patch",
                    "conversationId":"conversation-patch",
                    "status":"running",
                    "toolCallIds":[]
                },
                "messages": [{
                    "id":"message-patch","requestId":"request-patch","content":"hello",
                    "status":"streaming","toolCallIds":[]
                }],
                "tools": []
            }
        });
        let patch = json!({
            "kind": "patch",
            "version": 1,
            "requestId": "request-patch",
            "run": {"set":{"status":"completed"},"appendToolCallIds":["call-1"]},
            "messages": [{
                "id":"message-patch","appendContent":" world","contentOffsetBytes":5,
                "set":{"status":"completed"},"appendToolCallIds":["call-1"]
            }],
            "tools": [{
                "toolCall":{"requestId":"request-patch","callId":"call-1"},
                "status":"completed"
            }]
        });
        assert_eq!(
            validate_agent_payload(&checkpoint).unwrap(),
            "agent_state_checkpoint"
        );
        assert_eq!(validate_agent_payload(&patch).unwrap(), "agent_state_patch");
        write_records(
            &path,
            &[
                json!({"timestamp": meta.timestamp, "type":"session_meta", "payload":to_value(meta).unwrap(), "ordinal":0}),
                json!({"timestamp":"2026-08-22T10:50:00Z", "type":"agent_state_checkpoint", "payload":checkpoint, "ordinal":1}),
                json!({"timestamp":"2026-08-22T10:50:01Z", "type":"agent_state_patch", "payload":patch, "ordinal":2}),
            ],
        );

        let loaded = load_session_file(&path).unwrap();
        let state = &loaded.agent_states[0];
        assert_eq!(state.pointer("/run/status").unwrap(), "completed");
        assert_eq!(state.pointer("/run/toolCallIds/0").unwrap(), "call-1");
        assert_eq!(state.pointer("/messages/0/content").unwrap(), "hello world");
        assert_eq!(state.pointer("/messages/0/status").unwrap(), "completed");
        assert_eq!(state.pointer("/tools/0/status").unwrap(), "completed");
    }

    #[test]
    fn long_agent_stream_has_linear_disk_growth_and_exceeds_snapshot_limit_gracefully() {
        const PATCH_COUNT: usize = 300;
        const DELTA_BYTES: usize = 4096;
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let meta = sample_meta("conversation-long-patch");
        let mut records = vec![
            json!({"timestamp": meta.timestamp, "type":"session_meta", "payload":to_value(meta).unwrap(), "ordinal":0}),
            json!({
                "timestamp":"2026-08-22T10:50:00Z",
                "type":"agent_state_checkpoint",
                "payload":{
                    "kind":"checkpoint","version":1,
                    "state":{
                        "run":{
                            "requestId":"request-long",
                            "conversationId":"conversation-long-patch",
                            "status":"completed",
                            "toolCallIds":[]
                        },
                        "messages":[{"id":"message-long","requestId":"request-long","content":"","status":"completed","toolCallIds":[]}],
                        "tools":[]
                    }
                },
                "ordinal":1
            }),
        ];
        let delta = "x".repeat(DELTA_BYTES);
        for ordinal in 0..PATCH_COUNT {
            let patch = json!({
                "kind":"patch","version":1,"requestId":"request-long",
                "messages":[{
                    "id":"message-long","appendContent":delta,
                    "contentOffsetBytes":ordinal * DELTA_BYTES
                }]
            });
            assert!(serde_json::to_vec(&patch).unwrap().len() < super::MAX_AGENT_STATE_BYTES);
            records.push(json!({
                "timestamp":"2026-08-22T10:50:01Z",
                "type":"agent_state_patch",
                "payload":patch,
                "ordinal":ordinal + 2
            }));
        }
        write_records(&path, &records);

        let final_content_bytes = PATCH_COUNT * DELTA_BYTES;
        assert!(final_content_bytes > super::MAX_AGENT_STATE_BYTES);
        assert!(fs::metadata(&path).unwrap().len() < (final_content_bytes * 2) as u64);
        let loaded = load_session_file(&path).unwrap();
        assert_eq!(
            loaded.agent_states[0]
                .pointer("/messages/0/content")
                .and_then(serde_json::Value::as_str)
                .unwrap()
                .len(),
            final_content_bytes
        );
    }

    #[test]
    fn content_offsets_make_retried_agent_deltas_idempotent() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let meta = sample_meta("conversation-idempotent-patch");
        let checkpoint = json!({
            "kind":"checkpoint","version":1,
            "state":{
                "run":{
                    "requestId":"request-idempotent",
                    "conversationId":"conversation-idempotent-patch",
                    "status":"completed",
                    "toolCallIds":[]
                },
                "messages":[{
                    "id":"message-idempotent","requestId":"request-idempotent",
                    "content":"hi","status":"completed","toolCallIds":[]
                }],
                "tools":[]
            }
        });
        let patch = json!({
            "kind":"patch","version":1,"requestId":"request-idempotent",
            "messages":[
                {"id":"message-idempotent","appendContent":" there","contentOffsetBytes":2},
                {"id":"message-idempotent","appendContent":" friend","contentOffsetBytes":8}
            ]
        });
        write_records(
            &path,
            &[
                json!({"timestamp":meta.timestamp,"type":"session_meta","payload":to_value(meta).unwrap(),"ordinal":0}),
                json!({"timestamp":"2026-08-22T10:50:00Z","type":"agent_state_checkpoint","payload":checkpoint.clone(),"ordinal":1}),
                json!({"timestamp":"2026-08-22T10:50:01Z","type":"agent_state_patch","payload":patch,"ordinal":2}),
                // Simulate a durable append whose IPC response was lost and retried.
                json!({"timestamp":"2026-08-22T10:50:02Z","type":"agent_state_patch","payload":patch,"ordinal":3}),
            ],
        );

        let loaded = load_session_file(&path).unwrap();
        assert_eq!(
            loaded.agent_states[0]
                .pointer("/messages/0/content")
                .unwrap(),
            "hi there friend"
        );
        assert!(loaded.recovery.is_none());
    }

    #[test]
    fn malformed_patch_does_not_partially_mutate_the_valid_prefix() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let meta = sample_meta("conversation-malformed-patch");
        let checkpoint = json!({
            "kind":"checkpoint","version":1,
            "state":{
                "run":{
                    "requestId":"request-malformed",
                    "conversationId":"conversation-malformed-patch",
                    "status":"completed",
                    "toolCallIds":[]
                },
                "messages":[{
                    "id":"message-valid","requestId":"request-malformed",
                    "content":"prefix","status":"completed","toolCallIds":[]
                }],
                "tools":[]
            }
        });
        let malformed = json!({
            "kind":"patch","version":1,"requestId":"request-malformed",
            "run":{"set":{"status":"failed"}},
            "messages":[
                {"id":"message-valid","appendContent":" changed","contentOffsetBytes":6},
                {"id":"missing-message","appendContent":" invalid","contentOffsetBytes":0}
            ]
        });
        write_records(
            &path,
            &[
                json!({"timestamp":meta.timestamp,"type":"session_meta","payload":to_value(meta).unwrap(),"ordinal":0}),
                json!({"timestamp":"2026-08-22T10:50:00Z","type":"agent_state_checkpoint","payload":checkpoint.clone(),"ordinal":1}),
                json!({"timestamp":"2099-01-01T00:00:00Z","type":"agent_state_patch","payload":malformed,"ordinal":2}),
            ],
        );

        let loaded = load_session_file(&path).unwrap();
        let state = &loaded.agent_states[0];
        assert_eq!(state.pointer("/run/status").unwrap(), "completed");
        assert_eq!(state.pointer("/messages/0/content").unwrap(), "prefix");
        assert_eq!(loaded.conversation.updated_at, "2026-08-22T10:50:00Z");
        let recovery = loaded.recovery.unwrap();
        assert_eq!(recovery.valid_records, 2);
        assert!(recovery.first_error.contains("missing-message"));

        let invalid_set_path = root.path().join("invalid-set.jsonl");
        let invalid_set_meta = sample_meta("conversation-invalid-set");
        write_records(
            &invalid_set_path,
            &[
                json!({"timestamp":invalid_set_meta.timestamp,"type":"session_meta","payload":to_value(invalid_set_meta).unwrap(),"ordinal":0}),
                json!({"timestamp":"2026-08-22T10:50:00Z","type":"agent_state_checkpoint","payload":checkpoint,"ordinal":1}),
                json!({"timestamp":"2099-01-01T00:00:00Z","type":"agent_state_patch","payload":{
                    "kind":"patch","version":1,"requestId":"request-malformed",
                    "run":{"set":{"status":null}}
                },"ordinal":2}),
            ],
        );
        let invalid_set_loaded = load_session_file(&invalid_set_path).unwrap();
        assert_eq!(
            invalid_set_loaded.agent_states[0]
                .pointer("/run/status")
                .unwrap(),
            "completed"
        );
        let invalid_set_recovery = invalid_set_loaded.recovery.unwrap();
        assert_eq!(invalid_set_recovery.valid_records, 2);
        assert!(invalid_set_recovery.first_error.contains("status"));

        let invalid_upsert = json!({
            "kind":"patch","version":1,"requestId":"request-malformed",
            "messages":[{
                "id":"message-invalid","upsert":{
                    "id":"message-invalid","requestId":"request-malformed",
                    "content":null,"toolCallIds":[]
                }
            }]
        });
        assert!(validate_agent_payload(&invalid_upsert)
            .unwrap_err()
            .contains("content"));
    }
}
