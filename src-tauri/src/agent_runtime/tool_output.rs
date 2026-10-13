//! Bounded model views of durable tool evidence. Full redacted data stays retrievable.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::LazyLock;

use super::{
    AgentArtifactMetadata, AgentArtifactStore, AgentSessionEventPayload, AgentSessionStore,
    ModelMessage, ModelRequest, ModelSurfaceBudget,
};

pub(crate) const READ_TOOL_RESULT: &str = "read_tool_result";

static ARTIFACT_REFERENCES: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?-u:\b)artifact-[0-9a-f]{32}(?-u:\b)")
        .expect("canonical artifact reference pattern")
});

fn tool_result_metadata(event: &super::AgentSessionEvent) -> Option<AgentArtifactMetadata> {
    match &event.payload {
        AgentSessionEventPayload::ContextArtifact {
            artifact_id,
            kind,
            title,
            size_bytes: Some(size_bytes),
            media_type: Some(media_type),
            sha256: Some(sha256),
            sensitivity: Some(sensitivity),
        } if matches!(kind.as_str(), "tool-result" | "model-tool-result") => {
            Some(AgentArtifactMetadata {
                artifact_id: artifact_id.clone(),
                kind: kind.clone(),
                title: title.clone(),
                size_bytes: *size_bytes,
                media_type: media_type.clone(),
                sha256: sha256.clone(),
                sensitivity: *sensitivity,
                created_at_unix_ms: event.time_unix_ms,
            })
        }
        _ => None,
    }
}

fn artifact_references(text: &str) -> impl Iterator<Item = String> + '_ {
    ARTIFACT_REFERENCES
        .find_iter(text)
        .map(|matched| matched.as_str().to_string())
}

pub(crate) fn materialize_inherited_results(
    sessions: &AgentSessionStore,
    artifacts: &AgentArtifactStore,
    child_session_id: &str,
    turn_id: &str,
    step_id: &str,
    inherited: &super::AgentSurfaceSnapshot,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    let cancelled = || {
        if cancellation.is_cancelled() {
            Err("Inherited tool-result transfer cancelled".to_string())
        } else {
            Ok(())
        }
    };
    cancelled()?;
    let header = sessions.snapshot(child_session_id)?.header;
    let Some(subagent) = header.subagent else {
        return Ok(());
    };
    if !subagent
        .capability_scope
        .tool_names
        .iter()
        .any(|name| name == READ_TOOL_RESULT)
        || !subagent
            .capability_scope
            .effects
            .contains(&super::AgentSessionEffect::ReadOnly)
    {
        return Ok(());
    }
    let super::AgentSubagentInheritance::SafePrefix {
        parent_through_seq: Some(boundary),
    } = subagent.inheritance
    else {
        return Ok(());
    };
    let parent_id = header
        .parent_session_id
        .ok_or("Inherited tool results have no parent Session")?;
    let events = sessions.all_events(&parent_id)?;
    if !events.iter().any(|event| {
        event.seq == boundary
            && matches!(
                event.payload,
                AgentSessionEventPayload::StepEnd { .. } | AgentSessionEventPayload::TurnEnd { .. }
            )
    }) {
        return Err("Inherited tool-result boundary is not a completed prefix".into());
    }
    let mut catalog = HashMap::new();
    for event in events.iter().filter(|event| event.seq <= boundary) {
        if let Some(metadata) = tool_result_metadata(event) {
            catalog
                .entry(metadata.artifact_id.clone())
                .or_insert(metadata);
        }
    }
    // Surface serialization omits private replay. Every reference, including
    // nested claim checks, must still belong to this frozen parent prefix.
    let surface = serde_json::to_string(inherited).map_err(|error| error.to_string())?;
    let mut pending: VecDeque<String> = artifact_references(&surface)
        .filter(|id| catalog.contains_key(id))
        .collect();
    let mut visited = HashSet::new();
    while let Some(id) = pending.pop_front() {
        cancelled()?;
        if !visited.insert(id.clone()) {
            continue;
        }
        let metadata = &catalog[&id];
        let existing = sessions.read_events(child_session_id, |events| {
            events
                .iter()
                .filter_map(tool_result_metadata)
                .find(|item| item.artifact_id == id)
        })?;
        let (bytes, copied) = if let Some(existing) = &existing {
            if existing.sha256 != metadata.sha256
                || existing.size_bytes != metadata.size_bytes
                || artifacts.verify(child_session_id, existing)?
                    != super::AgentArtifactIntegrity::Verified
            {
                return Err("Inherited child tool result failed integrity verification".into());
            }
            (
                artifacts.retrieve(child_session_id, existing, existing.size_bytes as usize)?,
                None,
            )
        } else {
            let (copied, bytes) =
                artifacts.copy_tool_result(&parent_id, child_session_id, metadata)?;
            (bytes, Some(copied))
        };
        cancelled()?;
        let text = std::str::from_utf8(&bytes).map_err(|_| "Inherited tool result is not UTF-8")?;
        pending.extend(
            artifact_references(text).filter(|reference| {
                catalog.contains_key(reference) && !visited.contains(reference)
            }),
        );
        if let Some(copied) = copied {
            cancelled()?;
            publish_artifact(sessions, child_session_id, turn_id, step_id, &copied)?;
        }
    }
    Ok(())
}

