use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::ai::{
    append_provider_stream_chunk, apply_output_token_limit, apply_reasoning_effort, build_client,
    endpoint_url, ensure_provider_stream_frame_size, format_transport_error,
    provider_usage_from_value, read_bounded_response_body, sse_data, take_final_sse_event,
    take_line, take_sse_event, AiProviderConfig, AiProviderKind, ProviderUsage,
    AGENT_MAX_OUTPUT_TOKENS, MAX_ERROR_BODY_BYTES,
};
use crate::redaction::redact_sensitive_text;

use super::{
    AgentAssistantContentBlock, AgentRequestToolSchema, AgentSurfaceMessage, AgentSurfaceSnapshot,
    RecordedToolCall,
};

const MAX_PROVIDER_TOOL_CALL_ID_BYTES: usize = 256;
const MAX_PROVIDER_TOOL_ARGUMENT_BYTES: usize = 64 * 1024;

pub(crate) type ModelToolDefinition = AgentRequestToolSchema;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ModelContentBlock {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_item: Option<Value>,
    },
    ToolCall {
        call: ModelToolCall,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "role",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ModelMessage {
    User {
        content: String,
    },
    Assistant {
        content: Vec<ModelContentBlock>,
    },
    Tool {
        call_id: String,
        provider_call_id: Option<String>,
        name: String,
        content: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelRequest {
    pub(crate) request_id: String,
    pub(crate) surface_generation: u64,
    pub(crate) system_prompt: String,
    pub(crate) messages: Vec<ModelMessage>,
    pub(crate) tools: Vec<AgentRequestToolSchema>,
}

impl ModelRequest {
    pub(crate) fn from_surface(
        request_id: String,
        surface: &AgentSurfaceSnapshot,
        system_prompt: String,
        tools: Vec<AgentRequestToolSchema>,
    ) -> Self {
        let mut provider_ids = std::collections::HashMap::new();
        let mut messages = Vec::with_capacity(surface.messages.len());
        for message in &surface.messages {
            match message {
                AgentSurfaceMessage::User { content, .. } => {
                    messages.push(ModelMessage::User {
                        content: content.clone(),
                    });
                }
                AgentSurfaceMessage::Assistant { content, .. } => {
                    let content = content
                        .iter()
                        .map(|block| match block {
                            AgentAssistantContentBlock::Text { text } => {
                                ModelContentBlock::Text { text: text.clone() }
                            }
                            AgentAssistantContentBlock::Reasoning {
                                text,
                                provider_item,
                            } => ModelContentBlock::Reasoning {
                                text: text.clone(),
                                provider_item: provider_item.clone(),
                            },
                            AgentAssistantContentBlock::ToolCall { call } => {
                                if let Some(provider_call_id) = &call.provider_call_id {
                                    provider_ids
                                        .insert(call.call_id.clone(), provider_call_id.clone());
                                }
                                ModelContentBlock::ToolCall {
                                    call: ModelToolCall {
                                        call_id: call.call_id.clone(),
                                        provider_call_id: call.provider_call_id.clone(),
                                        name: call.name.clone(),
                                        arguments: call.arguments.clone(),
                                    },
                                }
                            }
                        })
                        .collect();
                    messages.push(ModelMessage::Assistant { content });
                }
                AgentSurfaceMessage::Tool {
                    call_id,
                    name,
                    content,
                    ..
                } => messages.push(ModelMessage::Tool {
                    call_id: call_id.clone(),
                    provider_call_id: provider_ids.get(call_id).cloned(),
                    name: name.clone(),
                    content: content.clone(),
                }),
            }
        }
        Self {
            request_id,
            surface_generation: surface.generation,
            system_prompt,
            messages,
            tools,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelToolCall {
    pub(crate) call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) provider_call_id: Option<String>,
    pub(crate) name: String,
    pub(crate) arguments: Value,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ModelFinishReason {
    Stop,
    ToolCalls,
    Length,
    ContentFilter,
    Other,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) uncached_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cache_write_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reasoning_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) total_tokens: Option<u64>,
}

impl From<ProviderUsage> for ModelUsage {
    fn from(value: ProviderUsage) -> Self {
        Self {
            uncached_input_tokens: value.uncached_input_tokens,
            cache_read_tokens: value.cache_read_tokens,
            cache_write_tokens: value.cache_write_tokens,
            output_tokens: value.output_tokens,
            reasoning_tokens: value.reasoning_tokens,
            total_tokens: value.total_tokens,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelResponse {
    pub(crate) content: Vec<ModelContentBlock>,
    pub(crate) finish_reason: ModelFinishReason,
    pub(crate) usage: ModelUsage,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum StreamDelta {
    Text {
        index: u32,
        text: String,
    },
    Reasoning {
        index: u32,
        text: String,
    },
    ToolCall {
        index: u32,
        call_id: Option<String>,
        name_delta: Option<String>,
        arguments_delta: Option<String>,
    },
    Usage {
        usage: ModelUsage,
    },
}

pub(crate) trait ModelStreamSink: Send + Sync {
    fn emit(&self, delta: StreamDelta) -> Result<(), NormalizedModelError>;
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NormalizedModelErrorKind {
    Cancelled,
    Retryable,
    ContextTooLarge,
    Authentication,
    RateLimited,
    Terminal,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NormalizedModelError {
    pub(crate) kind: NormalizedModelErrorKind,
    pub(crate) message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) retry_after_ms: Option<u64>,
}

impl NormalizedModelError {
    pub(crate) fn new(kind: NormalizedModelErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: redact_sensitive_text(&message.into()),
            status: None,
            code: None,
            retry_after_ms: None,
        }
    }

    pub(crate) fn cancelled() -> Self {
        Self::new(Self::cancelled_kind(), "model request cancelled")
    }

    const fn cancelled_kind() -> NormalizedModelErrorKind {
        NormalizedModelErrorKind::Cancelled
    }

    pub(crate) fn retryable(&self) -> bool {
        matches!(
            self.kind,
            NormalizedModelErrorKind::Retryable | NormalizedModelErrorKind::RateLimited
        )
    }
}

#[async_trait]
pub(crate) trait ModelAdapter: Send + Sync {
    async fn stream(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
        sink: Arc<dyn ModelStreamSink>,
    ) -> Result<ModelResponse, NormalizedModelError>;
}

pub(crate) trait ModelAdapterFactory: Send + Sync {
    fn create(
        &self,
        provider: AiProviderConfig,
        api_key: Option<String>,
    ) -> Result<Arc<dyn ModelAdapter>, String>;
}

#[derive(Default)]
struct HttpModelAdapterFactory;

impl ModelAdapterFactory for HttpModelAdapterFactory {
    fn create(
        &self,
        provider: AiProviderConfig,
        api_key: Option<String>,
    ) -> Result<Arc<dyn ModelAdapter>, String> {
        Ok(Arc::new(HttpModelAdapter {
            client: build_client()?,
            provider,
            api_key,
        }))
    }
}

#[derive(Clone)]
pub(crate) struct ModelRegistry {
    factory: Arc<dyn ModelAdapterFactory>,
}

impl Default for ModelRegistry {
    fn default() -> Self {
        Self {
            factory: Arc::new(HttpModelAdapterFactory),
        }
    }
}

impl ModelRegistry {
    #[cfg(test)]
    pub(crate) fn with_factory(factory: Arc<dyn ModelAdapterFactory>) -> Self {
        Self { factory }
    }

    pub(crate) fn resolve(
        &self,
        provider: AiProviderConfig,
        api_key: Option<String>,
    ) -> Result<Arc<dyn ModelAdapter>, String> {
        self.factory.create(provider, api_key)
    }
}

struct HttpModelAdapter {
    client: Client,
    provider: AiProviderConfig,
    api_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderProfile {
    OpenAiResponses,
    DeepSeek,
    MiniMax,
    OpenAiCompatible,
    Ollama,
}

#[derive(Debug, Clone, Copy)]
struct ProviderCapabilities {
    cumulative_stream: bool,
    supports_stream_usage: bool,
    native_reasoning: bool,
    split_reasoning: bool,
    replay_reasoning_content: bool,
    think_tag_fallback: bool,
    parallel_tool_calls: bool,
}

fn provider_capabilities(provider: &AiProviderConfig) -> ProviderCapabilities {
    let model = provider.model.trim().to_ascii_lowercase();
    let base_url = provider.base_url.trim().to_ascii_lowercase();
    let profile = match provider.kind {
        AiProviderKind::OpenAi => ProviderProfile::OpenAiResponses,
        AiProviderKind::Ollama => ProviderProfile::Ollama,
        AiProviderKind::OpenAiCompatible
            if base_url.contains("api.deepseek.com") || model.starts_with("deepseek-") =>
        {
            ProviderProfile::DeepSeek
        }
        AiProviderKind::OpenAiCompatible
            if base_url.contains("api.minimax.io")
                || base_url.contains("api.minimaxi.com")
                || model.starts_with("minimax-")
                || model.contains("abab") =>
        {
            ProviderProfile::MiniMax
        }
        AiProviderKind::OpenAiCompatible => ProviderProfile::OpenAiCompatible,
    };
    ProviderCapabilities {
        cumulative_stream: profile == ProviderProfile::MiniMax,
        supports_stream_usage: matches!(
            profile,
            ProviderProfile::DeepSeek | ProviderProfile::MiniMax
        ),
        native_reasoning: !matches!(profile, ProviderProfile::OpenAiCompatible),
        split_reasoning: profile == ProviderProfile::MiniMax,
        replay_reasoning_content: matches!(
            profile,
            ProviderProfile::DeepSeek | ProviderProfile::MiniMax
        ),
        think_tag_fallback: matches!(
            profile,
            ProviderProfile::MiniMax | ProviderProfile::OpenAiCompatible | ProviderProfile::Ollama
        ),
        parallel_tool_calls: !crate::ai::is_kimi_code_provider(provider),
    }
}

#[async_trait]
impl ModelAdapter for HttpModelAdapter {
    async fn stream(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
        sink: Arc<dyn ModelStreamSink>,
    ) -> Result<ModelResponse, NormalizedModelError> {
        match self.provider.kind {
            AiProviderKind::OpenAi => {
                self.stream_openai_responses(request, cancellation, sink)
                    .await
            }
            AiProviderKind::OpenAiCompatible => {
                self.stream_chat_completions(request, cancellation, sink)
                    .await
            }
            AiProviderKind::Ollama => self.stream_ollama(request, cancellation, sink).await,
        }
    }
}

impl HttpModelAdapter {
    async fn stream_openai_responses(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
        sink: Arc<dyn ModelStreamSink>,
    ) -> Result<ModelResponse, NormalizedModelError> {
        let mut body = json!({
            "model": self.provider.model,
            "stream": true,
            "store": false,
            "instructions": request.system_prompt,
            "input": responses_input(&request.messages),
        });
        apply_reasoning_effort(&mut body, &self.provider);
        apply_output_token_limit(&mut body, self.provider.kind, AGENT_MAX_OUTPUT_TOKENS);
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
                            "strict": true,
                        })
                    })
                    .collect(),
            );
            body["tool_choice"] = json!("auto");
            body["parallel_tool_calls"] = json!(true);
        }
        let endpoint = endpoint_url(&self.provider, "responses").map_err(|error| {
            NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error)
        })?;
        let api_key = self.api_key.as_deref().ok_or_else(|| {
            NormalizedModelError::new(
                NormalizedModelErrorKind::Authentication,
                "API key is required",
            )
        })?;
        let response = send_request(
            self.client.post(endpoint).bearer_auth(api_key).json(&body),
            &cancellation,
        )
        .await?;
        let response = checked_stream_response(response, &cancellation).await?;
        stream_responses(response, &cancellation, sink).await
    }

    async fn stream_chat_completions(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
        sink: Arc<dyn ModelStreamSink>,
    ) -> Result<ModelResponse, NormalizedModelError> {
        let capabilities = provider_capabilities(&self.provider);
        let mut messages = vec![json!({
            "role": "system",
            "content": request.system_prompt,
        })];
        messages.extend(chat_messages(&request.messages, false, capabilities));
        let mut body = json!({
            "model": self.provider.model,
            "stream": true,
            "messages": messages,
        });
        apply_reasoning_effort(&mut body, &self.provider);
        apply_output_token_limit(&mut body, self.provider.kind, AGENT_MAX_OUTPUT_TOKENS);
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
            body["tool_choice"] = json!("auto");
            if capabilities.parallel_tool_calls {
                body["parallel_tool_calls"] = json!(true);
            }
        }
        let endpoint = endpoint_url(&self.provider, "chat/completions").map_err(|error| {
            NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error)
        })?;
        let mut request_builder = self.client.post(endpoint).json(&body);
        if let Some(api_key) = self.api_key.as_deref() {
            request_builder = request_builder.bearer_auth(api_key);
        }
        let response = send_request(request_builder, &cancellation).await?;
        let response = checked_stream_response(response, &cancellation).await?;
        stream_chat(response, &cancellation, sink, capabilities).await
    }

    async fn stream_ollama(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
        sink: Arc<dyn ModelStreamSink>,
    ) -> Result<ModelResponse, NormalizedModelError> {
        let capabilities = provider_capabilities(&self.provider);
        let mut messages = vec![json!({
            "role": "system",
            "content": request.system_prompt,
        })];
        messages.extend(chat_messages(&request.messages, true, capabilities));
        let mut body = json!({
            "model": self.provider.model,
            "stream": true,
            "messages": messages,
        });
        apply_reasoning_effort(&mut body, &self.provider);
        apply_output_token_limit(&mut body, self.provider.kind, AGENT_MAX_OUTPUT_TOKENS);
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
        let endpoint = endpoint_url(&self.provider, "api/chat").map_err(|error| {
            NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error)
        })?;
        let response = send_request(self.client.post(endpoint).json(&body), &cancellation).await?;
        let response = checked_stream_response(response, &cancellation).await?;
        stream_ollama(response, &cancellation, sink).await
    }
}

