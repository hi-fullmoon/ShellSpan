use super::protocol::{
    decode_agent_decision_v1, AgentDecisionV1, AgentProviderBindingV1, AgentProviderCapabilitiesV1,
    AgentProviderKindV1, AGENT_DECISION_SCHEMA_V1,
};
use crate::ai::{
    api_key_for_provider, build_client, endpoint_url, validate_provider_config, AiProviderConfig,
    AiProviderKind, AiStructuredOutputMode,
};
use futures_util::StreamExt;
use reqwest::{Client, Response, StatusCode};
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

const AGENT_DECISION_SCHEMA_NAME_V1: &str = "termbridge_agent_decision_v1";
const MAX_AGENT_PROVIDER_RESPONSE_BYTES_V1: usize = 128 * 1024;
const REPAIR_INSTRUCTION_V1: &str = "Your previous response did not match the required AgentDecision v1 contract. Return exactly one JSON object matching the supplied schema. Do not add Markdown, commentary, another action, or fields outside the schema.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentModelContextV1 {
    pub(crate) stable_instructions: String,
    pub(crate) dynamic_input: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentModelRequestV1 {
    pub(crate) context: AgentModelContextV1,
    pub(crate) repair: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentModelErrorKindV1 {
    Cancelled,
    Timeout,
    Unavailable,
    Incompatible,
    ProviderProtocol,
    InvalidDecision,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentModelErrorV1 {
    pub(crate) kind: AgentModelErrorKindV1,
    pub(crate) message: String,
}

impl AgentModelErrorV1 {
    fn new(kind: AgentModelErrorKindV1, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn cancelled() -> Self {
        Self::new(
            AgentModelErrorKindV1::Cancelled,
            "The Agent model request was cancelled.",
        )
    }

    fn protocol(message: impl Into<String>) -> Self {
        Self::new(AgentModelErrorKindV1::ProviderProtocol, message)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct AgentModelUsageV1 {
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentModelTurnResultV1 {
    pub(crate) decision: AgentDecisionV1,
    pub(crate) provider_request_id: Option<String>,
    pub(crate) usage: Option<AgentModelUsageV1>,
}

pub(crate) type AgentModelFutureV1<'a> =
    Pin<Box<dyn Future<Output = Result<AgentModelTurnResultV1, AgentModelErrorV1>> + Send + 'a>>;

/// One invocation is exactly one provider request and one strict decode. The
/// orchestrator owns the single permitted repair so that each repair consumes
/// the same model-turn budget and observes the same cancellation boundaries.
pub(crate) trait AgentDecisionModelV1: Send + Sync {
    fn provider(&self) -> &AgentProviderBindingV1;

    fn request_decision<'a>(
        &'a self,
        request: AgentModelRequestV1,
        cancellation: CancellationToken,
    ) -> AgentModelFutureV1<'a>;
}

pub(crate) struct HttpAgentModelAdapterV1 {
    provider_config: AiProviderConfig,
    provider_binding: AgentProviderBindingV1,
    api_key: Option<String>,
    client: Client,
}

impl HttpAgentModelAdapterV1 {
    pub(crate) fn new(provider: AiProviderConfig) -> Result<Self, AgentModelErrorV1> {
        let provider_binding = capability_snapshot_v1(&provider)?;
        let api_key = api_key_for_provider(&provider).map_err(|_| {
            AgentModelErrorV1::new(
                AgentModelErrorKindV1::Unavailable,
                "The Agent provider credential is unavailable.",
            )
        })?;
        let mut provider_config = provider;
        // Keep the transport credential in one private field only. Request
        // bodies and the frozen public capability snapshot never contain it.
        provider_config.api_key = None;
        let client = build_client().map_err(|_| {
            AgentModelErrorV1::new(
                AgentModelErrorKindV1::Unavailable,
                "The Agent provider HTTP client could not be initialized.",
            )
        })?;
        Ok(Self {
            provider_config,
            provider_binding,
            api_key,
            client,
        })
    }

    async fn request_raw_decision(
        &self,
        request: &AgentModelRequestV1,
        cancellation: &CancellationToken,
    ) -> Result<Value, AgentModelErrorV1> {
        let body = build_provider_request_body_v1(&self.provider_config, request)?;
        let path = match self.provider_config.kind {
            AiProviderKind::OpenAi => "responses",
            AiProviderKind::OpenAiCompatible => "chat/completions",
            AiProviderKind::Ollama => "api/chat",
        };
        let endpoint = endpoint_url(&self.provider_config, path).map_err(|_| {
            AgentModelErrorV1::new(
                AgentModelErrorKindV1::Incompatible,
                "The Agent provider endpoint is invalid.",
            )
        })?;
        let builder = self.client.post(endpoint).json(&body);
        let builder = if let Some(api_key) = &self.api_key {
            builder.bearer_auth(api_key)
        } else {
            builder
        };
        let response = cancellable_provider_future_v1(cancellation, builder.send())
            .await?
            .map_err(classify_transport_error_v1)?;
        let response = checked_provider_status_v1(response)?;
        let bytes = read_bounded_provider_body_v1(response, cancellation).await?;
        serde_json::from_slice(&bytes).map_err(|_| {
            AgentModelErrorV1::protocol("The Agent provider returned an invalid JSON envelope.")
        })
    }
}

impl AgentDecisionModelV1 for HttpAgentModelAdapterV1 {
    fn provider(&self) -> &AgentProviderBindingV1 {
        &self.provider_binding
    }

    fn request_decision<'a>(
        &'a self,
        request: AgentModelRequestV1,
        cancellation: CancellationToken,
    ) -> AgentModelFutureV1<'a> {
        Box::pin(async move {
            let response = self.request_raw_decision(&request, &cancellation).await?;
            parse_provider_decision_v1(self.provider_config.kind, &response)
        })
    }
}

pub(crate) fn capability_snapshot_v1(
    provider: &AiProviderConfig,
) -> Result<AgentProviderBindingV1, AgentModelErrorV1> {
    validate_provider_config(provider, true).map_err(|_| {
        AgentModelErrorV1::new(
            AgentModelErrorKindV1::Incompatible,
            "The Agent provider configuration is invalid.",
        )
    })?;

    if !matches!(provider.kind, AiProviderKind::OpenAi)
        && provider.structured_output != AiStructuredOutputMode::JsonSchema
    {
        return Err(AgentModelErrorV1::new(
            AgentModelErrorKindV1::Incompatible,
            "Dynamic Agent requires strict JSON schema output for this provider.",
        ));
    }

    let (kind, native_tool_calling, usage_reporting, response_continuation) = match provider.kind {
        AiProviderKind::OpenAi => (AgentProviderKindV1::OpenAi, false, true, true),
        AiProviderKind::OpenAiCompatible => {
            (AgentProviderKindV1::OpenAiCompatible, false, true, false)
        }
        AiProviderKind::Ollama => (AgentProviderKindV1::Ollama, false, true, false),
    };
    Ok(AgentProviderBindingV1 {
        provider_id: provider.id.clone(),
        kind,
        base_url: provider.base_url.trim().trim_end_matches('/').to_string(),
        model: provider.model.trim().to_string(),
        capabilities: AgentProviderCapabilitiesV1 {
            streaming: true,
            strict_json_schema: true,
            // Native tool calls are deliberately not part of the P1 adapter
            // contract even when the upstream provider supports them.
            native_tool_calling,
            usage_reporting,
            response_continuation,
        },
    })
}

fn decision_schema_value_v1() -> Result<Value, AgentModelErrorV1> {
    serde_json::from_str(AGENT_DECISION_SCHEMA_V1).map_err(|_| {
        AgentModelErrorV1::new(
            AgentModelErrorKindV1::ProviderProtocol,
            "The checked-in Agent decision schema is invalid.",
        )
    })
}

fn provider_messages_v1(request: &AgentModelRequestV1) -> Vec<Value> {
    let mut messages = vec![
        json!({
            "role": "system",
            "content": request.context.stable_instructions,
        }),
        json!({
            "role": "user",
            "content": request.context.dynamic_input,
        }),
    ];
    if request.repair {
        messages.push(json!({
            "role": "user",
            "content": REPAIR_INSTRUCTION_V1,
        }));
    }
    messages
}

pub(crate) fn build_provider_request_body_v1(
    provider: &AiProviderConfig,
    request: &AgentModelRequestV1,
) -> Result<Value, AgentModelErrorV1> {
    let snapshot = capability_snapshot_v1(provider)?;
    if !snapshot.capabilities.strict_json_schema {
        return Err(AgentModelErrorV1::new(
            AgentModelErrorKindV1::Incompatible,
            "Dynamic Agent requires strict JSON schema output.",
        ));
    }
    let schema = decision_schema_value_v1()?;
    Ok(match provider.kind {
        AiProviderKind::OpenAi => {
            let mut input = vec![json!({
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": request.context.dynamic_input,
                }],
            })];
            if request.repair {
                input.push(json!({
                    "role": "user",
                    "content": [{
                        "type": "input_text",
                        "text": REPAIR_INSTRUCTION_V1,
                    }],
                }));
            }
            json!({
                "model": provider.model,
                "store": false,
                "stream": false,
                "instructions": request.context.stable_instructions,
                "input": input,
                "text": {
                    "format": {
                        "type": "json_schema",
                        "name": AGENT_DECISION_SCHEMA_NAME_V1,
                        "strict": true,
                        "schema": schema,
                    }
                },
            })
        }
        AiProviderKind::OpenAiCompatible => json!({
            "model": provider.model,
            "stream": false,
            "messages": provider_messages_v1(request),
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": AGENT_DECISION_SCHEMA_NAME_V1,
                    "strict": true,
                    "schema": schema,
                }
            },
        }),
        AiProviderKind::Ollama => json!({
            "model": provider.model,
            "stream": false,
            "messages": provider_messages_v1(request),
            "format": schema,
        }),
    })
}

