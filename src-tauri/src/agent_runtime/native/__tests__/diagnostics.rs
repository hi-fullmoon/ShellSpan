use super::*;
use crate::agent_runtime::{
    AgentEffectKindNative, AgentPermissionModeNative, NATIVE_TOOL_CONTRACT_VERSION,
};
use std::net::TcpListener;
use std::time::Instant;

fn call(name: &str, arguments: Value) -> AgentToolCallNative {
    AgentToolCallNative {
        request_id: "diagnostic-request".into(),
        call_id: "diagnostic-call".into(),
        tool_name: name.into(),
        arguments,
        target: AgentToolTargetNative::Local {
            target_id: "diagnostic-local".into(),
            session_id: "diagnostic-terminal".into(),
            cwd: None,
        },
        capability_id: "diagnostic-capability".into(),
    }
}

fn request(call: &AgentToolCallNative) -> AgentRequestNative {
    AgentRequestNative {
        contract_version: NATIVE_TOOL_CONTRACT_VERSION,
        request_id: call.request_id.clone(),
        user_session_id: "diagnostics".into(),
        task_id: "diagnostics".into(),
        goal: "Inspect actual runtime environment".into(),
        success_criteria: vec!["Return bounded observations".into()],
        targets: vec![call.target.clone()],
        permission_mode: AgentPermissionModeNative::RequestApproval,
    }
}

fn effect(call: &AgentToolCallNative) -> AgentObservedEffectNative {
    let registry = super::super::ToolRegistryNative::from_builtin_manifest().unwrap();
    super::super::assess_effect_native(
        &registry.executable(&call.tool_name).unwrap().descriptor,
        call,
    )
    .unwrap()
}

fn run(call: &AgentToolCallNative, cancellation: &CancellationToken) -> AgentToolResultNative {
    execute_diagnostic(
        &request(call),
        call,
        &effect(call),
        None,
        Path::new(""),
        &ProcessRegistryNative::default(),
        cancellation,
    )
    .unwrap()
}

#[test]
fn diagnostic_admission_rejects_injection_unbounded_reads_and_secret_arguments() {
    for (name, arguments) in [
        ("inspect_host", json!({"fields":["cpu","cpu"]})),
        ("inspect_host", json!({"command":"id"})),
        ("inspect_service", json!({"service":"--all"})),
        ("inspect_service", json!({"service":"sshd;id"})),
        ("inspect_service", json!({"service":"*.service"})),
        (
            "query_logs",
            json!({"service":"sshd","sinceUnixMs":2,"untilUnixMs":1}),
        ),
        (
            "query_logs",
            json!({"service":"sshd","sinceUnixMs":0,"untilUnixMs":86400001}),
        ),
        (
            "query_logs",
            json!({"service":"sshd","sinceUnixMs":0,"untilUnixMs":1,"maxEntries":201}),
        ),
        (
            "diagnose_endpoint",
            json!({"host":"name@localhost","port":80,"protocol":"http"}),
        ),
        (
            "diagnose_endpoint",
            json!({"host":"localhost","port":0,"protocol":"http"}),
        ),
        (
            "diagnose_endpoint",
            json!({"host":"localhost","port":80,"protocol":"http","path":"//other-host/"}),
        ),
        (
            "diagnose_endpoint",
            json!({"host":"localhost","port":80,"protocol":"http","path":"/\r\nInjected: yes"}),
        ),
        (
            "diagnose_endpoint",
            json!({"host":"localhost","port":80,"protocol":"http","path":"/?password=do-not-send"}),
        ),
        (
            "diagnose_endpoint",
            json!({"host":"localhost","port":80,"protocol":"http","timeoutMs":30001}),
        ),
        (
            "diagnose_endpoint",
            json!({"host":"localhost","port":80,"protocol":"http","headers":{"Authorization":"hidden"}}),
        ),
    ] {
        assert!(
            validate_diagnostic_arguments(name, &arguments).is_err(),
            "accepted {name}"
        );
    }
    for host in ["localhost", "127.0.0.1", "[::1]"] {
        assert!(validate_diagnostic_arguments(
            "diagnose_endpoint",
            &json!({"host":host,"port":443,"protocol":"https"})
        )
        .is_ok());
    }
}

