use super::common::*;
use crate::llm::{adapter::*, config::*, errors::*, transport::*, types::*, usage::*};
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Response;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(in crate::llm) struct ResponsesReplayCodec;
pub(in crate::llm) static RESPONSES_REPLAY_CODEC: ResponsesReplayCodec = ResponsesReplayCodec;

fn sanitized_reasoning_item(value: &Value) -> Value {
    let mut output = serde_json::Map::new();
    for key in [
        "type",
        "id",
        "status",
        "encrypted_content",
        "summary",
        "content",
    ] {
        if let Some(value) = value.get(key) {
            output.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(output)
}

impl ReplayCodec for ResponsesReplayCodec {
    fn adapter_id(&self) -> &'static str {
        "responses"
    }

    fn replay_format_version(&self) -> u32 {
        1
    }

    fn validate_response_metadata(&self, value: &Value) -> Result<(), NormalizedModelError> {
        let object = crate::llm::replay::object_with_allowed_keys(
            value,
            &["responseId", "model"],
            "Responses response metadata",
        )?;
        for key in ["responseId", "model"] {
            crate::llm::replay::optional_bounded_string(object, key, "Responses response")?;
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
            ReplayBlockKind::Text => &["providerItemId"],
            ReplayBlockKind::Reasoning => &["nativeItem"],
            ReplayBlockKind::ToolCall => &["providerCallId", "providerItemId"],
        };
        let object = crate::llm::replay::object_with_allowed_keys(
            value,
            allowed,
            "Responses block metadata",
        )?;
        for key in ["providerCallId", "providerItemId"] {
            crate::llm::replay::optional_bounded_string(object, key, "Responses block")?;
        }
        if let Some(item) = object.get("nativeItem") {
            let item = crate::llm::replay::object_with_allowed_keys(
                item,
                &[
                    "type",
                    "id",
                    "status",
                    "encrypted_content",
                    "summary",
                    "content",
                ],
                "Responses reasoning item",
            )?;
            if item.get("type").and_then(Value::as_str) != Some("reasoning") {
                return Err(crate::llm::replay::replay_error(
                    "REPLAY_METADATA_INVALID",
                    "Responses native reasoning item has the wrong type",
                ));
            }
            for key in ["id", "status", "encrypted_content"] {
                crate::llm::replay::optional_bounded_string(item, key, "Responses reasoning item")?;
            }
            for key in ["summary", "content"] {
                if let Some(parts) = item.get(key) {
                    let parts = parts.as_array().ok_or_else(|| {
                        crate::llm::replay::replay_error(
                            "REPLAY_METADATA_INVALID",
                            format!("Responses reasoning {key} must be an array"),
                        )
                    })?;
                    for part in parts {
                        let part = crate::llm::replay::object_with_allowed_keys(
                            part,
                            &["type", "text"],
                            "Responses reasoning text part",
                        )?;
                        for field in ["type", "text"] {
                            crate::llm::replay::optional_bounded_string(
                                part,
                                field,
                                "Responses reasoning text part",
                            )?;
                        }
                    }
                }
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
        for (content, replay) in content.iter_mut().zip(blocks) {
            match content {
                ModelContentBlock::Reasoning { provider_item, .. } => {
                    *provider_item = replay.metadata.get("nativeItem").cloned();
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

pub(in crate::llm) struct ResponsesAdapter {
    pub(in crate::llm) http: HttpConfig,
}

#[async_trait]
impl ModelAdapter for ResponsesAdapter {
    fn replay_codec(&self) -> &'static dyn ReplayCodec {
        &RESPONSES_REPLAY_CODEC
    }

    async fn stream(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
        sink: Arc<dyn ModelStreamSink>,
    ) -> Result<ModelResponse, NormalizedModelError> {
        let resolved = self.http.validate(&request)?;
        let (input, previous_response_id) = responses_input_with_replay(&request.messages);
        let mut body = json!({
            "model": self.http.provider.model,
            "stream": true,
            "store": false,
            "instructions": request.system_prompt,
            "input": input,
        });
        if let Some(previous_response_id) = previous_response_id {
            body["previous_response_id"] = json!(previous_response_id);
        }
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
        if !request.tools.is_empty() {
            body["tools"] = Value::Array(
                request
                    .tools
                    .iter()
                    .map(|tool| {
                        json!({
                            "type": "function",
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.input_schema,
                            "strict": resolved.compat.strict_schema,
                        })
                    })
                    .collect(),
            );
            body["tool_choice"] = json!("auto");
            body["parallel_tool_calls"] = json!(resolved.compat.parallel_tool_calls);
        }
        let endpoint = resolved.endpoint.clone();
        let api_key = self.http.api_key.as_deref().ok_or_else(|| {
            NormalizedModelError::new(
                NormalizedModelErrorKind::Authentication,
                "API key is required",
            )
        })?;
        let response = send_request(
            self.http
                .client
                .post(endpoint)
                .bearer_auth(api_key)
                .json(&body),
            &cancellation,
            self.http.timeouts,
        )
        .await?;
        let response = checked_stream_response(response, &cancellation, self.http.timeouts).await?;
        stream_responses(response, &cancellation, sink, self.http.timeouts).await
    }
}

pub(in crate::llm) fn responses_input(messages: &[ModelMessage]) -> Vec<Value> {
    let mut input = Vec::new();
    for message in messages {
        match message {
            ModelMessage::UserImages { .. } => {
                unreachable!("Responses vision is refused by the capability contract")
            }
            ModelMessage::User { content } => {
                input.push(json!({ "role": "user", "content": content }));
            }
            ModelMessage::Assistant { content, .. } => {
                for block in content {
                    match block {
                        ModelContentBlock::Text { text } if !text.is_empty() => {
                            input.push(json!({ "role": "assistant", "content": text }));
                        }
                        ModelContentBlock::Reasoning {
                            provider_item: Some(provider_item),
                            ..
                        } => input.push(provider_item.clone()),
                        ModelContentBlock::Reasoning { .. } => {}
                        ModelContentBlock::ToolCall { call } => input.push(json!({
                            "type": "function_call",
                            "call_id": call.provider_call_id.as_deref().unwrap_or(&call.call_id),
                            "name": call.name,
                            "arguments": call.arguments.to_string(),
                        })),
                        ModelContentBlock::Text { .. } => {}
                    }
                }
            }
            ModelMessage::Tool {
                call_id,
                provider_call_id,
                content,
                ..
            } => input.push(json!({
                "type": "function_call_output",
                "call_id": provider_call_id.as_deref().unwrap_or(call_id),
                "output": content,
            })),
        }
    }
    input
}

pub(in crate::llm) fn responses_input_with_replay(
    messages: &[ModelMessage],
) -> (Vec<Value>, Option<String>) {
    let previous = messages
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, message)| {
            let ModelMessage::Assistant {
                native_replay: Some(response),
                ..
            } = message
            else {
                return None;
            };
            response
                .get("responseId")
                .and_then(Value::as_str)
                .map(|id| (index, id.to_string()))
        });
    match previous {
        Some((index, response_id)) => (
            responses_input(&messages[index.saturating_add(1)..]),
            Some(response_id),
        ),
        None => (responses_input(messages), None),
    }
}
pub(in crate::llm) async fn stream_responses(
    response: Response,
    cancellation: &CancellationToken,
    sink: Arc<dyn ModelStreamSink>,
    timeouts: ModelTimeoutPolicy,
) -> Result<ModelResponse, NormalizedModelError> {
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut response_bytes = 0;
    let mut output = BTreeMap::<usize, Value>::new();
    let mut streamed_text = BTreeMap::<usize, String>::new();
    let mut streamed_reasoning = BTreeMap::<usize, String>::new();
    let mut streamed_calls = BTreeMap::<usize, ToolCallAccumulator>::new();
    let mut usage = ProviderUsage::default();
    let mut replay_response = json!({});
    let mut completed = false;
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
                    process_responses_event(
                        &event,
                        &sink,
                        &mut output,
                        &mut streamed_text,
                        &mut streamed_reasoning,
                        &mut streamed_calls,
                        &mut usage,
                        &mut completed,
                        &mut replay_response,
                    )?;
                    if effective {
                        deadline.observe_frame();
                    }
                }
                ensure_provider_stream_frame_size(buffer.len())
                    .map_err(|error| coded_error(NormalizedModelErrorKind::Protocol, error, "STREAM_LIMIT"))?;
                if completed {
                    break;
                }
            }
        }
    }
    if let Some(event) = take_final_sse_event(&mut buffer)
        .map_err(|error| coded_error(NormalizedModelErrorKind::Protocol, error, "SSE_FRAMING"))?
    {
        process_responses_event(
            &event,
            &sink,
            &mut output,
            &mut streamed_text,
            &mut streamed_reasoning,
            &mut streamed_calls,
            &mut usage,
            &mut completed,
            &mut replay_response,
        )?;
    }
    if !completed {
        return Err(if deadline.first_byte_seen {
            coded_error(
                NormalizedModelErrorKind::Retryable,
                "OpenAI stream ended before response.completed",
                "STREAM_CLOSED",
            )
        } else {
            deadline.empty_response_error("OpenAI stream")
        });
    }
    let replay_output = output.clone();
    let content = if output.is_empty() {
        fallback_responses_blocks(streamed_text, streamed_reasoning, streamed_calls)?
    } else {
        responses_output_blocks(output)?
    };
    let finish_reason = if content
        .iter()
        .any(|block| matches!(block, ModelContentBlock::ToolCall { .. }))
    {
        ModelFinishReason::ToolCalls
    } else {
        ModelFinishReason::Stop
    };
    ensure_nonempty_response(&content)?;
    Ok(ModelResponse {
        replay: Some(AdapterReplayCapture {
            response: replay_response,
            blocks: content
                .iter()
                .map(|block| match block {
                    ModelContentBlock::Reasoning {
                        provider_item: Some(item),
                        ..
                    } => json!({"nativeItem": sanitized_reasoning_item(item)}),
                    ModelContentBlock::ToolCall { call } => {
                        let item_id = replay_output
                            .values()
                            .find(|item| {
                                item.get("type").and_then(Value::as_str) == Some("function_call")
                                    && item.get("call_id").and_then(Value::as_str)
                                        == call.provider_call_id.as_deref()
                            })
                            .and_then(|item| item.get("id"))
                            .and_then(Value::as_str);
                        let mut metadata = json!({});
                        if let Some(id) = &call.provider_call_id {
                            metadata["providerCallId"] = json!(id);
                        }
                        if let Some(id) = item_id {
                            metadata["providerItemId"] = json!(id);
                        }
                        metadata
                    }
                    ModelContentBlock::Text { .. } | ModelContentBlock::Reasoning { .. } => {
                        json!({})
                    }
                })
                .collect(),
        }),
        replay_envelope: None,
        content,
        finish_reason,
        usage: usage.into(),
    })
}

pub(in crate::llm) fn response_function_call(
    index: usize,
    item: &Value,
) -> Result<ModelToolCall, NormalizedModelError> {
    let provider_call_id = item
        .get("call_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            NormalizedModelError::new(
                NormalizedModelErrorKind::Protocol,
                "OpenAI function call is missing call_id",
            )
        })?;
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            NormalizedModelError::new(
                NormalizedModelErrorKind::Protocol,
                "OpenAI function call is missing name",
            )
        })?;
    let arguments = item
        .get("arguments")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            NormalizedModelError::new(
                NormalizedModelErrorKind::Protocol,
                "OpenAI function call is missing arguments",
            )
        })?;
    if provider_call_id.len() > MAX_PROVIDER_TOOL_CALL_ID_BYTES {
        return Err(NormalizedModelError::new(
            NormalizedModelErrorKind::Protocol,
            "OpenAI function call id exceeded the 256-byte limit",
        ));
    }
    if arguments.len() > MAX_PROVIDER_TOOL_ARGUMENT_BYTES {
        return Err(NormalizedModelError::new(
            NormalizedModelErrorKind::Protocol,
            "OpenAI function arguments exceeded the 64 KiB limit",
        ));
    }
    let arguments = serde_json::from_str::<Value>(arguments).map_err(|error| {
        NormalizedModelError::new(
            NormalizedModelErrorKind::Protocol,
            format!("OpenAI returned invalid tool arguments: {error}"),
        )
    })?;
    if !arguments.is_object() {
        return Err(NormalizedModelError::new(
            NormalizedModelErrorKind::Protocol,
            "OpenAI function arguments must be a JSON object",
        ));
    }
    Ok(ModelToolCall {
        call_id: format!("call-{}", index + 1),
        provider_call_id: Some(provider_call_id.to_string()),
        name: name.to_string(),
        arguments,
    })
}

