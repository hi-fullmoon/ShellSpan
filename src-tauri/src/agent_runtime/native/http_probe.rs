use std::io::Read;
use std::net::TcpStream;
use std::path::Path;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::client::conn::http1;
use hyper::header::{CONNECTION, CONTENT_LENGTH, CONTENT_TYPE, HOST};
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use reqwest::blocking::Client;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::agent_runtime::{
    AgentToolCallNative, AgentToolTargetNative, HttpProbeMethodNative, ProbeHttpArgumentsNative,
};
use crate::models::RemoteConnectionRequest;

const DEFAULT_TIMEOUT_MS: u64 = 5_000;
const MAX_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_BODY_BYTES: u64 = 64 * 1024;
const MAX_BODY_BYTES: u64 = 128 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub(super) struct HttpProbeOutputNative {
    pub(super) summary: String,
    pub(super) data: Value,
    pub(super) truncated: bool,
}

struct HttpProbeResponseNative {
    status: u16,
    content_type: Option<String>,
    content_length: Option<u64>,
    body: Vec<u8>,
}

pub(super) fn execute_http_probe_native(
    call: &AgentToolCallNative,
    remote_connection: Option<&RemoteConnectionRequest>,
    known_hosts_path: &Path,
    cancellation: &CancellationToken,
) -> Result<HttpProbeOutputNative, String> {
    let remote_connection = match &call.target {
        AgentToolTargetNative::Local { .. } => None,
        AgentToolTargetNative::Remote { .. } => Some(remote_connection.ok_or_else(|| {
            "probe_http requires the authenticated frozen remote connection".to_string()
        })?),
        _ => return Err("probe_http requires a frozen local or remote host target".into()),
    };
    let arguments: ProbeHttpArgumentsNative = serde_json::from_value(call.arguments.clone())
        .map_err(|error| format!("invalid probe_http arguments: {error}"))?;
    let timeout_ms = arguments.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let max_bytes = arguments.max_bytes.unwrap_or(DEFAULT_BODY_BYTES);
    if timeout_ms == 0
        || timeout_ms > MAX_TIMEOUT_MS
        || max_bytes == 0
        || max_bytes > MAX_BODY_BYTES
        || arguments
            .body
            .as_ref()
            .is_some_and(|body| body.len() > MAX_REQUEST_BODY_BYTES)
    {
        return Err("probe_http bounds changed after authorization".into());
    }
    let logical_url = loopback_url(&arguments)?;
    if cancellation.is_cancelled() {
        return Err("probe_http was cancelled before dispatch".into());
    }

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    if let Some(connection) = remote_connection {
        let mut transport = crate::port_forward::open_scoped_loopback_connection(
            connection,
            arguments.port,
            known_hosts_path,
            deadline,
        )?;
        let stream = transport.take_stream()?;
        let result = send_http_probe_over_stream(
            &arguments,
            &logical_url,
            stream,
            deadline,
            max_bytes,
            cancellation,
        );
        let transport_result = transport.finish(deadline);
        return match (result, transport_result) {
            (Ok(output), Ok(())) => Ok(output),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Err(probe_error), Err(transport_error)) => {
                Err(format!("{probe_error}; {transport_error}"))
            }
        };
    }
    send_http_probe(
        &arguments,
        &logical_url,
        remaining_probe_time(deadline)?,
        max_bytes,
        cancellation,
    )
}

fn send_http_probe(
    arguments: &ProbeHttpArgumentsNative,
    logical_url: &Url,
    timeout: Duration,
    max_bytes: u64,
    cancellation: &CancellationToken,
) -> Result<HttpProbeOutputNative, String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(timeout)
        .timeout(timeout)
        .user_agent(concat!("ShellSpan/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("failed to create loopback HTTP client: {error}"))?;
    let method = match arguments.method {
        HttpProbeMethodNative::Get => reqwest::Method::GET,
        HttpProbeMethodNative::Head => reqwest::Method::HEAD,
        HttpProbeMethodNative::Post => reqwest::Method::POST,
        HttpProbeMethodNative::Put => reqwest::Method::PUT,
        HttpProbeMethodNative::Patch => reqwest::Method::PATCH,
        HttpProbeMethodNative::Delete => reqwest::Method::DELETE,
    };
    let target_authority = if arguments.port == 80 {
        "127.0.0.1".to_string()
    } else {
        format!("127.0.0.1:{}", arguments.port)
    };
    let mut request = client
        .request(method, logical_url.clone())
        .header(CONNECTION, "close")
        .header(HOST, target_authority);
    if let Some(content_type) = arguments.content_type.as_deref() {
        request = request.header(CONTENT_TYPE, content_type);
    }
    if let Some(body) = arguments.body.as_ref() {
        request = request.body(body.clone());
    }
    let response = request
        .send()
        .map_err(|error| probe_transport_error(&error))?;
    if cancellation.is_cancelled() {
        return Err("probe_http was cancelled while awaiting the response".into());
    }

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| (value.len() <= 1_024).then(|| value.to_string()));
    let content_length = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let mut body = Vec::new();
    if arguments.method != HttpProbeMethodNative::Head {
        response
            .take(max_bytes.saturating_add(1))
            .read_to_end(&mut body)
            .map_err(|error| format!("failed to read loopback HTTP response: {error}"))?;
    }
    if cancellation.is_cancelled() {
        return Err("probe_http was cancelled while reading the response".into());
    }
    complete_http_probe(
        arguments,
        logical_url,
        HttpProbeResponseNative {
            status,
            content_type,
            content_length,
            body,
        },
        max_bytes,
    )
}

