use super::common::{
    ensure_nonempty_response, MAX_PROVIDER_TOOL_ARGUMENT_BYTES, MAX_PROVIDER_TOOL_CALL_ID_BYTES,
};
use crate::llm::{adapter::*, errors::*, transport::*, types::*, usage::*};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, sync::Arc};
use tokio_util::sync::CancellationToken;

const ANTHROPIC_VERSION: &str = "2023-06-01";

fn safe_provider_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PROVIDER_TOOL_CALL_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

pub(in crate::llm) struct AnthropicReplayCodec;
pub(in crate::llm) static ANTHROPIC_REPLAY_CODEC: AnthropicReplayCodec = AnthropicReplayCodec;

fn validate_redacted_list(value: Option<&Value>, label: &str) -> Result<(), NormalizedModelError> {
    let Some(value) = value else { return Ok(()) };
    let items = value.as_array().ok_or_else(|| {
        crate::llm::replay::replay_error(
            "REPLAY_METADATA_INVALID",
            format!("{label} must be an array"),
        )
    })?;
    for item in items {
        let object = crate::llm::replay::object_with_allowed_keys(
            item,
            &["data"],
            "Anthropic redacted thinking",
        )?;
        crate::llm::replay::optional_bounded_string(object, "data", "Anthropic redacted thinking")?
            .ok_or_else(|| {
                crate::llm::replay::replay_error(
                    "REPLAY_METADATA_INVALID",
                    "Anthropic redacted thinking is missing data",
                )
            })?;
    }
    Ok(())
}

impl ReplayCodec for AnthropicReplayCodec {
    fn adapter_id(&self) -> &'static str {
        "anthropic-messages"
    }
    fn replay_format_version(&self) -> u32 {
        1
    }

    fn validate_response_metadata(&self, value: &Value) -> Result<(), NormalizedModelError> {
        let object = crate::llm::replay::object_with_allowed_keys(
            value,
            &["messageId", "model", "redactedThinkingTail"],
            "Anthropic response metadata",
        )?;
        if let Some(message_id) =
            crate::llm::replay::optional_bounded_string(object, "messageId", "Anthropic response")?
        {
            if !safe_provider_id(&message_id) {
                return Err(crate::llm::replay::replay_error(
                    "REPLAY_METADATA_INVALID",
                    "Anthropic response messageId is invalid",
                ));
            }
        }
        crate::llm::replay::optional_bounded_string(object, "model", "Anthropic response")?;
        validate_redacted_list(object.get("redactedThinkingTail"), "redactedThinkingTail")
    }

    fn validate_block_metadata(
        &self,
        kind: crate::llm::replay::ReplayBlockKind,
        value: &Value,
    ) -> Result<(), NormalizedModelError> {
        use crate::llm::replay::ReplayBlockKind;
        let allowed: &[&str] = match kind {
            ReplayBlockKind::Text => &["redactedThinkingBefore"],
            ReplayBlockKind::Reasoning => &["signature", "redactedThinkingBefore"],
            ReplayBlockKind::ToolCall => &["providerCallId", "redactedThinkingBefore"],
        };
        let object = crate::llm::replay::object_with_allowed_keys(
            value,
            allowed,
            "Anthropic block metadata",
        )?;
        validate_redacted_list(
            object.get("redactedThinkingBefore"),
            "redactedThinkingBefore",
        )?;
        if kind == ReplayBlockKind::Reasoning {
            crate::llm::replay::optional_bounded_string(object, "signature", "Anthropic thinking")?
                .ok_or_else(|| {
                    crate::llm::replay::replay_error(
                        "REPLAY_METADATA_INVALID",
                        "Anthropic thinking is missing its signature",
                    )
                })?;
        }
        if let Some(provider_call_id) = crate::llm::replay::optional_bounded_string(
            object,
            "providerCallId",
            "Anthropic tool use",
        )? {
            if !safe_provider_id(&provider_call_id) {
                return Err(crate::llm::replay::replay_error(
                    "REPLAY_METADATA_INVALID",
                    "Anthropic providerCallId is invalid",
                ));
            }
        }
        Ok(())
    }

    fn restore_private_metadata(
        &self,
        content: &mut [ModelContentBlock],
        envelope: &crate::llm::replay::ReplayEnvelopeV5,
    ) -> Result<Value, NormalizedModelError> {
        let crate::llm::replay::ReplayEnvelopeV5::Prepared {
            response, blocks, ..
        } = envelope
        else {
            return Ok(json!({}));
        };
        for (block, replay) in content.iter_mut().zip(blocks) {
            match block {
                ModelContentBlock::Reasoning { provider_item, .. } => {
                    let signature = replay
                        .metadata
                        .get("signature")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            crate::llm::replay::replay_error(
                                "REPLAY_METADATA_INVALID",
                                "Anthropic thinking signature is missing",
                            )
                        })?;
                    *provider_item =
                        Some(json!({"anthropic":{"type":"thinking","signature":signature}}));
                }
                ModelContentBlock::ToolCall { call } => {
                    call.provider_call_id = replay
                        .metadata
                        .get("providerCallId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                ModelContentBlock::Text { .. } => {}
            }
        }
        Ok(json!({
            "response": response,
            "blocks": blocks.iter().map(|block| block.metadata.clone()).collect::<Vec<_>>()
        }))
    }
}

pub(in crate::llm) struct AnthropicMessagesAdapter {
    pub(in crate::llm) http: HttpConfig,
}

