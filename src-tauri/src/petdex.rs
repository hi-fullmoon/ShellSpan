use reqwest::{Client, Url};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::sync::CancellationToken;

mod arbiter;
pub(crate) mod configuration;
mod delivery;
// Stage 9 consumes these persistence operations when /bubble is enabled.
#[allow(dead_code)]
mod installation;
#[allow(dead_code)] // Safe wire content is consumed by stage 9, preferences by stage 10.
pub(crate) mod message_content;
mod message_delivery;
#[allow(dead_code)] // Transport consumes the versioned handoff in stage 9.
mod message_snapshot;
#[allow(dead_code)] // Content/receipt consumers land in stages 8/9; projection runs now.
mod slots;
mod transport;
pub(crate) mod types;

#[cfg(test)]
use self::delivery::{
    failure_backoff, ACTIVE_STEADY_RECOVERY_PROBE_INTERVAL, IDLE_STEADY_RECOVERY_PROBE_INTERVAL,
    INITIAL_FAILURE_BACKOFF, INITIAL_RECOVERY_PROBE_INTERVAL, MAX_FAILURE_BACKOFF,
    WARM_RECOVERY_PROBE_INTERVAL,
};
pub(crate) use self::types::PetdexCategories;
pub(crate) use self::types::PetdexConnectionStatus;
pub(crate) use self::types::PetdexDiagnostic;
pub(crate) use self::types::{ActivityPhase, ActivitySource, PetdexTestResult};
use self::{
    arbiter::{ArbitrationTarget, PetdexArbiter},
    delivery::{DeliveryPolicy, MIN_SEND_INTERVAL},
    types::{ActivityEvent, PetdexState, PreviewOutcome, RequestResult, StateCommand},
};

const PETDEX_STATE_ENDPOINT: &str = "http://127.0.0.1:7777/state";
const PETDEX_STATUS_EVENT: &str = "petdex-status";
const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const REQUEST_TIMEOUT: Duration = Duration::from_millis(750);
const STATE_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(1500);
const COORDINATOR_QUEUE_CAPACITY: usize = 16;
const TEST_CONNECTION_TIMEOUT: Duration = Duration::from_secs(2);
enum CoordinatorMessage {
    Wake,
    Test(oneshot::Sender<PetdexTestResult>),
}

fn test_connection_timeout() -> Duration {
    #[cfg(test)]
    {
        Duration::from_millis(50)
    }
    #[cfg(not(test))]
    {
        TEST_CONNECTION_TIMEOUT
    }
}

struct CoordinatorControl {
    cancellation: CancellationToken,
    sender: Option<mpsc::Sender<CoordinatorMessage>>,
    arbiter: PetdexArbiter,
    wake_queued: bool,
    diagnostic: PetdexDiagnostic,
    configuration_epoch: u64,
    cleanup_cancellation: CancellationToken,
    cleanup_pending: bool,
}

struct PetdexAdapterInner {
    client: Option<Client>,
    endpoint: Option<Url>,
    token_path: PathBuf,
    enabled: AtomicBool,
    coordinator: StdMutex<CoordinatorControl>,
    request_lock: Mutex<()>,
    write_policy: StdMutex<transport::WritePolicy>,
    configuration_lock: Mutex<()>,
    configuration_command_lock: Mutex<()>,
    messages: StdMutex<message_delivery::MessageDelivery>,
    write_epoch: std::sync::atomic::AtomicU64,
    message_installation: StdMutex<Option<installation::Installation>>,
}

#[derive(Clone)]
pub(crate) struct PetdexAdapter {
    inner: Arc<PetdexAdapterInner>,
}

