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
    assert_eq!(arbiter.active_sftp_operations(), 2);

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
    assert!(!arbiter.has_failure());

    arbiter.apply(
        PetdexEvent::SftpFailed("transfer-a".into()),
        start + SUCCESS_TTL,
    );
    assert!(!arbiter.has_failure());
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

    for index in 0..10_000 {
        let operation_id = format!("transfer-{index}");
        adapter.queue_event(PetdexEvent::SftpStarted(operation_id.clone()));
        adapter.queue_event(PetdexEvent::SftpSucceeded(operation_id));
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

    adapter.queue_event(PetdexEvent::AiStarted("ai-1".into()));

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

    assert_eq!(status, PetdexConnectionStatus::ConnectionError);
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
        request.await.expect("test request join"),
        PetdexConnectionStatus::NotDetected
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