fn send_http_probe_over_stream(
    arguments: &ProbeHttpArgumentsNative,
    logical_url: &Url,
    stream: TcpStream,
    deadline: Instant,
    max_bytes: u64,
    cancellation: &CancellationToken,
) -> Result<HttpProbeOutputNative, String> {
    stream
        .set_nonblocking(true)
        .map_err(|error| format!("failed to configure target loopback HTTP transport: {error}"))?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|error| format!("failed to create target loopback HTTP runtime: {error}"))?;
    let timeout = remaining_probe_time(deadline)?;
    let response = runtime.block_on(async {
        tokio::time::timeout(timeout, async {
            let stream = tokio::net::TcpStream::from_std(stream).map_err(|error| {
                format!("failed to adopt target loopback HTTP transport: {error}")
            })?;
            let (mut sender, connection) = http1::handshake(TokioIo::new(stream))
                .await
                .map_err(|error| format!("target loopback HTTP handshake failed: {error}"))?;
            tokio::task::spawn(async move {
                let _ = connection.await;
            });
            let method = match arguments.method {
                HttpProbeMethodNative::Get => hyper::Method::GET,
                HttpProbeMethodNative::Head => hyper::Method::HEAD,
                HttpProbeMethodNative::Post => hyper::Method::POST,
                HttpProbeMethodNative::Put => hyper::Method::PUT,
                HttpProbeMethodNative::Patch => hyper::Method::PATCH,
                HttpProbeMethodNative::Delete => hyper::Method::DELETE,
            };
            let request_target = match logical_url.query() {
                Some(query) => format!("{}?{query}", logical_url.path()),
                None => logical_url.path().to_string(),
            };
            let target_authority = target_authority(arguments.port);
            let mut builder = Request::builder()
                .method(method)
                .uri(request_target)
                .header(CONNECTION, "close")
                .header(HOST, target_authority);
            if let Some(content_type) = arguments.content_type.as_deref() {
                builder = builder.header(CONTENT_TYPE, content_type);
            }
            let request = builder
                .body(Full::new(Bytes::from(
                    arguments.body.clone().unwrap_or_default(),
                )))
                .map_err(|error| {
                    format!("failed to build target loopback HTTP request: {error}")
                })?;
            let response = sender
                .send_request(request)
                .await
                .map_err(|error| format!("target loopback HTTP request failed: {error}"))?;
            collect_hyper_response(response, arguments.method, max_bytes).await
        })
        .await
        .map_err(|_| "target loopback HTTP request exceeded its total deadline".to_string())?
    })?;
    if cancellation.is_cancelled() {
        return Err("probe_http was cancelled while awaiting the response".into());
    }
    complete_http_probe(arguments, logical_url, response, max_bytes)
}

async fn collect_hyper_response(
    mut response: Response<Incoming>,
    method: HttpProbeMethodNative,
    max_bytes: u64,
) -> Result<HttpProbeResponseNative, String> {
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| (value.len() <= 1_024).then(|| value.to_string()));
    let content_length = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let mut body = Vec::new();
    if method != HttpProbeMethodNative::Head {
        while let Some(frame) = response.body_mut().frame().await {
            let frame = frame.map_err(|error| {
                format!("failed to read target loopback HTTP response: {error}")
            })?;
            if let Some(data) = frame.data_ref() {
                let remaining = max_bytes
                    .saturating_add(1)
                    .saturating_sub(body.len() as u64);
                body.extend_from_slice(&data[..data.len().min(remaining as usize)]);
                if body.len() as u64 > max_bytes {
                    break;
                }
            }
        }
    }
    Ok(HttpProbeResponseNative {
        status,
        content_type,
        content_length,
        body,
    })
}

