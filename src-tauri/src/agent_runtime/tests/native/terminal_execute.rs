    use super::*;
    use crate::models::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionStatus,
        SessionTerminalKind, StatusEvent,
    };
    use crate::terminal_broker::{TerminalGeometry, TerminalTransportKind};
    use crate::terminal_integration::{TerminalIntegrationControlEvent, TerminalShellKind};
    use crossbeam_channel::{unbounded, Receiver};
    use std::sync::atomic::AtomicBool;
    use std::thread;

    fn harness() -> (
        TerminalSessionBroker,
        TerminalExecuteRegistry,
        SessionManager,
        Receiver<SessionCommand>,
    ) {
        let broker = TerminalSessionBroker::phase3_enabled_for_test(128);
        broker
            .attach_transport(
                "transport-1",
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(80, 24),
            )
            .unwrap();
        broker
            .register_integration_channel("transport-1", "integration-1", TerminalShellKind::Zsh)
            .unwrap();
        for event in [
            TerminalIntegrationControlEvent::Ready {
                shell: TerminalShellKind::Zsh,
            },
            TerminalIntegrationControlEvent::PromptStart { cwd: "/tmp".into() },
            TerminalIntegrationControlEvent::PromptEnd,
        ] {
            broker
                .accept_integration_event("transport-1", "integration-1", event)
                .unwrap();
        }
        let leases = TerminalLeaseManager::new(broker.clone());
        let acknowledger = leases.clone();
        leases
            .set_publisher(Arc::new(move |event| {
                if event.state == super::super::TerminalLeaseEventState::Acquired {
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
        let registry = TerminalExecuteRegistry::new(leases, broker.clone());
        let sessions = SessionManager::default();
        let (sender, receiver) = unbounded();
        sessions
            .insert(
                "transport-1".into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: "transport-1".into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: "zsh".into(),
                        host: "local".into(),
                        port: 0,
                        username: "tester".into(),
                    },
                },
            )
            .unwrap();
        (broker, registry, sessions, receiver)
    }

    fn command_start(broker: &TerminalSessionBroker, command: &str) {
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::CommandStart {
                    command_line: command.into(),
                    cwd: "/tmp".into(),
                },
            )
            .unwrap();
    }

    fn command_end(broker: &TerminalSessionBroker, exit_code: i32) {
        broker
            .accept_integration_event(
                "transport-1",
                "integration-1",
                TerminalIntegrationControlEvent::CommandEnd {
                    exit_code,
                    cwd: "/tmp/after".into(),
                },
            )
            .unwrap();
    }

    #[test]
    fn submits_exact_real_input_and_returns_cooperative_contract() {
        let (broker, registry, sessions, receiver) = harness();
        let operation = registry
            .start(
                &sessions,
                "transport-1",
                "agent-1",
                "task-1",
                "operation-1",
                "printf '终端'",
                "\n",
            )
            .unwrap();
        let worker_broker = broker.clone();
        let worker = thread::spawn(move || {
            let SessionCommand::Write(input) = receiver.recv().unwrap() else {
                panic!("expected command input")
            };
            assert_eq!(input, "printf '终端'\n");
            assert!(!input.contains("/bin/sh -c"));
            assert!(!input.contains("BEGIN:"));
            assert!(!input.contains("[Agent]"));
            command_start(&worker_broker, "printf '终端'");
            worker_broker
                .observe_raw_output("transport-1", b"\x1b[31mterminal\x1b[0m")
                .unwrap();
            command_end(&worker_broker, 3);
        });
        let snapshot = registry
            .wait(&sessions, "transport-1", &operation, Duration::from_secs(2))
            .unwrap();
        worker.join().unwrap();
        assert_eq!(snapshot.state, TerminalCommandState::Completed);
        assert_eq!(snapshot.command_line, "printf '终端'");
        assert_eq!(snapshot.exit_code, Some(3));
        assert_eq!(snapshot.cwd.as_deref(), Some("/tmp/after"));
        assert!(snapshot.combined_output.contains("terminal"));
        assert!(snapshot.no_auto_replay);
    }

    fn interrupt_settlement(
        requested: TerminalCommandRequestedSettlement,
        expected: TerminalCommandState,
    ) {
        let (broker, registry, sessions, receiver) = harness();
        let operation = registry
            .start(
                &sessions,
                "transport-1",
                "agent-1",
                "task-1",
                "operation-1",
                "sleep 60",
                "\n",
            )
            .unwrap();
        let worker_broker = broker.clone();
        let worker = thread::spawn(move || {
            let SessionCommand::Write(input) = receiver.recv().unwrap() else {
                panic!("expected command input")
            };
            assert_eq!(input, "sleep 60\n");
            command_start(&worker_broker, "sleep 60");
            let SessionCommand::Write(interrupt) = receiver.recv().unwrap() else {
                panic!("expected interrupt")
            };
            assert_eq!(interrupt.as_bytes(), [3]);
            command_end(&worker_broker, 130);
        });
        match requested {
            TerminalCommandRequestedSettlement::Cancelled => {
                assert_eq!(registry.cancel_task(&sessions, "task-1").unwrap(), 1);
            }
            TerminalCommandRequestedSettlement::TakenOver => {
                assert!(registry
                    .takeover(&sessions, "transport-1", "agent-1", "operation-1",)
                    .unwrap());
            }
            TerminalCommandRequestedSettlement::TimedOut => {}
        }
        let timeout = if requested == TerminalCommandRequestedSettlement::TimedOut {
            Duration::from_millis(1)
        } else {
            Duration::from_secs(2)
        };
        let snapshot = registry
            .wait(&sessions, "transport-1", &operation, timeout)
            .unwrap();
        worker.join().unwrap();
        assert_eq!(snapshot.state, expected);
        assert_eq!(snapshot.exit_code, Some(130));
    }

    #[test]
    fn cancellation_timeout_and_takeover_use_one_scoped_interrupt_and_cooperative_end() {
        interrupt_settlement(
            TerminalCommandRequestedSettlement::Cancelled,
            TerminalCommandState::Cancelled,
        );
        interrupt_settlement(
            TerminalCommandRequestedSettlement::TimedOut,
            TerminalCommandState::TimedOut,
        );
        interrupt_settlement(
            TerminalCommandRequestedSettlement::TakenOver,
            TerminalCommandState::TakenOver,
        );
    }

    #[test]
    fn missing_cooperative_end_is_uncertain_and_never_reported_as_timeout() {
        let (broker, registry, sessions, receiver) = harness();
        let operation = registry
            .start(
                &sessions,
                "transport-1",
                "agent-1",
                "task-1",
                "operation-1",
                "side-effect; sleep 60",
                "\n",
            )
            .unwrap();
        let worker_broker = broker.clone();
        let worker = thread::spawn(move || {
            let SessionCommand::Write(_) = receiver.recv().unwrap() else {
                panic!("expected command input")
            };
            command_start(&worker_broker, "side-effect; sleep 60");
            let SessionCommand::Write(interrupt) = receiver.recv().unwrap() else {
                panic!("expected interrupt")
            };
            assert_eq!(interrupt.as_bytes(), [3]);
        });
        let snapshot = registry
            .wait(
                &sessions,
                "transport-1",
                &operation,
                Duration::from_millis(1),
            )
            .unwrap();
        worker.join().unwrap();
        assert_eq!(snapshot.state, TerminalCommandState::Uncertain);
        assert_eq!(snapshot.exit_code, None);
        assert!(snapshot.no_auto_replay);
    }
