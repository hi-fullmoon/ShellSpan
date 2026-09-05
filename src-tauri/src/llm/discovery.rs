//! Legacy model discovery; results are candidates and do not declare capabilities.
use super::{
    config::{endpoint_url, AiProviderConfig, AiProviderKind},
    transport::{build_client, checked_json, format_transport_error},
};
use serde_json::Value;

pub(crate) async fn list_models(
    provider: &AiProviderConfig,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
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
    let mut models = match provider.kind {
        AiProviderKind::Ollama => value
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect::<Vec<_>>(),
        AiProviderKind::OpenAi
        | AiProviderKind::OpenAiCompatible
        | AiProviderKind::AnthropicMessages => value
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect::<Vec<_>>(),
    };
    models.sort();
    models.dedup();
    Ok(models)
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
            let body = r#"{"data":[{"id":"claude-sonnet-5"},{"id":"claude-opus-5"}]}"#;
            write!(socket, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
            received
        });
        let provider = AiProviderConfig {
            model_definition: None,
            retry_policy: None,
            profile: Some("anthropic".into()),
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
            vec!["claude-opus-5", "claude-sonnet-5"],
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
