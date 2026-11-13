use super::*;
use crate::agent_runtime::{TerminalExecuteRegistry, TerminalLeaseManager};
use crate::models::SessionManager;
use crate::terminal_broker::{
    TerminalCommandState, TerminalGenerationCloseReason, TerminalSessionBroker,
};
use sha2::{Digest, Sha256};
use std::fs;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fault {
    DescriptorTimeout,
    PayloadTimeout,
    PartialPayloadTimeout,
    InputDisconnect,
    RunningDisconnect,
}

#[derive(Clone, Copy)]
enum Endpoint {
    Fixture(&'static str),
    SavedProfile,
}

impl Endpoint {
    fn connect(
        self,
        id: &str,
        predecessor: Option<&str>,
        broker: TerminalSessionBroker,
    ) -> RemoteFixtureTerminal {
        match self {
            Self::Fixture(username) => {
                RemoteFixtureTerminal::connect(username, id, predecessor, broker)
            }
            Self::SavedProfile => connect_saved_profile(id, predecessor, broker),
        }
    }
}

const FAULT_OPERATION: &str = "fault-command";

fn send_ordinary_frame(
    terminal: &mut RemoteFixtureTerminal,
    operation_id: &str,
    source: &str,
    fault: Option<Fault>,
) -> (
    Arc<crate::terminal_broker::TerminalCommandOperation>,
    Vec<u8>,
) {
    use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};

    let shell = terminal
        .broker
        .command_shell(&terminal.transport_id)
        .unwrap();
    let submission = (shell == TerminalShellKind::Bash)
        .then(|| crate::terminal_integration::bash_native_submission(source).unwrap());
    let chunks = native_editor_chunks(submission.as_deref().unwrap_or(source), shell);
    let [(payload, expected)] = chunks.as_slice() else {
        panic!("the ordinary SSH frame fixture requires a single frame");
    };
    let nonce = Uuid::new_v4().simple().to_string();
    let descriptor = if shell == TerminalShellKind::Bash {
        let original_bytes = crate::terminal_integration::bash_native_eval_source(expected)
            .unwrap()
            .len()
            * 4;
        format!(
            "b{:05x}{:04x}001e0064{nonce:0>47}",
            payload.len(),
            original_bytes
        )
    } else {
        format!("e{:04x}{nonce:0>60}", payload.len())
    };
    assert_eq!(descriptor.len(), 65);

    let broker = terminal.broker.clone();
    let id = terminal.transport_id.clone();
    let agent = terminal.agent_session_id.clone();
    broker
        .acquire_agent_lease(&id, &agent, "fixture-task", operation_id)
        .unwrap()
        .unwrap();
    let operation = broker
        .begin_command_with_submission(&id, operation_id, source, submission.as_deref())
        .unwrap();
    operation.expect_native_checkpoint("").unwrap();
    let send = |terminal: &mut RemoteFixtureTerminal, bytes: &[u8]| {
        broker
            .admit_terminal_input(
                &id,
                TerminalBrokerInputSource::Agent {
                    agent_session_id: agent.clone(),
                    task_id: "fixture-task".into(),
                    operation_id: operation_id.into(),
                },
                TerminalInputKind::Text,
                bytes,
                || write_all_nonblocking(&terminal.session, &mut terminal.shell_channel, bytes),
            )
            .unwrap();
    };
    send(terminal, b"\x18\x02");
    terminal.pump_until(Duration::from_secs(3), |_| {
        operation.wait_native_checkpoint(Duration::ZERO).unwrap()
    });
    operation
        .expect_native_data_checkpoint(&descriptor, expected)
        .unwrap();

    let Some(fault) = fault else {
        send(terminal, descriptor.as_bytes());
        send(terminal, payload.as_bytes());
        terminal.pump_until(Duration::from_secs(5), |_| {
            operation
                .wait_native_private_checkpoint(Duration::ZERO)
                .unwrap()
        });
        send(terminal, b"\x18\x05");
        return (operation, Vec::new());
    };

