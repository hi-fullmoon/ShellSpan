use super::{format_transport_error, read_bounded_response_body, MAX_ERROR_BODY_BYTES};
use crate::llm::{
    config::AiProviderConfig,
    errors::*,
    types::{ModelMessage, ModelRequest},
};
use reqwest::{Client, Response};
use std::{
    pin::Pin,
    time::{Duration, SystemTime},
};
use tokio_util::sync::CancellationToken;
#[derive(Debug, Clone, Copy)]
pub(in crate::llm) struct ModelTimeoutPolicy {
    pub(in crate::llm) request_headers: Duration,
    pub(in crate::llm) first_byte: Duration,
    pub(in crate::llm) stream_idle: Duration,
}

impl Default for ModelTimeoutPolicy {
    fn default() -> Self {
        Self {
            request_headers: Duration::from_secs(30),
            first_byte: Duration::from_secs(30),
            stream_idle: Duration::from_secs(300),
        }
    }
}

pub(in crate::llm) struct HttpConfig {
    pub(in crate::llm) client: Client,
    pub(in crate::llm) provider: AiProviderConfig,
    pub(in crate::llm) api_key: Option<String>,
    pub(in crate::llm) timeouts: ModelTimeoutPolicy,
}

impl HttpConfig {
    pub(in crate::llm) fn validate(
        &self,
        request: &ModelRequest,
    ) -> Result<crate::llm::catalog::ResolvedModel, NormalizedModelError> {
        let model = crate::llm::catalog::resolve(&self.provider).map_err(|error| {
            let code = error
                .split_once(':')
                .map_or("UNSUPPORTED_OPTION", |(code, _)| code)
                .to_string();
            coded_error(NormalizedModelErrorKind::Terminal, error, code)
        })?;
        if !request.tools.is_empty()
            && model.tool_calling != crate::llm::catalog::Support::Supported
        {
            return Err(coded_error(
                NormalizedModelErrorKind::Terminal,
                "tool calling is not explicitly supported",
                "UNSUPPORTED_OPTION",
            ));
        }
        if model.text_input != crate::llm::catalog::Support::Supported {
            return Err(coded_error(
                NormalizedModelErrorKind::Terminal,
                "text input is not explicitly supported",
                "UNSUPPORTED_OPTION",
            ));
        }
        if request
            .messages
            .iter()
            .any(|m| matches!(m, ModelMessage::UserImages { .. }))
        {
            if model.image_input != crate::llm::catalog::Support::Supported {
                return Err(NormalizedModelError::new(
                    NormalizedModelErrorKind::Terminal,
                    "IMAGE_MODEL_UNSUPPORTED",
                ));
            }
            if request.messages.iter().any(|m| matches!(m, ModelMessage::UserImages { images, data_urls, .. } if images.len() != data_urls.len())) {
                return Err(NormalizedModelError::new(NormalizedModelErrorKind::Terminal, "IMAGE_UNRESOLVED"));
            }
        }
        Ok(model)
    }
}
pub(in crate::llm) async fn send_request(
    request: reqwest::RequestBuilder,
    cancellation: &CancellationToken,
    timeouts: ModelTimeoutPolicy,
) -> Result<Response, NormalizedModelError> {
    if cancellation.is_cancelled() {
        return Err(NormalizedModelError::cancelled());
    }
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(NormalizedModelError::cancelled()),
        result = tokio::time::timeout(timeouts.request_headers, request.send()) => match result {
            Ok(result) => result.map_err(normalize_transport_error),
            Err(_) => Err(coded_error(
                NormalizedModelErrorKind::Timeout,
                "AI provider timed out before returning response headers",
                "REQUEST_HEADERS_TIMEOUT",
            )),
        },
    }
}

pub(in crate::llm) fn normalize_transport_error(error: reqwest::Error) -> NormalizedModelError {
    let (kind, code) = if error.is_timeout() {
        (NormalizedModelErrorKind::Timeout, "TRANSPORT_TIMEOUT")
    } else if error.is_connect() {
        (NormalizedModelErrorKind::Transport, "CONNECT")
    } else if error.is_body() {
        (NormalizedModelErrorKind::Transport, "STREAM_READ")
    } else if error.is_decode() {
        // reqwest reports a truncated Content-Length body as Decode. These calls
        // read raw bytes; malformed provider JSON is classified by our parsers.
        (NormalizedModelErrorKind::Transport, "STREAM_DECODE")
    } else {
        (NormalizedModelErrorKind::Terminal, "TRANSPORT_PERMANENT")
    };
    coded_error(kind, format_transport_error(error), code)
}

pub(in crate::llm) fn coded_error(
    kind: NormalizedModelErrorKind,
    message: impl Into<String>,
    code: impl Into<String>,
) -> NormalizedModelError {
    let mut error = NormalizedModelError::new(kind, message);
    error.code = Some(code.into());
    error
}