fn parse_provider_decision_v1(
    kind: AiProviderKind,
    response: &Value,
) -> Result<AgentModelTurnResultV1, AgentModelErrorV1> {
    let (raw_decision, provider_request_id, usage) = match kind {
        AiProviderKind::OpenAi => parse_openai_responses_envelope_v1(response)?,
        AiProviderKind::OpenAiCompatible => parse_openai_chat_envelope_v1(response)?,
        AiProviderKind::Ollama => parse_ollama_envelope_v1(response)?,
    };
    let decision = decode_agent_decision_v1(&raw_decision).map_err(|_| {
        AgentModelErrorV1::new(
            AgentModelErrorKindV1::InvalidDecision,
            "The Agent provider response did not match AgentDecision v1.",
        )
    })?;
    Ok(AgentModelTurnResultV1 {
        decision,
        provider_request_id,
        usage,
    })
}

fn parse_openai_responses_envelope_v1(
    response: &Value,
) -> Result<(String, Option<String>, Option<AgentModelUsageV1>), AgentModelErrorV1> {
    if response.get("status").and_then(Value::as_str) != Some("completed") {
        return Err(AgentModelErrorV1::protocol(
            "The OpenAI Responses request did not complete.",
        ));
    }
    let raw = if let Some(output_text) = response.get("output_text").and_then(Value::as_str) {
        output_text.to_string()
    } else {
        let output = response
            .get("output")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                AgentModelErrorV1::protocol("The OpenAI Responses envelope did not contain output.")
            })?;
        let mut text = String::new();
        for item in output {
            let Some(content) = item.get("content").and_then(Value::as_array) else {
                continue;
            };
            for part in content {
                if part.get("type").and_then(Value::as_str) == Some("refusal") {
                    return Err(AgentModelErrorV1::protocol(
                        "The OpenAI Responses request was refused.",
                    ));
                }
                if part.get("type").and_then(Value::as_str) == Some("output_text") {
                    if let Some(part_text) = part.get("text").and_then(Value::as_str) {
                        text.push_str(part_text);
                    }
                }
            }
        }
        if text.is_empty() {
            return Err(AgentModelErrorV1::protocol(
                "The OpenAI Responses envelope did not contain decision text.",
            ));
        }
        text
    };
    let usage = token_usage_v1(response, "/usage/input_tokens", "/usage/output_tokens");
    Ok((
        raw,
        response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string),
        usage,
    ))
}