#[test]
fn diagnostic_effects_retain_sensitive_reads_and_exact_network_scope() {
    for name in ["inspect_host", "inspect_service", "query_logs"] {
        assert_eq!(
            effect(&call(name, json!({}))).kind,
            AgentEffectKindNative::SensitiveRead
        );
    }
    let scope = effect(&call(
        "diagnose_endpoint",
        json!({"host":"localhost","port":8443,"protocol":"https"}),
    ));
    assert_eq!(scope.kind, AgentEffectKindNative::ExternalSideEffect);
    assert_eq!(scope.network_destinations.len(), 1);
    assert_eq!(scope.network_destinations[0].host, "localhost");
    assert_eq!(scope.network_destinations[0].port, 8443);
    assert_eq!(scope.network_destinations[0].protocol, "https");
}

#[test]
fn diagnostic_admission_uses_the_shared_metadata_deny_list() {
    for host in [
        "[fd00:ec2::254]",
        "[FD00:0EC2:0:0:0:0:0:0254]",
        "metadata.google.internal",
        "METADATA.GOOGLE.INTERNAL.",
        "[::ffff:169.254.169.254]",
    ] {
        let args = json!({"host":host,"port":80,"protocol":"http"});
        assert!(
            validate_diagnostic_arguments("diagnose_endpoint", &args).is_err(),
            "metadata admission must fail"
        );
        assert!(
            crate::connection::validate_host(host).is_err(),
            "shared connection policy must agree"
        );
    }
    assert!(validate_diagnostic_arguments("diagnose_endpoint", &json!({
        "host":"localhost","port":80,"protocol":"http", "_networkDenyList":{"hosts":[],"addresses":[]}
    })).is_err(), "model arguments cannot replace the native deny list");
}

#[test]
fn diagnostic_ssh_handshake_obeys_total_deadline_and_cancellation() {
    use std::io::{BufRead, BufReader, Read};
    let rt = tokio::runtime::Runtime::new().unwrap();
    let _entered = rt.enter();
    for cancel in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let cancellation = CancellationToken::new();
        let server_cancellation = cancellation.clone();
        let server = std::thread::spawn(move || {
            let accept_deadline = Instant::now() + Duration::from_secs(3);
            let socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < accept_deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => panic!("diagnostic must initiate the real handshake"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(socket);
            let mut banner = String::new();
            reader.read_line(&mut banner).unwrap();
            assert!(banner.starts_with("SSH-"));
            // Leave the real transport stalled before the peer's SSH banner.
            if cancel {
                server_cancellation.cancel();
            }
            let mut buffer = [0; 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => break,
                    Err(_) => {
                        panic!("diagnostic must close the socket, not abandon a blocked handshake")
                    }
                }
            }
        });
        let connection = RemoteConnectionRequest {
            host: address.ip().to_string(),
            port: address.port(),
            username: "diagnostic".into(),
            auth_method: crate::models::AuthMethod::Password,
            password: None,
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        };
        let mut call = call(
            "inspect_host",
            json!({"fields":["system"],"timeoutMs":if cancel {10000} else {500}}),
        );
        call.target = AgentToolTargetNative::Remote {
            target_id: "diagnostic-stalled-ssh".into(),
            session_id: "diagnostic-stalled-session".into(),
            profile_id: None,
            host: connection.host.clone(),
            port: address.port(),
            username: connection.username.clone(),
            root_path: None,
            local_root: None,
        };
        let processes = ProcessRegistryNative::default();
        let started = Instant::now();
        let result = execute_diagnostic(
            &request(&call),
            &call,
            &effect(&call),
            Some(connection),
            Path::new(""),
            &processes,
            &cancellation,
        )
        .unwrap();
        server.join().unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "SSH setup must obey the diagnostic deadline"
        );
        assert_eq!(
            result.status,
            if cancel {
                AgentToolResultStatusNative::Cancelled
            } else {
                AgentToolResultStatusNative::TimedOut
            }
        );
        assert_eq!(processes.running_count().unwrap(), 0);
        if !cancel {
            assert_eq!(result.data.unwrap()["code"], "transportDeadlineExceeded");
        }
    }
}

