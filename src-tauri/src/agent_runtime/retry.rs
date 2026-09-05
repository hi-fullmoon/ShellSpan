use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::NormalizedModelError;

pub(crate) const MAX_SAFE_REQUEST_ATTEMPTS: u32 = 8;
pub(crate) const MAX_SAFE_RETRY_DELAY_MS: u64 = 300_000;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetryPolicy {
    pub(crate) max_attempts: u32,
    pub(crate) initial_delay_ms: u64,
    pub(crate) max_delay_ms: u64,
    pub(crate) max_server_delay_ms: u64,
    pub(crate) jitter_ratio: f64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            initial_delay_ms: 250,
            max_delay_ms: 4_000,
            max_server_delay_ms: 30_000,
            jitter_ratio: 0.2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RetryPlan {
    pub(crate) delay_ms: u64,
    pub(crate) server_retry_after_ms: Option<u64>,
    pub(crate) server_hint_capped: bool,
}

impl RetryPolicy {
    pub(crate) fn deserialize_optional<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Self>, D::Error> {
        let policy = Self::deserialize(deserializer)?;
        policy.validate().map_err(serde::de::Error::custom)?;
        Ok(Some(policy))
    }

    pub(crate) fn validate(self) -> Result<(), String> {
        if !(1..=MAX_SAFE_REQUEST_ATTEMPTS).contains(&self.max_attempts)
            || self.initial_delay_ms > self.max_delay_ms
            || self.max_delay_ms > MAX_SAFE_RETRY_DELAY_MS
            || self.max_server_delay_ms > MAX_SAFE_RETRY_DELAY_MS
            || !self.jitter_ratio.is_finite()
            || !(0.0..=1.0).contains(&self.jitter_ratio)
        {
            return Err("AI retry policy is invalid: attempts 1..8, delays 0..300000 ms, initial <= maximum, jitter 0..1".into());
        }
        Ok(())
    }

    pub(crate) fn max_attempts(self) -> u32 {
        self.max_attempts.clamp(1, MAX_SAFE_REQUEST_ATTEMPTS)
    }

    pub(crate) fn plan(
        self,
        error: &NormalizedModelError,
        failed_attempt: u32,
        random_sample: f64,
    ) -> Option<RetryPlan> {
        if !error.retryable() || failed_attempt >= self.max_attempts() {
            return None;
        }
        if let Some(server_hint) = error.retry_after_ms.filter(|delay| *delay > 0) {
            let server_cap = self.max_server_delay_ms.min(MAX_SAFE_RETRY_DELAY_MS);
            let delay_ms = server_hint.min(server_cap);
            return Some(RetryPlan {
                delay_ms,
                server_retry_after_ms: Some(server_hint),
                server_hint_capped: server_hint > server_cap,
            });
        }
        let exponent = failed_attempt.saturating_sub(1).min(62);
        let local_cap = self.max_delay_ms.min(MAX_SAFE_RETRY_DELAY_MS);
        let exponential = self
            .initial_delay_ms
            .min(MAX_SAFE_RETRY_DELAY_MS)
            .saturating_mul(1_u64 << exponent)
            .min(local_cap);
        let ratio = self.jitter_ratio.clamp(0.0, 1.0);
        let sample = random_sample.clamp(0.0, 1.0);
        let factor = 1.0 - ratio + (2.0 * ratio * sample);
        Some(RetryPlan {
            delay_ms: (((exponential as f64) * factor).round() as u64).min(local_cap),
            server_retry_after_ms: None,
            server_hint_capped: false,
        })
    }
}

pub(crate) async fn cancellable_retry_delay(
    delay_ms: u64,
    cancellation: &CancellationToken,
) -> bool {
    if cancellation.is_cancelled() {
        return false;
    }
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => false,
        _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::{NormalizedModelError, NormalizedModelErrorKind};

    fn retryable() -> NormalizedModelError {
        NormalizedModelError::new(NormalizedModelErrorKind::Transport, "connection failed")
    }

    #[test]
    fn provider_policy_defaults_and_limits_match_frontend_and_reject_invalid_input() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../../src/lib/ai/retry-policy.json")).unwrap();
        assert_eq!(
            serde_json::to_value(RetryPolicy::default()).unwrap(),
            contract["defaults"]
        );
        assert_eq!(
            MAX_SAFE_REQUEST_ATTEMPTS,
            contract["maxAttempts"].as_u64().unwrap() as u32
        );
        assert_eq!(
            MAX_SAFE_RETRY_DELAY_MS,
            contract["maxDelayMs"].as_u64().unwrap()
        );
        for (field, value) in [
            ("maxAttempts", serde_json::json!(0)),
            ("maxAttempts", serde_json::json!(9)),
            ("maxAttempts", serde_json::json!(1.5)),
            ("initialDelayMs", serde_json::json!(-1)),
            ("initialDelayMs", serde_json::json!(5000)),
            ("maxDelayMs", serde_json::json!(300001)),
            ("maxServerDelayMs", serde_json::json!(300001)),
            ("jitterRatio", serde_json::json!(1.1)),
            ("jitterRatio", serde_json::json!("NaN")),
            ("initialDelayMs", serde_json::json!(1e100)),
        ] {
            let mut value_policy = contract["defaults"].clone();
            value_policy[field] = value;
            assert!(
                serde_json::from_value::<RetryPolicy>(value_policy)
                    .map_err(|error| error.to_string())
                    .and_then(RetryPolicy::validate)
                    .is_err(),
                "{field}"
            );
        }
        for ratio in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(RetryPolicy {
                jitter_ratio: ratio,
                ..Default::default()
            }
            .validate()
            .is_err());
        }
        let disabled = RetryPolicy {
            max_attempts: 1,
            ..Default::default()
        };
        assert!(disabled.validate().is_ok());
        assert!(disabled.plan(&retryable(), 1, 0.5).is_none());
    }

    #[test]
    fn provider_wire_omission_keeps_defaults_but_explicit_invalid_policy_is_rejected() {
        let base = serde_json::json!({"id":"p","kind":"ollama","baseUrl":"http://localhost:11434","model":"qwen3","requiresApiKey":false});
        let legacy: crate::ai::AiProviderConfig = serde_json::from_value(base.clone()).unwrap();
        assert_eq!(
            legacy.retry_policy.unwrap_or_default(),
            RetryPolicy::default()
        );
        for invalid in [
            serde_json::Value::Null,
            serde_json::json!({}),
            serde_json::json!({"maxAttempts":1}),
            serde_json::json!({"maxAttempts":9,"initialDelayMs":0,"maxDelayMs":0,"maxServerDelayMs":0,"jitterRatio":0}),
        ] {
            let mut config = base.clone();
            config["retryPolicy"] = invalid;
            assert!(serde_json::from_value::<crate::ai::AiProviderConfig>(config).is_err());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn already_cancelled_wins_even_when_zero_delay_is_ready() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(!cancellable_retry_delay(0, &cancellation).await);
    }

    #[test]
    fn bounded_exponential_backoff_applies_deterministic_jitter_and_attempt_cap() {
        let policy = RetryPolicy {
            max_attempts: 99,
            initial_delay_ms: 100,
            max_delay_ms: 250,
            max_server_delay_ms: 2_000,
            jitter_ratio: 0.2,
        };
        assert_eq!(policy.max_attempts(), MAX_SAFE_REQUEST_ATTEMPTS);
        assert_eq!(policy.plan(&retryable(), 1, 0.0).unwrap().delay_ms, 80);
        assert_eq!(policy.plan(&retryable(), 2, 0.5).unwrap().delay_ms, 200);
        assert_eq!(policy.plan(&retryable(), 3, 1.0).unwrap().delay_ms, 250);
        assert!(policy
            .plan(&retryable(), MAX_SAFE_REQUEST_ATTEMPTS, 0.5)
            .is_none());
    }

    #[test]
    fn server_hint_is_respected_and_safely_capped() {
        let mut error = retryable();
        error.retry_after_ms = Some(9_000);
        let policy = RetryPolicy {
            max_server_delay_ms: 2_000,
            ..RetryPolicy::default()
        };
        assert_eq!(
            policy.plan(&error, 1, 0.5),
            Some(RetryPlan {
                delay_ms: 2_000,
                server_retry_after_ms: Some(9_000),
                server_hint_capped: true,
            })
        );
    }

    #[tokio::test(start_paused = true)]
    async fn backoff_wait_is_cancelled_without_advancing_the_clock() {
        let cancellation = CancellationToken::new();
        let waiting = tokio::spawn({
            let cancellation = cancellation.clone();
            async move { cancellable_retry_delay(30_000, &cancellation).await }
        });
        tokio::task::yield_now().await;
        cancellation.cancel();
        assert!(!waiting.await.unwrap());
    }
}