    let mut held = Vec::new();
    let expected_rejection = if fault == Fault::DescriptorTimeout {
        send(terminal, &descriptor.as_bytes()[..9]);
        held.extend_from_slice(&descriptor.as_bytes()[9..]);
        ""
    } else {
        send(terminal, descriptor.as_bytes());
        descriptor.as_str()
    };
    let sent = if fault == Fault::PartialPayloadTimeout {
        payload.len() / 2
    } else {
        0
    };
    if sent != 0 {
        send(terminal, &payload.as_bytes()[..sent]);
    }
    held.extend_from_slice(&payload.as_bytes()[sent..]);
    if fault == Fault::InputDisconnect {
        return (operation, held);
    }

    // Observe the receiver's actual quarantine message. A timed-out or partial
    // descriptor cannot supply a matching input proof, even when bytes arrive late.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut rejected = false;
    while !rejected {
        terminal.pump_once_with_control(|event| {
            rejected |= matches!(event, crate::terminal_integration::TerminalIntegrationControlEvent::NativePrivateCheckpoint { descriptor, buffer }
                if descriptor == expected_rejection && buffer.is_empty());
        });
        assert!(
            Instant::now() < deadline,
            "SSH receiver did not quarantine the {fault:?} frame"
        );
        thread::sleep(Duration::from_millis(5));
    }
    assert!(!operation
        .wait_native_private_checkpoint(Duration::ZERO)
        .unwrap());
    broker
        .require_native_input_recovery(&id, operation_id)
        .unwrap();
    (operation, held)
}

fn disconnect_transport(terminal: &mut RemoteFixtureTerminal) -> String {
    terminal.socket.shutdown(std::net::Shutdown::Both).unwrap();
    let outcome = match terminal.shell_channel.read(&mut [0; 16]) {
        Ok(0) => "eof".to_string(),
        Err(error) => format!("{:?}", error.kind()),
        Ok(_) => "bufferedOutputBeforeClose".into(),
    };
    terminal
        .broker
        .close_transport(
            &terminal.transport_id,
            TerminalGenerationCloseReason::TransportDisconnected,
        )
        .unwrap();
    outcome
}
#[test]
#[ignore = "requires the isolated tests/ssh-e2e Docker service"]
fn isolated_ssh_buffered_editor_receipt_does_not_wait_for_more_network_input() {
    for username in ["shellspan", "shellspan-zsh"] {
        let broker = TerminalSessionBroker::phase4_enabled_for_test(65_536);
        let transport = format!("buffered-receipt-{username}");
        let mut terminal = RemoteFixtureTerminal::connect(username, &transport, None, broker);
        pump_for(&mut terminal, Duration::from_millis(100));
        write_all_nonblocking(&terminal.session, &mut terminal.shell_channel, b"\x18\x01").unwrap();
        // Read only the PTY. libssh2 must dispatch the real editor receipt
        // into the other channel's buffer while this read returns WouldBlock.
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut output = [0; 8192];
        loop {
            match terminal.shell_channel.read(&mut output) {
                Ok(_) => {}
                Err(error) if is_retryable_channel_error_kind(error.kind()) => {}
                Err(error) => panic!("read SSH PTY while receiving editor receipt: {error}"),
            }
            if terminal
                .integration
                .as_ref()
                .unwrap()
                .control
                .read_window()
                .available
                > 0
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "editor did not send a real receipt"
            );
            thread::sleep(Duration::from_millis(2));
        }
        let (_waker, wake) = session_wake_pair().unwrap();
        let started = Instant::now();
        wait_for_terminal_session_events(
            &terminal.session,
            &terminal.shell_channel,
            Some(&terminal.integration.as_ref().unwrap().control),
            &wake,
            Duration::from_millis(800),
        )
        .unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(400),
            "{username}: buffered receipt slept until the socket deadline"
        );
        let integration = terminal.integration.as_mut().unwrap();
        let count = integration.control.read(&mut output).unwrap();
        assert!(integration.decoder.push(&output[..count]).unwrap().iter().any(
            |event| matches!(event, crate::terminal_integration::TerminalIntegrationControlEvent::NativeCheckpoint { buffer } if buffer.is_empty())
        ));
    }
}