#[test]
#[cfg(unix)]
fn diagnostic_local_collector_returns_real_host_evidence_without_workspace() {
    let result = run(
        &call("inspect_host", json!({"fields":["system","cpu"]})),
        &CancellationToken::new(),
    );
    assert_eq!(
        result.status,
        AgentToolResultStatusNative::Completed,
        "{result:?}"
    );
    let data = result.data.unwrap();
    assert_eq!(data["targetId"], "diagnostic-local");
    assert_eq!(data["evidenceRef"], "diagnostic-call");
    assert!(
        data["data"]["observations"]["cpu"]["data"]["logicalCount"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!(data["collectedAtUnixMs"].as_u64().unwrap() > 0);
    assert!(data["data"]["observations"].get("memory").is_none());
}

#[test]
#[cfg(unix)]
fn diagnostic_cancel_reaps_real_local_process_and_prevents_late_results() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let call = call(
        "diagnose_endpoint",
        json!({"host":"127.0.0.1", "port":listener.local_addr().unwrap().port(), "protocol":"http", "timeoutMs":10000}),
    );
    let cancellation = CancellationToken::new();
    let worker_token = cancellation.clone();
    let worker = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        worker_token.cancel();
    });
    let start = Instant::now();
    let result = run(&call, &cancellation);
    worker.join().unwrap();
    assert_eq!(result.status, AgentToolResultStatusNative::Cancelled);
    assert!(start.elapsed() < Duration::from_secs(3));
    assert_eq!(result.data.unwrap()["terminationConfirmed"], true);
}

#[test]
fn diagnostic_cancel_before_dispatch_still_has_an_evidence_envelope() {
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let result = run(&call("inspect_host", json!({})), &cancellation);
    assert_eq!(result.status, AgentToolResultStatusNative::Cancelled);
    let data = result.data.unwrap();
    assert_eq!(data["schemaVersion"], 1);
    assert_eq!(data["code"], "cancelledBeforeDispatch");
}

#[test]
#[ignore = "requires explicitly opted-in isolated SSH service"]
fn diagnostic_isolated_ssh_collects_remote_host_and_remote_loopback_http() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let _entered = rt.enter();
    let connection = crate::execution::fixture::isolated_ssh_connection();
    let (_trust, known_hosts) =
        crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
    for (name, args) in [
        ("inspect_host", json!({"fields":["system"]})),
        (
            "diagnose_endpoint",
            json!({"host":"127.0.0.1","port":18081,"protocol":"http"}),
        ),
    ] {
        let mut call = call(name, args);
        call.target = AgentToolTargetNative::Remote {
            target_id: "diagnostic-ssh".into(),
            session_id: "diagnostic-ssh-session".into(),
            profile_id: Some("diagnostic-profile".into()),
            host: connection.host.clone(),
            port: connection.port,
            username: connection.username.clone(),
            root_path: None,
            local_root: None,
        };
        let result = execute_diagnostic(
            &request(&call),
            &call,
            &effect(&call),
            Some(connection.clone()),
            &known_hosts,
            &ProcessRegistryNative::default(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(
            result.status,
            AgentToolResultStatusNative::Completed,
            "{result:?}"
        );
        let data = result.data.unwrap();
        if name == "inspect_host" {
            assert_eq!(
                data["data"]["observations"]["system"]["data"]["os"],
                "Linux"
            );
        } else {
            assert_eq!(data["data"]["stages"]["http"]["statusCode"], 200);
        }
    }
}
