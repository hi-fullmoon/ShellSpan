use super::*;
use crate::agent_runtime::{
    TerminalExecuteRegistry, TerminalLeaseEventState, TerminalLeaseManager,
};
use crate::models::{
    ManagedSession, SessionCommandSender, SessionIdentity, SessionManager, SessionStatus,
    SessionTerminalKind, StatusEvent,
};
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

struct InputFault {
    kind: Fault,
    descriptor_expected: bool,
    payload_expected: bool,
    ready: bool,
    held: Vec<u8>,
}

impl InputFault {
    fn forward(&mut self, input: &str) -> Vec<u8> {
        if input == "\u{18}\u{2}" {
            self.descriptor_expected = true;
        } else if self.descriptor_expected {
            self.descriptor_expected = false;
            self.payload_expected = true;
            assert_eq!(
                input.len(),
                65,
                "the production registry must send the frame descriptor next"
            );
            if self.kind == Fault::DescriptorTimeout {
                self.held.extend_from_slice(&input.as_bytes()[9..]);
                return input.as_bytes()[..9].to_vec();
            }
        } else if self.payload_expected {
            self.payload_expected = false;
            self.ready = true;
            let sent = if self.kind == Fault::PartialPayloadTimeout {
                input.len() / 2
            } else {
                0
            };
            self.held.extend_from_slice(&input.as_bytes()[sent..]);
            return input.as_bytes()[..sent].to_vec();
        }
        input.as_bytes().to_vec()
    }
}

struct CommandRuntime {
    registry: TerminalExecuteRegistry,
    leases: TerminalLeaseManager,
    sessions: SessionManager,
    receiver: crossbeam_channel::Receiver<SessionCommand>,
    dequeued_frames: usize,
}

impl CommandRuntime {
    fn new(terminal: &RemoteFixtureTerminal) -> Self {
        let leases = TerminalLeaseManager::new(terminal.broker.clone());
        let acknowledger = leases.clone();
        leases
            .set_publisher(Arc::new(move |event| {
                if event.state == TerminalLeaseEventState::Acquired {
                    acknowledger
                        .acknowledge_frontend_ready(
                            &event.session_id,
                            &event.agent_session_id,
                            &event.operation_id,
                            true,
                            true,
                            false,
                            false,
                            false,
                        )
                        .unwrap();
                }
            }))
            .unwrap();
        let registry = TerminalExecuteRegistry::new(leases.clone(), terminal.broker.clone());
        let (_, receiver) = crossbeam_channel::unbounded();
        let mut runtime = Self {
            registry,
            leases,
            sessions: SessionManager::default(),
            receiver,
            dequeued_frames: 0,
        };
        runtime.attach(terminal);
        runtime
    }

