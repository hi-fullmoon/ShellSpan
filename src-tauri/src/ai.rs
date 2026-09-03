use std::{collections::HashSet, time::Duration};

use futures_util::StreamExt;
use reqwest::{Client, Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::{
    db::Database,
    keychain::{CredentialManager, AI_KEY_SERVICE},
};

const AI_KEY_MIGRATION_PREFERENCE: &str = "ai.apiKeyStorageMigrationV4";
pub(crate) const AGENT_MAX_OUTPUT_TOKENS: u64 = 4_096;
pub(crate) const MAX_ERROR_BODY_BYTES: usize = 4 * 1024;
pub(crate) const MAX_PROVIDER_NON_STREAM_RESPONSE_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_PROVIDER_STREAM_EVENT_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_PROVIDER_STREAM_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

const ERROR_BODY_LIMIT_MESSAGE: &str =
    "AI provider HTTP error body exceeded the 4 KiB response limit";
const NON_STREAM_BODY_LIMIT_MESSAGE: &str =
    "AI provider response exceeded the 1 MiB non-streaming limit";

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AiProviderKind {
    Ollama,
    OpenAi,
    OpenAiCompatible,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AiReasoningEffort {
    Off,
    On,
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiProviderConfig {
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ProviderUsage {
    pub(crate) uncached_input_tokens: Option<u64>,
    pub(crate) cache_read_tokens: Option<u64>,
    pub(crate) cache_write_tokens: Option<u64>,
    pub(crate) output_tokens: Option<u64>,
    pub(crate) reasoning_tokens: Option<u64>,
    pub(crate) total_tokens: Option<u64>,
}

impl ProviderUsage {
    pub(crate) fn is_empty(self) -> bool {
        self.uncached_input_tokens.is_none()
            && self.cache_read_tokens.is_none()
            && self.cache_write_tokens.is_none()
            && self.output_tokens.is_none()
            && self.reasoning_tokens.is_none()
            && self.total_tokens.is_none()
    }

    pub(crate) fn merge_latest(&mut self, next: Self) {
        if next.uncached_input_tokens.is_some() {
            self.uncached_input_tokens = next.uncached_input_tokens;
        }
        if next.cache_read_tokens.is_some() {
            self.cache_read_tokens = next.cache_read_tokens;
        }
        if next.cache_write_tokens.is_some() {
            self.cache_write_tokens = next.cache_write_tokens;
        }
        if next.output_tokens.is_some() {
            self.output_tokens = next.output_tokens;
        }
        if next.reasoning_tokens.is_some() {
            self.reasoning_tokens = next.reasoning_tokens;
        }
        if let Some(total_tokens) = next.total_tokens {
            self.total_tokens = Some(total_tokens);
        } else {
            self.total_tokens =
                self.uncached_input_tokens
                    .zip(self.output_tokens)
                    .and_then(|(input, output)| {
                        input
                            .checked_add(self.cache_read_tokens.unwrap_or_default())?
                            .checked_add(output)
                    });
        }
    }
}

trait AiCredentialStore {
    fn set_api_key(&self, provider_id: &str, api_key: &str) -> Result<(), String>;
    fn get_api_key(&self, provider_id: &str) -> Result<Option<String>, String>;
}

impl AiCredentialStore for CredentialManager {
    fn set_api_key(&self, provider_id: &str, api_key: &str) -> Result<(), String> {
        self.set_credential(AI_KEY_SERVICE, provider_id, api_key)
    }

    fn get_api_key(&self, provider_id: &str) -> Result<Option<String>, String> {
        self.get_credential(AI_KEY_SERVICE, provider_id)
    }
}

trait AiPreferenceStore {
    fn load_ai_preferences(&self) -> Result<Vec<(String, String)>, String>;
    fn save_ai_preferences(&self, entries: &[(String, String)]) -> Result<(), String>;
}

impl AiPreferenceStore for Database {
    fn load_ai_preferences(&self) -> Result<Vec<(String, String)>, String> {
        self.load_preferences()
    }

    fn save_ai_preferences(&self, entries: &[(String, String)]) -> Result<(), String> {
        self.save_preferences(entries)
    }
}

pub(crate) fn migrate_inline_api_keys(
    credentials: &CredentialManager,
    database: &Database,
) -> Result<usize, String> {
    migrate_inline_api_keys_with(credentials, database)
}

fn migrate_inline_api_keys_with(
    credentials: &impl AiCredentialStore,
    preferences: &impl AiPreferenceStore,
) -> Result<usize, String> {
    let entries = preferences.load_ai_preferences()?;
    if entries
        .iter()
        .any(|(key, value)| key == AI_KEY_MIGRATION_PREFERENCE && value == "true")
    {
        return Ok(0);
    }
    let Some((_, raw_providers)) = entries.iter().find(|(key, _)| key == "ai.providers") else {
        preferences.save_ai_preferences(&[(
            AI_KEY_MIGRATION_PREFERENCE.to_string(),
            "true".to_string(),
        )])?;
        return Ok(0);
    };
    let mut providers: Value = serde_json::from_str(raw_providers)
        .map_err(|error| format!("invalid stored AI providers: {error}"))?;
    let Some(provider_items) = providers.as_array_mut() else {
        return Err("invalid stored AI providers: expected an array".to_string());
    };

    let mut pending_keys = Vec::new();
    let mut provider_ids = HashSet::new();
    let mut providers_changed = false;
    for provider in provider_items {
        let Some(provider) = provider.as_object_mut() else {
            continue;
        };
        let provider_id = provider
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "cannot migrate a legacy AI API key without a provider id".to_string())?
            .to_string();
        validate_provider_id(&provider_id)?;
        if !provider_ids.insert(provider_id.clone()) {
            return Err(format!(
                "cannot migrate duplicate AI provider id: {provider_id}"
            ));
        }
        let inline_key = provider
            .remove("apiKey")
            .and_then(|value| value.as_str().map(str::trim).map(str::to_string))
            .filter(|key| !key.is_empty());
        if inline_key.is_some() {
            providers_changed = true;
        }
        let Some(inline_key) = inline_key else {
            continue;
        };
        let already_stored = credentials
            .get_api_key(&provider_id)?
            .is_some_and(|key| !key.trim().is_empty());
        if !already_stored {
            pending_keys.push((provider_id, inline_key));
        }
    }

    for (provider_id, api_key) in &pending_keys {
        credentials.set_api_key(provider_id, api_key)?;
    }
    if providers_changed {
        preferences.save_ai_preferences(&[(
            "ai.providers".to_string(),
            serde_json::to_string(&providers)
                .map_err(|error| format!("failed to serialize migrated AI providers: {error}"))?,
        )])?;
    }
    preferences
        .save_ai_preferences(&[(AI_KEY_MIGRATION_PREFERENCE.to_string(), "true".to_string())])?;
    Ok(pending_keys.len())
}

#[tauri::command]
pub(crate) fn ai_store_api_key(
    credentials: State<'_, CredentialManager>,
    provider_id: String,
    api_key: String,
) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API key cannot be empty".to_string());
    }
    credentials.set_credential(AI_KEY_SERVICE, &provider_id, api_key)
}

#[tauri::command]
pub(crate) fn ai_has_api_key(
    credentials: State<'_, CredentialManager>,
    provider_id: String,
) -> Result<bool, String> {
    validate_provider_id(&provider_id)?;
    Ok(credentials
        .get_credential(AI_KEY_SERVICE, &provider_id)?
        .is_some_and(|value| !value.trim().is_empty()))
}

#[tauri::command]
pub(crate) fn ai_delete_api_key(
    credentials: State<'_, CredentialManager>,
    provider_id: String,
) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    credentials.delete_credential(AI_KEY_SERVICE, &provider_id)
}

