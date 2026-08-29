//! Phase 0-only executable contract probe for the Petdex loopback boundary.
//!
//! This integration test deliberately lives outside the production crate. It
//! uses fixture tokens and an ephemeral loopback server, so it can run on CI
//! hosts where Petdex Desktop is not installed. Product integration belongs to
//! Phase 1 and must not import code from this file.

use reqwest::{Client, StatusCode, Url};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const PRODUCTION_ENDPOINT: &str = "http://127.0.0.1:7777/state";
const UPDATE_TOKEN_HEADER: &str = "x-petdex-update-token";
const TOKEN_RELATIVE_COMPONENTS: [&str; 3] = [".petdex", "runtime", "update-token"];
const FIXTURE_STALE_TOKEN: &str = "fixture-stale-token";
const FIXTURE_CURRENT_TOKEN: &str = "fixture-current-token";

#[derive(Debug, PartialEq, Eq)]
enum ProbeOutcome {
    Applied,
}

#[derive(Debug, PartialEq, Eq)]
enum ProbeFailure {
    EmptyToken,
    InvalidEndpoint,
    TokenMissing,
    TokenUnreadable,
    Transport,
    Unauthorized,
    UnexpectedStatus(u16),
}

struct ContractProbe {
    client: Client,
    endpoint: Url,
    token_path: PathBuf,
}

impl ContractProbe {
    fn fixture(endpoint: Url, token_path: PathBuf) -> Result<Self, ProbeFailure> {
        validate_loopback_state_endpoint(&endpoint)?;
        let client = Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_millis(250))
            .timeout(Duration::from_millis(750))
            .build()
            .map_err(|_| ProbeFailure::Transport)?;
        Ok(Self {
            client,
            endpoint,
            token_path,
        })
    }

    async fn set_state(&self, state: &str) -> Result<ProbeOutcome, ProbeFailure> {
        let first_token = read_token(&self.token_path)?;
        let first_status = self.post_state(state, &first_token).await?;
        if first_status != StatusCode::UNAUTHORIZED {
            return classify_status(first_status);
        }

        // A 401 is the only status that triggers a token re-read. Retry once
        // only when the file actually rotated, preventing an auth retry loop.
        let refreshed_token = read_token(&self.token_path)?;
        if refreshed_token == first_token {
            return Err(ProbeFailure::Unauthorized);
        }
        classify_status(self.post_state(state, &refreshed_token).await?)
    }

    async fn post_state(&self, state: &str, token: &str) -> Result<StatusCode, ProbeFailure> {
        self.client
            .post(self.endpoint.clone())
            .header(UPDATE_TOKEN_HEADER, token)
            .json(&json!({ "state": state }))
            .send()
            .await
            .map(|response| response.status())
            .map_err(|_| ProbeFailure::Transport)
    }
}

fn production_token_path(home: &Path) -> PathBuf {
    TOKEN_RELATIVE_COMPONENTS
        .iter()
        .fold(home.to_path_buf(), |path, component| path.join(component))
}

fn validate_loopback_state_endpoint(endpoint: &Url) -> Result<(), ProbeFailure> {
    let fixed_scheme = endpoint.scheme() == "http";
    let fixed_host = endpoint.host_str() == Some("127.0.0.1");
    let fixed_path = endpoint.path() == "/state";
    let no_credentials = endpoint.username().is_empty() && endpoint.password().is_none();
    let no_query_or_fragment = endpoint.query().is_none() && endpoint.fragment().is_none();
    if fixed_scheme && fixed_host && fixed_path && no_credentials && no_query_or_fragment {
        Ok(())
    } else {
        Err(ProbeFailure::InvalidEndpoint)
    }
}

fn validate_production_endpoint(endpoint: &Url) -> Result<(), ProbeFailure> {
    validate_loopback_state_endpoint(endpoint)?;
    if endpoint.port() == Some(7777) {
        Ok(())
    } else {
        Err(ProbeFailure::InvalidEndpoint)
    }
}