    fn attach(&mut self, terminal: &RemoteFixtureTerminal) {
        let (sender, receiver) = crossbeam_channel::unbounded();
        let peer = terminal.socket.peer_addr().unwrap();
        self.sessions
            .insert(
                terminal.transport_id.clone(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: terminal.transport_id.clone(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Remote,
                    identity: SessionIdentity {
                        title: "SSH input recovery acceptance".into(),
                        host: peer.ip().to_string(),
                        port: peer.port(),
                        username: terminal.username.clone(),
                    },
                },
            )
            .unwrap();
        self.receiver = receiver;
    }

    fn pump(&mut self, terminal: &mut RemoteFixtureTerminal, fault: Option<&mut InputFault>) {
        let mut fault = fault;
        for command in self.receiver.try_iter() {
            let SessionCommand::Write(input) = command else {
                panic!("unexpected transport command in SSH acceptance");
            };
            self.dequeued_frames += 1;
            let bytes = match fault.as_mut() {
                Some(fault) => fault.forward(&input),
                None => input.into_bytes(),
            };
            if !bytes.is_empty() {
                write_all_nonblocking(&terminal.session, &mut terminal.shell_channel, &bytes)
                    .unwrap();
            }
        }
        terminal.pump_once();
    }

    fn disconnect(&self, terminal: &mut RemoteFixtureTerminal) -> String {
        terminal.socket.shutdown(std::net::Shutdown::Both).unwrap();
        let outcome = match terminal.shell_channel.read(&mut [0; 16]) {
            Ok(0) => "eof".to_string(),
            Err(error) => format!("{:?}", error.kind()),
            Ok(_) => "bufferedOutputBeforeClose".into(),
        };
        self.registry
            .terminal_closed(&terminal.transport_id)
            .unwrap();
        terminal
            .broker
            .close_transport(
                &terminal.transport_id,
                TerminalGenerationCloseReason::TransportDisconnected,
            )
            .unwrap();
        self.sessions.remove(&terminal.transport_id).unwrap();
        outcome
    }

    fn execute(&mut self, terminal: &mut RemoteFixtureTerminal, source: &str) {
        let registry = self.registry.clone();
        let sessions = self.sessions.clone();
        let id = terminal.transport_id.clone();
        let shell = terminal.broker.command_shell(&id).unwrap();
        let operation = thread::scope(|scope| {
            let typing = scope.spawn(|| {
                registry.start(
                    &sessions,
                    &id,
                    "ssh-recovery-agent",
                    "ssh-recovery-task",
                    "new-command",
                    source,
                    shell.enter(),
                )
            });
            let deadline = Instant::now() + Duration::from_secs(12);
            while !typing.is_finished() {
                self.pump(terminal, None);
                assert!(
                    Instant::now() < deadline,
                    "new SSH command input did not settle"
                );
                thread::sleep(Duration::from_millis(2));
            }
            typing.join().unwrap().unwrap()
        });
        let deadline = Instant::now() + Duration::from_secs(8);
        while !operation.snapshot().unwrap().state.is_terminal() {
            self.pump(terminal, None);
            assert!(
                Instant::now() < deadline,
                "new SSH command did not complete"
            );
            thread::sleep(Duration::from_millis(2));
        }
        let result = self
            .registry
            .wait(&self.sessions, &id, &operation, Duration::from_secs(5))
            .unwrap();
        assert_eq!(result.state, TerminalCommandState::Completed);
        assert_eq!(result.exit_code, Some(0));
        self.leases.release_turn("ssh-recovery-agent").unwrap();
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
    let mut runtime = CommandRuntime::new(&old);
    let mut injection = InputFault {
        kind: fault,
        descriptor_expected: false,
        payload_expected: false,
        ready: false,
        held: Vec::new(),
    };
    let display_start = old.display.len();
    let registry = runtime.registry.clone();
    let sessions = runtime.sessions.clone();
    let mut transport_failure = None;
    let started = thread::scope(|scope| {
        let typing = scope.spawn(|| {
            registry.start(
                &sessions,
                &old_id,
                "ssh-recovery-agent",
                "ssh-recovery-task",
                "fault-command",
                &source,
                shell.enter(),
            )
        });
        let deadline = Instant::now() + Duration::from_secs(12);
        while !typing.is_finished() {
            if transport_failure.is_none() {
                runtime.pump(
                    &mut old,
                    (fault != Fault::RunningDisconnect).then_some(&mut injection),
                );
                if injection.ready && fault == Fault::InputDisconnect {
                    transport_failure = Some(runtime.disconnect(&mut old));
                }
            }
            assert!(
                Instant::now() < deadline,
                "SSH fault did not settle: {fault:?}"
            );
            thread::sleep(Duration::from_millis(2));
        }
        typing.join().unwrap()
    });
    let mut rejected_probes = 0;
    if fault == Fault::RunningDisconnect {
        let operation = started.unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !String::from_utf8_lossy(&old.display[display_start..]).contains(&running)
            || operation.snapshot().unwrap().state != TerminalCommandState::Running
        {
            runtime.pump(&mut old, None);
            assert!(
                Instant::now() < deadline,
                "remote command did not start before disconnect"
            );
            thread::sleep(Duration::from_millis(2));
        }
        transport_failure = Some(runtime.disconnect(&mut old));
        assert_eq!(
            operation.snapshot().unwrap().state,
            TerminalCommandState::Uncertain
        );
    } else if fault == Fault::InputDisconnect {
        assert!(
            started.is_err()
                || started.unwrap().snapshot().unwrap().state != TerminalCommandState::Completed
        );
    } else {
        assert!(crate::agent_runtime::terminal_execution_needs_user_action(
            &started.unwrap_err()
        ));
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
            let error = runtime
                .registry
                .start(
                    &runtime.sessions,
                    &old_id,
                    "ssh-recovery-agent",
                    "ssh-recovery-task",
                    "rejected-retry",
                    command,
                    shell.enter(),
                )
                .unwrap_err();
            assert!(crate::agent_runtime::terminal_execution_needs_user_action(
                &error
            ));
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
        assert!(runtime.receiver.is_empty());
        write_all_nonblocking(&old.session, &mut old.shell_channel, b"\x03").unwrap();
        pump_for(&mut old, Duration::from_millis(200));
        injection.held.push(b'\r');
        write_all_nonblocking(&old.session, &mut old.shell_channel, &injection.held).unwrap();
        pump_for(&mut old, Duration::from_millis(500));
        transport_failure = Some(runtime.disconnect(&mut old));
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
    assert!(runtime
        .registry
        .start(
            &runtime.sessions,
            &old_id,
            "ssh-recovery-agent",
            "ssh-recovery-task",
            "stale-retry",
            &source,
            shell.enter()
        )
        .is_err());
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
    runtime.attach(&fresh);
    runtime.execute(
        &mut fresh,
        &format!("printf 'reconnected\\n' >> {ledger}\nprintf 'new-generation-ok\\n'"),
    );
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
        "fault": format!("{fault:?}"), "peer": peer.to_string(), "shell": shell,
        "terminalGenerationBefore": before.terminal_generation, "terminalGenerationAfter": after.terminal_generation,
        "rejectedRetryProbes": rejected_probes, "closedInputSequence": closed_sequence,
        "transportFailure": transport_failure, "encodedOutputLeaks": 0, "effects": effects,
        "rawOutputSha256": hex::encode(Sha256::digest(&old_output)),
        "realModelRequests": 0, "executionPath": "production SSH2 + shell integration + terminal broker + execute registry",
        "registryInputFramesDequeued": runtime.dequeued_frames,
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
#[ignore = "requires an explicitly selected saved production SSH profile and OS keychain access; run with --release"]
fn saved_profile_ssh_input_timeout_disconnect_and_reconnect_do_not_replay() {
    verify_all_faults(Endpoint::SavedProfile);
}

fn connect_saved_profile(
    transport: &str,
    predecessor: Option<&str>,
    broker: crate::terminal_broker::TerminalSessionBroker,
) -> RemoteFixtureTerminal {
    assert!(!cfg!(debug_assertions), "Saved production profiles require cargo test --release; development credential isolation stays enforced");
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
