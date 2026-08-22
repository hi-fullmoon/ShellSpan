use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Manager};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

static AI_SESSION_ORDINALS: LazyLock<Mutex<HashMap<PathBuf, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const SESSION_SUMMARY_TAIL_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSessionMeta {
    pub id: String,
    pub timestamp: String,
    pub title: String,
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
    pub session_id: Option<String>,
    pub profile_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSessionFile {
    pub conversation: AiConversationSummary,
    pub messages: Vec<Value>,
}

fn sessions_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve home directory: {error}"))?
        .join(".termbridge")
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

fn append_record(
    path: &Path,
    timestamp: &str,
    record_type: &str,
    payload: Value,
) -> Result<(), String> {
    let mut ordinals = AI_SESSION_ORDINALS
        .lock()
        .map_err(|error| format!("AI session write lock poisoned: {error}"))?;
    let ordinal = ordinals.get(path).copied().unwrap_or_else(|| {
        if path.exists() {
            File::open(path)
                .map(BufReader::new)
                .map(|reader| reader.lines().count())
                .unwrap_or(0)
        } else {
            0
        }
    });
    let record = json!({
        "timestamp": timestamp,
        "type": record_type,
        "payload": payload,
        "ordinal": ordinal,
    });
    let mut encoded = serde_json::to_vec(&record)
        .map_err(|error| format!("failed to encode AI session record: {error}"))?;
    encoded.push(b'\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to append AI session: {error}"))?;
    file.write_all(&encoded)
        .and_then(|_| file.flush())
        .map_err(|error| format!("failed to flush AI session record: {error}"))?;
    ordinals.insert(path.to_path_buf(), ordinal + 1);
    Ok(())
}

#[tauri::command]
pub(crate) fn create_ai_session(app: AppHandle, meta: AiSessionMeta) -> Result<(), String> {
    let root = sessions_root(&app)?;
    let path = session_path(&root, &meta.id, &meta.timestamp)?;
    if path.exists() {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "AI session path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create AI session directory: {error}"))?;
    #[cfg(unix)]
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("failed to secure AI sessions directory: {error}"))?;
    append_record(
        &path,
        &meta.timestamp,
        "session_meta",
        serde_json::to_value(&meta)
            .map_err(|error| format!("failed to encode AI session metadata: {error}"))?,
    )?;
    #[cfg(unix)]
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("failed to secure AI session file: {error}"))?;
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
    if !path.exists() {
        return Err("AI session does not exist".to_string());
    }
    append_record(&path, &timestamp, "response_item", message)
}

#[tauri::command]
pub(crate) fn clear_ai_session_lane(
    app: AppHandle,
    conversation_id: String,
    started_at: String,
    timestamp: String,
    lane: String,
) -> Result<(), String> {
    if lane != "conversation" && lane != "command" {
        return Err("invalid AI conversation lane".to_string());
    }
    let path = session_path(&sessions_root(&app)?, &conversation_id, &started_at)?;
    if !path.exists() {
        return Ok(());
    }
    append_record(
        &path,
        &timestamp,
        "event_msg",
        json!({ "type": "conversation_cleared", "lane": lane }),
    )
}

#[tauri::command]
pub(crate) fn archive_ai_session(
    app: AppHandle,
    conversation_id: String,
    started_at: String,
    timestamp: String,
) -> Result<(), String> {
    let path = session_path(&sessions_root(&app)?, &conversation_id, &started_at)?;
    if !path.exists() {
        return Ok(());
    }
    append_record(
        &path,
        &timestamp,
        "event_msg",
        json!({ "type": "conversation_archived", "reason": "terminal_closed" }),
    )
}

fn collect_jsonl_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if !directory.exists() {
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
    if message.get("task").and_then(Value::as_str) == Some("generateCommand") {
        "command"
    } else {
        "conversation"
    }
}

