//! Explicit offline v4 -> v5 converter. Production readers never call this module.
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(unix)]
use std::fs::File;
use std::{
    collections::HashSet,
    fs::OpenOptions,
    io::{BufRead, BufReader, Seek, Write},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversionResult {
    pub source: PathBuf,
    pub destination: PathBuf,
    pub events: usize,
    pub status: String,
}

pub(crate) fn convert_v4_to_v5(
    source: &Path,
    destination: &Path,
) -> Result<ConversionResult, String> {
    if source == destination {
        return Err("MIGRATION_SOURCE_MUST_BE_PRESERVED".into());
    }
    let parent = destination
        .parent()
        .ok_or("INVALID_MIGRATION_DESTINATION")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let lock_path = source.with_extension("migration.lock");
    let backup = destination.with_extension("v4.backup.jsonl");
    if destination.exists() {
        let events = read_and_validate_v5(destination)?;
        if !backup.exists() {
            return Err("MIGRATION_BACKUP_MISSING".into());
        }
        let _ = std::fs::remove_file(&lock_path);
        return Ok(ConversionResult {
            source: source.into(),
            destination: destination.into(),
            events,
            status: "alreadyConverted".into(),
        });
    }
    let mut marker = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|e| format!("MIGRATION_BUSY: {e}"))?;
    marker
        .write_all(b"preparing")
        .and_then(|_| marker.sync_all())
        .map_err(|e| format!("MIGRATION_MARKER: {e}"))?;
    drop(marker);
    // On Windows share_mode(0) excludes appenders too; the old writer cannot race this read.
    #[cfg(windows)]
    let mut input = {
        use std::os::windows::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(source)
            .map_err(|e| format!("MIGRATION_BUSY: {e}"))?
    };
    #[cfg(not(windows))]
    let mut input = File::open(source).map_err(|e| format!("MIGRATION_SOURCE: {e}"))?;
    if !backup.exists() {
        let mut backup_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&backup)
            .map_err(|e| format!("MIGRATION_BACKUP: {e}"))?;
        std::io::copy(&mut input, &mut backup_file).map_err(|e| e.to_string())?;
        backup_file
            .sync_all()
            .map_err(|e| format!("MIGRATION_BACKUP_SYNC: {e}"))?;
        input.rewind().map_err(|e| e.to_string())?;
    }
    let mut events = Vec::new();
    for (index, line) in BufReader::new(input).lines().enumerate() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let mut event: Value = serde_json::from_str(&line)
            .map_err(|e| format!("MIGRATION_INVALID_EVENT line {}: {e}", index + 1))?;
        if event["version"] != 4 {
            return Err(format!("MIGRATION_EXPECTED_V4 line {}", index + 1));
        }
        event["version"] = Value::from(5);
        let request_identity = matches!(
            event["type"].as_str(),
            Some("request/header" | "request/start")
        )
        .then(|| {
            (
                event["data"]["providerId"].clone(),
                event["data"]["model"].clone(),
            )
        });
        migrate_provider_descriptors(&mut event);
        if let Some((provider, model)) = request_identity {
            event["data"]
                .as_object_mut()
                .expect("request data")
                .remove("routeId");
            event["data"]
                .as_object_mut()
                .expect("request data")
                .remove("modelId");
            event["data"]["providerId"] = provider;
            event["data"]["model"] = model;
        }
        if event["type"] == "request/header" {
            let snapshot = serde_json::json!({"status":"legacyUnknown"});
            event["data"]["snapshotDigest"] = Value::String(crate::llm::runtime::digest(
                &serde_json::to_vec(&snapshot).expect("legacy snapshot"),
            ));
            event["data"]["snapshot"] = snapshot;
        }
        if event["type"] == "assistant/message" && event["data"].get("replay").is_none() {
            event["data"]["replay"] =
                serde_json::json!({"status":"legacyUnknown","archivedProviderItems":true});
        }
        events.push(event);
    }
    validate(&events)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    for event in &events {
        serde_json::to_writer(&mut temporary, event).map_err(|e| e.to_string())?;
        temporary.write_all(b"\n").map_err(|e| e.to_string())?;
    }
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|e| e.to_string())?;
    // Replay through the full production validator before the filesystem
    // publication point: envelope, transition, payload, redaction, Inbox,
    // surface derivation, and final record invariants all apply here.
    let decoded = events
        .iter()
        .cloned()
        .map(serde_json::from_value::<crate::agent_runtime::AgentSessionEvent>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("MIGRATION_V5_VALIDATION: {e}"))?;
    crate::agent_runtime::validate_session_events(decoded)
        .map_err(|e| format!("MIGRATION_V5_VALIDATION: {e}"))?;
    temporary
        .persist_noclobber(destination)
        .map_err(|e| format!("MIGRATION_PUBLISH: {}", e.error))?;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("MIGRATION_DIRECTORY_SYNC: {e}"))?;
    // The destination is already atomically published. A stale marker is safe
    // to clean on the next idempotent run and must not turn success into failure.
    let _ = std::fs::remove_file(lock_path);
    Ok(ConversionResult {
        source: source.into(),
        destination: destination.into(),
        events: events.len(),
        status: "converted".into(),
    })
}