impl PetdexAdapter {
    pub(crate) fn initialize_messages(&self, directory: &std::path::Path) {
        let mut installation = self
            .inner
            .message_installation
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if installation.is_some() {
            return;
        }
        match installation::Installation::open(directory) {
            Ok(value) => {
                let mut messages = self
                    .inner
                    .messages
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                messages.usage = value.usage();
                messages.writer_ready = true;
                *installation = Some(value);
            }
            Err(_) => log::warn!("Petdex message writer unavailable; messages remain disabled"),
        }
        drop(installation);
        let control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(sender) = &control.sender {
            let _ = sender.try_send(CoordinatorMessage::Wake);
        }
    }
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
            .redirect(reqwest::redirect::Policy::none())
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
                coordinator: StdMutex::new(CoordinatorControl {
                    cancellation: CancellationToken::new(),
                    sender: None,
                    arbiter: PetdexArbiter::default(),
                    wake_queued: false,
                    diagnostic: PetdexDiagnostic::default(),
                    configuration_epoch: 0,
                    cleanup_cancellation: CancellationToken::new(),
                    cleanup_pending: false,
                }),
                request_lock: Mutex::new(()),
                write_policy: StdMutex::new(Default::default()),
                configuration_lock: Mutex::new(()),
                configuration_command_lock: Mutex::new(()),
                messages: StdMutex::new(Default::default()),
                write_epoch: std::sync::atomic::AtomicU64::new(0),
                message_installation: StdMutex::new(None),
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

    fn status(&self) -> PetdexDiagnostic {
        self.inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .diagnostic
    }

    async fn set_enabled(&self, app: &AppHandle, enabled: bool) -> PetdexDiagnostic {
        if enabled {
            let (epoch, _) = self.begin_message_configuration();
            let _configuration = self.inner.configuration_lock.lock().await;
            self.start_coordinator(app.clone(), epoch);
        } else {
            self.shutdown_messages().await;
        }
        let snapshot = self.status();
        let _ = app.emit(PETDEX_STATUS_EVENT, snapshot);
        snapshot
    }

    fn set_categories(&self, categories: PetdexCategories) {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if control.arbiter.set_categories(categories) {
            // A request prepared for a now-hidden source must not outlive this
            // configuration generation. Preserve other sources' presentation.
            control.cancellation.cancel();
            control.sender = None;
            control.wake_queued = false;
        }
        if self.inner.enabled.load(Ordering::Acquire) {
            let cancellation = control.cancellation.clone();
            control.refresh_diagnostic(&cancellation, None, false);
        }
    }

    fn start_coordinator(&self, app: AppHandle, epoch: u64) {
        let Some((receiver, cancellation)) = self.prepare_coordinator_epoch(Some(epoch)) else {
            return;
        };
        let _ = app.emit(PETDEX_STATUS_EVENT, self.status());
        let adapter = self.clone();
        tauri::async_runtime::spawn(async move {
            adapter.run_coordinator(app, receiver, cancellation).await;
        });
    }

    #[cfg(test)]
    fn prepare_coordinator(
        &self,
    ) -> Option<(mpsc::Receiver<CoordinatorMessage>, CancellationToken)> {
        self.prepare_coordinator_epoch(None)
    }

    fn prepare_coordinator_epoch(
        &self,
        epoch: Option<u64>,
    ) -> Option<(mpsc::Receiver<CoordinatorMessage>, CancellationToken)> {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if epoch.is_some_and(|epoch| control.configuration_epoch != epoch) {
            return None;
        }
        if self.inner.enabled.load(Ordering::Acquire) && control.sender.is_some() {
            return None;
        }

        control.cancellation.cancel();
        let cancellation = CancellationToken::new();
        let (sender, receiver) = mpsc::channel(COORDINATOR_QUEUE_CAPACITY);
        control.cancellation = cancellation.clone();
        control.arbiter.message_cancellation = CancellationToken::new();
        control.sender = Some(sender);
        if !self.inner.enabled.load(Ordering::Acquire) {
            control.arbiter.clear_presentation();
        }
        control.wake_queued = false;
        let target = control.arbiter.target(Instant::now()).state;
        control
            .diagnostic
            .update(PetdexConnectionStatus::Checking, None, Some(target), None);
        self.inner.enabled.store(true, Ordering::Release);
        Some((receiver, cancellation))
    }