fn read_token(path: &Path) -> Result<String, ProbeFailure> {
    let raw = fs::read_to_string(path).map_err(|error| match error.kind() {
        ErrorKind::NotFound => ProbeFailure::TokenMissing,
        _ => ProbeFailure::TokenUnreadable,
    })?;
    let token = raw.trim().to_string();
    if token.is_empty() {
        Err(ProbeFailure::EmptyToken)
    } else {
        Ok(token)
    }
}

fn classify_status(status: StatusCode) -> Result<ProbeOutcome, ProbeFailure> {
    match status {
        StatusCode::OK => Ok(ProbeOutcome::Applied),
        StatusCode::UNAUTHORIZED => Err(ProbeFailure::Unauthorized),
        other => Err(ProbeFailure::UnexpectedStatus(other.as_u16())),
    }
}

#[derive(Debug)]
struct CapturedRequest {
    body: String,
    headers: BTreeMap<String, String>,
    request_line: String,
}

fn write_fixture_token(root: &TempDir, token: &str) -> PathBuf {
    let token_path = production_token_path(root.path());
    fs::create_dir_all(token_path.parent().expect("token parent")).expect("create token parent");
    fs::write(&token_path, format!("{token}\n")).expect("write fixture token");
    token_path
}

fn endpoint_for(listener: &TcpListener) -> Url {
    let address = listener.local_addr().expect("fixture address");
    Url::parse(&format!("http://127.0.0.1:{}/state", address.port())).expect("fixture endpoint")
}

fn accept_before(listener: &TcpListener, deadline: Instant) -> TcpStream {
    listener
        .set_nonblocking(true)
        .expect("set fixture listener nonblocking");
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream
                    .set_nonblocking(false)
                    .expect("restore blocking fixture stream");
                return stream;
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("fixture accept failed: {error}"),
        }
    }
}

fn read_request(stream: &mut TcpStream) -> CapturedRequest {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("set fixture read timeout");
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 1024];
    let header_end = loop {
        let count = stream.read(&mut chunk).expect("read fixture request");
        assert!(count > 0, "fixture client closed before sending headers");
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        assert!(
            bytes.len() <= 8192,
            "fixture request headers are unexpectedly large"
        );
    };

    let header_text = String::from_utf8(bytes[..header_end].to_vec()).expect("UTF-8 headers");
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().expect("request line").to_string();
    let mut headers = BTreeMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').expect("valid fixture header");
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    let content_length = headers
        .get("content-length")
        .expect("content-length")
        .parse::<usize>()
        .expect("numeric content-length");
    while bytes.len() < header_end + content_length {
        let count = stream.read(&mut chunk).expect("read fixture body");
        assert!(count > 0, "fixture client closed before sending its body");
        bytes.extend_from_slice(&chunk[..count]);
    }
    let body = String::from_utf8(bytes[header_end..header_end + content_length].to_vec())
        .expect("UTF-8 body");
    CapturedRequest {
        body,
        headers,
        request_line,
    }
}

fn respond(stream: &mut TcpStream, status: u16, reason: &str, body: &str) {
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
    .expect("write fixture response");
    stream.flush().expect("flush fixture response");
}

#[test]
fn production_target_and_token_path_are_literal_and_narrow() {
    assert_eq!(PRODUCTION_ENDPOINT, "http://127.0.0.1:7777/state");
    let production_endpoint = Url::parse(PRODUCTION_ENDPOINT).expect("production endpoint");
    assert_eq!(validate_production_endpoint(&production_endpoint), Ok(()));
    assert_eq!(
        production_token_path(Path::new("fixture-home")),
        Path::new("fixture-home")
            .join(".petdex")
            .join("runtime")
            .join("update-token")
    );

    for rejected in [
        "https://127.0.0.1:7777/state",
        "http://localhost:7777/state",
        "http://[::1]:7777/state",
        "http://127.0.0.1:7777/bubble",
        "http://127.0.0.1:7778/state",
        "http://127.0.0.1/state",
        "http://127.0.0.1:7777/state?target=other",
        "http://user@127.0.0.1:7777/state",
    ] {
        assert_eq!(
            validate_production_endpoint(&Url::parse(rejected).expect("test URL")),
            Err(ProbeFailure::InvalidEndpoint),
            "accepted unsafe endpoint {rejected}"
        );
    }
}