pub(crate) fn bounded_text(text: &str, maximum: usize) -> String {
    if text.len() <= maximum {
        return text.to_string();
    }
    let mut end = maximum.saturating_sub(32).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{} …[truncated; read_tool_result]", &text[..end])
}

pub(crate) fn bound_request_results(
    sessions: &AgentSessionStore,
    artifacts: &AgentArtifactStore,
    session_id: &str,
    turn_id: &str,
    step_id: &str,
    request: &mut ModelRequest,
    budget: &ModelSurfaceBudget,
) -> Result<(), String> {
    if !budget.requires_compaction()
        || !request
            .tools
            .iter()
            .any(|tool| tool.name == READ_TOOL_RESULT)
    {
        return Ok(());
    }
    let maximum = (budget.usable_input_tokens.saturating_mul(4) / 16).clamp(1024, 8192) as usize;
    for message in &mut request.messages {
        let ModelMessage::Tool { name, content, .. } = message else {
            continue;
        };
        // Skill instructions must remain complete. Terminal observations are
        // deliberately ephemeral and must never be copied into an artifact.
        // Human answers use a flat payload and remain complete human input.
        if matches!(
            name.as_str(),
            "skill" | "read_terminal" | "wait_terminal" | "ask_user_question" | READ_TOOL_RESULT
        ) || content.len() <= maximum
        {
            continue;
        }
        let mut body: Value = serde_json::from_str(content)
            .map_err(|error| format!("Invalid structured tool result: {error}"))?;
        let artifact = artifacts.store_json(
            session_id,
            "model-tool-result",
            "Complete redacted tool result",
            &body,
        )?;
        publish_artifact(sessions, session_id, turn_id, step_id, &artifact)?;
        body["data"] = result_reference(
            body.get("data").unwrap_or(&Value::Null),
            &artifact,
            (maximum / 8).clamp(64, 512),
        );
        if let Some(summary) = body.get("summary").and_then(Value::as_str) {
            body["summary"] = json!(bounded_text(summary, (maximum / 4).clamp(128, 1024)));
        }
        *content = serde_json::to_string(&body).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn result_reference(
    original: &Value,
    artifact: &AgentArtifactMetadata,
    preview_bytes: usize,
) -> Value {
    let original = crate::redaction::redact_json_value(original);
    let mut data = serde_json::Map::new();
    if let Some(original) = original.as_object() {
        for (key, value) in original {
            if matches!(
                key.as_str(),
                "status"
                    | "exitCode"
                    | "signal"
                    | "reason"
                    | "processHandle"
                    | "durationMs"
                    | "timedOut"
                    | "cancelled"
                    | "state"
                    | "channel"
            ) && (value.is_null()
                || value.is_boolean()
                || value.is_number()
                || value.as_str().is_some_and(|text| text.len() <= 256))
            {
                data.insert(key.clone(), value.clone());
            }
        }
        for field in ["stdout", "stderr"] {
            if let Some(text) = original.get(field).and_then(Value::as_str) {
                data.insert(field.into(), json!(bounded_text(text, preview_bytes)));
            }
        }
        if let Some(truncated) = original.get("truncated").and_then(Value::as_bool) {
            data.insert("sourceTruncated".into(), json!(truncated));
        }
    }
    data.insert("artifactRef".into(), json!(artifact.artifact_id));
    data.insert("sizeBytes".into(), json!(artifact.size_bytes));
    data.insert("sha256".into(), json!(artifact.sha256));
    data.insert("truncated".into(), json!(true));
    data.insert("readWith".into(), json!(READ_TOOL_RESULT));
    data.insert("sensitivity".into(), json!(artifact.sensitivity));
    Value::Object(data)
}

pub(crate) fn artifact_event(metadata: &AgentArtifactMetadata) -> AgentSessionEventPayload {
    AgentSessionEventPayload::ContextArtifact {
        artifact_id: metadata.artifact_id.clone(),
        kind: metadata.kind.clone(),
        title: metadata.title.clone(),
        size_bytes: Some(metadata.size_bytes),
        media_type: Some(metadata.media_type.clone()),
        sha256: Some(metadata.sha256.clone()),
        sensitivity: Some(metadata.sensitivity),
    }
}

pub(crate) fn publish_artifact(
    sessions: &AgentSessionStore,
    session_id: &str,
    turn_id: &str,
    step_id: &str,
    metadata: &AgentArtifactMetadata,
) -> Result<(), String> {
    if !sessions.read_events(session_id, |events| events.iter().any(|event| matches!(&event.payload, AgentSessionEventPayload::ContextArtifact { artifact_id, kind, .. } if artifact_id == &metadata.artifact_id && kind == &metadata.kind)))? {
        sessions.append(session_id, Some(turn_id.into()), Some(step_id.into()), artifact_event(metadata))?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadArguments {
    artifact_id: String,
    offset: usize,
    max_bytes: usize,
}

pub(crate) fn read_result(
    sessions: &AgentSessionStore,
    artifacts: &AgentArtifactStore,
    session_id: &str,
    arguments: Value,
) -> Result<Value, String> {
    let args: ReadArguments = serde_json::from_value(arguments)
        .map_err(|error| format!("Invalid read_tool_result arguments: {error}"))?;
    super::session::validate_identifier(&args.artifact_id, "artifactId")?;
    if !(1..=2048).contains(&args.max_bytes) {
        return Err("maxBytes must be between 1 and 2048".into());
    }
    let metadata = sessions
        .read_events(session_id, |events| {
            events
                .iter()
                .filter_map(tool_result_metadata)
                .find(|item| item.artifact_id == args.artifact_id)
        })?
        .ok_or("Tool result artifact was not found in this session")?;
    let bytes = artifacts.retrieve(session_id, &metadata, metadata.size_bytes as usize)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "Tool result is not UTF-8")?;
    if args.offset > text.len() || !text.is_char_boundary(args.offset) {
        return Err("offset must be a UTF-8 boundary within the result".into());
    }
    let mut end = args.offset.saturating_add(args.max_bytes).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if end == args.offset && end < text.len() {
        return Err("maxBytes is too small for the next UTF-8 character".into());
    }
    Ok(
        json!({"artifactRef": metadata.artifact_id, "sha256": metadata.sha256, "sizeBytes": text.len(), "offset": args.offset, "nextOffset": end, "hasMore": end < text.len(), "untrustedExcerpt": &text[args.offset..end]}),
    )
}

#[cfg(test)]
mod tests {
    include!("tests/tool_output.rs");
}
