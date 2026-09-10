#[cfg(test)]
use crate::keychain::{CredentialManager, AI_KEY_SERVICE};
pub(crate) use crate::llm::config::{validate_provider_config, AiProviderConfig};
#[cfg(test)]
pub(crate) use crate::llm::config::{AiProviderKind, AiReasoningEffort};
#[cfg(test)]
use serde_json::Value;
use std::collections::BTreeMap;
use tauri::State;
#[cfg(test)]
trait AiCredentialStore {
    fn get_api_key(&self, provider_id: &str) -> Result<Option<String>, String>;
}

#[cfg(test)]
impl AiCredentialStore for CredentialManager {
    fn get_api_key(&self, provider_id: &str) -> Result<Option<String>, String> {
        self.get_credential(AI_KEY_SERVICE, provider_id)
    }
}

#[tauri::command]
pub(crate) fn ai_list_routes(
    runtime: State<'_, crate::llm::runtime::LlmRuntime>,
) -> Result<crate::llm::routes::RouteSnapshot, String> {
    Ok(runtime.routes.snapshot()?.as_ref().clone())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveRouteDocumentInput {
    routes: Vec<crate::llm::routes::ProviderRoute>,
    #[serde(default)]
    default_selection: Option<crate::llm::routes::ModelSelection>,
    expected_revision: u64,
    #[serde(default)]
    secrets: BTreeMap<String, String>,
}

#[tauri::command]
pub(crate) fn ai_save_routes(
    runtime: State<'_, crate::llm::runtime::LlmRuntime>,
    input: SaveRouteDocumentInput,
) -> Result<crate::llm::routes::RouteSnapshot, String> {
    Ok(runtime
        .routes
        .save(
            input.routes,
            input.default_selection,
            input.expected_revision,
            input.secrets,
        )?
        .as_ref()
        .clone())
}

#[tauri::command]
pub(crate) fn ai_list_route_models(
    runtime: State<'_, crate::llm::runtime::LlmRuntime>,
    route_id: String,
) -> Result<RouteModelsResult, String> {
    let snapshot = runtime.routes.snapshot()?;
    let route = snapshot.route(&route_id)?;
    let mut model_ids = route.model_catalog()?.into_keys().collect::<Vec<_>>();
    for selection in [route.defaults.as_ref(), snapshot.default_selection.as_ref()]
        .into_iter()
        .flatten()
        .filter(|selection| selection.route_id == route_id)
    {
        if !model_ids.contains(&selection.model_id) {
            model_ids.push(selection.model_id.clone());
        }
    }
    let models = model_ids
        .iter()
        .map(|model_id| {
            crate::llm::catalog::resolve(&route.provider(&crate::llm::routes::ModelSelection {
                route_id: route_id.clone(),
                model_id: model_id.clone(),
                reasoning_effort: None,
            })?)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RouteModelsResult {
        revision: snapshot.revision,
        models,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouteModelsResult {
    revision: u64,
    models: Vec<crate::llm::catalog::ResolvedModel>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResolveSelectionInput {
    selection: crate::llm::routes::ModelSelection,
    expected_revision: u64,
}

#[tauri::command]
pub(crate) fn ai_resolve_selection(
    runtime: State<'_, crate::llm::runtime::LlmRuntime>,
    input: ResolveSelectionInput,
) -> Result<crate::llm::catalog::ResolvedModel, String> {
    let snapshot = runtime.routes.snapshot()?;
    let route = snapshot.route(&input.selection.route_id)?;
    if route.revision != input.expected_revision {
        return Err("REVISION_CONFLICT".into());
    }
    crate::llm::catalog::resolve(&route.provider(&input.selection)?)
}

#[tauri::command]
pub(crate) async fn ai_list_models(
    runtime: State<'_, crate::llm::runtime::LlmRuntime>,
    provider: AiProviderConfig,
) -> Result<Vec<crate::llm::discovery::DiscoveredModel>, String> {
    validate_provider_config(&provider, false)?;
    if let Some(models) = crate::llm::discovery::catalog_models(&provider)? {
        return Ok(models);
    }
    let temporary = provider
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let api_key = if temporary.is_some() {
        temporary
    } else {
        let snapshot = runtime.routes.snapshot()?;
        match snapshot.routes.iter().find(|route| route.id == provider.id) {
            Some(route) => runtime.routes.credential(route)?,
            None if provider.requires_api_key => return Err("MISSING_CREDENTIAL".into()),
            None => None,
        }
    };
    crate::llm::discovery::list_models(&provider, api_key).await
}

#[cfg(test)]
fn api_key_from_store(
    credentials: &impl AiCredentialStore,
    provider: &AiProviderConfig,
) -> Result<Option<String>, String> {
    let api_key = credentials
        .get_api_key(&provider.id)?
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());
    match provider.kind {
        AiProviderKind::Ollama => Ok(None),
        AiProviderKind::OpenAi => api_key
            .map(Some)
            .ok_or_else(|| "API key is required".to_string()),
        AiProviderKind::OpenAiCompatible => {
            if provider.requires_api_key && api_key.is_none() {
                Err("API key is required".to_string())
            } else {
                Ok(api_key)
            }
        }
        AiProviderKind::AnthropicMessages => api_key
            .map(Some)
            .ok_or_else(|| "API key is required".to_string()),
    }
}

#[cfg(test)]
pub(crate) fn api_key_for_provider(
    credentials: &CredentialManager,
    provider: &AiProviderConfig,
) -> Result<Option<String>, String> {
    api_key_from_store(credentials, provider)
}

#[cfg(test)]
fn connection_test_api_key(
    credentials: &impl AiCredentialStore,
    provider: &AiProviderConfig,
) -> Result<Option<String>, String> {
    let inline_key = provider
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string);
    if inline_key.is_some() {
        return Ok(inline_key);
    }
    api_key_from_store(credentials, provider)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        io::{Read, Write},
        net::{Ipv4Addr, TcpListener},
        sync::Mutex,
        thread,
    };

    use super::*;
    use crate::llm::{config::*, transport::*, usage::*};
    use serde_json::json;
    const AGENT_MAX_OUTPUT_TOKENS: u64 = 4_096;

    fn serve_http_body(
        status: u16,
        body: Vec<u8>,
        chunked: bool,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind HTTP fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept fixture request");
            let mut request = [0u8; 2048];
            let _ = stream.read(&mut request);
            let reason = if status >= 400 { "Error" } else { "OK" };
            if chunked {
                write!(
                    stream,
                    "HTTP/1.1 {status} {reason}\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n"
                )
                .expect("write fixture headers");
                for chunk in body.chunks(1024) {
                    write!(stream, "{:x}\r\n", chunk.len()).expect("write chunk size");
                    stream.write_all(chunk).expect("write fixture chunk");
                    stream.write_all(b"\r\n").expect("finish fixture chunk");
                }
                stream.write_all(b"0\r\n\r\n").expect("finish chunked body");
            } else {
                write!(
                    stream,
                    "HTTP/1.1 {status} {reason}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len(),
                )
                .expect("write fixture headers");
                stream.write_all(&body).expect("write fixture body");
            }
        });
        (format!("http://{address}/fixture"), server)
    }

    #[derive(Default)]
    struct MockAiCredentials {
        keys: Mutex<HashMap<String, String>>,
    }

    impl MockAiCredentials {
        fn key(&self, provider_id: &str) -> Option<String> {
            self.keys.lock().unwrap().get(provider_id).cloned()
        }
    }

    impl AiCredentialStore for MockAiCredentials {
        fn get_api_key(&self, provider_id: &str) -> Result<Option<String>, String> {
            Ok(self.key(provider_id))
        }
    }
    #[test]
    fn provider_stream_limits_bound_frames_and_total_bytes() {
        let oversized_frame = vec![b'x'; MAX_PROVIDER_STREAM_EVENT_BYTES + 1];
        assert_eq!(
            ensure_provider_stream_frame_size(oversized_frame.len()).unwrap_err(),
            "AI provider stream event exceeded the 1 MiB framing limit"
        );

        let mut complete_sse_frame = oversized_frame.clone();
        complete_sse_frame.extend_from_slice(b"\n\n");
        assert_eq!(
            take_sse_event(&mut complete_sse_frame).unwrap_err(),
            "AI provider stream event exceeded the 1 MiB framing limit"
        );
        assert_eq!(
            complete_sse_frame.len(),
            MAX_PROVIDER_STREAM_EVENT_BYTES + 3
        );

        let mut complete_ndjson_frame = oversized_frame;
        complete_ndjson_frame.push(b'\n');
        assert_eq!(
            take_line(&mut complete_ndjson_frame).unwrap_err(),
            "AI provider stream event exceeded the 1 MiB framing limit"
        );
        assert_eq!(
            complete_ndjson_frame.len(),
            MAX_PROVIDER_STREAM_EVENT_BYTES + 2
        );

        let mut buffer = Vec::new();
        let mut response_bytes = MAX_PROVIDER_STREAM_RESPONSE_BYTES;
        assert_eq!(
            append_provider_stream_chunk(&mut buffer, b"x", &mut response_bytes).unwrap_err(),
            "AI provider stream exceeded the 16 MiB response limit"
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn applies_agent_output_limits_for_every_provider_protocol() {
        let mut responses = json!({ "model": "gpt-test" });
        apply_output_token_limit(
            &mut responses,
            AiProviderKind::OpenAi,
            AGENT_MAX_OUTPUT_TOKENS,
        );
        assert_eq!(
            responses.get("max_output_tokens").and_then(Value::as_u64),
            Some(4_096),
        );

        let mut compatible = json!({ "model": "compatible-test" });
        apply_output_token_limit(
            &mut compatible,
            AiProviderKind::OpenAiCompatible,
            AGENT_MAX_OUTPUT_TOKENS,
        );
        assert_eq!(
            compatible.get("max_tokens").and_then(Value::as_u64),
            Some(4_096),
        );
        assert!(compatible.get("stream_options").is_none());

        let mut ollama = json!({ "model": "ollama-test", "options": { "temperature": 0 } });
        apply_output_token_limit(&mut ollama, AiProviderKind::Ollama, AGENT_MAX_OUTPUT_TOKENS);
        assert_eq!(
            ollama
                .pointer("/options/num_predict")
                .and_then(Value::as_u64),
            Some(4_096),
        );
        assert_eq!(
            ollama
                .pointer("/options/temperature")
                .and_then(Value::as_u64),
            Some(0),
        );
    }

    #[test]
    fn reads_available_usage_without_requiring_compatible_usage_metadata() {
        assert_eq!(
            provider_usage_from_value(
                AiProviderKind::OpenAi,
                &json!({
                    "type": "response.completed",
                    "response": { "usage": { "input_tokens": 12, "output_tokens": 7, "total_tokens": 19 } }
                }),
            ),
            Some(ProviderUsage {
                uncached_input_tokens: Some(12),
                cache_read_tokens: None,
                cache_write_tokens: None,
                output_tokens: Some(7),
                reasoning_tokens: None,
                total_tokens: Some(19),
            }),
        );
        assert_eq!(
            provider_usage_from_value(
                AiProviderKind::OpenAiCompatible,
                &json!({ "usage": { "prompt_tokens": 4, "completion_tokens": 3 } }),
            ),
            Some(ProviderUsage {
                uncached_input_tokens: Some(4),
                cache_read_tokens: None,
                cache_write_tokens: None,
                output_tokens: Some(3),
                reasoning_tokens: None,
                total_tokens: Some(7),
            }),
        );
        assert_eq!(
            provider_usage_from_value(
                AiProviderKind::Ollama,
                &json!({ "done": true, "prompt_eval_count": 5, "eval_count": 6 }),
            ),
            Some(ProviderUsage {
                uncached_input_tokens: Some(5),
                cache_read_tokens: None,
                cache_write_tokens: None,
                output_tokens: Some(6),
                reasoning_tokens: None,
                total_tokens: Some(11),
            }),
        );
        assert_eq!(
            provider_usage_from_value(AiProviderKind::OpenAiCompatible, &json!({ "choices": [] }),),
            None,
        );
        assert_eq!(
            provider_usage_from_value(
                AiProviderKind::Ollama,
                &json!({ "prompt_eval_count": u64::MAX, "eval_count": 1 }),
            )
            .and_then(|usage| usage.total_tokens),
            None,
        );

        let mut split_usage = ProviderUsage {
            uncached_input_tokens: Some(8),
            output_tokens: Some(1),
            total_tokens: Some(9),
            ..ProviderUsage::default()
        };
        split_usage.merge_latest(ProviderUsage {
            output_tokens: Some(5),
            ..ProviderUsage::default()
        });
        assert_eq!(split_usage.total_tokens, Some(13));

        assert_eq!(
            provider_usage_from_value(
                AiProviderKind::OpenAiCompatible,
                &json!({
                    "usage": {
                        "prompt_tokens": 20,
                        "prompt_cache_hit_tokens": 12,
                        "prompt_cache_miss_tokens": 8,
                        "completion_tokens": 9,
                        "completion_tokens_details": { "reasoning_tokens": 4 },
                        "total_tokens": 29
                    }
                }),
            ),
            Some(ProviderUsage {
                uncached_input_tokens: Some(8),
                cache_read_tokens: Some(12),
                cache_write_tokens: None,
                output_tokens: Some(9),
                reasoning_tokens: Some(4),
                total_tokens: Some(29),
            }),
        );
    }
    #[tokio::test]
    async fn bounded_body_reader_accepts_exact_limit_and_rejects_the_next_chunk() {
        let client = build_client().unwrap();
        let (url, server) = serve_http_body(200, b"12345678".to_vec(), true);
        let response = client.get(url).send().await.unwrap();
        assert_eq!(
            read_bounded_response_body(response, None, 8, "fixture body exceeded")
                .await
                .unwrap()
                .unwrap(),
            b"12345678",
        );
        server.join().unwrap();

        let (url, server) = serve_http_body(200, b"123456789".to_vec(), true);
        let response = client.get(url).send().await.unwrap();
        assert_eq!(
            read_bounded_response_body(response, None, 8, "fixture body exceeded")
                .await
                .unwrap_err(),
            "fixture body exceeded",
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn checked_responses_reject_oversized_error_and_success_bodies() {
        let client = build_client().unwrap();
        let (url, server) = serve_http_body(500, vec![b'e'; MAX_ERROR_BODY_BYTES + 1], true);
        let response = client.get(url).send().await.unwrap();
        assert_eq!(
            checked_response(response).await.unwrap_err(),
            ERROR_BODY_LIMIT_MESSAGE,
        );
        server.join().unwrap();

        let (url, server) = serve_http_body(
            200,
            vec![b' '; MAX_PROVIDER_NON_STREAM_RESPONSE_BYTES + 1],
            true,
        );
        let response = client.get(url).send().await.unwrap();
        assert_eq!(
            checked_json(response).await.unwrap_err(),
            NON_STREAM_BODY_LIMIT_MESSAGE,
        );
        server.join().unwrap();
    }
    #[test]
    fn sse_decoder_preserves_partial_event() {
        let mut buffer = b"event: one\ndata: {}\n\nevent: two".to_vec();
        assert_eq!(
            take_sse_event(&mut buffer).unwrap().as_deref(),
            Some("event: one\ndata: {}")
        );
        assert_eq!(buffer, b"event: two");
    }
    #[test]
    fn sse_decoder_returns_an_unterminated_final_event() {
        let mut buffer = b"data: {\"type\":\"response.completed\"}".to_vec();
        assert_eq!(
            take_final_sse_event(&mut buffer).unwrap().as_deref(),
            Some("data: {\"type\":\"response.completed\"}")
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn sse_decoder_preserves_utf8_split_across_chunks() {
        let text = "data: {\"delta\":\"中\"}";
        let bytes = text.as_bytes();
        let split = text.find('中').unwrap() + 1;
        let mut buffer = bytes[..split].to_vec();
        assert!(take_sse_event(&mut buffer).unwrap().is_none());
        buffer.extend_from_slice(&bytes[split..]);
        buffer.extend_from_slice(b"\n\n");
        assert_eq!(take_sse_event(&mut buffer).unwrap().as_deref(), Some(text));
    }

    #[test]
    fn ndjson_decoder_preserves_utf8_split_across_chunks() {
        let text = "{\"message\":{\"content\":\"诊断\"}}";
        let bytes = text.as_bytes();
        let split = text.find('诊').unwrap() + 2;
        let mut buffer = bytes[..split].to_vec();
        assert!(take_line(&mut buffer).unwrap().is_none());
        buffer.extend_from_slice(&bytes[split..]);
        buffer.push(b'\n');
        assert_eq!(take_line(&mut buffer).unwrap().as_deref(), Some(text));
    }

    #[test]
    fn validates_provider_url_security_contract() {
        let mut provider = AiProviderConfig {
            model_definition: None,
            profile: "ollama".into(),
            retry_policy: None,
            id: "ollama".to_string(),
            kind: AiProviderKind::Ollama,
            base_url: String::new(),
            model: "qwen3".to_string(),
            reasoning_effort: None,
            requires_api_key: false,
            api_key: None,
        };
        for base_url in [
            "https://example.com/v1",
            "http://localhost:11434",
            "http://127.0.0.1:11434",
            "http://[::1]:11434",
        ] {
            provider.base_url = base_url.to_string();
            assert!(
                validate_provider_config(&provider, true).is_ok(),
                "expected provider URL to be accepted: {base_url}"
            );
        }
        for base_url in [
            "http://example.com/v1",
            "https://user@example.com/v1",
            "https://user:password@example.com/v1",
            "ftp://example.com/v1",
            "file:///tmp/provider",
        ] {
            provider.base_url = base_url.to_string();
            assert!(
                validate_provider_config(&provider, true).is_err(),
                "expected provider URL to be rejected: {base_url}"
            );
        }
    }

    #[test]
    fn builds_versioned_openai_endpoints_from_a_service_root() {
        let provider = AiProviderConfig {
            model_definition: None,
            profile: "minimax".into(),
            retry_policy: None,
            id: "minimax".to_string(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "https://api.minimaxi.com/v1/chat/completions".to_string(),
            model: "MiniMax-M3".to_string(),
            reasoning_effort: None,
            requires_api_key: true,
            api_key: None,
        };

        assert_eq!(
            endpoint_url(&provider, "chat/completions")
                .unwrap()
                .as_str(),
            "https://api.minimaxi.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint_url(&provider, "models").unwrap().as_str(),
            "https://api.minimaxi.com/v1/models"
        );

        let api_root = AiProviderConfig {
            model_definition: None,
            profile: "minimax".into(),
            retry_policy: None,
            base_url: "https://api.minimaxi.com/v1".to_string(),
            ..provider
        };
        assert_eq!(
            endpoint_url(&api_root, "chat/completions")
                .unwrap()
                .as_str(),
            "https://api.minimaxi.com/v1/chat/completions"
        );

        let service_root = AiProviderConfig {
            model_definition: None,
            profile: "kimi".into(),
            retry_policy: None,
            base_url: "https://api.kimi.com/coding".to_string(),
            ..api_root
        };
        assert_eq!(
            endpoint_url(&service_root, "models").unwrap().as_str(),
            "https://api.kimi.com/coding/v1/models"
        );
        assert_eq!(
            endpoint_url(&service_root, "chat/completions")
                .unwrap()
                .as_str(),
            "https://api.kimi.com/coding/v1/chat/completions"
        );

        let deepseek = AiProviderConfig {
            model_definition: None,
            profile: "deepseek".into(),
            retry_policy: None,
            base_url: "https://api.deepseek.com/v1/chat/completions".to_string(),
            model: "deepseek-flash".to_string(),
            ..service_root
        };
        assert_eq!(
            endpoint_url(&deepseek, "chat/completions")
                .unwrap()
                .as_str(),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            endpoint_url(&deepseek, "models").unwrap().as_str(),
            "https://api.deepseek.com/models"
        );

        let glm = AiProviderConfig {
            model_definition: None,
            profile: "glm".into(),
            retry_policy: None,
            base_url: "https://open.bigmodel.cn/api/paas/v4".to_string(),
            model: "glm-5.2".to_string(),
            ..deepseek
        };
        assert_eq!(
            endpoint_url(&glm, "chat/completions").unwrap().as_str(),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
        let glm_root = AiProviderConfig {
            model_definition: None,
            profile: "glm".into(),
            retry_policy: None,
            base_url: "https://open.bigmodel.cn".to_string(),
            ..glm
        };
        assert_eq!(
            endpoint_url(&glm_root, "models").unwrap().as_str(),
            "https://open.bigmodel.cn/api/paas/v4/models"
        );
    }

    #[test]
    fn applies_reasoning_effort_in_each_supported_protocol_shape() {
        let compatible = AiProviderConfig {
            model_definition: None,
            profile: "kimi".into(),
            retry_policy: None,
            id: "kimi".to_string(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "https://api.kimi.com/coding".to_string(),
            model: "k3".to_string(),
            reasoning_effort: Some("max".to_string()),
            requires_api_key: true,
            api_key: None,
        };
        let mut compatible_body = json!({ "model": "k3" });
        apply_reasoning_effort(&mut compatible_body, &compatible);
        assert_eq!(
            compatible_body
                .get("reasoning_effort")
                .and_then(Value::as_str),
            Some("max")
        );
        assert_eq!(
            crate::agent_runtime::provider::profile_id(&compatible).unwrap(),
            "kimi"
        );

        let openai = AiProviderConfig {
            model_definition: None,
            profile: "openai".into(),
            retry_policy: None,
            id: "openai".to_string(),
            kind: AiProviderKind::OpenAi,
            base_url: "https://api.openai.com".to_string(),
            model: "gpt-5.4-mini".to_string(),
            reasoning_effort: Some("high".to_string()),
            requires_api_key: true,
            api_key: None,
        };
        let mut responses_body = json!({ "model": "gpt-test" });
        apply_reasoning_effort(&mut responses_body, &openai);
        assert_eq!(
            responses_body
                .pointer("/reasoning/effort")
                .and_then(Value::as_str),
            Some("high")
        );

        let deepseek = AiProviderConfig {
            model_definition: None,
            profile: "deepseek".into(),
            retry_policy: None,
            id: "deepseek".to_string(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "https://api.deepseek.com".to_string(),
            model: "deepseek-flash".to_string(),
            reasoning_effort: Some("off".to_string()),
            requires_api_key: true,
            api_key: None,
        };
        let mut deepseek_body = json!({ "model": "deepseek-flash" });
        apply_reasoning_effort(&mut deepseek_body, &deepseek);
        assert_eq!(
            deepseek_body
                .pointer("/thinking/type")
                .and_then(Value::as_str),
            Some("disabled")
        );
        assert!(deepseek_body.get("reasoning_effort").is_none());

        let mut deepseek_high = deepseek.clone();
        deepseek_high.reasoning_effort = Some("high".to_string());
        let mut deepseek_high_body = json!({ "model": "deepseek-flash" });
        apply_reasoning_effort(&mut deepseek_high_body, &deepseek_high);
        assert_eq!(
            deepseek_high_body
                .pointer("/thinking/type")
                .and_then(Value::as_str),
            Some("enabled")
        );
        assert_eq!(
            deepseek_high_body
                .get("reasoning_effort")
                .and_then(Value::as_str),
            Some("high")
        );

        let minimax = AiProviderConfig {
            model_definition: None,
            profile: "minimax".into(),
            retry_policy: None,
            id: "minimax".to_string(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "https://api.minimaxi.com".to_string(),
            model: "MiniMax-M3".to_string(),
            reasoning_effort: Some("on".to_string()),
            requires_api_key: true,
            api_key: None,
        };
        let mut minimax_body = json!({ "model": "MiniMax-M3" });
        apply_reasoning_effort(&mut minimax_body, &minimax);
        assert_eq!(
            minimax_body
                .pointer("/thinking/type")
                .and_then(Value::as_str),
            Some("adaptive")
        );

        let qwen = AiProviderConfig {
            model_definition: None,
            profile: "qwen".into(),
            retry_policy: None,
            id: "qwen".to_string(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            model: "qwen3.8-max".to_string(),
            reasoning_effort: Some("on".to_string()),
            requires_api_key: true,
            api_key: None,
        };
        let mut qwen_body = json!({ "model": "qwen3.8-max" });
        apply_reasoning_effort(&mut qwen_body, &qwen);
        assert_eq!(
            qwen_body.get("enable_thinking").and_then(Value::as_bool),
            Some(true)
        );
        assert!(qwen_body.get("thinking").is_none());

        let glm = AiProviderConfig {
            model_definition: None,
            profile: "glm".into(),
            retry_policy: None,
            id: "glm".to_string(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "https://open.bigmodel.cn/api/paas/v4".to_string(),
            model: "glm-5.2".to_string(),
            reasoning_effort: Some("high".to_string()),
            requires_api_key: true,
            api_key: None,
        };
        let mut glm_body = json!({ "model": "glm-5.2" });
        apply_reasoning_effort(&mut glm_body, &glm);
        assert_eq!(
            glm_body.get("reasoning_effort").and_then(Value::as_str),
            Some("high")
        );
        assert_eq!(
            glm_body.pointer("/thinking/type").and_then(Value::as_str),
            Some("enabled")
        );

        let ollama = AiProviderConfig {
            model_definition: None,
            profile: "ollama".into(),
            retry_policy: None,
            id: "ollama".to_string(),
            kind: AiProviderKind::Ollama,
            base_url: "http://127.0.0.1:11434".to_string(),
            model: "gpt-oss:20b".to_string(),
            reasoning_effort: Some("medium".to_string()),
            requires_api_key: false,
            api_key: None,
        };
        let mut ollama_body = json!({ "model": "gpt-oss:20b" });
        apply_reasoning_effort(&mut ollama_body, &ollama);
        assert_eq!(
            ollama_body.get("think").and_then(Value::as_str),
            Some("medium")
        );
    }

    #[test]
    fn reads_and_trims_api_key_from_keychain() {
        let credentials = MockAiCredentials::default();
        credentials
            .keys
            .lock()
            .unwrap()
            .insert("minimax".to_string(), "  keychain-key  ".to_string());
        let provider = AiProviderConfig {
            model_definition: None,
            profile: "minimax".into(),
            retry_policy: None,
            id: "minimax".to_string(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "https://api.minimaxi.com/v1".to_string(),
            model: "MiniMax-M3".to_string(),
            reasoning_effort: None,
            requires_api_key: true,
            api_key: Some("stale-inline-key".to_string()),
        };

        assert_eq!(
            api_key_from_store(&credentials, &provider)
                .unwrap()
                .as_deref(),
            Some("keychain-key")
        );
    }

    #[test]
    fn rejects_a_required_provider_without_a_saved_api_key() {
        let credentials = MockAiCredentials::default();
        let provider = AiProviderConfig {
            model_definition: None,
            profile: "minimax".into(),
            retry_policy: None,
            id: "minimax".to_string(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "https://api.minimaxi.com/v1".to_string(),
            model: "MiniMax-M3".to_string(),
            reasoning_effort: None,
            requires_api_key: true,
            api_key: None,
        };

        assert_eq!(
            api_key_from_store(&credentials, &provider).unwrap_err(),
            "API key is required"
        );
    }

    #[test]
    fn connection_test_can_use_an_ephemeral_inline_key() {
        let credentials = MockAiCredentials::default();
        let provider = AiProviderConfig {
            model_definition: None,
            profile: "minimax".into(),
            retry_policy: None,
            id: "provider-setup-draft".to_string(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "https://api.minimaxi.com/v1".to_string(),
            model: "MiniMax-M3".to_string(),
            reasoning_effort: None,
            requires_api_key: true,
            api_key: Some("  ephemeral-key  ".to_string()),
        };

        assert_eq!(
            connection_test_api_key(&credentials, &provider)
                .unwrap()
                .as_deref(),
            Some("ephemeral-key")
        );
        assert!(credentials.key("provider-setup-draft").is_none());
    }
}

/// Credential-free capability DTO. Discovery and capability declaration are separate.
#[tauri::command]
pub(crate) fn ai_resolve_model(
    provider: AiProviderConfig,
) -> Result<crate::llm::catalog::ResolvedModel, String> {
    validate_provider_config(&provider, true)?;
    crate::llm::catalog::resolve(&provider)
}

#[tauri::command]
pub(crate) fn ai_model_declaration_template(
    provider: AiProviderConfig,
) -> Result<crate::llm::catalog::ModelDefinition, String> {
    crate::llm::catalog::declaration_template(&provider)
}