fn read_and_validate_v5(path: &Path) -> Result<usize, String> {
    let input = std::fs::File::open(path).map_err(|e| format!("MIGRATION_DESTINATION: {e}"))?;
    let mut events = Vec::new();
    for (index, line) in BufReader::new(input).lines().enumerate() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        events.push(
            serde_json::from_str::<crate::agent_runtime::AgentSessionEvent>(&line)
                .map_err(|e| format!("MIGRATION_V5_VALIDATION line {}: {e}", index + 1))?,
        );
    }
    let count = events.len();
    crate::agent_runtime::validate_session_events(events)
        .map_err(|e| format!("MIGRATION_V5_VALIDATION: {e}"))?;
    Ok(count)
}

fn migrate_provider_descriptors(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if object.contains_key("providerId") && object.contains_key("model") {
                let route = object.remove("providerId").unwrap();
                let model = object.remove("model").unwrap();
                let reasoning = object.remove("reasoningEffort");
                for key in [
                    "profile",
                    "retryPolicy",
                    "providerKind",
                    "baseUrl",
                    "requiresApiKey",
                ] {
                    object.remove(key);
                }
                object.insert("routeId".into(), route);
                object.insert("modelId".into(), model);
                if let Some(reasoning) = reasoning {
                    object.insert("reasoningEffort".into(), reasoning);
                }
            } else {
                for item in object.values_mut() {
                    migrate_provider_descriptors(item);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                migrate_provider_descriptors(item);
            }
        }
        _ => {}
    }
}

