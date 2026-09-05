use serde::{Deserialize, Serialize};

use crate::ai::AiProviderConfig;

use super::{ModelMessage, ModelRequest};

const FIXED_SAFETY_TOKENS: u64 = 1_024;
const COMPACTION_THRESHOLD_PERCENT: u64 = 85;
const COMPACTION_TARGET_PERCENT: u64 = 60;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelSurfaceBudget {
    pub(crate) reserved_tokens_per_image: u64,
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
) -> Result<ModelSurfaceBudget, String> {
    let model = crate::llm::catalog::resolve(provider)?;
    let context_window = model.context_window;
    let output_reserve_tokens = model.max_output_tokens;
    let image_reserve = model
        .vision
        .as_ref()
        .map_or(0, |v| v.reserved_tokens_per_image);
    let safety_reserve_tokens = (context_window / 20).max(FIXED_SAFETY_TOKENS);
    let usable_input_tokens = context_window
        .saturating_sub(output_reserve_tokens)
        .saturating_sub(safety_reserve_tokens)
        .max(1);
    let compaction_threshold_tokens =
        usable_input_tokens.saturating_mul(COMPACTION_THRESHOLD_PERCENT) / 100;
    let compaction_target_tokens =
        usable_input_tokens.saturating_mul(COMPACTION_TARGET_PERCENT) / 100;
    let system_bytes = request.system_prompt.len() as u64;
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
        .map(|message| model_message_tokens(message, image_reserve))
        .sum::<u64>();
    let estimated_input_tokens = system_tokens
        .saturating_add(tool_schema_tokens)
        .saturating_add(message_tokens);
    let estimated_input_bytes = system_bytes
        .saturating_add(tool_schema_bytes)
        .saturating_add(message_bytes);

    Ok(ModelSurfaceBudget {
        reserved_tokens_per_image: image_reserve,
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
    })
}

fn model_message_bytes(message: &ModelMessage) -> u64 {
    serde_json::to_vec(message)
        .map(|value| value.len() as u64)
        .unwrap_or(u64::MAX / 16)
}

pub(crate) fn measure_model_messages(
    messages: &[ModelMessage],
    reserved_tokens_per_image: u64,
) -> (u64, u64) {
    messages.iter().fold((0, 0), |(tokens, bytes), message| {
        (
            tokens.saturating_add(model_message_tokens(message, reserved_tokens_per_image)),
            bytes.saturating_add(model_message_bytes(message)),
        )
    })
}

fn model_message_tokens(message: &ModelMessage, reserved_tokens_per_image: u64) -> u64 {
    let image_reserve = match message {
        // Admission estimate from the selected model; never provider-reported usage.
        ModelMessage::UserImages { images, .. } => images.len() as u64 * reserved_tokens_per_image,
        _ => 0,
    };
    // Four bytes per token is deliberately conservative for mixed prose,
    // paths, JSON arguments and tool output. The per-message framing reserve
    // covers provider role/name/call identifiers that are not literal text.
    estimate_tokens(model_message_bytes(message))
        .saturating_add(8)
        .saturating_add(image_reserve)
}

fn estimate_tokens(bytes: u64) -> u64 {
    bytes.saturating_add(3) / 4
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::ai::AiProviderKind;

    use super::*;
    use crate::agent_runtime::{ModelContentBlock, ModelToolCall, ModelToolDefinition};

    fn provider(context: u64) -> AiProviderConfig {
        AiProviderConfig {
            model_definition: Some(crate::llm::catalog::fixture_definition(
                AiProviderKind::OpenAiCompatible,
                context,
            )),
            profile: None,
            retry_policy: None,
            id: "fixture".into(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "http://127.0.0.1".into(),
            model: "synthetic-budget".into(),
            reasoning_effort: Some("off".to_string()),
            requires_api_key: false,
            api_key: None,
        }
    }

    #[test]
    fn budget_counts_system_tools_messages_and_provider_model_window() {
        let request = ModelRequest {
            request_id: "request".into(),
            surface_generation: 0,
            system_prompt: "system prompt".into(),
            messages: vec![
                ModelMessage::User {
                    content: "x".repeat(8_000),
                },
                ModelMessage::Assistant {
                    content: vec![
                        ModelContentBlock::Text {
                            text: "inspect".into(),
                        },
                        ModelContentBlock::ToolCall {
                            call: ModelToolCall {
                                call_id: "call".into(),
                                provider_call_id: None,
                                name: "read_file".into(),
                                arguments: json!({"path": "/tmp/example"}),
                            },
                        },
                    ],
                    replay: None,
                    native_replay: None,
                },
            ],
            tools: vec![ModelToolDefinition {
                name: "read_file".into(),
                description: "read".into(),
                input_schema: json!({"type": "object"}),
            }],
        };
        let budget = estimate_model_surface_budget(&provider(16384), &request).unwrap();
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
            system_prompt: "system prompt".into(),
            messages: vec![ModelMessage::User {
                content: "x".repeat(64 * 1024),
            }],
            tools: Vec::new(),
        };
        let budget = estimate_model_surface_budget(&provider(8192), &request).unwrap();
        assert!(budget.compaction_target_tokens < budget.compaction_threshold_tokens);
        assert!(budget.compaction_threshold_tokens < budget.context_window);
        assert!(budget.requires_compaction());
    }
}
