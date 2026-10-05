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

#[derive(Default)]
pub(super) struct WritePolicy {
    last_write: Option<Instant>,
    limited_until: Option<Instant>,
    pid: Option<u32>,
    pub generation: u64,
    failures: u32,
    retry_at: Option<Instant>,
}

impl WritePolicy {
    #[cfg(all(test, target_os = "macos"))]
    pub fn pid_for_test(&self) -> u32 {
        self.pid.unwrap()
    }
    pub fn deadline(&self, now: Instant) -> Instant {
        self.last_write
            .map(|t| t + super::MIN_SEND_INTERVAL)
            .unwrap_or(now)
            .max(self.limited_until.unwrap_or(now))
            .max(self.retry_at.unwrap_or(now))
            .max(now)
    }
    pub fn observe(&mut self, pid: u32) {
        if self.pid != Some(pid) {
            self.pid = Some(pid);
            self.generation += 1;
        }
    }
    pub fn record(&mut self, status: StatusCode, now: Instant) {
        if status == StatusCode::TOO_MANY_REQUESTS {
            self.limited_until = Some(now + std::time::Duration::from_secs(1));
        }
    }
    pub fn result(&mut self, result: RequestResult, now: Instant) {
        if result == RequestResult::Applied {
            self.failures = 0;
            self.retry_at = None;
        } else if result.should_retry() && self.retry_at.is_none_or(|deadline| now >= deadline) {
            // Another channel or a bounded manual request can time out while
            // waiting for this backoff. It has not made a new attempt and must
            // not move the recovery deadline or increase the failure count.
            self.failures = self.failures.saturating_add(1);
            self.retry_at = Some(now + super::delivery::failure_backoff(self.failures));
        }
    }
}

#[derive(serde::Deserialize)]
struct BubbleReceipt {
    ok: bool,
    counter: u64,
}

