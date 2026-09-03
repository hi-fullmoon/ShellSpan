//! Shared, versioned provider wire contract. JSON is also imported by the frontend.
use crate::ai::{AiProviderConfig, AiProviderKind};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::LazyLock;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderCapabilities {
    pub kind: AiProviderKind,
    pub hosts: Vec<String>,
    pub cumulative_stream: bool,
    pub supports_stream_usage: bool,
    pub native_reasoning: bool,
    pub split_reasoning: bool,
    pub replay_reasoning_content: bool,
    pub think_tag_fallback: bool,
    pub parallel_tool_calls: bool,
    pub tool_calls: bool,
    pub strict_schema: bool,
    pub context_window: u64,
    pub max_output_tokens: u64,
    pub context_rules: Vec<ContextRule>,
    pub preserves_reasoning_across_turns: bool,
    pub reasoning_rules: Vec<ReasoningRule>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContextRule {
    prefixes: Vec<String>,
    tokens: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReasoningRule {
    prefixes: Vec<String>,
    exclude: Vec<String>,
    pub options: Vec<String>,
    encoding: String,
}
#[derive(Deserialize)]
struct Contract {
    version: u32,
    profiles: BTreeMap<String, ProviderCapabilities>,
}
static CONTRACT: LazyLock<Contract> = LazyLock::new(|| {
    let contract: Contract =
        serde_json::from_str(include_str!("../../../src/lib/provider-contract.json"))
            .expect("valid shared provider contract");
    assert_eq!(contract.version, 1);
    contract
});
pub(crate) fn profile_id(provider: &AiProviderConfig) -> &str {
    if let Some(profile) = &provider.profile {
        return profile;
    }
    match provider.kind {
        AiProviderKind::OpenAi => "openai",
        AiProviderKind::Ollama => "ollama",
        AiProviderKind::OpenAiCompatible => {
            let host = reqwest::Url::parse(provider.base_url.trim())
                .ok()
                .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
                .unwrap_or_default();
            CONTRACT
                .profiles
                .iter()
                .find(|(_, caps)| {
                    caps.hosts.iter().any(|h| {
                        if h.starts_with('.') {
                            host.ends_with(h)
                        } else {
                            host == *h
                        }
                    })
                })
                .map_or("generic", |(id, _)| id.as_str())
        }
    }
}
pub(crate) fn capabilities(provider: &AiProviderConfig) -> &'static ProviderCapabilities {
    CONTRACT
        .profiles
        .get(profile_id(provider))
        .unwrap_or(&CONTRACT.profiles["generic"])
}
fn reasoning_rule(provider: &AiProviderConfig) -> Option<&'static ReasoningRule> {
    let model = provider.model.trim().to_ascii_lowercase();
    capabilities(provider).reasoning_rules.iter().find(|rule| {
        rule.prefixes.iter().any(|prefix| {
            model == *prefix
                || ['-', '.', ':']
                    .iter()
                    .any(|separator| model.starts_with(&format!("{prefix}{separator}")))
        }) && !rule.exclude.iter().any(|part| model.contains(part))
    })
}
pub(crate) fn validate(provider: &AiProviderConfig) -> Result<(), String> {
    if !CONTRACT.profiles.contains_key(profile_id(provider)) {
        return Err("Unknown provider profile".into());
    }
    if capabilities(provider).kind != provider.kind {
        return Err("Provider profile does not match protocol".into());
    }
    if let Some(effort) = provider.reasoning_effort {
        let effort = serde_json::to_value(effort).expect("effort");
        if !reasoning_rule(provider)
            .is_some_and(|rule| rule.options.iter().any(|option| effort == *option))
        {
            return Err(format!(
                "Unsupported reasoning option for {}/{}",
                profile_id(provider),
                provider.model
            ));
        }
    }
    Ok(())
}
pub(crate) fn apply_reasoning(body: &mut Value, provider: &AiProviderConfig) {
    if profile_id(provider) == "glm" && reasoning_rule(provider).is_some() {
        body["thinking"] = json!({"type": "enabled", "clear_thinking": false});
    }
    let (Some(effort), Some(rule)) = (provider.reasoning_effort, reasoning_rule(provider)) else {
        return;
    };
    let effort = serde_json::to_value(effort).expect("effort");
    if !rule.options.iter().any(|option| effort == *option) {
        return;
    }
    let enabled = effort != "off" && effort != "none";
    match rule.encoding.as_str() {
        "responses" => body["reasoning"] = json!({"effort": effort}),
        "enableThinking" => body["enable_thinking"] = json!(enabled),
        "thinking" | "adaptive" | "thinkingEffort" => {
            body["thinking"] = json!({"type": if !enabled { "disabled" } else if rule.encoding == "adaptive" { "adaptive" } else { "enabled" }});
            if profile_id(provider) == "glm" {
                body["thinking"]["clear_thinking"] = json!(false);
            }
            if enabled && rule.encoding == "thinkingEffort" {
                body["reasoning_effort"] = effort;
            }
        }
        "effort" => body["reasoning_effort"] = effort,
        "ollama" => {
            body["think"] = if effort == "off" || effort == "on" {
                json!(enabled)
            } else {
                effort
            }
        }
        _ => {}
    }
}

pub(crate) fn context_window(provider: &AiProviderConfig) -> u64 {
    let caps = capabilities(provider);
    let model = provider.model.trim().to_ascii_lowercase();
    caps.context_rules
        .iter()
        .find(|rule| rule.prefixes.iter().any(|prefix| model.starts_with(prefix)))
        .map_or(caps.context_window, |rule| rule.tokens)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_frontend_fixtures_validate_and_encode_official_wire_shapes() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../../src/lib/__tests__/provider-contract-fixtures.json"
        ))
        .unwrap();
        for fixture in fixtures {
            let provider: AiProviderConfig =
                serde_json::from_value(fixture["provider"].clone()).unwrap();
            validate(&provider).unwrap();
            assert_eq!(
                profile_id(&provider),
                fixture["provider"]["profile"].as_str().unwrap()
            );
            let mut body = json!({});
            apply_reasoning(&mut body, &provider);
            assert_eq!(body, fixture["reasoningBody"], "{}", provider.model);
        }
    }
    #[test]
    fn unsupported_efforts_and_profile_protocol_mismatch_fail_before_network() {
        let mut provider: AiProviderConfig = serde_json::from_value(json!({"id":"x","profile":"qwen","kind":"openAiCompatible","baseUrl":"https://proxy.example/v1","model":"qwen3-thinking","requiresApiKey":false,"reasoningEffort":"off"})).unwrap();
        assert!(validate(&provider).unwrap_err().contains("Unsupported"));
        provider.reasoning_effort = None;
        provider.profile = Some("openai".into());
        assert!(validate(&provider).unwrap_err().contains("protocol"));
        provider.profile = Some("unknown".into());
        assert!(validate(&provider).unwrap_err().contains("Unknown"));
    }
    #[test]
    fn json_contract_round_trips_without_missing_capabilities() {
        let raw: Value =
            serde_json::from_str(include_str!("../../../src/lib/provider-contract.json")).unwrap();
        for (id, caps) in &CONTRACT.profiles {
            assert_eq!(serde_json::to_value(caps).unwrap(), raw["profiles"][id]);
        }
    }
}
