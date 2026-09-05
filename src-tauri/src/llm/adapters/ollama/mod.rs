use super::common::*;
use crate::llm::{adapter::*, config::*, errors::*, transport::*, types::*, usage::*};
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Response;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(in crate::llm) struct OllamaReplayCodec;
pub(in crate::llm) static OLLAMA_REPLAY_CODEC: OllamaReplayCodec = OllamaReplayCodec;

impl ReplayCodec for OllamaReplayCodec {
    fn adapter_id(&self) -> &'static str {
        "ollama"
    }

    fn replay_format_version(&self) -> u32 {
        1
    }

    fn validate_response_metadata(&self, value: &Value) -> Result<(), NormalizedModelError> {
        let object = crate::llm::replay::object_with_allowed_keys(
            value,
            &["model", "createdAt", "doneReason"],
            "Ollama response metadata",
        )?;
        for key in ["model", "createdAt", "doneReason"] {
            crate::llm::replay::optional_bounded_string(object, key, "Ollama response")?;
        }
        Ok(())
    }

    fn validate_block_metadata(
        &self,
        kind: crate::llm::replay::ReplayBlockKind,
        value: &Value,
    ) -> Result<(), NormalizedModelError> {
        let allowed: &[&str] = match kind {
            crate::llm::replay::ReplayBlockKind::ToolCall => &["providerCallId"],
            _ => &[],
        };
        let object =
            crate::llm::replay::object_with_allowed_keys(value, allowed, "Ollama block metadata")?;
        crate::llm::replay::optional_bounded_string(object, "providerCallId", "Ollama tool block")?;
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
            if let ModelContentBlock::ToolCall { call } = content {
                call.provider_call_id = replay
                    .metadata
                    .get("providerCallId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
        }
        Ok(response.clone())
    }
}

pub(in crate::llm) struct OllamaAdapter {
    pub(in crate::llm) http: HttpConfig,
}

#[async_trait]
impl ModelAdapter for OllamaAdapter {
    fn replay_codec(&self) -> &'static dyn ReplayCodec {
        &OLLAMA_REPLAY_CODEC
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
        messages.extend(chat_messages(&request.messages, true, capabilities));
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
        if !request.tools.is_empty() {
            body["tools"] = Value::Array(
                request
                    .tools
                    .iter()
                    .map(|tool| {
                        json!({
                            "type": "function",
                            "function": {
                                "name": tool.name,
                                "description": tool.description,
                                "parameters": tool.input_schema,
                            }
                        })
                    })
                    .collect(),
            );
        }
        let endpoint = resolved.endpoint.clone();
        let response = send_request(
            self.http.client.post(endpoint).json(&body),
            &cancellation,
            self.http.timeouts,
        )
        .await?;
        let response = checked_stream_response(response, &cancellation, self.http.timeouts).await?;
        stream_ollama(response, &cancellation, sink, self.http.timeouts).await
    }
}