    #[cfg(test)]
    fn stop_coordinator(&self) {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.stop_coordinator_locked(&mut control);
    }

    fn stop_coordinator_locked(&self, control: &mut CoordinatorControl) {
        self.inner.enabled.store(false, Ordering::Release);
        control.cancellation.cancel();
        control.sender = None;
        control.arbiter.clear_presentation();
        control.wake_queued = false;
        control
            .diagnostic
            .update(PetdexConnectionStatus::Disabled, None, None, None);
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
        control.arbiter = PetdexArbiter::default();
        control.wake_queued = false;
        control.diagnostic.update(
            if enabled {
                PetdexConnectionStatus::Checking
            } else {
                PetdexConnectionStatus::Disabled
            },
            None,
            enabled.then_some(PetdexState::Idle),
            None,
        );
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

    fn queue_event(&self, event: ActivityEvent) {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.record_event(&mut control, event);
    }

    fn record_event(&self, control: &mut CoordinatorControl, event: ActivityEvent) {
        control.arbiter.apply(event, Instant::now());
        if !self.inner.enabled.load(Ordering::Acquire) {
            control.arbiter.clear_presentation();
            return;
        }
        if control.wake_queued {
            return;
        }
        let Some(sender) = control.sender.as_ref() else {
            return;
        };
        if sender.try_send(CoordinatorMessage::Wake).is_ok() {
            control.wake_queued = true;
        }
    }

    fn arbitration_snapshot(
        &self,
        now: Instant,
        cancellation: &CancellationToken,
    ) -> Option<(ArbitrationTarget, Option<Instant>)> {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if cancellation.is_cancelled() {
            return None;
        }
        let target = control.arbiter.target(now);
        let next_expiry = control.arbiter.next_expiry();
        Some((target, next_expiry))
    }

    fn acknowledge_wake(&self, cancellation: &CancellationToken) {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !cancellation.is_cancelled() {
            control.wake_queued = false;
        }
    }

    fn test_command(&self, now: Instant, cancellation: &CancellationToken) -> Option<StateCommand> {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if cancellation.is_cancelled() {
            return None;
        }
        control.arbiter.start_preview(now);
        Some(control.arbiter.target(now).command())
    }

    fn test_result(
        &self,
        result: RequestResult,
        overridden_at_send: bool,
        cancellation: Option<&CancellationToken>,
    ) -> PetdexTestResult {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let preview = if cancellation.is_some_and(CancellationToken::is_cancelled)
            || !self.inner.enabled.load(Ordering::Acquire)
            || result == RequestResult::Disabled
        {
            PreviewOutcome::Disabled
        } else if result != RequestResult::Applied {
            PreviewOutcome::Failed
        } else if overridden_at_send || control.arbiter.preview_overridden(Instant::now()) {
            PreviewOutcome::Overridden
        } else {
            PreviewOutcome::Requested
        };
        PetdexTestResult {
            diagnostic: control.diagnostic,
            preview,
        }
    }

    async fn test_connection(&self) -> Result<PetdexTestResult, &'static str> {
        if !self.inner.enabled.load(Ordering::Acquire) {
            return Ok(self.test_result(RequestResult::Disabled, false, None));
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
            return Err("petdex-coordinator-unavailable");
        };
        let deadline = tokio::time::Instant::now() + test_connection_timeout();
        let (reply, response) = oneshot::channel();
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Ok(self.test_result(RequestResult::Disabled, false, Some(&cancellation))),
            result = tokio::time::timeout_at(deadline, sender.send(CoordinatorMessage::Test(reply))) => {
                match result {
                    Ok(Ok(())) => {
                        tokio::select! {
                            biased;
                            _ = cancellation.cancelled() => Ok(self.test_result(RequestResult::Disabled, false, Some(&cancellation))),
                            result = tokio::time::timeout_at(deadline, response) => result
                                .ok()
                                .and_then(Result::ok)
                                .ok_or("petdex-check-timeout"),
                        }
                    }
                    Ok(Err(_)) | Err(_) => Err("petdex-check-timeout"),
                }
            },
        }
    }

    async fn run_coordinator(
        &self,
        app: AppHandle,
        mut receiver: mpsc::Receiver<CoordinatorMessage>,
        cancellation: CancellationToken,
    ) {
        let mut delivery = DeliveryPolicy::default();
        let mut last_was_message = false;

        loop {
            if cancellation.is_cancelled() || !self.inner.enabled.load(Ordering::Acquire) {
                break;
            }

            let now = Instant::now();
            let Some((target, next_expiry)) = self.arbitration_snapshot(now, &cancellation) else {
                break;
            };
            self.update_diagnostic(&app, &cancellation, None, false);
            let attempt_deadline = delivery.attempt_deadline(target, now);
            let pending = self.next_message(now);
            let message_deadline = pending.as_ref().map(Self::message_due);
            // Alternate ready channels, so continuous action churn cannot starve
            // bubbles. Absolute action TTL is rechecked after every queue wait.
            if message_deadline.is_some_and(|d| d <= now)
                && (!last_was_message || !attempt_deadline.is_some_and(|d| d <= now))
            {
                self.deliver_message(pending.unwrap()).await;
                last_was_message = true;
                continue;
            }
            if attempt_deadline.is_some_and(|deadline| deadline <= now) {
                last_was_message = false;
                let command = target.command();
                let result = self.apply_state(command, cancellation.clone()).await;
                if cancellation.is_cancelled() || !self.inner.enabled.load(Ordering::Acquire) {
                    break;
                }
                log::debug!(
                    "Petdex state update result={}",
                    result.diagnostic_category()
                );
                let completed_at = Instant::now();
                delivery.record(command, result, completed_at);
                self.reconcile_message_connection(result);
                self.update_diagnostic(&app, &cancellation, Some(result), false);
                continue;
            }

            let deadline = [attempt_deadline, next_expiry, message_deadline]
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
                Some(CoordinatorMessage::Wake) => {
                    self.acknowledge_wake(&cancellation);
                }
                Some(CoordinatorMessage::Test(mut reply)) => {
                    if reply.is_closed() {
                        continue;
                    }
                    delivery.reset_backoff();
                    self.inner
                        .messages
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .diagnostic
                        .unsupported = false;
                    if let Some(send_at) = delivery
                        .last_attempt_at
                        .map(|last_attempt| last_attempt + MIN_SEND_INTERVAL)
                        .filter(|send_at| *send_at > Instant::now())
                    {
                        tokio::select! {
                            biased;
                            _ = cancellation.cancelled() => {
                                let _ = reply.send(self.test_result(RequestResult::Disabled, false, Some(&cancellation)));
                                break;
                            }
                            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(send_at)) => {}
                        }
                    }
                    if reply.is_closed() {
                        continue;
                    }
                    let test_started_at = Instant::now();
                    let Some(command) = self.test_command(test_started_at, &cancellation) else {
                        break;
                    };
                    let overridden = command.state != PetdexState::Waving;
                    let previous_diagnostic = self.status();
                    self.update_diagnostic(&app, &cancellation, None, true);
                    let result = tokio::select! {
                        biased;
                        _ = reply.closed() => {
                            let mut control = self.inner.coordinator.lock().unwrap_or_else(|p| p.into_inner());
                            if control.abandon_test_preview(test_started_at, &cancellation, previous_diagnostic) {
                                let _ = app.emit(PETDEX_STATUS_EVENT, control.diagnostic);
                            }
                            delivery.record(command, RequestResult::Expired, Instant::now());
                            continue;
                        },
                        result = self.apply_state(command, cancellation.clone()) => result,
                    };
                    if cancellation.is_cancelled() || !self.inner.enabled.load(Ordering::Acquire) {
                        let _ = reply.send(self.test_result(
                            RequestResult::Disabled,
                            false,
                            Some(&cancellation),
                        ));
                        break;
                    }
                    if result != RequestResult::Applied {
                        let mut control = self
                            .inner
                            .coordinator
                            .lock()
                            .unwrap_or_else(|p| p.into_inner());
                        if !cancellation.is_cancelled() {
                            control.arbiter.cancel_preview(test_started_at);
                        }
                    }
                    log::debug!(
                        "Petdex state update result={}",
                        result.diagnostic_category()
                    );
                    delivery.record(command, result, Instant::now());
                    self.reconcile_message_connection(result);
                    self.update_diagnostic(&app, &cancellation, Some(result), false);
                    let _ = reply.send(self.test_result(result, overridden, Some(&cancellation)));
                }
                None if deadline.is_some() => {}
                None => break,
            }
        }
    }

    fn update_diagnostic(
        &self,
        app: &AppHandle,
        cancellation: &CancellationToken,
        result: Option<RequestResult>,
        checking: bool,
    ) {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if control.refresh_diagnostic(cancellation, result, checking) {
            let _ = app.emit(PETDEX_STATUS_EVENT, control.diagnostic);
        }
    }
}

