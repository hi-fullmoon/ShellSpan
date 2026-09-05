#[cfg(test)]
use crate::llm::config::AiProviderConfig;
use crate::llm::{errors::*, transport::coded_error, types::*};
use serde_json::{json, Value};
use std::collections::BTreeMap;
pub(in crate::llm) const MAX_PROVIDER_TOOL_CALL_ID_BYTES: usize = 256;
pub(in crate::llm) const MAX_PROVIDER_TOOL_ARGUMENT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy)]
pub(in crate::llm) struct ProviderCapabilities {
    pub(in crate::llm) cumulative_stream: bool,
    pub(in crate::llm) supports_stream_usage: bool,
    pub(in crate::llm) native_reasoning: bool,
    pub(in crate::llm) split_reasoning: bool,
    pub(in crate::llm) replay_reasoning_content: bool,
    pub(in crate::llm) think_tag_fallback: bool,
    pub(in crate::llm) parallel_tool_calls: bool,
}

pub(in crate::llm) fn resolved_capabilities(
    model: &crate::llm::catalog::ResolvedModel,
) -> ProviderCapabilities {
    let caps = &model.compat;
    ProviderCapabilities {
        cumulative_stream: caps.cumulative_stream,
        supports_stream_usage: caps.supports_stream_usage,
        native_reasoning: caps.native_reasoning,
        split_reasoning: caps.split_reasoning,
        replay_reasoning_content: caps.replay_reasoning_content,
        think_tag_fallback: caps.think_tag_fallback,
        parallel_tool_calls: caps.parallel_tool_calls,
    }
}
#[cfg(test)]
pub(in crate::llm) fn provider_capabilities(provider: &AiProviderConfig) -> ProviderCapabilities {
    resolved_capabilities(&crate::llm::catalog::resolve(provider).expect("explicit fixture model"))
}

#[derive(Default)]
pub(in crate::llm) struct ToolCallAccumulator {
    pub(in crate::llm) id: Option<String>,
    pub(in crate::llm) name: String,
    pub(in crate::llm) arguments: String,
}

pub(in crate::llm) fn append_fragment(accumulated: &mut String, fragment: &str, cumulative: bool) {
    if !cumulative {
        accumulated.push_str(fragment);
    } else if fragment.starts_with(accumulated.as_str()) {
        *accumulated = fragment.to_string();
    } else if !accumulated.starts_with(fragment) {
        accumulated.push_str(fragment);
    }
}

pub(in crate::llm) fn append_and_delta(
    accumulated: &mut String,
    fragment: &str,
    cumulative: bool,
) -> String {
    if !cumulative {
        accumulated.push_str(fragment);
        return fragment.to_string();
    }
    if let Some(delta) = fragment.strip_prefix(accumulated.as_str()) {
        let delta = delta.to_string();
        *accumulated = fragment.to_string();
        return delta;
    }
    if accumulated.starts_with(fragment) {
        return String::new();
    }
    accumulated.push_str(fragment);
    fragment.to_string()
}

