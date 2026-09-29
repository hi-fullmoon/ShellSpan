use reqwest::{
    header::{HeaderValue, CONNECTION, CONTENT_TYPE},
    StatusCode,
};
use std::{io::ErrorKind, sync::atomic::Ordering, time::Instant};
use tokio_util::sync::CancellationToken;

use super::{
    types::{RequestFailure, RequestResult, SecretToken, StateCommand, StateRequest},
    PetdexAdapter,
};

const UPDATE_TOKEN_HEADER: &str = "X-Petdex-Update-Token";
const MAX_PROTOCOL_RESPONSE_BYTES: usize = 1024;

#[derive(serde::Deserialize)]
struct ProtocolHealth {
    ok: bool,
    port: u16,
}

impl ProtocolHealth {
    fn compatible(&self) -> bool {
        self.ok && self.port == 7777
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolIdentity {
    ok: bool,
    pid: u32,
    in_process: bool,
}

impl ProtocolIdentity {
    fn compatible(&self) -> bool {
        self.ok && self.in_process && self.pid > 0 && self.pid <= i32::MAX as u32
    }
}

fn decode_protocol_response<T: serde::de::DeserializeOwned>(
    body: &[u8],
) -> Result<T, RequestFailure> {
    if body.len() > MAX_PROTOCOL_RESPONSE_BYTES {
        return Err(RequestFailure::Rejected);
    }
    serde_json::from_slice(body).map_err(|_| RequestFailure::Rejected)
}

impl PetdexAdapter {
    // Anonymous health is never recorded as authenticated state delivery.
    pub(super) async fn check_health(&self) -> super::types::PetdexHealth {
        use super::types::PetdexHealth;
        let cancellation = {
            let control = self
                .inner
                .coordinator
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if !self.inner.enabled.load(Ordering::Acquire) {
                return PetdexHealth::Disabled;
            }
            control.cancellation.clone()
        };
        let check = async {
            let _guard = self.inner.request_lock.lock().await;
            let health: ProtocolHealth = self.protocol_response("/health").await.map_err(|_| ())?;
            if health.compatible() {
                Ok(())
            } else {
                Err(())
            }
        };
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => PetdexHealth::Disabled,
            result = tokio::time::timeout(super::REQUEST_TIMEOUT * 2, check) => {
                if cancellation.is_cancelled() { PetdexHealth::Disabled }
                else if matches!(result, Ok(Ok(()))) { PetdexHealth::Reachable }
                else { PetdexHealth::Unavailable }
            }
        }
    }

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
            result = tokio::time::timeout(super::STATE_ATTEMPT_TIMEOUT,
                self.apply_state_serialized(command, cancellation.clone())) =>
                result.unwrap_or(Err(RequestFailure::Transport)),
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
        command.remaining_duration(Instant::now())?;

        // Preserve missing/unreadable-file diagnostics without reading a secret.
        tokio::fs::metadata(&self.inner.token_path)
            .await
            .map_err(|error| match error.kind() {
                ErrorKind::NotFound => RequestFailure::TokenMissing,
                _ => RequestFailure::TokenUnreadable,
            })?;
        // Compatibility only, not peer authentication: another local process
        // can claim this contract, or replace the listener after these checks.
        self.check_protocol_compatibility().await?;
        let first_token = self.read_token().await?;
        if cancellation.is_cancelled() || !self.inner.enabled.load(Ordering::Acquire) {
            return Err(RequestFailure::Disabled);
        }
        let first_status = match self.post_state(command, &first_token).await {
            Ok(status) => status,
            Err(RequestFailure::Transport) => {
                // The next coordinator attempt checks compatibility before
                // rereading the file; never read a secret after a failed probe.
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
        self.check_protocol_compatibility().await?;
        let refreshed_token = self.read_token().await?;
        if cancellation.is_cancelled() || !self.inner.enabled.load(Ordering::Acquire) {
            return Err(RequestFailure::Disabled);
        }
        if refreshed_token == first_token {
            return Err(RequestFailure::Unauthorized);
        }
        Self::classify_status(self.post_state(command, &refreshed_token).await?)
    }

    pub(super) async fn read_token(&self) -> Result<SecretToken, RequestFailure> {
        let raw = tokio::fs::read_to_string(&self.inner.token_path)
            .await
            .map_err(|error| match error.kind() {
                ErrorKind::NotFound => RequestFailure::TokenMissing,
                _ => RequestFailure::TokenUnreadable,
            })?;
        let token = raw.trim();
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(RequestFailure::TokenInvalid);
        }
        Ok(SecretToken::new(token.to_string()))
    }

    async fn protocol_response<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
    ) -> Result<T, RequestFailure> {
        let client = self
            .inner
            .client
            .as_ref()
            .ok_or(RequestFailure::Transport)?;
        let endpoint = self
            .inner
            .endpoint
            .as_ref()
            .ok_or(RequestFailure::Transport)?
            .join(path)
            .map_err(|_| RequestFailure::Transport)?;
        let mut response = client
            .get(endpoint)
            .header(CONNECTION, "close")
            .send()
            .await
            .map_err(|_| RequestFailure::Transport)?;
        if response.status() != StatusCode::OK
            || response
                .content_length()
                .is_some_and(|size| size > MAX_PROTOCOL_RESPONSE_BYTES as u64)
        {
            return Err(RequestFailure::Rejected);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| RequestFailure::Transport)?
        {
            if body.len().saturating_add(chunk.len()) > MAX_PROTOCOL_RESPONSE_BYTES {
                return Err(RequestFailure::Rejected);
            }
            body.extend_from_slice(&chunk);
        }
        decode_protocol_response(&body)
    }