fn parse_openai_chat_envelope_v1(
    response: &Value,
) -> Result<(String, Option<String>, Option<AgentModelUsageV1>), AgentModelErrorV1> {
    let raw = response
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .filter(|content| !content.is_empty())
        .ok_or_else(|| {
            AgentModelErrorV1::protocol(
                "The OpenAI-compatible envelope did not contain decision text.",
            )
        })?
        .to_string();
    let usage = token_usage_v1(response, "/usage/prompt_tokens", "/usage/completion_tokens");
    Ok((
        raw,
        response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string),
        usage,
    ))
}

fn parse_ollama_envelope_v1(
    response: &Value,
) -> Result<(String, Option<String>, Option<AgentModelUsageV1>), AgentModelErrorV1> {
    if response.get("done").and_then(Value::as_bool) == Some(false) {
        return Err(AgentModelErrorV1::protocol(
            "The Ollama request ended before completion.",
        ));
    }
    let raw = response
        .pointer("/message/content")
        .and_then(Value::as_str)
        .filter(|content| !content.is_empty())
        .ok_or_else(|| {
            AgentModelErrorV1::protocol("The Ollama envelope did not contain decision text.")
        })?
        .to_string();
    let usage = token_usage_v1(response, "/prompt_eval_count", "/eval_count");
    Ok((raw, None, usage))
}