#[test]
#[ignore = "requires the isolated tests/ssh-e2e Docker service"]
fn isolated_ssh_long_source_frames_receive_exact_acknowledgements() {
    for username in ["shellspan", "shellspan-zsh"] {
        let broker = TerminalSessionBroker::phase4_enabled_for_test(65_536);
        let transport = format!("long-frame-{username}");
        let mut terminal = RemoteFixtureTerminal::connect(username, &transport, None, broker);
        let ledger = format!("/tmp/.shellspan-source-frame-{}", Uuid::new_v4());
        let mut expected = Vec::new();
        for count in [64, 128, 256] {
            let text = "中文'\"$\\\n".repeat(count);
            let marker = format!("source-frame-complete-{count}");
            let source = format!(
                ": {}\nprintf '%s\\n' {marker} >> {ledger}",
                shlex::try_quote(&text).unwrap()
            );
            assert!(source.len() <= 8192);
            let id = format!("long-frame-{count}");
            let (operation, _) = send_ordinary_frame(&mut terminal, &id, &source, None);
            let result = terminal.finish_command(&id, &operation);
            assert_eq!(result.command_line, source);
            assert_eq!(result.state, TerminalCommandState::Completed);
            assert_eq!(result.exit_code, Some(0));
            expected.push(marker);
            assert_eq!(read_ledger(&mut terminal, &ledger), expected);
        }
        assert_eq!(
            terminal
                .execute("long-frame-cleanup", &format!("rm -- {ledger}"))
                .exit_code,
            Some(0)
        );
    }
}

fn read_ledger(terminal: &mut RemoteFixtureTerminal, path: &str) -> Vec<String> {
    terminal.session.set_blocking(true);
    let sftp = terminal.session.sftp().unwrap();
    let result = match sftp.open(std::path::Path::new(path)) {
        Ok(mut file) => {
            let mut text = String::new();
            file.read_to_string(&mut text).unwrap();
            text.lines().map(str::to_owned).collect()
        }
        Err(error) if error.code() == ssh2::ErrorCode::SFTP(2) => Vec::new(),
        Err(error) => panic!("read SSH acceptance ledger: {error}"),
    };
    drop(sftp);
    terminal.session.set_blocking(false);
    result
}

fn pump_for(terminal: &mut RemoteFixtureTerminal, duration: Duration) {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        terminal.pump_once();
        thread::sleep(Duration::from_millis(5));
    }
}

fn record_evidence(run: &str, fault: Fault, evidence: &serde_json::Value, raw: Option<&[u8]>) {
    if let Some(output) = std::env::var_os("SHELLSPAN_SSH_RECOVERY_EVIDENCE_DIR") {
        let output = std::path::PathBuf::from(output);
        assert!(output.is_absolute());
        fs::create_dir_all(&output).unwrap();
        fs::write(
            output.join(format!("{fault:?}-{run}.json")),
            serde_json::to_vec_pretty(evidence).unwrap(),
        )
        .unwrap();
        if let Some(raw) = raw {
            fs::write(
                output.join(format!("{fault:?}-{run}.log")),
                crate::redaction::redact_sensitive_text(&String::from_utf8_lossy(raw)),
            )
            .unwrap();
        }
    }
}

