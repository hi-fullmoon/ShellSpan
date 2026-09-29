use super::types::{RequestResult, FAILURE_TTL, SUCCESS_TTL};
use super::*;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::ErrorKind,
    io::{Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    thread,
};
use tempfile::TempDir;

const TOKEN_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "requires the explicitly selected existing non-Petdex loopback service; no service lifecycle changes"]
async fn existing_foreign_service_is_rejected_before_authenticated_delivery() {
    assert_eq!(
        std::env::var("SHELLSPAN_PETDEX_FOREIGN_E2E").as_deref(),
        Ok("1")
    );
    let pid: u32 = std::env::var("SHELLSPAN_PETDEX_FOREIGN_PID")
        .expect("explicit foreign PID")
        .parse()
        .expect("PID");
    let process = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .expect("process identity");
    assert!(process.status.success());
    assert!(String::from_utf8(process.stdout)
        .expect("process path")
        .trim()
        .ends_with("/Python"));
    let adapter = PetdexAdapter::new(PathBuf::from(std::env::var_os("HOME").expect("home")));
    let client = adapter.inner.client.as_ref().expect("client");
    for path in ["health", "whoami"] {
        let response = client
            .get(format!("http://127.0.0.1:7777/{path}"))
            .send()
            .await
            .expect("anonymous response");
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    }
    adapter.set_enabled_for_io_test(true);
    let result = adapter
        .apply_state(
            StateCommand::full_ttl(PetdexState::Waving),
            adapter.cancellation_token(),
        )
        .await;
    adapter.set_enabled_for_io_test(false);
    assert_eq!(result, RequestResult::Rejected);
}

#[tokio::test]
async fn health_check_disabled_and_cancelled_preserve_diagnostics() {
    let home = TempDir::new().expect("isolated home");
    let adapter = PetdexAdapter::new(home.path().to_path_buf());
    let before = adapter.status();
    assert_eq!(adapter.check_health().await, types::PetdexHealth::Disabled);
    assert_eq!(adapter.status(), before);
    let (_receiver, _) = adapter.prepare_coordinator().expect("enable");
    let lock = adapter.inner.request_lock.lock().await;
    let check = adapter.check_health();
    tokio::pin!(check);
    tokio::select! {
        result = &mut check => panic!("check must wait for request lock: {result:?}"),
        _ = tokio::task::yield_now() => {}
    }
    adapter.stop_coordinator();
    let disabled = adapter.status();
    assert_eq!(check.await, types::PetdexHealth::Disabled);
    assert_eq!(adapter.status(), disabled);
    drop(lock);
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "requires an already running, locally identified Petdex; never starts or stops it"]
async fn running_macos_petdex_accepts_production_transport() {
    assert_eq!(
        std::env::var("SHELLSPAN_PETDEX_RUNNING_E2E").as_deref(),
        Ok("1")
    );
    let adapter = PetdexAdapter::new(PathBuf::from(std::env::var_os("HOME").expect("home")));
    let client = adapter.inner.client.as_ref().expect("HTTP client");
    let identity: Value = client
        .get("http://127.0.0.1:7777/whoami")
        .send()
        .await
        .expect("identity response")
        .json()
        .await
        .expect("identity JSON");
    assert_eq!(identity["ok"], true);
    assert_eq!(identity["inProcess"], true);
    let pid = identity["pid"].as_u64().expect("native process ID");
    let process = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .expect("process identity");
    assert!(process.status.success());
    assert_eq!(
        String::from_utf8(process.stdout)
            .expect("executable path")
            .trim(),
        "/Applications/Petdex.app/Contents/MacOS/petdex-desktop-native"
    );
    let health: Value = client
        .get("http://127.0.0.1:7777/health")
        .send()
        .await
        .expect("health response")
        .json()
        .await
        .expect("health JSON");
    assert_eq!(health["ok"], true);
    assert_eq!(health["port"], 7777);
    // Only after checking the live native process do we read its credential.
    let (_receiver, _) = adapter
        .prepare_coordinator()
        .expect("enable production coordinator");
    let mut activity = ActivityGuard::new(
        Some(adapter.clone()),
        ActivitySource::Sftp,
        ActivityPhase::Running,
    );
    {
        let cancellation = adapter.cancellation_token();
        adapter
            .inner
            .coordinator
            .lock()
            .expect("coordinator lock")
            .refresh_diagnostic(&cancellation, None, false);
    }
    let before_check = adapter.status();
    assert_eq!(adapter.check_health().await, types::PetdexHealth::Reachable);
    assert_eq!(
        adapter.status(),
        before_check,
        "anonymous health must not claim authenticated delivery"
    );
    assert_eq!(adapter.status().target_action, Some(PetdexState::Running));
    activity.transition(ActivityPhase::Cancelled);
    let cancellation = adapter.cancellation_token();
    let result = adapter
        .apply_state(
            StateCommand::full_ttl(PetdexState::Waving),
            cancellation.clone(),
        )
        .await;
    assert_eq!(result, RequestResult::Applied);
    {
        let mut control = adapter.inner.coordinator.lock().expect("coordinator lock");
        control.refresh_diagnostic(&cancellation, Some(result), false);
        assert_eq!(control.diagnostic.status, PetdexConnectionStatus::Connected);
        assert!(control.diagnostic.last_success_at.is_some());
    }
    adapter.stop_coordinator();
    assert_eq!(adapter.status().status, PetdexConnectionStatus::Disabled);
    // HTTP success does not assert queued=true or visible animation. No cleanup POST.
}

