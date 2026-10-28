use serde::{Deserialize, Serialize};

use crate::ai::AiProviderConfig;

use super::{ModelMessage, ModelRequest};

const COMPACTION_THRESHOLD_PERCENT: u64 = 85;
const COMPACTION_TARGET_PERCENT: u64 = 60;

/// Size-only evidence tying an estimate to a request's routed model configuration.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InputTokenMeasurement {
    pub(crate) identity: String,
    pub(crate) heuristic_tokens: u64,
    pub(crate) usage_adjustment_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) anchor_request_id: Option<String>,
}

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) input_measurement: Option<InputTokenMeasurement>,
    #[serde(skip)]
    pub(crate) tool_message_sizes: std::collections::BTreeMap<String, Vec<(u64, u64)>>,
    #[serde(skip)]
    pub(crate) assistant_message_sizes: Vec<(u64, u64)>,
}

impl ModelSurfaceBudget {
    pub(crate) fn fits_hard_limit(&self) -> bool {
        self.estimated_input_tokens <= self.usable_input_tokens
            && self.estimated_input_bytes <= self.maximum_input_bytes
    }

    pub(crate) fn diagnostic(&self) -> String {
        format!(
            "system={} tokens; tools={} tokens; messages={} tokens; total={} tokens/{} bytes; input limit={} tokens/{} bytes; output reserve={}; safety reserve={}; compaction target={}",
            self.system_tokens, self.tool_schema_tokens, self.message_tokens,
            self.estimated_input_tokens, self.estimated_input_bytes,
            self.usable_input_tokens, self.maximum_input_bytes,
            self.output_reserve_tokens, self.safety_reserve_tokens,
            self.compaction_target_tokens,
        )
    }

    pub(crate) fn requires_compaction(&self) -> bool {
        self.estimated_input_tokens >= self.compaction_threshold_tokens
            || self.estimated_input_bytes >= self.maximum_input_bytes
    }
}

/// Counts only categories and sizes. Never persist request bodies in budget diagnostics.
pub(crate) fn request_budget_breakdown(
    request: &ModelRequest,
    budget: &ModelSurfaceBudget,
) -> serde_json::Value {
    let mut categories = std::collections::BTreeMap::<&str, (u64, u64, u64)>::new();
    for message in &request.messages {
        let category = match message {
            ModelMessage::User { .. } | ModelMessage::UserImages { .. } => "userAndRuntimeContext",
            ModelMessage::Assistant { .. } => "assistantAndToolCalls",
            ModelMessage::Tool { .. } => "toolResults",
        };
        let entry = categories.entry(category).or_default();
        entry.0 += 1;
        entry.1 += model_message_tokens(message, budget.reserved_tokens_per_image);
        entry.2 += model_message_bytes(message);
    }
    let tool_results = request.messages.iter().filter_map(|message| match message {
        ModelMessage::Tool { name, .. } => Some(serde_json::json!({"name": name, "tokens": model_message_tokens(message, budget.reserved_tokens_per_image), "bytes": model_message_bytes(message)})),
        _ => None,
    }).collect::<Vec<_>>();
    serde_json::json!({"budget": budget, "messageCategories": categories, "toolResults": tool_results})
}

pub(crate) fn estimate_model_surface_budget(
    provider: &AiProviderConfig,
    request: &ModelRequest,
) -> Result<ModelSurfaceBudget, String> {
    let model = crate::llm::catalog::resolve(provider)?;
    let context_window = model.context_window;
    let output_reserve_tokens = model.output_token_budget();
    let image_reserve = model
        .vision
        .as_ref()
        .map_or(0, |v| v.reserved_tokens_per_image);
    let (safety_reserve_tokens, usable_input_tokens) =
        crate::llm::catalog::model_input_token_budget(context_window, output_reserve_tokens)?;
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
    if system_tokens.saturating_add(tool_schema_tokens) >= usable_input_tokens {
        return Err(format!("INVALID_MODEL_TOKEN_BUDGET: input budget {usable_input_tokens} cannot hold fixed system and tool instructions ({} tokens); reduce the request output budget or increase the context window", system_tokens.saturating_add(tool_schema_tokens)));
    }
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
        input_measurement: None,
        tool_message_sizes: request.messages.iter().fold(
            std::collections::BTreeMap::<String, Vec<(u64, u64)>>::new(),
            |mut sizes, message| {
                if let ModelMessage::Tool { call_id, .. } = message {
                    sizes.entry(call_id.clone()).or_default().push((
                        model_message_tokens(message, image_reserve),
                        model_message_bytes(message),
                    ));
                }
                sizes
            },
        ),
        assistant_message_sizes: request
            .messages
            .iter()
            .filter(|message| matches!(message, ModelMessage::Assistant { .. }))
            .map(|message| {
                (
                    model_message_tokens(message, image_reserve),
                    model_message_bytes(message),
                )
            })
            .collect(),
    })
}

fn model_message_bytes(message: &ModelMessage) -> u64 {
    let normalized = serde_json::to_vec(message)
        .map(|value| value.len() as u64)
        .unwrap_or(u64::MAX / 16);
    // Prepared provider replay is skipped by ModelMessage's audit serialization,
    // but still travels on the wire. Include it in admission accounting.
    if let ModelMessage::Assistant {
        native_replay: Some(replay),
        ..
    } = message
    {
        normalized.saturating_add(
            serde_json::to_vec(replay).map_or(u64::MAX / 16, |value| value.len() as u64),
        )
    } else {
        normalized
    }
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

    #[test]
    fn prepared_private_metadata_is_counted_without_entering_diagnostics() {
        let source = include_str!("../../../AGENTS.md");
        let message = ModelMessage::Assistant {
            content: vec![ModelContentBlock::Text {
                text: source.into(),
            }],
            replay: None,
            native_replay: Some(json!({"reasoningDetails":source})),
        };
        let normalized = serde_json::to_vec(&message).unwrap().len() as u64;
        assert!(model_message_bytes(&message) > normalized + source.len() as u64);
        let request = ModelRequest {
            request_id: "budget".into(),
            surface_generation: 0,
            system_prompt: String::new(),
            messages: vec![message],
            tools: vec![],
        };
        let budget = estimate_model_surface_budget(&provider(16384), &request).unwrap();
        let diagnostic = request_budget_breakdown(&request, &budget).to_string();
        assert!(!diagnostic.contains(source.lines().next().unwrap()));
        assert!(!diagnostic.contains("reasoningDetails"));
    }

    fn provider(context: u64) -> AiProviderConfig {
        AiProviderConfig {
            model_definition: Some(crate::llm::catalog::fixture_definition(
                AiProviderKind::OpenAiCompatible,
                context,
            )),
            profile: "generic".into(),
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
    fn fixed_instructions_that_cannot_fit_fail_before_compaction() {
        let source = include_str!("driver.rs");
        let mut request = ModelRequest {
            request_id: "fixed-input-capacity".into(),
            surface_generation: 0,
            system_prompt: source.into(),
            messages: vec![],
            tools: vec![],
        };
        assert!(estimate_model_surface_budget(&provider(8192), &request)
            .unwrap_err()
            .starts_with("INVALID_MODEL_TOKEN_BUDGET:"));
        request.system_prompt.clear();
        request.messages.push(ModelMessage::User {
            content: source.into(),
        });
        let budget = estimate_model_surface_budget(&provider(8192), &request).unwrap();
        assert!(budget.requires_compaction());
        assert!(!budget.fits_hard_limit());
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