fn token_usage_v1(
    response: &Value,
    input_path: &str,
    output_path: &str,
) -> Option<AgentModelUsageV1> {
    let input_tokens = response.pointer(input_path).and_then(Value::as_u64)?;
    let output_tokens = response.pointer(output_path).and_then(Value::as_u64)?;
    Some(AgentModelUsageV1 {
        input_tokens,
        output_tokens,
    })
}

async fn cancellable_provider_future_v1<F, T>(
    cancellation: &CancellationToken,
    future: F,
) -> Result<T, AgentModelErrorV1>
where
    F: Future<Output = T>,
{
    tokio::select! {
        _ = cancellation.cancelled() => Err(AgentModelErrorV1::cancelled()),
        result = future => Ok(result),
    }
}

fn classify_transport_error_v1(error: reqwest::Error) -> AgentModelErrorV1 {
    if error.is_timeout() {
        AgentModelErrorV1::new(
            AgentModelErrorKindV1::Timeout,
            "The Agent provider request timed out.",
        )
    } else {
        AgentModelErrorV1::new(
            AgentModelErrorKindV1::Unavailable,
            "The Agent provider request failed.",
        )
    }
}

fn checked_provider_status_v1(response: Response) -> Result<Response, AgentModelErrorV1> {
    if response.status().is_success() {
        return Ok(response);
    }
    let kind = if response.status() == StatusCode::REQUEST_TIMEOUT
        || response.status() == StatusCode::GATEWAY_TIMEOUT
    {
        AgentModelErrorKindV1::Timeout
    } else {
        AgentModelErrorKindV1::Unavailable
    };
    Err(AgentModelErrorV1::new(
        kind,
        format!(
            "The Agent provider returned HTTP status {}.",
            response.status().as_u16()
        ),
    ))
}