#[test]
fn diagnostic_revisions_and_success_time_do_not_regress() {
    let mut diagnostic = PetdexDiagnostic::default();
    assert_eq!(diagnostic.status, PetdexConnectionStatus::Disabled);
    assert_eq!(diagnostic.target_action, None);
    assert!(diagnostic.update(
        PetdexConnectionStatus::Checking,
        None,
        Some(PetdexState::Idle),
        None
    ));
    assert_eq!(diagnostic.revision, 1);
    assert!(!diagnostic.update(
        PetdexConnectionStatus::Checking,
        None,
        Some(PetdexState::Idle),
        None
    ));
    assert!(diagnostic.update(
        PetdexConnectionStatus::Connected,
        None,
        Some(PetdexState::Idle),
        Some(100)
    ));
    assert!(!diagnostic.update(
        PetdexConnectionStatus::Connected,
        None,
        Some(PetdexState::Idle),
        Some(99)
    ));
    assert_eq!(diagnostic.last_success_at, Some(100));
    diagnostic.update(PetdexConnectionStatus::Disabled, None, None, None);
    assert_eq!(diagnostic.revision, 3);
    assert_eq!(diagnostic.last_success_at, Some(100));
    assert_eq!(diagnostic.target_action, None);
}

#[test]
fn cancelled_generation_cannot_publish_into_disabled_or_reopened_diagnostics() {
    let adapter = PetdexAdapter::new(PathBuf::new());
    let old = adapter.cancellation_token();
    adapter.stop_coordinator();
    let disabled = adapter.status();
    let mut control = adapter.inner.coordinator.lock().expect("coordinator lock");
    assert!(!control.refresh_diagnostic(&old, Some(RequestResult::Applied), false));
    assert_eq!(control.diagnostic, disabled);
    control.cancellation = CancellationToken::new();
    let current = control.cancellation.clone();
    assert!(control.refresh_diagnostic(&current, None, true));
    let checking = control.diagnostic;
    assert!(!control.refresh_diagnostic(&old, Some(RequestResult::Unauthorized), false));
    assert_eq!(control.diagnostic, checking);
    assert!(control.refresh_diagnostic(&current, Some(RequestResult::Applied), false));
    assert!(control.diagnostic.revision > checking.revision);
    assert!(control.diagnostic.last_success_at.is_some());
    assert_eq!(control.diagnostic.status, PetdexConnectionStatus::Connected);
}

