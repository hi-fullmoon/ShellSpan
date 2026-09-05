use super::config::AiProviderKind;
use serde_json::Value;

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
        AiProviderKind::AnthropicMessages => value.get("usage").unwrap_or(value),
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
        AiProviderKind::AnthropicMessages => (
            usage.get("input_tokens").and_then(Value::as_u64),
            usage.get("cache_read_input_tokens").and_then(Value::as_u64),
            usage
                .get("cache_creation_input_tokens")
                .and_then(Value::as_u64),
            usage.get("output_tokens").and_then(Value::as_u64),
            None,
            None,
        ),
    };
    let uncached_input_tokens = if kind == AiProviderKind::AnthropicMessages {
        input_tokens
    } else {
        usage
            .get("prompt_cache_miss_tokens")
            .and_then(Value::as_u64)
            .or_else(|| {
                input_tokens
                    .map(|input| input.saturating_sub(cache_read_tokens.unwrap_or_default()))
            })
    };
    let total_tokens = explicit_total.or_else(|| match (input_tokens, output_tokens) {
        (Some(input), Some(output)) if kind == AiProviderKind::AnthropicMessages => input
            .checked_add(cache_read_tokens.unwrap_or_default())
            .and_then(|value| value.checked_add(cache_write_tokens.unwrap_or_default()))
            .and_then(|value| value.checked_add(output)),
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