pub(in crate::llm) fn responses_output_blocks(
    output: BTreeMap<usize, Value>,
) -> Result<Vec<ModelContentBlock>, NormalizedModelError> {
    let mut blocks = Vec::new();
    for (index, item) in output {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                if let Some(parts) = item.get("content").and_then(Value::as_array) {
                    for part in parts {
                        if let Some(text) = part
                            .get("text")
                            .or_else(|| part.get("refusal"))
                            .and_then(Value::as_str)
                        {
                            blocks.push(ModelContentBlock::Text {
                                text: text.to_string(),
                            });
                        }
                    }
                }
            }
            Some("reasoning") => {
                let text = item
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .chain(
                        item.get("summary")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten(),
                    )
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<String>();
                blocks.push(ModelContentBlock::Reasoning {
                    text,
                    provider_item: Some(item),
                });
            }
            Some("function_call") => blocks.push(ModelContentBlock::ToolCall {
                call: response_function_call(index, &item)?,
            }),
            _ => {}
        }
    }
    Ok(blocks)
}

pub(in crate::llm) fn fallback_responses_blocks(
    mut text: BTreeMap<usize, String>,
    mut reasoning: BTreeMap<usize, String>,
    calls: BTreeMap<usize, ToolCallAccumulator>,
) -> Result<Vec<ModelContentBlock>, NormalizedModelError> {
    let mut normalized_calls = normalized_calls(calls, true)?;
    let mut indexes = text
        .keys()
        .chain(reasoning.keys())
        .chain(normalized_calls.keys())
        .copied()
        .collect::<Vec<_>>();
    indexes.sort_unstable();
    indexes.dedup();
    let mut blocks = Vec::new();
    for index in indexes {
        if let Some(value) = reasoning.remove(&index) {
            blocks.push(ModelContentBlock::Reasoning {
                text: value,
                provider_item: None,
            });
        }
        if let Some(value) = text.remove(&index) {
            blocks.push(ModelContentBlock::Text { text: value });
        }
        if let Some(call) = normalized_calls.remove(&index) {
            blocks.push(ModelContentBlock::ToolCall { call });
        }
    }
    Ok(blocks)
}