#[async_trait]
impl ModelAdapter for AnthropicMessagesAdapter {
    fn replay_codec(&self) -> &'static dyn ReplayCodec {
        &ANTHROPIC_REPLAY_CODEC
    }

    async fn stream(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
        sink: Arc<dyn ModelStreamSink>,
    ) -> Result<ModelResponse, NormalizedModelError> {
        let resolved = self.http.validate(&request)?;
        let api_key = self
            .http
            .api_key
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                coded_error(
                    NormalizedModelErrorKind::Authentication,
                    "Anthropic Messages requires a versioned credential",
                    "MISSING_CREDENTIAL",
                )
            })?;
        let messages = encode_messages(&request.messages)?;
        let mut body = json!({
            "model": self.http.provider.model,
            "max_tokens": resolved.max_output_tokens,
            "stream": true,
            "system": request.system_prompt,
            "messages": messages,
        });
        crate::llm::catalog::apply_reasoning(
            &mut body,
            &resolved,
            self.http.provider.reasoning_effort.clone(),
        );
        if !request.tools.is_empty() {
            body["tools"] = Value::Array(
                request
                    .tools
                    .iter()
                    .map(|tool| {
                        json!({
                            "name": tool.name,
                            "description": tool.description,
                            "input_schema": tool.input_schema,
                        })
                    })
                    .collect(),
            );
            body["tool_choice"] = json!({"type":"auto"});
        }
        let response = send_request(
            self.http
                .client
                .post(resolved.endpoint.clone())
                .header("x-api-key", api_key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .header(reqwest::header::ACCEPT, "text/event-stream")
                .json(&body),
            &cancellation,
            self.http.timeouts,
        )
        .await?;
        let provider_request_id = response
            .headers()
            .get("request-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let response =
            match checked_stream_response(response, &cancellation, self.http.timeouts).await {
                Ok(response) => response,
                Err(mut error) => {
                    attach_provider_request_id(&mut error, provider_request_id.as_deref());
                    return Err(error);
                }
            };
        stream_anthropic(response, &cancellation, sink, self.http.timeouts).await
    }
}

fn parse_image_data_url(value: &str) -> Result<Value, NormalizedModelError> {
    let (header, data) = value.split_once(',').ok_or_else(|| {
        coded_error(
            NormalizedModelErrorKind::Protocol,
            "resolved image is not a data URL",
            "IMAGE_UNRESOLVED",
        )
    })?;
    let media_type = header
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .filter(|value| {
            matches!(
                *value,
                "image/png" | "image/jpeg" | "image/gif" | "image/webp"
            )
        })
        .ok_or_else(|| {
            coded_error(
                NormalizedModelErrorKind::Protocol,
                "resolved image has an unsupported media type",
                "IMAGE_UNSUPPORTED_MEDIA_TYPE",
            )
        })?;
    if data.is_empty() {
        return Err(coded_error(
            NormalizedModelErrorKind::Protocol,
            "resolved image is empty",
            "IMAGE_UNRESOLVED",
        ));
    }
    Ok(json!({"type":"image","source":{"type":"base64","media_type":media_type,"data":data}}))
}

fn append_message(output: &mut Vec<Value>, role: &str, mut blocks: Vec<Value>) {
    if let Some(last) = output
        .last_mut()
        .filter(|last| last.get("role").and_then(Value::as_str) == Some(role))
    {
        last.get_mut("content")
            .and_then(Value::as_array_mut)
            .expect("message content")
            .append(&mut blocks);
    } else {
        output.push(json!({"role":role,"content":blocks}));
    }
}

fn redacted_blocks(metadata: Option<&Value>, key: &str) -> Vec<Value> {
    metadata
        .and_then(|value| value.get(key))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("data").and_then(Value::as_str))
        .map(|data| json!({"type":"redacted_thinking","data":data}))
        .collect()
}

pub(in crate::llm) fn encode_messages(
    messages: &[ModelMessage],
) -> Result<Vec<Value>, NormalizedModelError> {
    let mut output = Vec::new();
    for message in messages {
        match message {
            ModelMessage::User { content } => append_message(
                &mut output,
                "user",
                vec![json!({"type":"text","text":content})],
            ),
            ModelMessage::UserImages {
                content, data_urls, ..
            } => {
                let mut blocks = data_urls
                    .iter()
                    .map(|value| parse_image_data_url(value))
                    .collect::<Result<Vec<_>, _>>()?;
                if !content.trim().is_empty() {
                    blocks.push(json!({"type":"text","text":content}));
                }
                append_message(&mut output, "user", blocks);
            }
            ModelMessage::Tool {
                call_id,
                provider_call_id,
                content,
                ..
            } => append_message(
                &mut output,
                "user",
                vec![json!({
                    "type":"tool_result",
                    "tool_use_id":provider_call_id.as_deref().unwrap_or(call_id),
                    "content":[{"type":"text","text":content}],
                })],
            ),
            ModelMessage::Assistant {
                content,
                native_replay,
                ..
            } => {
                let metadata = native_replay
                    .as_ref()
                    .and_then(|value| value.get("blocks"))
                    .and_then(Value::as_array);
                let mut blocks = Vec::new();
                for (index, block) in content.iter().enumerate() {
                    let replay = metadata.and_then(|items| items.get(index));
                    blocks.extend(redacted_blocks(replay, "redactedThinkingBefore"));
                    match block {
                        ModelContentBlock::Text { text } => {
                            blocks.push(json!({"type":"text","text":text}))
                        }
                        ModelContentBlock::Reasoning {
                            text,
                            provider_item,
                        } => {
                            if let Some(signature) = provider_item
                                .as_ref()
                                .and_then(|item| item.pointer("/anthropic/signature"))
                                .and_then(Value::as_str)
                            {
                                blocks.push(json!({"type":"thinking","thinking":text,"signature":signature}));
                            } else {
                                blocks.push(json!({"type":"text","text":text}));
                            }
                        }
                        ModelContentBlock::ToolCall { call } => blocks.push(json!({
                            "type":"tool_use",
                            "id":call.provider_call_id.as_deref().unwrap_or(&call.call_id),
                            "name":call.name,
                            "input":call.arguments,
                        })),
                    }
                }
                let response = native_replay
                    .as_ref()
                    .and_then(|value| value.get("response"));
                blocks.extend(redacted_blocks(response, "redactedThinkingTail"));
                append_message(&mut output, "assistant", blocks);
            }
        }
    }
    if output
        .last()
        .and_then(|message| message.get("role"))
        .and_then(Value::as_str)
        != Some("user")
    {
        return Err(coded_error(
            NormalizedModelErrorKind::Protocol,
            "Anthropic Messages history must end with a user message",
            "HISTORY_INCOMPATIBLE",
        ));
    }
    Ok(output)
}