#[test]
fn every_transport_result_has_a_distinct_finite_diagnostic() {
    use super::types::PetdexErrorReason;
    for (result, status, reason) in [
        (
            RequestResult::Applied,
            PetdexConnectionStatus::Connected,
            None,
        ),
        (
            RequestResult::Disabled,
            PetdexConnectionStatus::Disabled,
            None,
        ),
        (
            RequestResult::TokenMissing,
            PetdexConnectionStatus::NotDetected,
            Some(PetdexErrorReason::TokenMissing),
        ),
        (
            RequestResult::TokenUnreadable,
            PetdexConnectionStatus::TokenUnreadable,
            Some(PetdexErrorReason::TokenUnreadable),
        ),
        (
            RequestResult::TokenInvalid,
            PetdexConnectionStatus::TokenInvalid,
            Some(PetdexErrorReason::TokenInvalid),
        ),
        (
            RequestResult::Transport,
            PetdexConnectionStatus::Unreachable,
            Some(PetdexErrorReason::Transport),
        ),
        (
            RequestResult::Unauthorized,
            PetdexConnectionStatus::Unauthorized,
            Some(PetdexErrorReason::Unauthorized),
        ),
        (
            RequestResult::Rejected,
            PetdexConnectionStatus::Rejected,
            Some(PetdexErrorReason::Rejected),
        ),
    ] {
        assert_eq!(result.connection_status(), status);
        assert_eq!(result.error_reason(), reason);
    }
    let serialized =
        serde_json::to_value(PetdexDiagnostic::default()).expect("diagnostic serialization");
    assert_eq!(
        serialized,
        json!({"revision": 0, "status": "disabled", "errorReason": null, "targetAction": null, "lastSuccessAt": null})
    );
}

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

fn install_coordinator_queue(
    adapter: &PetdexAdapter,
    capacity: usize,
) -> mpsc::Receiver<CoordinatorMessage> {
    adapter.set_enabled_for_io_test(true);
    let (sender, receiver) = mpsc::channel(capacity);
    let mut control = adapter
        .inner
        .coordinator
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    control.sender = Some(sender);
    control.arbiter = PetdexArbiter::default();
    control.wake_queued = false;
    receiver
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
        let mut headers = [httparse::EMPTY_HEADER; 32];
        if let httparse::Status::Complete(end) = httparse::Request::new(&mut headers)
            .parse(&bytes)
            .expect("HTTP request")
        {
            break end;
        }
    };
    let mut parsed_headers = [httparse::EMPTY_HEADER; 32];
    let mut parsed = httparse::Request::new(&mut parsed_headers);
    parsed
        .parse(&bytes[..header_end])
        .expect("complete HTTP headers");
    let request_line = format!(
        "{} {} HTTP/1.{}",
        parsed.method.expect("method"),
        parsed.path.expect("path"),
        parsed.version.expect("version")
    );
    let headers: BTreeMap<String, String> = parsed
        .headers
        .iter()
        .map(|header| {
            (
                header.name.to_ascii_lowercase(),
                String::from_utf8(header.value.to_vec()).expect("header value"),
            )
        })
        .collect();
    let content_length = headers
        .get("content-length")
        .map(|value| value.parse::<usize>().expect("numeric content length"))
        .unwrap_or(0);
    while bytes.len() < header_end + content_length {
        let count = stream.read(&mut chunk).expect("read body");
        assert!(count > 0, "client closed before request body");
        bytes.extend_from_slice(&chunk[..count]);
    }
    CapturedRequest {
        body: if content_length == 0 {
            Value::Null
        } else {
            serde_json::from_slice(&bytes[header_end..header_end + content_length])
                .expect("JSON body")
        },
        headers,
        request_line,
    }
}

