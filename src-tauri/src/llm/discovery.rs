//! Provider model discovery; results are candidates and do not declare capabilities.
use super::{
    catalog::{self, ModelDefinition, ReasoningEncoding, ReasoningOption, Support, VisionBudget},
    config::{endpoint_url, AiProviderConfig, AiProviderKind},
    transport::{build_client, checked_json, format_transport_error},
};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveredModel {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    definition: Option<ModelDefinition>,
}

fn optional_text(item: &Value, fields: &[&str]) -> Option<String> {
    fields
        .iter()
        .find_map(|field| item.get(field).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn optional_count(item: &Value, fields: &[&str]) -> Option<u64> {
    fields
        .iter()
        .find_map(|field| item.get(field).and_then(Value::as_u64))
        .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
}

fn has_string(items: &[Value], expected: &str) -> bool {
    items.iter().any(|value| value.as_str() == Some(expected))
}

fn openrouter_definition(
    provider: &AiProviderConfig,
    item: &Value,
    name: &Option<String>,
    context_window: Option<u64>,
    max_output_tokens: Option<u64>,
) -> Option<ModelDefinition> {
    if provider.profile != "openrouter" {
        return None;
    }
    let mut definition = catalog::declaration_template(provider).ok()?;
    definition.display_name = name.clone();
    definition.context_window = context_window.unwrap_or(definition.context_window);
    definition.max_output_tokens = max_output_tokens
        .unwrap_or(definition.max_output_tokens)
        .min(definition.context_window);

    if let Some(parameters) = item.get("supported_parameters").and_then(Value::as_array) {
        definition.tool_calling = if has_string(parameters, "tools") {
            Support::Supported
        } else {
            Support::Unsupported
        };
        if has_string(parameters, "reasoning_effort") {
            definition.compat.native_reasoning = true;
            definition.compat.reasoning_encoding = ReasoningEncoding::Effort;
            definition.reasoning = ["low", "medium", "high"]
                .into_iter()
                .map(|id| ReasoningOption {
                    id: id.into(),
                    display_name: id[..1].to_uppercase() + &id[1..],
                    wire_value: None,
                })
                .collect();
        }
    }

    if let Some(modalities) = item
        .get("architecture")
        .and_then(|architecture| architecture.get("input_modalities"))
        .and_then(Value::as_array)
    {
        definition.text_input = if has_string(modalities, "text") {
            Support::Supported
        } else {
            Support::Unsupported
        };
        if has_string(modalities, "image") {
            definition.image_input = Support::Supported;
            definition.vision = Some(VisionBudget {
                max_request_images: 20,
                max_request_image_bytes: 20 * 1024 * 1024,
                reserved_tokens_per_image: 4096.min(definition.context_window),
                image_token_budget_policy: "Application admission estimate of 4096 tokens per image after normalization; OpenRouter reports the modality but not a request token estimate.".into(),
            });
        }
    }
    Some(definition)
}

fn discovered(
    provider: &AiProviderConfig,
    item: &Value,
    id_field: &str,
) -> Option<DiscoveredModel> {
    if provider.profile == "openrouter"
        && item
            .get("expiration_date")
            .is_some_and(|value| !value.is_null())
    {
        return None;
    }
    let id = item.get(id_field)?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let name =
        optional_text(item, &["name", "displayName", "display_name"]).filter(|name| name != id);
    let context_window =
        optional_count(item, &["contextWindow", "context_window", "context_length"]);
    let max_output_tokens = optional_count(
        item,
        &[
            "maxOutputTokens",
            "max_output_tokens",
            "maxTokens",
            "max_tokens",
            "max_completion_tokens",
        ],
    )
    .or_else(|| {
        item.get("top_provider")
            .and_then(|provider| optional_count(provider, &["max_completion_tokens"]))
    });
    let definition =
        openrouter_definition(provider, item, &name, context_window, max_output_tokens);
    Some(DiscoveredModel {
        id: id.to_string(),
        name,
        context_window,
        max_output_tokens,
        definition,
    })
}

pub(crate) fn catalog_models(
    provider: &AiProviderConfig,
) -> Result<Option<Vec<DiscoveredModel>>, String> {
    // Built-in declarations supply capabilities for known IDs and a fallback
    // when the endpoint cannot provide a listing. They do not replace discovery.
    if provider.kind != AiProviderKind::Ollama && provider.profile != "generic" {
        let models = catalog::preset_models(&provider.profile, provider.kind)?;
        if !models.is_empty() {
            return Ok(Some(
                models
                    .into_iter()
                    .map(|(id, definition)| DiscoveredModel {
                        id,
                        name: definition.display_name.clone(),
                        context_window: Some(definition.context_window),
                        max_output_tokens: Some(definition.max_output_tokens),
                        definition: Some(definition),
                    })
                    .collect(),
            ));
        }
    }
    Ok(None)
}

pub(crate) async fn list_models(
    provider: &AiProviderConfig,
    api_key: Option<String>,
) -> Result<Vec<DiscoveredModel>, String> {
    let builtin = catalog_models(provider)?.unwrap_or_default();
    let remote = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        list_endpoint_models(provider, api_key),
    )
    .await
    .unwrap_or_else(|_| Err("MODEL_DISCOVERY_TIMEOUT".into()));
    match remote {
        Ok(remote) => {
            log::info!(
                "Model discovery: received {} endpoint candidates; merging {} built-in candidates",
                remote.len(),
                builtin.len()
            );
            Ok(merge_models(builtin, remote))
        }
        Err(_) if !builtin.is_empty() => {
            log::warn!(
                "Model discovery endpoint failed; falling back to {} built-in candidates",
                builtin.len()
            );
            Ok(builtin)
        }
        Err(error) => Err(error),
    }
}

fn merge_models(
    builtin: Vec<DiscoveredModel>,
    remote: Vec<DiscoveredModel>,
) -> Vec<DiscoveredModel> {
    let mut models: BTreeMap<_, _> = remote
        .into_iter()
        .map(|model| (model.id.clone(), model))
        .collect();
    // An ID-only listing cannot override reviewed capacities or capabilities.
    // New IDs retain only the metadata actually supplied by the endpoint.
    for model in builtin {
        models.insert(model.id.clone(), model);
    }
    models.into_values().collect()
}

async fn list_endpoint_models(
    provider: &AiProviderConfig,
    api_key: Option<String>,
) -> Result<Vec<DiscoveredModel>, String> {
    let client = build_client()?;
    let response = match provider.kind {
        AiProviderKind::Ollama => client
            .get(endpoint_url(provider, "api/tags")?)
            .send()
            .await
            .map_err(format_transport_error)?,
        AiProviderKind::OpenAi | AiProviderKind::OpenAiCompatible => {
            let request = client.get(endpoint_url(provider, "models")?);
            let request = if let Some(api_key) = api_key {
                request.bearer_auth(api_key)
            } else {
                request
            };
            request.send().await.map_err(format_transport_error)?
        }
        AiProviderKind::AnthropicMessages => {
            let api_key = api_key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "MISSING_CREDENTIAL".to_string())?;
            let mut request = client
                .get(endpoint_url(provider, "models")?)
                .header("anthropic-version", "2023-06-01");
            request = request.header("x-api-key", api_key);
            request.send().await.map_err(format_transport_error)?
        }
    };
    let value = checked_json(response).await?;
    let (field, id_field) = match provider.kind {
        AiProviderKind::Ollama => ("models", "name"),
        AiProviderKind::OpenAi
        | AiProviderKind::OpenAiCompatible
        | AiProviderKind::AnthropicMessages => ("data", "id"),
    };
    let entries = value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| "MODEL_DISCOVERY_INVALID_RESPONSE: missing model array".to_string())?;
    let models = entries
        .iter()
        .filter_map(|item| discovered(provider, item, id_field));
    let mut unique = BTreeMap::new();
    for model in models {
        unique.entry(model.id.clone()).or_insert(model);
    }
    Ok(unique.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::{Ipv4Addr, TcpListener},
        thread,
    };

    fn minimax_provider() -> AiProviderConfig {
        serde_json::from_value(serde_json::json!({
            "id": "minimax", "profile": "minimax", "kind": "openAiCompatible",
            "baseUrl": "https://api.minimaxi.com/v1", "model": "MiniMax-M3",
            "requiresApiKey": false
        }))
        .unwrap()
    }

    #[test]
    fn merging_preserves_reviewed_capabilities_and_new_id_metadata() {
        let provider = minimax_provider();
        let mut builtin = catalog_models(&provider).unwrap().unwrap();
        let flash = builtin.remove(
            builtin
                .iter()
                .position(|m| m.id == "MiniMax-M3.1-Flash")
                .unwrap(),
        );
        let m3 = builtin
            .iter()
            .find(|m| m.id == "MiniMax-M3")
            .unwrap()
            .clone();
        let remote_m3 =
            discovered(&provider, &serde_json::json!({"id": "MiniMax-M3"}), "id").unwrap();
        let remote_flash = discovered(
            &provider,
            &serde_json::json!({
                "id": flash.id, "context_window": flash.context_window,
                "max_output_tokens": flash.max_output_tokens
            }),
            "id",
        )
        .unwrap();
        let merged = merge_models(builtin.clone(), vec![remote_m3, remote_flash.clone()]);
        assert_eq!(merged.len(), builtin.len() + 1);
        assert_eq!(merged.iter().find(|m| m.id == m3.id), Some(&m3));
        assert_eq!(
            merged.iter().find(|m| m.id == flash.id),
            Some(&remote_flash)
        );
        assert!(remote_flash.definition.is_none());
        assert_eq!(merge_models(builtin.clone(), vec![]), builtin);
    }

    #[tokio::test]
    async fn refused_endpoint_falls_back_only_when_a_builtin_catalog_exists() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let mut provider = minimax_provider();
        provider.base_url = format!("http://{address}/v1");
        let builtin = catalog_models(&provider).unwrap().unwrap();
        assert_eq!(list_models(&provider, None).await.unwrap(), builtin);
        provider.profile = "generic".into();
        assert!(list_models(&provider, None).await.is_err());
    }

    #[tokio::test]
    #[ignore = "requires external access to OpenRouter's public model listing"]
    async fn live_public_gateway_merges_remote_models_with_curated_profile() {
        let mut provider = minimax_provider();
        provider.base_url = "https://openrouter.ai/api/v1".into();
        let builtin = catalog_models(&provider).unwrap().unwrap();
        let models = list_models(&provider, None).await.unwrap();
        assert!(
            models.len() > builtin.len(),
            "endpoint models must extend the catalog"
        );
        for model in builtin {
            assert_eq!(models.iter().find(|m| m.id == model.id), Some(&model));
        }
        assert!(models
            .iter()
            .any(|m| m.id.contains('/') && m.definition.is_none()));
    }

    #[test]
    fn curated_cloud_discovery_uses_the_capability_catalog() {
        let provider = AiProviderConfig {
            model_definition: None,
            retry_policy: None,
            profile: "deepseek".into(),
            id: "deepseek-discovery".into(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "https://unreachable.invalid".into(),
            model: "deepseek-flash".into(),
            reasoning_effort: None,
            requires_api_key: true,
            api_key: None,
        };

        let models = catalog_models(&provider).unwrap().unwrap();
        assert!(models.iter().any(|model| model.id == "deepseek-flash"));
        assert!(models.iter().any(|model| model.id == "deepseek-v4-pro"));
        for retired in [
            "deepseek-chat",
            "deepseek-reasoner",
            "deepseek-v4-flash",
            "deepseek-v4-flash-vision-exp",
        ] {
            assert!(!models.iter().any(|model| model.id == retired));
        }
        assert!(models
            .iter()
            .all(|model| { model.context_window.is_some() && model.max_output_tokens.is_some() }));
    }

    #[tokio::test]
    async fn openrouter_discovery_reads_router_capacity_fields() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let count = socket.read(&mut request).unwrap();
            let received = String::from_utf8_lossy(&request[..count]).into_owned();
            let body = r#"{"data":[{"id":"deepseek/deepseek-flash","name":"DeepSeek Flash","context_length":1048576,"top_provider":{"max_completion_tokens":384000},"supported_parameters":["tools","reasoning_effort"],"architecture":{"input_modalities":["text"]},"expiration_date":null},{"id":"vision/model","context_length":131072,"supported_parameters":[],"architecture":{"input_modalities":["text","image"]},"expiration_date":null},{"id":"retired/model","context_length":8192,"expiration_date":"2026-01-01"}]}"#;
            write!(socket, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
            received
        });
        let provider = AiProviderConfig {
            model_definition: None,
            retry_policy: None,
            profile: "openrouter".into(),
            id: "openrouter-discovery".into(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: format!("http://{address}/api/v1"),
            model: String::new(),
            reasoning_effort: None,
            requires_api_key: true,
            api_key: None,
        };

        let models = list_models(&provider, Some("router-key".into()))
            .await
            .unwrap();
        assert_eq!(models.len(), 2);
        let model = models
            .iter()
            .find(|model| model.id == "deepseek/deepseek-flash")
            .unwrap();
        assert_eq!(model.id, "deepseek/deepseek-flash");
        assert_eq!(model.name.as_deref(), Some("DeepSeek Flash"));
        assert_eq!(model.context_window, Some(1_048_576));
        assert_eq!(model.max_output_tokens, Some(384_000));
        let definition = model.definition.as_ref().unwrap();
        assert_eq!(definition.tool_calling, Support::Supported);
        assert_eq!(definition.text_input, Support::Supported);
        assert_eq!(definition.image_input, Support::Unsupported);
        assert_eq!(
            definition
                .reasoning
                .iter()
                .map(|option| option.id.as_str())
                .collect::<Vec<_>>(),
            vec!["low", "medium", "high"]
        );
        assert_eq!(
            definition.compat.reasoning_encoding,
            ReasoningEncoding::Effort
        );
        let vision = models
            .iter()
            .find(|model| model.id == "vision/model")
            .and_then(|model| model.definition.as_ref())
            .unwrap();
        assert_eq!(vision.tool_calling, Support::Unsupported);
        assert_eq!(vision.image_input, Support::Supported);
        assert!(vision.vision.is_some());
        assert!(!models.iter().any(|model| model.id == "retired/model"));
        let wire = server.join().unwrap();
        assert!(wire.starts_with("GET /api/v1/models HTTP/1.1"));
        assert!(wire
            .to_ascii_lowercase()
            .contains("authorization: bearer router-key"));
    }

    #[tokio::test]
    async fn anthropic_discovery_uses_models_endpoint_and_stable_headers() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let count = socket.read(&mut request).unwrap();
            let received = String::from_utf8_lossy(&request[..count]).into_owned();
            let body = r#"{"data":[{"id":"claude-sonnet-5","name":"Claude Sonnet","context_window":1000000,"max_output_tokens":128000},{"id":"claude-opus-5"}]}"#;
            write!(socket, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
            received
        });
        let provider = AiProviderConfig {
            model_definition: None,
            retry_policy: None,
            profile: "anthropic".into(),
            id: "anthropic-discovery".into(),
            kind: AiProviderKind::AnthropicMessages,
            base_url: format!("http://{address}"),
            model: "claude-sonnet-5".into(),
            reasoning_effort: None,
            requires_api_key: true,
            api_key: None,
        };
        assert_eq!(
            list_endpoint_models(&provider, None).await.unwrap_err(),
            "MISSING_CREDENTIAL"
        );
        assert_eq!(
            list_endpoint_models(&provider, Some("stage-e-secret".into()))
                .await
                .unwrap(),
            vec![
                DiscoveredModel {
                    id: "claude-opus-5".into(),
                    name: None,
                    context_window: None,
                    max_output_tokens: None,
                    definition: None,
                },
                DiscoveredModel {
                    id: "claude-sonnet-5".into(),
                    name: Some("Claude Sonnet".into()),
                    context_window: Some(1_000_000),
                    max_output_tokens: Some(128_000),
                    definition: None,
                },
            ],
        );
        let wire = server.join().unwrap();
        let lower = wire.to_ascii_lowercase();
        assert!(wire.starts_with("GET /v1/models HTTP/1.1"));
        assert!(!wire.starts_with("GET /v1/messages"));
        assert!(lower.contains("x-api-key: stage-e-secret"));
        assert!(lower.contains("anthropic-version: 2023-06-01"));
        assert!(!lower.contains("authorization:"));
    }
}