impl CoordinatorControl {
    fn abandon_test_preview(
        &mut self,
        started_at: Instant,
        cancellation: &CancellationToken,
        previous: PetdexDiagnostic,
    ) -> bool {
        if cancellation.is_cancelled() {
            return false;
        }
        self.arbiter.cancel_preview(started_at);
        let target = self.arbiter.target(Instant::now()).state;
        self.diagnostic
            .update(previous.status, previous.error_reason, Some(target), None)
    }

    // Cancellation is checked under the same lock used by stop/start. An old
    // coordinator cannot publish results or mutate a newly enabled session.
    fn refresh_diagnostic(
        &mut self,
        cancellation: &CancellationToken,
        result: Option<RequestResult>,
        checking: bool,
    ) -> bool {
        if cancellation.is_cancelled() {
            return false;
        }
        let target = self.arbiter.target(Instant::now()).state;
        // Expiry is not a network result and cannot manufacture a successful
        // communication timestamp or replace the prior connection diagnosis.
        let result = result.filter(|result| *result != RequestResult::Expired);
        let status = if checking {
            PetdexConnectionStatus::Checking
        } else {
            result
                .map(RequestResult::connection_status)
                .unwrap_or(self.diagnostic.status)
        };
        let error = if checking {
            None
        } else {
            result
                .map(RequestResult::error_reason)
                .unwrap_or(self.diagnostic.error_reason)
        };
        let success_at = result
            .filter(|result| *result == RequestResult::Applied)
            .and_then(|_| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .ok()
                    .and_then(|time| u64::try_from(time.as_millis()).ok())
            });
        self.diagnostic
            .update(status, error, Some(target), success_at)
    }
}

