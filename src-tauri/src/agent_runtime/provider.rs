//! Compatibility names for legacy tests; runtime facts live in llm::catalog.
#[cfg(test)]
use crate::ai::AiProviderConfig;
#[cfg(test)]
pub(crate) use crate::llm::catalog::legacy_profile as profile_id;
#[cfg(test)]
fn validate(p: &AiProviderConfig) -> Result<(), String> {
    crate::llm::catalog::resolve(p).map(|_| ())
}
#[cfg(test)]
fn apply_reasoning(body: &mut serde_json::Value, p: &AiProviderConfig) {
    crate::llm::config::apply_reasoning_effort(body, p);
}
#[cfg(test)]
use serde_json::{json, Value};
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_frontend_fixtures_validate_and_encode_official_wire_shapes() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../../src/lib/ai/__tests__/provider-contract-fixtures.json"
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
        let mut provider: AiProviderConfig = serde_json::from_value(json!({"id":"x","profile":"qwen","kind":"openAiCompatible","baseUrl":"https://proxy.example/v1","model":"qwen3-thinking-2507","requiresApiKey":false,"reasoningEffort":"off"})).unwrap();
        assert!(validate(&provider).unwrap_err().contains("Unsupported"));
        provider.reasoning_effort = None;
        provider.profile = Some("openai".into());
        assert!(validate(&provider).unwrap_err().contains("protocol"));
        provider.profile = Some("unknown".into());
        assert!(validate(&provider).unwrap_err().contains("Unknown"));
    }
}
