use super::common::*;
use crate::llm::{adapter::*, config::*, errors::*, transport::*, types::*, usage::*};
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Response;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(in crate::llm) struct ChatCompletionsReplayCodec;
pub(in crate::llm) static CHAT_COMPLETIONS_REPLAY_CODEC: ChatCompletionsReplayCodec =
    ChatCompletionsReplayCodec;

impl ReplayCodec for ChatCompletionsReplayCodec {
    fn adapter_id(&self) -> &'static str {
        "chat-completions"
    }

    fn replay_format_version(&self) -> u32 {
        1
    }

    fn validate_response_metadata(&self, value: &Value) -> Result<(), NormalizedModelError> {
        let object = crate::llm::replay::object_with_allowed_keys(
            value,
            &["id", "model", "systemFingerprint"],
            "chat-completions response metadata",
        )?;
        for key in ["id", "model", "systemFingerprint"] {
            crate::llm::replay::optional_bounded_string(object, key, "chat-completions response")?;
        }
        Ok(())
    }

    fn validate_block_metadata(
        &self,
        kind: crate::llm::replay::ReplayBlockKind,
        value: &Value,
    ) -> Result<(), NormalizedModelError> {
        use crate::llm::replay::ReplayBlockKind;
        let allowed: &[&str] = match kind {
            ReplayBlockKind::Text => &[],
            ReplayBlockKind::Reasoning => &["reasoningDetails"],
            ReplayBlockKind::ToolCall => &["providerCallId"],
        };
        let object = crate::llm::replay::object_with_allowed_keys(
            value,
            allowed,
            "chat-completions block metadata",
        )?;
        if let Some(details) = object.get("reasoningDetails") {
            let details = details.as_array().ok_or_else(|| {
                crate::llm::replay::replay_error(
                    "REPLAY_METADATA_INVALID",
                    "reasoningDetails must be an array",
                )
            })?;
            for detail in details {
                let detail = crate::llm::replay::object_with_allowed_keys(
                    detail,
                    &["type", "text", "signature", "index", "id", "format"],
                    "chat-completions reasoning detail",
                )?;
                for key in ["type", "text", "signature", "id", "format"] {
                    crate::llm::replay::optional_bounded_string(detail, key, "reasoning detail")?;
                }
                if detail
                    .get("index")
                    .is_some_and(|value| value.as_u64().is_none())
                {
                    return Err(crate::llm::replay::replay_error(
                        "REPLAY_METADATA_INVALID",
                        "reasoning detail index must be an unsigned integer",
                    ));
                }
            }
        }
        crate::llm::replay::optional_bounded_string(
            object,
            "providerCallId",
            "chat-completions tool block",
        )?;
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
        for (content, replay) in content.iter_mut().zip(blocks) {
            match content {
                ModelContentBlock::Reasoning { provider_item, .. } => {
                    if let Some(details) = replay.metadata.get("reasoningDetails") {
                        *provider_item = Some(json!({"reasoning_details": details}));
                    }
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
        Ok(response.clone())
    }
}

pub(in crate::llm) struct ChatCompletionsAdapter {
    pub(in crate::llm) http: HttpConfig,
}

#[async_trait]
impl ModelAdapter for ChatCompletionsAdapter {
    fn replay_codec(&self) -> &'static dyn ReplayCodec {
        &CHAT_COMPLETIONS_REPLAY_CODEC
    }

    async fn stream(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
        sink: Arc<dyn ModelStreamSink>,
    ) -> Result<ModelResponse, NormalizedModelError> {
        let resolved = self.http.validate(&request)?;
        let capabilities = resolved_capabilities(&resolved);
        let mut messages = vec![json!({
            "role": "system",
            "content": request.system_prompt,
        })];
        messages.extend(chat_messages(&request.messages, false, capabilities));
        let mut body = json!({
            "model": self.http.provider.model,
            "stream": true,
            "messages": messages,
        });
        crate::llm::catalog::apply_reasoning(
            &mut body,
            &resolved,
            self.http.provider.reasoning_effort.clone(),
        );
        apply_output_token_limit(
            &mut body,
            self.http.provider.kind,
            resolved.max_output_tokens,
        );
        if capabilities.supports_stream_usage {
            body["stream_options"] = json!({ "include_usage": true });
        }
        if capabilities.split_reasoning {
            body["reasoning_split"] = json!(true);
        }
        if !request.tools.is_empty() {
            body["tools"] = Value::Array(
                request
                    .tools
                    .iter()
                    .map(|tool| {
                        let mut encoded = json!({
                            "type": "function",
                            "function": {
                                "name": tool.name,
                                "description": tool.description,
                                "parameters": tool.input_schema,
                            }
                        });
                        if resolved.compat.strict_schema {
                            encoded["function"]["strict"] = json!(true);
                        }
                        encoded
                    })
                    .collect(),
            );
            body["tool_choice"] = json!("auto");
            if capabilities.parallel_tool_calls {
                body["parallel_tool_calls"] = json!(true);
            }
        }
        let endpoint = resolved.endpoint.clone();
        let mut request_builder = self.http.client.post(endpoint).json(&body);
        if let Some(api_key) = self.http.api_key.as_deref() {
            request_builder = request_builder.bearer_auth(api_key);
        }
        let response = send_request(request_builder, &cancellation, self.http.timeouts).await?;
        let response = checked_stream_response(response, &cancellation, self.http.timeouts).await?;
        stream_chat(
            response,
            &cancellation,
            sink,
            capabilities,
            self.http.timeouts,
        )
        .await
    }
}

pub(in crate::llm) async fn stream_chat(
    response: Response,
    cancellation: &CancellationToken,
    sink: Arc<dyn ModelStreamSink>,
    capabilities: ProviderCapabilities,
    timeouts: ModelTimeoutPolicy,
) -> Result<ModelResponse, NormalizedModelError> {
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut response_bytes = 0;
    let mut accumulated = ChatAccumulator::default();
    let mut usage = ProviderUsage::default();
    let mut completed = false;
    let mut stream_done = false;
    let mut finish_reason = ModelFinishReason::Other;
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
                    .map_err(|error| coded_error(NormalizedModelErrorKind::Protocol, error, "STREAM_LIMIT"))?;
                while let Some(event) = take_sse_event(&mut buffer)
                    .map_err(|error| coded_error(NormalizedModelErrorKind::Protocol, error, "SSE_FRAMING"))?
                {
                    let effective = !sse_data(&event).is_empty();
                    stream_done |= sse_data(&event) == "[DONE]";
                    process_chat_event(
                        &event,
                        capabilities,
                        &sink,
                        &mut accumulated,
                        &mut usage,
                        &mut completed,
                        &mut finish_reason,
                    )?;
                    if effective {
                        deadline.observe_frame();
                    }
                }
                ensure_provider_stream_frame_size(buffer.len())
                    .map_err(|error| coded_error(NormalizedModelErrorKind::Protocol, error, "STREAM_LIMIT"))?;
                // finish_reason completes the choice, not the transport: usage
                // may arrive in a later TCP chunk with choices=[]. Keep the
                // normal cancellation/idle bounds until [DONE] or clean EOF.
                if stream_done {
                    break;
                }
            }
        }
    }
    if let Some(event) = take_final_sse_event(&mut buffer)
        .map_err(|error| coded_error(NormalizedModelErrorKind::Protocol, error, "SSE_FRAMING"))?
    {
        process_chat_event(
            &event,
            capabilities,
            &sink,
            &mut accumulated,
            &mut usage,
            &mut completed,
            &mut finish_reason,
        )?;
    }
    if !completed {
        return Err(if deadline.first_byte_seen {
            coded_error(
                NormalizedModelErrorKind::Retryable,
                "OpenAI-compatible stream ended before a completion signal",
                "STREAM_CLOSED",
            )
        } else {
            deadline.empty_response_error("OpenAI-compatible stream")
        });
    }
    if finish_reason == ModelFinishReason::Length {
        return Err(NormalizedModelError::new(
            NormalizedModelErrorKind::Terminal,
            "AI provider reached the configured output token limit",
        ));
    }
    let replay_response = Value::Object(accumulated.replay_response.clone());
    let content = accumulated.finish(true, capabilities.think_tag_fallback)?;
    if content
        .iter()
        .any(|block| matches!(block, ModelContentBlock::ToolCall { .. }))
    {
        finish_reason = ModelFinishReason::ToolCalls;
    }
    ensure_nonempty_response(&content)?;
    Ok(ModelResponse {
        replay: Some(AdapterReplayCapture {
            response: replay_response,
            blocks: content
                .iter()
                .map(|block| match block {
                    ModelContentBlock::Text { .. } => json!({}),
                    ModelContentBlock::Reasoning { provider_item, .. } => provider_item
                        .as_ref()
                        .and_then(|item| item.get("reasoning_details"))
                        .map_or_else(|| json!({}), |details| json!({"reasoningDetails": details})),
                    ModelContentBlock::ToolCall { call } => call
                        .provider_call_id
                        .as_ref()
                        .map_or_else(|| json!({}), |id| json!({"providerCallId": id})),
                })
                .collect(),
        }),
        replay_envelope: None,
        content,
        finish_reason,
        usage: usage.into(),
    })
}