// Own this guard in the actual worker, not the awaiting command. Dropping an
// IPC future must not end a blocking operation that is still running.
pub(crate) struct ActivityGuard {
    adapter: Option<PetdexAdapter>,
    event: ActivityEvent,
    finished: bool,
}

impl ActivityGuard {
    /// Evaluate candidates lazily under the same preference/lifecycle lock.
    /// Guards retain no business text, so disabling details clears every owner.
    pub(crate) fn details(&self, update: impl FnOnce(&mut message_content::SafeDetails)) {
        if self.finished {
            return;
        }
        if let Some(adapter) = &self.adapter {
            let mut control = adapter
                .inner
                .coordinator
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if adapter.inner.enabled.load(Ordering::Acquire) {
                control
                    .arbiter
                    .update_details(self.event.source, self.event.run_id, update);
                if !control.wake_queued {
                    if let Some(sender) = &control.sender {
                        if sender.try_send(CoordinatorMessage::Wake).is_ok() {
                            control.wake_queued = true;
                        }
                    }
                }
            }
        }
    }

    pub(crate) fn owned(
        adapter: Option<PetdexAdapter>,
        source: ActivitySource,
        phase: ActivityPhase,
        owner: types::ActivityOwner,
        kind: types::ActivityKind,
    ) -> Self {
        Self::create(adapter, source, phase, Some(owner), kind)
    }