fn responses_input(messages: &[ModelMessage]) -> Vec<Value> {
    let mut input = Vec::new();
    for message in messages {
        match message {
            ModelMessage::User { content } => {
                input.push(json!({ "role": "user", "content": content }));
            }
            ModelMessage::Assistant { content } => {
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

fn chat_messages(
    messages: &[ModelMessage],
    ollama: bool,
    capabilities: ProviderCapabilities,
) -> Vec<Value> {
    messages
        .iter()
        .map(|message| match message {
            ModelMessage::User { content } => json!({ "role": "user", "content": content }),
            ModelMessage::Assistant { content } => {
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
                if capabilities.replay_reasoning_content && !reasoning.is_empty() {
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

async fn send_request(
    request: reqwest::RequestBuilder,
    cancellation: &CancellationToken,
) -> Result<Response, NormalizedModelError> {
    tokio::select! {
        _ = cancellation.cancelled() => Err(NormalizedModelError::cancelled()),
        result = request.send() => result.map_err(normalize_transport_error),
    }
}

fn normalize_transport_error(error: reqwest::Error) -> NormalizedModelError {
    let retryable = error.is_timeout() || error.is_connect();
    NormalizedModelError::new(
        if retryable {
            NormalizedModelErrorKind::Retryable
        } else {
            NormalizedModelErrorKind::Terminal
        },
        format_transport_error(error),
    )
}

async fn checked_stream_response(
    response: Response,
    cancellation: &CancellationToken,
) -> Result<Response, NormalizedModelError> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let retry_after_ms = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|seconds| seconds.checked_mul(1_000));
    let body = read_bounded_response_body(
        response,
        Some(cancellation),
        MAX_ERROR_BODY_BYTES,
        "AI provider HTTP error body exceeded the response limit",
    )
    .await
    .map_err(|error| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error))?
    .ok_or_else(NormalizedModelError::cancelled)?;
    let text = String::from_utf8_lossy(&body).into_owned();
    let mut error = normalize_provider_error(status.as_u16(), &text);
    error.retry_after_ms = retry_after_ms;
    Err(error)
}

fn normalize_provider_error(status: u16, message: &str) -> NormalizedModelError {
    let normalized = message.to_ascii_lowercase();
    let context_too_large = [
        "context length",
        "context window",
        "maximum context",
        "too many tokens",
        "prompt is too long",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase));
    let kind = if matches!(status, 401 | 403) {
        NormalizedModelErrorKind::Authentication
    } else if status == 429 {
        NormalizedModelErrorKind::RateLimited
    } else if context_too_large {
        NormalizedModelErrorKind::ContextTooLarge
    } else if matches!(status, 408 | 409 | 425 | 500..=599) {
        NormalizedModelErrorKind::Retryable
    } else {
        NormalizedModelErrorKind::Terminal
    };
    let display = if message.trim().is_empty() {
        format!("AI provider returned HTTP {status}")
    } else {
        format!("AI provider returned HTTP {status}: {message}")
    };
    let mut error = NormalizedModelError::new(kind, display);
    error.status = Some(status);
    error
}

#[derive(Default)]
struct ToolCallAccumulator {
    id: Option<String>,
    name: String,
    arguments: String,
}

fn append_fragment(accumulated: &mut String, fragment: &str, cumulative: bool) {
    if !cumulative {
        accumulated.push_str(fragment);
    } else if fragment.starts_with(accumulated.as_str()) {
        *accumulated = fragment.to_string();
    } else if !accumulated.starts_with(fragment) {
        accumulated.push_str(fragment);
    }
}

fn append_and_delta(accumulated: &mut String, fragment: &str, cumulative: bool) -> String {
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

fn normalized_calls(
    calls: BTreeMap<usize, ToolCallAccumulator>,
    require_id: bool,
) -> Result<BTreeMap<usize, ModelToolCall>, NormalizedModelError> {
    calls
        .into_iter()
        .enumerate()
        .map(|(ordinal, (provider_index, call))| {
            if call.name.trim().is_empty() {
                return Err(NormalizedModelError::new(
                    NormalizedModelErrorKind::Terminal,
                    "provider tool call is missing a function name",
                ));
            }
            if require_id && call.id.as_deref().unwrap_or_default().is_empty() {
                return Err(NormalizedModelError::new(
                    NormalizedModelErrorKind::Terminal,
                    "provider tool call is missing an id",
                ));
            }
            if call
                .id
                .as_ref()
                .is_some_and(|id| id.len() > MAX_PROVIDER_TOOL_CALL_ID_BYTES)
            {
                return Err(NormalizedModelError::new(
                    NormalizedModelErrorKind::Terminal,
                    "provider tool call id exceeded the 256-byte limit",
                ));
            }
            if call.arguments.len() > MAX_PROVIDER_TOOL_ARGUMENT_BYTES {
                return Err(NormalizedModelError::new(
                    NormalizedModelErrorKind::Terminal,
                    "provider tool arguments exceeded the 64 KiB limit",
                ));
            }
            let arguments = serde_json::from_str::<Value>(&call.arguments).map_err(|error| {
                NormalizedModelError::new(
                    NormalizedModelErrorKind::Terminal,
                    format!("provider returned invalid tool arguments: {error}"),
                )
            })?;
            if !arguments.is_object() {
                return Err(NormalizedModelError::new(
                    NormalizedModelErrorKind::Terminal,
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
enum ChatBlockKey {
    Reasoning,
    Text,
    Tool(usize),
}

#[derive(Default)]
struct ChatAccumulator {
    order: Vec<ChatBlockKey>,
    reasoning: String,
    content: String,
    calls: BTreeMap<usize, ToolCallAccumulator>,
}

impl ChatAccumulator {
    fn index_for(&mut self, key: ChatBlockKey) -> u32 {
        if let Some(index) = self.order.iter().position(|candidate| *candidate == key) {
            return index as u32;
        }
        self.order.push(key);
        (self.order.len() - 1) as u32
    }

    fn finish(
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
                        provider_item: None,
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

fn split_think_blocks(blocks: Vec<ModelContentBlock>) -> Vec<ModelContentBlock> {
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

async fn stream_chat(
    response: Response,
    cancellation: &CancellationToken,
    sink: Arc<dyn ModelStreamSink>,
    capabilities: ProviderCapabilities,
) -> Result<ModelResponse, NormalizedModelError> {
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut response_bytes = 0;
    let mut accumulated = ChatAccumulator::default();
    let mut usage = ProviderUsage::default();
    let mut completed = false;
    let mut finish_reason = ModelFinishReason::Other;
    loop {
        tokio::select! {
            _ = cancellation.cancelled() => return Err(NormalizedModelError::cancelled()),
            next = stream.next() => {
                let Some(chunk) = next else { break };
                let chunk = chunk.map_err(normalize_transport_error)?;
                append_provider_stream_chunk(&mut buffer, &chunk, &mut response_bytes)
                    .map_err(|error| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error))?;
                while let Some(event) = take_sse_event(&mut buffer)
                    .map_err(|error| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error))?
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
                ensure_provider_stream_frame_size(buffer.len())
                    .map_err(|error| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error))?;
            }
        }
    }
    if let Some(event) = take_final_sse_event(&mut buffer)
        .map_err(|error| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error))?
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
        return Err(NormalizedModelError::new(
            NormalizedModelErrorKind::Retryable,
            "OpenAI-compatible stream ended before a completion signal",
        ));
    }
    if finish_reason == ModelFinishReason::Length {
        return Err(NormalizedModelError::new(
            NormalizedModelErrorKind::Terminal,
            "AI provider reached the configured output token limit",
        ));
    }
    let content = accumulated.finish(true, capabilities.think_tag_fallback)?;
    if content
        .iter()
        .any(|block| matches!(block, ModelContentBlock::ToolCall { .. }))
    {
        finish_reason = ModelFinishReason::ToolCalls;
    }
    Ok(ModelResponse {
        content,
        finish_reason,
        usage: usage.into(),
    })
}

#[allow(clippy::too_many_arguments)]
fn process_chat_event(
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
            NormalizedModelErrorKind::Terminal,
            format!("invalid OpenAI-compatible stream event: {error}"),
        )
    })?;
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

async fn stream_responses(
    response: Response,
    cancellation: &CancellationToken,
    sink: Arc<dyn ModelStreamSink>,
) -> Result<ModelResponse, NormalizedModelError> {
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut response_bytes = 0;
    let mut output = BTreeMap::<usize, Value>::new();
    let mut streamed_text = BTreeMap::<usize, String>::new();
    let mut streamed_reasoning = BTreeMap::<usize, String>::new();
    let mut streamed_calls = BTreeMap::<usize, ToolCallAccumulator>::new();
    let mut usage = ProviderUsage::default();
    let mut completed = false;
    loop {
        tokio::select! {
            _ = cancellation.cancelled() => return Err(NormalizedModelError::cancelled()),
            next = stream.next() => {
                let Some(chunk) = next else { break };
                let chunk = chunk.map_err(normalize_transport_error)?;
                append_provider_stream_chunk(&mut buffer, &chunk, &mut response_bytes)
                    .map_err(|error| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error))?;
                while let Some(event) = take_sse_event(&mut buffer)
                    .map_err(|error| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error))?
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
                    )?;
                }
                ensure_provider_stream_frame_size(buffer.len())
                    .map_err(|error| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error))?;
            }
        }
    }
    if let Some(event) = take_final_sse_event(&mut buffer)
        .map_err(|error| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error))?
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
        )?;
    }
    if !completed {
        return Err(NormalizedModelError::new(
            NormalizedModelErrorKind::Retryable,
            "OpenAI stream ended before response.completed",
        ));
    }
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
    Ok(ModelResponse {
        content,
        finish_reason,
        usage: usage.into(),
    })
}

