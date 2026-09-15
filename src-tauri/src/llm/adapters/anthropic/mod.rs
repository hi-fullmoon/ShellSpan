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
        } = envelope;
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
    include!("tests.rs");
}
