use crate::redaction::redact_sensitive_text;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NormalizedModelErrorKind {
    Cancelled,
    Retryable,
    Transport,
    Timeout,
    EmptyResponse,
    Protocol,
    ContextTooLarge,
    Authentication,
    RateLimited,
    Terminal,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NormalizedModelError {
    pub(crate) kind: NormalizedModelErrorKind,
    pub(crate) message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) retry_after_ms: Option<u64>,
}

impl NormalizedModelError {
    pub(crate) fn new(kind: NormalizedModelErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: redact_sensitive_text(&message.into()),
            status: None,
            code: None,
            retry_after_ms: None,
        }
    }

    pub(crate) fn cancelled() -> Self {
        Self::new(Self::cancelled_kind(), "model request cancelled")
    }

    const fn cancelled_kind() -> NormalizedModelErrorKind {
        NormalizedModelErrorKind::Cancelled
    }

    pub(crate) fn retryable(&self) -> bool {
        matches!(
            self.kind,
            NormalizedModelErrorKind::Retryable
                | NormalizedModelErrorKind::Transport
                | NormalizedModelErrorKind::Timeout
                | NormalizedModelErrorKind::EmptyResponse
                | NormalizedModelErrorKind::RateLimited
        )
    }
}