fn verify_recovery(endpoint: Endpoint, fault: Fault) {
    let run = Uuid::new_v4().simple().to_string();
    let broker = TerminalSessionBroker::phase4_enabled_for_test(65_536);
    let old_id = format!("recovery-old-{run}");
    let mut old = endpoint.connect(&old_id, None, broker.clone());
    let peer = old.socket.peer_addr().unwrap();
    let shell = broker.command_shell(&old_id).unwrap();
    let before = broker.execution_capabilities(&old_id).unwrap();
    assert!(before
        .integration_capabilities
        .contains(&"nativeScriptInput"));
    let directory = format!("/tmp/.shellspan-ssh-recovery-{run}");
    old.session.set_blocking(true);
    old.session
        .sftp()
        .unwrap()
        .mkdir(std::path::Path::new(&directory), 0o700)
        .unwrap();
    old.session.set_blocking(false);
    record_evidence(
        &run,
        fault,
        &serde_json::json!({"status":"running", "fault": format!("{fault:?}"), "peer":peer.to_string(), "remoteDirectory": directory}),
        None,
    );
    let ledger = format!("{directory}/effects");
    let running = format!("running-{run}");
    let source = format!("printf 'started\\n' >> {ledger}\nprintf '{running}\\n'\nsleep 2\nprintf 'finished\\n' >> {ledger}");
    let display_start = old.display.len();
    let leases = TerminalLeaseManager::new(broker.clone());
    let registry = TerminalExecuteRegistry::new(leases, broker.clone());
    let sessions = SessionManager::default();
    let probe = |command: &str| {
        registry
            .start(
                &sessions,
                &old_id,
                "ssh-recovery-agent",
                "ssh-recovery-task",
                "rejected-retry",
                command,
                shell.enter(),
            )
            .unwrap_err()
    };
    let mut rejected_probes = 0;
    let operation = if fault == Fault::RunningDisconnect {
        let (operation, _) = send_ordinary_frame(&mut old, FAULT_OPERATION, &source, None);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !String::from_utf8_lossy(&old.display[display_start..]).contains(&running)
            || operation.snapshot().unwrap().state != TerminalCommandState::Running
        {
            old.pump_once();
            assert!(
                Instant::now() < deadline,
                "remote command did not start before disconnect"
            );
            thread::sleep(Duration::from_millis(2));
        }
        operation
    } else {
        let (operation, mut held) =
            send_ordinary_frame(&mut old, FAULT_OPERATION, &source, Some(fault));
        if fault != Fault::InputDisconnect {
            assert!(
                broker
                    .execution_capabilities(&old_id)
                    .unwrap()
                    .input_recovery_required
            );
            let sequence = broker
                .snapshot(Some(&old_id))
                .unwrap()
                .session
                .unwrap()
                .next_input_sequence;
            for command in ["echo alive; date", "printf one\nprintf two", "pwd"] {
                let error = probe(command);
                assert!(
                    crate::agent_runtime::terminal_execution_needs_user_action(&error),
                    "{error}"
                );
                rejected_probes += 1;
            }
            assert_eq!(
                broker
                    .snapshot(Some(&old_id))
                    .unwrap()
                    .session
                    .unwrap()
                    .next_input_sequence,
                sequence,
                "a recovery rejection enqueued new input"
            );
            write_all_nonblocking(&old.session, &mut old.shell_channel, b"\x03").unwrap();
            pump_for(&mut old, Duration::from_millis(200));
            held.push(b'\r');
            write_all_nonblocking(&old.session, &mut old.shell_channel, &held).unwrap();
            pump_for(&mut old, Duration::from_millis(500));
        }
        operation
    };
    let transport_failure = disconnect_transport(&mut old);
    let fault_state = operation.snapshot().unwrap().state;
    if fault == Fault::RunningDisconnect {
        assert_eq!(fault_state, TerminalCommandState::Uncertain);
    } else {
        assert_ne!(fault_state, TerminalCommandState::Completed);
    }
    let old_output = old.display[display_start..].to_vec();
    assert!(
        !old_output.windows(2).any(|pair| pair == b"\\x"),
        "encoded frame leaked over real SSH: {fault:?}"
    );
    let closed_sequence = broker
        .snapshot(Some(&old_id))
        .unwrap()
        .session
        .unwrap()
        .next_input_sequence;
    let fresh_id = format!("recovery-new-{run}");
    let mut fresh = endpoint.connect(&fresh_id, Some(&old_id), broker.clone());
    if let Some(integration) = old.integration.as_mut() {
        integration.cleanup_files(&fresh.session);
        fresh.session.set_blocking(false);
    }
    let after = broker.execution_capabilities(&fresh_id).unwrap();
    assert!(after.terminal_generation > before.terminal_generation);
    assert!(
        !after.input_recovery_required
            && after
                .integration_capabilities
                .contains(&"nativeScriptInput")
    );
    pump_for(&mut fresh, Duration::from_secs(3));
    let prior = read_ledger(&mut fresh, &ledger);
    let expected_started = usize::from(fault == Fault::RunningDisconnect);
    assert_eq!(
        prior
            .iter()
            .filter(|entry| entry.as_str() == "started")
            .count(),
        expected_started,
        "old command ran or replayed: {fault:?}"
    );
    assert!(
        prior
            .iter()
            .filter(|entry| entry.as_str() == "finished")
            .count()
            <= expected_started
    );
    let stale_error = probe(&source);
    assert_eq!(
        broker
            .snapshot(Some(&fresh_id))
            .unwrap()
            .session
            .unwrap()
            .next_input_sequence,
        1,
        "reconnect automatically submitted input"
    );
    let (fresh_command, _) = send_ordinary_frame(
        &mut fresh,
        "reconnected-command",
        &format!("printf 'reconnected\\n' >> {ledger}\nprintf 'new-generation-ok\\n'"),
        None,
    );
    let reconnected = fresh.finish_command("reconnected-command", &fresh_command);
    assert_eq!(reconnected.state, TerminalCommandState::Completed);
    assert_eq!(reconnected.exit_code, Some(0));
    let effects = read_ledger(&mut fresh, &ledger);
    assert_eq!(
        effects
            .iter()
            .filter(|entry| entry.as_str() == "reconnected")
            .count(),
        1
    );
    assert_eq!(
        effects
            .iter()
            .filter(|entry| entry.as_str() == "started")
            .count(),
        expected_started
    );
    let evidence = serde_json::json!({
        "status": "passed", "cleanup": "completed",
        "fault": format!("{fault:?}"), "peer": peer.to_string(), "shell": shell, "username": old.username,
        "terminalGenerationBefore": before.terminal_generation, "terminalGenerationAfter": after.terminal_generation,
        "rejectedRetryProbes": rejected_probes, "closedInputSequence": closed_sequence, "staleError": stale_error,
        "transportFailure": transport_failure, "faultState": fault_state, "encodedOutputLeaks": 0, "effects": effects,
        "rawOutputSha256": hex::encode(Sha256::digest(&old_output)),
        "realModelRequests": 0, "executionPath": "SSH2 + ordinary shell integration + broker; native-only registry rejects retries",
    });
    fresh.session.set_blocking(true);
    let sftp = fresh.session.sftp().unwrap();
    sftp.unlink(std::path::Path::new(&ledger)).unwrap();
    sftp.rmdir(std::path::Path::new(&directory)).unwrap();
    record_evidence(&run, fault, &evidence, Some(&old_output));
}