fn response_function_call(
    index: usize,
    item: &Value,
) -> Result<ModelToolCall, NormalizedModelError> {
    let provider_call_id = item
        .get("call_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            NormalizedModelError::new(
                NormalizedModelErrorKind::Terminal,
                "OpenAI function call is missing call_id",
            )
        })?;
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            NormalizedModelError::new(
                NormalizedModelErrorKind::Terminal,
                "OpenAI function call is missing name",
            )
        })?;
    let arguments = item
        .get("arguments")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            NormalizedModelError::new(
                NormalizedModelErrorKind::Terminal,
                "OpenAI function call is missing arguments",
            )
        })?;
    if provider_call_id.len() > MAX_PROVIDER_TOOL_CALL_ID_BYTES {
        return Err(NormalizedModelError::new(
            NormalizedModelErrorKind::Terminal,
            "OpenAI function call id exceeded the 256-byte limit",
        ));
    }
    if arguments.len() > MAX_PROVIDER_TOOL_ARGUMENT_BYTES {
        return Err(NormalizedModelError::new(
            NormalizedModelErrorKind::Terminal,
            "OpenAI function arguments exceeded the 64 KiB limit",
        ));
    }
    let arguments = serde_json::from_str::<Value>(arguments).map_err(|error| {
        NormalizedModelError::new(
            NormalizedModelErrorKind::Terminal,
            format!("OpenAI returned invalid tool arguments: {error}"),
        )
    })?;
    if !arguments.is_object() {
        return Err(NormalizedModelError::new(
            NormalizedModelErrorKind::Terminal,
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

fn responses_output_blocks(
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

fn fallback_responses_blocks(
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

fn process_responses_event(
    event: &str,
    sink: &Arc<dyn ModelStreamSink>,
    output: &mut BTreeMap<usize, Value>,
    streamed_text: &mut BTreeMap<usize, String>,
    streamed_reasoning: &mut BTreeMap<usize, String>,
    streamed_calls: &mut BTreeMap<usize, ToolCallAccumulator>,
    usage: &mut ProviderUsage,
    completed: &mut bool,
) -> Result<(), NormalizedModelError> {
    let data = sse_data(event);
    if data.is_empty() || data == "[DONE]" {
        return Ok(());
    }
    let value: Value = serde_json::from_str(&data).map_err(|error| {
        NormalizedModelError::new(
            NormalizedModelErrorKind::Terminal,
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

async fn stream_ollama(
    response: Response,
    cancellation: &CancellationToken,
    sink: Arc<dyn ModelStreamSink>,
) -> Result<ModelResponse, NormalizedModelError> {
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut response_bytes = 0;
    let mut accumulated = ChatAccumulator::default();
    let mut usage = ProviderUsage::default();
    let mut completed = false;
    let mut finish_reason = ModelFinishReason::Other;
    loop {
        tokio::select! {
            _ = cancellation.cancelled() => return Err(NormalizedModelError::cancelled()),
            next = stream.next() => {
                let Some(chunk) = next else { break };
                let chunk = chunk.map_err(normalize_transport_error)?;
                append_provider_stream_chunk(&mut buffer, &chunk, &mut response_bytes)
                    .map_err(|error| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error))?;
                while let Some(line) = take_line(&mut buffer)
                    .map_err(|error| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error))?
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
                    }
                }
                ensure_provider_stream_frame_size(buffer.len())
                    .map_err(|error| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error))?;
            }
        }
    }
    if !buffer.iter().all(u8::is_ascii_whitespace) {
        let line = String::from_utf8(buffer).map_err(|error| {
            NormalizedModelError::new(
                NormalizedModelErrorKind::Terminal,
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
        return Err(NormalizedModelError::new(
            NormalizedModelErrorKind::Retryable,
            "Ollama stream ended before done=true",
        ));
    }
    let content = accumulated.finish(false, true)?;
    if content
        .iter()
        .any(|block| matches!(block, ModelContentBlock::ToolCall { .. }))
    {
        finish_reason = ModelFinishReason::ToolCalls;
    }
    Ok(ModelResponse {
        content,
        finish_reason,
        usage: usage.into(),
    })
}

#[allow(clippy::too_many_arguments)]
fn process_ollama_line(
    line: &str,
    sink: &Arc<dyn ModelStreamSink>,
    accumulated: &mut ChatAccumulator,
    usage: &mut ProviderUsage,
    completed: &mut bool,
    finish_reason: &mut ModelFinishReason,
) -> Result<(), NormalizedModelError> {
    let value: Value = serde_json::from_str(line.trim()).map_err(|error| {
        NormalizedModelError::new(
            NormalizedModelErrorKind::Terminal,
            format!("invalid Ollama stream event: {error}"),
        )
    })?;
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

fn normalize_finish_reason(reason: &str) -> ModelFinishReason {
    match reason {
        "stop" | "completed" => ModelFinishReason::Stop,
        "tool_calls" | "function_call" => ModelFinishReason::ToolCalls,
        "length" | "max_tokens" => ModelFinishReason::Length,
        "content_filter" => ModelFinishReason::ContentFilter,
        _ => ModelFinishReason::Other,
    }
}

pub(crate) fn default_model_tools() -> Vec<ModelToolDefinition> {
    vec![
        ModelToolDefinition {
            name: "run_terminal_command".into(),
            description: "Request one command in the frozen ShellSpan terminal session. ShellSpan decides approval and execution.".into(),
            input_schema: object_schema(
                &["command", "explanation"],
                json!({
                    "command": bounded_string(8192),
                    "explanation": bounded_string(2048)
                }),
            ),
        },
        ModelToolDefinition {
            name: "read_file".into(),
            description: "Read a bounded file from the frozen target through ShellSpan's native filesystem runtime.".into(),
            input_schema: object_schema(
                &["path", "encoding"],
                json!({
                    "path": bounded_string(4096),
                    "encoding": { "type": "string", "enum": ["utf8", "base64", "metadataOnly"] },
                    "offset": { "type": "integer", "minimum": 0 },
                    "maxBytes": { "type": "integer", "minimum": 1, "maximum": 1048576 },
                    "expectedSha256": { "type": "string", "pattern": "^[0-9a-fA-F]{64}$" }
                }),
            ),
        },
        ModelToolDefinition {
            name: "list_directory".into(),
            description: "List one bounded page of a directory on the frozen target. Adjacent safe calls may run in parallel.".into(),
            input_schema: object_schema(
                &["path"],
                json!({
                    "path": bounded_string(4096),
                    "cursor": bounded_string(1024),
                    "pageSize": { "type": "integer", "minimum": 1, "maximum": 1000 },
                    "includeHidden": { "type": "boolean" }
                }),
            ),
        },
        ModelToolDefinition {
            name: "search_text".into(),
            description: "Search file names or file contents on the frozen target with bounded results.".into(),
            input_schema: object_schema(
                &["path", "query", "mode"],
                json!({
                    "path": bounded_string(4096),
                    "query": bounded_string(4096),
                    "mode": { "type": "string", "enum": ["content", "fileName", "both"] },
                    "caseSensitive": { "type": "boolean" },
                    "globs": { "type": "array", "maxItems": 64, "items": bounded_string(512) },
                    "maxResults": { "type": "integer", "minimum": 1, "maximum": 1000 },
                    "cursor": bounded_string(1024)
                }),
            ),
        },
        ModelToolDefinition {
            name: "apply_patch".into(),
            description: "Apply an exact digest-bound patch on the frozen target through ShellSpan's native runtime.".into(),
            input_schema: object_schema(
                &["patch", "preconditions"],
                json!({
                    "patch": bounded_string(1048576),
                    "preconditions": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 128,
                        "items": object_schema(
                            &["path", "sha256"],
                            json!({
                                "path": bounded_string(4096),
                                "sha256": { "type": "string", "pattern": "^[0-9a-fA-F]{64}$" }
                            }),
                        )
                    },
                    "dryRun": { "type": "boolean" }
                }),
            ),
        },
        ModelToolDefinition {
            name: "transfer_file".into(),
            description: "Upload or download one digest-bounded file through ShellSpan's native transfer runtime.".into(),
            input_schema: object_schema(
                &["direction", "sourcePath", "destinationPath", "overwrite"],
                json!({
                    "direction": { "type": "string", "enum": ["upload", "download"] },
                    "sourcePath": bounded_string(4096),
                    "destinationPath": bounded_string(4096),
                    "overwrite": { "type": "boolean" },
                    "expectedSha256": { "type": "string", "pattern": "^[0-9a-fA-F]{64}$" },
                    "destinationSha256": { "type": "string", "pattern": "^[0-9a-fA-F]{64}$" },
                    "maxBytes": { "type": "integer", "minimum": 1 }
                }),
            ),
        },
        ModelToolDefinition {
            name: "call_mcp_tool".into(),
            description: "Call one enabled MCP tool discovered from the frozen workspace configuration. ShellSpan validates the server, tool policy, arguments, credentials, target, and native approval before execution.".into(),
            input_schema: object_schema(
                &["serverId", "toolName", "arguments"],
                json!({
                    "serverId": bounded_string(128),
                    "toolName": bounded_string(256),
                    "arguments": { "type": "object" }
                }),
            ),
        },
        ModelToolDefinition {
            name: "update_plan".into(),
            description: "Replace the primary Session task plan with the next monotonic version. This records a Session event and never enters the native execution kernel.".into(),
            input_schema: object_schema(
                &["planVersion", "steps"],
                json!({
                    "planVersion": { "type": "integer", "minimum": 1 },
                    "explanation": bounded_string(4096),
                    "steps": {
                        "type": "array",
                        "maxItems": 100,
                        "items": object_schema(
                            &["id", "title", "status"],
                            json!({
                                "id": bounded_string(128),
                                "title": bounded_string(256),
                                "status": { "type": "string", "enum": ["pending", "inProgress", "completed", "blocked", "failed"] },
                                "detail": bounded_string(131072),
                                "evidenceRefs": { "type": "array", "maxItems": 128, "uniqueItems": true, "items": bounded_string(128) }
                            }),
                        )
                    }
                }),
            ),
        },
        ModelToolDefinition {
            name: "spawn_one_shot_agent".into(),
            description: "Create a least-privilege child Agent in a durable child Session, wait for exactly one Turn, and return its settlement.".into(),
            input_schema: subagent_spawn_schema(),
        },
        ModelToolDefinition {
            name: "spawn_continuable_agent".into(),
            description: "Create a least-privilege continuable child Agent in a durable child Session and return its first settlement.".into(),
            input_schema: subagent_spawn_schema(),
        },
        ModelToolDefinition {
            name: "send_child_input".into(),
            description: "Send a new bounded input to a continuable child Session, cold-resuming the same Session when needed.".into(),
            input_schema: object_schema(
                &["childSessionId", "content"],
                json!({
                    "childSessionId": bounded_string(128),
                    "content": bounded_string(131072)
                }),
            ),
        },
        ModelToolDefinition {
            name: "inspect_child_agent".into(),
            description: "Inspect the durable status, budget usage, and last settlement of a child Agent without waking it.".into(),
            input_schema: object_schema(
                &["childSessionId"],
                json!({ "childSessionId": bounded_string(128) }),
            ),
        },
        ModelToolDefinition {
            name: "cancel_child_agent".into(),
            description: "Cancel a child Agent and its descendants, deepest child first.".into(),
            input_schema: object_schema(
                &["childSessionId"],
                json!({ "childSessionId": bounded_string(128) }),
            ),
        },
        ModelToolDefinition {
            name: "fleet_plan".into(),
            description: "Create a durable multi-target Fleet plan with canary, wave, and failure-threshold policy.".into(),
            input_schema: object_schema(
                &["targets", "canarySize", "waveSize", "failureThreshold"],
                json!({
                    "targets": {
                        "type": "array", "minItems": 1, "maxItems": 128,
                        "items": object_schema(&["targetId", "goal"], json!({
                            "targetId": bounded_string(128),
                            "goal": bounded_string(131072)
                        }))
                    },
                    "canarySize": { "type": "integer", "minimum": 1, "maximum": 128 },
                    "waveSize": { "type": "integer", "minimum": 1, "maximum": 128 },
                    "failureThreshold": { "type": "integer", "minimum": 0, "maximum": 128 }
                }),
            ),
        },
        ModelToolDefinition {
            name: "fleet_start".into(),
            description: "Start a planned Fleet using real per-target Explorer, Operator, and independent Verifier child Agents.".into(),
            input_schema: fleet_id_schema(),
        },
        ModelToolDefinition {
            name: "fleet_pause".into(),
            description: "Pause admission of new Fleet targets at a durable wave boundary.".into(),
            input_schema: fleet_id_schema(),
        },
        ModelToolDefinition {
            name: "fleet_resume".into(),
            description: "Resume a paused Fleet from its durable checkpoint.".into(),
            input_schema: fleet_id_schema(),
        },
        ModelToolDefinition {
            name: "fleet_abort".into(),
            description: "Abort a Fleet and cancel every active target child tree.".into(),
            input_schema: fleet_id_schema(),
        },
        ModelToolDefinition {
            name: "fleet_reconcile".into(),
            description: "Record explicit reconciliation evidence for one uncertain Fleet target.".into(),
            input_schema: object_schema(
                &["fleetId", "targetId", "evidence"],
                json!({
                    "fleetId": bounded_string(128),
                    "targetId": bounded_string(128),
                    "evidence": bounded_string(131072)
                }),
            ),
        },
    ]
}

fn subagent_spawn_schema() -> Value {
    object_schema(
        &["goal", "role", "inheritanceMode", "targetIds"],
        json!({
            "goal": bounded_string(131072),
            "role": { "type": "string", "enum": ["general", "explorer", "diagnostician", "operator", "verifier", "reviewer"] },
            "inheritanceMode": { "type": "string", "enum": ["blank", "safePrefix"] },
            "targetIds": { "type": "array", "minItems": 1, "maxItems": 128, "uniqueItems": true, "items": bounded_string(128) },
            "budget": object_schema(&["maxStepsPerTurn", "maxTurns", "maxToolCalls", "maxTokens", "timeoutMs"], json!({
                "maxStepsPerTurn": { "type": "integer", "minimum": 1, "maximum": 64 },
                "maxTurns": { "type": "integer", "minimum": 1, "maximum": 256 },
                "maxToolCalls": { "type": "integer", "minimum": 1, "maximum": 4096 },
                "maxTokens": { "type": "integer", "minimum": 1024, "maximum": 16000000 },
                "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 86400000 }
            }))
        }),
    )
}

fn fleet_id_schema() -> Value {
    object_schema(&["fleetId"], json!({ "fleetId": bounded_string(128) }))
}

fn bounded_string(max_length: usize) -> Value {
    json!({ "type": "string", "minLength": 1, "maxLength": max_length })
}

fn object_schema(required: &[&str], properties: Value) -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": required,
        "properties": properties
    })
}

pub(crate) fn recorded_tool_call(call: ModelToolCall) -> RecordedToolCall {
    RecordedToolCall {
        call_id: call.call_id,
        provider_call_id: call.provider_call_id,
        name: call.name,
        native_name: None,
        arguments: call.arguments,
        title: None,
        effect: None,
        target: None,
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::thread;

    use super::*;

    struct RecordingSink(Mutex<String>, Mutex<Vec<ModelUsage>>, Mutex<String>);

    impl Default for RecordingSink {
        fn default() -> Self {
            Self(
                Mutex::new(String::new()),
                Mutex::new(Vec::new()),
                Mutex::new(String::new()),
            )
        }
    }

    impl ModelStreamSink for RecordingSink {
        fn emit(&self, delta: StreamDelta) -> Result<(), NormalizedModelError> {
            match delta {
                StreamDelta::Text { text, .. } => self.0.lock().unwrap().push_str(&text),
                StreamDelta::Reasoning { text, .. } => self.2.lock().unwrap().push_str(&text),
                StreamDelta::ToolCall { .. } => {}
                StreamDelta::Usage { usage } => self.1.lock().unwrap().push(usage),
            }
            Ok(())
        }
    }

    #[test]
    fn model_exposes_only_strict_runtime_pipeline_tools() {
        let tools = default_model_tools();
        assert_eq!(
            tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            [
                "run_terminal_command",
                "read_file",
                "list_directory",
                "search_text",
                "apply_patch",
                "transfer_file",
                "call_mcp_tool",
                "update_plan",
                "spawn_one_shot_agent",
                "spawn_continuable_agent",
                "send_child_input",
                "inspect_child_agent",
                "cancel_child_agent",
                "fleet_plan",
                "fleet_start",
                "fleet_pause",
                "fleet_resume",
                "fleet_abort",
                "fleet_reconcile",
            ]
        );
        assert!(tools.iter().all(|tool| {
            tool.input_schema["type"] == "object"
                && tool.input_schema["additionalProperties"] == false
                && tool.input_schema["required"].is_array()
        }));
    }

    #[test]
    fn minimax_cumulative_fragments_and_multiple_calls_remain_ordered_and_replayable() {
        let mut name = String::new();
        let mut arguments = String::new();
        append_fragment(&mut name, "run_terminal", true);
        append_fragment(&mut name, "run_terminal_command", true);
        append_fragment(&mut arguments, "{\"command\":\"pwd\"", true);
        append_fragment(
            &mut arguments,
            "{\"command\":\"pwd\",\"explanation\":\"inspect\"}",
            true,
        );
        assert_eq!(name, "run_terminal_command");
        let mut accumulated = ChatAccumulator {
            order: vec![ChatBlockKey::Tool(0), ChatBlockKey::Tool(1)],
            ..ChatAccumulator::default()
        };
        accumulated.calls.insert(
            0,
            ToolCallAccumulator {
                id: Some("report".into()),
                name: "report_task_outcome".into(),
                arguments: json!({ "summary": "premature" }).to_string(),
            },
        );
        accumulated.calls.insert(
            1,
            ToolCallAccumulator {
                id: Some("terminal".into()),
                name,
                arguments,
            },
        );
        let selected = accumulated.finish(true, false).unwrap();
        assert_eq!(selected.len(), 2);
        assert!(matches!(
            &selected[0],
            ModelContentBlock::ToolCall { call }
                if call.provider_call_id.as_deref() == Some("report")
        ));
        assert!(matches!(
            &selected[1],
            ModelContentBlock::ToolCall { call }
                if call.provider_call_id.as_deref() == Some("terminal")
        ));
    }

    #[test]
    fn cumulative_chat_content_is_merged_into_exactly_one_delta_stream() {
        let recording = Arc::new(RecordingSink::default());
        let sink: Arc<dyn ModelStreamSink> = recording.clone();
        let mut accumulated = ChatAccumulator::default();
        let mut usage = ProviderUsage::default();
        let mut completed = false;
        let mut reason = ModelFinishReason::Other;
        for data in [
            json!({ "choices": [{ "delta": { "content": "Hello" }, "finish_reason": null }] }),
            json!({
                "choices": [{ "delta": { "content": "Hello world" }, "finish_reason": "stop" }],
                "usage": { "prompt_tokens": 0, "completion_tokens": 3, "total_tokens": 3 },
            }),
        ] {
            process_chat_event(
                &format!("data: {data}"),
                ProviderCapabilities {
                    cumulative_stream: true,
                    supports_stream_usage: true,
                    native_reasoning: true,
                    split_reasoning: false,
                    replay_reasoning_content: true,
                    think_tag_fallback: false,
                    parallel_tool_calls: true,
                },
                &sink,
                &mut accumulated,
                &mut usage,
                &mut completed,
                &mut reason,
            )
            .unwrap();
        }
        assert_eq!(accumulated.content, "Hello world");
        assert_eq!(*recording.0.lock().unwrap(), "Hello world");
        assert_eq!(
            *recording.1.lock().unwrap(),
            vec![ModelUsage {
                uncached_input_tokens: Some(0),
                output_tokens: Some(3),
                total_tokens: Some(3),
                ..ModelUsage::default()
            }]
        );
        assert_eq!(usage.uncached_input_tokens, Some(0));
        assert!(completed);
        assert_eq!(reason, ModelFinishReason::Stop);
    }

    #[test]
    fn deepseek_reasoning_text_tools_and_usage_keep_provider_order_and_detail() {
        let recording = Arc::new(RecordingSink::default());
        let sink: Arc<dyn ModelStreamSink> = recording.clone();
        let provider = AiProviderConfig {
            id: "deepseek".into(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-reasoner".into(),
            reasoning_effort: None,
            requires_api_key: true,
            api_key: None,
        };
        let capabilities = provider_capabilities(&provider);
        let mut accumulated = ChatAccumulator::default();
        let mut usage = ProviderUsage::default();
        let mut completed = false;
        let mut reason = ModelFinishReason::Other;
        for data in [
            json!({
                "choices": [{ "delta": { "reasoning_content": "inspect first" }, "finish_reason": null }]
            }),
            json!({
                "choices": [{
                    "delta": {
                        "content": "I will inspect.",
                        "tool_calls": [
                            { "index": 0, "id": "provider-a", "function": { "name": "read_file", "arguments": "{\"path\":\"a\"}" } },
                            { "index": 1, "id": "provider-b", "function": { "name": "read_file", "arguments": "{\"path\":\"b\"}" } }
                        ]
                    },
                    "finish_reason": "tool_calls"
                }],
                "usage": {
                    "prompt_tokens": 10,
                    "prompt_cache_hit_tokens": 7,
                    "prompt_cache_miss_tokens": 3,
                    "completion_tokens": 5,
                    "completion_tokens_details": { "reasoning_tokens": 2 },
                    "total_tokens": 15
                }
            }),
        ] {
            process_chat_event(
                &format!("data: {data}"),
                capabilities,
                &sink,
                &mut accumulated,
                &mut usage,
                &mut completed,
                &mut reason,
            )
            .unwrap();
        }
        let blocks = accumulated.finish(true, false).unwrap();
        assert!(
            matches!(&blocks[0], ModelContentBlock::Reasoning { text, .. } if text == "inspect first")
        );
        assert!(
            matches!(&blocks[1], ModelContentBlock::Text { text } if text == "I will inspect.")
        );
        assert!(
            matches!(&blocks[2], ModelContentBlock::ToolCall { call } if call.provider_call_id.as_deref() == Some("provider-a"))
        );
        assert!(
            matches!(&blocks[3], ModelContentBlock::ToolCall { call } if call.provider_call_id.as_deref() == Some("provider-b"))
        );
        assert_eq!(usage.uncached_input_tokens, Some(3));
        assert_eq!(usage.cache_read_tokens, Some(7));
        assert_eq!(usage.reasoning_tokens, Some(2));
        assert_eq!(*recording.2.lock().unwrap(), "inspect first");
        assert!(completed);
        assert_eq!(reason, ModelFinishReason::ToolCalls);
    }

    #[test]
    fn minimax_cumulative_reasoning_text_and_tool_fragments_are_deduplicated() {
        let recording = Arc::new(RecordingSink::default());
        let sink: Arc<dyn ModelStreamSink> = recording.clone();
        let provider = AiProviderConfig {
            id: "minimax".into(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "https://api.minimaxi.com".into(),
            model: "MiniMax-M2.7".into(),
            reasoning_effort: None,
            requires_api_key: true,
            api_key: None,
        };
        let capabilities = provider_capabilities(&provider);
        let mut accumulated = ChatAccumulator::default();
        let mut usage = ProviderUsage::default();
        let mut completed = false;
        let mut reason = ModelFinishReason::Other;
        for data in [
            json!({ "choices": [{ "delta": { "reasoning_details": [{ "text": "plan" }] }, "finish_reason": null }] }),
            json!({ "choices": [{ "delta": { "reasoning_content": "plan safely", "content": "Ready" }, "finish_reason": null }] }),
            json!({ "choices": [{ "delta": {
                "reasoning_content": "plan safely",
                "content": "Ready now",
                "tool_calls": [{ "index": 0, "id": "provider", "function": { "name": "read", "arguments": "{\"path\":" } }]
            }, "finish_reason": null }] }),
            json!({ "choices": [{ "delta": {
                "reasoning_content": "plan safely",
                "content": "Ready now",
                "tool_calls": [{ "index": 0, "id": "provider", "function": { "name": "read_file", "arguments": "{\"path\":\"a\"}" } }]
            }, "finish_reason": "tool_calls" }] }),
        ] {
            process_chat_event(
                &format!("data: {data}"),
                capabilities,
                &sink,
                &mut accumulated,
                &mut usage,
                &mut completed,
                &mut reason,
            )
            .unwrap();
        }
        let blocks = accumulated.finish(true, false).unwrap();
        assert!(
            matches!(&blocks[0], ModelContentBlock::Reasoning { text, .. } if text == "plan safely")
        );
        assert!(matches!(&blocks[1], ModelContentBlock::Text { text } if text == "Ready now"));
        assert!(
            matches!(&blocks[2], ModelContentBlock::ToolCall { call } if call.name == "read_file" && call.arguments == json!({"path": "a"}))
        );
        assert_eq!(*recording.2.lock().unwrap(), "plan safely");
        assert_eq!(*recording.0.lock().unwrap(), "Ready now");
    }

    #[test]
    fn think_tag_fallback_becomes_structured_reasoning_without_ui_parsing() {
        let mut accumulated = ChatAccumulator::default();
        accumulated.order.push(ChatBlockKey::Text);
        accumulated.content = "<think>check constraints</think>Final answer".into();
        assert_eq!(
            accumulated.finish(false, true).unwrap(),
            vec![
                ModelContentBlock::Reasoning {
                    text: "check constraints".into(),
                    provider_item: None,
                },
                ModelContentBlock::Text {
                    text: "Final answer".into(),
                },
            ]
        );
    }

    #[test]
    fn openai_reasoning_items_replay_exactly_and_keep_output_order() {
        let reasoning = json!({
            "type": "reasoning",
            "id": "rs_1",
            "summary": [{ "type": "summary_text", "text": "checked constraints" }],
            "encrypted_content": "opaque-provider-state"
        });
        let content = vec![ModelContentBlock::Reasoning {
            text: "checked constraints".into(),
            provider_item: Some(reasoning.clone()),
        }];
        assert_eq!(
            responses_input(&[ModelMessage::Assistant { content }]),
            vec![reasoning.clone()]
        );
        let blocks = responses_output_blocks(BTreeMap::from([
            (0, reasoning.clone()),
            (1, json!({ "type": "message", "content": [{ "type": "output_text", "text": "done" }] })),
            (2, json!({ "type": "function_call", "call_id": "provider-call", "name": "read_file", "arguments": "{\"path\":\"a\"}" })),
        ]))
        .unwrap();
        assert!(
            matches!(&blocks[0], ModelContentBlock::Reasoning { provider_item: Some(item), .. } if item == &reasoning)
        );
        assert!(matches!(&blocks[1], ModelContentBlock::Text { text } if text == "done"));
        assert!(
            matches!(&blocks[2], ModelContentBlock::ToolCall { call } if call.provider_call_id.as_deref() == Some("provider-call"))
        );
    }

    #[test]
    fn provider_errors_are_typed_for_retry_auth_rate_limit_and_context() {
        assert_eq!(
            normalize_provider_error(503, "unavailable").kind,
            NormalizedModelErrorKind::Retryable
        );
        assert_eq!(
            normalize_provider_error(401, "bad token").kind,
            NormalizedModelErrorKind::Authentication
        );
        assert_eq!(
            normalize_provider_error(429, "slow down").kind,
            NormalizedModelErrorKind::RateLimited
        );
        assert_eq!(
            normalize_provider_error(400, "maximum context length exceeded").kind,
            NormalizedModelErrorKind::ContextTooLarge
        );
    }

    #[test]
    fn every_request_is_built_only_from_the_supplied_surface() {
        let surface = AgentSurfaceSnapshot {
            generation: 4,
            replaced_through_seq: None,
            messages: vec![AgentSurfaceMessage::User {
                message_id: "message-1".into(),
                content: "current surface".into(),
                source: crate::agent_runtime::AgentMessageSource::user(),
            }],
        };
        let request =
            ModelRequest::from_surface("request-1".into(), &surface, "system".into(), Vec::new());
        assert_eq!(request.surface_generation, 4);
        assert_eq!(
            request.messages,
            vec![ModelMessage::User {
                content: "current surface".into()
            }]
        );
    }

    #[test]
    fn structured_assistant_and_tool_history_replays_in_committed_order() {
        let provider_item = json!({
            "type": "reasoning",
            "id": "reasoning-1",
            "summary": [{ "type": "summary_text", "text": "inspect" }]
        });
        let recorded_call = RecordedToolCall {
            call_id: "call-1".into(),
            provider_call_id: Some("provider-call-1".into()),
            name: "read_file".into(),
            native_name: None,
            arguments: json!({"path": "a"}),
            title: None,
            effect: None,
            target: None,
        };
        let surface = AgentSurfaceSnapshot {
            generation: 2,
            replaced_through_seq: Some(5),
            messages: vec![
                AgentSurfaceMessage::Assistant {
                    message_id: "assistant-1".into(),
                    content: vec![
                        AgentAssistantContentBlock::Reasoning {
                            text: "inspect".into(),
                            provider_item: Some(provider_item.clone()),
                        },
                        AgentAssistantContentBlock::Text {
                            text: "reading".into(),
                        },
                        AgentAssistantContentBlock::ToolCall {
                            call: Box::new(recorded_call),
                        },
                    ],
                    interrupted: false,
                },
                AgentSurfaceMessage::Tool {
                    call_id: "call-1".into(),
                    name: "read_file".into(),
                    status: crate::agent_runtime::AgentToolResultStatus::Completed,
                    content: "file contents".into(),
                },
            ],
        };
        let request = ModelRequest::from_surface(
            "request-history".into(),
            &surface,
            "system".into(),
            Vec::new(),
        );
        assert!(matches!(
            &request.messages[0],
            ModelMessage::Assistant { content }
                if matches!(&content[0], ModelContentBlock::Reasoning { provider_item: Some(item), .. } if item == &provider_item)
                    && matches!(&content[1], ModelContentBlock::Text { text } if text == "reading")
                    && matches!(&content[2], ModelContentBlock::ToolCall { call } if call.provider_call_id.as_deref() == Some("provider-call-1"))
        ));
        assert!(matches!(
            &request.messages[1],
            ModelMessage::Tool { provider_call_id: Some(call_id), content, .. }
                if call_id == "provider-call-1" && content == "file contents"
        ));
        assert_eq!(
            responses_input(&request.messages),
            vec![
                provider_item,
                json!({ "role": "assistant", "content": "reading" }),
                json!({
                    "type": "function_call",
                    "call_id": "provider-call-1",
                    "name": "read_file",
                    "arguments": "{\"path\":\"a\"}"
                }),
                json!({
                    "type": "function_call_output",
                    "call_id": "provider-call-1",
                    "output": "file contents"
                }),
            ]
        );
    }

    fn serve_recording_sse(sse: String) -> (String, mpsc::Receiver<Value>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            let (header_end, content_length) = loop {
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0, "request ended before its body was complete");
                request.extend_from_slice(&chunk[..read]);
                if let Some(header_end) = request
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|index| index + 4)
                {
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length: ")
                                .or_else(|| line.strip_prefix("Content-Length: "))
                        })
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap();
                    break (header_end, content_length);
                }
            };
            while request.len() < header_end + content_length {
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0, "request ended before its body was complete");
                request.extend_from_slice(&chunk[..read]);
            }
            let body =
                serde_json::from_slice::<Value>(&request[header_end..header_end + content_length])
                    .unwrap();
            sender.send(body).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                sse.len(),
                sse,
            )
            .unwrap();
        });
        (format!("http://{address}"), receiver, handle)
    }

    #[tokio::test]
    async fn actual_chat_request_body_matches_the_assembled_prompt_and_canonical_tools() {
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"READY\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        )
        .to_string();
        let (base_url, body_receiver, server) = serve_recording_sse(sse);
        let provider = AiProviderConfig {
            id: "wire-minimax".into(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url,
            model: "MiniMax-M2.7".into(),
            reasoning_effort: None,
            requires_api_key: false,
            api_key: None,
        };
        let tool = AgentRequestToolSchema {
            name: "read_file".into(),
            description: "Read a bounded file.".into(),
            input_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["path"],
                "properties": { "path": { "type": "string" } }
            }),
        };
        let request = ModelRequest {
            request_id: "wire-request".into(),
            surface_generation: 9,
            system_prompt: "exact assembled system prompt".into(),
            messages: vec![ModelMessage::User {
                content: "Say READY".into(),
            }],
            tools: vec![tool.clone()],
        };
        let adapter = HttpModelAdapter {
            client: build_client().unwrap(),
            provider,
            api_key: None,
        };
        let response = adapter
            .stream(
                request.clone(),
                CancellationToken::new(),
                Arc::new(RecordingSink::default()),
            )
            .await
            .unwrap();
        let body = body_receiver.recv().unwrap();
        server.join().unwrap();
        assert_eq!(
            body.pointer("/messages/0/content").and_then(Value::as_str),
            Some(request.system_prompt.as_str())
        );
        assert_eq!(
            body.pointer("/tools/0/function/parameters"),
            Some(&tool.input_schema)
        );
        assert_eq!(
            body.pointer("/stream_options/include_usage")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            body.get("reasoning_split").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            response.content,
            vec![ModelContentBlock::Text {
                text: "READY".into()
            }]
        );
    }

    #[tokio::test]
    async fn generic_compatible_request_omits_unsupported_stream_usage_options() {
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        )
        .to_string();
        let (base_url, body_receiver, server) = serve_recording_sse(sse);
        let adapter = HttpModelAdapter {
            client: build_client().unwrap(),
            provider: AiProviderConfig {
                id: "wire-compatible".into(),
                kind: AiProviderKind::OpenAiCompatible,
                base_url,
                model: "generic-chat-model".into(),
                reasoning_effort: None,
                requires_api_key: false,
                api_key: None,
            },
            api_key: None,
        };
        let response = adapter
            .stream(
                ModelRequest {
                    request_id: "wire-generic".into(),
                    surface_generation: 0,
                    system_prompt: "system".into(),
                    messages: Vec::new(),
                    tools: Vec::new(),
                },
                CancellationToken::new(),
                Arc::new(RecordingSink::default()),
            )
            .await
            .unwrap();
        let body = body_receiver.recv().unwrap();
        server.join().unwrap();
        assert!(body.get("stream_options").is_none());
        assert!(body.get("parallel_tool_calls").is_none());
        assert_eq!(response.usage, ModelUsage::default());
        assert_eq!(
            response.content,
            vec![ModelContentBlock::Text { text: "ok".into() }]
        );
        assert!(!response
            .content
            .iter()
            .any(|block| matches!(block, ModelContentBlock::Reasoning { .. })));
    }

    async fn run_live_provider_basic_round(
        prefix: &str,
        kind: AiProviderKind,
        default_base_url: &str,
        default_model: &str,
        reasoning_effort: Option<crate::ai::AiReasoningEffort>,
        requires_api_key: bool,
        require_reasoning: bool,
        forbid_reasoning: bool,
        require_usage: bool,
    ) {
        let base_url = std::env::var(format!("SHELLSPAN_LIVE_{prefix}_BASE_URL"))
            .unwrap_or_else(|_| default_base_url.to_string());
        let model = std::env::var(format!("SHELLSPAN_LIVE_{prefix}_MODEL"))
            .unwrap_or_else(|_| default_model.to_string());
        let api_key = std::env::var(format!("SHELLSPAN_LIVE_{prefix}_API_KEY")).ok();
        if requires_api_key && api_key.is_none() {
            panic!("SHELLSPAN_LIVE_{prefix}_API_KEY is required for this ignored live test");
        }
        let provider = AiProviderConfig {
            id: format!("live-{}", prefix.to_ascii_lowercase()),
            kind,
            base_url,
            model,
            reasoning_effort,
            requires_api_key,
            api_key: None,
        };
        let adapter = ModelRegistry::default().resolve(provider, api_key).unwrap();
        let surface = AgentSurfaceSnapshot {
            generation: 0,
            replaced_through_seq: None,
            messages: vec![AgentSurfaceMessage::User {
                message_id: "live-message".into(),
                content: if require_reasoning {
                    "Which is greater, 9.11 or 9.8? Answer briefly.".into()
                } else {
                    "Reply briefly with READY.".into()
                },
                source: crate::agent_runtime::AgentMessageSource::user(),
            }],
        };
        let response = adapter
            .stream(
                ModelRequest::from_surface(
                    "live-request".into(),
                    &surface,
                    "You are a concise test assistant.".into(),
                    Vec::new(),
                ),
                CancellationToken::new(),
                Arc::new(RecordingSink::default()),
            )
            .await
            .unwrap_or_else(|error| {
                panic!("live provider failed: {:?}: {}", error.kind, error.message)
            });
        assert!(
            response.content.iter().any(|block| matches!(
                block,
                ModelContentBlock::Text { text } if !text.trim().is_empty()
            )),
            "live provider returned no answer text"
        );
        if require_reasoning {
            let block_kinds = response
                .content
                .iter()
                .map(|block| match block {
                    ModelContentBlock::Text { .. } => "text",
                    ModelContentBlock::Reasoning { .. } => "reasoning",
                    ModelContentBlock::ToolCall { .. } => "toolCall",
                })
                .collect::<Vec<_>>();
            assert!(
                response.content.iter().any(|block| matches!(
                    block,
                    ModelContentBlock::Reasoning { text, .. } if !text.trim().is_empty()
                )),
                "live provider returned no structured reasoning; blocks={block_kinds:?}, reasoning_tokens={:?}, total_tokens={:?}",
                response.usage.reasoning_tokens,
                response.usage.total_tokens,
            );
        } else if forbid_reasoning {
            assert!(
                !response.content.iter().any(|block| matches!(
                    block,
                    ModelContentBlock::Reasoning { text, .. } if !text.trim().is_empty()
                )),
                "live provider returned reasoning while thinking was disabled"
            );
        }
        if require_usage {
            assert!(
                response.usage.uncached_input_tokens.is_some()
                    || response.usage.cache_read_tokens.is_some()
                    || response.usage.cache_write_tokens.is_some()
                    || response.usage.output_tokens.is_some()
                    || response.usage.reasoning_tokens.is_some()
                    || response.usage.total_tokens.is_some(),
                "live provider returned no usage facts"
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires SHELLSPAN_LIVE_OPENAI_API_KEY and external network access"]
    async fn live_provider_basic_round_openai() {
        run_live_provider_basic_round(
            "OPENAI",
            AiProviderKind::OpenAi,
            "https://api.openai.com",
            "gpt-5.4-mini",
            None,
            true,
            false,
            false,
            false,
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires SHELLSPAN_LIVE_DEEPSEEK_API_KEY and external network access"]
    async fn live_provider_basic_round_deepseek() {
        run_live_provider_basic_round(
            "DEEPSEEK",
            AiProviderKind::OpenAiCompatible,
            "https://api.deepseek.com",
            "deepseek-v4-flash",
            Some(crate::ai::AiReasoningEffort::High),
            true,
            true,
            false,
            true,
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires SHELLSPAN_LIVE_DEEPSEEK_API_KEY and external network access"]
    async fn live_provider_basic_round_deepseek_no_reasoning() {
        run_live_provider_basic_round(
            "DEEPSEEK",
            AiProviderKind::OpenAiCompatible,
            "https://api.deepseek.com",
            "deepseek-v4-flash",
            Some(crate::ai::AiReasoningEffort::Off),
            true,
            false,
            true,
            true,
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires SHELLSPAN_LIVE_KIMI_API_KEY and external network access"]
    async fn live_provider_basic_round_kimi() {
        run_live_provider_basic_round(
            "KIMI",
            AiProviderKind::OpenAiCompatible,
            "https://api.kimi.com/coding",
            "k3",
            None,
            true,
            false,
            false,
            false,
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires SHELLSPAN_LIVE_MINIMAX_API_KEY and external network access"]
    async fn live_provider_basic_round_minimax() {
        run_live_provider_basic_round(
            "MINIMAX",
            AiProviderKind::OpenAiCompatible,
            "https://api.minimaxi.com",
            "MiniMax-M2.7",
            None,
            true,
            true,
            false,
            true,
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires a local Ollama service and model"]
    async fn live_provider_basic_round_ollama() {
        run_live_provider_basic_round(
            "OLLAMA",
            AiProviderKind::Ollama,
            "http://127.0.0.1:11434",
            "qwen3",
            None,
            false,
            false,
            false,
            false,
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires a configured OpenAI-compatible service"]
    async fn live_provider_basic_round_compatible() {
        run_live_provider_basic_round(
            "COMPATIBLE",
            AiProviderKind::OpenAiCompatible,
            "http://127.0.0.1:1234",
            "generic-chat-model",
            None,
            false,
            false,
            true,
            false,
        )
        .await;
    }
}