#[tauri::command]
pub(crate) async fn ai_list_models(
    credentials: State<'_, CredentialManager>,
    provider: AiProviderConfig,
) -> Result<Vec<String>, String> {
    validate_provider_config(&provider, false)?;
    let api_key = connection_test_api_key(credentials.inner(), &provider)?;
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
        AiProviderKind::OpenAi | AiProviderKind::OpenAiCompatible => value
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

pub(crate) fn take_sse_event(buffer: &mut Vec<u8>) -> Result<Option<String>, String> {
    let lf = find_bytes(buffer, b"\n\n").map(|index| (index, 2));
    let crlf = find_bytes(buffer, b"\r\n\r\n").map(|index| (index, 4));
    let Some((index, separator_len)) = earliest_separator(lf, crlf) else {
        return Ok(None);
    };
    ensure_provider_stream_frame_size(index)?;
    let event = buffer.drain(..index).collect::<Vec<_>>();
    buffer.drain(..separator_len);
    String::from_utf8(event)
        .map(Some)
        .map_err(|error| format!("invalid UTF-8 in OpenAI stream event: {error}"))
}

pub(crate) async fn read_bounded_response_body(
    response: Response,
    cancellation: Option<&CancellationToken>,
    max_bytes: usize,
    limit_error: &'static str,
) -> Result<Option<Vec<u8>>, String> {
    if cancellation.is_some_and(CancellationToken::is_cancelled) {
        return Ok(None);
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(limit_error.to_string());
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    loop {
        let next = if let Some(cancellation) = cancellation {
            tokio::select! {
                _ = cancellation.cancelled() => return Ok(None),
                next = stream.next() => next,
            }
        } else {
            stream.next().await
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(format_transport_error)?;
        let next_len = body
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| limit_error.to_string())?;
        if next_len > max_bytes {
            return Err(limit_error.to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Some(body))
}

pub(crate) fn append_provider_stream_chunk(
    buffer: &mut Vec<u8>,
    chunk: &[u8],
    response_bytes: &mut usize,
) -> Result<(), String> {
    *response_bytes = (*response_bytes)
        .checked_add(chunk.len())
        .ok_or_else(|| "AI provider stream size overflowed".to_string())?;
    if *response_bytes > MAX_PROVIDER_STREAM_RESPONSE_BYTES {
        return Err("AI provider stream exceeded the 16 MiB response limit".to_string());
    }
    buffer.extend_from_slice(chunk);
    Ok(())
}

pub(crate) fn ensure_provider_stream_frame_size(frame_bytes: usize) -> Result<(), String> {
    if frame_bytes > MAX_PROVIDER_STREAM_EVENT_BYTES {
        Err("AI provider stream event exceeded the 1 MiB framing limit".to_string())
    } else {
        Ok(())
    }
}

pub(crate) fn take_final_sse_event(buffer: &mut Vec<u8>) -> Result<Option<String>, String> {
    if buffer.iter().all(|byte| byte.is_ascii_whitespace()) {
        buffer.clear();
        return Ok(None);
    }
    ensure_provider_stream_frame_size(buffer.len())?;
    String::from_utf8(std::mem::take(buffer))
        .map(Some)
        .map_err(|error| format!("invalid UTF-8 in final AI stream event: {error}"))
}

pub(crate) fn sse_data(event: &str) -> String {
    event
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn provider_usage_from_value(
    kind: AiProviderKind,
    value: &Value,
) -> Option<ProviderUsage> {
    let usage = match kind {
        AiProviderKind::OpenAi => value
            .pointer("/response/usage")
            .or_else(|| value.get("usage"))?,
        AiProviderKind::OpenAiCompatible => value.get("usage")?,
        AiProviderKind::Ollama => value,
    };
    let (
        input_tokens,
        cache_read_tokens,
        cache_write_tokens,
        output_tokens,
        reasoning_tokens,
        explicit_total,
    ) = match kind {
        AiProviderKind::OpenAi => (
            usage.get("input_tokens").and_then(Value::as_u64),
            usage
                .pointer("/input_tokens_details/cached_tokens")
                .and_then(Value::as_u64),
            None,
            usage.get("output_tokens").and_then(Value::as_u64),
            usage
                .pointer("/output_tokens_details/reasoning_tokens")
                .and_then(Value::as_u64),
            usage.get("total_tokens").and_then(Value::as_u64),
        ),
        AiProviderKind::OpenAiCompatible => (
            usage.get("prompt_tokens").and_then(Value::as_u64),
            usage
                .get("prompt_cache_hit_tokens")
                .or_else(|| usage.pointer("/prompt_tokens_details/cached_tokens"))
                .and_then(Value::as_u64),
            usage
                .get("prompt_cache_creation_tokens")
                .or_else(|| usage.pointer("/prompt_tokens_details/cache_creation_tokens"))
                .and_then(Value::as_u64),
            usage.get("completion_tokens").and_then(Value::as_u64),
            usage
                .pointer("/completion_tokens_details/reasoning_tokens")
                .and_then(Value::as_u64),
            usage.get("total_tokens").and_then(Value::as_u64),
        ),
        AiProviderKind::Ollama => (
            usage.get("prompt_eval_count").and_then(Value::as_u64),
            None,
            None,
            usage.get("eval_count").and_then(Value::as_u64),
            None,
            None,
        ),
    };
    let uncached_input_tokens = usage
        .get("prompt_cache_miss_tokens")
        .and_then(Value::as_u64)
        .or_else(|| {
            input_tokens.map(|input| input.saturating_sub(cache_read_tokens.unwrap_or_default()))
        });
    let total_tokens = explicit_total.or_else(|| match (input_tokens, output_tokens) {
        (Some(input), Some(output)) => input.checked_add(output),
        _ => None,
    });
    let usage = ProviderUsage {
        uncached_input_tokens,
        cache_read_tokens,
        cache_write_tokens,
        output_tokens,
        reasoning_tokens,
        total_tokens,
    };
    (!usage.is_empty()).then_some(usage)
}

pub(crate) fn take_line(buffer: &mut Vec<u8>) -> Result<Option<String>, String> {
    let Some(index) = buffer.iter().position(|byte| *byte == b'\n') else {
        return Ok(None);
    };
    ensure_provider_stream_frame_size(index)?;
    let mut line = buffer.drain(..index).collect::<Vec<_>>();
    buffer.drain(..1);
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    String::from_utf8(line)
        .map(Some)
        .map_err(|error| format!("invalid UTF-8 in Ollama stream event: {error}"))
}

fn find_bytes(buffer: &[u8], needle: &[u8]) -> Option<usize> {
    buffer
        .windows(needle.len())
        .position(|window| window == needle)
}

fn earliest_separator(
    first: Option<(usize, usize)>,
    second: Option<(usize, usize)>,
) -> Option<(usize, usize)> {
    match (first, second) {
        (Some(first), Some(second)) => Some(if first.0 <= second.0 { first } else { second }),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

pub(crate) fn validate_provider_config(
    provider: &AiProviderConfig,
    require_model: bool,
) -> Result<(), String> {
    validate_provider_id(&provider.id)?;
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

fn validate_provider_id(provider_id: &str) -> Result<(), String> {
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

pub(crate) fn is_kimi_code_provider(provider: &AiProviderConfig) -> bool {
    Url::parse(provider.base_url.trim())
        .ok()
        .is_some_and(|url| {
            url.host_str()
                .is_some_and(|host| host.eq_ignore_ascii_case("api.kimi.com"))
                && (url.path() == "/coding" || url.path().starts_with("/coding/"))
        })
}

pub(crate) fn apply_reasoning_effort(body: &mut Value, provider: &AiProviderConfig) {
    let Some(effort) = provider.reasoning_effort else {
        return;
    };
    match provider.kind {
        AiProviderKind::OpenAi => match effort {
            AiReasoningEffort::Off => body["reasoning"] = json!({ "effort": "none" }),
            AiReasoningEffort::On => {}
            effort => body["reasoning"] = json!({ "effort": effort }),
        },
        AiProviderKind::OpenAiCompatible => match effort {
            AiReasoningEffort::Off => body["thinking"] = json!({ "type": "disabled" }),
            AiReasoningEffort::On => body["thinking"] = json!({ "type": "enabled" }),
            effort => body["reasoning_effort"] = json!(effort),
        },
        AiProviderKind::Ollama => match effort {
            AiReasoningEffort::Off | AiReasoningEffort::None => body["think"] = json!(false),
            AiReasoningEffort::On => body["think"] = json!(true),
            effort => body["think"] = json!(effort),
        },
    }
}

pub(crate) fn apply_output_token_limit(
    body: &mut Value,
    kind: AiProviderKind,
    max_output_tokens: u64,
) {
    match kind {
        AiProviderKind::OpenAi => body["max_output_tokens"] = json!(max_output_tokens),
        AiProviderKind::OpenAiCompatible => body["max_tokens"] = json!(max_output_tokens),
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
    let mut base_path = url.path().trim_end_matches('/').to_string();
    for endpoint_suffix in [
        "/chat/completions",
        "/responses",
        "/models",
        "/api/chat",
        "/api/tags",
        "/api/show",
    ] {
        if let Some(api_root) = base_path.strip_suffix(endpoint_suffix) {
            base_path = api_root.to_string();
            break;
        }
    }
    if !matches!(provider.kind, AiProviderKind::Ollama) && !base_path.ends_with("/v1") {
        base_path = format!("{}/v1", base_path.trim_end_matches('/'));
    }
    url.set_path(&format!(
        "{}/{}",
        base_path.trim_end_matches('/'),
        path.trim_start_matches('/'),
    ));
    Ok(url)
}

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
    }
}

pub(crate) fn api_key_for_provider(
    credentials: &CredentialManager,
    provider: &AiProviderConfig,
) -> Result<Option<String>, String> {
    api_key_from_store(credentials, provider)
}

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

pub(crate) fn build_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("ShellSpan/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("failed to create AI HTTP client: {error}"))
}

async fn checked_response(response: Response) -> Result<Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = read_bounded_response_body(
        response,
        None,
        MAX_ERROR_BODY_BYTES,
        ERROR_BODY_LIMIT_MESSAGE,
    )
    .await?
    .unwrap_or_default();
    let body = String::from_utf8_lossy(&body);
    Err(if body.trim().is_empty() {
        format!("AI provider returned HTTP {status}")
    } else {
        format!("AI provider returned HTTP {status}: {body}")
    })
}

async fn checked_json(response: Response) -> Result<Value, String> {
    let response = checked_response(response).await?;
    let body = read_bounded_response_body(
        response,
        None,
        MAX_PROVIDER_NON_STREAM_RESPONSE_BYTES,
        NON_STREAM_BODY_LIMIT_MESSAGE,
    )
    .await?
    .unwrap_or_default();
    serde_json::from_slice(&body).map_err(|error| format!("invalid AI provider response: {error}"))
}

pub(crate) fn format_transport_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "AI provider request timed out".to_string()
    } else if error.is_connect() {
        "Could not connect to the AI provider".to_string()
    } else {
        format!("AI provider request failed: {error}")
    }
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
        fail_set_for: Mutex<Option<String>>,
        set_calls: Mutex<usize>,
    }

    impl MockAiCredentials {
        fn key(&self, provider_id: &str) -> Option<String> {
            self.keys.lock().unwrap().get(provider_id).cloned()
        }

        fn set_call_count(&self) -> usize {
            *self.set_calls.lock().unwrap()
        }
    }

    impl AiCredentialStore for MockAiCredentials {
        fn set_api_key(&self, provider_id: &str, api_key: &str) -> Result<(), String> {
            *self.set_calls.lock().unwrap() += 1;
            if self.fail_set_for.lock().unwrap().as_deref() == Some(provider_id) {
                return Err(format!(
                    "simulated keychain write failure for {provider_id}"
                ));
            }
            self.keys
                .lock()
                .unwrap()
                .insert(provider_id.to_string(), api_key.to_string());
            Ok(())
        }

        fn get_api_key(&self, provider_id: &str) -> Result<Option<String>, String> {
            Ok(self.key(provider_id))
        }
    }

    struct MockAiPreferences {
        entries: Mutex<Vec<(String, String)>>,
        fail_save: bool,
    }

    impl MockAiPreferences {
        fn new(entries: Vec<(String, String)>) -> Self {
            Self {
                entries: Mutex::new(entries),
                fail_save: false,
            }
        }

        fn value(&self, key: &str) -> Option<String> {
            self.entries
                .lock()
                .unwrap()
                .iter()
                .find(|(entry_key, _)| entry_key == key)
                .map(|(_, value)| value.clone())
        }
    }

    impl AiPreferenceStore for MockAiPreferences {
        fn load_ai_preferences(&self) -> Result<Vec<(String, String)>, String> {
            Ok(self.entries.lock().unwrap().clone())
        }

        fn save_ai_preferences(&self, entries: &[(String, String)]) -> Result<(), String> {
            if self.fail_save {
                return Err("simulated preference cleanup failure".to_string());
            }
            let mut stored = self.entries.lock().unwrap();
            for (key, value) in entries {
                if let Some((_, stored_value)) =
                    stored.iter_mut().find(|(stored_key, _)| stored_key == key)
                {
                    *stored_value = value.clone();
                } else {
                    stored.push((key.clone(), value.clone()));
                }
            }
            Ok(())
        }
    }

    fn ai_preferences(api_key: Option<&str>) -> MockAiPreferences {
        let mut provider = json!({
            "id": "openai",
            "name": "OpenAI",
            "preset": "openai",
            "kind": "openAi",
            "baseUrl": "https://api.openai.com",
            "model": "gpt-5.4-mini",
            "requiresApiKey": true,
        });
        if let Some(api_key) = api_key {
            provider["apiKey"] = Value::String(api_key.to_string());
        }
        MockAiPreferences::new(vec![(
            "ai.providers".to_string(),
            json!([provider]).to_string(),
        )])
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
    }

    #[test]
    fn applies_reasoning_effort_in_each_supported_protocol_shape() {
        let compatible = AiProviderConfig {
            id: "kimi".to_string(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "https://api.kimi.com/coding".to_string(),
            model: "k3".to_string(),
            reasoning_effort: Some(AiReasoningEffort::Max),
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
        assert!(is_kimi_code_provider(&compatible));

        let openai = AiProviderConfig {
            id: "openai".to_string(),
            kind: AiProviderKind::OpenAi,
            base_url: "https://api.openai.com".to_string(),
            model: "gpt-test".to_string(),
            reasoning_effort: Some(AiReasoningEffort::High),
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
            id: "deepseek".to_string(),
            kind: AiProviderKind::OpenAiCompatible,
            base_url: "https://api.deepseek.com".to_string(),
            model: "deepseek-v4-flash".to_string(),
            reasoning_effort: Some(AiReasoningEffort::Off),
            requires_api_key: true,
            api_key: None,
        };
        let mut deepseek_body = json!({ "model": "deepseek-v4-flash" });
        apply_reasoning_effort(&mut deepseek_body, &deepseek);
        assert_eq!(
            deepseek_body
                .pointer("/thinking/type")
                .and_then(Value::as_str),
            Some("disabled")
        );
        assert!(deepseek_body.get("reasoning_effort").is_none());

        let ollama = AiProviderConfig {
            id: "ollama".to_string(),
            kind: AiProviderKind::Ollama,
            base_url: "http://127.0.0.1:11434".to_string(),
            model: "gpt-oss:20b".to_string(),
            reasoning_effort: Some(AiReasoningEffort::Medium),
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

    #[test]
    fn migrates_inline_api_keys_to_keychain_and_cleans_preferences() {
        let secret = "migration-secret-now-in-keychain";
        let credentials = MockAiCredentials::default();
        let preferences = ai_preferences(Some(&format!("  {secret}  ")));

        assert_eq!(
            migrate_inline_api_keys_with(&credentials, &preferences).unwrap(),
            1
        );
        assert_eq!(credentials.key("openai").as_deref(), Some(secret));
        assert_eq!(
            preferences.value(AI_KEY_MIGRATION_PREFERENCE).as_deref(),
            Some("true")
        );
        let stored = preferences.value("ai.providers").unwrap();
        assert!(!stored.contains("apiKey"));
        assert!(!stored.contains(secret));
    }

    #[test]
    fn inline_api_key_migration_is_idempotent() {
        let credentials = MockAiCredentials::default();
        let preferences = ai_preferences(Some("repeatable-secret"));

        assert_eq!(
            migrate_inline_api_keys_with(&credentials, &preferences).unwrap(),
            1
        );
        assert_eq!(
            migrate_inline_api_keys_with(&credentials, &preferences).unwrap(),
            0
        );
        assert_eq!(credentials.set_call_count(), 1);
    }

    #[test]
    fn migration_without_stored_providers_only_records_completion() {
        let credentials = MockAiCredentials::default();
        let preferences = MockAiPreferences::new(Vec::new());

        assert_eq!(
            migrate_inline_api_keys_with(&credentials, &preferences).unwrap(),
            0
        );
        assert!(preferences.value("ai.providers").is_none());
        assert_eq!(
            preferences.value(AI_KEY_MIGRATION_PREFERENCE).as_deref(),
            Some("true")
        );
    }

    #[test]
    fn keychain_write_failure_preserves_the_inline_copy_for_recovery() {
        let secret = "recover-after-keychain-write-failure";
        let credentials = MockAiCredentials::default();
        *credentials.fail_set_for.lock().unwrap() = Some("openai".to_string());
        let preferences = ai_preferences(Some(secret));

        let error = migrate_inline_api_keys_with(&credentials, &preferences).unwrap_err();

        assert!(!error.contains(secret));
        assert!(credentials.key("openai").is_none());
        assert!(preferences.value("ai.providers").unwrap().contains(secret));
        assert!(preferences.value(AI_KEY_MIGRATION_PREFERENCE).is_none());
    }

    #[test]
    fn preference_cleanup_failure_keeps_both_copies_for_recovery() {
        let secret = "recover-after-preference-cleanup-failure";
        let credentials = MockAiCredentials::default();
        let mut preferences = ai_preferences(Some(secret));
        preferences.fail_save = true;

        let error = migrate_inline_api_keys_with(&credentials, &preferences).unwrap_err();

        assert!(!error.contains(secret));
        assert_eq!(credentials.key("openai").as_deref(), Some(secret));
        assert!(preferences.value("ai.providers").unwrap().contains(secret));
        assert!(preferences.value(AI_KEY_MIGRATION_PREFERENCE).is_none());
    }

    #[test]
    fn migration_prefers_the_current_keychain_key_over_a_stale_inline_copy() {
        let credentials = MockAiCredentials::default();
        credentials
            .keys
            .lock()
            .unwrap()
            .insert("openai".to_string(), "current-key".to_string());
        let preferences = ai_preferences(Some("stale-key"));

        assert_eq!(
            migrate_inline_api_keys_with(&credentials, &preferences).unwrap(),
            0
        );

        let stored = preferences.value("ai.providers").unwrap();
        assert!(!stored.contains("current-key"));
        assert!(!stored.contains("stale-key"));
        assert_eq!(credentials.key("openai").as_deref(), Some("current-key"));
    }
}