fn load_session_file(path: &Path) -> Option<AiSessionFile> {
    let file = File::open(path).ok()?;
    let mut meta: Option<AiSessionMeta> = None;
    let mut updated_at = String::new();
    let mut archived = false;
    let mut messages: Vec<Value> = Vec::new();

    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) {
            updated_at = timestamp.to_string();
        }
        match record.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if let Some(payload) = record.get("payload") {
                    meta = serde_json::from_value(payload.clone()).ok().or(meta);
                }
            }
            Some("response_item") => {
                let Some(message) = record.get("payload").cloned() else {
                    continue;
                };
                if message.get("id").and_then(Value::as_str).is_some() {
                    if let Some(id) = message.get("id").and_then(Value::as_str) {
                        messages.retain(|item| item.get("id").and_then(Value::as_str) != Some(id));
                    }
                    messages.push(message);
                }
            }
            Some("event_msg") => match record
                .get("payload")
                .and_then(|payload| payload.get("type"))
                .and_then(Value::as_str)
            {
                Some("conversation_archived") => archived = true,
                Some("conversation_cleared") => {
                    if let Some(lane) = record
                        .get("payload")
                        .and_then(|payload| payload.get("lane"))
                        .and_then(Value::as_str)
                    {
                        messages.retain(|message| message_lane(message) != lane);
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }

    let meta = meta?;
    Some(AiSessionFile {
        conversation: AiConversationSummary {
            id: meta.id,
            started_at: meta.timestamp.clone(),
            updated_at: if updated_at.is_empty() {
                meta.timestamp
            } else {
                updated_at
            },
            title: meta.title,
            archived,
            session_id: meta.session_id,
            profile_id: meta.profile_id,
            host: meta.host,
            port: meta.port,
            username: meta.username,
        },
        messages,
    })
}

fn load_session_summary(path: &Path) -> Option<AiConversationSummary> {
    let file = File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    let mut reader = BufReader::new(file);
    let mut first_line = String::new();
    reader.read_line(&mut first_line).ok()?;
    let first_record = serde_json::from_str::<Value>(&first_line).ok()?;
    if first_record.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let meta: AiSessionMeta = serde_json::from_value(first_record.get("payload")?.clone()).ok()?;
    let first_line_len = first_line.len() as u64;
    if file_len <= first_line_len {
        return None;
    }

    let tail_start = file_len.saturating_sub(SESSION_SUMMARY_TAIL_BYTES);
    reader.seek(SeekFrom::Start(tail_start)).ok()?;
    let mut tail_bytes = Vec::new();
    reader.read_to_end(&mut tail_bytes).ok()?;
    let tail = String::from_utf8_lossy(&tail_bytes);
    let mut updated_at = meta.timestamp.clone();
    let mut archived = false;
    for line in tail.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) {
            updated_at = timestamp.to_string();
        }
        if record.get("type").and_then(Value::as_str) == Some("event_msg")
            && record
                .get("payload")
                .and_then(|payload| payload.get("type"))
                .and_then(Value::as_str)
                == Some("conversation_archived")
        {
            archived = true;
        }
    }

    Some(AiConversationSummary {
        id: meta.id,
        started_at: meta.timestamp,
        updated_at,
        title: meta.title,
        archived,
        session_id: meta.session_id,
        profile_id: meta.profile_id,
        host: meta.host,
        port: meta.port,
        username: meta.username,
    })
}

#[tauri::command]
pub(crate) fn list_ai_sessions(app: AppHandle) -> Result<Vec<AiConversationSummary>, String> {
    let mut paths = Vec::new();
    collect_jsonl_files(&sessions_root(&app)?, &mut paths)?;
    let mut sessions: Vec<AiConversationSummary> = paths
        .iter()
        .filter_map(|path| load_session_summary(path))
        .collect();
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
    Ok(load_session_file(&path))
}

#[cfg(test)]
mod tests {
    use super::{date_parts, load_session_file, load_session_summary, session_path, AiSessionMeta};
    use serde_json::{json, to_value};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn builds_codex_style_date_path() {
        let root = tempdir().unwrap();
        let path = session_path(root.path(), "conversation-1", "2026-08-22T10:49:08.000Z").unwrap();
        assert!(path.ends_with("2026/08/22/rollout-2026-08-22T10-49-08-conversation-1.jsonl"));
        assert!(date_parts("bad").is_err());
    }

    #[test]
    fn rebuilds_messages_from_append_only_events() {
        let root = tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let meta = AiSessionMeta {
            id: "conversation-1".into(),
            timestamp: "2026-08-22T10:49:08.000Z".into(),
            title: "root@example.com".into(),
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
        let summary = load_session_summary(&path).unwrap();
        assert_eq!(summary.id, "conversation-1");
        assert!(summary.archived);
    }
}
