use super::{
    adapter::ReplayCodec,
    errors::{NormalizedModelError, NormalizedModelErrorKind},
    runtime::RequestSnapshot,
    types::{AdapterReplayCapture, ModelContentBlock, ModelMessage},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub(crate) const REPLAY_ENVELOPE_VERSION: u32 = 1;
const MAX_REPLAY_STRING_BYTES: usize = 64 * 1024;
const MAX_REPLAY_METADATA_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplaySourceV5 {
    pub(crate) request_id: String,
    pub(crate) request_snapshot_digest: String,
    pub(crate) route_id: String,
    pub(crate) route_revision: u64,
    pub(crate) model_id: String,
    pub(crate) replay_domain_id: String,
    pub(crate) request_content_hash: String,
    pub(crate) preparation_version: u32,
    pub(crate) projection_policy: String,
    pub(crate) image_projection_refs: Vec<crate::agent_runtime::images::ImageRef>,
    pub(crate) image_projection_hash: String,
    pub(crate) assistant_content_hash: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReplayBlockKind {
    Text,
    Reasoning,
    ToolCall,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplayBlockV5 {
    pub(crate) index: u32,
    pub(crate) kind: ReplayBlockKind,
    pub(crate) content_hash: String,
    pub(crate) metadata: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ReplayEnvelopeV5 {
    Prepared {
        version: u32,
        adapter_id: String,
        replay_format_version: u32,
        source: ReplaySourceV5,
        response: Value,
        blocks: Vec<ReplayBlockV5>,
    },
}

pub(crate) fn replay_error(code: &str, message: impl Into<String>) -> NormalizedModelError {
    let mut error = NormalizedModelError::new(NormalizedModelErrorKind::Protocol, message);
    error.code = Some(code.to_string());
    error
}

pub(crate) fn replay_error_string(error: NormalizedModelError) -> String {
    format!(
        "{}: {}",
        error.code.as_deref().unwrap_or("REPLAY_INVALID"),
        error.message
    )
}

pub(crate) fn object_with_allowed_keys<'a>(
    value: &'a Value,
    allowed: &[&str],
    label: &str,
) -> Result<&'a Map<String, Value>, NormalizedModelError> {
    let object = value.as_object().ok_or_else(|| {
        replay_error(
            "REPLAY_METADATA_INVALID",
            format!("{label} must be an object"),
        )
    })?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(replay_error(
            "REPLAY_METADATA_INVALID",
            format!("{label} contains unsupported field {key}"),
        ));
    }
    Ok(object)
}

pub(crate) fn optional_bounded_string(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<String>, NormalizedModelError> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    let value = value.as_str().ok_or_else(|| {
        replay_error(
            "REPLAY_METADATA_INVALID",
            format!("{label}.{key} must be a string"),
        )
    })?;
    if value.is_empty() || value.len() > MAX_REPLAY_STRING_BYTES || value.starts_with("data:") {
        return Err(replay_error(
            "REPLAY_METADATA_INVALID",
            format!("{label}.{key} is empty, oversized, or embeds data"),
        ));
    }
    Ok(Some(value.to_string()))
}

pub(crate) fn validate_metadata_safety(value: &Value) -> Result<(), NormalizedModelError> {
    if serde_json::to_vec(value)
        .map_err(|error| replay_error("REPLAY_METADATA_INVALID", error.to_string()))?
        .len()
        > MAX_REPLAY_METADATA_BYTES
    {
        return Err(replay_error(
            "REPLAY_METADATA_INVALID",
            "replay metadata exceeded the storage boundary",
        ));
    }
    fn walk(value: &Value) -> bool {
        match value {
            Value::String(value) => value.starts_with("data:") || value.contains(";base64,"),
            Value::Array(values) => values.iter().any(walk),
            Value::Object(values) => values
                .iter()
                .any(|(key, value)| crate::redaction::is_sensitive_key(key) || walk(value)),
            _ => false,
        }
    }
    if walk(value) {
        return Err(replay_error(
            "REPLAY_METADATA_FORBIDDEN",
            "replay metadata contains a credential-like field or embedded data",
        ));
    }
    Ok(())
}

fn model_block_kind(block: &ModelContentBlock) -> ReplayBlockKind {
    match block {
        ModelContentBlock::Text { .. } => ReplayBlockKind::Text,
        ModelContentBlock::Reasoning { .. } => ReplayBlockKind::Reasoning,
        ModelContentBlock::ToolCall { .. } => ReplayBlockKind::ToolCall,
    }
}

struct ReplayBlockFact {
    kind: ReplayBlockKind,
    hash: String,
    provider_call_id: Option<String>,
}

pub(crate) fn model_block_has_output(block: &ModelContentBlock) -> bool {
    match block {
        ModelContentBlock::Text { text } | ModelContentBlock::Reasoning { text, .. } => {
            !text.trim().is_empty()
        }
        ModelContentBlock::ToolCall { .. } => true,
    }
}

pub(crate) fn committed_model_content(
    content: &[ModelContentBlock],
) -> Result<Vec<ModelContentBlock>, NormalizedModelError> {
    serde_json::from_value(crate::redaction::redact_json_value(
        &serde_json::to_value(content)
            .map_err(|error| replay_error("REPLAY_CONTENT_INVALID", error.to_string()))?,
    ))
    .map_err(|error| replay_error("REPLAY_CONTENT_INVALID", error.to_string()))
}

pub(crate) fn block_hash(block: &impl Serialize) -> Result<String, NormalizedModelError> {
    super::runtime::try_digest(
        &serde_json::to_vec(block)
            .map_err(|error| replay_error("REPLAY_CONTENT_INVALID", error.to_string()))?,
    )
}

pub(crate) fn assistant_content_hash(
    content: &[impl Serialize],
) -> Result<String, NormalizedModelError> {
    super::runtime::try_digest(
        &serde_json::to_vec(content)
            .map_err(|error| replay_error("REPLAY_CONTENT_INVALID", error.to_string()))?,
    )
}

pub(crate) fn image_projection_hash(
    snapshot: &RequestSnapshot,
) -> Result<String, NormalizedModelError> {
    let RequestSnapshot::Prepared {
        preparation_version,
        projection_policy,
        content_hash,
        images,
        ..
    } = snapshot;
    super::runtime::try_digest(
        &serde_json::to_vec(&json!({
            "preparationVersion": preparation_version,
            "projectionPolicy": projection_policy,
            "requestContentHash": content_hash,
            "images": images,
        }))
        .map_err(|error| replay_error("REPLAY_SOURCE_INVALID", error.to_string()))?,
    )
}

pub(crate) fn prepare_envelope(
    codec: &dyn ReplayCodec,
    request_id: &str,
    snapshot: &RequestSnapshot,
    content: &[ModelContentBlock],
    capture: AdapterReplayCapture,
) -> Result<ReplayEnvelopeV5, NormalizedModelError> {
    let RequestSnapshot::Prepared {
        route_id,
        route_revision,
        adapter_id,
        model_id,
        replay_domain_id,
        content_hash,
        preparation_version,
        projection_policy,
        images,
        ..
    } = snapshot;
    if adapter_id != codec.adapter_id() {
        return Err(replay_error(
            "REPLAY_ADAPTER_MISMATCH",
            "prepared adapter does not own the response replay format",
        ));
    }
    if capture.blocks.len() != content.len() {
        return Err(replay_error(
            "REPLAY_BLOCK_MISMATCH",
            "adapter replay block count does not match final response content",
        ));
    }
    codec.validate_response_metadata(&capture.response)?;
    validate_metadata_safety(&capture.response)?;
    let blocks = content
        .iter()
        .zip(capture.blocks)
        .enumerate()
        .map(|(index, (block, metadata))| {
            let kind = model_block_kind(block);
            codec.validate_block_metadata(kind, &metadata)?;
            validate_metadata_safety(&metadata)?;
            Ok(ReplayBlockV5 {
                index: index as u32,
                kind,
                content_hash: block_hash(block)?,
                metadata,
            })
        })
        .collect::<Result<Vec<_>, NormalizedModelError>>()?;
    let envelope = ReplayEnvelopeV5::Prepared {
        version: REPLAY_ENVELOPE_VERSION,
        adapter_id: adapter_id.clone(),
        replay_format_version: codec.replay_format_version(),
        source: ReplaySourceV5 {
            request_id: request_id.to_string(),
            request_snapshot_digest: snapshot.digest(),
            route_id: route_id.clone(),
            route_revision: *route_revision,
            model_id: model_id.clone(),
            replay_domain_id: replay_domain_id.clone(),
            request_content_hash: content_hash.clone(),
            preparation_version: *preparation_version,
            projection_policy: projection_policy.clone(),
            image_projection_refs: images.clone(),
            image_projection_hash: image_projection_hash(snapshot)?,
            assistant_content_hash: assistant_content_hash(content)?,
        },
        response: capture.response,
        blocks,
    };
    validate_model_envelope(&envelope, content, snapshot, request_id, codec)?;
    Ok(envelope)
}

pub(crate) fn validate_model_envelope(
    envelope: &ReplayEnvelopeV5,
    content: &[ModelContentBlock],
    snapshot: &RequestSnapshot,
    request_id: &str,
    codec: &dyn ReplayCodec,
) -> Result<(), NormalizedModelError> {
    validate_envelope_common(
        envelope,
        snapshot,
        request_id,
        assistant_content_hash(content)?,
        content
            .iter()
            .map(|block| {
                Ok(ReplayBlockFact {
                    kind: model_block_kind(block),
                    hash: block_hash(block)?,
                    provider_call_id: match block {
                        ModelContentBlock::ToolCall { call } => call.provider_call_id.clone(),
                        _ => None,
                    },
                })
            })
            .collect::<Result<Vec<_>, NormalizedModelError>>()?,
        codec,
    )
}

pub(crate) fn validate_agent_envelope(
    envelope: &ReplayEnvelopeV5,
    content: &[crate::agent_runtime::AgentAssistantContentBlock],
    snapshot: &RequestSnapshot,
    request_id: &str,
) -> Result<(), NormalizedModelError> {
    let ReplayEnvelopeV5::Prepared { adapter_id, .. } = envelope;
    let codec = super::registry::replay_codec(adapter_id).ok_or_else(|| {
        replay_error(
            "REPLAY_ADAPTER_UNKNOWN",
            format!("unknown replay adapter {adapter_id}"),
        )
    })?;
    let kinds = content
        .iter()
        .map(|block| {
            let kind = match block {
                crate::agent_runtime::AgentAssistantContentBlock::Text { .. } => {
                    ReplayBlockKind::Text
                }
                crate::agent_runtime::AgentAssistantContentBlock::Reasoning { .. } => {
                    ReplayBlockKind::Reasoning
                }
                crate::agent_runtime::AgentAssistantContentBlock::ToolCall { .. } => {
                    ReplayBlockKind::ToolCall
                }
            };
            Ok(ReplayBlockFact {
                kind,
                hash: block_hash(block)?,
                provider_call_id: match block {
                    crate::agent_runtime::AgentAssistantContentBlock::ToolCall { call } => {
                        call.provider_call_id.clone()
                    }
                    _ => None,
                },
            })
        })
        .collect::<Result<Vec<_>, NormalizedModelError>>()?;
    validate_envelope_common(
        envelope,
        snapshot,
        request_id,
        assistant_content_hash(content)?,
        kinds,
        codec,
    )
}

fn validate_envelope_common(
    envelope: &ReplayEnvelopeV5,
    snapshot: &RequestSnapshot,
    request_id: &str,
    actual_content_hash: String,
    actual_blocks: Vec<ReplayBlockFact>,
    codec: &dyn ReplayCodec,
) -> Result<(), NormalizedModelError> {
    let ReplayEnvelopeV5::Prepared {
        version,
        adapter_id,
        replay_format_version,
        source,
        response,
        blocks,
    } = envelope;
    if *version != REPLAY_ENVELOPE_VERSION {
        return Err(replay_error(
            "REPLAY_VERSION_UNKNOWN",
            "unknown replay envelope version",
        ));
    }
    if adapter_id != codec.adapter_id() {
        return Err(replay_error(
            "REPLAY_ADAPTER_MISMATCH",
            "replay adapter mismatch",
        ));
    }
    if *replay_format_version != codec.replay_format_version() {
        return Err(replay_error(
            "REPLAY_FORMAT_UNKNOWN",
            "unknown adapter replay format",
        ));
    }
    let RequestSnapshot::Prepared {
        route_id,
        route_revision,
        adapter_id: snapshot_adapter,
        model_id,
        replay_domain_id,
        content_hash,
        preparation_version,
        projection_policy,
        images,
        ..
    } = snapshot;
    if source.request_id != request_id
        || source.request_snapshot_digest != snapshot.digest()
        || source.route_id != *route_id
        || source.route_revision != *route_revision
        || source.model_id != *model_id
        || source.replay_domain_id != *replay_domain_id
        || adapter_id != snapshot_adapter
        || source.request_content_hash != *content_hash
        || source.preparation_version != *preparation_version
        || source.projection_policy != *projection_policy
        || source.image_projection_refs != *images
        || source.image_projection_hash != image_projection_hash(snapshot)?
    {
        return Err(replay_error(
            "REPLAY_SOURCE_MISMATCH",
            "replay source does not match its committed request snapshot",
        ));
    }
    if source.assistant_content_hash != actual_content_hash || blocks.len() != actual_blocks.len() {
        return Err(replay_error(
            "REPLAY_CONTENT_MISMATCH",
            "replay content does not match the committed assistant message",
        ));
    }
    codec.validate_response_metadata(response)?;
    validate_metadata_safety(response)?;
    for (index, (block, fact)) in blocks.iter().zip(actual_blocks).enumerate() {
        if block.index != index as u32 || block.kind != fact.kind || block.content_hash != fact.hash
        {
            return Err(replay_error(
                "REPLAY_BLOCK_MISMATCH",
                "replay block index, type, or content hash mismatch",
            ));
        }
        codec.validate_block_metadata(block.kind, &block.metadata)?;
        validate_metadata_safety(&block.metadata)?;
        if block.kind == ReplayBlockKind::ToolCall
            && block
                .metadata
                .get("providerCallId")
                .and_then(Value::as_str)
                .map(str::to_string)
                != fact.provider_call_id
        {
            return Err(replay_error(
                "REPLAY_TOOL_ID_MISMATCH",
                "replay provider tool id does not match committed tool content",
            ));
        }
    }
    Ok(())
}

pub(crate) struct ReplayTarget<'a> {
    pub(crate) route_id: &'a str,
    pub(crate) model_id: &'a str,
    pub(crate) replay_domain_id: &'a str,
}