    async fn check_protocol_compatibility(&self) -> Result<(), RequestFailure> {
        let health: ProtocolHealth = self.protocol_response("/health").await?;
        if !health.compatible() {
            return Err(RequestFailure::Rejected);
        }
        let identity: ProtocolIdentity = self.protocol_response("/whoami").await?;
        if !identity.compatible() {
            return Err(RequestFailure::Rejected);
        }
        Ok(())
    }

    async fn post_state(
        &self,
        command: StateCommand,
        token: &SecretToken,
    ) -> Result<StatusCode, RequestFailure> {
        // Repeat immediately before each authenticated attempt, including the
        // single token-rotation retry. Never attach a token to either probe.
        self.check_protocol_compatibility().await?;
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
        let mut token_header =
            HeaderValue::from_str(token.expose()).map_err(|_| RequestFailure::TokenInvalid)?;
        token_header.set_sensitive(true);
        let duration = command.remaining_duration(Instant::now())?.map(|duration| {
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

#[cfg(test)]
mod protocol_tests {
    use super::*;

    #[test]
    fn accepts_only_the_native_anonymous_contract() {
        let health: ProtocolHealth = decode_protocol_response(br#"{"ok":true,"port":7777}"#)
            .unwrap_or_else(|_| panic!("health contract"));
        assert!(health.compatible());
        let identity: ProtocolIdentity = decode_protocol_response(
            br#"{"ok":true,"pid":51462,"parentPid":null,"inProcess":true}"#,
        )
        .unwrap_or_else(|_| panic!("whoami contract"));
        assert!(identity.compatible());
        for body in [
            br#"{"ok":false,"port":7777}"#.as_slice(),
            br#"{"ok":true,"port":80}"#,
        ] {
            assert!(!decode_protocol_response::<ProtocolHealth>(body)
                .unwrap_or_else(|_| panic!("health JSON"))
                .compatible());
        }
        for body in [
            br#"{"ok":true,"pid":0,"inProcess":true}"#.as_slice(),
            br#"{"ok":true,"pid":51462,"inProcess":false}"#,
            br#"{"ok":false,"pid":51462,"inProcess":true}"#,
            br#"{"ok":true,"pid":4294967295,"inProcess":true}"#,
        ] {
            assert!(!decode_protocol_response::<ProtocolIdentity>(body)
                .unwrap_or_else(|_| panic!("whoami JSON"))
                .compatible());
        }
    }

    #[test]
    fn rejects_non_json_incomplete_contracts_and_oversized_responses() {
        for body in [
            b"<!DOCTYPE HTML>".as_slice(),
            b"{}",
            br#"{"ok":"true","port":7777}"#,
        ] {
            assert!(matches!(
                decode_protocol_response::<ProtocolHealth>(body),
                Err(RequestFailure::Rejected)
            ));
        }
        assert!(matches!(
            decode_protocol_response::<ProtocolHealth>(&vec![
                b' ';
                MAX_PROTOCOL_RESPONSE_BYTES + 1
            ]),
            Err(RequestFailure::Rejected)
        ));
        assert!(matches!(
            decode_protocol_response::<ProtocolIdentity>(
                br#"{"ok":true,"pid":-1,"inProcess":true}"#
            ),
            Err(RequestFailure::Rejected)
        ));
    }
}
