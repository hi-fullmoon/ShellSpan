use super::adapters::{
    anthropic::AnthropicMessagesAdapter, chat_completions::ChatCompletionsAdapter,
    ollama::OllamaAdapter, responses::ResponsesAdapter,
};
#[cfg(test)]
use super::transport::{build_streaming_client, ModelTimeoutPolicy};
use super::{adapter::*, config::*, transport::HttpConfig};
use std::sync::Arc;

pub(crate) fn replay_codec(adapter_id: &str) -> Option<&'static dyn ReplayCodec> {
    match adapter_id {
        "chat-completions" => {
            Some(&super::adapters::chat_completions::CHAT_COMPLETIONS_REPLAY_CODEC)
        }
        "responses" => Some(&super::adapters::responses::RESPONSES_REPLAY_CODEC),
        "ollama" => Some(&super::adapters::ollama::OLLAMA_REPLAY_CODEC),
        "anthropic-messages" => Some(&super::adapters::anthropic::ANTHROPIC_REPLAY_CODEC),
        _ => None,
    }
}

/// Compile-time protocol registration.
/// Only this boundary selects a protocol; each adapter owns its request and parser.
pub(in crate::llm) fn create_adapter(http: HttpConfig) -> Arc<dyn ModelAdapter> {
    match http.provider.kind {
        AiProviderKind::OpenAi => Arc::new(ResponsesAdapter { http }),
        AiProviderKind::OpenAiCompatible => Arc::new(ChatCompletionsAdapter { http }),
        AiProviderKind::Ollama => Arc::new(OllamaAdapter { http }),
        AiProviderKind::AnthropicMessages => Arc::new(AnthropicMessagesAdapter { http }),
    }
}
#[cfg(test)]
#[derive(Default)]
pub(crate) struct HttpModelAdapterFactory;

#[cfg(test)]
impl ModelAdapterFactory for HttpModelAdapterFactory {
    fn create(
        &self,
        provider: AiProviderConfig,
        api_key: Option<String>,
    ) -> Result<Arc<dyn ModelAdapter>, String> {
        if let Some(policy) = provider.retry_policy {
            policy.validate()?;
        }
        super::config::validate_provider_config(&provider, true)?;
        Ok(create_adapter(HttpConfig {
            client: build_streaming_client()?,
            provider,
            api_key,
            timeouts: ModelTimeoutPolicy::default(),
        }))
    }
}