// Maintain the existing transport fixture's protocol contract. These responses
// are client regression fixtures, never evidence of a live Petdex identity.
fn accept_state_request(listener: &TcpListener) -> (TcpStream, CapturedRequest) {
    loop {
        let (mut stream, _) = listener.accept().expect("accept request");
        let request = read_request(&mut stream);
        if request.request_line == "POST /state HTTP/1.1" {
            return (stream, request);
        }
        respond_to_protocol_probe(&mut stream, &request);
    }
}

fn respond_to_protocol_probe(stream: &mut TcpStream, request: &CapturedRequest) {
    let body = match request.request_line.as_str() {
        "GET /health HTTP/1.1" => json!({"ok": true, "port": 7777}),
        "GET /whoami HTTP/1.1" => json!({"ok": true, "pid": std::process::id(), "inProcess": true}),
        _ => panic!("unexpected fixture request"),
    };
    assert!(!request.headers.contains_key("x-petdex-update-token"));
    let body = serde_json::to_vec(&body).expect("protocol JSON");
    write!(
        stream,
        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    )
    .expect("protocol headers");
    stream.write_all(&body).expect("protocol body");
    stream.flush().expect("flush protocol response");
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
    assert_eq!(MAX_FAILURE_BACKOFF, Duration::from_secs(60));
    assert_eq!(INITIAL_RECOVERY_PROBE_INTERVAL, Duration::from_secs(5));
    assert_eq!(WARM_RECOVERY_PROBE_INTERVAL, Duration::from_secs(15));
    assert_eq!(
        ACTIVE_STEADY_RECOVERY_PROBE_INTERVAL,
        Duration::from_secs(30)
    );
    assert_eq!(IDLE_STEADY_RECOVERY_PROBE_INTERVAL, Duration::from_secs(60));
}

#[test]
fn arbiter_honors_priority_ttl_and_persistent_recovery() {
    let start = Instant::now();
    let mut arbiter = PetdexArbiter::default();

    arbiter.apply(
        ActivityEvent::new(ActivitySource::Ssh, 1, 0, ActivityPhase::Connecting, start),
        start,
    );
    assert_eq!(arbiter.target(start).state, PetdexState::Waiting);
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 2, 0, ActivityPhase::Running, start),
        start,
    );
    assert_eq!(arbiter.target(start).state, PetdexState::Running);

    let failure_at = start + Duration::from_millis(20);
    arbiter.apply(
        ActivityEvent::new(
            ActivitySource::Sftp,
            2,
            1,
            ActivityPhase::Failed,
            failure_at,
        ),
        failure_at,
    );
    assert_eq!(arbiter.target(failure_at).state, PetdexState::Failed);
    assert_eq!(
        arbiter.target(failure_at + FAILURE_TTL).state,
        PetdexState::Waiting
    );

    let connected_at = failure_at + FAILURE_TTL + Duration::from_millis(1);
    arbiter.apply(
        ActivityEvent::new(
            ActivitySource::Ssh,
            1,
            1,
            ActivityPhase::Connected,
            connected_at,
        ),
        connected_at,
    );
    assert_eq!(arbiter.target(connected_at).state, PetdexState::Waving);
    assert_eq!(
        arbiter.target(connected_at + SUCCESS_TTL).state,
        PetdexState::Idle
    );
}