pub(in crate::llm) async fn stream_ollama(
    response: Response,
    cancellation: &CancellationToken,
    sink: Arc<dyn ModelStreamSink>,
    timeouts: ModelTimeoutPolicy,
) -> Result<ModelResponse, NormalizedModelError> {
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut response_bytes = 0;
    let mut accumulated = ChatAccumulator::default();
    let mut usage = ProviderUsage::default();
    let mut completed = false;
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
                while let Some(line) = take_line(&mut buffer)
                    .map_err(|error| coded_error(NormalizedModelErrorKind::Protocol, error, "OLLAMA_FRAMING"))?
                {
                    if !line.trim().is_empty() {
                        process_ollama_line(
                            &line,
                            &sink,
                            &mut accumulated,
                            &mut usage,
                            &mut completed,
                            &mut finish_reason,
                        )?;
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
    if !buffer.iter().all(u8::is_ascii_whitespace) {
        let line = String::from_utf8(buffer).map_err(|error| {
            NormalizedModelError::new(
                NormalizedModelErrorKind::Protocol,
                format!("invalid UTF-8 in final Ollama event: {error}"),
            )
        })?;
        process_ollama_line(
            &line,
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
                "Ollama stream ended before done=true",
                "STREAM_CLOSED",
            )
        } else {
            deadline.empty_response_error("Ollama stream")
        });
    }
    let replay_response = Value::Object(accumulated.replay_response.clone());
    let content = accumulated.finish(false, true)?;
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
                    ModelContentBlock::ToolCall { call } => call
                        .provider_call_id
                        .as_ref()
                        .map_or_else(|| json!({}), |id| json!({"providerCallId": id})),
                    _ => json!({}),
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
pub(in crate::llm) fn process_ollama_line(
    line: &str,
    sink: &Arc<dyn ModelStreamSink>,
    accumulated: &mut ChatAccumulator,
    usage: &mut ProviderUsage,
    completed: &mut bool,
    finish_reason: &mut ModelFinishReason,
) -> Result<(), NormalizedModelError> {
    let value: Value = serde_json::from_str(line.trim()).map_err(|error| {
        NormalizedModelError::new(
            NormalizedModelErrorKind::Protocol,
            format!("invalid Ollama stream event: {error}"),
        )
    })?;
    for (source, target) in [
        ("model", "model"),
        ("created_at", "createdAt"),
        ("done_reason", "doneReason"),
    ] {
        if let Some(value) = value.get(source).and_then(Value::as_str) {
            accumulated
                .replay_response
                .insert(target.to_string(), json!(value));
        }
    }
    if let Some(next) = provider_usage_from_value(AiProviderKind::Ollama, &value) {
        sink.emit(StreamDelta::Usage { usage: next.into() })?;
        usage.merge_latest(next);
    }
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(normalize_provider_error(400, error));
    }
    if value.get("done_reason").and_then(Value::as_str) == Some("length") {
        return Err(NormalizedModelError::new(
            NormalizedModelErrorKind::Terminal,
            "AI provider reached the configured output token limit",
        ));
    }
    if value.get("done").and_then(Value::as_bool) == Some(true) {
        *completed = true;
        *finish_reason = normalize_finish_reason(
            value
                .get("done_reason")
                .and_then(Value::as_str)
                .unwrap_or("stop"),
        );
    }
    if let Some(text) = value
        .pointer("/message/thinking")
        .or_else(|| value.pointer("/message/reasoning_content"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        accumulated.reasoning.push_str(text);
        let index = accumulated.index_for(ChatBlockKey::Reasoning);
        sink.emit(StreamDelta::Reasoning {
            index,
            text: text.to_string(),
        })?;
    }
    if let Some(text) = value
        .pointer("/message/content")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        accumulated.content.push_str(text);
        let index = accumulated.index_for(ChatBlockKey::Text);
        sink.emit(StreamDelta::Text {
            index,
            text: text.to_string(),
        })?;
    }
    if let Some(tool_calls) = value
        .pointer("/message/tool_calls")
        .and_then(Value::as_array)
    {
        for (index, call) in tool_calls.iter().enumerate() {
            let block_index = accumulated.index_for(ChatBlockKey::Tool(index));
            let accumulator = accumulated.calls.entry(index).or_default();
            let mut call_id = None;
            let mut name_delta = None;
            let mut arguments_delta = None;
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                let prior = accumulator.id.get_or_insert_with(String::new);
                let delta = append_and_delta(prior, id, true);
                if !delta.is_empty() {
                    call_id = Some(delta);
                }
            }
            if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                let delta = append_and_delta(&mut accumulator.name, name, true);
                if !delta.is_empty() {
                    name_delta = Some(delta);
                }
            }
            if let Some(arguments) = call.pointer("/function/arguments") {
                let arguments = match arguments {
                    Value::String(value) => value.clone(),
                    value => value.to_string(),
                };
                let delta = append_and_delta(&mut accumulator.arguments, &arguments, true);
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