fn verify_all_faults(endpoint: Endpoint) {
    for fault in [
        Fault::DescriptorTimeout,
        Fault::PayloadTimeout,
        Fault::PartialPayloadTimeout,
        Fault::InputDisconnect,
        Fault::RunningDisconnect,
    ] {
        verify_recovery(endpoint, fault);
    }
}

#[test]
#[ignore = "requires the isolated tests/ssh-e2e Docker SSH server"]
fn isolated_ssh_input_timeout_disconnect_and_reconnect_do_not_replay() {
    for username in ["shellspan", "shellspan-zsh"] {
        verify_all_faults(Endpoint::Fixture(username));
    }
}

#[test]
#[ignore = "requires the isolated tests/ssh-e2e Docker SSH server"]
fn isolated_ssh_stop_restores_manual_input_on_fresh_connections() {
    use crate::terminal_broker::TerminalCommandRequestedSettlement;

    for username in ["shellspan", "shellspan-zsh"] {
        let broker = TerminalSessionBroker::phase4_enabled_for_test(65_536);
        let transport = format!("stop-{username}");
        let mut terminal =
            RemoteFixtureTerminal::connect(username, &transport, None, broker.clone());
        let operation = terminal.begin("ssh-stop", "sleep 30");
        let stopped = terminal.interrupt(&operation, TerminalCommandRequestedSettlement::Cancelled);
        assert_eq!(stopped.state, TerminalCommandState::Cancelled);
        broker
            .retire_command(&transport, &stopped.command_id)
            .unwrap();
        broker
            .release_agent_lease(
                &transport,
                &terminal.agent_session_id,
                "fixture-task",
                "ssh-stop",
            )
            .unwrap();
        assert!(terminal
            .execute_user_command("printf '%s%s\\n' SSH_MANUAL_ OK")
            .contains("SSH_MANUAL_OK"));
    }
}

#[test]
#[ignore = "requires an explicitly selected saved production SSH profile and OS keychain access; run with --release"]
fn saved_profile_ssh_input_timeout_disconnect_and_reconnect_do_not_replay() {
    verify_all_faults(Endpoint::SavedProfile);
}