#[allow(clippy::too_many_arguments)]
pub(in crate::llm) fn process_chat_event(
    event: &str,
    capabilities: ProviderCapabilities,
    sink: &Arc<dyn ModelStreamSink>,
    accumulated: &mut ChatAccumulator,
    usage: &mut ProviderUsage,
    completed: &mut bool,
    finish_reason: &mut ModelFinishReason,
) -> Result<(), NormalizedModelError> {
    let data = sse_data(event);
    if data == "[DONE]" {
        *completed = true;
        return Ok(());
    }
    if data.is_empty() {
        return Ok(());
    }
    let value: Value = serde_json::from_str(&data).map_err(|error| {
        NormalizedModelError::new(
            NormalizedModelErrorKind::Protocol,
            format!("invalid OpenAI-compatible stream event: {error}"),
        )
    })?;
    for (source, target) in [
        ("id", "id"),
        ("model", "model"),
        ("system_fingerprint", "systemFingerprint"),
    ] {
        if let Some(value) = value.get(source).and_then(Value::as_str) {
            accumulated
                .replay_response
                .insert(target.to_string(), json!(value));
        }
    }
    if let Some(next) = provider_usage_from_value(AiProviderKind::OpenAiCompatible, &value) {
        sink.emit(StreamDelta::Usage { usage: next.into() })?;
        usage.merge_latest(next);
    }
    if let Some(message) = value
        .pointer("/error/message")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
    {
        return Err(normalize_provider_error(400, message));
    }
    if let Some(reason) = value
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
    {
        *completed = true;
        *finish_reason = normalize_finish_reason(reason);
    }
    if capabilities.split_reasoning {
        if let Some(details) = value
            .pointer("/choices/0/delta/reasoning_details")
            .and_then(Value::as_array)
        {
            if details.starts_with(&accumulated.reasoning_details) {
                accumulated.reasoning_details = details.clone();
            } else if !accumulated.reasoning_details.starts_with(details) {
                accumulated.reasoning_details.extend(details.clone());
            }
        }
    }
    let direct_reasoning = value
        .pointer("/choices/0/delta/reasoning_content")
        .or_else(|| value.pointer("/choices/0/delta/reasoning"))
        .and_then(Value::as_str);
    let reasoning_fragments = direct_reasoning.map_or_else(
        || {
            value
                .pointer("/choices/0/delta/reasoning_details")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|detail| detail.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
        },
        |reasoning| vec![reasoning],
    );
    for next in reasoning_fragments
        .into_iter()
        .filter(|_| capabilities.native_reasoning)
    {
        let delta = append_and_delta(
            &mut accumulated.reasoning,
            next,
            capabilities.cumulative_stream,
        );
        if !delta.is_empty() {
            let index = accumulated.index_for(ChatBlockKey::Reasoning);
            sink.emit(StreamDelta::Reasoning { index, text: delta })?;
        }
    }
    if let Some(next) = value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
    {
        let delta = append_and_delta(
            &mut accumulated.content,
            next,
            capabilities.cumulative_stream,
        );
        if !delta.is_empty() {
            let index = accumulated.index_for(ChatBlockKey::Text);
            sink.emit(StreamDelta::Text { index, text: delta })?;
        }
    }
    if let Some(tool_calls) = value
        .pointer("/choices/0/delta/tool_calls")
        .and_then(Value::as_array)
    {
        for (position, call) in tool_calls.iter().enumerate() {
            let index = call
                .get("index")
                .and_then(Value::as_u64)
                .map(|index| index as usize)
                .unwrap_or(position);
            let block_index = accumulated.index_for(ChatBlockKey::Tool(index));
            let accumulator = accumulated.calls.entry(index).or_default();
            let mut call_id = None;
            let mut name_delta = None;
            let mut arguments_delta = None;
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                let delta = match accumulator.id.as_deref() {
                    Some(previous)
                        if capabilities.cumulative_stream && id.starts_with(previous) =>
                    {
                        id.strip_prefix(previous).unwrap_or(id)
                    }
                    Some(previous)
                        if capabilities.cumulative_stream && previous.starts_with(id) =>
                    {
                        ""
                    }
                    _ => id,
                };
                if !delta.is_empty() {
                    call_id = Some(delta.to_string());
                }
                append_fragment(
                    accumulator.id.get_or_insert_with(String::new),
                    id,
                    capabilities.cumulative_stream,
                );
            }
            if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                let delta =
                    append_and_delta(&mut accumulator.name, name, capabilities.cumulative_stream);
                if !delta.is_empty() {
                    name_delta = Some(delta);
                }
            }
            if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str) {
                let delta = append_and_delta(
                    &mut accumulator.arguments,
                    arguments,
                    capabilities.cumulative_stream,
                );
                if !delta.is_empty() {
                    arguments_delta = Some(delta);
                }
            }
            if call_id.is_some() || name_delta.is_some() || arguments_delta.is_some() {
                sink.emit(StreamDelta::ToolCall {
                    index: block_index,
                    call_id,
                    name_delta,
                    arguments_delta,
                })?;
            }
        }
    }
    Ok(())
}