pub(in crate::llm) fn normalized_calls(
    calls: BTreeMap<usize, ToolCallAccumulator>,
    require_id: bool,
) -> Result<BTreeMap<usize, ModelToolCall>, NormalizedModelError> {
    calls
        .into_iter()
        .enumerate()
        .map(|(ordinal, (provider_index, call))| {
            if call.name.trim().is_empty() {
                return Err(NormalizedModelError::new(
                    NormalizedModelErrorKind::Protocol,
                    "provider tool call is missing a function name",
                ));
            }
            if require_id && call.id.as_deref().unwrap_or_default().is_empty() {
                return Err(NormalizedModelError::new(
                    NormalizedModelErrorKind::Protocol,
                    "provider tool call is missing an id",
                ));
            }
            if call
                .id
                .as_ref()
                .is_some_and(|id| id.len() > MAX_PROVIDER_TOOL_CALL_ID_BYTES)
            {
                return Err(NormalizedModelError::new(
                    NormalizedModelErrorKind::Protocol,
                    "provider tool call id exceeded the 256-byte limit",
                ));
            }
            if call.arguments.len() > MAX_PROVIDER_TOOL_ARGUMENT_BYTES {
                return Err(NormalizedModelError::new(
                    NormalizedModelErrorKind::Protocol,
                    "provider tool arguments exceeded the 64 KiB limit",
                ));
            }
            let arguments = serde_json::from_str::<Value>(&call.arguments).map_err(|error| {
                NormalizedModelError::new(
                    NormalizedModelErrorKind::Protocol,
                    format!("provider returned invalid tool arguments: {error}"),
                )
            })?;
            if !arguments.is_object() {
                return Err(NormalizedModelError::new(
                    NormalizedModelErrorKind::Protocol,
                    "provider tool arguments must be a JSON object",
                ));
            }
            Ok((
                provider_index,
                ModelToolCall {
                    call_id: format!("call-{}", ordinal + 1),
                    provider_call_id: call.id,
                    name: call.name,
                    arguments,
                },
            ))
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::llm) enum ChatBlockKey {
    Reasoning,
    Text,
    Tool(usize),
}

#[derive(Default)]
pub(in crate::llm) struct ChatAccumulator {
    pub(in crate::llm) order: Vec<ChatBlockKey>,
    pub(in crate::llm) reasoning: String,
    pub(in crate::llm) reasoning_details: Vec<Value>,
    pub(in crate::llm) content: String,
    pub(in crate::llm) calls: BTreeMap<usize, ToolCallAccumulator>,
    pub(in crate::llm) replay_response: serde_json::Map<String, Value>,
}

impl ChatAccumulator {
    pub(in crate::llm) fn index_for(&mut self, key: ChatBlockKey) -> u32 {
        if let Some(index) = self.order.iter().position(|candidate| *candidate == key) {
            return index as u32;
        }
        self.order.push(key);
        (self.order.len() - 1) as u32
    }

    pub(in crate::llm) fn finish(
        self,
        require_tool_id: bool,
        think_tag_fallback: bool,
    ) -> Result<Vec<ModelContentBlock>, NormalizedModelError> {
        let mut calls = normalized_calls(self.calls, require_tool_id)?;
        let mut blocks = Vec::with_capacity(self.order.len());
        for key in self.order {
            match key {
                ChatBlockKey::Reasoning if !self.reasoning.is_empty() => {
                    blocks.push(ModelContentBlock::Reasoning {
                        text: self.reasoning.clone(),
                        provider_item: (!self.reasoning_details.is_empty())
                            .then(|| json!({"reasoning_details": self.reasoning_details})),
                    });
                }
                ChatBlockKey::Text if !self.content.is_empty() => {
                    blocks.push(ModelContentBlock::Text {
                        text: self.content.clone(),
                    });
                }
                ChatBlockKey::Tool(index) => {
                    if let Some(call) = calls.remove(&index) {
                        blocks.push(ModelContentBlock::ToolCall { call });
                    }
                }
                _ => {}
            }
        }
        if think_tag_fallback
            && !blocks
                .iter()
                .any(|block| matches!(block, ModelContentBlock::Reasoning { .. }))
        {
            blocks = split_think_blocks(blocks);
        }
        Ok(blocks)
    }
}

pub(in crate::llm) fn split_think_blocks(blocks: Vec<ModelContentBlock>) -> Vec<ModelContentBlock> {
    let mut output = Vec::new();
    for block in blocks {
        let ModelContentBlock::Text { text } = block else {
            output.push(block);
            continue;
        };
        let mut rest = text.as_str();
        let mut found = false;
        while let Some(start) = rest.find("<think>") {
            found = true;
            let before = &rest[..start];
            if !before.is_empty() {
                output.push(ModelContentBlock::Text {
                    text: before.to_string(),
                });
            }
            let reasoning_start = &rest[start + "<think>".len()..];
            if let Some(end) = reasoning_start.find("</think>") {
                let reasoning = &reasoning_start[..end];
                if !reasoning.is_empty() {
                    output.push(ModelContentBlock::Reasoning {
                        text: reasoning.to_string(),
                        provider_item: None,
                    });
                }
                rest = &reasoning_start[end + "</think>".len()..];
            } else {
                if !reasoning_start.is_empty() {
                    output.push(ModelContentBlock::Reasoning {
                        text: reasoning_start.to_string(),
                        provider_item: None,
                    });
                }
                rest = "";
                break;
            }
        }
        if !rest.is_empty() {
            output.push(ModelContentBlock::Text {
                text: rest.to_string(),
            });
        } else if !found && text.is_empty() {
            output.push(ModelContentBlock::Text { text });
        }
    }
    output
}

pub(in crate::llm) fn ensure_nonempty_response(
    content: &[ModelContentBlock],
) -> Result<(), NormalizedModelError> {
    let has_output = content.iter().any(|block| match block {
        ModelContentBlock::Text { text } | ModelContentBlock::Reasoning { text, .. } => {
            !text.is_empty()
        }
        ModelContentBlock::ToolCall { .. } => true,
    });
    if has_output {
        Ok(())
    } else {
        Err(coded_error(
            NormalizedModelErrorKind::EmptyResponse,
            "AI provider completed without text, reasoning, or tool calls",
            "EMPTY_RESPONSE",
        ))
    }
}

pub(in crate::llm) fn normalize_finish_reason(reason: &str) -> ModelFinishReason {
    match reason {
        "stop" | "completed" => ModelFinishReason::Stop,
        "tool_calls" | "function_call" => ModelFinishReason::ToolCalls,
        "length" | "max_tokens" => ModelFinishReason::Length,
        "content_filter" => ModelFinishReason::ContentFilter,
        _ => ModelFinishReason::Other,
    }
}

pub(in crate::llm) fn chat_messages(
    messages: &[ModelMessage],
    ollama: bool,
    capabilities: ProviderCapabilities,
) -> Vec<Value> {
    messages
        .iter()
        .map(|message| match message {
            ModelMessage::UserImages {
                content, data_urls, ..
            } => {
                let mut blocks = Vec::new();
                // Image-only submissions are valid, but providers can reject empty text parts.
                if !content.trim().is_empty() {
                    blocks.push(json!({"type":"text", "text":content}));
                }
                blocks.extend(
                    data_urls
                        .iter()
                        .map(|url| json!({"type":"image_url", "image_url":{"url":url}})),
                );
                json!({"role":"user", "content":blocks})
            }
            ModelMessage::User { content } => json!({ "role": "user", "content": content }),
            ModelMessage::Assistant { content, .. } => {
                let text = content
                    .iter()
                    .filter_map(|block| match block {
                        ModelContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<String>();
                let reasoning = content
                    .iter()
                    .filter_map(|block| match block {
                        ModelContentBlock::Reasoning { text, .. } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<String>();
                let tool_calls = content
                    .iter()
                    .filter_map(|block| match block {
                        ModelContentBlock::ToolCall { call } => Some(call),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                let mut value = json!({
                    "role": "assistant",
                    "content": if text.is_empty() { Value::Null } else { Value::String(text) },
                });
                if capabilities.split_reasoning {
                    let details: Vec<Value> = content
                        .iter()
                        .filter_map(|block| match block {
                            ModelContentBlock::Reasoning {
                                provider_item: Some(item),
                                ..
                            } => item.get("reasoning_details").and_then(Value::as_array),
                            _ => None,
                        })
                        .flatten()
                        .cloned()
                        .collect();
                    if !details.is_empty() {
                        value["reasoning_details"] = json!(details);
                    }
                }
                if capabilities.replay_reasoning_content
                    && !reasoning.is_empty()
                    && value.get("reasoning_details").is_none()
                {
                    value["reasoning_content"] = Value::String(reasoning);
                }
                if !tool_calls.is_empty() {
                    value["tool_calls"] = Value::Array(
                        tool_calls
                            .iter()
                            .map(|call| {
                                let mut value = json!({
                                    "type": "function",
                                    "function": {
                                        "name": call.name,
                                        "arguments": if ollama {
                                            call.arguments.clone()
                                        } else {
                                            Value::String(call.arguments.to_string())
                                        },
                                    }
                                });
                                if !ollama {
                                    value["id"] = json!(call
                                        .provider_call_id
                                        .as_deref()
                                        .unwrap_or(&call.call_id));
                                }
                                value
                            })
                            .collect(),
                    );
                }
                value
            }
            ModelMessage::Tool {
                call_id,
                provider_call_id,
                name,
                content,
            } => {
                if ollama {
                    json!({ "role": "tool", "tool_name": name, "content": content })
                } else {
                    json!({
                        "role": "tool",
                        "tool_call_id": provider_call_id.as_deref().unwrap_or(call_id),
                        "content": content,
                    })
                }
            }
        })
        .collect()
}