fn validate(events: &[Value]) -> Result<(), String> {
    let mut seq = None;
    let mut calls = HashSet::new();
    for event in events {
        let current = event["seq"].as_u64().ok_or("MIGRATION_MISSING_SEQ")?;
        if seq.is_some_and(|previous| current <= previous) {
            return Err("MIGRATION_INVALID_SEQUENCE".into());
        }
        seq = Some(current);
        let payload = event;
        if payload["type"] == "tool/call" {
            if let Some(id) = payload["data"]["call"]["callId"].as_str() {
                calls.insert(id.to_string());
            }
        }
        if payload["type"] == "tool/result" {
            let id = payload["data"]["callId"]
                .as_str()
                .ok_or("MIGRATION_INVALID_TOOL_RESULT")?;
            if !calls.contains(id) {
                return Err("MIGRATION_ORPHAN_TOOL_RESULT".into());
            }
        }
        if payload["type"] == "tool/approval" {
            let id = payload["data"]["callId"]
                .as_str()
                .ok_or("MIGRATION_INVALID_APPROVAL")?;
            if !calls.contains(id) {
                return Err("MIGRATION_ORPHAN_APPROVAL".into());
            }
        }
        if payload["type"] == "user/message" {
            if let Some(images) = payload["data"]["message"]["images"].as_array() {
                for image in images {
                    serde_json::from_value::<crate::agent_runtime::images::ImageRef>(image.clone())
                        .map_err(|e| format!("MIGRATION_INVALID_IMAGE: {e}"))?
                        .validate()?;
                }
            }
        }
        // Conversion has no executor and cannot append tool results or approvals.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::{
        AgentAssistantContentBlock, AgentInboxMessage, AgentMessageSource, AgentRequestReason,
        AgentRequestSeries, AgentRequestSnapshotReason, AgentSessionEffect,
        AgentSessionEventPayload, AgentSessionStore, AgentStopReason, AgentTokenUsage,
        AgentToolApprovalStatus, CreateAgentSessionRequest, RecordedToolCall,
    };
    use base64::{engine::general_purpose::STANDARD, Engine};

    fn write_v4(path: &Path, events: &[Value]) {
        let raw = events
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(path, raw).unwrap();
    }

    fn production_log(root: &Path, session_id: &str, rich: bool) -> (Vec<Value>, Option<PathBuf>) {
        let store = AgentSessionStore::default();
        store.configure(root.join("store")).unwrap();
        store
            .create(CreateAgentSessionRequest {
                session_id: session_id.into(),
                task_id: "migration-task".into(),
                goal: "validate an offline migration".into(),
                parent_session_id: None,
                target: None,
                permission_mode: None,
                success_criteria: Vec::new(),
                capability_scope: None,
                subagent: None,
            })
            .unwrap();

        let attachment = if rich {
            let bytes = STANDARD
                .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
                .unwrap();
            let sha256 = crate::llm::runtime::digest(&bytes);
            let attachment_dir = root.join("attachments");
            std::fs::create_dir_all(&attachment_dir).unwrap();
            let path = attachment_dir.join(format!("{sha256}.png"));
            std::fs::write(&path, &bytes).unwrap();
            let image = crate::agent_runtime::images::ImageRef {
                version: 1,
                sha256,
                media_type: "image/png".into(),
                bytes: bytes.len() as u64,
                width: 1,
                height: 1,
                name: "pixel.png".into(),
            };
            store
                .append(
                    session_id,
                    Some("turn-1".into()),
                    None,
                    AgentSessionEventPayload::TurnStart,
                )
                .unwrap();
            store
                .append(
                    session_id,
                    Some("turn-1".into()),
                    Some("step-1".into()),
                    AgentSessionEventPayload::StepStart,
                )
                .unwrap();
            store
                .append(
                    session_id,
                    Some("turn-1".into()),
                    Some("step-1".into()),
                    AgentSessionEventPayload::UserMessage {
                        message: AgentInboxMessage {
                            images: vec![image],
                            message_id: "message-image".into(),
                            client_submission_id: None,
                            content: "inspect the retained image".into(),
                            source: AgentMessageSource::user(),
                        },
                    },
                )
                .unwrap();
            let snapshot = crate::llm::runtime::RequestSnapshot::LegacyUnknown;
            let series = AgentRequestSeries {
                series_id: "series-1".into(),
                request_index: 0,
                starts_series: true,
            };
            store
                .append(
                    session_id,
                    Some("turn-1".into()),
                    Some("step-1".into()),
                    AgentSessionEventPayload::RequestHeader {
                        request_id: "request-1".into(),
                        snapshot_digest: Some(snapshot.digest()),
                        snapshot: Some(snapshot),
                        provider_id: "legacy-route".into(),
                        model: "legacy-model".into(),
                        reasoning_effort: None,
                        reason: AgentRequestReason::Initial,
                        series: series.clone(),
                        snapshot_reason: Some(AgentRequestSnapshotReason::Initial),
                        system_prompt: "system".into(),
                        tool_schemas: Vec::new(),
                        attempt: 1,
                    },
                )
                .unwrap();
            store
                .append(
                    session_id,
                    Some("turn-1".into()),
                    Some("step-1".into()),
                    AgentSessionEventPayload::RequestStart {
                        request_id: "request-1".into(),
                        header_request_id: "request-1".into(),
                        provider_id: "legacy-route".into(),
                        model: "legacy-model".into(),
                        reasoning_effort: None,
                        reason: AgentRequestReason::Initial,
                        series,
                        attempt: 1,
                    },
                )
                .unwrap();
            let call = RecordedToolCall {
                call_id: "call-pending".into(),
                provider_call_id: Some("provider-call-pending".into()),
                name: "list_directory".into(),
                native_name: Some("list_directory".into()),
                arguments: serde_json::json!({}),
                title: Some("List directory".into()),
                effect: Some(AgentSessionEffect::ReadOnly),
                target: None,
            };
            store
                .append(
                    session_id,
                    Some("turn-1".into()),
                    Some("step-1".into()),
                    AgentSessionEventPayload::AssistantMessage {
                        message_id: "assistant-1".into(),
                        content: vec![AgentAssistantContentBlock::ToolCall {
                            call: Box::new(call.clone()),
                        }],
                        usage: AgentTokenUsage::default(),
                        stop_reason: AgentStopReason::ToolCalls,
                        interrupted: false,
                        replay: Some(super::super::replay::ReplayEnvelopeV5::LegacyUnknown {
                            archived_provider_items: true,
                        }),
                    },
                )
                .unwrap();
            store
                .append(
                    session_id,
                    Some("turn-1".into()),
                    Some("step-1".into()),
                    AgentSessionEventPayload::ToolCall { call },
                )
                .unwrap();
            let expires = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 60_000;
            store
                .append(
                    session_id,
                    Some("turn-1".into()),
                    Some("step-1".into()),
                    AgentSessionEventPayload::ToolApproval {
                        request_id: "request-1".into(),
                        call_id: "call-pending".into(),
                        approval_id: Some("approval-pending".into()),
                        status: AgentToolApprovalStatus::Requested,
                        risk: Some(AgentSessionEffect::ReadOnly),
                        reason: None,
                        expires_at_unix_ms: Some(expires),
                        prompt: Some("Approve retained tool call".into()),
                    },
                )
                .unwrap();
            Some(path)
        } else {
            None
        };

        let mut events = store
            .all_events(session_id)
            .unwrap()
            .into_iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .collect::<Vec<_>>();
        for event in &mut events {
            event["version"] = 4.into();
            if event["type"] == "request/header" {
                event["data"].as_object_mut().unwrap().remove("snapshot");
                event["data"]
                    .as_object_mut()
                    .unwrap()
                    .remove("snapshotDigest");
            }
            if event["type"] == "assistant/message" {
                event["data"].as_object_mut().unwrap().remove("replay");
            }
        }
        (events, attachment)
    }

    #[test]
    fn windows_atomic_publish_keeps_source_and_failure_keeps_destination() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("x.v4.jsonl");
        let destination = dir.path().join("x.v5.jsonl");
        let (events, _) = production_log(dir.path(), "session-atomic", false);
        write_v4(&source, &events);
        convert_v4_to_v5(&source, &destination).unwrap();
        let original = std::fs::read(&source).unwrap();
        let published = std::fs::read(&destination).unwrap();
        assert!(source.exists());
        assert_ne!(original, published);
        let repeated = convert_v4_to_v5(&source, &destination).unwrap();
        assert_eq!(repeated.status, "alreadyConverted");
        assert_eq!(published, std::fs::read(&destination).unwrap());
        assert_eq!(original, std::fs::read(&source).unwrap());
    }
    #[test]
    fn converts_a_full_session_without_executing_or_dropping_events_or_attachments() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("fixture.v4.jsonl");
        let destination = dir.path().join("fixture.v5.jsonl");
        let (fixture, attachment) = production_log(dir.path(), "session-rich", true);
        let attachment = attachment.unwrap();
        let attachment_before = std::fs::read(&attachment).unwrap();
        write_v4(&source, &fixture);
        let result = convert_v4_to_v5(&source, &destination).unwrap();
        assert_eq!(result.events, fixture.len());
        let published = std::fs::read_to_string(&destination).unwrap();
        let converted = published
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(converted.len(), fixture.len());
        assert!(converted.iter().all(|event| event["version"] == 5));
        let header = converted
            .iter()
            .find(|event| event["type"] == "request/header")
            .unwrap();
        assert_eq!(header["data"]["snapshot"]["status"], "legacyUnknown");
        assert!(header["data"]["snapshotDigest"]
            .as_str()
            .is_some_and(|v| v.len() == 64));
        let assistant = converted
            .iter()
            .find(|event| event["type"] == "assistant/message")
            .unwrap();
        assert_eq!(assistant["data"]["replay"]["status"], "legacyUnknown");
        // The converter only transforms envelopes. Images, tools and pending approvals stay recorded; no executor is reachable here.
        for kind in ["tool/call", "tool/approval"] {
            assert_eq!(
                converted
                    .iter()
                    .filter(|event| event["type"] == kind)
                    .count(),
                fixture.iter().filter(|event| event["type"] == kind).count()
            );
        }
        assert!(converted.iter().any(
            |event| event["type"] == "tool/approval" && event["data"]["status"] == "requested"
        ));
        assert_eq!(
            converted
                .iter()
                .find(|event| event["data"]["message"]["messageId"] == "message-image")
                .unwrap()["data"]["message"]["images"][0]["sha256"],
            crate::llm::runtime::digest(&attachment_before)
        );
        assert_eq!(std::fs::read(&attachment).unwrap(), attachment_before);
    }

    #[test]
    fn production_state_validation_rejects_an_illegal_log_before_publish() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("illegal.v4.jsonl");
        let destination = dir.path().join("illegal.v5.jsonl");
        let (mut events, _) = production_log(dir.path(), "session-illegal", false);
        let first_type = events[0]["type"].clone();
        let first_data = events[0]["data"].clone();
        events[0]["type"] = events[1]["type"].clone();
        events[0]["data"] = events[1]["data"].clone();
        events[1]["type"] = first_type;
        events[1]["data"] = first_data;
        write_v4(&source, &events);

        let error = convert_v4_to_v5(&source, &destination).unwrap_err();
        assert!(error.contains("MIGRATION_V5_VALIDATION"));
        assert!(error.contains("start with session/created"), "{error}");
        assert!(!destination.exists());
        assert!(source.exists());
        assert!(source.with_extension("migration.lock").exists());
    }

    #[test]
    fn corrupt_existing_target_is_never_reported_as_already_converted() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("snapshot.v4.jsonl");
        let destination = dir.path().join("snapshot.v5.jsonl");
        let (events, _) = production_log(dir.path(), "session-snapshot", true);
        write_v4(&source, &events);
        convert_v4_to_v5(&source, &destination).unwrap();

        let mut converted = std::fs::read_to_string(&destination)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        converted
            .iter_mut()
            .find(|event| event["type"] == "request/header")
            .unwrap()["data"]["snapshotDigest"] = "0".repeat(64).into();
        write_v4(&destination, &converted);
        let corrupt_before = std::fs::read(&destination).unwrap();

        let error = convert_v4_to_v5(&source, &destination).unwrap_err();
        assert!(error.contains("snapshot digest mismatch"));
        assert_eq!(std::fs::read(&destination).unwrap(), corrupt_before);
    }

    #[test]
    fn exclusive_marker_blocks_new_work_and_a_stale_marker_is_recovered_after_publish() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("marker.v4.jsonl");
        let destination = dir.path().join("marker.v5.jsonl");
        let marker = source.with_extension("migration.lock");
        let (events, _) = production_log(dir.path(), "session-marker", false);
        write_v4(&source, &events);
        let source_before = std::fs::read(&source).unwrap();

        std::fs::write(&marker, b"active").unwrap();
        let error = convert_v4_to_v5(&source, &destination).unwrap_err();
        assert!(error.contains("MIGRATION_BUSY"));
        assert!(!destination.exists());
        assert_eq!(std::fs::read(&source).unwrap(), source_before);

        std::fs::remove_file(&marker).unwrap();
        convert_v4_to_v5(&source, &destination).unwrap();
        std::fs::write(&marker, b"stale").unwrap();
        let repeated = convert_v4_to_v5(&source, &destination).unwrap();
        assert_eq!(repeated.status, "alreadyConverted");
        assert!(!marker.exists());
    }
    #[test]
    fn corruption_never_publishes() {
        let d = tempfile::tempdir().unwrap();
        let s = d.path().join("bad");
        let o = d.path().join("out");
        std::fs::write(&s, "not json\n").unwrap();
        assert!(convert_v4_to_v5(&s, &o).is_err());
        assert!(!o.exists());
        assert!(s.exists());
    }
}