pub(crate) fn project_history(
    codec: &dyn ReplayCodec,
    messages: &mut [ModelMessage],
    target: ReplayTarget<'_>,
) -> Result<(), NormalizedModelError> {
    let mut provider_ids = HashMap::<String, String>::new();
    let mut pending = HashSet::<String>::new();
    let mut completed = HashSet::<String>::new();
    for message in messages {
        match message {
            ModelMessage::Assistant {
                content,
                replay,
                native_replay,
            } => {
                *native_replay = None;
                for block in content.iter_mut() {
                    match block {
                        ModelContentBlock::Reasoning { provider_item, .. } => *provider_item = None,
                        ModelContentBlock::ToolCall { call } => call.provider_call_id = None,
                        ModelContentBlock::Text { .. } => {}
                    }
                }
                let same_domain = match replay.as_deref() {
                    Some(ReplayEnvelopeV5::Prepared {
                        adapter_id,
                        replay_format_version,
                        source,
                        ..
                    }) => {
                        if adapter_id != codec.adapter_id()
                            || *replay_format_version != codec.replay_format_version()
                        {
                            false
                        } else {
                            source.route_id == target.route_id
                                && source.model_id == target.model_id
                                && source.replay_domain_id == target.replay_domain_id
                        }
                    }
                    _ => false,
                };
                if same_domain {
                    let envelope = replay.as_ref().expect("same-domain replay");
                    *native_replay = Some(codec.restore_private_metadata(content, envelope)?);
                }
                *replay = None;
                for block in content.iter() {
                    if let ModelContentBlock::ToolCall { call } = block {
                        if !pending.insert(call.call_id.clone())
                            || completed.contains(&call.call_id)
                        {
                            return Err(replay_error(
                                "HISTORY_INCOMPATIBLE",
                                "history contains a duplicate tool call id",
                            ));
                        }
                        if let Some(provider_id) = &call.provider_call_id {
                            provider_ids.insert(call.call_id.clone(), provider_id.clone());
                        }
                    }
                }
            }
            ModelMessage::Tool {
                call_id,
                provider_call_id,
                ..
            } => {
                if !pending.remove(call_id) || !completed.insert(call_id.clone()) {
                    return Err(replay_error(
                        "HISTORY_INCOMPATIBLE",
                        "history contains an orphan or duplicate tool result",
                    ));
                }
                *provider_call_id = provider_ids.get(call_id).cloned();
            }
            ModelMessage::User { .. } | ModelMessage::UserImages { .. } => {}
        }
    }
    if !pending.is_empty() {
        return Err(replay_error(
            "HISTORY_INCOMPATIBLE",
            "history contains a tool call without a result",
        ));
    }
    Ok(())
}

pub(crate) fn public_event_projection(event: &mut crate::agent_runtime::AgentSessionEvent) {
    match &mut event.payload {
        crate::agent_runtime::AgentSessionEventPayload::AssistantMessage {
            content,
            replay,
            ..
        } => {
            *replay = None;
            for block in content {
                match block {
                    crate::agent_runtime::AgentAssistantContentBlock::Reasoning {
                        provider_item,
                        ..
                    } => *provider_item = None,
                    crate::agent_runtime::AgentAssistantContentBlock::ToolCall { call } => {
                        call.provider_call_id = None;
                    }
                    crate::agent_runtime::AgentAssistantContentBlock::Text { .. } => {}
                }
            }
        }
        crate::agent_runtime::AgentSessionEventPayload::ToolCall { call } => {
            call.provider_call_id = None;
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    include!("tests/replay.rs");
}