#[test]
fn concurrent_operations_end_independently_and_cancel_is_neutral() {
    let start = Instant::now();
    let mut arbiter = PetdexArbiter::default();
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 1, 0, ActivityPhase::Running, start),
        start,
    );
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 2, 0, ActivityPhase::Running, start),
        start,
    );
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 2, 0, ActivityPhase::Running, start),
        start,
    );
    assert_eq!(arbiter.active_sftp_operations(), 2);

    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 1, 1, ActivityPhase::Succeeded, start),
        start,
    );
    assert_eq!(arbiter.target(start).state, PetdexState::Jumping);
    assert_eq!(
        arbiter.target(start + SUCCESS_TTL).state,
        PetdexState::Running
    );
    arbiter.apply(
        ActivityEvent::new(
            ActivitySource::Sftp,
            2,
            1,
            ActivityPhase::Cancelled,
            start + SUCCESS_TTL,
        ),
        start + SUCCESS_TTL,
    );
    assert_eq!(arbiter.target(start + SUCCESS_TTL).state, PetdexState::Idle);
    assert!(!arbiter.has_failure());

    arbiter.apply(
        ActivityEvent::new(
            ActivitySource::Sftp,
            1,
            2,
            ActivityPhase::Failed,
            start + SUCCESS_TTL,
        ),
        start + SUCCESS_TTL,
    );
    assert!(!arbiter.has_failure());
}

#[test]
fn concurrent_ssh_completion_does_not_clear_another_connection() {
    let start = Instant::now();
    let mut arbiter = PetdexArbiter::default();
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Ssh, 1, 0, ActivityPhase::Connecting, start),
        start,
    );
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Ssh, 2, 0, ActivityPhase::Connecting, start),
        start,
    );
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Ssh, 1, 1, ActivityPhase::Connected, start),
        start,
    );
    assert_eq!(arbiter.target(start).state, PetdexState::Waving);
    assert_eq!(
        arbiter.target(start + SUCCESS_TTL).state,
        PetdexState::Waiting
    );

    let failed_at = start + SUCCESS_TTL;
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Ssh, 2, 1, ActivityPhase::Failed, failed_at),
        failed_at,
    );
    assert_eq!(arbiter.target(failed_at).state, PetdexState::Failed);
    assert_eq!(
        arbiter.target(failed_at + FAILURE_TTL).state,
        PetdexState::Idle
    );

    let disconnect_at = failed_at + FAILURE_TTL;
    arbiter.apply(
        ActivityEvent::new(
            ActivitySource::Ssh,
            1,
            2,
            ActivityPhase::Failed,
            disconnect_at,
        ),
        disconnect_at,
    );
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
        Some(start + INITIAL_RECOVERY_PROBE_INTERVAL)
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
    for count in 2..=12 {
        let attempt_at = failed_at + Duration::from_secs(count.into());
        delivery.record(PetdexState::Running, RequestResult::Transport, attempt_at);
        assert!(failure_backoff(count) <= MAX_FAILURE_BACKOFF);
    }
    let final_failure_at = failed_at + Duration::from_secs(12);
    assert_eq!(
        delivery.attempt_deadline(idle, final_failure_at + Duration::from_millis(1)),
        Some(final_failure_at + MIN_SEND_INTERVAL),
        "a changed state bypasses the retry backoff but not the send-rate floor"
    );
    let expected_backoff_ms = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
    for (index, expected_ms) in expected_backoff_ms.into_iter().enumerate() {
        assert_eq!(
            failure_backoff(u32::try_from(index + 1).expect("small failure count")),
            Duration::from_millis(expected_ms)
        );
    }
    assert_eq!(failure_backoff(100), MAX_FAILURE_BACKOFF);
}