#[derive(Debug)]
enum BlockState {
    Text {
        text: String,
    },
    Thinking {
        text: String,
        signature: String,
    },
    Redacted {
        data: String,
    },
    ToolUse {
        id: String,
        name: String,
        arguments: String,
        saw_delta: bool,
    },
}

#[derive(Default)]
struct AnthropicAccumulator {
    started: bool,
    stopped: bool,
    next_index: u32,
    open_index: Option<u32>,
    blocks: BTreeMap<u32, BlockState>,
    output_indices: BTreeMap<u32, u32>,
    next_output_index: u32,
    message_id: Option<String>,
    model: Option<String>,
    stop_reason: Option<String>,
    usage: ProviderUsage,
}

fn protocol(message: impl Into<String>, code: &str) -> NormalizedModelError {
    coded_error(NormalizedModelErrorKind::Protocol, message, code)
}

fn attach_provider_request_id(error: &mut NormalizedModelError, request_id: Option<&str>) {
    let Some(request_id) = request_id.filter(|value| {
        !value.is_empty()
            && value.len() <= 256
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    }) else {
        return;
    };
    error.message = NormalizedModelError::new(
        error.kind,
        format!("{} (Anthropic request ID: {request_id})", error.message),
    )
    .message;
}

fn sse_event_name(event: &str) -> Option<&str> {
    event
        .lines()
        .find_map(|line| line.strip_prefix("event:").map(str::trim))
}

fn usage_from(value: &Value) -> Option<ProviderUsage> {
    value
        .pointer("/message/usage")
        .or_else(|| value.get("usage"))
        .and_then(|usage| {
            provider_usage_from_value(crate::llm::config::AiProviderKind::AnthropicMessages, usage)
        })
}

