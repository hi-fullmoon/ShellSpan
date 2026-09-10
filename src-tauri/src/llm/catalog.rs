//! Exact model facts. No URL, prefix, case folding or context-name inference here.
use super::config::{AiProviderConfig, AiProviderKind};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::LazyLock};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Support {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReasoningEncoding {
    None,
    Responses,
    EnableThinking,
    Thinking,
    Adaptive,
    ThinkingEffort,
    Effort,
    Ollama,
    AnthropicAdaptive,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Compat {
    pub protocol: AiProviderKind,
    pub cumulative_stream: bool,
    pub supports_stream_usage: bool,
    pub native_reasoning: bool,
    pub split_reasoning: bool,
    pub replay_reasoning_content: bool,
    pub think_tag_fallback: bool,
    pub parallel_tool_calls: bool,
    pub strict_schema: bool,
    pub preserves_reasoning_across_turns: bool,
    pub reasoning_encoding: ReasoningEncoding,
    pub clear_thinking: bool,
    pub default_thinking: bool,
}

/// Model-local differences from the preset wire contract. The adapter protocol
/// is route-owned and therefore cannot be overridden by a model entry.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompatOverride {
    cumulative_stream: Option<bool>,
    supports_stream_usage: Option<bool>,
    native_reasoning: Option<bool>,
    split_reasoning: Option<bool>,
    replay_reasoning_content: Option<bool>,
    think_tag_fallback: Option<bool>,
    parallel_tool_calls: Option<bool>,
    strict_schema: Option<bool>,
    preserves_reasoning_across_turns: Option<bool>,
    reasoning_encoding: Option<ReasoningEncoding>,
    clear_thinking: Option<bool>,
    default_thinking: Option<bool>,
}

impl Compat {
    fn with_override(&self, value: &CompatOverride) -> Self {
        Self {
            protocol: self.protocol,
            cumulative_stream: value.cumulative_stream.unwrap_or(self.cumulative_stream),
            supports_stream_usage: value
                .supports_stream_usage
                .unwrap_or(self.supports_stream_usage),
            native_reasoning: value.native_reasoning.unwrap_or(self.native_reasoning),
            split_reasoning: value.split_reasoning.unwrap_or(self.split_reasoning),
            replay_reasoning_content: value
                .replay_reasoning_content
                .unwrap_or(self.replay_reasoning_content),
            think_tag_fallback: value.think_tag_fallback.unwrap_or(self.think_tag_fallback),
            parallel_tool_calls: value
                .parallel_tool_calls
                .unwrap_or(self.parallel_tool_calls),
            strict_schema: value.strict_schema.unwrap_or(self.strict_schema),
            preserves_reasoning_across_turns: value
                .preserves_reasoning_across_turns
                .unwrap_or(self.preserves_reasoning_across_turns),
            reasoning_encoding: value.reasoning_encoding.unwrap_or(self.reasoning_encoding),
            clear_thinking: value.clear_thinking.unwrap_or(self.clear_thinking),
            default_thinking: value.default_thinking.unwrap_or(self.default_thinking),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReasoningOption {
    pub id: String,
    pub display_name: String,
    /// Missing uses `id`, explicit null omits the provider reasoning field, and
    /// a value supplies the provider's spelling for this selector value.
    #[serde(
        default,
        deserialize_with = "deserialize_present_optional_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub wire_value: Option<Option<Value>>,
}

fn deserialize_present_optional_value<'de, D>(
    deserializer: D,
) -> Result<Option<Option<Value>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<Value>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VisionBudget {
    pub max_request_images: usize,
    pub max_request_image_bytes: u64,
    pub reserved_tokens_per_image: u64,
    pub image_token_budget_policy: String,
}

/// Full explicit declaration, also usable to replace an exact built-in entry.
/// All capacities and support states are required: absence never grants tools/images.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelDefinition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub context_window: u64,
    pub max_output_tokens: u64,
    pub tool_calling: Support,
    pub text_input: Support,
    pub image_input: Support,
    pub reasoning: Vec<ReasoningOption>,
    pub compat: Compat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vision: Option<VisionBudget>,
}

/// Built-in catalog entry. Model facts stay explicit while provider protocol
/// behavior inherits from the preset and names only model-local differences.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogModelDefinition {
    #[serde(default)]
    display_name: Option<String>,
    context_window: u64,
    max_output_tokens: u64,
    tool_calling: Support,
    text_input: Support,
    image_input: Support,
    reasoning: Vec<ReasoningOption>,
    #[serde(default)]
    compat: CompatOverride,
    #[serde(default)]
    vision: Option<VisionBudget>,
}

impl CatalogModelDefinition {
    fn resolve(&self, preset: &Compat) -> ModelDefinition {
        ModelDefinition {
            display_name: self.display_name.clone(),
            context_window: self.context_window,
            max_output_tokens: self.max_output_tokens,
            tool_calling: self.tool_calling,
            text_input: self.text_input,
            image_input: self.image_input,
            reasoning: self.reasoning.clone(),
            compat: preset.with_override(&self.compat),
            vision: self.vision.clone(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preset {
    kind: AiProviderKind,
    compat: Compat,
    models: BTreeMap<String, CatalogModelDefinition>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    version: u32,
    policy: String,
    presets: BTreeMap<String, Preset>,
}
static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    let value: Catalog = serde_json::from_str(include_str!("../../../protocol/llm/catalog.json"))
        .expect("typed LLM catalog");
    assert_eq!(value.version, 1);
    assert!(!value.policy.is_empty());
    for preset in value.presets.values() {
        assert_eq!(preset.kind, preset.compat.protocol);
        for (id, model) in &preset.models {
            validate_definition(id, &model.resolve(&preset.compat), preset.kind)
                .expect("valid catalog model");
        }
    }
    value
});

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedModel {
    pub catalog_version: u32,
    pub route_id: String,
    pub provider_id: String,
    pub profile: String,
    pub kind: AiProviderKind,
    pub model_id: String,
    pub source: &'static str,
    pub capacity_policy: &'static str,
    #[serde(skip)]
    pub endpoint: reqwest::Url,
    #[serde(flatten)]
    pub definition: ModelDefinition,
}
impl std::ops::Deref for ResolvedModel {
    type Target = ModelDefinition;
    fn deref(&self) -> &Self::Target {
        &self.definition
    }
}

pub(crate) fn profile_id(provider: &AiProviderConfig) -> Result<&str, String> {
    if provider.profile.is_empty() {
        return Err("UNKNOWN_PROFILE: Provider profile is required".into());
    }
    Ok(&provider.profile)
}

pub(crate) fn validate_profile(provider: &AiProviderConfig) -> Result<(), String> {
    let profile = profile_id(provider)?;
    let preset = CATALOG
        .presets
        .get(profile)
        .ok_or("UNKNOWN_PROFILE: Unknown provider profile")?;
    if preset.kind != provider.kind {
        return Err("UNSUPPORTED_OPTION: Provider profile does not match protocol".into());
    }
    Ok(())
}

pub(crate) fn validate_definition(
    id: &str,
    d: &ModelDefinition,
    kind: AiProviderKind,
) -> Result<(), String> {
    if id.is_empty() || id.trim() != id {
        return Err("UNKNOWN_MODEL: model ID must be nonempty and exact".into());
    }
    if d.display_name
        .as_ref()
        .is_some_and(|name| name.trim().is_empty())
    {
        return Err("UNSUPPORTED_OPTION: model display name must be nonempty".into());
    }
    // IPC token counts must remain exact JavaScript integers; this is an encoding limit,
    // not a provider capacity heuristic. Small/custom windows are otherwise valid.
    if d.context_window == 0
        || d.context_window > 9_007_199_254_740_991
        || d.max_output_tokens == 0
        || d.max_output_tokens > d.context_window
    {
        return Err("UNSUPPORTED_OPTION: token counts must be positive exact JSON integers; output must not exceed context".into());
    }
    let c = &d.compat;
    if c.protocol != kind {
        return Err("UNSUPPORTED_OPTION: compat protocol mismatch".into());
    }
    use ReasoningEncoding::*;
    let valid_encoding = match kind {
        AiProviderKind::OpenAi => matches!(c.reasoning_encoding, None | Responses),
        AiProviderKind::Ollama => matches!(c.reasoning_encoding, None | Ollama),
        AiProviderKind::OpenAiCompatible => matches!(
            c.reasoning_encoding,
            None | EnableThinking | Thinking | Adaptive | ThinkingEffort | Effort
        ),
        AiProviderKind::AnthropicMessages => {
            matches!(c.reasoning_encoding, None | AnthropicAdaptive)
        }
    };
    if !valid_encoding
        || (c.reasoning_encoding == None && !d.reasoning.is_empty())
        || (!c.native_reasoning && !d.reasoning.is_empty())
    {
        return Err("UNSUPPORTED_OPTION: incompatible reasoning encoding".into());
    }
    if kind != AiProviderKind::OpenAiCompatible
        && (c.cumulative_stream || c.split_reasoning || c.clear_thinking || c.default_thinking)
    {
        return Err("UNSUPPORTED_OPTION: chat compatibility requires chat-completions".into());
    }
    if kind == AiProviderKind::Ollama
        && (c.strict_schema
            || c.parallel_tool_calls
            || c.replay_reasoning_content
            || !c.supports_stream_usage)
    {
        return Err("UNSUPPORTED_OPTION: unsupported Ollama compatibility switch".into());
    }
    if kind == AiProviderKind::OpenAi
        && (!c.native_reasoning
            || c.replay_reasoning_content
            || c.think_tag_fallback
            || !c.supports_stream_usage)
    {
        return Err("UNSUPPORTED_OPTION: unsupported Responses compatibility switch".into());
    }
    if kind == AiProviderKind::AnthropicMessages
        && (c.cumulative_stream
            || !c.supports_stream_usage
            || !c.native_reasoning
            || c.split_reasoning
            || c.replay_reasoning_content
            || c.think_tag_fallback
            || !c.parallel_tool_calls
            || c.strict_schema
            || !c.preserves_reasoning_across_turns
            || c.clear_thinking
            || c.default_thinking)
    {
        return Err(
            "UNSUPPORTED_OPTION: unsupported Anthropic Messages compatibility switch".into(),
        );
    }
    if (c.clear_thinking || c.default_thinking)
        && !matches!(c.reasoning_encoding, Thinking | ThinkingEffort)
    {
        return Err("UNSUPPORTED_OPTION: thinking retention requires a thinking encoding".into());
    }
    let mut ids = std::collections::HashSet::new();
    for option in &d.reasoning {
        if option.id.is_empty()
            || option.display_name.trim().is_empty()
            || !ids.insert(&option.id)
            || !option
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("UNSUPPORTED_OPTION: invalid or duplicate reasoning ID".into());
        }
    }
    if (d.image_input == Support::Supported) != d.vision.is_some() {
        return Err("UNSUPPORTED_OPTION: supported images require an explicit budget".into());
    }
    if let Some(v) = &d.vision {
        // Current immutable projection supports PNG on all three extracted adapters.
        if v.max_request_images == 0
            || v.max_request_images > 20
            || v.max_request_image_bytes == 0
            || v.max_request_image_bytes > 20 * 1024 * 1024
            || v.reserved_tokens_per_image == 0
            || v.reserved_tokens_per_image > d.context_window
            || v.image_token_budget_policy.trim().is_empty()
        {
            return Err("UNSUPPORTED_OPTION: invalid image budget".into());
        }
    }
    Ok(())
}

pub(crate) fn resolve(provider: &AiProviderConfig) -> Result<ResolvedModel, String> {
    validate_profile(provider)?;
    let profile = profile_id(provider)?;
    let definition = match provider.model_definition.as_ref() {
        Some(definition) => definition.clone(),
        None => CATALOG.presets[profile]
            .models
            .get(&provider.model)
            .map(|model| model.resolve(&CATALOG.presets[profile].compat))
            .ok_or_else(|| {
                format!(
                    "UNKNOWN_MODEL: declare capacities and capabilities for {profile}/{}",
                    provider.model
                )
            })?,
    };
    validate_definition(&provider.model, &definition, provider.kind)?;
    if let Some(effort) = &provider.reasoning_effort {
        let id = serde_json::to_value(effort).expect("reasoning ID");
        if !definition.reasoning.iter().any(|o| id == o.id) {
            return Err(format!(
                "UNSUPPORTED_REASONING_EFFORT: Unsupported reasoning option for {profile}/{}",
                provider.model
            ));
        }
    }
    Ok(ResolvedModel {
        catalog_version: CATALOG.version,
        route_id: provider.id.clone(),
        provider_id: provider.id.clone(),
        profile: profile.into(),
        kind: provider.kind,
        model_id: provider.model.clone(),
        source: if provider.model_definition.is_some() {
            "userDeclaration"
        } else {
            "builtinCatalog"
        },
        capacity_policy: if profile == "anthropic" {
            "providerPublished2026-09-05"
        } else {
            "conservativeApplicationBudget"
        },
        endpoint: super::config::endpoint_url(
            provider,
            match provider.kind {
                AiProviderKind::OpenAi => "responses",
                AiProviderKind::OpenAiCompatible => "chat/completions",
                AiProviderKind::Ollama => "api/chat",
                AiProviderKind::AnthropicMessages => "messages",
            },
        )?,
        definition,
    })
}

pub(crate) fn apply_reasoning(
    body: &mut Value,
    model: &ResolvedModel,
    effort: Option<super::config::AiReasoningEffort>,
) {
    let c = &model.compat;
    if c.default_thinking {
        body["thinking"] = json!({"type":"enabled", "clear_thinking": !c.clear_thinking});
    }
    let Some(effort) = effort else {
        return;
    };
    let wire_value = model
        .reasoning
        .iter()
        .find(|o| o.id == effort)
        .and_then(|o| o.wire_value.clone());
    let effort = match wire_value {
        Some(std::option::Option::None) => return,
        Some(Some(value)) => value,
        std::option::Option::None => Value::String(effort),
    };
    let enabled = effort != "off" && effort != "none";
    use ReasoningEncoding::*;
    match c.reasoning_encoding {
        Responses => body["reasoning"] = json!({"effort":effort}),
        EnableThinking => body["enable_thinking"] = json!(enabled),
        Thinking | Adaptive | ThinkingEffort => {
            body["thinking"] = json!({"type": if !enabled {"disabled"} else if c.reasoning_encoding == Adaptive {"adaptive"} else {"enabled"}});
            if c.clear_thinking {
                body["thinking"]["clear_thinking"] = json!(false);
            }
            if enabled && c.reasoning_encoding == ThinkingEffort {
                body["reasoning_effort"] = effort;
            }
        }
        Effort => body["reasoning_effort"] = effort,
        AnthropicAdaptive => {
            body["thinking"] = json!({"type":"adaptive"});
            body["output_config"] = json!({"effort":effort});
        }
        Ollama => {
            body["think"] = if effort == "off" || effort == "on" {
                json!(enabled)
            } else {
                effort
            }
        }
        None => {}
    }
}

/// Draft for explicit user declaration; zero capacities deliberately cannot resolve.
pub(crate) fn declaration_template(provider: &AiProviderConfig) -> Result<ModelDefinition, String> {
    validate_profile(provider)?;
    Ok(ModelDefinition {
        display_name: None,
        context_window: 0,
        max_output_tokens: 0,
        tool_calling: Support::Unknown,
        text_input: Support::Supported,
        image_input: Support::Unknown,
        reasoning: vec![],
        compat: CATALOG.presets[profile_id(provider)?].compat.clone(),
        vision: None,
    })
}
#[cfg(test)]
pub(crate) fn fixture_definition(kind: AiProviderKind, context: u64) -> ModelDefinition {
    let profile = match kind {
        AiProviderKind::OpenAi => "openai",
        AiProviderKind::Ollama => "ollama",
        AiProviderKind::AnthropicMessages => "anthropic",
        _ => "generic",
    };
    let mut compat = CATALOG.presets[profile].compat.clone();
    compat.native_reasoning = true;
    compat.reasoning_encoding = match kind {
        AiProviderKind::OpenAi => ReasoningEncoding::Responses,
        AiProviderKind::Ollama => ReasoningEncoding::Ollama,
        AiProviderKind::AnthropicMessages => ReasoningEncoding::AnthropicAdaptive,
        _ => ReasoningEncoding::Thinking,
    };
    ModelDefinition {
        display_name: None,
        context_window: context,
        max_output_tokens: 4096.min(context / 4),
        tool_calling: Support::Supported,
        text_input: Support::Supported,
        image_input: Support::Unsupported,
        reasoning: vec![ReasoningOption {
            wire_value: None,
            id: "off".into(),
            display_name: "Off".into(),
        }],
        compat,
        vision: None,
    }
}

pub(crate) fn preset_models(
    id: &str,
    kind: AiProviderKind,
) -> Result<BTreeMap<String, ModelDefinition>, String> {
    let preset = CATALOG.presets.get(id).ok_or("UNKNOWN_PROFILE")?;
    if preset.kind != kind {
        return Err("UNSUPPORTED_OPTION: preset protocol mismatch".into());
    }
    Ok(preset
        .models
        .iter()
        .map(|(id, model)| (id.clone(), model.resolve(&preset.compat)))
        .collect())
}
