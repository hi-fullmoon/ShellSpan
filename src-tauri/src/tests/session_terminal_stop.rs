use super::*;
use crate::agent_runtime::{
    TerminalExecuteRegistry, TerminalInputSource, TerminalLeaseEventState, TerminalLeaseManager,
};
use crate::models::{
    ManagedSession, SessionCommandSender, SessionIdentity, SessionManager, SessionStatus,
    SessionTerminalKind, StatusEvent,
};
use crate::terminal_broker::{TerminalCommandState, TerminalSessionBroker};

fn pump_registry_input(
    terminal: &mut RemoteFixtureTerminal,
    receiver: &crossbeam_channel::Receiver<SessionCommand>,
    registry: &TerminalExecuteRegistry,
    frame: &str,
) -> bool {
    let mut frame_sent = false;
    for command in receiver.try_iter() {
        let SessionCommand::Write(input) = command else {
            panic!("unexpected terminal transport command");
        };
        if input == "\u{18}\u{4}" && frame.len() > 2 {
            assert!(
                registry
                    .native_editor_confirmed_for_test(&terminal.transport_id, "stop-operation")
                    .unwrap(),
                "clear must wait for the source frame and terminal-mode restoration"
            );
        }
        write_all_nonblocking(
            &terminal.session,
            &mut terminal.shell_channel,
            input.as_bytes(),
        )
        .unwrap();
        frame_sent |= input == frame;
    }
    terminal.pump_once();
    frame_sent
}

#[test]
#[ignore = "requires the isolated tests/ssh-e2e Docker service"]
fn remote_native_stop_restores_manual_input_on_fresh_connections() {
    for username in ["shellspan", "shellspan-zsh"] {
        for attempt in 0..9 {
            let broker = TerminalSessionBroker::phase4_enabled_for_test(16_384);
            let transport = format!("stop-{username}-{attempt}");
            let mut terminal =
                RemoteFixtureTerminal::connect(username, &transport, None, broker.clone());
            let leases = TerminalLeaseManager::new(broker.clone());
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
            let registry = TerminalExecuteRegistry::new(leases.clone(), broker.clone());
            let sessions = SessionManager::default();
            let (sender, receiver) = crossbeam_channel::unbounded();
            sessions
                .insert(
                    transport.clone(),
                    ManagedSession {
                        sender: SessionCommandSender::Event(sender),
                        waker: None,
                        output_state_sender: None,
                        status: StatusEvent {
                            session_id: transport.clone(),
                            status: SessionStatus::Connected,
                            message: None,
                        },
                        output_ready: Arc::new(AtomicBool::new(true)),
                        output_paused: Arc::new(AtomicBool::new(false)),
                        terminal_kind: SessionTerminalKind::Remote,
                        identity: SessionIdentity {
                            title: transport.clone(),
                            host: "127.0.0.1".into(),
                            port: 22222,
                            username: username.into(),
                        },
                    },
                )
                .unwrap();
            let effect = format!("/tmp/shellspan-stopped-{}", Uuid::new_v4());
            let source = format!(
                "printf '%s' '{}' > {effect}",
                "cancel-before-submit".repeat(40)
            );
            let shell = broker.command_shell(&transport).unwrap();
            let submitted = if shell == TerminalShellKind::Bash {
                crate::terminal_integration::bash_native_submission(&source).unwrap()
            } else {
                source.clone()
            };
            let frame = crate::agent_runtime::native_editor_chunks(&submitted, shell)[0]
                .0
                .clone();
            let cancel_input = if attempt % 3 == 0 {
                "\u{18}\u{1}"
            } else {
                &frame
            };
            let takeover = attempt % 3 == 2;
            let operation = thread::scope(|scope| {
                let typing = scope.spawn(|| {
                    registry.start(
                        &sessions,
                        &transport,
                        "stop-agent",
                        "stop-task",
                        "stop-operation",
                        &source,
                        shell.enter(),
                    )
                });
                let deadline = Instant::now() + Duration::from_secs(10);
                let mut cancellation = None;
                loop {
                    if pump_registry_input(&mut terminal, &receiver, &registry, cancel_input)
                        && cancellation.is_none()
                    {
                        cancellation = Some(scope.spawn(|| {
                            if takeover {
                                registry
                                    .takeover(&sessions, &transport, "stop-agent", "stop-operation")
                                    .map(usize::from)
                            } else {
                                registry.cancel_task(&sessions, "stop-task")
                            }
                        }));
                    }
                    if typing.is_finished()
                        && cancellation.as_ref().is_some_and(|task| task.is_finished())
                    {
                        break;
                    }
                    assert!(Instant::now() < deadline, "SSH cancellation did not settle");
                    thread::sleep(Duration::from_millis(1));
                }
                cancellation
                    .unwrap()
                    .join()
                    .unwrap()
                    .unwrap_or_else(|error| {
                        panic!(
                            "SSH stop failed for {transport}: {error}; snapshot={:?}",
                            broker.snapshot(Some(&transport)).unwrap().session
                        )
                    });
                typing.join().unwrap().unwrap()
            });
            let result = registry
                .wait(&sessions, &transport, &operation, Duration::from_secs(5))
                .unwrap();
            assert_eq!(
                result.state,
                if takeover {
                    TerminalCommandState::TakenOver
                } else {
                    TerminalCommandState::Cancelled
                },
                "{result:?}"
            );
            leases.release_turn("stop-agent").unwrap();
            let marker = format!("ready-{}", Uuid::new_v4());
            leases
                .write(
                    &sessions,
                    &transport,
                    format!("test ! -e {effect} && printf 'manual-%s' '{marker}'\n"),
                    TerminalInputSource::User,
                )
                .expect("stopping must release manual SSH input");
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                pump_registry_input(&mut terminal, &receiver, &registry, "");
                if String::from_utf8_lossy(&terminal.display).contains(&format!("manual-{marker}"))
                {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "manual command failed or cancelled source executed: {:?}",
                    broker.snapshot(Some(&transport)).unwrap().session
                );
                thread::sleep(Duration::from_millis(1));
            }
        }
    }
}