fn process_anthropic_event(
    event: &str,
    sink: &Arc<dyn ModelStreamSink>,
    state: &mut AnthropicAccumulator,
) -> Result<(), NormalizedModelError> {
    let data = sse_data(event);
    if data.is_empty() {
        return Ok(());
    }
    let value: Value = serde_json::from_str(&data).map_err(|error| {
        protocol(
            format!("invalid Anthropic stream event: {error}"),
            "ANTHROPIC_EVENT_JSON",
        )
    })?;
    let event_type = value.get("type").and_then(Value::as_str).ok_or_else(|| {
        protocol(
            "Anthropic stream event is missing type",
            "ANTHROPIC_EVENT_TYPE",
        )
    })?;
    if sse_event_name(event).is_some_and(|name| name != event_type) {
        return Err(protocol(
            "Anthropic SSE event name does not match data.type",
            "ANTHROPIC_EVENT_MISMATCH",
        ));
    }
    if event_type == "error" {
        let kind = value
            .pointer("/error/type")
            .and_then(Value::as_str)
            .unwrap_or("api_error");
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Anthropic stream error");
        let status = match kind {
            "authentication_error" => 401,
            "permission_error" => 403,
            "rate_limit_error" => 429,
            "overloaded_error" => 529,
            _ => 500,
        };
        let mut error = normalize_provider_error(status, message);
        error.code = Some(format!("ANTHROPIC_{}", kind.to_ascii_uppercase()));
        attach_provider_request_id(&mut error, value.get("request_id").and_then(Value::as_str));
        return Err(error);
    }
    match event_type {
        "message_start" => {
            if state.started || state.stopped {
                return Err(protocol(
                    "duplicate Anthropic message_start",
                    "ANTHROPIC_SEQUENCE",
                ));
            }
            let message = value
                .get("message")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    protocol(
                        "Anthropic message_start is missing message",
                        "ANTHROPIC_MESSAGE_START",
                    )
                })?;
            if message.get("role").and_then(Value::as_str) != Some("assistant")
                || message
                    .get("content")
                    .and_then(Value::as_array)
                    .is_none_or(|content| !content.is_empty())
            {
                return Err(protocol(
                    "invalid Anthropic message_start shape",
                    "ANTHROPIC_MESSAGE_START",
                ));
            }
            state.message_id = message
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| safe_provider_id(value))
                .map(str::to_string);
            state.model = message
                .get("model")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 256)
                .map(str::to_string);
            if state.message_id.is_none() || state.model.is_none() {
                return Err(protocol(
                    "Anthropic message_start is missing id or model",
                    "ANTHROPIC_MESSAGE_START",
                ));
            }
            state.started = true;
        }
        "ping" => {
            if !state.started || state.stopped {
                return Err(protocol(
                    "Anthropic ping outside message",
                    "ANTHROPIC_SEQUENCE",
                ));
            }
        }
        "content_block_start" => {
            if !state.started || state.stopped || state.open_index.is_some() {
                return Err(protocol(
                    "Anthropic content block started out of order",
                    "ANTHROPIC_BLOCK_SEQUENCE",
                ));
            }
            let index = value
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| {
                    protocol(
                        "Anthropic content block index is invalid",
                        "ANTHROPIC_BLOCK_INDEX",
                    )
                })?;
            if index != state.next_index || state.blocks.contains_key(&index) {
                return Err(protocol(
                    "Anthropic content block index is duplicate or out of order",
                    "ANTHROPIC_BLOCK_INDEX",
                ));
            }
            let block = value
                .get("content_block")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    protocol(
                        "Anthropic content block is missing",
                        "ANTHROPIC_BLOCK_START",
                    )
                })?;
            let block = match block.get("type").and_then(Value::as_str) {
                Some("text") => BlockState::Text {
                    text: block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                },
                Some("thinking") => BlockState::Thinking {
                    text: block
                        .get("thinking")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    signature: block
                        .get("signature")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                },
                Some("redacted_thinking") => BlockState::Redacted {
                    data: block
                        .get("data")
                        .and_then(Value::as_str)
                        .filter(|data| !data.is_empty())
                        .ok_or_else(|| {
                            protocol(
                                "redacted thinking is missing data",
                                "ANTHROPIC_REDACTED_THINKING",
                            )
                        })?
                        .into(),
                },
                Some("tool_use") => BlockState::ToolUse {
                    id: block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    name: block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    arguments: serde_json::to_string(block.get("input").unwrap_or(&json!({})))
                        .map_err(|error| {
                            protocol(
                                format!("invalid Anthropic tool input: {error}"),
                                "ANTHROPIC_TOOL_JSON",
                            )
                        })?,
                    saw_delta: false,
                },
                Some(kind) => {
                    return Err(protocol(
                        format!("unsupported Anthropic content block {kind}"),
                        "ANTHROPIC_BLOCK_UNKNOWN",
                    ))
                }
                None => {
                    return Err(protocol(
                        "Anthropic content block type is missing",
                        "ANTHROPIC_BLOCK_START",
                    ))
                }
            };
            let output_index = state.next_output_index;
            if !matches!(block, BlockState::Redacted { .. }) {
                state.output_indices.insert(index, output_index);
                state.next_output_index += 1;
            }
            match &block {
                BlockState::Text { text } if !text.is_empty() => {
                    sink.emit(StreamDelta::Text {
                        index: output_index,
                        text: text.clone(),
                    })?;
                }
                BlockState::Thinking { text, .. } if !text.is_empty() => {
                    sink.emit(StreamDelta::Reasoning {
                        index: output_index,
                        text: text.clone(),
                    })?;
                }
                BlockState::ToolUse { id, name, .. } => {
                    sink.emit(StreamDelta::ToolCall {
                        index: output_index,
                        call_id: Some(id.clone()),
                        name_delta: Some(name.clone()),
                        arguments_delta: None,
                    })?;
                }
                _ => {}
            }
            state.blocks.insert(index, block);
            state.open_index = Some(index);
        }
        "content_block_delta" => {
            let index = value
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| {
                    protocol(
                        "Anthropic content block delta index is invalid",
                        "ANTHROPIC_BLOCK_INDEX",
                    )
                })?;
            if state.open_index != Some(index) {
                return Err(protocol(
                    "Anthropic content block delta has no matching open block",
                    "ANTHROPIC_BLOCK_SEQUENCE",
                ));
            }
            let delta = value
                .get("delta")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    protocol(
                        "Anthropic content block delta is missing",
                        "ANTHROPIC_BLOCK_DELTA",
                    )
                })?;
            let output_index = state.output_indices.get(&index).copied();
            match (
                state.blocks.get_mut(&index).expect("open block"),
                delta.get("type").and_then(Value::as_str),
            ) {
                (BlockState::Text { text }, Some("text_delta")) => {
                    let fragment = delta.get("text").and_then(Value::as_str).ok_or_else(|| {
                        protocol("text_delta is missing text", "ANTHROPIC_BLOCK_DELTA")
                    })?;
                    text.push_str(fragment);
                    sink.emit(StreamDelta::Text {
                        index: output_index.expect("text output index"),
                        text: fragment.into(),
                    })?;
                }
                (BlockState::Thinking { text, .. }, Some("thinking_delta")) => {
                    let fragment =
                        delta
                            .get("thinking")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                protocol(
                                    "thinking_delta is missing thinking",
                                    "ANTHROPIC_BLOCK_DELTA",
                                )
                            })?;
                    text.push_str(fragment);
                    sink.emit(StreamDelta::Reasoning {
                        index: output_index.expect("thinking output index"),
                        text: fragment.into(),
                    })?;
                }
                (BlockState::Thinking { signature, .. }, Some("signature_delta")) => {
                    let fragment =
                        delta
                            .get("signature")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                protocol(
                                    "signature_delta is missing signature",
                                    "ANTHROPIC_BLOCK_DELTA",
                                )
                            })?;
                    signature.push_str(fragment);
                }
                (
                    BlockState::ToolUse {
                        arguments,
                        saw_delta,
                        ..
                    },
                    Some("input_json_delta"),
                ) => {
                    let fragment = delta
                        .get("partial_json")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            protocol(
                                "input_json_delta is missing partial_json",
                                "ANTHROPIC_BLOCK_DELTA",
                            )
                        })?;
                    if !*saw_delta {
                        arguments.clear();
                        *saw_delta = true;
                    }
                    arguments.push_str(fragment);
                    if arguments.len() > MAX_PROVIDER_TOOL_ARGUMENT_BYTES {
                        return Err(protocol(
                            "Anthropic tool arguments exceeded the 64 KiB limit",
                            "ANTHROPIC_TOOL_ARGUMENT_LIMIT",
                        ));
                    }
                    sink.emit(StreamDelta::ToolCall {
                        index: output_index.expect("tool output index"),
                        call_id: None,
                        name_delta: None,
                        arguments_delta: Some(fragment.into()),
                    })?;
                }
                _ => {
                    return Err(protocol(
                        "Anthropic delta type does not match its content block",
                        "ANTHROPIC_BLOCK_DELTA_MISMATCH",
                    ))
                }
            }
        }
        "content_block_stop" => {
            let index = value
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| {
                    protocol(
                        "Anthropic content block stop index is invalid",
                        "ANTHROPIC_BLOCK_INDEX",
                    )
                })?;
            if state.open_index != Some(index) {
                return Err(protocol(
                    "Anthropic content block stopped out of order",
                    "ANTHROPIC_BLOCK_SEQUENCE",
                ));
            }
            match state.blocks.get(&index).expect("open block") {
                BlockState::Thinking { signature, .. } if signature.is_empty() => {
                    return Err(protocol(
                        "Anthropic thinking block is missing signature",
                        "ANTHROPIC_THINKING_SIGNATURE",
                    ))
                }
                BlockState::ToolUse {
                    id,
                    name,
                    arguments,
                    ..
                } => {
                    if !safe_provider_id(id) || name.trim().is_empty() || name.len() > 256 {
                        return Err(protocol(
                            "Anthropic tool_use is missing or exceeds id/name limits",
                            "ANTHROPIC_TOOL_USE",
                        ));
                    }
                    let parsed: Value = serde_json::from_str(arguments).map_err(|error| {
                        protocol(
                            format!("invalid Anthropic tool input JSON: {error}"),
                            "ANTHROPIC_TOOL_JSON",
                        )
                    })?;
                    if !parsed.is_object() {
                        return Err(protocol(
                            "Anthropic tool input must be a JSON object",
                            "ANTHROPIC_TOOL_JSON",
                        ));
                    }
                }
                _ => {}
            }
            state.open_index = None;
            state.next_index += 1;
        }
        "message_delta" => {
            if !state.started || state.stopped || state.open_index.is_some() {
                return Err(protocol(
                    "Anthropic message_delta arrived out of order",
                    "ANTHROPIC_SEQUENCE",
                ));
            }
            if let Some(reason) = value.pointer("/delta/stop_reason").and_then(Value::as_str) {
                if state.stop_reason.replace(reason.into()).is_some() {
                    return Err(protocol(
                        "duplicate Anthropic stop_reason",
                        "ANTHROPIC_SEQUENCE",
                    ));
                }
            }
        }
        "message_stop" => {
            if !state.started
                || state.stopped
                || state.open_index.is_some()
                || state.stop_reason.is_none()
            {
                return Err(protocol(
                    "Anthropic message_stop arrived before completion",
                    "ANTHROPIC_SEQUENCE",
                ));
            }
            state.stopped = true;
        }
        kind => {
            return Err(protocol(
                format!("unknown Anthropic stream event {kind}"),
                "ANTHROPIC_EVENT_UNKNOWN",
            ))
        }
    }
    if let Some(next) = usage_from(&value) {
        state.usage.merge_latest(next);
        state.usage.total_tokens = state
            .usage
            .uncached_input_tokens
            .zip(state.usage.output_tokens)
            .and_then(|(input, output)| {
                input
                    .checked_add(state.usage.cache_read_tokens.unwrap_or_default())?
                    .checked_add(state.usage.cache_write_tokens.unwrap_or_default())?
                    .checked_add(output)
            });
        sink.emit(StreamDelta::Usage {
            usage: state.usage.into(),
        })?;
    }
    Ok(())
}