pub(in crate::llm) fn parse_retry_after(value: &str, now: SystemTime) -> Option<u64> {
    if let Ok(seconds) = value.trim().parse::<u64>() {
        return seconds.checked_mul(1_000);
    }
    let deadline = httpdate::parse_http_date(value.trim()).ok()?;
    let delay = deadline.duration_since(now).ok()?;
    u64::try_from(delay.as_millis()).ok()
}

pub(in crate::llm) async fn checked_stream_response(
    response: Response,
    cancellation: &CancellationToken,
    timeouts: ModelTimeoutPolicy,
) -> Result<Response, NormalizedModelError> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let retry_after_ms = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_retry_after(value, SystemTime::now()))
        .or_else(|| {
            response
                .headers()
                .get("retry-after-ms")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok())
        });
    let body = tokio::time::timeout(
        timeouts.request_headers,
        read_bounded_response_body(
            response,
            Some(cancellation),
            MAX_ERROR_BODY_BYTES,
            "AI provider HTTP error body exceeded the response limit",
        ),
    )
    .await
    .map_err(|_| {
        let mut error = coded_error(
            NormalizedModelErrorKind::Timeout,
            "AI provider timed out while returning an HTTP error body",
            "HTTP_ERROR_BODY_TIMEOUT",
        );
        error.status = Some(status.as_u16());
        error.retry_after_ms = retry_after_ms;
        error
    })?
    .map_err(|error| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, error))?
    .ok_or_else(NormalizedModelError::cancelled)?;
    let text = String::from_utf8_lossy(&body).into_owned();
    let mut error = normalize_provider_error(status.as_u16(), &text);
    error.retry_after_ms = retry_after_ms;
    Err(error)
}

pub(in crate::llm) fn normalize_provider_error(status: u16, message: &str) -> NormalizedModelError {
    let normalized = message.to_ascii_lowercase();
    let context_too_large = [
        "context length",
        "context window",
        "maximum context",
        "too many tokens",
        "prompt is too long",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase));
    let kind = if matches!(status, 401 | 403) {
        NormalizedModelErrorKind::Authentication
    } else if status == 429 {
        NormalizedModelErrorKind::RateLimited
    } else if context_too_large {
        NormalizedModelErrorKind::ContextTooLarge
    } else if matches!(status, 408 | 409 | 425 | 500..=599) {
        NormalizedModelErrorKind::Retryable
    } else {
        NormalizedModelErrorKind::Terminal
    };
    let display = if message.trim().is_empty() {
        format!("AI provider returned HTTP {status}")
    } else {
        format!("AI provider returned HTTP {status}: {message}")
    };
    let mut error = NormalizedModelError::new(kind, display);
    error.status = Some(status);
    error.code = Some(format!("HTTP_{status}"));
    error
}

pub(in crate::llm) struct StreamDeadline {
    pub(in crate::llm) timer: Pin<Box<tokio::time::Sleep>>,
    pub(in crate::llm) first_byte_seen: bool,
    pub(in crate::llm) first_byte_timeout: Duration,
    pub(in crate::llm) idle_timeout: Duration,
}

impl StreamDeadline {
    pub(in crate::llm) fn new(timeouts: ModelTimeoutPolicy) -> Self {
        Self {
            timer: Box::pin(tokio::time::sleep(timeouts.first_byte)),
            first_byte_seen: false,
            first_byte_timeout: timeouts.first_byte,
            idle_timeout: timeouts.stream_idle,
        }
    }

    pub(in crate::llm) fn observe_bytes(&mut self, bytes: usize) {
        if bytes > 0 && !self.first_byte_seen {
            self.first_byte_seen = true;
            self.reset(self.idle_timeout);
        }
    }

    pub(in crate::llm) fn observe_frame(&mut self) {
        self.reset(self.idle_timeout);
    }

    pub(in crate::llm) fn reset(&mut self, timeout: Duration) {
        self.timer
            .as_mut()
            .reset(tokio::time::Instant::now() + timeout);
    }

    pub(in crate::llm) fn timeout_error(&self) -> NormalizedModelError {
        if self.first_byte_seen {
            coded_error(
                NormalizedModelErrorKind::Timeout,
                format!(
                    "AI provider stream was idle for {} ms",
                    self.idle_timeout.as_millis()
                ),
                "STREAM_IDLE_TIMEOUT",
            )
        } else {
            coded_error(
                NormalizedModelErrorKind::Timeout,
                format!(
                    "AI provider returned no stream bytes within {} ms",
                    self.first_byte_timeout.as_millis()
                ),
                "FIRST_BYTE_TIMEOUT",
            )
        }
    }

    pub(in crate::llm) fn empty_response_error(&self, stream_name: &str) -> NormalizedModelError {
        coded_error(
            NormalizedModelErrorKind::EmptyResponse,
            format!("{stream_name} returned an empty response body"),
            "EMPTY_RESPONSE",
        )
    }
}
