//! Ephemeral provider checks: no route writes, history, tools, retries, or response text.
use super::{
    adapter::ModelStreamSink,
    config::{validate_provider_config, AiProviderConfig},
    errors::{NormalizedModelError, NormalizedModelErrorKind},
    runtime::LlmRuntime,
    types::{ModelMessage, ModelRequest, StreamDelta},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const DEADLINE: Duration = Duration::from_secs(30);
const OUTPUT_LIMIT: u64 = 128;

#[derive(Clone, Default)]
pub(crate) struct ConnectionTests(Arc<Mutex<HashMap<String, CancellationToken>>>);

impl ConnectionTests {
    fn begin(&self) -> Result<(String, CancellationToken), String> {
        let mut active = self
            .0
            .lock()
            .map_err(|_| "CONNECTION_TEST_STATE_UNAVAILABLE")?;
        if active.len() >= 8 {
            return Err("CONNECTION_TEST_LIMIT".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let token = CancellationToken::new();
        active.insert(id.clone(), token.clone());
        Ok((id, token))
    }

    pub(crate) fn cancel(&self, id: &str) -> Result<(), String> {
        let active = self
            .0
            .lock()
            .map_err(|_| "CONNECTION_TEST_STATE_UNAVAILABLE")?;
        if let Some(token) = active.get(id) {
            token.cancel();
        }
        Ok(())
    }

    fn finish(&self, id: &str) {
        if let Ok(mut active) = self.0.lock() {
            active.remove(id);
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ConnectionTestResult {
    Success {
        elapsed_ms: u64,
    },
    Failed {
        kind: NormalizedModelErrorKind,
        status: Option<u16>,
    },
}

struct DiscardOutput;
impl ModelStreamSink for DiscardOutput {
    fn emit(&self, _: StreamDelta) -> Result<(), NormalizedModelError> {
        Ok(())
    }
}

fn test_provider(mut provider: AiProviderConfig) -> Result<AiProviderConfig, String> {
    // The same declaration fallback as Save supports a manually entered model.
    if provider.model_definition.is_none() {
        let definition = match super::catalog::resolve(&provider) {
            Ok(model) => model.definition,
            Err(error) if error.starts_with("UNKNOWN_MODEL") => {
                super::catalog::declaration_template(&provider)?
            }
            Err(error) => return Err(error),
        };
        provider.model_definition = Some(definition);
    }
    validate_provider_config(&provider, true)?;
    if let Some(definition) = &mut provider.model_definition {
        definition.max_output_tokens = definition.max_output_tokens.min(OUTPUT_LIMIT);
    }
    Ok(provider)
}

fn terminal_error(message: impl Into<String>) -> NormalizedModelError {
    NormalizedModelError::new(NormalizedModelErrorKind::Terminal, message)
}

async fn run(
    runtime: LlmRuntime,
    mut provider: AiProviderConfig,
    token: CancellationToken,
) -> Result<(), NormalizedModelError> {
    // Credential lookup can involve the OS keychain; keep it off the async executor.
    let api_key = tokio::task::spawn_blocking(move || {
        let temporary = provider
            .api_key
            .take()
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty());
        let api_key = if temporary.is_some() {
            temporary
        } else {
            let snapshot = runtime.routes.snapshot()?;
            match snapshot.routes.iter().find(|route| route.id == provider.id) {
                Some(route) => runtime.routes.credential(route)?,
                None => None,
            }
        };
        if provider.requires_api_key && api_key.as_deref().is_none_or(|key| key.trim().is_empty()) {
            return Err("MISSING_CREDENTIAL".to_string());
        }
        Ok((provider, api_key))
    })
    .await
    .map_err(|_| terminal_error("credential lookup failed"))?
    .map_err(|_| {
        NormalizedModelError::new(
            NormalizedModelErrorKind::Authentication,
            "MISSING_CREDENTIAL",
        )
    })?;
    let (provider, api_key) = api_key;
    let adapter = super::registry::create_adapter(super::transport::HttpConfig {
        client: super::transport::build_streaming_client().map_err(terminal_error)?,
        provider,
        api_key,
        timeouts: super::transport::ModelTimeoutPolicy {
            request_headers: DEADLINE,
            first_byte: DEADLINE,
            stream_idle: DEADLINE,
        },
    });
    let response = adapter
        .stream(
            ModelRequest {
                request_id: uuid::Uuid::new_v4().to_string(),
                surface_generation: 0,
                system_prompt: "Reply briefly.".into(),
                messages: vec![ModelMessage::User {
                    content: "Reply with OK.".into(),
                }],
                tools: vec![],
            },
            token,
            Arc::new(DiscardOutput),
        )
        .await?;
    if !response
        .content
        .iter()
        .any(super::replay::model_block_has_output)
    {
        return Err(NormalizedModelError::new(
            NormalizedModelErrorKind::EmptyResponse,
            "empty response",
        ));
    }
    Ok(())
}

async fn bounded_run(
    runtime: LlmRuntime,
    provider: AiProviderConfig,
    token: CancellationToken,
) -> ConnectionTestResult {
    let started = Instant::now();
    let result = tokio::select! {
        biased;
        _ = token.cancelled() => Err(NormalizedModelError::cancelled()),
        result = tokio::time::timeout(DEADLINE, run(runtime, provider, token.clone())) => {
            result.unwrap_or_else(|_| Err(NormalizedModelError::new(NormalizedModelErrorKind::Timeout, "connection test timed out")))
        }
    };
    token.cancel();
    match result {
        Ok(()) => ConnectionTestResult::Success {
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
        // Do not send arbitrary provider response bodies, URLs or credentials to the UI/logs.
        Err(error) => ConnectionTestResult::Failed {
            kind: error.kind,
            status: error.status,
        },
    }
}

#[tauri::command]
pub(crate) fn ai_test_connection(
    runtime: tauri::State<'_, LlmRuntime>,
    tests: tauri::State<'_, ConnectionTests>,
    provider: AiProviderConfig,
    on_result: tauri::ipc::Channel<ConnectionTestResult>,
) -> Result<String, String> {
    let provider = test_provider(provider).map_err(|_| "INVALID_CONNECTION_TEST_CONFIG")?;
    let (id, token) = tests.begin()?;
    let request_id = id.clone();
    let tests = tests.inner().clone();
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = bounded_run(runtime, provider, token).await;
        tests.finish(&request_id);
        let _ = on_result.send(result);
    });
    Ok(id)
}

#[tauri::command]
pub(crate) fn ai_cancel_connection_test(
    tests: tauri::State<'_, ConnectionTests>,
    request_id: String,
) -> Result<(), String> {
    tests.cancel(&request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db::Database,
        keychain::CredentialManager,
        llm::{config::AiProviderKind, routes::RouteStore},
    };
    use tokio::io::AsyncReadExt;

    fn provider(base_url: String) -> AiProviderConfig {
        AiProviderConfig {
            id: "connection-check".into(),
            profile: "ollama".into(),
            kind: AiProviderKind::Ollama,
            base_url,
            model: "qwen3:8b".into(),
            requires_api_key: false,
            api_key: None,
            reasoning_effort: None,
            model_definition: None,
            retry_policy: None,
        }
    }

    fn runtime() -> (tempfile::TempDir, Database, LlmRuntime) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("checks.db")).unwrap();
        let routes = RouteStore::open(database.clone(), CredentialManager::new()).unwrap();
        (directory, database, LlmRuntime { routes })
    }

    #[test]
    fn checks_reject_unsafe_urls_and_bound_the_selected_model_without_mutating_it() {
        for url in [
            "http://example.com",
            "https://user:password@example.com",
            "file:///tmp/model",
        ] {
            assert!(test_provider(provider(url.into())).is_err());
        }
        for (profile, kind) in [
            ("ollama", AiProviderKind::Ollama),
            ("openai", AiProviderKind::OpenAi),
            ("generic", AiProviderKind::OpenAiCompatible),
            ("anthropic", AiProviderKind::AnthropicMessages),
        ] {
            let mut original = provider("https://example.com/v1".into());
            original.profile = profile.into();
            original.kind = kind;
            let checked = test_provider(original.clone()).unwrap();
            assert_eq!(checked.kind, original.kind);
            assert_eq!(checked.model, original.model);
            assert!(checked.model_definition.unwrap().max_output_tokens <= OUTPUT_LIMIT);
            assert!(original.model_definition.is_none());
        }
    }

    #[test]
    fn cancellation_is_isolated_idempotent_and_capacity_is_reclaimed() {
        let tests = ConnectionTests::default();
        let (first, token) = tests.begin().unwrap();
        let (_, other) = tests.begin().unwrap();
        tests.cancel(&first).unwrap();
        tests.cancel(&first).unwrap();
        assert!(token.is_cancelled());
        assert!(!other.is_cancelled());
        for _ in 0..6 {
            tests.begin().unwrap();
        }
        assert!(tests.begin().is_err());
        tests.finish(&first);
        tests.cancel(&first).unwrap();
        assert!(tests.begin().is_ok());
    }

    #[tokio::test]
    async fn real_refused_connection_returns_transport_failure_without_persisting() {
        let (_directory, database, runtime) = runtime();
        let before = database.load_preferences().unwrap();
        let reserved = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = reserved.local_addr().unwrap();
        drop(reserved);
        let provider = test_provider(provider(format!("http://{address}"))).unwrap();
        let result = bounded_run(runtime, provider, CancellationToken::new()).await;
        assert!(matches!(
            result,
            ConnectionTestResult::Failed {
                kind: NormalizedModelErrorKind::Transport,
                ..
            }
        ));
        assert_eq!(database.load_preferences().unwrap(), before);
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 3);
        assert!(json.get("message").is_none());
    }

    #[tokio::test]
    async fn cancelling_an_active_http_request_stops_it_without_waiting_for_headers() {
        let (_directory, database, runtime) = runtime();
        let before = database.load_preferences().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider = test_provider(provider(format!(
            "http://{}",
            listener.local_addr().unwrap()
        )))
        .unwrap();
        let token = CancellationToken::new();
        let request = tokio::spawn(bounded_run(runtime, provider, token.clone()));
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut buffer = [0; 1024];
        assert!(socket.read(&mut buffer).await.unwrap() > 0);
        token.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), request)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            result,
            ConnectionTestResult::Failed {
                kind: NormalizedModelErrorKind::Cancelled,
                ..
            }
        ));
        assert_eq!(database.load_preferences().unwrap(), before);
    }

    #[tokio::test]
    async fn a_stalled_real_http_connection_hits_the_total_deadline() {
        let (_directory, _database, runtime) = runtime();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider = test_provider(provider(format!(
            "http://{}",
            listener.local_addr().unwrap()
        )))
        .unwrap();
        let request = tokio::spawn(bounded_run(runtime, provider, CancellationToken::new()));
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut buffer = [0; 1024];
        assert!(socket.read(&mut buffer).await.unwrap() > 0);
        let result = tokio::time::timeout(DEADLINE + Duration::from_secs(2), request)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            result,
            ConnectionTestResult::Failed {
                kind: NormalizedModelErrorKind::Timeout,
                ..
            }
        ));
    }
}