    pub(crate) fn start_owned(
        app: &AppHandle,
        source: ActivitySource,
        phase: ActivityPhase,
        owner: types::ActivityOwner,
        kind: types::ActivityKind,
    ) -> Self {
        Self::owned(
            app.try_state::<PetdexAdapter>().map(|s| s.inner().clone()),
            source,
            phase,
            owner,
            kind,
        )
    }
    #[cfg(test)]
    pub(crate) fn new(
        adapter: Option<PetdexAdapter>,
        source: ActivitySource,
        phase: ActivityPhase,
    ) -> Self {
        let kind = ActivityEvent::new(source, 0, 0, phase, Instant::now()).kind;
        Self::create(adapter, source, phase, None, kind)
    }

    fn create(
        adapter: Option<PetdexAdapter>,
        source: ActivitySource,
        phase: ActivityPhase,
        owner: Option<types::ActivityOwner>,
        kind: types::ActivityKind,
    ) -> Self {
        let mut guard = Self {
            adapter,
            event: ActivityEvent::new(source, 0, 0, phase, Instant::now()),
            finished: false,
        };
        guard.event.owner = owner;
        guard.event.kind = kind;
        if let Some(adapter) = &guard.adapter {
            let mut control = adapter
                .inner
                .coordinator
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            guard.event.run_id = control.arbiter.allocate_run_id();
            adapter.record_event(&mut control, guard.event.clone());
        }
        guard
    }

    fn publish(&self) {
        if let Some(adapter) = &self.adapter {
            adapter.queue_event(self.event.clone());
        }
    }

    pub(crate) fn transition(&mut self, phase: ActivityPhase) {
        self.transition_with_kind(phase, self.event.kind);
    }

    pub(crate) fn transition_with_kind(&mut self, phase: ActivityPhase, kind: types::ActivityKind) {
        if self.finished {
            return;
        }
        self.event.revision += 1;
        self.event.phase = phase;
        self.event.kind = kind;
        self.event.occurred_at = Instant::now();
        self.finished = matches!(
            phase,
            ActivityPhase::Succeeded | ActivityPhase::Failed | ActivityPhase::Cancelled
        );
        self.publish();
    }
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        // Unwinding / an unhandled early exit is a failure. Ordinary user
        // cancellation must be explicitly published by the domain owner.
        self.transition(ActivityPhase::Failed);
    }
}

#[tauri::command]
pub(crate) async fn petdex_set_enabled(
    app: AppHandle,
    adapter: State<'_, PetdexAdapter>,
    enabled: bool,
    categories: Option<PetdexCategories>,
) -> Result<PetdexDiagnostic, &'static str> {
    if let Some(categories) = categories {
        adapter.set_categories(categories);
    }
    Ok(adapter.set_enabled(&app, enabled).await)
}

#[tauri::command]
pub(crate) fn petdex_get_status(adapter: State<'_, PetdexAdapter>) -> PetdexDiagnostic {
    adapter.status()
}

#[tauri::command]
pub(crate) async fn petdex_test_connection(
    app: AppHandle,
) -> Result<PetdexTestResult, &'static str> {
    let Some(adapter) = app
        .try_state::<PetdexAdapter>()
        .map(|state| state.inner().clone())
    else {
        return Err("petdex-coordinator-unavailable");
    };
    adapter.test_connection().await
}

#[tauri::command]
pub(crate) async fn petdex_check_health(
    app: AppHandle,
) -> Result<types::PetdexCheckResult, &'static str> {
    let adapter = app
        .try_state::<PetdexAdapter>()
        .map(|state| state.inner().clone())
        .ok_or("petdex-coordinator-unavailable")?;
    let health = adapter.check_health().await;
    Ok(types::PetdexCheckResult {
        diagnostic: adapter.status(),
        health,
    })
}
#[cfg(test)]
mod activity_tests;
#[cfg(test)]
mod agent_activity_tests;
#[cfg(test)]
mod slot_tests;
#[cfg(test)]
mod tests;