#[tokio::test]
async fn missing_token_stops_before_network_io() {
    let root = tempfile::tempdir().expect("temp home");
    let probe = ContractProbe::fixture(
        Url::parse(PRODUCTION_ENDPOINT).expect("production endpoint"),
        production_token_path(root.path()),
    )
    .expect("contract probe");

    assert_eq!(
        probe.set_state("idle").await,
        Err(ProbeFailure::TokenMissing)
    );
}

#[tokio::test]
async fn residual_token_plus_closed_port_is_transport_unavailable() {
    let root = tempfile::tempdir().expect("temp home");
    let token_path = write_fixture_token(&root, FIXTURE_STALE_TOKEN);
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("reserve loopback port");
    let endpoint = endpoint_for(&listener);
    drop(listener);
    let probe = ContractProbe::fixture(endpoint, token_path.clone()).expect("contract probe");

    assert_eq!(probe.set_state("idle").await, Err(ProbeFailure::Transport));
    assert_eq!(
        fs::read_to_string(token_path)
            .expect("residual token remains")
            .trim(),
        FIXTURE_STALE_TOKEN
    );
}

#[tokio::test]
async fn unauthorized_response_rereads_rotated_token_once() {
    let root = tempfile::tempdir().expect("temp home");
    let token_path = write_fixture_token(&root, FIXTURE_STALE_TOKEN);
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind loopback fixture");
    let endpoint = endpoint_for(&listener);
    let server_token_path = token_path.clone();
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut first_stream = accept_before(&listener, deadline);
        let first = read_request(&mut first_stream);
        fs::write(&server_token_path, format!("{FIXTURE_CURRENT_TOKEN}\n"))
            .expect("rotate fixture token");
        respond(
            &mut first_stream,
            401,
            "Unauthorized",
            r#"{"ok":false,"error":"unauthorized"}"#,
        );

        let mut second_stream = accept_before(&listener, deadline);
        let second = read_request(&mut second_stream);
        respond(
            &mut second_stream,
            200,
            "OK",
            r#"{"ok":true,"state":"idle","duration":null,"queued":true}"#,
        );
        [first, second]
    });
    let probe = ContractProbe::fixture(endpoint, token_path).expect("contract probe");

    let result = probe.set_state("idle").await;
    let requests = server.join().expect("fixture server");
    assert_eq!(result, Ok(ProbeOutcome::Applied));
    assert_eq!(requests[0].request_line, "POST /state HTTP/1.1");
    assert_eq!(requests[1].request_line, "POST /state HTTP/1.1");
    assert_eq!(
        requests[0]
            .headers
            .get(UPDATE_TOKEN_HEADER)
            .map(String::as_str),
        Some(FIXTURE_STALE_TOKEN)
    );
    assert_eq!(
        requests[1]
            .headers
            .get(UPDATE_TOKEN_HEADER)
            .map(String::as_str),
        Some(FIXTURE_CURRENT_TOKEN)
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&requests[0].body).expect("request JSON"),
        json!({ "state": "idle" })
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&requests[1].body).expect("request JSON"),
        json!({ "state": "idle" })
    );
}

#[tokio::test]
async fn unchanged_token_after_unauthorized_is_not_retried() {
    let root = tempfile::tempdir().expect("temp home");
    let token_path = write_fixture_token(&root, FIXTURE_STALE_TOKEN);
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind loopback fixture");
    let endpoint = endpoint_for(&listener);
    let server = thread::spawn(move || {
        let mut stream = accept_before(&listener, Instant::now() + Duration::from_secs(3));
        let request = read_request(&mut stream);
        respond(
            &mut stream,
            401,
            "Unauthorized",
            r#"{"ok":false,"error":"unauthorized"}"#,
        );
        request
    });
    let probe = ContractProbe::fixture(endpoint, token_path).expect("contract probe");

    let result = probe.set_state("idle").await;
    let request = server.join().expect("fixture server");
    assert_eq!(result, Err(ProbeFailure::Unauthorized));
    assert_eq!(request.request_line, "POST /state HTTP/1.1");
    assert_eq!(
        request.headers.get(UPDATE_TOKEN_HEADER).map(String::as_str),
        Some(FIXTURE_STALE_TOKEN)
    );
}