fn complete_http_probe(
    arguments: &ProbeHttpArgumentsNative,
    logical_url: &Url,
    mut response: HttpProbeResponseNative,
    max_bytes: u64,
) -> Result<HttpProbeOutputNative, String> {
    let truncated = arguments.method != HttpProbeMethodNative::Head
        && (response.body.len() as u64 > max_bytes
            || response
                .content_length
                .is_some_and(|length| length > max_bytes));
    if response.body.len() as u64 > max_bytes {
        response.body.truncate(max_bytes as usize);
    }
    let body_bytes = response.body.len() as u64;
    let (body, body_encoding) = match String::from_utf8(response.body) {
        Ok(body) => (body, "utf8"),
        Err(error) => (STANDARD.encode(error.into_bytes()), "base64"),
    };
    let method_name = http_probe_method_name(arguments.method);
    Ok(HttpProbeOutputNative {
        summary: format!(
            "Loopback HTTP {method_name} returned status {} from 127.0.0.1:{}.",
            response.status, arguments.port
        ),
        data: json!({
            "method": method_name,
            "url": logical_url.as_str(),
            "status": response.status,
            "contentType": response.content_type,
            "contentLength": response.content_length,
            "body": body,
            "bodyEncoding": body_encoding,
            "bodyBytes": body_bytes,
            "truncated": truncated,
            "redirectsFollowed": false,
            "networkScope": "targetLoopback"
        }),
        truncated,
    })
}

fn target_authority(port: u16) -> String {
    if port == 80 {
        "127.0.0.1".to_string()
    } else {
        format!("127.0.0.1:{port}")
    }
}

fn http_probe_method_name(method: HttpProbeMethodNative) -> &'static str {
    match method {
        HttpProbeMethodNative::Get => "get",
        HttpProbeMethodNative::Head => "head",
        HttpProbeMethodNative::Post => "post",
        HttpProbeMethodNative::Put => "put",
        HttpProbeMethodNative::Patch => "patch",
        HttpProbeMethodNative::Delete => "delete",
    }
}

fn remaining_probe_time(deadline: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| "probe_http exceeded its total deadline".into())
}

fn loopback_url(arguments: &ProbeHttpArgumentsNative) -> Result<Url, String> {
    let url = Url::parse(&format!(
        "http://127.0.0.1:{}{}",
        arguments.port, arguments.path
    ))
    .map_err(|_| "probe_http path is not a valid HTTP request target".to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port_or_known_default() != Some(arguments.port)
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("probe_http must remain scoped to target loopback HTTP".into());
    }
    Ok(url)
}

