use super::limits::*;
use futures_util::StreamExt;
use reqwest::{Client, Response};
use serde_json::Value;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
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

pub(crate) fn build_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("ShellSpan/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("failed to create AI HTTP client: {error}"))
}

pub(crate) fn build_streaming_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("ShellSpan/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("failed to create streaming AI HTTP client: {error}"))
}

pub(crate) async fn checked_response(response: Response) -> Result<Response, String> {
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

pub(crate) async fn checked_json(response: Response) -> Result<Value, String> {
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