async fn stream_anthropic(
    response: reqwest::Response,
    cancellation: &CancellationToken,
    sink: Arc<dyn ModelStreamSink>,
    timeouts: ModelTimeoutPolicy,
) -> Result<ModelResponse, NormalizedModelError> {
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut response_bytes = 0;
    let mut state = AnthropicAccumulator::default();
    let mut deadline = StreamDeadline::new(timeouts);
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(NormalizedModelError::cancelled()),
            _ = deadline.timer.as_mut() => return Err(deadline.timeout_error()),
            next = stream.next() => {
                let Some(chunk) = next else { break };
                let chunk = chunk.map_err(normalize_transport_error)?;
                deadline.observe_bytes(chunk.len());
                append_provider_stream_chunk(&mut buffer, &chunk, &mut response_bytes)
                    .map_err(|error| protocol(error, "STREAM_LIMIT"))?;
                while let Some(event) = take_sse_event(&mut buffer).map_err(|error| protocol(error, "SSE_FRAMING"))? {
                    if !sse_data(&event).is_empty() { process_anthropic_event(&event, &sink, &mut state)?; deadline.observe_frame(); }
                }
                ensure_provider_stream_frame_size(buffer.len()).map_err(|error| protocol(error, "STREAM_LIMIT"))?;
                if state.stopped { break }
            }
        }
    }
    if !state.stopped {
        if let Some(event) =
            take_final_sse_event(&mut buffer).map_err(|error| protocol(error, "SSE_FRAMING"))?
        {
            process_anthropic_event(&event, &sink, &mut state)?;
        }
    }
    if !state.stopped {
        return Err(if deadline.first_byte_seen {
            protocol(
                "Anthropic stream ended before message_stop",
                "STREAM_CLOSED",
            )
        } else {
            deadline.empty_response_error("Anthropic stream")
        });
    }
    let finish_reason = match state.stop_reason.as_deref() {
        Some("end_turn" | "stop_sequence") => ModelFinishReason::Stop,
        Some("tool_use") => ModelFinishReason::ToolCalls,
        Some("max_tokens" | "model_context_window_exceeded") => ModelFinishReason::Length,
        Some("refusal") => ModelFinishReason::ContentFilter,
        Some(_) => ModelFinishReason::Other,
        None => unreachable!(),
    };
    if finish_reason == ModelFinishReason::Length {
        return Err(coded_error(
            NormalizedModelErrorKind::Terminal,
            "Anthropic reached the configured output token limit",
            "OUTPUT_LIMIT",
        ));
    }
    let mut content = Vec::new();
    let mut metadata = Vec::new();
    let mut pending_redacted = Vec::new();
    let mut tool_ordinal = 0;
    for (_, block) in state.blocks {
        match block {
            BlockState::Redacted { data } => pending_redacted.push(json!({"data":data})),
            BlockState::Text { text } => {
                if !text.is_empty() {
                    content.push(ModelContentBlock::Text { text });
                    metadata.push(metadata_with_redacted(Map::new(), &mut pending_redacted));
                }
            }
            BlockState::Thinking { text, signature } => {
                if !text.is_empty() {
                    content.push(ModelContentBlock::Reasoning {
                        text,
                        provider_item: Some(
                            json!({"anthropic":{"type":"thinking","signature":signature}}),
                        ),
                    });
                    let mut value = Map::new();
                    value.insert("signature".into(), json!(signature));
                    metadata.push(metadata_with_redacted(value, &mut pending_redacted));
                }
            }
            BlockState::ToolUse {
                id,
                name,
                arguments,
                ..
            } => {
                tool_ordinal += 1;
                let arguments = serde_json::from_str(&arguments).map_err(|error| {
                    protocol(
                        format!("invalid Anthropic tool input JSON: {error}"),
                        "ANTHROPIC_TOOL_JSON",
                    )
                })?;
                content.push(ModelContentBlock::ToolCall {
                    call: ModelToolCall {
                        call_id: format!("call-{tool_ordinal}"),
                        provider_call_id: Some(id.clone()),
                        name,
                        arguments,
                    },
                });
                let mut value = Map::new();
                value.insert("providerCallId".into(), json!(id));
                metadata.push(metadata_with_redacted(value, &mut pending_redacted));
            }
        }
    }
    ensure_nonempty_response(&content)?;
    let response = json!({
        "messageId": state.message_id.expect("validated message id"),
        "model": state.model.expect("validated model"),
        "redactedThinkingTail": pending_redacted,
    });
    Ok(ModelResponse {
        content,
        finish_reason,
        usage: state.usage.into(),
        replay: Some(AdapterReplayCapture {
            response,
            blocks: metadata,
        }),
        replay_envelope: None,
    })
}