pub(in crate::llm) fn process_responses_event(
    event: &str,
    sink: &Arc<dyn ModelStreamSink>,
    output: &mut BTreeMap<usize, Value>,
    streamed_text: &mut BTreeMap<usize, String>,
    streamed_reasoning: &mut BTreeMap<usize, String>,
    streamed_calls: &mut BTreeMap<usize, ToolCallAccumulator>,
    usage: &mut ProviderUsage,
    completed: &mut bool,
    replay_response: &mut Value,
) -> Result<(), NormalizedModelError> {
    let data = sse_data(event);
    if data.is_empty() || data == "[DONE]" {
        return Ok(());
    }
    let value: Value = serde_json::from_str(&data).map_err(|error| {
        NormalizedModelError::new(
            NormalizedModelErrorKind::Protocol,
            format!("invalid OpenAI stream event: {error}"),
        )
    })?;
    if let Some(next) = provider_usage_from_value(AiProviderKind::OpenAi, &value) {
        sink.emit(StreamDelta::Usage { usage: next.into() })?;
        usage.merge_latest(next);
    }
    match value.get("type").and_then(Value::as_str) {
        Some("response.output_text.delta") | Some("response.refusal.delta") => {
            if let Some(text) = value.get("delta").and_then(Value::as_str) {
                let index = value
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or_default() as usize;
                streamed_text.entry(index).or_default().push_str(text);
                sink.emit(StreamDelta::Text {
                    index: index as u32,
                    text: text.to_string(),
                })?;
            }
        }
        Some("response.reasoning_text.delta") | Some("response.reasoning_summary_text.delta") => {
            if let Some(text) = value.get("delta").and_then(Value::as_str) {
                let index = value
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or_default() as usize;
                streamed_reasoning.entry(index).or_default().push_str(text);
                sink.emit(StreamDelta::Reasoning {
                    index: index as u32,
                    text: text.to_string(),
                })?;
            }
        }
        Some("response.function_call_arguments.delta") => {
            let index = value
                .get("output_index")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize;
            if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                streamed_calls
                    .entry(index)
                    .or_default()
                    .arguments
                    .push_str(delta);
                sink.emit(StreamDelta::ToolCall {
                    index: index as u32,
                    call_id: None,
                    name_delta: None,
                    arguments_delta: Some(delta.to_string()),
                })?;
            }
        }
        Some("response.output_item.added") | Some("response.output_item.done") => {
            if let (Some(index), Some(item)) = (
                value.get("output_index").and_then(Value::as_u64),
                value.get("item"),
            ) {
                output.insert(index as usize, item.clone());
                if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    let accumulator = streamed_calls.entry(index as usize).or_default();
                    let call_id = item.get("call_id").and_then(Value::as_str);
                    let name = item.get("name").and_then(Value::as_str);
                    let arguments = item.get("arguments").and_then(Value::as_str);
                    let call_id_delta = call_id.and_then(|value| {
                        let accumulated = accumulator.id.get_or_insert_with(String::new);
                        let delta = append_and_delta(accumulated, value, true);
                        (!delta.is_empty()).then_some(delta)
                    });
                    let name_delta = name.and_then(|value| {
                        let delta = append_and_delta(&mut accumulator.name, value, true);
                        (!delta.is_empty()).then_some(delta)
                    });
                    if let Some(call_id) = call_id {
                        if accumulator.id.as_deref().unwrap_or_default().is_empty() {
                            accumulator.id = Some(call_id.to_string());
                        }
                    }
                    if let Some(arguments) = arguments {
                        accumulator.arguments = arguments.to_string();
                    }
                    if call_id_delta.is_some() || name_delta.is_some() {
                        sink.emit(StreamDelta::ToolCall {
                            index: index as u32,
                            call_id: call_id_delta,
                            name_delta,
                            arguments_delta: None,
                        })?;
                    }
                }
            }
        }
        Some("response.completed") => {
            *completed = true;
            if let Some(response) = value.get("response") {
                if let Some(id) = response.get("id").and_then(Value::as_str) {
                    replay_response["responseId"] = json!(id);
                }
                if let Some(model) = response.get("model").and_then(Value::as_str) {
                    replay_response["model"] = json!(model);
                }
            }
            if let Some(items) = value.pointer("/response/output").and_then(Value::as_array) {
                output.clear();
                output.extend(items.iter().cloned().enumerate());
            }
        }
        Some("response.incomplete") => {
            return Err(NormalizedModelError::new(
                NormalizedModelErrorKind::Terminal,
                "AI provider reached the configured output token limit",
            ));
        }
        Some("response.failed") | Some("error") => {
            let message = value
                .pointer("/response/error/message")
                .or_else(|| value.pointer("/error/message"))
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("OpenAI request failed");
            return Err(normalize_provider_error(400, message));
        }
        _ => {}
    }
    Ok(())
}
