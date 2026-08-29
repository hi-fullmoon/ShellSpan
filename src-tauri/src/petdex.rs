use reqwest::{
    header::{HeaderValue, CONNECTION, CONTENT_TYPE},
    Client, StatusCode, Url,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::sync::CancellationToken;

const PETDEX_STATE_ENDPOINT: &str = "http://127.0.0.1:7777/state";
const PETDEX_STATUS_EVENT: &str = "petdex-status";
const UPDATE_TOKEN_HEADER: &str = "X-Petdex-Update-Token";
const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const REQUEST_TIMEOUT: Duration = Duration::from_millis(750);
const MIN_SEND_INTERVAL: Duration = Duration::from_millis(100);
const INITIAL_FAILURE_BACKOFF: Duration = Duration::from_millis(250);
const MAX_FAILURE_BACKOFF: Duration = Duration::from_secs(4);
const RECOVERY_PROBE_INTERVAL: Duration = Duration::from_secs(5);
const SUCCESS_TTL: Duration = Duration::from_millis(1_200);
const FAILURE_TTL: Duration = Duration::from_millis(2_500);
const SSH_CONNECTING_PRIORITY: u8 = 40;
const SFTP_ACTIVE_PRIORITY: u8 = 50;
const AI_ACTIVE_PRIORITY: u8 = 60;
const SUCCESS_PRIORITY: u8 = 80;
const FAILURE_PRIORITY: u8 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum PetdexState {
    Idle,
    Waiting,
    Waving,
    Running,
    Jumping,
    Failed,
}

impl PetdexState {
    fn temporary_priority(self) -> u8 {
        match self {
            Self::Failed => FAILURE_PRIORITY,
            Self::Waving | Self::Jumping => SUCCESS_PRIORITY,
            Self::Idle | Self::Waiting | Self::Running => 0,
        }
    }

    fn ttl(self) -> Option<Duration> {
        match self {
            Self::Waving | Self::Jumping => Some(SUCCESS_TTL),
            Self::Failed => Some(FAILURE_TTL),
            Self::Idle | Self::Waiting | Self::Running => None,
        }
    }
}

#[derive(Clone)]
pub(crate) enum PetdexEvent {
    SshConnecting(String),
    SshConnected(String),
    SshFailed(String),
    SshClosed(String),
    SftpStarted(String),
    SftpSucceeded(String),
    SftpFailed(String),
    SftpCancelled(String),
    AiStarted(String),
    AiSucceeded(String),
    AiFailed(String),
    AiCancelled(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PetdexConnectionStatus {
    NotDetected = 0,
    Connected = 1,
    NotRunning = 2,
    ConnectionError = 3,
}

impl PetdexConnectionStatus {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Connected,
            2 => Self::NotRunning,
            3 => Self::ConnectionError,
            _ => Self::NotDetected,
        }
    }
}

#[derive(Clone, Copy)]
struct StateCommand {
    state: PetdexState,
    duration: Option<Duration>,
}

impl StateCommand {
    #[cfg(test)]
    fn full_ttl(state: PetdexState) -> Self {
        Self {
            state,
            duration: state.ttl(),
        }
    }

    fn from_target(target: ArbitrationTarget, now: Instant) -> Self {
        Self {
            state: target.state,
            duration: target
                .expires_at
                .and_then(|expires_at| expires_at.checked_duration_since(now)),
        }
    }
}

#[derive(Serialize)]
struct StateRequest {
    state: PetdexState,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration: Option<u64>,
}

struct SecretToken(String);

impl SecretToken {
    fn expose(&self) -> &str {
        &self.0
    }
}

impl PartialEq for SecretToken {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

#[derive(Clone, Copy)]
enum RequestFailure {
    Disabled,
    TokenMissing,
    TokenUnreadable,
    TokenInvalid,
    Transport,
    Unauthorized,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestResult {
    Applied,
    Disabled,
    TokenMissing,
    TokenUnreadable,
    TokenInvalid,
    Transport,
    Unauthorized,
    Rejected,
}

impl RequestResult {
    fn from_result(result: Result<(), RequestFailure>) -> Self {
        match result {
            Ok(()) => Self::Applied,
            Err(RequestFailure::Disabled) => Self::Disabled,
            Err(RequestFailure::TokenMissing) => Self::TokenMissing,
            Err(RequestFailure::TokenUnreadable) => Self::TokenUnreadable,
            Err(RequestFailure::TokenInvalid) => Self::TokenInvalid,
            Err(RequestFailure::Transport) => Self::Transport,
            Err(RequestFailure::Unauthorized) => Self::Unauthorized,
            Err(RequestFailure::Rejected) => Self::Rejected,
        }
    }

    fn connection_status(self) -> PetdexConnectionStatus {
        match self {
            Self::Applied => PetdexConnectionStatus::Connected,
            Self::Disabled | Self::TokenMissing => PetdexConnectionStatus::NotDetected,
            Self::Transport => PetdexConnectionStatus::NotRunning,
            Self::TokenUnreadable | Self::TokenInvalid | Self::Unauthorized | Self::Rejected => {
                PetdexConnectionStatus::ConnectionError
            }
        }
    }

    fn diagnostic_category(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Disabled => "disabled",
            Self::TokenMissing => "token-missing",
            Self::TokenUnreadable => "token-unreadable",
            Self::TokenInvalid => "token-invalid",
            Self::Transport => "transport-unavailable",
            Self::Unauthorized => "unauthorized",
            Self::Rejected => "rejected",
        }
    }

    fn should_retry(self) -> bool {
        self != Self::Applied && self != Self::Disabled
    }
}

#[derive(Clone, Copy)]
struct TemporaryState {
    state: PetdexState,
    expires_at: Instant,
    sequence: u64,
}

#[derive(Clone, Copy)]
struct ArbitrationTarget {
    state: PetdexState,
    expires_at: Option<Instant>,
}

#[derive(Default)]
struct PetdexArbiter {
    ssh_known: HashSet<String>,
    ssh_connecting: HashSet<String>,
    sftp_active: HashSet<String>,
    ai_active: HashSet<String>,
    waving: Option<TemporaryState>,
    jumping: Option<TemporaryState>,
    failed: Option<TemporaryState>,
    sequence: u64,
}

impl PetdexArbiter {
    fn apply(&mut self, event: PetdexEvent, now: Instant) {
        match event {
            PetdexEvent::SshConnecting(operation_id) => {
                self.ssh_known.insert(operation_id.clone());
                self.ssh_connecting.insert(operation_id);
            }
            PetdexEvent::SshConnected(operation_id) => {
                if self.ssh_connecting.remove(&operation_id) {
                    self.pulse(PetdexState::Waving, now);
                }
            }
            PetdexEvent::SshFailed(operation_id) => {
                self.ssh_connecting.remove(&operation_id);
                if self.ssh_known.remove(&operation_id) {
                    self.pulse(PetdexState::Failed, now);
                }
            }
            PetdexEvent::SshClosed(operation_id) => {
                self.ssh_connecting.remove(&operation_id);
                self.ssh_known.remove(&operation_id);
            }
            PetdexEvent::SftpStarted(operation_id) => {
                self.sftp_active.insert(operation_id);
            }
            PetdexEvent::SftpSucceeded(operation_id) => {
                if self.sftp_active.remove(&operation_id) {
                    self.pulse(PetdexState::Jumping, now);
                }
            }
            PetdexEvent::SftpFailed(operation_id) => {
                if self.sftp_active.remove(&operation_id) {
                    self.pulse(PetdexState::Failed, now);
                }
            }
            PetdexEvent::SftpCancelled(operation_id) => {
                self.sftp_active.remove(&operation_id);
            }
            PetdexEvent::AiStarted(operation_id) => {
                self.ai_active.insert(operation_id);
            }
            PetdexEvent::AiSucceeded(operation_id) => {
                if self.ai_active.remove(&operation_id) {
                    self.pulse(PetdexState::Jumping, now);
                }
            }
            PetdexEvent::AiFailed(operation_id) => {
                if self.ai_active.remove(&operation_id) {
                    self.pulse(PetdexState::Failed, now);
                }
            }
            PetdexEvent::AiCancelled(operation_id) => {
                self.ai_active.remove(&operation_id);
            }
        }
    }

    fn pulse(&mut self, state: PetdexState, now: Instant) {
        let Some(ttl) = state.ttl() else {
            return;
        };
        let slot = match state {
            PetdexState::Waving => &mut self.waving,
            PetdexState::Jumping => &mut self.jumping,
            PetdexState::Failed => &mut self.failed,
            PetdexState::Idle | PetdexState::Waiting | PetdexState::Running => return,
        };
        if slot.is_some_and(|current| current.expires_at > now) {
            return;
        }
        self.sequence = self.sequence.wrapping_add(1);
        *slot = Some(TemporaryState {
            state,
            expires_at: now + ttl,
            sequence: self.sequence,
        });
    }

    fn clear_temporaries(&mut self) {
        self.waving = None;
        self.jumping = None;
        self.failed = None;
    }

    fn prune(&mut self, now: Instant) {
        for slot in [&mut self.waving, &mut self.jumping, &mut self.failed] {
            if slot.is_some_and(|temporary| temporary.expires_at <= now) {
                *slot = None;
            }
        }
    }

    fn target(&mut self, now: Instant) -> ArbitrationTarget {
        self.prune(now);
        let temporary = [self.waving, self.jumping, self.failed]
            .into_iter()
            .flatten()
            .max_by_key(|temporary| (temporary.state.temporary_priority(), temporary.sequence));
        if let Some(temporary) = temporary {
            return ArbitrationTarget {
                state: temporary.state,
                expires_at: Some(temporary.expires_at),
            };
        }

        // Persistent priorities are AI waiting (60), transfer running (50),
        // then SSH connecting (40). Waiting has a single wire value, but the
        // separate sets preserve the priority and independent lifecycles.
        let state = [
            (
                !self.ssh_connecting.is_empty(),
                PetdexState::Waiting,
                SSH_CONNECTING_PRIORITY,
            ),
            (
                !self.sftp_active.is_empty(),
                PetdexState::Running,
                SFTP_ACTIVE_PRIORITY,
            ),
            (
                !self.ai_active.is_empty(),
                PetdexState::Waiting,
                AI_ACTIVE_PRIORITY,
            ),
        ]
        .into_iter()
        .filter(|(active, _, _)| *active)
        .max_by_key(|(_, _, priority)| *priority)
        .map(|(_, state, _)| state)
        .unwrap_or(PetdexState::Idle);
        ArbitrationTarget {
            state,
            expires_at: None,
        }
    }

    fn next_expiry(&self) -> Option<Instant> {
        [self.waving, self.jumping, self.failed]
            .into_iter()
            .flatten()
            .map(|temporary| temporary.expires_at)
            .min()
    }
}

#[derive(Default)]
struct DeliveryPolicy {
    last_sent: Option<PetdexState>,
    last_success_at: Option<Instant>,
    last_attempt_at: Option<Instant>,
    retry_at: Option<Instant>,
    consecutive_failures: u32,
}

impl DeliveryPolicy {
    fn attempt_deadline(&self, target: ArbitrationTarget, now: Instant) -> Option<Instant> {
        let state_changed = self.last_sent != Some(target.state);
        let recovery_due = self
            .last_success_at
            .is_some_and(|last_success| now >= last_success + RECOVERY_PROBE_INTERVAL);
        if !state_changed && !recovery_due {
            return self
                .last_success_at
                .map(|last_success| last_success + RECOVERY_PROBE_INTERVAL);
        }

        let mut deadline = now;
        if let Some(last_attempt) = self.last_attempt_at {
            deadline = deadline.max(last_attempt + MIN_SEND_INTERVAL);
        }
        if let Some(retry_at) = self.retry_at {
            deadline = deadline.max(retry_at);
        }
        Some(deadline)
    }

    fn record(&mut self, state: PetdexState, result: RequestResult, now: Instant) {
        self.last_attempt_at = Some(now);
        if result == RequestResult::Applied {
            self.last_sent = Some(state);
            self.last_success_at = Some(now);
            self.retry_at = None;
            self.consecutive_failures = 0;
            return;
        }

        self.last_sent = None;
        if result.should_retry() {
            self.consecutive_failures = self.consecutive_failures.saturating_add(1);
            self.retry_at = Some(now + failure_backoff(self.consecutive_failures));
        }
    }

    fn reset_backoff(&mut self) {
        self.retry_at = None;
        self.consecutive_failures = 0;
    }
}

fn failure_backoff(consecutive_failures: u32) -> Duration {
    let exponent = consecutive_failures.saturating_sub(1).min(4);
    let multiplier = 1_u32 << exponent;
    (INITIAL_FAILURE_BACKOFF * multiplier).min(MAX_FAILURE_BACKOFF)
}

enum CoordinatorMessage {
    Event(PetdexEvent),
    Test(oneshot::Sender<PetdexConnectionStatus>),
}

struct CoordinatorControl {
    cancellation: CancellationToken,
    sender: Option<mpsc::UnboundedSender<CoordinatorMessage>>,
}

struct PetdexAdapterInner {
    client: Option<Client>,
    endpoint: Option<Url>,
    token_path: PathBuf,
    enabled: AtomicBool,
    status: AtomicU8,
    coordinator: StdMutex<CoordinatorControl>,
    request_lock: Mutex<()>,
}

#[derive(Clone)]
pub(crate) struct PetdexAdapter {
    inner: Arc<PetdexAdapterInner>,
}

impl PetdexAdapter {
    pub(crate) fn new(home_dir: PathBuf) -> Self {
        Self::build(
            Url::parse(PETDEX_STATE_ENDPOINT).ok(),
            home_dir
                .join(".petdex")
                .join("runtime")
                .join("update-token"),
        )
    }

    fn build(endpoint: Option<Url>, token_path: PathBuf) -> Self {
        let client = Client::builder()
            .no_proxy()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .ok();
        Self {
            inner: Arc::new(PetdexAdapterInner {
                client,
                endpoint,
                token_path,
                enabled: AtomicBool::new(false),
                status: AtomicU8::new(PetdexConnectionStatus::NotDetected as u8),
                coordinator: StdMutex::new(CoordinatorControl {
                    cancellation: CancellationToken::new(),
                    sender: None,
                }),
                request_lock: Mutex::new(()),
            }),
        }
    }

    #[cfg(test)]
    fn fixture(endpoint: Url, token_path: PathBuf) -> Self {
        assert_eq!(endpoint.scheme(), "http");
        assert_eq!(endpoint.host_str(), Some("127.0.0.1"));
        assert_eq!(endpoint.path(), "/state");
        assert!(endpoint.username().is_empty());
        assert!(endpoint.password().is_none());
        assert!(endpoint.query().is_none());
        assert!(endpoint.fragment().is_none());
        Self::build(Some(endpoint), token_path)
    }

    fn status(&self) -> PetdexConnectionStatus {
        PetdexConnectionStatus::from_u8(self.inner.status.load(Ordering::Acquire))
    }

    fn set_enabled(&self, app: &AppHandle, enabled: bool) -> PetdexConnectionStatus {
        if enabled && self.inner.enabled.load(Ordering::Acquire) {
            return self.status();
        }
        if enabled {
            self.inner
                .status
                .store(PetdexConnectionStatus::NotDetected as u8, Ordering::Release);
            let status = PetdexConnectionStatus::NotDetected;
            let _ = app.emit(PETDEX_STATUS_EVENT, status);
            self.start_coordinator(app.clone());
            status
        } else {
            self.stop_coordinator();
            self.inner
                .status
                .store(PetdexConnectionStatus::NotDetected as u8, Ordering::Release);
            let status = PetdexConnectionStatus::NotDetected;
            let _ = app.emit(PETDEX_STATUS_EVENT, status);
            status
        }
    }

    fn start_coordinator(&self, app: AppHandle) {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.inner.enabled.load(Ordering::Acquire) && control.sender.is_some() {
            return;
        }

        control.cancellation.cancel();
        let cancellation = CancellationToken::new();
        let (sender, receiver) = mpsc::unbounded_channel();
        control.cancellation = cancellation.clone();
        control.sender = Some(sender);
        self.inner.enabled.store(true, Ordering::Release);
        drop(control);

        let adapter = self.clone();
        tauri::async_runtime::spawn(async move {
            adapter.run_coordinator(app, receiver, cancellation).await;
        });
    }

    fn stop_coordinator(&self) {
        self.inner.enabled.store(false, Ordering::Release);
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        control.cancellation.cancel();
        control.sender = None;
    }

    #[cfg(test)]
    fn set_enabled_for_io_test(&self, enabled: bool) {
        self.inner.enabled.store(enabled, Ordering::Release);
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        control.cancellation.cancel();
        control.cancellation = CancellationToken::new();
        control.sender = None;
        self.inner
            .status
            .store(PetdexConnectionStatus::NotDetected as u8, Ordering::Release);
    }

    #[cfg(test)]
    fn cancellation_token(&self) -> CancellationToken {
        self.inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .cancellation
            .clone()
    }

    fn queue_event(&self, event: PetdexEvent) {
        if !self.inner.enabled.load(Ordering::Acquire) {
            return;
        }
        let sender = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .sender
            .clone();
        if let Some(sender) = sender {
            let _ = sender.send(CoordinatorMessage::Event(event));
        }
    }

    async fn test_connection(&self) -> PetdexConnectionStatus {
        if !self.inner.enabled.load(Ordering::Acquire) {
            return PetdexConnectionStatus::NotDetected;
        }
        let (sender, cancellation) = {
            let control = self
                .inner
                .coordinator
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (control.sender.clone(), control.cancellation.clone())
        };
        let Some(sender) = sender else {
            return PetdexConnectionStatus::ConnectionError;
        };
        let (reply, response) = oneshot::channel();
        if sender.send(CoordinatorMessage::Test(reply)).is_err() {
            return PetdexConnectionStatus::ConnectionError;
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => PetdexConnectionStatus::NotDetected,
            result = response => result.unwrap_or(PetdexConnectionStatus::ConnectionError),
        }
    }

    async fn run_coordinator(
        &self,
        app: AppHandle,
        mut receiver: mpsc::UnboundedReceiver<CoordinatorMessage>,
        cancellation: CancellationToken,
    ) {
        let mut arbiter = PetdexArbiter::default();
        let mut delivery = DeliveryPolicy::default();

        loop {
            if cancellation.is_cancelled() || !self.inner.enabled.load(Ordering::Acquire) {
                break;
            }

            let now = Instant::now();
            let target = arbiter.target(now);
            let attempt_deadline = delivery.attempt_deadline(target, now);
            if attempt_deadline.is_some_and(|deadline| deadline <= now) {
                let command = StateCommand::from_target(target, now);
                let result = self.apply_state(command, cancellation.clone()).await;
                if cancellation.is_cancelled() || !self.inner.enabled.load(Ordering::Acquire) {
                    break;
                }
                log::debug!(
                    "Petdex state update result={}",
                    result.diagnostic_category()
                );
                let completed_at = Instant::now();
                delivery.record(command.state, result, completed_at);
                self.update_status(&app, result.connection_status());
                continue;
            }

            let deadline = [attempt_deadline, arbiter.next_expiry()]
                .into_iter()
                .flatten()
                .min();
            let message = if let Some(deadline) = deadline {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => break,
                    message = receiver.recv() => message,
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => None,
                }
            } else {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => break,
                    message = receiver.recv() => message,
                }
            };

            match message {
                Some(CoordinatorMessage::Event(event)) => {
                    arbiter.apply(event, Instant::now());
                }
                Some(CoordinatorMessage::Test(reply)) => {
                    delivery.reset_backoff();
                    if let Some(send_at) = delivery
                        .last_attempt_at
                        .map(|last_attempt| last_attempt + MIN_SEND_INTERVAL)
                        .filter(|send_at| *send_at > Instant::now())
                    {
                        tokio::select! {
                            biased;
                            _ = cancellation.cancelled() => {
                                let _ = reply.send(PetdexConnectionStatus::NotDetected);
                                break;
                            }
                            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(send_at)) => {}
                        }
                    }
                    let test_started_at = Instant::now();
                    arbiter.clear_temporaries();
                    arbiter.pulse(PetdexState::Waving, test_started_at);
                    let command =
                        StateCommand::from_target(arbiter.target(test_started_at), test_started_at);
                    let result = self.apply_state(command, cancellation.clone()).await;
                    if cancellation.is_cancelled() || !self.inner.enabled.load(Ordering::Acquire) {
                        let _ = reply.send(PetdexConnectionStatus::NotDetected);
                        break;
                    }
                    log::debug!(
                        "Petdex state update result={}",
                        result.diagnostic_category()
                    );
                    delivery.record(command.state, result, Instant::now());
                    let status = result.connection_status();
                    self.update_status(&app, status);
                    let _ = reply.send(status);
                }
                None if deadline.is_some() => {}
                None => break,
            }
        }
    }

    fn update_status(&self, app: &AppHandle, status: PetdexConnectionStatus) {
        let previous = self.inner.status.swap(status as u8, Ordering::AcqRel);
        if previous != status as u8 {
            let _ = app.emit(PETDEX_STATUS_EVENT, status);
        }
    }

    async fn apply_state(
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

    fn read_token(&self) -> Result<SecretToken, RequestFailure> {
        let raw =
            fs::read_to_string(&self.inner.token_path).map_err(|error| match error.kind() {
                ErrorKind::NotFound => RequestFailure::TokenMissing,
                _ => RequestFailure::TokenUnreadable,
            })?;
        let token = raw.trim();
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(RequestFailure::TokenInvalid);
        }
        Ok(SecretToken(token.to_string()))
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

pub(crate) fn notify(app: &AppHandle, event: PetdexEvent) {
    if let Some(adapter) = app.try_state::<PetdexAdapter>() {
        adapter.queue_event(event);
    }
}

#[tauri::command]
pub(crate) fn petdex_set_enabled(
    app: AppHandle,
    adapter: State<'_, PetdexAdapter>,
    enabled: bool,
) -> PetdexConnectionStatus {
    adapter.set_enabled(&app, enabled)
}

#[tauri::command]
pub(crate) fn petdex_get_status(adapter: State<'_, PetdexAdapter>) -> PetdexConnectionStatus {
    adapter.status()
}

#[tauri::command]
pub(crate) async fn petdex_test_connection(app: AppHandle) -> PetdexConnectionStatus {
    let Some(adapter) = app
        .try_state::<PetdexAdapter>()
        .map(|state| state.inner().clone())
    else {
        return PetdexConnectionStatus::ConnectionError;
    };
    adapter.test_connection().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{
        collections::BTreeMap,
        io::{Read, Write},
        net::{Ipv4Addr, TcpListener, TcpStream},
        thread,
    };
    use tempfile::TempDir;

    const TOKEN_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TOKEN_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    struct CapturedRequest {
        body: Value,
        headers: BTreeMap<String, String>,
        request_line: String,
    }

    fn token_path(root: &TempDir) -> PathBuf {
        root.path()
            .join(".petdex")
            .join("runtime")
            .join("update-token")
    }

    fn write_token(path: &PathBuf, token: &str) {
        fs::create_dir_all(path.parent().expect("token parent")).expect("create token parent");
        fs::write(path, format!("{token}\n")).expect("write token");
    }

    fn fixture_adapter(listener: &TcpListener, token_path: PathBuf) -> PetdexAdapter {
        fixture_adapter_for_port(
            listener.local_addr().expect("listener address").port(),
            token_path,
        )
    }

    fn fixture_adapter_for_port(port: u16, token_path: PathBuf) -> PetdexAdapter {
        PetdexAdapter::fixture(
            Url::parse(&format!("http://127.0.0.1:{port}/state")).expect("fixture endpoint"),
            token_path,
        )
    }

    fn read_request(stream: &mut TcpStream) -> CapturedRequest {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("read timeout");
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 1024];
        let header_end = loop {
            let count = stream.read(&mut chunk).expect("read request");
            assert!(count > 0, "client closed before request headers");
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let header_text = String::from_utf8(bytes[..header_end].to_vec()).expect("headers");
        let mut lines = header_text.split("\r\n");
        let request_line = lines.next().expect("request line").to_string();
        let mut headers = BTreeMap::new();
        for line in lines.filter(|line| !line.is_empty()) {
            let (name, value) = line.split_once(':').expect("header");
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
        let content_length = headers
            .get("content-length")
            .expect("content length")
            .parse::<usize>()
            .expect("numeric content length");
        while bytes.len() < header_end + content_length {
            let count = stream.read(&mut chunk).expect("read body");
            assert!(count > 0, "client closed before request body");
            bytes.extend_from_slice(&chunk[..count]);
        }
        CapturedRequest {
            body: serde_json::from_slice(&bytes[header_end..header_end + content_length])
                .expect("JSON body"),
            headers,
            request_line,
        }
    }

    fn respond(stream: &mut TcpStream, status: u16, reason: &str) {
        write!(
            stream,
            "HTTP/1.1 {status} {reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        )
        .expect("response");
        stream.flush().expect("flush response");
    }

    #[test]
    fn production_target_token_path_and_time_bounds_are_fixed() {
        let home = PathBuf::from("fixture-home");
        let adapter = PetdexAdapter::new(home.clone());
        assert_eq!(
            adapter.inner.endpoint.as_ref().map(Url::as_str),
            Some(PETDEX_STATE_ENDPOINT)
        );
        assert_eq!(
            adapter.inner.token_path,
            home.join(".petdex").join("runtime").join("update-token")
        );
        assert_eq!(CONNECT_TIMEOUT, Duration::from_millis(250));
        assert_eq!(REQUEST_TIMEOUT, Duration::from_millis(750));
        assert!(MIN_SEND_INTERVAL >= Duration::from_millis(100));
        assert!(MAX_FAILURE_BACKOFF <= Duration::from_secs(4));
    }

    #[test]
    fn arbiter_honors_priority_ttl_and_persistent_recovery() {
        let start = Instant::now();
        let mut arbiter = PetdexArbiter::default();

        arbiter.apply(PetdexEvent::SshConnecting("ssh-1".into()), start);
        assert_eq!(arbiter.target(start).state, PetdexState::Waiting);
        arbiter.apply(PetdexEvent::SftpStarted("sftp-1".into()), start);
        assert_eq!(arbiter.target(start).state, PetdexState::Running);
        arbiter.apply(PetdexEvent::AiStarted("ai-1".into()), start);
        assert_eq!(arbiter.target(start).state, PetdexState::Waiting);

        let failure_at = start + Duration::from_millis(20);
        arbiter.apply(PetdexEvent::SftpFailed("sftp-1".into()), failure_at);
        assert_eq!(arbiter.target(failure_at).state, PetdexState::Failed);
        assert_eq!(
            arbiter.target(failure_at + FAILURE_TTL).state,
            PetdexState::Waiting
        );

        let ai_done_at = failure_at + FAILURE_TTL + Duration::from_millis(1);
        arbiter.apply(PetdexEvent::AiCancelled("ai-1".into()), ai_done_at);
        assert_eq!(arbiter.target(ai_done_at).state, PetdexState::Waiting);
        arbiter.apply(PetdexEvent::SshConnected("ssh-1".into()), ai_done_at);
        assert_eq!(arbiter.target(ai_done_at).state, PetdexState::Waving);
        assert_eq!(
            arbiter.target(ai_done_at + SUCCESS_TTL).state,
            PetdexState::Idle
        );
    }

    #[test]
    fn concurrent_operations_end_independently_and_cancel_is_neutral() {
        let start = Instant::now();
        let mut arbiter = PetdexArbiter::default();
        arbiter.apply(PetdexEvent::SftpStarted("transfer-a".into()), start);
        arbiter.apply(PetdexEvent::SftpStarted("transfer-b".into()), start);
        arbiter.apply(PetdexEvent::SftpStarted("transfer-b".into()), start);
        assert_eq!(arbiter.sftp_active.len(), 2);

        arbiter.apply(PetdexEvent::SftpSucceeded("transfer-a".into()), start);
        assert_eq!(arbiter.target(start).state, PetdexState::Jumping);
        assert_eq!(
            arbiter.target(start + SUCCESS_TTL).state,
            PetdexState::Running
        );
        arbiter.apply(
            PetdexEvent::SftpCancelled("transfer-b".into()),
            start + SUCCESS_TTL,
        );
        assert_eq!(arbiter.target(start + SUCCESS_TTL).state, PetdexState::Idle);
        assert!(arbiter.failed.is_none());

        arbiter.apply(
            PetdexEvent::SftpFailed("transfer-a".into()),
            start + SUCCESS_TTL,
        );
        assert!(arbiter.failed.is_none());
    }

    #[test]
    fn ai_completion_restores_a_remaining_transfer_after_ttl() {
        let start = Instant::now();
        let mut arbiter = PetdexArbiter::default();
        arbiter.apply(PetdexEvent::SftpStarted("transfer".into()), start);
        arbiter.apply(PetdexEvent::AiStarted("ai".into()), start);
        assert_eq!(arbiter.target(start).state, PetdexState::Waiting);

        arbiter.apply(PetdexEvent::AiSucceeded("ai".into()), start);
        assert_eq!(arbiter.target(start).state, PetdexState::Jumping);
        assert_eq!(
            arbiter.target(start + SUCCESS_TTL).state,
            PetdexState::Running
        );
    }

    #[test]
    fn concurrent_ssh_completion_does_not_clear_another_connection() {
        let start = Instant::now();
        let mut arbiter = PetdexArbiter::default();
        arbiter.apply(PetdexEvent::SshConnecting("ssh-a".into()), start);
        arbiter.apply(PetdexEvent::SshConnecting("ssh-b".into()), start);
        arbiter.apply(PetdexEvent::SshConnected("ssh-a".into()), start);
        assert_eq!(arbiter.target(start).state, PetdexState::Waving);
        assert_eq!(
            arbiter.target(start + SUCCESS_TTL).state,
            PetdexState::Waiting
        );

        let failed_at = start + SUCCESS_TTL;
        arbiter.apply(PetdexEvent::SshFailed("ssh-b".into()), failed_at);
        assert_eq!(arbiter.target(failed_at).state, PetdexState::Failed);
        assert_eq!(
            arbiter.target(failed_at + FAILURE_TTL).state,
            PetdexState::Idle
        );

        let disconnect_at = failed_at + FAILURE_TTL;
        arbiter.apply(PetdexEvent::SshFailed("ssh-a".into()), disconnect_at);
        assert_eq!(arbiter.target(disconnect_at).state, PetdexState::Failed);
    }

    #[test]
    fn delivery_deduplicates_throttles_resyncs_and_bounds_backoff() {
        let start = Instant::now();
        let idle = ArbitrationTarget {
            state: PetdexState::Idle,
            expires_at: None,
        };
        let running = ArbitrationTarget {
            state: PetdexState::Running,
            expires_at: None,
        };
        let mut delivery = DeliveryPolicy::default();

        assert_eq!(delivery.attempt_deadline(idle, start), Some(start));
        delivery.record(PetdexState::Idle, RequestResult::Applied, start);
        assert_eq!(
            delivery.attempt_deadline(idle, start),
            Some(start + RECOVERY_PROBE_INTERVAL)
        );
        assert_eq!(
            delivery.attempt_deadline(running, start + Duration::from_millis(10)),
            Some(start + MIN_SEND_INTERVAL)
        );

        let failed_at = start + MIN_SEND_INTERVAL;
        delivery.record(PetdexState::Running, RequestResult::Transport, failed_at);
        assert_eq!(
            delivery.attempt_deadline(running, failed_at),
            Some(failed_at + INITIAL_FAILURE_BACKOFF)
        );
        for count in 2..=10 {
            let attempt_at = failed_at + Duration::from_secs(count.into());
            delivery.record(PetdexState::Running, RequestResult::Transport, attempt_at);
            assert!(failure_backoff(count) <= MAX_FAILURE_BACKOFF);
        }
        assert_eq!(failure_backoff(10), MAX_FAILURE_BACKOFF);
    }

    #[test]
    fn diagnostic_output_is_a_finite_result_category_only() {
        let categories = [
            RequestResult::Applied,
            RequestResult::Disabled,
            RequestResult::TokenMissing,
            RequestResult::TokenUnreadable,
            RequestResult::TokenInvalid,
            RequestResult::Transport,
            RequestResult::Unauthorized,
            RequestResult::Rejected,
        ]
        .map(RequestResult::diagnostic_category);
        assert_eq!(
            categories,
            [
                "applied",
                "disabled",
                "token-missing",
                "token-unreadable",
                "token-invalid",
                "transport-unavailable",
                "unauthorized",
                "rejected",
            ]
        );
        for category in categories {
            assert!(category
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'-'));
            assert!(!category.contains(TOKEN_A));
            assert!(!category.contains('/') && !category.contains(' '));
        }
    }

    #[tokio::test]
    async fn disabled_adapter_reads_no_token_and_sends_no_request() {
        let root = TempDir::new().expect("temp dir");
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");
        let adapter = fixture_adapter(&listener, token_path(&root));

        assert_eq!(
            adapter
                .apply_state(
                    StateCommand::full_ttl(PetdexState::Running),
                    adapter.cancellation_token(),
                )
                .await,
            RequestResult::Disabled
        );
        assert!(matches!(listener.accept(), Err(error) if error.kind() == ErrorKind::WouldBlock));
    }

    #[tokio::test]
    async fn sends_only_the_fixed_header_and_state_payload() {
        let root = TempDir::new().expect("temp dir");
        let path = token_path(&root);
        write_token(&path, TOKEN_A);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let adapter = fixture_adapter(&listener, path);
        adapter.set_enabled_for_io_test(true);
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let request = read_request(&mut stream);
            respond(&mut stream, 200, "OK");
            request
        });

        assert_eq!(
            adapter
                .apply_state(
                    StateCommand::full_ttl(PetdexState::Waving),
                    adapter.cancellation_token(),
                )
                .await,
            RequestResult::Applied
        );
        let request = server.join().expect("server join");
        assert_eq!(request.request_line, "POST /state HTTP/1.1");
        assert_eq!(
            request.headers.get("x-petdex-update-token").unwrap(),
            TOKEN_A
        );
        assert_eq!(request.headers.get("connection").unwrap(), "close");
        assert_eq!(request.body, json!({ "state": "waving", "duration": 1200 }));
        assert_eq!(request.body.as_object().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn rereads_rotated_token_once_after_unauthorized() {
        let root = TempDir::new().expect("temp dir");
        let path = token_path(&root);
        write_token(&path, TOKEN_A);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let adapter = fixture_adapter(&listener, path.clone());
        adapter.set_enabled_for_io_test(true);
        let server = thread::spawn(move || {
            let (mut first, _) = listener.accept().expect("first request");
            let first_request = read_request(&mut first);
            write_token(&path, TOKEN_B);
            respond(&mut first, 401, "Unauthorized");

            let (mut second, _) = listener.accept().expect("second request");
            let second_request = read_request(&mut second);
            respond(&mut second, 200, "OK");
            (first_request, second_request)
        });

        assert_eq!(
            adapter
                .apply_state(
                    StateCommand::full_ttl(PetdexState::Running),
                    adapter.cancellation_token(),
                )
                .await,
            RequestResult::Applied
        );
        let (first, second) = server.join().expect("server join");
        assert_eq!(first.headers.get("x-petdex-update-token").unwrap(), TOKEN_A);
        assert_eq!(
            second.headers.get("x-petdex-update-token").unwrap(),
            TOKEN_B
        );
        assert_eq!(first.body, json!({ "state": "running" }));
        assert_eq!(second.body, json!({ "state": "running" }));
    }

    #[tokio::test]
    async fn unchanged_token_after_unauthorized_is_not_retried() {
        let root = TempDir::new().expect("temp dir");
        let path = token_path(&root);
        write_token(&path, TOKEN_A);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let adapter = fixture_adapter(&listener, path);
        adapter.set_enabled_for_io_test(true);
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("request");
            let request = read_request(&mut stream);
            respond(&mut stream, 401, "Unauthorized");
            listener
                .set_nonblocking(true)
                .expect("nonblocking listener");
            assert!(
                matches!(listener.accept(), Err(error) if error.kind() == ErrorKind::WouldBlock)
            );
            request
        });

        assert_eq!(
            adapter
                .apply_state(
                    StateCommand::full_ttl(PetdexState::Waiting),
                    adapter.cancellation_token(),
                )
                .await,
            RequestResult::Unauthorized
        );
        let _ = server.join().expect("server join");
    }

    #[tokio::test]
    async fn the_same_adapter_recovers_after_service_restart_and_token_rotation() {
        let root = TempDir::new().expect("temp dir");
        let path = token_path(&root);
        write_token(&path, TOKEN_A);
        let reserved = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let port = reserved.local_addr().expect("address").port();
        drop(reserved);
        let adapter = fixture_adapter_for_port(port, path.clone());
        adapter.set_enabled_for_io_test(true);

        assert_eq!(
            adapter
                .apply_state(
                    StateCommand::full_ttl(PetdexState::Waiting),
                    adapter.cancellation_token(),
                )
                .await,
            RequestResult::Transport
        );

        write_token(&path, TOKEN_B);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).expect("restart listener");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("recovery request");
            let request = read_request(&mut stream);
            respond(&mut stream, 200, "OK");
            request
        });
        assert_eq!(
            adapter
                .apply_state(
                    StateCommand::full_ttl(PetdexState::Waiting),
                    adapter.cancellation_token(),
                )
                .await,
            RequestResult::Applied
        );
        let request = server.join().expect("server join");
        assert_eq!(
            request.headers.get("x-petdex-update-token").unwrap(),
            TOKEN_B
        );
    }

    #[tokio::test]
    async fn disabling_cancels_an_in_flight_request_and_clears_future_io() {
        let root = TempDir::new().expect("temp dir");
        let path = token_path(&root);
        write_token(&path, TOKEN_A);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let adapter = fixture_adapter(&listener, path);
        adapter.set_enabled_for_io_test(true);
        let cancellation = adapter.cancellation_token();
        let (accepted_tx, accepted_rx) = oneshot::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let _ = read_request(&mut stream);
            let _ = accepted_tx.send(());
            let mut byte = [0_u8; 1];
            let _ = stream.read(&mut byte);
        });
        let request_adapter = adapter.clone();
        let request = tokio::spawn(async move {
            request_adapter
                .apply_state(StateCommand::full_ttl(PetdexState::Running), cancellation)
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), accepted_rx)
            .await
            .expect("request accepted before timeout")
            .expect("request accepted signal");

        adapter.set_enabled_for_io_test(false);
        assert_eq!(
            request.await.expect("request join"),
            RequestResult::Disabled
        );
        server.join().expect("server join");
    }

    #[tokio::test]
    async fn classifies_failures_without_response_details() {
        let missing_root = TempDir::new().expect("temp dir");
        let missing_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let missing = fixture_adapter(&missing_listener, token_path(&missing_root));
        missing.set_enabled_for_io_test(true);
        assert_eq!(
            missing
                .apply_state(
                    StateCommand::full_ttl(PetdexState::Waiting),
                    missing.cancellation_token(),
                )
                .await,
            RequestResult::TokenMissing
        );

        let transport_root = TempDir::new().expect("temp dir");
        let transport_path = token_path(&transport_root);
        write_token(&transport_path, TOKEN_A);
        let closed_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let transport = fixture_adapter(&closed_listener, transport_path);
        drop(closed_listener);
        transport.set_enabled_for_io_test(true);
        assert_eq!(
            transport
                .apply_state(
                    StateCommand::full_ttl(PetdexState::Waiting),
                    transport.cancellation_token(),
                )
                .await,
            RequestResult::Transport
        );

        let rejected_root = TempDir::new().expect("temp dir");
        let rejected_path = token_path(&rejected_root);
        write_token(&rejected_path, TOKEN_A);
        let rejected_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let rejected = fixture_adapter(&rejected_listener, rejected_path);
        rejected.set_enabled_for_io_test(true);
        let server = thread::spawn(move || {
            let (mut stream, _) = rejected_listener.accept().expect("accept request");
            let _ = read_request(&mut stream);
            respond(&mut stream, 429, "Too Many Requests");
        });
        assert_eq!(
            rejected
                .apply_state(
                    StateCommand::full_ttl(PetdexState::Failed),
                    rejected.cancellation_token(),
                )
                .await,
            RequestResult::Rejected
        );
        server.join().expect("server join");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "controlled local Petdex Desktop 0.8.0 end-to-end test"]
    async fn controlled_macos_petdex_restart_recovers_without_adapter_restart() {
        assert_eq!(
            std::env::var("TERMBRIDGE_PETDEX_E2E").as_deref(),
            Ok("1"),
            "set the explicit controlled-E2E guard"
        );

        fn petdex_is_running() -> bool {
            std::process::Command::new("osascript")
                .args([
                    "-e",
                    "application id \"dev.petdex.desktop-native\" is running",
                ])
                .output()
                .ok()
                .is_some_and(|output| output.status.success() && output.stdout == b"true\n")
        }

        #[derive(Default)]
        struct ControlledPetdex {
            child: Option<std::process::Child>,
        }

        impl ControlledPetdex {
            fn start(&mut self) {
                assert!(self.child.is_none(), "controlled Petdex is already running");
                let child = std::process::Command::new(
                    "/Applications/Petdex.app/Contents/MacOS/petdex-desktop-native",
                )
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("start controlled Petdex Desktop process");
                self.child = Some(child);
            }

            fn stop(&mut self) {
                let Some(mut child) = self.child.take() else {
                    return;
                };
                let _ = std::process::Command::new("osascript")
                    .args([
                        "-e",
                        "tell application id \"dev.petdex.desktop-native\" to quit",
                    ])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
                for _ in 0..20 {
                    if child.try_wait().ok().flatten().is_some() {
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }

        impl Drop for ControlledPetdex {
            fn drop(&mut self) {
                self.stop();
            }
        }

        async fn wait_for_result(
            adapter: &PetdexAdapter,
            expected: RequestResult,
            timeout: Duration,
        ) {
            let deadline = Instant::now() + timeout;
            let mut last_result = RequestResult::Disabled;
            while Instant::now() < deadline {
                last_result = adapter
                    .apply_state(
                        StateCommand::full_ttl(PetdexState::Running),
                        adapter.cancellation_token(),
                    )
                    .await;
                if last_result == expected {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!(
                "Petdex E2E did not reach result category {}",
                last_result.diagnostic_category()
            );
        }

        assert!(
            !petdex_is_running(),
            "controlled E2E requires Petdex Desktop to start stopped"
        );
        let mut petdex = ControlledPetdex::default();
        let home_dir = std::env::var_os("HOME")
            .map(PathBuf::from)
            .expect("home directory is available");
        let adapter = PetdexAdapter::new(home_dir);
        adapter.set_enabled_for_io_test(true);

        petdex.start();
        wait_for_result(&adapter, RequestResult::Applied, Duration::from_secs(10)).await;
        let first_token = adapter
            .read_token()
            .unwrap_or_else(|_| panic!("Petdex E2E could not read a valid runtime token category"));

        petdex.stop();
        wait_for_result(&adapter, RequestResult::Transport, Duration::from_secs(10)).await;
        petdex.start();
        wait_for_result(&adapter, RequestResult::Applied, Duration::from_secs(10)).await;
        let rotated_token = adapter
            .read_token()
            .unwrap_or_else(|_| panic!("Petdex E2E could not read a valid rotated-token category"));
        assert!(
            first_token != rotated_token,
            "Petdex runtime token did not rotate"
        );

        assert_eq!(
            adapter
                .apply_state(
                    StateCommand::full_ttl(PetdexState::Idle),
                    adapter.cancellation_token(),
                )
                .await,
            RequestResult::Applied
        );
        adapter.set_enabled_for_io_test(false);
    }
}