#[test]
fn delivery_uses_activity_aware_probes_and_recovers_after_success_or_manual_reset() {
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

    delivery.record(PetdexState::Running, RequestResult::Applied, start);
    assert_eq!(
        delivery.attempt_deadline(running, start),
        Some(start + INITIAL_RECOVERY_PROBE_INTERVAL)
    );
    let initial_probe_at = start + INITIAL_RECOVERY_PROBE_INTERVAL;
    delivery.record(
        PetdexState::Running,
        RequestResult::Applied,
        initial_probe_at,
    );
    assert_eq!(
        delivery.attempt_deadline(running, initial_probe_at),
        Some(initial_probe_at + WARM_RECOVERY_PROBE_INTERVAL)
    );
    let warm_probe_at = initial_probe_at + WARM_RECOVERY_PROBE_INTERVAL;
    delivery.record(PetdexState::Running, RequestResult::Applied, warm_probe_at);
    assert_eq!(
        delivery.attempt_deadline(running, warm_probe_at),
        Some(warm_probe_at + ACTIVE_STEADY_RECOVERY_PROBE_INTERVAL)
    );
    assert_eq!(
        delivery.attempt_deadline(idle, warm_probe_at + Duration::from_millis(1)),
        Some(warm_probe_at + MIN_SEND_INTERVAL)
    );

    let failed_at = warm_probe_at + MIN_SEND_INTERVAL;
    for count in 1_u32..=9 {
        delivery.record(
            PetdexState::Idle,
            RequestResult::Transport,
            failed_at + Duration::from_secs(count.into()),
        );
    }
    assert_eq!(delivery.consecutive_failures, 9);
    assert!(delivery.retry_at.is_some());

    delivery.reset_backoff();
    assert_eq!(delivery.consecutive_failures, 0);
    assert!(delivery.retry_at.is_none());
    let last_failure_at = failed_at + Duration::from_secs(9);
    assert_eq!(
        delivery.attempt_deadline(idle, last_failure_at),
        Some(last_failure_at + MIN_SEND_INTERVAL),
        "manual reset clears the retry delay but preserves the send-rate floor"
    );

    let recovered_at = failed_at + Duration::from_secs(70);
    delivery.record(PetdexState::Idle, RequestResult::Applied, recovered_at);
    assert_eq!(delivery.consecutive_failures, 0);
    assert!(delivery.retry_at.is_none());
    assert_eq!(
        delivery.attempt_deadline(idle, recovered_at),
        Some(recovered_at + INITIAL_RECOVERY_PROBE_INTERVAL)
    );
    let initial_idle_probe_at = recovered_at + INITIAL_RECOVERY_PROBE_INTERVAL;
    delivery.record(
        PetdexState::Idle,
        RequestResult::Applied,
        initial_idle_probe_at,
    );
    let warm_idle_probe_at = initial_idle_probe_at + WARM_RECOVERY_PROBE_INTERVAL;
    delivery.record(
        PetdexState::Idle,
        RequestResult::Applied,
        warm_idle_probe_at,
    );
    assert_eq!(
        delivery.attempt_deadline(idle, warm_idle_probe_at),
        Some(warm_idle_probe_at + IDLE_STEADY_RECOVERY_PROBE_INTERVAL)
    );
}

