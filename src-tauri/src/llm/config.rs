//! Legacy provider DTO and compatibility helpers, retained until stages B/C.
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AiProviderKind {
    Ollama,
    OpenAi,
    OpenAiCompatible,
    AnthropicMessages,
}

pub(crate) type AiReasoningEffort = String;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AiProviderConfig {
    #[serde(default)]
    pub(crate) model_definition: Option<super::catalog::ModelDefinition>,
    #[serde(
        default,
        deserialize_with = "crate::agent_runtime::RetryPolicy::deserialize_optional"
    )]
    pub(crate) retry_policy: Option<crate::agent_runtime::RetryPolicy>,
    #[serde(default)]
    pub(crate) profile: Option<String>,
    pub(crate) id: String,
    pub(crate) kind: AiProviderKind,
    pub(crate) base_url: String,
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) reasoning_effort: Option<AiReasoningEffort>,
    pub(crate) requires_api_key: bool,
    #[serde(default)]
    pub(crate) api_key: Option<String>,
}

pub(crate) fn validate_provider_config(
    provider: &AiProviderConfig,
    require_model: bool,
) -> Result<(), String> {
    validate_provider_id(&provider.id)?;
    if let Some(policy) = provider.retry_policy {
        policy.validate()?;
    }
    super::catalog::validate_profile(provider)?;
    if require_model {
        super::catalog::resolve(provider)?;
    }
    if require_model && provider.model.trim().is_empty() {
        return Err("AI model cannot be empty".to_string());
    }
    let url = Url::parse(provider.base_url.trim())
        .map_err(|_| "AI provider URL is invalid".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("AI provider URL cannot contain credentials".to_string());
    }
    match url.scheme() {
        "https" => Ok(()),
        "http" if is_loopback_host(url.host_str()) => Ok(()),
        _ => Err("AI provider URL must use HTTPS; HTTP is only allowed for localhost".to_string()),
    }
}

pub(crate) fn validate_provider_id(provider_id: &str) -> Result<(), String> {
    if provider_id.is_empty()
        || provider_id.len() > 80
        || !provider_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("AI provider id is invalid".to_string());
    }
    Ok(())
}

fn is_loopback_host(host: Option<&str>) -> bool {
    // `url::Url::host_str` has returned both bracketed and unbracketed IPv6
    // literals across dependency versions. Keep the allow-list exact while
    // accepting the canonical loopback spelling in either representation.
    matches!(host, Some("localhost" | "127.0.0.1" | "::1" | "[::1]"))
}

#[cfg(test)]
pub(crate) fn apply_reasoning_effort(body: &mut Value, provider: &AiProviderConfig) {
    let model = super::catalog::resolve(provider).expect("valid reasoning fixture");
    super::catalog::apply_reasoning(body, &model, provider.reasoning_effort.clone());
}

pub(crate) fn apply_output_token_limit(
    body: &mut Value,
    kind: AiProviderKind,
    max_output_tokens: u64,
) {
    match kind {
        AiProviderKind::OpenAi => body["max_output_tokens"] = json!(max_output_tokens),
        AiProviderKind::OpenAiCompatible => body["max_tokens"] = json!(max_output_tokens),
        AiProviderKind::AnthropicMessages => body["max_tokens"] = json!(max_output_tokens),
        AiProviderKind::Ollama => {
            if !body.get("options").is_some_and(Value::is_object) {
                body["options"] = json!({});
            }
            body["options"]["num_predict"] = json!(max_output_tokens);
        }
    }
}

pub(crate) fn endpoint_url(provider: &AiProviderConfig, path: &str) -> Result<Url, String> {
    validate_provider_config(provider, false)?;
    let mut url = Url::parse(provider.base_url.trim())
        .map_err(|_| "failed to build AI provider endpoint".to_string())?;
    let is_official_deepseek = matches!(provider.kind, AiProviderKind::OpenAiCompatible)
        && url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("api.deepseek.com"));
    let is_official_glm = matches!(provider.kind, AiProviderKind::OpenAiCompatible)
        && url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("open.bigmodel.cn"));
    let mut base_path = url.path().trim_end_matches('/').to_string();
    let mut had_endpoint = false;
    for endpoint_suffix in [
        "/chat/completions",
        "/responses",
        "/models",
        "/api/chat",
        "/api/tags",
        "/api/show",
        "/messages",
    ] {
        if let Some(api_root) = base_path.strip_suffix(endpoint_suffix) {
            base_path = api_root.to_string();
            had_endpoint = true;
            break;
        }
    }
    if is_official_deepseek && base_path == "/v1" {
        base_path.clear();
    } else if is_official_glm {
        if base_path.is_empty() || base_path == "/v1" {
            base_path = "/api/paas/v4".to_string();
        }
    } else if !had_endpoint
        && !matches!(provider.kind, AiProviderKind::Ollama)
        && !base_path.ends_with("/v1")
    {
        base_path = format!("{}/v1", base_path.trim_end_matches('/'));
    }
    url.set_fragment(None);
    url.set_path(&format!(
        "{}/{}",
        base_path.trim_end_matches('/'),
        path.trim_start_matches('/'),
    ));
    Ok(url)
}

/// Only the existing ai.providers setting is a declaration source during v4 recovery.
#[cfg(test)]
pub(crate) fn restore_model_definition(
    provider: &mut AiProviderConfig,
    preferences: &[(String, String)],
) -> Result<(), String> {
    if provider.model_definition.is_some() {
        return Ok(());
    }
    let Some((_, raw)) = preferences.iter().find(|(key, _)| key == "ai.providers") else {
        return Ok(());
    };
    let values: Vec<Value> =
        serde_json::from_str(raw).map_err(|e| format!("invalid ai.providers: {e}"))?;
    let matches: Vec<_> = values
        .iter()
        .filter(|value| {
            value["id"] == provider.id
                && value["kind"] == serde_json::to_value(provider.kind).unwrap()
                && value["baseUrl"] == provider.base_url
                && value["model"] == provider.model
        })
        .collect();
    if matches.len() > 1 {
        return Err("UNSUPPORTED_OPTION: ambiguous persisted model declaration".into());
    }
    if let Some(value) = matches.first() {
        // A changed explicit profile changes compatibility identity too.
        if value.get("profile").and_then(Value::as_str) != provider.profile.as_deref() {
            return Ok(());
        }
        if let Some(definition) = value.get("modelDefinition").filter(|d| !d.is_null()) {
            provider.model_definition = Some(
                serde_json::from_value(definition.clone())
                    .map_err(|e| format!("invalid model declaration: {e}"))?,
            );
        }
    }
    Ok(())
}
