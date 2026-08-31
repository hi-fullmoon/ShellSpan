use reqwest::{Client, Url};
use std::{
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

mod arbiter;
mod delivery;
mod transport;
mod types;

#[cfg(test)]
use self::delivery::{
    failure_backoff, ACTIVE_STEADY_RECOVERY_PROBE_INTERVAL, IDLE_STEADY_RECOVERY_PROBE_INTERVAL,
    INITIAL_FAILURE_BACKOFF, INITIAL_RECOVERY_PROBE_INTERVAL, MAX_FAILURE_BACKOFF,
    WARM_RECOVERY_PROBE_INTERVAL,
};
pub(crate) use self::types::{PetdexConnectionStatus, PetdexEvent};
use self::{
    arbiter::{ArbitrationTarget, PetdexArbiter},
    delivery::{DeliveryPolicy, MIN_SEND_INTERVAL},
    types::{PetdexState, StateCommand},
};

const PETDEX_STATE_ENDPOINT: &str = "http://127.0.0.1:7777/state";
const PETDEX_STATUS_EVENT: &str = "petdex-status";
const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const REQUEST_TIMEOUT: Duration = Duration::from_millis(750);
const COORDINATOR_QUEUE_CAPACITY: usize = 16;
#[cfg(not(test))]
const TEST_CONNECTION_TIMEOUT: Duration = Duration::from_secs(2);
enum CoordinatorMessage {
    Wake,
    Test(oneshot::Sender<PetdexConnectionStatus>),
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
                    arbiter: PetdexArbiter::default(),
                    wake_queued: false,
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
        let (sender, receiver) = mpsc::channel(COORDINATOR_QUEUE_CAPACITY);
        control.cancellation = cancellation.clone();
        control.sender = Some(sender);
        control.arbiter = PetdexArbiter::default();
        control.wake_queued = false;
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
        control.arbiter = PetdexArbiter::default();
        control.wake_queued = false;
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
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !self.inner.enabled.load(Ordering::Acquire) || control.sender.is_none() {
            return;
        }
        control.arbiter.apply(event, Instant::now());
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

    fn arbitration_snapshot(&self, now: Instant) -> (ArbitrationTarget, Option<Instant>) {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let target = control.arbiter.target(now);
        let next_expiry = control.arbiter.next_expiry();
        (target, next_expiry)
    }

    fn acknowledge_wake(&self) {
        self.inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .wake_queued = false;
    }

    fn test_command(&self, now: Instant) -> StateCommand {
        let mut control = self
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        control.arbiter.clear_temporaries();
        control.arbiter.pulse(PetdexState::Waving, now);
        control.arbiter.target(now).command(now)
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
        let deadline = tokio::time::Instant::now() + test_connection_timeout();
        let (reply, response) = oneshot::channel();
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => PetdexConnectionStatus::NotDetected,
            result = tokio::time::timeout_at(deadline, sender.send(CoordinatorMessage::Test(reply))) => {
                match result {
                    Ok(Ok(())) => {
                        tokio::select! {
                            biased;
                            _ = cancellation.cancelled() => PetdexConnectionStatus::NotDetected,
                            result = tokio::time::timeout_at(deadline, response) => result
                                .ok()
                                .and_then(Result::ok)
                                .unwrap_or(PetdexConnectionStatus::ConnectionError),
                        }
                    }
                    Ok(Err(_)) | Err(_) => PetdexConnectionStatus::ConnectionError,
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

        loop {
            if cancellation.is_cancelled() || !self.inner.enabled.load(Ordering::Acquire) {
                break;
            }

            let now = Instant::now();
            let (target, next_expiry) = self.arbitration_snapshot(now);
            let attempt_deadline = delivery.attempt_deadline(target, now);
            if attempt_deadline.is_some_and(|deadline| deadline <= now) {
                let command = target.command(now);
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

            let deadline = [attempt_deadline, next_expiry].into_iter().flatten().min();
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
                    self.acknowledge_wake();
                }
                Some(CoordinatorMessage::Test(reply)) => {
                    if reply.is_closed() {
                        continue;
                    }
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
                    if reply.is_closed() {
                        continue;
                    }
                    let test_started_at = Instant::now();
                    let command = self.test_command(test_started_at);
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
mod tests;