#[test]
fn event_storm_coalesces_to_one_wake_without_losing_lifecycles() {
    let root = TempDir::new().expect("temp dir");
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
    let adapter = fixture_adapter(&listener, token_path(&root));
    let mut receiver = install_coordinator_queue(&adapter, COORDINATOR_QUEUE_CAPACITY);

    for _ in 0..10_000 {
        let mut activity = ActivityGuard::new(
            Some(adapter.clone()),
            ActivitySource::Sftp,
            ActivityPhase::Running,
        );
        activity.transition(ActivityPhase::Succeeded);
    }

    {
        let mut control = adapter
            .inner
            .coordinator
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(control.arbiter.active_sftp_operations(), 0);
        assert_eq!(
            control.arbiter.target(Instant::now()).state,
            PetdexState::Jumping
        );
        assert!(control.wake_queued);
    }
    assert!(matches!(receiver.try_recv(), Ok(CoordinatorMessage::Wake)));
    assert!(matches!(
        receiver.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
}

#[test]
fn a_full_control_queue_still_records_the_latest_business_state() {
    let root = TempDir::new().expect("temp dir");
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
    let adapter = fixture_adapter(&listener, token_path(&root));
    let _receiver = install_coordinator_queue(&adapter, 1);
    let sender = adapter
        .inner
        .coordinator
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .sender
        .clone()
        .expect("coordinator sender");
    let (reply, _response) = oneshot::channel();
    sender
        .try_send(CoordinatorMessage::Test(reply))
        .expect("fill control queue");

    let _activity = ActivityGuard::new(
        Some(adapter.clone()),
        ActivitySource::Ssh,
        ActivityPhase::Connecting,
    );

    let mut control = adapter
        .inner
        .coordinator
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert_eq!(
        control.arbiter.target(Instant::now()).state,
        PetdexState::Waiting
    );
    assert!(!control.wake_queued);
}

#[tokio::test]
async fn test_connection_times_out_while_waiting_for_queue_capacity() {
    let root = TempDir::new().expect("temp dir");
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
    let adapter = fixture_adapter(&listener, token_path(&root));
    let _receiver = install_coordinator_queue(&adapter, 1);
    let sender = adapter
        .inner
        .coordinator
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .sender
        .clone()
        .expect("coordinator sender");
    sender
        .try_send(CoordinatorMessage::Wake)
        .expect("fill control queue");

    let status = tokio::time::timeout(Duration::from_millis(500), adapter.test_connection())
        .await
        .expect("bounded test connection result");

    assert_eq!(status, Err("petdex-check-timeout"));
}

#[tokio::test]
async fn disabling_releases_a_test_waiting_for_a_coordinator_reply() {
    let root = TempDir::new().expect("temp dir");
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
    let adapter = fixture_adapter(&listener, token_path(&root));
    let mut receiver = install_coordinator_queue(&adapter, 1);
    let request_adapter = adapter.clone();
    let request = tokio::spawn(async move { request_adapter.test_connection().await });
    let pending = tokio::time::timeout(Duration::from_millis(500), receiver.recv())
        .await
        .expect("queued test request")
        .expect("test message");
    assert!(matches!(pending, CoordinatorMessage::Test(_)));

    adapter.stop_coordinator();

    assert_eq!(
        request
            .await
            .expect("test request join")
            .expect("disabled snapshot")
            .diagnostic
            .status,
        PetdexConnectionStatus::Disabled
    );
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
        let (mut stream, request) = accept_state_request(&listener);
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
    assert_eq!(request.body["state"], "waving");
    assert!((1..=1200).contains(
        &request.body["duration"]
            .as_u64()
            .expect("remaining duration")
    ));
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
        let (mut first, first_request) = accept_state_request(&listener);
        write_token(&path, TOKEN_B);
        respond(&mut first, 401, "Unauthorized");

        let (mut second, second_request) = accept_state_request(&listener);
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
        let (mut stream, request) = accept_state_request(&listener);
        respond(&mut stream, 401, "Unauthorized");
        // Refresh checks are anonymous; an unchanged token still must not
        // produce a second authenticated attempt.
        for path in ["health", "whoami"] {
            let (mut probe_stream, _) = listener.accept().expect("refresh probe");
            let probe = read_request(&mut probe_stream);
            assert_eq!(probe.request_line, format!("GET /{path} HTTP/1.1"));
            respond_to_protocol_probe(&mut probe_stream, &probe);
        }
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");
        assert!(matches!(listener.accept(), Err(error) if error.kind() == ErrorKind::WouldBlock));
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
        let (mut stream, request) = accept_state_request(&listener);
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
        std::env::var("SHELLSPAN_PETDEX_E2E").as_deref(),
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

    async fn wait_for_result(adapter: &PetdexAdapter, expected: RequestResult, timeout: Duration) {
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
        .await
        .unwrap_or_else(|_| panic!("Petdex E2E could not read a valid runtime token category"));

    petdex.stop();
    wait_for_result(&adapter, RequestResult::Transport, Duration::from_secs(10)).await;
    petdex.start();
    wait_for_result(&adapter, RequestResult::Applied, Duration::from_secs(10)).await;
    let rotated_token = adapter
        .read_token()
        .await
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
