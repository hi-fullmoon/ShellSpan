use super::super::super::{
    AgentAuthorizeCallRequestNative, AgentPermissionModeNative, AgentRequestNative,
    NativeExecutionContext, NativeToolEngine, NATIVE_TOOL_CONTRACT_VERSION,
};
use super::*;

#[test]
#[ignore = "actual sshd channel response delayed beyond its blocking IO timeout"]
fn host_control_channel_waits_until_its_deadline_for_delayed_server_bytes() {
    use std::net::{Shutdown, TcpListener, TcpStream};

    let fixture = Fixture::new_host_review();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server_address = (fixture.connection.host.clone(), fixture.connection.port);
    let delay_next_response = Arc::new(AtomicBool::new(false));
    let delay = delay_next_response.clone();
    let relay = std::thread::spawn(move || {
        let mut workers = Vec::new();
        for _ in 0..2 {
            let (mut client, _) = listener.accept().unwrap();
            let mut server = TcpStream::connect(server_address.clone()).unwrap();
            let delay = delay.clone();
            workers.push(std::thread::spawn(move || {
                let mut client_reader = client.try_clone().unwrap();
                let mut server_writer = server.try_clone().unwrap();
                let upstream = std::thread::spawn(move || {
                    let _ = std::io::copy(&mut client_reader, &mut server_writer);
                    let _ = server_writer.shutdown(Shutdown::Write);
                });
                let mut bytes = [0; 8192];
                while let Ok(count) = server.read(&mut bytes) {
                    if count == 0 {
                        break;
                    }
                    // Forward actual encrypted server bytes without decoding them.
                    if delay.swap(false, Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_secs(3));
                    }
                    if client.write_all(&bytes[..count]).is_err() {
                        break;
                    }
                }
                let _ = client.shutdown(Shutdown::Both);
                upstream.join().unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
    });
    let (_trust_directory, known) =
        crate::connection::trusted_known_hosts_fixture("127.0.0.1", address.port());
    let mut connection = fixture.connection.clone();
    connection.port = address.port();
    let session = open_ssh_execution_session(&connection, &known).unwrap();
    delay_next_response.store(true, Ordering::SeqCst);
    let started = Instant::now();
    let result = fixed_json_peer(
        &session.target,
        "/usr/bin/python3",
        &json!({"mode":"inspect", "hostController":true, "root":"/"}),
        &connection,
        Duration::from_secs(5),
    );
    let elapsed = started.elapsed();
    assert!(session.target.is_blocking());
    delay_next_response.store(true, Ordering::SeqCst);
    let timeout_started = Instant::now();
    let timed_out = fixed_json_peer(
        &session.target,
        "/usr/bin/python3",
        &json!({"mode":"inspect", "hostController":true, "root":"/"}),
        &connection,
        Duration::from_millis(100),
    );
    let timeout_elapsed = timeout_started.elapsed();
    assert!(session.target.is_blocking());
    drop(session);
    relay.join().unwrap();
    assert!(
        result.is_ok(),
        "actual delayed control response failed: {result:?}"
    );
    assert!(elapsed >= Duration::from_secs(3));
    assert!(elapsed < Duration::from_secs(5));
    assert_eq!(
        timed_out.unwrap_err(),
        "sandboxRemoteControllerFailed: bounded SSH controller operation timed out"
    );
    assert!(timeout_elapsed < Duration::from_secs(1));
}

#[test]
#[ignore = "real owned SSH channel reports actual controller launch failure"]
fn host_controller_failure_preserves_actual_exit_status() {
    let fixture = Fixture::new_host_review();
    let session = open_ssh_execution_session(&fixture.connection, &fixture.known_hosts).unwrap();
    let unavailable = tempfile::tempdir().unwrap();
    let python = unavailable.path().join("absent-controller-python");
    let error = fixed_json_peer(
        &session.target,
        python.to_str().unwrap(),
        &json!({"mode":"inspect", "hostController":true, "root":"/"}),
        &fixture.connection,
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert_eq!(
        error,
        "sandboxRemoteControllerFailed: controller exited with status 127"
    );
    let invalid_root = fixed_json_peer(
        &session.target,
        "/usr/bin/python3",
        &json!({"mode":"inspect", "hostController":true, "root":python}),
        &fixture.connection,
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert!(invalid_root.contains("status 125: remoteHostControllerFailed:FileNotFoundError"));
}

#[test]
#[ignore = "real owned sshd handshake delayed beyond the ordinary session IO timeout"]
fn host_handshake_has_independent_timeout_and_restores_session_io_timeout() {
    use std::net::{Shutdown, TcpListener, TcpStream};

    let fixture = Fixture::new_host_review();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server_address = (fixture.connection.host.clone(), fixture.connection.port);
    let relay = std::thread::spawn(move || {
        let (mut client, _) = listener.accept().unwrap();
        let mut server = TcpStream::connect(server_address).unwrap();
        let mut client_reader = client.try_clone().unwrap();
        let mut server_writer = server.try_clone().unwrap();
        let upstream = std::thread::spawn(move || {
            let _ = std::io::copy(&mut client_reader, &mut server_writer);
            let _ = server_writer.shutdown(Shutdown::Write);
        });
        // Delay actual server bytes; the relay generates no SSH responses.
        std::thread::sleep(Duration::from_secs(16));
        let _ = std::io::copy(&mut server, &mut client);
        let _ = client.shutdown(Shutdown::Both);
        upstream.join().unwrap();
    });
    let started = Instant::now();
    let session = crate::connection::open_session_for_host_key("127.0.0.1", address.port());
    let elapsed = started.elapsed();
    if let Ok(session) = &session {
        assert!(session.host_key().is_some());
        assert_eq!(session.timeout(), 15_000);
        let _ = session.disconnect(None, "Owned delayed handshake completed", None);
    }
    let succeeded = session.is_ok();
    drop(session);
    relay.join().unwrap();
    assert!(succeeded, "real delayed SSH handshake failed");
    assert!(elapsed >= Duration::from_secs(16));
    assert!(elapsed < Duration::from_secs(30));
}

fn host_process(
    fixture: &Fixture,
    command: &str,
    timeout: Duration,
) -> (Arc<super::super::super::ManagedProcessNative>, PathBuf) {
    let contract = AgentSandboxContract::freeze(
        Some(AgentSandboxPolicy::Host),
        fixture.header.target.as_ref().unwrap(),
        AgentExecutionSurface::Direct,
        0,
    )
    .unwrap()
    .bind_to_session(&fixture.header);
    let target = super::super::super::remote_backend::validate_probe_target(
        &fixture.header,
        &fixture.sessions,
    )
    .unwrap();
    let job = RemoteSeatbeltJob::new_host(
        &contract,
        &target,
        command,
        timeout,
        &fixture.connection,
        &fixture.known_hosts,
        &fixture.sessions,
        &fixture.database,
    )
    .unwrap();
    assert!(!job.launch_command().unwrap().contains(&job.secret()));
    let directory = job.owned_directory();
    let process = super::super::super::spawn_remote_process_native(
        super::super::super::RemoteProcessStartNative {
            remote_sandbox: Some(job),
            admission: Some(fixture.admission.clone()),
            task_id: "host-own-task".into(),
            request_id: Uuid::new_v4().to_string(),
            owner_target_id: "mac-target".into(),
            command: command.into(),
            connection: fixture.connection.clone(),
            known_hosts_path: fixture.known_hosts.clone(),
            timeout,
        },
    )
    .unwrap();
    (process, directory)
}

#[test]
#[ignore = "explicit owned SSH cleanup receipt retention across actual source disconnect"]
fn host_final_receipt_survives_cleanup_and_source_disconnect() {
    let mut fixture = Fixture::new_host_review();
    let contract = AgentSandboxContract::freeze(
        Some(AgentSandboxPolicy::Host),
        fixture.header.target.as_ref().unwrap(),
        AgentExecutionSurface::Direct,
        0,
    )
    .unwrap()
    .bind_to_session(&fixture.header);
    let target = super::super::super::remote_backend::validate_probe_target(
        &fixture.header,
        &fixture.sessions,
    )
    .unwrap();
    let job = RemoteSeatbeltJob::new_host(
        &contract,
        &target,
        "printf retained-output",
        Duration::from_secs(20),
        &fixture.connection,
        &fixture.known_hosts,
        &fixture.sessions,
        &fixture.database,
    )
    .unwrap();
    let ssh = job.open_session().unwrap();
    let mut channel = ssh.target.channel_session().unwrap();
    crate::execution::start_ssh_exec_channel(&mut channel, &job.launch_command().unwrap()).unwrap();
    channel.write_all(&job.launch_input().unwrap()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !job.ready().unwrap_or(false) {
        assert!(
            Instant::now() < deadline,
            "real retained-receipt job did not start"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(job.cleanup(false));
    assert!(!job.owned_directory().exists());
    fixture.disconnect_source().unwrap();
    assert!(!job.valid());
    let receipt = job.completion().unwrap();
    assert_eq!(receipt["exitCode"], 0);
    assert_eq!(receipt["controllerFinished"], true);
    assert_eq!(receipt["terminationConfirmed"], true);
    assert!(job.cleanup(false));
    channel.close().unwrap();
}

#[test]
#[ignore = "explicit own ordinary-account SSH server with real signed host controller"]
fn host_controller_confirms_exit_timeout_and_explicit_cancel() {
    let fixture = Fixture::new_host_review();
    let (process, directory) = host_process(
        &fixture,
        "printf host-controller-output",
        Duration::from_secs(20),
    );
    let result = process.wait(Duration::from_secs(25)).unwrap();
    assert_eq!(
        result.stdout, "host-controller-output",
        "actual controller: {result:?}"
    );
    assert_eq!(result.exit_code, Some(0));
    assert!(result.termination_confirmed);
    assert!(!directory.exists());

    let (process, directory) = host_process(
        &fixture,
        "printf timeout-started; sleep 30",
        Duration::from_secs(8),
    );
    let result = process.wait(Duration::from_secs(20)).unwrap();
    assert_eq!(result.stdout, "timeout-started");
    assert_eq!(
        result.state,
        super::super::super::ProcessLifecycleNative::TimedOut
    );
    assert!(result.termination_confirmed);
    assert!(!directory.exists());

    let (process, directory) = host_process(
        &fixture,
        "printf cancel-started; sleep 30",
        Duration::from_secs(30),
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    while process.snapshot().unwrap().stdout != "cancel-started" {
        assert!(
            Instant::now() < deadline,
            "actual remote command did not start"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let result = process
        .kill(
            super::super::super::ProcessSignalNative::Kill,
            Duration::from_secs(15),
        )
        .unwrap();
    assert!(result.termination_confirmed);
    assert_eq!(
        result.state,
        super::super::super::ProcessLifecycleNative::Cancelled
    );
    assert!(!directory.exists());
}

#[test]
#[ignore = "explicit own real SSH host job and keychain cleanup custody recovery"]
fn host_cleanup_capsule_reconciles_own_job_without_replaying_command() {
    let fixture = Fixture::new_host_review();
    let contract = AgentSandboxContract::freeze(
        Some(AgentSandboxPolicy::Host),
        fixture.header.target.as_ref().unwrap(),
        AgentExecutionSurface::Direct,
        0,
    )
    .unwrap()
    .bind_to_session(&fixture.header);
    let target = super::super::super::remote_backend::validate_probe_target(
        &fixture.header,
        &fixture.sessions,
    )
    .unwrap();
    let job = RemoteSeatbeltJob::new_host(
        &contract,
        &target,
        "printf custody-started; sleep 30",
        Duration::from_secs(30),
        &fixture.connection,
        &fixture.known_hosts,
        &fixture.sessions,
        &fixture.database,
    )
    .unwrap();
    let service = "ShellSpan.HostCleanup.Acceptance.v1";
    let reference = Uuid::new_v4().to_string();
    fixture
        .credentials
        .set_credential(
            service,
            &reference,
            &serde_json::to_string(&job.cleanup_capsule().unwrap()).unwrap(),
        )
        .unwrap();
    let ssh = job.open_session().unwrap();
    let mut channel = ssh.target.channel_session().unwrap();
    crate::execution::start_ssh_exec_channel(&mut channel, &job.launch_command().unwrap()).unwrap();
    channel.write_all(&job.launch_input().unwrap()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !job.ready().unwrap_or(false) {
        assert!(
            Instant::now() < deadline,
            "actual custody command did not start"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let recovered: super::super::super::remote_seatbelt::cleanup::RemoteCleanupCapsule =
        serde_json::from_str(
            &fixture
                .credentials
                .get_credential(service, &reference)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
    recovered
        .reconcile(&fixture.credentials, &fixture.known_hosts)
        .unwrap();
    fixture
        .credentials
        .delete_credential(service, &reference)
        .unwrap();
    channel.close().unwrap();
    assert!(!job.owned_directory().exists());
}

#[test]
#[ignore = "explicit real SSH host NativeToolEngine approval and native keychain custody"]
fn host_engine_requires_approval_and_resolves_only_confirmed_own_custody() {
    let fixture = Fixture::new_host_review();
    let target = super::super::super::remote_backend::validate_probe_target(
        &fixture.header,
        &fixture.sessions,
    )
    .unwrap();
    let contract = AgentSandboxContract::freeze(
        Some(AgentSandboxPolicy::Host),
        fixture.header.target.as_ref().unwrap(),
        AgentExecutionSurface::Direct,
        0,
    )
    .unwrap()
    .bind_to_session(&fixture.header);
    let context = NativeExecutionContext {
        sandbox_contract: Some(contract),
        request: AgentRequestNative {
            contract_version: NATIVE_TOOL_CONTRACT_VERSION,
            request_id: "host-engine-request".into(),
            user_session_id: fixture.header.session_id.clone(),
            task_id: fixture.header.task_id.clone(),
            goal: "Verify real host command ownership".into(),
            success_criteria: vec![
                "Real approved command with confirmed owned resource termination".into(),
            ],
            targets: vec![target.clone()],
            permission_mode: AgentPermissionModeNative::RequestApproval,
        },
        turn_id: "host-turn".into(),
        step_id: "host-step".into(),
    };
    let state = fixture.directory.path().join("host-engine-state");
    let engine = NativeToolEngine::default();
    engine.configure_direct_ownership(&state).unwrap();
    for (id, command) in [
        ("host-exit", "printf host-engine-output"),
        ("host-timeout", "printf host-engine-output; sleep 30"),
    ] {
        let prepared = engine.prepare_authorization(context.clone(), AgentAuthorizeCallRequestNative {
            request_id: context.request.request_id.clone(), call_id: id.into(), tool_name: "exec_command".into(),
            target: target.clone(), ttl_ms: None,
            arguments: json!({"command":command,"explanation":"Own host controller check","channel":"direct","timeoutMs":8000}),
        }, &fixture.sessions, &fixture.database, &fixture.credentials, &fixture.known_hosts).unwrap();
        assert!(engine
            .issue_prepared_authorization(&prepared, false)
            .is_err());
        let approved = engine
            .issue_prepared_authorization(&prepared, true)
            .unwrap();
        let mut call = prepared.call.clone();
        call.capability_id = approved.capability_id;
        call.arguments = approved.effective_arguments;
        let result = engine
            .execute_tool(
                &context,
                call,
                &fixture.sessions,
                &fixture.database,
                &fixture.credentials,
                &fixture.known_hosts,
                &tokio_util::sync::CancellationToken::new(),
            )
            .unwrap();
        let data = result.data.unwrap();
        assert_eq!(data["stdout"], "host-engine-output");
        assert_eq!(data["sandboxBackend"], "host-account");
        assert_eq!(data["sandboxCapability"]["status"], "unavailable");
        assert_eq!(
            data["terminationConfirmed"], true,
            "actual {id} result: {data}"
        );
        let ledger =
            rusqlite::Connection::open(state.join("agent-direct-ownership.sqlite3")).unwrap();
        for table in ["dispatch_debt", "remote_cleanup_custody"] {
            assert_eq!(
                ledger
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }
}
