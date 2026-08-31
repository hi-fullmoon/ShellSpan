use reqwest::{
    header::{HeaderValue, CONNECTION, CONTENT_TYPE},
    StatusCode,
};
use std::{fs, io::ErrorKind, sync::atomic::Ordering};
use tokio_util::sync::CancellationToken;

use super::{
    types::{RequestFailure, RequestResult, SecretToken, StateCommand, StateRequest},
    PetdexAdapter,
};

const UPDATE_TOKEN_HEADER: &str = "X-Petdex-Update-Token";

impl PetdexAdapter {
    pub(super) async fn apply_state(
        &self,
        command: StateCommand,
        cancellation: CancellationToken,
    ) -> RequestResult {
        if !self.inner.enabled.load(Ordering::Acquire) {
            return RequestResult::Disabled;
        }

        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(RequestFailure::Disabled),
            result = self.apply_state_serialized(command, cancellation.clone()) => result,
        };
        RequestResult::from_result(result)
    }

    async fn apply_state_serialized(
        &self,
        command: StateCommand,
        cancellation: CancellationToken,
    ) -> Result<(), RequestFailure> {
        let _request_guard = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(RequestFailure::Disabled),
            guard = self.inner.request_lock.lock() => guard,
        };
        if cancellation.is_cancelled() || !self.inner.enabled.load(Ordering::Acquire) {
            return Err(RequestFailure::Disabled);
        }

        let first_token = self.read_token()?;
        if cancellation.is_cancelled() || !self.inner.enabled.load(Ordering::Acquire) {
            return Err(RequestFailure::Disabled);
        }
        let first_status = match self.post_state(command, &first_token).await {
            Ok(status) => status,
            Err(RequestFailure::Transport) => {
                // Refresh the file after a restart-shaped failure. The
                // coordinator performs the bounded retry after its backoff.
                let _ = self.read_token();
                return Err(RequestFailure::Transport);
            }
            Err(other) => return Err(other),
        };

        if first_status != StatusCode::UNAUTHORIZED {
            return Self::classify_status(first_status);
        }

        // Authentication failures get one immediate retry only when Petdex
        // actually replaced the token. Persistent failures are handled by the
        // bounded coordinator backoff, never an authentication loop.
        let refreshed_token = self.read_token()?;
        if refreshed_token == first_token {
            return Err(RequestFailure::Unauthorized);
        }
        Self::classify_status(self.post_state(command, &refreshed_token).await?)
    }

    pub(super) fn read_token(&self) -> Result<SecretToken, RequestFailure> {
        let raw =
            fs::read_to_string(&self.inner.token_path).map_err(|error| match error.kind() {
                ErrorKind::NotFound => RequestFailure::TokenMissing,
                _ => RequestFailure::TokenUnreadable,
            })?;
        let token = raw.trim();
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(RequestFailure::TokenInvalid);
        }
        Ok(SecretToken::new(token.to_string()))
    }

    async fn post_state(
        &self,
        command: StateCommand,
        token: &SecretToken,
    ) -> Result<StatusCode, RequestFailure> {
        let client = self
            .inner
            .client
            .as_ref()
            .ok_or(RequestFailure::Transport)?;
        let endpoint = self
            .inner
            .endpoint
            .as_ref()
            .ok_or(RequestFailure::Transport)?;
        let token_header =
            HeaderValue::from_str(token.expose()).map_err(|_| RequestFailure::TokenInvalid)?;
        let duration = command.duration.map(|duration| {
            let millis = duration.as_millis().max(1);
            u64::try_from(millis).unwrap_or(u64::MAX).min(30_000)
        });
        client
            .post(endpoint.clone())
            .header(CONTENT_TYPE, "application/json")
            .header(CONNECTION, "close")
            .header(UPDATE_TOKEN_HEADER, token_header)
            .json(&StateRequest {
                state: command.state,
                duration,
            })
            .send()
            .await
            .map(|response| response.status())
            .map_err(|_| RequestFailure::Transport)
    }

    fn classify_status(status: StatusCode) -> Result<(), RequestFailure> {
        match status {
            StatusCode::OK => Ok(()),
            StatusCode::UNAUTHORIZED => Err(RequestFailure::Unauthorized),
            _ => Err(RequestFailure::Rejected),
        }
    }
}
