//! Provider model discovery; results are candidates and do not declare capabilities.
use super::{
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

fn discovered(item: &Value, id_field: &str) -> Option<DiscoveredModel> {
    let id = item.get(id_field)?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    Some(DiscoveredModel {
        id: id.to_string(),
        name: optional_text(item, &["name", "displayName", "display_name"])
            .filter(|name| name != id),
        context_window: optional_count(item, &["contextWindow", "context_window"]),
        max_output_tokens: optional_count(
            item,
            &[
                "maxOutputTokens",
                "max_output_tokens",
                "maxTokens",
                "max_tokens",
            ],
        ),
    })
}

pub(crate) async fn list_models(
    provider: &AiProviderConfig,
    api_key: Option<String>,
) -> Result<Vec<DiscoveredModel>, String> {
    let client = build_client()?;
    let response = match provider.kind {
        AiProviderKind::Ollama => client
            .get(endpoint_url(&provider, "api/tags")?)
            .send()
            .await
            .map_err(format_transport_error)?,
        AiProviderKind::OpenAi | AiProviderKind::OpenAiCompatible => {
            let request = client.get(endpoint_url(&provider, "models")?);
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
    let models = match provider.kind {
        AiProviderKind::Ollama => value
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| discovered(item, "name"))
            .collect::<Vec<_>>(),
        AiProviderKind::OpenAi
        | AiProviderKind::OpenAiCompatible
        | AiProviderKind::AnthropicMessages => value
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| discovered(item, "id"))
            .collect::<Vec<_>>(),
    };
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
            list_models(&provider, None).await.unwrap_err(),
            "MISSING_CREDENTIAL"
        );
        assert_eq!(
            list_models(&provider, Some("stage-e-secret".into()))
                .await
                .unwrap(),
            vec![
                DiscoveredModel {
                    id: "claude-opus-5".into(),
                    name: None,
                    context_window: None,
                    max_output_tokens: None,
                },
                DiscoveredModel {
                    id: "claude-sonnet-5".into(),
                    name: Some("Claude Sonnet".into()),
                    context_window: Some(1_000_000),
                    max_output_tokens: Some(128_000),
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