async fn read_bounded_provider_body_v1(
    response: Response,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, AgentModelErrorV1> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_AGENT_PROVIDER_RESPONSE_BYTES_V1 as u64)
    {
        return Err(AgentModelErrorV1::protocol(
            "The Agent provider response exceeded the bounded envelope size.",
        ));
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    loop {
        let next = tokio::select! {
            _ = cancellation.cancelled() => return Err(AgentModelErrorV1::cancelled()),
            next = stream.next() => next,
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(classify_transport_error_v1)?;
        if body.len().saturating_add(chunk.len()) > MAX_AGENT_PROVIDER_RESPONSE_BYTES_V1 {
            return Err(AgentModelErrorV1::protocol(
                "The Agent provider response exceeded the bounded envelope size.",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(
        kind: AiProviderKind,
        structured_output: AiStructuredOutputMode,
    ) -> AiProviderConfig {
        AiProviderConfig {
            id: match kind {
                AiProviderKind::OpenAi => "openai",
                AiProviderKind::OpenAiCompatible => "compatible",
                AiProviderKind::Ollama => "ollama",
            }
            .to_string(),
            kind,
            base_url: match kind {
                AiProviderKind::Ollama => "http://127.0.0.1:11434",
                _ => "https://provider.invalid/v1",
            }
            .to_string(),
            model: "fixture-model".to_string(),
            requires_api_key: kind != AiProviderKind::Ollama,
            structured_output,
            api_key: (kind != AiProviderKind::Ollama).then(|| "fixture-secret".to_string()),
        }
    }

    fn model_request(repair: bool) -> AgentModelRequestV1 {
        AgentModelRequestV1 {
            context: AgentModelContextV1 {
                stable_instructions: "stable contract".to_string(),
                dynamic_input: "dynamic observations".to_string(),
            },
            repair,
        }
    }

    fn valid_final_decision() -> String {
        json!({
            "schemaVersion": 1,
            "kind": "final",
            "rationale": "The bounded fake observations are sufficient.",
            "plan": { "items": [] },
            "report": {
                "outcome": "inconclusive",
                "summary": "The fake run ended safely.",
                "findings": [],
                "changes": [],
                "warnings": [],
                "nextActions": []
            }
        })
        .to_string()
    }

    #[test]
    fn capability_snapshot_is_frozen_and_strict_for_all_three_providers() {
        for (kind, expected_kind, response_continuation) in [
            (AiProviderKind::OpenAi, AgentProviderKindV1::OpenAi, true),
            (
                AiProviderKind::OpenAiCompatible,
                AgentProviderKindV1::OpenAiCompatible,
                false,
            ),
            (AiProviderKind::Ollama, AgentProviderKindV1::Ollama, false),
        ] {
            let snapshot = capability_snapshot_v1(&provider(
                kind,
                if kind == AiProviderKind::OpenAi {
                    AiStructuredOutputMode::Prompt
                } else {
                    AiStructuredOutputMode::JsonSchema
                },
            ))
            .expect("strict provider snapshot");
            assert!(snapshot.capabilities.strict_json_schema);
            assert!(!snapshot.capabilities.native_tool_calling);
            assert_eq!(
                snapshot.capabilities.response_continuation,
                response_continuation
            );
            assert_eq!(snapshot.kind, expected_kind);
            assert_eq!(snapshot.model, "fixture-model");
            assert!(!snapshot.base_url.contains("fixture-secret"));
        }

        for incompatible in [
            provider(
                AiProviderKind::OpenAiCompatible,
                AiStructuredOutputMode::JsonObject,
            ),
            provider(AiProviderKind::Ollama, AiStructuredOutputMode::Prompt),
        ] {
            assert_eq!(
                capability_snapshot_v1(&incompatible)
                    .expect_err("non-schema mode is not strict enough")
                    .kind,
                AgentModelErrorKindV1::Incompatible
            );
        }
    }

    #[test]
    fn provider_requests_share_the_exact_checked_in_schema_without_native_tools() {
        for kind in [
            AiProviderKind::OpenAi,
            AiProviderKind::OpenAiCompatible,
            AiProviderKind::Ollama,
        ] {
            let body = build_provider_request_body_v1(
                &provider(kind, AiStructuredOutputMode::JsonSchema),
                &model_request(false),
            )
            .expect("request body");
            assert_eq!(body["stream"], false);
            assert!(body.get("tools").is_none());
            assert!(!body.to_string().contains("fixture-secret"));
            let schema = match kind {
                AiProviderKind::OpenAi => &body["text"]["format"]["schema"],
                AiProviderKind::OpenAiCompatible => {
                    &body["response_format"]["json_schema"]["schema"]
                }
                AiProviderKind::Ollama => &body["format"],
            };
            assert_eq!(schema["$id"], decision_schema_value_v1().unwrap()["$id"]);
        }
    }

    #[test]
    fn repair_request_is_generic_and_does_not_echo_invalid_provider_output() {
        let invalid_output_marker = "raw-invalid-provider-output";
        for kind in [
            AiProviderKind::OpenAi,
            AiProviderKind::OpenAiCompatible,
            AiProviderKind::Ollama,
        ] {
            let body = build_provider_request_body_v1(
                &provider(kind, AiStructuredOutputMode::JsonSchema),
                &model_request(true),
            )
            .expect("repair request");
            let serialized = body.to_string();
            assert!(serialized.contains("previous response did not match"));
            assert!(!serialized.contains(invalid_output_marker));
        }
    }

    #[test]
    fn all_provider_envelopes_decode_to_the_same_strict_decision() {
        let decision = valid_final_decision();
        let openai = json!({
            "id": "resp-1",
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{ "type": "output_text", "text": decision }]
            }],
            "usage": { "input_tokens": 10, "output_tokens": 5 }
        });
        let compatible = json!({
            "id": "chatcmpl-1",
            "choices": [{ "message": { "content": valid_final_decision() } }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 5 }
        });
        let ollama = json!({
            "done": true,
            "message": { "content": valid_final_decision() },
            "prompt_eval_count": 10,
            "eval_count": 5
        });

        for (kind, envelope) in [
            (AiProviderKind::OpenAi, openai),
            (AiProviderKind::OpenAiCompatible, compatible),
            (AiProviderKind::Ollama, ollama),
        ] {
            let parsed = parse_provider_decision_v1(kind, &envelope).expect("strict decision");
            assert_eq!(parsed.decision.kind_name(), "final");
            assert_eq!(
                parsed.usage,
                Some(AgentModelUsageV1 {
                    input_tokens: 10,
                    output_tokens: 5,
                })
            );
        }
    }

    #[test]
    fn unknown_decision_field_is_a_repairable_schema_failure() {
        let mut decision: Value = serde_json::from_str(&valid_final_decision()).unwrap();
        decision["anotherAction"] = json!({ "tool": "host.inspect" });
        let envelope = json!({
            "done": true,
            "message": { "content": decision.to_string() }
        });
        assert_eq!(
            parse_provider_decision_v1(AiProviderKind::Ollama, &envelope)
                .expect_err("unknown field must fail closed")
                .kind,
            AgentModelErrorKindV1::InvalidDecision
        );
    }

    #[tokio::test]
    async fn request_cancellation_interrupts_a_pending_provider_future() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let error = cancellable_provider_future_v1(
            &cancellation,
            std::future::pending::<Result<(), reqwest::Error>>(),
        )
        .await
        .expect_err("cancelled request");
        assert_eq!(error.kind, AgentModelErrorKindV1::Cancelled);
    }
}
