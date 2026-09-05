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
    LegacyUnknown {
        archived_provider_items: bool,
    },
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
    } = snapshot
    else {
        return Err(replay_error(
            "REPLAY_SOURCE_INVALID",
            "prepared replay requires a prepared request snapshot",
        ));
    };
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
    } = snapshot
    else {
        return Err(replay_error(
            "REPLAY_SOURCE_INVALID",
            "normal responses cannot use a legacy request snapshot",
        ));
    };
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
    let ReplayEnvelopeV5::Prepared { adapter_id, .. } = envelope else {
        return Err(replay_error(
            "REPLAY_LEGACY_UNKNOWN",
            "legacy replay metadata cannot be validated as prepared",
        ));
    };
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
    } = envelope
    else {
        return Err(replay_error(
            "REPLAY_LEGACY_UNKNOWN",
            "legacy replay metadata is not executable",
        ));
    };
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
    } = snapshot
    else {
        return Err(replay_error(
            "REPLAY_SOURCE_INVALID",
            "prepared replay references legacy request",
        ));
    };
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
                let same_domain = match replay.as_ref() {
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
    use super::*;
    use crate::llm::{
        catalog, config::AiProviderKind, routes::RouteTimeouts, types::ModelToolCall,
    };

    fn snapshot(adapter_id: &str) -> RequestSnapshot {
        let kind = match adapter_id {
            "responses" => AiProviderKind::OpenAi,
            "ollama" => AiProviderKind::Ollama,
            "anthropic-messages" => AiProviderKind::AnthropicMessages,
            _ => AiProviderKind::OpenAiCompatible,
        };
        RequestSnapshot::Prepared {
            route_id: "route-a".into(),
            route_revision: 7,
            adapter_id: adapter_id.into(),
            model_id: "model-a".into(),
            catalog_version: 1,
            capabilities: catalog::fixture_definition(kind, 8192),
            endpoint_identity: "https://example.test/v1".into(),
            replay_domain_id: "domain-a".into(),
            reasoning_effort: None,
            output_tokens: 8192,
            retry_policy: Default::default(),
            timeouts: RouteTimeouts::default(),
            purpose: "step".into(),
            preparation_version: 1,
            projection_policy: "immutable-png-v1-strict".into(),
            content_hash: super::super::runtime::digest(b"request-content"),
            images: Vec::new(),
        }
    }

    fn tool(provider_call_id: Option<&str>) -> ModelContentBlock {
        ModelContentBlock::ToolCall {
            call: ModelToolCall {
                call_id: "call-1".into(),
                provider_call_id: provider_call_id.map(str::to_string),
                name: "read_file".into(),
                arguments: json!({"path":"a"}),
            },
        }
    }

    fn envelope(
        adapter_id: &str,
        content: &[ModelContentBlock],
        response: Value,
        blocks: Vec<Value>,
    ) -> ReplayEnvelopeV5 {
        prepare_envelope(
            super::super::registry::replay_codec(adapter_id).unwrap(),
            "request-1",
            &snapshot(adapter_id),
            content,
            AdapterReplayCapture { response, blocks },
        )
        .unwrap()
    }

    #[test]
    fn each_adapter_restores_only_its_same_domain_private_format() {
        let cases = [
            (
                "chat-completions",
                vec![
                    ModelContentBlock::Reasoning {
                        text: "plan".into(),
                        provider_item: None,
                    },
                    tool(Some("chat-completions-provider-call")),
                ],
                json!({"id":"chat-response"}),
                vec![
                    json!({"reasoningDetails":[{"type":"reasoning.text","text":"plan","signature":"opaque-signature"}]}),
                    json!({"providerCallId":"chat-completions-provider-call"}),
                ],
            ),
            (
                "responses",
                vec![
                    ModelContentBlock::Reasoning {
                        text: "plan".into(),
                        provider_item: None,
                    },
                    tool(Some("responses-provider-call")),
                ],
                json!({"responseId":"resp_1","model":"model-a"}),
                vec![
                    json!({"nativeItem":{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"plan"}],"encrypted_content":"opaque-state"}}),
                    json!({"providerCallId":"responses-provider-call","providerItemId":"fc_1"}),
                ],
            ),
            (
                "ollama",
                vec![tool(Some("ollama-provider-call"))],
                json!({"model":"model-a","doneReason":"stop"}),
                vec![json!({"providerCallId":"ollama-provider-call"})],
            ),
            (
                "anthropic-messages",
                vec![
                    ModelContentBlock::Reasoning {
                        text: "plan".into(),
                        provider_item: None,
                    },
                    tool(Some("anthropic-messages-provider-call")),
                ],
                json!({"messageId":"msg_1","model":"model-a","redactedThinkingTail":[{"data":"opaque-tail"}]}),
                vec![
                    json!({"signature":"anthropic-signature","redactedThinkingBefore":[{"data":"opaque-before"}]}),
                    json!({"providerCallId":"anthropic-messages-provider-call"}),
                ],
            ),
        ];
        for (adapter_id, canonical, response, blocks) in cases {
            let envelope = envelope(adapter_id, &canonical, response, blocks);
            validate_model_envelope(
                &envelope,
                &canonical,
                &snapshot(adapter_id),
                "request-1",
                super::super::registry::replay_codec(adapter_id).unwrap(),
            )
            .unwrap();

            let mut projected = canonical.clone();
            for block in &mut projected {
                match block {
                    ModelContentBlock::Reasoning { provider_item, .. } => *provider_item = None,
                    ModelContentBlock::ToolCall { call } => call.provider_call_id = None,
                    ModelContentBlock::Text { .. } => {}
                }
            }
            let mut messages = vec![
                ModelMessage::Assistant {
                    content: projected,
                    replay: Some(envelope.clone()),
                    native_replay: None,
                },
                ModelMessage::Tool {
                    call_id: "call-1".into(),
                    provider_call_id: None,
                    name: "read_file".into(),
                    content: "ok".into(),
                },
            ];
            project_history(
                super::super::registry::replay_codec(adapter_id).unwrap(),
                &mut messages,
                ReplayTarget {
                    route_id: "route-a",
                    model_id: "model-a",
                    replay_domain_id: "domain-a",
                },
            )
            .unwrap();
            let ModelMessage::Assistant { content, .. } = &messages[0] else {
                panic!()
            };
            if adapter_id == "responses" {
                assert!(matches!(
                    &content[0],
                    ModelContentBlock::Reasoning { provider_item: Some(item), .. }
                        if item.get("encrypted_content").and_then(Value::as_str) == Some("opaque-state")
                ));
            } else if adapter_id == "anthropic-messages" {
                assert!(matches!(
                    &content[0],
                    ModelContentBlock::Reasoning { provider_item: Some(item), .. }
                        if item.pointer("/anthropic/signature").and_then(Value::as_str)
                            == Some("anthropic-signature")
                ));
            }
            let expected = format!("{adapter_id}-provider-call");
            assert!(content.iter().any(|block| matches!(
                block,
                ModelContentBlock::ToolCall { call }
                    if call.provider_call_id.as_deref() == Some(expected.as_str())
            )));
            assert!(matches!(
                &messages[1],
                ModelMessage::Tool { provider_call_id: Some(id), .. } if id == &expected
            ));
            let projected_serialized = serde_json::to_string(&messages).unwrap();
            assert!(!projected_serialized.contains("\"replay\""));
            assert!(!projected_serialized.contains("responseId"));
            if adapter_id == "responses" {
                let (input, previous) =
                    crate::llm::adapters::responses::responses_input_with_replay(&messages);
                assert_eq!(previous.as_deref(), Some("resp_1"));
                assert_eq!(input[0]["call_id"], "responses-provider-call");
            } else if adapter_id == "chat-completions" {
                let wire = crate::llm::adapters::common::chat_messages(
                    &messages,
                    false,
                    crate::llm::adapters::common::ProviderCapabilities {
                        cumulative_stream: false,
                        supports_stream_usage: true,
                        native_reasoning: true,
                        split_reasoning: true,
                        replay_reasoning_content: false,
                        think_tag_fallback: false,
                        parallel_tool_calls: true,
                    },
                );
                assert_eq!(
                    wire[0]["reasoning_details"][0]["signature"],
                    "opaque-signature"
                );
            } else if adapter_id == "anthropic-messages" {
                let wire = crate::llm::adapters::anthropic::encode_messages(&messages).unwrap();
                assert_eq!(wire[0]["content"][0]["type"], "redacted_thinking");
                assert_eq!(wire[0]["content"][1]["signature"], "anthropic-signature");
                assert_eq!(wire[0]["content"][2]["type"], "tool_use");
                assert_eq!(wire[0]["content"][3]["type"], "redacted_thinking");
                assert_eq!(
                    wire[1]["content"][0]["tool_use_id"],
                    "anthropic-messages-provider-call"
                );
            }

            let mut cross_domain = messages.clone();
            project_history(
                super::super::registry::replay_codec(adapter_id).unwrap(),
                &mut cross_domain,
                ReplayTarget {
                    route_id: "route-a",
                    model_id: "model-a",
                    replay_domain_id: "rotated-domain",
                },
            )
            .unwrap();
            let encoded = serde_json::to_string(&cross_domain).unwrap();
            assert!(!encoded.contains("opaque-state"));
            assert!(!encoded.contains("opaque-signature"));
            assert!(!encoded.contains("anthropic-signature"));
            assert!(!encoded.contains("opaque-before"));
            assert!(!encoded.contains("opaque-tail"));
            assert!(!encoded.contains(&expected));
            if adapter_id == "anthropic-messages" {
                let wire = crate::llm::adapters::anthropic::encode_messages(&cross_domain).unwrap();
                let wire = serde_json::to_string(&wire).unwrap();
                assert!(!wire.contains("signature"));
                assert!(!wire.contains("redacted_thinking"));
                assert!(!wire.contains("anthropic-messages-provider-call"));
            }
        }
    }

    #[test]
    fn persisted_envelope_rejects_source_content_block_tool_and_image_corruption() {
        let content = vec![
            ModelContentBlock::Text {
                text: "done".into(),
            },
            tool(Some("provider-call")),
        ];
        let base = envelope(
            "chat-completions",
            &content,
            json!({"id":"response-1"}),
            vec![json!({}), json!({"providerCallId":"provider-call"})],
        );
        let codec = super::super::registry::replay_codec("chat-completions").unwrap();
        let mut cases = Vec::new();
        for mutation in 0..9 {
            let mut candidate = base.clone();
            let ReplayEnvelopeV5::Prepared {
                version,
                adapter_id,
                replay_format_version,
                source,
                blocks,
                ..
            } = &mut candidate
            else {
                unreachable!()
            };
            match mutation {
                0 => *version = 9,
                1 => *replay_format_version = 9,
                2 => *adapter_id = "responses".into(),
                3 => source.route_id = "other-route".into(),
                4 => source.request_snapshot_digest = "0".repeat(64),
                5 => source.assistant_content_hash = "0".repeat(64),
                6 => blocks[0].index = 4,
                7 => blocks[1].metadata["providerCallId"] = json!("other-provider-call"),
                8 => source.image_projection_hash = "0".repeat(64),
                _ => unreachable!(),
            }
            cases.push(candidate);
        }
        for candidate in cases {
            assert!(validate_model_envelope(
                &candidate,
                &content,
                &snapshot("chat-completions"),
                "request-1",
                codec,
            )
            .is_err());
        }
        let changed_content = vec![
            ModelContentBlock::Text {
                text: "tampered".into(),
            },
            tool(Some("provider-call")),
        ];
        assert!(validate_model_envelope(
            &base,
            &changed_content,
            &snapshot("chat-completions"),
            "request-1",
            codec,
        )
        .is_err());

        let reasoning = vec![ModelContentBlock::Reasoning {
            text: "plan".into(),
            provider_item: None,
        }];
        let mut corrupted_reasoning = envelope(
            "chat-completions",
            &reasoning,
            json!({}),
            vec![
                json!({"reasoningDetails":[{"type":"reasoning.text","text":"plan","signature":"opaque"}]}),
            ],
        );
        if let ReplayEnvelopeV5::Prepared { blocks, .. } = &mut corrupted_reasoning {
            blocks[0].metadata["reasoningDetails"][0]["unknown"] = json!(true);
        }
        assert!(validate_model_envelope(
            &corrupted_reasoning,
            &reasoning,
            &snapshot("chat-completions"),
            "request-1",
            codec,
        )
        .is_err());
    }

    #[test]
    fn image_projection_binding_contains_only_immutable_refs_and_rejects_changes() {
        let mut source = snapshot("responses");
        let RequestSnapshot::Prepared { images, .. } = &mut source else {
            unreachable!()
        };
        images.push(crate::agent_runtime::images::ImageRef {
            version: 1,
            sha256: "a".repeat(64),
            media_type: "image/png".into(),
            bytes: 128,
            width: 16,
            height: 8,
            name: "diagram.png".into(),
        });
        let content = vec![ModelContentBlock::Text { text: "ok".into() }];
        let envelope = prepare_envelope(
            super::super::registry::replay_codec("responses").unwrap(),
            "request-1",
            &source,
            &content,
            AdapterReplayCapture {
                response: json!({"responseId":"resp_1"}),
                blocks: vec![json!({})],
            },
        )
        .unwrap();
        let encoded = serde_json::to_string(&envelope).unwrap();
        assert!(encoded.contains(&"a".repeat(64)));
        assert!(!encoded.contains("data:image"));
        let mut changed = source.clone();
        let RequestSnapshot::Prepared { images, .. } = &mut changed else {
            unreachable!()
        };
        images[0].sha256 = "b".repeat(64);
        assert!(validate_model_envelope(
            &envelope,
            &content,
            &changed,
            "request-1",
            super::super::registry::replay_codec("responses").unwrap(),
        )
        .is_err());
    }

    #[test]
    fn tool_history_rejects_orphans_duplicates_and_unsettled_calls() {
        let codec = super::super::registry::replay_codec("ollama").unwrap();
        let target = || ReplayTarget {
            route_id: "route-a",
            model_id: "model-a",
            replay_domain_id: "domain-a",
        };
        let mut orphan = vec![ModelMessage::Tool {
            call_id: "call-1".into(),
            provider_call_id: None,
            name: "read_file".into(),
            content: "result".into(),
        }];
        assert!(
            project_history(codec, &mut orphan, target())
                .unwrap_err()
                .code
                .as_deref()
                == Some("HISTORY_INCOMPATIBLE")
        );

        let mut duplicate = vec![ModelMessage::Assistant {
            content: vec![tool(None), tool(None)],
            replay: None,
            native_replay: None,
        }];
        assert!(project_history(codec, &mut duplicate, target()).is_err());

        let mut unsettled = vec![ModelMessage::Assistant {
            content: vec![tool(None)],
            replay: None,
            native_replay: None,
        }];
        assert!(project_history(codec, &mut unsettled, target()).is_err());
    }

    #[test]
    fn retry_envelopes_keep_the_frozen_snapshot_digest() {
        let snapshot = snapshot("ollama");
        let content = vec![ModelContentBlock::Text { text: "ok".into() }];
        let make = |request_id| {
            prepare_envelope(
                super::super::registry::replay_codec("ollama").unwrap(),
                request_id,
                &snapshot,
                &content,
                AdapterReplayCapture {
                    response: json!({}),
                    blocks: vec![json!({})],
                },
            )
            .unwrap()
        };
        let first = make("attempt-1");
        let second = make("attempt-2");
        let (
            ReplayEnvelopeV5::Prepared { source: first, .. },
            ReplayEnvelopeV5::Prepared { source: second, .. },
        ) = (first, second)
        else {
            unreachable!()
        };
        assert_ne!(first.request_id, second.request_id);
        assert_eq!(
            first.request_snapshot_digest,
            second.request_snapshot_digest
        );
        assert_eq!(first.request_content_hash, second.request_content_hash);
        assert_eq!(first.image_projection_hash, second.image_projection_hash);
    }

    #[test]
    fn legacy_and_cross_domain_history_never_execute_archived_provider_items() {
        let mut messages = vec![ModelMessage::Assistant {
            content: vec![ModelContentBlock::Reasoning {
                text: "display only".into(),
                provider_item: Some(json!({"type":"reasoning","id":"forged-native-id"})),
            }],
            replay: Some(ReplayEnvelopeV5::LegacyUnknown {
                archived_provider_items: true,
            }),
            native_replay: None,
        }];
        project_history(
            super::super::registry::replay_codec("responses").unwrap(),
            &mut messages,
            ReplayTarget {
                route_id: "route-a",
                model_id: "model-a",
                replay_domain_id: "domain-a",
            },
        )
        .unwrap();
        assert!(!serde_json::to_string(&messages)
            .unwrap()
            .contains("forged-native-id"));
    }

    #[test]
    fn public_event_projection_removes_all_backend_native_fields() {
        let mut event = crate::agent_runtime::AgentSessionEvent::new(
            "session".into(),
            0,
            1,
            Some("turn".into()),
            Some("step".into()),
            crate::agent_runtime::AgentSessionEventPayload::AssistantMessage {
                message_id: "message".into(),
                content: vec![
                    crate::agent_runtime::AgentAssistantContentBlock::Reasoning {
                        text: "display".into(),
                        provider_item: Some(json!({"id":"legacy-private-item"})),
                    },
                    crate::agent_runtime::AgentAssistantContentBlock::ToolCall {
                        call: Box::new(crate::agent_runtime::RecordedToolCall {
                            call_id: "call".into(),
                            provider_call_id: Some("private-provider-call".into()),
                            name: "read_file".into(),
                            native_name: None,
                            arguments: json!({}),
                            title: None,
                            effect: None,
                            target: None,
                        }),
                    },
                ],
                usage: Default::default(),
                stop_reason: crate::agent_runtime::AgentStopReason::ToolCalls,
                interrupted: false,
                replay: Some(ReplayEnvelopeV5::LegacyUnknown {
                    archived_provider_items: true,
                }),
            },
        );
        public_event_projection(&mut event);
        let encoded = serde_json::to_string(&event).unwrap();
        assert!(!encoded.contains("legacy-private-item"));
        assert!(!encoded.contains("private-provider-call"));
        assert!(!encoded.contains("\"replay\""));
        assert!(encoded.contains("\"callId\":\"call\""));
    }
}
