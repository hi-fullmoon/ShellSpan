use serde::{Deserialize, Serialize};

use crate::ai::{AiProviderConfig, AiProviderKind, AGENT_MAX_OUTPUT_TOKENS};

use super::{ModelMessage, ModelRequest, MODEL_SYSTEM_INSTRUCTIONS};

const DEFAULT_OPENAI_CONTEXT_TOKENS: u64 = 128 * 1024;
const DEFAULT_COMPATIBLE_CONTEXT_TOKENS: u64 = 64 * 1024;
const DEFAULT_OLLAMA_CONTEXT_TOKENS: u64 = 32 * 1024;
const MIN_CONTEXT_TOKENS: u64 = 8 * 1024;
const MAX_CONTEXT_TOKENS: u64 = 2 * 1024 * 1024;
const FIXED_SAFETY_TOKENS: u64 = 1_024;
const COMPACTION_THRESHOLD_PERCENT: u64 = 85;
const COMPACTION_TARGET_PERCENT: u64 = 60;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelSurfaceBudget {
    pub(crate) context_window: u64,
    pub(crate) output_reserve_tokens: u64,
    pub(crate) safety_reserve_tokens: u64,
    pub(crate) usable_input_tokens: u64,
    pub(crate) compaction_threshold_tokens: u64,
    pub(crate) compaction_target_tokens: u64,
    pub(crate) system_tokens: u64,
    pub(crate) tool_schema_tokens: u64,
    pub(crate) message_tokens: u64,
    pub(crate) estimated_input_tokens: u64,
    pub(crate) estimated_input_bytes: u64,
    pub(crate) maximum_input_bytes: u64,
}

impl ModelSurfaceBudget {
    pub(crate) fn requires_compaction(&self) -> bool {
        self.estimated_input_tokens >= self.compaction_threshold_tokens
            || self.estimated_input_bytes >= self.maximum_input_bytes
    }
}

pub(crate) fn estimate_model_surface_budget(
    provider: &AiProviderConfig,
    request: &ModelRequest,
) -> ModelSurfaceBudget {
    let context_window = provider_model_context_window(provider);
    let output_reserve_tokens = AGENT_MAX_OUTPUT_TOKENS.min(context_window / 4);
    let safety_reserve_tokens = (context_window / 20).max(FIXED_SAFETY_TOKENS);
    let usable_input_tokens = context_window
        .saturating_sub(output_reserve_tokens)
        .saturating_sub(safety_reserve_tokens)
        .max(1);
    let compaction_threshold_tokens =
        usable_input_tokens.saturating_mul(COMPACTION_THRESHOLD_PERCENT) / 100;
    let compaction_target_tokens =
        usable_input_tokens.saturating_mul(COMPACTION_TARGET_PERCENT) / 100;
    let system_bytes = MODEL_SYSTEM_INSTRUCTIONS.len() as u64;
    let tool_schema_bytes = serde_json::to_vec(&request.tools)
        .map(|value| value.len() as u64)
        .unwrap_or(u64::MAX / 8);
    let message_bytes = request
        .messages
        .iter()
        .map(model_message_bytes)
        .sum::<u64>();
    let system_tokens = estimate_tokens(system_bytes);
    let tool_schema_tokens = estimate_tokens(tool_schema_bytes);
    let message_tokens = request
        .messages
        .iter()
        .map(model_message_tokens)
        .sum::<u64>();
    let estimated_input_tokens = system_tokens
        .saturating_add(tool_schema_tokens)
        .saturating_add(message_tokens);
    let estimated_input_bytes = system_bytes
        .saturating_add(tool_schema_bytes)
        .saturating_add(message_bytes);

    ModelSurfaceBudget {
        context_window,
        output_reserve_tokens,
        safety_reserve_tokens,
        usable_input_tokens,
        compaction_threshold_tokens,
        compaction_target_tokens,
        system_tokens,
        tool_schema_tokens,
        message_tokens,
        estimated_input_tokens,
        estimated_input_bytes,
        maximum_input_bytes: usable_input_tokens.saturating_mul(4),
    }
}