fn validate_bubble_receipt(body: &[u8]) -> Result<(), RequestFailure> {
    let receipt: BubbleReceipt = decode_protocol_response(body)?;
    if receipt.ok && receipt.counter > 0 {
        Ok(())
    } else {
        Err(RequestFailure::Rejected)
    }
}

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
        let result = RequestResult::from_result(result);
        self.record_transport_result(result);
        result
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
        self.wait_write().await;
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
        let refreshed_token = self.refresh_token(&first_token).await?;
        if cancellation.is_cancelled() || !self.inner.enabled.load(Ordering::Acquire) {
            return Err(RequestFailure::Disabled);
        }
        Self::classify_status(self.post_state(command, &refreshed_token).await?)
    }

    pub(super) async fn refresh_token(
        &self,
        first: &SecretToken,
    ) -> Result<SecretToken, RequestFailure> {
        self.check_protocol_compatibility().await?;
        let refreshed = self.read_token().await?;
        if &refreshed == first {
            Err(RequestFailure::Unauthorized)
        } else {
            Ok(refreshed)
        }
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

    pub(super) async fn check_protocol_compatibility(&self) -> Result<(), RequestFailure> {
        let health: ProtocolHealth = self.protocol_response("/health").await?;
        if !health.compatible() {
            return Err(RequestFailure::Rejected);
        }
        let identity: ProtocolIdentity = self.protocol_response("/whoami").await?;
        if !identity.compatible() {
            return Err(RequestFailure::Rejected);
        }
        self.inner
            .write_policy
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .observe(identity.pid);
        Ok(())
    }

    pub(super) fn service_generation(&self) -> u64 {
        self.inner
            .write_policy
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .generation
    }

    pub(super) fn record_transport_result(&self, result: RequestResult) {
        self.inner
            .write_policy
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .result(result, Instant::now());
    }

    pub(super) fn write_deadline(&self, now: Instant) -> Instant {
        self.inner
            .write_policy
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .deadline(now)
    }

    // Caller holds request_lock. Recheck even after coordinator scheduling:
    // a manual request may have changed the shared clock in the meantime.
    // This final wait remains inside the caller's total attempt budget.
    pub(super) async fn wait_write(&self) {
        let deadline = self.write_deadline(Instant::now());
        tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
    }

    pub(super) async fn post_bytes(
        &self,
        path: &str,
        bytes: Vec<u8>,
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
            .ok_or(RequestFailure::Transport)?
            .join(path)
            .map_err(|_| RequestFailure::Transport)?;
        let mut header =
            HeaderValue::from_str(token.expose()).map_err(|_| RequestFailure::TokenInvalid)?;
        header.set_sensitive(true);
        self.inner
            .write_policy
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .last_write = Some(Instant::now());
        let mut response = client
            .post(endpoint)
            .header(CONTENT_TYPE, "application/json")
            .header(CONNECTION, "close")
            .header(UPDATE_TOKEN_HEADER, header)
            .body(bytes)
            .send()
            .await
            .map_err(|_| RequestFailure::Transport)?;
        let status = response.status();
        self.inner
            .write_policy
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .record(status, Instant::now());
        if response
            .content_length()
            .is_some_and(|n| n > MAX_PROTOCOL_RESPONSE_BYTES as u64)
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
        if path == "/bubble" && status == StatusCode::OK {
            validate_bubble_receipt(&body)?;
        }
        Ok(status)
    }

    async fn post_state(
        &self,
        command: StateCommand,
        token: &SecretToken,
    ) -> Result<StatusCode, RequestFailure> {
        // Repeat immediately before each authenticated attempt, including the
        // single token-rotation retry. Never attach a token to either probe.
        self.wait_write().await;
        self.check_protocol_compatibility().await?;
        let duration = command.remaining_duration(Instant::now())?.map(|duration| {
            let millis = duration.as_millis().max(1);
            u64::try_from(millis).unwrap_or(u64::MAX).min(30_000)
        });
        let bytes = serde_json::to_vec(&StateRequest {
            state: command.state,
            duration,
        })
        .map_err(|_| RequestFailure::Rejected)?;
        self.post_bytes("/state", bytes, token).await
    }

    pub(super) fn classify_status(status: StatusCode) -> Result<(), RequestFailure> {
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
    fn bubble_receipt_requires_bounded_success_and_integer_counter() {
        assert!(validate_bubble_receipt(br#"{"ok":true,"counter":123,"extra":true}"#).is_ok());
        for body in [
            b"".as_slice(),
            b"<html>",
            br#"{"ok":false,"counter":1}"#,
            br#"{"ok":true}"#,
            br#"{"counter":1}"#,
            br#"{"ok":true,"counter":-1}"#,
            br#"{"ok":true,"counter":1.5}"#,
            br#"{"ok":true,"counter":"1"}"#,
            br#"{"ok":true,"counter":0}"#,
        ] {
            assert!(validate_bubble_receipt(body).is_err());
        }
        assert!(validate_bubble_receipt(&vec![b' '; 1025]).is_err());
    }

    #[test]
    fn writes_retries_and_both_channels_share_interval_rate_limit_and_failure_backoff() {
        let now = Instant::now();
        let mut policy = WritePolicy::default();
        assert_eq!(policy.deadline(now), now);
        policy.last_write = Some(now);
        assert_eq!(policy.deadline(now), now + super::super::MIN_SEND_INTERVAL);
        policy.record(StatusCode::TOO_MANY_REQUESTS, now);
        policy.result(RequestResult::Applied, now);
        assert_eq!(
            policy.deadline(now),
            now + std::time::Duration::from_secs(1)
        );
        let mut attempt_at = now;
        for result in [
            RequestResult::Transport,
            RequestResult::Unauthorized,
            RequestResult::Rejected,
            RequestResult::Transport,
        ] {
            attempt_at = policy.deadline(attempt_at);
            policy.result(result, attempt_at);
        }
        assert_eq!(
            policy.deadline(attempt_at),
            attempt_at + std::time::Duration::from_secs(2)
        );
        policy.observe(1);
        let generation = policy.generation;
        policy.observe(1);
        assert_eq!(policy.generation, generation);
        policy.observe(2);
        assert_eq!(policy.generation, generation + 1);
    }

    #[tokio::test]
    async fn both_channels_timing_out_in_backoff_leave_recovery_deadline_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let adapter = PetdexAdapter::new(root.path().to_owned());
        adapter.set_enabled_for_io_test(true);
        adapter.set_message_preferences(super::super::message_content::MessagePreferences {
            petdex_messages_enabled: true,
            petdex_message_details_enabled: false,
        });
        let recovery_at = {
            let mut policy = adapter.inner.write_policy.lock().unwrap();
            let elapsed: std::time::Duration =
                (1..9).map(super::super::delivery::failure_backoff).sum();
            let mut now = Instant::now() - elapsed;
            for _ in 0..9 {
                now = policy.deadline(now);
                policy.result(RequestResult::Transport, now);
            }
            policy.deadline(now)
        };
        let command = StateCommand {
            state: super::super::types::PetdexState::Running,
            expires_at: None,
        };
        let (action, message) = tokio::join!(
            adapter.apply_state(command, adapter.cancellation_token()),
            adapter.test_message(),
        );
        assert_eq!(action, RequestResult::Transport);
        assert_eq!(
            message.outcome,
            super::super::message_delivery::MessageTestOutcome::Failed
        );
        let mut policy = adapter.inner.write_policy.lock().unwrap();
        assert_eq!(policy.deadline(Instant::now()), recovery_at);
        assert_eq!(policy.failures, 9);
        assert_eq!(policy.deadline(recovery_at), recovery_at);
        policy.result(RequestResult::Applied, recovery_at);
        assert_eq!(policy.failures, 0);
        assert!(policy.retry_at.is_none());
    }

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