fn saved_profile_build_guard() -> Result<(), &'static str> {
    if cfg!(debug_assertions) {
        Err("Saved production profiles require cargo test --release; development credential isolation stays enforced")
    } else {
        Ok(())
    }
}

#[test]
fn saved_profile_build_guard_matches_credential_isolation() {
    assert_eq!(saved_profile_build_guard().is_err(), cfg!(debug_assertions));
}

fn connect_saved_profile(
    transport: &str,
    predecessor: Option<&str>,
    broker: crate::terminal_broker::TerminalSessionBroker,
) -> RemoteFixtureTerminal {
    saved_profile_build_guard().expect("saved-profile acceptance requires a production build");
    let id = std::env::var("SHELLSPAN_SSH_ACCEPTANCE_PROFILE_ID")
        .expect("explicit SSH profile reference required");
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .expect("user home required");
    let data = crate::shellspan_data_dir(&home);
    let database = rusqlite::Connection::open_with_flags(
        data.join("shellspan-main.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let (host, port, username, authentication): (String, u16, String, String) = database
        .query_row(
            "SELECT host, port, username, auth_method FROM profiles WHERE id = ?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read the explicitly selected SSH profile without modifying application data");
    assert_eq!(
        authentication, "password",
        "this acceptance connector requires a saved password profile"
    );
    let credentials = crate::keychain::CredentialManager::new();
    let password = credentials
        .retrieve_profile_password(&id)
        .expect("resolve profile credential through the OS keychain")
        .expect("the selected profile has no saved password");
    let stream = crate::connection::connect_tcp_stream(&host, port)
        .expect("connect to the selected remote SSH host");
    let socket = stream.try_clone().unwrap();
    let known_hosts = data.join("known_hosts");
    let session = crate::connection::open_authenticated_session(
        stream,
        &username,
        crate::models::AuthMethod::Password,
        Some(&password),
        None,
        None,
        &host,
        port,
        Some(&known_hosts),
    )
    .expect("authenticate with the saved credential and the existing trusted host key");
    drop(password);
    RemoteFixtureTerminal::from_session(
        None,
        socket,
        session,
        &username,
        transport,
        predecessor,
        broker,
    )
}

#[test]
#[ignore = "requires an explicitly selected saved production SSH profile and OS keychain access; run with --release"]
fn saved_profile_ssh_recovery_preflight() {
    let broker = crate::terminal_broker::TerminalSessionBroker::phase4_enabled_for_test(16_384);
    let terminal = connect_saved_profile("ssh-recovery-preflight", None, broker.clone());
    let state = broker
        .execution_capabilities(&terminal.transport_id)
        .unwrap();
    assert!(state.open && state.prompt_ready);
    assert!(state
        .integration_capabilities
        .contains(&"nativeScriptInput"));
}

#[test]
#[ignore = "cleans only explicitly listed UUID directories created by this SSH acceptance; requires a saved production profile and --release"]
fn saved_profile_ssh_cleanup_acceptance_directories() {
    let runs = std::env::var("SHELLSPAN_SSH_ACCEPTANCE_CLEANUP_RUNS")
        .expect("explicit acceptance run UUIDs required");
    let broker = TerminalSessionBroker::phase4_enabled_for_test(16_384);
    let terminal = connect_saved_profile("ssh-recovery-owned-cleanup", None, broker);
    terminal.session.set_blocking(true);
    let sftp = terminal.session.sftp().unwrap();
    for run in runs.split(',') {
        let run = Uuid::parse_str(run).expect("cleanup accepts only acceptance run UUIDs");
        let directory = format!("/tmp/.shellspan-ssh-recovery-{}", run.simple());
        let ledger = format!("{directory}/effects");
        match sftp.unlink(std::path::Path::new(&ledger)) {
            Ok(()) => (),
            Err(error) if error.code() == ssh2::ErrorCode::SFTP(2) => (),
            Err(error) => panic!("remove acceptance-owned ledger: {error}"),
        }
        sftp.rmdir(std::path::Path::new(&directory))
            .expect("remove only the empty acceptance-owned UUID directory");
    }
}