pub(crate) fn provider_model_context_window(provider: &AiProviderConfig) -> u64 {
    if let Some(explicit) =
        context_window_hint(&provider.model).or_else(|| context_window_hint(&provider.id))
    {
        return explicit.clamp(MIN_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS);
    }
    let model = provider.model.trim().to_ascii_lowercase();
    match provider.kind {
        AiProviderKind::OpenAi if model.starts_with("gpt-4.1") => 1_047_576,
        AiProviderKind::OpenAi
            if model.starts_with("gpt-5") || model.starts_with("o3") || model.starts_with("o4") =>
        {
            400_000
        }
        AiProviderKind::OpenAi => DEFAULT_OPENAI_CONTEXT_TOKENS,
        AiProviderKind::OpenAiCompatible
            if model.starts_with("minimax-") || model.contains("abab") =>
        {
            204_800
        }
        AiProviderKind::OpenAiCompatible
            if model.contains("kimi") || model.contains("moonshot") =>
        {
            131_072
        }
        AiProviderKind::OpenAiCompatible if model.contains("deepseek") => 65_536,
        AiProviderKind::OpenAiCompatible => DEFAULT_COMPATIBLE_CONTEXT_TOKENS,
        AiProviderKind::Ollama => DEFAULT_OLLAMA_CONTEXT_TOKENS,
    }
}

fn context_window_hint(value: &str) -> Option<u64> {
    let lower = value.to_ascii_lowercase();
    for marker in ["context-", "ctx-"] {
        let Some(start) = lower.find(marker).map(|index| index + marker.len()) else {
            continue;
        };
        let digits = lower[start..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>();
        if let Ok(tokens) = digits.parse::<u64>() {
            return Some(tokens);
        }
    }
    None
}

fn model_message_bytes(message: &ModelMessage) -> u64 {
    serde_json::to_vec(message)
        .map(|value| value.len() as u64)
        .unwrap_or(u64::MAX / 16)
}

fn model_message_tokens(message: &ModelMessage) -> u64 {
    // Four bytes per token is deliberately conservative for mixed prose,
    // paths, JSON arguments and tool output. The per-message framing reserve
    // covers provider role/name/call identifiers that are not literal text.
    estimate_tokens(model_message_bytes(message)).saturating_add(8)
}

fn estimate_tokens(bytes: u64) -> u64 {
    bytes.saturating_add(3) / 4
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::ai::{AiProviderKind, AiReasoningEffort};

    use super::*;
    use crate::agent_runtime::{ModelToolCall, ModelToolDefinition};

    fn provider(model: &str) -> AiProviderConfig {
        AiProviderConfig {
            id: "fixture".into(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "http://127.0.0.1".into(),
            model: model.into(),
            reasoning_effort: Some(AiReasoningEffort::Off),
            requires_api_key: false,
            api_key: None,
        }
    }

    #[test]
    fn budget_counts_system_tools_messages_and_provider_model_window() {
        let request = ModelRequest {
            request_id: "request".into(),
            surface_generation: 0,
            messages: vec![
                ModelMessage::User {
                    content: "x".repeat(8_000),
                },
                ModelMessage::Assistant {
                    content: "inspect".into(),
                    tool_calls: vec![ModelToolCall {
                        call_id: "call".into(),
                        provider_call_id: None,
                        name: "read_file".into(),
                        arguments: json!({"path": "/tmp/example"}),
                    }],
                },
            ],
            tools: vec![ModelToolDefinition {
                name: "read_file".into(),
                description: "read".into(),
                parameters: json!({"type": "object"}),
            }],
        };
        let budget = estimate_model_surface_budget(&provider("fixture-context-16384"), &request);
        assert_eq!(budget.context_window, 16_384);
        assert!(budget.system_tokens > 0);
        assert!(budget.tool_schema_tokens > 0);
        assert!(budget.message_tokens > 2_000);
        assert_eq!(
            budget.estimated_input_tokens,
            budget.system_tokens + budget.tool_schema_tokens + budget.message_tokens
        );
    }

    #[test]
    fn threshold_is_strictly_below_usable_window_and_has_a_lower_target() {
        let request = ModelRequest {
            request_id: "request".into(),
            surface_generation: 0,
            messages: vec![ModelMessage::User {
                content: "x".repeat(64 * 1024),
            }],
            tools: Vec::new(),
        };
        let budget = estimate_model_surface_budget(&provider("fixture-context-8192"), &request);
        assert!(budget.compaction_target_tokens < budget.compaction_threshold_tokens);
        assert!(budget.compaction_threshold_tokens < budget.context_window);
        assert!(budget.requires_compaction());
    }
}