fn metadata_with_redacted(mut value: Map<String, Value>, pending: &mut Vec<Value>) -> Value {
    if !pending.is_empty() {
        value.insert(
            "redactedThinkingBefore".into(),
            Value::Array(std::mem::take(pending)),
        );
    }
    Value::Object(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::images::ImageRef;
    use std::{
        io::{Read, Write},
        net::{Ipv4Addr, TcpListener},
        sync::Mutex,
        thread,
        time::Duration,
    };

    #[derive(Default)]
    struct Sink(Mutex<Vec<StreamDelta>>);
    impl ModelStreamSink for Sink {
        fn emit(&self, delta: StreamDelta) -> Result<(), NormalizedModelError> {
            self.0.lock().unwrap().push(delta);
            Ok(())
        }
    }

    fn anthropic_provider(base_url: String) -> crate::llm::config::AiProviderConfig {
        crate::llm::config::AiProviderConfig {
            model_definition: None,
            retry_policy: None,
            profile: Some("anthropic".into()),
            id: "anthropic-route".into(),
            kind: crate::llm::config::AiProviderKind::AnthropicMessages,
            base_url,
            model: "claude-sonnet-5".into(),
            reasoning_effort: Some("high".into()),
            requires_api_key: true,
            api_key: None,
        }
    }

    fn serve(response: Vec<u8>) -> (String, thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut received = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let count = socket.read(&mut chunk).unwrap();
                received.extend_from_slice(&chunk[..count]);
                if let Some(end) = received.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&received[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or_default();
                    if received.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            socket.write_all(&response).unwrap();
            received
        });
        (format!("http://{address}"), handle)
    }

    fn sse(events: &[Value]) -> Vec<u8> {
        let body = events
            .iter()
            .map(|value| {
                let event = value["type"].as_str().unwrap();
                format!("event: {event}\ndata: {value}\n\n")
            })
            .collect::<String>();
        format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).into_bytes()
    }

    fn basic_request() -> ModelRequest {
        ModelRequest {
            request_id: "request-safe".into(),
            surface_generation: 0,
            system_prompt: "system".into(),
            messages: vec![ModelMessage::User {
                content: "hello".into(),
            }],
            tools: Vec::new(),
        }
    }

    fn serve_stalled(
        prefix: Option<&'static [u8]>,
        headers: bool,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request);
            if headers {
                socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n").unwrap();
                if let Some(prefix) = prefix {
                    write!(socket, "{:x}\r\n", prefix.len()).unwrap();
                    socket.write_all(prefix).unwrap();
                    socket.write_all(b"\r\n").unwrap();
                }
                socket.flush().unwrap();
            }
            thread::sleep(Duration::from_millis(100));
            let _ = socket.write_all(b"0\r\n\r\n");
        });
        (format!("http://{address}"), server)
    }

    #[tokio::test]
    async fn exact_messages_wire_and_stream_cover_images_thinking_redaction_and_parallel_tools() {
        let events = vec![
            json!({"type":"message_start","message":{"id":"msg_safe","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5","stop_reason":null,"usage":{"input_tokens":11,"cache_creation_input_tokens":3,"cache_read_input_tokens":5,"output_tokens":1}}}),
            json!({"type":"ping"}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed-current"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque-redacted"}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"checking"}}),
            json!({"type":"content_block_stop","index":2}),
            json!({"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"toolu_one","name":"read_file","input":{}}}),
            json!({"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"a\"}"}}),
            json!({"type":"content_block_stop","index":3}),
            json!({"type":"content_block_start","index":4,"content_block":{"type":"tool_use","id":"toolu_two","name":"list_files","input":{}}}),
            json!({"type":"content_block_delta","index":4,"delta":{"type":"input_json_delta","partial_json":"{}"}}),
            json!({"type":"content_block_stop","index":4}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":19}}),
            json!({"type":"message_stop"}),
        ];
        let (base_url, server) = serve(sse(&events));
        let adapter = AnthropicMessagesAdapter {
            http: HttpConfig {
                client: build_streaming_client().unwrap(),
                provider: anthropic_provider(base_url),
                api_key: Some("stage-e-secret".into()),
                timeouts: ModelTimeoutPolicy::default(),
            },
        };
        let request = ModelRequest {
            request_id: "request-safe".into(),
            surface_generation: 1,
            system_prompt: "system".into(),
            messages: vec![
                ModelMessage::UserImages {
                    content: "inspect".into(),
                    images: vec![ImageRef {
                        version: 1,
                        sha256: "a".repeat(64),
                        media_type: "image/png".into(),
                        bytes: 3,
                        width: 1,
                        height: 1,
                        name: "pixel.png".into(),
                    }],
                    data_urls: vec!["data:image/png;base64,AAAA".into()],
                },
                ModelMessage::Assistant {
                    content: vec![
                        ModelContentBlock::Reasoning {
                            text: "prior plan".into(),
                            provider_item: Some(
                                json!({"anthropic":{"type":"thinking","signature":"signed-prior"}}),
                            ),
                        },
                        ModelContentBlock::ToolCall {
                            call: ModelToolCall {
                                call_id: "call-prior".into(),
                                provider_call_id: Some("toolu_prior".into()),
                                name: "read_file".into(),
                                arguments: json!({"path":"old"}),
                            },
                        },
                        ModelContentBlock::ToolCall {
                            call: ModelToolCall {
                                call_id: "call-prior-2".into(),
                                provider_call_id: Some("toolu_prior_2".into()),
                                name: "list_files".into(),
                                arguments: json!({}),
                            },
                        },
                    ],
                    replay: None,
                    native_replay: None,
                },
                ModelMessage::Tool {
                    call_id: "call-prior".into(),
                    provider_call_id: Some("toolu_prior".into()),
                    name: "read_file".into(),
                    content: "ok".into(),
                },
                ModelMessage::Tool {
                    call_id: "call-prior-2".into(),
                    provider_call_id: Some("toolu_prior_2".into()),
                    name: "list_files".into(),
                    content: "two".into(),
                },
                ModelMessage::User {
                    content: "continue".into(),
                },
            ],
            tools: vec![
                ModelToolDefinition {
                    name: "read_file".into(),
                    description: "Read one file".into(),
                    input_schema: json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
                },
                ModelToolDefinition {
                    name: "list_files".into(),
                    description: "List files".into(),
                    input_schema: json!({"type":"object"}),
                },
            ],
        };
        let sink = Arc::new(Sink::default());
        let response = adapter
            .stream(request, CancellationToken::new(), sink.clone())
            .await
            .unwrap();
        let wire = String::from_utf8(server.join().unwrap()).unwrap();
        let (headers, body) = wire.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with("POST /v1/messages HTTP/1.1"));
        assert!(headers
            .to_ascii_lowercase()
            .contains("x-api-key: stage-e-secret"));
        assert!(headers
            .to_ascii_lowercase()
            .contains("anthropic-version: 2023-06-01"));
        assert!(!headers.to_ascii_lowercase().contains("anthropic-beta"));
        assert!(!headers.to_ascii_lowercase().contains("authorization:"));
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["system"], "system");
        assert_eq!(body["max_tokens"], 128000);
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(body["output_config"]["effort"], "high");
        assert_eq!(
            body["messages"][0]["content"][0]["source"]["media_type"],
            "image/png"
        );
        assert_eq!(
            body["messages"][1]["content"][0]["signature"],
            "signed-prior"
        );
        assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
        assert_eq!(
            body["messages"][2]["content"][0]["tool_use_id"],
            "toolu_prior"
        );
        assert_eq!(
            body["messages"][2]["content"][1]["tool_use_id"],
            "toolu_prior_2"
        );
        assert_eq!(body["messages"][2]["content"][2]["text"], "continue");
        assert_eq!(body["tool_choice"]["type"], "auto");
        assert_eq!(response.finish_reason, ModelFinishReason::ToolCalls);
        assert_eq!(response.usage.uncached_input_tokens, Some(11));
        assert_eq!(response.usage.cache_read_tokens, Some(5));
        assert_eq!(response.usage.cache_write_tokens, Some(3));
        assert_eq!(response.usage.output_tokens, Some(19));
        assert_eq!(response.usage.total_tokens, Some(38));
        assert_eq!(response.content.len(), 4);
        assert_eq!(
            response.replay.as_ref().unwrap().blocks[1]["redactedThinkingBefore"][0]["data"],
            "opaque-redacted"
        );
        let deltas = sink.0.lock().unwrap();
        assert!(deltas
            .iter()
            .any(|delta| matches!(delta, StreamDelta::Text { index: 1, .. })));
        assert!(deltas.iter().any(|delta| matches!(delta, StreamDelta::ToolCall { index:3, call_id:Some(id), .. } if id == "toolu_two")));
        drop(deltas);
        let serialized = serde_json::to_string(&response.replay).unwrap();
        assert!(!serialized.contains("stage-e-secret"));
        assert!(!serialized.contains("data:image"));
    }

    fn event(value: Value) -> String {
        format!("event: {}\ndata: {value}", value["type"].as_str().unwrap())
    }

    #[test]
    fn malformed_or_incomplete_anthropic_events_fail_closed() {
        let sink: Arc<dyn ModelStreamSink> = Arc::new(Sink::default());
        let start = event(
            json!({"type":"message_start","message":{"id":"msg","role":"assistant","content":[],"model":"model"}}),
        );
        let cases = vec![
            vec![
                start.clone(),
                event(
                    json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
                ),
            ],
            vec![
                start.clone(),
                event(
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
                ),
                event(json!({"type":"content_block_stop","index":0})),
            ],
            vec![
                start.clone(),
                event(
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu","name":"x","input":{}}}),
                ),
                event(
                    json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}),
                ),
                event(json!({"type":"content_block_stop","index":0})),
            ],
            vec![
                start.clone(),
                event(json!({"type":"future_critical_event"})),
            ],
        ];
        for events in cases {
            let mut state = AnthropicAccumulator::default();
            let mut error = None;
            for next in events {
                if let Err(found) = process_anthropic_event(&next, &sink, &mut state) {
                    error = Some(found);
                    break;
                }
            }
            assert!(error.is_some());
            assert_eq!(error.unwrap().kind, NormalizedModelErrorKind::Protocol);
        }
    }

    #[test]
    fn stream_error_maps_stable_anthropic_classification() {
        let sink: Arc<dyn ModelStreamSink> = Arc::new(Sink::default());
        let mut state = AnthropicAccumulator::default();
        let error = process_anthropic_event(
            &event(json!({"type":"error","error":{"type":"overloaded_error","message":"busy"},"request_id":"req_safe"})),
            &sink,
            &mut state,
        ).unwrap_err();
        assert_eq!(error.kind, NormalizedModelErrorKind::Retryable);
        assert_eq!(error.status, Some(529));
        assert_eq!(error.code.as_deref(), Some("ANTHROPIC_OVERLOADED_ERROR"));
        assert!(error.message.contains("req_safe"));
    }

    #[tokio::test]
    async fn cancellation_and_all_three_timeout_phases_are_typed() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let cancelled = AnthropicMessagesAdapter {
            http: HttpConfig {
                client: build_streaming_client().unwrap(),
                provider: anthropic_provider("http://127.0.0.1:9".into()),
                api_key: Some("stage-e-secret".into()),
                timeouts: ModelTimeoutPolicy::default(),
            },
        }
        .stream(basic_request(), cancellation, Arc::new(Sink::default()))
        .await
        .unwrap_err();
        assert_eq!(cancelled.kind, NormalizedModelErrorKind::Cancelled);

        let timeouts = ModelTimeoutPolicy {
            request_headers: Duration::from_millis(20),
            first_byte: Duration::from_millis(20),
            stream_idle: Duration::from_millis(20),
        };
        const START: &[u8] = b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg\",\"role\":\"assistant\",\"content\":[],\"model\":\"model\"}}\n\n";
        for (prefix, headers, expected) in [
            (None, false, "REQUEST_HEADERS_TIMEOUT"),
            (None, true, "FIRST_BYTE_TIMEOUT"),
            (Some(START), true, "STREAM_IDLE_TIMEOUT"),
        ] {
            let (base_url, server) = serve_stalled(prefix, headers);
            let error = AnthropicMessagesAdapter {
                http: HttpConfig {
                    client: build_streaming_client().unwrap(),
                    provider: anthropic_provider(base_url),
                    api_key: Some("stage-e-secret".into()),
                    timeouts,
                },
            }
            .stream(
                basic_request(),
                CancellationToken::new(),
                Arc::new(Sink::default()),
            )
            .await
            .unwrap_err();
            assert_eq!(error.kind, NormalizedModelErrorKind::Timeout);
            assert_eq!(error.code.as_deref(), Some(expected));
            assert!(!error.message.contains("stage-e-secret"));
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn http_auth_rate_limit_and_server_errors_keep_safe_request_id() {
        for (status, expected) in [
            (401, NormalizedModelErrorKind::Authentication),
            (403, NormalizedModelErrorKind::Authentication),
            (429, NormalizedModelErrorKind::RateLimited),
            (500, NormalizedModelErrorKind::Retryable),
        ] {
            let body =
                format!("{{\"type\":\"error\",\"error\":{{\"message\":\"status {status}\"}}}}");
            let response = format!("HTTP/1.1 {status} Error\r\ncontent-type: application/json\r\nrequest-id: req_safe_{status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).into_bytes();
            let (base_url, server) = serve(response);
            let error = AnthropicMessagesAdapter {
                http: HttpConfig {
                    client: build_streaming_client().unwrap(),
                    provider: anthropic_provider(base_url),
                    api_key: Some("stage-e-secret".into()),
                    timeouts: ModelTimeoutPolicy::default(),
                },
            }
            .stream(
                basic_request(),
                CancellationToken::new(),
                Arc::new(Sink::default()),
            )
            .await
            .unwrap_err();
            let _ = server.join().unwrap();
            assert_eq!(error.kind, expected);
            assert_eq!(error.status, Some(status));
            assert!(error.message.contains(&format!("req_safe_{status}")));
            assert!(!error.message.contains("stage-e-secret"));
        }
    }

    #[test]
    fn endpoint_normalization_never_duplicates_version_or_messages() {
        for base in [
            "https://api.anthropic.com",
            "https://api.anthropic.com/v1",
            "https://api.anthropic.com/v1/messages",
        ] {
            let provider = anthropic_provider(base.into());
            assert_eq!(
                crate::llm::config::endpoint_url(&provider, "messages")
                    .unwrap()
                    .as_str(),
                "https://api.anthropic.com/v1/messages",
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires SHELLSPAN_LIVE_ANTHROPIC_API_KEY and external network access"]
    async fn live_anthropic_messages_basic_round() {
        let api_key = std::env::var("SHELLSPAN_LIVE_ANTHROPIC_API_KEY")
            .expect("SHELLSPAN_LIVE_ANTHROPIC_API_KEY is required");
        let adapter = AnthropicMessagesAdapter {
            http: HttpConfig {
                client: build_streaming_client().unwrap(),
                provider: anthropic_provider("https://api.anthropic.com".into()),
                api_key: Some(api_key),
                timeouts: ModelTimeoutPolicy::default(),
            },
        };
        let mut request = basic_request();
        request.system_prompt = "Reply with exactly OK.".into();
        let response = adapter
            .stream(request, CancellationToken::new(), Arc::new(Sink::default()))
            .await
            .unwrap();
        assert!(response.content.iter().any(
            |block| matches!(block, ModelContentBlock::Text { text } if !text.trim().is_empty())
        ));
    }
}