fn probe_transport_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "loopback HTTP probe timed out".into()
    } else if error.is_connect() {
        "could not connect to the loopback HTTP service".into()
    } else {
        format!("loopback HTTP probe failed: {error}")
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::path::Path;
    use std::thread;

    use serde_json::json;

    use super::*;

    fn call(port: u16, path: &str, max_bytes: u64) -> AgentToolCallNative {
        AgentToolCallNative {
            request_id: "request-http-probe".into(),
            call_id: "call-http-probe".into(),
            tool_name: "probe_http".into(),
            arguments: json!({
                "method": "get",
                "port": port,
                "path": path,
                "timeoutMs": 2_000,
                "maxBytes": max_bytes
            }),
            target: AgentToolTargetNative::Local {
                target_id: "target-local".into(),
                session_id: "terminal-local".into(),
                cwd: Some("/workspace".into()),
            },
            capability_id: "capability-http-probe".into(),
        }
    }

    #[test]
    fn probe_is_fixed_to_loopback_does_not_follow_redirects_and_bounds_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1_024];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /health?detail=1 HTTP/1.1"));
            stream
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: https://example.test/leak\r\nContent-Type: text/plain\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef",
                )
                .unwrap();
        });

        let result = execute_http_probe_native(
            &call(port, "/health?detail=1", 4),
            None,
            Path::new(""),
            &CancellationToken::new(),
        )
        .unwrap();
        worker.join().unwrap();
        assert_eq!(result.data["status"], 302);
        assert_eq!(result.data["body"], "abcd");
        assert_eq!(result.data["redirectsFollowed"], false);
        assert_eq!(result.data["networkScope"], "targetLoopback");
        assert!(result.truncated);
    }

    #[test]
    fn remote_probe_requires_an_authenticated_frozen_connection() {
        let mut call = call(80, "/", 1_024);
        call.target = AgentToolTargetNative::Remote {
            target_id: "target-remote".into(),
            session_id: "terminal-remote".into(),
            profile_id: Some("profile-remote".into()),
            host: "example.test".into(),
            port: 22,
            username: "tester".into(),
            root_path: None,
            local_root: None,
        };
        assert!(
            execute_http_probe_native(&call, None, Path::new(""), &CancellationToken::new())
                .unwrap_err()
                .contains("authenticated frozen remote connection")
        );
    }

    #[test]
    fn probe_sends_bounded_json_mutation_without_arbitrary_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            assert_eq!(request_line, "POST /api HTTP/1.1\r\n");
            let mut content_length = None;
            let mut saw_content_type = false;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if let Some(value) = lower.strip_prefix("content-length:") {
                    content_length = Some(value.trim().parse::<usize>().unwrap());
                }
                if lower == "content-type: application/json\r\n" {
                    saw_content_type = true;
                }
                assert!(!lower.starts_with("authorization:"));
            }
            assert!(saw_content_type);
            let mut body = vec![0_u8; content_length.unwrap()];
            reader.read_exact(&mut body).unwrap();
            assert_eq!(body, br#"{"title":"test"}"#);
            stream
                .write_all(
                    b"HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 8\r\nConnection: close\r\n\r\n{\"id\":1}",
                )
                .unwrap();
        });

        let mut request = call(port, "/api", 1_024);
        request.arguments = json!({
            "method": "post",
            "port": port,
            "path": "/api",
            "body": "{\"title\":\"test\"}",
            "contentType": "application/json",
            "timeoutMs": 2_000,
            "maxBytes": 1_024
        });
        let result =
            execute_http_probe_native(&request, None, Path::new(""), &CancellationToken::new())
                .unwrap();
        worker.join().unwrap();
        assert_eq!(result.data["method"], "post");
        assert_eq!(result.data["status"], 201);
        assert_eq!(result.data["body"], "{\"id\":1}");
    }

    #[test]
    fn preconnected_transport_uses_http_framing_without_a_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let client = TcpStream::connect(address).unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1_024];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /chunked?detail=1 HTTP/1.1"));
            assert!(request
                .to_ascii_lowercase()
                .contains("host: 127.0.0.1:18081"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
                )
                .unwrap();
        });
        let arguments = ProbeHttpArgumentsNative {
            method: HttpProbeMethodNative::Get,
            port: 18_081,
            path: "/chunked?detail=1".into(),
            body: None,
            content_type: None,
            timeout_ms: Some(2_000),
            max_bytes: Some(1_024),
        };
        let logical_url = loopback_url(&arguments).unwrap();
        let result = send_http_probe_over_stream(
            &arguments,
            &logical_url,
            client,
            Instant::now() + Duration::from_secs(2),
            1_024,
            &CancellationToken::new(),
        )
        .unwrap();
        worker.join().unwrap();
        assert_eq!(result.data["status"], 200);
        assert_eq!(result.data["body"], "hello world");
        assert!(!result.truncated);
    }

    #[test]
    fn preconnected_transport_obeys_one_total_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let worker = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(100));
        });
        let arguments = ProbeHttpArgumentsNative {
            method: HttpProbeMethodNative::Get,
            port: 18_081,
            path: "/slow".into(),
            body: None,
            content_type: None,
            timeout_ms: Some(20),
            max_bytes: Some(1_024),
        };
        let logical_url = loopback_url(&arguments).unwrap();
        let started = Instant::now();
        let error = send_http_probe_over_stream(
            &arguments,
            &logical_url,
            client,
            started + Duration::from_millis(20),
            1_024,
            &CancellationToken::new(),
        )
        .unwrap_err();
        assert!(error.contains("total deadline"));
        assert!(started.elapsed() < Duration::from_millis(90));
        worker.join().unwrap();
    }

    #[test]
    fn loopback_url_accepts_the_default_http_port() {
        let arguments = ProbeHttpArgumentsNative {
            method: HttpProbeMethodNative::Head,
            port: 80,
            path: "/health".into(),
            body: None,
            content_type: None,
            timeout_ms: None,
            max_bytes: None,
        };
        let url = loopback_url(&arguments).unwrap();
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert_eq!(url.port(), None);
        assert_eq!(url.port_or_known_default(), Some(80));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_probe_reaches_only_the_remote_loopback_service() {
        let connection = crate::execution::fixture::isolated_ssh_connection();
        let (_known_hosts_temp, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let mut request = call(18_081, "/", 16 * 1_024);
        request.target = AgentToolTargetNative::Remote {
            target_id: "target-remote-http-probe".into(),
            session_id: "terminal-remote-http-probe".into(),
            profile_id: Some("profile-remote-http-probe".into()),
            host: connection.host.clone(),
            port: connection.port,
            username: connection.username.clone(),
            root_path: None,
            local_root: None,
        };
        request.arguments = json!({
            "method": "get",
            "port": 18_081,
            "path": "/",
            "timeoutMs": 10_000,
            "maxBytes": 16 * 1_024
        });

        let result = execute_http_probe_native(
            &request,
            Some(&connection),
            &known_hosts_path,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(result.data["status"], 200);
        assert_eq!(result.data["url"], "http://127.0.0.1:18081/");
        assert_eq!(result.data["networkScope"], "targetLoopback");
        assert!(result.data["body"]
            .as_str()
            .is_some_and(|body| body.contains("Directory listing")));
    }
}
